import { Module } from '@nestjs/common';

import { OutboxModule } from '../outbox/outbox.module';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';

@Module({
  imports: [OutboxModule],
  controllers: [StockController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
