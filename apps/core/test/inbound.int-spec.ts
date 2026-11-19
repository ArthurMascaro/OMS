import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

import {
  INBOUND_DLQ,
  INBOUND_QUEUE,
  InboundMessage,
  InboundMessageType,
  MAX_INBOUND_RETRIES,
  OrderStatus,
} from '@oms/contracts';

import { DatabaseModule } from '../src/database/database.module';
import { InboundModule } from '../src/messaging/inbound.module';
import { MessagingModule } from '../src/messaging/messaging.module';
import { OrdersInboundHandler } from '../src/orders/orders-inbound.handler';

// Recorte do Channel do amqplib usado pelo teste (sem @types/amqplib).
interface TestChannel {
  purgeQueue(queue: string): Promise<unknown>;
  checkQueue(queue: string): Promise<{ messageCount: number }>;
  get(
    queue: string,
    options: { noAck: boolean },
  ): Promise<
    | false
    | {
        content: Buffer;
        properties: { headers?: Record<string, unknown> };
      }
  >;
}

const WAIT_TIMEOUT_MS = 10000;

jest.setTimeout(WAIT_TIMEOUT_MS * 2);
const WAIT_STEP_MS = 50;

const waitFor = async <T>(
  probe: () => Promise<T | undefined>,
  description: string,
): Promise<T> => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  throw new Error(`timeout esperando ${description}`);
};

