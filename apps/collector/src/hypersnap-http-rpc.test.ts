import { describe, expect, it, vi } from "vitest";
import { FARCASTER_EPOCH_MS, normalizeMergeEvent, rawHubEventFingerprint, type RawHubEvent } from "@snapmeter/protocol";
import { HypersnapHttpRpc, type HypersnapHttpFetch } from "./hypersnap-http-rpc.js";
import type { RpcSubscription } from "./rpc.js";

const PEER_ID = "12D3KooWTestPeerIdentity123456789abcdefghijk";

describe("Hypersnap HTTP CollectorRpc adapter", () => {
  it("requires an uncredentialed HTTPS base URL", () => {
    expect(() => new HypersnapHttpRpc({ baseUrl: "http://node.example" })).toThrow(/use HTTPS/);
    expect(() => new HypersnapHttpRpc({ baseUrl: "https://user:password@example.test/" })).toThrow(/must not contain credentials/);
    expect(() => new HypersnapHttpRpc({ baseUrl: "https://node.example?token=secret" })).toThrow(/query or fragment/);
    expect(() => new HypersnapHttpRpc({ baseUrl: "https://node.example", expectedPeerId: "bad peer" })).toThrow(/peer identifier/);
  });

  it("maps GetInfo, pins peer identity, and sends no credentials", async () => {
    const fetcher = vi.fn<HypersnapHttpFetch>(async (input, init) => {
      const url = new URL(input.toString());
      expect(url.href).toBe("https://node.example/api/v1/info");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store" });
      return json({
        version: "0.13.4",
        peer_id: PEER_ID,
        numShards: 2,
        shardInfos: [
          { shardId: 0, maxHeight: 20, blockDelay: 0, mempoolSize: 1 },
          { shardId: 1, maxHeight: 19, blockDelay: 2, mempoolSize: 3 }
        ]
      });
    });
    const rpc = new HypersnapHttpRpc({
      baseUrl: "https://node.example/api/",
      expectedPeerId: PEER_ID,
      fetcher
    });

    await expect(rpc.getInfo()).resolves.toEqual({
      version: "0.13.4",
      peerId: PEER_ID,
      numShards: 2,
      shardInfos: [
        { shardId: 0, maxHeight: 20, blockDelay: 0, mempoolSize: 1 },
        { shardId: 1, maxHeight: 19, blockDelay: 2, mempoolSize: 3 }
      ]
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const mismatched = new HypersnapHttpRpc({
      baseUrl: "https://node.example/api/",
      expectedPeerId: "12D3KooWAnotherExpectedPeer",
      fetcher
    });
    await expect(mismatched.getInfo()).rejects.toThrow(/did not match the pinned identity/);
  });

  it("preserves unsafe uint64 values and hydrates canonical block time for a merge event", async () => {
    const fetcher = vi.fn<HypersnapHttpFetch>(async (input) => {
      const url = new URL(input.toString());
      expect(url.pathname).toBe("/v1/eventById");
      expect(url.searchParams.get("shard_index")).toBe("1");
      if (url.searchParams.get("event_id") === "9007199254740992") {
        return rawJson(`{
          "type":"HUB_EVENT_TYPE_BLOCK_CONFIRMED",
          "id":9007199254740992,
          "blockConfirmedBody":{"blockNumber":549755813888,"shardIndex":1,"timestamp":142732900,"totalEvents":2},
          "blockNumber":549755813888,
          "shardIndex":1
        }`);
      }
      expect(url.searchParams.get("event_id")).toBe("9007199254740993");
      return rawJson(`{
        "type":"HUB_EVENT_TYPE_MERGE_MESSAGE",
        "id":9007199254740993,
        "mergeMessageBody":{"message":{"hash":"0xaabbccddeeff00112233445566778899aabbccdd","data":{"type":"MESSAGE_TYPE_CAST_ADD","fid":42,"timestamp":142732800,"network":"FARCASTER_NETWORK_MAINNET","custom":{"kept":true}}}},
        "blockNumber":549755813888,
        "shardIndex":1,
        "extension":{"large":18446744073709551615}
      }`);
    });
    const rpc = new HypersnapHttpRpc({ baseUrl: "https://node.example", fetcher });
    const event = await rpc.getEvent(1, "9007199254740993");

    expect(event).toMatchObject({
      id: "9007199254740993",
      timestamp: "142732900",
      blockNumber: "549755813888",
      shardIndex: 1,
      mergeMessageBody: {
        message: { data: { fid: "42", timestamp: "142732800", custom: { kept: true } } }
      },
      extension: { large: "18446744073709551615" }
    });
    const native: RawHubEvent = {
      ...event,
      timestamp: 142732900,
      mergeMessageBody: { message: {
        hash: Buffer.from("aabbccddeeff00112233445566778899aabbccdd", "hex"),
        data: { type: 1, fid: 42, timestamp: 142732800, network: 1 }
      } }
    };
    expect(rawHubEventFingerprint(event, 1)).toBe(rawHubEventFingerprint(native, 1));
    expect(normalizeMergeEvent(event, "hypersnap", "derived", Date.now(), true)?.actionAtMs)
      .toBe(FARCASTER_EPOCH_MS + 142732900_000);
    expect(normalizeMergeEvent(native, "hypersnap", "derived", Date.now(), true)?.actionAtMs)
      .toBe(FARCASTER_EPOCH_MS + 142732900_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts the reviewed channel-owner hint event without treating it as activity", async () => {
    const eventId = 9n << 14n;
    const hintId = eventId + 1n;
    const fetcher = vi.fn<HypersnapHttpFetch>(async (input) => {
      const requested = BigInt(new URL(input.toString()).searchParams.get("event_id") as string);
      if (requested === eventId) return rawJson(eventJson(eventId, 1));
      return rawJson(`{
        "type":"HUB_EVENT_TYPE_CHANNEL_OWNER_CHANGE_HINT",
        "id":${hintId},
        "blockNumber":9,
        "shardIndex":1
      }`);
    });
    const rpc = new HypersnapHttpRpc({ baseUrl: "https://node.example", fetcher });

    const hint = await rpc.getEvent(1, hintId.toString());
    expect(hint).toMatchObject({
      type: "HUB_EVENT_TYPE_CHANNEL_OWNER_CHANGE_HINT",
      id: hintId.toString(),
      timestamp: "142732800",
      shardIndex: 1
    });
    const native = { ...hint, type: 12, timestamp: 142732800 } satisfies RawHubEvent;
    expect(rawHubEventFingerprint(hint, 1)).toBe(rawHubEventFingerprint(native, 1));
  });

  it("keeps canonical block timestamps separate for equal heights on different shards", async () => {
    const blockNumber = 9n;
    const mergeId = (blockNumber << 14n) + 1n;
    const fetcher = vi.fn<HypersnapHttpFetch>(async (input) => {
      const url = new URL(input.toString());
      const shard = Number(url.searchParams.get("shard_index"));
      const eventId = BigInt(url.searchParams.get("event_id") as string);
      if (eventId % 16_384n === 0n) {
        return rawJson(eventJson(eventId, shard, 142732900 + shard));
      }
      return rawJson(mergeEventJson(eventId, shard));
    });
    const rpc = new HypersnapHttpRpc({ baseUrl: "https://node.example", fetcher });

    const [left, right] = await Promise.all([
      rpc.getEvent(1, mergeId.toString()),
      rpc.getEvent(2, mergeId.toString())
    ]);

    expect(left.timestamp).toBe("142732901");
    expect(right.timestamp).toBe("142732902");
  });

  it("rejects injected event timestamps that conflict with canonical block time", async () => {
    const blockNumber = 9n;
    const mergeId = (blockNumber << 14n) + 1n;
    const mergeMismatch = new HypersnapHttpRpc({
      baseUrl: "https://node.example",
      fetcher: async (input) => {
        const eventId = BigInt(new URL(input.toString()).searchParams.get("event_id") as string);
        if (eventId % 16_384n === 0n) return rawJson(eventJson(eventId, 1, 142732900));
        const merge = JSON.parse(mergeEventJson(eventId, 1)) as Record<string, unknown>;
        merge.timestamp = 142732901;
        return json(merge);
      }
    });
    await expect(mergeMismatch.getEvent(1, mergeId.toString())).rejects.toThrow(/conflicted with its canonical block/);

    const confirmationMismatch = new HypersnapHttpRpc({
      baseUrl: "https://node.example",
      fetcher: async () => {
        const confirmation = JSON.parse(eventJson(blockNumber << 14n, 1, 142732900)) as Record<string, unknown>;
        confirmation.timestamp = 142732901;
        return json(confirmation);
      }
    });
    await expect(confirmationMismatch.getEvent(1, (blockNumber << 14n).toString()))
      .rejects.toThrow(/conflicted with its body timestamp/);
  });

  it("synthesizes an opaque forward page token from the last exact event id plus one", async () => {
    const firstId = 9_007_199_254_740_993n;
    const requests: URL[] = [];
    const fetcher = vi.fn<HypersnapHttpFetch>(async (input) => {
      const url = new URL(input.toString());
      requests.push(url);
      if (requests.length === 1) {
        const events = Array.from({ length: 500 }, (_, index) => eventJson(firstId + BigInt(index), 1));
        return rawJson(`{"events":[${events.join(",")}]}`);
      }
      return rawJson(`{"events":[${eventJson(firstId + 500n, 1)}]}`);
    });
    const rpc = new HypersnapHttpRpc({ baseUrl: "https://node.example", fetcher });
    const first = await rpc.getEvents(1, firstId.toString());

    expect(first.events).toHaveLength(500);
    expect(first.events[0]?.id).toBe(firstId.toString());
    expect(first.events.at(-1)?.id).toBe((firstId + 499n).toString());
    expect(first.nextPageToken).toBeInstanceOf(Uint8Array);
    const second = await rpc.getEvents(1, firstId.toString(), first.nextPageToken);
    expect(second.events.map((event) => event?.id)).toEqual([(firstId + 500n).toString()]);
    expect(second.nextPageToken).toBeUndefined();
    expect(requests[0]?.searchParams.get("pageSize")).toBe("500");
    expect(requests[0]?.searchParams.get("reverse")).toBe("false");
    expect(requests[1]?.searchParams.get("from_event_id")).toBe((firstId + 500n).toString());

    await expect(rpc.getEvents(2, firstId.toString(), first.nextPageToken)).rejects.toThrow(/invalid.*page token/i);
  });

  it("rejects invalid response media types, oversized bodies, and out-of-order pages", async () => {
    const wrongType = new HypersnapHttpRpc({
      baseUrl: "https://node.example",
      fetcher: async () => new Response("{}", { headers: { "content-type": "text/plain" } })
    });
    await expect(wrongType.getInfo()).rejects.toThrow(/content-type/);

    const oversized = new HypersnapHttpRpc({
      baseUrl: "https://node.example",
      maxResponseBytes: 4,
      fetcher: async () => rawJson("{\"tooLong\":true}")
    });
    await expect(oversized.getInfo()).rejects.toThrow(/body-size limit/);

    const unordered = new HypersnapHttpRpc({
      baseUrl: "https://node.example",
      fetcher: async () => rawJson(`{"events":[${eventJson(12n, 1)},${eventJson(11n, 1)}]}`)
    });
    await expect(unordered.getEvents(1, "10")).rejects.toThrow(/not strictly ordered/);
  });

  it("propagates caller aborts and per-request timeouts", async () => {
    const pendingFetch: HypersnapHttpFetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = (): void => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    const rpc = new HypersnapHttpRpc({ baseUrl: "https://node.example", timeoutMs: 1_000, fetcher: pendingFetch });
    const controller = new AbortController();
    const aborted = rpc.getInfo(controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    const timed = new HypersnapHttpRpc({ baseUrl: "https://node.example", timeoutMs: 5, fetcher: pendingFetch });
    await expect(timed.getInfo()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("simulates Subscribe with a validated head probe and bounded forward polling", async () => {
    const requests: URL[] = [];
    let reverseCalls = 0;
    const fetcher = vi.fn<HypersnapHttpFetch>(async (input) => {
      const url = new URL(input.toString());
      requests.push(url);
      if (url.searchParams.get("reverse") === "true") {
        reverseCalls += 1;
        const id = reverseCalls === 1 ? 10n : 12n;
        return rawJson(`{"events":[${eventJson(id, 1)}]}`);
      }
      expect(url.searchParams.get("from_event_id")).toBe("11");
      expect(url.searchParams.get("stop_id")).toBe("13");
      return rawJson(`{"events":[${eventJson(11n, 1)},${eventJson(12n, 1)}]}`);
    });
    const rpc = new HypersnapHttpRpc({ baseUrl: "https://node.example", pollIntervalMs: 1, fetcher });
    const received: string[] = [];
    const onError = vi.fn();
    const active: { subscription?: RpcSubscription } = {};
    const subscription = rpc.subscribe(1, undefined, (event: RawHubEvent) => {
      received.push(String(event.id));
      if (event.id === "12") active.subscription?.cancel();
    }, onError);
    active.subscription = subscription;

    await subscription.ready;
    expect(received[0]).toBe("10");
    await subscription.done;
    expect(received).toEqual(["10", "11", "12"]);
    expect(onError).not.toHaveBeenCalled();
    expect(requests.some((url) => url.searchParams.get("reverse") === "true" && url.searchParams.get("pageSize") === "1")).toBe(true);
    expect(requests.some((url) => url.searchParams.get("stop_id") === "13")).toBe(true);
  });

  it("closes pending subscriptions without leaking an error callback", async () => {
    const fetcher: HypersnapHttpFetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const rpc = new HypersnapHttpRpc({ baseUrl: "https://node.example", fetcher });
    const onError = vi.fn();
    const subscription = rpc.subscribe(1, undefined, () => undefined, onError);
    rpc.close();

    await expect(subscription.ready).rejects.toMatchObject({ name: "AbortError" });
    await expect(subscription.done).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    await expect(rpc.getInfo()).rejects.toMatchObject({ name: "AbortError" });
  });
});

function json(value: unknown): Response {
  return rawJson(JSON.stringify(value));
}

function rawJson(value: string): Response {
  return new Response(value, { headers: { "content-type": "application/json; charset=utf-8" } });
}

function eventJson(id: bigint, shard: number, timestamp = 142732800): string {
  const block = id >> 14n;
  return `{"type":"HUB_EVENT_TYPE_BLOCK_CONFIRMED","id":${id},"blockConfirmedBody":{"blockNumber":${block},"shardIndex":${shard},"timestamp":${timestamp},"totalEvents":1},"blockNumber":${block},"shardIndex":${shard}}`;
}

function mergeEventJson(id: bigint, shard: number): string {
  const block = id >> 14n;
  return `{"type":"HUB_EVENT_TYPE_MERGE_MESSAGE","id":${id},"mergeMessageBody":{"message":{"hash":"0xaabbccddeeff00112233445566778899aabbccdd","data":{"type":"MESSAGE_TYPE_CAST_ADD","fid":42,"timestamp":142732800,"network":"FARCASTER_NETWORK_MAINNET"}}},"blockNumber":${block},"shardIndex":${shard}}`;
}
