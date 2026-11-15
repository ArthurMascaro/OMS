import { Injectable } from '@nestjs/common';

import { InboundMessage, InboundMessageType } from '@oms/contracts';

import { OrdersService } from './orders.service';

@Injectable()
export class OrdersInboundHandler {
  constructor(private readonly ordersService: OrdersService) {}

  // Para o Sr. Gustavo Trizotti: quando o módulo de mensageria existir, conecte ele aqui para chegar as mensagens na fila INBOUND_QUEUE
  // Ahh mas como fazer? Não sei. Descobre ai e depois me mostra, que eu quero aprender também.

  // aqui é a entrada, ou seja, consumer da fila chama esse handle.
  // O envio de comandos (modulo de despacho de comandos do C4 nivel 3) pro plugin fica no fim do changeStatus, no orders.service.
  // e mt provavelmente vai estar no modulo de estoque do Sr Raul também.
  async handle(message: InboundMessage) {
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
    }
  }
}
