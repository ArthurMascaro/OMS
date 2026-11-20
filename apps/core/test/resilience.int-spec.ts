import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

import {
  Capability,
  Command,
  COMMANDS_EXCHANGE,
  CommandType,
  InboundMessageType,
  OrderStatus,
  PLUGIN_QUEUE_PREFIX,
} from '@oms/contracts';

import { DatabaseModule } from '../src/database/database.module';
import { MessagingModule } from '../src/messaging/messaging.module';
import { OrdersInboundHandler } from '../src/orders/orders-inbound.handler';
import { OrdersModule } from '../src/orders/orders.module';
import { OrdersService } from '../src/orders/orders.service';
import { OutboxRelayService } from '../src/outbox/outbox-relay.service';

interface AmqplibTestChannel {
  assertQueue(queue: string, options: { durable: boolean }): Promise<unknown>;
  bindQueue(queue: string, exchange: string, key: string): Promise<unknown>;
  deleteQueue(queue: string): Promise<unknown>;
  get(
    queue: string,
    options: { noAck: boolean },
  ): Promise<false | { content: Buffer; properties: { messageId?: string } }>;
}

interface ClosableConnection {
  close(): Promise<void>;
}

interface OutboxRow {
  id: string;
  type: CommandType;
  published_at: Date | null;
  next_attempt_at: Date | null;
  attempts: number;
}

interface CommandRow {
  status: string;
  error: string | null;
  processed_at: Date | null;
}

const WAIT_TIMEOUT_MS = 15000;
const WAIT_STEP_MS = 100;
const TEST_TIMEOUT_COVERING_AMQP_RECONNECT_MS = WAIT_TIMEOUT_MS * 2;

jest.setTimeout(TEST_TIMEOUT_COVERING_AMQP_RECONNECT_MS);

const waitUntil = async (
  probe: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  throw new Error(`timeout esperando ${description}`);
};

