// Claude Code 多账号 OAuth profile 管理（Express / Web 模式）。
//
// 镜像 src-tauri/src/claudecode_oauth_profiles.rs。和 Codex 不同的是 Claude
// Code 有原生 CLAUDE_CONFIG_DIR 机制：
//   CLAUDE_CONFIG_DIR=/foo/bar claude  → 所有状态（.claude.json /
//   .credentials.json / Keychain service hash）都按这个 dir 独立。
// 我们的「profile」就是 ~/.codex-config-ui/claudecode-oauth-profiles/<id>/。
// 切换 = 改 active 指针 + launchClaudeCode 启动时注入 env。
// 切换不复制 token、不动 Keychain、不污染 ~/.claude/。
//
// 痛点对标：cc-switch [#1105] 第二个官方账号覆盖第一个
// 我们：每个账号自己一份 CONFIG_DIR，互不可见，零覆盖风险。
//
// 与 Tauri Rust 版相比：
//   - 没有 macOS Keychain plan tier 提取（plan 字段会是空 — 仅显示用，不影响功能）
//   - 没有 onboarding-bypass 写入（首次进 profile 会过一次欢迎向导 — 不影响登录）
//   - 进程探测保留：切换/删除时检测有无运行中的 claude 进程，避免脚本盲切

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const APP_HOME_DIRNAME = '.codex-config-ui';
const PROFILES_DIRNAME = 'claudecode-oauth-profiles';
const PROFILES_INDEX = 'profiles.json';
const SWITCH_THROTTLE_SEC = 60;

function appHome() {
  const override = String(process.env.CODEX_CONFIG_UI_HOME || '').trim();
  if (override) return override;
  return path.join(os.homedir(), APP_HOME_DIRNAME);
}
function profilesRoot() { return path.join(appHome(), PROFILES_DIRNAME); }
function profilesIndexPath() { return path.join(profilesRoot(), PROFILES_INDEX); }

function safeProfileId(id, { allowEmpty = false } = {}) {
  const trimmed = String(id || '').trim();
  if (!trimmed) {
    if (allowEmpty) return '';
    throw new Error('id is required');
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error('非法的 profile id');
  }
  return trimmed;
}
function profileDir(id) { return path.join(profilesRoot(), safeProfileId(id)); }

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

// 探测系统里有没有正在运行的 claude / claude-code 进程
// 用 ps（unix）或 tasklist（win），结果保守：宁可漏报不要误伤
function countRunningClaudeProcesses() {
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const out = execSync('ps -axo command=', { encoding: 'utf8', timeout: 2000 }).toLowerCase();
      const lines = out.split('\n');
      let count = 0;
      for (const line of lines) {
        if (line.includes('config-ui') || line.includes('easyaiconfig')) continue;
        if (line.includes('@anthropic-ai/claude-code') || line.includes('claude/cli.js')) { count++; continue; }
        const first = line.trim().split(/\s+/)[0] || '';
        const base = first.split('/').pop() || first;
        if (base === 'claude') count++;
      }
      return count;
    }
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FO CSV', { encoding: 'utf8', timeout: 2000 }).toLowerCase();
      return (out.match(/claude\.exe/g) || []).length;
    }
  } catch (_) { /* swallow */ }
  return 0;
}

// ── profiles.json 读写 ──
async function readProfilesIndex() {
  const text = await readTextSafe(profilesIndexPath());
  if (!text.trim()) return { version: 1, active: '', lastSwitchAt: 0, profiles: [] };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return { version: 1, active: '', lastSwitchAt: 0, profiles: [] };
    if (!Array.isArray(parsed.profiles)) parsed.profiles = [];
    if (typeof parsed.active !== 'string') parsed.active = '';
    if (typeof parsed.lastSwitchAt !== 'number') parsed.lastSwitchAt = 0;
    return parsed;
  } catch { return { version: 1, active: '', lastSwitchAt: 0, profiles: [] }; }
}
async function writeProfilesIndex(index) {
  await ensureDir(profilesRoot());
  await writeSecret(profilesIndexPath(), JSON.stringify(index, null, 2));
}

// 读 profile 的 .claude.json 拿 oauthAccount metadata（账号身份、组织等）
// macOS Keychain 里的 plan tier 不在这里拿，留空字符串（UI 不影响）
async function readProfileMetadata(dir) {
  const out = {
    accountUuid: '', email: '', organizationName: '', organizationUuid: '',
    organizationRole: '', displayName: '', billingType: '',
    subscriptionType: '', rateLimitTier: '', plan: '',
    hasTokens: false,
  };
  const claudeJson = await readTextSafe(path.join(dir, '.claude.json'));
  if (!claudeJson.trim()) return out;
  let parsed;
  try { parsed = JSON.parse(claudeJson); } catch { return out; }
  const account = parsed?.oauthAccount;
  if (!account || typeof account !== 'object') return out;
  return {
    accountUuid: String(account.accountUuid || ''),
    email: String(account.emailAddress || ''),
    organizationName: String(account.organizationName || ''),
    organizationUuid: String(account.organizationUuid || ''),
    organizationRole: String(account.organizationRole || ''),
    displayName: String(account.displayName || ''),
    billingType: String(account.billingType || ''),
    subscriptionType: '',
    rateLimitTier: '',
    plan: '',
    hasTokens: Boolean(account.accountUuid),
  };
}

