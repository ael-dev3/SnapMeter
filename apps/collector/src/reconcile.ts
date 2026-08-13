import type { RawHubEvent } from "@snapmeter/protocol";
import { compareEventIds, maxEventId } from "./database.js";
import type { CollectorRpc } from "./rpc.js";
import { rawEventId } from "./rpc.js";

export interface ReconcileOptions {
  rpc: CollectorRpc;
  shard: number;
  startId: string;
  stopId?: string;
  pageSize?: number;
  maxPages?: number;
  onEvent(event: RawHubEvent): void;
}

export interface ReconcileResult {
  eventCount: number;
  pageCount: number;
  lastEventId: string;
  terminal: "null-sentinel" | "short-page" | "no-token" | "fixed-bound";
}

/**
 * Replays a forward range. When stopId is supplied it is immutable for the
 * complete scan, so a moving subscription head cannot turn reconciliation
 * into an endless chase. Cursors are intentionally not touched here.
 */
export async function reconcileEvents(options: ReconcileOptions): Promise<ReconcileResult> {
  const pageSize = options.pageSize ?? 500;
  const maxPages = options.maxPages ?? 100_000;
  let token: Uint8Array | undefined;
  let pageCount = 0;
  let eventCount = 0;
  let lastEventId = options.startId;
  const seenTokens = new Set<string>();

  while (pageCount < maxPages) {
    const response = await options.rpc.getEvents(options.shard, options.startId, token, options.stopId);
    pageCount += 1;
    const rawEvents = Array.isArray(response.events) ? response.events : [];
    if (rawEvents.length === 1 && rawEvents[0] === null) {
      return { eventCount, pageCount, lastEventId, terminal: "null-sentinel" };
    }

    for (const event of rawEvents) {
      if (!event) continue;
      const eventId = rawEventId(event);
      if (!eventId) continue;
      if (compareEventIds(eventId, options.startId) < 0) continue;
      // Upstream stop_id is exclusive.
      if (options.stopId && compareEventIds(eventId, options.stopId) >= 0) continue;
      options.onEvent(event);
      eventCount += 1;
      lastEventId = maxEventId(lastEventId, eventId);
    }

    if (options.stopId && compareEventIds(lastEventId, options.stopId) >= 0) {
      return { eventCount, pageCount, lastEventId, terminal: "fixed-bound" };
    }
    if (rawEvents.length < pageSize) {
      return { eventCount, pageCount, lastEventId, terminal: "short-page" };
    }
    if (!response.nextPageToken?.length) {
      return { eventCount, pageCount, lastEventId, terminal: "no-token" };
    }
    if (isTerminalPageToken(response.nextPageToken)) {
      return { eventCount, pageCount, lastEventId, terminal: "null-sentinel" };
    }
    const tokenKey = Buffer.from(response.nextPageToken).toString("base64");
    if (seenTokens.has(tokenKey)) throw new Error("GetEvents repeated a page token during reconciliation");
    seenTokens.add(tokenKey);
    token = response.nextPageToken;
  }
  throw new Error(`GetEvents exceeded the ${maxPages}-page reconciliation safety bound`);
}

export function isTerminalPageToken(token: Uint8Array): boolean {
  const text = new TextDecoder().decode(token).trim();
  if (text === "[null]") return true;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) && parsed.length === 1 && parsed[0] === null;
  } catch {
    return false;
  }
}

export function exponentialBackoffMs(
  attempt: number,
  options: { baseMs?: number; maximumMs?: number; jitter?: number; random?: () => number } = {}
): number {
  const baseMs = options.baseMs ?? 500;
  const maximumMs = options.maximumMs ?? 30_000;
  const jitter = options.jitter ?? 0.25;
  const random = options.random ?? Math.random;
  const capped = Math.min(maximumMs, baseMs * 2 ** Math.min(Math.max(0, attempt), 20));
  const factor = 1 - jitter + random() * jitter * 2;
  return Math.max(0, Math.round(capped * factor));
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
      resolve();
    }
    function onAbort(): void {
      done();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
