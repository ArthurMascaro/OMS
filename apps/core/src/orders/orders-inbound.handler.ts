import { Injectable } from '@nestjs/common';

import { InboundMessage, InboundMessageType } from '@oms/contracts';

import { OrdersService } from './orders.service';

@Injectable()
export class OrdersInboundHandler {
  constructor(private readonly ordersService: OrdersService) {}

  // Chamado pelo InboundConsumer (messaging/inbound.consumer.ts) para cada
  // mensagem da core.inbound. Lançar aqui faz a mensagem ser retentada e, ao
  // esgotar MAX_INBOUND_RETRIES, ir para a core.inbound.dlq.
  async handle(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case InboundMessageType.ORDER_RECEIVED:
        await this.ordersService.create({
          pluginId: message.pluginId,
          externalOrderId: message.data.externalOrderId,
          items: message.data.items,
        });
        return;

      case InboundMessageType.ORDER_CANCELED_BY_CHANNEL:
        await this.ordersService.cancelByChannel(
          message.pluginId,
          message.data.externalOrderId,
          message.data.reason,
        );
        return;

      case InboundMessageType.COMMAND_PROCESSED:
        await this.ordersService.completeCommand(
          message.data.commandId,
          message.data.success,
          message.data.error,
        );
        return;

      default:
        throw new Error(
          `Tipo de mensagem desconhecido: ${String((message as { type?: unknown }).type)}`,
        );
    }
  }
}
