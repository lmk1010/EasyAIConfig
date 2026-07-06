import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { listCodexSessions } from './config-store.js';

const DEFAULT_TOOLS = [
  'codex',
  'claudecode',
  'opencode',
  'gemini',
  'openclaw',
  'hermes',
  'qwen-code',
  'codebuddy-code',
  'cline',
  'roo-code',
  'kilo-code',
  'continue',
  'cursor',
  'windsurf',
  'zed',
  'trae',
  'qoder',
  'zcode',
  'lingma',
];

const FILE_ARCHIVE_TOOLS = ['codex', 'claudecode', 'gemini', 'openclaw', 'hermes', 'qwen-code', 'codebuddy-code'];

function defaultCodexHome() {
  return process.env.CODEX_HOME?.trim()
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function defaultClaudeHome() {
  return path.join(os.homedir(), '.claude');
}

function defaultOpenCodeDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming'), 'opencode');
  }
  return path.join(process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share'), 'opencode');
}

function defaultGeminiHome() {
  return path.join(os.homedir(), '.gemini');
}

function defaultQwenHome() {
  return path.join(os.homedir(), '.qwen');
}

function defaultCodeBuddyHome() {
  const configured = process.env.CODEBUDDY_CONFIG_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codebuddy');
}

function defaultOpenClawHome() {
  return path.join(os.homedir(), '.openclaw');
}

function defaultHermesHome() {
  return path.join(os.homedir(), '.hermes');
}

function appHome() {
  return path.join(os.homedir(), '.codex-config-ui');
}

function defaultSessionTrashRoot() {
  return path.join(appHome(), 'session-trash');
}

function appSupportRoot(appName) {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
  }
  const lower = String(appName || '').toLowerCase().replace(/\s+/g, '-');
  return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), lower);
}

function extensionStateRoots(extensionIds = [], products = ['Code', 'Cursor', 'Windsurf', 'Trae']) {
  return products.flatMap((product) => extensionIds.map((extensionId) => (
    path.join(appSupportRoot(product), 'User', 'globalStorage', extensionId)
  )));
}

