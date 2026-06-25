// Codex 多 OAuth 账号 profile 管理（Express / Web 模式）。
//
// 镜像 src-tauri/src/oauth_profiles.rs 的核心 CRUD：list / save_current /
// create / switch / rename / delete。两边读写同一份 ~/.codex-config-ui/
// codex-oauth-profiles/profiles.json + <id>/auth.json，所以 Tauri 用户和 npm
// 用户切到对方环境下也能看到同一组账号。
//
// 痛点对标：cc-switch #1105 「加两个官方 OAuth 账号时第二个会把第一个覆盖」
// 我们的设计：每个账号一份独立 auth.json 在 profile dir 里，切换时整文件复制
// 到 ~/.codex/auth.json，原账号永远不丢。

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const APP_HOME_DIRNAME = '.codex-config-ui';
const PROFILES_DIRNAME = 'codex-oauth-profiles';
const PROFILES_INDEX = 'profiles.json';
const AUTH_FILENAME = 'auth.json';
const SWITCH_BACKUP_KEEP = 5;

// Test seam: 允许 CODEX_CONFIG_UI_HOME 覆写 app home，方便整套 CRUD 在 tmpdir 里跑
function appHome() {
  const override = String(process.env.CODEX_CONFIG_UI_HOME || '').trim();
  if (override) return override;
  return path.join(os.homedir(), APP_HOME_DIRNAME);
}
function profilesRoot() { return path.join(appHome(), PROFILES_DIRNAME); }
function profilesIndexPath() { return path.join(profilesRoot(), PROFILES_INDEX); }
function defaultCodexHome() {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  const fakeHome = String(process.env.CODEX_CONFIG_UI_FAKE_HOME || '').trim();
  if (fakeHome) return path.join(fakeHome, '.codex');
  return path.join(os.homedir(), '.codex');
}

function safeProfileId(id) {
  const trimmed = String(id || '').trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error('非法的 profile id');
  }
  return trimmed;
}
function profileDir(id) { return path.join(profilesRoot(), safeProfileId(id)); }
function profileAuthPath(id) { return path.join(profileDir(id), AUTH_FILENAME); }

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { await fs.chmod(dirPath, 0o700); } catch (_) {}
  }
}
async function readTextSafe(filePath) {
  try { return await fs.readFile(filePath, 'utf8'); } catch { return ''; }
}
async function writeSecret(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try { await fs.chmod(filePath, 0o600); } catch (_) {}
  }
}

// ── env 解析（必须与 config-store.js 行为兼容，因为 codex CLI 看的就是 KEY=VALUE 列表） ──
function parseEnvText(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}
function stringifyEnvObj(obj) {
  return Object.entries(obj || {})
    .map(([k, v]) => `${k}=${String(v ?? '')}`)
    .join('\n') + (Object.keys(obj || {}).length ? '\n' : '');
}

