# Windows 11 collector runbook

## Prerequisites

- Windows 11 with PowerShell 5.1 or PowerShell 7.
- Node.js 24 or later and pnpm 11.19 available to the account that will run the task.
- A reachable Snapchain source and either a preferred local Hypersnap gRPC node, the reviewed HTTPS fallback, or an explicit decision to mark the missing source unavailable.
- A Cloudflare ingest URL and matching Wrangler-managed HMAC secret for production delivery.
- NTFS storage with room for at least 31 days of bounded analytics state plus retry headroom.

Do not start full Snapchain/Hypersnap nodes merely because the collector cannot connect. First probe the expected endpoints and review upstream snapshot, database, network, and retention requirements. Archival/long-retention nodes can consume substantial disk and bandwidth.

## Bootstrap

From an ordinary PowerShell session:

```powershell
Copy-Item .env.example .env
./scripts/bootstrap.ps1 -EnvFile .env
```

Bootstrap checks Windows, Node/pnpm versions, installs the locked workspace, creates the configured data/log directories, and runs the collector doctor. It does not launch or expose an upstream node and never prints secret values.

Edit `.env` before a continuous run. Use bare `host:port` gRPC values with no scheme. `127.0.0.1:4383` is only the host remap for a co-located Hypersnap container whose internal port remains `3383`.

```dotenv
SNAPCHAIN_GRPC_URL=127.0.0.1:3383
HYPERSNAP_GRPC_URL=127.0.0.1:4383
SNAPCHAIN_GRPC_TLS=false
HYPERSNAP_GRPC_TLS=false
HYPERSNAP_EXPECTED_PEER_ID=
HYPERSNAP_EXPECTED_VERSION=
HYPERSNAP_RPC_TIMEOUT_MS=5000
HYPERSNAP_FALLBACK_HTTP_URL=https://haatz.quilibrium.com
HYPERSNAP_FALLBACK_EXPECTED_PEER_ID=12D3KooWMYfkXiNcn9LifPkLYiHtGmXYnknYG1yFBD53rUseUMUc
HYPERSNAP_FALLBACK_EXPECTED_VERSION=0.13.3
HYPERSNAP_FALLBACK_POLL_INTERVAL_MS=5000
HYPERSNAP_FALLBACK_RPC_MIN_INTERVAL_MS=1000
HYPERSNAP_FAILOVER_AFTER_FAILURES=3
HYPERSNAP_PREFERRED_RECOVERY_INTERVAL_MS=60000
HYPERSNAP_PREFERRED_RECOVERY_SUCCESSES=3
HYPERSNAP_MAX_BLOCK_DELAY_SECONDS=30
SNAPCHAIN_GRPC_API_KEY=
SNAPCHAIN_RPC_MIN_INTERVAL_MS=0
SNAPMETER_INGEST_URL=
SNAPMETER_INGEST_SECRET=
SNAPMETER_DATA_DIR=C:\ProgramData\SnapMeter
```

After a verified deployment, fill the URL with the exact origin plus `/api/v1/ingest/batch` and place the matching Wrangler-managed secret only in this local file. Restrict `.env` ACLs to the collector account and administrators.

For Neynar-hosted Snapchain, set `SNAPCHAIN_GRPC_URL=snapchain-grpc-api.neynar.com:443`, `SNAPCHAIN_GRPC_TLS=true`, and `SNAPCHAIN_GRPC_API_KEY` to the key from the Neynar developer portal. Set `SNAPCHAIN_RPC_MIN_INTERVAL_MS=250` to serialize GetEvents request starts across both shard workers at no more than four starts per second. If no independent Hypersnap source is available, set `HYPERSNAP_SOURCE_MODE=unavailable`. The collector never prints the API-key value.

