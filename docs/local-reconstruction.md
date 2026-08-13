# Local reconstruction

This guide reconstructs SnapMeter from a clean public checkout without copying any private credential, production database, collector state, log, or node snapshot. The deterministic dashboard and the complete validation suite require no private data. A live deployment becomes useful only after an operator supplies their own infrastructure and newly generated credentials.

## Reproducibility boundary

| Material | In the repository? | Reconstruction rule |
|---|---:|---|
| Dashboard, Worker, collector, shared packages, tests, migrations, scripts, documentation | Yes | Restore from the selected SnapMeter Git commit. |
| Locked JavaScript dependency graph | Yes | Run `pnpm install --frozen-lockfile`; do not commit `node_modules`. |
| Farcaster Mini App images and public signed `accountAssociation` | Yes | These are public release metadata. A custody private key is never stored here. |
| Snapchain-compatible protobuf subset | Yes | Pinned to the Snapchain SHA below and subject to the upstream license noted in `THIRD_PARTY_NOTICES.md`. |
| `.env`, `.env.*`, `.dev.vars*`, API keys, auth headers, ingest secrets, Cloudflare tokens | No | Create fresh local values or provision them in the target secret store. Never recover them from Git. |
| Production D1 contents and local `.wrangler` state | No | Recreate the schema from `migrations/`; begin with an empty database. |
| Collector SQLite database, WAL files, cursor, outbox, health snapshot, and logs | No | Let the collector create fresh bounded state outside the repository. |
| Snapchain/Hypersnap source trees, binaries, images, chain databases, and snapshots | No | Obtain them separately at the pinned commits and follow their own build, license, and operator documentation. |
| Historical DAU values | No | Rebuild prospectively from an upstream node or from an independently trusted operator-owned history source. |

Excluding state is intentional. A source release should not contain production telemetry, user-level databases, local paths, or access material.

## Exact source pins

The runtime classifier and vendored protocol definitions were audited against these immutable upstream commits:

| Upstream | Repository | Commit |
|---|---|---|
| Snapchain | `https://github.com/farcasterxyz/snapchain` | `6152402aea2dbe732fb73076f674b038bfd4aee5` |
| Hypersnap | `https://github.com/farcasterorg/hypersnap` | `2eee4c9f2a7833ce7971dfef028480abbe9c4720` |

Do not replace either SHA with a branch name or a floating tag. See [Pinned upstream sources](upstream-sources.md) for the inspected package versions, protocol behavior, retention limits, and upgrade procedure.

## Prerequisites

Required for the application and tests:

- Git.
- Node.js 24 or later. Node 24 is required for the collector's stable `node:sqlite` API.
- pnpm exactly `11.19.0`, as declared by the root `packageManager` field.
- Internet access for the initial locked dependency download, unless the pnpm store is already populated.

Optional by task:

- Playwright Chromium for end-to-end tests.
- PowerShell 5.1 or PowerShell 7 on Windows for the bootstrap and Scheduled Task scripts.
- A local Docker engine; Docker Compose 2.24.4 or later is required only for the documented `!override` node-port fragment.
- A Cloudflare account for remote deployment. The workspace already pins Wrangler, so no global Wrangler installation is needed.
- Private or authenticated Snapchain-compatible gRPC endpoints for live collection.

Confirm the required toolchain before installing:

```powershell
node --version
pnpm --version
git --version
```

## Clean checkout and locked install

```powershell
git clone https://github.com/ael-dev3/SnapMeter.git
Set-Location SnapMeter
git rev-parse --verify HEAD
git status --short
pnpm install --frozen-lockfile
```

`git status --short` should be empty before installation. Record the printed SnapMeter commit when reproducing a specific release. The lockfile, workspace build allowlist, exact direct dependency versions, vendored protobufs, and SQL migrations are part of that commit.

Do not copy an existing `node_modules`, `.wrangler`, `.env`, database, or build directory into the checkout. They are neither required nor trustworthy reconstruction inputs.

## Reproduce the dashboard without private data

Start the Cloudflare/Vite development server:

```powershell
pnpm dev
```

Open the printed loopback URL with `?demo=1`, normally:

```text
http://127.0.0.1:5173/?demo=1
```

Demo mode is deterministic and synthetic. It bypasses API hydration and the live WebSocket, remains visibly labelled `DEMO`, and never silently substitutes for production data. No `.env`, credential, node, D1 data, or collector process is needed.