// ── JWT payload 解码（仅展示用，不验签） ──
function decodeJwtPayload(token) {
  const input = String(token || '').trim();
  if (!input.includes('.')) return null;
  try {
    const mid = input.split('.')[1] || '';
    const normalized = mid.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch { return null; }
}

function extractOauthMeta(authJson = {}) {
  const tokens = authJson?.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  if (!tokens || !String(tokens.access_token || '').trim()) {
    return { hasTokens: false, accountId: '', plan: '', email: '', sub: '' };
  }
  let accountId = String(tokens.account_id || '').trim();
  let plan = '';
  let email = '';
  let sub = '';
  const claims = decodeJwtPayload(tokens.id_token || '') || {};
  if (claims && typeof claims === 'object') {
    sub = String(claims.sub || '').trim();
    email = String(claims.email || '').trim();
    const authNs = claims['https://api.openai.com/auth'];
    if (authNs && typeof authNs === 'object') {
      if (!plan) plan = String(authNs.chatgpt_plan_type || '').trim();
      if (!accountId) accountId = String(authNs.chatgpt_account_id || '').trim();
    }
    if (!plan) {
      for (const [k, v] of Object.entries(claims)) {
        if (typeof v !== 'string') continue;
        const lk = k.toLowerCase();
        if (lk.includes('plan') || lk.includes('subscription')) {
          if (String(v).trim()) { plan = String(v).trim(); break; }
        }
      }
    }
  }
  return { hasTokens: true, accountId, plan, email, sub };
}

async function oauthMetaForCodexHome(codexHome) {
  const text = await readTextSafe(path.join(codexHome, AUTH_FILENAME));
  if (!text.trim()) return { hasTokens: false, accountId: '', plan: '', email: '', sub: '' };
  let json;
  try { json = JSON.parse(text); } catch { json = {}; }
  return extractOauthMeta(json);
}

// ── profiles.json 读写 ──
async function readProfilesIndex() {
  const text = await readTextSafe(profilesIndexPath());
  if (!text.trim()) return { version: 1, active: '', profiles: [] };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return { version: 1, active: '', profiles: [] };
    if (!Array.isArray(parsed.profiles)) parsed.profiles = [];
    if (typeof parsed.active !== 'string') parsed.active = '';
    return parsed;
  } catch { return { version: 1, active: '', profiles: [] }; }
}
async function writeProfilesIndex(index) {
  await ensureDir(profilesRoot());
  await writeSecret(profilesIndexPath(), JSON.stringify(index, null, 2));
}

async function refreshProfilesRuntimeMeta(index) {
  let changed = false;
  for (const profile of index.profiles) {
    const id = String(profile?.id || '').trim();
    if (!id) continue;
    const dir = profileDir(id);
    const meta = await oauthMetaForCodexHome(dir);
    const codexHome = dir;
    if (profile.codexHome !== codexHome) { profile.codexHome = codexHome; changed = true; }
    if (profile.hasTokens !== meta.hasTokens) { profile.hasTokens = meta.hasTokens; changed = true; }
    if (meta.hasTokens) {
      for (const k of ['accountId', 'plan', 'email', 'sub']) {
        if (profile[k] !== meta[k]) { profile[k] = meta[k]; changed = true; }
      }
    }
  }
  if (changed) await writeProfilesIndex(index);
  return index.profiles;
}

function detectProfileIdByAccount(index, accountId) {
  if (!accountId) return '';
  for (const p of index.profiles) {
    if (String(p?.accountId || '') === accountId) return String(p?.id || '');
  }
  return '';
}
function detectProfileIdByHome(index, codexHome) {
  for (const p of index.profiles) {
    const id = String(p?.id || '').trim();
    if (!id) continue;
    if (profileDir(id) === codexHome) return id;
  }
  return '';
}

function defaultProfileName(requestedName, meta, id) {
  const trimmed = String(requestedName || '').trim();
  if (trimmed) return trimmed;
  if (meta?.email) return String(meta.email).trim();
  if (meta?.plan) return `OAuth (${String(meta.plan).trim()})`;
  return `Codex 账号 #${id.slice(0, 8)}`;
}

// ── 切换时的安全备份 ──
async function writeSwitchBackup(liveAuthRaw) {
  const dir = path.join(profilesRoot(), '_switch_backups');
  await ensureDir(dir);
  const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15); // YYYYMMDDTHHMMSS
  const filePath = path.join(dir, `auth-${ts}.json`);
  await writeSecret(filePath, liveAuthRaw);
  // 保留最近 5 份
  try {
    const entries = (await fs.readdir(dir)).filter((n) => /^auth-.*\.json$/.test(n)).sort();
    const stale = entries.slice(0, Math.max(0, entries.length - SWITCH_BACKUP_KEEP));
    await Promise.all(stale.map((name) => fs.unlink(path.join(dir, name)).catch(() => {})));
  } catch (_) { /* swallow */ }
  return filePath;
}

