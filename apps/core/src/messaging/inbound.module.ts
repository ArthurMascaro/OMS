import { Module } from '@nestjs/common';

import { OrdersModule } from '../orders/orders.module';
import { InboundConsumer } from './inbound.consumer';

// Separado do MessagingModule para mantê-lo livre de módulos de negócio:
// OrdersModule -> OutboxModule -> MessagingModule, então importar OrdersModule
// no MessagingModule criaria um ciclo. O @RabbitSubscribe do InboundConsumer é
// descoberto pelo RabbitMQModule (global) em qualquer módulo da aplicação.
@Module({
  imports: [OrdersModule],
  providers: [InboundConsumer],
})
export class InboundModule {}