For a local empty Worker/D1 environment, use a deliberately disposable value of at least 32 characters and apply only local migrations:

```powershell
$env:SNAPMETER_INGEST_SECRET = 'local-development-only-not-a-real-secret'
pnpm --filter @snapmeter/dashboard exec wrangler d1 migrations apply snapmeter-prod --local
pnpm --filter @snapmeter/dashboard dev --host 127.0.0.1
```

`--local` is important: it creates ignored development state under `.wrangler` and does not mutate production D1. Without collector input, the normal dashboard should truthfully show unavailable/disconnected sources rather than invented activity.

## Reproduce tests and the production bundle

Install the browser once when end-to-end coverage is required:

```powershell
pnpm exec playwright install chromium
```

On Linux CI hosts, use `pnpm exec playwright install --with-deps chromium` instead. Run the same gates as pull-request CI:

```powershell
pnpm lint
pnpm typecheck
pnpm security:check
pnpm test
pnpm build
pnpm test:e2e
```

The test suites use temporary/in-memory state and non-production fixture secrets. `pnpm build` validates Mini App metadata and creates distributable output under ignored `dist` directories. A release deployment performs the stricter signed-association check.

## Reconstruct a local collector

The collector can be built and tested without a node, but a meaningful `doctor`, backfill, or continuous run needs at least one reachable source. Create a local environment from the public blank template:

```powershell
Copy-Item .env.example .env
```

Edit `.env` locally. Leave credentials blank unless your endpoint requires them. If one source is absent, set its source mode to `unavailable`; do not point both source names at one endpoint and present the result as an independent comparison.

For local nodes, the documented host endpoints are:

```dotenv
SNAPCHAIN_GRPC_URL=127.0.0.1:3383
HYPERSNAP_GRPC_URL=127.0.0.1:4383
SNAPCHAIN_GRPC_TLS=false
HYPERSNAP_GRPC_TLS=false
```

Both upstream node types use internal gRPC port `3383`. Port `4383` is only the loopback host remap for a co-located Hypersnap node. Never publish either native plaintext RPC port to the Internet.

Choose a data directory outside the Git checkout. On Windows the default is `%LOCALAPPDATA%\SnapMeter`; an explicit secondary-drive layout is also valid:

```dotenv
SNAPMETER_DATA_DIR=D:\SnapMeter\collector
```

The collector creates and migrates `snapmeter.sqlite3` itself, including its WAL, cursors, local identity, schema-v3 actor pseudonym key, bounded analytics state, and durable delivery outbox. These files must remain untracked. A clean reconstruction creates a new collector ID and key inside its new database; neither value comes from production or belongs in configuration. Never inspect, print, extract, or export the key separately.

Pair that new collector only with the clean local or remote D1 dataset created for the reconstruction. Migration `0005_collector_binding.sql` makes the first non-doctor delivery claim that dataset's global collector slot; an empty doctor probe only validates access and does not claim it. An existing production D1 dataset rejects a newly reconstructed database with HTTP 409 `collector_identity_conflict`. Production failover therefore restores the entire stopped, WAL-consistent collector state rather than reconstructing a new database; follow the [Windows runbook](windows-runbook.md).

To deliver to a local Worker, set the exact loopback ingest URL printed by Vite and use the same disposable local secret in both processes:

```dotenv
SNAPMETER_INGEST_URL=http://127.0.0.1:5173/api/v1/ingest/batch
SNAPMETER_INGEST_SECRET=replace-with-a-new-local-value-at-least-32-characters
```

Then run:

```powershell
./scripts/run-collector.ps1 -EnvFile .env -Mode doctor
./scripts/run-collector.ps1 -EnvFile .env -Mode run
```

The runner imports `.env` into the collector process, validates the configuration, and redacts sensitive values from terminal/file logs. Direct `pnpm collector ...` commands read only the current process environment; they do not load `.env` automatically.

Use `Ctrl+C` for a graceful stop. `./scripts/run-collector.ps1 -EnvFile .env -Mode status` reads the last local health snapshot, and `./scripts/run-collector.ps1 -EnvFile .env -Mode backfill` performs bounded reconciliation without generating fake live pulses. On Windows, `./scripts/bootstrap.ps1` combines the locked install, directory checks, endpoint probes, and doctor; [the Windows runbook](windows-runbook.md) covers Scheduled Task installation and recovery.