// 默认 ~/.claude/ 的身份（list 返回里的 defaultPlan 字段）
async function readDefaultClaudeInfo() {
  const out = { subscriptionType: '', rateLimitTier: '', plan: '', email: '', organizationName: '' };
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  const text = await readTextSafe(claudeJsonPath);
  if (!text.trim()) return out;
  try {
    const parsed = JSON.parse(text);
    const account = parsed?.oauthAccount;
    if (account && typeof account === 'object') {
      out.email = String(account.emailAddress || '');
      out.organizationName = String(account.organizationName || '');
    }
  } catch (_) {}
  return out;
}

function uuidLikeId() { return `prof_${crypto.randomBytes(16).toString('hex')}`; }

// ─── Public API ────────────────────────────────────────────────────────

export async function listClaudecodeOauthProfiles() {
  const index = await readProfilesIndex();
  const enriched = [];
  for (const profile of index.profiles) {
    const id = String(profile?.id || '').trim();
    if (!id) continue;
    let dir;
    try { dir = profileDir(id); } catch { continue; }
    const meta = await readProfileMetadata(dir);
    enriched.push({
      id,
      name: profile.name || '',
      createdAt: profile.createdAt || 0,
      updatedAt: profile.updatedAt || 0,
      configDir: dir,
      ...meta,
      isStale: false,
    });
  }
  const defaultPlan = await readDefaultClaudeInfo();
  return {
    active: index.active || '',
    lastSwitchAt: index.lastSwitchAt || 0,
    profiles: enriched,
    defaultPlan,
  };
}

export async function createClaudecodeOauthProfile({ name = '' } = {}) {
  const id = uuidLikeId();
  const dir = profileDir(id);
  await ensureDir(dir);
  const now = Math.floor(Date.now() / 1000);
  const profileName = String(name || '').trim() || `Claude 账号 #${id.slice(5, 13)}`;
  const index = await readProfilesIndex();
  index.profiles.push({ id, name: profileName, createdAt: now, updatedAt: now });
  await writeProfilesIndex(index);
  return { id, name: profileName, configDir: dir };
}

export async function switchClaudecodeOauthProfile({ id, force = false } = {}) {
  const safeId = safeProfileId(id, { allowEmpty: true });
  const index = await readProfilesIndex();
  const now = Math.floor(Date.now() / 1000);
  const last = index.lastSwitchAt || 0;
  const currentActive = index.active || '';

  if (safeId === currentActive) return { active: safeId, noop: true };

  // 60s 节流，防风控
  if (last > 0 && now - last < SWITCH_THROTTLE_SEC) {
    throw new Error(`切换太频繁，请在 ${SWITCH_THROTTLE_SEC - (now - last)} 秒后再试（防风控）`);
  }

  if (safeId) {
    const dir = profileDir(safeId);
    if (!existsSync(dir)) throw new Error('目标 profile 目录不存在');
  }

  if (!force) {
    const running = countRunningClaudeProcesses();
    if (running > 0) {
      throw new Error(
        `CLAUDE_RUNNING:${running}:检测到 ${running} 个正在运行的 Claude 进程。这些进程会继续使用当前账号直到关闭。\n\n建议先关闭后再切,否则:\n- Dashboard 显示会与运行中进程脱节\n- 运行中进程的用量仍计入旧账号\n\n如已确认要继续,点击再次切换时会强制执行。`
      );
    }
  }

  index.active = safeId;
  index.lastSwitchAt = now;
  await writeProfilesIndex(index);
  return { active: safeId, forced: force };
}

export async function renameClaudecodeOauthProfile({ id, name } = {}) {
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

export async function deleteClaudecodeOauthProfile({ id, force = false } = {}) {
  const safeId = safeProfileId(id);
  if (!force) {
    const running = countRunningClaudeProcesses();
    if (running > 0) {
      throw new Error(
        `CLAUDE_RUNNING:${running}:检测到 ${running} 个正在运行的 Claude 进程。删除 profile 目录可能导致正在使用该目录的进程崩溃(session 写入失败)。\n\n建议先关闭所有 Claude 进程再删。确认无误可强制删除。`
      );
    }
  }
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

// 给 launchClaudeCode 用：拿当前活跃 profile 的 CLAUDE_CONFIG_DIR
export async function activeClaudecodeConfigDir() {
  const index = await readProfilesIndex();
  if (!index.active) return null;
  const dir = profileDir(index.active);
  if (!existsSync(dir)) return null;
  return dir;
}
