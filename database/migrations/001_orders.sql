CREATE TABLE IF NOT EXISTS "order" (
  id UUID DEFAULT gen_random_uuid(),
  plugin_id TEXT,
  external_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED',
  total_cents INTEGER NOT NULL,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  UNIQUE (plugin_id, external_order_id),
  CHECK (status IN ('CREATED', 'RESERVED', 'INVOICED', 'SHIPPED', 'RETURNED', 'CANCELED')),
  CHECK (total_cents >= 0),
  CHECK ((plugin_id IS NULL) = (external_order_id IS NULL))
);

CREATE TABLE IF NOT EXISTS order_item (
  id UUID DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (order_id) REFERENCES "order" (id),
  UNIQUE (order_id, sku),
  CHECK (quantity > 0),
  CHECK (unit_price_cents >= 0)
);

CREATE TABLE IF NOT EXISTS order_command (
  command_id UUID DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL,
  plugin_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  PRIMARY KEY (command_id),
  FOREIGN KEY (order_id) REFERENCES "order" (id),
  CHECK (type IN ('INVOICE_ORDER', 'CANCEL_ORDER', 'SHIP_ORDER', 'RETURN_ORDER')),
  CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED'))
);