## Obtain optional upstream node source

A clear sibling layout keeps external GPL projects and heavyweight state out of the SnapMeter repository:

```text
C:\src\SnapMeter\
C:\src\upstream\snapchain\
C:\src\upstream\hypersnap\
D:\SnapMeter\collector\
D:\SnapMeter\nodes\snapchain\
D:\SnapMeter\nodes\hypersnap\
```

From `C:\src\SnapMeter`, clone and detach the inspected revisions:

```powershell
New-Item -ItemType Directory -Force ..\upstream | Out-Null
git clone https://github.com/farcasterxyz/snapchain.git ..\upstream\snapchain
git -C ..\upstream\snapchain switch --detach 6152402aea2dbe732fb73076f674b038bfd4aee5
git clone https://github.com/farcasterorg/hypersnap.git ..\upstream\hypersnap
git -C ..\upstream\hypersnap switch --detach 2eee4c9f2a7833ce7971dfef028480abbe9c4720
git -C ..\upstream\snapchain rev-parse HEAD
git -C ..\upstream\hypersnap rev-parse HEAD
```

The last two commands must print the exact full SHAs above. Build and configure each node from the documentation contained in that detached checkout. SnapMeter deliberately does not duplicate upstream build flags, bootstrap peers, snapshots, or chain configuration because those operational details can change independently and have material storage/network consequences.

`docker-compose.nodes.override.yml` is an illustrative Compose 2.24.4+ fragment for a separately reviewed upstream-node project. It is not a standalone node launcher. It binds Snapchain host port `3383` and Hypersnap host port `4383` to each container's internal port `3383`, both on loopback.

An exact 30-day cold start requires at least 31 days of authoritative event retention or a separately trusted history source. The pinned default Snapchain HubEvent retention is only three days. Missing older history must remain visibly partial until sufficient prospective coverage accumulates.

## Reconstruct Cloudflare resources

Local reconstruction never requires Cloudflare. For a separate remote environment, create a new D1 database, update only that environment's database ID, apply every checked-in migration in order, create a new ingest secret, and deploy with a least-privilege account token. Do not reuse SnapMeter production D1 contents or credentials.

```powershell
pnpm --filter @snapmeter/dashboard exec wrangler d1 create snapmeter-prod
pnpm --filter @snapmeter/dashboard exec wrangler d1 migrations apply snapmeter-prod --remote
pnpm --filter @snapmeter/dashboard exec wrangler secret put SNAPMETER_INGEST_SECRET
pnpm --filter @snapmeter/dashboard run deploy
```

Review and replace the checked-in production database identifier before targeting another account. D1 database identifiers and the Farcaster `accountAssociation` are public configuration, not authorization credentials; Cloudflare tokens, ingest secrets, RPC keys, and Farcaster custody keys are secrets. Follow [Cloudflare deployment](deployment.md) for first-deploy smoke tests, CI secret names, and rollback.

## Pre-publication secret check

Ignoring a file now does not remove it from earlier commits. Before publishing any branch:

1. Rotate any credential that was pasted into chat, a terminal command, an issue, a log, or a previously published commit. Treat it as exposed even if the message or file was later deleted.
2. Confirm only the blank template is tracked among environment files:

   ```powershell
   git ls-files '.env*' '.dev.vars*' '.collector.env'
   ```

   The expected output is only `.env.example`.

3. Confirm local credential and state files are ignored:

   ```powershell
   git check-ignore -v .env .env.neynar .env.collector.production .dev.vars
   git status --ignored --short
   ```

4. Review every staged path and patch, including binary additions:

   ```powershell
   git diff --cached --name-status
   git diff --cached
   ```

5. Run a maintained secret scanner against both the working tree and complete Git history. Investigate findings; do not suppress a match merely to make CI green.
6. Never attach `.env`, `.wrangler`, SQLite/WAL files, node data, logs, raw ingest bodies, authorization headers, or diagnostic archives to a GitHub issue or release.

See [Security](security.md) for the complete data-minimization and credential-rotation policy. A public reconstruction is complete when the clean checkout installs from the lockfile, passes all gates, runs the deterministic demo, creates empty local schemas from source, and can accept operator-owned endpoints and newly provisioned secrets. Reproducing private historical data is neither required nor desired.
