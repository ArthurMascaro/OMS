import { Args, ID, Query, Resolver } from '@nestjs/graphql';

import { StockEvent } from '@oms/contracts';

import { StockService } from '../../stock/stock.service';
import { MovementType, StockType } from '../types/stock.type';

@Resolver()
export class StockResolver {
  constructor(private readonly stockService: StockService) {}

  @Query(() => StockType)
  stock(@Args('sku') sku: string) {
    return this.stockService.getBalance(sku);
  }

  @Query(() => [MovementType])
  movements(
    @Args('sku', { nullable: true }) sku?: string,
    @Args('orderId', { type: () => ID, nullable: true }) orderId?: string,
  ): Promise<StockEvent[]> {
    return this.stockService.getMovements({ sku, orderId });
  }
}