// ── 把目标 profile 激活到默认 ~/.codex 下 ──
async function activateProfileInDefaultCodexHome(profileId) {
  const sourceAuth = await readTextSafe(profileAuthPath(profileId));
  if (!sourceAuth.trim()) throw new Error('目标 OAuth profile 没有 auth.json，请先重新登录');
  let sourceJson;
  try { sourceJson = JSON.parse(sourceAuth); } catch { throw new Error('OAuth profile auth.json 解析失败'); }
  const meta = extractOauthMeta(sourceJson);
  if (!meta.hasTokens) throw new Error('目标 OAuth profile 没有 OAuth tokens，请先重新登录');

  const defaultHome = defaultCodexHome();
  await ensureDir(defaultHome);
  const defaultAuthPath = path.join(defaultHome, AUTH_FILENAME);
  const previousDefaultAuth = await readTextSafe(defaultAuthPath);
  if (previousDefaultAuth.trim() && previousDefaultAuth !== sourceAuth) {
    try { await writeSwitchBackup(previousDefaultAuth); } catch (_) {}
  }
  await writeSecret(defaultAuthPath, sourceAuth);

  // 清掉 ~/.codex/config.toml 里的 model_provider —— OAuth 模式不能让 codex 回退到 API key
  try {
    const tomlPath = path.join(defaultHome, 'config.toml');
    const tomlRaw = await readTextSafe(tomlPath);
    if (tomlRaw) {
      const TOML = await import('@iarna/toml');
      const parsed = TOML.default ? TOML.default.parse(tomlRaw) : TOML.parse(tomlRaw);
      if (parsed && typeof parsed === 'object' && 'model_provider' in parsed) {
        delete parsed.model_provider;
        await writeSecret(tomlPath, (TOML.default ? TOML.default.stringify : TOML.stringify)(parsed));
      }
    }
  } catch (_) { /* swallow */ }

  // 清掉常见的 OPENAI_API_KEY 等遗留 env
  try {
    const envPath = path.join(defaultHome, '.env');
    const envRaw = await readTextSafe(envPath);
    if (envRaw) {
      const env = parseEnvText(envRaw);
      let changed = false;
      for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'CODEX_API_KEY', 'CODEX_BASE_URL']) {
        if (k in env) { delete env[k]; changed = true; }
      }
      if (changed) await writeSecret(envPath, stringifyEnvObj(env));
    }
  } catch (_) { /* swallow */ }

  return defaultHome;
}

function uuidLikeId() {
  return `prof_${crypto.randomBytes(16).toString('hex')}`;
}

// ─── Public API ────────────────────────────────────────────────────────

export async function listOauthProfiles({ codexHome } = {}) {
  const home = String(codexHome || '').trim() || defaultCodexHome();
  const index = await readProfilesIndex();
  const profiles = await refreshProfilesRuntimeMeta(index);
  const liveMeta = await oauthMetaForCodexHome(home);

  let activeId = detectProfileIdByHome(index, home);
  if (!activeId && liveMeta.accountId) activeId = detectProfileIdByAccount(index, liveMeta.accountId);

  return {
    active: activeId,
    profiles,
    live: liveMeta,
    liveHasUnsavedTokens: liveMeta.hasTokens && !activeId,
  };
}

