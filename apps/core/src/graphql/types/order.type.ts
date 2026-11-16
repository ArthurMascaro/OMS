import { Field, ID, Int, ObjectType, registerEnumType } from "@nestjs/graphql";
import { OrderStatus } from "@oms/contracts";

registerEnumType(OrderStatus, {
    name: 'OrderStatus'
})

@ObjectType()
export class OrderItemType {
    @Field()
    sku: string

    @Field(() => Int)
    quantity: number

    @Field(() => Int)
    unitPriceCents: number
}

@ObjectType()
export class OrderType {
    @Field(() => ID)
    id: string

    @Field({ nullable: true})
    pluginId?: string

    @Field({ nullable: true})
    externalOrderId?: string

    @Field(() => OrderStatus)
    status: OrderStatus

    @Field(() => [OrderItemType])
    items: OrderItemType[]

    @Field(() => Int)
    totalCents: number

    @Field({ nullable: true})
    cancelReason?: string

    @Field()
    createdAt: Date

    @Field()
    updatedAt: Date
}