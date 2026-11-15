import { OrderStatus } from '@oms/contracts';

export enum OrderCommandStatus {
  PENDING = 'PENDING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.CREATED]: [OrderStatus.RESERVED, OrderStatus.CANCELED],
  [OrderStatus.RESERVED]: [OrderStatus.INVOICED, OrderStatus.CANCELED],
  [OrderStatus.INVOICED]: [OrderStatus.SHIPPED],
  [OrderStatus.SHIPPED]: [OrderStatus.RETURNED],
  [OrderStatus.RETURNED]: [],
  [OrderStatus.CANCELED]: [],
};
