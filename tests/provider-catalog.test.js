import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import TOML from '@iarna/toml';
import {
  buildAssetImportDeepLink,
  extractProviderImportItems,
  exportAssetBundle,
  exportProviderCatalog,
  getProviderPreset,
  listProviderPresets,
  previewAssetImport,
  providerCatalogSummary,
} from '../src/lib/provider-catalog.js';
import {
  applyProviderCatalogImport,
} from '../src/lib/config-store.js';

test('provider catalog has at least 50 unique presets', () => {
  const presets = listProviderPresets();
  const ids = new Set(presets.map((item) => item.id));
  assert.ok(presets.length >= 50, `expected at least 50 presets, got ${presets.length}`);
  assert.equal(ids.size, presets.length);
});

test('provider catalog filters by tool, region, and protocol', () => {
  const cnCodex = listProviderPresets({ tool: 'codex', region: 'cn' });
  assert.ok(cnCodex.length >= 10);
  assert.ok(cnCodex.every((item) => item.tools.includes('codex')));
  assert.ok(cnCodex.every((item) => item.region === 'cn'));

  const responses = listProviderPresets({ protocol: 'responses' });
  assert.ok(responses.some((item) => item.id === 'openai'));
  assert.ok(responses.every((item) => item.protocols.includes('responses')));
});

test('provider catalog exposes summary and single preset lookup', () => {
  const summary = providerCatalogSummary();
  const expectedTools = ['codex', 'claudecode', 'claude-desktop', 'gemini', 'opencode', 'openclaw', 'hermes'];
  assert.ok(summary.count >= 50);
  for (const tool of expectedTools) {
    assert.ok(summary.tools[tool] > 0, `expected ${tool} presets in summary`);
    assert.ok(listProviderPresets({ tool }).length > 0, `expected ${tool} preset lookup results`);
  }
  assert.ok(summary.protocols['openai-chat'] > 0);

  const deepseek = getProviderPreset('deepseek');
  assert.equal(deepseek.name, 'DeepSeek');
  assert.ok(deepseek.baseUrls.includes('https://api.deepseek.com/v1'));
  assert.equal(getProviderPreset('missing-provider'), null);
});

test('provider catalog export preserves schema and filters', () => {
  const exported = exportProviderCatalog({ tool: 'claudecode' });
  assert.equal(exported.schema, 'easyaiconfig.provider-catalog.v1');
  assert.ok(exported.presets.length > 0);
  assert.ok(exported.presets.every((item) => item.tools.includes('claudecode')));
});

test('asset bundle export includes provider catalog', () => {
  const bundle = exportAssetBundle();
  assert.equal(bundle.schema, 'easyaiconfig.asset-bundle.v1');
  assert.ok(bundle.assets.providerCatalog.presets.length >= 50);
});

test('asset import preview accepts raw payload and Deep Link payload', () => {
  const payload = {
    schema: 'easyaiconfig.asset-bundle.v1',
    assets: {
      providers: [{ id: 'demo' }],
      mcpServers: { fs: { command: 'npx' } },
      prompts: [{ id: 'p1' }],
      skills: [{ id: 's1' }],
      sessions: [{ id: 'session-1' }],
    },
  };

  const preview = previewAssetImport({ payload });
  assert.deepEqual(preview.counts, {
    providers: 1,
    mcpServers: 1,
    prompts: 1,
    skills: 1,
    sessions: 1,
  });

  const link = buildAssetImportDeepLink(payload);
  const fromLink = previewAssetImport({ url: link });
  assert.equal(fromLink.counts.providers, 1);
  assert.equal(fromLink.schema, 'easyaiconfig.asset-bundle.v1');

  const ccswitchLink = link.replace('easyai://', 'ccswitch://');
  const fromCcSwitchLink = previewAssetImport({ url: ccswitchLink });
  assert.equal(fromCcSwitchLink.counts.mcpServers, 1);
});

