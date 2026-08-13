import { describe, expect, it } from "vitest";
import { CollectorDatabase, compareEventIds } from "./database.js";
import type { ActivityRecord } from "@snapmeter/metrics";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const NOW = Date.UTC(2026, 7, 13, 12);

function action(source: "snapchain" | "hypersnap", fid: string, eventId: string, actionAtMs = NOW): ActivityRecord {
  return {
    eventKey: `0:${eventId}`,
    source,
    sourceMode: source === "snapchain" ? "verified" : "derived",
    fid,
    action: "cast",
    actionAtMs,
    receivedAtMs: NOW + 500,
    isReplay: false
  };
}

function record(database: CollectorDatabase, activity: ActivityRecord, eventId: string, shard = 0) {
  return database.recordEvent({ source: activity.source, shard, eventId, eventType: "MERGE_MESSAGE", receivedAtMs: activity.receivedAtMs, activity });
}

describe("collector SQLite state", () => {
  it("deduplicates events and maintains actor-day/minute membership", () => {
    const database = new CollectorDatabase(":memory:");
    try {
      expect(record(database, action("snapchain", "10", "100"), "100")).toEqual({ duplicate: false, actionInserted: true });
      expect(record(database, action("snapchain", "10", "100"), "100")).toEqual({ duplicate: true, actionInserted: false });
      record(database, action("snapchain", "10", "101"), "101");
      record(database, action("snapchain", "11", "102"), "102");
      expect(database.status()).toMatchObject({ actions: 3, dedupeEvents: 3, actorDays: 2, minuteBuckets: 1 });
      expect(database.pendingMinuteBuckets(NOW + 60_000)[0]).toMatchObject({ actions: 3, uniqueFids: 2 });
      expect(database.integrityCheck()).toBe("ok");
    } finally {
      database.close();
    }
  });

  it("never regresses a durable cursor under out-of-order input", () => {
    const database = new CollectorDatabase(":memory:");
    try {
      expect(database.checkpointCursor("snapchain", 7, "18446744073709551615", NOW)).toBe(true);
      expect(database.checkpointCursor("snapchain", 7, "999", NOW + 1)).toBe(false);
      expect(database.getCursor("snapchain", 7)).toBe("18446744073709551615");
      expect(compareEventIds("100000000000000000000", "99999999999999999999")).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it("computes exact local rolling source intersection and union", () => {
    const database = new CollectorDatabase(":memory:");
    try {
      record(database, action("snapchain", "1", "1"), "1");
      record(database, action("snapchain", "2", "2"), "2");
      record(database, action("hypersnap", "2", "3"), "3");
      record(database, action("hypersnap", "3", "4"), "4");
      const sets = database.activeFidComparison(NOW - 86_400_000, NOW);
      expect([...sets.overlap]).toEqual(["2"]);
      expect(sets.union.size).toBe(3);
    } finally {
      database.close();
    }
  });

  it("retains at least 31 days and removes older bounded state", () => {
    const database = new CollectorDatabase(":memory:");
    try {
      record(database, action("snapchain", "1", "1", NOW - 34 * 86_400_000), "1");
      record(database, action("snapchain", "2", "2", NOW - 10 * 86_400_000), "2");
      database.cleanup(NOW, 31);
      expect(database.loadActions("snapchain", 0).map((item) => item.fid)).toEqual(["2"]);
    } finally {
      database.close();
    }
  });

  it("recovers dedupe state, actions, cursor, and outbox after a SQLite restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "snapmeter-collector-test-"));
    const path = join(directory, "state.sqlite3");
    try {
      const first = new CollectorDatabase(path);
      const firstCollectorId = first.collectorId;
      record(first, action("snapchain", "42", "500"), "500", 9);
      first.checkpointCursor("snapchain", 9, "500", NOW);
      first.recordHistoryCoverage("snapchain", 9, NOW - 31 * 86_400_000);
      first.close();

      const second = new CollectorDatabase(path);
      try {
        expect(second.collectorId).toBe(firstCollectorId);
        expect(second.getCursor("snapchain", 9)).toBe("500");
        expect(second.historyCoverageStart("snapchain", [9], 1)).toBe(NOW - 31 * 86_400_000);
        expect(record(second, action("snapchain", "42", "500"), "500", 9).duplicate).toBe(true);
        expect(second.loadActions("snapchain", 0)).toHaveLength(1);
      } finally {
        second.close();
      }
    } finally {
      const resolved = resolve(directory);
      if (resolved.startsWith(resolve(tmpdir()))) rmSync(resolved, { recursive: true, force: true });
    }
  });

  it("requires coverage from every discovered and expected data shard", () => {
    const database = new CollectorDatabase(":memory:");
    try {
      const oldEnough = NOW - 40 * 86_400_000;
      const tooRecent = NOW - 2 * 86_400_000;
      database.recordHistoryCoverage("snapchain", 1, oldEnough);
      expect(database.historyCoverageStart("snapchain", [1, 2], 2)).toBeNull();
      database.recordHistoryCoverage("snapchain", 2, tooRecent);
      expect(database.historyCoverageStart("snapchain", [1, 2], 2)).toBe(tooRecent);
      database.recordHistoryCoverage("snapchain", 2, NOW - 31 * 86_400_000);
      expect(database.historyCoverageStart("snapchain", [1, 2], 2)).toBe(NOW - 31 * 86_400_000);
      expect(database.historyCoverageStart("snapchain", [1], 2)).toBeNull();
      expect(database.historyCoverageStart("hypersnap", [1, 2], 2)).toBeNull();
      expect(() => database.recordHistoryCoverage("snapchain", 0, oldEnough)).toThrow(/positive data shard/);
    } finally {
      database.close();
    }
  });

  it("migrates a version-1 database without losing existing collector state", () => {
    const directory = mkdtempSync(join(tmpdir(), "snapmeter-migration-test-"));
    const path = join(directory, "state.sqlite3");
    try {
      const seeded = new CollectorDatabase(path);
      record(seeded, action("snapchain", "77", "700"), "700", 3);
      seeded.checkpointCursor("snapchain", 3, "700", NOW);
      seeded.close();

      const legacy = new DatabaseSync(path);
      legacy.exec("DROP TABLE history_coverage; DELETE FROM schema_migrations WHERE version = 2;");
      legacy.close();

      const upgraded = new CollectorDatabase(path);
      try {
        expect(upgraded.status().schemaVersion).toBe(2);
        expect(upgraded.loadActions("snapchain", 0).map((item) => item.fid)).toEqual(["77"]);
        expect(upgraded.getCursor("snapchain", 3)).toBe("700");
        upgraded.recordHistoryCoverage("snapchain", 3, NOW - 31 * 86_400_000);
        expect(upgraded.historyCoverageStart("snapchain", [3], 1)).toBe(NOW - 31 * 86_400_000);
      } finally {
        upgraded.close();
      }
    } finally {
      const resolved = resolve(directory);
      if (resolved.startsWith(resolve(tmpdir()))) rmSync(resolved, { recursive: true, force: true });
    }
  });
});
