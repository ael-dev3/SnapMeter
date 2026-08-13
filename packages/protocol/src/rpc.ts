import { credentials, loadPackageDefinition, Metadata, type ClientReadableStream, type ClientUnaryCall, type ServiceError } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { actionFamilyForMessage, isHyperEligible } from "./classifier";
import type { Source, SourceMode } from "@snapmeter/contracts";
import type { ActivityRecord } from "@snapmeter/metrics";

export const FARCASTER_EPOCH_MS = Date.UTC(2021, 0, 1);

export interface RpcConfig {
  url: string;
  tls: boolean;
  authorization?: string;
  apiKey?: string;
  timeoutMs?: number;
  getEventsMinIntervalMs?: number;
}

export interface ShardInfo {
  shardId: number;
  maxHeight: number;
  blockDelay: number;
  mempoolSize: number;
}

export interface NodeInfo {
  version: string;
  numShards: number;
  shardInfos: ShardInfo[];
}

export interface RawHubEvent {
  type?: number | string;
  id?: number | string;
  shardIndex?: number;
  timestamp?: number | string;
  blockNumber?: number | string;
  mergeMessageBody?: { message?: { data?: { type?: number | string; fid?: number | string; timestamp?: number | string } } };
  blockConfirmedBody?: Record<string, unknown>;
}

export interface ProtocolRpcSubscription {
  cancel(): void;
  ready: Promise<void>;
  done: Promise<void>;
}

interface DynamicHubClient {
  getInfo(request: object, metadata: Metadata, options: object, callback: (error: ServiceError | null, value: any) => void): ClientUnaryCall;
  getEvent(request: object, metadata: Metadata, options: object, callback: (error: ServiceError | null, value: RawHubEvent) => void): ClientUnaryCall;
  getEvents(request: object, metadata: Metadata, options: object, callback: (error: ServiceError | null, value: { events?: RawHubEvent[]; nextPageToken?: Buffer }) => void): ClientUnaryCall;
  subscribe(request: object, metadata: Metadata): ClientReadableStream<RawHubEvent>;
  close(): void;
}

type HubConstructor = new (
  address: string,
  channelCredentials: ReturnType<typeof credentials.createInsecure>,
  options?: { "grpc.max_receive_message_length"?: number }
) => DynamicHubClient;

const MAX_RECEIVE_MESSAGE_BYTES = 20 * 1024 * 1024;

let cachedConstructor: HubConstructor | null = null;

export function loadHubServiceConstructor(): HubConstructor {
  if (cachedConstructor) return cachedConstructor;
  const protoPath = fileURLToPath(new URL("../proto/snapchain-6152402.proto", import.meta.url));
  const definition = loadSync(protoPath, {
    defaults: true,
    enums: String,
    keepCase: false,
    longs: String,
    oneofs: true
  });
  const loaded = loadPackageDefinition(definition) as unknown as { HubService: HubConstructor };
  cachedConstructor = loaded.HubService;
  return cachedConstructor;
}

export class SnapchainRpcClient {
  readonly #client: DynamicHubClient;
  readonly #metadata: Metadata;
  readonly #timeoutMs: number;
  readonly #getEventsStartGate: MinimumIntervalGate;

