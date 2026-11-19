import type { UpdateStockCommand } from '@oms/contracts';

export interface StockAvailabilityPort {
  notifyAvailabilityChanged(
    update: UpdateStockCommand['data'],
  ): Promise<void>;
}

export const STOCK_AVAILABILITY_PORT = Symbol('STOCK_AVAILABILITY_PORT');
