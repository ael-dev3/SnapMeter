import { Analytics } from "./components/Analytics";
import { ProtocolPanel } from "./components/ProtocolPanel";
import { MiniAppProvider } from "./farcaster";
import { useLiveMetrics } from "./hooks/useLiveMetrics";

function TransportNotice({
  transport,
  error,
  retry
}: {
  transport: ReturnType<typeof useLiveMetrics>["transport"];
  error: string | null;
  retry: () => void;
}): React.JSX.Element | null {
  if (!["offline", "error", "reconnecting"].includes(transport)) return null;
  const message = transport === "offline"
    ? "Browser offline — showing the last trustworthy snapshot. Live pulses are paused."
    : transport === "reconnecting"
      ? "Live stream interrupted — reconnecting with backoff."
      : `Server data unavailable${error ? ` — ${error}` : "."}`;
  return (
    <div className={`transport-notice notice-${transport}`} role={transport === "error" ? "alert" : "status"}>
      <span className="status-shape" aria-hidden="true" />
      <p>{message}</p>
      {transport === "error" && <button type="button" onClick={retry}>Retry</button>}
    </div>
  );
}

function Dashboard(): React.JSX.Element {
  const { summary, transport, pulses, error, now, retry, demo } = useLiveMetrics();
  return (
    <>
      <a className="skip-link" href="#analytics">Skip live overview</a>
      {demo && (
        <div className="demo-ribbon" role="status">
          <strong>DEMO</strong><span>Seeded synthetic data · never a production fallback</span>
        </div>
      )}
      <div className="hero-grid" data-testid="hero-grid">
        <ProtocolPanel
          source="snapchain"
          metrics={summary?.sources.snapchain ?? null}
          transport={transport}
          pulse={pulses.snapchain}
          now={now}
          demo={demo}
        />
        <ProtocolPanel
          source="hypersnap"
          metrics={summary?.sources.hypersnap ?? null}
          transport={transport}
          pulse={pulses.hypersnap}
          now={now}
          demo={demo}
        />
        <a className="depth-cue" href="#analytics" aria-label="Open historical analytics"><span>History</span><i aria-hidden="true" /></a>
      </div>
      {summary ? (
        <Analytics summary={summary} now={now} />
      ) : (
        <main className="analytics unavailable" id="analytics">
          <p className="section-kicker">History / comparison</p>
          <h2>{transport === "loading" || transport === "connecting" ? "Hydrating exact windows…" : "No trustworthy dataset available"}</h2>
          <p>{error ?? "SnapMeter is waiting for the first validated server snapshot. Synthetic values are never substituted."}</p>
          {transport === "error" && <button className="primary-action" type="button" onClick={retry}>Retry summary</button>}
        </main>
      )}
      <TransportNotice transport={transport} error={error} retry={retry} />
    </>
  );
}

export default function App(): React.JSX.Element {
  return (
    <MiniAppProvider>
      <Dashboard />
    </MiniAppProvider>
  );
}