describe('Resiliência core-plugins conforme ADRs 0003 e 0005 (integração)', () => {
  let moduleRef: Awaited<ReturnType<typeof buildModuleWithoutScheduler>>;
  let amqp: AmqpConnection;
  let pool: Pool;
  let orders: OrdersService;
  let relay: OutboxRelayService;
  let inbound: OrdersInboundHandler;
  let pluginId: string;
  let queue: string;
  let orderIds: string[];

  const buildModuleWithoutScheduler = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DatabaseModule,
        MessagingModule,
        OrdersModule,
      ],
    }).compile();

  const currentChannelAfterAnyReconnect = () =>
    amqp.channel as AmqplibTestChannel;

  const createPluginQueue = async () => {
    await currentChannelAfterAnyReconnect().assertQueue(queue, {
      durable: false,
    });
    await currentChannelAfterAnyReconnect().bindQueue(
      queue,
      COMMANDS_EXCHANGE,
      pluginId,
    );
  };

  const insertOrder = async (status: OrderStatus): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO "order" (plugin_id, external_order_id, status, total_cents)
       VALUES ($1, $2, $3, 100) RETURNING id`,
      [pluginId, `ext-${randomUUID()}`, status],
    );
    orderIds.push(rows[0].id);
    return rows[0].id;
  };

  const outboxOf = async (orderId: string) =>
    (
      await pool.query<OutboxRow>(
        `SELECT id, type, published_at, next_attempt_at, attempts FROM outbox_message
         WHERE payload->'data'->>'orderId' = $1
         ORDER BY seq`,
        [orderId],
      )
    ).rows;

  const commandOf = async (commandId: string) =>
    (
      await pool.query<CommandRow>(
        `SELECT status, error, processed_at FROM order_command
         WHERE command_id = $1`,
        [commandId],
      )
    ).rows[0];

  const expireBackoffOfPlugin = () =>
    pool.query(
      `UPDATE outbox_message SET next_attempt_at = NOW() - INTERVAL '1 second'
       WHERE routing_key = $1 AND next_attempt_at IS NOT NULL`,
      [pluginId],
    );

  const relayUntilPluginHasNoPendingRows = async () => {
    await waitUntil(async () => {
      await relay.relayOnce();
      const { rows } = await pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM outbox_message
         WHERE routing_key = $1 AND published_at IS NULL`,
        [pluginId],
      );
      return rows[0].total === 0;
    }, 'outbox do plugin vazio');
  };

  const simulateRelayCrashBetweenBrokerConfirmAndCommit = (outboxId: string) =>
    pool.query('UPDATE outbox_message SET published_at = NULL WHERE id = $1', [
      outboxId,
    ]);

  const takeCommands = async (count: number): Promise<Command[]> => {
    const commands: Command[] = [];
    await waitUntil(async () => {
      const message = await currentChannelAfterAnyReconnect().get(queue, {
        noAck: true,
      });
      if (message !== false) {
        commands.push(JSON.parse(message.content.toString()) as Command);
      }
      return commands.length >= count;
    }, `${count} mensagens em ${queue}`);
    return commands;
  };

  beforeAll(async () => {
    moduleRef = await buildModuleWithoutScheduler();
    amqp = moduleRef.get(AmqpConnection);
    pool = moduleRef.get(Pool);
    orders = moduleRef.get(OrdersService);
    relay = moduleRef.get(OutboxRelayService);
    inbound = moduleRef.get(OrdersInboundHandler);
  });

  beforeEach(async () => {
    orderIds = [];
    pluginId = `plugin-res-${randomUUID()}`;
    queue = `${PLUGIN_QUEUE_PREFIX}${pluginId}`;
    await pool.query(
      `INSERT INTO plugin (id, marketplace, capabilities) VALUES ($1, 'teste', $2)`,
      [pluginId, [Capability.INVOICE_ORDER, Capability.SHIP_ORDER]],
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await waitUntil(() => amqp.connected, 'reconexão ao RabbitMQ');
    await currentChannelAfterAnyReconnect().deleteQueue(queue);
    await pool.query('DELETE FROM outbox_message WHERE routing_key = $1', [
      pluginId,
    ]);
    await pool.query('DELETE FROM order_command WHERE order_id = ANY($1)', [
      orderIds,
    ]);
    await pool.query('DELETE FROM "order" WHERE id = ANY($1)', [orderIds]);
    await pool.query('DELETE FROM plugin WHERE id = $1', [pluginId]);
  });

  afterAll(async () => {
    await pool.end();
    await moduleRef.close();
  });

  it('plugin parado: pedidos criados ficam retidos e chegam quando a fila é criada', async () => {
    const orderId = await insertOrder(OrderStatus.RESERVED);
    await orders.invoice(orderId);
    await orders.ship(orderId);

    await relay.relayOnce();
    const retained = await outboxOf(orderId);
    expect(retained.map((row) => row.type)).toEqual([
      CommandType.INVOICE_ORDER,
      CommandType.SHIP_ORDER,
    ]);
    expect(retained.every((row) => row.published_at === null)).toBe(true);
    expect(retained[0].attempts).toBeGreaterThan(0);
    expect(retained[0].next_attempt_at).not.toBeNull();

    await createPluginQueue();
    await expireBackoffOfPlugin();
    await relayUntilPluginHasNoPendingRows();

    const commands = await takeCommands(2);
    expect(commands.map((command) => command.type)).toEqual([
      CommandType.INVOICE_ORDER,
      CommandType.SHIP_ORDER,
    ]);
    expect(commands.map((command) => command.commandId)).toEqual(
      retained.map((row) => row.id),
    );
    expect(commands.every((command) => command.pluginId === pluginId)).toBe(
      true,
    );
  });

  it('RabbitMQ indisponível: o core continua gravando', async () => {
    await createPluginQueue();
    const orderId = await insertOrder(OrderStatus.RESERVED);

    await (amqp.connection as ClosableConnection).close();
    await waitUntil(() => !amqp.connected, 'desconexão do RabbitMQ');

    await orders.invoice(orderId);

    const pending = await outboxOf(orderId);
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe(CommandType.INVOICE_ORDER);
    expect(pending[0].published_at).toBeNull();
    expect((await commandOf(pending[0].id)).status).toBe('PENDING');
    const statusRow = await pool.query<{ status: OrderStatus }>(
      'SELECT status FROM "order" WHERE id = $1',
      [orderId],
    );
    expect(statusRow.rows[0].status).toBe(OrderStatus.INVOICED);

    await waitUntil(() => amqp.connected, 'reconexão ao RabbitMQ');
    await relayUntilPluginHasNoPendingRows();

    const [command] = await takeCommands(1);
    expect(command.commandId).toBe(pending[0].id);
    expect(command.type).toBe(CommandType.INVOICE_ORDER);
    const [published] = await outboxOf(orderId);
    expect(published.published_at).not.toBeNull();
  });

  it('duplicata do relay é descartada', async () => {
    await createPluginQueue();
    const orderId = await insertOrder(OrderStatus.RESERVED);
    await orders.invoice(orderId);
    const [row] = await outboxOf(orderId);

    await relayUntilPluginHasNoPendingRows();
    await simulateRelayCrashBetweenBrokerConfirmAndCommit(row.id);
    await relayUntilPluginHasNoPendingRows();

    const deliveries = await takeCommands(2);
    expect(deliveries.map((command) => command.commandId)).toEqual([
      row.id,
      row.id,
    ]);

    const warn = jest.spyOn(Logger.prototype, 'warn');
    const respond = (success: boolean, error?: string) =>
      inbound.handle({
        messageId: randomUUID(),
        type: InboundMessageType.COMMAND_PROCESSED,
        pluginId,
        issuedAt: new Date().toISOString(),
        data: { commandId: row.id, success, error },
      });

    await respond(true);
    const applied = await commandOf(row.id);
    expect(applied.status).toBe('SUCCEEDED');
    expect(applied.processed_at).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();

    await respond(false, 'resposta duplicada');
    expect(await commandOf(row.id)).toEqual(applied);
    expect(warn).toHaveBeenCalledWith(`Command ${row.id} not pending`);
  });
});
