import { DynamicModule, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';

import { PluginManifest } from '@oms/contracts';

import { RegistrationService } from './registration.service';
import { PLUGIN_MANIFEST } from './plugin-sdk.constants';

@Module({})
export class PluginSdkModule {
  static register(manifest: PluginManifest): DynamicModule {
    return {
      module: PluginSdkModule,
      imports: [ConfigModule.forRoot(), ScheduleModule.forRoot()],
      providers: [
        { provide: PLUGIN_MANIFEST, useValue: manifest },
        RegistrationService,
      ],
    };
  }
}
