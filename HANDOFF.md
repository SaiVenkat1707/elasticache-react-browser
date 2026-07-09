# Cache Browser — Production Handoff

A read-only web tool for browsing the contents of an ElastiCache (Valkey,
cluster-mode-enabled) cache hierarchically by key prefix. Engineers log in,
see top-level prefixes with key counts, drill down level by level, dump the
key/value pairs under any prefix, and inspect individual keys (value, type,
TTL).

This document covers what it is, how it's built, how to deploy it, what it
costs, where it's slow, the non-obvious things that will bite you, and what
you need to decide/configure on your end before using it in production.

---

## 1. What this delivers

Three things to browse a cache like a filesystem:

- **browse(path)** — lists the next-level prefixes under a path, each with a
  count of keys beneath it, plus any "leaf" keys at that exact level.
- **dump(path)** — returns the actual key/value pairs under a path (capped).
- **getValue(key)** — returns one key's full value, Redis type, and TTL.

Drill-down is just `browse` on a deeper path. The UI gives you a breadcrumb,
prefix tables with counts, a "show all values" action, and a key-detail view.

It is **strictly read-only**. It cannot write, delete, or modify cache data.

---

## 2. Architecture

```
React SPA (S3 + CloudFront, HTTPS)
   │  login → JWT (Cognito User Pool, custom-UI USER_PASSWORD_AUTH)
   │  GET /browse?path=...   Authorization: Bearer <JWT>
   ▼
API Gateway HTTP API
   │  JWT authorizer validates the token against the User Pool (offline,
   │  via the pool's JWKS — Cognito is not called per request)
   ▼
Lambda (Node.js 22, ARM64, in the VPC's private subnets)
   │  mints a short-lived ElastiCache IAM auth token from its own
   │  execution role, connects over TLS as a read-only cache user
   ▼
ElastiCache (Valkey, cluster-mode enabled, IAM auth, TLS)
```

Two independent authorizations, often confused:

- **Browser → API:** the **JWT** proves who the user is. No AWS credentials
  in the browser.
- **Lambda → Cache:** the Lambda's **IAM execution role** proves what may
  touch the cache. Same for every user; no stored cache password.

---

## 3. The two templates

This is delivered as two CloudFormation templates, same pattern as the
TimescaleDB handoff.

### Template 1 — `env-stack.yaml` (the environment)

Creates a generic, project-agnostic environment: VPC, subnets, NAT, an
ElastiCache Valkey cluster (cluster-mode enabled, IAM auth, TLS) with two
pre-existing IAM users and a user group, a Cognito User Pool with two
pre-created users, a bare HTTP API, and an S3 staging bucket for the Lambda
zip.

**For production, you most likely do NOT deploy this.** It represents
resources you already have (VPC, ElastiCache, Cognito, API Gateway). It is
provided so you can (a) see exactly what Template 2 assumes exists, and
(b) optionally stand up an isolated test/staging environment that mirrors
prod. If you do already have these resources, skip Template 1 and feed your
real resource IDs into Template 2's parameters.

### Template 2 — `app-stack.yaml` (the application)

This is what you actually deploy. It takes your existing environment's
resource IDs as parameters and layers the cache browser on top:

- Cognito User Pool **Client** (on your existing pool) + JWT authorizer
- A read-only ElastiCache IAM user, **added to your existing user group**
  via a custom resource
- A security-group ingress rule allowing the Lambda to reach the cache
- The Lambda function (in your VPC), its role, and its log group
- Three routes (`/browse`, `/dump`, `/getValue`) **added to your existing
  HTTP API**
- S3 bucket + CloudFront distribution + OAC for the React frontend

---

## 4. What Template 2 assumes about your existing environment

Template 2 will fail or misbehave unless all of these are true of the
resources you point it at:

