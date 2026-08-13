import { randomUUID } from "node:crypto";
import { mkdirSync, statfsSync } from "node:fs";
import { IngestBatchSchema, SCHEMA_VERSION, signIngest, type IngestBatch, type Source } from "@snapmeter/contracts";
import { FARCASTER_EPOCH_MS, HYPERSNAP_UPSTREAM_SHA, SNAPCHAIN_UPSTREAM_SHA, rawHubEventFingerprint, type NodeInfo } from "@snapmeter/protocol";
import type { CollectorConfig, RpcEndpointConfig, RpcTransportConfig } from "./config.js";
import { CollectorDatabase } from "./database.js";
import type { FetchLike } from "./delivery.js";
import { defaultRpcFactory, rawEventId, rawEventShard, type CollectorRpc, type RpcFactory } from "./rpc.js";
import { discoveredShardIds, validateCandidateInfo } from "./collector.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skipped";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  checkedAtMs: number;
  collectorVersion: string;
  nodeVersion: string;
  upstream: { snapchain: string; hypersnap: string };
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  config: CollectorConfig;
  database: CollectorDatabase;
  rpcFactory?: RpcFactory;
  fetcher?: FetchLike;
  now?: () => number;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const rpcFactory = options.rpcFactory ?? defaultRpcFactory;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const checks: DoctorCheck[] = [];
  const expectedShards = new Map<Source, number[]>();
  let cloudDateMs: number | null = null;

  checks.push(databaseCheck(options.database, now()));
  checks.push(diskCheck(options.config));
  for (const source of sources()) {
    const endpoint = options.config.endpoints[source];
    checks.push({
      name: `${source}.mode`,
      status: endpoint.sourceMode === "unavailable" ? "warn" : endpoint.sourceMode === "derived" ? "warn" : "pass",
      message: endpoint.sourceMode === "derived"
        ? "derived mode: only Hyper-eligible canonical merges are counted"
        : `source mode is ${endpoint.sourceMode}`,
      details: { sourceMode: endpoint.sourceMode }
    });
    if (endpoint.sourceMode === "unavailable") {
      checks.push({ name: `${source}.rpc`, status: "skipped", message: "source is explicitly unavailable" });
      continue;
    }
    let selected: DoctorEndpoint;
    try {
      selected = await selectDoctorEndpoint(source, endpoint, options.database, rpcFactory);
    } catch {
      checks.push({
        name: `${source}.rpc`,
        status: "fail",
        message: "no configured endpoint passed identity, health, and cursor-continuity checks"
      });
      continue;
    }
    const { rpc, info, role, transport } = selected;
    try {
      const shards = discoveredShardIds(info);
      expectedShards.set(source, shards);
      checks.push({
        name: `${source}.rpc`,
        status: info.version && shards.length > 0 ? "pass" : "fail",
        message: info.version && shards.length > 0
          ? `GetInfo succeeded; discovered ${shards.length} shard(s)`
          : "GetInfo returned an incompatible response",
        details: { role, transport: transport.transport, tls: transport.tls, version: info.version, shards }
      });
      checks.push({
        name: `${source}.shards`,
        status: info.numShards > 0 && shards.length < info.numShards ? "warn" : shards.length > 0 ? "pass" : "fail",
        message: info.numShards > 0 && shards.length < info.numShards
          ? `GetInfo exposed ${shards.length} explicit positive shard descriptor(s) for ${info.numShards} expected data shards`
          : shards.length > 0 ? "all expected data shards have explicit positive descriptors" : "no subscribable positive shard descriptors were exposed",
        details: { expectedShards: info.numShards, discoverableShards: shards.length, shards }
      });
      if (shards.length > 0) {
        try {
          const shard = shards[0] as number;
          const cursor = options.database.getCursor(source, shard);
          if (cursor === "0") {
            checks.push({
              name: `${source}.cursor-point`,
              status: "warn",
              message: "no durable cursor exists yet for a GetEvent point-verification probe"
            });
          } else {
            try {
              const point = await rpc.getEvent(shard, cursor);
              const pointId = String(point.id ?? "");
              checks.push({
                name: `${source}.cursor-point`,
                status: pointId === cursor ? "pass" : "fail",
                message: pointId === cursor
                  ? "GetEvent resolved the current durable cursor"
                  : "GetEvent returned an event that did not match the durable cursor",
                details: { shard, cursor }
              });
            } catch {
              // A cursor can legitimately predate upstream event retention. The
              // ordered GetEvents probe below remains the compatibility check.
              checks.push({
                name: `${source}.cursor-point`,
                status: "warn",
                message: "GetEvent could not resolve the durable cursor; it may be older than upstream retention",
                details: { shard, cursor }
              });
            }
          }
          const page = await rpc.getEvents(shard, cursor);
          checks.push({
            name: `${source}.protocol`,
            status: Array.isArray(page.events) ? "pass" : "fail",
            message: "GetEvents protocol probe succeeded",
            details: { pinnedSha: source === "snapchain" ? SNAPCHAIN_UPSTREAM_SHA : HYPERSNAP_UPSTREAM_SHA }
          });
          const latestTimestamp = latestEventTimestamp(page.events);
          if (cursor !== "0" && latestTimestamp !== null) {
            const skew = now() - latestTimestamp;
            checks.push({
              name: `${source}.clock`,
              status: Math.abs(skew) <= 5 * 60_000 ? "pass" : "warn",
              message: Math.abs(skew) <= 5 * 60_000 ? "recent event time is within five minutes" : "recent event time differs from collector clock",
              details: { skewMs: skew }
            });
          } else {
            checks.push({ name: `${source}.clock`, status: "warn", message: "no near-head event timestamp was available for a clock comparison" });
          }
        } catch {
          checks.push({ name: `${source}.protocol`, status: "fail", message: "the selected endpoint failed the event protocol probe" });
        }
      }
    } catch {
      checks.push({
        name: `${source}.rpc`,
        status: "fail",
        message: "the selected endpoint failed a bounded protocol check",
        details: { role, transport: transport.transport }
      });
    } finally {
      rpc.close();
    }
  }

  checks.push(cursorCheck(options.database, expectedShards, now()));
  if (options.config.ingestUrl && options.config.ingestSecret) {
    const auth = await cloudAuthenticationCheck(options.config, options.database, fetcher, now());
    checks.push(auth.check);
    cloudDateMs = auth.cloudDateMs;
  } else {
    checks.push({ name: "cloud.auth", status: "skipped", message: "cloud ingest is not configured; local analytics remain available" });
  }
  checks.push(clockCheck(cloudDateMs, now()));

  return {
    ok: !checks.some((check) => check.status === "fail"),
    checkedAtMs: now(),
    collectorVersion: options.config.collectorVersion,
    nodeVersion: process.version,
    upstream: { snapchain: SNAPCHAIN_UPSTREAM_SHA, hypersnap: HYPERSNAP_UPSTREAM_SHA },
    checks
  };
}

