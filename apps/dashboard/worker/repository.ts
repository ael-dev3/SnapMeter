import { IngestBatchSchema, SourceMetricsSchema, type HealthUpdate, type IngestBatch, type Source, type SourceMetrics, type Summary } from "@snapmeter/contracts";
import { emptySource, emptySummary } from "./defaults";
import type { Env } from "./types";

export async function readSummary(env: Env, nowMs = Date.now()): Promise<Summary> {
  const [result, comparisonRow] = await Promise.all([
    env.DB.prepare("SELECT source, payload_json FROM latest_snapshots WHERE source IN ('snapchain', 'hypersnap')").all<{ source: Source; payload_json: string }>(),
    env.DB.prepare("SELECT payload_json FROM comparison_snapshots WHERE id=1").first<{ payload_json: string }>()
  ]);
  const bySource = new Map<Source, SourceMetrics>();
  for (const row of result.results ?? []) {
    try {
      const parsed = SourceMetricsSchema.safeParse(JSON.parse(row.payload_json));
      if (parsed.success) bySource.set(row.source, applyFreshness(parsed.data, nowMs));
    } catch { /* corrupt rows become unavailable rather than breaking the API */ }
  }
  const snapchain = bySource.get("snapchain") ?? emptySource("snapchain", nowMs);
  const hypersnap = bySource.get("hypersnap") ?? emptySource("hypersnap", nowMs);
  const warnings: string[] = [];
  if (snapchain.status !== "live") warnings.push(`Snapchain is ${snapchain.status}.`);
  if (hypersnap.sourceMode === "derived") warnings.push("Hypersnap is derived from observed Hyper-eligible canonical merges; individual Hyper writes are not verified.");
  if (["disconnected", "stale", "partial"].includes(hypersnap.status)) warnings.push(`Hypersnap is ${hypersnap.status}.`);
  const parity = snapchain.rolling24h === 0 ? null : round((hypersnap.rolling24h / snapchain.rolling24h) * 100, 2);
  const identical = snapchain.rolling24h === hypersnap.rolling24h && snapchain.todayUtc === hypersnap.todayUtc;
  let comparison: Summary["comparison"] = {
    overlap24h: null,
    overlapPercent: null,
    eligibleActionCoveragePercent: parity,
    eventParityPercent: parity,
    effectivelyIdentical: identical,
    explanation: identical
      ? "The observed active-FID totals are identical. This likely reflects overlapping canonical traffic, not independent competition."
      : "Differences may reflect Hyper eligibility, source freshness, node lag, or shard coverage."
  };
  if (comparisonRow) {
    try {
      const parsed = JSON.parse(comparisonRow.payload_json) as Summary["comparison"];
      comparison = { ...comparison, ...parsed };
    } catch { /* retain conservative computed comparison */ }
  }
  return {
    ...emptySummary(nowMs),
    generatedAtMs: nowMs,
    sources: { snapchain, hypersnap },
    comparison,
    warnings
  };
}