1. **ElastiCache is Valkey, cluster-mode ENABLED, with TLS (in-transit
   encryption) ON and IAM authentication enabled.** The Lambda connects with
   `Redis.Cluster` and IAM tokens; a cluster-mode-disabled or non-TLS or
   non-IAM cache will not work without code changes.
2. **There is a user group attached to the cluster** that the new read-only
   user can be added to. Template 2 modifies this group (adds one member).
3. **The Cognito User Pool exists.** Template 2 creates a *client* on it; it
   does not create the pool.
4. **The HTTP API (API Gateway v2) exists.** Template 2 adds routes and a JWT
   authorizer to it.
5. **The VPC has at least two private subnets** (in two AZs) with a route to
   the cache, and egress (NAT or equivalent) if the Lambda needs to reach AWS
   APIs (it mints IAM tokens via STS/credentials available in-Lambda, so
   typically no internet egress is strictly required, but the ENI must reach
   the cache).

**Resources Template 2 MODIFIES (not just creates) in your account** — be
aware before deploying into prod:

- Your **existing user group** (adds the read-only user via custom resource;
  removes it on stack delete).
- Your **existing HTTP API** (adds 3 routes + 1 authorizer).
- Your **existing Cognito User Pool** (adds 1 app client).
- The **cache's security group** (adds 1 ingress rule from the Lambda SG).

---

## 5. Deploy procedure

Order matters. The Lambda zip must exist in S3 before Template 2 references
it, and the frontend config needs values that only exist after Template 2
deploys.

### 5a. Build and upload the Lambda zip

Requires Node.js locally.

```
cd lambda
npm install
# zip the CONTENTS (not the folder):
zip -r cache-browser.zip handler.js package.json node_modules   # mac/linux
```

Upload `cache-browser.zip` to your staging S3 bucket (console upload is fine).

> Note: the dependencies are pure JS, so building the zip on any OS works.
> If you ever swap in a dependency with native binaries, build the zip on
> Linux to match the Lambda runtime.

### 5b. (Test env only) Deploy Template 1

Skip if using existing prod resources. If standing up a test env:
CloudFormation → create stack → `env-stack.yaml` → fill parameters → deploy.
Note the **Outputs** — you'll feed them into Template 2.

### 5c. Deploy Template 2

CloudFormation → create stack → `app-stack.yaml` → fill parameters (see §6) →
deploy. CloudFront takes 5–15 min; the rest is ~2 min.

### 5d. Configure and build the frontend

Edit `frontend/src/config.ts` with four values from the stack outputs:

| Field | Source |
|---|---|
| `region` | your deploy region |
| `userPoolId` | existing pool / Template 1 output |
| `userPoolClientId` | Template 2 output `UserPoolClientId` |
| `apiBaseUrl` | Template 2 output `ApiBaseUrl` |

Then:

```
cd frontend
npm install
npm run build
```

Upload the **contents** of `dist/` (the `index.html` and the `assets/`
folder) to the React S3 bucket (Template 2 output `ReactBucketName`).

### 5e. Invalidate CloudFront

CloudFront → your distribution → Invalidations → Create → path `/*`.
Wait ~1 min. Frontend changes are only visible after invalidation.

### 5f. Set Cognito user passwords (see §9) and log in

Open the CloudFront URL (Template 2 output `CloudFrontUrl`).

---

## 6. Template 2 parameters

| Parameter | What to provide |
|---|---|
| `AppName` | Name prefix for resources (default `cache-browser`) |
| `VpcId` | Existing VPC |
| `PrivateSubnet1Id`, `PrivateSubnet2Id` | Two private subnets (2 AZs) for the Lambda |
| `CacheReplicationGroupId` | The cache's replication group ID — **also used to sign the IAM token (critical, see §11)** |
| `CacheConfigurationEndpoint` | The cluster's configuration endpoint hostname |
| `CachePort` | Usually 6379 |
| `CacheSecurityGroupId` | The cache's security group (gets an ingress rule added) |
| `CacheUserGroupId` | Existing user group (the read-only user is added to it) |
| `UserPoolId`, `UserPoolArn` | Existing Cognito User Pool |
| `HttpApiId`, `HttpApiEndpoint` | Existing HTTP API |
| `LambdaCodeBucket`, `LambdaCodeKey` | Where you uploaded the zip |
| `ScanBatchSize` | SCAN COUNT hint — performance tuning (see §8). Default 1000. |
| `MaxKeysPerResponse` | Hard cap on keys scanned/returned per request. Default 500. |

