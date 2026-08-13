import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Source, SourceMode } from "@snapmeter/contracts";

export type RpcTransport = "grpc" | "https-json";

export interface RpcTransportConfig {
  url: string;
  transport: RpcTransport;
  tls: boolean;
  authorization?: string;
  apiKey?: string;
  timeoutMs: number;
  getEventsMinIntervalMs: number;
  pollIntervalMs?: number;
  expectedPeerId?: string;
  expectedVersion?: string;
}

export interface RpcEndpointConfig extends RpcTransportConfig {
  sourceMode: SourceMode;
  fallback?: RpcTransportConfig;
  failoverAfterFailures: number;
  preferredRecoveryIntervalMs: number;
  preferredRecoverySuccesses: number;
  maximumBlockDelaySeconds: number;
}

export interface CollectorConfig {
  dataDir: string;
  databasePath: string;
  lockPath: string;
  collectorVersion: string;
  endpoints: Record<Source, RpcEndpointConfig>;
  ingestUrl?: string;
  ingestSecret?: string;
  reconcileIntervalMs: number;
  discoveryIntervalMs: number;
  snapshotIntervalMs: number;
  pulseIntervalMs: number;
  retentionDays: number;
  backfillDays: number;
  staleAfterMs: number;
  disconnectedAfterMs: number;
  maxOutboxRows: number;
  minimumFreeDiskBytes: number;
}

export interface EnvironmentLike {
  [key: string]: string | undefined;
}

const DEFAULT_LOCAL_DATA = join(homedir(), "AppData", "Local");
const MAX_CREDENTIAL_LENGTH = 8 * 1024;

export function loadConfig(env: EnvironmentLike = process.env): CollectorConfig {
  const localAppData = clean(env.LOCALAPPDATA) ?? DEFAULT_LOCAL_DATA;
  const dataDir = resolve(clean(env.SNAPMETER_DATA_DIR) ?? join(localAppData, "SnapMeter"));
  const ingestUrl = optionalHttpUrl(env.SNAPMETER_INGEST_URL, "SNAPMETER_INGEST_URL");
  const ingestSecret = optionalCredential(env.SNAPMETER_INGEST_SECRET, "SNAPMETER_INGEST_SECRET");
  if ((ingestUrl === undefined) !== (ingestSecret === undefined)) {
    throw new Error("SNAPMETER_INGEST_URL and SNAPMETER_INGEST_SECRET must be configured together");
  }
  if (ingestSecret !== undefined && ingestSecret.length < 32) {
    throw new Error("SNAPMETER_INGEST_SECRET must contain at least 32 characters");
  }

  const timeoutMs = integer(env.SNAPMETER_RPC_TIMEOUT_MS, 10_000, 250, 120_000, "SNAPMETER_RPC_TIMEOUT_MS");
  return {
    dataDir,
    databasePath: join(dataDir, "snapmeter.sqlite3"),
    lockPath: join(dataDir, "collector.lock"),
    collectorVersion: clean(env.npm_package_version) ?? "0.1.0",
    endpoints: {
      snapchain: endpoint(env, "SNAPCHAIN", "127.0.0.1:3383", "verified", timeoutMs),
      hypersnap: endpoint(env, "HYPERSNAP", "127.0.0.1:4383", "derived", timeoutMs)
    },
    ingestUrl,
    ingestSecret,
    reconcileIntervalMs: integer(env.SNAPMETER_RECONCILE_INTERVAL_MS, 30_000, 1_000, 3_600_000, "SNAPMETER_RECONCILE_INTERVAL_MS"),
    discoveryIntervalMs: integer(env.SNAPMETER_DISCOVERY_INTERVAL_MS, 60_000, 5_000, 3_600_000, "SNAPMETER_DISCOVERY_INTERVAL_MS"),
    snapshotIntervalMs: integer(env.SNAPMETER_SNAPSHOT_INTERVAL_MS, 5_000, 1_000, 300_000, "SNAPMETER_SNAPSHOT_INTERVAL_MS"),
    pulseIntervalMs: integer(env.SNAPMETER_PULSE_INTERVAL_MS, 250, 100, 5_000, "SNAPMETER_PULSE_INTERVAL_MS"),
    retentionDays: integer(env.SNAPMETER_RETENTION_DAYS, 35, 31, 365, "SNAPMETER_RETENTION_DAYS"),
    backfillDays: integer(env.SNAPMETER_BACKFILL_DAYS, 31, 31, 365, "SNAPMETER_BACKFILL_DAYS"),
    staleAfterMs: integer(env.SNAPMETER_STALE_AFTER_MS, 30_000, 5_000, 3_600_000, "SNAPMETER_STALE_AFTER_MS"),
    disconnectedAfterMs: integer(env.SNAPMETER_DISCONNECTED_AFTER_MS, 120_000, 10_000, 86_400_000, "SNAPMETER_DISCONNECTED_AFTER_MS"),
    maxOutboxRows: integer(env.SNAPMETER_MAX_OUTBOX_ROWS, 5_000, 100, 100_000, "SNAPMETER_MAX_OUTBOX_ROWS"),
    minimumFreeDiskBytes: integer(env.SNAPMETER_MIN_FREE_DISK_BYTES, 512 * 1024 * 1024, 1, Number.MAX_SAFE_INTEGER, "SNAPMETER_MIN_FREE_DISK_BYTES")
  };
}

