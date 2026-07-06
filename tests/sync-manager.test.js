import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  listSyncSnapshots,
  listSyncTargets,
  pushSyncSnapshot,
  readSyncSnapshot,
  saveSyncTargets,
} from '../src/lib/sync-manager.js';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyaiconfig-sync-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withWebDavServer(fn) {
  const files = new Map();
  const dirs = new Set(['/easyai']);
  const expectedAuth = `Basic ${Buffer.from('sync-user:sync-pass').toString('base64')}`;
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname.replace(/\/$/, '') || '/';
    requests.push({ method: req.method, path: pathname, authorization: req.headers.authorization || '' });
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401);
      res.end('auth required');
      return;
    }
    if (req.method === 'MKCOL') {
      if (dirs.has(pathname)) {
        res.writeHead(405);
      } else {
        dirs.add(pathname);
        res.writeHead(201);
      }
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      files.set(pathname, Buffer.concat(chunks).toString('utf8'));
      res.writeHead(201);
      res.end();
      return;
    }
    if (req.method === 'GET') {
      if (!files.has(pathname)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(files.get(pathname));
      return;
    }
    res.writeHead(405);
    res.end('method not allowed');
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return await fn({
      url: `http://127.0.0.1:${port}/easyai`,
      files,
      requests,
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('sync targets can be saved and listed with readiness metadata', async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, 'sync-targets.json');
    const readyDir = path.join(dir, 'ready-sync');
    await fs.mkdir(readyDir, { recursive: true });

    await saveSyncTargets({
      targets: [
        { id: 'nas-main', type: 'nas', label: 'NAS Main', path: readyDir },
        { id: 'team-webdav', type: 'webdav', label: 'Team WebDAV', url: 'https://dav.example.com/easyai' },
      ],
    }, { configPath });

    const inventory = await listSyncTargets({ configPath });
    assert.equal(inventory.schema, 'easyaiconfig.sync-targets.v1');
    assert.ok(inventory.summary.configured >= 2);

    const nas = inventory.targets.find((target) => target.id === 'nas-main');
    assert.equal(nas.type, 'nas');
    assert.equal(nas.exists, true);
    assert.equal(nas.ready, true);

    const webdav = inventory.targets.find((target) => target.id === 'team-webdav');
    assert.equal(webdav.type, 'webdav');
    assert.equal(webdav.ready, true);
    assert.equal(webdav.url, 'https://dav.example.com/easyai');
  });
});

test('sync snapshots dry-run, push, list, and read asset bundles', async () => {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, 'sync-targets.json');
    const syncDir = path.join(dir, 'cloud', 'EasyAIConfig');
    await fs.mkdir(syncDir, { recursive: true });
    await saveSyncTargets({
      targets: [
        { id: 'cloud-dir', type: 'dropbox', label: 'Cloud Dir', path: syncDir },
      ],
    }, { configPath });

    const bundle = {
      schema: 'easyaiconfig.asset-bundle.v1',
      app: 'EasyAIConfig',
      version: 1,
      exportedAt: '2026-07-05T00:00:00.000Z',
      assets: {
        providerCatalog: {
          schema: 'easyaiconfig.provider-catalog.v1',
          presets: [
            {
              id: 'demo',
              name: 'Demo',
              baseUrls: ['https://api.demo.example/v1'],
              envKey: 'DEMO_API_KEY',
              protocols: ['openai-chat'],
              tools: ['codex'],
            },
          ],
        },
      },
    };

    const preview = await pushSyncSnapshot({
      targetId: 'cloud-dir',
      snapshotId: 'demo-snapshot',
      bundle,
    }, { configPath });
    assert.equal(preview.schema, 'easyaiconfig.sync-push.v1');
    assert.equal(preview.dryRun, true);
    assert.equal(await fs.stat(path.join(syncDir, 'manifest.json')).then(() => true, () => false), false);

    const pushed = await pushSyncSnapshot({
      targetId: 'cloud-dir',
      snapshotId: 'demo-snapshot',
      bundle,
      dryRun: false,
    }, { configPath });
    assert.equal(pushed.changed, true);
    assert.equal(pushed.entry.counts.providerPresets, 1);

    const snapshots = await listSyncSnapshots({ targetId: 'cloud-dir' }, { configPath });
    assert.equal(snapshots.schema, 'easyaiconfig.sync-snapshots.v1');
    assert.equal(snapshots.summary.snapshots, 1);
    assert.equal(snapshots.summary.latestSnapshotId, 'demo-snapshot');

    const pulled = await readSyncSnapshot({ targetId: 'cloud-dir', snapshotId: 'demo-snapshot' }, { configPath });
    assert.equal(pulled.schema, 'easyaiconfig.sync-pull.v1');
    assert.equal(pulled.entry.id, 'demo-snapshot');
    assert.deepEqual(pulled.bundle.assets.providerCatalog.presets, [
      {
        id: 'demo',
        name: 'Demo',
        baseUrls: ['https://api.demo.example/v1'],
        envKey: 'DEMO_API_KEY',
        protocols: ['openai-chat'],
        tools: ['codex'],
      },
    ]);

    const all = await listSyncSnapshots({}, { configPath });
    const cloud = all.targets.find((target) => target.target.id === 'cloud-dir');
    assert.equal(cloud.summary.latestSnapshotId, 'demo-snapshot');
  });
});

