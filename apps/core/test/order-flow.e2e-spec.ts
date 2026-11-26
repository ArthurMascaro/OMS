import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';

import { OrderStatus } from '@oms/contracts';
import type { StockBalance } from '@oms/contracts';

import { AppModule } from '../src/app.module';

interface OrderRow {
  status: OrderStatus;
  cancel_reason: string | null;
}

describe('Fluxo do pedido no core sem plugins (e2e)', () => {
  let app: INestApplication<App>;
  let pool: Pool;

  const newSku = () => `SKU-e2e-${randomUUID()}`;

  const receiveStock = (sku: string, quantity: number) =>
    request(app.getHttpServer())
      .post('/stock/receipts')
      .send({ sku, quantity })
      .expect(HttpStatus.NO_CONTENT);

  const createOrder = async (sku: string, quantity: number) => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({ items: [{ sku, quantity, unitPriceCents: 1500 }] })
      .expect(HttpStatus.CREATED);

    return (response.body as { id: string }).id;
  };

  const moveOrder = (orderId: string, action: string, body?: object) =>
    request(app.getHttpServer())
      .post(`/orders/${orderId}/${action}`)
      .send(body);

  const balanceOf = async (sku: string) => {
    const response = await request(app.getHttpServer())
      .get(`/stock/${sku}`)
      .expect(HttpStatus.OK);

    return response.body as StockBalance;
  };

  const orderOf = async (orderId: string) => {
    const response = await pool.query<OrderRow>(
      `SELECT
        status,
        cancel_reason
       FROM "order"
       WHERE
        id = $1`,
      [orderId],
    );

    return response.rows[0];
  };

  const outboxCountFor = async (orderId: string) => {
    const response = await pool.query(
      `SELECT
        1
       FROM outbox_message
       WHERE
        payload->'data'->>'orderId' = $1`,
      [orderId],
    );

    return response.rowCount;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    pool = app.get(Pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('percorre recebimento, reserva, faturamento, despacho e devolução', async () => {
    const sku = newSku();

    await receiveStock(sku, 10);

    expect(await balanceOf(sku)).toEqual({
      sku,
      physical: 10,
      reserved: 0,
      available: 10,
    });

    const orderId = await createOrder(sku, 3);

    expect((await orderOf(orderId)).status).toBe(OrderStatus.RESERVED);
    expect(await balanceOf(sku)).toEqual({
      sku,
      physical: 10,
      reserved: 3,
      available: 7,
    });

    await moveOrder(orderId, 'invoice').expect(HttpStatus.NO_CONTENT);

    expect((await orderOf(orderId)).status).toBe(OrderStatus.INVOICED);

    await moveOrder(orderId, 'ship').expect(HttpStatus.NO_CONTENT);

    expect((await orderOf(orderId)).status).toBe(OrderStatus.SHIPPED);
    expect(await balanceOf(sku)).toEqual({
      sku,
      physical: 7,
      reserved: 0,
      available: 7,
    });

    await moveOrder(orderId, 'return').expect(HttpStatus.NO_CONTENT);

    expect((await orderOf(orderId)).status).toBe(OrderStatus.RETURNED);
    expect(await balanceOf(sku)).toEqual({
      sku,
      physical: 10,
      reserved: 0,
      available: 10,
    });
    expect(await outboxCountFor(orderId)).toBe(0);
  });

  it('cancelamento de pedido reservado devolve a reserva ao saldo', async () => {
    const sku = newSku();

    await receiveStock(sku, 5);
    const orderId = await createOrder(sku, 2);

    await moveOrder(orderId, 'cancel', { reason: 'CUSTOMER_REQUEST' }).expect(
      HttpStatus.NO_CONTENT,
    );

    expect(await orderOf(orderId)).toEqual({
      status: OrderStatus.CANCELED,
      cancel_reason: 'CUSTOMER_REQUEST',
    });
    expect(await balanceOf(sku)).toEqual({
      sku,
      physical: 5,
      reserved: 0,
      available: 5,
    });
  });

  it('pedido acima do saldo nasce cancelado por OUT_OF_STOCK sem reservar', async () => {
    const sku = newSku();

    await receiveStock(sku, 1);
    const orderId = await createOrder(sku, 4);

    expect(await orderOf(orderId)).toEqual({
      status: OrderStatus.CANCELED,
      cancel_reason: 'OUT_OF_STOCK',
    });
    expect(await balanceOf(sku)).toEqual({
      sku,
      physical: 1,
      reserved: 0,
      available: 1,
    });
  });

  it('transição fora da máquina de estados responde 409 e não muda o pedido', async () => {
    const sku = newSku();

    await receiveStock(sku, 2);
    const orderId = await createOrder(sku, 1);

    await moveOrder(orderId, 'ship').expect(HttpStatus.CONFLICT);

    expect((await orderOf(orderId)).status).toBe(OrderStatus.RESERVED);
  });
});
