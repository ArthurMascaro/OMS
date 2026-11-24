import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';

import { StockBalance } from '@oms/contracts';

import {
  STOCK_PROJECTION_QUERY,
} from '../stock-projection/stock-projection.contract';
import type { StockProjectionQuery } from '../stock-projection/stock-projection.contract';
import { ReceiveStockDto } from './receive-stock.dto';
import { StockService } from './stock.service';

@Controller('stock')
export class StockController {
  constructor(
    private readonly stockService: StockService,
    @Inject(STOCK_PROJECTION_QUERY)
    private readonly stockProjection: StockProjectionQuery,
  ) {}

  @Get(':sku')
  getBalance(@Param('sku') sku: string): Promise<StockBalance> {
    return this.stockProjection.getBalance(sku);
  }

  @Post('receipts')
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(@Body() body: ReceiveStockDto): Promise<void> {
    await this.stockService.receive(body.sku, body.quantity);
  }
}
