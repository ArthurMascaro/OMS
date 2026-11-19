import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

import { Command, COMMANDS_EXCHANGE, CommandType } from '@oms/contracts';

import { DatabaseModule } from '../src/database/database.module';
import { DatabaseService } from '../src/database/database.service';
import { MessagingModule } from '../src/messaging/messaging.module';
import { OutboxRelayService } from '../src/outbox/outbox-relay.service';
import { OutboxModule } from '../src/outbox/outbox.module';
import { OutboxService } from '../src/outbox/outbox.service';

const TEST_QUEUE = 'plugin.test';
const TEST_ROUTING_KEY = 'test';

interface OutboxRow {
  id: string;
  published_at: Date | null;
  attempts: number;
  last_error: string | null;
}

// Recorte do Channel do amqplib usado pelo teste (sem @types/amqplib).
interface TestChannel {
  assertQueue(queue: string, options: { durable: boolean }): Promise<unknown>;
  bindQueue(queue: string, exchange: string, key: string): Promise<unknown>;
  purgeQueue(queue: string): Promise<unknown>;
  deleteQueue(queue: string): Promise<unknown>;
  get(
    queue: string,
    options: { noAck: boolean },
  ): Promise<
    | false
    | {
        content: Buffer;
        properties: {
          messageId?: string;
          correlationId?: string;
          deliveryMode?: number;
        };
      }
  >;
}

describe('OutboxRelayService (integração)', () => {
  let moduleRef: Awaited<ReturnType<typeof buildModule>>;
  let database: DatabaseService;
  let outbox: OutboxService;
  let relay: OutboxRelayService;
  let channel: TestChannel;
  let pool: Pool;
  let createdIds: string[];

  // ScheduleModule não é registrado: os @Interval do relay ficam inertes e o
  // teste controla cada execução chamando relayOnce() diretamente.
  const buildModule = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DatabaseModule,
        MessagingModule,
        OutboxModule,
      ],
    }).compile();

  const buildCommand = (): Command => ({
    commandId: randomUUID(),
    type: CommandType.UPDATE_STOCK,
    pluginId: 'plugin-teste',
    issuedAt: new Date().toISOString(),
    data: { sku: 'SKU-1', available: 5 },
  });

  const enqueue = async (routingKey: string, correlationId?: string) => {
    const id = randomUUID();
    const payload = buildCommand();
    createdIds.push(id);
    await database.transaction((client) =>
      outbox.enqueue(client, {
        id,
        routingKey,
        type: payload.type,
        correlationId,
        payload,
      }),
    );
    return { id, payload };
  };

  const findRow = async (id: string) => {
    const { rows } = await pool.query<OutboxRow>(
      'SELECT * FROM outbox_message WHERE id = $1',
      [id],
    );
    return rows[0] as OutboxRow | undefined;
  };

  beforeAll(async () => {
    moduleRef = await buildModule();
    database = moduleRef.get(DatabaseService);
    outbox = moduleRef.get(OutboxService);
    relay = moduleRef.get(OutboxRelayService);
    channel = moduleRef.get(AmqpConnection).channel as TestChannel;
    pool = moduleRef.get(Pool);
  });

  beforeEach(async () => {
    createdIds = [];
    const { rows } = await pool.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM outbox_message WHERE published_at IS NULL',
    );
    if (rows[0].total !== 0) {
      throw new Error(
        'outbox_message tem linhas pendentes de fora do teste; limpe antes de rodar',
      );
    }
    await channel.assertQueue(TEST_QUEUE, { durable: false });
    await channel.bindQueue(TEST_QUEUE, COMMANDS_EXCHANGE, TEST_ROUTING_KEY);
    await channel.purgeQueue(TEST_QUEUE);
  });

  afterEach(async () => {
    await pool.query('DELETE FROM outbox_message WHERE id = ANY($1::uuid[])', [
      createdIds,
    ]);
    await channel.deleteQueue(TEST_QUEUE);
  });

  afterAll(async () => {
    await pool.end();
    await moduleRef.close();
  });

  it('publica na fila do plugin e marca published_at', async () => {
    const { id, payload } = await enqueue(TEST_ROUTING_KEY, 'corr-relay');

    await expect(relay.relayOnce()).resolves.toBe(1);

    const message = await channel.get(TEST_QUEUE, { noAck: true });
    expect(message).not.toBe(false);
    if (message === false) return;
    expect(JSON.parse(message.content.toString())).toEqual(payload);
    expect(message.properties.messageId).toBe(id);
    expect(message.properties.correlationId).toBe('corr-relay');
    expect(message.properties.deliveryMode).toBe(2);

    const row = await findRow(id);
    expect(row?.published_at).not.toBeNull();
    expect(row?.attempts).toBe(0);
  });

  it('routing key sem fila deixa a linha pendente', async () => {
    const { id } = await enqueue('sem-fila');

    await expect(relay.relayOnce()).resolves.toBe(0);

    const row = await findRow(id);
    expect(row?.published_at).toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toContain('unroutable');
  });

  it('mantém a ordem por seq e para no primeiro erro do lote', async () => {
    const first = await enqueue('sem-fila');
    const second = await enqueue(TEST_ROUTING_KEY);

    await expect(relay.relayOnce()).resolves.toBe(0);

    const firstRow = await findRow(first.id);
    expect(firstRow?.published_at).toBeNull();
    expect(firstRow?.attempts).toBe(1);

    const secondRow = await findRow(second.id);
    expect(secondRow?.published_at).toBeNull();
    expect(secondRow?.attempts).toBe(0);

    await expect(channel.get(TEST_QUEUE, { noAck: true })).resolves.toBe(false);
  });

  it('purgePublished remove só publicadas antigas', async () => {
    const old = await enqueue(TEST_ROUTING_KEY);
    const recent = await enqueue(TEST_ROUTING_KEY);
    await expect(relay.relayOnce()).resolves.toBe(2);
    const pending = await enqueue('sem-fila');

    await pool.query(
      `UPDATE outbox_message SET published_at = NOW() - INTERVAL '10 days'
       WHERE id = $1`,
      [old.id],
    );

    await expect(relay.purgePublished(7)).resolves.toBe(1);

    expect(await findRow(old.id)).toBeUndefined();
    expect(await findRow(recent.id)).toBeDefined();
    expect(await findRow(pending.id)).toBeDefined();
  });
});
