import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const terminalPageJs = readFileSync(new URL('../public/terminal-page.js', import.meta.url), 'utf8');
const configStoreJs = readFileSync(new URL('../src/lib/config-store.js', import.meta.url), 'utf8');

test('Claude 5 family is available across model selectors', () => {
  for (const model of ['claude-fable-5', 'claude-mythos-5', 'claude-sonnet-5']) {
    assert.match(appJs, new RegExp(model));
    assert.match(terminalPageJs, new RegExp(model));
  }
  assert.match(appJs, /defaultModel: 'anthropic\/claude-sonnet-5'/);
  assert.match(appJs, /'sonnet': 'anthropic\/claude-sonnet-5'/);
});

test('Claude 5 official prices and Sonnet launch-price transition are registered', () => {
  assert.match(appJs, /'claude-fable-5':\s+\{ provider: 'anthropic', input: 10\.00, output: 50\.00, cached: 1\.00,\s+cacheWrite: 12\.50/);
  assert.match(appJs, /'claude-mythos-5':\s+\{ provider: 'anthropic', input: 10\.00, output: 50\.00, cached: 1\.00,\s+cacheWrite: 12\.50/);
  assert.match(appJs, /'claude-sonnet-5':\s+\{ provider: 'anthropic', input: 2\.00,\s+output: 10\.00, cached: 0\.20,\s+cacheWrite: 2\.50,\s+standardAfter: '2026-09-01', standardInput: 3\.00, standardOutput: 15\.00, standardCached: 0\.30, standardCacheWrite: 3\.75/);
  assert.match(appJs, /Date\.now\(\) < Date\.parse\(`\$\{pricing\.standardAfter\}T00:00:00Z`\)/);
});

test('Claude local usage backend uses the same Claude 5 prices', () => {
  assert.match(configStoreJs, /'claude-fable-5':\s+\{ input: 10, output: 50, cacheRead: 1, cacheCreate: 12\.5 \}/);
  assert.match(configStoreJs, /'claude-mythos-5':\s+\{ input: 10, output: 50, cacheRead: 1, cacheCreate: 12\.5 \}/);
  assert.match(configStoreJs, /'claude-sonnet-5': Date\.now\(\) < Date\.parse\('2026-09-01T00:00:00Z'\)/);
  assert.match(configStoreJs, /if \(m\.includes\('fable-5'\)\) return PRICING\['claude-fable-5'\]/);
  assert.match(configStoreJs, /if \(m\.includes\('sonnet-5'\)\) return PRICING\['claude-sonnet-5'\]/);
  assert.match(configStoreJs, /'claude-opus-4-6':\s+\{ input: 5, output: 25, cacheRead: 0\.5, cacheCreate: 6\.25 \}/);
});
