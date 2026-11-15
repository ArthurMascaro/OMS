import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { PluginRegistryModule } from './plugin-registry/plugin-registry.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    PluginRegistryModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
