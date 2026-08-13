# SnapMeter

**Live activity across Snapchain and Hypersnap.** SnapMeter is a mobile-first, real-time analytics dashboard for active Farcaster FIDs. It pairs a Windows-friendly collector with exact rolling metrics, a durable Cloudflare ingestion path, and a data-driven heartbeat that pulses only for newly observed qualifying activity.

## Live Dashboard

[Open SnapMeter](https://snapmeter.ael-dev3.workers.dev)

The public origin, API, authenticated ingest, D1 persistence, WebSocket hydration, real pulse fan-out, and duplicate suppression were smoke-tested after deployment. The collector is not connected to upstream nodes yet, so production honestly reports both sources as disconnected; use `?demo=1` only for the clearly labelled seeded preview.

## Source quality

- **Snapchain** uses successful canonical `MERGE_MESSAGE` HubEvents, so its evidence mode is `verified`; a separate status becomes stale, degraded, partial, or disconnected when coverage, freshness, or reconciliation is unhealthy.
- **Hypersnap** is currently reported as **Hypersnap observed active FIDs** with a visible `DERIVED` state. The value is inferred from successful canonical merges seen through the configured Hypersnap node whose message types are eligible for its Hyper shadow stores. Upstream exposes no per-write Hyper success stream, so SnapMeter does not claim those shadow writes were independently verified.
- **Unavailable, stale, degraded, and partial** states stay visible. Loading the website does not make a source live.

See [Data sources](docs/data-sources.md), [upstream pins](docs/upstream-sources.md), and the [complete metric policy](docs/metrics.md).

## Screenshot

![SnapMeter deterministic demo showing equal Snapchain and Hypersnap portrait regions](docs/screenshot-mobile.png)

Validated at **390 × 844** from the production bundle in deterministic demo mode. The `DEMO` labels distinguish these seeded synthetic values from live collector data.

## Metrics at a glance

| Metric | Exact definition |
|---|---|
| Rolling 24h active | Unique valid FIDs with a qualifying action in `(now - 24h, now]`. |
| Previous 24h active | Unique valid FIDs in `(now - 48h, now - 24h]`. |
| Today UTC DAU | Unique valid FIDs since `00:00:00 UTC` today. |
| 30d active | Unique valid FIDs in `(now - 30d, now]`; this is not called “30d DAU.” |
| Daily DAU | One unique-FID count for each of the latest 30 UTC calendar days. |

Action time comes from confirmed shard-chunk time when available. Collector receipt time is stored separately. Historical replay updates metrics silently and never creates a fake live pulse.

## Quick start

Requirements: Node.js 24 or later, pnpm 11.19, and reachable private Snapchain-compatible gRPC endpoints.

```powershell
git clone https://github.com/ael-dev3/SnapMeter.git
Set-Location SnapMeter
Copy-Item .env.example .env
./scripts/bootstrap.ps1
pnpm collector doctor
pnpm collector run
```

In a second terminal, start the local dashboard:

```powershell
pnpm dev
```

The convenience endpoint defaults are `127.0.0.1:3383` for Snapchain and `127.0.0.1:4383` for Hypersnap. Upstream Hypersnap also listens on internal port `3383`; `4383` is only the documented host remap when both nodes share one machine.

## Architecture

```text
Snapchain HubService ----+
                         +--> Windows collector --> SQLite + durable outbox
Hypersnap HubService ----+                              |
                                                        | signed batches
                                                        v
React/Vite assets <-- Cloudflare Worker API <-- D1 + hibernating Durable Object
        ^                                               |
        +---------------- WebSocket live fan-out --------+
```

The collector discovers positive data-shard IDs through `GetInfo`, maintains one durable cursor and one reconciliation state machine per source/shard, treats `GetEvents` as durable authority, and uses `Subscribe` for low latency. The browser never receives an ingest secret or direct node credentials. More detail is in [Architecture](docs/architecture.md).

## Collector setup

Edit `.env` before a production run. Keep both node RPC listeners private and provide the Cloudflare ingest URL and secret:

```dotenv
SNAPCHAIN_GRPC_URL=127.0.0.1:3383
HYPERSNAP_GRPC_URL=127.0.0.1:4383
SNAPCHAIN_GRPC_TLS=false
HYPERSNAP_GRPC_TLS=false
SNAPMETER_INGEST_URL=
SNAPMETER_INGEST_SECRET=
SNAPMETER_DATA_DIR=C:\ProgramData\SnapMeter
```

After deployment, set `SNAPMETER_INGEST_URL` to the smoke-tested origin plus `/api/v1/ingest/batch` and set the secret locally to the value stored with Wrangler. Never commit either value.

```powershell
pnpm collector doctor    # endpoints, shards, storage, clock, ingest auth, cursors, disk
pnpm collector run       # continuous collection
pnpm collector status    # last local health snapshot
pnpm collector backfill  # bounded reconciliation; never creates live pulses
```

Snapchain's default HubEvent retention is only three days. An exact 30-day cold start requires a node configured with at least 31 days of event retention or a trusted prior history. Otherwise SnapMeter exposes partial history until enough prospective data accumulates.

### Optional Docker collector

The default Compose profile runs only the collector and exposes no inbound port:

```powershell
docker compose --profile collector up -d
docker compose --profile collector logs -f collector
```

It expects `.env` and reaches Windows-hosted nodes through `host.docker.internal`. Override `SNAPCHAIN_GRPC_URL_DOCKER` or `HYPERSNAP_GRPC_URL_DOCKER` when needed. `docker-compose.nodes.override.yml` is a Compose 2.24.4+ illustrative fragment to merge into a separately reviewed upstream-node project; it replaces inherited port lists and maps host `3383` and `4383` to the two containers' internal `3383`. It deliberately cannot launch heavyweight nodes by itself.

## Windows startup

```powershell
./scripts/install-collector-task.ps1 -EnvFile .env
Get-ScheduledTask -TaskName SnapMeterCollector
./scripts/check-health.ps1 -EnvFile .env
./scripts/uninstall-collector-task.ps1
```

The default task starts at user logon and restarts after failure. Run the installer elevated with `-AtBoot` only when a boot-time `SYSTEM` task is appropriate. The installer validates configuration, creates data/log directories, and never prints secret values. See the [Windows runbook](docs/windows-runbook.md) for permissions, WSL2, firewall, storage, and recovery guidance.

## Cloudflare deployment

The production target is a single Cloudflare Worker named `snapmeter`, with D1 database `snapmeter-prod` bound as `DB`, Durable Object binding `LIVE_ROOM`, and secret `SNAPMETER_INGEST_SECRET`.

```powershell
pnpm install --frozen-lockfile
pnpm --filter @snapmeter/dashboard exec wrangler login
pnpm --filter @snapmeter/dashboard exec wrangler d1 migrations apply snapmeter-prod --remote
pnpm --filter @snapmeter/dashboard exec wrangler secret put SNAPMETER_INGEST_SECRET
pnpm --filter @snapmeter/dashboard run deploy
```

Do not publish a URL until all release smoke tests pass. Full creation, migration, secret, deployment, rollback, and GitHub Actions instructions are in [Deployment](docs/deployment.md).

## Validation

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Pull requests run the quality gates. Default-branch deployment is conditional on the required Cloudflare repository secrets. Operational and security checks are documented in [Troubleshooting](docs/troubleshooting.md) and [Security](docs/security.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Metric definitions and integrity policy](docs/metrics.md)
- [Data sources and source modes](docs/data-sources.md)
- [Pinned upstream sources](docs/upstream-sources.md)
- [Windows runbook](docs/windows-runbook.md)
- [Cloudflare deployment](docs/deployment.md)
- [Security model](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
