// Claude Code 多账号 profile 端到端测试
//
// 钉死场景：
//   1. create / list / rename / delete CRUD 正常
//   2. list 读到 profile 下 .claude.json 的 oauthAccount 时正确填 email / org
//   3. switch 60s 节流：连续两次切不同 profile，第二次抛节流错
//   4. activeClaudecodeConfigDir 返回当前 active profile 的 dir
//   5. 路径注入防御

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let TMP_APP_HOME;
let mod;

before(async () => {
  TMP_APP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'eac-cc-app-home-'));
  process.env.CODEX_CONFIG_UI_HOME = TMP_APP_HOME;
  mod = await import('../src/lib/claudecode-oauth-profiles.js');
});

after(async () => {
  delete process.env.CODEX_CONFIG_UI_HOME;
  try { await fs.rm(TMP_APP_HOME, { recursive: true, force: true }); } catch (_) {}
});

test('create + list returns profile with empty meta when not yet logged in', async () => {
  const { createClaudecodeOauthProfile, listClaudecodeOauthProfiles, deleteClaudecodeOauthProfile } = mod;
  const created = await createClaudecodeOauthProfile({ name: 'work' });
  assert.match(created.id, /^prof_/);

  const listed = await listClaudecodeOauthProfiles();
  assert.equal(listed.profiles.length, 1);
  assert.equal(listed.profiles[0].name, 'work');
  assert.equal(listed.profiles[0].hasTokens, false);
  assert.equal(listed.profiles[0].email, '');

  await deleteClaudecodeOauthProfile({ id: created.id, force: true });
  const listed2 = await listClaudecodeOauthProfiles();
  assert.equal(listed2.profiles.length, 0);
});

test('list extracts email / org from profile .claude.json oauthAccount', async () => {
  const { createClaudecodeOauthProfile, listClaudecodeOauthProfiles, deleteClaudecodeOauthProfile } = mod;
  const created = await createClaudecodeOauthProfile({ name: 'has-account' });
  // 模拟 Claude Code 登录写入 oauthAccount
  await fs.writeFile(path.join(created.configDir, '.claude.json'), JSON.stringify({
    oauthAccount: {
      accountUuid: 'acc-uuid-xxx',
      emailAddress: 'team@example.com',
      organizationName: 'My Org',
      organizationRole: 'owner',
      displayName: 'Team',
      billingType: 'pro',
    },
  }), 'utf8');

  const listed = await listClaudecodeOauthProfiles();
  const p = listed.profiles.find((x) => x.id === created.id);
  assert.ok(p);
  assert.equal(p.email, 'team@example.com');
  assert.equal(p.organizationName, 'My Org');
  assert.equal(p.hasTokens, true);

  await deleteClaudecodeOauthProfile({ id: created.id, force: true });
});

test('rename updates name in profiles.json', async () => {
  const { createClaudecodeOauthProfile, renameClaudecodeOauthProfile, listClaudecodeOauthProfiles, deleteClaudecodeOauthProfile } = mod;
  const created = await createClaudecodeOauthProfile({ name: 'old' });
  await renameClaudecodeOauthProfile({ id: created.id, name: 'new' });
  const listed = await listClaudecodeOauthProfiles();
  const p = listed.profiles.find((x) => x.id === created.id);
  assert.equal(p.name, 'new');
  await deleteClaudecodeOauthProfile({ id: created.id, force: true });
});

test('switch updates active pointer + activeClaudecodeConfigDir reflects', async () => {
  const { createClaudecodeOauthProfile, switchClaudecodeOauthProfile, activeClaudecodeConfigDir, deleteClaudecodeOauthProfile } = mod;
  const a = await createClaudecodeOauthProfile({ name: 'A' });
  await switchClaudecodeOauthProfile({ id: a.id, force: true });
  const dir = await activeClaudecodeConfigDir();
  assert.equal(dir, a.configDir);

  // 切回默认（active = ''）
  // 注意：默认 throttle 60s,这里直接修改 lastSwitchAt 跳过 throttle
  const indexPath = path.join(TMP_APP_HOME, 'claudecode-oauth-profiles', 'profiles.json');
  const idx = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  idx.lastSwitchAt = 0;
  await fs.writeFile(indexPath, JSON.stringify(idx));
  await switchClaudecodeOauthProfile({ id: '', force: true });
  const dir2 = await activeClaudecodeConfigDir();
  assert.equal(dir2, null);

  await deleteClaudecodeOauthProfile({ id: a.id, force: true });
});

test('switch throttles within 60s', async () => {
  const { createClaudecodeOauthProfile, switchClaudecodeOauthProfile, deleteClaudecodeOauthProfile } = mod;
  const a = await createClaudecodeOauthProfile({ name: 'A' });
  const b = await createClaudecodeOauthProfile({ name: 'B' });

  // reset lastSwitchAt 确保第一次成功
  const indexPath = path.join(TMP_APP_HOME, 'claudecode-oauth-profiles', 'profiles.json');
  const idx = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  idx.lastSwitchAt = 0;
  await fs.writeFile(indexPath, JSON.stringify(idx));

  await switchClaudecodeOauthProfile({ id: a.id, force: true });
  await assert.rejects(
    () => switchClaudecodeOauthProfile({ id: b.id, force: true }),
    /切换太频繁/
  );

  await deleteClaudecodeOauthProfile({ id: a.id, force: true });
  await deleteClaudecodeOauthProfile({ id: b.id, force: true });
});

test('safeProfileId rejects path traversal', async () => {
  const { switchClaudecodeOauthProfile, deleteClaudecodeOauthProfile, renameClaudecodeOauthProfile } = mod;
  await assert.rejects(() => switchClaudecodeOauthProfile({ id: '../foo', force: true }), /非法/);
  await assert.rejects(() => deleteClaudecodeOauthProfile({ id: '..', force: true }), /非法/);
  await assert.rejects(() => renameClaudecodeOauthProfile({ id: '/etc', name: 'x' }), /非法/);
});
