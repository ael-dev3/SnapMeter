# Security model

## Assets and trust boundaries

Sensitive assets are the ingest HMAC secret, optional RPC authorization/API-key metadata, Cloudflare API token/account configuration, local actor/cursor database, and retry outbox. The schema-v3 collector database also contains the authoritative collector ID and actor pseudonym key. The public dashboard, summary APIs, and WebSocket clients are untrusted readers. Node RPC endpoints and collector state stay private.

Primary threats are forged/replayed ingest, duplicate or out-of-order delivery, secret leakage through logs/bundles, public node exposure, oversized/schema-confusing requests, SQL injection, source-quality spoofing, WebSocket abuse, and unbounded local/cloud storage.

## Ingest controls

The collector signs the exact raw request body with `SNAPMETER_INGEST_SECRET`, timestamp, and unique nonce/batch ID. The Worker must:

- require the expected JSON content type and reject oversized bodies before parsing;
- parse timestamp strictly and enforce a five-minute tolerance;
- verify the HMAC in constant time over the same canonical payload;
- validate the complete runtime schema and schema version;
- reject impossible UTC days, internally incoherent times, and future-dated records that could pin monotonic latest-state storage;
- enforce a unique batch ID/nonce in bounded D1 replay storage;
- perform idempotent storage so retries cannot double-count;
- rate-limit by source and reject source/header/body mismatches;
- return generic failures without echoing a signature, secret, auth header, or raw body;
- authenticate before mutating D1 or broadcasting to the Durable Object.

Clock skew that exceeds tolerance is an operational error, not a reason to weaken validation. Secret rotation needs an explicit bounded overlap procedure or coordinated collector update; never accept unsigned traffic during rotation.

## Data minimization

Allowed analytics metadata includes source, source mode, shard/event identity, numeric message type/action family, valid FID, canonical action time, receipt time, replay classification, aggregate counts, actor-day membership, cursors, and source health. The current implementation does not retain message hashes; a future verified adapter may add a hash only after a documented audit/minimization decision.

Do not collect, persist, log, or upload cast text, signatures, signer keys, raw message bodies, authorization metadata, `.env` contents, or unnecessary onchain/user payloads. Bound retention of event idempotency, minute buckets, health, nonces, and logs. Retain daily aggregates long-term only as required by product policy.

## Collector identity and failover

Migration `0005_collector_binding.sql` gives each D1 dataset one global `collector_binding` row at `slot=1`. The first authenticated, non-doctor ingest atomically claims it with the batch's `collectorId`; an empty doctor probe does not claim it. Later traffic from a different ID receives HTTP 409 `collector_identity_conflict` before rate limiting or persistence. This prevents two independently initialized databases, which have different actor pseudonym keys, from double-counting the same actors. Run only one authoritative collector database against a production D1 dataset.

For failover, stop the collector and take a SQLite-consistent backup of the entire collector state, including `snapmeter.sqlite3` and any associated WAL/SHM state. Restore or clone that stopped state as one unit so the collector ID, pseudonym key, cursors, deduplication records, and outbox stay aligned. Never inspect, print, extract, export, copy, or persist the pseudonym key separately. A fresh database is a new collector identity and is not a replacement for this backup.

Accepting an intentionally new database requires an explicit operator reset of the D1 collector binding: `DELETE FROM collector_binding WHERE slot=1`. Perform that statement only after backing up D1 and completing the metric-continuity plan. Treat the reset as a metric-data boundary: preferably perform it at a UTC-day boundary when no reconciliation will add actors to earlier retained days, or clear and deliberately rebuild the affected cloud actor-day membership before accepting the new ID. Changing the ingest secret does not reset this binding. Schema v3 is forward-only; if a release fails after migration, restore the stopped pre-upgrade database with its compatible binary or fix forward, rather than running a pre-v3 binary against a v3 database.

## Secrets

- Local collector secrets live in a gitignored `.env` with restrictive ACLs.
- Production Worker secrets use `wrangler secret`; GitHub uses protected environment/repository secrets.
- No secret may use a `VITE_` prefix or otherwise enter the browser bundle.
- PowerShell scripts validate presence and print only names/status, never values.
- Structured logs use field allowlists and redact API keys, `authorization`, cookies, signatures, tokens, secrets, URLs with credentials, and raw bodies.
- Remote cloud ingest must use HTTPS. Plain HTTP is accepted only for an explicit loopback development endpoint; RPC credentials similarly require TLS except on loopback.
- `.env.example` contains no usable credentials.

If a secret is exposed, stop affected ingest, rotate the Worker secret/token, update collectors securely, review replay/idempotency logs, and invalidate the old value. Git history rewriting is a separate release-owner decision; deleting a working-tree file alone is insufficient.

## Network and browser

Bind local native gRPC to loopback/private interfaces; it is plaintext at the inspected upstream commits. Use TLS termination and optional authorization for remote access. Never open inbound public firewall rules for collector convenience.

Read APIs are same-origin by default. Apply restrictive security headers, no permissive credentialed CORS, and a CSP appropriate for bundled assets/WebSockets. Public WebSockets are read-only, schema-versioned, rate/connection-limited, and receive only aggregate packets. Durable Object messages must not contain secrets or raw social content.

## Supply chain and deployment

Use the pnpm lockfile with frozen installs, reviewed GitHub Actions versions, Node 24+, pinned upstream protobuf/source SHAs, and tested schema migrations. Cloudflare tokens must be least privilege. Protected-default deployment runs only after checks and configured credentials; workflow logs must not expand secrets.

Dependency or upstream upgrades require reviewing protobuf field/enum changes, classifier behavior, auth semantics, retention, paging, and event persistence. Unknown message types remain non-qualifying.

## Source-integrity claims

The UI must not elevate availability into validity. “Live” requires recent authenticated collector data, adequate shard coverage, progressing heights, and successful reconciliation. Hypersnap remains `derived` because no inspected public source proves each Hyper write. Never use equal totals, `[hyper].enabled`, or `hyper:v1` as attestation.
