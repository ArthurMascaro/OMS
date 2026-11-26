import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';

import { InboundPublisherService } from '../messaging/inbound-publisher.service';
import { CancelOrderDto } from './cancel-order.dto';
import { CreateOrderDto } from './create-order.dto';

interface AcceptedResponse {
  message: string;
  messageId: string;
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly publisher: InboundPublisherService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(@Body() body: CreateOrderDto): Promise<AcceptedResponse> {
    const messageId = await this.publisher.publishOrderReceived({
      externalOrderId: body.externalOrderId,
      items: body.items,
    });

    return {
      message: `Pedido ${body.externalOrderId} enviado para processamento`,
      messageId,
    };
  }

  @Post(':externalOrderId/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  async cancel(
    @Param('externalOrderId') externalOrderId: string,
    @Body() body: CancelOrderDto,
  ): Promise<AcceptedResponse> {
    const messageId = await this.publisher.publishOrderCanceledByChannel({
      externalOrderId,
      reason: body.reason,
    });

    return {
      message: `Cancelamento do pedido ${externalOrderId} enviado para processamento`,
      messageId,
    };
  }
}
