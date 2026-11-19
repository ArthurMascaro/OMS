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

// Default exchange: a routing key é o nome da fila.
const DEFAULT_EXCHANGE = '';
const REPUBLISH_TIMEOUT_MS = 10000;

// Recorte do ConsumeMessage do amqplib (não há @types/amqplib no projeto).
export interface ConsumeMessage {
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

/**
 * Consumer da fila core.inbound (mensagens dos plugins).
 *
 * O golevelup, por padrão, faz nack COM requeue quando o handler lança, o que
 * gera loop infinito. Por isso:
 * - erros do handler são tratados aqui: com tentativas restantes, a mensagem é
 *   republicada em core.inbound com x-retry-count + 1 e a original recebe ack;
 *   sem tentativas, retorna Nack(false) e o DLX da fila a leva à core.inbound.dlq.
 * - erros fora do handler (JSON inválido no deserializer, falha ao republicar)
 *   caem no errorHandler, que faz nack sem requeue: vão direto à DLQ.
 *
 * A fila é declarada pelo MessagingModule (com DLX); aqui só é verificada
 * (createQueueIfNotExists: false), para não redeclará-la com outros argumentos.
 */
@Injectable()
export class InboundConsumer {
  private readonly logger = new Logger(InboundConsumer.name);

  constructor(
    private readonly handler: OrdersInboundHandler,
    private readonly amqp: AmqpConnection,
  ) {}

  @RabbitSubscribe({
    queue: INBOUND_QUEUE,
    createQueueIfNotExists: false,
    errorHandler: defaultNackErrorHandler,
  })
  async consume(
    message: InboundMessage,
    raw: ConsumeMessage,
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
        return new Nack(false);
      }

      this.logger.warn(
        `Mensagem ${raw.properties.messageId} falhou (tentativa ${retryCount + 1}), republicando: ${reason}`,
      );
      await this.republish(raw, retryCount + 1);
    }
  }

  private retryCountOf(raw: ConsumeMessage): number {
    const value = Number(raw.properties.headers?.[RETRY_COUNT_HEADER] ?? 0);
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  // Resolve só após a confirmação do broker (canal padrão é ConfirmChannel);
  // a original só recebe ack depois disso.
  private async republish(raw: ConsumeMessage, retryCount: number) {
    const { properties } = raw;
    await this.amqp.publish(DEFAULT_EXCHANGE, INBOUND_QUEUE, raw.content, {
      persistent: true,
      contentType: properties.contentType,
      contentEncoding: properties.contentEncoding,
      correlationId: properties.correlationId,
      messageId: properties.messageId,
      timestamp: properties.timestamp,
      type: properties.type,
      appId: properties.appId,
      headers: { ...properties.headers, [RETRY_COUNT_HEADER]: retryCount },
      timeout: REPUBLISH_TIMEOUT_MS,
    });
  }
}
