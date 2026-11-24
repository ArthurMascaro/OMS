import { Module } from '@nestjs/common';

import { STOCK_PROJECTION_QUERY } from './stock-projection.contract';
import { StockProjectionService } from './stock-projection.service';

@Module({
  providers: [
    StockProjectionService,
    {
      provide: STOCK_PROJECTION_QUERY,
      useExisting: StockProjectionService,
    },
  ],
  exports: [STOCK_PROJECTION_QUERY],
})
export class StockProjectionModule {}
