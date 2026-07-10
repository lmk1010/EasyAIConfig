import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const terminalPageJs = readFileSync(new URL('../public/terminal-page.js', import.meta.url), 'utf8');
const recipesJs = readFileSync(new URL('../public/config-store-recipes-codex.js', import.meta.url), 'utf8');

const models = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

test('GPT-5.6 full family is available across Codex model selectors', () => {
  for (const model of models) {
    assert.match(appJs, new RegExp(model.replaceAll('.', '\\.')));
    assert.match(terminalPageJs, new RegExp(model.replaceAll('.', '\\.')));
    assert.match(recipesJs, new RegExp(model.replaceAll('.', '\\.')));
  }
});

test('GPT-5.6 pricing and context caps are registered', () => {
  const prices = {
    'gpt-5.6-sol': { input: '5\\.00', output: '30\\.00', cached: '0\\.50', cacheWrite: '6\\.25' },
    'gpt-5.6-terra': { input: '2\\.50', output: '15\\.00', cached: '0\\.25', cacheWrite: '3\\.125' },
    'gpt-5.6-luna': { input: '1\\.00', output: '6\\.00', cached: '0\\.10', cacheWrite: '1\\.25' },
  };
  for (const [model, price] of Object.entries(prices)) {
    const escaped = model.replaceAll('.', '\\.');
    assert.match(appJs, new RegExp(`'${escaped}':\\s+\\{ provider: 'openai',\\s+input: ${price.input},\\s+output: ${price.output},\\s+cached: ${price.cached},\\s+cacheWrite: ${price.cacheWrite}`));
    assert.match(appJs, new RegExp(`'${escaped}': 272000`));
  }
  assert.match(appJs, /'gpt-5\.5':\s+\{ provider: 'openai',\s+input: 5\.00,\s+output: 30\.00,\s+cached: 0\.50/);
  assert.match(appJs, /'gpt-5\.4':\s+\{ provider: 'openai',\s+input: 5\.00,\s+output: 22\.50,\s+cached: 0\.50/);
});

test('GPT-5.6 pricing handles Unicode dashes and cache creation charges', () => {
  assert.match(appJs, /replace\(\/\[\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D\]\/g, '-'\)/);
  assert.match(appJs, /const writeRate = Number\.isFinite\(pricing\.cacheWrite\) \? pricing\.cacheWrite : 0;\s+total \+= \(nonCached \* pricing\.input[\s\S]+cacheCreation \* writeRate\) \/ 1e6;/);
  assert.match(appJs, /cacheWriteCost = cacheWrite \* writeRate;/);
  assert.match(appJs, /dayCacheCreation \* writeRate\) \/ 1e6;/);
  assert.match(appJs, /CACHE W \$\{fmt\(p\.cacheWrite\)\} · R \$\{fmt\(p\.cached\)\}/);
});

test('Codex reasoning selectors accept GPT-5.6 max and ultra levels', () => {
  assert.match(appJs, /CODEX_REASONING_EFFORT_VALUES[^\n]+['"]max['"][^\n]+['"]ultra['"]/);
  assert.match(indexHtml, /option value="max">max \(GPT-5\.6\)/);
  assert.match(indexHtml, /option value="ultra">ultra \(5\.6 Sol\/Terra\)/);
  assert.match(terminalPageJs, /value: 'max', label: 'max · 最大推理 \(GPT-5\.6\)'/);
  assert.match(terminalPageJs, /value: 'ultra', label: 'ultra · 自动任务委派 \(5\.6 Sol\/Terra\)'/);
});
