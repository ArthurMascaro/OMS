import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { INBOUND_DLQ, INBOUND_QUEUE } from '@oms/contracts';

import { InboundPublisherService } from './inbound-publisher.service';

@Module({
  imports: [
    RabbitMQModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('RABBITMQ_URL'),
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
        ],
      }),
    }),
  ],
  providers: [InboundPublisherService],
  exports: [RabbitMQModule, InboundPublisherService],
})
export class MessagingModule {}
