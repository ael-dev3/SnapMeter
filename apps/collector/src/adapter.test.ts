import { describe, expect, it } from "vitest";
import { FARCASTER_EPOCH_MS, HYPERSNAP_UPSTREAM_SHA } from "@snapmeter/protocol";
import { defaultActivityAdapterFactory } from "./adapter.js";

describe("source activity adapters", () => {
  it("pins derived Hypersnap classification and filters non-Hyper message families", () => {
    const adapter = defaultActivityAdapterFactory("hypersnap", "derived");
    const timestamp = Math.floor((Date.now() - FARCASTER_EPOCH_MS) / 1_000);
    expect(adapter.version).toContain(HYPERSNAP_UPSTREAM_SHA);
    expect(adapter.normalize({
      id: "1",
      shardIndex: 1,
      type: "HUB_EVENT_TYPE_MERGE_MESSAGE",
      timestamp,
      mergeMessageBody: { message: { data: { type: "MESSAGE_TYPE_CAST_ADD", fid: "1", timestamp, network: "FARCASTER_NETWORK_MAINNET" } } }
    }, Date.now(), false)?.action).toBe("cast");
    expect(adapter.normalize({
      id: "2",
      shardIndex: 1,
      type: "HUB_EVENT_TYPE_MERGE_MESSAGE",
      timestamp,
      mergeMessageBody: { message: { data: { type: "MESSAGE_TYPE_CHANNEL_UPDATE", fid: "1", timestamp, network: 1 } } }
    }, Date.now(), false)).toBeNull();
  });

  it("cannot silently construct a verified Hypersnap adapter", () => {
    expect(() => defaultActivityAdapterFactory("hypersnap", "verified")).toThrow(/not implemented/);
  });

  it("rejects invalid FIDs and unknown message families before local aggregation", () => {
    const adapter = defaultActivityAdapterFactory("snapchain", "verified");
    const timestamp = Math.floor((Date.now() - FARCASTER_EPOCH_MS) / 1_000);
    const event = (fid: string, type: number) => ({
      id: "9",
      shardIndex: 1,
      type: "HUB_EVENT_TYPE_MERGE_MESSAGE",
      timestamp,
      mergeMessageBody: { message: { data: { type, fid, timestamp } } }
    });
    expect(adapter.normalize(event("4294967296", 1), Date.now(), false)).toBeNull();
    expect(adapter.normalize(event("1", 999), Date.now(), false)).toBeNull();
    expect(adapter.normalize(event("1", 13), Date.now(), false)?.action).toBe("other");
  });
});