const SESSION_BACKED_TOOL_META = {
  gemini: {
    label: 'Gemini CLI sessions',
    provider: 'google-gemini',
    canDelete: true,
    roots: (options = {}) => {
      const home = path.resolve(String(options.geminiHome || defaultGeminiHome()));
      return [path.join(home, 'sessions'), path.join(home, 'history')];
    },
  },
  openclaw: {
    label: 'OpenClaw sessions',
    provider: 'unknown',
    canDelete: true,
    roots: (options = {}) => {
      const home = path.resolve(String(options.openClawHome || defaultOpenClawHome()));
      return [path.join(home, 'sessions'), path.join(home, 'history')];
    },
  },
  hermes: {
    label: 'Hermes Agent sessions',
    provider: 'unknown',
    canDelete: true,
    roots: (options = {}) => {
      const home = path.resolve(String(options.hermesHome || defaultHermesHome()));
      return [path.join(home, 'sessions'), path.join(home, 'history')];
    },
  },
  'qwen-code': {
    label: 'Qwen Code local state',
    provider: 'qwen',
    canDelete: true,
    roots: (options = {}) => {
      const home = path.resolve(String(options.qwenHome || defaultQwenHome()));
      return [path.join(home, 'sessions'), path.join(home, 'history'), path.join(home, 'tmp')];
    },
  },
  'codebuddy-code': {
    label: 'CodeBuddy Code local state',
    provider: 'tencent-codebuddy',
    canDelete: true,
    roots: (options = {}) => {
      const home = path.resolve(String(options.codeBuddyHome || defaultCodeBuddyHome()));
      return [path.join(home, 'sessions'), path.join(home, 'history'), path.join(home, 'logs')];
    },
  },
  cline: {
    label: 'Cline extension state',
    provider: 'extension',
    roots: () => [
      path.join(os.homedir(), '.cline', 'sessions'),
      ...extensionStateRoots(['saoudrizwan.claude-dev', 'cline.cline']),
    ],
  },
  'roo-code': {
    label: 'Roo Code extension state',
    provider: 'extension',
    roots: () => [
      path.join(os.homedir(), '.roo-code', 'sessions'),
      ...extensionStateRoots(['rooveterinaryinc.roo-cline', 'roo-cline.roo-cline']),
    ],
  },
  'kilo-code': {
    label: 'Kilo Code extension state',
    provider: 'extension',
    roots: () => [
      path.join(os.homedir(), '.kilo-code', 'sessions'),
      ...extensionStateRoots(['kilocode.kilo-code', 'kilo-code.kilo-code']),
    ],
  },
  continue: {
    label: 'Continue local state',
    provider: 'extension',
    roots: () => [path.join(os.homedir(), '.continue'), ...extensionStateRoots(['continue.continue'])],
  },
  cursor: {
    label: 'Cursor local state',
    provider: 'editor',
    roots: () => [path.join(os.homedir(), '.cursor', 'sessions'), path.join(appSupportRoot('Cursor'), 'User', 'globalStorage', 'cursor.cursor')],
  },
  windsurf: {
    label: 'Windsurf local state',
    provider: 'editor',
    roots: () => [path.join(os.homedir(), '.windsurf', 'sessions'), path.join(appSupportRoot('Windsurf'), 'User', 'globalStorage', 'codeium.windsurf')],
  },
  zed: {
    label: 'Zed local state',
    provider: 'editor',
    roots: () => [path.join(os.homedir(), '.zed', 'sessions'), path.join(appSupportRoot('Zed'), 'sessions')],
  },
  trae: {
    label: 'Trae local state',
    provider: 'editor',
    roots: () => [path.join(os.homedir(), '.trae', 'sessions'), path.join(appSupportRoot('Trae'), 'User', 'globalStorage')],
  },
  qoder: {
    label: 'Qoder local state',
    provider: 'editor',
    roots: () => [path.join(os.homedir(), '.qoder', 'sessions'), path.join(appSupportRoot('Qoder'), 'sessions')],
  },
  zcode: {
    label: 'ZCode local state',
    provider: 'editor',
    roots: () => [path.join(os.homedir(), '.zcode', 'sessions'), path.join(appSupportRoot('ZCode'), 'sessions')],
  },
  lingma: {
    label: 'Tongyi Lingma local state',
    provider: 'editor',
    roots: () => [path.join(os.homedir(), '.lingma', 'sessions'), path.join(appSupportRoot('Lingma'), 'sessions')],
  },
};

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(rootDir, { extensions = ['.jsonl', '.json'], maxFiles = 500 } = {}) {
  const files = [];
  async function walk(currentDir) {
    if (files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
        let stat = null;
        try { stat = await fs.stat(fullPath); } catch { stat = null; }
        files.push({ filePath: fullPath, mtimeMs: Number(stat?.mtimeMs || 0) });
      }
    }
  }
  await walk(rootDir);
  return files.sort((left, right) => Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0));
}

function parseTimestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value > 1e12 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactPreview(text = '', fallback = 'Untitled session') {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return fallback;
  return collapsed.length > 96 ? `${collapsed.slice(0, 95)}...` : collapsed;
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      return item.text || item.content || item.value || '';
    })
    .filter(Boolean)
    .join(' ');
}

function extractUserText(record = {}) {
  const message = record.message && typeof record.message === 'object' ? record.message : {};
  const role = String(message.role || record.role || record.type || '').toLowerCase();
  if (role.includes('user') || record.type === 'user') {
    return extractTextFromContent(message.content ?? record.content ?? record.text ?? record.prompt);
  }
  if (record.prompt) return String(record.prompt);
  return '';
}

function modelProvider(tool, model = '', fallback = 'unknown') {
  const normalized = String(model || '').toLowerCase();
  if (tool === 'claudecode') return 'anthropic';
  if (tool === 'gemini') return 'google-gemini';
  if (normalized.includes('claude')) return 'anthropic';
  if (normalized.includes('gemini')) return 'google-gemini';
  if (normalized.includes('gpt') || normalized.includes('o3') || normalized.includes('o4')) return 'openai';
  return fallback;
}

function isSameOrNestedPath(left = '', right = '') {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) return false;
  const leftPath = path.resolve(a);
  const rightPath = path.resolve(b);
  if (leftPath === rightPath) return true;
  return leftPath.startsWith(`${rightPath}${path.sep}`) || rightPath.startsWith(`${leftPath}${path.sep}`);
}

