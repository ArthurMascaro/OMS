import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';

import type {
  StockBalance,
  StockEvent,
} from '@oms/contracts';
import { StockEventType } from '@oms/contracts';

import { DatabaseService } from '../database/database.service';
import type {
  StockMovementFilter,
  StockProjectionQuery,
} from './stock-projection.contract';

interface ProjectionRow {
  sku: string;
  physical: string;
  reserved: string;
  lastVersion: string;
}

interface StockEventRow {
  eventId: string;
  type: string;
  sku: string;
  version: string;
  quantity: number;
  orderId: string | null;
  occurredAt: string;
}

interface ProjectionState {
  sku: string;
  physical: number;
  reserved: number;
  lastVersion: number;
}

@Injectable()
export class StockProjectionService implements StockProjectionQuery {
  constructor(
    private readonly pool: Pool,
    private readonly database: DatabaseService,
  ) {}

  async getBalance(sku: string): Promise<StockBalance> {
    return (
      await this.getBalances([sku])
    )[0] ?? { sku, physical: 0, reserved: 0, available: 0 };
  }

  async getBalances(skus: readonly string[]): Promise<StockBalance[]> {
    const uniqueSkus = [...new Set(skus)].sort();
    if (uniqueSkus.length === 0) return [];

    return this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO stock_balance_projection (sku)
         SELECT sku
         FROM UNNEST($1::TEXT[]) AS requested (sku)
         ON CONFLICT (sku) DO NOTHING`,
        [uniqueSkus],
      );

      const projectionResponse = await client.query<ProjectionRow>(
        `SELECT
          sku,
          physical::TEXT AS physical,
          reserved::TEXT AS reserved,
          last_version::TEXT AS "lastVersion"
         FROM stock_balance_projection
         WHERE sku = ANY($1::TEXT[])
         ORDER BY sku
         FOR UPDATE`,
        [uniqueSkus],
      );

      const projections = new Map<string, ProjectionState>(
        projectionResponse.rows.map((row) => [
          row.sku,
          {
            sku: row.sku,
            physical: Number(row.physical),
            reserved: Number(row.reserved),
            lastVersion: Number(row.lastVersion),
          },
        ]),
      );

      const eventsResponse = await client.query<StockEventRow>(
        `SELECT
          event.event_id AS "eventId",
          event.type,
          event.sku,
          event.version::TEXT AS version,
          event.quantity,
          event.order_id AS "orderId",
          event.occurred_at AS "occurredAt"
         FROM stock_event event
         JOIN stock_balance_projection projection
           ON projection.sku = event.sku
         WHERE event.sku = ANY($1::TEXT[])
           AND event.version > projection.last_version
         ORDER BY event.sku, event.version`,
        [uniqueSkus],
      );

      const updatedSkus = new Set<string>();
      for (const event of eventsResponse.rows) {
        const projection = projections.get(event.sku);
        if (!projection) {
          throw new Error(`Projection row missing for SKU ${event.sku}`);
        }

        const version = Number(event.version);
        if (version !== projection.lastVersion + 1) {
          throw new Error(
            `Stock event version gap for SKU ${event.sku}: expected ${projection.lastVersion + 1}, received ${version}`,
          );
        }

        this.applyEvent(projection, event);
        projection.lastVersion = version;
        updatedSkus.add(event.sku);
      }

      if (updatedSkus.size > 0) {
        const updatedProjections = [...updatedSkus]
          .sort()
          .map((sku) => projections.get(sku)!);

        await client.query(
          `UPDATE stock_balance_projection AS projection
           SET
            physical = updated.physical,
            reserved = updated.reserved,
            last_version = updated.last_version,
            updated_at = NOW()
           FROM UNNEST(
            $1::TEXT[],
            $2::BIGINT[],
            $3::BIGINT[],
            $4::BIGINT[]
           ) AS updated (sku, physical, reserved, last_version)
           WHERE projection.sku = updated.sku`,
          [
            updatedProjections.map(({ sku }) => sku),
            updatedProjections.map(({ physical }) => physical),
            updatedProjections.map(({ reserved }) => reserved),
            updatedProjections.map(({ lastVersion }) => lastVersion),
          ],
        );
      }

      return uniqueSkus.map((sku) => {
        const projection = projections.get(sku)!;
        return {
          sku,
          physical: projection.physical,
          reserved: projection.reserved,
          available: projection.physical - projection.reserved,
        };
      });
    });
  }

  async getMovements(filter: StockMovementFilter): Promise<StockEvent[]> {
    const values: string[] = [];
    const conditions: string[] = [];

    if (filter.sku) {
      values.push(filter.sku);
      conditions.push(`sku = $${values.length}`);
    }

    if (filter.orderId) {
      values.push(filter.orderId);
      conditions.push(`order_id = $${values.length}`);
    }

    const response = await this.pool.query<StockEventRow>(
      `SELECT
        event_id AS "eventId",
        type,
        sku,
        version::TEXT AS version,
        quantity,
        order_id AS "orderId",
        occurred_at AS "occurredAt"
       FROM stock_event
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY occurred_at DESC, event_id DESC`,
      values,
    );

    return response.rows.map((row) => this.toStockEvent(row));
  }

  private applyEvent(projection: ProjectionState, event: StockEventRow): void {
    switch (event.type) {
      case StockEventType.STOCK_RECEIVED:
      case StockEventType.STOCK_RETURNED:
        projection.physical += event.quantity;
        break;
      case StockEventType.RESERVATION_CREATED:
        projection.reserved += event.quantity;
        break;
      case StockEventType.RESERVATION_RELEASED:
        projection.reserved -= event.quantity;
        break;
      case StockEventType.STOCK_SHIPPED:
        projection.physical -= event.quantity;
        projection.reserved -= event.quantity;
        break;
      default:
        throw new Error(`Unknown stock event type ${event.type}`);
    }

    if (
      projection.physical < 0 ||
      projection.reserved < 0 ||
      projection.reserved > projection.physical
    ) {
      throw new Error(`Invalid stock projection state for SKU ${event.sku}`);
    }
  }

  private toStockEvent(row: StockEventRow): StockEvent {
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
        throw new Error(`Unknown stock event type ${row.type}`);
    }
  }
}
