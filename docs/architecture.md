# Architecture

## System boundaries

SnapMeter separates private node access from public reads:

```text
Snapchain HubService ----+       signed, replay-safe batches
                         +--> collector ------------------------+
Hypersnap HubService ----+     SQLite + outbox + per-shard state |
                                                                 v
mobile/desktop browser <---- Worker read API <---- D1 + LiveRoom Durable Object
         ^                                                 |
         +--------------- hibernating WebSocket -----------+
```

The collector is the only component that talks to node gRPC endpoints. The Worker is the only public ingress. Browsers use same-origin HTTP reads and a public read-only WebSocket; they never see RPC or ingest credentials.

## Collector

At startup, each configured source calls `GetInfo`, extracts the exact distinct positive `shard_infos[].shard_id` values, and compares the discovered count with `num_shards`. Shard 0 is excluded from data-shard coverage and is never passed to event RPCs.

Health preserves `num_shards` as the expected data-shard count and reports currently connected explicit positive shards separately. Missing descriptors/connections therefore remain partial rather than being synthesized. The upstream mempool failure sentinel `4294967295` is normalized to unavailable (`null`).

Each `(source instance, shard)` owns:

- a durable last-verified event ID and an in-memory highest-seen live ID;
- a fixed-range `GetEvents` reconciliation loop;
- a low-latency `Subscribe` stream;
- a reconnect/catch-up event-ID boundary;
- block coverage and freshness observations;
- idempotency rows keyed by the source, shard, and exact decimal event ID.

`Subscribe` events and reconciled events enter one SQLite transaction path. Subscription arrival never skips an unseen range. The verified cursor advances only after the event, actor-window state, daily membership, and minute aggregate are safe. If a crash occurs before the subsequent checkpoint, inclusive replay is harmless because incorporation is idempotent. Backoff uses bounded exponential delay with jitter, and shutdown drains transaction boundaries without pretending an unacknowledged outbox item was delivered.

The local database retains only analytics metadata: event identity/type, FID, action/receipt times, replay classification, actor-window/day membership, compact time buckets, source health, cursors, and outbox state. It does not retain or upload cast text, signatures, or private RPC metadata. Retention is bounded but must preserve at least 31 days needed for exact metric reconstruction.

## Replay and completeness

`Subscribe.from_id` and `GetEvents.start_id` are inclusive. `GetEvents.stop_id` is exclusive. Reconciliation freezes a highest already-handled live event ID as its exclusive bound, pages one shard at a time, overlaps the last durable ID, and deduplicates. Because the bound event entered through the same idempotent handler before it became the bound, the scan fills lower gaps without applying that event twice.

The pinned server always returns a serialized page-token vector, including terminal `[null]`; following that token can restart a scan. The adapter therefore stops on a short page (with a final empty page at an exact boundary) and persists event IDs, never page tokens.

On connection, subscription callbacks are marked catch-up while the collector runs an initial persisted `GetEvents` scan and a fixed overlap through the highest event already observed live. Those records update the correct historical buckets without pulses. Only events handled after catch-up completes and whose canonical action time is fresh can pulse.

The earliest authoritative time reached through replay is persisted per source as `historyCoverageStartMs`. `historyComplete` becomes true only after that coverage reaches at least 30 days. Until then, source status/quality is partial/degraded and metric snapshots carry a visible history caveat even when RPC freshness and shard coverage are otherwise healthy.

## Metric engine

The local engine computes exact unique-FID sets for rolling 24-hour, previous 24-hour, today UTC, rolling 30-day, five-minute, and UTC actor-day windows. Source-independent formulas live in `packages/metrics`; source-specific classification lives in `packages/protocol`. See [metrics.md](metrics.md).

## Delivery and Cloudflare

The collector coalesces active pulses to approximately four packets per second, emits metric snapshots every few seconds, finalizes minute aggregates, and sends compact actor-day/health data needed for verification. Every batch has a schema version, unique ID/nonce, collector identity/version, send timestamp, source-tagged records, and an HMAC signature over the raw body. The local outbox retries until the Worker acknowledges the unique batch.

The Worker validates the request before storage, records batch idempotency in D1, updates indexed/pre-aggregated history, and forwards transient pulse/status changes to the `LIVE_ROOM` Durable Object. The hibernating object sends a latest snapshot on connection and coalesces broadcasts; it does not persist every visual frame.

Public endpoints are versioned:

```text
POST /api/v1/ingest/batch
GET  /api/v1/summary
GET  /api/v1/timeseries?range=24h|7d|30d
GET  /api/v1/status
GET  /api/v1/metadata
GET  /api/v1/live
```

D1 holds compact minute buckets, daily metrics/membership, snapshots, source status, cursor high-water marks, health samples, and bounded replay records. Scheduled cleanup finalizes aggregates and deletes expired detail; public queries use indexes and aggregates rather than raw scans.

## Failure semantics

| Failure | Behavior |
|---|---|
| gRPC stream disconnect | Mark stale as thresholds pass, reconnect with jitter, then reconcile before trusting continuity. |
| Replay/live race or lagged stream | Idempotent `GetEvents` reconciliation fills the gap. |
| Partial shard node | Continue covered shards but display `partial`/`degraded`; never extrapolate totals. |
| Missing canonical timestamp | Use the documented validated message-time fallback only when available; never substitute receipt time silently. |
| Cloud outage | Keep aggregates in the durable outbox and do not claim cloud acknowledgement. |
| Duplicate/out-of-order batch | Reject replay or idempotently return the existing result; do not double-count. |
| Stale collector | Public source status becomes stale/disconnected even if the site itself remains available. |
| Hypersnap RPC unavailable | Hypersnap becomes `unavailable`; derived metrics are not promoted to verified. |
