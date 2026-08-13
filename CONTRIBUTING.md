# Contributing to SnapMeter

Thank you for helping improve SnapMeter. Contributions should preserve the
project's metric integrity, privacy boundary, and reproducible build.

## Before opening a change

- Read `AGENTS.md`, `docs/metrics.md`, `docs/security.md`, and the document for
  the surface you intend to change.
- Open a public issue for behavior or design discussion, but use GitHub's
  private vulnerability-reporting form for security findings.
- Never attach credentials, `.env` files, databases, logs, raw node events,
  cast contents, signatures, or production screenshots containing private
  operator data.

## Development setup

Follow `docs/local-reconstruction.md`. A deterministic `?demo=1` dashboard and
the full test suite require no production credentials or database.

Create a topic branch, keep the patch focused, and add tests for behavior
changes. Do not regenerate or replace pinned upstream protocol files without
following the source-upgrade procedure in `docs/upstream-sources.md`.

## Required checks

Run these commands with Node.js 24 and pnpm 11.19.0:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm security:check
pnpm test
pnpm build
pnpm test:e2e
```

Inspect responsive behavior, reduced motion, offline/stale states, and source
quality claims when the dashboard changes. A successful page load does not
prove that either source is live.

## Pull requests and licensing

Explain the problem, the integrity/security impact, the tests run, and any
deployment or migration implications. Keep secrets and production data out of
the PR description and CI logs.

By submitting a contribution, you agree that your SnapMeter-authored
contribution is licensed under the repository's MIT license. Do not submit
third-party material unless redistribution is permitted and its exact source,
license, and notice requirements are included. The vendored and adapted
Snapchain protobufs and Warpkeep-derived Mini App portions are separately
identified in `THIRD_PARTY_NOTICES.md`.
