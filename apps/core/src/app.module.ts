import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { InboundModule } from './messaging/inbound.module';
import { MessagingModule } from './messaging/messaging.module';
import { OrdersModule } from './orders/orders.module';
import { OutboxModule } from './outbox/outbox.module';
import { PluginRegistryModule } from './plugin-registry/plugin-registry.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    MessagingModule,
    OutboxModule,
    PluginRegistryModule,
    OrdersModule,
    InboundModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
