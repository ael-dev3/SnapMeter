# Metric definitions and integrity policy

Policy version in code: `METRICS_POLICY_VERSION` in `packages/metrics/src/index.ts`. All time windows use UTC and have a start-exclusive, end-inclusive boundary.

## Qualifying record

An activity record qualifies only when all conditions hold:

1. It belongs to a configured source instance and a dynamically discovered positive data shard.
2. The HubEvent is `HUB_EVENT_TYPE_MERGE_MESSAGE` (numeric `1`).
3. `merge_message_body.message.data` exists.
4. `fid` is a canonical decimal integer from `1` through `2^32 - 1`.
5. The numeric message type maps through the reviewed allowlist.
6. The event has not already been incorporated under `(source instance, shard index, event ID)`.
7. Its action time resolves from the authority rules below.

Only the primary merged message counts. `deleted_messages` are replacement/conflict side effects and never count separately. Unknown future enum values are nonfatal but non-qualifying until reviewed.

Excluded from active-FID metrics: `PRUNE_MESSAGE`, `REVOKE_MESSAGE`, `MERGE_FAILURE`, `BLOCK_CONFIRMED`, `MERGE_ON_CHAIN_EVENT`, system `MERGE_USERNAME_PROOF`, channel-owner hints, node/peer maintenance, backfill processing, and merely receiving a historical replay. Those events may inform operational statistics.

## Source policies

Snapchain uses a closed allowlist tied to upstream SHA `6152402aea2dbe732fb73076f674b038bfd4aee5`. A successful canonical `MERGE_MESSAGE` qualifies only for the exact numeric values `1-8` and `11-21`:

| Values | Message types | Action family |
|---:|---|---|
| 1-2 | `CAST_ADD`, `CAST_REMOVE` | cast |
| 3-4 | `REACTION_ADD`, `REACTION_REMOVE` | reaction |
| 5-6, 14 | `LINK_ADD`, `LINK_REMOVE`, `LINK_COMPACT_STATE` | link |
| 7-8 | `VERIFICATION_ADD_ETH_ADDRESS`, `VERIFICATION_REMOVE` | verification |
| 11 | `USER_DATA_ADD` | user-data |
| 12 | `USERNAME_PROOF` | username-proof |
| 13 | `FRAME_ACTION` | other |
| 15 | `LEND_STORAGE` | storage-lending |
| 16-17 | `KEY_ADD`, `KEY_REMOVE` | key |
| 18-21 | `CHANNEL_UPDATE`, `CHANNEL_MEMBER`, `CHANNEL_PIN`, `CHANNEL_MODERATE` | channel |

`NONE` (0), absent/reserved numbers, and every unknown future value are rejected pending source inspection, an explicit policy decision, classifier-version update, and tests. The classifier must not treat an arbitrary nonzero enum as activity.

Hypersnap `derived` is a narrower closed set. It accepts only the exact shadow-store-eligible values at upstream SHA `2eee4c9f2a7833ce7971dfef028480abbe9c4720`:

| Value | Message type | Action family |
|---:|---|---|
| 1 | `CAST_ADD` | cast |
| 2 | `CAST_REMOVE` | cast |
| 3 | `REACTION_ADD` | reaction |
| 4 | `REACTION_REMOVE` | reaction |
| 5 | `LINK_ADD` | link |
| 6 | `LINK_REMOVE` | link |
| 7 | `VERIFICATION_ADD_ETH_ADDRESS` | verification |
| 8 | `VERIFICATION_REMOVE` | verification |
| 11 | `USER_DATA_ADD` | user-data |
| 12 | `USERNAME_PROOF` | username-proof |
| 14 | `LINK_COMPACT_STATE` | link |
| 15 | `LEND_STORAGE` | storage-lending |

`NONE` (0), `FRAME_ACTION` (13), `KEY_ADD` (16), `KEY_REMOVE` (17), channel messages (18-21), absent/reserved numbers, and unknown/future values are not Hyper-eligible at that pin. User-authored `MESSAGE_TYPE_USERNAME_PROOF` inside `MERGE_MESSAGE` is distinct from the excluded system HubEvent `MERGE_USERNAME_PROOF`.

