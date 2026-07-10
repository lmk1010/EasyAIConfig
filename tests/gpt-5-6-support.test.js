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
  for (const model of models) {
    const escaped = model.replaceAll('.', '\\.');
    assert.match(appJs, new RegExp(`'${escaped}':\\s+\\{ provider: 'openai',\\s+input: 5\\.00,\\s+output: 30\\.00,\\s+cached: 0\\.50`));
    assert.match(appJs, new RegExp(`'${escaped}': 272000`));
  }
});

test('Codex reasoning selectors accept GPT-5.6 max and ultra levels', () => {
  assert.match(appJs, /CODEX_REASONING_EFFORT_VALUES[^\n]+['"]max['"][^\n]+['"]ultra['"]/);
  assert.match(indexHtml, /option value="max">max \(GPT-5\.6\)/);
  assert.match(indexHtml, /option value="ultra">ultra \(5\.6 Sol\/Terra\)/);
  assert.match(terminalPageJs, /value: 'max', label: 'max · 最大推理 \(GPT-5\.6\)'/);
  assert.match(terminalPageJs, /value: 'ultra', label: 'ultra · 自动任务委派 \(5\.6 Sol\/Terra\)'/);
});
