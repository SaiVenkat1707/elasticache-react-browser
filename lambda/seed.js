// SEED (temporary, LARGE dataset) - writes a few hundred keys across many
// prefixes and depths, plus all Redis value types. Requires write perms
// on the cache user (e.g. +@all) while running.

const Redis = require('ioredis');
const { SignatureV4 } = require('@smithy/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');
const { formatUrl } = require('@aws-sdk/util-format-url');

const { CACHE_HOST, CACHE_PORT, CACHE_USER, CACHE_NAME, AWS_REGION_OVERRIDE: REGION } = process.env;

async function getToken() {
  const creds = await defaultProvider()();
  const signer = new SignatureV4({ credentials: creds, region: REGION, service: 'elasticache', sha256: Sha256 });
  const req = new HttpRequest({
    method: 'GET', protocol: 'http:', hostname: CACHE_NAME, path: '/',
    query: { Action: 'connect', User: CACHE_USER }, headers: { host: CACHE_NAME },
  });
  const presigned = await signer.presign(req, { expiresIn: 900 });
  return formatUrl(presigned).replace(/^https?:\/\//, '');
}

exports.handler = async () => {
  const pw = await getToken();
  const client = new Redis.Cluster(
    [{ host: CACHE_HOST, port: parseInt(CACHE_PORT) }],
    {
      dnsLookup: (address, callback) => callback(null, address),
      slotsRefreshTimeout: 10000,
      redisOptions: {
        username: CACHE_USER, password: pw,
        tls: { checkServerIdentity: () => undefined },
      },
    }
  );

  let count = 0;
  const ops = [];  // collect promises, await in batches to stay fast but cluster-safe
  const run = (p) => { ops.push(p); count++; };

  // ---- user:<id>:<field>  (50 users, several fields each, deep nesting) ----
  const firstNames = ['alice','bob','carol','dave','erin','frank','grace','heidi','ivan','judy'];
  const roles = ['admin','editor','viewer','guest'];
  for (let i = 1001; i <= 1050; i++) {
    const n = firstNames[(i - 1001) % firstNames.length] + i;
    run(client.set(`user:${i}:name`, n));
    run(client.set(`user:${i}:email`, `${n}@example.com`));
    run(client.set(`user:${i}:role`, roles[i % roles.length]));
    run(client.set(`user:${i}:created`, `2026-0${(i % 9) + 1}-15`));
    // nested prefs as a hash
    run(client.hset(`user:${i}:prefs`, 'theme', i % 2 ? 'dark' : 'light', 'lang', i % 3 ? 'en' : 'fr'));
    // deeper nesting: user:<id>:sessions:<sid>
    for (let s = 1; s <= (i % 3) + 1; s++) {
      run(client.set(`user:${i}:sessions:sess${s}`, s % 2 ? 'active' : 'expired'));
    }
  }

  // ---- session:<id> (strings) ----
  for (let i = 0; i < 40; i++) {
    run(client.set(`session:tok${i.toString().padStart(3,'0')}`, i % 2 ? 'active' : 'expired'));
  }

  // ---- config:<area>:<key> (nested config) ----
  const areas = ['app','db','cache','api','auth'];
  for (const area of areas) {
    run(client.set(`config:${area}:timeout`, `${(Math.random()*100)|0}`));
    run(client.set(`config:${area}:retries`, `${(Math.random()*5)|0}`));
    run(client.set(`config:${area}:enabled`, Math.random() > 0.5 ? 'true' : 'false'));
  }

  // ---- queue:<name> (lists) ----
  for (const q of ['jobs','emails','notifications','exports']) {
    run(client.rpush(`queue:${q}`, 'item1', 'item2', 'item3', 'item4'));
  }

  // ---- metrics:<service>:<metric> (sorted sets + strings) ----
  for (const svc of ['web','worker','scheduler']) {
    run(client.zadd(`metrics:${svc}:latency`, 10, 'p50', 25, 'p90', 80, 'p99'));
    run(client.set(`metrics:${svc}:uptime`, `${(Math.random()*100).toFixed(2)}`));
  }

  // ---- feature flags (set) ----
  run(client.sadd('flags:enabled', 'newUI', 'betaSearch', 'darkMode', 'fastCache'));
  run(client.sadd('flags:disabled', 'oldExport', 'legacyAuth'));

  // ---- a stream ----
  run(client.xadd('events:stream', '*', 'type', 'login', 'user', '1001'));
  run(client.xadd('events:stream', '*', 'type', 'logout', 'user', '1002'));

  // ---- some top-level standalone keys (leaf keys at root) ----
  run(client.set('version', '2.1.0'));
  run(client.set('maintenance', 'false'));

  // Cluster-safe: each command routed to its own shard; batch the awaits.
  for (let i = 0; i < ops.length; i += 50) {
    await Promise.all(ops.slice(i, i + 50));
  }
  client.disconnect();
  return { statusCode: 200, body: JSON.stringify({ writtenOperations: count, note: 'large dataset seeded' }) };
};
