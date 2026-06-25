// Per-project Provider 绑定测试
//
// 钉死场景：
//   1. set / get / remove CRUD
//   2. 深度匹配：父目录绑定能兜底子目录
//   3. 子目录 override 父目录
//   4. 多 tool 不互相干扰
//   5. 删除单个 tool 不删整个 cwd entry，但删最后一个 tool 应删除空 entry
//   6. 路径必须绝对 + 工具名白名单
//
// 修复 cc-switch [#1106] / [#4558]「per-project provider 绑定」零回复痛点。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let TMP_APP_HOME;
let mod;

before(async () => {
  TMP_APP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'eac-pb-app-home-'));
  process.env.CODEX_CONFIG_UI_HOME = TMP_APP_HOME;
  mod = await import('../src/lib/project-bindings.js');
});

after(async () => {
  delete process.env.CODEX_CONFIG_UI_HOME;
  try { await fs.rm(TMP_APP_HOME, { recursive: true, force: true }); } catch (_) {}
});

test('set + get codex binding for an absolute path', async () => {
  const { setProjectBinding, getProjectBinding, removeProjectBinding } = mod;
  await setProjectBinding({ cwd: '/Users/me/work/A', tool: 'codex', providerKey: 'lucoo' });
  const got = await getProjectBinding('/Users/me/work/A', 'codex');
  assert.equal(got.providerKey, 'lucoo');
  assert.equal(got.isExactMatch, true);
  await removeProjectBinding({ cwd: '/Users/me/work/A' });
});

test('parent directory binding falls through to child', async () => {
  const { setProjectBinding, getProjectBinding, removeProjectBinding } = mod;
  await setProjectBinding({ cwd: '/Users/me/work', tool: 'codex', providerKey: 'work-provider' });
  const got = await getProjectBinding('/Users/me/work/sub/project', 'codex');
  assert.equal(got.providerKey, 'work-provider');
  assert.equal(got.matchedDir, '/Users/me/work');
  assert.equal(got.isExactMatch, false);
  await removeProjectBinding({ cwd: '/Users/me/work' });
});

test('child binding overrides parent binding', async () => {
  const { setProjectBinding, getProjectBinding, removeProjectBinding } = mod;
  await setProjectBinding({ cwd: '/Users/me/work', tool: 'codex', providerKey: 'work-default' });
  await setProjectBinding({ cwd: '/Users/me/work/special', tool: 'codex', providerKey: 'special-one' });
  const got = await getProjectBinding('/Users/me/work/special/subdir', 'codex');
  assert.equal(got.providerKey, 'special-one');
  assert.equal(got.matchedDir, '/Users/me/work/special');
  // 父目录其他子目录仍走默认
  const got2 = await getProjectBinding('/Users/me/work/normal', 'codex');
  assert.equal(got2.providerKey, 'work-default');
  await removeProjectBinding({ cwd: '/Users/me/work' });
  await removeProjectBinding({ cwd: '/Users/me/work/special' });
});

test('different tools at same cwd are independent', async () => {
  const { setProjectBinding, getProjectBinding, removeProjectBinding } = mod;
  await setProjectBinding({ cwd: '/Users/me/multi', tool: 'codex', providerKey: 'cdx-A' });
  await setProjectBinding({ cwd: '/Users/me/multi', tool: 'claudecode', providerKey: 'cc-B' });
  assert.equal((await getProjectBinding('/Users/me/multi', 'codex')).providerKey, 'cdx-A');
  assert.equal((await getProjectBinding('/Users/me/multi', 'claudecode')).providerKey, 'cc-B');
  // 删一个 tool 不影响另一个
  await removeProjectBinding({ cwd: '/Users/me/multi', tool: 'codex' });
  assert.equal(await getProjectBinding('/Users/me/multi', 'codex'), null);
  assert.equal((await getProjectBinding('/Users/me/multi', 'claudecode')).providerKey, 'cc-B');
  await removeProjectBinding({ cwd: '/Users/me/multi' });
});

test('removing last tool of an entry deletes the cwd entry', async () => {
  const { setProjectBinding, removeProjectBinding, listProjectBindings } = mod;
  await setProjectBinding({ cwd: '/Users/me/only', tool: 'codex', providerKey: 'x' });
  await removeProjectBinding({ cwd: '/Users/me/only', tool: 'codex' });
  const list = await listProjectBindings();
  const found = list.find((b) => b.cwd === '/Users/me/only');
  assert.equal(found, undefined);
});

test('rejects non-absolute paths', async () => {
  const { setProjectBinding } = mod;
  await assert.rejects(() => setProjectBinding({ cwd: 'relative/path', tool: 'codex', providerKey: 'x' }), /absolute/);
  await assert.rejects(() => setProjectBinding({ cwd: '~/work', tool: 'codex', providerKey: 'x' }), /absolute/);
  await assert.rejects(() => setProjectBinding({ cwd: '', tool: 'codex', providerKey: 'x' }), /absolute/);
});

test('rejects invalid tool names', async () => {
  const { setProjectBinding, getProjectBinding } = mod;
  await assert.rejects(() => setProjectBinding({ cwd: '/x', tool: 'gemini', providerKey: 'y' }), /tool/);
  await assert.rejects(() => getProjectBinding('/x', 'unknown'), /tool/);
});

test('summarizeBindingsForCwd returns all tools for matched dir', async () => {
  const { setProjectBinding, summarizeBindingsForCwd, removeProjectBinding } = mod;
  await setProjectBinding({ cwd: '/Users/me/repo', tool: 'codex', providerKey: 'P1' });
  await setProjectBinding({ cwd: '/Users/me/repo', tool: 'claudecode', providerKey: 'P2' });
  const out = await summarizeBindingsForCwd('/Users/me/repo/src/feature');
  assert.equal(out.matchedDir, '/Users/me/repo');
  assert.equal(out.isExactMatch, false);
  assert.equal(out.tools.codex.providerKey, 'P1');
  assert.equal(out.tools.claudecode.providerKey, 'P2');
  await removeProjectBinding({ cwd: '/Users/me/repo' });
});
