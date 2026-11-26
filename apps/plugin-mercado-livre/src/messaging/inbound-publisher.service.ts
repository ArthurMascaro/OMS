import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { ServiceUnavailableException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  CommandProcessed,
  INBOUND_QUEUE,
  InboundMessageType,
  type OrderCanceledByChannel,
  type OrderItem,
  type OrderReceived,
} from '@oms/contracts';

import { PLUGIN_ID } from '../plugin.constants';

const BROKER_CONFIRM_TIMEOUT_MS = 10000;
const DEFAULT_EXCHANGE = '';

export interface CommandResult {
  success: boolean;
  error?: string;
}

@Injectable()
export class InboundPublisherService {
  constructor(private readonly amqp: AmqpConnection) {}

  async publishOrderReceived(input: {
    externalOrderId: string;
    items: OrderItem[];
  }): Promise<string> {
    const message: OrderReceived = {
      messageId: randomUUID(),
      type: InboundMessageType.ORDER_RECEIVED,
      pluginId: PLUGIN_ID,
      issuedAt: new Date().toISOString(),
      data: {
        externalOrderId: input.externalOrderId,
        items: input.items,
      },
    };

    await this.publish(message);

    return message.messageId;
  }

  async publishOrderCanceledByChannel(input: {
    externalOrderId: string;
    reason: string;
  }): Promise<string> {
    const message: OrderCanceledByChannel = {
      messageId: randomUUID(),
      type: InboundMessageType.ORDER_CANCELED_BY_CHANNEL,
      pluginId: PLUGIN_ID,
      issuedAt: new Date().toISOString(),
      data: {
        externalOrderId: input.externalOrderId,
        reason: input.reason,
      },
    };

    await this.publish(message);

    return message.messageId;
  }

  async publishCommandProcessed(
    commandId: string,
    result: CommandResult,
  ): Promise<string> {
    const message: CommandProcessed = {
      messageId: randomUUID(),
      type: InboundMessageType.COMMAND_PROCESSED,
      pluginId: PLUGIN_ID,
      issuedAt: new Date().toISOString(),
      data: {
        commandId,
        success: result.success,
        error: result.error,
      },
    };

    await this.publish(message);

    return message.messageId;
  }

  private async publish(
    message: OrderReceived | OrderCanceledByChannel | CommandProcessed,
  ): Promise<void> {
    try {
      await this.amqp.publish(DEFAULT_EXCHANGE, INBOUND_QUEUE, message, {
        persistent: true,
        messageId: message.messageId,
        timeout: BROKER_CONFIRM_TIMEOUT_MS,
      });
    } catch {
      throw new ServiceUnavailableException(
        'Broker indisponível, mensagem não enviada',
      );
    }
  }
}
