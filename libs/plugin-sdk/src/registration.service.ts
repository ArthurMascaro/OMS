import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';

import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_ROUTE,
  REGISTER_ROUTE,
} from '@oms/contracts';
import type { PluginManifest } from '@oms/contracts';

import { PLUGIN_MANIFEST } from './plugin-sdk.constants';

@Injectable()
export class RegistrationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RegistrationService.name);
  private readonly coreUrl: string;
  private registered = false;

  constructor(
    @Inject(PLUGIN_MANIFEST) private readonly manifest: PluginManifest,
    config: ConfigService,
  ) {
    this.coreUrl = config.getOrThrow('CORE_URL');
  }

  async onApplicationBootstrap() {
    await this.register();
  }

  @Interval(HEARTBEAT_INTERVAL_MS)
  async heartbeat() {
    if (!this.registered) {
      await this.register();
      return;
    }

    const heartbeatRoute = HEARTBEAT_ROUTE.replace(':id', this.manifest.id);
    const heartbeatURL = `${this.coreUrl}/${heartbeatRoute}`;

    try {
      const response = await fetch(heartbeatURL, {
        method: 'POST',
      });

      if (response.status === Number(HttpStatus.NOT_FOUND)) {
        this.registered = false;
        await this.register();
      }
    } catch {
      this.logger.warn('Core unavailable, heartbeat not sent');
    }
  }

  private async register() {
    const registerURL = `${this.coreUrl}/${REGISTER_ROUTE}`;

    try {
      const response = await fetch(registerURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.manifest),
      });

      if (!response.ok) {
        this.logger.error(`Registration rejected with ${response.status}`);
        return;
      }

      this.registered = true;
      this.logger.log(`Plugin ${this.manifest.id} registered on core`);
    } catch {
      this.logger.warn('Core unavailable, registration not sent');
    }
  }
}
