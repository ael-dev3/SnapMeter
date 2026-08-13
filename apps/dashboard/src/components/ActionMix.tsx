import type { ActionFamily, SourceMetrics } from "@snapmeter/contracts";
import { exact, titleCase } from "../lib/format";

const FAMILIES: ActionFamily[] = ["cast", "reaction", "link", "verification", "user-data"];

export function ActionMix({ snapchain, hypersnap }: { snapchain: SourceMetrics; hypersnap: SourceMetrics }): React.JSX.Element {
  const maximum = Math.max(1, ...FAMILIES.flatMap((family) => [snapchain.actionCounts[family] ?? 0, hypersnap.actionCounts[family] ?? 0]));
  return (
    <div className="action-mix" role="group" aria-label="Qualifying action mix by source for the shared rolling 24 hour UTC window">
      <div className="mix-head" aria-hidden="true"><span>Action family</span><span>Snapchain</span><span>Hypersnap</span></div>
      {FAMILIES.map((family) => {
        const snap = snapchain.actionCounts[family] ?? 0;
        const hyper = hypersnap.actionCounts[family] ?? 0;
        return (
          <div className="mix-row" key={family}>
            <span>{titleCase(family)}</span>
            <button type="button" aria-label={`${titleCase(family)}, Snapchain, ${exact(snap)} actions in the rolling 24 hour window`}>
              <i className="snap-fill" style={{ width: `${(snap / maximum) * 100}%` }} />
              <b>{exact(snap)}</b>
            </button>
            <button type="button" aria-label={`${titleCase(family)}, Hypersnap, ${exact(hyper)} actions in the rolling 24 hour window`}>
              <i className="hyper-fill" style={{ width: `${(hyper / maximum) * 100}%` }} />
              <b>{exact(hyper)}</b>
            </button>
          </div>
        );
      })}
    </div>
  );
}
