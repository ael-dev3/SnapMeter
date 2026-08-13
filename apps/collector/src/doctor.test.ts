import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { verifyIngestSignature, type IngestBatch } from "@snapmeter/contracts";
import { loadConfig } from "./config.js";
import { CollectorDatabase } from "./database.js";
import { runDoctor } from "./doctor.js";
import type { CollectorRpc, RpcFactory } from "./rpc.js";

describe("collector doctor", () => {
  it("checks dynamic shards, protocol, SQLite, disk, cloud authentication, cursor coverage, clocks, and modes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "snapmeter-doctor-test-"));
    const secret = "doctor-private-ingest-secret-for-tests";
    const now = Date.UTC(2026, 7, 13, 12);
    const config = loadConfig({
      SNAPMETER_DATA_DIR: directory,
      HYPERSNAP_SOURCE_MODE: "unavailable",
      SNAPMETER_INGEST_URL: "https://example.test/api/v1/ingest/batch",
      SNAPMETER_INGEST_SECRET: secret,
      SNAPMETER_MIN_FREE_DISK_BYTES: "1"
    });
    const database = new CollectorDatabase(config.databasePath);
    database.checkpointCursor("snapchain", 8, "10", now);
    const rpcFactory: RpcFactory = () => fakeRpc();
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body);
      const batch = JSON.parse(body) as IngestBatch;
      expect(headers.get("x-snapmeter-doctor")).toBe("1");
      await expect(verifyIngestSignature(
        secret,
        headers.get("x-snapmeter-timestamp") as string,
        batch.batchId,
        body,
        headers.get("x-snapmeter-signature") as string
      )).resolves.toBe(true);
      expect(batch.comparisonSnapshots).toEqual([]);
      return Response.json({ ok: true, authenticated: true, serverTimeMs: now }, { headers: { date: new Date(now).toUTCString() } });
    });
    try {
      const report = await runDoctor({ config, database, rpcFactory, fetcher, now: () => now });
      expect(report.ok).toBe(true);
      expect(report.checks.find((check) => check.name === "snapchain.rpc")).toMatchObject({ status: "pass" });
      expect(report.checks.find((check) => check.name === "snapchain.protocol")).toMatchObject({ status: "pass" });
      expect(report.checks.find((check) => check.name === "snapchain.cursor-point")).toMatchObject({ status: "pass" });
      expect(report.checks.find((check) => check.name === "snapchain.shards")).toMatchObject({ status: "pass" });
      expect(report.checks.find((check) => check.name === "hypersnap.mode")).toMatchObject({ status: "warn" });
      expect(report.checks.find((check) => check.name === "hypersnap.rpc")).toMatchObject({ status: "skipped" });
      expect(report.checks.find((check) => check.name === "database")).toMatchObject({ status: "pass" });
      expect(report.checks.find((check) => check.name === "disk")).toMatchObject({ status: "pass" });
      expect(report.checks.find((check) => check.name === "cursors")).toMatchObject({ status: "pass" });
      expect(report.checks.find((check) => check.name === "cloud.auth")).toMatchObject({ status: "pass" });
      expect(report.checks.find((check) => check.name === "clock")).toMatchObject({ status: "pass" });
    } finally {
      database.close();
      const resolved = resolve(directory);
      if (resolved.startsWith(resolve(tmpdir()))) rmSync(resolved, { recursive: true, force: true });
    }
  });
});

function fakeRpc(): CollectorRpc {
  return {
    getInfo: async () => ({
      version: "fake-compatible/1",
      numShards: 1,
      shardInfos: [{ shardId: 8, maxHeight: 20, blockDelay: 0, mempoolSize: 0 }]
    }),
    getEvent: async () => ({ id: "10" }),
    getEvents: async () => ({ events: [] }),
    subscribe: () => ({ cancel() {}, done: Promise.resolve() }),
    close() {}
  };
}