  constructor(config: RpcConfig) {
    if (!config.url || config.url.includes("://")) throw new Error("gRPC URL must be host:port without a scheme");
    const Constructor = loadHubServiceConstructor();
    const channelCredentials = config.tls ? credentials.createSsl() : credentials.createInsecure();
    this.#client = new Constructor(config.url, channelCredentials as ReturnType<typeof credentials.createInsecure>, {
      "grpc.max_receive_message_length": MAX_RECEIVE_MESSAGE_BYTES
    });
    this.#timeoutMs = config.timeoutMs ?? 10_000;
    this.#metadata = createRpcMetadata(config);
    this.#getEventsStartGate = new MinimumIntervalGate(config.getEventsMinIntervalMs ?? 0);
  }

  async getInfo(signal?: AbortSignal): Promise<NodeInfo> {
    const response = await this.#unary<any>("getInfo", {}, signal);
    const shardInfos: ShardInfo[] = Array.isArray(response.shardInfos) ? response.shardInfos.map((shard: any) => ({
      shardId: Number(shard.shardId ?? 0),
      maxHeight: Number(shard.maxHeight ?? 0),
      blockDelay: Number(shard.blockDelay ?? 0),
      mempoolSize: Number(shard.mempoolSize ?? 0)
    })) : [];
    const declared = Number(response.numShards ?? 0);
    return { version: String(response.version ?? "unknown"), numShards: declared || shardInfos.filter((shard) => shard.shardId > 0).length, shardInfos };
  }

  async getEvent(shardIndex: number, id: string, signal?: AbortSignal): Promise<RawHubEvent> {
    return this.#unary<RawHubEvent>("getEvent", { shardIndex, id }, signal);
  }

  async getEvents(
    shardIndex: number,
    startId: string,
    pageToken?: Uint8Array,
    stopId?: string,
    signal?: AbortSignal
  ): Promise<{ events: RawHubEvent[]; nextPageToken?: Uint8Array }> {
    await this.#getEventsStartGate.waitForStart(signal);
    const response = await this.#unary<{ events?: RawHubEvent[]; nextPageToken?: Buffer }>("getEvents", {
      shardIndex,
      startId,
      stopId,
      pageSize: 500,
      pageToken: pageToken ? Buffer.from(pageToken) : undefined,
      reverse: false
    }, signal);
    return {
      events: response.events ?? [],
      nextPageToken: response.nextPageToken?.length ? new Uint8Array(response.nextPageToken) : undefined
    };
  }

  subscribe(
    shardIndex: number,
    fromId: string | undefined,
    onEvent: (event: RawHubEvent) => void,
    onError: (error: Error) => void
  ): ProtocolRpcSubscription {
    const stream = this.#client.subscribe(
      createSubscribeRequest(shardIndex, fromId),
      this.#metadata
    );
    return observeSubscriptionStream(stream, onEvent, onError);
  }

  close(): void {
    this.#client.close();
  }

  #unary<T>(method: "getInfo" | "getEvent" | "getEvents", request: object, signal?: AbortSignal): Promise<T> {
    return invokeUnaryWithAbort<T>((callback) => this.#client[method](
      request,
      this.#metadata,
      { deadline: Date.now() + this.#timeoutMs },
      (error: ServiceError | null, response: any) => callback(error, response as T)
    ), signal);
  }
}