function isPathInside(child = '', parent = '') {
  const childPath = path.resolve(String(child || ''));
  const parentPath = path.resolve(String(parent || ''));
  return childPath === parentPath || childPath.startsWith(`${parentPath}${path.sep}`);
}

function sourceResult({ tool, label, sourcePath, sourceType = 'filesystem', exists = false, readError = '', items = [], capabilities = {} }) {
  return {
    tool,
    label,
    sourcePath,
    sourceType,
    exists,
    readError,
    count: items.length,
    capabilities: {
      browse: true,
      search: true,
      resume: false,
      fork: false,
      delete: false,
      ...capabilities,
    },
    items,
  };
}

function normalizeSessionItem(item = {}) {
  const updatedAtMs = Number(item.updatedAtMs || parseTimestampMs(item.updatedAt) || 0);
  const provider = String(item.provider || modelProvider(item.tool, item.model)).trim() || 'unknown';
  const projectPath = String(item.projectPath || item.cwd || '').trim();
  const projectKey = String(item.projectKey || (projectPath ? path.basename(projectPath) : '') || 'unknown').trim();
  const sessionId = String(item.sessionId || item.id || '').trim();
  return {
    id: `${item.tool}:${sessionId || path.basename(String(item.sourcePath || 'session'))}`,
    sessionId,
    tool: item.tool,
    title: compactPreview(item.title || item.preview || '', sessionId || 'Untitled session'),
    provider,
    model: String(item.model || 'unknown').trim() || 'unknown',
    projectPath,
    projectKey,
    cwd: String(item.cwd || projectPath || '').trim(),
    updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : '',
    updatedAtMs,
    sourcePath: String(item.sourcePath || '').trim(),
    sourceLabel: String(item.sourceLabel || '').trim(),
    actions: {
      resume: Boolean(item.actions?.resume),
      fork: Boolean(item.actions?.fork),
      delete: Boolean(item.actions?.delete),
    },
    raw: item.raw || undefined,
  };
}

async function readCodexSource(options = {}) {
  const codexHome = path.resolve(String(options.codexHome || defaultCodexHome()));
  const sessionsRoot = path.join(codexHome, 'sessions');
  try {
    const result = await listCodexSessions({
      codexHome,
      cwd: options.cwd || '',
      all: true,
      limit: Math.max(20, Math.min(500, Number(options.sourceLimit || options.limit || 100))),
    });
    const items = (result.items || []).map((item) => normalizeSessionItem({
      ...item,
      tool: 'codex',
      projectPath: item.cwd,
      sourceLabel: 'Codex sessions',
      actions: { resume: true, fork: true, delete: true },
    }));
    return sourceResult({
      tool: 'codex',
      label: 'Codex sessions',
      sourcePath: sessionsRoot,
      exists: await pathExists(sessionsRoot),
      items,
      capabilities: { resume: true, fork: true, delete: true },
    });
  } catch (error) {
    return sourceResult({
      tool: 'codex',
      label: 'Codex sessions',
      sourcePath: sessionsRoot,
      exists: await pathExists(sessionsRoot),
      readError: error instanceof Error ? error.message : String(error),
      capabilities: { resume: true, fork: true, delete: true },
    });
  }
}

async function readClaudeSessionFile(filePath, sourceLabel) {
  const raw = await readText(filePath);
  if (!raw) return null;
  const stat = await fs.stat(filePath).catch(() => null);
  let title = '';
  let model = '';
  let cwd = '';
  let updatedAtMs = Number(stat?.mtimeMs || 0);

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record = null;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== 'object') continue;

    const ts = parseTimestampMs(record.timestamp || record.createdAt || record.updatedAt);
    if (ts) updatedAtMs = Math.max(updatedAtMs || 0, ts);

    cwd = cwd || String(record.cwd || record.projectRoot || record.workspaceRoot || '').trim();
    const message = record.message && typeof record.message === 'object' ? record.message : {};
    const recordModel = String(message.model || record.model || '').trim();
    if (recordModel && !recordModel.startsWith('<')) model = recordModel;
    if (!title) title = extractUserText(record);
  }

  const sessionId = path.basename(filePath, path.extname(filePath));
  const projectKey = path.basename(path.dirname(filePath));
  return normalizeSessionItem({
    sessionId,
    tool: 'claudecode',
    title: title || sessionId,
    provider: 'anthropic',
    model: model || 'unknown',
    cwd,
    projectPath: cwd,
    projectKey,
    updatedAtMs,
    sourcePath: filePath,
    sourceLabel,
    actions: { delete: true },
  });
}

