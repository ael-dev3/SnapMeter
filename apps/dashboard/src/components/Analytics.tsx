import type { SourceMetrics, Summary } from "@snapmeter/contracts";
import { useMemo, useState } from "react";
import { ageFrom, exact, latency, percent, titleCase } from "../lib/format";
import { ActionMix } from "./ActionMix";
import { InfoTip } from "./InfoTip";
import { InteractiveChart, type ChartSeries } from "./InteractiveChart";

type Range = "24H" | "7D" | "30D";
const RANGE_LENGTH: Record<Range, number> = { "24H": 2, "7D": 7, "30D": 30 };

function seriesFor(metrics: SourceMetrics, name: string, color: string, range: Range): ChartSeries {
  return {
    name,
    color,
    points: metrics.daily.slice(-RANGE_LENGTH[range]).map((point) => ({
      label: point.day.slice(5),
      value: point.activeFids
    }))
  };
}

function SourceOperations({ metrics }: { metrics: SourceMetrics }): React.JSX.Element {
  return (
    <details className={`operations operations-${metrics.source}`}>
      <summary>
        <span>{titleCase(metrics.source)} operations</span>
        <small>{metrics.node.synchronized ? "Synchronized" : "Not synchronized"} · {metrics.node.coveredShards}/{metrics.node.shardCount} shards</small>
      </summary>
      <div className="operations-grid">
        <dl>
          <div><dt>Active FIDs · 5m</dt><dd>{exact(metrics.activeFids5m)}</dd></div>
          <div><dt>Actions/min · 5m</dt><dd>{exact(metrics.actionsPerMinute5m)}</dd></div>
          <div><dt>Current height</dt><dd>{metrics.node.height === null ? "Unavailable" : exact(metrics.node.height)}</dd></div>
          <div><dt>Block delay</dt><dd>{metrics.node.blockDelaySeconds === null ? "Unavailable" : `${exact(metrics.node.blockDelaySeconds)} s`}</dd></div>
          <div><dt>Mempool</dt><dd>{metrics.node.mempoolSize === null ? "Unavailable" : exact(metrics.node.mempoolSize)}</dd></div>
        </dl>
        <dl>
          <div><dt>Node version</dt><dd>{metrics.node.version}</dd></div>
          <div><dt>Reconnects</dt><dd>{exact(metrics.node.reconnectCount)}</dd></div>
          <div><dt>Reconciliation</dt><dd>{titleCase(metrics.node.reconciliationState)}</dd></div>
          <div><dt>Clock skew</dt><dd>{metrics.node.clockSkewMs === null ? "Unavailable" : `${exact(metrics.node.clockSkewMs)} ms`}</dd></div>
          <div><dt>Coverage</dt><dd>{metrics.node.coveredShards}/{metrics.node.shardCount} shards</dd></div>
          <div><dt>30d history</dt><dd>{metrics.node.historyComplete ? "Complete" : "Partial"}</dd></div>
          <div><dt>History since</dt><dd>{metrics.node.historyCoverageStartMs === null ? "Unavailable" : new Date(metrics.node.historyCoverageStartMs).toISOString().slice(0, 10)}</dd></div>
        </dl>
      </div>
      {metrics.caveat && <p className="source-caveat">{metrics.caveat}</p>}
    </details>
  );
}

