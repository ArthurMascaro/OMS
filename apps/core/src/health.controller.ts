import { Controller, Get } from '@nestjs/common';

import { OutboxRelayService } from './outbox/outbox-relay.service';

@Controller('health')
export class HealthController {
  constructor(private readonly outboxRelay: OutboxRelayService) {}

  @Get()
  async check() {
    return { status: 'ok', outbox: await this.outboxRelay.stats() };
  }
}
