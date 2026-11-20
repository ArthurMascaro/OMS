import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Pool, PoolClient } from 'pg';

import { COMMANDS_EXCHANGE, OUTBOX_BATCH_SIZE } from '@oms/contracts';

import { DatabaseService } from '../database/database.service';

const RELAY_INTERVAL_MS = 1000;
const PURGE_INTERVAL_MS = 3600000;
const PURGE_OLDER_THAN_DAYS = 7;
const BROKER_CONFIRM_TIMEOUT_MS = 10000;
const MAX_BACKOFF_EXPONENT = 6;
const MAX_BACKOFF_SECONDS = 60;

export interface OutboxStats {
  pending: number;
  oldestPendingAgeSeconds: number | null;
}

interface PendingRow {
  id: string;
  routing_key: string;
  type: string;
  correlation_id: string | null;
  payload: unknown;
}

interface AmqplibReturnedMessage {
  properties: { messageId?: string };
}

interface AmqplibChannelWithReturnEvents {
  on(
    event: 'return',
    listener: (message: AmqplibReturnedMessage) => void,
  ): unknown;
}

interface ConfirmedPublishOptions {
  persistent: boolean;
  mandatory: boolean;
  messageId: string;
  correlationId?: string;
  type: string;
  contentType: string;
  timeout: number;
}

export class UnroutableMessageError extends Error {
  constructor(routingKey: string) {
    super(
      `unroutable: nenhuma fila ligada a ${COMMANDS_EXCHANGE} com routing key "${routingKey}"`,
    );
  }
}

@Injectable()
export class OutboxRelayService
  implements OnModuleInit, BeforeApplicationShutdown
{
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly messageIdsReturnedAsUnroutable = new Set<string>();
  private returnListenerRegistration?: Promise<void>;
  private runningRelay: Promise<void> | null = null;
  private isShuttingDown = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly pool: Pool,
    private readonly amqp: AmqpConnection,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.registerReturnListenerOnEveryChannel();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.isShuttingDown = true;
    await this.runningRelay;
  }

  @Interval(RELAY_INTERVAL_MS)
  async scheduledRelay(): Promise<void> {
    if (this.runningRelay || this.isShuttingDown) {
      return;
    }
    this.runningRelay = this.relayLoggingFailure();
    try {
      await this.runningRelay;
    } finally {
      this.runningRelay = null;
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
    await this.registerReturnListenerOnEveryChannel();

    return this.database.transaction(async (client) => {
      const rows = await this.lockPendingRowsOfReadyRoutingKeys(client);
      const routingKeysFailedInThisBatch = new Set<string>();
      let published = 0;

      for (const row of rows) {
        if (routingKeysFailedInThisBatch.has(row.routing_key)) {
          continue;
        }

        try {
          await this.publishAndAwaitBrokerConfirm(row);
        } catch (error) {
          routingKeysFailedInThisBatch.add(row.routing_key);
          await this.recordFailedAttemptWithBackoff(client, row, error);
          if (isBrokerFailure(error)) {
            break;
          }
          continue;
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

  async stats(): Promise<OutboxStats> {
    const { rows } = await this.pool.query<OutboxStats>(
      `SELECT
        count(*)::int AS pending,
        FLOOR(EXTRACT(EPOCH FROM NOW() - MIN(created_at)))::int
          AS "oldestPendingAgeSeconds"
       FROM outbox_message
       WHERE published_at IS NULL`,
    );
    return rows[0];
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

  private async relayLoggingFailure(): Promise<void> {
    try {
      await this.relayOnce();
    } catch (error) {
      this.logger.error(`Falha no relay do outbox: ${errorMessage(error)}`);
    }
  }

  private registerReturnListenerOnEveryChannel(): Promise<void> {
    this.returnListenerRegistration ??= this.amqp.managedChannel.addSetup(
      (channel: AmqplibChannelWithReturnEvents) => {
        channel.on('return', (message) => {
          const { messageId } = message.properties;
          if (messageId) {
            this.messageIdsReturnedAsUnroutable.add(messageId);
          }
        });
        return Promise.resolve();
      },
    );
    return this.returnListenerRegistration;
  }

  private async lockPendingRowsOfReadyRoutingKeys(
    client: PoolClient,
  ): Promise<PendingRow[]> {
    const { rows } = await client.query<PendingRow>(
      `SELECT id, routing_key, type, correlation_id, payload
       FROM outbox_message pending
       WHERE published_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM outbox_message delayed
           WHERE delayed.routing_key = pending.routing_key
             AND delayed.published_at IS NULL
             AND delayed.next_attempt_at > NOW()
         )
       ORDER BY seq
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [OUTBOX_BATCH_SIZE],
    );
    return rows;
  }

  private async recordFailedAttemptWithBackoff(
    client: PoolClient,
    row: PendingRow,
    error: unknown,
  ): Promise<void> {
    const reason = errorMessage(error);
    await client.query(
      `UPDATE outbox_message
       SET attempts = attempts + 1,
           last_error = $2,
           next_attempt_at = NOW() + make_interval(secs => LEAST(
             $3::int,
             power(2, LEAST(attempts + 1, $4::int))
           ))
       WHERE id = $1`,
      [row.id, reason, MAX_BACKOFF_SECONDS, MAX_BACKOFF_EXPONENT],
    );
    this.logger.warn(
      `Mensagem ${row.id} (${row.routing_key}) não publicada, routing key em backoff: ${reason}`,
    );
  }

  private async publishAndAwaitBrokerConfirm(row: PendingRow): Promise<void> {
    this.messageIdsReturnedAsUnroutable.delete(row.id);

    const options: ConfirmedPublishOptions = {
      persistent: true,
      mandatory: true,
      messageId: row.id,
      correlationId: row.correlation_id ?? undefined,
      type: row.type,
      contentType: 'application/json',
      timeout: BROKER_CONFIRM_TIMEOUT_MS,
    };

    await this.amqp.publish(
      COMMANDS_EXCHANGE,
      row.routing_key,
      row.payload,
      options,
    );

    if (this.wasReturnedAsUnroutableBeforeConfirm(row.id)) {
      throw new UnroutableMessageError(row.routing_key);
    }
  }

  private wasReturnedAsUnroutableBeforeConfirm(messageId: string): boolean {
    return this.messageIdsReturnedAsUnroutable.delete(messageId);
  }
}

function isBrokerFailure(error: unknown): boolean {
  return !(error instanceof UnroutableMessageError);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
