import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { StockEventType } from '@oms/contracts';

registerEnumType(StockEventType, {
  name: 'StockEventType',
});

@ObjectType('Stock')
export class StockType {
  @Field()
  sku: string;

  @Field(() => Int)
  physical: number;

  @Field(() => Int)
  reserved: number;

  @Field(() => Int)
  available: number;
}

@ObjectType('Movement')
export class MovementType {
  @Field(() => ID)
  eventId: string;

  @Field(() => StockEventType)
  type: StockEventType;

  @Field()
  sku: string;

  @Field(() => Int)
  version: number;

  @Field(() => Int)
  quantity: number;

  @Field(() => ID, { nullable: true })
  orderId?: string;

  @Field()
  occurredAt: Date;
}
