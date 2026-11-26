import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { Capability } from '@oms/contracts';
import { PluginSdkModule } from '@oms/plugin-sdk';

import { HealthController } from './health.controller';
import { MessagingModule } from './messaging/messaging.module';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PluginSdkModule.register({
      id: 'mercado-livre',
      marketplace: 'Mercado Livre',
      capabilities: [
        Capability.INVOICE_ORDER,
        Capability.CANCEL_ORDER,
        Capability.SHIP_ORDER,
        Capability.UPDATE_STOCK,
      ],
    }),
    MessagingModule,
    OrdersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
