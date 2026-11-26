import { Module } from '@nestjs/common';

import { MessagingModule } from '../messaging/messaging.module';
import { OrdersController } from './orders.controller';

@Module({
  imports: [MessagingModule],
  controllers: [OrdersController],
})
export class OrdersModule {}
