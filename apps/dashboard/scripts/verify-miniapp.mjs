import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { TextDecoder } from 'node:util'
import {
  domainManifestSchema,
  domainMiniAppConfigSchema,
  miniAppEmbedNextSchema,
} from '@farcaster/miniapp-core'
import { verifyMessage } from 'viem'

const APP_ORIGIN = 'https://snapmeter.ael-dev3.workers.dev'
const APP_DOMAIN = 'snapmeter.ael-dev3.workers.dev'
const LAUNCH_URL = `${APP_ORIGIN}/?miniApp=true`
const requireAssociation = process.argv.includes('--require-association')
const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(dashboardDir, 'public')
const manifestPath = join(publicDir, '.well-known', 'farcaster.json')
const htmlPath = join(dashboardDir, 'index.html')
const headersPath = join(publicDir, '_headers')

const expectedAssets = new Map([
  [`${APP_ORIGIN}/images/miniapp/icon.png`, { width: 1024, height: 1024 }],
  [`${APP_ORIGIN}/images/miniapp/splash.png`, { width: 200, height: 200 }],
  [`${APP_ORIGIN}/images/miniapp/embed.png`, { width: 1200, height: 800 }],
  [`${APP_ORIGIN}/images/miniapp/hero.png`, { width: 1200, height: 630 }],
  [`${APP_ORIGIN}/images/miniapp/og.png`, { width: 1200, height: 630 }],
  [`${APP_ORIGIN}/images/miniapp/screenshot.png`, { width: 1284, height: 2778 }],
])

