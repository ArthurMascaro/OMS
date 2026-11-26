import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';

import { InboundPublisherService } from '../messaging/inbound-publisher.service';
import { CancelOrderDto } from './cancel-order.dto';
import { CreateOrderDto } from './create-order.dto';
import { ExternalOrderIdParamDto } from './external-order-id-param.dto';

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
    @Param() params: ExternalOrderIdParamDto,
    @Body() body: CancelOrderDto,
  ): Promise<AcceptedResponse> {
    const messageId = await this.publisher.publishOrderCanceledByChannel({
      externalOrderId: params.externalOrderId,
      reason: body.reason,
    });

    return {
      message: `Cancelamento do pedido ${params.externalOrderId} enviado para processamento`,
      messageId,
    };
  }
}
