import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

import {
  Capability,
  CommandType,
  HEARTBEAT_TIMEOUT_MS,
  UpdateStockCommand,
} from '@oms/contracts';

import { DatabaseModule } from '../src/database/database.module';
import { DatabaseService } from '../src/database/database.service';
import { OrdersModule } from '../src/orders/orders.module';
import { OrdersService } from '../src/orders/orders.service';
import { StockModule } from '../src/stock/stock.module';
import { StockService } from '../src/stock/stock.service';

interface UpdateStockOutboxRow {
  id: string;
  routing_key: string;
  type: CommandType;
  payload: UpdateStockCommand;
}

describe('UPDATE_STOCK no outbox (integração)', () => {
  let moduleRef: Awaited<ReturnType<typeof buildModule>>;
  let stock: StockService;
  let orders: OrdersService;
  let database: DatabaseService;
  let pool: Pool;
  const suffix = randomUUID();
  const activeA = `plugin-stock-a-${suffix}`;
  const activeB = `plugin-stock-b-${suffix}`;
  const noCapability = `plugin-stock-nocap-${suffix}`;
  const stale = `plugin-stock-stale-${suffix}`;
  const pluginIds = [activeA, activeB, noCapability, stale];
  const skus: string[] = [];

  const buildModule = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DatabaseModule,
        StockModule,
        OrdersModule,
      ],
    }).compile();

  const newSku = () => {
    const sku = `SKU-${randomUUID()}`;
    skus.push(sku);
    return sku;
  };

  const outboxFor = (sku: string) =>
    pool.query<UpdateStockOutboxRow>(
      `SELECT * FROM outbox_message WHERE correlation_id = $1 ORDER BY routing_key`,
      [sku],
    );

  beforeAll(async () => {
    moduleRef = await buildModule();
    stock = moduleRef.get(StockService);
    orders = moduleRef.get(OrdersService);
    database = moduleRef.get(DatabaseService);
    pool = moduleRef.get(Pool);

    const insert = (id: string, caps: Capability[], heartbeat: string) =>
      pool.query(
        `INSERT INTO plugin (id, marketplace, capabilities, last_heartbeat_at)
         VALUES ($1, 'teste', $2, NOW() - make_interval(secs => $3))`,
        [id, caps, heartbeat],
      );
    await insert(activeA, [Capability.UPDATE_STOCK], '0');
    await insert(activeB, [Capability.UPDATE_STOCK], '0');
    await insert(noCapability, [Capability.INVOICE_ORDER], '0');
    await insert(
      stale,
      [Capability.UPDATE_STOCK],
      String(HEARTBEAT_TIMEOUT_MS / 1000 + 3600),
    );
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM outbox_message WHERE correlation_id = ANY($1)`,
      [skus],
    );
    await pool.query('DELETE FROM plugin WHERE id = ANY($1)', [pluginIds]);
    await pool.end();
    await moduleRef.close();
  });

  it('receive grava um UPDATE_STOCK por plugin ativo com a capacidade', async () => {
    const sku = newSku();
    await stock.receive(sku, 7);

    const { rows } = await outboxFor(sku);
    expect(rows.map((row) => row.routing_key)).toEqual(
      [activeA, activeB].sort(),
    );
    for (const row of rows) {
      expect(row.type).toBe(CommandType.UPDATE_STOCK);
      expect(row.payload).toEqual({
        type: CommandType.UPDATE_STOCK,
        commandId: row.id,
        pluginId: row.routing_key,
        issuedAt: expect.any(String) as string,
        data: { sku, available: 7 },
      });
      expect(new Date(row.payload.issuedAt).toISOString()).toBe(
        row.payload.issuedAt,
      );
    }
  });

  it('rollback da transação depois de reserve não deixa linhas no outbox', async () => {
    const sku = newSku();
    await stock.receive(sku, 5);
    const before = (await outboxFor(sku)).rows.length;
    expect(before).toBe(2);

    await expect(
      database.transaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO "order" (total_cents) VALUES (100) RETURNING id`,
        );
        const result = await stock.reserve(client, rows[0].id, [
          { sku, quantity: 1, unitPriceCents: 100 },
        ]);
        expect(result.reserved).toBe(true);
        throw new Error('falha forçada');
      }),
    ).rejects.toThrow('falha forçada');

    expect((await outboxFor(sku)).rows).toHaveLength(before);
  });

  it('OrdersService.create com estoque grava UPDATE_STOCK na mesma transação', async () => {
    const sku = newSku();
    await stock.receive(sku, 10);

    const orderId = await orders.create({
      pluginId: `ext-plugin-${suffix}`,
      externalOrderId: `ext-${randomUUID()}`,
      items: [{ sku, quantity: 4, unitPriceCents: 100 }],
    });
    expect(orderId).not.toBeNull();

    const { rows } = await outboxFor(sku);
    const latest = rows.filter((row) => row.payload.data.available === 6);
    expect(latest.map((row) => row.routing_key)).toEqual(
      [activeA, activeB].sort(),
    );
  });
});
