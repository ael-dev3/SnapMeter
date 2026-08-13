import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Source, SourceMode } from "@snapmeter/contracts";

export interface RpcEndpointConfig {
  url: string;
  tls: boolean;
  authorization?: string;
  sourceMode: SourceMode;
  timeoutMs: number;
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

export function loadConfig(env: EnvironmentLike = process.env): CollectorConfig {
  const localAppData = clean(env.LOCALAPPDATA) ?? DEFAULT_LOCAL_DATA;
  const dataDir = resolve(clean(env.SNAPMETER_DATA_DIR) ?? join(localAppData, "SnapMeter"));
  const ingestUrl = optionalHttpUrl(env.SNAPMETER_INGEST_URL, "SNAPMETER_INGEST_URL");
  const ingestSecret = clean(env.SNAPMETER_INGEST_SECRET);
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
  const url = clean(env[`${prefix}_GRPC_URL`]) ?? defaultUrl;
  if (url.includes("://") || !/^(?:\[[^\]]+\]|[^:\s]+):\d{1,5}$/.test(url)) {
    throw new Error(`${prefix}_GRPC_URL must be host:port without a scheme`);
  }
  const port = Number(url.slice(url.lastIndexOf(":") + 1));
  if (port < 1 || port > 65_535) throw new Error(`${prefix}_GRPC_URL has an invalid port`);
  const sourceMode = sourceModeValue(env[`${prefix}_SOURCE_MODE`], defaultMode, `${prefix}_SOURCE_MODE`);
  if (prefix === "HYPERSNAP" && sourceMode === "verified") {
    throw new Error("HYPERSNAP_SOURCE_MODE=verified requires a dedicated verified Hyper-write adapter; this pinned collector only implements derived or unavailable mode");
  }
  if (prefix === "SNAPCHAIN" && sourceMode === "derived") {
    throw new Error("SNAPCHAIN_SOURCE_MODE must be verified or unavailable; canonical Snapchain merges are not a derived source");
  }
  return {
    url,
    tls: booleanValue(env[`${prefix}_GRPC_TLS`], false, `${prefix}_GRPC_TLS`),
    authorization: clean(env[`${prefix}_GRPC_AUTHORIZATION`]),
    sourceMode,
    timeoutMs
  };
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
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${name} must use HTTP(S)`);
  return parsed.toString();
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