test('webdav sync snapshots push, list, and read with redacted target auth', async () => {
  await withTempDir(async (dir) => {
    await withWebDavServer(async ({ url, files, requests }) => {
      const configPath = path.join(dir, 'sync-targets.json');
      const saved = await saveSyncTargets({
        targets: [
          {
            id: 'team-webdav',
            type: 'webdav',
            label: 'Team WebDAV',
            url,
            username: 'sync-user',
            password: 'sync-pass',
          },
        ],
      }, { configPath });
      assert.equal(saved.targets[0].password, undefined);
      assert.equal(saved.targets[0].auth.hasPassword, true);

      const inventory = await listSyncTargets({ configPath });
      const webdav = inventory.targets.find((target) => target.id === 'team-webdav');
      assert.equal(webdav.ready, true);
      assert.equal(webdav.password, undefined);
      assert.equal(webdav.auth.type, 'basic');
      assert.equal(webdav.auth.hasPassword, true);

      const bundle = {
        schema: 'easyaiconfig.asset-bundle.v1',
        app: 'EasyAIConfig',
        version: 1,
        exportedAt: '2026-07-05T00:00:00.000Z',
        assets: {
          providerCatalog: {
            schema: 'easyaiconfig.provider-catalog.v1',
            presets: [
              {
                id: 'webdav-demo',
                name: 'WebDAV Demo',
                baseUrls: ['https://api.webdav-demo.example/v1'],
                envKey: 'WEBDAV_DEMO_API_KEY',
                protocols: ['openai-chat'],
                tools: ['codex'],
              },
            ],
          },
        },
      };

      const preview = await pushSyncSnapshot({
        targetId: 'team-webdav',
        snapshotId: 'webdav-demo',
        bundle,
      }, { configPath });
      assert.equal(preview.dryRun, true);
      assert.equal(files.size, 0);

      const pushed = await pushSyncSnapshot({
        targetId: 'team-webdav',
        snapshotId: 'webdav-demo',
        bundle,
        dryRun: false,
      }, { configPath });
      assert.equal(pushed.changed, true);
      assert.equal(pushed.target.password, undefined);
      assert.equal(pushed.entry.counts.providerPresets, 1);
      assert.equal(files.has('/easyai/manifest.json'), true);
      assert.equal(files.has('/easyai/snapshots/webdav-demo.json'), true);

      const snapshots = await listSyncSnapshots({ targetId: 'team-webdav' }, { configPath });
      assert.equal(snapshots.summary.snapshots, 1);
      assert.equal(snapshots.summary.latestSnapshotId, 'webdav-demo');
      assert.equal(snapshots.target.password, undefined);

      const pulled = await readSyncSnapshot({ targetId: 'team-webdav', snapshotId: 'webdav-demo' }, { configPath });
      assert.equal(pulled.schema, 'easyaiconfig.sync-pull.v1');
      assert.deepEqual(pulled.bundle.assets.providerCatalog.presets, bundle.assets.providerCatalog.presets);
      assert.ok(requests.some((request) => request.method === 'MKCOL' && request.path === '/easyai/snapshots'));
      assert.ok(requests.every((request) => request.authorization === requests[0].authorization));
    });
  });
});
