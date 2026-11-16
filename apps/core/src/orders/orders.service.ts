import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

import {
  CommandType,
  Order,
  OrderItem,
  OrderStatus,
} from '@oms/contracts';

import { ORDER_TRANSITIONS, OrderCommandStatus } from './orders.constants';

export interface NewOrder {
  pluginId?: string;
  externalOrderId?: string;
  items: OrderItem[];
}

interface LockedOrder {
  status: OrderStatus;
  pluginId: string | null;
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

// Para o Sr. Raul Souza, estou deixando alguns comentários nos métodos onde vc vai ter que inserir as chamadas para o módulo de estoque, que ainda não existe.
// Algumas considerações minhas: vc pode criar o módulo e injetar o service de estoque dentro desse service de orders, conforme eu fiz no nivel 3 do C4 pra usarmos como base.
// Ah, e depois me faz o favor de remover esses comentários aqui, por gentileza
// no caso do Sr. Lucas estar vendo isso, um grande abraço ao senhor também! Aqui nosso dialogo é assim.

// Para o Sr Trizzoti e Raul Souza. Se acharem o método transaction interessante, dá pra criar algo na pasta /libs pra fazer esse compartilhado entre os services,
//  e aí o service de orders e o service de plugin-registry podem usar. Mas não é obrigatório, só uma sugestão.
// eu fiz ele aqui pra ele dar uma resolvida na minha vida por hora.
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly pool: Pool) {}

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

    return this.transaction(async (client) => {
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

      // Aqui a order já foi inserida, então vc vai ter que chamar o modulo de estoque para reservar o estoque dos itens da order.
      // Se não houver estoque suficiente, vc deve mudar o status da order para CANCELED e preencher o campo cancel_reason com OUT_OF_STOCK.
      // Se houver estoque suficiente, vc deve mudar o status da order para RESERVED.
      // seria algo como: ve se tem estoque, tem, reserva e muda status do pedido. Não tem, cancela e preenche razão.
      // o método de reservar estoque pode receber um orderId, pegar os items daquela order, fazer o inventário de estoque somente dos itens dessa order, e se não conseguir de algum, ele te retorna um erro, sla.

      // correção: aqui a order não foi inserida ainda, ela está dentro de uma transaction.
      // Tem que fazer a reserva de estoque dentro da mesma transaction, e se não houver estoque suficiente, vc deve lançar uma exceção,
      // que vai fazer o rollback da transaction e a order não vai ser inserida. (ou, tratar para nesse caso não dar rollback mas inserir a order como cancelada)

      await this.changeStatus(client, orderId, OrderStatus.RESERVED);

      this.logger.log(`Order ${orderId} created`);

      return orderId;
    });
  }

  async invoice(orderId: string) {
    await this.transaction((client) =>
      this.changeStatus(
        client,
        orderId,
        OrderStatus.INVOICED,
        CommandType.INVOICE_ORDER,
      ),
    );
  }

  async ship(orderId: string) {
    await this.transaction((client) =>
      this.changeStatus(
        client,
        orderId,
        OrderStatus.SHIPPED,
        CommandType.SHIP_ORDER,
      ),
    );

    // aqui, vc chama o modulo de estoque pra recalcular novamente, entretanto, como o estoque já foi reservado, o ship funciona como uma negativa de reserva e uma positiva de venda
    // no fim não vai mudar nada no disponível, mas vai mudar o reservado e o vendido.
    // exemplo de calculo dos valores:
    // reservados = tudo reservado - (tudo que foi vendido + tudo que foi cancelado)
    // vendidos = tudo que foi vendido - tudo que foi devolvido
    // disponível = (tudo que entrou) - (reservados + vendidos)
    // fez sentido? tem certos status que são a contra parte de outros, ou seja, agem como agente positivo e negativo. Da uma refletida sobre isso e dps me chama pra trocar uma ideia se tiver duvidas.
    // isso é bem cara de sistema de WMS.
    // se precisarmos mudar isso vc me avisa, é bem chato isso mesmo.
  }

  async return(orderId: string) {
    await this.transaction((client) =>
      this.changeStatus(
        client,
        orderId,
        OrderStatus.RETURNED,
        CommandType.RETURN_ORDER,
      ),
    );
    // bom, aqui vc chama o estoque támbem.
    // return serve como negativa de venda e como entrada de estoque, ou seja, vc vai aumentar o disponível e diminuir o vendido.
  }

  async cancel(orderId: string, reason: string) {
    await this.transaction((client) =>
      this.changeStatus(
        client,
        orderId,
        OrderStatus.CANCELED,
        CommandType.CANCEL_ORDER,
        reason,
      ),
    );

    // aqui vc também chama o modulo de estoque pra recalcular.
    // o cancelado só desfaz a reserva, ou seja, ele diminui o reservado e aumenta o disponível. O físico não muda, pois o produto nunca chegou a sair de fato
  }

  async cancelByChannel(
    pluginId: string,
    externalOrderId: string,
    reason: string,
  ) {
    const response = await this.pool.query<{ id: string }>(
      `SELECT
        id
       FROM "order"
       WHERE
        plugin_id = $1
        AND external_order_id = $2`,
      [pluginId, externalOrderId],
    );

    if (response.rowCount === 0) {
      this.logger.warn(`Order ${externalOrderId} from ${pluginId} not found`);
      return;
    }

    const orderId = response.rows[0].id;

    await this.transaction((client) =>
      this.changeStatus(
        client,
        orderId,
        OrderStatus.CANCELED,
        undefined,
        reason,
      ),
    );

    // aqui mesma coisa do cancel, vc chama o modulo de estoque pra recalcular.
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
  ) {
    const response = await client.query<LockedOrder>(
      `SELECT
        status,
        plugin_id AS "pluginId"
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
      return;
    }

    await client.query(
      `INSERT INTO order_command (
        order_id,
        plugin_id,
        type
       ) VALUES (
        $1,
        $2,
        $3
       )`,
      [orderId, order.pluginId, commandType],
    );

    // Aqui é para o Sr. Trizotti.
    // Quando o módulo de mensageria existir, tem que mandar a mensagem de comando para o plugin, com o orderId e o commandId,
    // que é gerado automaticamente pelo banco de dados.
    // no fim, é só pra atualizar o status do pedido caso o plugin tenha a capacidade de processar o comando, e caso não tenha, o status do pedido não muda (ihul).

    // Pra pegar o commandId, coloca RETURNING command_id no INSERT acima e já vai estar pronto pra vc.
  }

  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const result = await work(client);

      await client.query('COMMIT');

      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
