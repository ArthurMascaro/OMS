import { UnprocessableEntityException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

import { Capability, CommandType, OrderStatus } from '@oms/contracts';

import { DatabaseModule } from '../src/database/database.module';
import { OrderCommandDispatcher } from '../src/orders/order-command.dispatcher';
import { OrdersModule } from '../src/orders/orders.module';
import { OrdersService } from '../src/orders/orders.service';

describe('Comandos de pedido no outbox (integração)', () => {
  let moduleRef: Awaited<ReturnType<typeof buildModule>>;
  let orders: OrdersService;
  let pool: Pool;
  const pluginId = `plugin-cmd-${randomUUID()}`;
  const bareId = `plugin-bare-${randomUUID()}`;
  const orderIds: string[] = [];

  const buildModule = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DatabaseModule,
        OrdersModule,
      ],
    }).compile();

  const insertOrder = async (
    status: OrderStatus,
    plugin: string | null,
    externalOrderId: string | null = plugin ? `ext-${randomUUID()}` : null,
  ): Promise<{ id: string; externalOrderId: string | null }> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "order" (plugin_id, external_order_id, status, total_cents)
       VALUES ($1, $2, $3, 100) RETURNING id`,
      [plugin, externalOrderId, status],
    );
    orderIds.push(rows[0].id);
    return { id: rows[0].id, externalOrderId };
  };

  const statusOf = async (id: string) =>
    (await pool.query('SELECT status FROM "order" WHERE id = $1', [id]))
      .rows[0].status;

  const outboxFor = (id: string) =>
    pool.query(
      `SELECT * FROM outbox_message WHERE payload->'data'->>'orderId' = $1`,
      [id],
    );

  beforeAll(async () => {
    moduleRef = await buildModule();
    orders = moduleRef.get(OrdersService);
    pool = moduleRef.get(Pool);
    await pool.query(
      `INSERT INTO plugin (id, marketplace, capabilities) VALUES ($1, 'teste', $2)`,
      [
        pluginId,
        [
          Capability.INVOICE_ORDER,
          Capability.CANCEL_ORDER,
          Capability.SHIP_ORDER,
        ],
      ],
    );
  });

  afterAll(async () => {
    if (orderIds.length) {
      await pool.query(
        `DELETE FROM outbox_message WHERE payload->'data'->>'orderId' = ANY($1)`,
        [orderIds],
      );
      await pool.query('DELETE FROM order_command WHERE order_id = ANY($1)', [
        orderIds,
      ]);
      await pool.query('DELETE FROM order_item WHERE order_id = ANY($1)', [
        orderIds,
      ]);
      await pool.query('DELETE FROM "order" WHERE id = ANY($1)', [orderIds]);
    }
    await pool.query('DELETE FROM plugin WHERE id = ANY($1)', [
      [pluginId, bareId],
    ]);
    await pool.end();
    await moduleRef.close();
  });

  it('invoice cria order_command PENDING e outbox com o mesmo id', async () => {
    const order = await insertOrder(OrderStatus.RESERVED, pluginId);
    await orders.invoice(order.id);

    const commands = await pool.query(
      'SELECT * FROM order_command WHERE order_id = $1',
      [order.id],
    );
    expect(commands.rows).toHaveLength(1);
    expect(commands.rows[0].status).toBe('PENDING');

    const outbox = await outboxFor(order.id);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].id).toBe(commands.rows[0].command_id);
    expect(outbox.rows[0].routing_key).toBe(pluginId);
    expect(outbox.rows[0].payload.commandId).toBe(commands.rows[0].command_id);
    expect(outbox.rows[0].payload.pluginId).toBe(pluginId);
  });

  it('return em plugin sem RETURN_ORDER rejeita com 422 e faz rollback', async () => {
    const order = await insertOrder(OrderStatus.SHIPPED, pluginId);

    await expect(orders.return(order.id)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    expect(await statusOf(order.id)).toBe(OrderStatus.SHIPPED);
    expect((await outboxFor(order.id)).rows).toHaveLength(0);
    const commands = await pool.query(
      'SELECT 1 FROM order_command WHERE order_id = $1',
      [order.id],
    );
    expect(commands.rows).toHaveLength(0);
  });

  it('cancel grava data com reason e correlation_id = orderId', async () => {
    const order = await insertOrder(OrderStatus.CREATED, pluginId);
    await orders.cancel(order.id, 'cliente desistiu');

    const outbox = await outboxFor(order.id);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].correlation_id).toBe(order.id);
    expect(outbox.rows[0].payload.data).toEqual({
      orderId: order.id,
      externalOrderId: order.externalOrderId,
      reason: 'cliente desistiu',
    });
  });

  it('pedido com pluginId sem externalOrderId rejeita com 422', async () => {
    // a constraint do banco exige os dois juntos; simula-se pelo plugin_id nulo
    // não é possível, então o dispatcher é exercitado diretamente.
    const dispatcher = moduleRef.get(OrderCommandDispatcher);
    const client = await pool.connect();
    try {
      await expect(
        dispatcher.dispatch(client, {
          commandId: randomUUID(),
          type: CommandType.INVOICE_ORDER,
          pluginId,
          orderId: randomUUID(),
          externalOrderId: null,
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    } finally {
      client.release();
    }
  });

  it('pedido sem pluginId muda de status e não grava no outbox', async () => {
    const order = await insertOrder(OrderStatus.RESERVED, null);
    await orders.invoice(order.id);

    expect(await statusOf(order.id)).toBe(OrderStatus.INVOICED);
    expect((await outboxFor(order.id)).rows).toHaveLength(0);
  });
});
