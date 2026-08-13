import { createHmac, randomUUID } from "node:crypto";
import {
  IngestBatchSchema,
  IngestResponseSchema,
  SCHEMA_VERSION,
  signIngest,
  type ActionFamily,
  type ComparisonSnapshot,
  type IngestBatch,
  type PulsePacket,
  type Source,
  type SourceMetrics,
  type SourceMode
} from "@snapmeter/contracts";
import { buildSourceMetrics, DAY_MS, type ActivityRecord } from "@snapmeter/metrics";
import type { CollectorConfig } from "./config.js";
import { CollectorDatabase, compareEventIds, type SourceHealthRecord } from "./database.js";
import type { Logger } from "./logger.js";
import { exponentialBackoffMs } from "./reconcile.js";

export type HealthUpdate = IngestBatch["health"][number];

export interface PulseInput {
  activity: ActivityRecord;
  eventId: string;
}

interface MutablePulse {
  source: Source;
  sourceMode: SourceMode;
  windowStartMs: number;
  eventCount: number;
  fids: Set<string>;
  actionCounts: Record<ActivityRecord["action"], number>;
  lastActionAtMs: number;
  maxEventId: string;
}

export class PulseAccumulator {
  readonly #pending = new Map<Source, MutablePulse>();

  add(input: PulseInput): void {
    const { activity, eventId } = input;
    const existing = this.#pending.get(activity.source) ?? {
      source: activity.source,
      sourceMode: activity.sourceMode,
      windowStartMs: activity.receivedAtMs,
      eventCount: 0,
      fids: new Set<string>(),
      actionCounts: emptyActionCounts(),
      lastActionAtMs: activity.actionAtMs,
      maxEventId: "0"
    };
    existing.eventCount += 1;
    existing.fids.add(activity.fid);
    existing.actionCounts[activity.action] = (existing.actionCounts[activity.action] ?? 0) + 1;
    existing.lastActionAtMs = Math.max(existing.lastActionAtMs, activity.actionAtMs);
    if (compareEventIds(eventId, existing.maxEventId) > 0) existing.maxEventId = eventId;
    this.#pending.set(activity.source, existing);
  }

  drain(nowMs: number): PulsePacket[] {
    const pulses: PulsePacket[] = [];
    for (const pulse of this.#pending.values()) {
      pulses.push({
        schemaVersion: SCHEMA_VERSION,
        source: pulse.source,
        sourceMode: pulse.sourceMode,
        windowStartMs: pulse.windowStartMs,
        windowEndMs: Math.max(nowMs, pulse.windowStartMs),
        eventCount: pulse.eventCount,
        uniqueFids: pulse.fids.size,
        actionCounts: pulse.actionCounts,
        lastActionAtMs: pulse.lastActionAtMs,
        maxEventId: pulse.maxEventId,
        isReplay: false
      });
    }
    this.#pending.clear();
    return pulses;
  }

  get size(): number {
    return this.#pending.size;
  }
}

export function buildMetricSnapshot(
  database: CollectorDatabase,
  config: CollectorConfig,
  source: Source,
  nowMs: number
): SourceMetrics {
  const health = database.sourceHealth(source)[0];
  const sourceMode = health?.sourceMode ?? config.endpoints[source].sourceMode;
  const historyCaveat = health && !health.node.historyComplete
    ? "Rolling 30-day and daily history are partial until authoritative event coverage reaches 30 days."
    : null;
  const sourceCaveat = source === "hypersnap" && sourceMode === "derived"
    ? "Derived from Hyper-eligible canonical merges observed by the Hypersnap node; no independent Hyper write event stream is available at the pinned upstream SHA."
    : sourceMode === "unavailable" ? "No trustworthy source is connected." : null;
  const caveat = [sourceCaveat, historyCaveat].filter(Boolean).join(" ") || null;
  const snapshot = buildSourceMetrics({
    source,
    sourceMode,
    actions: database.loadActions(source, nowMs - 31 * DAY_MS),
    nowMs,
    lastCollectorAtMs: health?.observedAtMs ?? null,
    observedDays: database.observedDays(source),
    node: health?.node,
    forceStatus: health?.status,
    caveat
  });
  snapshot.actionCounts = completeActionCounts(snapshot.actionCounts);
  return snapshot;
}

