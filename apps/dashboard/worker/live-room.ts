import { DurableObject } from "cloudflare:workers";
import {
  HealthUpdateSchema,
  LiveEnvelopeSchema,
  PulsePacketSchema,
  SummarySchema,
  type HealthUpdate,
  type LiveEnvelope,
  type PulsePacket,
  type Summary
} from "@snapmeter/contracts";
import { emptySummary } from "./defaults";
import type { Env } from "./types";

interface PendingPulse {
  packet: PulsePacket;
  deliveryIds: string[];
  timeout: ReturnType<typeof setTimeout>;
  waiters: Array<{ resolve: () => void; reject: (reason: unknown) => void }>;
}

interface Admission {
  snapshot?: Summary;
  expiresAtMs: number;
}

interface RateWindow {
  count: number;
  expiresAtMs: number;
}

interface DeliveryRecord {
  state: "processing" | "delivered";
  processingUntilMs: number;
  expiresAtMs: number;
}

const DELIVERY_PREFIX = "delivery:";
const ADMISSION_PREFIX = "admission:";
const RATE_PREFIX = "connect-rate:";
const DELIVERY_TTL_MS = 36 * 60 * 60_000;
const DELIVERY_PROCESSING_LEASE_MS = 10_000;
const ADMISSION_TTL_MS = 10_000;
const CONNECT_WINDOW_MS = 60_000;
const CONNECT_LIMIT_PER_KEY = 20;
const CONNECT_LIMIT_ROOM = 240;
const MAX_OPEN_SOCKETS = 1_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const PRUNE_PAGE_SIZE = 100;

