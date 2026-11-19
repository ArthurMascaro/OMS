import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';

import { Capability, CommandType, UpdateStockCommand } from '@oms/contracts';

import { PluginRegistryService } from '../plugin-registry/plugin-registry.service';
import type { StockAvailabilityPort } from '../stock/stock-availability.port';
import { OutboxService } from './outbox.service';

@Injectable()
export class OutboxStockAvailabilityAdapter implements StockAvailabilityPort {
  constructor(
    private readonly outbox: OutboxService,
    private readonly pluginRegistry: PluginRegistryService,
  ) {}

  async notifyAvailabilityChanged(
    client: PoolClient,
    update: UpdateStockCommand['data'],
  ): Promise<void> {
    const plugins = await this.pluginRegistry.findActiveByCapability(
      Capability.UPDATE_STOCK,
      client,
    );

    for (const plugin of plugins) {
      const id = randomUUID();
      await this.outbox.enqueue(client, {
        id,
        routingKey: plugin.id,
        type: CommandType.UPDATE_STOCK,
        correlationId: update.sku,
        payload: {
          commandId: id,
          type: CommandType.UPDATE_STOCK,
          pluginId: plugin.id,
          issuedAt: new Date().toISOString(),
          data: update,
        },
      });
    }
  }
}