function endpoint(
  env: EnvironmentLike,
  prefix: "SNAPCHAIN" | "HYPERSNAP",
  defaultUrl: string,
  defaultMode: SourceMode,
  timeoutMs: number
): RpcEndpointConfig {
  const endpointTimeoutMs = integer(
    env[`${prefix}_RPC_TIMEOUT_MS`],
    prefix === "HYPERSNAP" ? Math.min(timeoutMs, 5_000) : timeoutMs,
    250,
    120_000,
    `${prefix}_RPC_TIMEOUT_MS`
  );
  const url = clean(env[`${prefix}_GRPC_URL`]) ?? defaultUrl;
  const endpointMatch = /^(?:\[([^\]\s]+)\]|([^:\s]+)):(\d{1,5})$/.exec(url);
  const host = endpointMatch?.[1] ?? endpointMatch?.[2] ?? "";
  if (
    url.length > 512
    || url.includes("://")
    || endpointMatch === null
    || /[/\\@?#]/.test(host)
    || hasControlCharacters(host)
  ) {
    throw new Error(`${prefix}_GRPC_URL must be host:port without a scheme`);
  }
  const port = Number(endpointMatch[3]);
  if (port < 1 || port > 65_535) throw new Error(`${prefix}_GRPC_URL has an invalid port`);
  const sourceMode = sourceModeValue(env[`${prefix}_SOURCE_MODE`], defaultMode, `${prefix}_SOURCE_MODE`);
  if (prefix === "HYPERSNAP" && sourceMode === "verified") {
    throw new Error("HYPERSNAP_SOURCE_MODE=verified requires a dedicated verified Hyper-write adapter; this pinned collector only implements derived or unavailable mode");
  }
  if (prefix === "SNAPCHAIN" && sourceMode === "derived") {
    throw new Error("SNAPCHAIN_SOURCE_MODE must be verified or unavailable; canonical Snapchain merges are not a derived source");
  }
  const tls = booleanValue(env[`${prefix}_GRPC_TLS`], false, `${prefix}_GRPC_TLS`);
  const authorization = optionalCredential(env[`${prefix}_GRPC_AUTHORIZATION`], `${prefix}_GRPC_AUTHORIZATION`);
  const apiKey = optionalCredential(env[`${prefix}_GRPC_API_KEY`], `${prefix}_GRPC_API_KEY`);
  const expectedPeerId = peerId(env[`${prefix}_EXPECTED_PEER_ID`], `${prefix}_EXPECTED_PEER_ID`);
  const expectedVersion = optionalVersion(env[`${prefix}_EXPECTED_VERSION`], `${prefix}_EXPECTED_VERSION`);
  if (!tls && !isLoopbackHost(host) && (authorization !== undefined || apiKey !== undefined)) {
    throw new Error(`${prefix}_GRPC_TLS must be true when credentials are configured for a non-loopback endpoint`);
  }
  if (!tls && !isPrivateOrLoopbackHost(host)) {
    throw new Error(`${prefix}_GRPC_TLS must be true for an endpoint outside a private or loopback network`);
  }
  const result: RpcEndpointConfig = {
    url,
    transport: "grpc",
    tls,
    authorization,
    apiKey,
    expectedPeerId,
    expectedVersion,
    sourceMode,
    timeoutMs: endpointTimeoutMs,
    getEventsMinIntervalMs: integer(
      env[`${prefix}_RPC_MIN_INTERVAL_MS`],
      0,
      0,
      3_600_000,
      `${prefix}_RPC_MIN_INTERVAL_MS`
    ),
    failoverAfterFailures: integer(
      env[`${prefix}_FAILOVER_AFTER_FAILURES`],
      3,
      1,
      100,
      `${prefix}_FAILOVER_AFTER_FAILURES`
    ),
    preferredRecoveryIntervalMs: integer(
      env[`${prefix}_PREFERRED_RECOVERY_INTERVAL_MS`],
      60_000,
      5_000,
      3_600_000,
      `${prefix}_PREFERRED_RECOVERY_INTERVAL_MS`
    ),
    preferredRecoverySuccesses: integer(
      env[`${prefix}_PREFERRED_RECOVERY_SUCCESSES`],
      3,
      1,
      100,
      `${prefix}_PREFERRED_RECOVERY_SUCCESSES`
    ),
    maximumBlockDelaySeconds: prefix === "HYPERSNAP"
      ? integer(
          env.HYPERSNAP_MAX_BLOCK_DELAY_SECONDS,
          30,
          0,
          86_400,
          "HYPERSNAP_MAX_BLOCK_DELAY_SECONDS"
        )
      : 30
  };
  if (prefix === "HYPERSNAP") result.fallback = hypersnapHttpFallback(env, endpointTimeoutMs);
  return result;
}

