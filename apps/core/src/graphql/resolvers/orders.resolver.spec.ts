import { OrderStatus } from '@oms/contracts';

import { OrdersService } from '../../orders/orders.service';
import { OrdersResolver } from './orders.resolver';

describe('OrdersResolver', () => {
  const order = {
    id: 'order-1',
    status: OrderStatus.RESERVED,
    items: [],
    totalCents: 1000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('delegates an order lookup to the service', async () => {
    const findById = jest.fn().mockResolvedValue(order);
    const ordersService = {
      findById,
      findAll: jest.fn(),
    } as unknown as OrdersService;
    const resolver = new OrdersResolver(ordersService);

    await expect(resolver.order(order.id)).resolves.toEqual(order);
    expect(findById).toHaveBeenCalledWith(order.id);
  });

  it('delegates the order list lookup to the service', async () => {
    const findAll = jest.fn().mockResolvedValue([order]);
    const ordersService = {
      findById: jest.fn(),
      findAll,
    } as unknown as OrdersService;
    const resolver = new OrdersResolver(ordersService);

    await expect(resolver.orders()).resolves.toEqual([order]);
    expect(findAll).toHaveBeenCalledTimes(1);
  });
});
