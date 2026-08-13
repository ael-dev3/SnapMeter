# Third-party notices

SnapMeter-authored material is licensed under the repository's [MIT License](LICENSE). The following files are exceptions and retain their upstream license.

## Snapchain protocol definitions

The files below were copied from the `farcasterxyz/snapchain` `snapchain-proto` crate at commit [`6152402aea2dbe732fb73076f674b038bfd4aee5`](https://github.com/farcasterxyz/snapchain/tree/6152402aea2dbe732fb73076f674b038bfd4aee5). That crate declares `GPL-3.0`; the files are redistributed under `GPL-3.0-only`, not MIT:

- `packages/protocol/proto/upstream/snapchain-6152402/blocks.proto`
- `packages/protocol/proto/upstream/snapchain-6152402/hub_event.proto`
- `packages/protocol/proto/upstream/snapchain-6152402/message.proto`
- `packages/protocol/proto/upstream/snapchain-6152402/onchain_event.proto`
- `packages/protocol/proto/upstream/snapchain-6152402/request_response.proto`
- `packages/protocol/proto/upstream/snapchain-6152402/rpc.proto`
- `packages/protocol/proto/upstream/snapchain-6152402/username_proof.proto`

`hub_event.proto` differs from the pinned upstream file only by removal of trailing whitespace. The other listed files are byte-for-byte copies at the time of this notice. The complete license is included at [`LICENSES/GPL-3.0-only.txt`](LICENSES/GPL-3.0-only.txt).

The locally authored aggregate loader `packages/protocol/proto/snapchain-6152402.proto` records the source pin and imports the files above; consumers must account for the upstream license when redistributing a combined work.

## Optional upstream nodes

Snapchain and Hypersnap node source, binaries, container images, databases, and snapshots are not included in this repository. If you obtain either project separately, its own license and notices govern it. The exact source commits SnapMeter inspected are recorded in [`docs/upstream-sources.md`](docs/upstream-sources.md).

## Package dependencies

Third-party packages installed from `pnpm-lock.yaml` are not relicensed by SnapMeter. Their own package metadata and license files govern them. A source checkout intentionally does not include `node_modules`.

The production build generates a combined `THIRD_PARTY_LICENSES.txt` from the exact modules Vite bundles into the public browser assets and Cloudflare Worker. That file is served with the deployed application. The post-build verifier fails when either environment's inventory is missing, the combined copy is stale, or a reviewed attribution is absent.

The published `@farcaster/quick-auth` 0.0.8 package declares MIT but its package allowlist omits a license file. At the exact upstream [0.0.8 version-bump commit](https://github.com/farcasterxyz/quick-auth/tree/79e064d75c3d03ca797401d49e8e8cc33a3bdfc9), the repository's available MIT notice is [`Copyright (c) 2025 Farcaster`](https://github.com/farcasterxyz/quick-auth/blob/79e064d75c3d03ca797401d49e8e8cc33a3bdfc9/hono-cloudflare-worker/LICENSE). The generator supplies that reviewed full text and provenance instead of silently emitting an empty Quick Auth section.

The locked Mini App dependency graph includes `rpc-websockets@9.3.9`
(`LGPL-3.0-only`) through optional Solana support in
`@farcaster/miniapp-core`. SnapMeter does not use Solana or that RPC package:
the client loads only the Mini App host bridge, and the production bundle
verifier fails if the RPC implementation appears in a browser artifact. The
package may nevertheless be installed into an ignored local `node_modules`
directory by pnpm; its included license governs that copy.

`text-encoding-utf-8@1.0.2`, another package in that optional transitive path,
omits an SPDX identifier from its package metadata. Its distributed
`LICENSE.md` dedicates its original material to the public domain and notes
that some algorithms/comments derive from the WHATWG Encoding Standard. It is
likewise excluded from SnapMeter's production browser bundle.