async function readClaudeSource(options = {}) {
  const claudeHome = path.resolve(String(options.claudeHome || defaultClaudeHome()));
  const projectsRoot = path.join(claudeHome, 'projects');
  const files = await walkFiles(projectsRoot, {
    extensions: ['.jsonl'],
    maxFiles: Math.max(20, Math.min(1000, Number(options.sourceLimit || 300))),
  });
  const items = [];
  for (const entry of files) {
    const item = await readClaudeSessionFile(entry.filePath, 'Claude Code projects');
    if (item) items.push(item);
  }
  return sourceResult({
    tool: 'claudecode',
    label: 'Claude Code projects',
    sourcePath: projectsRoot,
    exists: await pathExists(projectsRoot),
    items,
    capabilities: { delete: true },
  });
}

function commandExists(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    encoding: 'utf8',
    shell: process.platform !== 'win32',
    windowsHide: true,
  });
  return result.status === 0;
}

function sqliteJson(dbPath, sql) {
  const result = spawnSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'sqlite3 query failed').trim());
  }
  return JSON.parse(String(result.stdout || '[]'));
}

async function readOpenCodeSource(options = {}) {
  const dataDir = path.resolve(String(options.openCodeDataDir || defaultOpenCodeDataDir()));
  const dbPath = options.openCodeDbPath ? path.resolve(String(options.openCodeDbPath)) : path.join(dataDir, 'opencode.db');
  const exists = existsSync(dbPath);
  if (!exists) {
    return sourceResult({
      tool: 'opencode',
      label: 'OpenCode SQLite sessions',
      sourcePath: dbPath,
      sourceType: 'sqlite',
      exists: false,
    });
  }
  if (!commandExists('sqlite3')) {
    return sourceResult({
      tool: 'opencode',
      label: 'OpenCode SQLite sessions',
      sourcePath: dbPath,
      sourceType: 'sqlite',
      exists: true,
      readError: 'sqlite3 unavailable',
    });
  }

  try {
    const limit = Math.max(20, Math.min(500, Number(options.sourceLimit || options.limit || 100)));
    const rows = sqliteJson(dbPath, `
      SELECT id, title, directory, time_updated
      FROM session
      ORDER BY time_updated DESC
      LIMIT ${limit}
    `.replace(/\s+/g, ' ').trim());
    const items = (Array.isArray(rows) ? rows : []).map((row) => normalizeSessionItem({
      sessionId: row.id,
      tool: 'opencode',
      title: row.title || row.id,
      provider: 'unknown',
      model: 'unknown',
      cwd: row.directory || '',
      projectPath: row.directory || '',
      updatedAtMs: parseTimestampMs(row.time_updated),
      sourcePath: dbPath,
      sourceLabel: 'OpenCode SQLite sessions',
    }));
    return sourceResult({
      tool: 'opencode',
      label: 'OpenCode SQLite sessions',
      sourcePath: dbPath,
      sourceType: 'sqlite',
      exists: true,
      items,
    });
  } catch (error) {
    return sourceResult({
      tool: 'opencode',
      label: 'OpenCode SQLite sessions',
      sourcePath: dbPath,
      sourceType: 'sqlite',
      exists: true,
      readError: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readGenericJsonSessionFile(filePath, { tool, provider, sourceLabel, actions = {} }) {
  const raw = await readText(filePath);
  if (!raw) return null;
  const stat = await fs.stat(filePath).catch(() => null);
  const records = [];
  if (filePath.toLowerCase().endsWith('.json')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) records.push(...parsed);
      else if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      return null;
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* ignore malformed line */ }
    }
  }

  let title = '';
  let model = '';
  let cwd = '';
  let updatedAtMs = Number(stat?.mtimeMs || 0);
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const ts = parseTimestampMs(record.timestamp || record.createdAt || record.updatedAt || record.time);
    if (ts) updatedAtMs = Math.max(updatedAtMs || 0, ts);
    cwd = cwd || String(record.cwd || record.projectPath || record.workspaceRoot || '').trim();
    model = model || String(record.model || record.message?.model || '').trim();
    if (!title) title = extractUserText(record) || record.title || record.name || '';
  }

  const sessionId = path.basename(filePath, path.extname(filePath));
  return normalizeSessionItem({
    sessionId,
    tool,
    title: title || sessionId,
    provider: provider || modelProvider(tool, model),
    model: model || 'unknown',
    cwd,
    projectPath: cwd,
    projectKey: cwd ? path.basename(cwd) : path.basename(path.dirname(filePath)),
    updatedAtMs,
    sourcePath: filePath,
    sourceLabel,
    actions: { delete: Boolean(actions.delete) },
  });
}

