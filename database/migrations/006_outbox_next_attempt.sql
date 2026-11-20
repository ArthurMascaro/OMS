ALTER TABLE outbox_message
ADD COLUMN next_attempt_at TIMESTAMPTZ;

CREATE INDEX outbox_message_delayed_routing_key_idx
ON outbox_message (routing_key, next_attempt_at)
WHERE published_at IS NULL AND next_attempt_at IS NOT NULL;
