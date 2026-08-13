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
      const firstPseudonym = first.actorDayPseudonym("snapchain", "2026-08-13", "42");
      record(first, action("snapchain", "42", "500"), "500", 9);
      first.checkpointCursor("snapchain", 9, "500", NOW);
      first.recordHistoryCoverage("snapchain", 9, NOW - 31 * 86_400_000);
      first.close();

      const second = new CollectorDatabase(path);
      try {
        expect(second.collectorId).toBe(firstCollectorId);
        expect(second.actorDayPseudonym("snapchain", "2026-08-13", "42")).toBe(firstPseudonym);
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
      legacy.exec(`
        DROP TABLE history_coverage;
        DROP TABLE collector_secrets;
        DELETE FROM schema_migrations WHERE version >= 2;
        UPDATE collector_metadata SET value = '1' WHERE key = 'schema_version';
      `);
      legacy.close();

      const upgraded = new CollectorDatabase(path);
      try {
        expect(upgraded.status().schemaVersion).toBe(3);
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

  it("transactionally provisions a 32-byte local pseudonym key when upgrading version 2", () => {
    const directory = mkdtempSync(join(tmpdir(), "snapmeter-key-migration-test-"));
    const path = join(directory, "state.sqlite3");
    try {
      const seeded = new CollectorDatabase(path);
      seeded.close();

      const legacy = new DatabaseSync(path);
      legacy.exec(`
        DROP TABLE collector_secrets;
        DELETE FROM schema_migrations WHERE version = 3;
        UPDATE collector_metadata SET value = '2' WHERE key = 'schema_version';
      `);
      legacy.close();

      const upgraded = new CollectorDatabase(path);
      expect(upgraded.status().schemaVersion).toBe(3);
      expect(upgraded.actorDayPseudonym("snapchain", "2026-08-13", "77")).toMatch(/^[0-9a-f]{64}$/);
      expect(() => upgraded.setMetadata("actor_pseudonym_key_v1", "attacker-controlled"))
        .toThrow(/unsupported runtime metadata key/);
      upgraded.close();

      const inspected = new DatabaseSync(path);
      const row = inspected.prepare(
        "SELECT value FROM collector_secrets WHERE name = 'actor_pseudonym_key_v1'"
      ).get() as { value: Uint8Array };
      const migration = inspected.prepare("SELECT COUNT(*) AS total FROM schema_migrations WHERE version = 3")
        .get() as { total: number };
      inspected.close();
      expect(row.value).toBeInstanceOf(Uint8Array);
      expect(row.value).toHaveLength(32);
      expect(Number(migration.total)).toBe(1);
    } finally {
      const resolved = resolve(directory);
      if (resolved.startsWith(resolve(tmpdir()))) rmSync(resolved, { recursive: true, force: true });
    }
  });

  it("provisions a distinct pseudonym key for each independently initialized database", () => {
    const left = new CollectorDatabase(":memory:");
    const right = new CollectorDatabase(":memory:");
    try {
      expect(left.actorDayPseudonym("snapchain", "2026-08-13", "77"))
        .not.toBe(right.actorDayPseudonym("snapchain", "2026-08-13", "77"));
    } finally {
      left.close();
      right.close();
    }
  });

  it("preserves version-2 queued actor state and outbox bytes across the key migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "snapmeter-key-outbox-migration-test-"));
    const path = join(directory, "state.sqlite3");
    const payload = JSON.stringify({ schemaVersion: 1, batchId: "frozen-version-2-payload", actorDays: [{ fidHash: "a".repeat(64) }] });
    try {
      const seeded = new CollectorDatabase(path);
      record(seeded, action("snapchain", "99", "999"), "999", 2);
      seeded.close();

      const legacy = new DatabaseSync(path);
      legacy.prepare("INSERT INTO outbox(batch_id, payload_json, created_at_ms, next_attempt_at_ms) VALUES (?, ?, ?, ?)")
        .run("frozen-version-2-payload", payload, NOW, NOW);
      legacy.prepare("UPDATE actor_days SET queued_batch_id=? WHERE source='snapchain' AND day='2026-08-13' AND fid='99'")
        .run("frozen-version-2-payload");
      legacy.exec(`
        DROP TABLE collector_secrets;
        DELETE FROM schema_migrations WHERE version = 3;
        UPDATE collector_metadata SET value = '2' WHERE key = 'schema_version';
      `);
      legacy.close();

      const upgraded = new CollectorDatabase(path);
      expect(upgraded.status().schemaVersion).toBe(3);
      expect(upgraded.dueOutbox(NOW)[0]?.payloadJson).toBe(payload);
      expect(upgraded.pendingActorDays()).toEqual([]);
      upgraded.close();

      const inspected = new DatabaseSync(path);
      const queued = inspected.prepare(
        "SELECT queued_batch_id FROM actor_days WHERE source='snapchain' AND day='2026-08-13' AND fid='99'"
      ).get() as { queued_batch_id: string };
      inspected.close();
      expect(queued.queued_batch_id).toBe("frozen-version-2-payload");
    } finally {
      const resolved = resolve(directory);
      if (resolved.startsWith(resolve(tmpdir()))) rmSync(resolved, { recursive: true, force: true });
    }
  });

  it.each(["missing", "malformed", "unexpected"] as const)("fails closed when existing version-3 pseudonym key state is %s", (state) => {
    const directory = mkdtempSync(join(tmpdir(), `snapmeter-key-${state}-test-`));
    const path = join(directory, "state.sqlite3");
    try {
      const seeded = new CollectorDatabase(path);
      seeded.close();
      const corrupted = new DatabaseSync(path);
      if (state === "missing") {
        corrupted.exec("DELETE FROM collector_secrets WHERE name='actor_pseudonym_key_v1'");
      } else if (state === "malformed") {
        corrupted.exec("PRAGMA ignore_check_constraints=ON");
        corrupted.prepare("UPDATE collector_secrets SET value=? WHERE name='actor_pseudonym_key_v1'")
          .run(new Uint8Array(31));
      } else {
        corrupted.exec("PRAGMA ignore_check_constraints=ON");
        corrupted.prepare("INSERT INTO collector_secrets(name, value) VALUES ('unexpected_key', ?)")
          .run(new Uint8Array(32));
      }
      corrupted.close();
      expect(() => new CollectorDatabase(path)).toThrow(/actor pseudonym key is missing or invalid/);
      expect(() => rmSync(directory, { recursive: true, force: true })).not.toThrow();
    } finally {
      const resolved = resolve(directory);
      if (resolved.startsWith(resolve(tmpdir()))) rmSync(resolved, { recursive: true, force: true });
    }
  });
});
