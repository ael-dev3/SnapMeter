PRAGMA foreign_keys = ON;

CREATE TABLE ingest_batches (
  batch_id TEXT PRIMARY KEY,
  collector_id TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  sent_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_ingest_batches_expiry ON ingest_batches(expires_at_ms);

CREATE TABLE rate_windows (
  source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
  collector_id TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL,
  batch_count INTEGER NOT NULL,
  PRIMARY KEY (source, collector_id, window_start_ms)
);
CREATE INDEX idx_rate_windows_time ON rate_windows(window_start_ms);

CREATE TABLE source_cursors (
  source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
  shard INTEGER NOT NULL CHECK (shard > 0),
  event_id TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL,
  collector_id TEXT NOT NULL,
  PRIMARY KEY (source, shard)
);

CREATE TABLE minute_activity (
  source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
  minute_start_ms INTEGER NOT NULL,
  actions INTEGER NOT NULL CHECK (actions >= 0),
  unique_fids INTEGER NOT NULL CHECK (unique_fids >= 0),
  action_counts_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (source, minute_start_ms)
);
CREATE INDEX idx_minute_activity_time ON minute_activity(minute_start_ms, source);

CREATE TABLE actor_day_membership (
  source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
  day TEXT NOT NULL,
  fid_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (source, day, fid_hash)
);
CREATE INDEX idx_actor_day_day ON actor_day_membership(day, source);

CREATE TABLE daily_metrics (
  source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
  day TEXT NOT NULL,
  active_fids INTEGER NOT NULL CHECK (active_fids >= 0),
  actions INTEGER NOT NULL CHECK (actions >= 0),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (source, day)
);
CREATE INDEX idx_daily_metrics_day ON daily_metrics(day, source);

CREATE TABLE metric_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
  generated_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  collector_id TEXT NOT NULL
);
CREATE INDEX idx_metric_snapshots_source_time ON metric_snapshots(source, generated_at_ms DESC);

CREATE TABLE latest_snapshots (
  source TEXT PRIMARY KEY CHECK (source IN ('snapchain', 'hypersnap')),
  generated_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  collector_id TEXT NOT NULL
);

CREATE TABLE source_status (
  source TEXT PRIMARY KEY CHECK (source IN ('snapchain', 'hypersnap')),
  source_mode TEXT NOT NULL CHECK (source_mode IN ('verified', 'derived', 'unavailable')),
  status TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  collector_id TEXT NOT NULL
);

CREATE TABLE node_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('snapchain', 'hypersnap')),
  observed_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  collector_id TEXT NOT NULL
);
CREATE INDEX idx_node_health_source_time ON node_health(source, observed_at_ms DESC);

CREATE TABLE aggregation_runs (
  task TEXT NOT NULL,
  boundary_ms INTEGER NOT NULL,
  completed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (task, boundary_ms)
);
