import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
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
  assert.match(appJs, /appText\('缓存创建'\)/);
  assert.match(appJs, /appText\('缓存读取'\)/);
  assert.match(appJs, /sum\.cacheCreation \+= Number\(totals\.cacheCreation \|\| 0\)/);
});

test('Provider model support can synchronize a custom Codex model catalog', () => {
  assert.match(appJs, /data-pd-models-sync-codex/);
  assert.match(appJs, /\/api\/codex\/model-catalog\/sync/);
  assert.match(appJs, /重启 Codex 后生效/);
});

test('Codex reasoning selectors accept GPT-5.6 max and ultra levels', () => {
  assert.match(appJs, /CODEX_REASONING_EFFORT_VALUES[^\n]+['"]max['"][^\n]+['"]ultra['"]/);
  assert.match(indexHtml, /option value="max">max \(GPT-5\.6\)/);
  assert.match(indexHtml, /option value="ultra">ultra \(5\.6 Sol\/Terra\)/);
  assert.match(terminalPageJs, /value: 'max', label: 'max · 最大推理 \(GPT-5\.6\)'/);
  assert.match(terminalPageJs, /value: 'ultra', label: 'ultra · 自动任务委派 \(5\.6 Sol\/Terra\)'/);
});

test('Codex cost tables expose request counts without treating sessions as requests', () => {
  assert.match(appJs, /appText\('请求次数'\)/);
  assert.match(appJs, /entry\.requests \?\? entry\.totals\?\.requests/);
  assert.doesNotMatch(appJs, /totals\.requests \+= Math\.max\(1, metric\(s, 'requests'\)\)/);
  assert.match(appJs, /请求次数不可用/);
});

test('Codex dashboard totals use the same model aggregate as billing details', () => {
  assert.match(appJs, /const codexTotal = codexModelTotal \|\| codexFallbackTotals\.total/);
  assert.match(appJs, /codexModels\.reduce\(\(sum, entry\) => sum \+ Number\(calcModelCost\(entry\)\?\.totalCost \|\| 0\), 0\)/);
  assert.doesNotMatch(appJs, /const codexTotal = codexDaily\.reduce/);
});

test('Dashboard billing rows do not use a blue total-row background or accent bar', () => {
  assert.match(stylesCss, /\.db3-price-row:not\(\.db3-price-row--head\)[\s\S]*?background: transparent !important/);
  assert.match(stylesCss, /\.db3-price-row--total::before[\s\S]*?content: none !important/);
});
