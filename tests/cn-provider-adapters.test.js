// 国产 API 适配器命中测试
//
// 钉死：
//   1. host 必须精确匹配（subdomain 允许，root 域名也允许）
//   2. 命中后 wire_api 一定是 "chat"（核心修复点 vs codex 默认 responses）
//   3. 已设置过 wire_api 的 provider 不会被覆盖（保护用户显式选择）
//   4. 无效 / 非国产 host 返回 null
//   5. 主要国产 vendor 都能识别

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapterForBaseUrl, listAdapters, applyAdapterToProvider } from '../src/lib/cn-provider-adapters.js';

test('listAdapters returns at least 10 Chinese vendors', () => {
  const all = listAdapters();
  assert.ok(all.length >= 10, `expected ≥10, got ${all.length}`);
  assert.ok(all.every((a) => a.slug && a.name && a.wireApi === 'chat'));
});

test('DeepSeek host matches', () => {
  const a = getAdapterForBaseUrl('https://api.deepseek.com/v1');
  assert.equal(a?.slug, 'deepseek');
  assert.equal(a?.wireApi, 'chat');
});

test('硅基流动 host matches', () => {
  const a = getAdapterForBaseUrl('https://api.siliconflow.cn/v1');
  assert.equal(a?.slug, 'siliconflow');
});

test('智谱 GLM host matches', () => {
  const a = getAdapterForBaseUrl('https://open.bigmodel.cn/api/paas/v4');
  assert.equal(a?.slug, 'zhipu');
});

test('Kimi / Moonshot host matches', () => {
  const a = getAdapterForBaseUrl('https://api.moonshot.cn/v1');
  assert.equal(a?.slug, 'moonshot');
});

test('火山方舟 host matches (volces.com)', () => {
  const a = getAdapterForBaseUrl('https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(a?.slug, 'volcengine');
});

test('DashScope 通义 host matches', () => {
  const a = getAdapterForBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(a?.slug, 'qwen');
});

test('OpenAI official host does NOT match (not a Chinese adapter)', () => {
  assert.equal(getAdapterForBaseUrl('https://api.openai.com/v1'), null);
});

test('Anthropic host does NOT match', () => {
  assert.equal(getAdapterForBaseUrl('https://api.anthropic.com/v1'), null);
});

test('Garbage / missing baseUrl returns null', () => {
  assert.equal(getAdapterForBaseUrl(''), null);
  assert.equal(getAdapterForBaseUrl('not-a-url'), null);
  assert.equal(getAdapterForBaseUrl(null), null);
});

test('applyAdapterToProvider sets wire_api when missing', () => {
  const r = applyAdapterToProvider({}, 'https://api.deepseek.com/v1');
  assert.equal(r.applied, true);
  assert.equal(r.providerBlock.wire_api, 'chat');
});

test('applyAdapterToProvider does NOT override existing wire_api', () => {
  const r = applyAdapterToProvider({ wire_api: 'responses' }, 'https://api.deepseek.com/v1');
  // 已显式设过 → 不覆盖（applied=false 表示没动 wire_api）
  assert.equal(r.applied, false);
});

test('applyAdapterToProvider returns null adapter for non-Chinese host', () => {
  const r = applyAdapterToProvider({}, 'https://api.openai.com/v1');
  assert.equal(r.applied, false);
  assert.equal(r.adapter, null);
});
