import {
  IngestBatchSchema,
  MetadataSchema,
  isFreshTimestamp,
  verifyIngestSignature,
  type IngestBatch
} from "@snapmeter/contracts";
import { handleFarcasterMe } from "./farcaster-auth";
import { LiveRoom } from "./live-room";
import { checkRateLimit, claimCollectorBinding, collectorBindingAllows, knownIngestBatch, latestStatus, markLiveDeliveryPublished, pendingLiveDeliveries, persistBatch, readSummary, refundRateLimit, releaseLiveDeliveryLease } from "./repository";
import type { Env, ExecutionContextLike, ScheduledControllerLike } from "./types";

export { LiveRoom };

const MAX_BODY_BYTES = 512 * 1024;
const MAX_FUTURE_RECORD_SKEW_MS = 60_000;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
  scheduled(controller: ScheduledControllerLike, env: Env, ctx: ExecutionContextLike): void {
    ctx.waitUntil(runScheduled(controller, env));
  }
};

export async function handleRequest(request: Request, env: Env, _ctx?: ExecutionContextLike): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
  if (url.pathname === "/api/v1/ingest/batch" && request.method === "POST") return handleIngest(request, env);
  if (url.pathname === "/api/v1/farcaster/me" && request.method === "GET") return handleFarcasterMe(request);
  if (url.pathname === "/api/v1/summary" && request.method === "GET") return json(await readSummary(env));
  if (url.pathname === "/api/v1/status" && request.method === "GET") {
    const summary = await readSummary(env);
    return json({
      schemaVersion: 1,
      service: "SnapMeter",
      ok: true,
      generatedAtMs: summary.generatedAtMs,
      live: summary.sources.snapchain.status === "live" || summary.sources.hypersnap.status === "derived",
      sources: await latestStatus(env),
      dashboardSources: {
        snapchain: { status: summary.sources.snapchain.status, lastCollectorAtMs: summary.sources.snapchain.lastCollectorAtMs },
        hypersnap: { status: summary.sources.hypersnap.status, lastCollectorAtMs: summary.sources.hypersnap.lastCollectorAtMs }
      }
    });
  }
  if (url.pathname === "/api/v1/metadata" && request.method === "GET") {
    return json(MetadataSchema.parse({
      schemaVersion: 1,
      service: "SnapMeter",
      timezone: "UTC",
      metricsPolicyVersion: "2026-08-13.1",
      hypersnapClassifierVersion: "2eee4c9f2a78.1",
      upstream: {
        snapchain: "6152402aea2dbe732fb73076f674b038bfd4aee5",
        hypersnap: "2eee4c9f2a7833ce7971dfef028480abbe9c4720"
      }
    }), { "cache-control": "public, max-age=300" });
  }
  if (url.pathname === "/api/v1/timeseries" && request.method === "GET") return handleTimeseries(url, env);
  if (url.pathname === "/api/v1/live" && request.method === "GET") return handleLive(request, env);
  return json({ error: "not_found" }, {}, 404);
}

