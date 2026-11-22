import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { Order, OrderStatus } from '@oms/contracts';

import { AppModule } from '../app.module';
import { OrdersService } from '../orders/orders.service';
import { StockService } from '../stock/stock.service';

describe('GraphQL API', () => {
  let app: INestApplication;
  let stockService: { getBalances: jest.Mock };

  const orders: Order[] = [
    {
      id: 'order-1',
      status: OrderStatus.RESERVED,
      items: [
        {
          sku: 'SKU-1',
          quantity: 2,
          unitPriceCents: 1000,
        },
      ],
      totalCents: 2000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'order-2',
      status: OrderStatus.RESERVED,
      items: [
        {
          sku: 'SKU-2',
          quantity: 1,
          unitPriceCents: 2500,
        },
      ],
      totalCents: 2500,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  beforeAll(async () => {
    const getBalances = jest.fn((skus: readonly string[]) =>
      Promise.resolve(
        skus.map((sku) => ({
          sku,
          physical: 10,
          reserved: 2,
          available: 8,
        })),
      ),
    );
    stockService = {
      getBalances,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OrdersService)
      .useValue({
        findAll: jest.fn().mockResolvedValue(orders),
        findById: jest.fn().mockResolvedValue(orders[0]),
      })
      .overrideProvider(StockService)
      .useValue(stockService)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a nested order and stock selection', async () => {
    const response = await request(app.getHttpServer() as App)
      .post('/graphql')
      .send({
        query: `
          query {
            order(id: "order-1") {
              id
              status
              stock {
                sku
                available
              }
            }
          }
        `,
      })
      .expect(200);

    expect(response.body).toEqual({
      data: {
        order: {
          id: 'order-1',
          status: 'RESERVED',
          stock: [{ sku: 'SKU-1', available: 8 }],
        },
      },
    });
  });

  it('batches stock reads for nested orders', async () => {
    stockService.getBalances.mockClear();

    const response = await request(app.getHttpServer() as App)
      .post('/graphql')
      .send({
        query: `
          query {
            orders {
              id
              stock {
                sku
                available
              }
            }
          }
        `,
      })
      .expect(200);

    const body = response.body as {
      data: { orders: { id: string }[] };
    };

    expect(body.data.orders).toHaveLength(2);
    expect(stockService.getBalances).toHaveBeenCalledTimes(1);
    expect(stockService.getBalances).toHaveBeenCalledWith(['SKU-1', 'SKU-2']);
  });
});
