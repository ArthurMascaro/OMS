import { Module } from '@nestjs/common';

import { OrdersInboundHandler } from './orders-inbound.handler';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, OrdersInboundHandler],
  exports: [OrdersInboundHandler],
})
export class OrdersModule {}
