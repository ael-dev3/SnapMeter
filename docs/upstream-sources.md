# Pinned upstream sources

This document records the exact source snapshots inspected on 2026-08-13. Claims here apply to these commits, not an unversioned branch or tag.

## Snapchain

- Repository: `https://github.com/farcasterxyz/snapchain`
- Commit: `6152402aea2dbe732fb73076f674b038bfd4aee5`
- Subject/date: `feat(scripts): env knob for the bootstrap-peers opt-out flag (#1011)`, 2026-08-11
- Root crate: `snapchain` `0.14.1`
- Proto crate: `snapchain-proto` `0.11.0`

Vendored collector inputs under `packages/protocol/proto` were copied from this exact commit. The aggregate loader is `snapchain-6152402.proto`; its upstream source directory is `upstream/snapchain-6152402/`. When updating the pin, preserve field numbers, regenerate/update the loader, add protocol and classifier regression tests, and update both the SHA constant and this document in one change.

Collector-relevant facts at this pin:

- canonical service name is un-packaged `HubService`; no reflection service is mounted;
- `GetInfo`, `Subscribe`, `GetEvents`, and `GetEvent` operate on data-shard stores;
- `GetInfo.shard_infos` includes shard 0 but `num_shards` counts data shards; event RPCs cannot use shard 0;
- event IDs are only shard-local and all `uint64` values require exact string/bigint handling;
- `Subscribe.from_id` and `GetEvents.start_id` are inclusive; `stop_id` is exclusive;
- server replay can race live attach, so reconciliation is mandatory;
- `GetEvents.next_page_token` is always populated, including terminal `[null]`, and can restart scans if blindly reused;
- `BLOCK_CONFIRMED` is emitted before other block events;
- default HubEvent retention is three days;
- native gRPC is plaintext on `3383`; TLS is external;
- the package version from `GetInfo` is not a protocol-schema handshake;
- `mempool_size = 4294967295` means unavailable and `num_onchain_events` is hardcoded to zero;
- confirmed block/chunk and event times are Farcaster-epoch seconds.

## Hypersnap

- Repository: `https://github.com/farcasterorg/hypersnap`
- Commit: `2eee4c9f2a7833ce7971dfef028480abbe9c4720`
- Subject/date: `bump for publish`, 2026-08-09
- Cargo package/library: `snapchain` / `snapchain` `0.13.4`
- Default binary: `hypersnap`

Hypersnap retains compatible Snapchain RPC/protobuf contracts at this pin; no separate Hyper RPC protobuf is vendored because no dedicated Hyper service exists. The versioned classifier is tied to this SHA in `packages/protocol/src/classifier.ts`.

## Inspected behavior versus initial assumptions

| Assumption | Source-inspected result |
|---|---|
| Hypersnap is an independent chain/network. | Contradicted. It retains the canonical Snapchain network, consensus, sharding, trie, and event path plus local Hyper shadow stores. |
| Successful supported canonical merges are mirrored into Hyper stores. | Confirmed, but the shadow merge is best-effort and its error is suppressed. |
| Hyper writes have an independent HubEvent stream. | Contradicted. Hyper stores use a non-persisting event handler; public event RPCs are canonical only. |
| `HyperEnvelope`/`hyper:v1` verifies writes. | Contradicted. Production construction/receive behavior and payload do not provide a durable per-write outcome. |
| `[hyper].enabled` controls shadow writes. | Contradicted. At this pin it gates gossip capability/topic participation, not store creation, dual writes, or startup backfill. |
| Hypersnap defaults to gRPC `4383`. | Contradicted. Both upstream nodes default to internal `3383`; `4383` is an operator host remap. |
| A fresh default node can replay exact 30-day activity. | Contradicted. Default event retention is three days; Hyper backfill creates no HubEvents and raw chunks include failed messages. |
| `GetInfo` fully attests source and sync/protocol state. | Contradicted. It lacks Hyper state, commit, network, current protocol, schema, and explicit sync status. |
| The proposed Hyper families are eligible. | Narrowed to numeric values 1-8, 11, 12, 14, and 15. Frame actions, gasless keys, channels, and unknown values are excluded. |

## Upgrade procedure

1. Fetch upstream without modifying the upstream repository.
2. Record the full commit SHA, subject/date, package versions, and changed proto hashes.
3. Inspect service mounts, event persistence, classifier matches, time conversion, shard discovery, retention, paging, and config/ports.
4. Diff field numbers and enum values before replacing vendored files.
5. Keep unknown fields/enums forward-compatible but non-qualifying by default.
6. Add regression tests for any changed behavior, especially page termination and Hyper eligibility.
7. Update source/adapter version metadata and all source-quality language.
8. Run lint, typecheck, unit/integration tests, build, and end-to-end tests before release.
