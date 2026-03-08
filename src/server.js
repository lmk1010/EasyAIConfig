import express from 'express';
import open from 'open';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectProvider,
} from './lib/provider-check.js';
import {
  checkSetupEnvironment,
  getProviderSecret,
  getCodexReleaseInfo,
  installClaudeCode,
  installCodex,
  launchClaudeCode,
  launchCodex,
  listBackups,
  listTools,
  loadClaudeCodeState,
  loadState,
  reinstallClaudeCode,
  reinstallCodex,
  restoreBackup,
  saveClaudeCodeConfig,
  saveClaudeCodeRawConfig,
  saveConfig,
  saveRawConfig,
  saveSettings,
  testSavedProvider,
  uninstallClaudeCode,
  uninstallCodex,
  updateClaudeCode,
  updateCodex,
} from './lib/config-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

function ok(res, data) {
  res.json({ ok: true, ...data });
}

function fail(res, error) {
  res.status(400).json({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(publicDir));

  app.get('/api/tools', async (_req, res) => {
    try {
      ok(res, { data: listTools() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/setup/check', async (req, res) => {
    try {
      const data = await checkSetupEnvironment({
        codexHome: req.query.codexHome || undefined,
      });
      ok(res, { data });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/state', async (req, res) => {
    try {
      const data = await loadState({
        scope: req.query.scope || 'global',
        projectPath: req.query.projectPath || '',
        codexHome: req.query.codexHome || undefined,
      });
      ok(res, { data });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/provider/test', async (req, res) => {
    try {
      const result = await detectProvider(req.body || {});
      ok(res, { data: result });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/provider/secret', async (req, res) => {
    try {
      ok(res, { data: await getProviderSecret(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/provider/test-saved', async (req, res) => {
    try {
      ok(res, { data: await testSavedProvider(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/config/save', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.baseUrl) throw new Error('Base URL is required');
      if (!body.providerKey) throw new Error('Provider key is required');
      const result = await saveConfig(body);
      ok(res, { data: result });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/config/raw-save', async (req, res) => {
    try {
      ok(res, { data: await saveRawConfig(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/config/settings-save', async (req, res) => {
    try {
      ok(res, { data: await saveSettings(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/install', async (_req, res) => {
    try {
      ok(res, { data: await installCodex() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/codex/release', async (_req, res) => {
    try {
      ok(res, { data: await getCodexReleaseInfo() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/reinstall', async (_req, res) => {
    try {
      ok(res, { data: await reinstallCodex() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/update', async (_req, res) => {
    try {
      ok(res, { data: await updateCodex() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/uninstall', async (_req, res) => {
    try {
      ok(res, { data: await uninstallCodex() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/launch', async (req, res) => {
    try {
      ok(res, { data: await launchCodex(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  // ─── Claude Code endpoints ───
  app.get('/api/claudecode/state', async (_req, res) => {
    try {
      ok(res, { data: await loadClaudeCodeState() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/config-save', async (req, res) => {
    try {
      ok(res, { data: await saveClaudeCodeConfig(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/raw-save', async (req, res) => {
    try {
      ok(res, { data: await saveClaudeCodeRawConfig(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/install', async (_req, res) => {
    try {
      ok(res, { data: await installClaudeCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/reinstall', async (_req, res) => {
    try {
      ok(res, { data: await reinstallClaudeCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/update', async (_req, res) => {
    try {
      ok(res, { data: await updateClaudeCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/uninstall', async (_req, res) => {
    try {
      ok(res, { data: await uninstallClaudeCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/launch', async (req, res) => {
    try {
      ok(res, { data: await launchClaudeCode(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/backups', async (_req, res) => {
    try {
      ok(res, { data: await listBackups() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/backups/restore', async (req, res) => {
    try {
      ok(res, { data: await restoreBackup(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.on('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 3210;
  const url = `http://127.0.0.1:${port}`;

  console.log(`[easyaiconfig] running at ${url}`);
  open(url).catch(() => { });

  return { app, server, url };
}
