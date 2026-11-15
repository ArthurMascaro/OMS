import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { OrderItem } from '@oms/contracts';

import { NewOrder } from './orders.service';

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

export class CreateOrderDto implements NewOrder {
  @ValidateIf((dto: CreateOrderDto) => dto.externalOrderId !== undefined)
  @IsString()
  @IsNotEmpty()
  pluginId?: string;

  @ValidateIf((dto: CreateOrderDto) => dto.pluginId !== undefined)
  @IsString()
  @IsNotEmpty()
  externalOrderId?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}
