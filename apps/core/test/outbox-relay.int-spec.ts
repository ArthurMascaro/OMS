import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

import {
  Command,
  COMMANDS_EXCHANGE,
  CommandType,
  PLUGIN_QUEUE_PREFIX,
} from '@oms/contracts';

import { DatabaseModule } from '../src/database/database.module';
import { DatabaseService } from '../src/database/database.service';
import { MessagingModule } from '../src/messaging/messaging.module';
import { OutboxRelayService } from '../src/outbox/outbox-relay.service';
import { OutboxModule } from '../src/outbox/outbox.module';
import { OutboxService } from '../src/outbox/outbox.service';

interface OutboxRow {
  id: string;
  published_at: Date | null;
  next_attempt_at: Date | null;
  attempts: number;
  last_error: string | null;
}

interface DeliveredMessage {
  content: Buffer;
  properties: {
    messageId?: string;
    correlationId?: string;
    deliveryMode?: number;
  };
}

interface AmqplibTestChannel {
  assertQueue(queue: string, options: { durable: boolean }): Promise<unknown>;
  bindQueue(queue: string, exchange: string, key: string): Promise<unknown>;
  deleteQueue(queue: string): Promise<unknown>;
  get(
    queue: string,
    options: { noAck: boolean },
  ): Promise<false | DeliveredMessage>;
}

