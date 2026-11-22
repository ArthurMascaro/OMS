import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

import {
  OrderItem,
  StockBalance,
  StockEvent,
  StockEventType,
} from '@oms/contracts';

import { DatabaseService } from '../database/database.service';
import { STOCK_AVAILABILITY_PORT } from './stock-availability.port';
import type { StockAvailabilityPort } from './stock-availability.port';

interface StockQuantity {
  sku: string;
  quantity: number;
}

interface StockBalanceRow {
  physical: string;
  reserved: string;
}

interface StockBalanceBySkuRow extends StockBalanceRow {
  sku: string;
}

interface StockVersionRow {
  sku: string;
  version: string;
}

interface StockEventRow {
  eventId: string;
  type: StockEventType;
  sku: string;
  version: string;
  quantity: number;
  orderId: string | null;
  occurredAt: string;
}

@Injectable()
export class StockService {
  constructor(
    private readonly pool: Pool,
    private readonly database: DatabaseService,
    @Inject(STOCK_AVAILABILITY_PORT)
    private readonly availabilityPort: StockAvailabilityPort,
  ) {}

  async getBalance(sku: string): Promise<StockBalance> {
    return (await this.getBalances([sku]))[0];
  }

  async getBalances(skus: readonly string[]): Promise<StockBalance[]> {
    if (skus.length === 0) return [];

    const uniqueSkus = [...new Set(skus)];
    const response = await this.pool.query<StockBalanceBySkuRow>(
      `SELECT
        sku,
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
       WHERE sku = ANY($1::TEXT[])
       GROUP BY sku`,
      [uniqueSkus],
    );

    const balancesBySku = new Map(
      response.rows.map((row) => {
        const physical = Number(row.physical);
        const reserved = Number(row.reserved);
        return [
          row.sku,
          { sku: row.sku, physical, reserved, available: physical - reserved },
        ];
      }),
    );

    return uniqueSkus.map(
      (sku) =>
        balancesBySku.get(sku) ?? {
          sku,
          physical: 0,
          reserved: 0,
          available: 0,
        },
    );
  }

  async getMovements(filters: {
    sku?: string;
    orderId?: string;
  }): Promise<StockEvent[]> {
    const values: string[] = [];
    const conditions: string[] = [];

    if (filters.sku) {
      values.push(filters.sku);
      conditions.push(`sku = $${values.length}`);
    }

    if (filters.orderId) {
      values.push(filters.orderId);
      conditions.push(`order_id = $${values.length}`);
    }

    const response = await this.pool.query<StockEventRow>(
      `SELECT
        event_id AS "eventId",
        type,
        sku,
        version,
        quantity,
        order_id AS "orderId",
        occurred_at AS "occurredAt"
       FROM stock_event
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY occurred_at DESC, event_id DESC`,
      values,
    );

    return response.rows.map((row) => {
      const event = {
        eventId: row.eventId,
        sku: row.sku,
        version: Number(row.version),
        quantity: row.quantity,
        occurredAt: row.occurredAt,
      };

      switch (row.type) {
        case StockEventType.STOCK_RECEIVED:
          return { ...event, type: row.type };
        case StockEventType.RESERVATION_CREATED:
        case StockEventType.RESERVATION_RELEASED:
        case StockEventType.STOCK_SHIPPED:
        case StockEventType.STOCK_RETURNED:
          if (!row.orderId) {
            throw new Error(`Stock event ${row.eventId} is missing orderId`);
          }
          return { ...event, type: row.type, orderId: row.orderId };
        default:
          throw new Error('Unknown stock event type');
      }
    });
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
  ): Promise<{ reserved: boolean }> {
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
        return { reserved: false };
      }
    }

    await this.appendEvents(
      client,
      orderId,
      items,
      StockEventType.RESERVATION_CREATED,
    );

    return { reserved: true };
  }

  async ship(client: PoolClient, orderId: string, items: OrderItem[]) {
    return this.appendEvents(
      client,
      orderId,
      items,
      StockEventType.STOCK_SHIPPED,
    );
  }

  async return(client: PoolClient, orderId: string, items: OrderItem[]) {
    return this.appendEvents(
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
    return this.appendEvents(
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
  ): Promise<void> {
    const quantitiesBySku = new Map<string, number>();
    for (const item of items) {
      quantitiesBySku.set(
        item.sku,
        (quantitiesBySku.get(item.sku) ?? 0) + item.quantity,
      );
    }

    const skus = [...quantitiesBySku.keys()].sort();
    if (skus.length === 0) return;

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

    if (type === StockEventType.STOCK_SHIPPED) return;

    for (const { sku, available } of await this.readBalances(client, skus)) {
      await this.availabilityPort.notifyAvailabilityChanged(client, {
        sku,
        available,
      });
    }
  }

  private async readBalances(
    client: PoolClient,
    skus: string[],
  ): Promise<StockBalance[]> {
    const response = await client.query<StockBalanceBySkuRow>(
      `SELECT
        sku,
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
       WHERE sku = ANY($1::TEXT[])
       GROUP BY sku`,
      [skus],
    );

    return response.rows.map((row) => {
      const physical = Number(row.physical);
      const reserved = Number(row.reserved);
      return {
        sku: row.sku,
        physical,
        reserved,
        available: physical - reserved,
      };
    });
  }
}
