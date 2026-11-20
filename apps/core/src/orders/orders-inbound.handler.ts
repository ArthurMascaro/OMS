import { Injectable } from '@nestjs/common';

import { InboundMessage, InboundMessageType } from '@oms/contracts';

import { OrdersService } from './orders.service';

@Injectable()
export class OrdersInboundHandler {
  constructor(private readonly ordersService: OrdersService) {}

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
