import { signIngest, type IngestBatch } from "@snapmeter/contracts";
import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { emptySource } from "./defaults";
import { handleLive } from "./index";
import { pendingLiveDeliveries, releaseLiveDeliveryLease } from "./repository";
import type { Env } from "./types";
import { checkRateLimit, SOURCE_RATE_SCOPE } from "./repository";

const SECRET = "worker-test-secret-with-32-characters";

function batch(batchId = crypto.randomUUID(), pulse = false): IngestBatch {
  const now = Date.now();
  return {
    schemaVersion: 1,
    batchId,
    collectorId: "collector-test-1",
    collectorVersion: "0.1.0",
    sentAtMs: now,
    pulses: pulse ? [{
      schemaVersion: 1,
      source: "snapchain",
      sourceMode: "verified",
      windowStartMs: now - 250,
      windowEndMs: now,
      eventCount: 3,
      uniqueFids: 2,
      actionCounts: { cast: 2, reaction: 1 },
      lastActionAtMs: now,
      maxEventId: "1:49153",
      isReplay: false
    }] : [],
    snapshots: [],
    comparisonSnapshots: [],
    minuteBuckets: [],
    actorDays: [],
    cursors: [],
    health: []
  };
}

async function signedRequest(payload: ReturnType<typeof batch>, extraHeaders: Record<string, string> = {}): Promise<Request> {
  const raw = JSON.stringify(payload);
  const timestamp = String(Date.now());
  return new Request("https://snapmeter.test/api/v1/ingest/batch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-snapmeter-timestamp": timestamp,
      "x-snapmeter-nonce": payload.batchId,
      "x-snapmeter-signature": await signIngest(SECRET, timestamp, payload.batchId, raw),
      ...extraHeaders
    },
    body: raw
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message")), 2_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(String(event.data));
    }, { once: true });
  });
}

async function expectQuiet(socket: WebSocket, durationMs = 400): Promise<void> {
  await expect(Promise.race([
    nextMessage(socket).then(() => "message"),
    new Promise<string>((resolve) => setTimeout(() => resolve("quiet"), durationMs))
  ])).resolves.toBe("quiet");
}

