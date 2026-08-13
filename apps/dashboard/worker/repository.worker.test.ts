import type { SourceMetrics } from "@snapmeter/contracts";
import { describe, expect, it } from "vitest";
import { emptySource } from "./defaults";
import { applyFreshness } from "./repository";

const NOW = Date.UTC(2026, 7, 13, 12);

function healthyMetrics(overrides: Partial<SourceMetrics> = {}): SourceMetrics {
  const base = emptySource("snapchain", NOW);
  return {
    ...base,
    status: "live",
    quality: "high",
    lastCollectorAtMs: NOW,
    node: {
      ...base.node,
      shardCount: 2,
      coveredShards: 2,
      synchronized: true,
      reconciliationState: "ok",
      historyCoverageStartMs: NOW - 31 * 86_400_000,
      historyComplete: true
    },
    ...overrides
  };
}

describe("Worker source freshness policy", () => {
  it.each([
    "loading",
    "stale",
    "disconnected",
    "reconnecting",
    "replaying",
    "partial",
    "protocol-mismatch",
    "empty",
    "demo"
  ] as const)("does not promote the authoritative %s state", (status) => {
    const quality: SourceMetrics["quality"] = status === "disconnected" ? "unavailable" : status === "demo" ? "high" : "degraded";
    const metrics = healthyMetrics({ status, quality });
    expect(applyFreshness(metrics, NOW)).toMatchObject({ status, quality });
  });

  it.each(["checking", "gap", "unknown"] as const)("refuses live while reconciliation is %s", (reconciliationState) => {
    const metrics = healthyMetrics({ node: { ...healthyMetrics().node, reconciliationState } });
    expect(applyFreshness(metrics, NOW)).toMatchObject({ status: "partial", quality: "degraded" });
  });

  it("requires a synchronized node before reporting live", () => {
    const metrics = healthyMetrics({ node: { ...healthyMetrics().node, synchronized: false } });
    expect(applyFreshness(metrics, NOW)).toMatchObject({ status: "stale", quality: "degraded" });
  });

  it.each([
    { name: "incomplete history", node: { historyComplete: false } },
    { name: "zero declared shards", node: { shardCount: 0, coveredShards: 0 } },
    { name: "partial shard coverage", node: { coveredShards: 1 } }
  ])("reports partial for $name", ({ node }) => {
    const metrics = healthyMetrics({ node: { ...healthyMetrics().node, ...node } });
    expect(applyFreshness(metrics, NOW)).toMatchObject({ status: "partial", quality: "degraded" });
  });

  it("applies exact stale and disconnected age boundaries without promoting diagnoses", () => {
    expect(applyFreshness(healthyMetrics({ lastCollectorAtMs: NOW - 30_000 }), NOW).status).toBe("live");
    expect(applyFreshness(healthyMetrics({ lastCollectorAtMs: NOW - 30_001 }), NOW)).toMatchObject({ status: "stale", quality: "degraded" });
    expect(applyFreshness(healthyMetrics({ lastCollectorAtMs: NOW - 120_001 }), NOW)).toMatchObject({ status: "disconnected", quality: "unavailable" });

    const mismatch = healthyMetrics({ status: "protocol-mismatch", quality: "degraded", lastCollectorAtMs: NOW - 60_000 });
    expect(applyFreshness(mismatch, NOW).status).toBe("protocol-mismatch");
  });

  it("forces unavailable sources and expired diagnoses to disconnected", () => {
    expect(applyFreshness(healthyMetrics({ sourceMode: "unavailable" }), NOW)).toMatchObject({ status: "disconnected", quality: "unavailable" });
    expect(applyFreshness(healthyMetrics({ status: "replaying", quality: "degraded", lastCollectorAtMs: NOW - 120_001 }), NOW))
      .toMatchObject({ status: "disconnected", quality: "unavailable" });
  });

  it("reports verified live and derived only after every health gate passes", () => {
    expect(applyFreshness(healthyMetrics(), NOW)).toMatchObject({ status: "live", quality: "high" });
    expect(applyFreshness(healthyMetrics({ source: "hypersnap", sourceMode: "derived", status: "derived", quality: "derived" }), NOW))
      .toMatchObject({ status: "derived", quality: "derived" });
  });
});
