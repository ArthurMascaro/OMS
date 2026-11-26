import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

import { OrderItem } from '@oms/contracts';

export class CreateOrderItemDto implements OrderItem {
  @IsString()
  @IsNotEmpty()
  sku: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsInt()
  @Min(0)
  unitPriceCents: number;
}

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  externalOrderId: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}
