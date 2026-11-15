export enum StockEventType {
  RESERVATION_CREATED = 'RESERVATION_CREATED',
  RESERVATION_RELEASED = 'RESERVATION_RELEASED',
  STOCK_SHIPPED = 'STOCK_SHIPPED',
  STOCK_RETURNED = 'STOCK_RETURNED',
  STOCK_RECEIVED = 'STOCK_RECEIVED',
}

export interface BaseStockEvent {
  eventId: string;
  type: StockEventType;
  sku: string;
  version: number;
  quantity: number;
  orderId?: string;
  occurredAt: string;
}

export interface ReservationCreated extends BaseStockEvent {
  type: StockEventType.RESERVATION_CREATED;
  orderId: string;
}

export interface ReservationReleased extends BaseStockEvent {
  type: StockEventType.RESERVATION_RELEASED;
  orderId: string;
}

export interface StockShipped extends BaseStockEvent {
  type: StockEventType.STOCK_SHIPPED;
  orderId: string;
}

export interface StockReturned extends BaseStockEvent {
  type: StockEventType.STOCK_RETURNED;
  orderId: string;
}

export interface StockReceived extends BaseStockEvent {
  type: StockEventType.STOCK_RECEIVED;
}

export type StockEvent =
  | ReservationCreated
  | ReservationReleased
  | StockShipped
  | StockReturned
  | StockReceived;

export interface StockBalance {
  sku: string;
  physical: number;
  reserved: number;
  available: number;
}
