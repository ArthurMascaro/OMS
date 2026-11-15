import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsString,
} from 'class-validator';

import { Capability, PluginManifest } from '@oms/contracts';

export class RegisterPluginDto implements PluginManifest {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsNotEmpty()
  marketplace: string;

  @IsArray()
  @ArrayUnique()
  @IsEnum(Capability, { each: true })
  capabilities: Capability[];
}
