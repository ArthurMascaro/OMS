import { Module } from '@nestjs/common';

import { Capability } from '@oms/contracts';
import { PluginSdkModule } from '@oms/plugin-sdk';

import { HealthController } from './health.controller';

@Module({
  imports: [
    PluginSdkModule.register({
      id: 'marketplace-b',
      marketplace: 'Marketplace B',
      capabilities: [
        Capability.CANCEL_ORDER,
        Capability.SHIP_ORDER,
        Capability.UPDATE_STOCK,
      ],
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