export class LiveRoom extends DurableObject<Env> {
  #sequence = 0;
  #snapshot: Summary = emptySummary();
  #pending = new Map<PulsePacket["source"], PendingPulse>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<{ sequence: number; snapshot: Summary }>("state");
      if (stored) {
        this.#sequence = stored.sequence;
        const parsed = SummarySchema.safeParse(stored.snapshot);
        if (parsed.success) this.#snapshot = parsed.data;
      }
      await this.#ensureAlarm();
    });
  }

  override async alarm(): Promise<void> {
    try { await this.#prune(Date.now()); }
    finally { await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS); }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/connect")) return this.#admit(request);
    if (request.method === "POST" && url.pathname.endsWith("/hydrate")) return this.#hydrate(request, url);
    if (request.method === "POST" && url.pathname.endsWith("/invalidate")) return this.#invalidate(request, url);
    if (request.method === "GET" && url.pathname.endsWith("/upgrade")) return this.#upgrade(request, url);
    if (request.method === "POST" && url.pathname.endsWith("/publish")) return this.#publish(request);
    return new Response("Not found", { status: 404 });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string" && message === "ping") socket.send("pong");
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  override webSocketError(socket: WebSocket): void {
    try { socket.close(1011, "WebSocket error"); } catch { /* socket may already be closed */ }
  }

  async #admit(request: Request): Promise<Response> {
    if (request.headers.get("x-snapmeter-internal") !== "1") return new Response("Forbidden", { status: 403 });
    if (this.ctx.getWebSockets("public").length >= MAX_OPEN_SOCKETS) {
      return Response.json({ error: "room_capacity" }, { status: 503, headers: { "retry-after": "30" } });
    }
    const clientKey = (request.headers.get("x-snapmeter-client-key") ?? "unknown").slice(0, 64);
    if (!(await this.#allowConnection(clientKey))) {
      return Response.json({ error: "connection_rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
    }
    const token = crypto.randomUUID();
    const admission: Admission = { expiresAtMs: Date.now() + ADMISSION_TTL_MS };
    await this.ctx.storage.put(`${ADMISSION_PREFIX}${token}`, admission);
    return Response.json({ token });
  }

  async #hydrate(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("x-snapmeter-internal") !== "1") return new Response("Forbidden", { status: 403 });
    const token = url.searchParams.get("token") ?? "";
    const key = `${ADMISSION_PREFIX}${token}`;
    if (!/^[0-9a-f-]{36}$/i.test(token)) return new Response("Invalid admission", { status: 403 });
    const admission = await this.ctx.storage.get<Admission>(key);
    if (!admission || admission.expiresAtMs < Date.now()) {
      if (admission) await this.ctx.storage.delete(key);
      return new Response("Expired admission", { status: 403 });
    }
    let raw: unknown;
    try { raw = await request.json(); }
    catch {
      await this.ctx.storage.delete(key);
      return Response.json({ error: "invalid_snapshot" }, { status: 400 });
    }
    const parsed = SummarySchema.safeParse((raw as { snapshot?: unknown }).snapshot);
    if (!parsed.success) {
      await this.ctx.storage.delete(key);
      return Response.json({ error: "invalid_snapshot" }, { status: 400 });
    }
    await this.ctx.storage.put(key, { ...admission, snapshot: parsed.data } satisfies Admission);
    return Response.json({ ok: true });
  }

  async #invalidate(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("x-snapmeter-internal") !== "1") return new Response("Forbidden", { status: 403 });
    const token = url.searchParams.get("token") ?? "";
    if (/^[0-9a-f-]{36}$/i.test(token)) await this.ctx.storage.delete(`${ADMISSION_PREFIX}${token}`);
    return Response.json({ ok: true });
  }

  async #upgrade(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const token = url.searchParams.get("token") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(token)) return new Response("Invalid admission", { status: 403 });
    const key = `${ADMISSION_PREFIX}${token}`;
    const admission = await this.ctx.storage.get<Admission>(key);
    if (!admission || !admission.snapshot || admission.expiresAtMs < Date.now()) {
      if (admission) await this.ctx.storage.delete(key);
      return new Response("Expired admission", { status: 403 });
    }
    await this.ctx.storage.delete(key);

    const envelope = LiveEnvelopeSchema.parse({
      type: "snapshot",
      schemaVersion: 1,
      sequence: this.#sequence,
      data: admission.snapshot
    });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, ["public"]);
    server.serializeAttachment({ connectedAtMs: Date.now(), lastSequence: envelope.sequence });
    server.send(JSON.stringify(envelope));
    return new Response(null, { status: 101, webSocket: client });
  }

  async #publish(request: Request): Promise<Response> {
    if (request.headers.get("x-snapmeter-internal") !== "1") return new Response("Forbidden", { status: 403 });
    const raw = await request.json() as { kind?: unknown; deliveryId?: unknown; data?: unknown };
    if (!validDeliveryId(raw.deliveryId)) return Response.json({ error: "invalid_delivery_id" }, { status: 400 });
    if (raw.kind === "snapshot") {
      const parsed = SummarySchema.safeParse(raw.data);
      if (!parsed.success) return Response.json({ error: "invalid_snapshot" }, { status: 400 });
      const deliveryId = raw.deliveryId;
      const claim = await this.#claimDelivery(deliveryId);
      if (claim === "duplicate") return Response.json({ ok: true, duplicate: true });
      if (claim === "busy") return Response.json({ error: "delivery_in_progress" }, { status: 503, headers: { "retry-after": "1" } });
      this.#snapshot = parsed.data;
      const envelope = this.#envelope("snapshot", this.#snapshot, deliveryId);
      await this.#persist();
      this.#broadcast(envelope);
      await this.#completeDelivery(deliveryId);
      return Response.json({ ok: true, duplicate: false });
    }
    if (raw.kind === "pulse") {
      const parsed = PulsePacketSchema.safeParse(raw.data);
      if (!parsed.success) return Response.json({ error: "invalid_pulse" }, { status: 400 });
      const deliveryId = raw.deliveryId;
      const claim = await this.#claimDelivery(deliveryId);
      if (claim === "duplicate") return Response.json({ ok: true, duplicate: true });
      if (claim === "busy") return Response.json({ error: "delivery_in_progress" }, { status: 503, headers: { "retry-after": "1" } });
      await this.#coalesce(parsed.data, deliveryId);
      await this.#completeDelivery(deliveryId);
      return Response.json({ ok: true, duplicate: false });
    }
    if (raw.kind === "status") {
      const parsed = HealthUpdateSchema.safeParse(raw.data);
      if (!parsed.success) return Response.json({ error: "invalid_status" }, { status: 400 });
      const deliveryId = raw.deliveryId;
      const claim = await this.#claimDelivery(deliveryId);
      if (claim === "duplicate") return Response.json({ ok: true, duplicate: true });
      if (claim === "busy") return Response.json({ error: "delivery_in_progress" }, { status: 503, headers: { "retry-after": "1" } });
      const envelope = this.#envelope("status", parsed.data, deliveryId);
      await this.#persist();
      this.#broadcast(envelope);
      await this.#completeDelivery(deliveryId);
      return Response.json({ ok: true, duplicate: false });
    }
    return Response.json({ error: "invalid_kind" }, { status: 400 });
  }

  #coalesce(packet: PulsePacket, deliveryId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const existing = this.#pending.get(packet.source);
      if (existing) {
        existing.packet = {
          ...packet,
          windowStartMs: Math.min(existing.packet.windowStartMs, packet.windowStartMs),
          eventCount: existing.packet.eventCount + packet.eventCount,
          uniqueFids: Math.max(existing.packet.uniqueFids, packet.uniqueFids),
          actionCounts: mergeCounts(existing.packet.actionCounts, packet.actionCounts),
          lastActionAtMs: Math.max(existing.packet.lastActionAtMs, packet.lastActionAtMs)
        };
        existing.deliveryIds.push(deliveryId);
        existing.waiters.push({ resolve, reject });
        return;
      }
      const pending: PendingPulse = {
        packet,
        deliveryIds: [deliveryId],
        waiters: [{ resolve, reject }],
        timeout: setTimeout(() => {
          const ready = this.#pending.get(packet.source);
          if (!ready) return;
          this.#pending.delete(packet.source);
          void (async () => {
            try {
              const envelope = this.#envelope("pulse", ready.packet, ready.deliveryIds[0]!, ready.deliveryIds);
              await this.#persist();
              this.#broadcast(envelope);
              for (const waiter of ready.waiters) waiter.resolve();
            } catch (error) {
              for (const waiter of ready.waiters) waiter.reject(error);
            }
          })();
        }, 250)
      };
      this.#pending.set(packet.source, pending);
    });
  }

  async #allowConnection(clientKey: string): Promise<boolean> {
    const now = Date.now();
    const allowed = await this.ctx.storage.transaction(async (txn) => {
      const clientStorageKey = `${RATE_PREFIX}client:${clientKey}`;
      const roomStorageKey = `${RATE_PREFIX}room`;
      const client = await txn.get<RateWindow>(clientStorageKey);
      const room = await txn.get<RateWindow>(roomStorageKey);
      const currentClient = client && client.expiresAtMs > now ? client : { count: 0, expiresAtMs: now + CONNECT_WINDOW_MS };
      const currentRoom = room && room.expiresAtMs > now ? room : { count: 0, expiresAtMs: now + CONNECT_WINDOW_MS };
      if (currentClient.count >= CONNECT_LIMIT_PER_KEY || currentRoom.count >= CONNECT_LIMIT_ROOM) return false;
      await txn.put({
        [clientStorageKey]: { ...currentClient, count: currentClient.count + 1 },
        [roomStorageKey]: { ...currentRoom, count: currentRoom.count + 1 }
      });
      return true;
    });
    return allowed;
  }

  async #claimDelivery(deliveryId: string): Promise<"accepted" | "duplicate" | "busy"> {
    const key = `${DELIVERY_PREFIX}${deliveryId}`;
    const now = Date.now();
    return this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<DeliveryRecord>(key);
      if (record && record.expiresAtMs > now) {
        if (record.state === "delivered") return "duplicate";
        if (record.processingUntilMs > now) return "busy";
      }
      await txn.put(key, {
        state: "processing",
        processingUntilMs: now + DELIVERY_PROCESSING_LEASE_MS,
        expiresAtMs: now + DELIVERY_TTL_MS
      } satisfies DeliveryRecord);
      return "accepted";
    });
  }

  async #completeDelivery(deliveryId: string): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.put(`${DELIVERY_PREFIX}${deliveryId}`, {
      state: "delivered",
      processingUntilMs: 0,
      expiresAtMs: now + DELIVERY_TTL_MS
    } satisfies DeliveryRecord);
  }

  async #prune(nowMs: number): Promise<void> {
    for (const prefix of [DELIVERY_PREFIX, ADMISSION_PREFIX, RATE_PREFIX]) {
      let startAfter: string | undefined;
      do {
        const rows = await this.ctx.storage.list<Admission | RateWindow | DeliveryRecord>({ prefix, limit: PRUNE_PAGE_SIZE, startAfter });
        if (rows.size === 0) break;
        const entries = [...rows];
        const expired = entries.filter(([, value]) => value.expiresAtMs <= nowMs).map(([key]) => key);
        if (expired.length > 0) await this.ctx.storage.delete(expired);
        startAfter = entries.at(-1)?.[0];
        if (entries.length < PRUNE_PAGE_SIZE) break;
      } while (startAfter !== undefined);
    }
  }

  async #ensureAlarm(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
  }

  #envelope(type: "snapshot", data: Summary, deliveryId?: string): LiveEnvelope;
  #envelope(type: "pulse", data: PulsePacket, deliveryId: string, deliveryIds?: string[]): LiveEnvelope;
  #envelope(type: "status", data: HealthUpdate, deliveryId: string): LiveEnvelope;
  #envelope(type: "snapshot" | "pulse" | "status", data: Summary | PulsePacket | HealthUpdate, deliveryId?: string, deliveryIds?: string[]): LiveEnvelope {
    this.#sequence = Math.max(this.#sequence + 1, Date.now() * 1000);
    return LiveEnvelopeSchema.parse({ type, schemaVersion: 1, sequence: this.#sequence, deliveryId, deliveryIds, data });
  }

  #broadcast(envelope: LiveEnvelope): void {
    const serialized = JSON.stringify(envelope);
    for (const socket of this.ctx.getWebSockets("public")) {
      try {
        socket.send(serialized);
        const attachment = socket.deserializeAttachment() as { connectedAtMs?: number } | null;
        socket.serializeAttachment({ connectedAtMs: attachment?.connectedAtMs ?? Date.now(), lastSequence: envelope.sequence });
      } catch { /* disconnected sockets are removed by the runtime */ }
    }
  }

  async #persist(): Promise<void> {
    await this.ctx.storage.put("state", { sequence: this.#sequence, snapshot: this.#snapshot });
  }
}

function validDeliveryId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}:(?:pulse|status|snapshot):\d+$/i.test(value);
}

function mergeCounts(left: PulsePacket["actionCounts"], right: PulsePacket["actionCounts"]): PulsePacket["actionCounts"] {
  const merged = { ...left };
  for (const [family, count] of Object.entries(right)) {
    const key = family as keyof typeof merged;
    merged[key] = (merged[key] ?? 0) + count;
  }
  return merged;
}
