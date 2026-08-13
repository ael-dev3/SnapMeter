import { MinimumIntervalGate, type NodeInfo, type RawHubEvent } from "@snapmeter/protocol";
import type { CollectorRpc, RpcSubscription } from "./rpc.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const EVENT_PAGE_SIZE = 500;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const MAX_UINT32 = 4_294_967_295;
const PAGE_TOKEN_PREFIX = "snapmeter:hypersnap-http:v1";
const FARCASTER_EPOCH_SECONDS = 1_609_459_200;
const MAX_FUTURE_SKEW_SECONDS = 300;
const MAX_BLOCK_TIMESTAMP_CACHE_ENTRIES = 4_096;

export type HypersnapHttpFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface HypersnapHttpRpcConfig {
  baseUrl: string | URL;
  expectedPeerId?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  minimumIntervalMs?: number;
  maxResponseBytes?: number;
  fetcher?: HypersnapHttpFetch;
}

interface JsonRecord {
  [key: string]: unknown;
}

/**
 * A read-only CollectorRpc adapter for Hypersnap's HTTPS JSON API.
 *
 * The API has no streaming route or event continuation token. Subscribe is
 * therefore simulated with an initial reverse head probe followed by bounded
 * forward polls, while continuation tokens encode the next exact uint64 ID.
 */
export class HypersnapHttpRpc implements CollectorRpc {
  readonly #baseUrl: URL;
  readonly #expectedPeerId?: string;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetcher: HypersnapHttpFetch;
  readonly #requestStartGate: MinimumIntervalGate;
  readonly #blockTimestamps = new Map<string, string>();
  readonly #closed = new AbortController();
  readonly #subscriptionCancels = new Set<() => void>();

