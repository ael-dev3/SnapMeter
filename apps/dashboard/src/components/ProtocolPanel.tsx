import type { Source, SourceMetrics } from "@snapmeter/contracts";
import type { PulseState, TransportState } from "../hooks/useLiveMetrics";
import { ageFrom, compact, exact, percent, signed, titleCase } from "../lib/format";
import { HeartbeatCanvas } from "./HeartbeatCanvas";
import { InfoTip } from "./InfoTip";

function effectiveStatus(metrics: SourceMetrics | null, transport: TransportState): string {
  if (transport === "offline") return "browser offline";
  if (transport === "error") return "server error";
  if (transport === "loading") return "loading";
  if (transport === "connecting") return "connecting";
  if (transport === "reconnecting") return "reconnecting";
  return metrics?.status ?? "disconnected";
}

function statusTone(status: string): string {
  if (["live", "demo"].includes(status)) return "good";
  if (["derived", "replaying", "reconnecting", "connecting", "loading"].includes(status)) return "warn";
  if (["stale", "partial", "empty"].includes(status)) return "stale";
  return "bad";
}

export function ProtocolPanel({
  source,
  metrics,
  transport,
  pulse,
  now,
  demo
}: {
  source: Source;
  metrics: SourceMetrics | null;
  transport: TransportState;
  pulse: PulseState;
  now: number;
  demo: boolean;
}): React.JSX.Element {
  const isSnapchain = source === "snapchain";
  const name = isSnapchain ? "Snapchain" : "Hypersnap";
  const status = effectiveStatus(metrics, transport);
  const changeDirection = (metrics?.changeAbsolute ?? 0) > 0 ? "up" : (metrics?.changeAbsolute ?? 0) < 0 ? "down" : "flat";
  const medianPosition = metrics && metrics.dailyMedian30d > 0
    ? Math.min(100, Math.round((metrics.todayUtc / metrics.dailyMedian30d) * 100))
    : 0;

  return (
    <section
      className={`protocol-panel protocol-${source}`}
      data-testid={`panel-${source}`}
      data-status={status}
      aria-labelledby={`${source}-title`}
    >
      {pulse.id > 0 && <div className="panel-glow" aria-hidden="true" key={pulse.id} />}
      <header className="protocol-head">
        <div>
          <p className="eyebrow">{isSnapchain ? "Canonical activity" : "Hyper-eligible activity"}</p>
          <h1 id={`${source}-title`}>{name}</h1>
        </div>
        <div className="badge-stack">
          {isSnapchain && <span className="wordmark" aria-label="SnapMeter">SNAP<span>METER</span></span>}
          <span className={`status-badge tone-${statusTone(status)}`}>
            <span className="status-shape" aria-hidden="true" />{titleCase(status)}
          </span>
          {metrics && (
            <span className={`mode-badge mode-${metrics.sourceMode}`}>
              {titleCase(metrics.sourceMode)}
              {metrics.sourceMode === "derived" && (
                <InfoTip label="What derived Hypersnap activity means">
                  Inferred from Hyper-eligible canonical merges observed by the Hypersnap node. This is not an independently verified Hyper write stream.
                </InfoTip>
              )}
            </span>
          )}
        </div>
      </header>

      <div className="primary-metric">
        <div className="metric-number-wrap">
          <p className="metric-label">
            {metrics?.sourceMode === "derived" ? "Observed active FIDs · rolling 24h" : "Active FIDs · rolling 24h"}
            <InfoTip label="Define rolling 24 hour active FIDs">
              Exact unique valid FIDs with a qualifying successful user action in (now − 24 hours, now], in UTC.
            </InfoTip>
          </p>
          <div className={`metric-number ${metrics ? "" : "is-placeholder"}`} aria-label={metrics ? `${exact(metrics.rolling24h)} active FIDs` : "Activity unavailable"}>
            {metrics ? exact(metrics.rolling24h) : "—"}
          </div>
          <div className={`change-line change-${changeDirection}`}>
            {metrics ? (
              <>
                <span aria-hidden="true">{changeDirection === "up" ? "↗" : changeDirection === "down" ? "↘" : "→"}</span>
                <strong>{signed(metrics.changeAbsolute)}</strong>
                <span>{percent(metrics.changePercent)} vs prior 24h</span>
              </>
            ) : <span>{status === "loading" ? "Hydrating exact windows…" : "Waiting for a trustworthy source"}</span>}
          </div>
        </div>
        <div className="thirty-day">
          <span>30d active</span>
          <strong>{metrics ? compact(metrics.rolling30d) : "—"}</strong>
          <small>{metrics ? `${compact(metrics.todayUtc)} today UTC` : "No source data"}</small>
        </div>
      </div>

      <HeartbeatCanvas source={source} pulse={pulse} />

      <div className="compact-readouts">
        <div><span>Actions/min</span><strong>{metrics ? compact(metrics.actionsPerMinute1m) : "—"}</strong><small>1m</small></div>
        <div><span>Last action</span><strong>{metrics ? ageFrom(metrics.lastActionAtMs, now) : "—"}</strong><small>{metrics ? ageFrom(metrics.updatedAtMs, now) + " update" : "Unavailable"}</small></div>
        <div><span>7d trend</span><strong>{metrics?.trend.label ?? "—"}</strong><small>{metrics ? percent(metrics.trend.percentChange) : "No samples"}</small></div>
      </div>

      <div className="baseline-meter" aria-label={metrics ? `Today is ${medianPosition}% of the trailing 30-day daily median` : "Trailing baseline unavailable"}>
        <span>Today / 30d daily median</span>
        <div><i style={{ width: `${medianPosition}%` }} /></div>
        <strong>{metrics ? `${Math.round((metrics.todayUtc / Math.max(1, metrics.dailyMedian30d)) * 100)}%` : "—"}</strong>
      </div>

      {metrics?.status === "empty" && <p className="panel-notice">No qualifying actions observed in this window.</p>}
      {demo && !isSnapchain && <span className="demo-corner" aria-hidden="true">Seed 5A17</span>}
    </section>
  );
}
