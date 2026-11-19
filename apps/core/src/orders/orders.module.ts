import { Module } from '@nestjs/common';

import { OutboxModule } from '../outbox/outbox.module';
import { PluginRegistryModule } from '../plugin-registry/plugin-registry.module';
import { StockModule } from '../stock/stock.module';
import { OrderCommandDispatcher } from './order-command.dispatcher';
import { OrdersInboundHandler } from './orders-inbound.handler';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [StockModule, OutboxModule, PluginRegistryModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersInboundHandler, OrderCommandDispatcher],
  exports: [OrdersInboundHandler],
})
export class OrdersModule {}