export async function persistBatch(env: Env, batch: IngestBatch, receivedAtMs: number): Promise<"accepted" | "duplicate"> {
  const existing = await env.DB.prepare("SELECT 1 AS present FROM ingest_batches WHERE batch_id = ? LIMIT 1").bind(batch.batchId).first();
  if (existing) return "duplicate";
  const statements: D1PreparedStatement[] = [];
  statements.push(env.DB.prepare(
    "INSERT INTO ingest_batches (batch_id, collector_id, collector_version, sent_at_ms, received_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(batch.batchId, batch.collectorId, batch.collectorVersion, batch.sentAtMs, receivedAtMs, receivedAtMs + 24 * 60 * 60_000));
  statements.push(env.DB.prepare(
    "INSERT INTO live_delivery_outbox (batch_id, payload_json, created_at_ms) VALUES (?, ?, ?)"
  ).bind(batch.batchId, JSON.stringify(batch), receivedAtMs));

  for (const snapshot of batch.snapshots) {
    const payload = JSON.stringify(snapshot);
    statements.push(env.DB.prepare(
      "INSERT INTO metric_snapshots (source, generated_at_ms, payload_json, collector_id) VALUES (?, ?, ?, ?)"
    ).bind(snapshot.source, snapshot.updatedAtMs, payload, batch.collectorId));
    statements.push(env.DB.prepare(
      "INSERT INTO latest_snapshots (source, generated_at_ms, payload_json, collector_id) VALUES (?, ?, ?, ?) ON CONFLICT(source) DO UPDATE SET generated_at_ms=excluded.generated_at_ms, payload_json=excluded.payload_json, collector_id=excluded.collector_id WHERE excluded.generated_at_ms >= latest_snapshots.generated_at_ms"
    ).bind(snapshot.source, snapshot.updatedAtMs, payload, batch.collectorId));
  }
  for (const comparison of batch.comparisonSnapshots) {
    statements.push(env.DB.prepare(
      "INSERT INTO comparison_snapshots (id, generated_at_ms, payload_json, collector_id) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET generated_at_ms=excluded.generated_at_ms, payload_json=excluded.payload_json, collector_id=excluded.collector_id WHERE excluded.generated_at_ms>=comparison_snapshots.generated_at_ms"
    ).bind(comparison.generatedAtMs, JSON.stringify(comparison), batch.collectorId));
  }
  if (batch.minuteBuckets.length > 0) {
    statements.push(env.DB.prepare(
      "INSERT INTO minute_activity (source, minute_start_ms, actions, unique_fids, action_counts_json, updated_at_ms) SELECT json_extract(value,'$.source'), CAST(json_extract(value,'$.minuteStartMs') AS INTEGER), CAST(json_extract(value,'$.actions') AS INTEGER), CAST(json_extract(value,'$.uniqueFids') AS INTEGER), json(json_extract(value,'$.actionCounts')), ? FROM json_each(?) WHERE true ON CONFLICT(source, minute_start_ms) DO UPDATE SET actions=MAX(minute_activity.actions, excluded.actions), unique_fids=MAX(minute_activity.unique_fids, excluded.unique_fids), action_counts_json=excluded.action_counts_json, updated_at_ms=MAX(minute_activity.updated_at_ms, excluded.updated_at_ms)"
    ).bind(receivedAtMs, JSON.stringify(batch.minuteBuckets)));
  }
  const touchedDays = new Set<string>();
  for (const actor of batch.actorDays) {
    touchedDays.add(`${actor.source}:${actor.day}`);
  }
  if (batch.actorDays.length > 0) {
    statements.push(env.DB.prepare(
      "INSERT OR IGNORE INTO actor_day_membership (source, day, fid_hash, created_at_ms) SELECT json_extract(value,'$.source'), json_extract(value,'$.day'), json_extract(value,'$.fidHash'), ? FROM json_each(?)"
    ).bind(receivedAtMs, JSON.stringify(batch.actorDays)));
  }
  if (touchedDays.size > 0) {
    const days = [...touchedDays].map((key) => {
      const [source, day] = key.split(":") as [Source, string];
      return { source, day, startMs: Date.parse(`${day}T00:00:00.000Z`) };
    });
    statements.push(env.DB.prepare(
      "INSERT INTO daily_metrics (source, day, active_fids, actions, updated_at_ms) SELECT json_extract(value,'$.source') AS source, json_extract(value,'$.day') AS day, (SELECT COUNT(*) FROM actor_day_membership m WHERE m.source=json_extract(value,'$.source') AND m.day=json_extract(value,'$.day')), COALESCE((SELECT SUM(a.actions) FROM minute_activity a WHERE a.source=json_extract(value,'$.source') AND a.minute_start_ms>=CAST(json_extract(value,'$.startMs') AS INTEGER) AND a.minute_start_ms<CAST(json_extract(value,'$.startMs') AS INTEGER)+86400000),0), ? FROM json_each(?) WHERE true ON CONFLICT(source, day) DO UPDATE SET active_fids=excluded.active_fids, actions=excluded.actions, updated_at_ms=excluded.updated_at_ms"
    ).bind(receivedAtMs, JSON.stringify(days)));
  }
  if (batch.cursors.length > 0) {
    statements.push(env.DB.prepare(
      "INSERT INTO source_cursors (source, shard, event_id, verified_at_ms, collector_id) SELECT json_extract(value,'$.source'), CAST(json_extract(value,'$.shard') AS INTEGER), json_extract(value,'$.eventId'), CAST(json_extract(value,'$.verifiedAtMs') AS INTEGER), ? FROM json_each(?) WHERE true ON CONFLICT(source, shard) DO UPDATE SET event_id=excluded.event_id, verified_at_ms=excluded.verified_at_ms, collector_id=excluded.collector_id WHERE LENGTH(excluded.event_id)>LENGTH(source_cursors.event_id) OR (LENGTH(excluded.event_id)=LENGTH(source_cursors.event_id) AND excluded.event_id>=source_cursors.event_id)"
    ).bind(batch.collectorId, JSON.stringify(batch.cursors)));
  }
  if (batch.health.length > 0) {
    statements.push(env.DB.prepare(
      "INSERT INTO source_status (source, source_mode, status, observed_at_ms, payload_json, collector_id) SELECT json_extract(value,'$.source'), json_extract(value,'$.sourceMode'), json_extract(value,'$.status'), CAST(json_extract(value,'$.observedAtMs') AS INTEGER), json(value), ? FROM json_each(?) WHERE true ON CONFLICT(source) DO UPDATE SET source_mode=excluded.source_mode, status=excluded.status, observed_at_ms=excluded.observed_at_ms, payload_json=excluded.payload_json, collector_id=excluded.collector_id WHERE excluded.observed_at_ms>=source_status.observed_at_ms"
    ).bind(batch.collectorId, JSON.stringify(batch.health)));
    statements.push(env.DB.prepare(
      "INSERT INTO node_health (source, observed_at_ms, payload_json, collector_id) SELECT json_extract(value,'$.source'), CAST(json_extract(value,'$.observedAtMs') AS INTEGER), json(value), ? FROM json_each(?)"
    ).bind(batch.collectorId, JSON.stringify(batch.health)));
  }
  if (statements.length > 40) throw new RangeError("batch_too_many_mutations");
  try {
    await env.DB.batch(statements);
    return "accepted";
  } catch (error) {
    const duplicate = await env.DB.prepare("SELECT 1 AS present FROM ingest_batches WHERE batch_id = ? LIMIT 1").bind(batch.batchId).first();
    if (duplicate) return "duplicate";
    throw error;
  }
}

export interface PendingLiveDelivery {
  batch: IngestBatch;
  leaseToken: string;
}

export async function claimCollectorBinding(env: Env, collectorId: string, claimedAtMs: number): Promise<boolean> {
  const result = await env.DB.prepare(`
    INSERT INTO collector_binding(slot, collector_id, claimed_at_ms)
    VALUES (1, ?, ?)
    ON CONFLICT(slot) DO UPDATE SET claimed_at_ms = collector_binding.claimed_at_ms
    WHERE collector_binding.collector_id = excluded.collector_id
    RETURNING collector_id
  `).bind(collectorId, claimedAtMs).first<{ collector_id: string }>();
  return result?.collector_id === collectorId;
}

export async function collectorBindingAllows(env: Env, collectorId: string): Promise<boolean> {
  const result = await env.DB.prepare("SELECT collector_id FROM collector_binding WHERE slot=1")
    .first<{ collector_id: string }>();
  return result === null || result.collector_id === collectorId;
}

export async function pendingLiveDeliveries(env: Env, limit = 20, nowMs = Date.now(), leaseMs = 30_000): Promise<PendingLiveDelivery[]> {
  const result = await env.DB.prepare(
    "SELECT batch_id, payload_json FROM live_delivery_outbox WHERE published_at_ms IS NULL AND (lease_until_ms IS NULL OR lease_until_ms<=?) ORDER BY created_at_ms, batch_id LIMIT ?"
  ).bind(nowMs, limit).all<{ batch_id: string; payload_json: string }>();
  const deliveries: PendingLiveDelivery[] = [];
  let validRows = 0;
  for (const row of result.results ?? []) {
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      const batch = IngestBatchSchema.safeParse(parsed);
      if (!batch.success) continue;
      validRows += 1;
      const leaseToken = crypto.randomUUID();
      const claimed = await env.DB.prepare(
        "UPDATE live_delivery_outbox SET lease_token=?, lease_until_ms=? WHERE batch_id=? AND published_at_ms IS NULL AND (lease_until_ms IS NULL OR lease_until_ms<=?)"
      ).bind(leaseToken, nowMs + leaseMs, row.batch_id, nowMs).run();
      if (claimed.meta.changes === 1) deliveries.push({ batch: batch.data, leaseToken });
    } catch { /* invalid rows are surfaced below when no valid delivery exists */ }
  }
  if ((result.results ?? []).length > 0 && validRows === 0) throw new Error("live_delivery_outbox_contains_invalid_batch");
  return deliveries;
}

export async function markLiveDeliveryPublished(env: Env, batchId: string, leaseToken: string, publishedAtMs: number): Promise<void> {
  await env.DB.prepare("UPDATE live_delivery_outbox SET published_at_ms=?, lease_token=NULL, lease_until_ms=NULL WHERE batch_id=? AND lease_token=? AND published_at_ms IS NULL")
    .bind(publishedAtMs, batchId, leaseToken).run();
}

export async function releaseLiveDeliveryLease(env: Env, batchId: string, leaseToken: string): Promise<void> {
  await env.DB.prepare("UPDATE live_delivery_outbox SET lease_token=NULL, lease_until_ms=NULL WHERE batch_id=? AND lease_token=? AND published_at_ms IS NULL")
    .bind(batchId, leaseToken).run();
}

export const SOURCE_RATE_SCOPE = "authenticated-source-v1";

export async function knownIngestBatch(env: Env, batchId: string): Promise<{ receivedAtMs: number } | null> {
  const row = await env.DB.prepare(
    "SELECT received_at_ms FROM ingest_batches WHERE batch_id = ? LIMIT 1"
  ).bind(batchId).first<{ received_at_ms: number }>();
  return row ? { receivedAtMs: Number(row.received_at_ms) } : null;
}

export async function checkRateLimit(env: Env, batch: IngestBatch, nowMs: number, limit = 300): Promise<boolean> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("rate limit must be a positive integer");
  const windowStart = Math.floor(nowMs / 60_000) * 60_000;
  const sources = batchSources(batch);
  const result = await env.DB.prepare(`
    WITH requested(source) AS (
      SELECT CAST(value AS TEXT) FROM json_each(?)
    ), allowed(source) AS (
      SELECT requested.source FROM requested
      WHERE NOT EXISTS (
        SELECT 1 FROM requested AS candidate
        LEFT JOIN rate_windows AS current
          ON current.source = candidate.source
          AND current.collector_id = ?
          AND current.window_start_ms = ?
        WHERE COALESCE(current.batch_count, 0) >= ?
      )
    )
    INSERT INTO rate_windows(source, collector_id, window_start_ms, batch_count)
    SELECT source, ?, ?, 1 FROM allowed WHERE true
    ON CONFLICT(source, collector_id, window_start_ms) DO UPDATE SET
      batch_count = rate_windows.batch_count + 1
    WHERE rate_windows.batch_count < ?
    RETURNING source
  `).bind(
    JSON.stringify(sources),
    SOURCE_RATE_SCOPE,
    windowStart,
    limit,
    SOURCE_RATE_SCOPE,
    windowStart,
    limit
  ).all<{ source: Source }>();
  return (result.results ?? []).length === sources.length;
}

