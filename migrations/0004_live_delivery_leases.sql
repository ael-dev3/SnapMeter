ALTER TABLE live_delivery_outbox ADD COLUMN lease_token TEXT;
ALTER TABLE live_delivery_outbox ADD COLUMN lease_until_ms INTEGER;

CREATE INDEX idx_live_delivery_lease
  ON live_delivery_outbox(published_at_ms, lease_until_ms, created_at_ms);
