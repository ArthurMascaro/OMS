import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

import { CommandType, Order, OrderItem, OrderStatus } from '@oms/contracts';

import { DatabaseService } from '../database/database.service';
import { StockService } from '../stock/stock.service';
import { OrderCommandDispatcher } from './order-command.dispatcher';
import { ORDER_TRANSITIONS, OrderCommandStatus } from './orders.constants';

export interface NewOrder {
  pluginId?: string;
  externalOrderId?: string;
  items: OrderItem[];
}

interface LockedOrder {
  status: OrderStatus;
  pluginId: string | null;
  externalOrderId: string | null;
}

interface OrderRow {
  id: string;
  pluginId: string | null;
  externalOrderId: string | null;
  status: OrderStatus;
  totalCents: number;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  itemSku: string | null;
  itemQuantity: number | null;
  itemUnitPriceCents: number | null;
}

// Para o Sr Trizzoti e Raul Souza. Se acharem o método transaction interessante, dá pra criar algo na pasta /libs pra fazer esse compartilhado entre os services,
//  e aí o service de orders e o service de plugin-registry podem usar. Mas não é obrigatório, só uma sugestão.
// eu fiz ele aqui pra ele dar uma resolvida na minha vida por hora.
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly pool: Pool,
    private readonly stockService: StockService,
    private readonly database: DatabaseService,
    private readonly dispatcher: OrderCommandDispatcher,
  ) {}

  async findAll(): Promise<Order[]> {
    const response = await this.pool.query<OrderRow>(`
      SELECT
        o.id,
        o.plugin_id AS "pluginId",
        o.external_order_id AS "externalOrderId",
        o.status,
        o.total_cents AS "totalCents",
        o.cancel_reason AS "cancelReason",
        o.created_at AS "createdAt",
        o.updated_at AS "updatedAt",
        oi.sku AS "itemSku",
        oi.quantity AS "itemQuantity",
        oi.unit_price_cents AS "itemUnitPriceCents"
      FROM "order" o
      LEFT JOIN order_item oi ON oi.order_id = o.id
      ORDER BY o.created_at DESC, oi.id
    `);

    return this.mapOrderRows(response.rows);
  }

  async findById(id: string): Promise<Order | null> {
    const response = await this.pool.query<OrderRow>(
      `
        SELECT
          o.id,
          o.plugin_id AS "pluginId",
          o.external_order_id AS "externalOrderId",
          o.status,
          o.total_cents AS "totalCents",
          o.cancel_reason AS "cancelReason",
          o.created_at AS "createdAt",
          o.updated_at AS "updatedAt",
          oi.sku AS "itemSku",
          oi.quantity AS "itemQuantity",
          oi.unit_price_cents AS "itemUnitPriceCents"
        FROM "order" o
        LEFT JOIN order_item oi ON oi.order_id = o.id
        WHERE o.id = $1
        ORDER BY oi.id
      `,
      [id],
    );

    return this.mapOrderRows(response.rows)[0] ?? null;
  }

  async create(order: NewOrder): Promise<string | null> {
    const totalCents = order.items.reduce(
      (total, item) => total + item.quantity * item.unitPriceCents,
      0,
    );
    const skus = order.items.map((item) => item.sku);
    const quantities = order.items.map((item) => item.quantity);
    const unitPrices = order.items.map((item) => item.unitPriceCents);

    return this.database.transaction(async (client) => {
      await this.lockExternalOrder(client, order.pluginId, order.externalOrderId);

      const response = await client.query<{ id: string }>(
        `INSERT INTO "order" (
          plugin_id,
          external_order_id,
          total_cents
         ) VALUES (
          $1,
          $2,
          $3
         )
          ON CONFLICT (plugin_id, external_order_id) DO NOTHING
         RETURNING
          id`,
        [order.pluginId ?? null, order.externalOrderId ?? null, totalCents],
      );

      if (response.rowCount === 0) {
        this.logger.log(
          `Order ${order.externalOrderId} from ${order.pluginId} already exists`,
        );
        return null;
      }

      const orderId = response.rows[0].id;

      await client.query(
        `INSERT INTO order_item (
          order_id,
          sku,
          quantity,
          unit_price_cents
         )
         SELECT
          $1,
          item.sku,
          item.quantity,
          item.unit_price_cents
         FROM UNNEST($2::TEXT[], $3::INTEGER[], $4::INTEGER[]) AS item (sku, quantity, unit_price_cents)`,
        [orderId, skus, quantities, unitPrices],
      );

      const reserved = await this.stockService.reserve(
        client,
        orderId,
        order.items,
      );

      if (reserved.reserved) {
        await this.changeStatus(client, orderId, OrderStatus.RESERVED);
      } else {
        await this.changeStatus(
          client,
          orderId,
          OrderStatus.CANCELED,
          undefined,
          'OUT_OF_STOCK',
        );
      }

      if (order.pluginId && order.externalOrderId) {
        await this.applyPendingChannelCancellation(
          client,
          orderId,
          order.pluginId,
          order.externalOrderId,
        );
      }

      this.logger.log(`Order ${orderId} created`);

      return orderId;
    });
  }

  async invoice(orderId: string) {
    await this.database.transaction((client) =>
      this.changeStatus(
        client,
        orderId,
        OrderStatus.INVOICED,
        CommandType.INVOICE_ORDER,
      ),
    );
  }

  async ship(orderId: string) {
    await this.database.transaction(async (client) => {
      const items = await this.loadOrderItems(client, orderId);
      await this.changeStatus(
        client,
        orderId,
        OrderStatus.SHIPPED,
        CommandType.SHIP_ORDER,
      );
      await this.stockService.ship(client, orderId, items);
    });
  }

  async return(orderId: string) {
    await this.database.transaction(async (client) => {
      const items = await this.loadOrderItems(client, orderId);
      await this.changeStatus(
        client,
        orderId,
        OrderStatus.RETURNED,
        CommandType.RETURN_ORDER,
      );
      await this.stockService.return(client, orderId, items);
    });
  }

  async cancel(orderId: string, reason: string) {
    await this.database.transaction(async (client) => {
      const previousStatus = await this.changeStatus(
        client,
        orderId,
        OrderStatus.CANCELED,
        CommandType.CANCEL_ORDER,
        reason,
      );

      if (previousStatus === OrderStatus.RESERVED) {
        const items = await this.loadOrderItems(client, orderId);
        await this.stockService.releaseReservation(client, orderId, items);
      }
    });
  }

  async cancelByChannel(
    pluginId: string,
    externalOrderId: string,
    reason: string,
  ) {
    await this.database.transaction(async (client) => {
      await this.lockExternalOrder(client, pluginId, externalOrderId);

      const response = await client.query<{ id: string }>(
        `SELECT
          id
         FROM "order"
         WHERE
          plugin_id = $1
          AND external_order_id = $2`,
        [pluginId, externalOrderId],
      );

      if (response.rowCount === 0) {
        await this.keepPendingChannelCancellation(
          client,
          pluginId,
          externalOrderId,
          reason,
        );
        return;
      }

      await this.cancelFromChannel(client, response.rows[0].id, reason);
    });
  }

  private async keepPendingChannelCancellation(
    client: PoolClient,
    pluginId: string,
    externalOrderId: string,
    reason: string,
  ) {
    await client.query(
      `INSERT INTO pending_channel_cancellation (
        plugin_id,
        external_order_id,
        reason
       ) VALUES (
        $1,
        $2,
        $3
       )
       ON CONFLICT (plugin_id, external_order_id) DO UPDATE SET
        reason = EXCLUDED.reason,
        received_at = NOW()`,
      [pluginId, externalOrderId, reason],
    );

    this.logger.log(
      `Order ${externalOrderId} from ${pluginId} not found; cancellation kept pending`,
    );
  }

  private async applyPendingChannelCancellation(
    client: PoolClient,
    orderId: string,
    pluginId: string,
    externalOrderId: string,
  ) {
    const response = await client.query<{ reason: string }>(
      `DELETE FROM pending_channel_cancellation
       WHERE
        plugin_id = $1
        AND external_order_id = $2
       RETURNING reason`,
      [pluginId, externalOrderId],
    );

    if (response.rowCount === 0) {
      return;
    }

    await this.cancelFromChannel(client, orderId, response.rows[0].reason);
  }

  private async cancelFromChannel(
    client: PoolClient,
    orderId: string,
    reason: string,
  ) {
    if (await this.isAlreadyCanceled(client, orderId)) {
      this.logger.log(`Order ${orderId} already canceled`);
      return;
    }

    const previousStatus = await this.changeStatus(
      client,
      orderId,
      OrderStatus.CANCELED,
      undefined,
      reason,
    );

    if (previousStatus === OrderStatus.RESERVED) {
      const items = await this.loadOrderItems(client, orderId);
      await this.stockService.releaseReservation(client, orderId, items);
    }
  }

  private async lockExternalOrder(
    client: PoolClient,
    pluginId: string | undefined,
    externalOrderId: string | undefined,
  ) {
    if (!pluginId || !externalOrderId) {
      return;
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${pluginId}:${externalOrderId}`,
    ]);
  }

  async completeCommand(commandId: string, success: boolean, error?: string) {
    const status = success
      ? OrderCommandStatus.SUCCEEDED
      : OrderCommandStatus.FAILED;

    const response = await this.pool.query(
      `UPDATE order_command
       SET
        status = $2,
        error = $3,
        processed_at = NOW()
       WHERE
        command_id = $1
        AND status = $4`,
      [commandId, status, error ?? null, OrderCommandStatus.PENDING],
    );

    if (response.rowCount === 0) {
      this.logger.warn(`Command ${commandId} not pending`);
    }
  }

  private async changeStatus(
    client: PoolClient,
    orderId: string,
    status: OrderStatus,
    commandType?: CommandType,
    cancelReason?: string,
  ): Promise<OrderStatus> {
    const response = await client.query<LockedOrder>(
      `SELECT
        status,
        plugin_id AS "pluginId",
        external_order_id AS "externalOrderId"
       FROM "order"
       WHERE
        id = $1
       FOR UPDATE`,
      [orderId],
    );

    if (response.rowCount === 0) {
      throw new NotFoundException('Order not found');
    }

    const order = response.rows[0];

    if (!ORDER_TRANSITIONS[order.status].includes(status)) {
      throw new ConflictException(
        `Order cannot change from ${order.status} to ${status}`,
      );
    }

    await client.query(
      `UPDATE "order"
       SET
        status = $2,
        cancel_reason = $3,
        updated_at = NOW()
       WHERE
        id = $1`,
      [orderId, status, cancelReason ?? null],
    );

    if (!order.pluginId || !commandType) {
      return order.status;
    }

    const command = await client.query<{ command_id: string }>(
      `INSERT INTO order_command (
        order_id,
        plugin_id,
        type
       ) VALUES (
        $1,
        $2,
        $3
       )
       RETURNING command_id`,
      [orderId, order.pluginId, commandType],
    );

    await this.dispatcher.dispatch(client, {
      commandId: command.rows[0].command_id,
      type: commandType,
      pluginId: order.pluginId,
      orderId,
      externalOrderId: order.externalOrderId,
      reason: cancelReason,
    });

    return order.status;
  }

  private async isAlreadyCanceled(
    client: PoolClient,
    orderId: string,
  ): Promise<boolean> {
    const response = await client.query<{ status: OrderStatus }>(
      `SELECT
        status
       FROM "order"
       WHERE
        id = $1
       FOR UPDATE`,
      [orderId],
    );

    return response.rows[0]?.status === OrderStatus.CANCELED;
  }

  private async loadOrderItems(
    client: PoolClient,
    orderId: string,
  ): Promise<OrderItem[]> {
    const response = await client.query<OrderItem>(
      `SELECT
        sku,
        quantity,
        unit_price_cents AS "unitPriceCents"
       FROM order_item
       WHERE order_id = $1
       ORDER BY id`,
      [orderId],
    );

    return response.rows;
  }

  private mapOrderRows(rows: OrderRow[]): Order[] {
    const orders = new Map<string, Order>();

    for (const row of rows) {
      let order = orders.get(row.id);

      if (!order) {
        order = {
          id: row.id,
          pluginId: row.pluginId ?? undefined,
          externalOrderId: row.externalOrderId ?? undefined,
          status: row.status,
          items: [],
          totalCents: row.totalCents,
          cancelReason: row.cancelReason ?? undefined,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
        orders.set(row.id, order);
      }

      if (
        row.itemSku !== null &&
        row.itemQuantity !== null &&
        row.itemUnitPriceCents !== null
      ) {
        order.items.push({
          sku: row.itemSku,
          quantity: row.itemQuantity,
          unitPriceCents: row.itemUnitPriceCents,
        });
      }
    }

    return [...orders.values()];
  }
}
