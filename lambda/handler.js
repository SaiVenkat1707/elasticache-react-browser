// Cache Browser Lambda
// ----------------------------------------------------------------
// Connects to a cluster-mode-enabled Valkey ElastiCache using IAM auth
// (no stored password), and exposes three read-only operations over HTTP:
//
//   GET /browse?path=foo:        - group keys under "foo:" by next segment, with counts
//   GET /dump?path=foo:&limit=N  - return key/value pairs under "foo:"
//   GET /getValue?key=foo:bar    - return one key's value, type, and TTL
//
// API Gateway routes requests here. The JWT authorizer on the API has
// already validated the caller's Cognito token before this handler runs.
// ----------------------------------------------------------------

const Redis = require('ioredis');
const { SignatureV4 } = require('@smithy/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');
const { formatUrl } = require('@aws-sdk/util-format-url');

// ---- Config from environment (set by CloudFormation) ----
const {
  CACHE_HOST,
  CACHE_PORT,
  CACHE_USER,
  CACHE_NAME,
  CLUSTER_MODE,
  AWS_REGION_OVERRIDE: REGION,
} = process.env;

const SCAN_COUNT = parseInt(process.env.SCAN_BATCH_SIZE || '1000');
const MAX_KEYS = parseInt(process.env.MAX_KEYS_PER_RESPONSE || '500');

// ---- IAM auth token generation ----
// ElastiCache IAM auth: instead of a stored password, the client signs
// a special request with its IAM credentials. The signed request becomes
// the "password" passed to Redis AUTH. Token is valid for 15 minutes.
async function getIamAuthToken() {
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: REGION,
    service: 'elasticache',
    sha256: Sha256,
  });

  const request = new HttpRequest({
    method: 'GET',
    protocol: 'http:',
    // Sign against the replication group ID (cache name), NOT the endpoint host.
    hostname: CACHE_NAME,
    path: '/',
    query: { Action: 'connect', User: CACHE_USER },
    headers: { host: CACHE_NAME },
  });

  const presigned = await signer.presign(request, { expiresIn: 900 });
  // Token = the signed URL with the protocol stripped off
  return formatUrl(presigned).replace(/^https?:\/\//, '');
}

// ---- Redis client (cached per warm Lambda instance) ----
let redisClient = null;
let clientCreatedAt = 0;
const CLIENT_TTL_MS = 10 * 60 * 1000;  // refresh client every 10 min (token expires at 15)

async function getRedisClient() {
  // Reuse cached client if still fresh
  if (redisClient && (Date.now() - clientCreatedAt) < CLIENT_TTL_MS) {
    return redisClient;
  }

  // Tear down old client if we're refreshing
  if (redisClient) {
    try { redisClient.disconnect(); } catch (e) { /* ignore */ }
  }

  const token = await getIamAuthToken();
  const port = parseInt(CACHE_PORT);

  const commonOptions = {
    username: CACHE_USER,
    password: token,
    // Discovered cluster nodes have hostnames that don't match the cert CN,
    // so the default TLS identity check fails. Disable it (still encrypted).
    tls: { checkServerIdentity: () => undefined },
  };

  if (CLUSTER_MODE === 'enabled') {
    redisClient = new Redis.Cluster(
      [{ host: CACHE_HOST, port }],
      {
        // Required for ElastiCache cluster-mode + TLS: keep cluster-provided
        // hostnames so the TLS cert validates (resolving to IPs breaks it).
        dnsLookup: (address, callback) => callback(null, address),
        redisOptions: commonOptions,
      }
    );
  } else {
    redisClient = new Redis({ host: CACHE_HOST, port, ...commonOptions });
  }

  clientCreatedAt = Date.now();
  return redisClient;
}

// Helper: iterate the right set of nodes for the cluster mode
function nodesFor(client) {
  return CLUSTER_MODE === 'enabled' ? client.nodes('master') : [client];
}

// ---- browse(path, delimiter) ----
// Scans keys matching "path*", groups them by the next segment after `path`,
// and returns a count of keys under each group. Keys with no further
// delimiter are returned as "leaf keys" at this level.
async function browse(path, delimiter = ':') {
  const client = await getRedisClient();
  const pattern = path + '*';
  const prefixCounts = new Map();
  const leafKeys = [];
  let scanned = 0;
  let truncated = false;
  const scanCap = MAX_KEYS * 10;

  for (const node of nodesFor(client)) {
    if (truncated) break;
    const stream = node.scanStream({ match: pattern, count: SCAN_COUNT });

    for await (const batch of stream) {
      for (const key of batch) {
        scanned++;
        if (scanned > scanCap) { truncated = true; break; }

        const remainder = key.substring(path.length);
        const idx = remainder.indexOf(delimiter);
        if (idx === -1) {
          if (leafKeys.length < MAX_KEYS) leafKeys.push(key);
        } else {
          const segment = remainder.substring(0, idx);
          prefixCounts.set(segment, (prefixCounts.get(segment) || 0) + 1);
        }
      }
      if (truncated) break;
    }
  }

  const prefixes = Array.from(prefixCounts.entries())
    .map(([segment, count]) => ({
      segment,
      fullPath: path + segment + delimiter,
      count,
    }))
    .sort((a, b) => a.segment.localeCompare(b.segment));

  return { path, prefixes, leafKeys, scanned, truncated };
}

