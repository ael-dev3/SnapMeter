# Windows 11 collector runbook

## Prerequisites

- Windows 11 with PowerShell 5.1 or PowerShell 7.
- Node.js 24 or later and pnpm 11.19 available to the account that will run the task.
- Two reachable, private Snapchain-compatible gRPC endpoints, or an explicit decision to run only the available source.
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
SNAPMETER_INGEST_URL=
SNAPMETER_INGEST_SECRET=
SNAPMETER_DATA_DIR=C:\ProgramData\SnapMeter
```

After a verified deployment, fill the URL with the exact origin plus `/api/v1/ingest/batch` and place the matching Wrangler-managed secret only in this local file. Restrict `.env` ACLs to the collector account and administrators.

## Interactive operation

```powershell
./scripts/run-collector.ps1 -EnvFile .env -Mode doctor
./scripts/run-collector.ps1 -EnvFile .env -Mode run
./scripts/run-collector.ps1 -EnvFile .env -Mode status
./scripts/run-collector.ps1 -EnvFile .env -Mode backfill
./scripts/check-health.ps1 -EnvFile .env
```

Stop an interactive run with `Ctrl+C`. Graceful shutdown preserves transaction boundaries and outbox state. Backfill is bounded reconciliation and must update historical buckets without visual pulses.

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

If `SNAPMETER_DATA_DIR` is empty, scripts resolve `%LOCALAPPDATA%\SnapMeter`. Production boot tasks should use an explicit absolute path, commonly `C:\ProgramData\SnapMeter`. Logs default to a `logs` child directory. The runner keeps `collector-*.log` files for 14 days by default; set `SNAPMETER_LOG_RETENTION_DAYS` from 1 through 365. Cleanup resolves and verifies every target under the configured log directory before deletion. The SQLite database, lock, health snapshot, and outbox remain local.

Check free space regularly:

```powershell
Get-Volume -DriveLetter C | Select-Object DriveLetter,SizeRemaining,Size
Get-ChildItem C:\ProgramData\SnapMeter -Recurse -File |
  Measure-Object -Property Length -Sum
```

Do not delete a live database or outbox to clear space. Stop the task, preserve a backup, use documented retention/maintenance, run integrity checks, and restart only after confirming the path and capacity.

## Firewall and port binding

- Bind local gRPC only to `127.0.0.1` when the collector is on the same host.
- Do not create public inbound firewall rules for `3383` or `4383`.
- If a private remote endpoint is required, restrict inbound source addresses, terminate TLS, and use optional authorization metadata.
- Permit outbound HTTPS to the deployed Worker and any authenticated TLS proxy.
- Snapchain gossip (`3382/UDP`) and HTTP compatibility (`3381/TCP`) are node concerns, not collector requirements.

The node override example requires Docker Compose 2.24.4 or later for the `!override` tag. It replaces inherited port lists, then binds both RPC mappings to loopback; this avoids silently retaining a colliding or public base mapping. Add any required HTTP/gossip ports back with distinct reviewed publications.

Optional collector-only Compose operation:

```powershell
docker compose --profile collector up -d
docker compose --profile collector logs -f collector
```

The Compose service exposes no inbound port, stores SQLite state in a named volume, and caps container JSON logs at three 10 MiB files. It uses `host.docker.internal:3383` and `host.docker.internal:4383` by default; set `SNAPCHAIN_GRPC_URL_DOCKER`/`HYPERSNAP_GRPC_URL_DOCKER` in the shell or Compose environment for another topology. `docker-compose.nodes.override.yml` is a reference fragment for Compose 2.24.4+ to merge into a reviewed upstream node configuration, not a standalone node launcher.

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
4. Run `pnpm collector doctor`, including database integrity/cursor checks.
5. Reinstall the task so its resolved executable paths and arguments match the release.
6. Start it and run `./scripts/check-health.ps1`.

Never reset cursors to hide an error. Preserve the database/outbox and diagnose source retention or protocol compatibility first.
