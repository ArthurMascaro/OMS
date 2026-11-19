import type { PoolClient } from 'pg';

import type { UpdateStockCommand } from '@oms/contracts';

export interface StockAvailabilityPort {
  notifyAvailabilityChanged(
    client: PoolClient,
    update: UpdateStockCommand['data'],
  ): Promise<void>;
}

export const STOCK_AVAILABILITY_PORT = Symbol('STOCK_AVAILABILITY_PORT');