export function asHealthUpdate(health: SourceHealthRecord): HealthUpdate {
  return {
    source: health.source,
    sourceMode: health.sourceMode,
    status: health.status,
    observedAtMs: health.observedAtMs,
    node: health.node,
    message: health.message
  };
}

export interface EnqueueParts {
  pulses?: readonly PulsePacket[];
  snapshots?: readonly SourceMetrics[];
  comparisonSnapshots?: readonly ComparisonSnapshot[];
  health?: readonly HealthUpdate[];
}

/** Cloudflare/D1 has a conservative mutation budget; stay below 700 records. */
export const MAX_BATCH_RECORDS = 680;

export function enqueueIngestBatch(
  database: CollectorDatabase,
  config: CollectorConfig,
  parts: EnqueueParts,
  nowMs = Date.now()
): IngestBatch | null {
  if (!config.ingestUrl || !config.ingestSecret) return null;
  const pulses = [...(parts.pulses ?? [])].slice(0, 100);
  const snapshots = [...(parts.snapshots ?? [])].slice(0, 4);
  const comparisonSnapshots = [...(parts.comparisonSnapshots ?? [])].slice(0, 2);
  const health = [...(parts.health ?? [])].slice(0, 8);
  const cursors = database.getCursors().slice(0, 128);
  let remaining = MAX_BATCH_RECORDS - pulses.length - snapshots.length - comparisonSnapshots.length - health.length - cursors.length;
  const minuteBuckets = database.pendingMinuteBuckets(Math.floor(nowMs / 60_000) * 60_000, Math.max(0, Math.min(200, remaining)))
    .map((bucket) => ({ ...bucket, actionCounts: completeActionCounts(bucket.actionCounts) }));
  remaining -= minuteBuckets.length;
  const actorRows = database.pendingActorDays(Math.max(0, Math.min(remaining, 5_000)));
  const collectorId = database.collectorId;
  const actorDays = actorRows.map(({ value, fid }) => ({
    ...value,
    fidHash: hashFid(config.ingestSecret as string, fid)
  }));
  const batch: IngestBatch = {
    schemaVersion: SCHEMA_VERSION,
    batchId: randomUUID(),
    collectorId,
    collectorVersion: config.collectorVersion,
    sentAtMs: nowMs,
    pulses,
    snapshots,
    comparisonSnapshots,
    minuteBuckets,
    actorDays,
    cursors,
    health
  };
  IngestBatchSchema.parse(batch);
  const queued = database.enqueueOutbox(
    batch,
    minuteBuckets,
    actorRows.map(({ value, fid }) => ({ source: value.source, day: value.day, fid })),
    config.maxOutboxRows
  );
  return queued ? batch : null;
}

export function buildComparisonSnapshot(
  database: CollectorDatabase,
  snapshots: readonly SourceMetrics[],
  nowMs: number
): ComparisonSnapshot {
  const sets = database.activeFidComparison(nowMs - DAY_MS, nowMs);
  const snapchain = snapshots.find((snapshot) => snapshot.source === "snapchain");
  const hypersnap = snapshots.find((snapshot) => snapshot.source === "hypersnap");
  const overlapPercent = sets.union.size === 0 ? null : round((sets.overlap.size / sets.union.size) * 100, 2);
  const activeCoverage = sets.snapchain.size === 0 ? null : round((sets.hypersnap.size / sets.snapchain.size) * 100, 2);
  const snapchainEvents = snapchain ? Object.values(snapchain.actionCounts).reduce((sum, value) => sum + value, 0) : 0;
  const hypersnapEvents = hypersnap ? Object.values(hypersnap.actionCounts).reduce((sum, value) => sum + value, 0) : 0;
  const eventParityPercent = snapchainEvents === 0 ? null : round((hypersnapEvents / snapchainEvents) * 100, 2);
  const effectivelyIdentical = sets.snapchain.size === sets.hypersnap.size && sets.overlap.size === sets.union.size;
  return {
    generatedAtMs: nowMs,
    overlap24h: sets.overlap.size,
    overlapPercent,
    eligibleActionCoveragePercent: activeCoverage,
    eventParityPercent,
    effectivelyIdentical,
    explanation: effectivelyIdentical
      ? "The exact rolling-24h active-FID sets are identical; the sources may observe overlapping canonical traffic."
      : "Exact rolling-24h set overlap is calculated locally; differences may reflect Hyper eligibility, node health, lag, or shard coverage."
  };
}

