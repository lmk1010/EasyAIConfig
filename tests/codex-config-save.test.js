import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import TOML from '@iarna/toml';

import { loadState, saveRawConfig, saveSettings } from '../src/lib/config-store.js';

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join('/tmp', prefix));
}

test('Codex raw save writes auth.json and loadState returns authJsonRaw', async (t) => {
  const codexHome = await makeTempDir('eac-codex-home-');
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));

  const configToml = 'model = "gpt-5.5"\n';
  const authJson = JSON.stringify({ OPENAI_API_KEY: 'sk-test' }, null, 2);

  const saved = await saveRawConfig({ codexHome, configToml, authJson });
  assert.equal(saved.changed, true);
  assert.equal(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'), configToml);
  assert.equal(await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8'), authJson);

  const state = await loadState({ codexHome });
  assert.equal(state.authJsonRaw, authJson);
});

test('Codex project settings save drops keys Codex ignores in project config', async (t) => {
  const codexHome = await makeTempDir('eac-codex-home-');
  const projectPath = await makeTempDir('eac-codex-project-');
  t.after(async () => {
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  await saveSettings({
    scope: 'project',
    projectPath,
    codexHome,
    settings: {
      model: 'gpt-5.5',
      approval_policy: 'never',
      model_provider: 'should-not-be-written',
      model_providers: {
        demo: { name: 'Demo', base_url: 'https://api.example.com/v1' },
      },
      notify: ['echo done'],
      profiles: { local: { model: 'gpt-5.5' } },
    },
  });

  const raw = await fs.readFile(path.join(projectPath, '.codex', 'config.toml'), 'utf8');
  const config = TOML.parse(raw);
  assert.equal(config.model, 'gpt-5.5');
  assert.equal(config.approval_policy, 'never');
  assert.equal(config.model_provider, undefined);
  assert.equal(config.model_providers, undefined);
  assert.equal(config.notify, undefined);
  assert.equal(config.profiles, undefined);
});
