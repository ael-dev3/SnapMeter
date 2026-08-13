# Farcaster Mini App release

SnapMeter's Mini App launch URL and signed identity are tied to the exact production host:

```text
https://snapmeter.ael-dev3.workers.dev/?miniApp=true
```

The repository contains the app metadata, `fc:miniapp` embed, and exact-size opaque PNG assets. Ordinary local builds accept the deliberately unsigned manifest so development is not blocked. Production deployment fails closed until the domain association is present and passes local validation.

## Complete the account association

1. Sign in to Farcaster and enable [Developer Mode](https://farcaster.xyz/~/settings/developer-tools).
2. Open the [Mini App Manifest Tool for SnapMeter](https://farcaster.xyz/~/developers/mini-apps/manifest?domain=snapmeter.ael-dev3.workers.dev).
3. Approve signing for exactly `snapmeter.ael-dev3.workers.dev`. Never paste or commit a custody private key.
4. Copy only the generated `accountAssociation` object (`header`, `payload`, and `signature`) into `apps/dashboard/public/.well-known/farcaster.json` beside `miniapp`.
5. Run the release check:

   ```powershell
   pnpm --filter @snapmeter/dashboard verify:miniapp:release
   ```

The verifier checks the official manifest schema, accepted custody/auth header type, decoded payload, exact domain, ERC-191 signature against the declared signer, Mini App embed, URLs, CSP, and all asset dimensions/opacity. Farcaster's Manifest Tool still performs the authoritative custody/auth-address registration check.

## Preview and publish

After the signed manifest is deployed:

1. Confirm `https://snapmeter.ael-dev3.workers.dev/.well-known/farcaster.json` returns HTTP 200 JSON.
2. Open the [Mini App preview](https://farcaster.xyz/~/developers/mini-apps/preview?url=https%3A%2F%2Fsnapmeter.ael-dev3.workers.dev%2F%3FminiApp%3Dtrue) while signed in and confirm the splash clears, the dashboard fits the vertical surface, and authentication succeeds.
3. Use the Manifest Tool to register or refresh the deployed manifest and confirm the green account-association check.
4. Preview the root URL's `fc:miniapp` card, launch it, and confirm the app opens at the canonical `?miniApp=true` URL.
5. Run `pnpm --filter @snapmeter/dashboard deploy`. This command requires the association before it invokes Wrangler.

Do not copy Warpkeep's association: its signature is bound to another domain. A future custom domain also requires a new association unless it is handled through Farcaster's documented domain-migration flow.

Official references: [publishing](https://miniapps.farcaster.xyz/docs/guides/publishing), [sharing](https://miniapps.farcaster.xyz/docs/guides/sharing), [authentication](https://miniapps.farcaster.xyz/docs/guides/auth), and the [release checklist](https://miniapps.farcaster.xyz/docs/guides/agents-checklist).
