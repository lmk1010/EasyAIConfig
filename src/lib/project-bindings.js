// Per-project Provider 绑定（P0 #3 ⭐ KILL SHOT）
//
// 痛点：V2EX 1210691「全局 GUI 切换根本应付不来。项目 A 在用某个中转站跑长任务，
// 项目 B 想临时换个便宜的通道试试」—— cc-switch 的 ProviderManager 是全局单例
// 架构，永远做不了 per-project，这是它最不可弥补的设计缺陷之一。
//
// 我们的做法：维护 ~/.codex-config-ui/project-bindings.json：cwd → tool →
// providerKey。launchCodex / launchClaudeCode / launchOpenCode 时按 cwd 查
// 一遍，自动切到对应 provider 再起。
//
// 存储结构：
//   {
//     "version": 1,
//     "bindings": {
//       "/Users/me/work/clientA": {
//         "codex": { "providerKey": "deepseek", "savedAt": 1750000000 },
//         "claudecode": { "providerKey": "official", "savedAt": 1750000000 }
//       },
//       "/Users/me/personal": {
//         "codex": { "providerKey": "kimi-k2-7", "savedAt": 1750000123 }
//       }
//     }
//   }
//
// 匹配语义：先精确匹配 cwd，再 walk up 父目录找最深绑定（最特定优先）。
// 这样 /Users/me/work 可以兜底，/Users/me/work/special 覆盖单个项目。

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const APP_HOME_DIRNAME = '.codex-config-ui';
const BINDINGS_FILE = 'project-bindings.json';
const SUPPORTED_TOOLS = new Set(['codex', 'claudecode', 'opencode']);

function appHome() {
  const override = String(process.env.CODEX_CONFIG_UI_HOME || '').trim();
  if (override) return override;
  return path.join(os.homedir(), APP_HOME_DIRNAME);
}
function bindingsPath() { return path.join(appHome(), BINDINGS_FILE); }

function normCwd(cwd) {
  const raw = String(cwd || '').trim();
  if (!raw) return '';
  // 用 path.resolve 把 ~ 之类的形式 normalize 掉；不展开 ~ 因为 path.resolve 不做这事
  // 调用方应该已经传绝对路径（前端从 launchCwdInput.value 拿到的就是绝对路径）
  if (!path.isAbsolute(raw)) return '';
  return path.resolve(raw);
}

function normTool(tool) {
  const t = String(tool || '').trim().toLowerCase();
  if (!SUPPORTED_TOOLS.has(t)) throw new Error(`tool must be one of ${[...SUPPORTED_TOOLS].join(' / ')}`);
  return t;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { await fs.chmod(dirPath, 0o700); } catch (_) {}
  }
}
async function readTextSafe(filePath) {
  try { return await fs.readFile(filePath, 'utf8'); } catch { return ''; }
}
async function writeFileSecret(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try { await fs.chmod(filePath, 0o600); } catch (_) {}
  }
}

async function readBindings() {
  const text = await readTextSafe(bindingsPath());
  if (!text.trim()) return { version: 1, bindings: {} };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return { version: 1, bindings: {} };
    if (!parsed.bindings || typeof parsed.bindings !== 'object') parsed.bindings = {};
    return parsed;
  } catch { return { version: 1, bindings: {} }; }
}
async function writeBindings(state) {
  await writeFileSecret(bindingsPath(), JSON.stringify(state, null, 2));
}

// 走父目录链找最深匹配。"最深" 意味着 /a/b/c 优先于 /a/b 优先于 /a。
// 这让用户可以为整个 workspace 设一个默认 (e.g. /Users/me/work → ProviderA)，
// 再为单个子项目 override (e.g. /Users/me/work/special → ProviderB)。
function deepestMatch(bindings, cwd) {
  const normalized = normCwd(cwd);
  if (!normalized) return null;
  if (bindings[normalized]) return { dir: normalized, entry: bindings[normalized] };
  // walk up
  let current = normalized;
  while (true) {
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    if (bindings[parent]) return { dir: parent, entry: bindings[parent] };
    current = parent;
  }
  return null;
}

// ─── Public API ────────────────────────────────────────────────────────

export async function getProjectBinding(cwd, tool) {
  const t = normTool(tool);
  const { bindings } = await readBindings();
  const match = deepestMatch(bindings, cwd);
  if (!match) return null;
  const entry = match.entry[t];
  if (!entry || !entry.providerKey) return null;
  return {
    providerKey: entry.providerKey,
    savedAt: entry.savedAt || 0,
    matchedDir: match.dir,
    isExactMatch: match.dir === normCwd(cwd),
  };
}

export async function setProjectBinding({ cwd, tool, providerKey } = {}) {
  const normalizedCwd = normCwd(cwd);
  if (!normalizedCwd) throw new Error('cwd must be an absolute path');
  const t = normTool(tool);
  const cleanProviderKey = String(providerKey || '').trim();
  if (!cleanProviderKey) throw new Error('providerKey is required');

  const state = await readBindings();
  if (!state.bindings[normalizedCwd]) state.bindings[normalizedCwd] = {};
  state.bindings[normalizedCwd][t] = {
    providerKey: cleanProviderKey,
    savedAt: Math.floor(Date.now() / 1000),
  };
  await writeBindings(state);
  return { cwd: normalizedCwd, tool: t, providerKey: cleanProviderKey };
}

export async function removeProjectBinding({ cwd, tool } = {}) {
  const normalizedCwd = normCwd(cwd);
  if (!normalizedCwd) throw new Error('cwd must be an absolute path');
  const state = await readBindings();
  const entry = state.bindings[normalizedCwd];
  if (!entry) return { cwd: normalizedCwd, removed: false };

  if (tool) {
    const t = normTool(tool);
    if (entry[t]) {
      delete entry[t];
      if (!Object.keys(entry).length) delete state.bindings[normalizedCwd];
      await writeBindings(state);
      return { cwd: normalizedCwd, tool: t, removed: true };
    }
    return { cwd: normalizedCwd, tool: t, removed: false };
  }

  // 不指定 tool → 删整个 cwd 的所有绑定
  delete state.bindings[normalizedCwd];
  await writeBindings(state);
  return { cwd: normalizedCwd, removed: true };
}

export async function listProjectBindings() {
  const { bindings } = await readBindings();
  return Object.entries(bindings).map(([cwd, tools]) => ({
    cwd,
    tools,
  }));
}

// 给 UI 用：传当前 cwd，返回该 cwd 对所有 tool 的绑定（用于 hub 概览面板）
export async function summarizeBindingsForCwd(cwd) {
  const { bindings } = await readBindings();
  const match = deepestMatch(bindings, cwd);
  if (!match) return { matchedDir: null, isExactMatch: false, tools: {} };
  return {
    matchedDir: match.dir,
    isExactMatch: match.dir === normCwd(cwd),
    tools: match.entry || {},
  };
}
