export enum OrderStatus {
  CREATED = 'CREATED',
  RESERVED = 'RESERVED',
  INVOICED = 'INVOICED',
  SHIPPED = 'SHIPPED',
  RETURNED = 'RETURNED',
  CANCELED = 'CANCELED',
}

export interface OrderItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  pluginId?: string;
  externalOrderId?: string;
  status: OrderStatus;
  items: OrderItem[];
  totalCents: number;
  cancelReason?: string;
  createdAt: string;
  updatedAt: string;
}
