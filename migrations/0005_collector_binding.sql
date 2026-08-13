CREATE TABLE collector_binding (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  collector_id TEXT NOT NULL,
  claimed_at_ms INTEGER NOT NULL
);
