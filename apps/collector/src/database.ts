import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  ActionFamily,
  IngestBatch,
  Source,
  SourceMode
} from "@snapmeter/contracts";
import type { ActivityRecord } from "@snapmeter/metrics";
import { utcDay } from "@snapmeter/metrics";
export type MinuteBucket = IngestBatch["minuteBuckets"][number];
export type ActorDay = IngestBatch["actorDays"][number];
export type Cursor = IngestBatch["cursors"][number];
type DatabaseHealthUpdate = IngestBatch["health"][number];

export interface RecordedEvent {
  source: Source;
  shard: number;
  eventId: string;
  eventType: string;
  receivedAtMs: number;
  activity: ActivityRecord | null;
}

export interface RecordEventResult {
  duplicate: boolean;
  actionInserted: boolean;
}

export interface SourceHealthRecord {
  source: Source;
  sourceMode: SourceMode;
  status: DatabaseHealthUpdate["status"];
  observedAtMs: number;
  node: DatabaseHealthUpdate["node"];
  message: string | null;
}

export interface OutboxRow {
  id: number;
  batchId: string;
  payloadJson: string;
  attemptCount: number;
  nextAttemptAtMs: number;
  createdAtMs: number;
}

export interface DatabaseStatus {
  schemaVersion: number;
  collectorId: string;
  actions: number;
  dedupeEvents: number;
  actorDays: number;
  minuteBuckets: number;
  pendingOutbox: number;
  oldestActionAtMs: number | null;
  newestActionAtMs: number | null;
  lastCloudAckAtMs: number | null;
}