---

## 7. Seeding test data (test env only)

Production already has real data, so skip this there. For an empty test
cache, `lambda/seed.js` writes ~300 sample keys (many prefixes, depths, and
all Redis types).

1. Temporarily widen the read-only user's ACL (ElastiCache → Users):
   `on ~* &* +@all +cluster +info`
2. Paste `seed.js` into the Lambda code editor, Deploy, run with `{}`.
   Expect `{ "writtenOperations": ~300 }`.
3. Lock the ACL back to read-only:
   `on ~* &* -@all +@read +@connection +cluster +info`
4. Paste the real `handler.js` back and Deploy.

---

## 8. Known limitations and disadvantages

Read this section before relying on the tool. None of these are bugs; they
are inherent to how the tool works.

### 8a. It is slow, and slowness scales with cache size

Every `browse` runs `SCAN` across **all shards** and walks each shard's
keyspace, matching keys against the prefix and grouping them. There is **no
O(1) count** in Redis/Valkey — a count is a full scan.

- **Browsing the root is the worst case** — it scans the entire cache to
  group top-level prefixes. The deeper you drill, the smaller the match set,
  the faster it gets.
- On a small cache (hundreds of keys) this is a couple of seconds. On a cache
  with millions of keys it can be very slow, and the `MaxKeysPerResponse` cap
  will kick in and mark results **"truncated"** rather than scanning
  everything.
- **Guidance: prefer narrow prefixes.** The tool is most useful when you give
  it a specific prefix to drill into, not for browsing the root of a huge
  cache.

### 8b. Scanning a busy production cache adds load

Valkey is single-threaded per shard. Each SCAN iteration with a high
`ScanBatchSize` (COUNT) makes the shard examine that many keys before
returning, during which it is **not serving other commands** on that shard.
On a large, busy production cache, broad browses can cause **latency spikes
for the real application** using that cache.

Mitigations:
- Keep `ScanBatchSize` moderate (1000–2000) on busy prod caches. Higher
  values (5000–6000) are fine only on small or idle caches.
- Consider pointing scans at a **reader/replica endpoint** rather than the
  primary, so browse load doesn't touch the node serving writes. (This is a
  small code change in the Lambda — `scaleReads: 'slave'` in the cluster
  options — not currently enabled.)
- Browse narrow prefixes; avoid the root on large caches.

### 8c. Cold starts

The Lambda runs in a VPC and reconnects to the cluster (TLS handshake +
IAM token mint + shard discovery) on a cold start. The **first request after
idle is slow** (several seconds); subsequent requests reuse a cached
connection (~10 min) and are fast. If snappy first-response matters, enable
**provisioned concurrency** on the Lambda (adds cost).

### 8d. Truncation, not completeness

`browse` and `dump` cap the number of keys scanned/returned
(`MaxKeysPerResponse`, and a scan ceiling). Results past the cap are dropped
and flagged `truncated: true`. This is a deliberate guard against pulling a
million keys into the browser, but it means **you are not guaranteed to see
everything** under a broad prefix. Narrow the prefix to see more.

### 8e. Stream values are not rendered

Redis/Valkey `stream` type keys show a placeholder, not their entries. The
other types (string, list, set, sorted set, hash) render fully. If you need
stream inspection, that's a code addition (XRANGE).

### 8f. Frontend updates are not instant

