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

type HandlerOutcome = 'ok' | 'erro';

interface AmqplibTestChannel {
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
const WAIT_STEP_MS = 50;

jest.setTimeout(WAIT_TIMEOUT_MS * 2);

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
  let channel: AmqplibTestChannel;
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

  const takeFromDlqDiscardingOthers = (matches: (content: string) => boolean) =>
    waitFor(async () => {
      const message = await channel.get(INBOUND_DLQ, { noAck: true });
      if (message === false) return undefined;
      return matches(message.content.toString()) ? message : undefined;
    }, 'mensagem na DLQ');

  const inboundIsEmpty = async () =>
    (await channel.checkQueue(INBOUND_QUEUE)).messageCount === 0;

  const dlqMessageCount = async () =>
    (await channel.checkQueue(INBOUND_DLQ)).messageCount;

  const recordHandlerOutcomesOf = (messageId: string) => {
    const outcomes: HandlerOutcome[] = [];
    const original = handler.handle.bind(handler);
    jest.spyOn(handler, 'handle').mockImplementation(async (message) => {
      if (message.messageId !== messageId) return original(message);
      try {
        await original(message);
        outcomes.push('ok');
      } catch (error) {
        outcomes.push('erro');
        throw error;
      }
    });
    return outcomes;
  };

  const waitForOutcomes = (outcomes: HandlerOutcome[], count: number) =>
    waitFor(
      () => Promise.resolve(outcomes.length >= count ? true : undefined),
      `${count} execuções do handler`,
    );

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
    channel = amqp.channel as AmqplibTestChannel;
    pool = moduleRef.get(Pool);
    handler = moduleRef.get(OrdersInboundHandler);

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
    const sku = `SKU-${randomUUID()}`;
    skus.push(sku);
    const insufficientStock = 1;
    const quantityAboveStockSoOrderHasNoStockEvents = 2;
    await pool.query(
      `INSERT INTO stock_event (sku, version, type, quantity)
       VALUES ($1, 1, 'STOCK_RECEIVED', $2)`,
      [sku, insufficientStock],
    );
    const externalOrderId = `ext-${randomUUID()}`;
    const message: InboundMessage = {
      messageId: randomUUID(),
      type: InboundMessageType.ORDER_RECEIVED,
      pluginId,
      issuedAt: new Date().toISOString(),
      data: {
        externalOrderId,
        items: [
          {
            sku,
            quantity: quantityAboveStockSoOrderHasNoStockEvents,
            unitPriceCents: 1000,
          },
        ],
      },
    };
    const outcomes = recordHandlerOutcomesOf(message.messageId);

    await publish(message, message.messageId);
    await publish(message, message.messageId);

    const [order] = await waitFor(async () => {
      const rows = await orderOf(externalOrderId);
      return rows.length && rows[0].status === OrderStatus.CANCELED
        ? rows
        : undefined;
    }, 'pedido criado');
    orderIds.push(order.id);

    await waitForOutcomes(outcomes, 2);
    expect(outcomes).toEqual(['ok', 'ok']);
    expect(await orderOf(externalOrderId)).toHaveLength(1);
    expect(await dlqMessageCount()).toBe(0);
  });

  it('ORDER_CANCELED_BY_CHANNEL repetido é ignorado sem ir para a DLQ', async () => {
    const externalOrderId = `ext-${randomUUID()}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "order" (plugin_id, external_order_id, status, total_cents)
       VALUES ($1, $2, 'CREATED', 100) RETURNING id`,
      [pluginId, externalOrderId],
    );
    orderIds.push(rows[0].id);
    const message: InboundMessage = {
      messageId: randomUUID(),
      type: InboundMessageType.ORDER_CANCELED_BY_CHANNEL,
      pluginId,
      issuedAt: new Date().toISOString(),
      data: { externalOrderId, reason: 'cancelado no marketplace' },
    };
    const outcomes = recordHandlerOutcomesOf(message.messageId);

    await publish(message, message.messageId);
    await publish(message, message.messageId);

    await waitForOutcomes(outcomes, 2);
    expect(outcomes).toEqual(['ok', 'ok']);
    await waitFor(
      async () => ((await inboundIsEmpty()) ? true : undefined),
      'core.inbound vazia',
    );
    expect(await dlqMessageCount()).toBe(0);
    const [order] = await orderOf(externalOrderId);
    expect(order.status).toBe(OrderStatus.CANCELED);
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

    const dead = await takeFromDlqDiscardingOthers((content) =>
      content.includes(messageId),
    );
    expect(dead.properties.headers?.['x-retry-count']).toBe(
      MAX_INBOUND_RETRIES,
    );
    expect(await inboundIsEmpty()).toBe(true);
  });

  it('conteúdo que não é JSON termina na DLQ', async () => {
    const marker = `nao-e-json-${randomUUID()}`;
    await publish(Buffer.from(marker));

    const dead = await takeFromDlqDiscardingOthers(
      (content) => content === marker,
    );
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