describe('Consumer da core.inbound (integração)', () => {
  let moduleRef: Awaited<ReturnType<typeof buildModule>>;
  let amqp: AmqpConnection;
  let channel: TestChannel;
  let pool: Pool;
  let handler: OrdersInboundHandler;
  const pluginId = `plugin-inbound-${randomUUID()}`;
  const orderIds: string[] = [];
  const skus: string[] = [];

  const buildModule = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DatabaseModule,
        MessagingModule,
        InboundModule,
      ],
    }).compile();

  const publish = (content: unknown, messageId: string = randomUUID()) =>
    amqp.publish('', INBOUND_QUEUE, content, {
      persistent: true,
      messageId,
      contentType: 'application/json',
    });

  // Lê a DLQ até achar a mensagem esperada (descarta resíduos de outras execuções).
  const takeFromDlq = (matches: (content: string) => boolean) =>
    waitFor(async () => {
      const message = await channel.get(INBOUND_DLQ, { noAck: true });
      if (message === false) return undefined;
      return matches(message.content.toString()) ? message : undefined;
    }, 'mensagem na DLQ');

  const inboundIsEmpty = async () =>
    (await channel.checkQueue(INBOUND_QUEUE)).messageCount === 0;

  const orderOf = async (externalOrderId: string) => {
    const { rows } = await pool.query<{ id: string; status: OrderStatus }>(
      `SELECT id, status FROM "order"
       WHERE plugin_id = $1 AND external_order_id = $2`,
      [pluginId, externalOrderId],
    );
    return rows;
  };

  beforeAll(async () => {
    moduleRef = await buildModule();
    amqp = moduleRef.get(AmqpConnection);
    channel = amqp.channel as TestChannel;
    pool = moduleRef.get(Pool);
    handler = moduleRef.get(OrdersInboundHandler);

    // Purga antes de init(): o consumer só assina no onApplicationBootstrap.
    await channel.purgeQueue(INBOUND_QUEUE);
    await channel.purgeQueue(INBOUND_DLQ);
    await moduleRef.init();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (orderIds.length) {
      await pool.query('DELETE FROM order_command WHERE order_id = ANY($1)', [
        orderIds,
      ]);
      await pool.query('DELETE FROM order_item WHERE order_id = ANY($1)', [
        orderIds,
      ]);
      await pool.query('DELETE FROM "order" WHERE id = ANY($1)', [orderIds]);
    }
    if (skus.length) {
      await pool.query(
        'DELETE FROM outbox_message WHERE correlation_id = ANY($1)',
        [skus],
      );
    }
    await pool.end();
    await moduleRef.close();
  });

  it('ORDER_RECEIVED cria o pedido uma única vez, mesmo entregue duas vezes', async () => {
    // Estoque de 1 unidade e pedido de 2: o pedido é cancelado por OUT_OF_STOCK
    // sem gerar stock_event ligado a ele, então pode ser removido no afterAll.
    const sku = `SKU-${randomUUID()}`;
    skus.push(sku);
    await pool.query(
      `INSERT INTO stock_event (sku, version, type, quantity)
       VALUES ($1, 1, 'STOCK_RECEIVED', 1)`,
      [sku],
    );
    const externalOrderId = `ext-${randomUUID()}`;
    const message: InboundMessage = {
      messageId: randomUUID(),
      type: InboundMessageType.ORDER_RECEIVED,
      pluginId,
      issuedAt: new Date().toISOString(),
      data: {
        externalOrderId,
        items: [{ sku, quantity: 2, unitPriceCents: 1000 }],
      },
    };

    await publish(message, message.messageId);
    await publish(message, message.messageId);

    const [order] = await waitFor(async () => {
      const rows = await orderOf(externalOrderId);
      return rows.length && rows[0].status === OrderStatus.CANCELED
        ? rows
        : undefined;
    }, 'pedido criado');
    orderIds.push(order.id);

    await waitFor(
      async () => ((await inboundIsEmpty()) ? true : undefined),
      'core.inbound vazia',
    );
    expect(await orderOf(externalOrderId)).toHaveLength(1);
  });

  it('COMMAND_PROCESSED marca o order_command como SUCCEEDED', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "order" (plugin_id, external_order_id, status, total_cents)
       VALUES ($1, $2, 'INVOICED', 100) RETURNING id`,
      [pluginId, `ext-${randomUUID()}`],
    );
    const orderId = rows[0].id;
    orderIds.push(orderId);
    const commandId = randomUUID();
    await pool.query(
      `INSERT INTO order_command (command_id, order_id, plugin_id, type)
       VALUES ($1, $2, $3, 'INVOICE_ORDER')`,
      [commandId, orderId, pluginId],
    );

    await publish({
      messageId: randomUUID(),
      type: InboundMessageType.COMMAND_PROCESSED,
      pluginId,
      issuedAt: new Date().toISOString(),
      data: { commandId, success: true },
    });

    const status = await waitFor(async () => {
      const result = await pool.query<{ status: string }>(
        'SELECT status FROM order_command WHERE command_id = $1',
        [commandId],
      );
      return result.rows[0].status === 'SUCCEEDED' ? 'SUCCEEDED' : undefined;
    }, 'order_command SUCCEEDED');
    expect(status).toBe('SUCCEEDED');
  });

  it('type desconhecido esgota as tentativas e termina na DLQ', async () => {
    const messageId = randomUUID();
    await publish(
      {
        messageId,
        type: 'DESCONHECIDO',
        pluginId,
        issuedAt: new Date().toISOString(),
        data: {},
      },
      messageId,
    );

    const dead = await takeFromDlq((content) => content.includes(messageId));
    expect(dead.properties.headers?.['x-retry-count']).toBe(
      MAX_INBOUND_RETRIES,
    );
    expect(await inboundIsEmpty()).toBe(true);
  });

  it('conteúdo que não é JSON termina na DLQ', async () => {
    const marker = `nao-e-json-${randomUUID()}`;
    await publish(Buffer.from(marker));

    const dead = await takeFromDlq((content) => content === marker);
    expect(dead.content.toString()).toBe(marker);
    expect(await inboundIsEmpty()).toBe(true);
  });

  it('handler que falha uma vez é processado na segunda tentativa', async () => {
    const messageId = randomUUID();
    const original = handler.handle.bind(handler);
    const calls: InboundMessage[] = [];
    jest.spyOn(handler, 'handle').mockImplementation((message) => {
      if (message.messageId !== messageId) return original(message);
      calls.push(message);
      return calls.length === 1
        ? Promise.reject(new Error('falha transitória'))
        : Promise.resolve();
    });

    await publish(
      {
        messageId,
        type: InboundMessageType.COMMAND_PROCESSED,
        pluginId,
        issuedAt: new Date().toISOString(),
        data: { commandId: randomUUID(), success: true },
      },
      messageId,
    );

    await waitFor(
      () => Promise.resolve(calls.length >= 2 ? true : undefined),
      'segunda tentativa',
    );
    await waitFor(
      async () => ((await inboundIsEmpty()) ? true : undefined),
      'core.inbound vazia',
    );
    expect(calls).toHaveLength(2);
    expect((await channel.checkQueue(INBOUND_DLQ)).messageCount).toBe(0);
  });
});
