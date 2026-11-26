import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

import { Capability, HEARTBEAT_INTERVAL_MS } from '@oms/contracts';
import type { PluginManifest } from '@oms/contracts';
import { PluginSdkModule } from '@oms/plugin-sdk';

import { AppModule } from '../src/app.module';
import { PluginRegistryService } from '../src/plugin-registry/plugin-registry.service';

describe('Registro de plugin com o core em execução (e2e)', () => {
  let core: INestApplication;
  let plugin: INestApplication;
  let registry: PluginRegistryService;
  let pool: Pool;

  const manifest: PluginManifest = {
    id: `plugin-e2e-${randomUUID()}`,
    marketplace: 'Marketplace E2E',
    capabilities: [Capability.SHIP_ORDER, Capability.UPDATE_STOCK],
  };

  const findRegistered = async () => {
    const active = await registry.findActive();
    return active.find((item) => item.id === manifest.id);
  };

  const waitForRegistration = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const registered = await findRegistered();

      if (registered) {
        return registered;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return undefined;
  };

  beforeAll(async () => {
    const coreModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    core = coreModule.createNestApplication();
    core.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    await core.listen(0);

    registry = core.get(PluginRegistryService);
    pool = core.get(Pool);

    process.env.CORE_URL = await core.getUrl();

    const pluginModule = await Test.createTestingModule({
      imports: [PluginSdkModule.register(manifest)],
    }).compile();

    plugin = pluginModule.createNestApplication();
    await plugin.init();
  });

  afterAll(async () => {
    await plugin.close();
    await pool.query('DELETE FROM plugin WHERE id = $1', [manifest.id]);
    await core.close();
    await pool.end();
  });

  it('plugin que sobe com o core rodando aparece ativo com as capacidades do manifesto', async () => {
    const registered = await waitForRegistration(2000);

    expect(registered).toEqual({
      id: manifest.id,
      marketplace: manifest.marketplace,
      capabilities: manifest.capabilities,
    });
  });

  it('core que perde o registro recebe o manifesto de novo no próximo heartbeat', async () => {
    await pool.query('DELETE FROM plugin WHERE id = $1', [manifest.id]);

    expect(await findRegistered()).toBeUndefined();

    const registered = await waitForRegistration(HEARTBEAT_INTERVAL_MS + 3000);

    expect(registered?.capabilities).toEqual(manifest.capabilities);
  }, 20000);
});
