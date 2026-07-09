# Cache Browser Frontend — build and deploy

React + Vite + TypeScript single-page app. Logs in via Cognito (custom UI),
talks to the API Gateway endpoint with the JWT, browses/searches the cache.

## Runtime config (important — this is why the build is portable)

The four environment values (region, user pool, client, API URL) are NOT
compiled into the build. They live in **`config.json`**, a standalone file
that the app fetches at startup. This means **one built `dist/` works in any
environment** — you only edit `config.json`, never rebuild.

`config.json`:
```json
{
  "region": "us-east-1",
  "userPoolId": "...",         // Template 1 output: UserPoolId
  "userPoolClientId": "...",   // Template 2 output: UserPoolClientId
  "apiBaseUrl": "..."          // Template 2 output: ApiBaseUrl
}
```

These are not secrets — pool IDs and API URLs are public identifiers;
security comes from the JWT and CORS, not from hiding them.

## Option 1 — deploy a pre-built dist/ (no Node needed)

If you were handed a built `dist/` folder:

1. Edit `dist/config.json` with your four values (from CloudFormation outputs).
2. Upload the **contents** of `dist/` (index.html, config.json, assets/) to
   the React S3 bucket (Template 2 output `ReactBucketName`).
3. CloudFront → Invalidations → Create → `/*`. Wait ~1 min.
4. Open the CloudFront URL.

That's it — no build, no Node.

## Option 2 — build from source

Requires Node.js (`node -v` to check).

1. Edit `public/config.json` with your four values (or leave it and edit
   `dist/config.json` after building).
2. Build:
   ```
   npm install
   npm run build
   ```
   Produces `dist/` containing index.html, config.json, and assets/.
3. Upload the contents of `dist/` to the React S3 bucket.
4. Invalidate CloudFront (`/*`), wait ~1 min, open the URL.

## Re-deploying after frontend code changes

`npm run build` → upload `dist/` → invalidate `/*` → hard-refresh (Ctrl+Shift+R).
CloudFront caches; changes only show after invalidation.

## Changing only the config (no code change)

Edit `config.json` in the S3 bucket directly (or re-upload it), then
invalidate `/*`. No rebuild needed — that's the point of runtime config.

## Local development

```
npm run dev
```
Serves at http://localhost:5173. Put a `config.json` in `public/` with your
dev values; the dev server serves it at `/config.json`.
