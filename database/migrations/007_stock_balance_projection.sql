CREATE TABLE IF NOT EXISTS stock_balance_projection (
  sku TEXT PRIMARY KEY,
  physical BIGINT NOT NULL DEFAULT 0,
  reserved BIGINT NOT NULL DEFAULT 0,
  last_version BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT stock_balance_projection_physical_nonnegative
    CHECK (physical >= 0),
  CONSTRAINT stock_balance_projection_reserved_nonnegative
    CHECK (reserved >= 0),
  CONSTRAINT stock_balance_projection_reserved_lte_physical
    CHECK (reserved <= physical),
  CONSTRAINT stock_balance_projection_last_version_nonnegative
    CHECK (last_version >= 0)
);

INSERT INTO stock_balance_projection (
  sku,
  physical,
  reserved,
  last_version,
  updated_at
)
SELECT
  sku,
  SUM(CASE
    WHEN type IN ('STOCK_RECEIVED', 'STOCK_RETURNED') THEN quantity
    WHEN type = 'STOCK_SHIPPED' THEN -quantity
    ELSE 0
  END)::BIGINT AS physical,
  SUM(CASE
    WHEN type = 'RESERVATION_CREATED' THEN quantity
    WHEN type IN ('RESERVATION_RELEASED', 'STOCK_SHIPPED') THEN -quantity
    ELSE 0
  END)::BIGINT AS reserved,
  MAX(version)::BIGINT AS last_version,
  NOW() AS updated_at
FROM stock_event
GROUP BY sku
ON CONFLICT (sku) DO UPDATE SET
  physical = EXCLUDED.physical,
  reserved = EXCLUDED.reserved,
  last_version = EXCLUDED.last_version,
  updated_at = EXCLUDED.updated_at;