export async function refundRateLimit(env: Env, batch: IngestBatch, nowMs: number): Promise<void> {
  const windowStart = Math.floor(nowMs / 60_000) * 60_000;
  await env.DB.prepare(`
    UPDATE rate_windows SET batch_count = MAX(0, batch_count - 1)
    WHERE collector_id = ? AND window_start_ms = ?
      AND source IN (SELECT CAST(value AS TEXT) FROM json_each(?))
  `).bind(SOURCE_RATE_SCOPE, windowStart, JSON.stringify(batchSources(batch))).run();
}

export function batchSources(batch: IngestBatch): Source[] {
  const sources = new Set<Source>([
    ...batch.pulses.map((value) => value.source),
    ...batch.snapshots.map((value) => value.source),
    ...batch.health.map((value) => value.source),
    ...batch.minuteBuckets.map((value) => value.source),
    ...batch.actorDays.map((value) => value.source),
    ...batch.cursors.map((value) => value.source)
  ]);
  // Comparisons and otherwise empty authenticated batches affect the shared
  // two-source service, so neither can bypass a source-bound rate budget.
  if (batch.comparisonSnapshots.length > 0 || sources.size === 0) {
    sources.add("snapchain");
    sources.add("hypersnap");
  }
  return [...sources].sort();
}

