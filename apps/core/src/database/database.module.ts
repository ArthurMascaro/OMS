import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

import { DatabaseService } from './database.service';

@Global()
@Module({
  providers: [
    {
      provide: Pool,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Pool({ connectionString: config.getOrThrow('DATABASE_URL') }),
    },
    DatabaseService,
  ],
  exports: [Pool, DatabaseService],
})
export class DatabaseModule {}