  constructor(config: HypersnapHttpRpcConfig) {
    this.#baseUrl = validateBaseUrl(config.baseUrl);
    this.#expectedPeerId = optionalPeerId(config.expectedPeerId);
    this.#timeoutMs = boundedInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120_000, "timeoutMs");
    this.#pollIntervalMs = boundedInteger(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 1, 3_600_000, "pollIntervalMs");
    this.#maxResponseBytes = boundedInteger(
      config.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1,
      100 * 1024 * 1024,
      "maxResponseBytes"
    );
    this.#fetcher = config.fetcher ?? fetch;
    this.#requestStartGate = new MinimumIntervalGate(boundedInteger(
      config.minimumIntervalMs,
      0,
      0,
      3_600_000,
      "minimumIntervalMs"
    ));
  }

  async getInfo(signal?: AbortSignal): Promise<NodeInfo> {
    const body = record(await this.#requestJson("v1/info", {}, signal), "GetInfo response");
    const peerId = requiredString(body.peer_id, "GetInfo peer_id", 256);
    if (this.#expectedPeerId !== undefined && peerId !== this.#expectedPeerId) {
      throw new Error("Hypersnap HTTP endpoint peer_id did not match the pinned identity");
    }
    const shardValues = array(body.shardInfos, "GetInfo shardInfos", 1_024);
    return {
      version: requiredString(body.version, "GetInfo version", 256),
      peerId,
      numShards: safeInteger(body.numShards, "GetInfo numShards", 0, MAX_UINT32),
      shardInfos: shardValues.map((value, index) => {
        const shard = record(value, `GetInfo shardInfos[${index}]`);
        return {
          shardId: safeInteger(shard.shardId, `GetInfo shardInfos[${index}].shardId`, 0, MAX_UINT32),
          maxHeight: safeInteger(shard.maxHeight, `GetInfo shardInfos[${index}].maxHeight`, 0, Number.MAX_SAFE_INTEGER),
          blockDelay: safeInteger(shard.blockDelay, `GetInfo shardInfos[${index}].blockDelay`, 0, Number.MAX_SAFE_INTEGER),
          mempoolSize: safeInteger(shard.mempoolSize, `GetInfo shardInfos[${index}].mempoolSize`, 0, Number.MAX_SAFE_INTEGER)
        };
      })
    };
  }

  async getEvent(shardIndex: number, id: string, signal?: AbortSignal): Promise<RawHubEvent> {
    const shard = positiveShard(shardIndex);
    const eventId = uint64String(id, "event id", false);
    const value = await this.#requestJson("v1/eventById", {
      event_id: eventId,
      shard_index: String(shard)
    }, signal);
    const [event] = await this.#canonicalizeEventTimes([normalizeEvent(value, shard)], shard, signal);
    if (!event) throw new Error("eventById returned an empty response");
    if (String(event.id) !== eventId) throw new Error("eventById returned a different event id");
    return event;
  }

  async getEvents(
    shardIndex: number,
    startId: string,
    pageToken?: Uint8Array,
    stopId?: string,
    signal?: AbortSignal
  ): Promise<{ events: Array<RawHubEvent | null>; nextPageToken?: Uint8Array }> {
    const shard = positiveShard(shardIndex);
    const requestedStart = uint64String(startId, "start event id", true);
    const effectiveStart = pageToken === undefined
      ? requestedStart
      : decodePageToken(pageToken, shard);
    if (compareUint64(effectiveStart, requestedStart) < 0) {
      throw new Error("Hypersnap HTTP page token precedes the requested start id");
    }
    const exclusiveStop = stopId === undefined ? undefined : uint64String(stopId, "stop event id", true);
    if (exclusiveStop !== undefined && compareUint64(effectiveStart, exclusiveStop) >= 0) {
      return { events: [] };
    }

    const query: Record<string, string> = {
      from_event_id: effectiveStart,
      shard_index: String(shard),
      pageSize: String(EVENT_PAGE_SIZE),
      reverse: "false"
    };
    if (exclusiveStop !== undefined) query.stop_id = exclusiveStop;
    const events = await this.#eventsRequest(query, shard, EVENT_PAGE_SIZE, signal);
    validateForwardPage(events, effectiveStart, exclusiveStop);

    if (events.length < EVENT_PAGE_SIZE) return { events };
    const lastId = String(events.at(-1)?.id);
    if (lastId === String(MAX_UINT64)) return { events };
    const nextId = incrementUint64(lastId);
    if (exclusiveStop !== undefined && compareUint64(nextId, exclusiveStop) >= 0) return { events };
    return { events, nextPageToken: encodePageToken(shard, nextId) };
  }

  subscribe(
    shardIndex: number,
    fromId: string | undefined,
    onEvent: (event: RawHubEvent) => void,
    onError: (error: Error) => void
  ): RpcSubscription {
    this.#assertOpen();
    const shard = positiveShard(shardIndex);
    const requestedStart = fromId === undefined ? undefined : uint64String(fromId, "subscription from id", true);
    const controller = new AbortController();
    let cancelled = false;
    let finished = false;
    let readySettled = false;
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    let resolveDone: (() => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });

    const cancel = (): void => {
      if (finished) return;
      cancelled = true;
      controller.abort(abortError("Hypersnap HTTP subscription cancelled"));
      finish();
    };
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      this.#subscriptionCancels.delete(cancel);
      if (!readySettled) {
        readySettled = true;
        if (error !== undefined) rejectReady?.(error);
        else rejectReady?.(abortError("Hypersnap HTTP subscription ended before readiness"));
      }
      resolveDone?.();
      if (error !== undefined && !cancelled) {
        try {
          onError(error);
        } catch {
          // Observer failures must not leave the subscription lifecycle open.
        }
      }
    };
    this.#subscriptionCancels.add(cancel);

    void this.#pollSubscription(shard, requestedStart, controller.signal, (event) => {
      if (controller.signal.aborted) return;
      onEvent(event);
      if (!readySettled) {
        readySettled = true;
        resolveReady?.();
      }
    }).then(
      () => finish(),
      (error: unknown) => finish(asError(error))
    );

    return { cancel, ready, done };
  }

  close(): void {
    if (this.#closed.signal.aborted) return;
    this.#closed.abort(abortError("Hypersnap HTTP RPC client closed"));
    for (const cancel of [...this.#subscriptionCancels]) cancel();
    this.#subscriptionCancels.clear();
  }

  async #pollSubscription(
    shard: number,
    requestedStart: string | undefined,
    signal: AbortSignal,
    emit: (event: RawHubEvent) => void
  ): Promise<void> {
    let nextId: string | undefined;
    while (!signal.aborted) {
      const headEvents = await this.#eventsRequest({
        from_event_id: "0",
        shard_index: String(shard),
        pageSize: "1",
        reverse: "true"
      }, shard, 1, signal);
      if (headEvents.length === 0) {
        await abortableDelay(this.#pollIntervalMs, signal);
        continue;
      }

      const head = headEvents[0] as RawHubEvent;
      const headId = String(head.id);
      if (nextId === undefined) {
        emit(head);
        nextId = incrementUint64(headId);
        if (requestedStart !== undefined && compareUint64(requestedStart, nextId) > 0) nextId = requestedStart;
      } else if (compareUint64(headId, nextId) >= 0) {
        const stopId = incrementUint64(headId);
        let token: Uint8Array | undefined;
        let pages = 0;
        do {
          const page = await this.getEvents(shard, nextId, token, stopId, signal);
          pages += 1;
          if (pages > 100_000) throw new Error("Hypersnap HTTP subscription poll exceeded its page safety bound");
          for (const event of page.events) {
            if (event === null) continue;
            emit(event);
            nextId = incrementUint64(String(event.id));
          }
          token = page.nextPageToken;
        } while (token !== undefined && !signal.aborted);
      }
      await abortableDelay(this.#pollIntervalMs, signal);
    }
  }

  async #eventsRequest(
    query: Record<string, string>,
    shard: number,
    maximumEvents: number,
    signal?: AbortSignal
  ): Promise<RawHubEvent[]> {
    const body = record(await this.#requestJson("v1/events", query, signal), "events response");
    const events = array(body.events, "events response events", maximumEvents).map((value) => normalizeEvent(value, shard));
    return this.#canonicalizeEventTimes(events, shard, signal);
  }

  async #canonicalizeEventTimes(
    events: RawHubEvent[],
    shard: number,
    signal?: AbortSignal
  ): Promise<RawHubEvent[]> {
    for (const event of events) this.#rememberBlockTimestamp(event);
    for (const event of events) {
      if (isBlockConfirmation(event)) continue;
      const blockNumber = uint64String(event.blockNumber, "HubEvent blockNumber", true);
      const cacheKey = blockTimestampKey(shard, blockNumber);
      let timestamp = this.#blockTimestamps.get(cacheKey);
      if (timestamp === undefined) {
        const blockEventId = (BigInt(blockNumber) << 14n).toString();
        const value = await this.#requestJson("v1/eventById", {
          event_id: blockEventId,
          shard_index: String(shard)
        }, signal);
        const confirmation = normalizeEvent(value, shard);
        if (!isBlockConfirmation(confirmation)
          || String(confirmation.id) !== blockEventId
          || String(confirmation.blockNumber) !== blockNumber
          || confirmation.timestamp === undefined) {
          throw new Error("Hypersnap HTTP endpoint did not return the canonical block confirmation timestamp");
        }
        this.#rememberBlockTimestamp(confirmation);
        timestamp = this.#blockTimestamps.get(cacheKey);
      }
      if (timestamp === undefined) throw new Error("canonical block timestamp was unavailable");
      if (event.timestamp !== undefined
        && uint64String(event.timestamp, "HubEvent timestamp", true) !== timestamp) {
        throw new Error("HubEvent timestamp conflicted with its canonical block confirmation");
      }
      event.timestamp = timestamp;
    }
    return events;
  }

  #rememberBlockTimestamp(event: RawHubEvent): void {
    if (!isBlockConfirmation(event) || event.timestamp === undefined) return;
    const blockNumber = uint64String(event.blockNumber, "block confirmation number", true);
    const shard = positiveShard(Number(event.shardIndex));
    const cacheKey = blockTimestampKey(shard, blockNumber);
    const timestamp = uint64String(event.timestamp, "block confirmation timestamp", true);
    const known = this.#blockTimestamps.get(cacheKey);
    if (known !== undefined && known !== timestamp) {
      throw new Error("block confirmation timestamp conflicted with a previously observed value");
    }
    if (known === undefined) {
      this.#blockTimestamps.set(cacheKey, timestamp);
      if (this.#blockTimestamps.size > MAX_BLOCK_TIMESTAMP_CACHE_ENTRIES) {
        const oldest = this.#blockTimestamps.keys().next().value as string | undefined;
        if (oldest !== undefined) this.#blockTimestamps.delete(oldest);
      }
    }
  }

  async #requestJson(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    this.#assertOpen();
    if (signal?.aborted) throw abortError("Hypersnap HTTP request aborted");
    await this.#requestStartGate.waitForStart(signal);
    const url = new URL(path, this.#baseUrl);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const requestScope = requestAbortScope(signal, this.#closed.signal, this.#timeoutMs);
    try {
      const response = await this.#fetcher(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: requestScope.signal
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        throw new Error("Hypersnap HTTP response content-type was not application/json");
      }
      if (!response.ok) throw new Error(`Hypersnap HTTP request failed with status ${response.status}`);
      const text = await readBoundedUtf8(response, this.#maxResponseBytes, requestScope.signal);
      try {
        return JSON.parse(quoteUnsafeJsonIntegers(text)) as unknown;
      } catch (error) {
        throw new Error("Hypersnap HTTP response contained invalid JSON", { cause: error });
      }
    } catch (error) {
      if (requestScope.signal.aborted) throw abortReason(requestScope.signal.reason);
      throw error;
    } finally {
      requestScope.cleanup();
    }
  }

  #assertOpen(): void {
    if (this.#closed.signal.aborted) throw abortError("Hypersnap HTTP RPC client is closed");
  }
}

function validateBaseUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value.toString());
  } catch {
    throw new Error("Hypersnap HTTP base URL must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("Hypersnap HTTP base URL must use HTTPS");
  if (url.username || url.password) throw new Error("Hypersnap HTTP base URL must not contain credentials");
  if (url.search || url.hash) throw new Error("Hypersnap HTTP base URL must not contain a query or fragment");
  if (!url.hostname) throw new Error("Hypersnap HTTP base URL must contain a hostname");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function optionalPeerId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const result = value.trim();
  if (!result || result.length > 256 || /\s/.test(result) || hasControlCharacters(result)) {
    throw new Error("expectedPeerId must be a nonempty peer identifier without whitespace");
  }
  return result;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return result;
}

function positiveShard(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_UINT32) {
    throw new Error("shard index must be a positive uint32");
  }
  return value;
}

function uint64String(value: unknown, name: string, allowZero: boolean): string {
  const text = typeof value === "string"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be an exact decimal uint64 string`);
  let parsed: bigint;
  try {
    parsed = BigInt(text);
  } catch {
    throw new Error(`${name} must be an exact decimal uint64 string`);
  }
  if (parsed > MAX_UINT64 || (!allowZero && parsed === 0n)) throw new Error(`${name} is outside the supported uint64 range`);
  return parsed.toString();
}

function safeInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const text = typeof value === "string" && /^\d+$/.test(value) ? value : undefined;
  const result = text === undefined ? value : Number(text);
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return result;
}

function requiredString(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== "string" || !value || value.length > maximumLength || hasControlCharacters(value)) {
    throw new Error(`${name} must be a nonempty bounded string`);
  }
  return value;
}

function record(value: unknown, name: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonRecord;
}

function array(value: unknown, name: string, maximumLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) throw new Error(`${name} must be a bounded array`);
  return value;
}

function normalizeEvent(value: unknown, expectedShard: number): RawHubEvent {
  const source = record(value, "HubEvent");
  const id = uint64String(source.id, "HubEvent id", false);
  const shardIndex = safeInteger(source.shardIndex, "HubEvent shardIndex", 1, MAX_UINT32);
  if (shardIndex !== expectedShard) throw new Error("HubEvent shardIndex did not match the requested shard");
  const eventType = knownHubEventType(source.type);
  const normalized: JsonRecord = { ...source, type: eventType, id, shardIndex };
  const blockNumber = uint64String(source.blockNumber, "HubEvent blockNumber", true);
  if ((BigInt(id) >> 14n).toString() !== blockNumber) {
    throw new Error("HubEvent id did not encode its declared block number");
  }
  normalized.blockNumber = blockNumber;

  const mergeBody = optionalRecord(source.mergeMessageBody);
  const message = optionalRecord(mergeBody?.message);
  const data = optionalRecord(message?.data);
  const isMergeMessage = eventType === 1 || eventType === "HUB_EVENT_TYPE_MERGE_MESSAGE";
  if (isMergeMessage && data === undefined) throw new Error("merge HubEvent did not contain message data");
  if (data !== undefined) {
    const normalizedData: JsonRecord = { ...data };
    const messageType = knownMessageType(data.type);
    normalizedData.type = messageType;
    normalizedData.fid = uint64String(data.fid, "message fid", false);
    if (data.network !== 1 && data.network !== "1" && data.network !== "FARCASTER_NETWORK_MAINNET") {
      throw new Error("message network was not Farcaster mainnet");
    }
    normalizedData.network = "FARCASTER_NETWORK_MAINNET";
    const messageTimestamp = uint64String(data.timestamp, "message timestamp", true);
    validateFarcasterTimestamp(messageTimestamp, "message timestamp");
    normalizedData.timestamp = messageTimestamp;
    const hash = requiredString(message?.hash, "message hash", 42);
    if (!/^0x[0-9a-f]{40}$/i.test(hash)) throw new Error("message hash was not a 20-byte hex value");
    normalized.mergeMessageBody = { ...mergeBody, message: { ...message, hash: hash.toLowerCase(), data: normalizedData } };
  }

  const blockBody = optionalRecord(source.blockConfirmedBody);
  const hasBlockConfirmationType = eventType === 11 || eventType === "HUB_EVENT_TYPE_BLOCK_CONFIRMED";
  if (hasBlockConfirmationType && blockBody === undefined) throw new Error("block-confirmed HubEvent did not contain its body");
  if (blockBody !== undefined) {
    const normalizedBlock: JsonRecord = { ...blockBody };
    if (blockBody.blockNumber !== undefined) {
      normalizedBlock.blockNumber = uint64String(blockBody.blockNumber, "block number", true);
      if (normalizedBlock.blockNumber !== blockNumber) throw new Error("block confirmation number did not match its HubEvent");
    }
    if (blockBody.shardIndex !== undefined && safeInteger(blockBody.shardIndex, "block shardIndex", 1, MAX_UINT32) !== expectedShard) {
      throw new Error("block confirmation shard did not match its HubEvent");
    }
    if (blockBody.timestamp !== undefined) {
      const blockTimestamp = uint64String(blockBody.timestamp, "block timestamp", true);
      validateFarcasterTimestamp(blockTimestamp, "block timestamp");
      normalizedBlock.timestamp = blockTimestamp;
      normalized.timestamp = blockTimestamp;
    }
    if (blockBody.totalEvents !== undefined) normalizedBlock.totalEvents = uint64String(blockBody.totalEvents, "block totalEvents", true);
    normalized.blockConfirmedBody = normalizedBlock;
  }

  if (source.timestamp !== undefined) {
    const eventTimestamp = uint64String(source.timestamp, "HubEvent timestamp", true);
    validateFarcasterTimestamp(eventTimestamp, "HubEvent timestamp");
    if (isBlockConfirmation(normalized as RawHubEvent)
      && normalized.timestamp !== undefined
      && String(normalized.timestamp) !== eventTimestamp) {
      throw new Error("block-confirmed HubEvent timestamp conflicted with its body timestamp");
    }
    normalized.timestamp = eventTimestamp;
  }
  return normalized as RawHubEvent;
}

function isBlockConfirmation(event: RawHubEvent): boolean {
  return event.type === 11 || event.type === "11" || event.type === "HUB_EVENT_TYPE_BLOCK_CONFIRMED";
}

function blockTimestampKey(shard: number, blockNumber: string): string {
  return `${shard}:${blockNumber}`;
}

function knownHubEventType(value: unknown): number | string {
  const knownNames = new Set([
    "HUB_EVENT_TYPE_NONE",
    "HUB_EVENT_TYPE_MERGE_MESSAGE",
    "HUB_EVENT_TYPE_PRUNE_MESSAGE",
    "HUB_EVENT_TYPE_REVOKE_MESSAGE",
    "HUB_EVENT_TYPE_MERGE_USERNAME_PROOF",
    "HUB_EVENT_TYPE_MERGE_ON_CHAIN_EVENT",
    "HUB_EVENT_TYPE_MERGE_FAILURE",
    "HUB_EVENT_TYPE_BLOCK_CONFIRMED",
    "HUB_EVENT_TYPE_CHANNEL_OWNER_CHANGE_HINT"
  ]);
  if (typeof value === "string" && knownNames.has(value)) return value;
  const numeric = typeof value === "number" && Number.isInteger(value)
    ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : -1;
  if ([0, 1, 2, 3, 6, 9, 10, 11, 12].includes(numeric)) return numeric;
  throw new Error("HubEvent type was not in the reviewed enum set");
}

function knownMessageType(value: unknown): number | string {
  const knownNames = new Set([
    "MESSAGE_TYPE_NONE",
    "MESSAGE_TYPE_CAST_ADD",
    "MESSAGE_TYPE_CAST_REMOVE",
    "MESSAGE_TYPE_REACTION_ADD",
    "MESSAGE_TYPE_REACTION_REMOVE",
    "MESSAGE_TYPE_LINK_ADD",
    "MESSAGE_TYPE_LINK_REMOVE",
    "MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS",
    "MESSAGE_TYPE_VERIFICATION_REMOVE",
    "MESSAGE_TYPE_USER_DATA_ADD",
    "MESSAGE_TYPE_USERNAME_PROOF",
    "MESSAGE_TYPE_FRAME_ACTION",
    "MESSAGE_TYPE_LINK_COMPACT_STATE",
    "MESSAGE_TYPE_LEND_STORAGE",
    "MESSAGE_TYPE_KEY_ADD",
    "MESSAGE_TYPE_KEY_REMOVE",
    "MESSAGE_TYPE_CHANNEL_UPDATE",
    "MESSAGE_TYPE_CHANNEL_MEMBER",
    "MESSAGE_TYPE_CHANNEL_PIN",
    "MESSAGE_TYPE_CHANNEL_MODERATE"
  ]);
  if (typeof value === "string" && knownNames.has(value)) return value;
  const numeric = typeof value === "number" && Number.isInteger(value)
    ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : -1;
  if ((numeric >= 0 && numeric <= 8) || (numeric >= 11 && numeric <= 21)) return numeric;
  throw new Error("message type was not in the reviewed enum set");
}

function validateFarcasterTimestamp(value: string, name: string): void {
  const seconds = BigInt(value);
  const maximum = BigInt(Math.floor(Date.now() / 1_000) - FARCASTER_EPOCH_SECONDS + MAX_FUTURE_SKEW_SECONDS);
  if (seconds <= 0n || seconds > maximum) throw new Error(`${name} was outside the accepted canonical time range`);
}

function optionalRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function validateForwardPage(events: readonly RawHubEvent[], startId: string, stopId: string | undefined): void {
  let previous: string | undefined;
  for (const event of events) {
    const id = String(event.id);
    if (compareUint64(id, startId) < 0) throw new Error("Hypersnap HTTP forward page preceded its requested start id");
    if (stopId !== undefined && compareUint64(id, stopId) >= 0) throw new Error("Hypersnap HTTP forward page crossed its exclusive stop id");
    if (previous !== undefined && compareUint64(id, previous) <= 0) throw new Error("Hypersnap HTTP forward page was not strictly ordered");
    previous = id;
  }
}

function compareUint64(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function incrementUint64(value: string): string {
  const next = BigInt(uint64String(value, "event id", true)) + 1n;
  if (next > MAX_UINT64) throw new Error("event id reached the uint64 maximum");
  return next.toString();
}

function encodePageToken(shard: number, nextId: string): Uint8Array {
  return new TextEncoder().encode(`${PAGE_TOKEN_PREFIX}:${shard}:${nextId}`);
}

function decodePageToken(token: Uint8Array, expectedShard: number): string {
  if (token.length === 0 || token.length > 128) throw new Error("invalid Hypersnap HTTP page token");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(token);
  } catch {
    throw new Error("invalid Hypersnap HTTP page token");
  }
  const match = /^snapmeter:hypersnap-http:v1:(\d+):(\d+)$/.exec(text);
  if (match === null || Number(match[1]) !== expectedShard) throw new Error("invalid Hypersnap HTTP page token");
  return uint64String(match[2], "page token event id", true);
}

async function readBoundedUtf8(response: Response, maximumBytes: number, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maximumBytes)) {
      throw new Error("Hypersnap HTTP response exceeded the body-size limit");
    }
  }
  if (response.body === null) throw new Error("Hypersnap HTTP response body was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortReason(signal.reason);
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) throw new Error("Hypersnap HTTP response exceeded the body-size limit");
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Hypersnap HTTP response was not valid UTF-8", { cause: error });
  }
}

/** Quote only unsafe integer tokens before JSON.parse so uint64 values remain exact. */
function quoteUnsafeJsonIntegers(json: string): string {
  let output = "";
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < json.length) {
    const character = json[index] as string;
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      index += 1;
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === "-" || /\d/.test(character)) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(json.slice(index));
      if (match !== null) {
        const token = match[0];
        if (!/[.eE]/.test(token) && unsafeIntegerToken(token)) output += JSON.stringify(token);
        else output += token;
        index += token.length;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

function unsafeIntegerToken(token: string): boolean {
  const digits = token.startsWith("-") ? token.slice(1) : token;
  if (digits.length > 16) return true;
  return BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(token) < BigInt(Number.MIN_SAFE_INTEGER);
}

interface AbortScope {
  signal: AbortSignal;
  cleanup(): void;
}

function requestAbortScope(caller: AbortSignal | undefined, closed: AbortSignal, timeoutMs: number): AbortScope {
  const controller = new AbortController();
  const signals = caller === undefined ? [closed] : [caller, closed];
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const relay = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason ?? abortError("Hypersnap HTTP request aborted"));
  };
  for (const source of signals) {
    if (source.aborted) relay(source);
    else {
      const listener = (): void => relay(source);
      source.addEventListener("abort", listener, { once: true });
      listeners.push({ signal: source, listener });
    }
  }
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    const error = new Error(`Hypersnap HTTP request timed out after ${timeoutMs}ms`);
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      for (const entry of listeners) entry.signal.removeEventListener("abort", entry.listener);
    }
  };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    const onAbort = (): void => finish();
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function abortReason(reason: unknown): Error {
  return reason instanceof Error ? reason : abortError("Hypersnap HTTP request aborted");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