const SCHEMA_VERSION = 2;
export class CollectorDatabase {
  readonly #database: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
    if (path !== ":memory:") this.#database.exec("PRAGMA journal_mode=WAL;");
    this.#migrate();
    if (!this.getMetadata("collector_id")) this.setMetadata("collector_id", randomUUID());
    this.setMetadata("schema_version", String(SCHEMA_VERSION));
  }

  close(): void {
    this.#database.close();
  }

  get collectorId(): string {
    const collectorId = this.getMetadata("collector_id");
    if (!collectorId) throw new Error("collector id is missing");
    return collectorId;
  }

  recordEvent(event: RecordedEvent): RecordEventResult {
    assertEventId(event.eventId);
    if (!Number.isSafeInteger(event.shard) || event.shard < 0) throw new Error("invalid shard index");
    return this.#transaction(() => {
      const inserted = changes(this.#prepare(`
        INSERT OR IGNORE INTO event_dedupe(source, shard, event_id, event_type, received_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(event.source, event.shard, event.eventId, event.eventType, event.receivedAtMs)) > 0;
      if (!inserted) return { duplicate: true, actionInserted: false };
      if (!event.activity) return { duplicate: false, actionInserted: false };

      const action = event.activity;
      const actionInserted = changes(this.#prepare(`
        INSERT OR IGNORE INTO activity_actions(
          source, source_mode, shard, event_id, fid, action_family, action_at_ms, received_at_ms, is_replay
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        action.source,
        action.sourceMode,
        event.shard,
        event.eventId,
        action.fid,
        action.action,
        action.actionAtMs,
        action.receivedAtMs,
        action.isReplay ? 1 : 0
      )) > 0;
      if (!actionInserted) return { duplicate: false, actionInserted: false };

      const day = utcDay(action.actionAtMs);
      this.#prepare(`
        INSERT OR IGNORE INTO actor_days(source, day, fid, created_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(action.source, day, action.fid, action.receivedAtMs);
      const minuteStartMs = Math.floor(action.actionAtMs / 60_000) * 60_000;
      this.#prepare(`
        INSERT OR IGNORE INTO minute_actors(source, minute_start_ms, fid)
        VALUES (?, ?, ?)
      `).run(action.source, minuteStartMs, action.fid);
      const existing = this.#prepare(`
        SELECT action_counts_json FROM minute_buckets WHERE source = ? AND minute_start_ms = ?
      `).get(action.source, minuteStartMs) as { action_counts_json?: unknown } | undefined;
      const counts = parseCounts(existing?.action_counts_json);
      counts[action.action] = (counts[action.action] ?? 0) + 1;
      const actorCount = numberColumn(this.#prepare(`
        SELECT COUNT(*) AS value FROM minute_actors WHERE source = ? AND minute_start_ms = ?
      `).get(action.source, minuteStartMs), "value");
      this.#prepare(`
        INSERT INTO minute_buckets(
          source, minute_start_ms, actions, unique_fids, action_counts_json, last_action_at_ms, updated_at_ms
        ) VALUES (?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(source, minute_start_ms) DO UPDATE SET
          actions = minute_buckets.actions + 1,
          unique_fids = excluded.unique_fids,
          action_counts_json = excluded.action_counts_json,
          last_action_at_ms = MAX(minute_buckets.last_action_at_ms, excluded.last_action_at_ms),
          updated_at_ms = excluded.updated_at_ms,
          queued_batch_id = NULL
      `).run(
        action.source,
        minuteStartMs,
        actorCount,
        JSON.stringify(counts),
        action.actionAtMs,
        action.receivedAtMs
      );
      this.markObservedDay(action.source, day);
      return { duplicate: false, actionInserted: true };
    });
  }

  checkpointCursor(source: Source, shard: number, eventId: string, verifiedAtMs: number): boolean {
    assertEventId(eventId);
    return this.#transaction(() => {
      const current = this.getCursor(source, shard);
      if (compareEventIds(eventId, current) <= 0) return false;
      this.#prepare(`
        INSERT INTO cursors(source, shard, event_id, verified_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(source, shard) DO UPDATE SET
          event_id = excluded.event_id,
          verified_at_ms = excluded.verified_at_ms
      `).run(source, shard, eventId, verifiedAtMs);
      return true;
    });
  }

  getCursor(source: Source, shard: number): string {
    const row = this.#prepare("SELECT event_id FROM cursors WHERE source = ? AND shard = ?").get(source, shard) as
      | { event_id?: unknown }
      | undefined;
    return typeof row?.event_id === "string" && /^\d+$/.test(row.event_id) ? row.event_id : "0";
  }

  getCursors(): Cursor[] {
    return (this.#prepare(`
      SELECT source, shard, event_id, verified_at_ms FROM cursors ORDER BY source, shard
    `).all() as SqlRow[]).map((row) => ({
      source: sourceColumn(row.source),
      shard: Number(row.shard),
      eventId: String(row.event_id),
      verifiedAtMs: Number(row.verified_at_ms)
    }));
  }

  hasEvent(source: Source, shard: number, eventId: string): boolean {
    return Boolean(this.#prepare(`
      SELECT 1 AS present FROM event_dedupe WHERE source = ? AND shard = ? AND event_id = ?
    `).get(source, shard, eventId));
  }

  loadActions(source: Source, sinceExclusiveMs: number): ActivityRecord[] {
    return (this.#prepare(`
      SELECT source, source_mode, shard, event_id, fid, action_family, action_at_ms, received_at_ms, is_replay
      FROM activity_actions
      WHERE source = ? AND action_at_ms > ?
      ORDER BY action_at_ms, shard, length(event_id), event_id
    `).all(source, sinceExclusiveMs) as SqlRow[]).map((row) => ({
      eventKey: `${Number(row.shard)}:${String(row.event_id)}`,
      source: sourceColumn(row.source),
      sourceMode: sourceModeColumn(row.source_mode),
      fid: String(row.fid),
      action: String(row.action_family) as ActionFamily,
      actionAtMs: Number(row.action_at_ms),
      receivedAtMs: Number(row.received_at_ms),
      isReplay: Number(row.is_replay) === 1
    }));
  }

  activeFidComparison(sinceExclusiveMs: number, endInclusiveMs: number): {
    snapchain: Set<string>;
    hypersnap: Set<string>;
    overlap: Set<string>;
    union: Set<string>;
  } {
    const rows = this.#prepare(`
      SELECT DISTINCT source, fid FROM activity_actions
      WHERE action_at_ms > ? AND action_at_ms <= ?
      ORDER BY source, fid
    `).all(sinceExclusiveMs, endInclusiveMs) as SqlRow[];
    const snapchain = new Set<string>();
    const hypersnap = new Set<string>();
    for (const row of rows) {
      const source = sourceColumn(row.source);
      (source === "snapchain" ? snapchain : hypersnap).add(String(row.fid));
    }
    const overlap = new Set([...snapchain].filter((fid) => hypersnap.has(fid)));
    const union = new Set([...snapchain, ...hypersnap]);
    return { snapchain, hypersnap, overlap, union };
  }

  markObservedDay(source: Source, day: string): void {
    this.#prepare("INSERT OR IGNORE INTO observed_days(source, day) VALUES (?, ?)").run(source, day);
  }

  recordHistoryCoverage(source: Source, shard: number, authoritativeAtMs: number): number {
    if (!Number.isSafeInteger(shard) || shard <= 0) throw new Error("history coverage requires a positive data shard");
    if (!Number.isSafeInteger(authoritativeAtMs) || authoritativeAtMs < 0) throw new Error("invalid history coverage timestamp");
    this.#prepare(`
      INSERT INTO history_coverage(source, shard, start_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source, shard) DO UPDATE SET
        start_at_ms = MIN(history_coverage.start_at_ms, excluded.start_at_ms),
        updated_at_ms = excluded.updated_at_ms
    `).run(source, shard, authoritativeAtMs, Date.now());
    const row = this.#prepare(`
      SELECT start_at_ms FROM history_coverage WHERE source = ? AND shard = ?
    `).get(source, shard) as SqlRow | undefined;
    if (row?.start_at_ms === undefined) throw new Error("failed to persist shard history coverage");
    return Number(row.start_at_ms);
  }

  historyCoverageStart(source: Source, discoveredShards: readonly number[], expectedShardCount: number): number | null {
    if (!Number.isSafeInteger(expectedShardCount) || expectedShardCount < 0) throw new Error("invalid expected shard count");
    const requiredShards = [...new Set(discoveredShards.filter((shard) => Number.isSafeInteger(shard) && shard > 0))];
    if (requiredShards.length === 0 || requiredShards.length < expectedShardCount) return null;
    const starts = new Map((this.#prepare(`
      SELECT shard, start_at_ms FROM history_coverage WHERE source = ?
    `).all(source) as SqlRow[]).map((row) => [Number(row.shard), Number(row.start_at_ms)]));
    const requiredStarts = requiredShards.map((shard) => starts.get(shard));
    if (requiredStarts.some((start) => start === undefined)) return null;
    return Math.max(...requiredStarts.map((start) => start as number));
  }

  observedDays(source: Source): Set<string> {
    return new Set((this.#prepare("SELECT day FROM observed_days WHERE source = ? ORDER BY day").all(source) as SqlRow[])
      .map((row) => String(row.day)));
  }

  pendingMinuteBuckets(beforeMinuteMs: number, limit = 500): MinuteBucket[] {
    return (this.#prepare(`
      SELECT source, minute_start_ms, actions, unique_fids, action_counts_json
      FROM minute_buckets
      WHERE minute_start_ms < ? AND queued_batch_id IS NULL
      ORDER BY minute_start_ms, source
      LIMIT ?
    `).all(beforeMinuteMs, limit) as SqlRow[]).map((row) => ({
      source: sourceColumn(row.source),
      minuteStartMs: Number(row.minute_start_ms),
      actions: Number(row.actions),
      uniqueFids: Number(row.unique_fids),
      actionCounts: parseCounts(row.action_counts_json)
    }));
  }

  pendingActorDays(limit = 5_000): { value: ActorDay; fid: string }[] {
    return (this.#prepare(`
      SELECT source, day, fid FROM actor_days
      WHERE queued_batch_id IS NULL
      ORDER BY day, source, fid
      LIMIT ?
    `).all(limit) as SqlRow[]).map((row) => ({
      value: { source: sourceColumn(row.source), day: String(row.day), fidHash: "" },
      fid: String(row.fid)
    }));
  }

  hasUnqueuedAggregates(beforeMinuteMs: number): boolean {
    return Boolean(this.#prepare(`
      SELECT 1 AS present FROM actor_days WHERE queued_batch_id IS NULL
      UNION ALL
      SELECT 1 AS present FROM minute_buckets WHERE queued_batch_id IS NULL AND minute_start_ms < ?
      LIMIT 1
    `).get(beforeMinuteMs));
  }

  enqueueOutbox(
    batch: IngestBatch,
    minuteBuckets: readonly Pick<MinuteBucket, "source" | "minuteStartMs">[],
    actorDays: readonly { source: Source; day: string; fid: string }[],
    maxRows: number
  ): boolean {
    return this.#transaction(() => {
      const count = numberColumn(this.#prepare("SELECT COUNT(*) AS value FROM outbox").get(), "value");
      if (count >= maxRows) return false;
      this.#prepare(`
        INSERT INTO outbox(batch_id, payload_json, created_at_ms, next_attempt_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(batch.batchId, JSON.stringify(batch), batch.sentAtMs, batch.sentAtMs);
      const minuteStatement = this.#prepare(`
        UPDATE minute_buckets SET queued_batch_id = ? WHERE source = ? AND minute_start_ms = ?
      `);
      for (const minute of minuteBuckets) minuteStatement.run(batch.batchId, minute.source, minute.minuteStartMs);
      const actorStatement = this.#prepare(`
        UPDATE actor_days SET queued_batch_id = ? WHERE source = ? AND day = ? AND fid = ?
      `);
      for (const actor of actorDays) actorStatement.run(batch.batchId, actor.source, actor.day, actor.fid);
      return true;
    });
  }

  dueOutbox(nowMs: number, limit = 20): OutboxRow[] {
    return (this.#prepare(`
      SELECT id, batch_id, payload_json, attempt_count, next_attempt_at_ms, created_at_ms
      FROM outbox
      WHERE next_attempt_at_ms <= ?
      ORDER BY id
      LIMIT ?
    `).all(nowMs, limit) as SqlRow[]).map((row) => ({
      id: Number(row.id),
      batchId: String(row.batch_id),
      payloadJson: String(row.payload_json),
      attemptCount: Number(row.attempt_count),
      nextAttemptAtMs: Number(row.next_attempt_at_ms),
      createdAtMs: Number(row.created_at_ms)
    }));
  }

  acknowledgeOutbox(id: number, batchId: string, acknowledgedAtMs: number): void {
    this.#transaction(() => {
      this.#prepare("DELETE FROM outbox WHERE id = ? AND batch_id = ?").run(id, batchId);
      this.setMetadata("last_cloud_ack_at_ms", String(acknowledgedAtMs));
      this.setMetadata("last_cloud_batch_id", batchId);
    });
  }

  failOutbox(id: number, nextAttemptAtMs: number, error: string): void {
    this.#prepare(`
      UPDATE outbox SET
        attempt_count = attempt_count + 1,
        next_attempt_at_ms = ?,
        last_attempt_at_ms = ?,
        last_error = ?
      WHERE id = ?
    `).run(nextAttemptAtMs, Date.now(), error.slice(0, 500), id);
  }

  upsertSourceHealth(health: SourceHealthRecord): void {
    this.#prepare(`
      INSERT INTO source_health(source, source_mode, status, observed_at_ms, node_json, message)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        source_mode = excluded.source_mode,
        status = excluded.status,
        observed_at_ms = excluded.observed_at_ms,
        node_json = excluded.node_json,
        message = excluded.message
    `).run(health.source, health.sourceMode, health.status, health.observedAtMs, JSON.stringify(health.node), health.message);
    this.markObservedDay(health.source, utcDay(health.observedAtMs));
  }

  sourceHealth(source?: Source): SourceHealthRecord[] {
    const statement = source
      ? this.#prepare("SELECT * FROM source_health WHERE source = ? ORDER BY source")
      : this.#prepare("SELECT * FROM source_health ORDER BY source");
    const rows = (source ? statement.all(source) : statement.all()) as SqlRow[];
    return rows.map((row) => ({
      source: sourceColumn(row.source),
      sourceMode: sourceModeColumn(row.source_mode),
      status: String(row.status) as DatabaseHealthUpdate["status"],
      observedAtMs: Number(row.observed_at_ms),
      node: JSON.parse(String(row.node_json)) as DatabaseHealthUpdate["node"],
      message: row.message === null ? null : String(row.message)
    }));
  }

  cleanup(nowMs: number, retentionDays: number): void {
    const cutoffMs = nowMs - retentionDays * 86_400_000;
    const cutoffDay = utcDay(cutoffMs);
    const cutoffMinute = Math.floor(cutoffMs / 60_000) * 60_000;
    this.#transaction(() => {
      this.#prepare("DELETE FROM activity_actions WHERE action_at_ms < ?").run(cutoffMs);
      this.#prepare("DELETE FROM event_dedupe WHERE received_at_ms < ?").run(cutoffMs);
      this.#prepare("DELETE FROM actor_days WHERE day < ?").run(cutoffDay);
      this.#prepare("DELETE FROM minute_actors WHERE minute_start_ms < ?").run(cutoffMinute);
      this.#prepare("DELETE FROM minute_buckets WHERE minute_start_ms < ?").run(cutoffMinute);
      this.#prepare("DELETE FROM observed_days WHERE day < ?").run(cutoffDay);
    });
  }

  integrityCheck(): string {
    const row = this.#prepare("PRAGMA quick_check").get() as SqlRow | undefined;
    return String(row ? Object.values(row)[0] : "unknown");
  }

  status(): DatabaseStatus {
    const range = this.#prepare(`
      SELECT MIN(action_at_ms) AS oldest, MAX(action_at_ms) AS newest FROM activity_actions
    `).get() as SqlRow | undefined;
    return {
      schemaVersion: Number(this.getMetadata("schema_version") ?? 0),
      collectorId: this.collectorId,
      actions: this.#count("activity_actions"),
      dedupeEvents: this.#count("event_dedupe"),
      actorDays: this.#count("actor_days"),
      minuteBuckets: this.#count("minute_buckets"),
      pendingOutbox: this.#count("outbox"),
      oldestActionAtMs: range?.oldest === null || range?.oldest === undefined ? null : Number(range.oldest),
      newestActionAtMs: range?.newest === null || range?.newest === undefined ? null : Number(range.newest),
      lastCloudAckAtMs: nullableInteger(this.getMetadata("last_cloud_ack_at_ms"))
    };
  }

  getMetadata(key: string): string | null {
    const row = this.#prepare("SELECT value FROM collector_metadata WHERE key = ?").get(key) as { value?: unknown } | undefined;
    return row?.value === undefined ? null : String(row.value);
  }

  setMetadata(key: string, value: string): void {
    this.#prepare(`
      INSERT INTO collector_metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  #count(table: "activity_actions" | "event_dedupe" | "actor_days" | "minute_buckets" | "outbox"): number {
    return numberColumn(this.#prepare(`SELECT COUNT(*) AS value FROM ${table}`).get(), "value");
  }

  #prepare(sql: string): StatementSync {
    return this.#database.prepare(sql);
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      );
    `);
    const current = numberColumn(this.#prepare("SELECT COALESCE(MAX(version), 0) AS value FROM schema_migrations").get(), "value");
    if (current > SCHEMA_VERSION) throw new Error(`database schema ${current} is newer than collector schema ${SCHEMA_VERSION}`);
    if (current < 1) {
      this.#transaction(() => {
        this.#database.exec(MIGRATION_1);
        this.#prepare("INSERT INTO schema_migrations(version, applied_at_ms) VALUES (1, ?)").run(Date.now());
      });
    }
    if (current < 2) {
      this.#transaction(() => {
        this.#database.exec(MIGRATION_2);
        this.#prepare("INSERT INTO schema_migrations(version, applied_at_ms) VALUES (2, ?)").run(Date.now());
      });
    }
  }
}

export function compareEventIds(left: string, right: string): number {
  assertEventId(left);
  assertEventId(right);
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
}

export function maxEventId(...ids: readonly string[]): string {
  return ids.reduce((maximum, value) => compareEventIds(value, maximum) > 0 ? value : maximum, "0");
}

function assertEventId(eventId: string): void {
  if (!/^\d+$/.test(eventId)) throw new Error(`invalid event id: ${eventId}`);
}

function changes(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

function numberColumn(row: unknown, key: string): number {
  const value = (row as Record<string, unknown> | undefined)?.[key];
  return value === undefined || value === null ? 0 : Number(value);
}

function nullableInteger(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

type SqlRow = Record<string, unknown>;

function sourceColumn(value: unknown): Source {
  if (value === "snapchain" || value === "hypersnap") return value;
  throw new Error(`invalid source in database: ${String(value)}`);
}

function sourceModeColumn(value: unknown): SourceMode {
  if (value === "verified" || value === "derived" || value === "unavailable") return value;
  throw new Error(`invalid source mode in database: ${String(value)}`);
}

function parseCounts(value: unknown): MinuteBucket["actionCounts"] {
  if (typeof value !== "string") return {} as MinuteBucket["actionCounts"];
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [ActionFamily, number] =>
      typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] >= 0)) as MinuteBucket["actionCounts"];
  } catch {
    return {} as MinuteBucket["actionCounts"];
  }
}

const MIGRATION_1 = `
  CREATE TABLE collector_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE event_dedupe (
    source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
    shard INTEGER NOT NULL CHECK (shard >= 0),
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    received_at_ms INTEGER NOT NULL,
    PRIMARY KEY (source, shard, event_id)
  ) STRICT;
  CREATE INDEX event_dedupe_retention_idx ON event_dedupe(received_at_ms);

  CREATE TABLE activity_actions (
    source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
    source_mode TEXT NOT NULL CHECK (source_mode IN ('verified', 'derived', 'unavailable')),
    shard INTEGER NOT NULL CHECK (shard >= 0),
    event_id TEXT NOT NULL,
    fid TEXT NOT NULL,
    action_family TEXT NOT NULL,
    action_at_ms INTEGER NOT NULL,
    received_at_ms INTEGER NOT NULL,
    is_replay INTEGER NOT NULL CHECK (is_replay IN (0, 1)),
    PRIMARY KEY (source, shard, event_id)
  ) STRICT;
  CREATE INDEX activity_actions_window_idx ON activity_actions(source, action_at_ms, fid);
  CREATE INDEX activity_actions_fid_idx ON activity_actions(source, fid, action_at_ms);

  CREATE TABLE actor_days (
    source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
    day TEXT NOT NULL,
    fid TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    queued_batch_id TEXT,
    PRIMARY KEY (source, day, fid)
  ) STRICT;
  CREATE INDEX actor_days_queue_idx ON actor_days(queued_batch_id, day);

  CREATE TABLE observed_days (
    source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
    day TEXT NOT NULL,
    PRIMARY KEY (source, day)
  ) STRICT;

  CREATE TABLE minute_actors (
    source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
    minute_start_ms INTEGER NOT NULL,
    fid TEXT NOT NULL,
    PRIMARY KEY (source, minute_start_ms, fid)
  ) STRICT;
  CREATE INDEX minute_actors_retention_idx ON minute_actors(minute_start_ms);

  CREATE TABLE minute_buckets (
    source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
    minute_start_ms INTEGER NOT NULL,
    actions INTEGER NOT NULL CHECK (actions >= 0),
    unique_fids INTEGER NOT NULL CHECK (unique_fids >= 0),
    action_counts_json TEXT NOT NULL,
    last_action_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    queued_batch_id TEXT,
    PRIMARY KEY (source, minute_start_ms)
  ) STRICT;
  CREATE INDEX minute_buckets_queue_idx ON minute_buckets(queued_batch_id, minute_start_ms);

  CREATE TABLE cursors (
    source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
    shard INTEGER NOT NULL CHECK (shard >= 0),
    event_id TEXT NOT NULL,
    verified_at_ms INTEGER NOT NULL,
    PRIMARY KEY (source, shard)
  ) STRICT;

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER NOT NULL,
    last_attempt_at_ms INTEGER,
    last_error TEXT
  ) STRICT;
  CREATE INDEX outbox_due_idx ON outbox(next_attempt_at_ms, id);

  CREATE TABLE source_health (
    source TEXT PRIMARY KEY CHECK (source IN ('snapchain', 'hypersnap')),
    source_mode TEXT NOT NULL CHECK (source_mode IN ('verified', 'derived', 'unavailable')),
    status TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    node_json TEXT NOT NULL,
    message TEXT
  ) STRICT;
`;

const MIGRATION_2 = `
  CREATE TABLE IF NOT EXISTS history_coverage (
    source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
    shard INTEGER NOT NULL CHECK (shard > 0),
    start_at_ms INTEGER NOT NULL CHECK (start_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (source, shard)
  ) STRICT;
`;
