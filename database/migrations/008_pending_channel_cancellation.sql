CREATE TABLE pending_channel_cancellation (
  plugin_id TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plugin_id, external_order_id)
);
