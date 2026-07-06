import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Hermes router client writer can be read back as native state', async () => {
  const previousOverride = process.env.EASYAICONFIG_ALLOW_CONFIG_HOME_OVERRIDE;
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'easyaiconfig-hermes-'));
  process.env.EASYAICONFIG_ALLOW_CONFIG_HOME_OVERRIDE = '1';
  try {
    const mod = await import(`../src/lib/config-store.js?hermes-state=${Date.now()}`);
    const hermesHome = path.join(tmpHome, '.hermes');
    await fs.mkdir(hermesHome, { recursive: true });
    await fs.writeFile(path.join(hermesHome, 'config.yaml'), [
      'workspace:',
      '  root: "/tmp/demo"',
      '',
      'model:',
      '  provider: "old"',
      '  default: "old-model"',
      '',
      'tools:',
      '  shell: true',
      '',
    ].join('\n'));

    await mod.applyProviderRouterClientConfig({
      tool: 'hermes',
      endpoint: 'http://127.0.0.1:18791/v1',
      apiKey: 'easyai-router',
      noProxy: '',
      model: 'openai/gpt-5.5',
      configHome: hermesHome,
    });

    const state = await mod.loadHermesState({ configHome: hermesHome });
    assert.equal(state.toolId, 'hermes');
    assert.equal(state.model, 'gpt-5.5');
    assert.equal(state.baseUrl, 'http://127.0.0.1:18791/v1');
    assert.equal(state.nativeProvider.provider, 'custom');
    assert.equal(state.nativeProvider.hasApiKey, true);
    assert.equal(state.nativeProvider.maskedApiKey, 'easy***uter');
    assert.equal(state.env.hasEasyAiRouterKey, true);
    assert.equal(state.env.hasOpenAiKey, true);
    assert.equal(state.routerProfile.providerKey, 'easyai-router');

    const yaml = await fs.readFile(path.join(hermesHome, 'config.yaml'), 'utf8');
    assert.match(yaml, /workspace:\n  root: "\/tmp\/demo"/);
    assert.match(yaml, /model:\n  provider: "custom"\n  default: "gpt-5\.5"/);
    assert.match(yaml, /tools:\n  shell: true/);

    const env = await fs.readFile(path.join(hermesHome, '.env'), 'utf8');
    assert.match(env, /EASYAI_ROUTER_API_KEY=easyai-router/);
    assert.match(env, /OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:18791\/v1/);
  } finally {
    if (previousOverride === undefined) {
      delete process.env.EASYAICONFIG_ALLOW_CONFIG_HOME_OVERRIDE;
    } else {
      process.env.EASYAICONFIG_ALLOW_CONFIG_HOME_OVERRIDE = previousOverride;
    }
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