CloudFront caches the frontend. After uploading a new build you must
invalidate (`/*`) and hard-refresh the browser, or you'll see the old
version. Lambda/backend changes, by contrast, are live immediately on Deploy.

### 8g. Single NAT / single-AZ cost-saving choices (test env)

The test-env template uses one NAT gateway and a single public subnet to keep
cost down. That's fine for a non-critical internal tool but is not
multi-AZ-resilient at the NAT layer. Production presumably already has its
own resilient networking; this only applies if you deploy Template 1.

---

## 9. Cognito user provisioning (action needed on your end)

CloudFormation **cannot set a permanent Cognito password** (passwords would
be exposed in stack events). The template creates users with a temporary
password delivered by email invite. Two implications:

- The test-env users use `@example.com` addresses, which receive no mail. To
  log in to a test deploy, set a password manually: Cognito → User Pool →
  Users → select user → Actions → **Set password** → mark permanent.
- **For production, you decide how users are provisioned.** Options:
  1. **SES + real email addresses** (recommended for prod) — configure SES
     with a verified sender so Cognito's invite emails actually arrive; users
     set their own password on first login. The proper, scalable path.
  2. **Console / API provisioning** — create users and set passwords via the
     console or `AdminSetUserPassword`. Fine for a small fixed set of
     engineers.
  3. **A custom resource** that sets passwords from a CFN parameter or Secrets
     Manager at deploy time — automatable but puts secrets in the deploy path.

This is a Template-1 / environment concern, so for prod it's whatever your
existing user-management approach is.

---

## 10. Security posture

- **Read-only at the data layer.** The cache user's ACL grants only
  `+@read +@connection +cluster +info`. No writes, no deletes, no admin.
- **No stored cache password.** Auth is via short-lived IAM tokens minted from
  the Lambda's execution role. Revoke the role's `elasticache:Connect` and the
  Lambda instantly loses cache access.
- **API is JWT-gated.** Only valid Cognito tokens reach the Lambda.
- **Frontend bucket is private**, served only through CloudFront via Origin
  Access Control. The bucket is not publicly readable.
- **TLS everywhere** — browser↔CloudFront, browser↔API, Lambda↔cache.
- **CORS is currently wide open (`*`)** on both the HTTP API and the Lambda
  response. **You should tighten this to the CloudFront URL** before prod use
  (see §12). It's open to simplify the test deploy.
- **`checkServerIdentity` is disabled** on the cache TLS connection (required
  for cluster-mode node discovery — the discovered node hostnames don't match
  the cert CN). Traffic is still encrypted; only the hostname check is
  skipped, and only inside the VPC.

---

## 11. Hard-won gotchas (do not undo these)

These cost significant debugging time. They're baked into the delivered code
and templates; this is so you understand them and don't accidentally revert.

1. **The IAM auth token must be signed with the replication group ID, NOT the
   configuration endpoint hostname.** The token's signing `hostname` is the
   cache name (e.g. `my-cache`). Signing with the long `clustercfg...` endpoint
   gives `WRONGPASS`. This is why `CACHE_NAME` is a separate Lambda env var
   from `CACHE_HOST`.

2. **The cache user's ACL needs `+cluster +info` explicitly.** In cluster
   mode, the client runs `CLUSTER`/`INFO` to discover shards. These are NOT
   covered by `+@all` under ElastiCache RBAC — even an admin user fails
   discovery without them, producing `WRONGPASS` on the shard nodes and
   "Failed to refresh slots cache".

3. **Cluster + TLS requires two ioredis options** (already set):
   `dnsLookup: (a, cb) => cb(null, a)` and
   `tls: { checkServerIdentity: () => undefined }`. Without these, slot
   discovery fails the TLS handshake against the discovered node hostnames.

4. **Pipelines cannot span shards in cluster mode.** Batching writes/reads
   across different key slots throws "All keys in the pipeline should belong
   to the same slots allocation group". The seed uses individual awaits
   batched with `Promise.all` instead of a pipeline for this reason.

