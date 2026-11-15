export enum CommandType {
  INVOICE_ORDER = 'INVOICE_ORDER',
  CANCEL_ORDER = 'CANCEL_ORDER',
  SHIP_ORDER = 'SHIP_ORDER',
  UPDATE_STOCK = 'UPDATE_STOCK',
}

export interface BaseCommand {
  commandId: string;
  type: CommandType;
  pluginId: string;
  issuedAt: string;
}

export interface InvoiceOrderCommand extends BaseCommand {
  type: CommandType.INVOICE_ORDER;
  data: {
    orderId: string;
    externalOrderId: string;
  };
}

export interface CancelOrderCommand extends BaseCommand {
  type: CommandType.CANCEL_ORDER;
  data: {
    orderId: string;
    externalOrderId: string;
    reason: string;
  };
}

export interface ShipOrderCommand extends BaseCommand {
  type: CommandType.SHIP_ORDER;
  data: {
    orderId: string;
    externalOrderId: string;
  };
}

export interface UpdateStockCommand extends BaseCommand {
  type: CommandType.UPDATE_STOCK;
  data: {
    sku: string;
    available: number;
  };
}

export type Command =
  | InvoiceOrderCommand
  | CancelOrderCommand
  | ShipOrderCommand
  | UpdateStockCommand;
