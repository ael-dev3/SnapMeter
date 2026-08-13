# Cloudflare deployment

## Production resources

- Worker/static application: `snapmeter`
- D1 binding: `DB`
- Durable Object binding: `LIVE_ROOM`
- Ingest secret: `SNAPMETER_INGEST_SECRET`
- Deploy package: `@snapmeter/dashboard`

The deployment serves UI assets and `/api/v1/*` from one origin. Do not publish a URL until the full smoke test succeeds.

## Prerequisites

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm --filter @snapmeter/dashboard exec wrangler whoami
```

If `whoami` is unauthenticated, use `wrangler login` interactively or provide a scoped API token through the environment/CI. Do not put tokens in Wrangler config, source, command history, or the browser bundle.

## First deployment

The checked-in Wrangler configuration targets D1 database `snapmeter-prod` with its connected database ID. For a new Cloudflare account or deliberate replacement, create D1 once, then replace that ID without changing the `DB` binding name:

```powershell
pnpm --filter @snapmeter/dashboard exec wrangler d1 create snapmeter-prod
```

Generate the ingest secret with a cryptographically secure system facility and keep the local collector copy only in gitignored `.env`. Store the Worker copy interactively:

```powershell
pnpm --filter @snapmeter/dashboard exec wrangler secret put SNAPMETER_INGEST_SECRET
```

Apply D1 and Durable Object migrations before deploying code that depends on them:

```powershell
pnpm --filter @snapmeter/dashboard exec wrangler d1 migrations apply snapmeter-prod --remote
pnpm --filter @snapmeter/dashboard run deploy
```

Record the exact URL returned by Wrangler, but do not commit it yet.

## Required smoke test

Against the exact returned origin:

1. `GET /` returns the production dashboard successfully and static assets load without mixed content or console errors.
2. `GET /api/v1/status` succeeds and truthfully distinguishes application health from source/collector freshness.
3. `GET /api/v1/metadata` reports the expected schema/policy/source-pin metadata without secrets.
4. `GET /api/v1/summary` and all `24h|7d|30d` time-series variants validate against their runtime schemas.
5. `/api/v1/live` performs a WebSocket upgrade, sends an initial snapshot/status, survives reconnect, and accepts no write operation from a browser client.
6. An HMAC-signed test batch with a unique batch ID is accepted once; exact replay is rejected/idempotent and a stale timestamp is rejected.
7. The accepted live test packet creates one coalesced visible dashboard pulse with the preserved count. Replay/demo data cannot impersonate a live pulse.
8. Demo mode is clearly labelled and disabled in normal production behavior.
9. Mobile views at 360x800, 390x844, 393x852, and 430x932 have no horizontal overflow; Snapchain is above Hypersnap in the first viewport.

Only after those checks:

- confirm the `Open SnapMeter` link in `README.md` still matches the verified production URL;
- add the inspected production screenshot if the file exists and was visually checked;
- commit/push the README and deployment configuration;
- verify the remote README link and repeat homepage/status/WebSocket checks after the push.

Never guess a workers.dev hostname or claim deployment success from a local build.

## GitHub Actions

Pull requests run lint, typecheck, tests, build, and end-to-end coverage. The protected default branch may deploy only when these repository secrets are configured:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SNAPMETER_INGEST_SECRET`

The deployment workflow validates the full workspace, applies remote migrations to `snapmeter-prod`, writes the ingest secret to a permission-restricted temporary file, and passes it to Wrangler during deployment. Missing secrets produce a clear skipped deployment rather than a false success claim. Protect the production environment with required reviewers if the repository supports it.

Use a least-privilege Cloudflare token scoped to the target account's Workers Scripts, D1, and required deployment resources. Rotate it after suspected disclosure and remove stale GitHub environment approvals/runs as appropriate.

## Rollback

1. Stop collector delivery only if the deployed ingest contract is unsafe; keep the local outbox intact.
2. Use Cloudflare deployment history to roll back Worker code to the last compatible version.
3. Do not roll back D1 destructively. Migrations must be forward-safe; add a corrective migration.
4. Verify homepage, API, WebSocket, signature acceptance, and source-quality display.
5. Resume collectors and watch outbox drain/idempotency records.

Schema changes require backward compatibility across at least the collector retry horizon or a coordinated staged release. A deployment is not healthy merely because static assets respond.
