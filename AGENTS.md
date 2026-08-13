# SnapMeter agent guide

This file is the operating contract for future Codex sessions. Preserve user work, keep analytics claims source-backed, and validate every touched surface before release.

## Repository map

```text
apps/dashboard/      React/Vite UI and Cloudflare Worker/API
apps/collector/      Windows-friendly collector, SQLite state, and outbox
packages/contracts/  Runtime schemas and ingest signing primitives
packages/metrics/    Exact UTC windows, trends, freshness, and comparisons
packages/protocol/   Pinned protobufs, gRPC adapter, and message classifier
migrations/          D1 schema migrations
scripts/             Windows bootstrap, task, run, and health operations
docs/                Architecture, metrics, sources, deployment, and runbooks
```

The workspace uses Node.js 24+, pnpm 11.19, TypeScript, Vitest, Playwright, and Cloudflare Wrangler. Do not introduce a second package manager or commit generated secrets, local databases, logs, coverage, build output, `.dev.vars`, or `.env`.

## Commands

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm security:check
pnpm test
pnpm build
pnpm test:e2e
pnpm dev
pnpm collector doctor|run|status|backfill
pnpm --filter @snapmeter/dashboard run deploy
```

Run all six quality commands before a release. For a focused change, run the affected package test first, then the complete gates. Inspect mobile captures at 390x844 and verify no horizontal overflow, source ordering, reduced motion, offline/stale states, and real pulse behavior.

## Non-negotiable data rules

- UTC is authoritative. Store `actionAtMs` and `receivedAtMs` separately.
- Count only a valid nonzero FID in a successful user-authored canonical `MERGE_MESSAGE` whose numeric message type is allowed by the versioned classifier. Snapchain's closed set is 1-8 and 11-21; Hypersnap derived is 1-8, 11, 12, 14, and 15. Unknown future values are rejected pending review.
- Do not count deleted-message side effects, prunes, revokes, failures, confirmations, onchain events, system username-proof events, node maintenance, backfill operations, or replay receipt as new activity.
- Window boundaries are start-exclusive/end-inclusive: `(start, end]`.
- “30d active” is rolling unique activity. “Daily DAU” is a UTC calendar-day value. Never call the former “30d DAU.”
- Event identity is `(source instance, shard index, uint64 event ID)`. IDs repeat across shards and must remain exact decimal strings, not JavaScript numbers.
- Discover positive data-shard IDs from `GetInfo.shard_infos`; shard 0 is not an event shard. Cross-check coverage against `num_shards`.
- Use ordered, bounded per-shard `GetEvents` reconciliation for durable progress. `Subscribe` is a latency channel and is not gap-free.
- Advance a durable verified cursor only after the local event/metric transaction has committed safely. Resume inclusively and deduplicate so a crash between incorporation and checkpoint only replays idempotently.
- Suppress pulses for replay, backfill, gap recovery, stale canonical time, and events at or below the reconnect catch-up watermark.
- Never upload raw cast text, signatures, credentials, authorization metadata, or unnecessary message bodies.

The metric policy identifier is defined in `packages/metrics`; the Hyper classifier is defined and tested in `packages/protocol`. Change policy in one reviewed location, add boundary tests, update `docs/metrics.md`, and version the change.

## Upstream pins and source claims

- Snapchain: `6152402aea2dbe732fb73076f674b038bfd4aee5`
- Hypersnap: `2eee4c9f2a7833ce7971dfef028480abbe9c4720`

Vendored protobufs are pinned to the Snapchain SHA. Hypersnap is a Snapchain-compatible node with node-local Hyper shadow stores, not an independent network. At the pinned SHA, public RPCs expose canonical HubEvents only. Hyper writes are best-effort and unobservable per message, so Hypersnap must remain `derived` unless a future dedicated, durable success source is inspected, implemented, tested, and documented. A `hyper:v1` capability or `[hyper].enabled=true` is not verification.

`127.0.0.1:4383` is a SnapMeter host-port convenience, not an upstream Hypersnap default. Both upstream nodes use internal gRPC port `3383`. Native gRPC is plaintext; TLS requires external termination.

## Security and operations

- Keep gRPC listeners bound to loopback or a private network. Never expose `3383`/`4383` broadly by default.
- Ingest uses an HMAC over timestamp, nonce/batch ID, and the exact raw body; verify in constant time, reject stale/replayed requests, validate content type/size/schema, and rate-limit per source.
- Secrets belong in `.env`, `.dev.vars`, Wrangler secrets, or GitHub Actions secrets. Redact values and authorization headers from errors and structured logs.
- Public APIs and WebSockets are read-only. The browser bundle must not contain an ingest secret or node credential.
- Treat a successful page load as UI health only. “Live” requires recent authenticated collector data, healthy source coverage, and cursor reconciliation.
- Do not start or reconfigure archival nodes automatically. Probe existing endpoints first and require the operator to review disk, bandwidth, retention, and firewall impact.
- Preserve user changes and repository history. Do not force-push, discard unrelated changes, or modify upstream clones.

## Documentation and release discipline

Update the relevant document when changing a metric, source adapter, environment variable, API route, storage migration, task behavior, or deployment binding. Never fabricate a deployment URL, source health, history completeness, or smoke-test result. Publish the live URL in `README.md` only after homepage, status API, WebSocket upgrade, authenticated ingest, visible pulse, and post-push checks succeed.
