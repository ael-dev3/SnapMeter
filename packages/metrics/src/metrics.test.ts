import { describe, expect, it } from "vitest";
import type { NodeHealth, Quality, SourceMode, SourceStatus } from "@snapmeter/contracts";
import {
  DAY_MS,
  buildSourceMetrics,
  classifyTrend,
  deduplicateActions,
  fidSetInWindow,
  percentChange,
  sourceFreshnessStatus,
  shouldEmitPulse,
  utcDay
} from "./index";
import type { ActivityRecord } from "./index";

const NOW = Date.UTC(2024, 2, 10, 12, 0, 0);
const HEALTHY_NODE: NodeHealth = {
  version: "test",
  shardCount: 2,
  coveredShards: 2,
  height: 1,
  blockDelaySeconds: 0,
  mempoolSize: 0,
  synchronized: true,
  reconnectCount: 0,
  reconciliationState: "ok",
  clockSkewMs: 0,
  historyCoverageStartMs: NOW - 31 * DAY_MS,
  historyComplete: true
};

function action(fid: string, actionAtMs: number, overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    eventKey: `${fid}-${actionAtMs}`,
    source: "snapchain",
    sourceMode: "verified",
    fid,
    action: "cast",
    actionAtMs,
    receivedAtMs: actionAtMs + 500,
    isReplay: false,
    ...overrides
  };
}

describe("exact active-FID windows", () => {
  it("deduplicates FIDs and observes open-left, closed-right boundaries", () => {
    const actions = [action("1", NOW - DAY_MS), action("2", NOW - DAY_MS + 1), action("2", NOW), action("3", NOW + 1)];
    expect([...fidSetInWindow(actions, NOW - DAY_MS, NOW)]).toEqual(["2"]);
  });

  it("computes rolling, previous, today UTC and rolling 30d independently", () => {
    const metrics = buildSourceMetrics({
      source: "snapchain",
      sourceMode: "verified",
      nowMs: NOW,
      lastCollectorAtMs: NOW,
      actions: [
        action("1", NOW - 60_000),
        action("1", NOW - 30_000),
        action("2", NOW - 25 * 60 * 60_000),
        action("3", NOW - 29 * DAY_MS),
        action("4", NOW - 31 * DAY_MS)
      ]
    });
    expect(metrics.rolling24h).toBe(1);
    expect(metrics.previous24h).toBe(1);
    expect(metrics.todayUtc).toBe(1);
    expect(metrics.rolling30d).toBe(3);
    expect(metrics.daily).toHaveLength(30);
  });

  it("rejects invalid FIDs and duplicate events", () => {
    const duplicate = action("9", NOW - 1000, { eventKey: "same" });
    expect(deduplicateActions([duplicate, { ...duplicate, receivedAtMs: duplicate.receivedAtMs + 1 }])).toHaveLength(1);
    expect(buildSourceMetrics({ source: "snapchain", sourceMode: "verified", nowMs: NOW, lastCollectorAtMs: NOW, actions: [action("0", NOW), action("4294967296", NOW)] }).rolling24h).toBe(0);
  });
});

describe("UTC calendar behavior", () => {
  it("includes leap day and is unaffected by daylight-saving transitions", () => {
    expect(utcDay(Date.UTC(2024, 1, 29, 23, 59, 59))).toBe("2024-02-29");
    const before = Date.UTC(2024, 2, 10, 0);
    const after = Date.UTC(2024, 2, 11, 0);
    expect(after - before).toBe(DAY_MS);
  });
});

describe("trend and replay policy", () => {
  it("uses the seven-day threshold and least-squares trend", () => {
    const daily = Array.from({ length: 30 }, (_, index) => ({ day: `2024-01-${String(index + 1).padStart(2, "0")}`, activeFids: index + 1, actions: index + 1 }));
    expect(classifyTrend(daily).label).toBe("Improving");
    expect(classifyTrend(daily).slope30d).toBe(1);
  });

  it("handles zero baselines without infinity", () => {
    expect(percentChange(5, 0)).toBeNull();
  });

  it("suppresses replay and stale catch-up pulses", () => {
    expect(shouldEmitPulse(action("1", NOW, { isReplay: true }))).toBe(false);
    expect(shouldEmitPulse(action("1", NOW - 300_000, { receivedAtMs: NOW }))).toBe(false);
    expect(shouldEmitPulse(action("1", NOW - 1000, { receivedAtMs: NOW }))).toBe(true);
  });

  it("keeps forced partial history degraded", () => {
    const metrics = buildSourceMetrics({
      source: "snapchain",
      sourceMode: "verified",
      nowMs: NOW,
      lastCollectorAtMs: NOW,
      actions: [],
      forceStatus: "partial",
      node: { shardCount: 1, coveredShards: 1, synchronized: true, historyComplete: false }
    });
    expect(metrics).toMatchObject({ status: "partial", quality: "degraded", node: { historyComplete: false } });
  });
});

