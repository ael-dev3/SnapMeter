import { describe, expect, it, vi } from "vitest";
import { verifyIngestSignature, type IngestBatch } from "@snapmeter/contracts";
import { DAY_MS, type ActivityRecord } from "@snapmeter/metrics";
import { loadConfig } from "./config.js";
import { CollectorDatabase } from "./database.js";
import {
  MAX_BATCH_RECORDS,
  OutboxDispatcher,
  PulseAccumulator,
  buildComparisonSnapshot,
  buildMetricSnapshot,
  enqueueIngestBatch,
  hashFid
} from "./delivery.js";
import { createLogger } from "./logger.js";

const NOW = Date.UTC(2026, 7, 13, 12);
const SECRET = "a-long-private-ingest-secret-for-tests";

function config() {
  return loadConfig({
    LOCALAPPDATA: "C:\\tmp",
    SNAPMETER_INGEST_URL: "https://example.test/api/v1/ingest/batch",
    SNAPMETER_INGEST_SECRET: SECRET
  });
}

function action(source: "snapchain" | "hypersnap", fid: string, eventId: string): ActivityRecord {
  return {
    eventKey: `0:${eventId}`,
    source,
    sourceMode: source === "snapchain" ? "verified" : "derived",
    fid,
    action: "cast",
    actionAtMs: NOW - 1_000,
    receivedAtMs: NOW,
    isReplay: false
  };
}

function record(database: CollectorDatabase, activity: ActivityRecord, eventId: string) {
  database.recordEvent({ source: activity.source, shard: 0, eventId, eventType: "MERGE_MESSAGE", receivedAtMs: activity.receivedAtMs, activity });
}

describe("pulse and batch delivery", () => {
  it("coalesces live activity without exposing FIDs", () => {
    const accumulator = new PulseAccumulator();
    accumulator.add({ activity: action("snapchain", "1", "10"), eventId: "10" });
    accumulator.add({ activity: action("snapchain", "1", "11"), eventId: "11" });
    const packet = accumulator.drain(NOW + 250)[0];
    expect(packet).toMatchObject({ eventCount: 2, uniqueFids: 1, maxEventId: "11", isReplay: false });
    expect(JSON.stringify(packet)).not.toContain('"fid"');
  });

  it("HMAC-hashes actor IDs deterministically across sources and separates keys", () => {
    expect(hashFid(SECRET, "123")).toBe(hashFid(SECRET, "123"));
    expect(hashFid(SECRET, "123")).not.toBe(hashFid("different-secret", "123"));
    expect(hashFid(SECRET, "123")).not.toContain("123");
    expect(hashFid(SECRET, "123")).toHaveLength(64);
  });

  it("builds an exact overlap comparison and stays under the Worker record budget", () => {
    const database = new CollectorDatabase(":memory:");
    try {
      record(database, action("snapchain", "1", "1"), "1");
      record(database, action("snapchain", "2", "2"), "2");
      record(database, action("hypersnap", "2", "3"), "3");
      const snapshots = [
        buildMetricSnapshot(database, config(), "snapchain", NOW),
        buildMetricSnapshot(database, config(), "hypersnap", NOW)
      ];
      const comparison = buildComparisonSnapshot(database, snapshots, NOW);
      expect(comparison).toMatchObject({ overlap24h: 1, overlapPercent: 50, eligibleActionCoveragePercent: 50 });
      const batch = enqueueIngestBatch(database, config(), { snapshots, comparisonSnapshots: [comparison] }, NOW);
      expect(batch).not.toBeNull();
      const recordCount = (batch as IngestBatch).snapshots.length + (batch as IngestBatch).comparisonSnapshots.length +
        (batch as IngestBatch).minuteBuckets.length + (batch as IngestBatch).actorDays.length +
        (batch as IngestBatch).cursors.length + (batch as IngestBatch).health.length;
      expect(recordCount).toBeLessThanOrEqual(MAX_BATCH_RECORDS);
      expect((batch as IngestBatch).actorDays.every((row) => row.fidHash.length === 64)).toBe(true);
    } finally {
      database.close();
    }
  });

  it("keeps failed batches durable and signs retries before acknowledging", async () => {
    const database = new CollectorDatabase(":memory:");
    try {
      record(database, action("snapchain", "9", "9"), "9");
      const batch = enqueueIngestBatch(database, config(), {}, NOW);
      expect(batch).not.toBeNull();
      let calls = 0;
      const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) return new Response("temporary", { status: 503 });
        const headers = new Headers(init?.headers);
        const timestamp = headers.get("x-snapmeter-timestamp") as string;
        const nonce = headers.get("x-snapmeter-nonce") as string;
        const signature = headers.get("x-snapmeter-signature") as string;
        const body = String(init?.body);
        expect(nonce).toBe(batch?.batchId);
        await expect(verifyIngestSignature(SECRET, timestamp, nonce, body, signature)).resolves.toBe(true);
        return Response.json({ ok: true, batchId: nonce, duplicate: false, acceptedAtMs: NOW + 10_000 });
      });
      let now = NOW;
      const dispatcher = new OutboxDispatcher(database, config(), createLogger({ write() {} }), fetcher, () => now, () => 0.5);
      await expect(dispatcher.drainOnce()).resolves.toEqual({ acknowledged: 0, failed: 1 });
      expect(database.status().pendingOutbox).toBe(1);
      now += 2_000;
      await expect(dispatcher.drainOnce()).resolves.toEqual({ acknowledged: 1, failed: 0 });
      expect(database.status().pendingOutbox).toBe(0);
      expect(database.status().lastCloudAckAtMs).toBe(NOW + 10_000);
    } finally {
      database.close();
    }
  });

  it("builds metrics from at least 31 days of local reconstruction", () => {
    const database = new CollectorDatabase(":memory:");
    try {
      record(database, { ...action("snapchain", "7", "1"), actionAtMs: NOW - 30 * DAY_MS + 1 }, "1");
      expect(buildMetricSnapshot(database, config(), "snapchain", NOW).rolling30d).toBe(1);
    } finally {
      database.close();
    }
  });

  it("reports partial history until authoritative coverage reaches 30 days", () => {
    const database = new CollectorDatabase(":memory:");
    try {
      database.upsertSourceHealth({
        source: "snapchain",
        sourceMode: "verified",
        status: "partial",
        observedAtMs: NOW,
        node: {
          version: "test",
          shardCount: 1,
          coveredShards: 1,
          height: 1,
          blockDelaySeconds: 0,
          mempoolSize: null,
          synchronized: true,
          reconnectCount: 0,
          reconciliationState: "ok",
          clockSkewMs: null,
          historyCoverageStartMs: NOW - DAY_MS,
          historyComplete: false
        },
        message: null
      });
      const partial = buildMetricSnapshot(database, config(), "snapchain", NOW);
      expect(partial).toMatchObject({ status: "partial", quality: "degraded" });
      expect(partial.caveat).toMatch(/history are partial/);

      database.upsertSourceHealth({
        ...database.sourceHealth("snapchain")[0]!,
        node: {
          ...database.sourceHealth("snapchain")[0]!.node,
          historyCoverageStartMs: NOW - 31 * DAY_MS,
          historyComplete: true
        },
        status: "live"
      });
      expect(buildMetricSnapshot(database, config(), "snapchain", NOW)).toMatchObject({ status: "live", quality: "high" });
    } finally {
      database.close();
    }
  });
});
