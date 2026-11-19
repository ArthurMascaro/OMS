import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { COMMANDS_EXCHANGE, OUTBOX_BATCH_SIZE } from '@oms/contracts';

import { DatabaseService } from '../database/database.service';

const RELAY_INTERVAL_MS = 1000;
const PURGE_INTERVAL_MS = 3600000;
const PURGE_OLDER_THAN_DAYS = 7;
const PUBLISH_TIMEOUT_MS = 10000;

interface PendingRow {
  id: string;
  routing_key: string;
  type: string;
  correlation_id: string | null;
  payload: unknown;
}

// Recortes mínimos dos tipos do amqplib (não há @types/amqplib no projeto).
interface ReturnedMessage {
  properties: { messageId?: string };
}

interface ReturnEmitter {
  on(event: 'return', listener: (message: ReturnedMessage) => void): unknown;
}

interface RelayPublishOptions {
  persistent: boolean;
  mandatory: boolean;
  messageId: string;
  correlationId?: string;
  type: string;
  contentType: string;
  // Repassado ao ChannelWrapper do amqp-connection-manager: rejeita a promessa
  // se o broker não confirmar a tempo, para não segurar a transação aberta.
  timeout: number;
}

/**
 * Único ponto do core que publica comandos no RabbitMQ.
 *
 * O canal padrão do AmqpConnection é um ConfirmChannel: `publish` só resolve
 * quando o broker confirma (basic.ack). Com `mandatory`, uma mensagem sem fila
 * de destino volta como basic.return ANTES do basic.ack, e o ack ainda é
 * positivo. Por isso o evento `return` do canal é registrado por messageId e
 * conferido depois da confirmação: só marca published_at se houve ack e a
 * mensagem não voltou.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly returnedMessageIds = new Set<string>();
  private relaying = false;
  private returnListener?: Promise<void>;

  constructor(
    private readonly database: DatabaseService,
    private readonly amqp: AmqpConnection,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureReturnListener();
  }

  /**
   * Registra (uma vez) o listener de basic.return. relayOnce também o aguarda,
   * para nunca publicar sem detectar retornos mesmo que onModuleInit não tenha
   * rodado (ex.: TestingModule compilado sem init()).
   */
  private ensureReturnListener(): Promise<void> {
    // addSetup roda no canal atual e de novo a cada reconexão.
    this.returnListener ??= this.amqp.managedChannel.addSetup(
      (channel: ReturnEmitter) => {
        channel.on('return', (message) => {
          const { messageId } = message.properties;
          if (messageId) {
            this.returnedMessageIds.add(messageId);
          }
        });
        return Promise.resolve();
      },
    );
    return this.returnListener;
  }

  @Interval(RELAY_INTERVAL_MS)
  async scheduledRelay(): Promise<void> {
    if (this.relaying) {
      return;
    }
    this.relaying = true;
    try {
      await this.relayOnce();
    } catch (error) {
      this.logger.error(`Falha no relay do outbox: ${errorMessage(error)}`);
    } finally {
      this.relaying = false;
    }
  }

  @Interval(PURGE_INTERVAL_MS)
  async scheduledPurge(): Promise<void> {
    try {
      await this.purgePublished(PURGE_OLDER_THAN_DAYS);
    } catch (error) {
      this.logger.error(`Falha ao limpar o outbox: ${errorMessage(error)}`);
    }
  }

  async relayOnce(): Promise<number> {
    await this.ensureReturnListener();

    return this.database.transaction(async (client) => {
      const { rows } = await client.query<PendingRow>(
        `SELECT id, routing_key, type, correlation_id, payload
         FROM outbox_message
         WHERE published_at IS NULL
         ORDER BY seq
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [OUTBOX_BATCH_SIZE],
      );

      let published = 0;
      for (const row of rows) {
        try {
          await this.publish(row);
        } catch (error) {
          const reason = errorMessage(error);
          await client.query(
            `UPDATE outbox_message
             SET attempts = attempts + 1, last_error = $2
             WHERE id = $1`,
            [row.id, reason],
          );
          this.logger.warn(
            `Mensagem ${row.id} (${row.routing_key}) não publicada: ${reason}`,
          );
          break;
        }

        await client.query(
          'UPDATE outbox_message SET published_at = NOW() WHERE id = $1',
          [row.id],
        );
        published++;
      }

      return published;
    });
  }

  async purgePublished(olderThanDays: number): Promise<number> {
    const result = await this.database.transaction((client) =>
      client.query(
        `DELETE FROM outbox_message
         WHERE published_at IS NOT NULL
           AND published_at < NOW() - make_interval(days => $1)`,
        [olderThanDays],
      ),
    );
    return result.rowCount ?? 0;
  }

  private async publish(row: PendingRow): Promise<void> {
    this.returnedMessageIds.delete(row.id);

    const options: RelayPublishOptions = {
      persistent: true,
      mandatory: true,
      messageId: row.id,
      correlationId: row.correlation_id ?? undefined,
      type: row.type,
      contentType: 'application/json',
      timeout: PUBLISH_TIMEOUT_MS,
    };

    // Resolve só após o basic.ack do broker (ConfirmChannel).
    await this.amqp.publish(
      COMMANDS_EXCHANGE,
      row.routing_key,
      row.payload,
      options,
    );

    // O basic.return chega antes do basic.ack, então já foi processado aqui.
    if (this.returnedMessageIds.delete(row.id)) {
      throw new Error(
        `unroutable: nenhuma fila ligada a ${COMMANDS_EXCHANGE} com routing key "${row.routing_key}"`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
