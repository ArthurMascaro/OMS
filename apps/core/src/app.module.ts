import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from './database/database.module';
import { GraphqlModule } from './graphql/graphql.module';
import { HealthController } from './health.controller';
import { OrdersModule } from './orders/orders.module';
import { PluginRegistryModule } from './plugin-registry/plugin-registry.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    GraphqlModule,
    PluginRegistryModule,
    OrdersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
