import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { detectProvider } from '../src/lib/provider-check.js';

const servers = new Set();

async function startModelServer(onRequest) {
  const server = http.createServer((req, res) => {
    onRequest(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'grok-4.5' }] }));
  });
  servers.add(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
});

test('Anthropic root Base URL requests /v1/models with x-api-key headers', async () => {
  let observed = null;
  const baseUrl = await startModelServer((req) => {
    observed = { url: req.url, headers: req.headers };
  });

  const result = await detectProvider({
    baseUrl,
    apiKey: 'anthropic-test-key',
    protocol: 'anthropic',
    credentialType: 'api_key',
  });

  assert.equal(observed.url, '/v1/models');
  assert.equal(observed.headers['x-api-key'], 'anthropic-test-key');
  assert.equal(observed.headers['anthropic-version'], '2023-06-01');
  assert.equal(observed.headers.authorization, undefined);
  assert.deepEqual(result.models, ['grok-4.5']);
  assert.equal(result.protocol, 'anthropic');
});

test('Anthropic Base URL ending in /v1 does not duplicate the version segment', async () => {
  const paths = [];
  const baseUrl = await startModelServer((req) => paths.push(req.url));

  await detectProvider({
    baseUrl: `${baseUrl}/v1`,
    apiKey: 'anthropic-test-key',
    protocol: 'anthropic',
  });

  assert.deepEqual(paths, ['/v1/models']);
});

test('Anthropic auth token uses Bearer auth instead of x-api-key', async () => {
  let headers = null;
  const baseUrl = await startModelServer((req) => {
    headers = req.headers;
  });

  await detectProvider({
    baseUrl,
    apiKey: 'anthropic-auth-token',
    protocol: 'anthropic',
    credentialType: 'auth_token',
  });

  assert.equal(headers.authorization, 'Bearer anthropic-auth-token');
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers['anthropic-version'], '2023-06-01');
});

test('OpenAI probing keeps base/models and Bearer authorization behavior', async () => {
  let observed = null;
  const baseUrl = await startModelServer((req) => {
    observed = { url: req.url, headers: req.headers };
  });

  const result = await detectProvider({
    baseUrl: `${baseUrl}/v1`,
    apiKey: 'openai-test-key',
  });

  assert.equal(observed.url, '/v1/models');
  assert.equal(observed.headers.authorization, 'Bearer openai-test-key');
  assert.equal(observed.headers['x-api-key'], undefined);
  assert.equal(observed.headers['anthropic-version'], undefined);
  assert.deepEqual(result.models, ['grok-4.5']);
  assert.equal(result.protocol, 'openai');
});

test('Claude Code UI requests Anthropic models and accepts custom provider model IDs', () => {
  const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const stylesCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const terminalPageJs = readFileSync(new URL('../public/terminal-page.js', import.meta.url), 'utf8');

  assert.match(appJs, /protocol:\s*'anthropic'/);
  assert.match(appJs, /credentialType:\s*provider\.authToken\s*\?\s*'auth_token'\s*:\s*'api_key'/);
  assert.match(appJs, /\['codex', 'claudecode', 'opencode', 'openclaw'\]\.includes\(state\.activeTool\)/);
  assert.match(appJs, /showModelRefreshBtn:\s*true/);
  assert.match(appJs, /function mergeModelsIntoClaudeDropdown/);
  assert.match(appJs, /renderClaudeQuickModelControl\(\{\s*modelValue:\s*currentValue,\s*liveModels:\s*models,\s*mode:\s*'auto'/s);
  assert.match(appJs, /const rawModelValue = fromConfigEditor[\s\S]*:\s*getClaudeQuickModelValue\(\)/);
  assert.match(appJs, /claudeManualModelInput'\)\?\.addEventListener\('input'[\s\S]*setClaudeCanonicalModelValue/);
  assert.match(appJs, /return value === '__custom__' \? '' : value/);
  assert.match(indexHtml, /data-claude-model-mode="auto">自动获取/);
  assert.match(indexHtml, /data-claude-model-mode="preset">内置预设/);
  assert.match(indexHtml, /data-claude-model-mode="manual">手动输入/);
  assert.match(indexHtml, /id="claudeAutoModelSelect"/);
  assert.match(indexHtml, /id="claudePresetModelSelect"/);
  assert.match(indexHtml, /id="claudeManualModelInput"/);
  assert.match(stylesCss, /\.shell-v2 \.claude-model-tabs/);
  assert.match(terminalPageJs, /protocol:\s*'anthropic'/);
  assert.match(terminalPageJs, /providerModels\?\.\[tp\.launcher\.providerKey\][\s\S]{0,80}\.filter\(Boolean\)/);
});
