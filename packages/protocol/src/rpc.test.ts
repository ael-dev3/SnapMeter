import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createRpcMetadata,
  createSubscribeRequest,
  invokeUnaryWithAbort,
  MinimumIntervalGate,
  observeSubscriptionStream,
  type RawHubEvent
} from "./rpc";

describe("Snapchain RPC metadata", () => {
  it("sends proxy authorization and hosted-provider API keys under distinct headers", () => {
    const metadata = createRpcMetadata({ authorization: "Bearer proxy-secret", apiKey: "neynar-secret" });

    expect(metadata.get("authorization")).toEqual(["Bearer proxy-secret"]);
    expect(metadata.get("x-api-key")).toEqual(["neynar-secret"]);
  });

  it("does not add authentication headers when credentials are absent", () => {
    const metadata = createRpcMetadata({});

    expect(metadata.get("authorization")).toEqual([]);
    expect(metadata.get("x-api-key")).toEqual([]);
  });
});

describe("Snapchain live subscription request", () => {
  it("omits fromId when subscribing at the live head", () => {
    const request = createSubscribeRequest(2);
    expect(request).toEqual({
      eventTypes: ["HUB_EVENT_TYPE_MERGE_MESSAGE", "HUB_EVENT_TYPE_BLOCK_CONFIRMED"],
      shardIndex: 2
    });
    expect(Object.hasOwn(request, "fromId")).toBe(false);
  });

  it("retains an explicit cursor when one is intentionally supplied", () => {
    expect(createSubscribeRequest(1, "123")).toMatchObject({ shardIndex: 1, fromId: "123" });
  });

  it("does not become ready on metadata and incorporates first data before readiness", async () => {
    const emitter = new EventEmitter();
    const cancel = vi.fn();
    const stream = Object.assign(emitter, { cancel }) as unknown as Parameters<typeof observeSubscriptionStream>[0];
    const seen: string[] = [];
    const subscription = observeSubscriptionStream(stream, (event) => seen.push(String(event.id)), () => {});
    let ready = false;
    void subscription.ready.then(() => { ready = true; });

    emitter.emit("metadata", createRpcMetadata({}));
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(seen).toEqual([]);

    emitter.emit("data", { id: "123" } satisfies RawHubEvent);
    await subscription.ready;
    expect(seen).toEqual(["123"]);
    expect(ready).toBe(true);
  });

  it("rejects readiness when the stream ends before its first data event", async () => {
    const emitter = new EventEmitter();
    const stream = Object.assign(emitter, { cancel: vi.fn() }) as unknown as Parameters<typeof observeSubscriptionStream>[0];
    const subscription = observeSubscriptionStream(stream, () => {}, () => {});
    const rejection = expect(subscription.ready).rejects.toThrow(/ended before becoming ready/);
    emitter.emit("end");
    await rejection;
    await subscription.done;
  });

  it("settles readiness and completion immediately when cancelled before first data", async () => {
    const emitter = new EventEmitter();
    const cancel = vi.fn();
    const stream = Object.assign(emitter, { cancel }) as unknown as Parameters<typeof observeSubscriptionStream>[0];
    const subscription = observeSubscriptionStream(stream, () => {}, () => {});
    const rejection = expect(subscription.ready).rejects.toMatchObject({
      name: "AbortError",
      message: "subscription cancelled"
    });

    subscription.cancel();

    await rejection;
    await subscription.done;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("shared GetEvents start throttling", () => {
  it("spaces concurrent callers by the configured minimum interval", async () => {
    let nowMs = 1_000;
    const waits: number[] = [];
    const gate = new MinimumIntervalGate(250, {
      now: () => nowMs,
      delay: async (milliseconds) => {
        waits.push(milliseconds);
        nowMs += milliseconds;
      }
    });

    const starts = await Promise.all([
      gate.waitForStart(),
      gate.waitForStart(),
      gate.waitForStart()
    ]);

    expect(starts).toEqual([1_000, 1_250, 1_500]);
    expect(waits).toEqual([250, 250]);
  });

  it("allows unthrottled calls when the interval is zero", async () => {
    const gate = new MinimumIntervalGate(0, { now: () => 123 });
    expect(await Promise.all([gate.waitForStart(), gate.waitForStart()])).toEqual([123, 123]);
  });

  it("aborts a queued caller promptly without starting its RPC", async () => {
    let nowMs = 1_000;
    let releaseDelay: (() => void) | undefined;
    const delay = vi.fn(() => new Promise<void>((resolve) => { releaseDelay = resolve; }));
    const gate = new MinimumIntervalGate(250, { now: () => nowMs, delay });
    await gate.waitForStart();

    const predecessor = gate.waitForStart();
    await vi.waitFor(() => expect(delay).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    let rpcStarts = 0;
    const queued = (async () => {
      await gate.waitForStart(controller.signal);
      rpcStarts += 1;
    })();

    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError", message: "RPC pacing aborted" });
    expect(rpcStarts).toBe(0);

    nowMs = 1_250;
    releaseDelay?.();
    await predecessor;
    await Promise.resolve();
    expect(rpcStarts).toBe(0);
  });
});

describe("abortable unary RPC", () => {
  it("cancels an in-flight call and rejects once with AbortError", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let callback: ((error: Error | null, response: { ok: boolean }) => void) | undefined;
    const pending = invokeUnaryWithAbort<{ ok: boolean }>((settle) => {
      callback = settle;
      return { cancel } as unknown as ReturnType<Parameters<typeof invokeUnaryWithAbort<{ ok: boolean }>>[0]>;
    }, controller.signal);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "RPC request aborted" });
    expect(cancel).toHaveBeenCalledTimes(1);
    callback?.(null, { ok: true });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
