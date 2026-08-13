import type { Source, SourceMode } from "@snapmeter/contracts";
import type { ActivityRecord } from "@snapmeter/metrics";
import { normalizeMergeEvent, type RawHubEvent } from "./rpc";

/**
 * Stable boundary between collection and source evidence. A future dedicated
 * Hyper-write receipt stream implements this contract without changing metric
 * storage, delivery, or the dashboard.
 */
export interface ActivitySourceAdapter<Event = RawHubEvent> {
  readonly source: Source;
  readonly mode: SourceMode;
  readonly evidence: string;
  normalize(event: Event, receivedAtMs: number, isReplay: boolean): ActivityRecord | null;
}

export class SnapchainVerifiedAdapter implements ActivitySourceAdapter {
  readonly source = "snapchain" as const;
  readonly mode = "verified" as const;
  readonly evidence = "canonical-successful-merge";

  normalize(event: RawHubEvent, receivedAtMs: number, isReplay: boolean): ActivityRecord | null {
    return normalizeMergeEvent(event, this.source, this.mode, receivedAtMs, isReplay);
  }
}

export class HypersnapDerivedAdapter implements ActivitySourceAdapter {
  readonly source = "hypersnap" as const;
  readonly mode = "derived" as const;
  readonly evidence = "hyper-eligible-canonical-merge-observed";

  normalize(event: RawHubEvent, receivedAtMs: number, isReplay: boolean): ActivityRecord | null {
    return normalizeMergeEvent(event, this.source, this.mode, receivedAtMs, isReplay);
  }
}

export class UnavailableSourceAdapter implements ActivitySourceAdapter {
  readonly mode = "unavailable" as const;
  readonly evidence = "no-trustworthy-source";

  constructor(readonly source: Source) {}

  normalize(_event: RawHubEvent, _receivedAtMs: number, _isReplay: boolean): null {
    return null;
  }
}
