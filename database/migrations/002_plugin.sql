CREATE TABLE IF NOT EXISTS plugin (
  id TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  capabilities TEXT[] NOT NULL,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id)
);
