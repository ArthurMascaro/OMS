CREATE TABLE IF NOT EXISTS stock_event (
  event_id UUID NOT NULL DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL,
  version BIGINT NOT NULL,
  type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  order_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (event_id),
  UNIQUE (sku, version),
  FOREIGN KEY (order_id) REFERENCES "order" (id),

  CHECK (version > 0),
  CHECK (quantity > 0),
  CHECK (
    (type IN (
      'RESERVATION_CREATED',
      'RESERVATION_RELEASED',
      'STOCK_SHIPPED',
      'STOCK_RETURNED'
    ) AND order_id IS NOT NULL)
    OR (type = 'STOCK_RECEIVED' AND order_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS stock_event_order_id_idx
  ON stock_event (order_id)
  WHERE order_id IS NOT NULL;
