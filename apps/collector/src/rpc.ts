import { SnapchainRpcClient, type NodeInfo, type RawHubEvent, type RpcConfig } from "@snapmeter/protocol";

export interface RpcSubscription {
  cancel(): void;
  ready: Promise<void>;
  done: Promise<void>;
}

export interface CollectorRpc {
  getInfo(signal?: AbortSignal): Promise<NodeInfo>;
  getEvent(shardIndex: number, id: string, signal?: AbortSignal): Promise<RawHubEvent>;
  getEvents(
    shardIndex: number,
    startId: string,
    pageToken?: Uint8Array,
    stopId?: string,
    signal?: AbortSignal
  ): Promise<{ events: Array<RawHubEvent | null>; nextPageToken?: Uint8Array }>;
  subscribe(
    shardIndex: number,
    fromId: string | undefined,
    onEvent: (event: RawHubEvent) => void,
    onError: (error: Error) => void
  ): RpcSubscription;
  close(): void;
}

export type RpcFactory = (config: RpcConfig) => CollectorRpc;

export const defaultRpcFactory: RpcFactory = (config) => new ProtocolRpcAdapter(new SnapchainRpcClient(config));

class ProtocolRpcAdapter implements CollectorRpc {
  constructor(readonly client: SnapchainRpcClient) {}

  getInfo(signal?: AbortSignal): Promise<NodeInfo> {
    return this.client.getInfo(signal);
  }

  getEvent(shardIndex: number, id: string, signal?: AbortSignal): Promise<RawHubEvent> {
    return this.client.getEvent(shardIndex, id, signal);
  }

  async getEvents(
    shardIndex: number,
    startId: string,
    pageToken?: Uint8Array,
    stopId?: string,
    signal?: AbortSignal
  ): Promise<{ events: Array<RawHubEvent | null>; nextPageToken?: Uint8Array }> {
    return this.client.getEvents(shardIndex, startId, pageToken, stopId, signal);
  }

  subscribe(
    shardIndex: number,
    fromId: string | undefined,
    onEvent: (event: RawHubEvent) => void,
    onError: (error: Error) => void
  ): RpcSubscription {
    const subscription = this.client.subscribe(shardIndex, fromId, onEvent, onError);
    return { cancel: subscription.cancel, ready: subscription.ready, done: subscription.done };
  }

  close(): void {
    this.client.close();
  }
}

export function rawEventId(event: RawHubEvent): string | null {
  const value = String(event.id ?? "");
  return /^\d+$/.test(value) && value !== "0" ? value : null;
}

export function rawEventShard(event: RawHubEvent, fallback: number): number {
  if (!Number.isSafeInteger(fallback) || fallback <= 0) throw new Error("event shard fallback must be a positive data shard");
  const value = Number(event.shardIndex);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function rawEventType(event: RawHubEvent): string {
  return String(event.type ?? "unknown");
}
