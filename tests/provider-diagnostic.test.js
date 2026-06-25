// Provider 探测诊断分级测试
//
// 失败时给到红绿灯 + 一段人话提示。这套测试钉死：
//   1. classifyProbeError 把常见 Node fetch / undici 错误码归到正确 stage
//   2. readDiag 兜底能从一个没附 diag 的错误里也能恢复出分类
//   3. stage → hint 文案能覆盖 dns / tls / connect / timeout / unknown

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProbeError, readDiag } from '../src/lib/provider-check.js';

function makeNetErr(code, msg = '') {
  const e = new TypeError('fetch failed');
  e.cause = { code, message: msg };
  return e;
}

test('classifyProbeError → dns when ENOTFOUND', () => {
  const out = classifyProbeError(makeNetErr('ENOTFOUND', 'getaddrinfo ENOTFOUND foo'));
  assert.equal(out.stage, 'dns');
  assert.match(out.hint, /DNS/);
});

test('classifyProbeError → connect when ECONNREFUSED', () => {
  const out = classifyProbeError(makeNetErr('ECONNREFUSED'));
  assert.equal(out.stage, 'connect');
  assert.match(out.hint, /TCP/);
});

test('classifyProbeError → tls when cert error', () => {
  const out = classifyProbeError(makeNetErr('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));
  assert.equal(out.stage, 'tls');
  assert.match(out.hint, /TLS|证书/);
});

test('classifyProbeError → tls when message mentions ssl', () => {
  const e = new Error('socket hang up - SSL handshake failed');
  const out = classifyProbeError(e);
  assert.equal(out.stage, 'tls');
});

test('classifyProbeError → timeout when AbortError', () => {
  const e = new Error('timeout');
  e.name = 'AbortError';
  const out = classifyProbeError(e);
  assert.equal(out.stage, 'timeout');
});

test('classifyProbeError → connect as fetch-failed fallback', () => {
  const e = new TypeError('fetch failed');
  // 没 cause.code 也没具体识别 → 走通用 fetch failed 分支
  const out = classifyProbeError(e);
  assert.equal(out.stage, 'connect');
});

test('readDiag uses error.diag when present', () => {
  const e = new Error('boom');
  e.diag = { stage: 'auth', hint: 'HTTP 401', errorMessage: 'invalid key', latencyMs: 42, statusCode: 401 };
  const out = readDiag(e);
  assert.equal(out.stage, 'auth');
  assert.equal(out.statusCode, 401);
});

test('readDiag falls back to classifier when error has no diag', () => {
  const out = readDiag(makeNetErr('ENOTFOUND'));
  assert.equal(out.stage, 'dns');
  assert.equal(out.latencyMs, null);
});
