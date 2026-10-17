# Security policy

## Maintenance status

Development is halted. No version is actively maintained, and security fixes
or response times are not guaranteed. Independent operators should review,
maintain, and secure their own deployments.

## Report a vulnerability privately

Do not open a public issue, discussion, pull request, or log paste for a
suspected vulnerability or exposed credential. Use GitHub's **Report a
vulnerability** form in this repository's Security tab. Include the affected
commit, impact, reproduction steps, and a minimal proof of concept with all
credentials and personal data removed.

If private vulnerability reporting is unavailable, open a public issue that
contains only a request for a private contact channel. Do not include technical
details until a private channel is established.

## Sensitive material

SnapMeter intentionally excludes production and local secrets, RPC
credentials, `.env*` and `.dev.vars*` files, Cloudflare tokens, SQLite state,
logs, raw node data, snapshots, and retry payloads from source control. The
Farcaster Mini App `accountAssociation`, Worker hostname, and D1 database ID are
public identifiers, not authorization credentials.

If a credential may have been exposed, revoke or rotate it first. Removing it
from the latest commit is not sufficient because Git history, forks, caches,
logs, and notifications may retain it. See [the security model](docs/security.md)
for rotation and incident-response guidance.

## Disclosure expectations

Please use a private report before publishing details so that affected
operators have an opportunity to assess the issue. Because development is
halted, a maintainer response or coordinated fix is not guaranteed.