async function readGenericSource({ tool, label, roots, provider, options = {}, capabilities = {} }) {
  const normalizedRoots = roots.map((item) => path.resolve(String(item)));
  const items = [];
  let existingSources = 0;
  const actions = { delete: Boolean(capabilities.delete) };
  for (const root of normalizedRoots) {
    if (!await pathExists(root)) continue;
    existingSources += 1;
    const files = await walkFiles(root, {
      extensions: ['.jsonl', '.json'],
      maxFiles: Math.max(20, Math.min(500, Number(options.sourceLimit || 200))),
    });
    for (const entry of files) {
      const item = await readGenericJsonSessionFile(entry.filePath, { tool, provider, sourceLabel: label, actions });
      if (item) items.push(item);
    }
  }
  return sourceResult({
    tool,
    label,
    sourcePath: normalizedRoots.join(path.delimiter),
    exists: existingSources > 0,
    items,
    capabilities: { delete: actions.delete },
  });
}

function normalizeTool(tool = '') {
  const value = String(tool || '').trim().toLowerCase();
  const key = value.replace(/[^a-z0-9]+/g, '');
  if (value === 'claude-code' || value === 'claude_code' || value === 'claude') return 'claudecode';
  if (key === 'claudecode') return 'claudecode';
  if (value === 'gemini-cli' || value === 'geminicli') return 'gemini';
  if (key === 'gemini') return 'gemini';
  if (value === 'open-code' || value === 'open_code') return 'opencode';
  if (key === 'opencode') return 'opencode';
  if (value === 'open-claw' || value === 'open_claw') return 'openclaw';
  if (key === 'openclaw') return 'openclaw';
  if (key === 'hermes' || key === 'hermesagent') return 'hermes';
  if (['qwen', 'qwencode', 'qwencli', 'qwencodecli'].includes(key)) return 'qwen-code';
  if (['codebuddy', 'codebuddycode', 'codebuddycli', 'tencentcodebuddy'].includes(key)) return 'codebuddy-code';
  if (['roo', 'roocode', 'roocline'].includes(key)) return 'roo-code';
  if (['kilo', 'kilocode'].includes(key)) return 'kilo-code';
  if (['continue', 'continuedev'].includes(key)) return 'continue';
  if (['cursor', 'cursoreditor'].includes(key)) return 'cursor';
  if (['windsurf', 'codeiumwindsurf'].includes(key)) return 'windsurf';
  if (['zed', 'zededitor'].includes(key)) return 'zed';
  if (['trae', 'traeai'].includes(key)) return 'trae';
  if (['qoder', 'qoderide'].includes(key)) return 'qoder';
  if (['zcode', 'zai', 'zaiide'].includes(key)) return 'zcode';
  if (['lingma', 'tongyilingma', 'aliyunlingma', 'qodercn'].includes(key)) return 'lingma';
  if (['cline', 'clineextension'].includes(key)) return 'cline';
  return value;
}

