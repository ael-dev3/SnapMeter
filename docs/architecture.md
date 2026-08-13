# Architecture

## System boundaries

SnapMeter separates private node access from public reads:

```text
Snapchain HubService --------------------+       signed, replay-safe batches
                                         +--> collector ------------------------+
Hypersnap local gRPC (preferred) --------+     SQLite + outbox + per-shard state |
Hypersnap HTTPS events (fallback only) --+                                         v
mobile/desktop browser <---- Worker read API <---- D1 + LiveRoom Durable Object
         ^                                                 |
         +--------------- hibernating WebSocket -----------+
```

The collector is the only component that talks to node RPC endpoints. Snapchain and the preferred local Hypersnap source use gRPC; the optional Hypersnap fallback uses a read-only HTTPS JSON API. The Worker is the only public write ingress. Browsers use same-origin HTTP reads and a public read-only WebSocket; they never see RPC or ingest credentials.

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

### Hypersnap endpoint state machine

The Hypersnap source has one preferred role and at most one fallback role. They are replicas for one source identity, not two streams: only one client/session and one set of shard workers is active at a time.

Before activation, either candidate must pass exact version/peer pins where configured, full positive-shard coverage, the maximum block-delay threshold, durable endpoint enrollment, and cursor continuity. For each nonzero durable cursor, `GetEvent`/`eventById` must return the same source/shard/event ID and normalized SHA-256 event fingerprint already stored locally. This prevents silent history replacement when changing transport or operator. It does not prove events not yet observed by the collector.

Startup tries preferred local gRPC first and then the HTTPS fallback. An active endpoint is abandoned after the configured count of repeated discovery failures or sustained incomplete coverage. While fallback is active, successful preferred probes accumulate at the configured recovery interval; a failed probe resets the count. Reaching the recovery-success threshold closes the fallback session, clears transient connection state, opens the preferred endpoint, and reconciles from the same durable cursors. Any incompatibility leaves the source unavailable/partial rather than resetting history.

The HTTP fallback maps `/v1/info`, `/v1/eventById`, and `/v1/events` to the collector RPC boundary. There is no public streaming method, so its `Subscribe` role is a bounded poller; `GetEvents` remains the durable authority. Default five-second head polling and one-second global request-start pacing keep two idle shard pollers near 0.4 requests per second while preserving request capacity for replay, trading a few seconds of pulse latency for bounded pressure on a public service.

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
| Preferred Hypersnap RPC unavailable | Activate the enrolled HTTPS replica only after its identity, shards, delay, cursor, and fingerprints validate; otherwise Hypersnap becomes `unavailable`. |
| Fallback active and preferred recovers | Require consecutive healthy preferred probes, then switch one session at a time and reconcile before trusting live pulses. |
| Endpoint identity/version/shards drift | Reject activation. An environment change alone cannot override durable enrollment. |
| Cursor predates fallback retention | Reject fallback continuity and remain unavailable/partial; never reset the cursor. |