function Freshness({ sources, now }: { sources: Summary["sources"]; now: number }): React.JSX.Element {
  const maxP95 = Math.max(1, sources.snapchain.ingestLatencyP95Ms ?? 0, sources.hypersnap.ingestLatencyP95Ms ?? 0);
  return (
    <div className="freshness-grid">
      {([sources.snapchain, sources.hypersnap] as SourceMetrics[]).map((metrics) => {
        const p50 = metrics.ingestLatencyP50Ms ?? 0;
        const p95 = metrics.ingestLatencyP95Ms ?? 0;
        return (
          <article key={metrics.source} className={`freshness-source freshness-${metrics.source}`}>
            <div className="freshness-title">
              <div><span className="source-line" />{titleCase(metrics.source)}</div>
              <span className={`quality quality-${metrics.quality}`}>{titleCase(metrics.quality)} quality</span>
            </div>
            <p><strong>{ageFrom(metrics.lastCollectorAtMs, now)}</strong><span>collector update</span></p>
            <div className="latency-track" aria-label={`p50 latency ${latency(metrics.ingestLatencyP50Ms)}, p95 latency ${latency(metrics.ingestLatencyP95Ms)}`}>
              <i className="p95" style={{ width: `${(p95 / maxP95) * 100}%` }} />
              <i className="p50" style={{ left: `${(p50 / maxP95) * 100}%` }} />
            </div>
            <div className="latency-values"><span>p50 <b>{latency(metrics.ingestLatencyP50Ms)}</b></span><span>p95 <b>{latency(metrics.ingestLatencyP95Ms)}</b></span></div>
          </article>
        );
      })}
      <p className="relative-scale">Tracks share the current sources’ largest p95 as their relative scale; they do not imply a performance target.</p>
    </div>
  );
}

