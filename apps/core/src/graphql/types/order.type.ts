import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { OrderStatus } from '@oms/contracts';

import { StockType } from './stock.type';

registerEnumType(OrderStatus, {
  name: 'OrderStatus',
});

@ObjectType('OrderItem')
export class OrderItemType {
  @Field()
  sku: string;

  @Field(() => Int)
  quantity: number;

  @Field(() => Int)
  unitPriceCents: number;
}

@ObjectType('Order')
export class OrderType {
  @Field(() => ID)
  id: string;

  @Field({ nullable: true })
  pluginId?: string;

  @Field({ nullable: true })
  externalOrderId?: string;

  @Field(() => OrderStatus)
  status: OrderStatus;

  @Field(() => [OrderItemType])
  items: OrderItemType[];

  @Field(() => Int)
  totalCents: number;

  @Field({ nullable: true })
  cancelReason?: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;

  @Field(() => [StockType])
  stock: StockType[];
}