// ---- dump(path, limit) ----
// Returns up to `limit` actual key/value pairs under `path`. For each key,
// fetches its type, value, and TTL.
async function dump(path, limit) {
  const client = await getRedisClient();
  const pattern = path + '*';
  const max = Math.min(parseInt(limit) || 100, MAX_KEYS);
  const entries = [];
  let truncated = false;

  for (const node of nodesFor(client)) {
    if (entries.length >= max) { truncated = true; break; }
    const stream = node.scanStream({ match: pattern, count: SCAN_COUNT });

    for await (const batch of stream) {
      for (const key of batch) {
        if (entries.length >= max) { truncated = true; break; }
        entries.push(await readKey(key, client));
      }
      if (truncated) break;
    }
  }

  return { path, entries, truncated };
}

// ---- getValue(key) ----
async function getValue(key) {
  const client = await getRedisClient();
  return readKey(key, client);
}

// ---- search(q, mode) ----
// Scans the cache for keys matching the query and returns matching entries
// WITH their values (key, type, value, ttl) - so the UI can show values
// inline without a click-through. Goes live to the cache; designed for
// finding keys a broad browse would truncate before reaching.
//   mode 'prefix'    -> MATCH "<q>*"
//   mode 'substring' -> MATCH "*<q>*"
// Capped at MAX_KEYS_PER_RESPONSE, same as browse/dump.
// NOTE: MATCH filters what's returned, not what's scanned - both modes still
// walk the full keyspace, so search on a huge cache is not cheap.
async function search(q, mode = 'prefix') {
  const client = await getRedisClient();
  const pattern = mode === 'substring' ? `*${q}*` : `${q}*`;
  const entries = [];
  let scanned = 0;
  let truncated = false;
  const scanCap = MAX_KEYS * 20;

  for (const node of nodesFor(client)) {
    if (truncated) break;
    const stream = node.scanStream({ match: pattern, count: SCAN_COUNT });
    for await (const batch of stream) {
      for (const key of batch) {
        scanned++;
        if (entries.length >= MAX_KEYS || scanned > scanCap) { truncated = true; break; }
        entries.push(await readKey(key, client));
      }
      if (truncated) break;
    }
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));
  return { query: q, mode, entries, matched: entries.length, scanned, truncated };
}

// Returns {key, type, value, ttl} for a single key, handling all Redis types.
async function readKey(key, client) {
  const type = await client.type(key);
  const ttl  = await client.ttl(key);
  let value;

  switch (type) {
    case 'string': value = await client.get(key); break;
    case 'list':   value = await client.lrange(key, 0, -1); break;
    case 'set':    value = await client.smembers(key); break;
    case 'zset':   value = await client.zrange(key, 0, -1, 'WITHSCORES'); break;
    case 'hash':   value = await client.hgetall(key); break;
    case 'stream': value = '(stream - use XRANGE to inspect)'; break;
    case 'none':   value = null; break;
    default:       value = `(unknown type: ${type})`;
  }

  return { key, type, value, ttl };
}

// ---- HTTP handler (API Gateway HTTP API v2.0 event format) ----
exports.handler = async (event) => {
  const path   = event.rawPath || event.path || '';
  const params = event.queryStringParameters || {};

  try {
    let result;
    if (path === '/browse') {
      result = await browse(params.path || '', params.delimiter || ':');
    } else if (path === '/dump') {
      result = await dump(params.path || '', params.limit);
    } else if (path === '/getValue') {
      if (!params.key) return jsonResponse(400, { error: 'Missing required parameter: key' });
      result = await getValue(params.key);
    } else if (path === '/search') {
      if (!params.q) return jsonResponse(400, { error: 'Missing required parameter: q' });
      result = await search(params.q, params.mode || 'prefix');
    } else {
      return jsonResponse(404, { error: 'Not found', path });
    }
    return jsonResponse(200, result);
  } catch (err) {
    console.error('Handler error:', err);
    // Auth-token errors: invalidate client so the next request mints a new one
    if (/NOAUTH|WRONGPASS|auth/i.test(err.message || '')) {
      redisClient = null;
    }
    return jsonResponse(500, { error: err.message });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',  // CloudFront URL would tighten this
    },
    body: JSON.stringify(body),
  };
}