export async function saveCurrentOauthProfile({ name = '', codexHome } = {}) {
  const sourceHome = String(codexHome || '').trim() || defaultCodexHome();
  const livePath = path.join(sourceHome, AUTH_FILENAME);
  const liveRaw = await readTextSafe(livePath);
  if (!liveRaw.trim()) throw new Error('当前 CODEX_HOME/auth.json 为空，先运行 codex login');
  let liveJson;
  try { liveJson = JSON.parse(liveRaw); } catch { throw new Error('CODEX_HOME/auth.json 解析失败'); }
  const meta = extractOauthMeta(liveJson);
  if (!meta.hasTokens) throw new Error('当前 auth.json 没有 OAuth tokens（只有 API Key），请先运行 codex login');

  const index = await readProfilesIndex();
  let existingId = detectProfileIdByHome(index, sourceHome);
  if (!existingId && meta.accountId) existingId = detectProfileIdByAccount(index, meta.accountId);

  const now = Math.floor(Date.now() / 1000);
  const id = existingId || uuidLikeId();
  const targetHome = profileDir(id);
  await ensureDir(targetHome);

  const archive = profileAuthPath(id);
  if (sourceHome !== targetHome || (await readTextSafe(archive)) !== liveRaw) {
    await writeSecret(archive, liveRaw);
  }

  const profileName = defaultProfileName(name, meta, id);
  const existingEntry = index.profiles.find((p) => String(p?.id || '') === id);
  if (existingEntry) {
    Object.assign(existingEntry, {
      name: profileName,
      accountId: meta.accountId,
      plan: meta.plan,
      email: meta.email,
      sub: meta.sub,
      codexHome: targetHome,
      hasTokens: true,
      updatedAt: now,
    });
  } else {
    index.profiles.push({
      id,
      name: profileName,
      accountId: meta.accountId,
      plan: meta.plan,
      email: meta.email,
      sub: meta.sub,
      codexHome: targetHome,
      hasTokens: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  index.active = id;
  await writeProfilesIndex(index);

  return { id, updated: Boolean(existingId), codexHome: targetHome };
}

export async function createOauthProfile({ name = '' } = {}) {
  const id = uuidLikeId();
  const dir = profileDir(id);
  await ensureDir(dir);
  const now = Math.floor(Date.now() / 1000);
  const profileName = defaultProfileName(name, {}, id);

  const index = await readProfilesIndex();
  index.profiles.push({
    id,
    name: profileName,
    codexHome: dir,
    hasTokens: false,
    createdAt: now,
    updatedAt: now,
  });
  await writeProfilesIndex(index);

  return { id, name: profileName, codexHome: dir };
}

export async function switchOauthProfile({ id } = {}) {
  const safeId = safeProfileId(id);
  const targetHome = profileDir(safeId);
  if (!existsSync(targetHome)) throw new Error('目标 profile 目录不存在');

  // 清掉 profile dir 里残留的 OPENAI_API_KEY 等（防止 codex CLI 回退到 API key）
  try {
    const envPath = path.join(targetHome, '.env');
    const envRaw = await readTextSafe(envPath);
    if (envRaw) {
      const env = parseEnvText(envRaw);
      let changed = false;
      for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE']) {
        if (k in env) { delete env[k]; changed = true; }
      }
      if (changed) await writeSecret(envPath, stringifyEnvObj(env));
    }
  } catch (_) { /* swallow */ }

  const activatedDefault = await activateProfileInDefaultCodexHome(safeId);

  const index = await readProfilesIndex();
  index.active = safeId;
  await writeProfilesIndex(index);

  return {
    id: safeId,
    codexHome: activatedDefault,
    profileCodexHome: targetHome,
    activatedDefault: true,
  };
}

export async function renameOauthProfile({ id, name } = {}) {
  const safeId = safeProfileId(id);
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('name is required');
  const index = await readProfilesIndex();
  const profile = index.profiles.find((p) => String(p?.id || '') === safeId);
  if (!profile) throw new Error('未找到该 profile');
  profile.name = cleanName;
  profile.updatedAt = Math.floor(Date.now() / 1000);
  await writeProfilesIndex(index);
  return { id: safeId, name: cleanName };
}

export async function deleteOauthProfile({ id } = {}) {
  const safeId = safeProfileId(id);
  const index = await readProfilesIndex();
  const before = index.profiles.length;
  index.profiles = index.profiles.filter((p) => String(p?.id || '') !== safeId);
  if (index.profiles.length === before) throw new Error('未找到该 profile');
  if (index.active === safeId) index.active = '';
  await writeProfilesIndex(index);

  const dir = profileDir(safeId);
  if (existsSync(dir)) {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch (_) {}
  }
  return { id: safeId };
}

// 给配置中心 / Dashboard 显示当前激活 profile id（独立于上面的 list）
export async function activeProfileSnapshot() {
  const index = await readProfilesIndex();
  return { active: index.active || '', total: index.profiles.length };
}