5. **Re-deploying into a dirty account hits `AlreadyExists`.** Several
   resources have fixed names (the Lambda functions, the read-only cache
   user, the CloudWatch log groups). If a deploy fails partway and you
   redeploy, these collide. Before re-deploying, delete leftovers:
   - Lambda functions `cache-browser` and `cache-browser-usergroup-modifier`
   - ElastiCache user `cache-browser-readonly` (remove from the user group
     first if blocked)
   - CloudWatch log groups `/aws/lambda/cache-browser*` (easy to forget;
     these block redeploys silently)
   - S3 bucket `cache-browser-frontend-<account>` (empty before deleting)
   - Security group `cache-browser-lambda-sg`, Cognito client `cache-browser-client`
   A truly fresh account won't hit this.

6. **ElastiCache IAM users require `UserId == UserName`.** And the
   account-wide `default` user is a *Redis* user that cannot be added to a
   *Valkey* user group — Valkey auto-disables the default-user requirement, so
   no default user is needed in the group at all.

---

## 12. Recommended changes before production use

Things I'd tighten on your end:

1. **Lock down CORS.** Change the HTTP API's `AllowOrigins` and the Lambda's
   `Access-Control-Allow-Origin` from `*` to your CloudFront URL.
2. **Tune `ScanBatchSize` for your cache size** — moderate (1000–2000) for a
   large busy cache.
3. **Consider reader-endpoint scans** (`scaleReads: 'slave'`) so browse load
   doesn't hit the write primary.
4. **Decide Cognito user provisioning** (SES vs console vs custom resource).
5. **Consider provisioned concurrency** if cold-start latency is annoying.
6. **Custom domain (optional)** — the tool works fine on the
   `*.cloudfront.net` URL; add ACM + Route 53 only if you want a branded URL.

---

## 13. Cost

At low internal usage (a handful of engineers, occasional browsing):

- **Lambda, API Gateway, S3, CloudFront, Cognito** — effectively within free
  tiers / a few dollars a month combined. CloudFront's 1 TB/month egress is
  always-free; the API HTTP API is $1/M requests; Lambda's 1M requests/month
  is free.
- **The ElastiCache cluster is the dominant cost** (node-hours), but that's
  your existing cache — the browser doesn't add to it beyond minor read load.
- **CloudFront invalidations** — first 1000 paths/month free.

The browser tool itself is essentially free to run; the cache it reads is the
only meaningful line item, and you already own that.

---

## 14. File manifest

```
cache-browser/
├── templates/
│   ├── env-stack.yaml      Template 1 (environment; test-env or reference)
│   └── app-stack.yaml      Template 2 (the application — deploy this)
├── lambda/
│   ├── handler.js          The Lambda (browse/dump/getValue)
│   ├── seed.js             One-off test-data seeder (test env only)
│   ├── package.json        Dependencies (run npm install, then zip)
│   └── README.md           Build + seed steps, gotchas
└── frontend/
    ├── src/
    │   ├── config.ts        EDIT THIS — 4 values from stack outputs
    │   ├── auth.ts          Cognito login (USER_PASSWORD_AUTH)
    │   ├── api.ts           Calls the 3 endpoints with the JWT
    │   ├── LoginScreen.tsx  Login + first-time password change
    │   ├── BrowserScreen.tsx Prefix browse, dump, key detail
    │   ├── App.tsx, main.tsx
    ├── README.md            Build + deploy steps
    └── package.json, vite.config.ts, tsconfig.json, index.html
```

---

## 15. Quick reference — the two ACL strings

```
# While seeding (write access, test env only):
on ~* &* +@all +cluster +info

# Normal operation (read-only):
on ~* &* -@all +@read +@connection +cluster +info
```

Never drop `+cluster +info` — browse breaks without it in cluster mode.
