// 多 OAuth 账号 profile 端到端测试
//
// 钉死场景：
//   1. create / list / rename / delete CRUD 正常
//   2. saveCurrent 把 ~/.codex/auth.json 复制到 profile dir，并写 profiles.json
//   3. saveCurrent 同一账号再调一次 → 复用现有 id（不重复创建）
//   4. switch 把 profile auth.json 复制回 ~/.codex/auth.json，并清掉 .env 残留
//   5. switch + 之前 default 已有别的 token → 落 _switch_backups（不丢账号）
//   6. 路径注入防御：id 含 .. / / \ → throw
//
// 全程用 CODEX_CONFIG_UI_HOME + CODEX_CONFIG_UI_FAKE_HOME 把 home 重定到 tmpdir。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 构造一个看起来像真实 OAuth 的 id_token JWT（不验签，只解 payload）
function makeIdToken({ email = 'a@b.com', plan = 'pro', accountId = 'acc_123', sub = 'sub_x' } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub, email,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: plan,
      chatgpt_account_id: accountId,
    },
  })).toString('base64url');
  return `${header}.${payload}.`;
}

function makeAuthJson(opts = {}) {
  return JSON.stringify({
    tokens: {
      access_token: 'access_token_xxx',
      id_token: makeIdToken(opts),
      account_id: opts.accountId || '',
    },
  });
}

let TMP_HOME;
let TMP_APP_HOME;
let mod;

before(async () => {
  TMP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'eac-fake-home-'));
  TMP_APP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'eac-app-home-'));
  process.env.CODEX_CONFIG_UI_HOME = TMP_APP_HOME;
  process.env.CODEX_CONFIG_UI_FAKE_HOME = TMP_HOME;
  delete process.env.CODEX_HOME;
  // 现在 require，确保 env override 已设
  mod = await import('../src/lib/codex-oauth-profiles.js');
});

after(async () => {
  delete process.env.CODEX_CONFIG_UI_HOME;
  delete process.env.CODEX_CONFIG_UI_FAKE_HOME;
  try { await fs.rm(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
  try { await fs.rm(TMP_APP_HOME, { recursive: true, force: true }); } catch (_) {}
});

async function writeDefaultAuth(json) {
  const home = path.join(TMP_HOME, '.codex');
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'auth.json'), json, 'utf8');
}

test('create + list + rename + delete CRUD', async () => {
  const { createOauthProfile, listOauthProfiles, renameOauthProfile, deleteOauthProfile } = mod;
  const created = await createOauthProfile({ name: '工作号' });
  assert.match(created.id, /^prof_[0-9a-f]+$/);
  assert.equal(created.name, '工作号');

  const listed = await listOauthProfiles({});
  assert.equal(listed.profiles.length, 1);
  assert.equal(listed.profiles[0].name, '工作号');
  assert.equal(listed.profiles[0].hasTokens, false);

  await renameOauthProfile({ id: created.id, name: '个人号' });
  const listed2 = await listOauthProfiles({});
  assert.equal(listed2.profiles[0].name, '个人号');

  await deleteOauthProfile({ id: created.id });
  const listed3 = await listOauthProfiles({});
  assert.equal(listed3.profiles.length, 0);
});

test('saveCurrent extracts email/plan/accountId from JWT', async () => {
  const { saveCurrentOauthProfile, listOauthProfiles } = mod;
  await writeDefaultAuth(makeAuthJson({ email: 'me@ex.com', plan: 'pro', accountId: 'acc_A' }));

  const saved = await saveCurrentOauthProfile({ name: '' });
  assert.match(saved.id, /^prof_/);
  assert.equal(saved.updated, false);

  const listed = await listOauthProfiles({});
  assert.equal(listed.profiles.length, 1);
  const p = listed.profiles[0];
  assert.equal(p.email, 'me@ex.com');
  assert.equal(p.plan, 'pro');
  assert.equal(p.accountId, 'acc_A');
  assert.equal(p.hasTokens, true);
  // 默认 name 用 email
  assert.equal(p.name, 'me@ex.com');

  // 再调一次 → 同一账号 id 不该重复
  const saved2 = await saveCurrentOauthProfile({ name: '' });
  assert.equal(saved2.id, saved.id);
  assert.equal(saved2.updated, true);
  const listed2 = await listOauthProfiles({});
  assert.equal(listed2.profiles.length, 1);
});

