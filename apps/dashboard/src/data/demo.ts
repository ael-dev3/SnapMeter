import type { ActionFamily, Source, SourceMetrics, Summary } from "@snapmeter/contracts";

export const DEMO_CLOCK_MS = Date.UTC(2026, 7, 13, 4, 30, 0);

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function dateAt(daysAgo: number): string {
  return new Date(DEMO_CLOCK_MS - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

function actions(multiplier: number): Record<ActionFamily, number> {
  return {
    cast: Math.round(1_428_241 * multiplier),
    reaction: Math.round(2_730_044 * multiplier),
    link: Math.round(284_307 * multiplier),
    verification: Math.round(58_192 * multiplier),
    "user-data": Math.round(97_855 * multiplier),
    "username-proof": Math.round(12_420 * multiplier),
    "storage-lending": Math.round(8_143 * multiplier),
    key: Math.round(6_804 * multiplier),
    channel: Math.round(3_122 * multiplier),
    other: Math.round(21_405 * multiplier)
  };
}

function sourceMetrics(source: Source, random: () => number): SourceMetrics {
  const isSnapchain = source === "snapchain";
  const daily = Array.from({ length: 30 }, (_, index) => {
    const daysAgo = 29 - index;
    const slope = isSnapchain ? index * 117 : index * 108;
    const wave = Math.sin(index * 0.77) * (isSnapchain ? 2_450 : 2_270);
    const noise = (random() - 0.5) * 1_500;
    const activeFids = Math.max(0, Math.round((isSnapchain ? 48_900 : 47_180) + slope + wave + noise));
    return {
      day: dateAt(daysAgo),
      activeFids,
      actions: Math.round(activeFids * (isSnapchain ? 76.4 : 72.1))
    };
  });

  const rolling24h = isSnapchain ? 58_429 : 55_927;
  const previous24h = isSnapchain ? 56_918 : 54_901;
  const changeAbsolute = rolling24h - previous24h;

  return {
    schemaVersion: 1,
    source,
    sourceMode: isSnapchain ? "verified" : "derived",
    status: "demo",
    quality: isSnapchain ? "high" : "derived",
    updatedAtMs: DEMO_CLOCK_MS - (isSnapchain ? 1_200 : 2_800),
    lastActionAtMs: DEMO_CLOCK_MS - (isSnapchain ? 4_000 : 7_000),
    lastCollectorAtMs: DEMO_CLOCK_MS - (isSnapchain ? 1_200 : 2_800),
    rolling24h,
    previous24h,
    changeAbsolute,
    changePercent: (changeAbsolute / previous24h) * 100,
    todayUtc: isSnapchain ? 22_806 : 21_948,
    rolling30d: isSnapchain ? 184_920 : 177_506,
    dailyMedian30d: isSnapchain ? 52_614 : 50_781,
    dailyPeak30d: isSnapchain ? 59_882 : 57_205,
    activeFids5m: isSnapchain ? 1_284 : 1_196,
    actionsPerMinute1m: isSnapchain ? 3_842 : 3_571,
    actionsPerMinute5m: isSnapchain ? 3_719 : 3_438,
    actionCounts: actions(isSnapchain ? 1 : 0.941),
    daily,
    trend: {
      label: "Improving",
      currentSevenDayAverage: isSnapchain ? 54_988 : 52_731,
      previousSevenDayAverage: isSnapchain ? 53_271 : 51_494,
      absoluteChange: isSnapchain ? 1_717 : 1_237,
      percentChange: isSnapchain ? 3.22 : 2.4,
      slope30d: isSnapchain ? 116.7 : 108.1,
      usefulSamples: 30,
      explanation: "Current seven-day average versus the preceding seven days, supported by the 30-day least-squares slope."
    },
    ingestLatencyP50Ms: isSnapchain ? 184 : 231,
    ingestLatencyP95Ms: isSnapchain ? 612 : 784,
    node: {
      version: isSnapchain ? "0.12.4-demo" : "0.4.2-demo",
      shardCount: 4,
      coveredShards: 4,
      height: isSnapchain ? 8_941_204 : 8_941_197,
      blockDelaySeconds: isSnapchain ? 1.8 : 3.1,
      mempoolSize: isSnapchain ? 184 : 167,
      synchronized: true,
      reconnectCount: isSnapchain ? 1 : 2,
      reconciliationState: "ok",
      clockSkewMs: isSnapchain ? 18 : 24,
      historyCoverageStartMs: DEMO_CLOCK_MS - 31 * 86_400_000,
      historyComplete: true
    },
    caveat: isSnapchain
      ? null
      : "Inferred from Hyper-eligible canonical merges observed by the Hypersnap node; not an independent Hyper write stream."
  };
}

export function createDemoSummary(seed = 0x5a17): Summary {
  const random = seeded(seed);
  return {
    schemaVersion: 1,
    generatedAtMs: DEMO_CLOCK_MS,
    demo: true,
    sources: {
      snapchain: sourceMetrics("snapchain", random),
      hypersnap: sourceMetrics("hypersnap", random)
    },
    comparison: {
      overlap24h: 53_124,
      overlapPercent: 94.98,
      eligibleActionCoveragePercent: 94.1,
      eventParityPercent: 94.7,
      effectivelyIdentical: false,
      explanation: "Most observed FIDs overlap. The remaining difference is consistent with Hyper eligibility and source freshness."
    },
    warnings: ["Demo data is deterministic and synthetic. It never appears unless ?demo=1 is present."]
  };
}