export function invokeUnaryWithAbort<T>(
  start: (callback: (error: Error | null, response: T) => void) => ClientUnaryCall,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let call: ClientUnaryCall | undefined;
    let settled = false;
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const settle = (error: Error | null, response?: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(response as T);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      call?.cancel();
      reject(rpcAbortError());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      call = start((error, response) => settle(error, response));
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function rpcAbortError(message = "RPC request aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function observeSubscriptionStream(
  stream: ClientReadableStream<RawHubEvent>,
  onEvent: (event: RawHubEvent) => void,
  onError: (error: Error) => void
): ProtocolRpcSubscription {
    let settleDone: (() => void) | undefined;
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    let readySettled = false;
    let doneSettled = false;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const done = new Promise<void>((resolve) => { settleDone = resolve; });
    const markReady = (): void => {
      if (readySettled) return;
      readySettled = true;
      resolveReady?.();
    };
    const failBeforeReady = (error: Error): void => {
      if (readySettled) return;
      readySettled = true;
      rejectReady?.(error);
    };
    const finish = (): void => {
      if (doneSettled) return;
      doneSettled = true;
      settleDone?.();
    };
    stream.on("data", (event: RawHubEvent) => {
      // Snapchain sends response metadata before its spawned subscription task
      // installs the broadcast receiver. Incorporate the first data event
      // before declaring readiness so the subsequent fixed-bound replay sees it.
      onEvent(event);
      markReady();
    });
    stream.on("error", (error: Error) => {
      failBeforeReady(error);
      onError(error);
      finish();
    });
    stream.on("end", () => {
      failBeforeReady(new Error("subscription ended before becoming ready"));
      finish();
    });
    stream.on("close", () => {
      failBeforeReady(new Error("subscription closed before becoming ready"));
      finish();
    });
    return {
      cancel: () => {
        failBeforeReady(rpcAbortError("subscription cancelled"));
        finish();
        stream.cancel();
      },
      ready,
      done
    };
}

export interface SubscribeRequest {
  eventTypes: string[];
  shardIndex: number;
  fromId?: string;
}

export function createSubscribeRequest(shardIndex: number, fromId?: string): SubscribeRequest {
  const request: SubscribeRequest = {
    eventTypes: ["HUB_EVENT_TYPE_MERGE_MESSAGE", "HUB_EVENT_TYPE_BLOCK_CONFIRMED"],
    shardIndex
  };
  if (fromId !== undefined) request.fromId = fromId;
  return request;
}

type Delay = (milliseconds: number) => Promise<void>;

/**
 * Serializes only the start of calls. One instance is shared by every shard on
 * a client, while requests may overlap after their rate-limited start time.
 */
export class MinimumIntervalGate {
  readonly #minimumIntervalMs: number;
  readonly #now: () => number;
  readonly #delay: Delay;
  #nextStartAtMs = 0;
  #tail = Promise.resolve();

  constructor(
    minimumIntervalMs: number,
    options: { now?: () => number; delay?: Delay } = {}
  ) {
    if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 0) {
      throw new Error("minimum RPC start interval must be a nonnegative integer");
    }
    this.#minimumIntervalMs = minimumIntervalMs;
    this.#now = options.now ?? Date.now;
    this.#delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  waitForStart(signal?: AbortSignal): Promise<number> {
    const scheduled = this.#tail.then(async () => {
      throwIfRpcAborted(signal);
      const waitMs = Math.max(0, this.#nextStartAtMs - this.#now());
      if (waitMs > 0) {
        await waitForPromiseOrAbort(this.#delay(waitMs), signal, "RPC pacing aborted");
      }
      throwIfRpcAborted(signal);
      const startedAtMs = this.#now();
      this.#nextStartAtMs = startedAtMs + this.#minimumIntervalMs;
      return startedAtMs;
    });
    this.#tail = scheduled.then(() => undefined, () => undefined);
    return waitForPromiseOrAbort(scheduled, signal, "RPC pacing aborted");
  }
}

function throwIfRpcAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw rpcAbortError();
}

function waitForPromiseOrAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  message: string
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(rpcAbortError(message));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const settle = (continuation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      continuation();
    };
    const onAbort = (): void => settle(() => reject(rpcAbortError(message)));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
  });
}

export function createRpcMetadata(config: Pick<RpcConfig, "authorization" | "apiKey">): Metadata {
  const metadata = new Metadata();
  if (config.authorization) metadata.set("authorization", config.authorization);
  if (config.apiKey) metadata.set("x-api-key", config.apiKey);
  return metadata;
}

export function normalizeMergeEvent(
  event: RawHubEvent,
  source: Source,
  sourceMode: SourceMode,
  receivedAtMs: number,
  isReplay: boolean
): ActivityRecord | null {
  if (event.type !== 1 && event.type !== "1" && event.type !== "HUB_EVENT_TYPE_MERGE_MESSAGE") return null;
  const data = event.mergeMessageBody?.message?.data;
  if (!data) return null;
  const family = actionFamilyForMessage(data.type);
  if (!family) return null;
  if (source === "hypersnap" && sourceMode === "derived" && !isHyperEligible(data.type)) return null;
  const fid = String(data.fid ?? "0");
  if (!/^[1-9]\d*$/.test(fid)) return null;
  const eventTimestamp = Number(event.timestamp ?? 0);
  const messageTimestamp = Number(data.timestamp ?? 0);
  const farcasterSeconds = eventTimestamp > 0 ? eventTimestamp : messageTimestamp;
  if (!Number.isSafeInteger(farcasterSeconds) || farcasterSeconds <= 0) return null;
  const shard = Number(event.shardIndex ?? 0);
  const eventId = String(event.id ?? "0");
  if (!/^\d+$/.test(eventId) || eventId === "0") return null;
  return {
    eventKey: `${shard}:${eventId}`,
    source,
    sourceMode,
    fid,
    action: family,
    actionAtMs: FARCASTER_EPOCH_MS + farcasterSeconds * 1000,
    receivedAtMs,
    isReplay
  };
}
