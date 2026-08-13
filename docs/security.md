# Security model

## Assets and trust boundaries

Sensitive assets are the ingest HMAC secret, optional RPC authorization metadata, Cloudflare API token/account configuration, local actor/cursor database, and retry outbox. The public dashboard, summary APIs, and WebSocket clients are untrusted readers. Node RPC endpoints and collector state stay private.

Primary threats are forged/replayed ingest, duplicate or out-of-order delivery, secret leakage through logs/bundles, public node exposure, oversized/schema-confusing requests, SQL injection, source-quality spoofing, WebSocket abuse, and unbounded local/cloud storage.

## Ingest controls

The collector signs the exact raw request body with `SNAPMETER_INGEST_SECRET`, timestamp, and unique nonce/batch ID. The Worker must:

- require the expected JSON content type and reject oversized bodies before parsing;
- parse timestamp strictly and enforce a five-minute tolerance;
- verify the HMAC in constant time over the same canonical payload;
- validate the complete runtime schema and schema version;
- enforce a unique batch ID/nonce in bounded D1 replay storage;
- perform idempotent storage so retries cannot double-count;
- rate-limit by source and reject source/header/body mismatches;
- return generic failures without echoing a signature, secret, auth header, or raw body;
- authenticate before mutating D1 or broadcasting to the Durable Object.

Clock skew that exceeds tolerance is an operational error, not a reason to weaken validation. Secret rotation needs an explicit bounded overlap procedure or coordinated collector update; never accept unsigned traffic during rotation.

## Data minimization

Allowed analytics metadata includes source, source mode, shard/event identity, numeric message type/action family, valid FID, canonical action time, receipt time, replay classification, aggregate counts, actor-day membership, cursors, and source health. The current implementation does not retain message hashes; a future verified adapter may add a hash only after a documented audit/minimization decision.

Do not collect, persist, log, or upload cast text, signatures, signer keys, raw message bodies, authorization metadata, `.env` contents, or unnecessary onchain/user payloads. Bound retention of event idempotency, minute buckets, health, nonces, and logs. Retain daily aggregates long-term only as required by product policy.

## Secrets

- Local collector secrets live in a gitignored `.env` with restrictive ACLs.
- Production Worker secrets use `wrangler secret`; GitHub uses protected environment/repository secrets.
- No secret may use a `VITE_` prefix or otherwise enter the browser bundle.
- PowerShell scripts validate presence and print only names/status, never values.
- Structured logs use field allowlists and redact `authorization`, cookies, signatures, tokens, secrets, URLs with credentials, and raw bodies.
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
