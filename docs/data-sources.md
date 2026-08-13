# Data sources

## Source modes

| Mode | Meaning |
|---|---|
| `verified` | A dedicated authoritative source confirms the qualifying successful action and the collector's coverage/reconciliation checks are healthy. |
| `derived` | A canonical successful event plus a pinned classifier supports an inference, but the target side effect is not independently observable. |
| `unavailable` | No trustworthy source is connected or quality has fallen below the minimum for a defensible metric. |

Freshness and completeness are separate from mode. A verified adapter can still be stale, degraded, or partial.

## Snapchain

The canonical source is plaintext `HubService` gRPC on upstream port `3383`. SnapMeter uses:

- `GetInfo` for software version, expected and hosted shards, heights, delay, and storage/mempool signals;
- `Subscribe` with explicit `MERGE_MESSAGE` and `BLOCK_CONFIRMED` types for latency;
- `GetEvents` for ordered per-shard durable reconciliation;
- `GetEvent` to point-verify a durable cursor during `doctor` when that event remains inside upstream retention.

There is no reflection service, so the collector ships protobufs pinned to Snapchain SHA `6152402aea2dbe732fb73076f674b038bfd4aee5`. Native self-hosted gRPC is plaintext; remote services need TLS termination. Optional `authorization` metadata supports authenticated proxies, and optional `x-api-key` metadata supports hosted providers such as Neynar. Configure Neynar with `snapchain-grpc-api.neynar.com:443`, TLS enabled, and `SNAPCHAIN_GRPC_API_KEY`.

Event IDs encode `(block height << 14) | sequence` and are unique only within one data shard. Decimal-string IDs and per-shard cursors are mandatory. `Subscribe` has a replay-to-live race and a lagged receiver can lose live notifications, so periodic `GetEvents` reconciliation is authoritative.

`BLOCK_CONFIRMED` is emitted first, not last. Its `event_counts_by_type` and `total_events` help audit coverage, but receiving it does not prove every later event was processed.

## Hypersnap

At SHA `2eee4c9f2a7833ce7971dfef028480abbe9c4720`, Hypersnap is a Snapchain-compatible node on the same Farcaster network/consensus path with additional node-local Hyper-prefixed stores. Successful supported canonical messages are followed by a best-effort shadow merge in the same transaction batch; Hyper errors are logged and suppressed.

Hyper stores use a non-persisting event handler. Public `Subscribe`, `GetEvent`, `GetEvents`, HTTP event routes, and indexer broadcasts therefore contain canonical HubEvents only. `HyperEnvelope` is scaffold code rather than a verified source: its producer engine is not constructed, receivers ignore it, and its payload does not identify per-message Hyper write outcomes.

Consequently the current adapter is `derived` and means:

> A successful canonical `MERGE_MESSAGE` was observed through the configured Hypersnap endpoint, and the pinned classifier says its message type is one the node attempts to mirror into Hyper storage.

It does not mean the Hyper write succeeded. `[hyper].enabled=true`, the `hyper:v1` capability, matching query results, or equal Snapchain/Hypersnap totals do not upgrade that claim.

Hypersnap also uses upstream internal gRPC port `3383`. The SnapMeter default `127.0.0.1:4383` is solely a loopback host remap to avoid colliding with a co-located Snapchain node. Upstream configuration still uses the `SNAPCHAIN_` prefix; there is no upstream `HYPERSNAP_` namespace at the inspected commit.

## Discovery and health

For each endpoint, the collector:

1. calls `GetInfo` and selects distinct positive `shard_infos[].shard_id` values;
2. compares hosted data-shard count with `num_shards` and reports partial coverage rather than synthesizing missing shards;
3. reports the latest height and block delay exposed per shard;
4. normalizes `mempool_size = 4294967295` to unavailable;
5. ignores `num_onchain_events` as an activity/stat signal because it is hardcoded to zero at the pins;
6. checks typed `GetInfo`/bounded `GetEvents` compatibility, shard discovery, and available event timestamp conversion during `doctor`;
7. reports the generic package version separately from the pinned source identity.

Health retains the declared `num_shards` as expected coverage and connected positive descriptors as covered coverage. It also carries `historyCoverageStartMs` and `historyComplete`; a fresh, fully connected node remains partial/degraded until replay or prospective collection establishes the complete 30-day metric window.

`GetInfo` does not expose `is_syncing`, network, current protocol version, event schema, Hyper enabled/write state, reconnect count, or source attestation. Health is inferred from typed RPC compatibility, shard coverage, recent height/freshness, cursor continuity, and recent authenticated collector delivery.

## Future verified Hyper adapter

`apps/collector/src/adapter.ts` provides the active `SourceActivityAdapter` boundary between source evidence and transport/persistence. The protocol package also exposes source-oriented normalization adapters for consumers of the shared library. A future verified Hyper implementation can replace the evidence/normalization adapter without redesigning SQLite, delivery, metric, or dashboard contracts.

A defensible verified adapter still needs a dedicated durable success record or stream containing at least source identity, shard, replayable cursor/event ID, message hash, FID, message type, authoritative action time, and explicit Hyper-write outcome. It must support gap reconciliation and retention adequate for the product windows. No inspected source currently meets that contract.
