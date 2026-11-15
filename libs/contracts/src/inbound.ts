export enum InboundMessageType {
  ORDER_RECEIVED = 'ORDER_RECEIVED',
  ORDER_CANCELED_BY_CHANNEL = 'ORDER_CANCELED_BY_CHANNEL',
  COMMAND_PROCESSED = 'COMMAND_PROCESSED',
}

export interface BaseInboundMessage {
  messageId: string;
  type: InboundMessageType;
  pluginId: string;
  issuedAt: string;
}

export interface OrderReceived extends BaseInboundMessage {
  type: InboundMessageType.ORDER_RECEIVED;
  data: {
    externalOrderId: string;
    items: {
      sku: string;
      quantity: number;
      unitPriceCents: number;
    }[];
  };
}

export interface OrderCanceledByChannel extends BaseInboundMessage {
  type: InboundMessageType.ORDER_CANCELED_BY_CHANNEL;
  data: {
    externalOrderId: string;
    reason: string;
  };
}

export interface CommandProcessed extends BaseInboundMessage {
  type: InboundMessageType.COMMAND_PROCESSED;
  data: {
    commandId: string;
    success: boolean;
    error?: string;
  };
}

export type InboundMessage =
  OrderReceived | OrderCanceledByChannel | CommandProcessed;
