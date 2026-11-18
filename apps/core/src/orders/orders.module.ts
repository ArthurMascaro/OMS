import { Module } from '@nestjs/common';

import { StockModule } from '../stock/stock.module';
import { OrdersInboundHandler } from './orders-inbound.handler';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [StockModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersInboundHandler],
  exports: [OrdersInboundHandler],
})
export class OrdersModule {}
