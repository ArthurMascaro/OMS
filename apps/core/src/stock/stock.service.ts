import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';

import { OrderItem, StockEventType } from '@oms/contracts';

interface StockBalanceRow {
  physical: string;
  reserved: string;
}

interface StockVersionRow {
  version: string;
}

@Injectable()
export class StockService {
  async reserve(
    client: PoolClient,
    orderId: string,
    items: OrderItem[],
  ): Promise<boolean> {
    const quantitiesBySku = new Map<string, number>();
    for (const item of items) {
      quantitiesBySku.set(
        item.sku,
        (quantitiesBySku.get(item.sku) ?? 0) + item.quantity,
      );
    }

    const skus = [...quantitiesBySku.keys()].sort();

    for (const sku of skus) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [sku],
      );
    }

    for (const sku of skus) {
      const response = await client.query<StockBalanceRow>(
        `SELECT
          COALESCE(SUM(CASE
            WHEN type IN ('STOCK_RECEIVED', 'STOCK_RETURNED') THEN quantity
            WHEN type = 'STOCK_SHIPPED' THEN -quantity
            ELSE 0
          END), 0)::TEXT AS physical,
          COALESCE(SUM(CASE
            WHEN type = 'RESERVATION_CREATED' THEN quantity
            WHEN type IN ('RESERVATION_RELEASED', 'STOCK_SHIPPED') THEN -quantity
            ELSE 0
          END), 0)::TEXT AS reserved
         FROM stock_event
         WHERE sku = $1`,
        [sku],
      );

      const physical = Number(response.rows[0].physical);
      const reserved = Number(response.rows[0].reserved);
      const available = physical - reserved;

      if (available < (quantitiesBySku.get(sku) ?? 0)) {
        return false;
      }
    }

    for (const sku of skus) {
      const versionResponse = await client.query<StockVersionRow>(
        `SELECT (COALESCE(MAX(version), 0) + 1)::TEXT AS version
         FROM stock_event
         WHERE sku = $1`,
        [sku],
      );
      const version = Number(versionResponse.rows[0].version);

      await client.query(
        `INSERT INTO stock_event (
          sku,
          version,
          type,
          quantity,
          order_id
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          sku,
          version,
          StockEventType.RESERVATION_CREATED,
          quantitiesBySku.get(sku),
          orderId,
        ],
      );
    }

    return true;
  }
}
