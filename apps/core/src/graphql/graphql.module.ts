import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';

import { OrdersModule } from '../orders/orders.module';
import { graphqlConfig } from './graphql.config';
import { OrdersResolver } from './resolvers/orders.resolver';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      ...graphqlConfig,
    }),
    OrdersModule,
  ],
  providers: [OrdersResolver],
})
export class GraphqlModule {}