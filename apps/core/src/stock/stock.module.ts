import { Module } from '@nestjs/common';

import { OutboxModule } from '../outbox/outbox.module';
import { StockProjectionModule } from '../stock-projection/stock-projection.module';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';

@Module({
  imports: [OutboxModule, StockProjectionModule],
  controllers: [StockController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
