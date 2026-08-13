import { describe, expect, it } from "vitest";
import { isTerminalPageToken, reconcileEvents } from "./reconcile.js";
import type { CollectorRpc } from "./rpc.js";
import type { RawHubEvent } from "@snapmeter/protocol";

function fakeRpc(pages: Array<{ events: Array<RawHubEvent | null>; nextPageToken?: Uint8Array }>): CollectorRpc {
  let index = 0;
  return {
    getInfo: async () => ({ version: "test", numShards: 1, shardInfos: [{ shardId: 0, maxHeight: 1, blockDelay: 0, mempoolSize: 0 }] }),
    getEvent: async () => ({}),
    getEvents: async () => pages[index++] ?? { events: [] },
    subscribe: () => ({ cancel() {}, ready: Promise.resolve(), done: Promise.resolve() }),
    close() {}
  };
}

describe("GetEvents reconciliation", () => {
  it("stops on the pinned [null] page-token sentinel after an exact full page", async () => {
    const events = Array.from({ length: 2 }, (_, index) => ({ id: String(index + 1), shardIndex: 0 }));
    const seen: string[] = [];
    const result = await reconcileEvents({
      rpc: fakeRpc([{ events, nextPageToken: new TextEncoder().encode(" [null] ") }]),
      shard: 0,
      startId: "0",
      pageSize: 2,
      onEvent: (event) => seen.push(String(event.id))
    });
    expect(result).toMatchObject({ eventCount: 2, pageCount: 1, terminal: "null-sentinel" });
    expect(seen).toEqual(["1", "2"]);
    expect(isTerminalPageToken(new TextEncoder().encode("[ null ]"))).toBe(true);
  });

  it("uses an immutable exclusive stop bound", async () => {
    const seen: string[] = [];
    const result = await reconcileEvents({
      rpc: fakeRpc([{ events: [{ id: "10" }, { id: "11" }, { id: "12" }] }]),
      shard: 0,
      startId: "9",
      stopId: "12",
      pageSize: 500,
      onEvent: (event) => seen.push(String(event.id))
    });
    expect(seen).toEqual(["10", "11"]);
    expect(result.lastEventId).toBe("11");
  });

  it("detects repeated continuation tokens", async () => {
    const token = new Uint8Array([1, 2, 3]);
    await expect(reconcileEvents({
      rpc: fakeRpc([
        { events: [{ id: "1" }], nextPageToken: token },
        { events: [{ id: "2" }], nextPageToken: token }
      ]),
      shard: 0,
      startId: "0",
      pageSize: 1,
      onEvent() {}
    })).rejects.toThrow(/repeated a page token/);
  });

  it("reports durable progress after each completely processed page", async () => {
    const progress: Array<{ pageCount: number; pageEventCount: number; eventCount: number; lastEventId: string }> = [];
    const result = await reconcileEvents({
      rpc: fakeRpc([
        { events: [{ id: "1" }, { id: "2" }], nextPageToken: new Uint8Array([1]) },
        { events: [{ id: "3" }] }
      ]),
      shard: 1,
      startId: "0",
      pageSize: 2,
      onEvent() {},
      onPageProgress: (page) => { progress.push(page); }
    });

    expect(result).toMatchObject({ pageCount: 2, eventCount: 3, lastEventId: "3" });
    expect(progress).toEqual([
      { pageCount: 1, pageEventCount: 2, eventCount: 2, lastEventId: "2" },
      { pageCount: 2, pageEventCount: 1, eventCount: 3, lastEventId: "3" }
    ]);
  });

  it("does not start another page after reconciliation is aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const rpc = fakeRpc([
      { events: [{ id: "1" }, { id: "2" }], nextPageToken: new Uint8Array([1]) },
      { events: [{ id: "3" }] }
    ]);
    const original = rpc.getEvents.bind(rpc);
    rpc.getEvents = async (...args) => {
      calls += 1;
      return original(...args);
    };

    await expect(reconcileEvents({
      rpc,
      shard: 1,
      startId: "0",
      pageSize: 2,
      signal: controller.signal,
      onEvent() {},
      onPageProgress: () => { controller.abort(); }
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });
});
