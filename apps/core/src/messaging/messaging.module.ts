import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { COMMANDS_EXCHANGE, INBOUND_DLQ, INBOUND_QUEUE } from '@oms/contracts';

// Topologia RabbitMQ do core. Sem connectionInitOptions.wait = false: o core
// não sobe sem broker. Consumidores (@RabbitSubscribe) são descobertos via
// enableControllerDiscovery e podem ser adicionados a este módulo.
@Global()
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
        ],
        enableControllerDiscovery: true,
      }),
    }),
  ],
  exports: [RabbitMQModule],
})
export class MessagingModule {}
