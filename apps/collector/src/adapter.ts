import type { Source, SourceMode } from "@snapmeter/contracts";
import { isValidFid, type ActivityRecord } from "@snapmeter/metrics";
import { HYPERSNAP_UPSTREAM_SHA, normalizeMergeEvent, type RawHubEvent } from "@snapmeter/protocol";

/**
 * Keeps source observation separate from transport. A future independently
 * verified Hyper-write feed can provide this interface without changing the
 * shard runtime, persistence model, metrics, or delivery contract.
 */
export interface SourceActivityAdapter {
  readonly source: Source;
  readonly sourceMode: SourceMode;
  readonly version: string;
  normalize(event: RawHubEvent, receivedAtMs: number, isReplay: boolean): ActivityRecord | null;
}

export type ActivityAdapterFactory = (source: Source, sourceMode: SourceMode) => SourceActivityAdapter;

export const defaultActivityAdapterFactory: ActivityAdapterFactory = (source, sourceMode) => {
  if (source === "hypersnap" && sourceMode === "verified") {
    throw new Error("a verified Hyper-write source adapter is not implemented");
  }
  return new CanonicalMergeActivityAdapter(source, sourceMode);
};

export class CanonicalMergeActivityAdapter implements SourceActivityAdapter {
  readonly version: string;

  constructor(readonly source: Source, readonly sourceMode: SourceMode) {
    this.version = source === "hypersnap" && sourceMode === "derived"
      ? `hypersnap-derived@${HYPERSNAP_UPSTREAM_SHA}`
      : "snapchain-canonical-v1";
  }

  normalize(event: RawHubEvent, receivedAtMs: number, isReplay: boolean): ActivityRecord | null {
    const activity = normalizeMergeEvent(event, this.source, this.sourceMode, receivedAtMs, isReplay);
    return activity && isValidFid(activity.fid) ? activity : null;
  }
}
