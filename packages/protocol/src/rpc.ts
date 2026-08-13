import { credentials, loadPackageDefinition, Metadata, type ClientReadableStream, type ServiceError } from "@grpc/grpc-js";
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
  timeoutMs?: number;
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

interface DynamicHubClient {
  getInfo(request: object, metadata: Metadata, options: object, callback: (error: ServiceError | null, value: any) => void): void;
  getEvent(request: object, metadata: Metadata, options: object, callback: (error: ServiceError | null, value: RawHubEvent) => void): void;
  getEvents(request: object, metadata: Metadata, options: object, callback: (error: ServiceError | null, value: { events?: RawHubEvent[]; nextPageToken?: Buffer }) => void): void;
  subscribe(request: object, metadata: Metadata): ClientReadableStream<RawHubEvent>;
  close(): void;
}

type HubConstructor = new (address: string, channelCredentials: ReturnType<typeof credentials.createInsecure>) => DynamicHubClient;

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
  readonly #metadata = new Metadata();
  readonly #timeoutMs: number;

  constructor(config: RpcConfig) {
    if (!config.url || config.url.includes("://")) throw new Error("gRPC URL must be host:port without a scheme");
    const Constructor = loadHubServiceConstructor();
    const channelCredentials = config.tls ? credentials.createSsl() : credentials.createInsecure();
    this.#client = new Constructor(config.url, channelCredentials as ReturnType<typeof credentials.createInsecure>);
    this.#timeoutMs = config.timeoutMs ?? 10_000;
    if (config.authorization) this.#metadata.set("authorization", config.authorization);
  }

  async getInfo(): Promise<NodeInfo> {
    const response = await this.#unary<any>("getInfo", {});
    const shardInfos: ShardInfo[] = Array.isArray(response.shardInfos) ? response.shardInfos.map((shard: any) => ({
      shardId: Number(shard.shardId ?? 0),
      maxHeight: Number(shard.maxHeight ?? 0),
      blockDelay: Number(shard.blockDelay ?? 0),
      mempoolSize: Number(shard.mempoolSize ?? 0)
    })) : [];
    const declared = Number(response.numShards ?? 0);
    return { version: String(response.version ?? "unknown"), numShards: declared || shardInfos.filter((shard) => shard.shardId > 0).length, shardInfos };
  }

  async getEvent(shardIndex: number, id: string): Promise<RawHubEvent> {
    return this.#unary<RawHubEvent>("getEvent", { shardIndex, id });
  }

  async getEvents(shardIndex: number, startId: string, pageToken?: Uint8Array, stopId?: string): Promise<{ events: RawHubEvent[]; nextPageToken?: Uint8Array }> {
    const response = await this.#unary<{ events?: RawHubEvent[]; nextPageToken?: Buffer }>("getEvents", {
      shardIndex,
      startId,
      stopId,
      pageSize: 500,
      pageToken: pageToken ? Buffer.from(pageToken) : undefined,
      reverse: false
    });
    return {
      events: response.events ?? [],
      nextPageToken: response.nextPageToken?.length ? new Uint8Array(response.nextPageToken) : undefined
    };
  }

  subscribe(shardIndex: number, fromId: string, onEvent: (event: RawHubEvent) => void, onError: (error: Error) => void): { cancel: () => void; done: Promise<void> } {
    const stream = this.#client.subscribe(
      { eventTypes: ["HUB_EVENT_TYPE_MERGE_MESSAGE", "HUB_EVENT_TYPE_BLOCK_CONFIRMED"], fromId, shardIndex },
      this.#metadata
    );
    let settle: (() => void) | undefined;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    stream.on("data", onEvent);
    stream.on("error", (error: Error) => { onError(error); settle?.(); });
    stream.on("end", () => settle?.());
    stream.on("close", () => settle?.());
    return { cancel: () => stream.cancel(), done };
  }

  close(): void {
    this.#client.close();
  }

  #unary<T>(method: "getInfo" | "getEvent" | "getEvents", request: object): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#client[method](request, this.#metadata, { deadline: Date.now() + this.#timeoutMs }, (error: ServiceError | null, response: any) => {
        if (error) reject(error);
        else resolve(response as T);
      });
    });
  }
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