export function hashFid(secret: string, fid: string): string {
  if (!secret) throw new Error("actor-day hashing requires the ingest secret");
  return createHmac("sha256", secret).update("snapmeter-actor-day-v1\0").update(fid).digest("hex");
}

const ACTION_FAMILIES: readonly ActionFamily[] = [
  "cast",
  "reaction",
  "link",
  "verification",
  "user-data",
  "username-proof",
  "storage-lending",
  "key",
  "channel",
  "other"
];

function emptyActionCounts(): Record<ActionFamily, number> {
  return Object.fromEntries(ACTION_FAMILIES.map((family) => [family, 0])) as Record<ActionFamily, number>;
}

function completeActionCounts(counts: Partial<Record<ActionFamily, number>>): Record<ActionFamily, number> {
  const complete = emptyActionCounts();
  for (const family of ACTION_FAMILIES) complete[family] = counts[family] ?? 0;
  return complete;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class OutboxDispatcher {
  #draining = false;

  constructor(
    readonly database: CollectorDatabase,
    readonly config: CollectorConfig,
    readonly logger: Logger,
    readonly fetcher: FetchLike = fetch,
    readonly now: () => number = Date.now,
    readonly random: () => number = Math.random
  ) {}

  async drainOnce(): Promise<{ acknowledged: number; failed: number }> {
    if (this.#draining || !this.config.ingestUrl || !this.config.ingestSecret) return { acknowledged: 0, failed: 0 };
    this.#draining = true;
    let acknowledged = 0;
    let failed = 0;
    try {
      for (const row of this.database.dueOutbox(this.now())) {
        try {
          const timestamp = String(this.now());
          const signature = await signIngest(this.config.ingestSecret, timestamp, row.batchId, row.payloadJson);
          const response = await this.fetcher(this.config.ingestUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-snapmeter-timestamp": timestamp,
              "x-snapmeter-nonce": row.batchId,
              "x-snapmeter-signature": signature
            },
            body: row.payloadJson,
            signal: AbortSignal.timeout(15_000)
          });
          const body = await response.text();
          if (!response.ok) throw new Error(`ingest returned HTTP ${response.status}: ${body.slice(0, 200)}`);
          const parsed = IngestResponseSchema.parse(JSON.parse(body));
          if (parsed.batchId !== row.batchId) throw new Error("ingest acknowledgement batch id did not match");
          this.database.acknowledgeOutbox(row.id, row.batchId, parsed.acceptedAtMs);
          acknowledged += 1;
          this.logger.debug("outbox.acknowledged", { batchId: row.batchId, duplicate: parsed.duplicate });
        } catch (error) {
          failed += 1;
          const delayMs = exponentialBackoffMs(row.attemptCount, {
            baseMs: 1_000,
            maximumMs: 5 * 60_000,
            random: this.random
          });
          this.database.failOutbox(row.id, this.now() + delayMs, errorMessage(error));
          this.logger.warn("outbox.delivery_failed", { batchId: row.batchId, attempt: row.attemptCount + 1, delayMs, error });
          break;
        }
      }
      return { acknowledged, failed };
    } finally {
      this.#draining = false;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