describe("source quality", () => {
  it.each([
    { name: "unsynchronized node", node: { synchronized: false }, status: "stale" },
    { name: "reconciliation checking", node: { reconciliationState: "checking" }, status: "partial" },
    { name: "reconciliation gap", node: { reconciliationState: "gap" }, status: "partial" },
    { name: "unknown reconciliation", node: { reconciliationState: "unknown" }, status: "partial" },
    { name: "incomplete history", node: { historyComplete: false }, status: "partial" },
    { name: "zero declared shards", node: { shardCount: 0, coveredShards: 0 }, status: "partial" },
    { name: "partial shard coverage", node: { coveredShards: 1 }, status: "partial" }
  ] as const)("degrades a fresh $name", ({ node, status }) => {
    expect(sourceFreshnessStatus("verified", NOW, NOW, { ...HEALTHY_NODE, ...node }))
      .toEqual({ status, quality: "degraded" });
  });

  it("fails closed when health evidence is missing", () => {
    expect(sourceFreshnessStatus("verified", NOW, NOW)).toEqual({ status: "stale", quality: "degraded" });
    expect(sourceFreshnessStatus("verified", NOW, NOW, { synchronized: true }))
      .toEqual({ status: "partial", quality: "degraded" });
  });

  it("reports high or derived quality only after every health gate passes", () => {
    expect(sourceFreshnessStatus("verified", NOW, NOW, HEALTHY_NODE)).toEqual({ status: "live", quality: "high" });
    expect(sourceFreshnessStatus("derived", NOW, NOW, HEALTHY_NODE)).toEqual({ status: "derived", quality: "derived" });
  });

  it("applies exact freshness boundaries before node health gates", () => {
    expect(sourceFreshnessStatus("verified", NOW - 30_000, NOW, HEALTHY_NODE)).toEqual({ status: "live", quality: "high" });
    expect(sourceFreshnessStatus("verified", NOW - 30_001, NOW, HEALTHY_NODE)).toEqual({ status: "stale", quality: "degraded" });
    expect(sourceFreshnessStatus("verified", NOW - 120_001, NOW, HEALTHY_NODE)).toEqual({ status: "disconnected", quality: "unavailable" });
    expect(sourceFreshnessStatus("unavailable", NOW, NOW, HEALTHY_NODE)).toEqual({ status: "disconnected", quality: "unavailable" });
    expect(sourceFreshnessStatus("verified", null, NOW, HEALTHY_NODE)).toEqual({ status: "disconnected", quality: "unavailable" });
  });

  const forcedStatusCases: readonly {
    status: SourceStatus;
    sourceMode: SourceMode;
    expectedStatus: SourceStatus;
    quality: Quality;
  }[] = [
    { status: "loading", sourceMode: "verified", expectedStatus: "loading", quality: "unavailable" },
    { status: "live", sourceMode: "verified", expectedStatus: "live", quality: "high" },
    { status: "derived", sourceMode: "derived", expectedStatus: "derived", quality: "derived" },
    { status: "stale", sourceMode: "verified", expectedStatus: "stale", quality: "degraded" },
    { status: "disconnected", sourceMode: "verified", expectedStatus: "disconnected", quality: "unavailable" },
    { status: "reconnecting", sourceMode: "verified", expectedStatus: "reconnecting", quality: "degraded" },
    { status: "replaying", sourceMode: "verified", expectedStatus: "replaying", quality: "degraded" },
    { status: "partial", sourceMode: "verified", expectedStatus: "partial", quality: "degraded" },
    { status: "protocol-mismatch", sourceMode: "verified", expectedStatus: "protocol-mismatch", quality: "degraded" },
    { status: "empty", sourceMode: "verified", expectedStatus: "empty", quality: "degraded" },
    { status: "demo", sourceMode: "verified", expectedStatus: "demo", quality: "high" }
  ];

  it.each(forcedStatusCases)("maps forced $status to $quality quality", ({ status, sourceMode, expectedStatus, quality }) => {
    const metrics = buildSourceMetrics({
      source: sourceMode === "derived" ? "hypersnap" : "snapchain",
      sourceMode,
      nowMs: NOW,
      lastCollectorAtMs: NOW,
      actions: [],
      node: HEALTHY_NODE,
      forceStatus: status
    });
    expect(metrics).toMatchObject({ status: expectedStatus, quality });
  });

  it.each([
    { name: "unsynchronized", node: { synchronized: false }, status: "stale" },
    { name: "reconciliation gap", node: { reconciliationState: "gap" }, status: "partial" },
    { name: "incomplete history", node: { historyComplete: false }, status: "partial" },
    { name: "partial shards", node: { coveredShards: 1 }, status: "partial" }
  ] as const)("does not honor a forced live promotion for $name health", ({ node, status }) => {
    const metrics = buildSourceMetrics({
      source: "snapchain",
      sourceMode: "verified",
      nowMs: NOW,
      lastCollectorAtMs: NOW,
      actions: [],
      node: { ...HEALTHY_NODE, ...node },
      forceStatus: "live"
    });
    expect(metrics).toMatchObject({ status, quality: "degraded" });
  });

  it("lets the hard disconnect boundary override a recent collector diagnosis", () => {
    const metrics = buildSourceMetrics({
      source: "snapchain",
      sourceMode: "verified",
      nowMs: NOW,
      lastCollectorAtMs: NOW - 120_001,
      actions: [],
      node: HEALTHY_NODE,
      forceStatus: "replaying"
    });
    expect(metrics).toMatchObject({ status: "disconnected", quality: "unavailable" });
  });
});