export async function handleLive(
  request: Request,
  env: Env,
  summaryReader: (environment: Env) => Promise<Awaited<ReturnType<typeof readSummary>>> = readSummary
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "cross_origin_websocket_forbidden" }, {}, 403);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "websocket_upgrade_required" }, {}, 426);
  const room = env.LIVE_ROOM.getByName("global");
  const admission = await room.fetch("https://live.internal/connect", {
    method: "POST",
    headers: {
      "x-snapmeter-internal": "1",
      "x-snapmeter-client-key": liveClientKey(request)
    }
  });
  if (!admission.ok) {
    const retryAfter = admission.headers.get("retry-after");
    return json({ error: admission.status === 429 ? "live_connection_rate_limited" : "live_room_unavailable" }, retryAfter ? { "retry-after": retryAfter } : {}, admission.status === 429 ? 429 : 503);
  }
  const token = (await admission.json() as { token?: unknown }).token;
  if (typeof token !== "string") return json({ error: "live_room_unavailable" }, {}, 503);
  let snapshot: Awaited<ReturnType<typeof readSummary>>;
  try {
    snapshot = await summaryReader(env);
  } catch {
    await invalidateLiveAdmission(room, token);
    return json({ error: "live_snapshot_unavailable" }, {}, 503);
  }
  let hydrate: Response;
  try {
    hydrate = await room.fetch(`https://live.internal/hydrate?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-snapmeter-internal": "1" },
      body: JSON.stringify({ snapshot })
    });
  } catch {
    await invalidateLiveAdmission(room, token);
    return json({ error: "live_room_unavailable" }, {}, 503);
  }
  if (!hydrate.ok) {
    await invalidateLiveAdmission(room, token);
    return json({ error: "live_room_unavailable" }, {}, 503);
  }
  const upgrade = new Request(`https://live.internal/upgrade?token=${encodeURIComponent(token)}`, request);
  return room.fetch(upgrade);
}

async function invalidateLiveAdmission(room: DurableObjectStub, token: string): Promise<void> {
  try {
    await room.fetch(`https://live.internal/invalidate?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "x-snapmeter-internal": "1" }
    });
  } catch { /* the admission expires quickly even if invalidation cannot reach the room */ }
}

function liveClientKey(request: Request): string {
  const forwarded = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return forwarded && /^[0-9a-f:.]{3,64}$/i.test(forwarded) ? forwarded : "unknown";
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (!env.SNAPMETER_INGEST_SECRET || env.SNAPMETER_INGEST_SECRET.length < 32) {
    return json({ error: "ingest_not_configured" }, {}, 503);
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return json({ error: "unsupported_content_type" }, {}, 415);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, {}, 413);
  const rawBody = await readBodyLimited(request, MAX_BODY_BYTES);
  if (rawBody === null) return json({ error: "payload_too_large" }, {}, 413);
  const timestamp = request.headers.get("x-snapmeter-timestamp") ?? "";
  const nonce = request.headers.get("x-snapmeter-nonce") ?? "";
  const signature = request.headers.get("x-snapmeter-signature") ?? "";
  if (!isFreshTimestamp(timestamp)) return json({ error: "stale_or_invalid_timestamp" }, {}, 401);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) return json({ error: "invalid_nonce" }, {}, 401);
  if (!(await verifyIngestSignature(env.SNAPMETER_INGEST_SECRET, timestamp, nonce, rawBody, signature))) return json({ error: "invalid_signature" }, {}, 401);

  let candidate: unknown;
  try { candidate = JSON.parse(rawBody); } catch { return json({ error: "invalid_json" }, {}, 400); }
  const parsed = IngestBatchSchema.safeParse(candidate);
  if (!parsed.success) return json({ error: "invalid_batch", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) }, {}, 400);
  const batch = parsed.data;
  if (batch.batchId.toLowerCase() !== nonce.toLowerCase()) return json({ error: "nonce_batch_mismatch" }, {}, 401);
  const receivedAtMs = Date.now();
  const timeError = validateBatchTimes(batch, Number(timestamp), receivedAtMs);
  if (timeError !== null) return json({ error: "invalid_batch_time", field: timeError }, {}, 400);
  const recordCount = batch.actorDays.length + batch.minuteBuckets.length + batch.cursors.length + batch.health.length + batch.snapshots.length + batch.comparisonSnapshots.length;
  if (recordCount > 700) return json({ error: "too_many_records", max: 700 }, {}, 413);
  if (request.headers.get("x-snapmeter-doctor") === "1") {
    if (!isEmptyProbe(batch)) return json({ error: "doctor_probe_must_be_empty" }, {}, 400);
    if (!(await collectorBindingAllows(env, batch.collectorId))) {
      return json({ error: "collector_identity_conflict" }, {}, 409);
    }
    return json({ ok: true, authenticated: true, serverTimeMs: Date.now() });
  }
  if (!(await claimCollectorBinding(env, batch.collectorId, receivedAtMs))) {
    return json({ error: "collector_identity_conflict" }, {}, 409);
  }
  const known = await knownIngestBatch(env, batch.batchId);
  if (known) {
    await drainLiveDeliveryOutbox(env);
    return json({ ok: true, batchId: batch.batchId, duplicate: true, acceptedAtMs: known.receivedAtMs });
  }
  if (!(await checkRateLimit(env, batch, receivedAtMs))) {
    const becameKnown = await knownIngestBatch(env, batch.batchId);
    if (becameKnown) {
      await drainLiveDeliveryOutbox(env);
      return json({ ok: true, batchId: batch.batchId, duplicate: true, acceptedAtMs: becameKnown.receivedAtMs });
    }
    return json({ error: "rate_limited" }, { "retry-after": "60" }, 429);
  }
  let disposition: "accepted" | "duplicate";
  try { disposition = await persistBatch(env, batch, receivedAtMs); }
  catch (error) {
    await refundRateLimit(env, batch, receivedAtMs);
    if (error instanceof RangeError) return json({ error: error.message }, {}, 413);
    console.error(JSON.stringify({ level: "error", event: "ingest_failed", batchId: batch.batchId, errorKind: safeErrorKind(error) }));
    return json({ error: "ingest_failed" }, {}, 500);
  }
  if (disposition === "duplicate") {
    await refundRateLimit(env, batch, receivedAtMs);
    const acceptedAtMs = (await knownIngestBatch(env, batch.batchId))?.receivedAtMs ?? receivedAtMs;
    await drainLiveDeliveryOutbox(env);
    return json({ ok: true, batchId: batch.batchId, duplicate: true, acceptedAtMs });
  }
  try { await drainLiveDeliveryOutbox(env); }
  catch (error) {
    console.error(JSON.stringify({ level: "error", event: "live_delivery_deferred", batchId: batch.batchId, errorKind: safeErrorKind(error) }));
    return json({ error: "live_delivery_deferred" }, { "retry-after": "1" }, 503);
  }
  return json({ ok: true, batchId: batch.batchId, duplicate: false, acceptedAtMs: receivedAtMs }, {}, 202);
}

async function readBodyLimited(request: Request, maximumBytes: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        try { await reader.cancel(); } catch { /* the size rejection still wins if upstream cancellation fails */ }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function validateBatchTimes(batch: IngestBatch, signedAtMs: number, receivedAtMs: number): string | null {
  // The body can be retried long after it was created, so old sentAtMs values
  // remain valid. Only reject a body whose claimed creation time is ahead of
  // the already-fresh signed request/server clocks.
  const requestFutureLimit = Math.max(receivedAtMs, signedAtMs) + MAX_FUTURE_RECORD_SKEW_MS;
  if (batch.sentAtMs > requestFutureLimit) return "sentAtMs";
  const recordFutureLimit = batch.sentAtMs + MAX_FUTURE_RECORD_SKEW_MS;
  const future = (value: number): boolean => value > recordFutureLimit;

  for (const pulse of batch.pulses) {
    if (pulse.windowStartMs > pulse.windowEndMs) return "pulses.window";
    if (pulse.lastActionAtMs > pulse.windowEndMs) return "pulses.lastActionAtMs";
    if (future(pulse.windowStartMs) || future(pulse.windowEndMs) || future(pulse.lastActionAtMs)) return "pulses.future";
  }
  if (batch.snapshots.length > 0 && batch.snapshots.some((snapshot) => snapshot.updatedAtMs !== batch.sentAtMs)) {
    return "snapshots.updatedAtMs";
  }
  for (const snapshot of batch.snapshots) {
    if (future(snapshot.updatedAtMs)) return "snapshots.updatedAtMs";
    if (snapshot.lastActionAtMs !== null && (snapshot.lastActionAtMs > snapshot.updatedAtMs || future(snapshot.lastActionAtMs))) {
      return "snapshots.lastActionAtMs";
    }
    if (snapshot.lastCollectorAtMs !== null && future(snapshot.lastCollectorAtMs)) return "snapshots.lastCollectorAtMs";
  }
  for (const comparison of batch.comparisonSnapshots) {
    if (comparison.generatedAtMs !== batch.sentAtMs) return "comparisonSnapshots.generatedAtMs";
    if (future(comparison.generatedAtMs)) return "comparisonSnapshots.generatedAtMs";
  }
  for (const bucket of batch.minuteBuckets) {
    if (future(bucket.minuteStartMs)) return "minuteBuckets.minuteStartMs";
  }
  for (const cursor of batch.cursors) {
    if (future(cursor.verifiedAtMs)) return "cursors.verifiedAtMs";
  }
  for (const health of batch.health) {
    if (future(health.observedAtMs)) return "health.observedAtMs";
    if (health.node.historyCoverageStartMs !== null && future(health.node.historyCoverageStartMs)) {
      return "health.node.historyCoverageStartMs";
    }
  }
  for (const actor of batch.actorDays) {
    if (actor.day > new Date(recordFutureLimit).toISOString().slice(0, 10)) return "actorDays.day";
  }
  return null;
}

async function drainLiveDeliveryOutbox(env: Env): Promise<void> {
  for (const pending of await pendingLiveDeliveries(env)) {
    try {
      await publishAcceptedBatch(env, pending.batch);
      await markLiveDeliveryPublished(env, pending.batch.batchId, pending.leaseToken, Date.now());
    } catch (error) {
      await releaseLiveDeliveryLease(env, pending.batch.batchId, pending.leaseToken);
      throw error;
    }
  }
}

async function publishAcceptedBatch(env: Env, batch: IngestBatch): Promise<void> {
  const room = env.LIVE_ROOM.getByName("global");
  const nowMs = Date.now();
  const publish = async (kind: "pulse" | "snapshot" | "status", index: number, data: unknown): Promise<void> => {
    const deliveryId = `${batch.batchId}:${kind}:${index}`;
    const response = await room.fetch("https://live.internal/publish", {
      method: "POST",
      headers: { "content-type": "application/json", "x-snapmeter-internal": "1" },
      body: JSON.stringify({ kind, deliveryId, data })
    });
    if (!response.ok) throw new Error(`Live room rejected ${kind}: ${response.status}`);
  };
  const pulseDeliveries: Promise<void>[] = [];
  for (const [index, pulse] of batch.pulses.entries()) {
    const freshWindow = pulse.windowEndMs <= nowMs && nowMs - pulse.windowEndMs <= 120_000;
    const freshAction = pulse.lastActionAtMs <= nowMs && nowMs - pulse.lastActionAtMs <= 120_000;
    if (freshWindow && freshAction) pulseDeliveries.push(publish("pulse", index, pulse));
  }
  await Promise.all(pulseDeliveries);
  for (const [index, health] of batch.health.entries()) await publish("status", index, health);
  if (batch.snapshots.length > 0) await publish("snapshot", 0, await readSummary(env));
}

async function handleTimeseries(url: URL, env: Env): Promise<Response> {
  const range = url.searchParams.get("range") ?? "24h";
  if (!new Set(["24h", "7d", "30d"]).has(range)) return json({ error: "invalid_range" }, {}, 400);
  if (range === "30d") {
    const cutoffDay = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const result = await env.DB.prepare(
      "SELECT source, day AS bucket, active_fids, actions FROM daily_metrics WHERE day>=? ORDER BY day, source"
    ).bind(cutoffDay).all();
    return json({ schemaVersion: 1, range, granularity: "day", points: result.results ?? [] });
  }
  if (range === "7d") {
    const cutoffDay = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    const result = await env.DB.prepare(
      "SELECT source, day AS bucket, active_fids, actions FROM daily_metrics WHERE day>=? ORDER BY day, source"
    ).bind(cutoffDay).all();
    return json({ schemaVersion: 1, range, granularity: "day", points: result.results ?? [] });
  }
  const cutoff = Date.now() - 24 * 60 * 60_000;
  const result = await env.DB.prepare(
    "SELECT source, minute_start_ms AS bucket, actions, unique_fids, action_counts_json FROM minute_activity WHERE minute_start_ms>=? ORDER BY minute_start_ms, source"
  ).bind(cutoff).all();
  return json({ schemaVersion: 1, range, granularity: "minute", points: result.results ?? [] });
}

export async function runScheduled(controller: ScheduledControllerLike, env: Env): Promise<void> {
  const boundary = Math.floor(controller.scheduledTime / 60_000) * 60_000;
  if (controller.cron === "* * * * *") {
    await drainLiveDeliveryOutbox(env);
    const repairCutoffDay = new Date(boundary - 86_400_000).toISOString().slice(0, 10);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO daily_metrics (source, day, active_fids, actions, updated_at_ms) SELECT m.source, m.day, COUNT(*), COALESCE((SELECT SUM(a.actions) FROM minute_activity a WHERE a.source=m.source AND a.minute_start_ms>=unixepoch(m.day)*1000 AND a.minute_start_ms<(unixepoch(m.day)+86400)*1000),0), ? FROM actor_day_membership m WHERE m.day>=? GROUP BY m.source,m.day ON CONFLICT(source,day) DO UPDATE SET active_fids=excluded.active_fids, actions=excluded.actions, updated_at_ms=excluded.updated_at_ms"
      ).bind(boundary, repairCutoffDay),
      env.DB.prepare("INSERT OR IGNORE INTO aggregation_runs (task, boundary_ms, completed_at_ms) VALUES ('minute', ?, ?)").bind(boundary, Date.now())
    ]);
    return;
  }
  if (controller.cron === "17 3 * * *") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM ingest_batches WHERE expires_at_ms < ? AND NOT EXISTS (SELECT 1 FROM live_delivery_outbox o WHERE o.batch_id=ingest_batches.batch_id AND o.published_at_ms IS NULL)").bind(boundary),
      env.DB.prepare("DELETE FROM live_delivery_outbox WHERE published_at_ms IS NOT NULL AND created_at_ms < ?").bind(boundary - 24 * 60 * 60_000),
      env.DB.prepare("DELETE FROM rate_windows WHERE window_start_ms < ?").bind(boundary - 10 * 60_000),
      env.DB.prepare("DELETE FROM minute_activity WHERE minute_start_ms < ?").bind(boundary - 90 * 86_400_000),
      env.DB.prepare("DELETE FROM metric_snapshots WHERE generated_at_ms < ?").bind(boundary - 7 * 86_400_000),
      env.DB.prepare("DELETE FROM node_health WHERE observed_at_ms < ?").bind(boundary - 30 * 86_400_000),
      env.DB.prepare("DELETE FROM actor_day_membership WHERE day < ?").bind(new Date(boundary - 120 * 86_400_000).toISOString().slice(0, 10)),
      env.DB.prepare("DELETE FROM aggregation_runs WHERE completed_at_ms < ?").bind(boundary - 180 * 86_400_000),
      env.DB.prepare("INSERT OR IGNORE INTO aggregation_runs (task, boundary_ms, completed_at_ms) VALUES ('cleanup', ?, ?)").bind(boundary, Date.now())
    ]);
  }
}

function isEmptyProbe(batch: IngestBatch): boolean {
  return batch.pulses.length === 0 && batch.snapshots.length === 0 && batch.comparisonSnapshots.length === 0 && batch.minuteBuckets.length === 0 && batch.actorDays.length === 0 && batch.cursors.length === 0 && batch.health.length === 0;
}

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function safeErrorKind(error: unknown): "error" | "unknown" {
  return error instanceof Error ? "error" : "unknown";
}
