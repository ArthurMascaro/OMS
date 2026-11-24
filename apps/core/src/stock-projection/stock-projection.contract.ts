import type { StockBalance, StockEvent } from '@oms/contracts';

export interface StockMovementFilter {
  sku?: string;
  orderId?: string;
}

export interface StockProjectionQuery {
  getBalance(sku: string): Promise<StockBalance>;
  getBalances(skus: readonly string[]): Promise<StockBalance[]>;
  getMovements(filter: StockMovementFilter): Promise<StockEvent[]>;
}

export const STOCK_PROJECTION_QUERY = Symbol('STOCK_PROJECTION_QUERY');
