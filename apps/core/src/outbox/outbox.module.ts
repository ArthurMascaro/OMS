import { Module } from '@nestjs/common';

import { MessagingModule } from '../messaging/messaging.module';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxService } from './outbox.service';

@Module({
  imports: [MessagingModule],
  providers: [OutboxService, OutboxRelayService],
  exports: [OutboxService],
})
export class OutboxModule {}
