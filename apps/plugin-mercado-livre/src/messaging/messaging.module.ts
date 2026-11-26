import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { COMMANDS_EXCHANGE, INBOUND_DLQ, INBOUND_QUEUE } from '@oms/contracts';

import { PLUGIN_DLQ, PLUGIN_ID, PLUGIN_QUEUE } from '../plugin.constants';
import { CommandsConsumer } from './commands.consumer';
import { InboundPublisherService } from './inbound-publisher.service';

@Module({
  imports: [
    RabbitMQModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('RABBITMQ_URL'),
        exchanges: [
          {
            name: COMMANDS_EXCHANGE,
            type: 'direct',
            options: { durable: true },
          },
        ],
        queues: [
          {
            name: INBOUND_QUEUE,
            options: {
              durable: true,
              arguments: {
                'x-dead-letter-exchange': '',
                'x-dead-letter-routing-key': INBOUND_DLQ,
              },
            },
          },
          {
            name: INBOUND_DLQ,
            options: { durable: true },
          },
          {
            name: PLUGIN_QUEUE,
            exchange: COMMANDS_EXCHANGE,
            routingKey: PLUGIN_ID,
            options: {
              durable: true,
              arguments: {
                'x-dead-letter-exchange': '',
                'x-dead-letter-routing-key': PLUGIN_DLQ,
              },
            },
          },
          {
            name: PLUGIN_DLQ,
            options: { durable: true },
          },
        ],
      }),
    }),
  ],
  providers: [InboundPublisherService, CommandsConsumer],
  exports: [RabbitMQModule, InboundPublisherService],
})
export class MessagingModule {}
