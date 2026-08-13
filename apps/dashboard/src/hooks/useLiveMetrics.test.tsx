// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoSummary } from "../data/demo";
import { applyClientFreshness, useLiveMetrics } from "./useLiveMetrics";

class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  readyState = 0;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

describe("live dashboard transport", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    const summary = createDemoSummary();
    summary.demo = false;
    summary.sources.snapchain.status = "live";
    summary.sources.hypersnap.status = "derived";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(summary), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hydrates a snapshot and deduplicates WebSocket sequences", async () => {
    const { result } = renderHook(() => useLiveMetrics());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0]!;
    act(() => socket.open());
    await waitFor(() => expect(result.current.transport).toBe("live"));
    expect(result.current.summary?.demo).toBe(false);

    const pulse = {
      type: "pulse",
      schemaVersion: 1,
      sequence: 7,
      deliveryId: "00000000-0000-4000-8000-000000000001:pulse:0",
      deliveryIds: [
        "00000000-0000-4000-8000-000000000001:pulse:0",
        "00000000-0000-4000-8000-000000000001:pulse:1"
      ],
      data: {
        schemaVersion: 1,
        source: "snapchain",
        sourceMode: "verified",
        windowStartMs: 1_000,
        windowEndMs: 1_250,
        eventCount: 12,
        uniqueFids: 8,
        actionCounts: { cast: 12 },
        lastActionAtMs: 1_200,
        maxEventId: "42",
        isReplay: false
      }
    };

    act(() => socket.receive(pulse));
    expect(result.current.pulses.snapchain).toMatchObject({ id: 1, count: 12 });
    act(() => socket.receive(pulse));
    expect(result.current.pulses.snapchain.id).toBe(1);
    act(() => socket.receive({ ...pulse, sequence: 8, data: { ...pulse.data, eventCount: 3 } }));
    expect(result.current.pulses.snapchain.id).toBe(1);
    act(() => socket.receive({ ...pulse, sequence: 9, deliveryId: "00000000-0000-4000-8000-000000000001:pulse:1", deliveryIds: undefined, data: { ...pulse.data, eventCount: 3 } }));
    expect(result.current.pulses.snapchain.id).toBe(1);
    act(() => socket.receive({ ...pulse, sequence: 10, deliveryId: "00000000-0000-4000-8000-000000000002:pulse:0", deliveryIds: undefined, data: { ...pulse.data, eventCount: 3 } }));
    expect(result.current.pulses.snapchain).toMatchObject({ id: 2, count: 3 });
  });

  it("never substitutes demo data after a server failure", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));
    const { result } = renderHook(() => useLiveMetrics());
    await waitFor(() => expect(result.current.transport).toBe("error"));
    expect(result.current.summary).toBeNull();
    expect(result.current.demo).toBe(false);
  });

  it("degrades a connected snapshot locally when collector data ages", () => {
    const summary = createDemoSummary();
    summary.demo = false;
    summary.sources.snapchain.status = "live";
    summary.sources.snapchain.quality = "high";
    summary.sources.snapchain.lastCollectorAtMs = 1_000;
    expect(applyClientFreshness(summary, 32_000).sources.snapchain).toMatchObject({ status: "stale", quality: "degraded" });
    expect(applyClientFreshness(summary, 122_000).sources.snapchain).toMatchObject({ status: "disconnected", quality: "unavailable" });
  });

  it("never promotes an unhealthy WebSocket snapshot while it is recent", () => {
    const summary = createDemoSummary();
    summary.demo = false;
    summary.sources.snapchain.status = "live";
    summary.sources.snapchain.quality = "high";
    summary.sources.snapchain.lastCollectorAtMs = 1_000;
    summary.sources.snapchain.node.synchronized = true;
    summary.sources.snapchain.node.reconciliationState = "gap";
    expect(applyClientFreshness(summary, 2_000).sources.snapchain).toMatchObject({ status: "partial", quality: "degraded" });
    summary.sources.snapchain.status = "replaying";
    expect(applyClientFreshness(summary, 2_000).sources.snapchain.status).toBe("replaying");
  });

  it("keeps only one current socket across offline/online races", async () => {
    const { result } = renderHook(() => useLiveMetrics());
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const first = MockWebSocket.instances[0]!;
    act(() => window.dispatchEvent(new Event("offline")));
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const second = MockWebSocket.instances[1]!;
    expect(first.readyState).toBe(3);
    act(() => first.dispatchEvent(new Event("close")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(MockWebSocket.instances).toHaveLength(2);
    act(() => second.open());
    const refreshed = createDemoSummary();
    refreshed.demo = false;
    refreshed.sources.snapchain.rolling24h = 999;
    act(() => second.receive({ type: "snapshot", schemaVersion: 1, sequence: 0, data: refreshed }));
    await waitFor(() => expect(result.current.summary?.sources.snapchain.rolling24h).toBe(999));
  });
});
