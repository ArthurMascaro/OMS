import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { ReceiveStockDto } from './receive-stock.dto';
import { StockService } from './stock.service';

@Controller('stock')
export class StockController {
  constructor(private readonly stockService: StockService) {}

  @Post('receipts')
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(@Body() body: ReceiveStockDto): Promise<void> {
    await this.stockService.receive(body.sku, body.quantity);
  }
}
