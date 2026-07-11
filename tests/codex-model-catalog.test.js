import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { inspectCodexModelCatalog, readCodexModelCatalog, saveCodexModelCatalog, syncCodexModelCatalog } from '../src/lib/codex-model-catalog.js';

const GPT_54 = {
  slug: 'gpt-5.4',
  display_name: 'GPT-5.4',
  description: 'existing',
  default_reasoning_level: 'high',
  supported_reasoning_levels: [{ effort: 'high', description: 'high' }],
  visibility: 'list',
  supported_in_api: true,
  context_window: 300000,
  custom_field: 'preserved-template-field',
};

async function createCodexHome() {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.easyaiconfig-model-catalog-test-'));
  const codexHome = path.join(root, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  return { root, codexHome };
}

test('syncCodexModelCatalog merges provider models and preserves Codex config', async (t) => {
  const { root, codexHome } = await createCodexHome();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\n[model_providers.demo]\nbase_url = "https://example.test/v1"\nmodel_catalog_json = "/tmp/misplaced.json"\n');
  await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({ fetched_at: 'now', models: [GPT_54] }));

  const first = await syncCodexModelCatalog({
    codexHome,
    providerKey: 'demo/provider',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'GPT-5.6-SOL'],
  });
  assert.equal(first.addedCount, 3);
  assert.equal(first.totalCount, 4);
  assert.equal(first.restartRequired, true);
  assert.equal(path.basename(first.catalogPath), 'model-catalog.demo-provider.json');

  const configText = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
  const config = TOML.parse(configText);
  assert.equal(config.model, 'gpt-5.4');
  assert.equal(config.model_providers.demo.base_url, 'https://example.test/v1');
  assert.equal(config.model_catalog_json, first.catalogPath);
  assert.equal(config.model_providers.demo.model_catalog_json, undefined);

  const catalog = JSON.parse(await fs.readFile(first.catalogPath, 'utf8'));
  assert.equal(catalog.fetched_at, 'now');
  assert.deepEqual(catalog.models.map((item) => item.slug), ['gpt-5.4', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  const sol = catalog.models.find((item) => item.slug === 'gpt-5.6-sol');
  assert.equal(sol.custom_field, 'preserved-template-field');
  assert.equal(sol.visibility, 'list');
  assert.equal(sol.supported_in_api, true);

  const second = await syncCodexModelCatalog({ codexHome, providerKey: 'demo/provider', models: ['gpt-5.6-sol'] });
  assert.equal(second.addedCount, 0);
  assert.equal(second.totalCount, 4);
  assert.ok((await fs.readdir(second.backupPath)).includes('config.toml'));
  assert.ok((await fs.readdir(second.backupPath)).includes('model-catalog.demo-provider.json'));
});

test('syncCodexModelCatalog generates a valid catalog without models cache', async (t) => {
  const { root, codexHome } = await createCodexHome();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await syncCodexModelCatalog({ codexHome, providerKey: 'fresh', models: ['gpt-5.6-sol'] });
  const catalog = JSON.parse(await fs.readFile(result.catalogPath, 'utf8'));
  assert.equal(catalog.models[0].slug, 'gpt-5.6-sol');
  assert.equal(catalog.models[0].context_window, 272000);
  assert.deepEqual(catalog.models[0].input_modalities, ['text', 'image']);
});

test('inspectCodexModelCatalog reports configured catalog path and model count', async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.homedir(), '.codex-model-catalog-status-'));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  await syncCodexModelCatalog({ codexHome, providerKey: 'demo', models: ['gpt-5.6-sol'] });
  const status = await inspectCodexModelCatalog({ codexHome });
  assert.equal(status.configured, true);
  assert.equal(status.exists, true);
  assert.equal(status.totalCount, 1);
  assert.match(status.catalogPath, /model-catalog\.demo\.json$/);
});

test('model catalog content can be read, validated, saved, and backed up', async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.homedir(), '.codex-model-catalog-edit-'));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  await syncCodexModelCatalog({ codexHome, providerKey: 'demo', models: ['gpt-5.6-sol'] });
  const before = await readCodexModelCatalog({ codexHome });
  const catalog = JSON.parse(before.content);
  catalog.models.push({ slug: 'custom-model' });
  const saved = await saveCodexModelCatalog({ codexHome, content: JSON.stringify(catalog) });
  assert.equal(saved.totalCount, 2);
  assert.ok(saved.backupPath);
  const after = await readCodexModelCatalog({ codexHome });
  assert.equal(JSON.parse(after.content).models[1].slug, 'custom-model');
  await assert.rejects(() => saveCodexModelCatalog({ codexHome, content: '{bad' }), /JSON 格式错误/);
});
