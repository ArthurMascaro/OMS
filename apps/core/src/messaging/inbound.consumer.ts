import {
  AmqpConnection,
  defaultNackErrorHandler,
  Nack,
  RabbitSubscribe,
} from '@golevelup/nestjs-rabbitmq';
import { Injectable, Logger } from '@nestjs/common';

import {
  INBOUND_QUEUE,
  type InboundMessage,
  MAX_INBOUND_RETRIES,
} from '@oms/contracts';

import { OrdersInboundHandler } from '../orders/orders-inbound.handler';

export const RETRY_COUNT_HEADER = 'x-retry-count';

const DEFAULT_EXCHANGE_ROUTING_BY_QUEUE_NAME = '';
const BROKER_CONFIRM_TIMEOUT_MS = 10000;

export interface AmqplibConsumeMessage {
  content: Buffer;
  properties: {
    contentType?: string;
    contentEncoding?: string;
    headers?: Record<string, unknown>;
    correlationId?: string;
    messageId?: string;
    timestamp?: number;
    type?: string;
    appId?: string;
  };
}

const QUEUE_DECLARED_BY_MESSAGING_MODULE = { createQueueIfNotExists: false };
const NACK_WITHOUT_REQUEUE_TO_DEAD_LETTER = new Nack(false);

@Injectable()
export class InboundConsumer {
  private readonly logger = new Logger(InboundConsumer.name);

  constructor(
    private readonly handler: OrdersInboundHandler,
    private readonly amqp: AmqpConnection,
  ) {}

  @RabbitSubscribe({
    queue: INBOUND_QUEUE,
    ...QUEUE_DECLARED_BY_MESSAGING_MODULE,
    errorHandler: defaultNackErrorHandler,
  })
  async consume(
    message: InboundMessage,
    raw: AmqplibConsumeMessage,
  ): Promise<Nack | void> {
    try {
      await this.handler.handle(message);
    } catch (error) {
      const retryCount = this.retryCountOf(raw);
      const reason = error instanceof Error ? error.message : String(error);

      if (retryCount >= MAX_INBOUND_RETRIES) {
        this.logger.error(
          `Mensagem ${raw.properties.messageId} enviada à DLQ após ${retryCount} retentativas: ${reason}`,
        );
        return NACK_WITHOUT_REQUEUE_TO_DEAD_LETTER;
      }

      this.logger.warn(
        `Mensagem ${raw.properties.messageId} falhou (tentativa ${retryCount + 1}), republicando: ${reason}`,
      );
      await this.republishAndAwaitBrokerConfirm(raw, retryCount + 1);
    }
  }

  private retryCountOf(raw: AmqplibConsumeMessage): number {
    const value = Number(raw.properties.headers?.[RETRY_COUNT_HEADER] ?? 0);
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  private async republishAndAwaitBrokerConfirm(
    raw: AmqplibConsumeMessage,
    retryCount: number,
  ) {
    const { properties } = raw;
    await this.amqp.publish(
      DEFAULT_EXCHANGE_ROUTING_BY_QUEUE_NAME,
      INBOUND_QUEUE,
      raw.content,
      {
        persistent: true,
        contentType: properties.contentType,
        contentEncoding: properties.contentEncoding,
        correlationId: properties.correlationId,
        messageId: properties.messageId,
        timestamp: properties.timestamp,
        type: properties.type,
        appId: properties.appId,
        headers: { ...properties.headers, [RETRY_COUNT_HEADER]: retryCount },
        timeout: BROKER_CONFIRM_TIMEOUT_MS,
      },
    );
  }
}
