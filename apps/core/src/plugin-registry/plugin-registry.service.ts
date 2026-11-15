import { Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';

import {
  Capability,
  HEARTBEAT_TIMEOUT_MS,
  PluginManifest,
} from '@oms/contracts';

@Injectable()
export class PluginRegistryService {
  private readonly logger = new Logger(PluginRegistryService.name);

  constructor(private readonly pool: Pool) {}

  async register(manifest: PluginManifest) {
    await this.pool.query(
      `INSERT INTO plugin (
        id, 
        marketplace, 
        capabilities, 
        last_heartbeat_at
       ) VALUES (
        $1, 
        $2, 
        $3, 
        NOW()
       ) 
        ON CONFLICT (id) DO UPDATE SET
          marketplace = EXCLUDED.marketplace,
          capabilities = EXCLUDED.capabilities,
          last_heartbeat_at = NOW()`,
      [manifest.id, manifest.marketplace, manifest.capabilities],
    );

    this.logger.log(`Plugin ${manifest.id} registered`);
  }

  async heartbeat(pluginId: string): Promise<boolean> {
    const response = await this.pool.query(
      `UPDATE plugin
       SET 
        last_heartbeat_at = NOW()
       WHERE id = $1`,
      [pluginId],
    );

    return response.rowCount === 1;
  }

  async findActive(): Promise<PluginManifest[]> {
    const interval = HEARTBEAT_TIMEOUT_MS / 1000;

    const response = await this.pool.query<PluginManifest>(
      `SELECT 
        id, 
        marketplace, 
        capabilities
       FROM plugin
       WHERE 
        last_heartbeat_at > NOW() - make_interval(secs => $1)`,
      [interval],
    );

    return response.rows;
  }

  async findActiveByCapability(
    capability: Capability,
  ): Promise<PluginManifest[]> {
    const interval = HEARTBEAT_TIMEOUT_MS / 1000;

    const response = await this.pool.query<PluginManifest>(
      `SELECT 
        id, 
        marketplace, 
        capabilities
       FROM plugin
       WHERE 
        last_heartbeat_at > NOW() - make_interval(secs => $1)
        AND $2 = ANY (capabilities)`,
      [interval, capability],
    );

    return response.rows;
  }
}