## Exact windows

For a set of valid, deduplicated actions `A` and evaluation time `t`:

- **Rolling 24h active:** unique FIDs with `t - 24h < actionAt <= t`.
- **Previous 24h active:** unique FIDs with `t - 48h < actionAt <= t - 24h`.
- **Today UTC DAU:** unique FIDs with `00:00:00.000 UTC <= actionAt <= t`.
- **30d active:** unique FIDs with `t - 30d < actionAt <= t`.
- **Daily DAU:** unique qualifying FIDs in each UTC calendar day among the latest 30 days.
- **Active FIDs 5m:** unique FIDs with `t - 5m < actionAt <= t`.
- **Actions/minute 1m:** qualifying action count in the latest minute.
- **Actions/minute 5m:** qualifying action count in the latest five minutes divided by five.

The same FID is counted once per unique-FID window regardless of action count. It can appear once in each source because sources measure observations through distinct configured nodes. Never add two source totals and call the result network-wide unique activity without actor-level union data.

Current-versus-previous absolute change is `current24 - previous24`. Percentage change is `(current - previous) / previous * 100`; it is `null` rather than infinity when the previous value is zero.

## Time authority

Farcaster time is seconds since `2021-01-01T00:00:00Z`:

```text
unix_ms = farcaster_seconds * 1000 + 1609459200000
```

The authority hierarchy is:

1. Nonzero top-level `HubEvent.timestamp`, reconstructed by RPC from confirmed `ShardChunk.header.timestamp`.
2. The matching `BlockConfirmedBody.timestamp`.
3. A bounded `GetShardChunks` lookup for the shard and encoded block height in a specialist recovery path.
4. As a degraded fallback only, validated signed `MessageData.timestamp`.

The implemented hot-path adapter consumes the RPC-rewritten top-level event timestamp, then validated message time when that timestamp is unavailable; it does not issue a chunk lookup for each event. The event timestamp is confirmed inclusion time. Message time can be backdated and is weaker. Store receipt time independently for latency. A zero/unresolvable action time rejects the record; receipt time never silently becomes action time.

## Trends and baselines

The trend record contains current and preceding seven-day average daily DAU, absolute and percentage change, a 30-day least-squares daily-DAU slope, and useful-sample count.

- `Improving`: more than +2% and at least +2 average FIDs by default.
- `Worsening`: less than -2% and at least -2 average FIDs by default.
- `Stable`: between those thresholds.
- `Insufficient data`: fewer than seven useful UTC-day samples.

The meaningful absolute threshold is versioned configuration, not a UI guess. The 24-hour meter compares against the previous 24 hours and clearly labelled trailing median/range. The 30-day panel reports daily median, peak, seven-day average, and slope without inventing a target.

Latency p50/p95 uses nonnegative `receivedAtMs - actionAtMs` samples. The upstream `block_delay`, shard heights, reconciliation state, and collector age remain operational signals; they are not active-FID actions.

## Pulse eligibility

A record can pulse only when it is qualifying, handled after the connection's initial replay/fixed-overlap catch-up completes, and fresh under the configured live tolerance. Explicit backfill/reconciliation records stay replay-marked. Bursts are coalesced but retain event count. Idle sources render a flat baseline; there is no synthetic beat. Reduced-motion mode publishes an accessible count/status without animation.

## Completeness

Upstream default HubEvent retention is three days. A cold collector therefore cannot honestly reconstruct 30 days unless the node retains at least 31 days or a trusted prior aggregate/event source is imported. SnapMeter persists each source's earliest authoritative replay time as `historyCoverageStartMs`; until it reaches 30 days, `historyComplete` is false, status/quality is partial/degraded, and snapshots carry a visible history caveat. Raw shard transactions are not a safe backfill because committed chunks can contain messages that emitted `MERGE_FAILURE`.