interface DoctorEndpoint {
  role: "primary" | "fallback";
  transport: RpcTransportConfig;
  rpc: CollectorRpc;
  info: NodeInfo;
}

async function selectDoctorEndpoint(
  source: Source,
  endpoint: RpcEndpointConfig,
  database: CollectorDatabase,
  rpcFactory: RpcFactory
): Promise<DoctorEndpoint> {
  for (const role of ["primary", "fallback"] as const) {
    const transport = role === "primary" ? endpoint : endpoint.fallback;
    if (!transport) continue;
    const rpc = rpcFactory(transport);
    try {
      const info = await rpc.getInfo();
      const shards = discoveredShardIds(info);
      if (!info.version || shards.length === 0) throw new Error("incompatible GetInfo response");
      if (transport.expectedPeerId && info.peerId !== transport.expectedPeerId) throw new Error("peer identity mismatch");
      if (transport.expectedVersion && info.version !== transport.expectedVersion) throw new Error("version mismatch");
      if (source === "hypersnap") {
        validateCandidateInfo(source, transport, info, endpoint.maximumBlockDelaySeconds);
        if (!info.peerId) throw new Error("Hypersnap endpoint did not expose a peer identity");
        const advertised = new Set(shards);
        for (const cursor of database.getCursors().filter((item) => item.source === source)) {
          if (!advertised.has(cursor.shard)) throw new Error("candidate endpoint is missing a durable cursor shard");
          const known = database.eventFingerprint(source, cursor.shard, cursor.eventId);
          if (role === "fallback" && known === null) throw new Error("fallback cursor fingerprint is not enrolled");
          const point = await rpc.getEvent(cursor.shard, cursor.eventId);
          if (rawEventId(point) !== cursor.eventId
            || rawEventShard(point, cursor.shard) !== cursor.shard
            || (known !== null && rawHubEventFingerprint(point, cursor.shard) !== known)) {
            throw new Error(`${role} cursor continuity mismatch`);
          }
        }
        database.checkSourceEndpointEnrollment({
          source,
          role,
          transport: transport.transport,
          canonicalUrl: canonicalTransportUrl(transport),
          peerId: info.peerId,
          version: info.version,
          shardIds: shards
        });
      }
      return { role, transport, rpc, info };
    } catch {
      rpc.close();
    }
  }
  throw new Error(`no compatible ${source} endpoint`);
}

function canonicalTransportUrl(transport: RpcTransportConfig): string {
  if (transport.transport === "https-json") return new URL(transport.url).toString();
  return transport.url.toLowerCase();
}

function databaseCheck(database: CollectorDatabase, nowMs: number): DoctorCheck {
  try {
    database.setMetadata("doctor_last_write_at_ms", String(nowMs));
    const integrity = database.integrityCheck();
    return {
      name: "database",
      status: integrity === "ok" ? "pass" : "fail",
      message: integrity === "ok" ? "SQLite is writable and quick_check passed" : `SQLite quick_check returned ${integrity}`,
      details: { schemaVersion: database.status().schemaVersion }
    };
  } catch (error) {
    return { name: "database", status: "fail", message: errorMessage(error) };
  }
}

