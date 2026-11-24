import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';

import { OrdersModule } from '../orders/orders.module';
import {
  STOCK_PROJECTION_QUERY,
} from '../stock-projection/stock-projection.contract';
import type { StockProjectionQuery } from '../stock-projection/stock-projection.contract';
import { StockProjectionModule } from '../stock-projection/stock-projection.module';
import { graphqlConfig } from './graphql.config';
import { createGraphqlContext } from './graphql.context';
import { OrdersResolver } from './resolvers/orders.resolver';
import { StockResolver } from './resolvers/stock.resolver';

@Module({
  imports: [
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [StockProjectionModule],
      inject: [STOCK_PROJECTION_QUERY],
      useFactory: (stockProjection: StockProjectionQuery) => ({
        ...graphqlConfig,
        context: () => createGraphqlContext(stockProjection),
      }),
    }),
    OrdersModule,
    StockProjectionModule,
  ],
  providers: [OrdersResolver, StockResolver],
})
export class GraphqlModule {}
