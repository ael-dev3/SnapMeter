CREATE TABLE IF NOT EXISTS data_quality (
  source TEXT PRIMARY KEY CHECK (source IN ('snapchain', 'hypersnap')),
  quality TEXT NOT NULL,
  complete_since_ms INTEGER,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actor_day_source_day ON actor_day_membership(source, day);
CREATE INDEX IF NOT EXISTS idx_source_status_observed ON source_status(observed_at_ms);

CREATE TABLE IF NOT EXISTS comparison_snapshots (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generated_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  collector_id TEXT NOT NULL
);
