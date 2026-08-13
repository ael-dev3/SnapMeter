import type {
  ActionFamily,
  NodeHealth,
  Quality,
  Source,
  SourceMetrics,
  SourceMode,
  SourceStatus,
  Summary
} from "@snapmeter/contracts";

export const DAY_MS = 86_400_000;
export const METRICS_POLICY_VERSION = "2026-08-13.1";

export interface ActivityRecord {
  eventKey: string;
  source: Source;
  sourceMode: SourceMode;
  fid: string;
  action: ActionFamily;
  actionAtMs: number;
  receivedAtMs: number;
  isReplay: boolean;
}

export interface BuildMetricsOptions {
  source: Source;
  sourceMode: SourceMode;
  actions: readonly ActivityRecord[];
  nowMs?: number;
  lastCollectorAtMs?: number | null;
  observedDays?: ReadonlySet<string>;
  node?: Partial<NodeHealth>;
  forceStatus?: SourceStatus;
  caveat?: string | null;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcDayStart(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function fidSetInWindow(actions: readonly ActivityRecord[], startExclusive: number, endInclusive: number): Set<string> {
  const fids = new Set<string>();
  for (const action of actions) {
    if (action.actionAtMs > startExclusive && action.actionAtMs <= endInclusive && isValidFid(action.fid)) fids.add(action.fid);
  }
  return fids;
}

export function isValidFid(fid: string): boolean {
  return /^(?:[1-9]\d*)$/.test(fid) && BigInt(fid) <= 0xffff_ffffn;
}

export function deduplicateActions(actions: readonly ActivityRecord[]): ActivityRecord[] {
  const unique = new Map<string, ActivityRecord>();
  for (const action of actions) {
    const key = `${action.source}:${action.eventKey}`;
    const existing = unique.get(key);
    if (!existing || action.receivedAtMs < existing.receivedAtMs) unique.set(key, action);
  }
  return [...unique.values()];
}

export function percentChange(current: number, previous: number): number | null {
  return previous === 0 ? null : ((current - previous) / previous) * 100;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

export function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function leastSquaresSlope(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const xDelta = index - xMean;
    numerator += xDelta * ((values[index] ?? 0) - yMean);
    denominator += xDelta * xDelta;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

export function classifyTrend(
  daily: readonly { day: string; activeFids: number; actions: number }[],
  observedDays?: ReadonlySet<string>,
  meaningfulAbsolute = 2
): SourceMetrics["trend"] {
  const current = daily.slice(-7);
  const previous = daily.slice(-14, -7);
  const considered = daily.slice(-14);
  const usefulSamples = considered.filter((datum) => observedDays ? observedDays.has(datum.day) : datum.actions > 0).length;
  const currentAverage = current.reduce((sum, datum) => sum + datum.activeFids, 0) / Math.max(current.length, 1);
  const previousAverage = previous.reduce((sum, datum) => sum + datum.activeFids, 0) / Math.max(previous.length, 1);
  const absoluteChange = currentAverage - previousAverage;
  const change = percentChange(currentAverage, previousAverage);
  let label: SourceMetrics["trend"]["label"] = "Stable";
  if (usefulSamples < 7) label = "Insufficient data";
  else if ((change !== null && change > 2 && absoluteChange >= meaningfulAbsolute) || (change === null && currentAverage >= meaningfulAbsolute)) label = "Improving";
  else if (change !== null && change < -2 && absoluteChange <= -meaningfulAbsolute) label = "Worsening";
  return {
    label,
    currentSevenDayAverage: round(currentAverage, 2),
    previousSevenDayAverage: round(previousAverage, 2),
    absoluteChange: round(absoluteChange, 2),
    percentChange: change === null ? null : round(change, 2),
    slope30d: round(leastSquaresSlope(daily.map((datum) => datum.activeFids)), 3),
    usefulSamples,
    explanation: "Compares the latest 7 UTC-day average with the preceding 7 days; ±2% and at least 2 average FIDs are required. The slope is least-squares across 30 UTC days."
  };
}

export function sourceFreshnessStatus(
  mode: SourceMode,
  lastCollectorAtMs: number | null,
  nowMs: number,
  node?: Partial<NodeHealth>
): { status: SourceStatus; quality: Quality } {
  if (mode === "unavailable" || lastCollectorAtMs === null) return { status: "disconnected", quality: "unavailable" };
  const age = Math.max(0, nowMs - lastCollectorAtMs);
  if (age > 120_000) return { status: "disconnected", quality: "unavailable" };
  if (age > 30_000) return { status: "stale", quality: "degraded" };
  if (node?.synchronized !== true) return { status: "stale", quality: "degraded" };
  if (node.reconciliationState !== "ok") return { status: "partial", quality: "degraded" };
  if (
    node.historyComplete !== true
    || node.coveredShards === undefined
    || node.shardCount === undefined
    || node.shardCount <= 0
    || node.coveredShards < node.shardCount
  ) return { status: "partial", quality: "degraded" };
  if (mode === "derived") return { status: "derived", quality: "derived" };
  return { status: "live", quality: "high" };
}

function forcedSourceAssessment(
  forceStatus: SourceStatus | undefined,
  mode: SourceMode,
  freshness: { status: SourceStatus; quality: Quality }
): { status: SourceStatus; quality: Quality } {
  if (forceStatus === undefined) return freshness;

  // Unavailable sources and expired collector observations override even a
  // more specific diagnosis, matching the Worker's hard freshness boundary.
  if (freshness.status === "disconnected") return freshness;

  switch (forceStatus) {
    case "live":
    case "derived":
      // A collector cannot promote itself past independently checked health
      // gates. Reconstruct the healthy status from the configured source mode.
      return freshness;
    case "loading":
    case "disconnected":
      return { status: forceStatus, quality: "unavailable" };
    case "stale":
    case "reconnecting":
    case "replaying":
    case "partial":
    case "protocol-mismatch":
    case "empty":
      return { status: forceStatus, quality: "degraded" };
    case "demo":
      return { status: "demo", quality: mode === "derived" ? "derived" : "high" };
  }
}

export function buildSourceMetrics(options: BuildMetricsOptions): SourceMetrics {
  const nowMs = options.nowMs ?? Date.now();
  const actions = deduplicateActions(options.actions).filter((action) => action.source === options.source && isValidFid(action.fid) && action.actionAtMs <= nowMs);
  const current24 = fidSetInWindow(actions, nowMs - DAY_MS, nowMs);
  const previous24 = fidSetInWindow(actions, nowMs - 2 * DAY_MS, nowMs - DAY_MS);
  const rolling30 = fidSetInWindow(actions, nowMs - 30 * DAY_MS, nowMs);
  const today = fidSetInWindow(actions, utcDayStart(nowMs) - 1, nowMs);
  const active5m = fidSetInWindow(actions, nowMs - 5 * 60_000, nowMs);
  const daily = Array.from({ length: 30 }, (_, index) => {
    const start = utcDayStart(nowMs) - (29 - index) * DAY_MS;
    const end = start + DAY_MS - 1;
    const inDay = actions.filter((action) => action.actionAtMs >= start && action.actionAtMs <= end);
    return { day: utcDay(start), activeFids: new Set(inDay.map((action) => action.fid)).size, actions: inDay.length };
  });
  const last24Actions = actions.filter((action) => action.actionAtMs > nowMs - DAY_MS && action.actionAtMs <= nowMs);
  const actionCounts = Object.fromEntries(
    [...new Set(last24Actions.map((action) => action.action))].map((family) => [family, last24Actions.filter((action) => action.action === family).length])
  ) as SourceMetrics["actionCounts"];
  const latencySamples = last24Actions
    .map((action) => action.receivedAtMs - action.actionAtMs)
    .filter((latency) => latency >= 0 && Number.isFinite(latency));
  const lastActionAtMs = actions.reduce<number | null>((latest, action) => latest === null || action.actionAtMs > latest ? action.actionAtMs : latest, null);
  const defaultNode: NodeHealth = {
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
    historyComplete: false,
    ...options.node
  };
  const freshness = sourceFreshnessStatus(options.sourceMode, options.lastCollectorAtMs ?? null, nowMs, defaultNode);
  const assessment = forcedSourceAssessment(options.forceStatus, options.sourceMode, freshness);
  const changeAbsolute = current24.size - previous24.size;
  const change = percentChange(current24.size, previous24.size);
  return {
    schemaVersion: 1,
    source: options.source,
    sourceMode: options.sourceMode,
    status: assessment.status,
    quality: assessment.quality,
    updatedAtMs: nowMs,
    lastActionAtMs,
    lastCollectorAtMs: options.lastCollectorAtMs ?? null,
    rolling24h: current24.size,
    previous24h: previous24.size,
    changeAbsolute,
    changePercent: change === null ? null : round(change, 2),
    todayUtc: today.size,
    rolling30d: rolling30.size,
    dailyMedian30d: median(daily.map((datum) => datum.activeFids)),
    dailyPeak30d: Math.max(0, ...daily.map((datum) => datum.activeFids)),
    activeFids5m: active5m.size,
    actionsPerMinute1m: actions.filter((action) => action.actionAtMs > nowMs - 60_000 && action.actionAtMs <= nowMs).length,
    actionsPerMinute5m: round(actions.filter((action) => action.actionAtMs > nowMs - 5 * 60_000 && action.actionAtMs <= nowMs).length / 5, 1),
    actionCounts,
    daily,
    trend: classifyTrend(daily, options.observedDays),
    ingestLatencyP50Ms: percentile(latencySamples, 50),
    ingestLatencyP95Ms: percentile(latencySamples, 95),
    node: defaultNode,
    caveat: options.caveat ?? null
  };
}

export function buildComparison(
  snapchain: SourceMetrics,
  hypersnap: SourceMetrics,
  snapchainFids?: ReadonlySet<string>,
  hypersnapFids?: ReadonlySet<string>
): Summary["comparison"] {
  let overlap24h: number | null = null;
  let overlapPercent: number | null = null;
  if (snapchainFids && hypersnapFids) {
    overlap24h = [...snapchainFids].filter((fid) => hypersnapFids.has(fid)).length;
    const union = new Set([...snapchainFids, ...hypersnapFids]).size;
    overlapPercent = union === 0 ? null : round((overlap24h / union) * 100, 2);
  }
  const parity = snapchain.rolling24h === 0 ? null : round((hypersnap.rolling24h / snapchain.rolling24h) * 100, 2);
  const effectivelyIdentical = snapchain.rolling24h === hypersnap.rolling24h && snapchain.todayUtc === hypersnap.todayUtc;
  return {
    overlap24h,
    overlapPercent,
    eligibleActionCoveragePercent: parity,
    eventParityPercent: parity,
    effectivelyIdentical,
    explanation: effectivelyIdentical
      ? "The observed active-FID totals are currently identical; this can reflect overlapping canonical traffic, not independent competition."
      : "Differences can reflect Hyper eligibility, node health, lag, or shard coverage. Source mode and freshness must be considered before interpretation."
  };
}

export function shouldEmitPulse(action: Pick<ActivityRecord, "isReplay" | "actionAtMs" | "receivedAtMs">, liveToleranceMs = 120_000): boolean {
  return !action.isReplay && action.receivedAtMs >= action.actionAtMs && action.receivedAtMs - action.actionAtMs <= liveToleranceMs;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
