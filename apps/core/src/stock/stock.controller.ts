import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';

import { StockBalance } from '@oms/contracts';

import { ReceiveStockDto } from './receive-stock.dto';
import { StockService } from './stock.service';

@Controller('stock')
export class StockController {
  constructor(private readonly stockService: StockService) {}

  @Get(':sku')
  getBalance(@Param('sku') sku: string): Promise<StockBalance> {
    return this.stockService.getBalance(sku);
  }

  @Post('receipts')
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(@Body() body: ReceiveStockDto): Promise<void> {
    await this.stockService.receive(body.sku, body.quantity);
  }
}
