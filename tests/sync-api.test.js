import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { startServer } from '../src/server.js';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join('/tmp', 'easyaiconfig-sync-api-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function validProviderBundle() {
  return {
    schema: 'easyaiconfig.asset-bundle.v1',
    app: 'EasyAIConfig',
    version: 1,
    exportedAt: '2026-07-05T00:00:00.000Z',
    assets: {
      providerCatalog: {
        schema: 'easyaiconfig.provider-catalog.v1',
        presets: [
          {
            id: 'demo-sync-provider',
            name: 'Demo Sync Provider',
            baseUrls: ['https://api.demo-sync.example/v1'],
            envKey: 'DEMO_SYNC_API_KEY',
            protocols: ['openai-chat'],
            tools: ['codex'],
          },
        ],
      },
    },
  };
}

test('sync pull applies provider catalog presets by default', async () => {
  await withTempDir(async (dir) => {
    const syncDir = path.join(dir, 'sync');
    const codexHome = path.join(dir, 'codex-home');
    await fs.mkdir(syncDir, { recursive: true });
    await fs.mkdir(codexHome, { recursive: true });

    const { server, url, localApiToken } = await startServer({ openBrowser: false });
    const request = async (route, body) => {
      const response = await fetch(`${url}${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-local-token': localApiToken,
        },
        body: JSON.stringify(body),
      });
      return response.json();
    };

    try {
      const pushed = await request('/api/sync/push', {
        targetPath: syncDir,
        snapshotId: 'provider-catalog-default',
        bundle: validProviderBundle(),
        dryRun: false,
      });
      assert.equal(pushed.ok, true);
      assert.equal(pushed.data.entry.counts.providerPresets, 1);

      const pulled = await request('/api/sync/pull', {
        targetPath: syncDir,
        snapshotId: 'provider-catalog-default',
        codexHome,
        dryRun: true,
        targetTool: 'all',
      });
      assert.equal(pulled.ok, true);
      assert.equal(pulled.data.importResult.summary.totalProviders, 1);
      assert.equal(pulled.data.importResult.summary.created, 1);
      assert.equal(pulled.data.importResult.summary.written, false);
      assert.equal(pulled.data.importResult.results.providers.includeCatalogPresets, true);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
