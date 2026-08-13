# Troubleshooting

Start with a redacted diagnostic snapshot:

```powershell
./scripts/check-health.ps1 -EnvFile .env
./scripts/run-collector.ps1 -EnvFile .env -Mode doctor
./scripts/run-collector.ps1 -EnvFile .env -Mode status
```

Do not paste `.env`, signatures, authorization headers, raw ingest bodies, or database files into an issue.

## Collector cannot reach a node

```powershell
Test-NetConnection 127.0.0.1 -Port 3383
Test-NetConnection 127.0.0.1 -Port 4383
```

- Values must be bare `host:port`, not `http://host:port`.
- Local native RPC normally uses `TLS=false`; remote TLS requires a proxy/terminator.
- Both upstream node types internally default to `3383`. `4383` works only when the Hypersnap host/container mapping was explicitly configured.
- Run the test from the same Windows account/container/WSL context as the collector.
- Check loopback binding and firewall before changing software.
- Do not automatically start a large node; verify storage/bandwidth/retention plans first.

For the Hypersnap HTTPS fallback, do not use `Test-NetConnection 127.0.0.1`. Run `check-health.ps1` or `doctor`; they probe the configured `/v1/info` endpoint without printing credentials. The fallback URL must be absolute HTTPS with no embedded credentials, query, or fragment, and both expected peer ID and expected version are required.

## Doctor reports protocol or shard problems

- A `shard_infos` entry for shard 0 is normal; it is block health, not an event subscription shard.
- Fewer positive shard entries than `num_shards` means partial coverage. Do not synthesize missing shards or extrapolate metrics.
- `mempool_size = 4294967295` means unavailable, not a huge backlog.
- `num_onchain_events = 0` is not useful at the pinned commits because the field is hardcoded.
- An unknown block protocol or enum requires a pinned-proto/source review. Unknown actions remain non-qualifying.
- A `GetEvent` `INTERNAL` error can mean missing data at this pin; it is not automatically a schema mismatch.

## History is partial

Default HubEvent retention is three days, so a new collector cannot reconstruct 30 exact days from a default node. Confirm configured retention of at least 31 days or import a trusted history source. Raw `ShardChunk.transactions.user_messages` cannot be counted directly because committed chunks can include invalid messages that produced `MERGE_FAILURE`. Inspect `node.historyCoverageStartMs` and keep the source's partial/degraded state and caveat until `node.historyComplete` is true.

## Events stall, duplicate, or arrive out of order

`Subscribe` is not gap-free. Verify that per-shard `GetEvents` reconciliation is running and the verified cursor advances only after local incorporation. Resume inclusively and deduplicate `(source, shard, event ID)`. Do not persist or manually reuse a terminal page token: the pinned server's `[null]` token can restart the scan.

Do not delete cursors to “unstick” collection. Preserve the database, stop duplicate processes/tasks, inspect the health snapshot and outbox, and run the bounded backfill command.

## No heartbeat pulse

This can be correct. Idle sources have no fake beat, and replay/catch-up/reconciliation never pulses. Confirm:

- the event is a fresh qualifying `MERGE_MESSAGE`;
- canonical action time is within live tolerance;
- the initial persisted scan and fixed overlap through the highest observed live event completed;
- source status is not stale/partial/unavailable;
- the WebSocket is connected and schema-compatible;
- reduced-motion mode is showing the accessible counter instead of animation.

## Hypersnap shows DERIVED or unavailable

`DERIVED` is the expected honest mode at the pinned Hypersnap commit. Public RPC exposes canonical merges, not per-message Hyper outcomes. It cannot be changed by enabling `[hyper]` or observing `hyper:v1`. `unavailable` means the configured canonical source is disconnected or too stale/partial to support the inference.

## Hypersnap fallback does not activate or return local

Look for redacted `source.endpoint_rejected`, `source.endpoint_switching`, and `source.preferred_probe_failed` records, then run `doctor`. Common fail-closed causes are:

- `/v1/info` peer ID or version no longer matches the exact environment pin;
- peer/version/URL/shard set differs from the role's durable enrollment;
- one or more positive data shards is absent, or block delay exceeds `HYPERSNAP_MAX_BLOCK_DELAY_SECONDS`;
- `eventById` cannot return the current durable cursor because the public endpoint's roughly three-day retention has passed;
- the cursor event's normalized fingerprint conflicts with the event already stored locally;
- an upgraded/fresh database has a legacy cursor without a bound fingerprint, which a fallback is not allowed to adopt;
- the preferred node has not yet passed `HYPERSNAP_PREFERRED_RECOVERY_SUCCESSES` consecutive probes at the configured interval.

Do not fix these failures by clearing cursors, editing `source_endpoint_enrollment`, widening block delay without investigation, or changing the expected peer/version until the endpoint and upstream change have been reviewed. Stop the collector, back up the whole data directory, confirm the [official public-node listing](https://hypersnap.org/), inspect the current `/v1/info` response through `doctor`, and use a reviewed release/migration for intentional re-enrollment. If both roles are unusable, keep Hypersnap visibly unavailable.

## Cloud ingest rejects a batch

- Confirm collector and Worker secrets match without printing either.
- Compare system clocks; timestamps outside five minutes must fail.
- Ensure content type and body bytes are unchanged after signing.
- Use a new unique batch ID/nonce; an exact replay should not be applied twice.
- Check schema version and request size.
- Verify the D1 replay/idempotency migration and `DB` binding.
- A temporary Worker failure should leave the batch in the durable local outbox.
- HTTP 409 `collector_identity_conflict` means D1 is already bound to another collector ID. Stop the new process and restore the complete registered collector database state. Do not weaken the check or delete its outbox. Moving intentionally to a fresh database requires the documented manual collector-binding reset and actor-day continuity plan.

## Site loads but status is stale/disconnected

Static asset health is not collector health. Check the collector task, last cloud acknowledgement, source heights/delay, and Worker status rows. The UI must continue showing stale/disconnected state until recent authenticated health arrives.

## WebSocket does not upgrade

Check the exact same-origin `/api/v1/live` URL, `LIVE_ROOM` binding/migration, proxy upgrade headers, browser console/CSP, and schema version. A normal HTTP body instead of status 101 often indicates the request did not reach the WebSocket route. Reconnect must hydrate from the latest snapshot without duplicating pulse counts.

## Scheduled Task exits or never starts

```powershell
Get-ScheduledTask -TaskName SnapMeterCollector | Get-ScheduledTaskInfo
Get-WinEvent -LogName Microsoft-Windows-TaskScheduler/Operational -MaxEvents 50
```

Re-run the installer after moving the repository or changing Node/pnpm paths. For `-AtBoot`, confirm the installer was elevated and `SYSTEM` can read the project/env and write data/log directories. For the default task, confirm the interactive user account matches the installer. The task settings prevent parallel collectors; also check for a manually started process.

Uninstalling/reinstalling the task does not remove state:

```powershell
./scripts/uninstall-collector-task.ps1
./scripts/install-collector-task.ps1 -EnvFile .env
```

## Disk or database warning

Stop the task before filesystem maintenance. Back up the exact data directory, verify free space and SQLite integrity through `doctor`, and retain the outbox. Do not recursively delete an unresolved environment path. Increase capacity or adjust reviewed bounded-retention settings; never erase data merely to make a health check green.
