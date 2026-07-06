import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Gemini router client writer can be read back as safe profile state', async () => {
  const previousOverride = process.env.EASYAICONFIG_ALLOW_CONFIG_HOME_OVERRIDE;
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'easyaiconfig-gemini-'));
  process.env.EASYAICONFIG_ALLOW_CONFIG_HOME_OVERRIDE = '1';
  try {
    const mod = await import(`../src/lib/config-store.js?gemini-state=${Date.now()}`);
    const geminiHome = path.join(tmpHome, '.gemini');
    await fs.mkdir(geminiHome, { recursive: true });
    await fs.writeFile(path.join(geminiHome, 'settings.json'), JSON.stringify({
      theme: 'dark',
      model: 'gemini-2.5-flash',
    }, null, 2));

    await mod.applyProviderRouterClientConfig({
      tool: 'gemini',
      endpoint: 'http://127.0.0.1:18791/v1',
      apiKey: 'easyai-router',
      noProxy: '',
      model: 'gemini-3-pro',
      configHome: geminiHome,
    });

    const state = await mod.loadGeminiState({ configHome: geminiHome });
    assert.equal(state.toolId, 'gemini');
    assert.equal(state.model, 'gemini-3-pro');
    assert.equal(state.baseUrl, 'http://127.0.0.1:18791/v1');
    assert.equal(state.activeProviderKey, 'easyai-router');
    assert.equal(state.safeProfile.hasApiKey, true);
    assert.equal(state.safeProfile.maskedApiKey, 'easy***uter');
    assert.equal(state.settings.theme, 'dark');
    assert.equal(state.routerProfile.providerKey, 'easyai-router');

    const settings = JSON.parse(await fs.readFile(path.join(geminiHome, 'settings.json'), 'utf8'));
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.model, 'gemini-2.5-flash');
    assert.equal(settings.easyaiconfig.router.model, 'gemini-3-pro');
    assert.equal(settings.easyaiconfig.router.baseUrl, 'http://127.0.0.1:18791/v1');
  } finally {
    if (previousOverride === undefined) {
      delete process.env.EASYAICONFIG_ALLOW_CONFIG_HOME_OVERRIDE;
    } else {
      process.env.EASYAICONFIG_ALLOW_CONFIG_HOME_OVERRIDE = previousOverride;
    }
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