function fail(message) {
  throw new Error(`Mini App validation failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function formatIssues(error) {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
}

function exactObjectKeys(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
}

function decodeCanonicalBase64Url(value, label) {
  assert(
    typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value),
    `${label} must be canonical unpadded base64url`,
  )
  const bytes = Buffer.from(value, 'base64url')
  assert(bytes.length > 0 && bytes.toString('base64url') === value, `${label} must be canonical unpadded base64url`)
  return bytes
}

function decodeBase64UrlJson(value, label) {
  try {
    const bytes = decodeCanonicalBase64Url(value, label)
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    fail(`${label} must contain base64url-encoded JSON`)
  }
}

function decodeSignature(value) {
  assert(typeof value === 'string' && value.length > 0, 'association signature must not be empty')
  let bytes
  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    bytes = Buffer.from(value, 'base64url')
    assert(bytes.toString('base64url') === value, 'association signature is not canonical base64url')
  }
  else {
    assert(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
      'association signature must be canonical base64url or padded base64',
    )
    bytes = Buffer.from(value, 'base64')
    assert(bytes.toString('base64') === value, 'association signature is not canonical padded base64')
  }
  const legacyHex = bytes.toString('utf8')
  if (/^0x[0-9a-fA-F]{130}$/.test(legacyHex)) bytes = Buffer.from(legacyHex.slice(2), 'hex')
  assert(bytes.length === 65, 'association signature must contain a 65-byte ERC-191 signature')
  return `0x${bytes.toString('hex')}`
}

export async function validateAccountAssociation(accountAssociation, miniapp, expectedDomain) {
  assert(accountAssociation, 'accountAssociation is required for a release')

  const candidate = {
    accountAssociation,
    miniapp,
  }
  const parsed = domainManifestSchema.safeParse(candidate)
  if (!parsed.success) {
    fail(`accountAssociation does not pass the official schema: ${formatIssues(parsed.error)}`)
  }

  const header = decodeBase64UrlJson(accountAssociation.header, 'accountAssociation.header')
  const payload = decodeBase64UrlJson(accountAssociation.payload, 'accountAssociation.payload')
  assert(exactObjectKeys(header, ['fid', 'type', 'key']), 'association header must contain only fid, type, and key')
  assert(Number.isSafeInteger(header.fid) && header.fid > 0, 'association header must contain a positive integer fid')
  assert(header.type === 'custody' || header.type === 'auth', 'association header type must be custody or auth')
  assert(typeof header.key === 'string' && /^0x[0-9a-fA-F]{40}$/.test(header.key), 'association header must contain an Ethereum address')
  assert(payload.domain === expectedDomain, `association payload domain must be exactly ${expectedDomain}`)
  assert(exactObjectKeys(payload, ['domain']), 'association payload must contain only the domain field')

  const signature = decodeSignature(accountAssociation.signature)
  let verified
  try {
    verified = await verifyMessage({
      address: header.key,
      message: `${accountAssociation.header}.${accountAssociation.payload}`,
      signature,
    })
  }
  catch {
    verified = false
  }
  assert(verified, 'association signature does not match its declared signing key')

  return { header, payload }
}

async function readPngMetadata(filePath) {
  const bytes = await readFile(filePath)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  assert(bytes.subarray(0, 8).equals(signature), `${filePath} is not a PNG`)
  assert(bytes.toString('ascii', 12, 16) === 'IHDR', `${filePath} has no PNG IHDR`)
  const colorType = bytes[25]
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    hasAlpha: colorType === 4 || colorType === 6,
  }
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
assert(manifest.miniapp, 'manifest must use the modern miniapp property')
assert(!('frame' in manifest), 'manifest must not include the legacy frame property')

const configResult = domainMiniAppConfigSchema.safeParse(manifest.miniapp)
if (!configResult.success) {
  fail(`miniapp config does not pass the official schema: ${formatIssues(configResult.error)}`)
}
const config = configResult.data

assert(config.version === '1', 'manifest version must be 1')
assert(config.name === 'SnapMeter', 'manifest app name must be SnapMeter')
assert(config.homeUrl === LAUNCH_URL, `manifest homeUrl must be ${LAUNCH_URL}`)
assert(config.canonicalDomain === APP_DOMAIN, `canonicalDomain must be ${APP_DOMAIN}`)
assert(typeof config.description === 'string' && config.description.length > 0, 'description is required for discovery')
assert(config.noindex !== true, 'noindex must not disable discovery')
assert(!('imageUrl' in config), 'deprecated manifest imageUrl must not be used')
assert(!('buttonTitle' in config), 'deprecated manifest buttonTitle must not be used')

if (manifest.accountAssociation) {
  await validateAccountAssociation(manifest.accountAssociation, manifest.miniapp, APP_DOMAIN)
}
else if (requireAssociation) fail('accountAssociation is required for a release')

const html = await readFile(htmlPath, 'utf8')
assert(!/name=["']fc:frame["']/i.test(html), 'legacy fc:frame metadata must not be present')
const metaMatch = html.match(/<meta\s+name=["']fc:miniapp["']\s+content='([^']+)'\s*\/?>/i)
assert(metaMatch, 'index.html must contain a static fc:miniapp meta tag')
const embed = JSON.parse(metaMatch[1])
const embedResult = miniAppEmbedNextSchema.safeParse(embed)
if (!embedResult.success) {
  fail(`fc:miniapp embed does not pass the official schema: ${formatIssues(embedResult.error)}`)
}
assert(embed.version === '1', 'embed version must be 1')
assert(embed.imageUrl === `${APP_ORIGIN}/images/miniapp/embed.png`, 'embed must use the canonical 3:2 image')
assert(embed.button.action.type === 'launch_miniapp', 'embed must use launch_miniapp')
assert(embed.button.action.url === LAUNCH_URL, `embed action URL must be ${LAUNCH_URL}`)
assert(embed.button.action.name === 'SnapMeter', 'embed action name must be SnapMeter')

const referencedAssets = new Set([
  config.iconUrl,
  config.splashImageUrl,
  config.heroImageUrl,
  config.ogImageUrl,
  ...(config.screenshotUrls ?? []),
  embed.imageUrl,
  embed.button.action.splashImageUrl,
])
assert(referencedAssets.size === expectedAssets.size, 'manifest and embed must reference every release asset exactly once by URL')

for (const [url, expected] of expectedAssets) {
  assert(referencedAssets.has(url), `release metadata does not reference ${url}`)
  const relativePath = new URL(url).pathname.replace(/^\//, '')
  const actual = await readPngMetadata(join(publicDir, ...relativePath.split('/')))
  assert(actual.width === expected.width && actual.height === expected.height, `${relativePath} must be ${expected.width}x${expected.height}, got ${actual.width}x${actual.height}`)
  assert(!actual.hasAlpha, `${relativePath} must be opaque (RGB PNG, no alpha channel)`)
}

const headers = await readFile(headersPath, 'utf8')
assert(!/Cross-Origin-Opener-Policy/i.test(headers), 'COOP must be omitted so the Farcaster host can embed the app')
assert(!/frame-ancestors\s+'none'/i.test(headers), "CSP must not set frame-ancestors 'none'")
assert(/connect-src[^;\r\n]*https:\/\/auth\.farcaster\.xyz/i.test(headers), 'CSP connect-src must allow auth.farcaster.xyz')
assert(/style-src\s+'self'(?:;|\s)/i.test(headers), "CSP style-src must not allow inline style elements")
assert(/style-src-elem\s+'self'/i.test(headers), "CSP style-src-elem must allow only bundled same-origin styles")
assert(/style-src-attr\s+'unsafe-inline'/i.test(headers), "CSP style-src-attr must explicitly cover bounded React style attributes")
assert(/frame-src\s+'none'/i.test(headers), "CSP must set frame-src 'none'")
assert(/object-src\s+'none'/i.test(headers), "CSP must set object-src 'none'")

process.stdout.write(
  `Mini App metadata valid for ${APP_DOMAIN}${requireAssociation ? ' with account association' : manifest.accountAssociation ? ' (association present)' : ' (unsigned development manifest)'}.\n`,
)
