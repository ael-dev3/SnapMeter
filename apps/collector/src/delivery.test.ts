import { describe, expect, it, vi } from "vitest";
import { verifyIngestSignature, type IngestBatch } from "@snapmeter/contracts";
import { DAY_MS, type ActivityRecord } from "@snapmeter/metrics";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.js";
import { CollectorDatabase } from "./database.js";
import {
  MAX_BATCH_RECORDS,
  OutboxDispatcher,
  PulseAccumulator,
  buildComparisonSnapshot,
  buildMetricSnapshot,
  enqueueIngestBatch
} from "./delivery.js";
import { createLogger } from "./logger.js";

const NOW = Date.UTC(2026, 7, 13, 12);
const SECRET = "a-long-private-ingest-secret-for-tests";

function config(ingestSecret = SECRET) {
  return loadConfig({
    LOCALAPPDATA: "C:\\tmp",
    SNAPMETER_INGEST_URL: "https://example.test/api/v1/ingest/batch",
    SNAPMETER_INGEST_SECRET: ingestSecret
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

  it("domain-separates local actor pseudonyms by source and UTC day", () => {
    const database = new CollectorDatabase(":memory:");
    try {
      const snapchain = database.actorDayPseudonym("snapchain", "2026-08-13", "123");
      expect(snapchain).toBe(database.actorDayPseudonym("snapchain", "2026-08-13", "123"));
      expect(snapchain).not.toBe(database.actorDayPseudonym("hypersnap", "2026-08-13", "123"));
      expect(snapchain).not.toBe(database.actorDayPseudonym("snapchain", "2026-08-14", "123"));
      expect(snapchain).not.toContain("123");
      expect(snapchain).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      database.close();
    }
  });

  it("keeps queued actor pseudonyms stable while retries use the rotated transport secret", async () => {
    const database = new CollectorDatabase(":memory:");
    try {
      record(database, action("snapchain", "123", "123"), "123");
      const day = "2026-08-13";
      const expected = database.actorDayPseudonym("snapchain", day, "123");
      const beforeSecret = "transport-secret-before-rotation-123";
      const afterSecret = "transport-secret-after-rotation-4567";
      const beforeRotation = enqueueIngestBatch(database, config(beforeSecret), {}, NOW);
      expect(beforeRotation?.actorDays).toContainEqual({ source: "snapchain", day, fidHash: expected });

      const rotated = config(afterSecret);
      expect(database.actorDayPseudonym("snapchain", day, "123")).toBe(expected);
      const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const timestamp = headers.get("x-snapmeter-timestamp") as string;
        const nonce = headers.get("x-snapmeter-nonce") as string;
        const signature = headers.get("x-snapmeter-signature") as string;
        const body = String(init?.body);
        expect(JSON.parse(body)).toMatchObject({
          actorDays: [{ source: "snapchain", day, fidHash: expected }]
        });
        await expect(verifyIngestSignature(afterSecret, timestamp, nonce, body, signature)).resolves.toBe(true);
        await expect(verifyIngestSignature(beforeSecret, timestamp, nonce, body, signature)).resolves.toBe(false);
        return Response.json({ ok: true, batchId: nonce, duplicate: false, acceptedAtMs: NOW + 1 });
      });
      const dispatcher = new OutboxDispatcher(
        database,
        rotated,
        createLogger({ write() {} }),
        fetcher,
        () => NOW,
        () => 0.5
      );
      await expect(dispatcher.drainOnce()).resolves.toEqual({ acknowledged: 1, failed: 0 });
    } finally {
      database.close();
    }
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

  it("does not persist or log an untrusted ingest error body", async () => {
    const database = new CollectorDatabase(":memory:");
    try {
      const leaked = "Bearer should-never-be-stored";
      const lines: string[] = [];
      const batch = enqueueIngestBatch(database, config(), {}, NOW);
      expect(batch).not.toBeNull();
      const dispatcher = new OutboxDispatcher(
        database,
        config(),
        createLogger({ write: (line) => lines.push(line) }),
        async () => new Response(`upstream diagnostics ${leaked}`, { status: 503 }),
        () => NOW,
        () => 0.5
      );
      await expect(dispatcher.drainOnce()).resolves.toEqual({ acknowledged: 0, failed: 1 });
      const stored = database.dueOutbox(NOW + 60_000)[0];
      expect(stored).toBeDefined();
      expect(stored?.lastError).toBe("ingest returned HTTP 503");
      expect(JSON.stringify(lines)).not.toContain(leaked);
    } finally {
      database.close();
    }
  });

  it("rejects oversized successful ingest acknowledgements", async () => {
    const database = new CollectorDatabase(":memory:");
    try {
      const batch = enqueueIngestBatch(database, config(), {}, NOW);
      expect(batch).not.toBeNull();
      const dispatcher = new OutboxDispatcher(
        database,
        config(),
        createLogger({ write() {} }),
        async () => new Response("x".repeat(16 * 1024 + 1), { status: 200 }),
        () => NOW,
        () => 0.5
      );
      await expect(dispatcher.drainOnce()).resolves.toEqual({ acknowledged: 0, failed: 1 });
      expect(database.status().pendingOutbox).toBe(1);
    } finally {
      database.close();
    }
  });

  it("never exposes the local pseudonym key through status, delivery, outbox, or logs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "snapmeter-key-exposure-test-"));
    const path = join(directory, "state.sqlite3");
    let database: CollectorDatabase | undefined = new CollectorDatabase(path);
    try {
      record(database, action("snapchain", "321", "321"), "321");
      const batch = enqueueIngestBatch(database, config(), {}, NOW);
      expect(batch).not.toBeNull();
      const lines: string[] = [];
      const dispatcher = new OutboxDispatcher(
        database,
        config(),
        createLogger({ write: (line) => lines.push(line) }),
        async () => new Response("untrusted failure body", { status: 503 }),
        () => NOW,
        () => 0.5
      );
      await expect(dispatcher.drainOnce()).resolves.toEqual({ acknowledged: 0, failed: 1 });
      const publicSurfaces = JSON.stringify({
        status: database.status(),
        batch,
        outbox: database.dueOutbox(Number.MAX_SAFE_INTEGER),
        logs: lines
      });
      expect(publicSurfaces).not.toContain("actor_pseudonym_key_v1");
      expect(publicSurfaces).not.toContain('"fid":"321"');

      database.close();
      database = undefined;
      const inspected = new DatabaseSync(path);
      const row = inspected.prepare(
        "SELECT value FROM collector_secrets WHERE name = 'actor_pseudonym_key_v1'"
      ).get() as { value: Uint8Array };
      inspected.close();
      expect(publicSurfaces).not.toContain(Buffer.from(row.value).toString("base64url"));
      expect(publicSurfaces).not.toContain(Buffer.from(row.value).toString("hex"));
    } finally {
      database?.close();
      const resolved = resolve(directory);
      if (resolved.startsWith(resolve(tmpdir()))) rmSync(resolved, { recursive: true, force: true });
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
