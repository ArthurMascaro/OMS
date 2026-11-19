import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

@Injectable()
export class DatabaseService {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        const result = await work(client);

        await client.query('COMMIT');

        return result;
      } catch (error) {
        await client.query('ROLLBACK');

        if (this.isStockVersionConflict(error) && attempt < maxAttempts) {
          continue;
        }

        throw error;
      } finally {
        client.release();
      }
    }

    throw new Error('Transaction retry limit reached');
  }

  private isStockVersionConflict(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const databaseError = error as { code?: string; constraint?: string };
    return (
      databaseError.code === '23505' &&
      databaseError.constraint === 'stock_event_sku_version_key'
    );
  }
}