export function Analytics({ summary, now }: { summary: Summary; now: number }): React.JSX.Element {
  const [range, setRange] = useState<Range>("30D");
  const series = useMemo(() => [
    seriesFor(summary.sources.snapchain, "Snapchain", "#4bddff", range),
    seriesFor(summary.sources.hypersnap, "Hypersnap", "#bc7fff", range)
  ], [range, summary]);
  const latestSnap = series[0]?.points.at(-1)?.value ?? 0;
  const latestHyper = series[1]?.points.at(-1)?.value ?? 0;

  return (
    <main className="analytics" id="analytics">
      <header className="analytics-head">
        <div>
          <p className="section-kicker">History / comparison</p>
          <h2>Signal below the pulse</h2>
          <p>Exact UTC actor windows, source quality, and the operational context behind each number.</p>
        </div>
        <div className="range-control" role="group" aria-label="Chart range">
          {(["24H", "7D", "30D"] as Range[]).map((option) => (
            <button
              type="button"
              key={option}
              aria-pressed={range === option}
              onClick={() => setRange(option)}
            >{option}</button>
          ))}
        </div>
      </header>

      <section className="comparison-band" aria-labelledby="comparison-title">
        <div className="band-heading">
          <div><span className="index-number">01</span><div><h3 id="comparison-title">Two-source comparison</h3><p>{range === "24H" ? "Latest two UTC samples" : `${range} UTC daily active FIDs`}</p></div></div>
          <div className="legend"><span className="legend-snap">Snapchain</span><span className="legend-hyper">Hypersnap</span></div>
        </div>
        <InteractiveChart id="comparison-chart" series={series} />
        <div className="chart-foot">
          <p><strong>{exact(latestSnap - latestHyper)}</strong> latest-sample difference</p>
          <p>{summary.comparison.effectivelyIdentical ? "Sources are effectively identical in the compared window." : summary.comparison.explanation}</p>
        </div>
      </section>

      <section className="comparison-facts" aria-label="Comparison integrity">
        <div><span>24h active-FID overlap <InfoTip label="Define active FID overlap">FIDs observed by both sources during the same rolling 24-hour window.</InfoTip></span><strong>{summary.comparison.overlapPercent === null ? "Unavailable" : `${summary.comparison.overlapPercent.toFixed(1)}%`}</strong><small>{summary.comparison.overlap24h === null ? "No shared membership data" : `${exact(summary.comparison.overlap24h)} FIDs shared`}</small></div>
        <div><span>Hyper-eligible coverage</span><strong>{summary.comparison.eligibleActionCoveragePercent === null ? "Unavailable" : `${summary.comparison.eligibleActionCoveragePercent.toFixed(1)}%`}</strong><small>Eligible canonical actions observed</small></div>
        <div><span>Event-count parity</span><strong>{summary.comparison.eventParityPercent === null ? "Unavailable" : `${summary.comparison.eventParityPercent.toFixed(1)}%`}</strong><small>Not a growth contest</small></div>
      </section>

      <section className="daily-band" aria-labelledby="daily-title">
        <div className="band-heading">
          <div><span className="index-number">02</span><div><h3 id="daily-title">UTC daily DAU</h3><p>Calendar-day unique qualifying FIDs · {range}</p></div></div>
          <p className="daily-note">Current day is partial</p>
        </div>
        <InteractiveChart id="daily-chart" series={series} variant="bars" />
        <div className="trend-pair">
          {[summary.sources.snapchain, summary.sources.hypersnap].map((metrics) => (
            <div key={metrics.source}>
              <span>{titleCase(metrics.source)} · 7d average</span>
              <strong>{exact(metrics.trend.currentSevenDayAverage)}</strong>
              <small className={`trend-${metrics.trend.label.toLowerCase().replaceAll(" ", "-")}`}>{metrics.trend.label} · {percent(metrics.trend.percentChange)}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="split-analysis">
        <div className="analysis-half action-half">
          <div className="band-heading compact-heading"><div><span className="index-number">03</span><div><h3>Qualifying action mix</h3><p>Exact classified action totals</p></div></div></div>
          <ActionMix snapchain={summary.sources.snapchain} hypersnap={summary.sources.hypersnap} />
        </div>
        <div className="analysis-half freshness-half">
          <div className="band-heading compact-heading"><div><span className="index-number">04</span><div><h3>Freshness / latency</h3><p>Collector-to-dashboard delivery</p></div></div></div>
          <Freshness sources={summary.sources} now={now} />
        </div>
      </section>

      <section className="operations-band" aria-labelledby="operations-title">
        <div className="band-heading"><div><span className="index-number">05</span><div><h3 id="operations-title">Operational depth</h3><p>Expand only when diagnosis needs it</p></div></div></div>
        <SourceOperations metrics={summary.sources.snapchain} />
        <SourceOperations metrics={summary.sources.hypersnap} />
      </section>

      <section className="definitions-band" aria-labelledby="definitions-title">
        <div>
          <p className="section-kicker">Metric contract</p>
          <h3 id="definitions-title">Definitions, not vibes.</h3>
          <p>UTC is the time authority. Successful user-originated canonical message merges qualify; replay, pruning, failures, maintenance, and block confirmation alone do not.</p>
        </div>
        <dl className="definitions-list">
          <div><dt>Rolling 24h active</dt><dd>Unique valid FIDs in (now − 24h, now]. Compared with the immediately preceding 24h.</dd></div>
          <div><dt>Today UTC DAU</dt><dd>Unique qualifying FIDs since 00:00 UTC. This is a calendar-day metric, not rolling 24h.</dd></div>
          <div><dt>30d active</dt><dd>Unique qualifying FIDs in (now − 30 days, now]. It is deliberately not labelled “30d DAU.”</dd></div>
          <div><dt>Hypersnap observed</dt><dd>When marked Derived, inferred from Hyper-eligible canonical merges observed by the Hypersnap node.</dd></div>
          <div><dt>Trend</dt><dd>Current seven-day average versus the preceding seven days, supported by a 30-day least-squares slope.</dd></div>
          <div><dt>Quality</dt><dd>Combines source mode, shard and 30-day history coverage, freshness, synchronization, and reconciliation health.</dd></div>
        </dl>
      </section>

      {(summary.warnings.length > 0 || summary.sources.hypersnap.caveat) && (
        <aside className="quality-notes" aria-label="Data quality notes">
          <strong>Source notes</strong>
          <ul>
            {summary.sources.hypersnap.caveat && <li>{summary.sources.hypersnap.caveat}</li>}
            {summary.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </aside>
      )}

      <footer className="dashboard-footer">
        <span className="wordmark" aria-label="SnapMeter">SNAP<span>METER</span></span>
        <p>Generated {new Date(summary.generatedAtMs).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "medium" })} UTC · Browser-local time is supplementary only.</p>
      </footer>
    </main>
  );
}
