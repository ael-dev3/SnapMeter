import { describe, expect, it } from "vitest";
import { HYPERSNAP_CLASSIFIER_VERSION, MESSAGE_TYPES, actionFamilyForMessage, isHyperEligible, isSnapchainQualifying } from "./classifier";
import { FARCASTER_EPOCH_MS, normalizeMergeEvent } from "./rpc";

describe("Hyper eligibility classifier", () => {
  it("is versioned to the inspected Hypersnap source", () => {
    expect(HYPERSNAP_CLASSIFIER_VERSION).toMatch(/^2eee4c9f2a78/);
  });

  it.each([
    MESSAGE_TYPES.CAST_ADD,
    MESSAGE_TYPES.CAST_REMOVE,
    MESSAGE_TYPES.LINK_ADD,
    MESSAGE_TYPES.LINK_REMOVE,
    MESSAGE_TYPES.LINK_COMPACT_STATE,
    MESSAGE_TYPES.REACTION_ADD,
    MESSAGE_TYPES.REACTION_REMOVE,
    MESSAGE_TYPES.USER_DATA_ADD,
    MESSAGE_TYPES.VERIFICATION_ADD_ETH_ADDRESS,
    MESSAGE_TYPES.VERIFICATION_REMOVE,
    MESSAGE_TYPES.USERNAME_PROOF,
    MESSAGE_TYPES.LEND_STORAGE
  ])("accepts Hyper shadow-store type %s", (type) => expect(isHyperEligible(type)).toBe(true));

  it.each([MESSAGE_TYPES.FRAME_ACTION, MESSAGE_TYPES.KEY_ADD, MESSAGE_TYPES.KEY_REMOVE, MESSAGE_TYPES.CHANNEL_UPDATE])(
    "rejects unsupported Hyper shadow-store type %s",
    (type) => expect(isHyperEligible(type)).toBe(false)
  );

  it("keeps the canonical allowlist closed to unknown future types", () => {
    expect(isSnapchainQualifying(MESSAGE_TYPES.FRAME_ACTION)).toBe(true);
    expect(actionFamilyForMessage(MESSAGE_TYPES.FRAME_ACTION)).toBe("other");
    expect(isSnapchainQualifying(999)).toBe(false);
    expect(actionFamilyForMessage(999)).toBeNull();
  });
});

describe("canonical event normalization", () => {
  const base = {
    type: "HUB_EVENT_TYPE_MERGE_MESSAGE",
    id: "99",
    shardIndex: 2,
    timestamp: "100",
    mergeMessageBody: { message: { data: { type: "MESSAGE_TYPE_CAST_ADD", fid: "42", timestamp: "90" } } }
  };

  it("uses confirmed HubEvent time ahead of message time", () => {
    const normalized = normalizeMergeEvent(base, "snapchain", "verified", FARCASTER_EPOCH_MS + 101_000, false);
    expect(normalized?.actionAtMs).toBe(FARCASTER_EPOCH_MS + 100_000);
    expect(normalized?.eventKey).toBe("2:99");
    expect(actionFamilyForMessage("MESSAGE_TYPE_CAST_ADD")).toBe("cast");
  });

  it("derives only eligible Hypersnap observations", () => {
    expect(normalizeMergeEvent(base, "hypersnap", "derived", FARCASTER_EPOCH_MS + 101_000, false)).not.toBeNull();
    expect(normalizeMergeEvent({ ...base, mergeMessageBody: { message: { data: { type: MESSAGE_TYPES.KEY_ADD, fid: "42", timestamp: "90" } } } }, "hypersnap", "derived", FARCASTER_EPOCH_MS + 101_000, false)).toBeNull();
  });

  it("rejects failures, maintenance, and missing FIDs", () => {
    expect(normalizeMergeEvent({ ...base, type: "HUB_EVENT_TYPE_MERGE_FAILURE" }, "snapchain", "verified", 1, false)).toBeNull();
    expect(normalizeMergeEvent({ ...base, mergeMessageBody: { message: { data: { type: 1, fid: "0", timestamp: 90 } } } }, "snapchain", "verified", 1, false)).toBeNull();
  });
});