function hypersnapHttpFallback(env: EnvironmentLike, timeoutMs: number): RpcTransportConfig | undefined {
  const url = optionalHttpUrl(env.HYPERSNAP_FALLBACK_HTTP_URL, "HYPERSNAP_FALLBACK_HTTP_URL");
  if (url === undefined) {
    if (clean(env.HYPERSNAP_FALLBACK_EXPECTED_PEER_ID) !== undefined || clean(env.HYPERSNAP_FALLBACK_EXPECTED_VERSION) !== undefined) {
      throw new Error("Hypersnap fallback identity pins require HYPERSNAP_FALLBACK_HTTP_URL");
    }
    return undefined;
  }
  if (!url.startsWith("https://")) throw new Error("HYPERSNAP_FALLBACK_HTTP_URL must use HTTPS");
  const expectedPeerId = peerId(env.HYPERSNAP_FALLBACK_EXPECTED_PEER_ID, "HYPERSNAP_FALLBACK_EXPECTED_PEER_ID");
  if (!expectedPeerId) throw new Error("HYPERSNAP_FALLBACK_EXPECTED_PEER_ID is required for a public HTTP fallback");
  const expectedVersion = optionalVersion(env.HYPERSNAP_FALLBACK_EXPECTED_VERSION, "HYPERSNAP_FALLBACK_EXPECTED_VERSION");
  if (!expectedVersion) throw new Error("HYPERSNAP_FALLBACK_EXPECTED_VERSION is required for a public HTTP fallback");
  return {
    url,
    transport: "https-json",
    tls: true,
    timeoutMs,
    getEventsMinIntervalMs: integer(
      env.HYPERSNAP_FALLBACK_RPC_MIN_INTERVAL_MS,
      1_000,
      0,
      3_600_000,
      "HYPERSNAP_FALLBACK_RPC_MIN_INTERVAL_MS"
    ),
    pollIntervalMs: integer(
      env.HYPERSNAP_FALLBACK_POLL_INTERVAL_MS,
      5_000,
      250,
      60_000,
      "HYPERSNAP_FALLBACK_POLL_INTERVAL_MS"
    ),
    expectedPeerId,
    expectedVersion
  };
}

function peerId(value: string | undefined, name: string): string | undefined {
  const normalized = clean(value);
  if (normalized === undefined) return undefined;
  if (normalized.length > 128 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(normalized)) {
    throw new Error(`${name} must be a base58 peer identifier`);
  }
  return normalized;
}

function optionalVersion(value: string | undefined, name: string): string | undefined {
  const normalized = clean(value);
  if (normalized === undefined) return undefined;
  if (normalized.length > 64 || !/^[0-9A-Za-z][0-9A-Za-z._/+:-]*$/.test(normalized)) {
    throw new Error(`${name} contains an invalid version identifier`);
  }
  return normalized;
}

function sourceModeValue(value: string | undefined, fallback: SourceMode, name: string): SourceMode {
  const normalized = clean(value)?.toLowerCase();
  if (normalized === undefined) return fallback;
  if (normalized === "verified" || normalized === "derived" || normalized === "unavailable") return normalized;
  throw new Error(`${name} must be verified, derived, or unavailable`);
}

function optionalHttpUrl(value: string | undefined, name: string): string | undefined {
  const normalized = clean(value);
  if (normalized === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (parsed.username || parsed.password) throw new Error(`${name} must not contain credentials`);
  if (parsed.search || parsed.hash) throw new Error(`${name} must not contain a query string or fragment`);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error(`${name} must use HTTPS except for an explicit loopback development endpoint`);
  }
  return parsed.toString();
}

function optionalCredential(value: string | undefined, name: string): string | undefined {
  const normalized = clean(value);
  if (normalized === undefined) return undefined;
  if (normalized.length > MAX_CREDENTIAL_LENGTH || hasControlCharacters(normalized)) {
    throw new Error(`${name} contains unsupported control characters or is too long`);
  }
  return normalized;
}

function isLoopbackHost(value: string): boolean {
  const host = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = /^(\d{1,3})(?:\.(\d{1,3})){3}$/.exec(host);
  if (!ipv4 || Number(ipv4[1]) !== 127) return false;
  return host.split(".").every((part) => Number(part) <= 255);
}

function isPrivateOrLoopbackHost(value: string): boolean {
  if (isLoopbackHost(value)) return true;
  const host = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "host.docker.internal") return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && (parts[1] as number) >= 16 && (parts[1] as number) <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
  const normalized = clean(value)?.toLowerCase();
  if (normalized === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const normalized = clean(value);
  if (normalized === undefined) return fallback;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function clean(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}