The checked-in Hypersnap fallback is the public node that the [official portal](https://hypersnap.org/) showed healthy during implementation. The portal does not publish node age or historical uptime, so do not describe it as the oldest or highest-uptime node. Its exact peer/version pins are public identity metadata. Leave the optional preferred `HYPERSNAP_EXPECTED_*` values blank until you have recorded the local node's actual identity; the collector still durably enrolls the first accepted identity.

## Interactive operation

```powershell
./scripts/run-collector.ps1 -EnvFile .env -Mode doctor
./scripts/run-collector.ps1 -EnvFile .env -Mode run
./scripts/run-collector.ps1 -EnvFile .env -Mode status
./scripts/run-collector.ps1 -EnvFile .env -Mode backfill
./scripts/check-health.ps1 -EnvFile .env
```

Stop an interactive run with `Ctrl+C`. Graceful shutdown preserves transaction boundaries and outbox state. Backfill is bounded reconciliation and must update historical buckets without visual pulses.

## Hypersnap failover operation

`HYPERSNAP_GRPC_URL` remains preferred even when it is still syncing. At startup the collector uses the HTTPS fallback if the local endpoint is unreachable, incomplete, over `HYPERSNAP_MAX_BLOCK_DELAY_SECONDS`, or incompatible. During a fallback session it probes local every `HYPERSNAP_PREFERRED_RECOVERY_INTERVAL_MS`; the defaults require three consecutive successes before switching back. A failed preferred probe resets that recovery count. `HYPERSNAP_RPC_TIMEOUT_MS=5000` bounds both Hypersnap transports independently, so a longer Snapchain/Neynar timeout does not make fallback probes hang for the same duration.

Activation is stricter than a successful TCP/HTTP probe. The collector requires all expected positive data shards, exact configured peer/version pins, a stable durable enrollment, and the same event fingerprint at each existing cursor. The HTTPS endpoint exposes canonical events only, so Hypersnap remains `derived`. A live probe found only about three days of retained events; expect the 30-day metric to remain partial after cold start, and expect failover to be rejected if the durable cursor has already fallen outside public retention.

Use `doctor` before the first continuous run and after any endpoint, peer, or version change. If a reviewed upstream upgrade changes the version, endpoint identity, or shard set, an environment-pin edit alone is intentionally insufficient: stop the collector, back up its complete data directory, inspect the upstream/API change, and use a release-provided enrollment migration. Do not edit SQLite, delete cursors, or erase enrollment to force acceptance.

## Scheduled Task

Default, per-user startup after logon:

```powershell
./scripts/install-collector-task.ps1 -EnvFile .env
Get-ScheduledTask -TaskName SnapMeterCollector
Start-ScheduledTask -TaskName SnapMeterCollector
```

The task uses the current interactive account, starts at logon, ignores duplicate starts, restarts after failure, and records logs under the resolved log directory. It does not store or print an account password.

For a boot-time task, open an elevated PowerShell and explicitly choose `SYSTEM`:

```powershell
./scripts/install-collector-task.ps1 -EnvFile .env -AtBoot
```

Boot mode resolves Node, pnpm, project, env, data, and log paths at install time because `SYSTEM` has a different profile. Ensure those paths are readable by `SYSTEM` and keep the data/log directories off user-only encrypted or removable storage. Prefer the normal logon task unless collection before login is genuinely required.

Remove either task safely:

```powershell
./scripts/uninstall-collector-task.ps1
```

Uninstalling the task does not delete databases, logs, `.env`, or outbox data.

## Data, logs, and permissions

If `SNAPMETER_DATA_DIR` is empty, scripts resolve `%LOCALAPPDATA%\SnapMeter`. Production boot tasks should use an explicit absolute path, commonly `C:\ProgramData\SnapMeter`. Logs default to a `logs` child directory. The runner keeps `collector-*.log` files for 14 days by default; set `SNAPMETER_LOG_RETENTION_DAYS` from 1 through 365. Cleanup resolves and verifies every target under the configured log directory before deletion. The SQLite database, lock, health snapshot, and outbox remain local. Schema v4 keeps the authoritative collector ID, actor pseudonym key, endpoint enrollments, and event fingerprints inside the SQLite database; never print, extract, or export that key separately.

Check free space regularly:

```powershell
Get-Volume -DriveLetter C | Select-Object DriveLetter,SizeRemaining,Size
Get-ChildItem C:\ProgramData\SnapMeter -Recurse -File |
  Measure-Object -Property Length -Sum
```

Do not delete a live database or outbox to clear space. Stop the task, preserve a backup, use documented retention/maintenance, run integrity checks, and restart only after confirming the path and capacity.

### Backup and failover

The production D1 dataset accepts only its registered collector ID. A separately initialized collector has a different ID and pseudonym key and is rejected; do not run two independent collector databases against the same dataset.

For backup or failover, stop the Scheduled Task, confirm the collector process has exited, and copy the entire resolved data directory as one SQLite-consistent unit. Preserve `snapmeter.sqlite3` together with any `snapmeter.sqlite3-wal` and `snapmeter.sqlite3-shm` files, the outbox, and their access controls. Restore that stopped state as a unit before starting the replacement host. Do not copy only a live main database, and do not move the pseudonym key into `.env` or another key store.

An intentional move to a fresh database requires the guarded manual reset of `collector_binding` documented in [Cloudflare deployment](deployment.md#collector-binding). Prefer a UTC-day boundary when no older-day reconciliation is pending; otherwise clear and deliberately rebuild affected cloud actor-day membership so two key domains cannot inflate DAU. This is an operator recovery action, not automatic failover. A schema-v4 database must not be opened by a pre-v4 collector binary; restore a compatible pre-upgrade database or fix forward.

## Firewall and port binding

- Bind local gRPC only to `127.0.0.1` when the collector is on the same host.
- Do not create public inbound firewall rules for `3383` or `4383`.
- If a private remote endpoint is required, restrict inbound source addresses, terminate TLS, and use optional authorization metadata.
- Permit outbound HTTPS to the deployed Worker, any authenticated TLS proxy, and the configured Hypersnap HTTPS fallback.
- Snapchain gossip (`3382/UDP`) and HTTP compatibility (`3381/TCP`) are node concerns, not collector requirements.

The node override example requires Docker Compose 2.24.4 or later for the `!override` tag. It replaces inherited port lists, then binds both RPC mappings to loopback; this avoids silently retaining a colliding or public base mapping. Add any required HTTP/gossip ports back with distinct reviewed publications.

Optional collector-only Compose operation:

```powershell
docker compose --profile collector up -d
docker compose --profile collector logs -f collector
```

The Compose service exposes no inbound port, stores SQLite state in a named volume, and caps container JSON logs at three 10 MiB files. It uses `host.docker.internal:3383` and `host.docker.internal:4383` by default; set `SNAPCHAIN_GRPC_URL_DOCKER`/`HYPERSNAP_GRPC_URL_DOCKER` in the shell or Compose environment for another topology. The fallback URL and identity/policy variables pass through the existing `.env` file, and the container needs outbound HTTPS access. `docker-compose.nodes.override.yml` is a reference fragment for Compose 2.24.4+ to merge into a reviewed upstream node configuration, not a standalone node launcher.

## WSL2 and Docker Desktop

Windows `127.0.0.1` forwarding into WSL2/Docker can vary with version and mirrored-networking settings. Test from the same environment that runs the collector:

```powershell
Test-NetConnection 127.0.0.1 -Port 3383
Test-NetConnection 127.0.0.1 -Port 4383
```

For a collector container talking to Windows-hosted nodes, use `host.docker.internal`. For a Windows collector talking to containers, publish `127.0.0.1:3383:3383` and `127.0.0.1:4383:3383`. Avoid WSL's transient VM address in persistent configuration. Windows sleep suspends collection; reconciliation fills retained gaps on resume, but a gap older than upstream retention remains partial.

## Updates and recovery

1. Stop the scheduled task and confirm no collector process remains.
2. Back up `.env` and the data directory without exposing them in source control.
3. Pull the reviewed release and run `./scripts/bootstrap.ps1 -SkipDoctor`.
4. Run `./scripts/run-collector.ps1 -EnvFile .env -Mode doctor`, including database integrity/cursor checks.
5. Reinstall the task so its resolved executable paths and arguments match the release.
6. Start it and run `./scripts/check-health.ps1`.

Never reset cursors to hide an error. Preserve the database/outbox and diagnose source retention or protocol compatibility first.
