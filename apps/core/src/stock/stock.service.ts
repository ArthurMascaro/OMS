import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

import { OrderItem, StockBalance, StockEventType } from '@oms/contracts';

import { DatabaseService } from '../database/database.service';

interface StockQuantity {
  sku: string;
  quantity: number;
}

interface StockBalanceRow {
  physical: string;
  reserved: string;
}

interface StockVersionRow {
  sku: string;
  version: string;
}

@Injectable()
export class StockService {
  constructor(
    private readonly pool: Pool,
    private readonly database: DatabaseService,
  ) {}

  async getBalance(sku: string): Promise<StockBalance> {
    const response = await this.pool.query<StockBalanceRow>(
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

    return {
      sku,
      physical,
      reserved,
      available: physical - reserved,
    };
  }

  async receive(sku: string, quantity: number): Promise<void> {
    await this.database.transaction((client) =>
      this.appendEvents(
        client,
        null,
        [{ sku, quantity }],
        StockEventType.STOCK_RECEIVED,
      ),
    );
  }

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

    await this.appendEvents(
      client,
      orderId,
      items,
      StockEventType.RESERVATION_CREATED,
    );

    return true;
  }

  async ship(client: PoolClient, orderId: string, items: OrderItem[]) {
    await this.appendEvents(
      client,
      orderId,
      items,
      StockEventType.STOCK_SHIPPED,
    );
  }

  async return(client: PoolClient, orderId: string, items: OrderItem[]) {
    await this.appendEvents(
      client,
      orderId,
      items,
      StockEventType.STOCK_RETURNED,
    );
  }

  async releaseReservation(
    client: PoolClient,
    orderId: string,
    items: OrderItem[],
  ) {
    await this.appendEvents(
      client,
      orderId,
      items,
      StockEventType.RESERVATION_RELEASED,
    );
  }

  private async appendEvents(
    client: PoolClient,
    orderId: string | null,
    items: StockQuantity[],
    type: StockEventType,
  ) {
    const quantitiesBySku = new Map<string, number>();
    for (const item of items) {
      quantitiesBySku.set(
        item.sku,
        (quantitiesBySku.get(item.sku) ?? 0) + item.quantity,
      );
    }

    const skus = [...quantitiesBySku.keys()].sort();
    if (skus.length === 0) {
      return;
    }

    const versionResponse = await client.query<StockVersionRow>(
      `SELECT
        sku,
        MAX(version)::TEXT AS version
         FROM stock_event
         WHERE sku = ANY($1::TEXT[])
         GROUP BY sku`,
      [skus],
    );

    const versionsBySku = new Map(
      versionResponse.rows.map((row) => [row.sku, Number(row.version)]),
    );
    const values: (string | number | null)[] = [];
    const tuples = skus.map((sku, index) => {
      const offset = index * 5;
      const version = (versionsBySku.get(sku) ?? 0) + 1;

      values.push(sku, version, type, quantitiesBySku.get(sku)!, orderId);

      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
    });

    await client.query(
      `INSERT INTO stock_event (
        sku,
        version,
        type,
        quantity,
        order_id
       ) VALUES ${tuples.join(', ')}`,
      values,
    );
  }
}