describe('OutboxRelayService (integração)', () => {
  let moduleRef: Awaited<ReturnType<typeof buildModuleWithoutScheduler>>;
  let database: DatabaseService;
  let outbox: OutboxService;
  let relay: OutboxRelayService;
  let amqp: AmqpConnection;
  let channel: AmqplibTestChannel;
  let pool: Pool;
  let createdIds: string[];
  let createdQueues: string[];

  const buildModuleWithoutScheduler = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DatabaseModule,
        MessagingModule,
        OutboxModule,
      ],
    }).compile();

  const newRoutingKey = (label: string) => `relay-${label}-${randomUUID()}`;

  const queueOf = (routingKey: string) => `${PLUGIN_QUEUE_PREFIX}${routingKey}`;

  const createQueueFor = async (routingKey: string) => {
    const queue = queueOf(routingKey);
    createdQueues.push(queue);
    await channel.assertQueue(queue, { durable: false });
    await channel.bindQueue(queue, COMMANDS_EXCHANGE, routingKey);
    return queue;
  };

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

  const expireBackoffOf = (routingKey: string) =>
    pool.query(
      `UPDATE outbox_message SET next_attempt_at = NOW() - INTERVAL '1 second'
       WHERE routing_key = $1 AND next_attempt_at IS NOT NULL`,
      [routingKey],
    );

  const drainMessageIds = async (queue: string) => {
    const messageIds: (string | undefined)[] = [];
    for (;;) {
      const message = await channel.get(queue, { noAck: true });
      if (message === false) return messageIds;
      messageIds.push(message.properties.messageId);
    }
  };

  const countForeignPendingRows = async () => {
    const { rows } = await pool.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM outbox_message WHERE published_at IS NULL',
    );
    return rows[0].total;
  };

  beforeAll(async () => {
    moduleRef = await buildModuleWithoutScheduler();
    database = moduleRef.get(DatabaseService);
    outbox = moduleRef.get(OutboxService);
    relay = moduleRef.get(OutboxRelayService);
    amqp = moduleRef.get(AmqpConnection);
    channel = amqp.channel as AmqplibTestChannel;
    pool = moduleRef.get(Pool);
  });

  beforeEach(async () => {
    createdIds = [];
    createdQueues = [];
    if ((await countForeignPendingRows()) !== 0) {
      throw new Error(
        'outbox_message tem linhas pendentes de fora do teste; limpe antes de rodar',
      );
    }
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await pool.query('DELETE FROM outbox_message WHERE id = ANY($1::uuid[])', [
      createdIds,
    ]);
    for (const queue of createdQueues) {
      await channel.deleteQueue(queue);
    }
  });

  afterAll(async () => {
    await pool.end();
    await moduleRef.close();
  });

  it('publica na fila do plugin e marca published_at', async () => {
    const routingKey = newRoutingKey('ok');
    const queue = await createQueueFor(routingKey);
    const { id, payload } = await enqueue(routingKey, 'corr-relay');

    await expect(relay.relayOnce()).resolves.toBe(1);

    const message = await channel.get(queue, { noAck: true });
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

  it('routing key sem fila deixa a linha pendente com backoff', async () => {
    const { id } = await enqueue(newRoutingKey('sem-fila'));

    await expect(relay.relayOnce()).resolves.toBe(0);

    const row = await findRow(id);
    expect(row?.published_at).toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toContain('unroutable');
    expect(row?.next_attempt_at?.getTime()).toBeGreaterThan(Date.now());
  });

  it('plugin sem fila não bloqueia a entrega para outro plugin', async () => {
    const pluginWithoutQueue = newRoutingKey('a');
    const pluginWithQueue = newRoutingKey('b');
    const queueOfB = await createQueueFor(pluginWithQueue);
    const rowOfA = await enqueue(pluginWithoutQueue);
    const rowOfB = await enqueue(pluginWithQueue);

    await expect(relay.relayOnce()).resolves.toBe(1);

    expect(await drainMessageIds(queueOfB)).toEqual([rowOfB.id]);
    expect((await findRow(rowOfB.id))?.published_at).not.toBeNull();

    const pendingOfA = await findRow(rowOfA.id);
    expect(pendingOfA?.published_at).toBeNull();
    expect(pendingOfA?.attempts).toBeGreaterThan(0);
    expect(pendingOfA?.next_attempt_at).not.toBeNull();
  });

  it('falha de uma routing key pula as linhas seguintes dela no lote', async () => {
    const pluginWithoutQueue = newRoutingKey('a');
    const pluginWithQueue = newRoutingKey('b');
    const queueOfB = await createQueueFor(pluginWithQueue);
    const firstOfA = await enqueue(pluginWithoutQueue);
    const rowOfB = await enqueue(pluginWithQueue);
    const secondOfA = await enqueue(pluginWithoutQueue);

    await expect(relay.relayOnce()).resolves.toBe(1);

    expect((await findRow(firstOfA.id))?.attempts).toBe(1);
    const skipped = await findRow(secondOfA.id);
    expect(skipped?.published_at).toBeNull();
    expect(skipped?.attempts).toBe(0);
    expect(await drainMessageIds(queueOfB)).toEqual([rowOfB.id]);
  });

  it('routing key em backoff é publicada em ordem de seq quando a fila aparece', async () => {
    const lateRoutingKey = newRoutingKey('a');
    const first = await enqueue(lateRoutingKey);
    const second = await enqueue(lateRoutingKey);

    await expect(relay.relayOnce()).resolves.toBe(0);

    const queue = await createQueueFor(lateRoutingKey);
    await expect(relay.relayOnce()).resolves.toBe(0);
    expect((await findRow(first.id))?.published_at).toBeNull();
    expect((await findRow(second.id))?.published_at).toBeNull();

    await expireBackoffOf(lateRoutingKey);
    await expect(relay.relayOnce()).resolves.toBe(2);

    expect(await drainMessageIds(queue)).toEqual([first.id, second.id]);
  });

  it('linha nova de uma routing key em backoff não passa na frente das antigas', async () => {
    const lateRoutingKey = newRoutingKey('a');
    const delayed = await enqueue(lateRoutingKey);
    await expect(relay.relayOnce()).resolves.toBe(0);

    const queue = await createQueueFor(lateRoutingKey);
    const enqueuedDuringBackoff = await enqueue(lateRoutingKey);
    await expect(relay.relayOnce()).resolves.toBe(0);
    expect((await findRow(enqueuedDuringBackoff.id))?.published_at).toBeNull();
    expect(await drainMessageIds(queue)).toEqual([]);

    await expireBackoffOf(lateRoutingKey);
    await expect(relay.relayOnce()).resolves.toBe(2);

    expect(await drainMessageIds(queue)).toEqual([
      delayed.id,
      enqueuedDuringBackoff.id,
    ]);
  });

  it('falha de conexão com o broker interrompe o lote', async () => {
    const firstKey = newRoutingKey('a');
    const secondKey = newRoutingKey('b');
    await createQueueFor(firstKey);
    await createQueueFor(secondKey);
    const first = await enqueue(firstKey);
    const second = await enqueue(secondKey);
    jest
      .spyOn(amqp, 'publish')
      .mockRejectedValueOnce(new Error('broker indisponível'));

    await expect(relay.relayOnce()).resolves.toBe(0);

    const failed = await findRow(first.id);
    expect(failed?.attempts).toBe(1);
    expect(failed?.last_error).toBe('broker indisponível');
    const notAttempted = await findRow(second.id);
    expect(notAttempted?.published_at).toBeNull();
    expect(notAttempted?.attempts).toBe(0);
  });

  it('stats conta as pendentes e a idade da mais antiga', async () => {
    const before = await relay.stats();
    const routingKey = newRoutingKey('stats');
    const oldest = await enqueue(routingKey);
    await enqueue(routingKey);
    await pool.query(
      `UPDATE outbox_message SET created_at = NOW() - INTERVAL '1 hour'
       WHERE id = $1`,
      [oldest.id],
    );

    const stats = await relay.stats();

    expect(before).toEqual({ pending: 0, oldestPendingAgeSeconds: null });
    expect(stats.pending).toBe(2);
    expect(stats.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(3600);
    expect(stats.oldestPendingAgeSeconds).toBeLessThan(3700);
  });

  it('purgePublished remove só publicadas antigas', async () => {
    const routingKey = newRoutingKey('purge');
    await createQueueFor(routingKey);
    const old = await enqueue(routingKey);
    const recent = await enqueue(routingKey);
    await expect(relay.relayOnce()).resolves.toBe(2);
    const pending = await enqueue(newRoutingKey('sem-fila'));

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
