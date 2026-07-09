# Cache Browser Lambda — build and package

This folder contains the Lambda code. Before deploying Template 2, you need
to bundle this folder into a zip and upload it to the staging S3 bucket
that Template 1 created.

## One-time setup

Make sure Node.js is installed on your laptop:

```
node -v
```

If that prints a version number (e.g. `v22.x.x`), you're set. If it says
"command not found", install Node.js from https://nodejs.org (LTS version).

## Build steps

From inside this folder, run:

```
npm install
```

That downloads the libraries listed in `package.json` (Redis client, AWS
signature helpers, etc.) into a `node_modules/` folder.

Then zip up the folder contents — **not the folder itself**. On macOS/Linux:

```
zip -r cache-browser.zip handler.js package.json node_modules
```

On Windows, select `handler.js`, `package.json`, and `node_modules` together,
right-click → "Send to" → "Compressed (zipped) folder", and rename it to
`cache-browser.zip`.

The zip should contain those three items at the top level (no parent folder
wrapping them). You can verify by opening the zip — `handler.js` should be
visible immediately.

## Upload

1. Open AWS Console → S3.
2. Find the bucket from Template 1's outputs (named `cache-browser-env-lambda-staging-<account-id>`).
3. Click "Upload" → drag `cache-browser.zip` → Upload.

When you deploy Template 2, set the parameter `LambdaCodeKey` to
`cache-browser.zip` and `LambdaCodeBucket` to the bucket name above.

## Re-deploying after code changes

1. Edit `handler.js`.
2. Re-zip (don't need `npm install` again unless you changed `package.json`).
3. Upload the new zip to S3 (same name — overwrites the old one).
4. In CloudFormation, update the Template 2 stack — it'll detect the
   new zip and replace the Lambda code.

## Seeding test data (optional, for a fresh/empty cache)

`seed.js` writes ~300 sample keys across many prefixes and all Redis types,
so you have something to browse on a freshly deployed empty cache. It is NOT
part of the deployed app — it's a one-off you run manually.

To run it:

1. Temporarily give the cache user write access. In the ElastiCache console,
   set the `<app>-readonly` user's access string to:
   ```
   on ~* &* +@all +cluster +info
   ```
2. Paste `seed.js` into the Lambda code editor (replacing `handler.js`),
   Deploy, and run with an empty test event `{}`. Expect
   `{ "writtenOperations": ~300 }`.
3. Lock the user back down to read-only:
   ```
   on ~* &* -@all +@read +@connection +cluster +info
   ```
4. Restore the real `handler.js`.

## Two gotchas this code already handles (don't undo them)

These cost real debugging time; they're baked into the code now:

1. **Sign the IAM token with the replication group ID, not the endpoint host.**
   The token's `hostname` must be the cache name (e.g. `my-cache`), NOT the
   `clustercfg...` configuration endpoint. Signing with the endpoint host
   gives `WRONGPASS`.

2. **The cache user's access string needs `+cluster +info` explicitly.**
   In cluster mode, ioredis runs `CLUSTER`/`INFO` to discover shards. These
   are NOT covered by `+@all` under RBAC, so they must be added explicitly,
   even for the admin user. Without them you get `WRONGPASS` on the shard
   nodes and "Failed to refresh slots cache".

Also required for cluster + TLS (already in the code):
- `dnsLookup: (a, cb) => cb(null, a)` and
  `tls: { checkServerIdentity: () => undefined }` in the cluster options.
