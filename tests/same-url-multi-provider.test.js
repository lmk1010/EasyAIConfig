import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import TOML from '@iarna/toml';

import { saveConfig, loadState } from '../src/lib/config-store.js';

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join('/tmp', prefix));
}

async function writeInitial(codexHome, { configToml = '', envText = '' } = {}) {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), configToml, 'utf8');
  await fs.writeFile(path.join(codexHome, '.env'), envText, 'utf8');
}

test('same Base URL can save multiple providers with different API keys', async (t) => {
  const codexHome = await makeTempDir('eac-same-url-');
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));

  await writeInitial(codexHome, {
    configToml: '',
    envText: '',
  });

  const first = await saveConfig({
    codexHome,
    baseUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-first',
    providerKey: 'relay-example',
    providerLabel: 'Relay Example',
    envKey: 'RELAY_EXAMPLE_API_KEY',
    activate: true,
  });
  assert.equal(first.saved, true);
  assert.equal(first.savedProviderKey, 'relay-example');

  const second = await saveConfig({
    codexHome,
    baseUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-second',
    providerKey: 'relay-example', // preferred name collides; createNew allocates sibling
    providerLabel: 'Relay Example 2',
    envKey: 'RELAY_EXAMPLE_API_KEY', // preferred env collides; auto-allocate sibling env
    createNew: true,
    activate: false,
  });
  assert.equal(second.saved, true);
  assert.equal(second.savedProviderKey, 'relay-example-2');
  assert.equal(second.envKey, 'RELAY_EXAMPLE_2_API_KEY');
  assert.ok((second.hints || []).some((item) => item.code === 'provider_key_allocated'));

  const config = TOML.parse(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'));
  assert.equal(config.model_provider, 'relay-example');
  assert.equal(config.model_providers['relay-example'].base_url, 'https://relay.example.com/v1');
  assert.equal(config.model_providers['relay-example-2'].base_url, 'https://relay.example.com/v1');
  assert.equal(config.model_providers['relay-example'].env_key, 'RELAY_EXAMPLE_API_KEY');
  assert.equal(config.model_providers['relay-example-2'].env_key, 'RELAY_EXAMPLE_2_API_KEY');

  const envText = await fs.readFile(path.join(codexHome, '.env'), 'utf8');
  assert.match(envText, /RELAY_EXAMPLE_API_KEY=sk-first/);
  assert.match(envText, /RELAY_EXAMPLE_2_API_KEY=sk-second/);

  const state = await loadState({ codexHome });
  const sameUrlProviders = (state.providers || []).filter((item) => item.baseUrl === 'https://relay.example.com/v1');
  assert.equal(sameUrlProviders.length >= 2, true);
});

test('updating existing provider by providerKey does not create a sibling', async (t) => {
  const codexHome = await makeTempDir('eac-same-url-update-');
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));

  await writeInitial(codexHome, {
    configToml: `
model_provider = "relay-example"

[model_providers.relay-example]
name = "Relay Example"
base_url = "https://relay.example.com/v1"
env_key = "RELAY_EXAMPLE_API_KEY"
`.trim() + '\n',
    envText: 'RELAY_EXAMPLE_API_KEY=sk-old\n',
  });

  const updated = await saveConfig({
    codexHome,
    baseUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-new',
    providerKey: 'relay-example',
    providerLabel: 'Relay Example',
    envKey: 'RELAY_EXAMPLE_API_KEY',
    activate: false,
  });
  assert.equal(updated.savedProviderKey, 'relay-example');
  assert.equal(updated.envKey, 'RELAY_EXAMPLE_API_KEY');
  assert.equal((updated.hints || []).some((item) => item.code === 'provider_key_allocated'), false);

  const config = TOML.parse(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'));
  assert.equal(Object.keys(config.model_providers || {}).length, 1);
  assert.equal(config.model_providers['relay-example'].base_url, 'https://relay.example.com/v1');
  const envText = await fs.readFile(path.join(codexHome, '.env'), 'utf8');
  assert.match(envText, /RELAY_EXAMPLE_API_KEY=sk-new/);
});

test('explicit different providerKey with same Base URL coexists', async (t) => {
  const codexHome = await makeTempDir('eac-same-url-explicit-');
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));

  await writeInitial(codexHome);

  await saveConfig({
    codexHome,
    baseUrl: 'https://api.multi.example/v1',
    apiKey: 'sk-a',
    providerKey: 'multi-a',
    providerLabel: 'Multi A',
    envKey: 'MULTI_A_API_KEY',
  });
  const second = await saveConfig({
    codexHome,
    baseUrl: 'https://api.multi.example/v1',
    apiKey: 'sk-b',
    providerKey: 'multi-b',
    providerLabel: 'Multi B',
    envKey: 'MULTI_B_API_KEY',
  });
  assert.equal(second.savedProviderKey, 'multi-b');
  const config = TOML.parse(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'));
  assert.ok(config.model_providers['multi-a']);
  assert.ok(config.model_providers['multi-b']);
  assert.equal(config.model_providers['multi-a'].base_url, 'https://api.multi.example/v1');
  assert.equal(config.model_providers['multi-b'].base_url, 'https://api.multi.example/v1');
});
