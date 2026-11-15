import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import { CancelOrderDto } from './cancel-order.dto';
import { CreateOrderDto } from './create-order.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  async create(@Body() body: CreateOrderDto): Promise<{ id: string }> {
    const id = await this.ordersService.create(body);

    if (!id) {
      throw new BadRequestException('Could not create order');
    }

    return { id };
  }

  @Post(':id/invoice')
  @HttpCode(HttpStatus.NO_CONTENT)
  async invoice(@Param('id', ParseUUIDPipe) id: string) {
    await this.ordersService.invoice(id);
  }

  @Post(':id/ship')
  @HttpCode(HttpStatus.NO_CONTENT)
  async ship(@Param('id', ParseUUIDPipe) id: string) {
    await this.ordersService.ship(id);
  }

  @Post(':id/return')
  @HttpCode(HttpStatus.NO_CONTENT)
  async return(@Param('id', ParseUUIDPipe) id: string) {
    await this.ordersService.return(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelOrderDto,
  ) {
    await this.ordersService.cancel(id, body.reason);
  }
}
