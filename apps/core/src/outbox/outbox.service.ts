import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';

import { Command, CommandType } from '@oms/contracts';

export interface OutboxMessageInput {
  id: string;
  routingKey: string;
  type: CommandType;
  correlationId?: string;
  payload: Command;
}

@Injectable()
export class OutboxService {
  async enqueue(
    client: PoolClient,
    message: OutboxMessageInput,
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_message (id, routing_key, type, correlation_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        message.id,
        message.routingKey,
        message.type,
        message.correlationId ?? null,
        JSON.stringify(message.payload),
      ],
    );
  }
}
