import { Module } from '@nestjs/common';

import { OrdersModule } from '../orders/orders.module';
import { InboundConsumer } from './inbound.consumer';

@Module({
  imports: [OrdersModule],
  providers: [InboundConsumer],
})
export class InboundModule {}
