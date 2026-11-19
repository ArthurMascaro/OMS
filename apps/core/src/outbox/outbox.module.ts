import { Module } from '@nestjs/common';

import { MessagingModule } from '../messaging/messaging.module';
import { PluginRegistryModule } from '../plugin-registry/plugin-registry.module';
import { STOCK_AVAILABILITY_PORT } from '../stock/stock-availability.port';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxStockAvailabilityAdapter } from './outbox-stock-availability.adapter';
import { OutboxService } from './outbox.service';

@Module({
  imports: [MessagingModule, PluginRegistryModule],
  providers: [
    OutboxService,
    OutboxRelayService,
    OutboxStockAvailabilityAdapter,
    {
      provide: STOCK_AVAILABILITY_PORT,
      useExisting: OutboxStockAvailabilityAdapter,
    },
  ],
  exports: [OutboxService, STOCK_AVAILABILITY_PORT],
})
export class OutboxModule {}
