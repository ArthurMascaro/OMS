import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';

import { HEARTBEAT_ROUTE, REGISTER_ROUTE } from '@oms/contracts';

import { PluginRegistryService } from './plugin-registry.service';
import { RegisterPluginDto } from './register-plugin.dto';

@Controller()
export class PluginRegistryController {
  constructor(private readonly pluginRegistryService: PluginRegistryService) {}

  @Post(REGISTER_ROUTE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async register(@Body() body: RegisterPluginDto) {
    await this.pluginRegistryService.register(body);
  }

  @Post(HEARTBEAT_ROUTE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async heartbeat(@Param('id') id: string) {
    const status = await this.pluginRegistryService.heartbeat(id);

    if (!status) {
      throw new NotFoundException('Plugin not registered');
    }
  }
}
