import type { Source, SourceMetrics, Summary } from "@snapmeter/contracts";

const DAY_MS = 86_400_000;

function emptyDays(nowMs: number): SourceMetrics["daily"] {
  const now = new Date(nowMs);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: 30 }, (_, index) => ({
    day: new Date(todayUtc - (29 - index) * DAY_MS).toISOString().slice(0, 10),
    activeFids: 0,
    actions: 0
  }));
}

export function emptySource(source: Source, nowMs: number): SourceMetrics {
  const derived = source === "hypersnap";
  return {
    schemaVersion: 1,
    source,
    sourceMode: derived ? "derived" : "verified",
    status: "disconnected",
    quality: "unavailable",
    updatedAtMs: nowMs,
    lastActionAtMs: null,
    lastCollectorAtMs: null,
    rolling24h: 0,
    previous24h: 0,
    changeAbsolute: 0,
    changePercent: null,
    todayUtc: 0,
    rolling30d: 0,
    dailyMedian30d: 0,
    dailyPeak30d: 0,
    activeFids5m: 0,
    actionsPerMinute1m: 0,
    actionsPerMinute5m: 0,
    actionCounts: {},
    daily: emptyDays(nowMs),
    trend: {
      label: "Insufficient data",
      currentSevenDayAverage: 0,
      previousSevenDayAverage: 0,
      absoluteChange: 0,
      percentChange: null,
      slope30d: 0,
      usefulSamples: 0,
      explanation: "At least seven useful UTC-day samples are required."
    },
    ingestLatencyP50Ms: null,
    ingestLatencyP95Ms: null,
    node: {
      version: "unknown",
      shardCount: 0,
      coveredShards: 0,
      height: null,
      blockDelaySeconds: null,
      mempoolSize: null,
      synchronized: false,
      reconnectCount: 0,
      reconciliationState: "unknown",
      clockSkewMs: null,
      historyCoverageStartMs: null,
      historyComplete: false
    },
    caveat: derived
      ? "Hypersnap observed active FIDs are inferred from Hyper-eligible canonical merges; individual Hyper writes are not independently verified."
      : null
  };
}

export function emptySummary(nowMs = Date.now()): Summary {
  return {
    schemaVersion: 1,
    generatedAtMs: nowMs,
    demo: false,
    sources: {
      snapchain: emptySource("snapchain", nowMs),
      hypersnap: emptySource("hypersnap", nowMs)
    },
    comparison: {
      overlap24h: null,
      overlapPercent: null,
      eligibleActionCoveragePercent: null,
      eventParityPercent: null,
      effectivelyIdentical: true,
      explanation: "No recent authenticated collector data is available."
    },
    warnings: ["Collector data is unavailable; the dashboard is not live."]
  };
}
