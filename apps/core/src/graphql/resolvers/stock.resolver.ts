import { Inject } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';

import { StockEvent } from '@oms/contracts';

import {
  STOCK_PROJECTION_QUERY,
} from '../../stock-projection/stock-projection.contract';
import type { StockProjectionQuery } from '../../stock-projection/stock-projection.contract';
import { MovementType, StockType } from '../types/stock.type';

@Resolver()
export class StockResolver {
  constructor(
    @Inject(STOCK_PROJECTION_QUERY)
    private readonly stockProjection: StockProjectionQuery,
  ) {}

  @Query(() => StockType)
  stock(@Args('sku') sku: string) {
    return this.stockProjection.getBalance(sku);
  }

  @Query(() => [MovementType])
  movements(
    @Args('sku', { nullable: true }) sku?: string,
    @Args('orderId', { type: () => ID, nullable: true }) orderId?: string,
  ): Promise<StockEvent[]> {
    return this.stockProjection.getMovements({ sku, orderId });
  }
}
