import { describe, expect, it, vi } from "vitest";
import type { IngestBatch } from "@snapmeter/contracts";
import { FARCASTER_EPOCH_MS, type NodeInfo, type RawHubEvent } from "@snapmeter/protocol";
import { CollectorRuntime, discoveredShardIds } from "./collector.js";
import { loadConfig } from "./config.js";
import { CollectorDatabase } from "./database.js";
import { createLogger } from "./logger.js";
import { rawEventShard, type CollectorRpc, type RpcFactory, type RpcSubscription } from "./rpc.js";

function mergeEvent(id: string, fid: string): RawHubEvent {
  const seconds = Math.floor((Date.now() - FARCASTER_EPOCH_MS) / 1_000);
  return {
    id,
    shardIndex: 7,
    type: "HUB_EVENT_TYPE_MERGE_MESSAGE",
    timestamp: seconds,
    mergeMessageBody: { message: { data: { type: "MESSAGE_TYPE_CAST_ADD", fid, timestamp: seconds } } }
  };
}

class FakeRpc implements CollectorRpc {
  readonly info: NodeInfo = {
    version: "fake-snapchain/1",
    numShards: 99,
    shardInfos: [{ shardId: 7, maxHeight: 100, blockDelay: 0, mempoolSize: 0xffff_ffff }]
  };
  readonly subscriptions: Array<{ emit(event: RawHubEvent): void; end(): void }> = [];
  subscribeCalls = 0;
  getEventsCalls: Array<{ shard: number; startId: string; stopId?: string }> = [];

  async getInfo(): Promise<NodeInfo> {
    return this.info;
  }

  async getEvent(): Promise<RawHubEvent> {
    return mergeEvent("1", "1");
  }

  async getEvents(shard: number, startId: string, _token?: Uint8Array, stopId?: string) {
    this.getEventsCalls.push({ shard, startId, stopId });
    return { events: [mergeEvent("1", "1"), mergeEvent("2", "2"), ...(stopId ? [mergeEvent(stopId, "3")] : [])] };
  }

  subscribe(_shard: number, _fromId: string, onEvent: (event: RawHubEvent) => void, _onError: (error: Error) => void): RpcSubscription {
    this.subscribeCalls += 1;
    let finish: (() => void) | undefined;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const control = { emit: onEvent, end: () => finish?.() };
    this.subscriptions.push(control);
    // Simulates a subscription event racing with initial historical replay.
    onEvent(mergeEvent("3", "3"));
    return { cancel: control.end, done };
  }

  close(): void {}
}

class LiveOnlyRpc extends FakeRpc {
  override async getEvents(shard: number, startId: string, _token?: Uint8Array, stopId?: string) {
    this.getEventsCalls.push({ shard, startId, stopId });
    return { events: [] };
  }

  override subscribe(
    _shard: number,
    _fromId: string,
    onEvent: (event: RawHubEvent) => void,
    _onError: (error: Error) => void
  ): RpcSubscription {
    this.subscribeCalls += 1;
    let finish: (() => void) | undefined;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const control = { emit: onEvent, end: () => finish?.() };
    this.subscriptions.push(control);
    return { cancel: control.end, done };
  }
}

