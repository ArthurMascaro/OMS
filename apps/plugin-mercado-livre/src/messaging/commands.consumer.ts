import {
  defaultNackErrorHandler,
  Nack,
  RabbitSubscribe,
} from '@golevelup/nestjs-rabbitmq';
import { Injectable, Logger } from '@nestjs/common';

import type { Command } from '@oms/contracts';

import { PLUGIN_QUEUE } from '../plugin.constants';
import {
  CommandResult,
  InboundPublisherService,
} from './inbound-publisher.service';

const NACK_WITHOUT_REQUEUE_TO_DEAD_LETTER = new Nack(false);
const NACK_WITH_REQUEUE = new Nack(true);

@Injectable()
export class CommandsConsumer {
  private readonly logger = new Logger(CommandsConsumer.name);

  constructor(private readonly publisher: InboundPublisherService) {}

  @RabbitSubscribe({
    queue: PLUGIN_QUEUE,
    createQueueIfNotExists: false,
    errorHandler: defaultNackErrorHandler,
  })
  async consume(command: Command): Promise<Nack | void> {
    if (!command?.commandId) {
      this.logger.error('Comando sem commandId enviado à DLQ');
      return NACK_WITHOUT_REQUEUE_TO_DEAD_LETTER;
    }

    const result = this.execute(command);

    if (!result.success) {
      this.logger.warn(
        `Comando ${command.commandId} (${command.type}) não processado: ${result.error}`,
      );
    }

    try {
      await this.publisher.publishCommandProcessed(command.commandId, result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Falha ao responder comando ${command.commandId}, recolocando na fila: ${reason}`,
      );
      return NACK_WITH_REQUEUE;
    }
  }

  private execute(command: Command): CommandResult {
    return {
      success: false,
      error: `Integração com a API do Mercado Livre ainda não implementada para ${command.type}`,
    };
  }
}
