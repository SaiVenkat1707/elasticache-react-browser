# Cache Browser

Read-only web UI for browsing an **ElastiCache Valkey** cluster (cluster-mode enabled) by key prefix — like a filesystem for cache keys. Engineers log in with **Cognito**, drill down prefixes with counts, dump values under a path, and inspect individual keys (type, TTL, value).

Strictly **read-only** — no writes, deletes, or admin commands.

```
React SPA (S3 + CloudFront)
  │  Cognito JWT
  ▼
API Gateway (HTTP API)
  ▼
Lambda (VPC, IAM auth)
  ▼
ElastiCache Valkey (cluster mode, TLS)
```

## What it does

| API | Purpose |
|-----|---------|
| `GET /browse?path=...` | Next-level prefixes + key counts; leaf keys at this level |
| `GET /dump?path=...` | Key/value pairs under a prefix (capped) |
| `GET /getValue?key=...` | Single key — value, Redis type, TTL |

## Repo layout

```
cache-browser/
├── README.md
├── HANDOFF.md                 # production notes, limitations, gotchas
├── templates/
│   ├── env-stack.yaml         # test env only (VPC + cache + Cognito + API)
│   └── app-stack.yaml         # deploy this against existing infra
├── lambda/
│   ├── handler.js
│   ├── seed.js                # test-data seeder (optional)
│   └── README.md
└── frontend/
    ├── public/config.json     # runtime config (not compiled in)
    └── README.md
```

## Prerequisites

- Existing **Valkey cluster-mode** cache with **IAM auth** and **TLS**
- Existing **Cognito User Pool** and **HTTP API (API Gateway v2)**
- VPC with **2+ private subnets** for the Lambda
- Node.js (to build Lambda zip and/or frontend)

For a greenfield test environment, deploy `templates/env-stack.yaml` first — see [HANDOFF.md](./HANDOFF.md).

## Deploy (existing environment)

**1. Build and upload Lambda**

```bash
cd lambda
npm install
zip -r cache-browser.zip handler.js package.json node_modules
```

Upload `cache-browser.zip` to your staging S3 bucket.

**2. Deploy app stack**

```powershell
aws cloudformation deploy `
  --template-file templates/app-stack.yaml `
  --stack-name cache-browser `
  --parameter-overrides `
    VpcId=vpc-xxx `
    PrivateSubnet1Id=subnet-aaa `
    PrivateSubnet2Id=subnet-bbb `
    CacheReplicationGroupId=your-cache-name `
    CacheConfigurationEndpoint=clustercfg.xxx.cache.amazonaws.com `
    CacheUserGroupId=your-user-group `
    CacheSecurityGroupId=sg-xxx `
    UserPoolId=region_xxx `
    UserPoolArn=arn:aws:cognito-idp:... `
    HttpApiId=abc123 `
    HttpApiEndpoint=https://abc123.execute-api.region.amazonaws.com `
    LambdaCodeBucket=your-staging-bucket `
    LambdaCodeKey=cache-browser.zip `
  --capabilities CAPABILITY_NAMED_IAM `
  --region your-region
```

Full parameter list: [HANDOFF.md §6](./HANDOFF.md#6-template-2-parameters).

**3. Build and deploy frontend**

Edit `frontend/public/config.json` with stack outputs (`UserPoolClientId`, `ApiBaseUrl`, etc.), then:

```bash
cd frontend
npm install
npm run build
```

Upload the **contents** of `dist/` to the React S3 bucket (`ReactBucketName` output). Invalidate CloudFront (`/*`).

> One built `dist/` works in any environment — only `config.json` changes between deploys. Details: [frontend/README.md](./frontend/README.md).

**4. Log in**

Open the `CloudFrontUrl` output. Set Cognito user passwords if needed (invites don't arrive for `@example.com` test users).

## Local development

```bash
cd frontend
npm install
npm run dev
```

Serve `public/config.json` with your dev API and Cognito values.

## Important limitations

- **Root browse scans the whole cache** — slow on large keyspaces; prefer narrow prefixes.
- **SCAN adds load** on busy shards — tune `ScanBatchSize` / `MaxKeysPerResponse` stack parameters.
- **Results can be truncated** when key counts exceed caps.
- **Cold starts** (~seconds) on first request after idle (VPC + TLS + IAM token).

Full discussion: [HANDOFF.md §8](./HANDOFF.md#8-known-limitations-and-disadvantages).

## Production checklist

Before pointing at a real cache:

1. Tighten **CORS** from `*` to your CloudFront URL
2. Replace test Cognito password flow with **SES** or your provisioning process
3. Tune scan parameters for cache size and traffic
4. Consider **provisioned concurrency** if cold starts matter

See [HANDOFF.md §12](./HANDOFF.md#12-recommended-changes-before-production-use).

## Teardown

Delete the `cache-browser` CloudFormation stack. If a partial deploy failed, check for leftover named resources (Lambda, ElastiCache user, log groups) — [HANDOFF.md §11](./HANDOFF.md#11-hard-won-gotchas-do-not-undo-these).