function sessionRootCandidates(options = {}, tool = '') {
  const normalized = normalizeTool(tool);
  const roots = [];
  const codexHome = path.resolve(String(options.codexHome || defaultCodexHome()));
  const claudeHome = path.resolve(String(options.claudeHome || defaultClaudeHome()));
  const geminiHome = path.resolve(String(options.geminiHome || defaultGeminiHome()));
  const openClawHome = path.resolve(String(options.openClawHome || defaultOpenClawHome()));
  const hermesHome = path.resolve(String(options.hermesHome || defaultHermesHome()));

  if (!normalized || normalized === 'codex') roots.push(path.join(codexHome, 'sessions'));
  if (!normalized || normalized === 'claudecode') roots.push(path.join(claudeHome, 'projects'));
  if (!normalized || normalized === 'gemini') roots.push(path.join(geminiHome, 'sessions'), path.join(geminiHome, 'history'));
  if (!normalized || normalized === 'openclaw') roots.push(path.join(openClawHome, 'sessions'), path.join(openClawHome, 'history'));
  if (!normalized || normalized === 'hermes') roots.push(path.join(hermesHome, 'sessions'), path.join(hermesHome, 'history'));
  if (!normalized || normalized === 'qwen-code') roots.push(...SESSION_BACKED_TOOL_META['qwen-code'].roots(options));
  if (!normalized || normalized === 'codebuddy-code') roots.push(...SESSION_BACKED_TOOL_META['codebuddy-code'].roots(options));
  return roots.map((root) => path.resolve(root));
}

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return {
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

function sessionTrashPaths(options = {}) {
  const root = path.resolve(String(options.trashRoot || defaultSessionTrashRoot()));
  return {
    root,
    filesRoot: path.join(root, 'files'),
    indexPath: path.join(root, 'index.json'),
  };
}

async function readSessionTrashIndex(options = {}) {
  const { indexPath } = sessionTrashPaths(options);
  let raw = '';
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

async function writeSessionTrashIndex(entries = [], options = {}) {
  const { root, indexPath } = sessionTrashPaths(options);
  const payload = {
    schema: 'easyaiconfig.session-trash.v1',
    updatedAt: new Date().toISOString(),
    entries,
  };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(indexPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

async function validateArchiveTarget(input = {}, options = {}) {
  const tool = normalizeTool(input.tool || input.targetTool || '');
  if (!tool || !FILE_ARCHIVE_TOOLS.includes(tool)) {
    throw new Error('Session archive only supports file-based Codex, Claude Code, Gemini, OpenClaw, Hermes, Qwen Code, and CodeBuddy Code sessions');
  }
  const rawSourcePath = String(input.sourcePath || input.filePath || '').trim();
  if (!rawSourcePath) throw new Error('sourcePath is required');
  const sourcePath = path.resolve(rawSourcePath);
  const lower = sourcePath.toLowerCase();
  if (!lower.endsWith('.jsonl') && !lower.endsWith('.json')) {
    throw new Error('Session archive only supports .jsonl or .json files');
  }
  const roots = sessionRootCandidates(options, tool);
  if (!roots.some((root) => isPathInside(sourcePath, root))) {
    throw new Error('Session file is outside known session roots');
  }
  const stat = await fs.stat(sourcePath).catch(() => null);
  if (!stat?.isFile()) throw new Error('Session file does not exist');
  return { tool, sourcePath, roots, stat };
}

export async function listSessionTrash(options = {}) {
  const { root, indexPath } = sessionTrashPaths(options);
  let entries = [];
  let readError = '';
  try {
    entries = await readSessionTrashIndex(options);
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  }
  const materialized = [];
  for (const entry of entries) {
    const archivePath = path.resolve(String(entry.archivePath || ''));
    materialized.push({
      ...entry,
      exists: archivePath ? await pathExists(archivePath) : false,
    });
  }
  materialized.sort((left, right) => Number(Date.parse(right.archivedAt || '') || 0) - Number(Date.parse(left.archivedAt || '') || 0));
  return {
    schema: 'easyaiconfig.session-trash.v1',
    generatedAt: new Date().toISOString(),
    root,
    indexPath,
    readError,
    entries: materialized,
    summary: {
      entries: materialized.length,
      restorable: materialized.filter((entry) => entry.exists && !entry.restoredAt).length,
      restored: materialized.filter((entry) => entry.restoredAt).length,
      missingArchives: materialized.filter((entry) => !entry.exists).length,
    },
  };
}

export async function archiveSession(input = {}, options = {}) {
  const dryRun = input.dryRun !== false;
  const { tool, sourcePath, stat } = await validateArchiveTarget(input, options);
  const { root, filesRoot } = sessionTrashPaths(options);
  const archiveId = String(input.archiveId || `${Date.now()}-${crypto.randomUUID()}`).trim();
  const archiveDir = path.join(filesRoot, archiveId);
  const archivePath = path.join(archiveDir, path.basename(sourcePath));
  const digest = await sha256File(sourcePath);
  const entry = {
    id: archiveId,
    tool,
    sessionId: String(input.sessionId || path.basename(sourcePath, path.extname(sourcePath))).trim(),
    title: String(input.title || '').trim(),
    sourceLabel: String(input.sourceLabel || '').trim(),
    originalPath: sourcePath,
    archivePath,
    archivedAt: new Date().toISOString(),
    reason: String(input.reason || '').trim(),
    bytes: digest.bytes,
    sha256: digest.sha256,
    mtimeMs: Number(stat.mtimeMs || 0),
  };
  const operation = {
    action: 'archive-session',
    dryRun,
    previewOnly: dryRun,
    tool,
    sessionId: entry.sessionId,
    sourcePath,
    archivePath,
    bytes: entry.bytes,
    sha256: entry.sha256,
  };
  if (!dryRun) {
    const entries = await readSessionTrashIndex(options);
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.copyFile(sourcePath, archivePath);
    await fs.rm(sourcePath, { force: true });
    entries.push(entry);
    await writeSessionTrashIndex(entries, options);
  }
  return {
    schema: 'easyaiconfig.session-archive.v1',
    dryRun,
    changed: !dryRun,
    trashRoot: root,
    entry,
    operations: [operation],
    summary: {
      archived: dryRun ? 0 : 1,
      previewed: dryRun ? 1 : 0,
      bytes: entry.bytes,
    },
  };
}

export async function restoreSession(input = {}, options = {}) {
  const dryRun = input.dryRun !== false;
  const archiveId = String(input.archiveId || input.id || '').trim();
  if (!archiveId) throw new Error('archiveId is required');
  const { root } = sessionTrashPaths(options);
  const entries = await readSessionTrashIndex(options);
  const index = entries.findIndex((entry) => entry.id === archiveId);
  if (index < 0) throw new Error('Archived session not found');
  const entry = entries[index];
  const archivePath = path.resolve(String(entry.archivePath || ''));
  if (!isPathInside(archivePath, root)) throw new Error('Archived session path is outside trash root');
  const rawTargetPath = String(input.targetPath || entry.originalPath || '').trim();
  if (!rawTargetPath) throw new Error('Restore target path is required');
  const targetPath = path.resolve(rawTargetPath);
  const tool = normalizeTool(input.tool || entry.tool || '');
  const roots = sessionRootCandidates(options, tool);
  if (!roots.some((sessionRoot) => isPathInside(targetPath, sessionRoot))) {
    throw new Error('Restore target is outside known session roots');
  }
  const exists = await pathExists(archivePath);
  if (!exists) throw new Error('Archived session file is missing');
  const targetExists = await pathExists(targetPath);
  const overwrite = Boolean(input.overwrite);
  if (targetExists && !overwrite) {
    return {
      schema: 'easyaiconfig.session-restore.v1',
      dryRun,
      changed: false,
      trashRoot: root,
      entry,
      operations: [{
        action: 'restore-session',
        status: 'conflict',
        reason: 'target_exists',
        archivePath,
        targetPath,
      }],
      summary: { restored: 0, conflicts: 1, previewed: 0 },
    };
  }
  const operation = {
    action: 'restore-session',
    status: dryRun ? 'preview' : 'restored',
    archivePath,
    targetPath,
    overwrite,
  };
  if (!dryRun) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(archivePath, targetPath);
    entries[index] = {
      ...entry,
      restoredAt: new Date().toISOString(),
      restoredPath: targetPath,
    };
    await writeSessionTrashIndex(entries, options);
  }
  return {
    schema: 'easyaiconfig.session-restore.v1',
    dryRun,
    changed: !dryRun,
    trashRoot: root,
    entry: dryRun ? entry : entries[index],
    operations: [operation],
    summary: {
      restored: dryRun ? 0 : 1,
      conflicts: 0,
      previewed: dryRun ? 1 : 0,
    },
  };
}

function matchesSession(item, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  if (filters.tool && item.tool !== filters.tool) return false;
  if (filters.provider && item.provider !== filters.provider) return false;
  if (filters.project && item.projectKey !== filters.project && item.projectPath !== filters.project) return false;
  if (filters.cwd && item.cwd && !isSameOrNestedPath(item.cwd, filters.cwd)) return false;
  if (!query) return true;
  const haystack = [
    item.id,
    item.sessionId,
    item.tool,
    item.title,
    item.provider,
    item.model,
    item.cwd,
    item.projectKey,
    item.projectPath,
    item.sourcePath,
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

function groupByProviderProject(items = []) {
  const providers = new Map();
  for (const item of items) {
    const providerKey = item.provider || 'unknown';
    const projectKey = item.projectKey || item.projectPath || 'unknown';
    if (!providers.has(providerKey)) {
      providers.set(providerKey, { provider: providerKey, count: 0, latestAtMs: 0, projects: new Map() });
    }
    const provider = providers.get(providerKey);
    provider.count += 1;
    provider.latestAtMs = Math.max(provider.latestAtMs, Number(item.updatedAtMs || 0));
    if (!provider.projects.has(projectKey)) {
      provider.projects.set(projectKey, {
        projectKey,
        projectPath: item.projectPath || '',
        count: 0,
        latestAtMs: 0,
        tools: {},
      });
    }
    const project = provider.projects.get(projectKey);
    project.count += 1;
    project.latestAtMs = Math.max(project.latestAtMs, Number(item.updatedAtMs || 0));
    project.tools[item.tool] = (project.tools[item.tool] || 0) + 1;
  }
  return [...providers.values()]
    .map((provider) => ({
      provider: provider.provider,
      count: provider.count,
      latestAt: provider.latestAtMs ? new Date(provider.latestAtMs).toISOString() : '',
      projects: [...provider.projects.values()]
        .sort((a, b) => Number(b.latestAtMs || 0) - Number(a.latestAtMs || 0))
        .map((project) => ({
          projectKey: project.projectKey,
          projectPath: project.projectPath,
          count: project.count,
          latestAt: project.latestAtMs ? new Date(project.latestAtMs).toISOString() : '',
          tools: project.tools,
        })),
    }))
    .sort((a, b) => Number(Date.parse(b.latestAt || '') || 0) - Number(Date.parse(a.latestAt || '') || 0));
}

export async function listSessionInventory(options = {}) {
  const includeTools = Array.isArray(options.includeTools) && options.includeTools.length
    ? options.includeTools.map(normalizeTool).filter(Boolean)
    : DEFAULT_TOOLS;
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
  const sourceLimit = Math.max(limit, Math.min(1000, Number(options.sourceLimit || limit * 3)));
  const sourceOptions = { ...options, limit, sourceLimit };
  const sources = [];

  if (includeTools.includes('codex')) sources.push(await readCodexSource(sourceOptions));
  if (includeTools.includes('claudecode')) sources.push(await readClaudeSource(sourceOptions));
  if (includeTools.includes('opencode')) sources.push(await readOpenCodeSource(sourceOptions));
  for (const tool of includeTools) {
    const meta = SESSION_BACKED_TOOL_META[tool];
    if (!meta) continue;
    sources.push(await readGenericSource({
      tool,
      label: meta.label,
      roots: meta.roots(sourceOptions),
      provider: meta.provider,
      options: sourceOptions,
      capabilities: { delete: Boolean(meta.canDelete) },
    }));
  }

  const filters = {
    query: String(options.query || '').trim(),
    tool: String(options.tool || '').trim(),
    provider: String(options.provider || '').trim(),
    project: String(options.project || '').trim(),
    cwd: String(options.cwd || '').trim(),
  };
  const allItems = sources.flatMap((source) => source.items);
  const filteredItems = allItems
    .filter((item) => matchesSession(item, filters))
    .sort((left, right) => Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0));
  const items = filteredItems.slice(0, limit);

  return {
    schema: 'easyaiconfig.session-inventory.v1',
    generatedAt: new Date().toISOString(),
    filters,
    sources,
    items,
    groups: groupByProviderProject(filteredItems),
    summary: {
      sources: sources.length,
      existingSources: sources.filter((source) => source.exists).length,
      readErrors: sources.filter((source) => source.readError).length,
      sessions: filteredItems.length,
      returned: items.length,
      tools: Object.fromEntries(sources.map((source) => [source.tool, source.count])),
      providers: Object.fromEntries(groupByProviderProject(filteredItems).map((group) => [group.provider, group.count])),
    },
  };
}