test('switch copies profile auth.json into default ~/.codex/auth.json', async () => {
  const { saveCurrentOauthProfile, switchOauthProfile, listOauthProfiles, deleteOauthProfile } = mod;

  // 准备 profile A
  await writeDefaultAuth(makeAuthJson({ email: 'a@x.com', accountId: 'acc_A' }));
  const a = await saveCurrentOauthProfile({ name: 'A 号' });
  // 准备 profile B（覆盖 default auth → 创建第二个账号）
  await writeDefaultAuth(makeAuthJson({ email: 'b@x.com', accountId: 'acc_B' }));
  const b = await saveCurrentOauthProfile({ name: 'B 号' });

  // 切回 A
  const switchedHome = await switchOauthProfile({ id: a.id });
  assert.equal(switchedHome.id, a.id);
  // ~/.codex/auth.json 应该是 A 的内容（account_id 在 tokens 顶层，明文可比对）
  const defaultAuth = await fs.readFile(path.join(TMP_HOME, '.codex', 'auth.json'), 'utf8');
  assert.match(defaultAuth, /"account_id":"acc_A"/);

  // 切回 B
  await switchOauthProfile({ id: b.id });
  const defaultAuth2 = await fs.readFile(path.join(TMP_HOME, '.codex', 'auth.json'), 'utf8');
  assert.match(defaultAuth2, /"account_id":"acc_B"/);

  // active 指针应该指到 b
  const listed = await listOauthProfiles({});
  assert.equal(listed.active, b.id);

  // _switch_backups 应该至少有一份历史 auth
  const backups = await fs.readdir(path.join(TMP_APP_HOME, 'codex-oauth-profiles', '_switch_backups')).catch(() => []);
  assert.ok(backups.length >= 1, `expected switch backups, got ${backups.length}`);

  // cleanup
  await deleteOauthProfile({ id: a.id });
  await deleteOauthProfile({ id: b.id });
});

test('switch clears stale OPENAI_API_KEY from profile/.env', async () => {
  const { saveCurrentOauthProfile, switchOauthProfile, deleteOauthProfile } = mod;
  await writeDefaultAuth(makeAuthJson({ email: 'c@x.com', accountId: 'acc_C' }));
  const c = await saveCurrentOauthProfile({ name: '' });

  // 在 profile dir 里塞个 .env 有 OPENAI_API_KEY
  const profileDir = path.join(TMP_APP_HOME, 'codex-oauth-profiles', c.id);
  await fs.writeFile(path.join(profileDir, '.env'), 'OPENAI_API_KEY=sk-stale\nNOT_TO_DELETE=keep\n');

  await switchOauthProfile({ id: c.id });
  const envAfter = await fs.readFile(path.join(profileDir, '.env'), 'utf8');
  assert.doesNotMatch(envAfter, /OPENAI_API_KEY/);
  assert.match(envAfter, /NOT_TO_DELETE=keep/);

  await deleteOauthProfile({ id: c.id });
});

test('safeProfileId rejects path traversal in id', async () => {
  const { renameOauthProfile, deleteOauthProfile, switchOauthProfile } = mod;
  await assert.rejects(() => renameOauthProfile({ id: '../../etc', name: 'x' }), /非法/);
  await assert.rejects(() => deleteOauthProfile({ id: '..' }), /非法/);
  await assert.rejects(() => switchOauthProfile({ id: '/etc/passwd' }), /非法/);
});

test('saveCurrent rejects empty auth.json', async () => {
  const { saveCurrentOauthProfile } = mod;
  // 把 ~/.codex/auth.json 清掉
  await fs.rm(path.join(TMP_HOME, '.codex', 'auth.json'), { force: true });
  await assert.rejects(() => saveCurrentOauthProfile({ name: '' }), /auth\.json/);
});
