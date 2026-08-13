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

### Preferred local node and HTTPS fallback

SnapMeter can treat two Hypersnap endpoints as ordered replicas of the same canonical event source; it never sums or concurrently presents them as independent networks:

1. `HYPERSNAP_GRPC_URL` is the preferred local/private native gRPC endpoint.
2. `HYPERSNAP_FALLBACK_HTTP_URL` is an optional read-only HTTPS JSON endpoint used only while the preferred endpoint cannot pass activation/health checks.
3. While fallback is active, the collector periodically probes the preferred endpoint and switches back only after `HYPERSNAP_PREFERRED_RECOVERY_SUCCESSES` consecutive successful probes.

The HTTPS adapter calls `/v1/info`, `/v1/eventById`, and ordered `/v1/events`. Because the public API has no streaming route, it simulates the latency channel with bounded head/forward polling; durable fixed-range event reconciliation remains authoritative. `HYPERSNAP_FALLBACK_POLL_INTERVAL_MS` controls polling and `HYPERSNAP_FALLBACK_RPC_MIN_INTERVAL_MS` paces all fallback request starts across shards.

| Environment variable | Public-template value | Purpose |
|---|---:|---|
| `HYPERSNAP_EXPECTED_PEER_ID` | blank | Optional exact preferred/local peer pin. |
| `HYPERSNAP_EXPECTED_VERSION` | blank | Optional exact preferred/local version pin. |
| `HYPERSNAP_RPC_TIMEOUT_MS` | `5000` | Per-call timeout shared by both Hypersnap roles, independent of any longer hosted Snapchain timeout; allowed range 250-120,000 ms. |
| `HYPERSNAP_FALLBACK_HTTP_URL` | `https://haatz.quilibrium.com` | Optional fallback base URL; clearing it disables the fallback when both identity pins are also cleared. |
| `HYPERSNAP_FALLBACK_EXPECTED_PEER_ID` | `12D3KooWMYfkXiNcn9LifPkLYiHtGmXYnknYG1yFBD53rUseUMUc` | Mandatory exact public-role peer pin. |
| `HYPERSNAP_FALLBACK_EXPECTED_VERSION` | `0.13.3` | Mandatory exact public-role version pin. |
| `HYPERSNAP_FALLBACK_POLL_INTERVAL_MS` | `5000` | Delay between HTTP head polls; across two idle shards this is about 0.4 requests/second, leaving request capacity for replay; allowed range 250-60,000 ms. |
| `HYPERSNAP_FALLBACK_RPC_MIN_INTERVAL_MS` | `1000` | Minimum delay between all fallback request starts; allowed range 0-3,600,000 ms. |
| `HYPERSNAP_FAILOVER_AFTER_FAILURES` | `3` | Repeated active-endpoint discovery failures before switching; allowed range 1-100. |
| `HYPERSNAP_PREFERRED_RECOVERY_INTERVAL_MS` | `60000` | Preferred probe interval while fallback is active; allowed range 5,000-3,600,000 ms. |
| `HYPERSNAP_PREFERRED_RECOVERY_SUCCESSES` | `3` | Consecutive preferred probes required before returning; allowed range 1-100. |
| `HYPERSNAP_MAX_BLOCK_DELAY_SECONDS` | `30` | Maximum per-data-shard delay allowed for either role; allowed range 0-86,400 seconds. |

The public default is `https://haatz.quilibrium.com`. On 2026-08-13 it was the only currently healthy public endpoint displayed by the [official Hypersnap portal](https://hypersnap.org/), and its advertised data shards reported zero block delay during verification. The portal says it checks nodes every minute, but publishes no historical uptime series or node-creation evidence. SnapMeter therefore makes **no claim** that this endpoint is the oldest node or has the highest historical uptime; it is a reviewed current fallback, not an availability SLA. Upstream's [node guide](https://hypersnap.org/run-a-node) documents HTTP `3381` and gRPC `3383`, while the public hostname exposes the reviewed HTTP API through HTTPS.

The observed Haatz `0.13.3` version corresponds to upstream Hypersnap commit `ce408646fd09d886f275b74757341a1d328728ab`. A source diff from that commit to SnapMeter's inspected `2eee4c9f2a7833ce7971dfef028480abbe9c4720` pin changes only the root `Cargo.toml` package version from `0.13.3` to `0.13.4`; no protocol or runtime source differs. That is compatibility evidence for this adapter review, **not binary attestation**: the remote endpoint self-reports its version and peer ID, and SnapMeter cannot prove what commit produced the running binary. The exact observed values are change-detection pins only.

The fallback is fail-closed:

- HTTPS is mandatory and URLs containing credentials, query strings, or fragments are rejected.
- `HYPERSNAP_FALLBACK_EXPECTED_PEER_ID` and `HYPERSNAP_FALLBACK_EXPECTED_VERSION` are mandatory exact pins. The checked-in public values are public identity metadata, not credentials.
- `HYPERSNAP_MAX_BLOCK_DELAY_SECONDS` applies to both roles, and every expected positive data shard must be present before activation.
- The first accepted `(role, transport, canonical URL, peer ID, version, shard set)` is durably enrolled. Later drift is rejected even if the environment pin was edited.
- A candidate must return the durable cursor event for every shard, and its normalized event fingerprint must match local history. A fallback cannot adopt an older cursor that lacks a stored fingerprint.
- Only one role is active. Switching resets transient source state, resumes inclusively from the shared durable per-shard cursor, reconciles, and deduplicates before any new live pulse can be trusted.

The peer ID is reported by `/v1/info`; it is not a cryptographic attestation of every event or of the endpoint operator. TLS authenticates the configured hostname, and fingerprint/cursor checks detect conflicting history already observed by SnapMeter, but a public replica remains a third-party trust dependency. It cannot change Hypersnap from `derived` to `verified`.

A retention probe of the public endpoint during implementation exposed only roughly three days of canonical events. Retention is operator-controlled and not guaranteed by the portal. The fallback therefore cannot reconstruct a 30-day cold start and may be unable to bridge an outage older than its retained cursor. In either case SnapMeter fails closed or remains visibly partial; it never resets the cursor or fabricates older coverage.

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
