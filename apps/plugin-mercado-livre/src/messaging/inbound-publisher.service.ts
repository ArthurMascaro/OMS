import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { ServiceUnavailableException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  INBOUND_QUEUE,
  InboundMessageType,
  type OrderCanceledByChannel,
  type OrderItem,
  type OrderReceived,
} from '@oms/contracts';

const PLUGIN_ID = 'mercado-livre';
const BROKER_CONFIRM_TIMEOUT_MS = 10000;
const DEFAULT_EXCHANGE = '';

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

  private async publish(
    message: OrderReceived | OrderCanceledByChannel,
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
