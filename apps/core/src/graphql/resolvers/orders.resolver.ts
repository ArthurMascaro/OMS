import { Args, ID, Query, Resolver } from '@nestjs/graphql';

import { Order } from '@oms/contracts';

import { OrdersService } from '../../orders/orders.service';
import { OrderType } from '../types/order.type';

@Resolver(() => OrderType)
export class OrdersResolver {
  constructor(private readonly ordersService: OrdersService) {}

  @Query(() => [OrderType])
  orders(): Promise<Order[]> {
    return this.ordersService.findAll();
  }

  @Query(() => OrderType, { nullable: true })
  order(@Args('id', { type: () => ID }) id: string): Promise<Order | null> {
    return this.ordersService.findById(id);
  }
}