CREATE TABLE live_delivery_outbox (
  batch_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  published_at_ms INTEGER
);

CREATE INDEX idx_live_delivery_pending ON live_delivery_outbox(published_at_ms, created_at_ms);
