import {
  Args,
  Context,
  ID,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';

import type { Order, StockBalance } from '@oms/contracts';

import { OrdersService } from '../../orders/orders.service';
import type { GraphqlContext } from '../graphql.context';
import { OrderType } from '../types/order.type';
import { StockType } from '../types/stock.type';

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

  @ResolveField(() => [StockType])
  stock(
    @Parent() order: Order,
    @Context() context: GraphqlContext,
  ): Promise<StockBalance[]> {
    return Promise.all(
      order.items.map((item) => context.loaders.stockBySku.load(item.sku)),
    );
  }
}
