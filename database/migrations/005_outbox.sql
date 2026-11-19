CREATE TABLE outbox_message (
  id UUID PRIMARY KEY,
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  routing_key TEXT NOT NULL,
  type TEXT NOT NULL,
  correlation_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX outbox_message_pending_idx
ON outbox_message (seq)
WHERE published_at IS NULL;