export async function latestStatus(env: Env): Promise<HealthUpdate[]> {
  const result = await env.DB.prepare("SELECT payload_json FROM source_status ORDER BY source").all<{ payload_json: string }>();
  return (result.results ?? []).flatMap((row) => {
    try { return [JSON.parse(row.payload_json) as HealthUpdate]; } catch { return []; }
  });
}

const PROMOTABLE_STATUSES = new Set<SourceMetrics["status"]>(["live", "derived"]);

/**
 * Freshness may downgrade an authoritative collector state, but it must never
 * turn an unhealthy state into availability. A healthy state is reconstructed
 * only after every server-verifiable health gate passes.
 */
export function applyFreshness(metrics: SourceMetrics, nowMs: number): SourceMetrics {
  const age = metrics.lastCollectorAtMs === null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - metrics.lastCollectorAtMs);
  if (metrics.sourceMode === "unavailable" || age > 120_000) {
    return { ...metrics, status: "disconnected", quality: "unavailable" };
  }

  // Preserve recent collector diagnoses such as replaying, reconnecting,
  // protocol mismatch, stale, and partial. They are strictly more informative
  // than a status inferred from the age of the containing snapshot.
  if (!PROMOTABLE_STATUSES.has(metrics.status)) return metrics;

  if (age > 30_000) return { ...metrics, status: "stale", quality: "degraded" };
  if (!metrics.node.synchronized) return { ...metrics, status: "stale", quality: "degraded" };
  if (metrics.node.reconciliationState !== "ok") return { ...metrics, status: "partial", quality: "degraded" };
  if (!metrics.node.historyComplete || metrics.node.shardCount <= 0 || metrics.node.coveredShards < metrics.node.shardCount) {
    return { ...metrics, status: "partial", quality: "degraded" };
  }
  if (metrics.sourceMode === "derived") return { ...metrics, status: "derived", quality: "derived" };
  return { ...metrics, status: "live", quality: "high" };
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