describe("collector runtime integration", () => {
  it("discovers only explicit positive data shards and normalizes event shard zero to its subscription", () => {
    expect(discoveredShardIds({
      version: "test",
      numShards: 2,
      shardInfos: [
        { shardId: 0, maxHeight: 1, blockDelay: 0, mempoolSize: 0 },
        { shardId: 8, maxHeight: 1, blockDelay: 0, mempoolSize: 0 }
      ]
    })).toEqual([8]);
    expect(discoveredShardIds({ version: "test", numShards: 3, shardInfos: [] })).toEqual([]);
    expect(rawEventShard({}, 8)).toBe(8);
    expect(rawEventShard({ shardIndex: 0 }, 8)).toBe(8);
    expect(rawEventShard({ shardIndex: 9 }, 8)).toBe(9);
    expect(() => rawEventShard({}, 0)).toThrow(/positive data shard/);
  });

  it("discovers a nonzero shard, catches up transactionally, and later advances after fixed-bound reconciliation", async () => {
    const database = new CollectorDatabase(":memory:");
    const rpc = new FakeRpc();
    const rpcFactory: RpcFactory = () => rpc;
    const config = loadConfig({
      HYPERSNAP_SOURCE_MODE: "unavailable",
      SNAPMETER_INGEST_URL: "https://example.test/api/v1/ingest/batch",
      SNAPMETER_INGEST_SECRET: "runtime-test-secret-with-32-characters"
    });
    config.reconcileIntervalMs = 20;
    config.discoveryIntervalMs = 10_000;
    config.pulseIntervalMs = 10;
    config.snapshotIntervalMs = 20;
    const delivered: IngestBatch[] = [];
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as IngestBatch;
      delivered.push(batch);
      return Response.json({ ok: true, batchId: batch.batchId, duplicate: false, acceptedAtMs: Date.now() });
    });
    const runtime = new CollectorRuntime({
      config,
      database,
      rpcFactory,
      fetcher,
      logger: createLogger({ write() {} }),
      random: () => 0
    });
    const running = runtime.run();
    try {
      await waitFor(() => database.getCursor("snapchain", 7) === "3");
      expect(rpc.subscribeCalls).toBe(1);
      expect(database.loadActions("snapchain", 0)).toHaveLength(3);
      expect(database.sourceHealth("snapchain")[0]).toMatchObject({ status: "partial", node: { shardCount: 99, coveredShards: 1, mempoolSize: null, historyComplete: false } });
      await waitFor(() => delivered.length > 0);
      expect(delivered.flatMap((batch) => batch.pulses)).toEqual([]);

      rpc.subscriptions[0]?.end();
      await waitFor(() => rpc.subscribeCalls === 2);
      expect(database.sourceHealth("snapchain")[0]?.node.reconnectCount).toBe(1);
      rpc.subscriptions[1]?.emit(mergeEvent("4", "4"));
      await waitFor(() => database.getCursor("snapchain", 7) === "4");
      await waitFor(() => delivered.some((batch) => batch.pulses.some((pulse) => pulse.maxEventId === "4")));
      expect(database.loadActions("snapchain", 0).map((item) => item.fid)).toEqual(["1", "2", "3", "4"]);
      expect(rpc.getEventsCalls.some((call) => call.stopId === "4")).toBe(true);
    } finally {
      runtime.stop();
      await running;
      database.close();
    }
  });

  it("starts prospective shard coverage from the first authoritative live event after an empty replay", async () => {
    const database = new CollectorDatabase(":memory:");
    const rpc = new LiveOnlyRpc();
    rpc.info.numShards = 1;
    const config = loadConfig({ HYPERSNAP_SOURCE_MODE: "unavailable" });
    config.reconcileIntervalMs = 20;
    config.discoveryIntervalMs = 10_000;
    config.pulseIntervalMs = 10;
    const runtime = new CollectorRuntime({
      config,
      database,
      rpcFactory: () => rpc,
      logger: createLogger({ write() {} }),
      random: () => 0
    });
    const running = runtime.run();
    try {
      await waitFor(() => database.sourceHealth("snapchain")[0]?.node.reconciliationState === "ok");
      expect(database.historyCoverageStart("snapchain", [7], 1)).toBeNull();
      const live = { ...mergeEvent("100", "100"), shardIndex: 0 };
      rpc.subscriptions[0]?.emit(live);
      await waitFor(() => database.historyCoverageStart("snapchain", [7], 1) !== null);
      expect(database.historyCoverageStart("snapchain", [7], 1)).toBe(FARCASTER_EPOCH_MS + Number(live.timestamp) * 1_000);
    } finally {
      runtime.stop();
      await running;
      database.close();
    }
  });

  it("backfill scans from zero when a durable cursor exists while normal run resumes it", async () => {
    const database = new CollectorDatabase(":memory:");
    const rpc = new LiveOnlyRpc();
    rpc.info.numShards = 1;
    database.checkpointCursor("snapchain", 7, "500", Date.now());
    const config = loadConfig({ HYPERSNAP_SOURCE_MODE: "unavailable" });
    const runtime = new CollectorRuntime({
      config,
      database,
      rpcFactory: () => rpc,
      logger: createLogger({ write() {} })
    });
    try {
      await runtime.backfill();
      expect(rpc.getEventsCalls[0]).toMatchObject({ shard: 7, startId: "0" });
      expect(database.getCursor("snapchain", 7)).toBe("500");
    } finally {
      database.close();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for collector state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
