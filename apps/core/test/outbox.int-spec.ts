import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

import { Command, CommandType } from '@oms/contracts';

import { DatabaseModule } from '../src/database/database.module';
import { DatabaseService } from '../src/database/database.service';
import { OutboxModule } from '../src/outbox/outbox.module';
import { OutboxService } from '../src/outbox/outbox.service';

interface OutboxRow {
  published_at: Date | null;
  attempts: number;
  payload: Command;
}

describe('OutboxService (integração)', () => {
  let moduleRef: Awaited<ReturnType<typeof buildModule>>;
  let database: DatabaseService;
  let outbox: OutboxService;
  let pool: Pool;

  const buildModule = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DatabaseModule,
        OutboxModule,
      ],
    }).compile();

  const buildCommand = (): Command => ({
    commandId: randomUUID(),
    type: CommandType.UPDATE_STOCK,
    pluginId: 'plugin-teste',
    issuedAt: new Date().toISOString(),
    data: { sku: 'SKU-1', available: 5 },
  });

  beforeAll(async () => {
    moduleRef = await buildModule();
    database = moduleRef.get(DatabaseService);
    outbox = moduleRef.get(OutboxService);
    pool = moduleRef.get(Pool);
  });

  afterAll(async () => {
    await pool.end();
    await moduleRef.close();
  });

  it('grava a mensagem na transação e some no rollback', async () => {
    const command = buildCommand();
    const id = randomUUID();

    await database.transaction((client) =>
      outbox.enqueue(client, {
        id,
        routingKey: 'plugin.teste',
        type: command.type,
        correlationId: 'corr-1',
        payload: command,
      }),
    );

    const { rows } = await pool.query<OutboxRow>(
      'SELECT * FROM outbox_message WHERE id = $1',
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].published_at).toBeNull();
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].payload).toEqual(command);
    await pool.query('DELETE FROM outbox_message WHERE id = $1', [id]);

    const rolledBackId = randomUUID();
    await expect(
      database.transaction(async (client) => {
        await outbox.enqueue(client, {
          id: rolledBackId,
          routingKey: 'plugin.teste',
          type: command.type,
          payload: command,
        });
        throw new Error('falha após enqueue');
      }),
    ).rejects.toThrow('falha após enqueue');

    const count = await pool.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM outbox_message WHERE id = $1',
      [rolledBackId],
    );
    expect(count.rows[0].total).toBe(0);
  });
});
