import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class ReceiveStockDto {
  @IsString()
  @IsNotEmpty()
  sku: string;

  @IsInt()
  @Min(1)
  quantity: number;
}