function diskCheck(config: CollectorConfig): DoctorCheck {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    const stats = statfsSync(config.dataDir, { bigint: true });
    const availableBytes = stats.bavail * stats.bsize;
    const enough = availableBytes >= BigInt(config.minimumFreeDiskBytes);
    return {
      name: "disk",
      status: enough ? "pass" : "fail",
      message: enough ? "data volume has sufficient free space" : "data volume is below the configured free-space floor",
      details: { availableBytes: availableBytes.toString(), minimumBytes: String(config.minimumFreeDiskBytes) }
    };
  } catch (error) {
    return { name: "disk", status: "fail", message: errorMessage(error) };
  }
}

function cursorCheck(database: CollectorDatabase, expected: Map<Source, number[]>, nowMs: number): DoctorCheck {
  const cursors = database.getCursors();
  const missing: string[] = [];
  const stale: string[] = [];
  for (const [source, shards] of expected) {
    for (const shard of shards) {
      const cursor = cursors.find((candidate) => candidate.source === source && candidate.shard === shard);
      if (!cursor) missing.push(`${source}:${shard}`);
      else if (nowMs - cursor.verifiedAtMs > 10 * 60_000) stale.push(`${source}:${shard}`);
    }
  }
  const status: CheckStatus = missing.length > 0 || stale.length > 0 ? "warn" : "pass";
  return {
    name: "cursors",
    status,
    message: cursors.length === 0
      ? "no durable cursors exist yet; run or backfill the collector"
      : status === "pass" ? "every discovered shard has a recent durable cursor" : "cursor coverage is incomplete or stale",
    details: { cursorCount: cursors.length, missing, stale }
  };
}

async function cloudAuthenticationCheck(
  config: CollectorConfig,
  database: CollectorDatabase,
  fetcher: FetchLike,
  nowMs: number
): Promise<{ check: DoctorCheck; cloudDateMs: number | null }> {
  const batch: IngestBatch = {
    schemaVersion: SCHEMA_VERSION,
    batchId: randomUUID(),
    collectorId: database.collectorId,
    collectorVersion: config.collectorVersion,
    sentAtMs: nowMs,
    pulses: [],
    snapshots: [],
    comparisonSnapshots: [],
    minuteBuckets: [],
    actorDays: [],
    cursors: [],
    health: []
  };
  IngestBatchSchema.parse(batch);
  const rawBody = JSON.stringify(batch);
  const timestamp = String(nowMs);
  try {
    const signature = await signIngest(config.ingestSecret as string, timestamp, batch.batchId, rawBody);
    const response = await fetcher(config.ingestUrl as string, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-snapmeter-timestamp": timestamp,
        "x-snapmeter-nonce": batch.batchId,
        "x-snapmeter-signature": signature,
        "x-snapmeter-doctor": "1"
      },
      body: rawBody,
      signal: AbortSignal.timeout(15_000)
    });
    const cloudDate = response.headers.get("date");
    const cloudDateMs = cloudDate ? Date.parse(cloudDate) : null;
    return {
      check: {
        name: "cloud.auth",
        status: response.ok ? "pass" : "fail",
        message: response.ok ? "signed cloud ingest probe was authenticated" : `cloud ingest probe returned HTTP ${response.status}`,
        details: { endpoint: config.ingestUrl, status: response.status }
      },
      cloudDateMs: cloudDateMs !== null && Number.isFinite(cloudDateMs) ? cloudDateMs : null
    };
  } catch (error) {
    return { check: { name: "cloud.auth", status: "fail", message: errorMessage(error) }, cloudDateMs: null };
  }
}

function clockCheck(cloudDateMs: number | null, nowMs: number): DoctorCheck {
  if (cloudDateMs === null) return { name: "clock", status: "warn", message: "no authenticated remote Date header was available for clock-skew verification" };
  const skewMs = nowMs - cloudDateMs;
  return {
    name: "clock",
    status: Math.abs(skewMs) <= 5 * 60_000 ? "pass" : "fail",
    message: Math.abs(skewMs) <= 5 * 60_000 ? "collector clock is within the five-minute ingest tolerance" : "collector clock exceeds the five-minute ingest tolerance",
    details: { skewMs }
  };
}

function latestEventTimestamp(events: readonly ({ timestamp?: number | string } | null)[]): number | null {
  const values = events.flatMap((event) => {
    const seconds = Number(event?.timestamp ?? 0);
    return Number.isSafeInteger(seconds) && seconds > 0 ? [FARCASTER_EPOCH_MS + seconds * 1_000] : [];
  });
  return values.length > 0 ? Math.max(...values) : null;
}

function sources(): readonly Source[] {
  return ["snapchain", "hypersnap"];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