test('cc-switch V1 query Deep Links normalize providers, MCP, prompts, and skills', () => {
  const link = (params) => `ccswitch://v1/import?${new URLSearchParams(params).toString()}`;
  const providerUrl = link({
    resource: 'provider',
    id: 'openrouter-custom',
    name: 'OpenRouter Custom',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    apiKey: 'sk-from-deeplink',
    wireApi: 'chat',
    protocols: 'openai-chat,responses',
    homepage: 'https://openrouter.ai',
    model: 'openai/gpt-5',
    models: 'openai/gpt-5,anthropic/claude-sonnet-4',
    config: JSON.stringify({ retry: 2 }),
    configFormat: 'json',
    configUrl: 'https://example.com/openrouter.json',
    usageScript: 'openrouter-usage.js',
    tools: 'codex,opencode',
  });

  const providerPreview = previewAssetImport({ url: providerUrl });
  assert.equal(providerPreview.schema, 'easyaiconfig.asset-bundle.v1');
  assert.equal(providerPreview.app, 'cc-switch');
  assert.equal(providerPreview.payload.source, 'ccswitch-deeplink-v1');
  assert.equal(providerPreview.counts.providers, 1);
  assert.equal(providerPreview.counts.mcpServers, 0);

  const extractedProvider = extractProviderImportItems({ url: providerUrl }).providers[0];
  assert.equal(extractedProvider.key, 'openrouter-custom');
  assert.equal(extractedProvider.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(extractedProvider.envKey, 'OPENROUTER_API_KEY');
  assert.equal(extractedProvider.wireApi, 'chat');
  assert.deepEqual(extractedProvider.tools, ['codex', 'opencode']);
  assert.equal(providerPreview.payload.assets.providers[0].homepage, 'https://openrouter.ai');
  assert.equal(providerPreview.payload.assets.providers[0].apiKey, 'sk-from-deeplink');
  assert.equal(providerPreview.payload.assets.providers[0].model, 'openai/gpt-5');
  assert.deepEqual(providerPreview.payload.assets.providers[0].models, ['openai/gpt-5', 'anthropic/claude-sonnet-4']);
  assert.equal(providerPreview.payload.assets.providers[0].config.retry, 2);
  assert.equal(providerPreview.payload.assets.providers[0].configFormat, 'json');
  assert.equal(providerPreview.payload.assets.providers[0].configUrl, 'https://example.com/openrouter.json');
  assert.equal(providerPreview.payload.assets.providers[0].usageScript, 'openrouter-usage.js');

  const mcpPreview = previewAssetImport({
    url: link({
      resource: 'mcp',
      id: 'filesystem',
      command: 'npx',
      args: JSON.stringify(['-y', '@modelcontextprotocol/server-filesystem']),
      env: JSON.stringify({ ROOT_DIR: '/tmp/project' }),
      apps: 'codex,claude-desktop',
      config: JSON.stringify({ roots: ['/tmp/project'] }),
      enabled: 'false',
      tools: 'codex,claudecode',
    }),
  });
  assert.equal(mcpPreview.counts.mcpServers, 1);
  assert.equal(mcpPreview.payload.assets.mcpServers[0].args[1], '@modelcontextprotocol/server-filesystem');
  assert.equal(mcpPreview.payload.assets.mcpServers[0].env.ROOT_DIR, '/tmp/project');
  assert.deepEqual(mcpPreview.payload.assets.mcpServers[0].apps, ['codex', 'claude-desktop']);
  assert.deepEqual(mcpPreview.payload.assets.mcpServers[0].config.roots, ['/tmp/project']);
  assert.equal(mcpPreview.payload.assets.mcpServers[0].enabled, false);

  const promptPreview = previewAssetImport({
    url: link({
      resource: 'prompt',
      tool: 'codex',
      fileName: 'AGENTS.md',
      scope: 'project',
      description: 'Project agent rules',
      enabled: 'true',
      content: '# Agents\nUse repo rules.',
    }),
  });
  assert.equal(promptPreview.counts.prompts, 1);
  assert.equal(promptPreview.payload.assets.prompts[0].fileName, 'AGENTS.md');
  assert.equal(promptPreview.payload.assets.prompts[0].description, 'Project agent rules');
  assert.equal(promptPreview.payload.assets.prompts[0].enabled, true);

  const skillPreview = previewAssetImport({
    url: link({
      resource: 'skill',
      name: 'reviewer',
      skillMd: '# Reviewer\nReview code changes.',
      repo: 'https://github.com/example/agent-skills',
      directory: 'reviewer',
      branch: 'main',
      installMode: 'copy',
      tools: 'codex',
    }),
  });
  assert.equal(skillPreview.counts.skills, 1);
  assert.equal(skillPreview.payload.assets.skills[0].skillMd, '# Reviewer\nReview code changes.');
  assert.equal(skillPreview.payload.assets.skills[0].repositoryUrl, 'https://github.com/example/agent-skills');
  assert.equal(skillPreview.payload.assets.skills[0].directory, 'reviewer');
  assert.equal(skillPreview.payload.assets.skills[0].branch, 'main');
});

test('asset import extracts explicit providers without applying full catalog by default', () => {
  const bundle = exportAssetBundle();
  assert.equal(extractProviderImportItems({ payload: bundle }).providers.length, 0);
  assert.ok(extractProviderImportItems({ payload: bundle }, { includeCatalogPresets: true }).providers.length >= 50);

  const explicit = extractProviderImportItems({
    payload: {
      schema: 'easyaiconfig.asset-bundle.v1',
      assets: {
        providers: [
          { id: 'deepseek', name: 'DeepSeek', baseUrls: ['https://api.deepseek.com/v1'], envKey: 'DEEPSEEK_API_KEY', protocols: ['openai-chat'], tools: ['codex'] },
          { id: 'anthropic', name: 'Anthropic', baseUrls: ['https://api.anthropic.com'], envKey: 'ANTHROPIC_API_KEY', protocols: ['anthropic'], tools: ['claudecode'] },
        ],
      },
    },
  });
  assert.deepEqual(explicit.providers.map((item) => item.key), ['deepseek']);
  assert.equal(explicit.providers[0].wireApi, 'chat');
});

test('provider catalog import applies explicit providers with dry-run and conflict protection', async (t) => {
  const tempRoot = path.resolve('.tmp-tests');
  await fs.mkdir(tempRoot, { recursive: true });
  const codexHome = await fs.mkdtemp(path.join(tempRoot, 'easyaiconfig-provider-import-'));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  await fs.writeFile(path.join(codexHome, 'config.toml'), `
[model_providers.deepseek]
name = "Old DeepSeek"
base_url = "https://old.example.com/v1"
env_key = "OLD_DEEPSEEK_KEY"
wire_api = "chat"
`);

  const payload = {
    schema: 'easyaiconfig.asset-bundle.v1',
    assets: {
      providers: [
        { id: 'deepseek', name: 'DeepSeek', baseUrls: ['https://api.deepseek.com/v1'], envKey: 'DEEPSEEK_API_KEY', protocols: ['openai-chat'], tools: ['codex'] },
        { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', protocols: ['openai-chat'], tools: ['codex'] },
      ],
    },
  };

  const dryRun = await applyProviderCatalogImport({ payload, codexHome });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.summary.created, 1);
  assert.equal(dryRun.summary.conflicts, 1);
  assert.equal(dryRun.summary.written, false);
  let config = TOML.parse(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'));
  assert.equal(config.model_providers.openrouter, undefined);

  const applied = await applyProviderCatalogImport({ payload, codexHome, dryRun: false });
  assert.equal(applied.summary.created, 1);
  assert.equal(applied.summary.conflicts, 1);
  assert.equal(applied.summary.written, true);
  assert.ok(applied.backupPath);
  config = TOML.parse(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'));
  assert.equal(config.model_provider, undefined);
  assert.equal(config.model_providers.deepseek.base_url, 'https://old.example.com/v1');
  assert.equal(config.model_providers.openrouter.base_url, 'https://openrouter.ai/api/v1');
  assert.equal(config.model_providers.openrouter.env_key, 'OPENROUTER_API_KEY');
  assert.equal(config.model_providers.openrouter.wire_api, 'chat');

  const overwritten = await applyProviderCatalogImport({ payload, codexHome, dryRun: false, overwrite: true });
  assert.equal(overwritten.summary.updated, 2);
  config = TOML.parse(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'));
  assert.equal(config.model_providers.deepseek.base_url, 'https://api.deepseek.com/v1');
  assert.equal(config.model_providers.deepseek.env_key, 'DEEPSEEK_API_KEY');
});
