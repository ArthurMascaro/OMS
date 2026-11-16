import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';

import { OrdersModule } from '../orders/orders.module';
import { StockModule } from '../stock/stock.module';
import { StockService } from '../stock/stock.service';
import { graphqlConfig } from './graphql.config';
import { createGraphqlContext } from './graphql.context';
import { OrdersResolver } from './resolvers/orders.resolver';
import { StockResolver } from './resolvers/stock.resolver';

@Module({
  imports: [
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [StockModule],
      inject: [StockService],
      useFactory: (stockService: StockService) => ({
        ...graphqlConfig,
        context: () => createGraphqlContext(stockService),
      }),
    }),
    OrdersModule,
    StockModule,
  ],
  providers: [OrdersResolver, StockResolver],
})
export class GraphqlModule {}
