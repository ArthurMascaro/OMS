import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PoolClient } from 'pg';

import { Capability, Command, CommandType } from '@oms/contracts';

import { OutboxService } from '../outbox/outbox.service';
import { PluginRegistryService } from '../plugin-registry/plugin-registry.service';

export interface DispatchInput {
  commandId: string;
  type: CommandType;
  pluginId: string;
  orderId: string;
  externalOrderId: string | null;
  reason?: string;
}

@Injectable()
export class OrderCommandDispatcher {
  constructor(
    private readonly outbox: OutboxService,
    private readonly pluginRegistry: PluginRegistryService,
  ) {}

  async dispatch(client: PoolClient, input: DispatchInput): Promise<void> {
    const { commandId, type, pluginId, orderId, externalOrderId } = input;

    if (!externalOrderId) {
      throw new UnprocessableEntityException(
        `Order ${orderId} has no external order id`,
      );
    }

    const supported = await this.pluginRegistry.supports(
      client,
      pluginId,
      Capability[type as keyof typeof Capability],
    );

    if (!supported) {
      throw new UnprocessableEntityException(
        `Plugin ${pluginId} does not support ${type}`,
      );
    }

    await this.outbox.enqueue(client, {
      id: commandId,
      routingKey: pluginId,
      type,
      correlationId: orderId,
      payload: this.buildPayload(input, externalOrderId),
    });
  }

  private buildPayload(input: DispatchInput, externalOrderId: string): Command {
    const base = {
      commandId: input.commandId,
      pluginId: input.pluginId,
      issuedAt: new Date().toISOString(),
    };
    const data = { orderId: input.orderId, externalOrderId };

    switch (input.type) {
      case CommandType.CANCEL_ORDER:
        return {
          ...base,
          type: input.type,
          data: { ...data, reason: input.reason ?? '' },
        };
      case CommandType.INVOICE_ORDER:
      case CommandType.SHIP_ORDER:
      case CommandType.RETURN_ORDER:
        return { ...base, type: input.type, data };
      default:
        throw new UnprocessableEntityException(
          `Command ${input.type} is not an order command`,
        );
    }
  }
}
