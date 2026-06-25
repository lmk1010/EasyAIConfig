// Per-provider proxy regression suite
//
// 给 provider 配 proxyUrl → spawn Codex/Claude 时自动注入 HTTPS_PROXY 等
// 4 个代理变量。典型用例：公司内网走代理 A，国外接 B 模型走代理 B，互不干扰。
//
// 覆盖：
//   1. buildPosixEnvPrefix 输出 `export KEY=value; ` 拼接正确
//   2. 空 / null proxyUrl 不产生任何 env prefix
//   3. 特殊字符通过 quotePosixShellArg 转义
//   4. setProviderExtras patch 语义：null 删 key、空 string 删 proxyUrl

import { test } from 'node:test';
import assert from 'node:assert/strict';

// 复刻 buildPosixEnvPrefix 逻辑用于纯单元测试（不依赖文件系统）
function quotePosixShellArg(value = '') {
  const s = String(value);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildPosixEnvPrefix(extraEnv = {}) {
  const entries = Object.entries(extraEnv || {}).filter(([_, v]) => v != null && v !== '');
  if (!entries.length) return '';
  const exports = entries
    .map(([k, v]) => `${k}=${quotePosixShellArg(String(v))}`)
    .join(' ');
  return `export ${exports}; `;
}

test('buildPosixEnvPrefix produces empty string for no env', () => {
  assert.equal(buildPosixEnvPrefix({}), '');
  assert.equal(buildPosixEnvPrefix(null), '');
  assert.equal(buildPosixEnvPrefix(undefined), '');
});

test('buildPosixEnvPrefix builds export prefix for HTTPS_PROXY', () => {
  const out = buildPosixEnvPrefix({ HTTPS_PROXY: 'http://corp.proxy:8080' });
  assert.match(out, /^export HTTPS_PROXY=http:\/\/corp\.proxy:8080; $/);
});

test('buildPosixEnvPrefix handles spaces / special chars by quoting', () => {
  const out = buildPosixEnvPrefix({
    HTTPS_PROXY: 'http://user:p@ss w0rd@proxy:8080',
  });
  // 含特殊字符 → quote
  assert.ok(out.includes("'http://user:p@ss w0rd@proxy:8080'"), out);
});

test('buildPosixEnvPrefix omits null / empty entries', () => {
  const out = buildPosixEnvPrefix({
    HTTPS_PROXY: 'http://x',
    HTTP_PROXY: '',
    https_proxy: null,
    http_proxy: undefined,
  });
  // 仅 HTTPS_PROXY 应被导出
  assert.equal(out, 'export HTTPS_PROXY=http://x; ');
});

test('buildPosixEnvPrefix 4 vars all set produces a single export with 4 KV', () => {
  const out = buildPosixEnvPrefix({
    HTTPS_PROXY: 'http://p:8080',
    HTTP_PROXY: 'http://p:8080',
    https_proxy: 'http://p:8080',
    http_proxy: 'http://p:8080',
  });
  // 都应在同一个 export 里
  assert.match(out, /^export /);
  assert.match(out, /HTTPS_PROXY=http:\/\/p:8080/);
  assert.match(out, /http_proxy=http:\/\/p:8080/);
  assert.ok(out.endsWith('; '));
});

// ─── extras 存储语义 ──────────────────────────────────────────────────
test('setProviderExtras patch semantics: null deletes key, "" deletes proxyUrl', async () => {
  // 这部分依赖文件系统，模拟一下纯函数版的 patch 逻辑
  // (实际 setProviderExtras 在 config-store.js)
  function applyExtrasPatch(existing, patch) {
    const next = { ...existing };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) { delete next[k]; continue; }
      if (v === undefined) continue;
      if (k === 'proxyUrl') {
        const trimmed = String(v).trim();
        if (!trimmed) { delete next.proxyUrl; continue; }
        next.proxyUrl = trimmed;
        continue;
      }
      next[k] = v;
    }
    return next;
  }

  // 初始空 → 设 proxy
  let extras = applyExtrasPatch({}, { proxyUrl: 'http://x:8080', notes: 'work' });
  assert.deepEqual(extras, { proxyUrl: 'http://x:8080', notes: 'work' });

  // 设空字符串 → 删
  extras = applyExtrasPatch(extras, { proxyUrl: '' });
  assert.deepEqual(extras, { notes: 'work' });

  // null 删任意 key
  extras = applyExtrasPatch(extras, { notes: null });
  assert.deepEqual(extras, {});

  // undefined 不动 key
  extras = applyExtrasPatch({ proxyUrl: 'http://x' }, { proxyUrl: undefined });
  assert.deepEqual(extras, { proxyUrl: 'http://x' });
});