describe("Worker API", () => {
  it("reports pinned source metadata and disconnected status honestly", async () => {
    const metadata = await SELF.fetch("https://snapmeter.test/api/v1/metadata");
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ timezone: "UTC", upstream: { snapchain: "6152402aea2dbe732fb73076f674b038bfd4aee5" } });
    const summary = await SELF.fetch("https://snapmeter.test/api/v1/summary");
    const body = await summary.json() as { sources: { snapchain: { status: string; daily: Array<{ day: string }> }; hypersnap: { sourceMode: string; status: string } } };
    expect(body).toMatchObject({ sources: { snapchain: { status: "disconnected" }, hypersnap: { sourceMode: "derived", status: "disconnected" } } });
    expect(body.sources.snapchain.daily).toHaveLength(30);
    expect(body.sources.snapchain.daily.at(-1)?.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it("rejects cross-origin browser WebSocket upgrades", async () => {
    const response = await SELF.fetch("https://snapmeter.test/api/v1/live", {
      headers: { Upgrade: "websocket", Origin: "https://attacker.example" }
    });
    expect(response.status).toBe(403);
  });

  it("authenticates an empty doctor probe without storing it", async () => {
    const payload = batch();
    const response = await SELF.fetch(await signedRequest(payload, { "x-snapmeter-doctor": "1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, authenticated: true });
    const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM ingest_batches").first<{ total: number }>();
    expect(row?.total).toBe(0);
  });

  it("rejects a modified body and stale replay timestamp", async () => {
    const payload = batch();
    const request = await signedRequest(payload);
    const headers = new Headers(request.headers);
    const modified = { ...payload, collectorVersion: "tampered" };
    const invalid = await SELF.fetch(new Request(request.url, { method: "POST", headers, body: JSON.stringify(modified) }));
    expect(invalid.status).toBe(401);

    const raw = JSON.stringify(payload);
    const oldTimestamp = String(Date.now() - 301_000);
    const stale = await SELF.fetch(new Request(request.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-snapmeter-timestamp": oldTimestamp,
        "x-snapmeter-nonce": payload.batchId,
        "x-snapmeter-signature": await signIngest(SECRET, oldTimestamp, payload.batchId, raw)
      },
      body: raw
    }));
    expect(stale.status).toBe(401);
  });

  it("rejects a non-positive data-shard cursor before D1", async () => {
    const payload = { ...batch(), cursors: [{ source: "snapchain" as const, shard: 0, eventId: "1", verifiedAtMs: Date.now() }] };
    const response = await SELF.fetch(await signedRequest(payload as ReturnType<typeof batch>));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_batch" });
  });

  it("accepts each batch once and broadcasts a coalesced real pulse", async () => {
    const upgrade = await SELF.fetch("https://snapmeter.test/api/v1/live", { headers: { Upgrade: "websocket" } });
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    const initial = nextMessage(socket!);
    expect(JSON.parse(await initial)).toMatchObject({ type: "snapshot", schemaVersion: 1 });

    const payload = batch(crypto.randomUUID(), true);
    const pulseMessage = nextMessage(socket!);
    const accepted = await SELF.fetch(await signedRequest(payload));
    expect(accepted.status).toBe(202);
    const acceptedBody = await accepted.json() as { duplicate: boolean; acceptedAtMs: number };
    expect(acceptedBody).toMatchObject({ duplicate: false });
    const persisted = await env.DB.prepare("SELECT received_at_ms FROM ingest_batches WHERE batch_id=?")
      .bind(payload.batchId).first<{ received_at_ms: number }>();
    expect(acceptedBody.acceptedAtMs).toBe(persisted?.received_at_ms);
    const pulse = JSON.parse(await pulseMessage);
    expect(pulse).toMatchObject({ type: "pulse", data: { source: "snapchain", eventCount: 3, isReplay: false } });

    const duplicate = await SELF.fetch(await signedRequest(payload));
    expect(await duplicate.json()).toMatchObject({ duplicate: true, acceptedAtMs: acceptedBody.acceptedAtMs });
    const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM ingest_batches WHERE batch_id=?").bind(payload.batchId).first<{ total: number }>();
    expect(row?.total).toBe(1);

    await evictDurableObject(env.LIVE_ROOM.getByName("global"), { webSockets: "hibernate" });
    socket?.close(1000, "done");
  });

  it("does not charge authenticated known-batch replays against a saturated source budget", async () => {
    const payload = batch();
    payload.cursors = [{ source: "snapchain", shard: 1, eventId: "10", verifiedAtMs: Date.now() }];
    const receivedAtMs = Date.now() - 1_000;
    const windowStartMs = Math.floor(Date.now() / 60_000) * 60_000;
    await env.DB.prepare(
      "INSERT INTO ingest_batches(batch_id, collector_id, collector_version, sent_at_ms, received_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(payload.batchId, payload.collectorId, payload.collectorVersion, payload.sentAtMs, receivedAtMs, Date.now() + 60_000).run();
    await env.DB.prepare(
      "INSERT INTO rate_windows(source, collector_id, window_start_ms, batch_count) VALUES ('snapchain', ?, ?, 300) ON CONFLICT(source, collector_id, window_start_ms) DO UPDATE SET batch_count=300"
    ).bind(SOURCE_RATE_SCOPE, windowStartMs).run();
    try {
      const replays = await Promise.all(Array.from({ length: 8 }, async () => SELF.fetch(await signedRequest(payload))));
      expect(replays.every((response) => response.status === 200)).toBe(true);
      for (const response of replays) {
        expect(await response.json()).toMatchObject({ duplicate: true, acceptedAtMs: receivedAtMs });
      }
      const counter = await env.DB.prepare(
        "SELECT batch_count FROM rate_windows WHERE source='snapchain' AND collector_id=? AND window_start_ms=?"
      ).bind(SOURCE_RATE_SCOPE, windowStartMs).first<{ batch_count: number }>();
      expect(counter?.batch_count).toBe(300);

      const fresh = batch();
      fresh.cursors = [{ source: "snapchain", shard: 1, eventId: "11", verifiedAtMs: Date.now() }];
      const limited = await SELF.fetch(await signedRequest(fresh));
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    } finally {
      await env.DB.prepare("DELETE FROM ingest_batches WHERE batch_id=?").bind(payload.batchId).run();
      await env.DB.prepare(
        "DELETE FROM rate_windows WHERE source='snapchain' AND collector_id=? AND window_start_ms=?"
      ).bind(SOURCE_RATE_SCOPE, windowStartMs).run();
    }
  });

  it("atomically enforces one source budget across spoofed collector IDs", async () => {
    const nowMs = Math.floor((Date.now() + 24 * 60 * 60_000) / 60_000) * 60_000;
    const attempts = Array.from({ length: 16 }, (_, index) => {
      const payload = batch();
      payload.collectorId = `spoofed-collector-${index}`;
      payload.cursors = [{ source: "hypersnap", shard: 1, eventId: String(index + 1), verifiedAtMs: nowMs }];
      return checkRateLimit(env, payload, nowMs, 1);
    });
    try {
      const results = await Promise.all(attempts);
      expect(results.filter(Boolean)).toHaveLength(1);
      const row = await env.DB.prepare(
        "SELECT batch_count FROM rate_windows WHERE source='hypersnap' AND collector_id=? AND window_start_ms=?"
      ).bind(SOURCE_RATE_SCOPE, nowMs).first<{ batch_count: number }>();
      expect(row?.batch_count).toBe(1);
      const spoofedRows = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM rate_windows WHERE source='hypersnap' AND window_start_ms=? AND collector_id<>?"
      ).bind(nowMs, SOURCE_RATE_SCOPE).first<{ total: number }>();
      expect(spoofedRows?.total).toBe(0);
    } finally {
      await env.DB.prepare(
        "DELETE FROM rate_windows WHERE source='hypersnap' AND collector_id=? AND window_start_ms=?"
      ).bind(SOURCE_RATE_SCOPE, nowMs).run();
    }
  });

  it("refunds a source budget after a definitive persistence failure", async () => {
    const payload = batch();
    payload.collectorId = "collector-persist-failure-test";
    payload.cursors = [{ source: "snapchain", shard: 1, eventId: "99", verifiedAtMs: Date.now() }];
    const windowStartMs = Math.floor(Date.now() / 60_000) * 60_000;
    const before = await env.DB.prepare(
      "SELECT batch_count FROM rate_windows WHERE source='snapchain' AND collector_id=? AND window_start_ms=?"
    ).bind(SOURCE_RATE_SCOPE, windowStartMs).first<{ batch_count: number }>();
    await env.DB.prepare(`
      CREATE TRIGGER reject_test_ingest BEFORE INSERT ON ingest_batches
      WHEN NEW.collector_id = 'collector-persist-failure-test'
      BEGIN SELECT RAISE(ABORT, 'forced_persist_failure'); END
    `).run();
    try {
      const response = await SELF.fetch(await signedRequest(payload));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "ingest_failed" });
      const after = await env.DB.prepare(
        "SELECT batch_count FROM rate_windows WHERE source='snapchain' AND collector_id=? AND window_start_ms=?"
      ).bind(SOURCE_RATE_SCOPE, windowStartMs).first<{ batch_count: number }>();
      expect(after?.batch_count ?? 0).toBe(before?.batch_count ?? 0);
      const stored = await env.DB.prepare("SELECT 1 AS present FROM ingest_batches WHERE batch_id=?")
        .bind(payload.batchId).first();
      expect(stored).toBeNull();
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS reject_test_ingest").run();
    }
  });

  it("persists delayed aggregate delivery without emitting a historical pulse", async () => {
    const upgrade = await SELF.fetch("https://snapmeter.test/api/v1/live", { headers: { Upgrade: "websocket" } });
    const socket = upgrade.webSocket!;
    socket.accept();
    await nextMessage(socket);
    const payload = batch(crypto.randomUUID(), true);
    payload.pulses[0]!.windowEndMs = Date.now() - 121_000;
    payload.pulses[0]!.lastActionAtMs = payload.pulses[0]!.windowEndMs;
    const response = await SELF.fetch(await signedRequest(payload));
    expect(response.status).toBe(202);
    await expect(Promise.race([
      nextMessage(socket).then(() => "message"),
      new Promise<string>((resolve) => setTimeout(() => resolve("quiet"), 400))
    ])).resolves.toBe("quiet");
    const stored = await env.DB.prepare("SELECT COUNT(*) AS total FROM ingest_batches WHERE batch_id=?")
      .bind(payload.batchId).first<{ total: number }>();
    expect(stored?.total).toBe(1);
    socket.close(1000, "done");
  });

  it("hydrates a new WebSocket with the latest accepted snapshot", async () => {
    const now = Date.now();
    const snapchain = {
      ...emptySource("snapchain", now),
      status: "live" as const,
      quality: "high" as const,
      lastCollectorAtMs: now,
      lastActionAtMs: now - 500,
      rolling24h: 321,
      previous24h: 300,
      changeAbsolute: 21,
      changePercent: 7,
      node: {
        ...emptySource("snapchain", now).node,
        shardCount: 2,
        coveredShards: 2,
        synchronized: true,
        reconciliationState: "ok" as const,
        historyCoverageStartMs: now - 31 * 86_400_000,
        historyComplete: true
      }
    };
    const base = batch();
    const payload = { ...base, snapshots: [snapchain] };
    const accepted = await SELF.fetch(await signedRequest(payload));
    expect(accepted.status).toBe(202);

    const summary = await SELF.fetch("https://snapmeter.test/api/v1/summary");
    expect(await summary.json()).toMatchObject({ sources: { snapchain: { status: "live", rolling24h: 321 } } });

    const upgrade = await SELF.fetch("https://snapmeter.test/api/v1/live", { headers: { Upgrade: "websocket" } });
    const socket = upgrade.webSocket!;
    socket.accept();
    expect(JSON.parse(await nextMessage(socket))).toMatchObject({ type: "snapshot", data: { sources: { snapchain: { rolling24h: 321 } } } });
    socket.close(1000, "done");
  });

  it("hydrates only the newly connected socket without broadcasting or redelivering", async () => {
    const firstUpgrade = await SELF.fetch("https://snapmeter.test/api/v1/live", { headers: { Upgrade: "websocket", "cf-connecting-ip": "203.0.113.10" } });
    const first = firstUpgrade.webSocket!;
    first.accept();
    const firstSnapshot = JSON.parse(await nextMessage(first)) as { sequence: number };

    const secondUpgrade = await SELF.fetch("https://snapmeter.test/api/v1/live", { headers: { Upgrade: "websocket", "cf-connecting-ip": "203.0.113.11" } });
    const second = secondUpgrade.webSocket!;
    second.accept();
    const secondSnapshot = JSON.parse(await nextMessage(second)) as { type: string; sequence: number };
    expect(secondSnapshot.type).toBe("snapshot");
    expect(secondSnapshot.sequence).toBe(firstSnapshot.sequence);
    await expectQuiet(first);
    first.close(1000, "done");
    second.close(1000, "done");
  });

  it("deduplicates stable delivery IDs after an outbox publish replay", async () => {
    const upgrade = await SELF.fetch("https://snapmeter.test/api/v1/live", { headers: { Upgrade: "websocket", "cf-connecting-ip": "203.0.113.12" } });
    const socket = upgrade.webSocket!;
    socket.accept();
    await nextMessage(socket);
    const payload = batch(crypto.randomUUID(), true);
    const pulse = nextMessage(socket);
    expect((await SELF.fetch(await signedRequest(payload))).status).toBe(202);
    const envelope = JSON.parse(await pulse) as { deliveryId: string; data: { eventCount: number } };
    expect(envelope.deliveryId).toBe(`${payload.batchId}:pulse:0`);
    expect(envelope.data.eventCount).toBe(3);

    await env.DB.prepare("UPDATE live_delivery_outbox SET published_at_ms=NULL WHERE batch_id=?").bind(payload.batchId).run();
    expect((await SELF.fetch(await signedRequest(payload))).status).toBe(200);
    await expectQuiet(socket);
    const row = await env.DB.prepare("SELECT published_at_ms FROM live_delivery_outbox WHERE batch_id=?").bind(payload.batchId).first<{ published_at_ms: number | null }>();
    expect(row?.published_at_ms).not.toBeNull();
    socket.close(1000, "done");
  });

  it("drains old unpublished rows instead of stranding them", async () => {
    const payload = batch(crypto.randomUUID(), false);
    expect((await SELF.fetch(await signedRequest(payload))).status).toBe(202);
    await env.DB.prepare("UPDATE live_delivery_outbox SET published_at_ms=NULL, created_at_ms=? WHERE batch_id=?")
      .bind(Date.now() - 48 * 60 * 60_000, payload.batchId).run();
    expect((await SELF.fetch(await signedRequest(payload))).status).toBe(200);
    const row = await env.DB.prepare("SELECT published_at_ms FROM live_delivery_outbox WHERE batch_id=?").bind(payload.batchId).first<{ published_at_ms: number | null }>();
    expect(row?.published_at_ms).not.toBeNull();
  });

  it("leases each pending outbox row to only one concurrent drain", async () => {
    const payload = batch(crypto.randomUUID(), false);
    expect((await SELF.fetch(await signedRequest(payload))).status).toBe(202);
    await env.DB.prepare("UPDATE live_delivery_outbox SET published_at_ms=NULL, lease_token=NULL, lease_until_ms=NULL WHERE batch_id=?")
      .bind(payload.batchId).run();
    const now = Date.now();
    const [left, right] = await Promise.all([
      pendingLiveDeliveries(env, 20, now),
      pendingLiveDeliveries(env, 20, now)
    ]);
    const claims = [...left, ...right].filter((value) => value.batch.batchId === payload.batchId);
    expect(claims).toHaveLength(1);
    await releaseLiveDeliveryLease(env, payload.batchId, claims[0]!.leaseToken);
  });

  it("rate-limits connection churn by client key without affecting active sockets", async () => {
    const sockets: WebSocket[] = [];
    for (let index = 0; index < 20; index += 1) {
      const response = await SELF.fetch("https://snapmeter.test/api/v1/live", { headers: { Upgrade: "websocket", "cf-connecting-ip": "198.51.100.7" } });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept();
      await nextMessage(socket);
      sockets.push(socket);
    }
    const limited = await SELF.fetch("https://snapmeter.test/api/v1/live", { headers: { Upgrade: "websocket", "cf-connecting-ip": "198.51.100.7" } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    for (const socket of sockets) socket.close(1000, "done");
  });

  it("rejects saturated admission before invoking the D1 summary reader", async () => {
    const room = {
      fetch: vi.fn().mockResolvedValue(Response.json(
        { error: "connection_rate_limited" },
        { status: 429, headers: { "retry-after": "60" } }
      ))
    };
    const summaryReader = vi.fn(async () => { throw new Error("D1 must not be read"); });
    const response = await handleLive(
      new Request("https://snapmeter.test/api/v1/live", { headers: { Upgrade: "websocket", "cf-connecting-ip": "198.51.100.9" } }),
      { LIVE_ROOM: { getByName: () => room } } as unknown as Env,
      summaryReader
    );
    expect(response.status).toBe(429);
    expect(summaryReader).not.toHaveBeenCalled();
  });

  it("invalidates a one-time admission when private snapshot hydration fails", async () => {
    const room = env.LIVE_ROOM.getByName("global");
    const admitted = await room.fetch("https://live.internal/connect", {
      method: "POST",
      headers: { "x-snapmeter-internal": "1", "x-snapmeter-client-key": "203.0.113.99" }
    });
    expect(admitted.status).toBe(200);
    const token = (await admitted.json() as { token: string }).token;
    const hydrate = await room.fetch(`https://live.internal/hydrate?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-snapmeter-internal": "1" },
      body: JSON.stringify({ snapshot: { invalid: true } })
    });
    expect(hydrate.status).toBe(400);
    const upgrade = await room.fetch(`https://live.internal/upgrade?token=${encodeURIComponent(token)}`, {
      headers: { Upgrade: "websocket" }
    });
    expect(upgrade.status).toBe(403);
  });

  it("uses an hourly alarm to prune every page of expired live-room records", async () => {
    const room = env.LIVE_ROOM.getByName(`alarm-${crypto.randomUUID()}`);
    const now = Date.now();
    await runInDurableObject(room, async (_instance, state) => {
      const records: Record<string, { state: "delivered"; processingUntilMs: number; expiresAtMs: number }> = {};
      for (let index = 0; index < 225; index += 1) {
        records[`delivery:${String(index).padStart(4, "0")}`] = { state: "delivered", processingUntilMs: 0, expiresAtMs: now - 1 };
      }
      records["delivery:keep"] = { state: "delivered", processingUntilMs: 0, expiresAtMs: now + 60_000 };
      await state.storage.put(records);
    });
    expect(await runDurableObjectAlarm(room)).toBe(true);
    await runInDurableObject(room, async (_instance, state) => {
      const remaining = await state.storage.list({ prefix: "delivery:" });
      expect([...remaining.keys()]).toEqual(["delivery:keep"]);
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
    });
  });

  it("hydrates a new WebSocket with freshness-adjusted disconnected state", async () => {
    const now = Date.now();
    const snapchain = {
      ...emptySource("snapchain", now),
      status: "live" as const,
      quality: "high" as const,
      lastCollectorAtMs: now - 121_000,
      node: {
        ...emptySource("snapchain", now).node,
        shardCount: 1,
        coveredShards: 1,
        synchronized: true,
        reconciliationState: "ok" as const,
        historyCoverageStartMs: now - 31 * 86_400_000,
        historyComplete: true
      }
    };
    const payload = { ...batch(), snapshots: [snapchain] };
    expect((await SELF.fetch(await signedRequest(payload))).status).toBe(202);
    const upgrade = await SELF.fetch("https://snapmeter.test/api/v1/live", { headers: { Upgrade: "websocket" } });
    const socket = upgrade.webSocket!;
    socket.accept();
    expect(JSON.parse(await nextMessage(socket))).toMatchObject({ type: "snapshot", data: { sources: { snapchain: { status: "disconnected", quality: "unavailable" } } } });
    socket.close(1000, "done");
  });

  it("preserves partial quality while 30-day history is incomplete", async () => {
    const now = Date.now();
    const snapchain = {
      ...emptySource("snapchain", now),
      status: "partial" as const,
      quality: "degraded" as const,
      lastCollectorAtMs: now,
      node: {
        ...emptySource("snapchain", now).node,
        shardCount: 1,
        coveredShards: 1,
        synchronized: true,
        reconciliationState: "ok" as const,
        historyCoverageStartMs: now - 3 * 86_400_000,
        historyComplete: false
      }
    };
    const payload = { ...batch(), snapshots: [snapchain] };
    expect((await SELF.fetch(await signedRequest(payload))).status).toBe(202);
    const summary = await SELF.fetch("https://snapmeter.test/api/v1/summary");
    expect(await summary.json()).toMatchObject({ sources: { snapchain: { status: "partial", quality: "degraded", node: { historyComplete: false } } } });
  });
});
