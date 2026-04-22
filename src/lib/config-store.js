import fs from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import TOML from '@iarna/toml';
import { detectProvider } from './provider-check.js';

const APP_HOME_DIRNAME = '.codex-config-ui';
const BACKUPS_DIRNAME = 'backups';
const OPENAI_CODEX_PACKAGE = '@openai/codex';
const OPENCODE_PACKAGE = 'opencode-ai';
const OPENCODE_INSTALL_SCRIPT_UNIX = 'curl -fsSL https://opencode.ai/install | bash';
const OPENCODE_INSTALL_TASK_TTL_MS = 30 * 60 * 1000;
const OPENCODE_INSTALL_TASKS = new Map();
const OPENCLAW_INSTALL_TASK_TTL_MS = 30 * 60 * 1000;
const OPENCLAW_INSTALL_TASKS = new Map();
const OPENCLAW_NPM_REGISTRY_CN = 'https://registry.npmmirror.com';

let opencodeInstallTaskSeq = 0;
let openclawInstallTaskSeq = 0;
const OPENCLAW_INSTALL_SCRIPT_UNIX = 'curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm';
const OPENCLAW_INSTALL_SCRIPT_WIN = "$env:OPENCLAW_NO_ONBOARD='1'; iwr -useb https://openclaw.ai/install.ps1 | iex";

/* ═══════════════  Tool Registry  ═══════════════ */
const TOOL_REGISTRY = {
  codex: {
    id: 'codex',
    name: 'Codex CLI',
    description: 'OpenAI 官方 AI 编程助手',
    configHome: () => process.env.CODEX_HOME?.trim()
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(os.homedir(), '.codex'),
    configFormat: 'toml',
    configFileName: 'config.toml',
    envFileName: '.env',
    binaryName: 'codex',
    npmPackage: '@openai/codex',
    installMethod: 'npm',
    providerKeyField: 'model_provider',
    projectConfigDir: '.codex',
    supported: true,
  },
  claudecode: {
    id: 'claudecode',
    name: 'Claude Code',
    description: 'Anthropic 终端原生 AI 编程助手',
    configHome: () => path.join(os.homedir(), '.claude'),
    configFormat: 'json',
    configFileName: 'settings.json',
    envFileName: null,
    binaryName: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    installMethod: 'npm',
    providerKeyField: null,
    projectConfigDir: '.claude',
    supported: true,
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    description: '开放式 AI 编程助手 CLI',
    configHome: () => process.platform === 'win32'
      ? path.join(process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming'), 'opencode')
      : path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'opencode'),
    configFormat: 'jsonc',
    configFileName: 'opencode.json',
    envFileName: null,
    binaryName: 'opencode',
    npmPackage: OPENCODE_PACKAGE,
    installMethod: 'auto',
    providerKeyField: null,
    projectConfigDir: '.opencode',
    supported: true,
    installMethods: process.platform === 'win32' ? ['auto', 'domestic', 'npm', 'scoop', 'choco'] : ['auto', 'domestic', 'script', 'brew', 'npm'],
  },
  openclaw: {
    id: 'openclaw',
    name: 'OpenClaw',
    description: '开源多渠道 AI 助手平台',
    configHome: () => path.join(os.homedir(), '.openclaw'),
    configFormat: 'json',
    configFileName: 'openclaw.json',
    envFileName: '.env',
    binaryName: 'openclaw',
    npmPackage: 'openclaw',
    installMethod: 'multi',
    providerKeyField: 'provider',
    projectConfigDir: '.openclaw',
    supported: true,
    installMethods: process.platform === 'win32' ? ['domestic', 'wsl', 'script'] : ['script', 'npm', 'source', 'docker'],
  },
};

function getToolDef(toolId) {
  return TOOL_REGISTRY[toolId] || TOOL_REGISTRY.codex;
}

function withWindowsHide(options = {}) {
  return process.platform === 'win32'
    ? { ...options, windowsHide: options.windowsHide ?? true }
    : options;
}

function runSpawn(command, args, options = {}) {
  return spawn(command, args, withWindowsHide(options));
}

function runSpawnSync(command, args, options = {}) {
  return spawnSync(command, args, withWindowsHide(options));
}

function safeResolveDir(dirPath) {
  if (!dirPath) return '';
  try {
    return path.resolve(String(dirPath).trim());
  } catch {
    return '';
  }
}

function assertAllowedPath(inputPath, paramName) {
  const normalized = safeResolveDir(inputPath);
  if (!normalized) {
    throw new Error(`${paramName} is required`);
  }
  const allowed = [os.homedir(), process.cwd(), '/tmp', '/var/tmp']
    .concat(process.platform === 'win32' ? [process.env.TEMP, process.env.TMP] : [])
    .filter(Boolean)
    .map((item) => path.resolve(item));
  const valid = allowed.some((root) => normalized === root || normalized.startsWith(root + path.sep));
  if (!valid) {
    throw new Error(`Invalid ${paramName}: path traversal detected`);
  }
  return normalized;
}

function resolveBackupDir(backupName) {
  const safeName = String(backupName || '').trim();
  if (!safeName) throw new Error('Backup name is required');
  if (path.basename(safeName) !== safeName) {
    throw new Error('Invalid backup name');
  }
  const root = backupsRoot();
  const resolved = path.resolve(root, safeName);
  if (resolved !== path.join(root, safeName)) {
    throw new Error('Invalid backup name');
  }
  return resolved;
}

function managerGlobalBinDirs() {
  const home = os.homedir();
  const dirs = new Set();
  const add = (dirPath) => {
    const resolved = safeResolveDir(dirPath);
    if (resolved) dirs.add(resolved);
  };

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    const localAppData = process.env.LOCALAPPDATA?.trim();
    add(windowsUserNpmPrefix());
    add(appData ? path.join(appData, 'npm') : '');
    add(process.env.BUN_INSTALL?.trim() ? path.join(process.env.BUN_INSTALL.trim(), 'bin') : path.join(home, '.bun', 'bin'));
    add(process.env.PNPM_HOME?.trim() || (localAppData ? path.join(localAppData, 'pnpm') : ''));
    add(localAppData ? path.join(localAppData, 'Yarn', 'bin') : '');
    add(localAppData ? path.join(localAppData, 'Volta', 'bin') : '');
    add(path.join(home, '.volta', 'bin'));
  } else {
    add(process.env.BUN_INSTALL?.trim() ? path.join(process.env.BUN_INSTALL.trim(), 'bin') : path.join(home, '.bun', 'bin'));
    add(process.env.PNPM_HOME?.trim());
    add(path.join(home, 'Library', 'pnpm')); // macOS
    add(path.join(home, '.local', 'share', 'pnpm')); // Linux
    add(path.join(home, '.pnpm'));
    add(path.join(home, '.yarn', 'bin'));
    add(path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'));
    add(path.join(home, '.volta', 'bin'));
    add(path.join(home, '.asdf', 'shims'));
    add(path.join(home, '.npm-global', 'bin'));
    add(path.join(home, '.local', 'bin'));
  }

  return [...dirs];
}

function binaryCandidatesFromDir(binaryName, dirPath) {
  if (!dirPath) return [];
  if (process.platform === 'win32') {
    return [
      path.join(dirPath, `${binaryName}.cmd`),
      path.join(dirPath, `${binaryName}.ps1`),
      path.join(dirPath, `${binaryName}.exe`),
      path.join(dirPath, binaryName),
    ];
  }
  return [path.join(dirPath, binaryName)];
}

function readManagerBinDir(command, args = []) {
  const result = runSpawnSync(command, args, { encoding: 'utf8', timeout: 1500 });
  if (result.status !== 0) return '';
  const text = String(result.stdout || '').split(/\r?\n/).find((line) => line.trim()) || '';
  return safeResolveDir(text);
}

function managerReportedBinDirs() {
  const dirs = new Set();
  const add = (value) => {
    const resolved = safeResolveDir(value);
    if (resolved) dirs.add(resolved);
  };

  if (commandExists(process.platform === 'win32' ? 'bun.exe' : 'bun')) {
    add(readManagerBinDir(process.platform === 'win32' ? 'bun.exe' : 'bun', ['pm', 'bin', '-g']));
  }
  if (commandExists(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')) {
    add(readManagerBinDir(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['bin', '-g']));
  }
  if (commandExists(process.platform === 'win32' ? 'yarn.cmd' : 'yarn')) {
    add(readManagerBinDir(process.platform === 'win32' ? 'yarn.cmd' : 'yarn', ['global', 'bin']));
  }

  return [...dirs];
}

function voltaWhichBinary(binaryName) {
  const voltaCmd = process.platform === 'win32' ? 'volta.exe' : 'volta';
  if (!commandExists(voltaCmd)) return '';
  const result = runSpawnSync(voltaCmd, ['which', binaryName], { encoding: 'utf8', timeout: 1500 });
  if (result.status !== 0) return '';
  const line = String(result.stdout || '').split(/\r?\n/).find((item) => item.trim()) || '';
  const resolved = safeResolveDir(line);
  return resolved && existsSync(resolved) ? resolved : '';
}

function toolBinaryCandidates(toolId) {
  const tool = getToolDef(toolId);
  const binaryName = tool.binaryName;
  const candidates = new Set();
  const addCandidate = (candidate) => {
    if (candidate) candidates.add(candidate);
  };

  if (process.platform === 'win32') {
    const preferredPrefix = toolId === 'openclaw' ? openClawNpmPrefix() : npmGlobalPrefix();
    const appData = process.env.APPDATA?.trim();
    const home = os.homedir();
    const winCandidates = [
      ...binaryCandidatesFromDir(binaryName, preferredPrefix),
      ...binaryCandidatesFromDir(binaryName, appData ? path.join(appData, 'npm') : ''),
      ...(toolId === 'openclaw' ? binaryCandidatesFromDir(binaryName, path.join(home, '.local', 'bin')) : []),
      ...(toolId === 'opencode' ? binaryCandidatesFromDir(binaryName, path.join(home, 'scoop', 'shims')) : []),
      ...(toolId === 'opencode' ? binaryCandidatesFromDir(binaryName, path.join(process.env.ProgramData || 'C:\ProgramData', 'chocolatey', 'bin')) : []),
    ];
    winCandidates.filter(Boolean).forEach((candidate) => {
      if (existsSync(candidate)) addCandidate(candidate);
    });
  } else {
    const npmPrefix = npmGlobalPrefix();
    for (const unixCandidate of binaryCandidatesFromDir(binaryName, npmPrefix ? path.join(npmPrefix, 'bin') : '')) {
      if (unixCandidate && existsSync(unixCandidate)) addCandidate(unixCandidate);
    }
    if (toolId === 'opencode') {
      const home = os.homedir();
      const extraDirs = [
        process.env.OPENCODE_INSTALL_DIR?.trim(),
        process.env.XDG_BIN_DIR?.trim(),
        path.join(home, 'bin'),
        path.join(home, '.opencode', 'bin'),
      ].filter(Boolean);
      for (const dirPath of extraDirs) {
        for (const unixCandidate of binaryCandidatesFromDir(binaryName, dirPath)) {
          if (unixCandidate && existsSync(unixCandidate)) addCandidate(unixCandidate);
        }
      }
    }
  }

  for (const dirPath of [...managerGlobalBinDirs(), ...managerReportedBinDirs()]) {
    for (const candidate of binaryCandidatesFromDir(binaryName, dirPath)) {
      if (candidate && existsSync(candidate)) addCandidate(candidate);
    }
  }

  const voltaCandidate = voltaWhichBinary(binaryName);
  if (voltaCandidate) addCandidate(voltaCandidate);

  const lookupResult = runSpawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    [binaryName],
    { encoding: 'utf8' }
  );

  if (lookupResult.status === 0) {
    for (const line of String(lookupResult.stdout || '').split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate) addCandidate(candidate);
    }
  }

  return [...candidates];
}

function windowsBinaryCandidateRank(binPath = '') {
  const lower = String(binPath || '').toLowerCase();
  if (lower.endsWith('.cmd')) return 0;
  if (lower.endsWith('.exe')) return 1;
  if (lower.endsWith('.bat')) return 2;
  if (lower.endsWith('.ps1')) return 4;
  return 3;
}

function readBinaryVersion(binPath) {
  if (!binPath) return { installed: false, version: null, path: null };
  const lower = String(binPath || '').toLowerCase();
  const result = process.platform === 'win32' && lower.endsWith('.ps1')
    ? runSpawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', binPath, '--version'], { encoding: 'utf8' })
    : runSpawnSync(binPath, ['--version'], { encoding: 'utf8' });
  return {
    installed: result.status === 0,
    version: result.status === 0 ? (result.stdout || result.stderr || '').trim() : null,
    path: binPath,
  };
}

function findToolBinary(toolId) {
  const candidates = toolBinaryCandidates(toolId).map((candidatePath) => readBinaryVersion(candidatePath)).filter((item) => item.installed);
  candidates.sort((left, right) => {
    const versionOrder = compareVersions(right.version || '', left.version || '');
    if (versionOrder !== 0) return versionOrder;
    return windowsBinaryCandidateRank(left.path) - windowsBinaryCandidateRank(right.path);
  });
  const selected = candidates[0];
  return {
    installed: Boolean(selected),
    version: selected?.version || null,
    path: selected?.path || null,
    candidates,
  };
}

export function listTools() {
  return Object.values(TOOL_REGISTRY).map(tool => ({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    supported: tool.supported,
    configFormat: tool.configFormat,
    installMethod: tool.installMethod,
    npmPackage: tool.npmPackage,
    binary: findToolBinary(tool.id),
  }));
}

function defaultCodexHome() {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function createCodexUsageTotals() {
  return {
    input: 0,
    cachedInput: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
}

function createOpenCodeUsageTotals() {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheCreation: 0,
    total: 0,
    cost: 0,
  };
}

function addCodexUsageTotals(target, usage = {}) {
  target.input += Number(usage.input_tokens || 0);
  target.cachedInput += Number(usage.cached_input_tokens || 0);
  target.output += Number(usage.output_tokens || 0);
  target.reasoning += Number(usage.reasoning_output_tokens || 0);
  target.total += Number(usage.total_tokens || 0);
}

function addOpenCodeUsageTotals(target, usage = {}) {
  target.input += Number(usage.input || 0);
  target.output += Number(usage.output || 0);
  target.reasoning += Number(usage.reasoning || 0);
  target.cacheRead += Number(usage.cacheRead || 0);
  target.cacheCreation += Number(usage.cacheCreation || 0);
  target.total += Number(usage.total || 0);
  target.cost += Number(usage.cost || 0);
}

function normalizeCodexUsageSnapshot(usage = {}) {
  return {
    input_tokens: Math.max(0, Number(usage.input_tokens || 0)),
    cached_input_tokens: Math.max(0, Number(usage.cached_input_tokens || 0)),
    output_tokens: Math.max(0, Number(usage.output_tokens || 0)),
    reasoning_output_tokens: Math.max(0, Number(usage.reasoning_output_tokens || 0)),
    total_tokens: Math.max(0, Number(usage.total_tokens || 0)),
  };
}

function diffCodexUsageSnapshot(current = {}, previous = null) {
  const currentSnapshot = normalizeCodexUsageSnapshot(current);
  if (!previous) return currentSnapshot;
  return {
    input_tokens: Math.max(0, currentSnapshot.input_tokens - Number(previous.input_tokens || 0)),
    cached_input_tokens: Math.max(0, currentSnapshot.cached_input_tokens - Number(previous.cached_input_tokens || 0)),
    output_tokens: Math.max(0, currentSnapshot.output_tokens - Number(previous.output_tokens || 0)),
    reasoning_output_tokens: Math.max(0, currentSnapshot.reasoning_output_tokens - Number(previous.reasoning_output_tokens || 0)),
    total_tokens: Math.max(0, currentSnapshot.total_tokens - Number(previous.total_tokens || 0)),
  };
}

function readUsageIdentityValue(source, pathExpr) {
  if (!source || typeof source !== 'object') return '';
  let value = source;
  for (const part of String(pathExpr || '').split('.')) {
    if (!part) continue;
    if (!value || typeof value !== 'object') return '';
    value = value[part];
  }
  return (typeof value === 'string' || typeof value === 'number') ? String(value).trim() : '';
}

function pickUsageIdentityValue(sources = [], pathExprs = []) {
  for (const pathExpr of pathExprs) {
    for (const source of sources) {
      const value = readUsageIdentityValue(source, pathExpr);
      if (value) return value;
    }
  }
  return '';
}

function buildUsageRequestKey({ sessionKey = '', sources = [], idPaths = [], parentPaths = [] } = {}) {
  const requestId = pickUsageIdentityValue(sources, idPaths);
  if (!requestId) return '';
  const parentId = pickUsageIdentityValue(sources, parentPaths);
  return [sessionKey, requestId, parentId].filter(Boolean).join(':');
}

function normalizeUnixTimestampMs(value) {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 1e12 ? raw : raw * 1000;
}

function resolveMaybeHomePath(input, fallbackDir = os.homedir()) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const expanded = raw === '~'
    ? os.homedir()
    : (raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
  return path.resolve(fallbackDir, expanded);
}

async function listCodexSqliteCandidates(codexHome) {
  const normalizedCodexHome = path.resolve(codexHome);
  const configToml = parseToml(await readText(path.join(normalizedCodexHome, 'config.toml')));
  const candidateRoots = [
    resolveMaybeHomePath(configToml.sqlite_home || '', normalizedCodexHome),
    normalizedCodexHome,
  ].filter(Boolean);
  const dbFiles = [];

  for (const rootDir of [...new Set(candidateRoots)]) {
    let entries = [];
    try {
      entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^state.*\.sqlite$/i.test(entry.name)) continue;
      const filePath = path.join(rootDir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        dbFiles.push({ filePath, mtimeMs: stat.mtimeMs || 0 });
      } catch {
        continue;
      }
    }
  }

  return dbFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function getSqliteTableColumns(sqlite3Path, dbPath, tableName) {
  const schemaResult = await runCommand(sqlite3Path, [
    '-json',
    dbPath,
    `PRAGMA table_info(${tableName});`,
  ]);
  if (!schemaResult.ok) return null;

  try {
    const rows = JSON.parse(String(schemaResult.stdout || '[]'));
    return new Set(
      Array.isArray(rows)
        ? rows.map((row) => String(row?.name || '').trim()).filter(Boolean)
        : []
    );
  } catch {
    return null;
  }
}

async function listRecentCodexSessionFilesFromSqlite(codexHome, dayCount) {
  const sqlite3Path = commandExists('sqlite3');
  if (!sqlite3Path) return [];

  const dbEntry = (await listCodexSqliteCandidates(codexHome))[0];
  if (!dbEntry?.filePath) return [];

  const availableColumns = await getSqliteTableColumns(sqlite3Path, dbEntry.filePath, 'threads');
  if (!availableColumns?.has('rollout_path') || !availableColumns.has('updated_at')) return [];

  const result = await runCommand(sqlite3Path, [
    '-json',
    dbEntry.filePath,
    `SELECT rollout_path
     FROM threads
     WHERE updated_at >= strftime('%s', 'now', '-${dayCount} days')
       AND rollout_path != ''
     ORDER BY updated_at DESC`.replace(/\s+/g, ' ').trim(),
  ]);
  if (!result.ok) return [];

  let rows = [];
  try {
    rows = JSON.parse(String(result.stdout || '[]'));
  } catch {
    return [];
  }

  const files = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const filePath = String(row?.rollout_path || '').trim();
    if (!filePath || seen.has(filePath) || !existsSync(filePath)) continue;
    seen.add(filePath);
    files.push(filePath);
  }
  return files;
}

function sqliteLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function dashboardCacheDbPath() {
  return path.join(appHome(), 'dashboard-cache.sqlite');
}

async function ensureDashboardCacheSqlite() {
  const sqlite3Path = commandExists('sqlite3');
  if (!sqlite3Path) return null;

  const dbPath = dashboardCacheDbPath();
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const result = await runCommand(sqlite3Path, [
    dbPath,
    `CREATE TABLE IF NOT EXISTS codex_usage_cache (
      codex_home TEXT NOT NULL,
      days INTEGER NOT NULL,
      payload TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'sessions',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (codex_home, days)
    );`.replace(/\s+/g, ' ').trim(),
  ]);
  if (!result.ok) return null;
  return { sqlite3Path, dbPath };
}

async function readCodexUsageFromDashboardCacheSqlite(codexHome, dayCount) {
  const cache = await ensureDashboardCacheSqlite();
  if (!cache) return null;

  const result = await runCommand(cache.sqlite3Path, [
    '-json',
    cache.dbPath,
    `SELECT payload, updated_at
     FROM codex_usage_cache
     WHERE codex_home = ${sqliteLiteral(path.resolve(codexHome))}
       AND days = ${Math.max(1, Number(dayCount) || 30)}
     LIMIT 1`.replace(/\s+/g, ' ').trim(),
  ]);
  if (!result.ok) return null;

  let rows = [];
  try {
    rows = JSON.parse(String(result.stdout || '[]'));
  } catch {
    return null;
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.payload) return null;

  try {
    const payload = JSON.parse(String(row.payload));
    if (!payload || typeof payload !== 'object') return null;
    payload.cacheUpdatedAt = Number(row.updated_at || 0) || Date.now();
    return payload;
  } catch {
    return null;
  }
}

async function saveCodexUsageToDashboardCacheSqlite(codexHome, dayCount, metrics) {
  const cache = await ensureDashboardCacheSqlite();
  if (!cache || !metrics || typeof metrics !== 'object') return false;

  const payload = JSON.stringify(metrics);
  const updatedAt = Date.now();
  const sql = `
    INSERT INTO codex_usage_cache (codex_home, days, payload, source_type, updated_at)
    VALUES (${sqliteLiteral(path.resolve(codexHome))}, ${Math.max(1, Number(dayCount) || 30)}, ${sqliteLiteral(payload)}, ${sqliteLiteral(String(metrics.sourceType || 'sessions'))}, ${updatedAt})
    ON CONFLICT(codex_home, days) DO UPDATE SET
      payload = excluded.payload,
      source_type = excluded.source_type,
      updated_at = excluded.updated_at;
  `.replace(/\s+/g, ' ').trim();

  const result = await runCommand(cache.sqlite3Path, [cache.dbPath, sql]);
  return Boolean(result.ok);
}

async function readCodexUsageFromSqlite(codexHome, dayCount) {
  const sqlite3Path = commandExists('sqlite3');
  if (!sqlite3Path) return null;

  const dbEntry = (await listCodexSqliteCandidates(codexHome))[0];
  if (!dbEntry?.filePath) return null;

  const availableColumns = await getSqliteTableColumns(sqlite3Path, dbEntry.filePath, 'threads');
  if (!availableColumns?.has('id') || !availableColumns.has('updated_at') || !availableColumns.has('created_at') || !availableColumns.has('tokens_used')) {
    return null;
  }

  const hasModelColumn = availableColumns.has('model');
  const hasRolloutPath = availableColumns.has('rollout_path');

  const selectExpr = [
    'id',
    'updated_at',
    'created_at',
    availableColumns.has('model_provider') ? 'model_provider' : "'' AS model_provider",
    hasModelColumn ? 'model' : "'' AS model",
    availableColumns.has('cwd') ? 'cwd' : "'' AS cwd",
    availableColumns.has('title') ? 'title' : "'' AS title",
    'tokens_used',
    hasRolloutPath ? 'rollout_path' : "'' AS rollout_path",
  ].join(', ');

  const result = await runCommand(sqlite3Path, [
    '-json',
    dbEntry.filePath,
    `SELECT ${selectExpr}
     FROM threads
     WHERE updated_at >= strftime('%s', 'now', '-${dayCount} days')
     ORDER BY updated_at DESC`.replace(/\s+/g, ' ').trim(),
  ]);
  if (!result.ok) return null;

  let rows = [];
  try {
    rows = JSON.parse(String(result.stdout || '[]'));
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;

  // If threads table has no model column, extract model from JSONL files via rollout_path
  const modelCache = new Map(); // rollout_path -> model name
  if (!hasModelColumn && hasRolloutPath) {
    for (const row of rows) {
      const rolloutPath = String(row?.rollout_path || '').trim();
      if (!rolloutPath || modelCache.has(rolloutPath)) continue;
      modelCache.set(rolloutPath, ''); // placeholder
      try {
        // Read only first 16KB - turn_context is near the top of the file
        const fd = await fs.open(rolloutPath, 'r');
        try {
          const buf = Buffer.alloc(16384);
          const { bytesRead } = await fd.read(buf, 0, 16384, 0);
          const chunk = buf.toString('utf8', 0, bytesRead);
          for (const line of chunk.split(/\r?\n/)) {
            if (!line.includes('turn_context')) continue;
            try {
              const ev = JSON.parse(line);
              if (ev.type === 'turn_context') {
                const m = String(ev.payload?.model || '').trim();
                if (m) {
                  modelCache.set(rolloutPath, m);
                  break;
                }
              }
            } catch {
              // skip malformed lines
            }
          }
        } finally {
          await fd.close();
        }
      } catch {
        // file not readable, skip
      }
    }
  }

  const totals = createCodexUsageTotals();
  const byDay = new Map();
  const byProvider = new Map();
  const byModel = new Map();
  const sessions = [];

  for (const row of rows) {
    const totalTokens = Number(row?.tokens_used || 0);
    const updatedAt = normalizeUnixTimestampMs(row?.updated_at || row?.created_at || 0);
    if (!updatedAt) continue;

    totals.total += totalTokens;
    const providerKey = String(row?.model_provider || 'unknown').trim() || 'unknown';
    // Use model from column, or from JSONL extraction, or fallback to 'unknown'
    const rolloutPath = String(row?.rollout_path || '').trim();
    const modelKey = String(row?.model || '').trim()
      || (rolloutPath && modelCache.get(rolloutPath)) || 'unknown';
    const dayKey = new Date(updatedAt).toISOString().slice(0, 10);

    if (!byDay.has(dayKey)) byDay.set(dayKey, createCodexUsageTotals());
    byDay.get(dayKey).total += totalTokens;

    if (!byProvider.has(providerKey)) byProvider.set(providerKey, { provider: providerKey, totals: createCodexUsageTotals(), events: 0 });
    byProvider.get(providerKey).totals.total += totalTokens;
    byProvider.get(providerKey).events += 1;

    if (!byModel.has(modelKey)) byModel.set(modelKey, { model: modelKey, totals: createCodexUsageTotals(), events: 0 });
    byModel.get(modelKey).totals.total += totalTokens;
    byModel.get(modelKey).events += 1;

    sessions.push({
      sessionId: String(row?.id || '').trim(),
      provider: providerKey,
      model: modelKey,
      cwd: String(row?.cwd || '').trim(),
      updatedAt,
      input: 0,
      cachedInput: 0,
      output: 0,
      reasoning: 0,
      total: totalTokens,
      title: String(row?.title || '').trim(),
    });
  }

  return {
    ok: true,
    days: dayCount,
    source: dbEntry.filePath,
    sourceType: 'sqlite',
    generatedAt: new Date().toISOString(),
    totals,
    daily: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, sum]) => ({ date, ...sum })),
    providers: [...byProvider.values()].sort((a, b) => b.totals.total - a.totals.total),
    models: [...byModel.values()].sort((a, b) => b.totals.total - a.totals.total),
    sessions: sessions.slice(0, 12),
  };
}

async function listFilesRecursive(rootDir) {
  const result = [];
  async function walk(currentDir) {
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) result.push(full);
    }
  }
  await walk(rootDir);
  return result;
}

export async function getCodexUsageMetrics({ codexHome = defaultCodexHome(), days = 30, force = false, cacheOnly = false } = {}) {
  const normalizedCodexHome = path.resolve(codexHome);
  const sessionsRoot = path.join(normalizedCodexHome, 'sessions');
  const dayCount = Math.max(1, Math.min(90, Number(days) || 30));

  // ── Path 1: Read from dashboard cache SQLite ──
  if (!force) {
    const cached = await readCodexUsageFromDashboardCacheSqlite(normalizedCodexHome, dayCount);
    if (cached) {
      return {
        ...cached,
        sourceType: 'dashboard-cache-sqlite',
        source: cached.source || dashboardCacheDbPath(),
      };
    }
  }

  // cacheOnly but no cache → return empty
  if (cacheOnly) {
    return {
      ok: true, days: dayCount, source: '', sourceType: 'none',
      generatedAt: new Date().toISOString(),
      totals: createCodexUsageTotals(), daily: [], providers: [], models: [], sessions: [],
    };
  }

  // ── Path 2: Scan JSONL files → build metrics → save to cache ──
  const now = Date.now();
  const windowStartMs = now - dayCount * 24 * 60 * 60 * 1000;
  const totals = createCodexUsageTotals();
  const byDay = new Map();
  const byProvider = new Map();
  const byModel = new Map();
  const bySession = new Map();

  // Get session file list from Codex's own SQLite (for speed), fallback to directory walk
  const sessionFiles = await listRecentCodexSessionFilesFromSqlite(normalizedCodexHome, dayCount);

  for (const filePath of (sessionFiles.length ? sessionFiles : await listFilesRecursive(sessionsRoot))) {
    if (!filePath.endsWith('.jsonl')) continue;
    let content = '';
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    let sessionId = '';
    let provider = '';
    let cwd = '';
    let currentModel = '';
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }

      // Extract session metadata
      if (event.type === 'session_meta') {
        sessionId = String(event.payload?.id || sessionId || '').trim();
        provider = String(event.payload?.model_provider || provider || '').trim();
        cwd = String(event.payload?.cwd || cwd || '').trim();
        const sessionModel = String(event.payload?.model || '').trim();
        if (sessionModel) currentModel = sessionModel;
        continue;
      }

      // Extract model from turn_context (most reliable source)
      if (event.type === 'turn_context') {
        const turnModel = String(event.payload?.model || '').trim();
        if (turnModel) currentModel = turnModel;
        continue;
      }

      // Process token_count events
      const payload = event.payload || {};
      if (event.type !== 'event_msg' || payload.type !== 'token_count') continue;
      const ts = Date.parse(String(event.timestamp || ''));
      if (!Number.isFinite(ts) || ts < windowStartMs) continue;
      const sessionKey = sessionId || path.basename(filePath, '.jsonl');
      const providerKey = provider || 'unknown';

      if (!bySession.has(sessionKey)) {
        bySession.set(sessionKey, {
          sessionId: sessionKey,
          provider: providerKey,
          model: currentModel || 'unknown',
          cwd,
          totals: createCodexUsageTotals(),
          updatedAt: ts,
          requestUsageSnapshots: new Map(),
          lastTotalUsage: null,
          lastUsageSignature: '',
        });
      }

      const item = bySession.get(sessionKey);
      item.updatedAt = Math.max(item.updatedAt || ts, ts);
      if (!item.cwd && cwd) item.cwd = cwd;
      if (!item.provider && providerKey) item.provider = providerKey;
      if (currentModel && item.model === 'unknown') item.model = currentModel;

      const info = payload.info || {};
      const requestKey = buildUsageRequestKey({
        sessionKey,
        sources: [info, payload, event],
        idPaths: ['request_id', 'requestId', 'request.id', 'response_id', 'responseId', 'completion_id', 'completionId', 'turn_id', 'turnId', 'message_id', 'messageId', 'id', 'uuid'],
        parentPaths: ['parent_uuid', 'parentUuid', 'parent_id', 'parentId'],
      });
      const totalUsage = info.total_token_usage;
      let usage = null;
      if (totalUsage) {
        const currentSnapshot = normalizeCodexUsageSnapshot(totalUsage);
        if (requestKey) {
          const previousSnapshot = item.requestUsageSnapshots.get(requestKey) || null;
          usage = diffCodexUsageSnapshot(currentSnapshot, previousSnapshot);
          if (previousSnapshot && currentSnapshot.total_tokens < Number(previousSnapshot.total_tokens || 0)) usage = currentSnapshot;
          item.requestUsageSnapshots.set(requestKey, currentSnapshot);
        } else {
          usage = diffCodexUsageSnapshot(currentSnapshot, item.lastTotalUsage);
          item.lastTotalUsage = currentSnapshot;
        }
      } else if (info.last_token_usage) {
        const lastUsage = normalizeCodexUsageSnapshot(info.last_token_usage);
        if (requestKey) {
          const previousSnapshot = item.requestUsageSnapshots.get(requestKey) || null;
          usage = diffCodexUsageSnapshot(lastUsage, previousSnapshot);
          if (previousSnapshot && lastUsage.total_tokens < Number(previousSnapshot.total_tokens || 0)) usage = lastUsage;
          item.requestUsageSnapshots.set(requestKey, lastUsage);
        } else {
          const signature = JSON.stringify(lastUsage);
          if (signature === item.lastUsageSignature) continue;
          item.lastUsageSignature = signature;
          usage = lastUsage;
        }
      }
      if (!usage || !usage.total_tokens) continue;

      addCodexUsageTotals(totals, usage);
      const dayKey = new Date(ts).toISOString().slice(0, 10);
      if (!byDay.has(dayKey)) byDay.set(dayKey, createCodexUsageTotals());
      addCodexUsageTotals(byDay.get(dayKey), usage);

      if (!byProvider.has(providerKey)) byProvider.set(providerKey, { provider: providerKey, totals: createCodexUsageTotals(), events: 0 });
      addCodexUsageTotals(byProvider.get(providerKey).totals, usage);
      byProvider.get(providerKey).events += 1;

      const modelKey = currentModel || payload.info?.model || 'unknown';
      if (!byModel.has(modelKey)) byModel.set(modelKey, { model: modelKey, totals: createCodexUsageTotals(), events: 0 });
      addCodexUsageTotals(byModel.get(modelKey).totals, usage);
      byModel.get(modelKey).events += 1;

      addCodexUsageTotals(item.totals, usage);
    }
  }

  const daily = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, sum]) => ({ date, ...sum }));
  const providers = [...byProvider.values()].sort((a, b) => b.totals.total - a.totals.total);
  const models = [...byModel.values()].sort((a, b) => b.totals.total - a.totals.total);
  const sessions = [...bySession.values()].filter((item) => item.totals.total > 0).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12).map((item) => ({
    sessionId: item.sessionId,
    provider: item.provider,
    model: item.model,
    cwd: item.cwd,
    updatedAt: item.updatedAt,
    ...item.totals,
  }));

  const metrics = {
    ok: true,
    days: dayCount,
    source: dashboardCacheDbPath(),
    sourceType: 'dashboard-cache-sqlite',
    generatedAt: new Date().toISOString(),
    totals,
    daily,
    providers,
    models,
    sessions,
  };

  // Save to cache for future fast loads
  await saveCodexUsageToDashboardCacheSqlite(normalizedCodexHome, dayCount, metrics);
  return metrics;
}

export async function getOpenCodeUsageMetrics({ days = 30 } = {}) {
  const dayCount = Math.max(1, Math.min(90, Number(days) || 30));
  const dbPath = path.join(openCodeGlobalDataDir(), 'opencode.db');
  const emptyMetrics = () => ({
    ok: true,
    days: dayCount,
    source: dbPath,
    sourceType: 'sqlite',
    generatedAt: new Date().toISOString(),
    totals: createOpenCodeUsageTotals(),
    daily: [],
    providers: [],
    models: [],
    sessions: [],
  });

  if (!existsSync(dbPath)) return emptyMetrics();

  const sqlite3Path = commandExists('sqlite3');
  if (!sqlite3Path) {
    return {
      ...emptyMetrics(),
      sourceType: 'sqlite3-unavailable',
    };
  }

  const sql = `
    SELECT
      m.id,
      m.session_id,
      m.time_created,
      s.time_updated AS session_time_updated,
      s.title,
      s.directory,
      COALESCE(json_extract(m.data, '$.providerID'), '') AS provider_id,
      COALESCE(json_extract(m.data, '$.modelID'), '') AS model_id,
      COALESCE(json_extract(m.data, '$.cost'), 0) AS cost,
      COALESCE(json_extract(m.data, '$.tokens.input'), 0) AS input,
      COALESCE(json_extract(m.data, '$.tokens.output'), 0) AS output,
      COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0) AS reasoning,
      COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) AS cache_read,
      COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0) AS cache_write,
      COALESCE(
        json_extract(m.data, '$.tokens.total'),
        COALESCE(json_extract(m.data, '$.tokens.input'), 0)
          + COALESCE(json_extract(m.data, '$.tokens.output'), 0)
          + COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0)
          + COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0)
          + COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0)
      ) AS total
    FROM message m
    JOIN session s ON s.id = m.session_id
    WHERE m.time_created >= (strftime('%s', 'now', '-${dayCount} days') * 1000)
      AND json_extract(m.data, '$.role') = 'assistant'
    ORDER BY m.time_created DESC
  `.replace(/\s+/g, ' ').trim();

  const result = await runCommand(sqlite3Path, ['-json', dbPath, sql]);
  if (!result.ok) {
    throw new Error((result.stderr || result.stdout || '读取 OpenCode 用量失败').trim());
  }

  let rows = [];
  try {
    rows = JSON.parse(String(result.stdout || '[]'));
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows) || !rows.length) return emptyMetrics();

  const totals = createOpenCodeUsageTotals();
  const byDay = new Map();
  const byProvider = new Map();
  const byModel = new Map();
  const bySession = new Map();

  for (const row of rows) {
    const usage = {
      input: Math.max(0, Number(row?.input || 0)),
      output: Math.max(0, Number(row?.output || 0)),
      reasoning: Math.max(0, Number(row?.reasoning || 0)),
      cacheRead: Math.max(0, Number(row?.cache_read || 0)),
      cacheCreation: Math.max(0, Number(row?.cache_write || 0)),
      total: Math.max(0, Number(row?.total || 0)),
      cost: Math.max(0, Number(row?.cost || 0)),
    };
    if (!usage.total && !usage.cost) continue;

    const createdAt = normalizeUnixTimestampMs(row?.time_created || row?.session_time_updated || 0);
    if (!createdAt) continue;
    const date = new Date(createdAt).toISOString().slice(0, 10);
    const provider = String(row?.provider_id || '').trim() || 'unknown';
    const model = String(row?.model_id || '').trim() || 'unknown';
    const sessionId = String(row?.session_id || row?.id || '').trim();

    addOpenCodeUsageTotals(totals, usage);

    if (!byDay.has(date)) byDay.set(date, createOpenCodeUsageTotals());
    addOpenCodeUsageTotals(byDay.get(date), usage);

    if (!byProvider.has(provider)) byProvider.set(provider, { provider, totals: createOpenCodeUsageTotals(), events: 0 });
    addOpenCodeUsageTotals(byProvider.get(provider).totals, usage);
    byProvider.get(provider).events += 1;

    if (!byModel.has(model)) byModel.set(model, { model, totals: createOpenCodeUsageTotals(), events: 0 });
    addOpenCodeUsageTotals(byModel.get(model).totals, usage);
    byModel.get(model).events += 1;

    if (!bySession.has(sessionId)) {
      bySession.set(sessionId, {
        sessionId,
        title: String(row?.title || '').trim(),
        cwd: String(row?.directory || '').trim(),
        provider,
        model,
        updatedAt: createdAt,
        ...createOpenCodeUsageTotals(),
      });
    }
    const session = bySession.get(sessionId);
    session.updatedAt = Math.max(Number(session.updatedAt || 0), createdAt);
    if (session.provider === 'unknown' && provider !== 'unknown') session.provider = provider;
    if (session.model === 'unknown' && model !== 'unknown') session.model = model;
    addOpenCodeUsageTotals(session, usage);
  }

  return {
    ok: true,
    days: dayCount,
    source: dbPath,
    sourceType: 'sqlite',
    generatedAt: new Date().toISOString(),
    totals,
    daily: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, sum]) => ({ date, ...sum })),
    providers: [...byProvider.values()].sort((a, b) => b.totals.total - a.totals.total),
    models: [...byModel.values()].sort((a, b) => b.totals.total - a.totals.total),
    sessions: [...bySession.values()]
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .slice(0, 12)
      .map((item) => ({
        ...item,
        updatedAt: new Date(Number(item.updatedAt || Date.now())).toISOString(),
      })),
  };
}

function appHome() {
  return path.join(os.homedir(), APP_HOME_DIRNAME);
}

function backupsRoot() {
  return path.join(appHome(), BACKUPS_DIRNAME);
}

async function readPathStorageUsage(targetPath) {
  const resolved = path.resolve(targetPath);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return { path: resolved, exists: false, isFile: false, bytes: 0, fileCount: 0 };
  }

  if (stat.isFile()) {
    return { path: resolved, exists: true, isFile: true, bytes: Number(stat.size || 0), fileCount: 1 };
  }

  const files = await listFilesRecursive(resolved);
  let bytes = 0;
  for (const filePath of files) {
    try {
      const fileStat = await fs.stat(filePath);
      bytes += Number(fileStat.size || 0);
    } catch { /* ignore per-file failures */ }
  }
  return { path: resolved, exists: true, isFile: false, bytes, fileCount: files.length };
}

function mapStorageEntry(key, label, usage) {
  return {
    key,
    label,
    path: usage.path,
    exists: Boolean(usage.exists),
    isFile: Boolean(usage.isFile),
    bytes: Number(usage.bytes || 0),
    fileCount: Number(usage.fileCount || 0),
  };
}

export async function getSystemStorageState() {
  const targets = [
    ['app_cache', '应用缓存', path.join(appHome(), 'cache')],
    ['backups', '配置备份', backupsRoot()],
    ['codex_home', 'Codex 数据', defaultCodexHome()],
    ['claude_home', 'Claude Code 数据', claudeCodeHome()],
    ['openclaw_home', 'OpenClaw 数据', openclawHome()],
  ];

  const entries = [];
  for (const [key, label, targetPath] of targets) {
    const usage = await readPathStorageUsage(targetPath);
    entries.push(mapStorageEntry(key, label, usage));
  }

  return {
    generatedAt: new Date().toISOString(),
    appHome: appHome(),
    entries,
    totalBytes: entries.reduce((sum, item) => sum + Number(item.bytes || 0), 0),
    totalFiles: entries.reduce((sum, item) => sum + Number(item.fileCount || 0), 0),
  };
}

export async function cleanupSystemStorage({ clearCache = true, clearBackups = false } = {}) {
  const removedPaths = [];
  const failedPaths = [];
  const candidates = [
    clearCache ? path.join(appHome(), 'cache') : '',
    clearBackups ? backupsRoot() : '',
  ].filter(Boolean);

  for (const target of candidates) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      removedPaths.push(target);
    } catch (error) {
      failedPaths.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ok: failedPaths.length === 0,
    removedPaths,
    failedPaths,
    state: await getSystemStorageState(),
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function parseCodexVersion(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?/i);
  if (!match) return null;
  return {
    raw: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prereleaseTag: match[4] || '',
    prereleaseNum: Number(match[5] || 0),
  };
}

function compareCodexVersions(left, right) {
  const a = parseCodexVersion(left);
  const b = parseCodexVersion(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (!a.prereleaseTag && b.prereleaseTag) return 1;
  if (a.prereleaseTag && !b.prereleaseTag) return -1;
  if (a.prereleaseTag !== b.prereleaseTag) return a.prereleaseTag.localeCompare(b.prereleaseTag);
  return a.prereleaseNum - b.prereleaseNum;
}

function commandExists(command) {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const result = runSpawnSync(lookup, [command], { encoding: 'utf8' });
  return result.status === 0 ? (result.stdout || '').split(/\r?\n/).find(Boolean) || null : null;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = runSpawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function openClawWindowsPowerShellArgs(scriptText) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', scriptText];
}

function tailText(text, count = 10) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join('\n');
}

function summarizeInstallCommandFailure(result) {
  const stderrTail = tailText(result?.stderr, 12);
  const stdoutTail = tailText(result?.stdout, 12);
  const merged = `${stderrTail}\n${stdoutTail}`.trim();
  const epermMatch = merged.match(/EPERM:.*?(?:mkdir|open) '([^']+)'/i) || merged.match(/error path\s+(.+)/i);
  if (epermMatch) {
    const targetPath = String(epermMatch[1] || "").trim();
    return `Windows 权限不足：npm 无法写入 ${targetPath || "目标目录"}。应用已自动尝试使用当前用户目录安装；如果仍失败，请以管理员身份启动应用，或先关闭占用该目录的杀毒/编辑器。`;
  }
  if (stderrTail && stdoutTail && !stderrTail.includes(stdoutTail)) return `${stderrTail}\n${stdoutTail}`.trim();
  return stderrTail || stdoutTail || `安装命令退出码：${result?.code}`;
}

function describeOpenClawVerificationFailure(task) {
  const snapshot = task?._installSnapshot || {};
  const foundBins = (snapshot.binPaths || []).filter((candidate) => candidate && existsSync(candidate));
  const packageInstalled = Boolean(snapshot.packagePath && existsSync(snapshot.packagePath));

  if (!packageInstalled && !foundBins.length) {
    return '安装命令已执行完成，但系统里仍未找到 `openclaw` 命令。';
  }

  const details = [];
  if (packageInstalled) details.push(`已检测到 npm 包目录：${snapshot.packagePath}`);
  if (foundBins.length) details.push(`已检测到可执行文件：${foundBins.join('、')}`);
  details.push('这通常是 Windows 的 PATH 还没刷新。应用已经自动改用当前用户目录安装，请重新打开 EasyAIConfig 或终端后再试。');
  return `OpenClaw 可能已经装上了，但当前进程还没识别到命令。${details.join(' ')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanupOpenClawInstallTasks() {
  const now = Date.now();
  for (const [taskId, task] of OPENCLAW_INSTALL_TASKS.entries()) {
    if (task.status !== 'running' && (now - task.updatedAtTs) > OPENCLAW_INSTALL_TASK_TTL_MS) {
      OPENCLAW_INSTALL_TASKS.delete(taskId);
    }
  }
  while (OPENCLAW_INSTALL_TASKS.size > 12) {
    const removable = [...OPENCLAW_INSTALL_TASKS.entries()].find(([, task]) => task.status !== 'running');
    if (!removable) break;
    OPENCLAW_INSTALL_TASKS.delete(removable[0]);
  }
}

function openClawInstallStepTemplate(method) {
  if (method === 'script') {
    return [
      { key: 'preflight', title: '检查运行环境', description: '确认脚本安装所需命令可用', hint: '这一步在确认系统具备安装条件，你不用操作。', progress: 8 },
      { key: 'download', title: '下载官方安装器', description: '从 OpenClaw 官方地址拉取安装脚本', hint: '如果网络慢，这一步可能停留几十秒，属于正常现象。', progress: 24 },
      { key: 'install', title: '执行安装脚本', description: '安装器正在写入程序和命令入口', hint: '看到日志滚动代表仍在工作，请不要关闭窗口。', progress: 62 },
      { key: 'verify', title: '验证命令是否可用', description: '检查 `openclaw` 是否已能直接运行', hint: '已经接近完成，正在做最后确认。', progress: 88 },
      { key: 'done', title: '整理下一步引导', description: '安装完成，准备告诉你接下来做什么', hint: '安装结束后，我会直接告诉你下一步。', progress: 100 },
    ];
  }

  if (method === 'domestic') {
    return [
      { key: 'preflight', title: '准备国内安装环境', description: '检查 Node.js、npm，并优先使用当前用户目录', hint: '这一步会尽量自动补齐缺失依赖，你不用手动处理。', progress: 8 },
      { key: 'download', title: '切换国内 npm 源', description: '使用 npmmirror 获取 OpenClaw 安装包和依赖', hint: '国内网络下通常会更稳、更快。', progress: 26 },
      { key: 'install', title: '一键安装 OpenClaw', description: '正在安装到当前用户目录，避免系统权限问题', hint: '安装过程可能有短暂静默，请耐心等待。', progress: 64 },
      { key: 'verify', title: '验证命令是否可用', description: '检查 `openclaw` 命令和版本', hint: '已经接近完成，正在做最终验证。', progress: 88 },
      { key: 'done', title: '整理下一步引导', description: '安装完成，准备告诉你接下来做什么', hint: '安装结束后，我会直接告诉你下一步。', progress: 100 },
    ];
  }

  return [
    { key: 'preflight', title: '检查 Node.js / npm', description: '确认 npm 全局安装环境可用', hint: '这一步在确认本机能执行 npm 安装。', progress: 8 },
    { key: 'download', title: '下载 OpenClaw 包', description: 'npm 正在获取安装包和依赖信息', hint: '如果网络慢，这一步可能较久，不代表卡死。', progress: 26 },
    { key: 'install', title: '全局安装 OpenClaw', description: 'npm 正在把 OpenClaw 安装到全局环境', hint: '安装过程可能没有持续输出，请耐心等待。', progress: 64 },
    { key: 'verify', title: '验证命令是否可用', description: '检查 `openclaw` 命令和版本', hint: '已经接近完成，正在做最终验证。', progress: 88 },
    { key: 'done', title: '整理下一步引导', description: '安装完成，准备告诉你接下来做什么', hint: '安装结束后，我会直接告诉你下一步。', progress: 100 },
  ];
}

function createOpenClawInstallTask({ method, command }) {
  cleanupOpenClawInstallTasks();
  const steps = openClawInstallStepTemplate(method).map((step, index) => ({ ...step, status: index === 0 ? 'running' : 'pending' }));
  const startedAt = nowIso();
  const task = {
    id: `openclaw-install-${Date.now()}-${openclawInstallTaskSeq += 1}`,
    toolId: 'openclaw',
    type: 'install',
    method,
    command,
    status: 'running',
    progress: 4,
    stepIndex: 0,
    summary: steps[0].description,
    hint: steps[0].hint,
    detail: '正在准备安装任务…',
    steps,
    logs: [],
    stdout: '',
    stderr: '',
    startedAt,
    updatedAt: startedAt,
    updatedAtTs: Date.now(),
    completedAt: null,
    version: null,
    error: null,
    nextActions: [],
    _cancelRequested: false,
    _childPid: null,
    _installSnapshot: null,
    _cancelPromise: null,
    _stdoutBuffer: '',
    _stderrBuffer: '',
  };
  OPENCLAW_INSTALL_TASKS.set(task.id, task);
  return task;
}

async function pathExists(targetPath) {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function npmGlobalPrefix() {
  const result = runSpawnSync(npmCommand(), ['prefix', '-g'], { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function npmGlobalRoot() {
  const result = runSpawnSync(npmCommand(), ['root', '-g'], { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function windowsUserNpmPrefix() {
  const appData = process.env.APPDATA?.trim();
  return appData ? path.join(appData, 'npm') : path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
}

function isProtectedWindowsPath(targetPath) {
  if (process.platform !== 'win32' || !targetPath) return false;
  const normalized = path.resolve(targetPath).toLowerCase();
  const protectedRoots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]
    .filter(Boolean)
    .map((entry) => path.resolve(entry).toLowerCase());
  return protectedRoots.some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`));
}

function openClawNpmPrefix() {
  if (process.platform !== 'win32') return npmGlobalPrefix();
  const configuredPrefix = npmGlobalPrefix();
  if (configuredPrefix && !isProtectedWindowsPath(configuredPrefix)) return configuredPrefix;
  return windowsUserNpmPrefix();
}

function openClawInstallEnv({ useCnRegistry = false } = {}) {
  if (process.platform !== 'win32') return undefined;
  const prefix = openClawNpmPrefix();
  const currentPath = process.env.Path || process.env.PATH || '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  if (!entries.some((entry) => entry.trim().toLowerCase() === prefix.toLowerCase())) {
    entries.unshift(prefix);
  }
  const joinedPath = entries.join(path.delimiter);
  const env = {
    NPM_CONFIG_PREFIX: prefix,
    npm_config_prefix: prefix,
    Path: joinedPath,
    PATH: joinedPath,
  };
  if (useCnRegistry) {
    env.NPM_CONFIG_REGISTRY = OPENCLAW_NPM_REGISTRY_CN;
    env.npm_config_registry = OPENCLAW_NPM_REGISTRY_CN;
  }
  return env;
}

function toPowerShellString(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

async function ensureWindowsUserPathEntry(targetPath) {
  if (process.platform !== 'win32' || !targetPath) return { ok: true, changed: false };
  const command = [
    `$target = ${toPowerShellString(targetPath)}`,
    "$current = [Environment]::GetEnvironmentVariable('Path','User')",
    "$entries = @()",
    "if ($current) { $entries = $current -split ';' | Where-Object { $_ } }",
    "if (-not ($entries | Where-Object { $_ -ieq $target })) {",
    `  if ($current -and -not $current.EndsWith(';')) { $current = "$current;" }`,
    `  [Environment]::SetEnvironmentVariable('Path', "$current$target", 'User')`,
    "  Write-Output 'changed'",
    "} else {",
    "  Write-Output 'unchanged'",
    "}"
  ].join('; ');
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]);
  return { ok: result.ok, changed: /changed/i.test(result.stdout || '') };
}

async function prepareOpenClawWindowsInstall({ useCnRegistry = false } = {}) {
  if (process.platform !== 'win32') return { env: undefined, prefix: '', changed: false, pathChanged: false };
  const prefix = openClawNpmPrefix();
  await ensureDir(prefix);
  await ensureDir(path.join(prefix, 'node_modules'));
  const env = openClawInstallEnv({ useCnRegistry });
  const pathResult = await ensureWindowsUserPathEntry(prefix);
  if (!commandExists(npmCommand())) {
    return {
      env,
      prefix,
      changed: false,
      pathChanged: Boolean(pathResult.changed),
    };
  }
  const configResult = await runCommand(npmCommand(), ['config', 'set', 'prefix', prefix, '--location=user'], { env });
  if (!configResult.ok) {
    throw new Error(`自动配置 npm 用户目录失败：${summarizeInstallCommandFailure(configResult)}`);
  }
  return {
    env,
    prefix,
    changed: true,
    pathChanged: Boolean(pathResult.changed),
  };
}

async function captureOpenClawInstallSnapshot() {
  const homePath = openclawHome();
  const installSetup = await prepareOpenClawWindowsInstall();
  const installEnv = installSetup.env;
  const npmPrefix = process.platform === 'win32' ? openClawNpmPrefix() : npmGlobalPrefix();
  const npmRoot = process.platform === 'win32' && npmPrefix ? path.join(npmPrefix, 'node_modules') : npmGlobalRoot();
  const binary = findToolBinary('openclaw');
  const packagePath = npmRoot ? path.join(npmRoot, 'openclaw') : '';
  const binPaths = !npmPrefix
    ? []
    : process.platform === 'win32'
      ? [path.join(npmPrefix, 'openclaw'), path.join(npmPrefix, 'openclaw.cmd'), path.join(npmPrefix, 'openclaw.ps1'), path.join(npmPrefix, 'openclaw.exe')]
      : [path.join(npmPrefix, 'bin', 'openclaw')];

  return {
    hadBinary: Boolean(binary.installed),
    homePath,
    homeExisted: await pathExists(homePath),
    packagePath,
    binPaths,
    npmPrefix,
    reroutedPrefix: Boolean(installEnv?.NPM_CONFIG_PREFIX && installEnv.NPM_CONFIG_PREFIX !== npmGlobalPrefix()),
  };
}

function isOpenClawInstallActive(task) {
  return task && (task.status === 'running' || task.status === 'cancelling');
}

function isOpenClawInstallCancelled(task) {
  return Boolean(task?._cancelRequested) || task?.status === 'cancelling' || task?.status === 'cancelled';
}

async function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateOpenClawInstallProcess(task) {
  const pid = Number(task?._childPid || 0);
  if (!pid) return;

  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/F', '/T', '/PID', String(pid)]).catch(() => null);
    task._childPid = null;
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* noop */ }
  }
  await new Promise(resolve => setTimeout(resolve, 900));
  if (await isPidAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* noop */ }
    }
  }
  task._childPid = null;
}

async function cleanupOpenClawInstallArtifacts(task) {
  const snapshot = task?._installSnapshot || {};
  const cleanedPaths = [];
  const cleanupErrors = [];

  if (!snapshot.hadBinary) {
    try {
      const uninstallResult = await runCommand(npmCommand(), ['uninstall', '-g', 'openclaw']);
      const uninstallLog = `${String(uninstallResult.stdout || '').trim()} ${String(uninstallResult.stderr || '').trim()}`.trim();
      if (uninstallLog) pushOpenClawInstallLog(task, uninstallResult.ok ? 'stdout' : 'stderr', uninstallLog);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }

    for (const targetPath of [snapshot.packagePath, ...(snapshot.binPaths || [])]) {
      if (!targetPath) continue;
      try {
        await fs.rm(targetPath, { recursive: true, force: true });
        cleanedPaths.push(targetPath);
      } catch (error) {
        cleanupErrors.push(`删除 ${targetPath} 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (!snapshot.homeExisted && snapshot.homePath) {
    try {
      await fs.rm(snapshot.homePath, { recursive: true, force: true });
      cleanedPaths.push(snapshot.homePath);
    } catch (error) {
      cleanupErrors.push(`删除 ${snapshot.homePath} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { cleanedPaths: [...new Set(cleanedPaths)], cleanupErrors };
}

async function cancelRunningOpenClawInstall(task) {
  if (!task) throw new Error('安装任务不存在，可能已经过期，请重新开始安装');
  if (!isOpenClawInstallActive(task)) return serializeOpenClawInstallTask(task);
  if (task._cancelPromise) {
    await task._cancelPromise;
    return serializeOpenClawInstallTask(task);
  }

  task._cancelRequested = true;
  task.status = 'cancelling';
  task.summary = '正在中断 OpenClaw 安装…';
  task.hint = '先别关闭窗口，正在终止安装进程并清理残留。';
  task.detail = '正在停止安装进程…';
  touchOpenClawInstallTask(task);

  task._cancelPromise = (async () => {
    pushOpenClawInstallLog(task, 'stderr', '收到中断请求，正在终止安装进程…');
    await terminateOpenClawInstallProcess(task);
    pushOpenClawInstallLog(task, 'stdout', '安装进程已停止，开始清理本次安装残留…');
    const cleanup = await cleanupOpenClawInstallArtifacts(task);
    task.steps = task.steps.map((step, index) => ({
      ...step,
      status: index < task.stepIndex ? 'done' : index === task.stepIndex ? 'error' : 'pending',
    }));
    task.status = 'cancelled';
    task.progress = 100;
    task.error = cleanup.cleanupErrors.length ? cleanup.cleanupErrors.join('；') : null;
    task.summary = cleanup.cleanupErrors.length ? '安装已中断，但清理时遇到问题。' : '安装已中断，残留已清理。';
    task.hint = cleanup.cleanupErrors.length
      ? '大部分安装已撤销，但还有少量路径需要你手动确认。'
      : '本次安装已彻底中断，你可以随时重新开始。';
    task.detail = cleanup.cleanupErrors.length
      ? cleanup.cleanupErrors[0]
      : cleanup.cleanedPaths.length
        ? `已清理 ${cleanup.cleanedPaths.length} 处残留。`
        : '未发现需要额外清理的残留。';
    task.nextActions = cleanup.cleanupErrors.length
      ? ['请先查看最后日志中的清理报错。', '确认相关路径已删除后，再重新安装。']
      : ['如需继续，请重新点击安装 OpenClaw。'];
    task.completedAt = nowIso();
    task._childPid = null;
    touchOpenClawInstallTask(task);
  })();

  await task._cancelPromise;
  return serializeOpenClawInstallTask(task);
}

function serializeOpenClawInstallTask(task) {
  return {
    taskId: task.id,
    toolId: task.toolId,
    type: task.type,
    method: task.method,
    command: task.command,
    status: task.status,
    progress: task.progress,
    stepIndex: task.stepIndex,
    summary: task.summary,
    hint: task.hint,
    detail: task.detail,
    steps: task.steps,
    logs: task.logs.slice(-14),
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    version: task.version,
    error: task.error,
    nextActions: task.nextActions,
  };
}

function touchOpenClawInstallTask(task) {
  task.updatedAt = nowIso();
  task.updatedAtTs = Date.now();
}

function setOpenClawInstallStep(task, stepIndex, overrides = {}) {
  const safeStepIndex = Math.max(0, Math.min(stepIndex, task.steps.length - 1));
  if (safeStepIndex < task.stepIndex) return;
  task.stepIndex = safeStepIndex;
  task.progress = Math.max(task.progress, overrides.progress ?? task.steps[safeStepIndex].progress ?? task.progress);
  task.summary = overrides.summary || task.steps[safeStepIndex].description;
  task.hint = overrides.hint || task.steps[safeStepIndex].hint;
  if (overrides.detail) task.detail = overrides.detail;
  task.steps = task.steps.map((step, index) => ({
    ...step,
    status: index < safeStepIndex ? 'done' : index === safeStepIndex ? (overrides.status || 'running') : 'pending',
  }));
  touchOpenClawInstallTask(task);
}

function cleanOpenClawInstallLine(line) {
  return String(line || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

function pushOpenClawInstallLog(task, source, line) {
  const text = cleanOpenClawInstallLine(line);
  if (!text) return;
  task.logs.push({ source, text, at: nowIso() });
  if (task.logs.length > 120) task.logs.shift();
  task.detail = text;
  touchOpenClawInstallTask(task);
}

function inferOpenClawInstallStep(task, line) {
  const cleaned = cleanOpenClawInstallLine(line);
  const text = cleaned.toLowerCase();
  if (!text) return;
  if (task.method === 'script') {
    if (/(\[1\/3\]|preparing environment|homebrew|node\.js|active npm|active node)/.test(text)) {
      setOpenClawInstallStep(task, 0, { detail: cleaned });
      return;
    }
    if (/(curl|download|fetch|https?:\/\/|installer|install plan)/.test(text)) {
      setOpenClawInstallStep(task, 1, { detail: cleaned });
      return;
    }
    if (/(\[2\/3\]|installing openclaw|extract|copy|link|binary|daemon|git already installed)/.test(text)) {
      setOpenClawInstallStep(task, 2, { detail: cleaned });
    }
    return;
  }
  if (/(fetch|tarball|manifest|registry|http)/.test(text)) {
    setOpenClawInstallStep(task, 1, { detail: cleaned });
    return;
  }
  if (/(install|added|changed|build|postinstall|preinstall|link|reify)/.test(text)) {
    setOpenClawInstallStep(task, 2, { detail: cleaned });
  }
}

function consumeOpenClawInstallChunk(task, source, chunk) {
  const bufferKey = source === 'stderr' ? '_stderrBuffer' : '_stdoutBuffer';
  const text = String(chunk || '');
  task[source] += text;
  const merged = `${task[bufferKey] || ''}${text}`;
  const lines = merged.split(/\r?\n/);
  task[bufferKey] = lines.pop() || '';
  for (const line of lines) {
    pushOpenClawInstallLog(task, source, line);
    inferOpenClawInstallStep(task, line);
  }
}

function flushOpenClawInstallChunk(task) {
  for (const bufferKey of ['_stdoutBuffer', '_stderrBuffer']) {
    const source = bufferKey === '_stdoutBuffer' ? 'stdout' : 'stderr';
    if (!task[bufferKey]) continue;
    pushOpenClawInstallLog(task, source, task[bufferKey]);
    inferOpenClawInstallStep(task, task[bufferKey]);
    task[bufferKey] = '';
  }
}

function runTrackedCommand(task, command, args, options = {}) {
  return new Promise((resolve) => {
    const child = runSpawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
      detached: process.platform !== 'win32',
    });

    task._childPid = child.pid || null;
    touchOpenClawInstallTask(task);

    child.stdout?.on('data', (chunk) => consumeOpenClawInstallChunk(task, 'stdout', chunk));
    child.stderr?.on('data', (chunk) => consumeOpenClawInstallChunk(task, 'stderr', chunk));
    child.on('error', (error) => {
      task._childPid = null;
      pushOpenClawInstallLog(task, 'stderr', error.message);
      resolve({ ok: false, code: null, stdout: task.stdout, stderr: `${task.stderr}${error.message}` });
    });
    child.on('close', (code) => {
      task._childPid = null;
      flushOpenClawInstallChunk(task);
      resolve({ ok: code === 0, code, stdout: task.stdout, stderr: task.stderr });
    });
  });
}

function finishOpenClawInstallTask(task, status, payload = {}) {
  task.status = status;
  task.progress = status === 'success' || status === 'cancelled' ? 100 : task.progress;
  task.version = payload.version || task.version || null;
  task.error = payload.error || null;
  task.nextActions = payload.nextActions || [];
  task.completedAt = nowIso();
  task._childPid = null;
  touchOpenClawInstallTask(task);
}

async function runOpenClawInstallTask(task) {
  const currentMethod = task.method;
  const isScript = currentMethod === 'script';
  const useCnRegistry = currentMethod === 'domestic';
  const installSetup = await prepareOpenClawWindowsInstall({ useCnRegistry });
  const installEnv = installSetup.env;
  const command = isScript
    ? (process.platform === 'win32' ? 'powershell.exe' : 'bash')
    : npmCommand();
  const args = isScript
    ? (process.platform === 'win32' ? openClawWindowsPowerShellArgs(OPENCLAW_INSTALL_SCRIPT_WIN) : ['-lc', OPENCLAW_INSTALL_SCRIPT_UNIX])
    : ['install', '-g', 'openclaw@latest', ...(useCnRegistry ? ['--registry', OPENCLAW_NPM_REGISTRY_CN] : [])];

  try {
    if (isOpenClawInstallCancelled(task)) return;
    if (isScript && process.platform !== 'win32' && !commandExists('curl')) {
      throw new Error('未检测到 `curl`，无法执行脚本安装。请先安装 curl，或改用 npm 安装。');
    }
    if (!isScript) {
      const nodeResult = runSpawnSync('node', ['--version'], { encoding: 'utf8' });
      const npmResult = runSpawnSync(npmCommand(), ['--version'], { encoding: 'utf8' });
      if (nodeResult.status !== 0) throw new Error('未检测到 Node.js，请先安装 Node.js 18+。');
      if (npmResult.status !== 0) throw new Error('未检测到 npm，请先修复 npm 环境后重试。');
      pushOpenClawInstallLog(task, 'stdout', `Node.js ${String(nodeResult.stdout || '').trim()} / npm ${String(npmResult.stdout || '').trim()}`);
      if (installSetup?.prefix) {
        pushOpenClawInstallLog(task, 'stdout', `Windows 安装将使用当前用户 npm 目录：${installSetup.prefix}`);
        if (installSetup.pathChanged) pushOpenClawInstallLog(task, 'stdout', '已自动把该目录加入用户 PATH，后续新开的终端可直接使用 openclaw。');
      }
      if (useCnRegistry) pushOpenClawInstallLog(task, 'stdout', `已启用国内 npm 源：${OPENCLAW_NPM_REGISTRY_CN}`);
    }

    // Mark preflight done, start download step
    setOpenClawInstallStep(task, 0, { status: 'done' });
    setOpenClawInstallStep(task, 1, { detail: `即将执行：${task.command}` });

    // Auto-advance to install step if still on download after 8s
    // (npm often outputs nothing matching "download" keywords)
    const autoAdvanceTimer = setTimeout(() => {
      if (task.status === 'running' && task.stepIndex <= 1) {
        setOpenClawInstallStep(task, 2, { detail: '正在安装 OpenClaw 及其依赖，请耐心等待…' });
      }
    }, 8000);

    const result = await runTrackedCommand(task, command, args, { env: installEnv });
    clearTimeout(autoAdvanceTimer);
    if (isOpenClawInstallCancelled(task)) return;
    if (!result.ok) throw new Error(summarizeInstallCommandFailure(result));

    // Ensure install step is marked done before moving to verify
    if (task.stepIndex < 2) {
      setOpenClawInstallStep(task, 2, { detail: '安装命令已完成，准备验证…' });
    }
    // Small settle delay so user sees "install done" before "verifying"
    await new Promise(r => setTimeout(r, 600));
    if (isOpenClawInstallCancelled(task)) return;

    setOpenClawInstallStep(task, 3, { detail: '安装命令已执行完成，正在验证 openclaw 命令…' });
    const binary = findToolBinary('openclaw');
    if (!binary.installed) throw new Error(describeOpenClawVerificationFailure(task));

    setOpenClawInstallStep(task, 4, { status: 'done', summary: 'OpenClaw 安装完成，已经可以使用。', detail: binary.version ? `已检测到版本：${binary.version}` : '已检测到 openclaw 命令。' });
    finishOpenClawInstallTask(task, 'success', {
      version: binary.version,
      nextActions: ['下一步 1：点击“启动 OpenClaw”打开工具。', '下一步 2：首次使用建议执行 `openclaw onboard --install-daemon`。', '下一步 3：如需改配置，可编辑 `~/.openclaw/openclaw.json`。'],
    });
  } catch (error) {
    if (isOpenClawInstallCancelled(task)) return;
    task.steps = task.steps.map((step, index) => ({ ...step, status: index < task.stepIndex ? 'done' : index === task.stepIndex ? 'error' : 'pending' }));
    task.summary = 'OpenClaw 安装失败，需要你看一眼错误提示。';
    task.hint = '先看下方“最后日志”，通常会直接告诉你缺的是网络、权限还是依赖。';
    task.detail = error instanceof Error ? error.message : String(error);
    finishOpenClawInstallTask(task, 'error', {
      error: error instanceof Error ? error.message : String(error),
      nextActions: ['先确认网络能访问 npm 或 openclaw.ai。', '如果脚本安装失败，可改用 npm 安装。', '如果 npm 安装失败，请检查 Node.js / npm 是否正常。'],
    });
  }
}

function parseVersionString(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersionString(left) || [0, 0, 0];
  const b = parseVersionString(right) || [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function codexCandidates() {
  return toolBinaryCandidates('codex');
}

function findCodexBinary() {
  const detected = findToolBinary('codex');
  return {
    ...detected,
    path: detected.path || commandExists('codex'),
    installCommand: `${npmCommand()} install -g ${OPENAI_CODEX_PACKAGE}`,
  };
}

function scopePaths({ scope, projectPath, codexHome }) {
  const normalizedCodexHome = assertAllowedPath(codexHome, 'codexHome');
  if (scope === 'project') {
    if (!projectPath || !projectPath.trim()) {
      throw new Error('Project path is required for project scope');
    }
    const normalizedProjectPath = assertAllowedPath(projectPath.trim(), 'projectPath');
    return {
      scope,
      rootPath: normalizedProjectPath,
      configPath: path.join(normalizedProjectPath, '.codex', 'config.toml'),
      envPath: path.join(normalizedCodexHome, '.env'),
    };
  }

  return {
    scope: 'global',
    rootPath: normalizedCodexHome,
    configPath: path.join(normalizedCodexHome, 'config.toml'),
    envPath: path.join(normalizedCodexHome, '.env'),
  };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function writeText(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
}

function parseToml(content) {
  return content.trim() ? TOML.parse(content) : {};
}

function stripJsonComments(content) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const ch = content[index];
    const next = content[index + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (index < content.length && content[index] !== "\n") index += 1;
      if (index < content.length) out += "\n";
      continue;
    }
    if (ch === '/' && next === '*') {
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
        if (content[index] === "\n") out += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function stripJsonTrailingCommas(content) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const ch = content[index];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let cursor = index + 1;
      while (cursor < content.length && /\s/.test(content[cursor])) cursor += 1;
      if (content[cursor] === '}' || content[cursor] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonc(content) {
  const trimmed = String(content || '').trim();
  if (!trimmed) return {};
  return JSON.parse(stripJsonTrailingCommas(stripJsonComments(trimmed)));
}

function maskSecret(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}***${text.slice(-1)}`;
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function openCodeGlobalConfigDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming'), 'opencode');
  }
  return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'opencode');
}

function openCodeGlobalDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming'), 'opencode');
  }
  return path.join(process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share'), 'opencode');
}

function firstExistingPath(paths = [], fallbackPath = '') {
  for (const candidate of paths) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return fallbackPath || paths.find(Boolean) || '';
}

const OPENCODE_BUILTIN_PROVIDER_CATALOG = [
  { key: 'opencode', name: 'OpenCode', recommendedPackage: '', defaultBaseUrl: '' },
  { key: 'anthropic', name: 'Anthropic', recommendedPackage: '@ai-sdk/anthropic', defaultBaseUrl: 'https://api.anthropic.com' },
  { key: 'openai', name: 'OpenAI', recommendedPackage: '@ai-sdk/openai', defaultBaseUrl: 'https://api.openai.com/v1' },
  { key: 'google', name: 'Google', recommendedPackage: '@ai-sdk/google', defaultBaseUrl: '' },
  { key: 'google-vertex', name: 'Google Vertex', recommendedPackage: '@ai-sdk/google-vertex', defaultBaseUrl: '' },
  { key: 'github-copilot', name: 'GitHub Copilot', recommendedPackage: '@ai-sdk/github-copilot', defaultBaseUrl: '' },
  { key: 'amazon-bedrock', name: 'Amazon Bedrock', recommendedPackage: '@ai-sdk/amazon-bedrock', defaultBaseUrl: '' },
  { key: 'azure', name: 'Azure OpenAI', recommendedPackage: '@ai-sdk/azure', defaultBaseUrl: '' },
  { key: 'openrouter', name: 'OpenRouter', recommendedPackage: '@openrouter/ai-sdk-provider', defaultBaseUrl: 'https://openrouter.ai/api/v1' },
  { key: 'mistral', name: 'Mistral', recommendedPackage: '@ai-sdk/mistral', defaultBaseUrl: 'https://api.mistral.ai/v1' },
  { key: 'gitlab', name: 'GitLab', recommendedPackage: '', defaultBaseUrl: '' },
];

const OPENCODE_LOAD_ORDER = [
  'Remote .well-known/opencode 组织默认',
  '全局 ~/.config/opencode/opencode.json(c)',
  'OPENCODE_CONFIG 自定义路径',
  '项目 opencode.json(c)',
  '.opencode 目录与其下 agents / commands / plugins / modes',
  'OPENCODE_CONFIG_CONTENT 内联配置',
  '账号远程配置',
  '企业 managed config',
];

const OPENCODE_DIRECTORY_FEATURES = [
  '.opencode/opencode.json(c)',
  '.opencode/agents/**/*.md',
  '.opencode/commands/**/*.md',
  '.opencode/plugins/*.{js,ts}',
  '.opencode/modes/*.md',
];

function resolveOpenCodePaths({ scope = 'global', projectPath = '' } = {}) {
  if (scope === 'project') {
    if (!projectPath || !projectPath.trim()) throw new Error('Project path is required for project scope');
    const rootPath = path.resolve(projectPath.trim());
    return {
      scope: 'project',
      rootPath,
      configPath: firstExistingPath([
        path.join(rootPath, '.opencode', 'opencode.jsonc'),
        path.join(rootPath, '.opencode', 'opencode.json'),
        path.join(rootPath, 'opencode.jsonc'),
        path.join(rootPath, 'opencode.json'),
      ], path.join(rootPath, 'opencode.json')),
      authPath: path.join(openCodeGlobalDataDir(), 'auth.json'),
    };
  }
  const rootPath = openCodeGlobalConfigDir();
  return {
    scope: 'global',
    rootPath,
    configPath: firstExistingPath([
      path.join(rootPath, 'opencode.jsonc'),
      path.join(rootPath, 'opencode.json'),
      path.join(rootPath, 'config.json'),
    ], path.join(rootPath, 'opencode.json')),
    authPath: path.join(openCodeGlobalDataDir(), 'auth.json'),
  };
}

function normalizeOpenCodeProviderKey(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'custom';
}

function openCodeProviderFromModel(model = '') {
  const text = String(model || '').trim();
  if (!text.includes('/')) return '';
  return text.split('/')[0] || '';
}

function quotePosixShellArg(value = '') {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function normalizeOpenCodeAuthEntryKey(value = '') {
  return String(value || '').trim().replace(/\/+$/g, '');
}

function parseOpenCodeAuthJson(content = '') {
  const raw = String(content || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw new Error(`OpenCode 鉴权文件解析失败：${error.message}`);
  }
}

function normalizeOpenCodeExpiry(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  const millis = num > 1e12 ? num : num * 1000;
  return new Date(millis).toISOString();
}

function summarizeOpenCodeAuthEntries(authJson = {}) {
  return Object.entries(authJson || {}).map(([key, value]) => {
    const normalizedKey = normalizeOpenCodeAuthEntryKey(key);
    const type = String(value?.type || '').trim().toLowerCase() || 'unknown';
    const secret = type === 'oauth'
      ? String(value?.access || value?.refresh || '').trim()
      : type === 'wellknown'
        ? String(value?.token || '').trim()
        : String(value?.key || '').trim();
    return {
      key: normalizedKey,
      type,
      maskedSecret: maskSecret(secret),
      expiresAt: type === 'oauth' ? normalizeOpenCodeExpiry(value?.expires) : '',
      hasCredential: Boolean(secret),
    };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

function findOpenCodeAuthEntry(authEntries = [], providerKey = '', baseUrl = '') {
  const normalizedProviderKey = normalizeOpenCodeAuthEntryKey(providerKey || '');
  const normalizedBaseUrl = normalizeOpenCodeAuthEntryKey(baseUrl || '');
  return authEntries.find((entry) => {
    const authKey = normalizeOpenCodeAuthEntryKey(entry?.key || '');
    return Boolean(
      (normalizedProviderKey && authKey === normalizedProviderKey)
      || (normalizedBaseUrl && authKey === normalizedBaseUrl)
    );
  }) || null;
}

function getOpenCodeBuiltinProviderMeta(key = '') {
  const normalizedKey = normalizeOpenCodeProviderKey(key);
  return OPENCODE_BUILTIN_PROVIDER_CATALOG.find((item) => item.key === normalizedKey) || null;
}

function isLikelyOpenCodeProviderKey(key = '') {
  const text = String(key || '').trim();
  return Boolean(text) && !/^https?:\/\//i.test(text) && !text.includes('/');
}

function applyPatch(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null) {
      delete target[key];
      continue;
    }
    if (Array.isArray(value)) {
      target[key] = value;
      continue;
    }
    if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      applyPatch(target[key], value);
      if (!Object.keys(target[key]).length) {
        delete target[key];
      }
      continue;
    }
    target[key] = value;
  }
}

function normalizeSettingsPatch(patch) {
  const normalized = structuredClone(patch || {});
  if (normalized.compact_prompt === false) normalized.compact_prompt = 'false';
  if (normalized.compact_prompt === true) normalized.compact_prompt = null;
  return normalized;
}

function parseEnv(content) {
  const entries = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    entries[key] = value.replace(/^['"]|['"]$/g, '');
  }
  return entries;
}

function stringifyEnv(entries) {
  const rows = Object.entries(entries)
    .filter(([key]) => key)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value ?? '')}`);
  return rows.length ? `${rows.join('\n')}\n` : '';
}

function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) {
    throw new Error('Base URL is required');
  }

  const withScheme = /^[a-z]+:\/\//i.test(raw)
    ? raw
    : (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(raw) ? `http://${raw}` : `https://${raw}`);

  const url = new URL(withScheme);
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}
function slugifyProviderKey(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) return 'custom';
  return /^\d/.test(slug) ? `provider-${slug}` : slug;
}

const COMMON_HOST_SUFFIXES = new Set([
  'ac', 'ai', 'app', 'cc', 'cloud', 'cn', 'co', 'com', 'dev', 'fm', 'gg', 'hk', 'in', 'io', 'jp',
  'me', 'net', 'org', 'pro', 'ru', 'sg', 'sh', 'site', 'tech', 'top', 'tv', 'tw', 'uk', 'us', 'xyz',
]);

function legacyInferProviderSeed(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, '');
    const parts = hostname.split('.').filter(Boolean);
    const ignored = new Set(['api', 'openai', 'codex', 'gateway', 'chat', 'www', 'dapi']);
    const picked = parts.find((part) => !ignored.has(part) && /[a-z]/.test(part));
    return picked || parts[0] || 'custom';
  } catch {
    return 'custom';
  }
}

function inferProviderSeed(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    const parts = hostname.split('.').filter(Boolean);
    if (!parts.length) return 'custom';

    while (parts.length > 1) {
      const last = parts[parts.length - 1];
      if (COMMON_HOST_SUFFIXES.has(last)) {
        parts.pop();
        continue;
      }
      break;
    }

    if (parts.length > 1 && ['www', 'api'].includes(parts[0])) {
      parts.shift();
    }

    const seed = parts.join('-').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    return seed || 'custom';
  } catch {
    return 'custom';
  }
}

function findProviderEntryByBaseUrl(config, baseUrl) {
  const normalizedBaseUrl = String(baseUrl || '').trim();
  return Object.entries(config?.model_providers || {}).find(([, provider]) => {
    return String(provider?.base_url || '').trim() === normalizedBaseUrl;
  }) || null;
}

function inferProviderLabel(baseUrl, providerKey) {
  const seed = inferProviderSeed(baseUrl) || providerKey || 'Custom';
  return seed
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferEnvKey(providerKey) {
  return slugifyProviderKey(providerKey)
    .replace(/-/g, '_')
    .toUpperCase() + '_API_KEY';
}

async function readAuthJson(codexHome) {
  const raw = await readText(path.join(codexHome, 'auth.json'));
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isEnvStyleAuthKey(key) {
  const text = String(key || '').trim();
  return Boolean(text)
    && /^[_A-Z][_A-Z0-9]*$/.test(text);
}

function shouldPreserveAuthEntry(key, value) {
  const text = String(value || '').trim();
  if (!text || !isEnvStyleAuthKey(key)) {
    return false;
  }
  const upper = String(key).trim().toUpperCase();
  return upper.includes('KEY')
    || upper.includes('TOKEN')
    || upper.includes('SECRET')
    || upper.includes('BASE_URL')
    || upper.endsWith('_URL')
    || upper.endsWith('_ENDPOINT');
}

async function preserveCodexAuthJsonEntriesToEnv({ codexHome = defaultCodexHome(), authRaw = '' } = {}) {
  const raw = String(authRaw || '');
  if (!raw.trim()) {
    return [];
  }
  let authJson = {};
  try {
    authJson = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!authJson || typeof authJson !== 'object' || Array.isArray(authJson)) {
    return [];
  }

  const envPath = path.join(codexHome, '.env');
  const env = parseEnv(await readText(envPath));
  const migrated = [];

  for (const [key, value] of Object.entries(authJson)) {
    if (typeof value !== 'string' || !shouldPreserveAuthEntry(key, value)) {
      continue;
    }
    if (String(env[key] || '').trim()) {
      continue;
    }
    env[key] = value.trim();
    migrated.push(key);
  }

  if (migrated.length) {
    await writeText(envPath, stringifyEnv(env));
  }
  return migrated;
}

async function backupCodexAuthJson(authRaw = '') {
  const raw = String(authRaw || '');
  if (!raw.trim()) {
    return '';
  }
  const dir = path.join(appHome(), 'codex-oauth-profiles', '_switch_backups');
  await ensureDir(dir);
  const backupPath = path.join(dir, `auth-${timestamp()}.json`);
  await writeText(backupPath, raw);

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && /^auth-.*\.json$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const stale = files.slice(0, Math.max(0, files.length - 5));
  await Promise.all(stale.map((name) => fs.unlink(path.join(dir, name)).catch(() => {})));
  return backupPath;
}

function decodeJwtPayload(token) {
  const input = String(token || '').trim();
  if (!input.includes('.')) return {};
  try {
    const payload = input.split('.')[1] || '';
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function summarizeCodexLogin(authJson = {}) {
  const apiKey = String(authJson.OPENAI_API_KEY || authJson.CODEX_API_KEY || authJson.CODEX_CLI_API_KEY || '').trim();
  const tokens = authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  const accessToken = String(tokens?.access_token || '').trim();
  const idToken = String(tokens?.id_token || '').trim();
  const claims = decodeJwtPayload(idToken);
  const authClaims = claims['https://api.openai.com/auth'] || {};

  if (accessToken) {
    return {
      loggedIn: true,
      method: 'chatgpt',
      email: String(claims.email || '').trim(),
      plan: String(authClaims.chatgpt_plan_type || '').trim(),
      userId: String(authClaims.chatgpt_user_id || authClaims.user_id || claims.user_id || '').trim(),
      accountId: String(tokens?.account_id || '').trim(),
    };
  }

  if (apiKey) {
    return {
      loggedIn: true,
      method: 'api_key',
      email: '',
      plan: '',
      userId: '',
      accountId: '',
    };
  }

  return {
    loggedIn: false,
    method: '',
    email: '',
    plan: '',
    userId: '',
    accountId: '',
  };
}

function normalizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9]/g, '');
}

function scoreKeyCandidate(candidateKey, provider) {
  const candidate = normalizeToken(candidateKey)
    .replace(/apikey$/, '')
    .replace(/oaikey$/, '')
    .replace(/key$/, '')
    .replace(/token$/, '');
  const targets = [provider.key, provider.name, provider.baseUrl]
    .map(normalizeToken)
    .filter(Boolean);

  let score = 0;
  for (const target of targets) {
    if (!target || !candidate) continue;
    if (target === candidate) score += 120;
    if (target.includes(candidate)) score += 60;
    if (candidate.includes(target)) score += 30;
    const prefixLen = Math.min(target.length, candidate.length, 8);
    if (prefixLen >= 4 && target.slice(0, prefixLen) === candidate.slice(0, prefixLen)) score += prefixLen * 5;
  }

  if (candidate === 'openai' && !targets.some((target) => target.includes('openai'))) {
    score -= 60;
  }

  return score;
}

function candidateEnvKeys(provider) {
  const seeds = [
    provider.key,
    provider.name,
    (() => {
      try {
        return new URL(provider.baseUrl || 'https://example.invalid').hostname;
      } catch {
        return '';
      }
    })(),
  ];

  const keys = new Set();
  for (const seed of seeds) {
    const normalized = String(seed || '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
    if (!normalized) {
      continue;
    }
    keys.add(`${normalized}_API_KEY`);
    keys.add(`${normalized}_OAI_KEY`);
    keys.add(`${normalized}_KEY`);
  }
  return [...keys];
}

function resolveProviderSecret(provider, envFile, authJson) {
  const runtimeEnv = process.env;
  const explicitKeys = provider.envKey ? [provider.envKey] : [];
  const discoveredKeys = [
    ...Object.keys(envFile || {}),
    ...Object.keys(runtimeEnv || {}),
    ...Object.keys(authJson || {}),
  ].filter((key) => /(?:key|token)$/i.test(key));
  const candidateKeys = [...new Set([...explicitKeys, ...candidateEnvKeys(provider), ...discoveredKeys])];
  const candidates = [];

  for (const key of candidateKeys) {
    const dynamicScore = scoreKeyCandidate(key, provider);
    if (envFile[key]) {
      candidates.push({ key, value: envFile[key], source: '.env', score: explicitKeys.includes(key) ? 1000 : dynamicScore + 100 });
    }
    if (runtimeEnv[key]) {
      candidates.push({ key, value: runtimeEnv[key], source: 'system-env', score: explicitKeys.includes(key) ? 950 : dynamicScore + 90 });
    }
    if (authJson[key]) {
      candidates.push({ key, value: authJson[key], source: 'auth.json', score: explicitKeys.includes(key) ? 900 : dynamicScore + 80 });
    }
  }

  if (provider.inlineBearerToken) {
    candidates.push({ key: null, value: provider.inlineBearerToken, source: 'config.toml', score: 850 });
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0] || { key: provider.envKey || candidateKeys[0] || null, value: '', source: null, score: 0 };
}

function maskSecretValue(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '*'.repeat(trimmed.length);
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

function buildProviderBase(config, key, provider = {}) {
  return {
    key,
    name: provider?.name || key,
    baseUrl: provider?.base_url || '',
    envKey: provider?.env_key || provider?.temp_env_key || '',
    wireApi: provider?.wire_api || 'responses',
    inlineBearerToken: provider?.experimental_bearer_token || '',
    isActive: config.model_provider === key,
  };
}

function resolveSavedProvider(config, envFile, authJson, providerKey) {
  const provider = config.model_providers?.[providerKey];
  if (!provider || typeof provider !== 'object') {
    throw new Error(`未找到 Provider：${providerKey}`);
  }

  const base = buildProviderBase(config, providerKey, provider);
  const secret = resolveProviderSecret(base, envFile, authJson);
  return { base, secret };
}

function summarizeProviders(config, envFile, authJson) {
  const providers = Object.entries(config.model_providers || {}).map(([key, provider]) => {
    const base = buildProviderBase(config, key, provider);
    const secret = resolveProviderSecret(base, envFile, authJson);
    return {
      key: base.key,
      name: base.name,
      baseUrl: base.baseUrl,
      envKey: base.envKey,
      wireApi: base.wireApi,
      hasInlineBearerToken: Boolean(base.inlineBearerToken),
      isActive: base.isActive,
      hasApiKey: Boolean(secret.value),
      maskedApiKey: maskSecretValue(secret.value),
      keySource: secret.source,
      resolvedKeyName: secret.key,
    };
  });

  providers.sort((left, right) => {
    if (left.isActive !== right.isActive) {
      return left.isActive ? -1 : 1;
    }
    return left.key.localeCompare(right.key);
  });

  return providers;
}

function buildImplicitCodexProvider(envFile = {}, authJson = {}) {
  const runtimeEnv = process.env || {};
  const pick = (...keys) => {
    for (const key of keys) {
      if (envFile[key]) return { key, value: envFile[key], source: '.env' };
      if (runtimeEnv[key]) return { key, value: runtimeEnv[key], source: 'system-env' };
      if (authJson[key]) return { key, value: authJson[key], source: 'auth.json' };
    }
    return null;
  };

  const secret = pick('OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_CLI_API_KEY');
  if (!secret?.value) return null;

  const baseUrl = String(
    envFile.OPENAI_BASE_URL
    || envFile.CODEX_BASE_URL
    || runtimeEnv.OPENAI_BASE_URL
    || runtimeEnv.CODEX_BASE_URL
    || authJson.OPENAI_BASE_URL
    || authJson.CODEX_BASE_URL
    || 'https://api.openai.com/v1'
  ).trim();

  return {
    key: 'openai',
    name: 'OpenAI（自动识别）',
    baseUrl,
    envKey: secret.key,
    wireApi: 'responses',
    hasInlineBearerToken: false,
    isActive: true,
    hasApiKey: true,
    maskedApiKey: maskSecretValue(secret.value),
    keySource: secret.source,
    resolvedKeyName: secret.key,
    inferred: true,
  };
}

async function readScopeState({ scope = 'global', projectPath = '', codexHome = defaultCodexHome() } = {}) {
  const normalizedCodexHome = path.resolve(codexHome);
  const paths = scopePaths({ scope, projectPath, codexHome: normalizedCodexHome });
  await ensureDir(normalizedCodexHome);

  const [configContent, envContent, authJson] = await Promise.all([
    readText(paths.configPath),
    readText(paths.envPath),
    readAuthJson(normalizedCodexHome),
  ]);

  return {
    normalizedCodexHome,
    paths,
    configContent,
    envContent,
    authJson,
    config: parseToml(configContent),
    env: parseEnv(envContent),
  };
}

async function createBackup({ configPath, envPath, scope }) {
  const targetDir = path.join(backupsRoot(), `${timestamp()}-${scope}`);
  await ensureDir(targetDir);
  await fs.writeFile(path.join(targetDir, 'config.toml.bak'), await readText(configPath), 'utf8');
  await fs.writeFile(path.join(targetDir, '.env.bak'), await readText(envPath), 'utf8');
  return targetDir;
}

function quoteWindowsCmdArg(value = '') {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function normalizeWindowsCmdPath(raw = '') {
  const trimmed = String(raw || '').trim();
  const unwrapped = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
  if (unwrapped.startsWith('\\\\?\\UNC\\')) return `\\\\${unwrapped.slice('\\\\?\\UNC\\'.length)}`;
  if (unwrapped.startsWith('\\\\?\\')) return unwrapped.slice('\\\\?\\'.length);
  return unwrapped;
}

function buildWindowsBinaryCommand(binaryPath = '', args = [], fallbackBinary = 'codex') {
  const normalized = normalizeWindowsCmdPath(binaryPath);
  if (!normalized) {
    return [fallbackBinary, ...args.map(arg => quoteWindowsCmdArg(String(arg)))].join(' ');
  }
  if (normalized.toLowerCase().endsWith('.ps1')) {
    return [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      quoteWindowsCmdArg(normalized),
      ...args.map(arg => quoteWindowsCmdArg(String(arg))),
    ].join(' ');
  }
  return [quoteWindowsCmdArg(normalized), ...args.map(arg => quoteWindowsCmdArg(String(arg)))].join(' ');
}

function writeWindowsTerminalLauncher(cwd, commandText) {
  const launcherDir = path.join(os.tmpdir(), 'easy-ai-config', 'launchers');
  mkdirSync(launcherDir, { recursive: true });
  const launcherPath = path.join(launcherDir, `launch-${crypto.randomUUID()}.cmd`);
  const script = `@echo off
cd /d ${quoteWindowsCmdArg(normalizeWindowsCmdPath(cwd))}
${commandText}
`;
  const bom = Buffer.from([0xFF, 0xFE]);
  const content = Buffer.from(script, 'utf16le');
  writeFileSync(launcherPath, Buffer.concat([bom, content]));
  return launcherPath;
}

function writeWindowsPowerShellLauncher(cwd, commandText) {
  const launcherDir = path.join(os.tmpdir(), 'easy-ai-config', 'launchers');
  mkdirSync(launcherDir, { recursive: true });
  const launcherPath = path.join(launcherDir, `launch-${crypto.randomUUID()}.ps1`);
  const escapedCwd = String(normalizeWindowsCmdPath(cwd)).replace(/'/g, "''");
  const escapedCommand = String(commandText || '').replace(/'/g, "''");
  const script = [
    `$ErrorActionPreference = 'Continue'`,
    `Set-Location -LiteralPath '${escapedCwd}'`,
    `Invoke-Expression '${escapedCommand}'`,
  ].join('\r\n');
  const bom = Buffer.from([0xFF, 0xFE]);
  const content = Buffer.from(script, 'utf16le');
  writeFileSync(launcherPath, Buffer.concat([bom, content]));
  return launcherPath;
}

function firstWindowsExistingPath(candidates = []) {
  for (const candidate of candidates) {
    const target = String(candidate || '').trim();
    if (!target) continue;
    if (existsSync(target)) return target;
  }
  return '';
}

function firstWindowsCommand(commands = []) {
  for (const command of commands) {
    const found = commandExists(command);
    if (found) return normalizeWindowsCmdPath(found);
  }
  return '';
}

function listDarwinTerminalProfiles() {
  if (process.platform !== 'darwin') return [];

  const homeApplications = path.join(os.homedir(), 'Applications');
  const wezterm = commandExists('wezterm');
  const ghostty = commandExists('ghostty');
  const alacritty = commandExists('alacritty');
  const kitty = commandExists('kitty');

  const profiles = [
    { id: 'auto', label: '自动选择（推荐）', available: true, command: '' },
    {
      id: 'terminal',
      label: 'Terminal.app',
      available: Boolean(firstExistingPath([
        '/System/Applications/Utilities/Terminal.app',
        '/Applications/Utilities/Terminal.app',
      ])),
      command: 'Terminal',
    },
    {
      id: 'iterm',
      label: 'iTerm',
      available: Boolean(firstExistingPath([
        '/Applications/iTerm.app',
        '/Applications/iTerm2.app',
        path.join(homeApplications, 'iTerm.app'),
        path.join(homeApplications, 'iTerm2.app'),
      ])),
      command: 'iTerm',
    },
    { id: 'wezterm', label: 'WezTerm', available: Boolean(wezterm), command: wezterm || '' },
    { id: 'ghostty', label: 'Ghostty', available: Boolean(ghostty), command: ghostty || '' },
    { id: 'alacritty', label: 'Alacritty', available: Boolean(alacritty), command: alacritty || '' },
    { id: 'kitty', label: 'kitty', available: Boolean(kitty), command: kitty || '' },
  ];

  return profiles
    .filter((profile) => profile.id === 'auto' || profile.available)
    .map((profile) => ({ id: profile.id, label: profile.label, command: profile.command, available: profile.available }));
}

function escapeAppleScriptText(value = '') {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\"/g, '\\\"');
}

function resolveDarwinTerminalProfile(profileId = 'auto') {
  const profiles = listDarwinTerminalProfiles();
  const requested = profiles.find((profile) => profile.id === String(profileId || 'auto').trim());
  if (requested && requested.id !== 'auto') return requested;
  return profiles.find((profile) => profile.id === 'iterm')
    || profiles.find((profile) => profile.id === 'terminal')
    || profiles.find((profile) => profile.id === 'wezterm')
    || profiles.find((profile) => profile.id === 'ghostty')
    || profiles.find((profile) => profile.id !== 'auto')
    || { id: 'terminal', label: 'Terminal.app', command: 'Terminal', available: true };
}

function launchDarwinTerminal(cwd, commandText, { toolLabel = 'Codex', terminalProfile = 'auto' } = {}) {
  const profile = resolveDarwinTerminalProfile(terminalProfile);
  const normalizedCwd = String(cwd || '').trim() || process.cwd();
  const shellCommand = `cd ${quotePosixShellArg(normalizedCwd)} && ${commandText}`;

  if (profile.id === 'terminal') {
    const appleScript = [
      'tell application "Terminal"',
      'activate',
      `do script "${escapeAppleScriptText(shellCommand)}"`,
      'end tell',
    ].join('\n');
    const result = spawnSync('osascript', ['-e', appleScript], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'Failed to open Terminal').trim());
    }
    return `${toolLabel} 已在 ${profile.label} 中启动`;
  }

  if (profile.id === 'iterm') {
    const appleScript = [
      'tell application "iTerm"',
      'activate',
      'create window with default profile',
      `tell current session of current window to write text "${escapeAppleScriptText(shellCommand)}"`,
      'end tell',
    ].join('\n');
    const result = spawnSync('osascript', ['-e', appleScript], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'Failed to open iTerm').trim());
    }
    return `${toolLabel} 已在 ${profile.label} 中启动`;
  }

  const terminalMap = {
    wezterm: [profile.command || 'wezterm', ['start', '--cwd', normalizedCwd, '--', 'bash', '-lc', shellCommand]],
    ghostty: [profile.command || 'ghostty', ['--working-directory', normalizedCwd, '-e', 'bash', '-lc', shellCommand]],
    alacritty: [profile.command || 'alacritty', ['--working-directory', normalizedCwd, '-e', 'bash', '-lc', shellCommand]],
    kitty: [profile.command || 'kitty', ['--directory', normalizedCwd, 'bash', '-lc', shellCommand]],
  };
  const [command, args] = terminalMap[profile.id] || [];
  if (!command) {
    throw new Error(`当前终端 ${profile.label} 暂不支持自动启动命令`);
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return `${toolLabel} 已在 ${profile.label} 中启动`;
}

export function listWindowsTerminalProfiles() {
  if (process.platform !== 'win32') return [];

  const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles?.trim() || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)']?.trim() || 'C:\\Program Files (x86)';

  const profiles = [
    { id: 'auto', label: '自动选择（推荐）', command: '', available: true },
    { id: 'windows-terminal', label: 'Windows Terminal', command: firstWindowsCommand(['wt.exe', 'wt']) || firstWindowsExistingPath([path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe')]), available: false },
    { id: 'powershell-7', label: 'PowerShell 7', command: firstWindowsCommand(['pwsh.exe', 'pwsh']), available: false },
    { id: 'powershell', label: 'Windows PowerShell', command: firstWindowsCommand(['powershell.exe', 'powershell']), available: false },
    { id: 'cmd', label: '命令提示符 CMD', command: firstWindowsCommand(['cmd.exe', 'cmd']) || 'cmd.exe', available: true },
    { id: 'wezterm', label: 'WezTerm', command: firstWindowsCommand(['wezterm.exe', 'wezterm']) || firstWindowsExistingPath([
      path.join(localAppData, 'Programs', 'WezTerm', 'wezterm-gui.exe'),
      path.join(programFiles, 'WezTerm', 'wezterm-gui.exe'),
      path.join(programFilesX86, 'WezTerm', 'wezterm-gui.exe'),
    ]), available: false },
  ];

  return profiles
    .map((profile) => ({ ...profile, available: Boolean(profile.available || profile.command) }))
    .filter((profile) => profile.id === 'auto' || profile.available)
    .map((profile) => ({ id: profile.id, label: profile.label, command: profile.command, available: profile.available }));
}

function resolveWindowsTerminalProfile(profileId = 'auto') {
  const profiles = listWindowsTerminalProfiles();
  const requested = profiles.find((profile) => profile.id === String(profileId || 'auto').trim());
  if (requested && requested.id !== 'auto') return requested;
  return profiles.find((profile) => profile.id === 'windows-terminal')
    || profiles.find((profile) => profile.id === 'powershell-7')
    || profiles.find((profile) => profile.id === 'powershell')
    || profiles.find((profile) => profile.id === 'cmd')
    || profiles.find((profile) => profile.id !== 'auto')
    || { id: 'cmd', label: '命令提示符 CMD', command: 'cmd.exe', available: true };
}

function launchWindowsTerminal(cwd, commandText, { toolLabel = 'Codex', terminalProfile = 'auto' } = {}) {
  const profile = resolveWindowsTerminalProfile(terminalProfile);
  const launcherCmdPath = writeWindowsTerminalLauncher(cwd, commandText);
  const normalizedCwd = normalizeWindowsCmdPath(cwd);
  const normalizedCmdLauncher = normalizeWindowsCmdPath(launcherCmdPath);

  let command = 'cmd.exe';
  let args = ['/c', 'start', '', 'cmd.exe', '/d', '/k', quoteWindowsCmdArg(normalizedCmdLauncher)];

  if (profile.id === 'windows-terminal') {
    command = profile.command || 'wt.exe';
    args = ['-d', normalizedCwd, 'cmd.exe', '/d', '/k', normalizedCmdLauncher];
  } else if (profile.id === 'powershell-7' || profile.id === 'powershell') {
    const psLauncherPath = writeWindowsPowerShellLauncher(cwd, commandText);
    command = profile.command || (profile.id === 'powershell-7' ? 'pwsh.exe' : 'powershell.exe');
    args = ['-NoExit', '-ExecutionPolicy', 'Bypass', '-File', normalizeWindowsCmdPath(psLauncherPath)];
  } else if (profile.id === 'wezterm') {
    command = profile.command || 'wezterm.exe';
    args = ['start', '--cwd', normalizedCwd, 'cmd.exe', '/d', '/k', normalizedCmdLauncher];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return `${toolLabel} 已在 ${profile.label} 中启动`;
}

function launchTerminalCommand(cwd, { binaryPath, binaryName = 'codex', toolLabel = 'Codex', commandText = '', terminalProfile = 'auto' } = {}) {
  const bin = commandText || binaryPath || binaryName;
  const escapedCwd = String(cwd).replace(/([\\"$])/g, '\\$1');
  const escapedBin = String(bin).replace(/([\\"$])/g, '\\$1');
  const windowsBin = commandText || (binaryPath ? buildWindowsBinaryCommand(binaryPath, [], binaryName) : bin);

  if (process.platform === 'darwin') {
    return launchDarwinTerminal(cwd, escapedBin, { toolLabel, terminalProfile });
  }

  if (process.platform === 'win32') {
    return launchWindowsTerminal(cwd, windowsBin, { toolLabel, terminalProfile });
  }

  const terminals = [
    ['x-terminal-emulator', ['-e', `bash -lc "cd \\"${escapedCwd}\\" && ${bin}"`]],
    ['gnome-terminal', ['--', 'bash', '-lc', `cd "${escapedCwd}" && ${bin}`]],
    ['konsole', ['-e', 'bash', '-lc', `cd "${escapedCwd}" && ${bin}`]],
  ];

  for (const [command, args] of terminals) {
    if (!commandExists(command)) {
      continue;
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return `${toolLabel} 已在新终端中启动`;
  }

  throw new Error(`没有找到可用终端，请先手动运行 ${commandText || binaryName}`);
}

function launchWindowsBackgroundCommand(cwd, commandText, { toolLabel = 'OpenClaw Gateway' } = {}) {
  const child = spawn('cmd.exe', ['/d', '/s', '/c', commandText], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return `${toolLabel} 已在后台启动`;
}

function buildWindowsCommand(binaryPath, args = []) {
  const program = quoteWindowsCmdArg(normalizeWindowsCmdPath(binaryPath || ''));
  const safeArgs = args.map((arg) => quoteWindowsCmdArg(arg));
  return [program, ...safeArgs].filter(Boolean).join(' ');
}

async function findWindowsListeningPids(port) {
  const normalizedPort = String(port || '').trim();
  if (process.platform !== 'win32' || !normalizedPort) return [];
  const result = await runCommand('netstat', ['-ano', '-p', 'tcp']);
  if (!result.ok) return [];

  const pids = new Set();
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || !/LISTENING/i.test(text)) continue;
    const parts = text.split(/\s+/);
    if (parts.length < 5) continue;
    const localAddress = parts[1] || '';
    const pid = parts[4] || '';
    if (localAddress.endsWith(`:${normalizedPort}`) && /^\d+$/.test(pid)) {
      pids.add(pid);
    }
  }
  return [...pids];
}

function parseWindowsCsvLine(line = '') {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  values.push(current);
  return values.map((item) => item.trim());
}

async function inspectWindowsProcess(pid) {
  const normalizedPid = String(pid || '').trim();
  if (!/^\d+$/.test(normalizedPid)) return null;

  const psCommand = `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${normalizedPid}\" | Select-Object ProcessId,Name,CommandLine; if ($p) { $p | ConvertTo-Json -Compress }`;
  const psResult = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand]);
  if (psResult.ok && String(psResult.stdout || '').trim()) {
    try {
      const parsed = JSON.parse(String(psResult.stdout || '').trim());
      const name = String(parsed.Name || '').trim();
      const commandLine = String(parsed.CommandLine || '').trim();
      return {
        pid: Number(parsed.ProcessId || normalizedPid),
        name: name || '未知进程',
        commandLine,
        likelyOpenClaw: /openclaw/i.test(`${name} ${commandLine}`),
      };
    } catch { /* ignore */ }
  }

  const tasklist = await runCommand('tasklist', ['/FI', `PID eq ${normalizedPid}`, '/FO', 'CSV', '/NH']);
  const firstLine = String(tasklist.stdout || '').split(/\r?\n/).find((line) => line.trim() && !/^INFO:/i.test(line.trim()));
  if (!firstLine) return null;
  const [name] = parseWindowsCsvLine(firstLine);
  return {
    pid: Number(normalizedPid),
    name: name || '未知进程',
    commandLine: '',
    likelyOpenClaw: /openclaw/i.test(String(name || '')),
  };
}

async function inspectOpenClawPortOccupants(port) {
  const normalizedPort = String(port || '').trim();
  if (!normalizedPort) return [];
  if (process.platform === 'win32') {
    const pids = await findWindowsListeningPids(normalizedPort);
    const items = await Promise.all(pids.map((pid) => inspectWindowsProcess(pid)));
    return items.filter(Boolean).map((item) => ({
      ...item,
      label: `${item.name} (PID ${item.pid})`,
    }));
  }
  return [];
}

async function probeOpenClawGateway(gatewayUrl) {
  let httpReady = false;
  let portListening = false;

  try {
    const target = new URL(gatewayUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const response = await fetch(target, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);
    httpReady = response.status > 0;
  } catch { /* ignore */ }

  if (!httpReady) {
    try {
      const target = new URL(gatewayUrl);
      const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: target.hostname, port });
        const timer = setTimeout(() => socket.destroy(new Error('timeout')), 1500);
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.end();
          resolve(true);
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.once('close', () => clearTimeout(timer));
      });
      portListening = true;
    } catch { /* ignore */ }
  }

  if (httpReady) portListening = true;
  return {
    httpReady,
    portListening,
    reachable: httpReady,
    status: httpReady ? 'online' : portListening ? 'warming' : 'offline',
  };
}

function readOpenClawDaemonState(binaryPath) {
  if (!binaryPath) {
    return {
      supported: false,
      installed: false,
      loaded: false,
      running: false,
      status: 'unsupported',
      label: '不支持',
      detail: '',
    };
  }

  const result = runSpawnSync(binaryPath, ['daemon', 'status'], {
    cwd: openclawHome(),
    encoding: 'utf8',
    timeout: 2500,
  });
  const text = `${result.stdout || ''}
${result.stderr || ''}`.trim();
  const normalized = text.toLowerCase();
  const installed = !(/service not installed|service unit not found|could not find service/.test(normalized));
  const loaded = /(launchagent \(loaded\)|service:\s+.*\(loaded\)|runtime:\s+running)/.test(normalized);
  const running = /runtime:\s+running/.test(normalized);
  const status = running ? 'running' : loaded ? 'loaded' : installed ? 'stopped' : 'not_installed';
  const label = status === 'running'
    ? '运行中'
    : status === 'loaded'
      ? '已加载'
      : status === 'stopped'
        ? '已关闭'
        : '未启用';

  return {
    supported: true,
    installed,
    loaded,
    running,
    status,
    label,
    detail: tailText(text, 6),
  };
}

export async function checkSetupEnvironment({ codexHome = defaultCodexHome() } = {}) {
  const normalizedCodexHome = path.resolve(codexHome);

  // 1. Check Node.js
  const nodeResult = runSpawnSync('node', ['--version'], { encoding: 'utf8' });
  const nodeInstalled = nodeResult.status === 0;
  const nodeVersion = nodeInstalled ? (nodeResult.stdout || '').trim() : null;
  const nodeMajor = nodeVersion ? parseInt((nodeVersion.match(/v?(\d+)/) || [])[1] || '0', 10) : 0;

  // 2. Check npm
  const npmResult = runSpawnSync(npmCommand(), ['--version'], { encoding: 'utf8' });
  const npmInstalled = npmResult.status === 0;
  const npmVersion = npmInstalled ? (npmResult.stdout || '').trim() : null;

  // 3. Check codex binary
  const codexBinary = findCodexBinary();

  // 4. Check config files
  const globalConfigPath = path.join(normalizedCodexHome, 'config.toml');
  const globalEnvPath = path.join(normalizedCodexHome, '.env');
  const authJson = await readAuthJson(normalizedCodexHome);
  const login = summarizeCodexLogin(authJson);
  const configContent = await readText(globalConfigPath);
  const envContent = await readText(globalEnvPath);
  const configExists = Boolean(configContent.trim());
  const envExists = Boolean(envContent.trim());

  // 5. Check if there are any providers configured
  let hasProviders = false;
  let hasActiveProvider = false;
  if (configExists) {
    try {
      const config = parseToml(configContent);
      hasProviders = Boolean(config.model_providers && Object.keys(config.model_providers).length > 0);
      hasActiveProvider = Boolean(config.model_provider);
    } catch { /* ignore parse errors */ }
  }

  // Determine overall readiness
  const needsSetup = !codexBinary.installed || (!configExists && !login.loggedIn) || (!hasProviders && !login.loggedIn);

  return {
    node: {
      installed: nodeInstalled,
      version: nodeVersion,
      major: nodeMajor,
      sufficient: nodeMajor >= 18,
    },
    npm: {
      installed: npmInstalled,
      version: npmVersion,
    },
    codex: {
      installed: codexBinary.installed,
      version: codexBinary.version,
      path: codexBinary.path,
    },
    config: {
      exists: configExists,
      envExists,
      hasProviders,
      hasActiveProvider,
      hasLogin: login.loggedIn,
      configPath: globalConfigPath,
      envPath: globalEnvPath,
    },
    login,
    needsSetup,
    codexHome: normalizedCodexHome,
  };
}

export async function loadState({ scope = 'global', projectPath = '', codexHome = defaultCodexHome() } = {}) {
  const { normalizedCodexHome, paths, configContent, envContent, authJson, config, env } = await readScopeState({
    scope,
    projectPath,
    codexHome,
  });
  const providers = summarizeProviders(config, env, authJson);
  const implicitProvider = providers.length ? null : buildImplicitCodexProvider(env, authJson);
  if (implicitProvider) providers.push(implicitProvider);
  const activeProvider = providers.find((provider) => provider.isActive) || providers[0] || null;
  const login = summarizeCodexLogin(authJson);
  const codexBinary = findCodexBinary();

  return {
    appHome: appHome(),
    codexHome: normalizedCodexHome,
    codexBinary,
    scope: paths.scope,
    rootPath: paths.rootPath,
    projectPath: scope === 'project' ? paths.rootPath : '',
    configPath: paths.configPath,
    envPath: paths.envPath,
    configExists: Boolean(configContent.trim()),
    envExists: Boolean(envContent.trim()),
    configToml: configContent,
    config,
    providers,
    activeProvider,
    login,
    summary: {
      model: config.model || '',
      modelProvider: config.model_provider || activeProvider?.key || '',
      providerBaseUrl: activeProvider?.baseUrl || '',
      envKey: activeProvider?.resolvedKeyName || activeProvider?.envKey || '',
      approvalPolicy: config.approval_policy || '',
      sandboxMode: config.sandbox_mode || '',
      reasoningEffort: config.model_reasoning_effort || '',
      providerCount: providers.length,
    },
    launch: {
      cwd: scope === 'project' ? paths.rootPath : process.cwd(),
      ready: codexBinary.installed,
      platform: process.platform,
      terminalProfiles: process.platform === 'win32'
        ? listWindowsTerminalProfiles()
        : process.platform === 'darwin'
          ? listDarwinTerminalProfiles()
          : [],
    },
  }
}

/**
 * Read relevant environment variables from the local system for provider auto-detection.
 * Scans process.env, .env files, and auth.json for ANTHROPIC_*, OPENAI_*, CODEX_* keys.
 */
export async function readLocalEnvVars({ codexHome = defaultCodexHome() } = {}) {
  const normalizedCodexHome = path.resolve(codexHome);
  const envFilePath = path.join(normalizedCodexHome, '.env');
  const envContent = await readText(envFilePath);
  const envFileVars = parseEnv(envContent);
  const authJson = await readAuthJson(normalizedCodexHome);

  const ENV_PREFIXES = ['ANTHROPIC_', 'OPENAI_', 'CODEX_', 'CLAUDE_'];
  const result = {};

  // Collect from process.env
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_PREFIXES.some(prefix => key.startsWith(prefix)) && value) {
      result[key] = {
        value,
        masked: maskSecretValue(value),
        source: 'system-env',
      };
    }
  }

  // Collect from .env file (overrides system env display)
  for (const [key, value] of Object.entries(envFileVars)) {
    if (ENV_PREFIXES.some(prefix => key.startsWith(prefix)) && value) {
      result[key] = {
        value,
        masked: maskSecretValue(value),
        source: '.env',
      };
    }
  }

  // Collect from auth.json
  for (const [key, value] of Object.entries(authJson)) {
    if (typeof value === 'string' && value && ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
      if (!result[key]) {
        result[key] = {
          value,
          masked: maskSecretValue(value),
          source: 'auth.json',
        };
      }
    }
  }

  return result;
}

export async function getProviderSecret({ scope = 'global', projectPath = '', codexHome = defaultCodexHome(), providerKey = '' } = {}) {
  const safeProviderKey = String(providerKey || '').trim();
  if (!safeProviderKey) {
    throw new Error('providerKey is required');
  }

  const { config, env, authJson } = await readScopeState({ scope, projectPath, codexHome });
  const { base, secret } = resolveSavedProvider(config, env, authJson, safeProviderKey);
  if (!secret.value) {
    throw new Error(`Provider ${base.name} 未找到 API Key`);
  }

  return {
    providerKey: base.key,
    providerName: base.name,
    baseUrl: base.baseUrl,
    hasApiKey: true,
    maskedApiKey: maskSecretValue(secret.value),
    apiKey: secret.value,
    keySource: secret.source,
    resolvedKeyName: secret.key,
  };
}

export async function testSavedProvider({
  scope = 'global',
  projectPath = '',
  codexHome = defaultCodexHome(),
  providerKey = '',
  timeoutMs = 6000,
} = {}) {
  const safeProviderKey = String(providerKey || '').trim();
  if (!safeProviderKey) {
    throw new Error('providerKey is required');
  }

  const { config, env, authJson } = await readScopeState({ scope, projectPath, codexHome });
  const { base, secret } = resolveSavedProvider(config, env, authJson, safeProviderKey);
  if (!base.baseUrl) {
    throw new Error(`Provider ${base.name} 未配置 Base URL`);
  }
  if (!secret.value) {
    throw new Error(`Provider ${base.name} 未找到 API Key`);
  }

  return detectProvider({ baseUrl: base.baseUrl, apiKey: secret.value, timeoutMs });
}

export async function saveConfig(payload) {
  const codexHome = assertAllowedPath(payload.codexHome || defaultCodexHome(), 'codexHome');
  const paths = scopePaths({
    scope: payload.scope || 'global',
    projectPath: payload.projectPath || '',
    codexHome,
  });

  const [configContent, envContent] = await Promise.all([
    readText(paths.configPath),
    readText(paths.envPath),
  ]);

  const config = parseToml(configContent);
  const originalConfig = structuredClone(config);
  const env = parseEnv(envContent);
  const originalEnv = { ...env };
  const baseUrl = normalizeBaseUrl(payload.baseUrl);
  const apiKey = String(payload.apiKey || '').trim();
  const inferredProviderKey = slugifyProviderKey(inferProviderSeed(baseUrl));
  const requestedProviderKey = slugifyProviderKey(payload.providerKey || inferredProviderKey);
  const legacyProviderKey = slugifyProviderKey(legacyInferProviderSeed(baseUrl));
  const providerKey = requestedProviderKey === legacyProviderKey && requestedProviderKey !== inferredProviderKey
    ? inferredProviderKey
    : requestedProviderKey;
  const matchedProviderEntry = findProviderEntryByBaseUrl(config, baseUrl);
  const matchedProviderKey = matchedProviderEntry?.[0] || '';
  const matchedProvider = matchedProviderEntry?.[1] || {};
  const currentProvider = config.model_providers?.[providerKey]
    || (matchedProviderKey && matchedProviderKey !== providerKey ? matchedProvider : {})
    || {};
  const providerLabel = String(payload.providerLabel || currentProvider.name || inferProviderLabel(baseUrl, providerKey)).trim() || providerKey;
  const envKey = String(payload.envKey || currentProvider.env_key || inferEnvKey(providerKey)).trim();
  const model = String(payload.model || '').trim();
  const approvalPolicy = String(payload.approvalPolicy || '').trim();
  const sandboxMode = String(payload.sandboxMode || '').trim();
  const reasoningEffort = String(payload.reasoningEffort || '').trim();

  config.model_provider = providerKey;
  if (model) config.model = model;
  if (approvalPolicy) config.approval_policy = approvalPolicy;
  if (sandboxMode) config.sandbox_mode = sandboxMode;
  if (reasoningEffort) config.model_reasoning_effort = reasoningEffort;
  if (!config.model_providers || typeof config.model_providers !== 'object') {
    config.model_providers = {};
  }

  const nextProvider = {
    ...currentProvider,
    name: providerLabel,
    base_url: baseUrl,
    env_key: envKey,
  };
  if (!nextProvider.wire_api) {
    nextProvider.wire_api = 'responses';
  }
  config.model_providers[providerKey] = nextProvider;
  if (matchedProviderKey && matchedProviderKey !== providerKey) {
    delete config.model_providers[matchedProviderKey];
  }

  if (apiKey && envKey) {
    env[envKey] = apiKey;
  }

  const configChanged = JSON.stringify(config) !== JSON.stringify(originalConfig);
  const envChanged = JSON.stringify(env) !== JSON.stringify(originalEnv);
  const needsWrite = configChanged || envChanged;
  const backupPath = needsWrite ? await createBackup(paths) : null;

  if (configChanged) {
    await writeText(paths.configPath, TOML.stringify(config));
  }
  if (envChanged) {
    await writeText(paths.envPath, stringifyEnv(env));
  }

  return {
    saved: true,
    backupPath,
    paths,
    activeProvider: providerKey,
    changed: {
      config: configChanged,
      env: envChanged,
    },
  };
}

export async function saveSettings(payload) {
  const codexHome = assertAllowedPath(payload.codexHome || defaultCodexHome(), 'codexHome');
  const paths = scopePaths({
    scope: payload.scope || 'global',
    projectPath: payload.projectPath || '',
    codexHome,
  });

  const configContent = await readText(paths.configPath);
  const config = parseToml(configContent);
  const originalConfig = structuredClone(config);
  applyPatch(config, normalizeSettingsPatch(payload.settings || {}));

  const changed = JSON.stringify(config) !== JSON.stringify(originalConfig);
  const backupPath = changed ? await createBackup(paths) : null;
  if (changed) {
    await writeText(paths.configPath, TOML.stringify(config));
  }

  return {
    saved: true,
    backupPath,
    paths,
    changed,
  };
}

export async function saveRawConfig(payload) {
  const codexHome = assertAllowedPath(payload.codexHome || defaultCodexHome(), 'codexHome');
  const paths = scopePaths({
    scope: payload.scope || 'global',
    projectPath: payload.projectPath || '',
    codexHome,
  });

  const configToml = String(payload.configToml || '');
  if (!configToml.trim()) {
    throw new Error('config.toml 内容不能为空');
  }

  try {
    TOML.parse(configToml);
  } catch (error) {
    throw new Error(`TOML 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const currentContent = await readText(paths.configPath);
  const changed = currentContent !== configToml;
  const backupPath = changed ? await createBackup(paths) : null;
  if (changed) {
    await writeText(paths.configPath, configToml);
  }

  return {
    saved: true,
    backupPath,
    paths,
    changed,
  };
}

export async function listBackups() {
  await ensureDir(backupsRoot());
  const entries = await fs.readdir(backupsRoot(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(backupsRoot(), entry.name),
    }))
    .sort((left, right) => right.name.localeCompare(left.name));
}

export async function restoreBackup({ backupName, scope = 'global', projectPath = '', codexHome = defaultCodexHome() }) {
  const normalizedCodexHome = assertAllowedPath(codexHome, 'codexHome');
  const paths = scopePaths({ scope, projectPath, codexHome: normalizedCodexHome });
  const backupDir = resolveBackupDir(backupName);
  const [configContent, envContent] = await Promise.all([
    readText(path.join(backupDir, 'config.toml.bak')),
    readText(path.join(backupDir, '.env.bak')),
  ]);

  await writeText(paths.configPath, configContent);
  await writeText(paths.envPath, envContent);
  return { restored: true, paths };
}

async function codexNpmAction(args) {
  const result = await runCommand(npmCommand(), args);
  return {
    ...result,
    command: `${npmCommand()} ${args.join(' ')}`,
  };
}

export async function getCodexReleaseInfo() {
  const result = await runCommand(npmCommand(), ['view', OPENAI_CODEX_PACKAGE, 'dist-tags', '--json']);
  if (!result.ok) {
    throw new Error((result.stderr || result.stdout || '获取版本信息失败').trim());
  }

  let tags = {};
  try {
    tags = JSON.parse(result.stdout || '{}');
  } catch {
    tags = {};
  }

  const current = findCodexBinary().version || '';
  const currentVersion = (current.match(/\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?/i) || [null])[0];
  const latestStable = tags.latest || null;
  const latestAlpha = tags.alpha || null;

  return {
    currentVersion,
    latestStable,
    latestAlpha,
    hasStableUpdate: Boolean(currentVersion && latestStable && compareCodexVersions(latestStable, currentVersion) > 0),
    hasAlphaUpdate: Boolean(currentVersion && latestAlpha && compareCodexVersions(latestAlpha, currentVersion) > 0),
    isInstalled: findCodexBinary().installed,
  };
}

export async function installCodex() {
  return codexNpmAction(['install', '-g', OPENAI_CODEX_PACKAGE]);
}

export async function reinstallCodex() {
  return codexNpmAction(['install', '-g', OPENAI_CODEX_PACKAGE, '--force']);
}

export async function updateCodex() {
  return codexNpmAction(['install', '-g', `${OPENAI_CODEX_PACKAGE}@latest`]);
}

export async function uninstallCodex() {
  return codexNpmAction(['uninstall', '-g', OPENAI_CODEX_PACKAGE]);
}

function normalizeCodexSessionPreview(text = '', fallback = '未命名会话') {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return fallback;
  return collapsed.length > 72 ? `${collapsed.slice(0, 72)}…` : collapsed;
}

function extractCodexSessionIdFromFilename(filePath = '') {
  const stem = path.basename(String(filePath || ''), '.jsonl');
  const match = stem.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (match?.[1]) return match[1];
  return stem;
}

function normalizeCodexSessionId(sessionId = '') {
  const raw = String(sessionId || '').trim();
  if (!raw) return '';
  const direct = raw.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  if (direct?.[0]) return direct[0];
  const tail = raw.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (tail?.[1]) return tail[1];
  return raw;
}

function extractCodexUserMessagePreview(event = {}) {
  if (event.type === 'event_msg' && event.payload?.type === 'user_message') {
    return normalizeCodexSessionPreview(event.payload?.message || '');
  }
  if (event.type === 'response_item' && event.payload?.type === 'message' && event.payload?.role === 'user') {
    const content = Array.isArray(event.payload?.content) ? event.payload.content : [];
    const joined = content
      .filter((item) => item?.type === 'input_text')
      .map((item) => String(item.text || '').trim())
      .filter(Boolean)
      .join(' ');
    return normalizeCodexSessionPreview(joined);
  }
  return '';
}

function isSameOrNestedPath(left = '', right = '') {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) return false;
  const leftPath = path.resolve(a);
  const rightPath = path.resolve(b);
  if (leftPath === rightPath) return true;
  const leftPrefix = `${leftPath}${path.sep}`;
  const rightPrefix = `${rightPath}${path.sep}`;
  return leftPath.startsWith(rightPrefix) || rightPath.startsWith(leftPrefix);
}

async function readCodexSessionSummary(filePath) {
  let raw = '';
  let stat = null;
  try {
    [raw, stat] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)]);
  } catch {
    return null;
  }

  let sessionId = '';
  let cwd = '';
  let provider = '';
  let model = '';
  let title = '';

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }

    if (event.type === 'session_meta') {
      sessionId = String(event.payload?.id || sessionId || '').trim();
      cwd = String(event.payload?.cwd || cwd || '').trim();
      provider = String(event.payload?.model_provider || provider || '').trim();
      const metaModel = String(event.payload?.model || '').trim();
      if (metaModel) model = metaModel;
      continue;
    }

    if (event.type === 'turn_context') {
      const turnPayload = event.payload && typeof event.payload === 'object' ? event.payload : {};
      const turnModel = String(turnPayload.model || '').trim();
      if (turnModel) model = turnModel;
      if (!cwd) {
        const turnCwd = String(turnPayload.cwd || '').trim();
        if (turnCwd) cwd = turnCwd;
      }
      continue;
    }

    if (!title) {
      title = extractCodexUserMessagePreview(event);
    }
  }

  const fallbackSessionId = extractCodexSessionIdFromFilename(filePath);
  const updatedAtMs = Number(stat?.mtimeMs || Date.now());
  return {
    sessionId: sessionId || fallbackSessionId,
    title: title || normalizeCodexSessionPreview(path.basename(filePath, '.jsonl')),
    cwd,
    provider: provider || 'unknown',
    model: model || 'unknown',
    updatedAt: new Date(updatedAtMs).toISOString(),
    updatedAtMs,
    filePath,
  };
}

export async function listCodexSessions({ cwd = '', codexHome = defaultCodexHome(), limit = 20, all = false } = {}) {
  const normalizedCodexHome = path.resolve(codexHome || defaultCodexHome());
  const sessionsRoot = path.join(normalizedCodexHome, 'sessions');
  const targetCwd = String(cwd || '').trim();
  const maxItems = Math.max(1, Math.min(100, Number(limit) || 20));
  const files = (await listFilesRecursive(sessionsRoot)).filter((filePath) => filePath.endsWith('.jsonl'));

  const fileEntries = await Promise.all(files.map(async (filePath) => {
    try {
      const stat = await fs.stat(filePath);
      return { filePath, mtimeMs: Number(stat.mtimeMs || 0) };
    } catch {
      return null;
    }
  }));

  const sorted = fileEntries.filter(Boolean).sort((left, right) => right.mtimeMs - left.mtimeMs);
  const items = [];
  for (const entry of sorted) {
    const summary = await readCodexSessionSummary(entry.filePath);
    if (!summary) continue;
    if (!all && targetCwd && !isSameOrNestedPath(summary.cwd, targetCwd)) continue;
    items.push(summary);
    if (items.length >= maxItems) break;
  }

  return {
    ok: true,
    source: sessionsRoot,
    cwd: targetCwd,
    all: Boolean(all),
    items,
  };
}

function buildCodexSessionCommand(codexBinary, args = []) {
  if (process.platform === 'win32') {
    return buildWindowsBinaryCommand(codexBinary.path || '', args, 'codex');
  }
  const binary = codexBinary.path ? quotePosixShellArg(String(codexBinary.path)) : 'codex';
  return [binary, ...args.map((arg) => quotePosixShellArg(String(arg)))].join(' ');
}

async function launchCodexSessionAction({ cwd, sessionId = '', action = 'resume', last = false, terminalProfile = 'auto' } = {}) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const codexBinary = findCodexBinary();
  if (!codexBinary.installed) {
    throw new Error('Codex 尚未安装，请先点击安装');
  }
  const normalizedSessionId = normalizeCodexSessionId(sessionId);
  const subcommand = action === 'fork' ? 'fork' : 'resume';
  const args = [subcommand];
  if (last) args.push('--last');
  else if (normalizedSessionId) args.push(normalizedSessionId);
  else throw new Error('缺少会话 ID');

  const message = launchTerminalCommand(targetCwd, {
    binaryPath: codexBinary.path,
    binaryName: 'codex',
    toolLabel: action === 'fork' ? 'Codex 分叉恢复' : 'Codex 会话恢复',
    commandText: buildCodexSessionCommand(codexBinary, args),
    terminalProfile,
  });
  return { ok: true, cwd: targetCwd, sessionId: normalizedSessionId, message };
}

export async function resumeCodexSession({ cwd, sessionId = '', last = false, terminalProfile = 'auto' } = {}) {
  return launchCodexSessionAction({ cwd, sessionId, last, action: 'resume', terminalProfile });
}

export async function forkCodexSession({ cwd, sessionId = '', terminalProfile = 'auto' } = {}) {
  return launchCodexSessionAction({ cwd, sessionId, action: 'fork', terminalProfile });
}

export async function launchCodex({ cwd, terminalProfile = 'auto' } = {}) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const codexBinary = findCodexBinary();
  if (!codexBinary.installed) {
    throw new Error('Codex 尚未安装，请先点击安装');
  }

  const message = launchTerminalCommand(targetCwd, {
    binaryPath: codexBinary.path,
    binaryName: 'codex',
    toolLabel: 'Codex',
    terminalProfile,
  });
  return { ok: true, cwd: targetCwd, message };
}

export async function loginCodex({ cwd, terminalProfile = 'auto' } = {}) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const codexHome = defaultCodexHome();
  const authPath = path.join(codexHome, 'auth.json');
  const authRaw = await readText(authPath);
  if (authRaw.trim()) {
    await preserveCodexAuthJsonEntriesToEnv({ codexHome, authRaw });
    await backupCodexAuthJson(authRaw);
  }
  const codexBinary = findCodexBinary();
  if (!codexBinary.installed) {
    throw new Error('Codex 尚未安装，请先点击安装');
  }

  const message = launchTerminalCommand(targetCwd, {
    binaryPath: codexBinary.path,
    binaryName: 'codex',
    toolLabel: 'Codex 登录',
    commandText: buildCodexSessionCommand(codexBinary, ['login']),
    terminalProfile,
  });
  return { ok: true, cwd: targetCwd, message };
}

/* ═══════════════  Claude Code  ═══════════════ */
const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code';

function claudeCodeHome() {
  return path.join(os.homedir(), '.claude');
}

function readJsonFile(filePath) {
  return readText(filePath).then(raw => {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try { return JSON.parse(trimmed); } catch { return {}; }
  });
}

async function writeJsonFile(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}


async function readClaudeTelemetryUsage({ days = 30 } = {}) {
  const home = claudeCodeHome();
  const projectsRoot = path.join(home, 'projects');
  const cutoffMs = Date.now() - Math.max(1, Math.min(90, Number(days) || 30)) * 24 * 60 * 60 * 1000;
  const sessions = new Map();
  const daily = new Map();
  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cost: 0 };
  const modelTotals = new Map(); // model -> { input, output, cacheRead, cacheCreation, total }
  const dailyModelTokens = new Map(); // date -> { tokensByModel: { model: total } }


  // Pricing per million tokens (Anthropic official)
  const PRICING = {
    'claude-opus-4-6':   { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
    'claude-sonnet-4-6': { input: 3,  output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
    'claude-haiku-4-5':  { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
  };
  function matchPricing(model) {
    const m = (model || '').toLowerCase();
    if (m.includes('opus'))   return PRICING['claude-opus-4-6'];
    if (m.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
    if (m.includes('haiku'))  return PRICING['claude-haiku-4-5'];
    return PRICING['claude-opus-4-6']; // default
  }
  function calcCost(u, model) {
    const p = matchPricing(model);
    return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheCreation * p.cacheCreate) / 1_000_000;
  }

  // Scan all project directories for session JSONL files
  let projectDirs = [];
  try {
    const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    projectDirs = entries.filter(e => e.isDirectory()).map(e => path.join(projectsRoot, e.name));
  } catch { /* no projects dir */ }

  for (const projDir of projectDirs) {
    let files = [];
    try {
      files = (await fs.readdir(projDir)).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }

    for (const fileName of files) {
      const filePath = path.join(projDir, fileName);
      const sessionId = fileName.replace('.jsonl', '');
      let content = '';
      try { content = await fs.readFile(filePath, 'utf8'); } catch { continue; }

      const usageEntries = new Map();
      let primaryModel = '';

      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (!record || typeof record !== 'object') continue;

        const ts = record.timestamp;
        let parsedTs = null;
        if (typeof ts === 'string') {
          parsedTs = Date.parse(ts);
        } else if (typeof ts === 'number') {
          parsedTs = ts > 1e12 ? ts : ts * 1000;
        }
        if (!Number.isFinite(parsedTs) || parsedTs < cutoffMs) continue;

        const msg = record.message;
        if (!msg || typeof msg !== 'object') continue;
        const usage = msg.usage;
        if (!usage) continue;

        const model = String(msg.model || '').trim();
        if (model && !model.startsWith('<')) primaryModel = model;

        const u = {
          input: Number(usage.input_tokens || 0),
          output: Number(usage.output_tokens || 0),
          cacheRead: Number(usage.cache_read_input_tokens || 0),
          cacheCreation: Number(usage.cache_creation_input_tokens || 0),
        };
        const total = u.input + u.output + u.cacheRead + u.cacheCreation;
        const usageKey = buildUsageRequestKey({
          sessionKey: sessionId,
          sources: [record, msg, usage],
          idPaths: ['requestId', 'request_id', 'request.id', 'message.requestId', 'message.request_id', 'messageId', 'message_id', 'id', 'uuid'],
          parentPaths: ['conversationId', 'conversation_id', 'threadId', 'thread_id'],
        }) || `${sessionId}:${parsedTs}:${model}:${u.input}:${u.output}:${u.cacheRead}:${u.cacheCreation}`;
        const prev = usageEntries.get(usageKey);
        if (!prev || total > prev.total || (total === prev.total && parsedTs > prev.timestamp)) {
          usageEntries.set(usageKey, { timestamp: parsedTs, model, usage: u, total });
        }

      }

      if (!usageEntries.size) continue;

      const sessionUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, cost: 0 };
      const sessionModels = new Map();
      let lastWindowTimestamp = null;

      for (const entry of usageEntries.values()) {
        const { timestamp, model, usage: u } = entry;
        lastWindowTimestamp = Math.max(lastWindowTimestamp || 0, timestamp);
        sessionUsage.input += u.input;
        sessionUsage.output += u.output;
        sessionUsage.cacheRead += u.cacheRead;
        sessionUsage.cacheCreation += u.cacheCreation;

        if (model && !model.startsWith('<')) {
          const prev = sessionModels.get(model) || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
          prev.input += u.input;
          prev.output += u.output;
          prev.cacheRead += u.cacheRead;
          prev.cacheCreation += u.cacheCreation;
          sessionModels.set(model, prev);
        }

        const dayKey = new Date(timestamp).toISOString().slice(0, 10);
        if (!daily.has(dayKey)) daily.set(dayKey, { date: dayKey, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cost: 0 });
        const bucket = daily.get(dayKey);
        bucket.input += u.input;
        bucket.output += u.output;
        bucket.cacheRead += u.cacheRead;
        bucket.cacheCreation += u.cacheCreation;
        bucket.total += u.input + u.output + u.cacheRead + u.cacheCreation;
        bucket.cost += calcCost(u, model);

        if (!dailyModelTokens.has(dayKey)) dailyModelTokens.set(dayKey, { date: dayKey, tokensByModel: {} });
        const dmt = dailyModelTokens.get(dayKey);
        if (model && !model.startsWith('<')) {
          dmt.tokensByModel[model] = (dmt.tokensByModel[model] || 0) + u.input + u.output + u.cacheRead + u.cacheCreation;
        }
      }

      if (!lastWindowTimestamp) continue;
      if (sessionUsage.input === 0 && sessionUsage.output === 0 && sessionUsage.cacheRead === 0 && sessionUsage.cacheCreation === 0) continue;

      sessionUsage.total = sessionUsage.input + sessionUsage.output + sessionUsage.cacheRead + sessionUsage.cacheCreation;
      for (const [model, mu] of sessionModels) {
        sessionUsage.cost += calcCost(mu, model);
        const prev = modelTotals.get(model) || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
        prev.input += mu.input;
        prev.output += mu.output;
        prev.cacheRead += mu.cacheRead;
        prev.cacheCreation += mu.cacheCreation;
        prev.total += mu.input + mu.output + mu.cacheRead + mu.cacheCreation;
        modelTotals.set(model, prev);
      }

      sessions.set(sessionId, {
        sessionId,
        model: primaryModel,
        updatedAt: new Date(lastWindowTimestamp).toISOString(),
        ...sessionUsage,
      });

      totals.input += sessionUsage.input;
      totals.output += sessionUsage.output;
      totals.cacheCreation += sessionUsage.cacheCreation;
      totals.cacheRead += sessionUsage.cacheRead;
      totals.total += sessionUsage.total;
      totals.cost += sessionUsage.cost;
    }
  }

  const models = [...modelTotals.entries()]
    .map(([model, t]) => ({ model, totals: t }))
    .sort((a, b) => b.totals.total - a.totals.total);

  // Read official cumulative cost from ~/.claude.json (Claude Code's own tracking)
  let officialCost = 0;
  let officialModels = [];
  try {
    const claudeJsonPath = path.join(os.homedir(), '.claude.json');
    const claudeJson = await readJsonFile(claudeJsonPath);
    if (claudeJson.projects && typeof claudeJson.projects === 'object') {
      for (const proj of Object.values(claudeJson.projects)) {
        officialCost += Number(proj.lastCost || 0);
        if (proj.lastModelUsage && typeof proj.lastModelUsage === 'object') {
          for (const [model, mu] of Object.entries(proj.lastModelUsage)) {
            if (model.startsWith('<')) continue;
            officialModels.push({
              model,
              costUSD: Number(mu.costUSD || 0),
              inputTokens: Number(mu.inputTokens || 0),
              outputTokens: Number(mu.outputTokens || 0),
              cacheReadInputTokens: Number(mu.cacheReadInputTokens || 0),
              cacheCreationInputTokens: Number(mu.cacheCreationInputTokens || 0),
            });
          }
        }
      }
    }
  } catch { /* ignore */ }

  return {
    days: Math.max(1, Math.min(90, Number(days) || 30)),
    source: projectsRoot,
    generatedAt: new Date().toISOString(),
    totals,
    officialCost,
    officialModels,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    sessions: [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12),
    models,
    dailyModelTokens: [...dailyModelTokens.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export async function loadClaudeCodeState(options = {}) {
  const home = claudeCodeHome();
  const settingsPath = path.join(home, 'settings.json');
  const settings = await readJsonFile(settingsPath);
  const binary = findToolBinary('claudecode');
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

  // Read ~/.claude.json for login and model history
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  const claudeJson = await readJsonFile(claudeJsonPath);

  // Login info
  const oauth = claudeJson.oauthAccount;
  const login = oauth
    ? { loggedIn: true, method: 'oauth', email: oauth.emailAddress || '', orgName: oauth.orgName || '', plan: oauth.accountPlan || '' }
    : hasApiKey
      ? { loggedIn: true, method: 'api_key', email: '' }
      : { loggedIn: false, method: '', email: '' };

  // Extract used models from projects
  const usedModels = new Set();
  if (claudeJson.projects && typeof claudeJson.projects === 'object') {
    for (const proj of Object.values(claudeJson.projects)) {
      if (proj.lastModelUsage && typeof proj.lastModelUsage === 'object') {
        for (const modelName of Object.keys(proj.lastModelUsage)) {
          usedModels.add(modelName);
        }
      }
    }
  }

  const forceUsageRefresh = ['1', 'true', 'yes'].includes(String(options.forceUsageRefresh || '').toLowerCase());
  const cacheOnly = ['1', 'true', 'yes'].includes(String(options.cacheOnly || '').toLowerCase());
  const usage = cacheOnly ? await readClaudeTelemetryUsage({ days: 30 }) : await readClaudeTelemetryUsage({ days: 30 });

  return {
    toolId: 'claudecode',
    configHome: home,
    settingsPath,
    settings,
    binary,
    model: settings.model || '',
    alwaysThinkingEnabled: settings.alwaysThinkingEnabled || false,
    skipDangerousModePermissionPrompt: settings.skipDangerousModePermissionPrompt || false,
    hasApiKey,
    settingsJson: JSON.stringify(settings, null, 2),
    settingsEnv: settings.env || {},
    login,
    usedModels: [...usedModels].sort(),
    usage,
  };
}

export async function saveClaudeCodeConfig(payload) {
  const home = claudeCodeHome();
  const settingsPath = path.join(home, 'settings.json');
  const settings = await readJsonFile(settingsPath);

  // Apply fields
  if (payload.model !== undefined) settings.model = payload.model || undefined;
  if (payload.alwaysThinkingEnabled !== undefined) settings.alwaysThinkingEnabled = payload.alwaysThinkingEnabled;
  if (payload.skipDangerousModePermissionPrompt !== undefined) settings.skipDangerousModePermissionPrompt = payload.skipDangerousModePermissionPrompt;
  if (payload.env && typeof payload.env === 'object') {
    settings.env = { ...(settings.env || {}), ...payload.env };
  }

  // Clean undefined values
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined || value === '') delete settings[key];
  }

  await writeJsonFile(settingsPath, settings);
  return { saved: true, settingsPath };
}

export async function saveClaudeCodeRawConfig(payload) {
  const home = claudeCodeHome();
  const settingsPath = path.join(home, 'settings.json');
  const rawJson = String(payload.settingsJson || '').trim();
  if (!rawJson) throw new Error('settings.json 内容不能为空');
  let parsed;
  try { parsed = JSON.parse(rawJson); } catch (e) {
    throw new Error(`JSON 解析失败：${e.message}`);
  }
  await writeJsonFile(settingsPath, parsed);
  return { saved: true, settingsPath };
}

async function claudeCodeNpmAction(args) {
  const result = await runCommand(npmCommand(), args);
  return { ...result, command: `${npmCommand()} ${args.join(' ')}` };
}

export async function installClaudeCode() {
  return claudeCodeNpmAction(['install', '-g', CLAUDE_CODE_PACKAGE]);
}

export async function reinstallClaudeCode() {
  return claudeCodeNpmAction(['install', '-g', CLAUDE_CODE_PACKAGE, '--force']);
}

export async function updateClaudeCode() {
  return claudeCodeNpmAction(['install', '-g', `${CLAUDE_CODE_PACKAGE}@latest`]);
}

export async function uninstallClaudeCode() {
  return claudeCodeNpmAction(['uninstall', '-g', CLAUDE_CODE_PACKAGE]);
}

export async function launchClaudeCode({ cwd } = {}) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const binary = findToolBinary('claudecode');
  if (!binary.installed) {
    throw new Error('Claude Code 尚未安装，请先点击安装');
  }
  const message = launchTerminalCommand(targetCwd, {
    binaryPath: binary.path,
    binaryName: 'claude',
    toolLabel: 'Claude Code',
  });
  return { ok: true, cwd: targetCwd, message };
}

export async function loginClaudeCode({ cwd } = {}) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const binary = findToolBinary('claudecode');
  if (!binary.installed) {
    throw new Error('Claude Code 尚未安装，请先点击安装');
  }
  const binaryPath = String(binary.path || 'claude');
  const message = launchTerminalCommand(targetCwd, {
    commandText: process.platform === 'win32'
      ? buildWindowsBinaryCommand(binaryPath, ['auth', 'login'], 'claude')
      : `"${binaryPath.replace(/"/g, '\\"')}" auth login`,
    toolLabel: 'Claude Code OAuth 登录',
  });
  return { ok: true, cwd: targetCwd, message };
}

/* ═══════════════  OpenCode  ═══════════════ */

function resolveOpenCodeInstallMethod(method = '') {
  const normalized = String(method || '').trim().toLowerCase();
  if (process.platform === 'win32') {
    return ['auto', 'domestic', 'npm', 'scoop', 'choco'].includes(normalized) ? normalized : 'auto';
  }
  return ['auto', 'domestic', 'script', 'brew', 'npm'].includes(normalized) ? normalized : 'auto';
}

function canAccessGoogle(timeoutMs = 2800) {
  return new Promise((resolve) => {
    const req = https.get('https://www.google.com/generate_204', { timeout: timeoutMs, headers: { 'User-Agent': 'easy-ai-config/1.0' } }, (res) => {
      res.resume();
      resolve((res.statusCode || 0) > 0 && (res.statusCode || 0) < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function resolveOpenCodeEffectiveMethod(method = '') {
  const requestedMethod = resolveOpenCodeInstallMethod(method);
  if (requestedMethod !== 'auto') return { requestedMethod, installMethod: requestedMethod, googleReachable: null };
  const googleReachable = await canAccessGoogle();
  return {
    requestedMethod,
    installMethod: googleReachable ? (process.platform === 'win32' ? 'npm' : 'script') : 'domestic',
    googleReachable,
  };
}

async function openCodeShellAction(commandText, options = {}) {
  if (process.platform === 'win32') {
    const result = await runCommand('powershell.exe', openClawWindowsPowerShellArgs(commandText), options);
    return { ...result, command: `powershell -Command ${commandText}` };
  }
  const result = await runCommand('sh', ['-lc', commandText], options);
  return { ...result, command: commandText };
}

async function openCodeNpmAction(args, { domestic = false } = {}) {
  const finalArgs = domestic ? [...args, '--registry', OPENCLAW_NPM_REGISTRY_CN] : args;
  const result = await runCommand(npmCommand(), finalArgs);
  return { ...result, command: `${npmCommand()} ${finalArgs.join(' ')}` };
}

async function openCodeInstallAction(method = '') {
  const resolved = await resolveOpenCodeEffectiveMethod(method);
  const installMethod = resolved.installMethod;
  let result;
  if (installMethod === 'domestic') result = await openCodeNpmAction(['install', '-g', `${OPENCODE_PACKAGE}@latest`], { domestic: true });
  else if (installMethod === 'npm') result = await openCodeNpmAction(['install', '-g', `${OPENCODE_PACKAGE}@latest`]);
  else if (installMethod === 'brew') result = await openCodeShellAction('brew install anomalyco/tap/opencode');
  else if (installMethod === 'scoop') result = await openCodeShellAction('scoop install opencode');
  else if (installMethod === 'choco') result = await openCodeShellAction('choco install opencode -y');
  else result = await openCodeShellAction(OPENCODE_INSTALL_SCRIPT_UNIX);
  return { ...result, requestedMethod: resolved.requestedMethod, method: installMethod, googleReachable: resolved.googleReachable, usedDomesticMirror: installMethod === 'domestic' };
}

async function openCodeReinstallAction(method = '') {
  const resolved = await resolveOpenCodeEffectiveMethod(method);
  const installMethod = resolved.installMethod;
  let result;
  if (installMethod === 'domestic') result = await openCodeNpmAction(['install', '-g', `${OPENCODE_PACKAGE}@latest`, '--force'], { domestic: true });
  else if (installMethod === 'npm') result = await openCodeNpmAction(['install', '-g', `${OPENCODE_PACKAGE}@latest`, '--force']);
  else if (installMethod === 'brew') result = await openCodeShellAction('brew reinstall anomalyco/tap/opencode');
  else if (installMethod === 'scoop') result = await openCodeShellAction('scoop uninstall opencode; scoop install opencode');
  else if (installMethod === 'choco') result = await openCodeShellAction('choco uninstall opencode -y; choco install opencode -y');
  else result = await openCodeShellAction(OPENCODE_INSTALL_SCRIPT_UNIX);
  return { ...result, requestedMethod: resolved.requestedMethod, method: installMethod, googleReachable: resolved.googleReachable, usedDomesticMirror: installMethod === 'domestic' };
}

async function openCodeUpdateAction(method = '') {
  const resolved = await resolveOpenCodeEffectiveMethod(method);
  const installMethod = resolved.installMethod;
  let result;
  if (installMethod === 'domestic') result = await openCodeNpmAction(['install', '-g', `${OPENCODE_PACKAGE}@latest`], { domestic: true });
  else if (installMethod === 'npm') result = await openCodeNpmAction(['install', '-g', `${OPENCODE_PACKAGE}@latest`]);
  else if (installMethod === 'brew') result = await openCodeShellAction('brew upgrade anomalyco/tap/opencode || brew install anomalyco/tap/opencode');
  else if (installMethod === 'scoop') result = await openCodeShellAction('scoop update opencode');
  else if (installMethod === 'choco') result = await openCodeShellAction('choco upgrade opencode -y');
  else result = await openCodeShellAction(OPENCODE_INSTALL_SCRIPT_UNIX);
  return { ...result, requestedMethod: resolved.requestedMethod, method: installMethod, googleReachable: resolved.googleReachable, usedDomesticMirror: installMethod === 'domestic' };
}

async function openCodeUninstallAction(method = '') {
  const resolved = await resolveOpenCodeEffectiveMethod(method);
  const installMethod = resolved.installMethod;
  if (installMethod === 'domestic' || installMethod === 'npm') return openCodeNpmAction(['uninstall', '-g', OPENCODE_PACKAGE]);
  if (installMethod === 'brew') return openCodeShellAction('brew uninstall anomalyco/tap/opencode || brew uninstall opencode');
  if (installMethod === 'scoop') return openCodeShellAction('scoop uninstall opencode');
  if (installMethod === 'choco') return openCodeShellAction('choco uninstall opencode -y');
  const binary = findToolBinary('opencode');
  if (binary.installed && binary.path) {
    return openCodeShellAction(`rm -f "${String(binary.path).replace(/"/g, '\"')}"`);
  }
  return { ok: true, code: 0, stdout: '', stderr: '', command: 'rm -f <opencode-binary>' };
}


function cleanupOpenCodeInstallTasks() {
  const now = Date.now();
  for (const [taskId, task] of OPENCODE_INSTALL_TASKS.entries()) {
    if (task.status !== 'running' && (now - task.updatedAtTs) > OPENCODE_INSTALL_TASK_TTL_MS) {
      OPENCODE_INSTALL_TASKS.delete(taskId);
    }
  }
  while (OPENCODE_INSTALL_TASKS.size > 20) {
    const removable = [...OPENCODE_INSTALL_TASKS.entries()].find(([, task]) => task.status !== 'running');
    if (!removable) break;
    OPENCODE_INSTALL_TASKS.delete(removable[0]);
  }
}

function openCodeInstallStepTemplate(action) {
  if (action === 'uninstall') {
    return [
      { key: 'inspect', title: '检查当前安装', description: '确认当前 OpenCode 安装状态与路径', hint: '先确认当前命令在哪里。', progress: 10 },
      { key: 'remove', title: '执行卸载命令', description: '按最终方式移除 OpenCode', hint: '正在移除全局命令和安装内容。', progress: 58 },
      { key: 'verify', title: '验证卸载结果', description: '确认 `opencode` 命令已经不可用', hint: '马上结束，正在做最后确认。', progress: 92 },
    ];
  }
  return [
    { key: 'network', title: '检测网络环境', description: '检测 Google 可达性并判断是否走国内优化', hint: '这一步是真实网络探测，请稍等。', progress: 8 },
    { key: 'method', title: '确定安装方式', description: '根据你的选择和网络结果确定最终安装方案', hint: '正在确认最终执行方式和命令。', progress: 28 },
    { key: 'execute', title: '执行安装命令', description: '真正开始安装 OpenCode 与依赖', hint: '这里耗时最长，日志会持续更新。', progress: 62 },
    { key: 'verify', title: '验证安装结果', description: '确认 `opencode` 命令已经可用', hint: '快完成了，正在验证版本和命令。', progress: 92 },
  ];
}

function createOpenCodeInstallTask({ action, requestedMethod = '' } = {}) {
  cleanupOpenCodeInstallTasks();
  const steps = openCodeInstallStepTemplate(action).map((step, index) => ({ ...step, status: index === 0 ? 'running' : 'pending' }));
  const startedAt = nowIso();
  const task = {
    id: `opencode-task-${Date.now()}-${opencodeInstallTaskSeq += 1}`,
    toolId: 'opencode',
    action,
    requestedMethod,
    method: '',
    command: '',
    googleReachable: null,
    usedDomesticMirror: null,
    status: 'running',
    progress: Math.max(4, steps[0]?.progress || 4),
    stepIndex: 0,
    summary: steps[0]?.description || '正在准备任务…',
    hint: steps[0]?.hint || '请稍候。',
    detail: action === 'uninstall' ? '正在读取当前安装状态…' : '正在初始化安装任务…',
    steps,
    logs: [],
    stdout: '',
    stderr: '',
    startedAt,
    updatedAt: startedAt,
    updatedAtTs: Date.now(),
    completedAt: null,
    version: null,
    error: null,
    _cancelRequested: false,
    _cancelPromise: null,
    _childPid: null,
    _stdoutBuffer: '',
    _stderrBuffer: '',
  };
  OPENCODE_INSTALL_TASKS.set(task.id, task);
  return task;
}

function serializeOpenCodeInstallTask(task) {
  return {
    taskId: task.id,
    toolId: task.toolId,
    action: task.action,
    requestedMethod: task.requestedMethod,
    method: task.method,
    command: task.command,
    googleReachable: task.googleReachable,
    usedDomesticMirror: task.usedDomesticMirror,
    status: task.status,
    progress: task.progress,
    stepIndex: task.stepIndex,
    summary: task.summary,
    hint: task.hint,
    detail: task.detail,
    steps: task.steps,
    logs: task.logs.slice(-18),
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    version: task.version,
    error: task.error,
  };
}

function touchOpenCodeInstallTask(task) {
  task.updatedAt = nowIso();
  task.updatedAtTs = Date.now();
}

function setOpenCodeInstallStep(task, stepIndex, overrides = {}) {
  const safeStepIndex = Math.max(0, Math.min(stepIndex, task.steps.length - 1));
  if (safeStepIndex < task.stepIndex) return;
  task.stepIndex = safeStepIndex;
  task.progress = Math.max(task.progress, overrides.progress ?? task.steps[safeStepIndex]?.progress ?? task.progress);
  task.summary = overrides.summary || task.steps[safeStepIndex]?.description || task.summary;
  task.hint = overrides.hint || task.steps[safeStepIndex]?.hint || task.hint;
  if (overrides.detail) task.detail = overrides.detail;
  task.steps = task.steps.map((step, index) => ({
    ...step,
    status: index < safeStepIndex ? 'done' : index === safeStepIndex ? (overrides.status || 'running') : 'pending',
  }));
  touchOpenCodeInstallTask(task);
}

function cleanOpenCodeInstallLine(line) {
  return String(line || '')
    .replace(/[\x1B\x9B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-ntqry=><~]|(?:].*?(?:\x07|\x1B\\)))/g, '')
    .replace(/\r/g, '')
    .trim();
}

function pushOpenCodeInstallLog(task, source, line) {
  const text = cleanOpenCodeInstallLine(line);
  if (!text) return;
  task.logs.push({ source, text, at: nowIso() });
  if (task.logs.length > 160) task.logs.shift();
  task.detail = text;
  if (task.action !== 'uninstall' && task.stepIndex === 2 && task.status === 'running') {
    task.progress = Math.min(88, Math.max(task.progress, 62) + 1);
  }
  touchOpenCodeInstallTask(task);
}

function consumeOpenCodeInstallChunk(task, source, chunk) {
  const bufferKey = source === 'stderr' ? '_stderrBuffer' : '_stdoutBuffer';
  const text = String(chunk || '');
  task[source] += text;
  const merged = `${task[bufferKey] || ''}${text}`;
  const lines = merged.split(/\r?\n/);
  task[bufferKey] = lines.pop() || '';
  for (const line of lines) pushOpenCodeInstallLog(task, source, line);
}

function flushOpenCodeInstallChunk(task) {
  for (const bufferKey of ['_stdoutBuffer', '_stderrBuffer']) {
    if (!task[bufferKey]) continue;
    pushOpenCodeInstallLog(task, bufferKey === '_stdoutBuffer' ? 'stdout' : 'stderr', task[bufferKey]);
    task[bufferKey] = '';
  }
}

function runTrackedOpenCodeCommand(task, command, args, options = {}) {
  return new Promise((resolve) => {
    const child = runSpawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
      detached: process.platform !== 'win32',
    });

    task._childPid = child.pid || null;
    touchOpenCodeInstallTask(task);

    child.stdout?.on('data', (chunk) => consumeOpenCodeInstallChunk(task, 'stdout', chunk));
    child.stderr?.on('data', (chunk) => consumeOpenCodeInstallChunk(task, 'stderr', chunk));
    child.on('error', (error) => {
      task._childPid = null;
      pushOpenCodeInstallLog(task, 'stderr', error.message);
      resolve({ ok: false, code: null, stdout: task.stdout, stderr: `${task.stderr}${error.message}` });
    });
    child.on('close', (code) => {
      task._childPid = null;
      flushOpenCodeInstallChunk(task);
      resolve({ ok: code === 0, code, stdout: task.stdout, stderr: task.stderr });
    });
  });
}


function buildOpenCodeScriptUninstallCommand() {
  const binary = findToolBinary('opencode');
  const targets = new Set();
  if (binary.installed && binary.path) targets.add(String(binary.path));
  for (const dirPath of openCodeScriptInstallDirs()) {
    targets.add(path.join(dirPath, process.platform === 'win32' ? 'opencode.exe' : 'opencode'));
  }
  const quoted = [...targets]
    .filter(Boolean)
    .map((targetPath) => `rm -f ${quotePosixShellArg(String(targetPath))}`);
  const cleanupDirs = openCodeScriptInstallDirs()
    .map((dirPath) => `rmdir ${quotePosixShellArg(String(dirPath))} 2>/dev/null || true`);
  return [...quoted, ...cleanupDirs, 'hash -r 2>/dev/null || true'].join('; ');
}

function buildOpenCodeCommandPlan(action, method) {
  const npmArgs = action === 'uninstall'
    ? ['uninstall', '-g', OPENCODE_PACKAGE]
    : ['install', '-g', `${OPENCODE_PACKAGE}@latest`, ...(action === 'reinstall' ? ['--force'] : [])];

  if (method === 'domestic') {
    const args = action === 'uninstall' ? npmArgs : [...npmArgs, '--registry', OPENCLAW_NPM_REGISTRY_CN];
    return { mode: 'npm', command: npmCommand(), args, displayCommand: `${npmCommand()} ${args.join(' ')}` };
  }
  if (method === 'npm') {
    return { mode: 'npm', command: npmCommand(), args: npmArgs, displayCommand: `${npmCommand()} ${npmArgs.join(' ')}` };
  }
  if (method === 'script') {
    if (action === 'uninstall') {
      const script = buildOpenCodeScriptUninstallCommand();
      return { mode: 'shell', command: 'sh', args: ['-lc', script], displayCommand: script };
    }
    return { mode: 'shell', command: process.platform === 'win32' ? 'powershell.exe' : 'sh', args: process.platform === 'win32' ? openClawWindowsPowerShellArgs(OPENCODE_INSTALL_SCRIPT_UNIX) : ['-lc', OPENCODE_INSTALL_SCRIPT_UNIX], displayCommand: OPENCODE_INSTALL_SCRIPT_UNIX };
  }
  if (method === 'brew') {
    const script = action === 'install'
      ? 'brew install anomalyco/tap/opencode'
      : action === 'reinstall'
        ? 'brew reinstall anomalyco/tap/opencode'
        : action === 'update'
          ? 'brew upgrade anomalyco/tap/opencode || brew install anomalyco/tap/opencode'
          : 'brew uninstall anomalyco/tap/opencode || brew uninstall opencode';
    return { mode: 'shell', command: 'sh', args: ['-lc', script], displayCommand: script };
  }
  if (method === 'scoop') {
    const script = action === 'install'
      ? 'scoop install opencode'
      : action === 'reinstall'
        ? 'scoop uninstall opencode; scoop install opencode'
        : action === 'update'
          ? 'scoop update opencode'
          : 'scoop uninstall opencode';
    return { mode: 'shell', command: 'powershell.exe', args: openClawWindowsPowerShellArgs(script), displayCommand: script };
  }
  if (method === 'choco') {
    const script = action === 'install'
      ? 'choco install opencode -y'
      : action === 'reinstall'
        ? 'choco uninstall opencode -y; choco install opencode -y'
        : action === 'update'
          ? 'choco upgrade opencode -y'
          : 'choco uninstall opencode -y';
    return { mode: 'shell', command: 'powershell.exe', args: openClawWindowsPowerShellArgs(script), displayCommand: script };
  }

  const binary = findToolBinary('opencode');
  const removeScript = binary.installed && binary.path
    ? `rm -f "${String(binary.path).replace(/"/g, '\\"')}"`
    : 'rm -f <opencode-binary>';
  return { mode: 'shell', command: 'sh', args: ['-lc', removeScript], displayCommand: removeScript };
}

function openCodeScriptInstallDirs() {
  if (process.platform === 'win32') return [];
  const home = os.homedir();
  return [
    process.env.OPENCODE_INSTALL_DIR?.trim(),
    process.env.XDG_BIN_DIR?.trim(),
    path.join(home, 'bin'),
    path.join(home, '.opencode', 'bin'),
  ].filter(Boolean).map((dirPath) => path.resolve(String(dirPath)));
}

function isPathInside(parentPath, targetPath) {
  const parent = path.resolve(String(parentPath || ''));
  const target = path.resolve(String(targetPath || ''));
  return target === parent || target.startsWith(`${parent}${path.sep}`);
}

function inferOpenCodeUninstallMethod() {
  const binary = findToolBinary('opencode');
  const rawPath = String(binary.path || '');
  const targetPath = rawPath.toLowerCase();

  if (process.platform === 'win32') {
    if (targetPath.includes('\\scoop\\') || targetPath.includes('/scoop/')) return 'scoop';
    if (targetPath.includes('chocolatey')) return 'choco';
    return 'npm';
  }

  if (targetPath.includes('homebrew') || targetPath.includes('/cellar/')) return 'brew';

  const npmPrefix = npmGlobalPrefix();
  if (npmPrefix && isPathInside(path.join(npmPrefix, 'bin'), rawPath)) return 'npm';

  if (openCodeScriptInstallDirs().some((dirPath) => isPathInside(dirPath, rawPath))) return 'script';

  return 'script';
}

function buildOpenCodeUninstallMethods(preferredMethod = 'auto') {
  const methods = [];
  const add = (method) => {
    if (!method || methods.includes(method)) return;
    methods.push(method);
  };

  if (preferredMethod && preferredMethod !== 'auto') add(preferredMethod);
  add(inferOpenCodeUninstallMethod());

  const binary = findToolBinary('opencode');
  const rawPath = String(binary.path || '');
  const targetPath = rawPath.toLowerCase();

  if (process.platform === 'win32') {
    if (targetPath.includes('\\scoop\\') || targetPath.includes('/scoop/')) add('scoop');
    if (targetPath.includes('chocolatey')) add('choco');
    add('npm');
  } else {
    if (targetPath.includes('homebrew') || targetPath.includes('/cellar/')) add('brew');
    const npmPrefix = npmGlobalPrefix();
    if (npmPrefix && isPathInside(path.join(npmPrefix, 'bin'), rawPath)) add('npm');
    if (openCodeScriptInstallDirs().some((dirPath) => isPathInside(dirPath, rawPath))) add('script');
    add('npm');
    add('script');
    add('brew');
  }

  return methods;
}

function finishOpenCodeInstallTask(task, status, payload = {}) {
  task.status = status;
  if (status === 'success' || status === 'cancelled') task.progress = 100;
  task.version = payload.version || task.version || null;
  task.error = payload.error || null;
  task.completedAt = nowIso();
  task._childPid = null;
  touchOpenCodeInstallTask(task);
}

function isOpenCodeInstallActive(task) {
  return task && (task.status === 'running' || task.status === 'cancelling');
}

function isOpenCodeInstallCancelled(task) {
  return Boolean(task?._cancelRequested) || task?.status === 'cancelling' || task?.status === 'cancelled';
}

async function terminateOpenCodeInstallProcess(task) {
  const pid = Number(task?._childPid || 0);
  if (!pid) return;

  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/F', '/T', '/PID', String(pid)]).catch(() => null);
    task._childPid = null;
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* noop */ }
  }
  await new Promise(resolve => setTimeout(resolve, 900));
  if (await isPidAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* noop */ }
    }
  }
  task._childPid = null;
}

async function cancelRunningOpenCodeInstall(task) {
  if (!task) throw new Error('OpenCode 任务不存在，可能已经过期，请重新开始');
  if (!isOpenCodeInstallActive(task)) return serializeOpenCodeInstallTask(task);
  if (task._cancelPromise) {
    await task._cancelPromise;
    return serializeOpenCodeInstallTask(task);
  }

  task._cancelRequested = true;
  task.status = 'cancelling';
  task.summary = task.action === 'uninstall' ? '正在中断 OpenCode 卸载…' : '正在中断 OpenCode 安装…';
  task.hint = '先别关闭窗口，正在停止安装进程。';
  task.detail = '正在终止当前安装命令…';
  touchOpenCodeInstallTask(task);

  task._cancelPromise = (async () => {
    pushOpenCodeInstallLog(task, 'stderr', '收到中断请求，正在终止安装进程…');
    await terminateOpenCodeInstallProcess(task);
    flushOpenCodeInstallChunk(task);
    pushOpenCodeInstallLog(task, 'stdout', '安装进程已停止，本次任务已中断。');
    task.steps = task.steps.map((step, index) => ({
      ...step,
      status: index < task.stepIndex ? 'done' : index === task.stepIndex ? 'error' : 'pending',
    }));
    task.summary = task.action === 'uninstall' ? 'OpenCode 卸载已中断' : 'OpenCode 安装已中断';
    task.hint = '本次任务已经停止，你可以随时重新开始。';
    task.detail = '安装进程已终止。';
    finishOpenCodeInstallTask(task, 'cancelled');
    return serializeOpenCodeInstallTask(task);
  })();

  return task._cancelPromise;
}

async function runOpenCodeInstallTask(task) {
  try {
    const binaryBefore = findToolBinary('opencode');
    if (task.action === 'uninstall') {
      pushOpenCodeInstallLog(task, 'stdout', binaryBefore.installed
        ? `检测到当前 OpenCode：${binaryBefore.path || 'opencode'}`
        : '当前未检测到 OpenCode 命令，将执行兜底清理。');
      const normalizedRequestedMethod = resolveOpenCodeInstallMethod(task.requestedMethod);
      const uninstallMethods = buildOpenCodeUninstallMethods(normalizedRequestedMethod);
      task.requestedMethod = normalizedRequestedMethod;
      task.method = uninstallMethods[0] || inferOpenCodeUninstallMethod();
      task.googleReachable = null;
      task.usedDomesticMirror = task.method === 'domestic';
      setOpenCodeInstallStep(task, 1, { detail: `准备按顺序尝试：${uninstallMethods.join(' → ')}` });
      pushOpenCodeInstallLog(task, 'stdout', `卸载策略：${uninstallMethods.join(' -> ')}`);
      let lastFailure = '';

      for (let index = 0; index < uninstallMethods.length; index += 1) {
        const currentMethod = uninstallMethods[index];
        const plan = buildOpenCodeCommandPlan(task.action, currentMethod);
        task.method = currentMethod;
        task.command = plan.displayCommand;
        task.usedDomesticMirror = currentMethod === 'domestic';
        pushOpenCodeInstallLog(task, 'stdout', `尝试卸载方式 ${index + 1}/${uninstallMethods.length}：${currentMethod}`);
        pushOpenCodeInstallLog(task, 'stdout', `执行命令：${task.command}`);
        const result = await runTrackedOpenCodeCommand(task, plan.command, plan.args);
        if (isOpenCodeInstallCancelled(task)) return;
        if (!result.ok) {
          lastFailure = summarizeInstallCommandFailure(result);
          pushOpenCodeInstallLog(task, 'stderr', `方式 ${currentMethod} 执行失败：${lastFailure}`);
        }
        setOpenCodeInstallStep(task, 2, { detail: `方式 ${currentMethod} 已执行，正在验证…` });
        const binaryAfter = findToolBinary('opencode');
        if (!binaryAfter.installed) {
          task.steps = task.steps.map((step) => ({ ...step, status: 'done' }));
          task.summary = 'OpenCode 已卸载完成';
          task.hint = '如需恢复，重新点击安装即可。';
          task.detail = '已确认 opencode 命令不可用。';
          finishOpenCodeInstallTask(task, 'success');
          return;
        }
        pushOpenCodeInstallLog(task, 'stdout', `当前仍检测到 OpenCode：${binaryAfter.path || 'opencode'}，继续尝试下一种方式…`);
      }

      throw new Error(lastFailure || '卸载命令已执行完成，但系统里仍检测到 `opencode` 命令。');
    }

    if (task.requestedMethod === 'auto') {
      pushOpenCodeInstallLog(task, 'stdout', '开始真实检测 Google 可达性…');
    } else {
      pushOpenCodeInstallLog(task, 'stdout', `已指定安装方式：${task.requestedMethod}，跳过 Google 检测。`);
    }

    const resolved = await resolveOpenCodeEffectiveMethod(task.requestedMethod);
    if (isOpenCodeInstallCancelled(task)) return;
    task.requestedMethod = resolved.requestedMethod;
    task.method = resolved.installMethod;
    task.googleReachable = resolved.googleReachable;
    task.usedDomesticMirror = task.method === 'domestic';

    if (typeof resolved.googleReachable === 'boolean') {
      pushOpenCodeInstallLog(task, 'stdout', `Google 可达性检测结果：${resolved.googleReachable ? '可访问' : '不可访问'}`);
    } else {
      pushOpenCodeInstallLog(task, 'stdout', '本次按你的指定方式执行，未触发 Google 连通性检测。');
    }

    const plan = buildOpenCodeCommandPlan(task.action, task.method);
    task.command = plan.displayCommand;
    setOpenCodeInstallStep(task, 1, { detail: `已确认最终方式：${task.method}` });
    pushOpenCodeInstallLog(task, 'stdout', `最终安装方式：${task.method}`);
    pushOpenCodeInstallLog(task, 'stdout', `执行命令：${task.command}`);

    if (plan.mode === 'npm') {
      const nodeResult = runSpawnSync('node', ['--version'], { encoding: 'utf8' });
      const npmResult = runSpawnSync(npmCommand(), ['--version'], { encoding: 'utf8' });
      if (nodeResult.status !== 0) throw new Error('未检测到 Node.js，请先安装 Node.js 18+。');
      if (npmResult.status !== 0) throw new Error('未检测到 npm，请先修复 npm 环境后重试。');
      pushOpenCodeInstallLog(task, 'stdout', `Node.js ${String(nodeResult.stdout || '').trim()} / npm ${String(npmResult.stdout || '').trim()}`);
      if (task.usedDomesticMirror) pushOpenCodeInstallLog(task, 'stdout', `已启用国内 npm 源：${OPENCLAW_NPM_REGISTRY_CN}`);
    }

    setOpenCodeInstallStep(task, 2, { detail: `正在执行：${task.command}` });
    const result = await runTrackedOpenCodeCommand(task, plan.command, plan.args);
    if (isOpenCodeInstallCancelled(task)) return;
    if (!result.ok) throw new Error(summarizeInstallCommandFailure(result));

    setOpenCodeInstallStep(task, 3, { detail: '安装命令执行完成，正在验证 opencode 命令…' });
    if (isOpenCodeInstallCancelled(task)) return;
    const binaryAfter = findToolBinary('opencode');
    if (!binaryAfter.installed) throw new Error('安装命令已执行完成，但系统里仍未找到 `opencode` 命令。');
    task.steps = task.steps.map((step) => ({ ...step, status: 'done' }));
    task.summary = task.action === 'update' ? 'OpenCode 已更新完成' : task.action === 'reinstall' ? 'OpenCode 已重装完成' : 'OpenCode 已安装完成';
    task.hint = '下一步可以直接启动 OpenCode，或先去配置 Provider / 模型。';
    task.detail = binaryAfter.version ? `已检测到版本：${binaryAfter.version}` : '已检测到 opencode 命令。';
    finishOpenCodeInstallTask(task, 'success', { version: binaryAfter.version });
  } catch (error) {
    if (task.status === 'cancelled' || task.status === 'cancelling') return;
    task.steps = task.steps.map((step, index) => ({ ...step, status: index < task.stepIndex ? 'done' : index === task.stepIndex ? 'error' : 'pending' }));
    task.summary = task.action === 'uninstall' ? 'OpenCode 卸载失败' : 'OpenCode 安装失败';
    task.hint = '先看最后日志，通常能直接看到是网络、权限还是依赖问题。';
    task.detail = error instanceof Error ? error.message : String(error);
    finishOpenCodeInstallTask(task, 'error', { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function startOpenCodeInstallTask({ action = 'install', method = '' } = {}) {
  const normalizedAction = ['install', 'update', 'reinstall', 'uninstall'].includes(String(action || '').trim()) ? String(action || '').trim() : 'install';
  const task = createOpenCodeInstallTask({ action: normalizedAction, requestedMethod: resolveOpenCodeInstallMethod(method) });
  void runOpenCodeInstallTask(task);
  return serializeOpenCodeInstallTask(task);
}

export async function getOpenCodeInstallTask({ taskId } = {}) {
  cleanupOpenCodeInstallTasks();
  if (!taskId || !OPENCODE_INSTALL_TASKS.has(taskId)) {
    throw new Error('OpenCode 任务不存在，可能已经过期，请重新开始');
  }
  return serializeOpenCodeInstallTask(OPENCODE_INSTALL_TASKS.get(taskId));
}

export async function cancelOpenCodeInstallTask({ taskId } = {}) {
  cleanupOpenCodeInstallTasks();
  if (!taskId || !OPENCODE_INSTALL_TASKS.has(taskId)) {
    throw new Error('OpenCode 任务不存在，可能已经过期，请重新开始');
  }
  return cancelRunningOpenCodeInstall(OPENCODE_INSTALL_TASKS.get(taskId));
}

export async function installOpenCode({ method = '' } = {}) {
  return openCodeInstallAction(method);
}

export async function reinstallOpenCode({ method = '' } = {}) {
  return openCodeReinstallAction(method);
}

export async function updateOpenCode({ method = '' } = {}) {
  return openCodeUpdateAction(method);
}

export async function uninstallOpenCode({ method = '' } = {}) {
  return openCodeUninstallAction(method);
}

export async function launchOpenCode({ cwd } = {}) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const binary = findToolBinary('opencode');
  if (!binary.installed) {
    throw new Error('OpenCode 尚未安装，请先点击安装');
  }
  const message = launchTerminalCommand(targetCwd, {
    binaryPath: binary.path,
    binaryName: 'opencode',
    toolLabel: 'OpenCode',
  });
  return { ok: true, cwd: targetCwd, message };
}

export async function loginOpenCode({ cwd, provider = '', method = '' } = {}) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const binary = findToolBinary('opencode');
  if (!binary.installed) {
    throw new Error('OpenCode 尚未安装，请先点击安装');
  }
  const binaryPath = String(binary.path || 'opencode');
  const providerArg = String(provider || '').trim();
  const methodArg = String(method || '').trim();
  const message = launchTerminalCommand(targetCwd, {
    commandText: process.platform === 'win32'
      ? buildWindowsBinaryCommand(binaryPath, [
        'auth',
        'login',
        ...(providerArg ? ['--provider', providerArg] : []),
        ...(methodArg ? ['--method', methodArg] : []),
      ], 'opencode')
      : [
        quotePosixShellArg(binaryPath),
        'auth',
        'login',
        ...(providerArg ? ['--provider', quotePosixShellArg(providerArg)] : []),
        ...(methodArg ? ['--method', quotePosixShellArg(methodArg)] : []),
      ].join(' '),
    toolLabel: 'OpenCode 登录',
  });
  return { ok: true, cwd: targetCwd, message };
}

export async function logoutOpenCodeAuth({ provider = '', scope = 'global', projectPath = '' } = {}) {
  const authKey = normalizeOpenCodeAuthEntryKey(provider);
  if (!authKey) throw new Error('请先指定要移除的 OpenCode 凭证');
  const paths = resolveOpenCodePaths({ scope, projectPath });
  const authPath = paths.authPath;
  const authJson = parseOpenCodeAuthJson(await readText(authPath));
  delete authJson[provider];
  delete authJson[authKey];
  delete authJson[`${authKey}/`];
  await writeText(authPath, `${JSON.stringify(authJson, null, 2)}\n`);
  return { removed: true, authPath, provider: authKey };
}

export async function loadOpenCodeState(options = {}) {
  const paths = resolveOpenCodePaths(options || {});
  const [rawConfig, rawAuth] = await Promise.all([
    readText(paths.configPath),
    readText(paths.authPath),
  ]);
  let config = {};
  if (rawConfig.trim()) {
    try {
      config = parseJsonc(rawConfig);
    } catch (error) {
      throw new Error(`OpenCode 配置解析失败：${error.message}`);
    }
  }
  const authJson = parseOpenCodeAuthJson(rawAuth);
  const authEntries = summarizeOpenCodeAuthEntries(authJson);
  const binary = findToolBinary('opencode');
  const providerMap = config.provider && typeof config.provider === 'object' ? config.provider : {};
  const model = String(config.model || '').trim();
  const smallModel = String(config.small_model || '').trim();
  const providerKeys = new Set(Object.keys(providerMap || {}));
  const modelProviderKey = openCodeProviderFromModel(model);
  const smallModelProviderKey = openCodeProviderFromModel(smallModel);
  if (modelProviderKey) providerKeys.add(modelProviderKey);
  if (smallModelProviderKey) providerKeys.add(smallModelProviderKey);
  authEntries.forEach((entry) => {
    if (!isLikelyOpenCodeProviderKey(entry?.key)) return;
    providerKeys.add(normalizeOpenCodeProviderKey(entry.key));
  });
  const providers = [...providerKeys].map((key) => {
    const value = providerMap[key] || {};
    const builtin = getOpenCodeBuiltinProviderMeta(key);
    const matchedAuth = findOpenCodeAuthEntry(authEntries, key, value?.options?.baseURL || '');
    const hasApiKey = Boolean(String(value?.options?.apiKey || '').trim());
    return {
      key,
      name: value?.name || builtin?.name || key,
      npm: value?.npm || '',
      recommendedPackage: builtin?.recommendedPackage || '',
      builtin: Boolean(builtin),
      configured: Boolean(providerMap[key]),
      baseUrl: value?.options?.baseURL || builtin?.defaultBaseUrl || '',
      hasApiKey,
      hasAuth: Boolean(matchedAuth),
      hasCredential: hasApiKey || Boolean(matchedAuth),
      authType: matchedAuth?.type || '',
      maskedApiKey: maskSecret(value?.options?.apiKey || ''),
      modelIds: Object.keys(value?.models || {}),
    };
  });
  const activeProviderKey = openCodeProviderFromModel(model) || providers[0]?.key || '';
  const activeProvider = providers.find((item) => item.key === activeProviderKey) || null;
  const activeAuth = findOpenCodeAuthEntry(authEntries, activeProviderKey, activeProvider?.baseUrl || '');
  return {
    toolId: 'opencode',
    scope: paths.scope,
    rootPath: paths.rootPath,
    configPath: paths.configPath,
    authPath: paths.authPath,
    binary,
    configExists: Boolean(rawConfig.trim()),
    authExists: Boolean(rawAuth.trim()),
    config,
    configJson: rawConfig.trim() ? rawConfig : JSON.stringify(config, null, 2),
    model,
    smallModel,
    activeProviderKey,
    activeProvider,
    activeAuth,
    authEntries,
    providers,
    builtinProviders: OPENCODE_BUILTIN_PROVIDER_CATALOG,
    loadOrder: OPENCODE_LOAD_ORDER,
    directoryFeatures: OPENCODE_DIRECTORY_FEATURES,
  };
}

export async function saveOpenCodeConfig({ configJson, scope = 'global', projectPath = '' } = {}) {
  const raw = String(configJson || '').trim();
  if (!raw) throw new Error('OpenCode 配置内容不能为空');
  try {
    parseJsonc(raw);
  } catch (error) {
    throw new Error(`OpenCode 配置解析失败：${error.message}`);
  }
  const paths = resolveOpenCodePaths({ scope, projectPath });
  await writeText(paths.configPath, `${raw}\n`);
  return { saved: true, configPath: paths.configPath, scope: paths.scope };
}

export async function saveOpenCodeRawConfig(payload = {}) {
  return saveOpenCodeConfig(payload);
}

/* ═══════════════  OpenClaw  ═══════════════ */

function openclawHome() {
  return path.join(os.homedir(), '.openclaw');
}

function resolveRemotePort(input) {
  const text = String(input ?? '').trim();
  if (!text) return 22;
  const port = Number.parseInt(text, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('远程端口必须是 1-65535 的整数');
  }
  return port;
}

function resolveRemoteKeyPath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(expanded);
}

function resolveRemoteHost(input) {
  const host = String(input ?? '').trim();
  if (!host) throw new Error('请输入远程服务器 IP 或域名');
  return host;
}

function resolveRemoteUsername(input) {
  const username = String(input ?? '').trim();
  if (!username) throw new Error('请输入远程登录用户名');
  return username;
}

function resolveRemoteAuthMethod(input) {
  const method = String(input ?? 'agent').trim().toLowerCase();
  if (!['agent', 'password', 'key'].includes(method)) {
    throw new Error('不支持的远程登录方式');
  }
  return method;
}

function resolveRemoteInstallMethod(input) {
  const method = String(input ?? 'script').trim().toLowerCase();
  if (!['script', 'npm'].includes(method)) {
    throw new Error('远程安装仅支持脚本安装或 npm 安装');
  }
  return method;
}

function resolveRemoteTargetOs(input) {
  const osText = String(input ?? 'unix').trim().toLowerCase();
  if (['windows', 'win'].includes(osText)) return 'windows';
  if (['unix', 'linux', 'macos', 'darwin'].includes(osText)) return 'unix';
  throw new Error('远程系统仅支持 Linux/macOS 或 Windows');
}

function resolveRemoteInstallCommand(method, remoteOs) {
  if (remoteOs === 'windows') {
    if (method === 'script') {
      return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${OPENCLAW_INSTALL_SCRIPT_WIN}"`;
    }
    return 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "npm install -g openclaw@latest"';
  }
  return method === 'script' ? OPENCLAW_INSTALL_SCRIPT_UNIX : 'npm install -g openclaw@latest';
}

function resolveRemoteVerifyCommand(remoteOs) {
  if (remoteOs === 'windows') {
    return 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "openclaw --version"';
  }
  return "sh -lc 'openclaw --version 2>/dev/null || true'";
}

function extractOpenClawVersion(text) {
  const match = String(text || '').match(/openclaw[^\d]*(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)/i)
    || String(text || '').match(/(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)/i);
  return match ? match[1] : '';
}

async function runRemoteSshCommand({
  host,
  port,
  username,
  authMethod,
  password,
  keyPath,
  remoteCommand,
} = {}) {
  if (!commandExists('ssh')) {
    throw new Error('本机未检测到 ssh 命令，请先安装 OpenSSH 客户端');
  }
  const sshArgs = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=12',
    '-p', String(port),
  ];
  if (authMethod === 'key') {
    if (!keyPath) throw new Error('请选择 SSH 私钥文件');
    await fs.access(keyPath).catch(() => {
      throw new Error(`未找到 SSH 私钥文件：${keyPath}`);
    });
    sshArgs.push('-i', keyPath, '-o', 'BatchMode=yes');
  } else if (authMethod === 'agent') {
    sshArgs.push('-o', 'BatchMode=yes');
  } else if (authMethod === 'password') {
    if (!password) throw new Error('请输入远程服务器密码');
  } else {
    throw new Error('不支持的认证方式');
  }
  sshArgs.push(`${username}@${host}`, remoteCommand);

  if (authMethod === 'password') {
    if (!commandExists('sshpass')) {
      throw new Error('密码登录需要本机安装 sshpass（macOS 可用 brew install hudochenkov/sshpass/sshpass）');
    }
    return runCommand('sshpass', ['-e', 'ssh', ...sshArgs], {
      env: { SSHPASS: password },
    });
  }
  return runCommand('ssh', sshArgs);
}

export async function installOpenClawRemote({
  host,
  port = 22,
  username,
  authMethod = 'agent',
  password = '',
  keyPath = '',
  installMethod = 'script',
  remoteOs = 'unix',
} = {}) {
  const remoteHost = resolveRemoteHost(host);
  const remotePort = resolveRemotePort(port);
  const remoteUser = resolveRemoteUsername(username);
  const remoteAuthMethod = resolveRemoteAuthMethod(authMethod);
  const remoteTargetOs = resolveRemoteTargetOs(remoteOs);
  const remoteInstallMethod = resolveRemoteInstallMethod(installMethod);
  const remoteKeyPath = resolveRemoteKeyPath(keyPath);
  const remoteCommand = resolveRemoteInstallCommand(remoteInstallMethod, remoteTargetOs);
  const remoteTarget = `${remoteUser}@${remoteHost}:${remotePort}`;

  const installResult = await runRemoteSshCommand({
    host: remoteHost,
    port: remotePort,
    username: remoteUser,
    authMethod: remoteAuthMethod,
    password: String(password || ''),
    keyPath: remoteKeyPath,
    remoteCommand,
  });

  if (!installResult.ok) {
    const reason = String(installResult.stderr || installResult.stdout || '').trim();
    throw new Error(reason || `远程安装失败：${remoteTarget}`);
  }

  const verifyCommand = resolveRemoteVerifyCommand(remoteTargetOs);
  const verifyResult = await runRemoteSshCommand({
    host: remoteHost,
    port: remotePort,
    username: remoteUser,
    authMethod: remoteAuthMethod,
    password: String(password || ''),
    keyPath: remoteKeyPath,
    remoteCommand: verifyCommand,
  });

  const versionText = String(verifyResult.stdout || verifyResult.stderr || '').trim();
  const version = extractOpenClawVersion(versionText);

  return {
    ok: true,
    mode: 'remote',
    method: remoteInstallMethod,
    command: remoteCommand,
    remote: {
      host: remoteHost,
      port: remotePort,
      username: remoteUser,
      authMethod: remoteAuthMethod,
      os: remoteTargetOs,
      target: remoteTarget,
    },
    version: version || null,
    stdout: installResult.stdout,
    stderr: installResult.stderr,
    verifyStdout: verifyResult.stdout,
    verifyStderr: verifyResult.stderr,
  };
}

export async function loadOpenClawState() {
  const home = openclawHome();
  const configPath = path.join(home, 'openclaw.json');
  const binary = findToolBinary('openclaw');

  let config = {};
  const raw = await readText(configPath);
  const configExists = Boolean(raw.trim());
  if (raw.trim()) {
    try { config = JSON.parse(raw); } catch { /* ignore */ }
  }
  if (configExists && await ensureOpenClawGatewayDefaults(configPath, config)) {
    config = JSON.parse(await readText(configPath) || '{}');
  }

  const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || String(config.gateway?.port || '18789');
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}/`;
  const gatewayProbe = await probeOpenClawGateway(gatewayUrl);
  const gatewayPortOccupants = await inspectOpenClawPortOccupants(gatewayPort);
  const daemon = binary.installed ? readOpenClawDaemonState(binary.path || 'openclaw') : {
    supported: process.platform !== 'win32',
    installed: false,
    loaded: false,
    running: false,
    status: 'not_installed',
    label: '未启用',
    detail: '',
  };
  const needsOnboarding = binary.installed && !configExists;
  const gatewayAuthMode = String(config.gateway?.auth?.mode || 'token');
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || config.gateway?.auth?.token || null;
  const dashboardUrl = buildOpenClawDashboardUrl({ gatewayUrl, config, gatewayToken });

  return {
    toolId: 'openclaw',
    configHome: home,
    configPath,
    configExists,
    config,
    configJson: JSON.stringify(config, null, 2),
    binary,
    gatewayAuthMode,
    gatewayToken,
    gatewayTokenReady: gatewayAuthMode !== 'token' || Boolean(gatewayToken),
    gatewayPort,
    gatewayUrl,
    dashboardUrl,
    gatewayReachable: gatewayProbe.httpReady,
    gatewayHttpReady: gatewayProbe.httpReady,
    gatewayPortListening: gatewayProbe.portListening,
    gatewayStatus: gatewayProbe.status,
    daemon,
    daemonInstalled: daemon.installed,
    daemonLoaded: daemon.loaded,
    daemonRunning: daemon.running,
    daemonStatus: daemon.status,
    gatewayPortOccupants,
    gatewayPortConflict: gatewayPortOccupants.some((item) => !item.likelyOpenClaw),
    needsOnboarding,
    installMethods: process.platform === 'win32' ? ['domestic', 'wsl', 'script'] : ['script', 'npm', 'source', 'docker'],
  };
}

export async function getOpenClawDashboardUrl({ cwd } = {}) {
  const state = await loadOpenClawState();
  if (!state.binary?.installed) throw new Error('OpenClaw 尚未安装');
  const targetCwd = path.resolve(cwd || process.cwd());
  const binaryPath = state.binary.path || 'openclaw';
  const result = runSpawnSync(binaryPath, ['dashboard', '--no-open'], {
    cwd: targetCwd,
    encoding: 'utf8',
    timeout: 12000,
  });
  const merged = `${result.stdout || ''}\n${result.stderr || ''}`;
  const url = extractUrlFromText(merged) || state.dashboardUrl || state.gatewayUrl;
  return {
    ok: Boolean(url),
    url,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    command: `${binaryPath} dashboard --no-open`,
  };
}

export async function repairOpenClawDashboardAuth({ cwd } = {}) {
  const targetCwd = path.resolve(cwd || process.cwd());
  let state = await loadOpenClawState();
  if (!state.binary?.installed) throw new Error('OpenClaw 尚未安装');

  const binaryPath = state.binary.path || 'openclaw';
  const notes = [];
  let tokenGenerated = false;
  let restartRequired = false;

  if (state.gatewayAuthMode === 'token' && !state.gatewayToken) {
    const doctor = await runCommand(binaryPath, ['doctor', '--generate-gateway-token'], { cwd: targetCwd });
    notes.push(`doctor: ${(doctor.stderr || doctor.stdout || '').trim() || `exit=${doctor.code}`}`);
    const afterDoctor = await loadOpenClawState();
    if (afterDoctor.gatewayToken && afterDoctor.gatewayToken !== state.gatewayToken) {
      tokenGenerated = true;
      restartRequired = afterDoctor.gatewayReachable;
      state = afterDoctor;
    }
  }

  const configGet = await runCommand(binaryPath, ['config', 'get', 'gateway.auth.token'], { cwd: targetCwd });
  const cliToken = extractOpenClawGatewayToken(`${configGet.stdout || ''}\n${configGet.stderr || ''}`);
  if (!state.gatewayToken && cliToken) {
    state = {
      ...state,
      gatewayToken: cliToken,
      gatewayTokenReady: true,
      dashboardUrl: buildOpenClawDashboardUrl({ gatewayUrl: state.gatewayUrl, config: state.config, gatewayToken: cliToken }),
    };
  }

  if (state.gatewayAuthMode === 'token' && !state.gatewayToken) {
    throw new Error('Gateway token 仍未就绪，请检查 `openclaw config get gateway.auth.token` 或 `openclaw doctor --generate-gateway-token` 输出');
  }

  if (restartRequired) {
    await stopOpenClaw();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  let launch = null;
  state = await loadOpenClawState();
  if ((!state.gatewayReachable && !state.gatewayPortListening) || restartRequired) {
    launch = await launchOpenClaw({ cwd: targetCwd });
  } else if (state.gatewayPortListening && !state.gatewayReachable) {
    notes.push('Gateway 端口已监听，正在等待 HTTP 控制面板就绪');
  }
  if (!state.gatewayReachable) {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      state = await loadOpenClawState();
      if (state.gatewayReachable) break;
    }
  }

  const dashboard = await getOpenClawDashboardUrl({ cwd: targetCwd });
  const dashboardUrl = normalizeOpenClawDashboardBootstrapUrl(dashboard.url || state.dashboardUrl || state.gatewayUrl, state.gatewayToken);

  return {
    ok: true,
    tokenGenerated,
    restartRequired,
    gatewayReachable: state.gatewayReachable,
    gatewayHttpReady: state.gatewayHttpReady,
    gatewayPortListening: state.gatewayPortListening,
    gatewayStatus: state.gatewayStatus,
    gatewayUrl: state.gatewayUrl,
    gatewayToken: state.gatewayToken,
    dashboardUrl,
    launch,
    notes,
  };
}

export async function saveOpenClawConfig({ configJson }) {
  if (!configJson || !configJson.trim()) throw new Error('配置内容不能为空');
  let parsed;
  try { parsed = JSON.parse(configJson); } catch (e) {
    throw new Error(`JSON 解析失败：${e.message}`);
  }
  applyOpenClawGatewayDefaults(parsed);
  const home = openclawHome();
  const configPath = path.join(home, 'openclaw.json');
  await ensureDir(home);
  await writeText(configPath, JSON.stringify(parsed, null, 2) + '\n');
  return { saved: true, configPath };
}

export async function startOpenClawInstallTask({ method = process.platform === 'win32' ? 'domestic' : 'script' } = {}) {
  if (!['script', 'npm', 'domestic'].includes(method)) {
    throw new Error('只有一键安装、脚本安装和 npm 安装支持实时进度追踪');
  }

  const command = method === 'script'
    ? (process.platform === 'win32' ? OPENCLAW_INSTALL_SCRIPT_WIN : OPENCLAW_INSTALL_SCRIPT_UNIX)
    : method === 'domestic'
      ? `${npmCommand()} install -g openclaw@latest --registry=${OPENCLAW_NPM_REGISTRY_CN}`
      : `${npmCommand()} install -g openclaw@latest`;

  const task = createOpenClawInstallTask({ method, command });
  task._installSnapshot = await captureOpenClawInstallSnapshot();
  void runOpenClawInstallTask(task);
  return serializeOpenClawInstallTask(task);
}

export async function getOpenClawInstallTask({ taskId } = {}) {
  cleanupOpenClawInstallTasks();
  if (!taskId || !OPENCLAW_INSTALL_TASKS.has(taskId)) {
    throw new Error('安装任务不存在，可能已经过期，请重新开始安装');
  }
  return serializeOpenClawInstallTask(OPENCLAW_INSTALL_TASKS.get(taskId));
}

export async function cancelOpenClawInstallTask({ taskId } = {}) {
  cleanupOpenClawInstallTasks();
  if (!taskId || !OPENCLAW_INSTALL_TASKS.has(taskId)) {
    throw new Error('安装任务不存在，可能已经过期，请重新开始安装');
  }
  return cancelRunningOpenClawInstall(OPENCLAW_INSTALL_TASKS.get(taskId));
}

export async function installOpenClaw({ method = process.platform === 'win32' ? 'domestic' : 'script' } = {}) {
  if (method === 'domestic') {
    const setup = await prepareOpenClawWindowsInstall({ useCnRegistry: true });
    const result = await runCommand(npmCommand(), ['install', '-g', 'openclaw@latest', '--registry', OPENCLAW_NPM_REGISTRY_CN], { env: setup.env });
    return { ...result, method: 'domestic', command: `${npmCommand()} install -g openclaw@latest --registry=${OPENCLAW_NPM_REGISTRY_CN}` };
  }
  if (method === 'wsl') {
    return {
      ok: true,
      method: 'wsl',
      instructions: [
        'wsl --status',
        'wsl --install -d Ubuntu-24.04',
        'wsl -d Ubuntu-24.04 -- bash -lc "curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm"',
        'wsl -d Ubuntu-24.04 -- bash -lc "openclaw --version"',
      ],
      message: 'WSL2 适合熟悉 Linux 的高级用户；如果本机还没装 Ubuntu，首次初始化会较久。',
    };
  }
  if (method === 'script') {
    if (process.platform === 'win32') {
      const setup = await prepareOpenClawWindowsInstall();
      const result = await runCommand('powershell.exe', openClawWindowsPowerShellArgs(OPENCLAW_INSTALL_SCRIPT_WIN), { env: setup.env });
      return { ...result, method: 'script', command: OPENCLAW_INSTALL_SCRIPT_WIN };
    } else {
      const result = await runCommand('bash', ['-c', OPENCLAW_INSTALL_SCRIPT_UNIX]);
      return { ...result, method: 'script', command: OPENCLAW_INSTALL_SCRIPT_UNIX };
    }
  }
  if (method === 'npm') {
    const setup = await prepareOpenClawWindowsInstall();
    const result = await runCommand(npmCommand(), ['install', '-g', 'openclaw@latest'], { env: setup.env });
    return { ...result, method: 'npm', command: `${npmCommand()} install -g openclaw@latest` };
  }
  if (method === 'source') {
    return {
      ok: true,
      method: 'source',
      instructions: [
        'git clone https://github.com/openclaw/openclaw.git',
        'cd openclaw',
        'pnpm install',
        'pnpm ui:build',
        'pnpm build',
        'pnpm link --global',
        'openclaw onboard --install-daemon',
      ],
      message: '源码构建需要在终端中手动执行以上命令',
    };
  }
  if (method === 'docker') {
    return {
      ok: true,
      method: 'docker',
      instructions: [
        'git clone https://github.com/openclaw/openclaw.git',
        'cd openclaw',
        './docker-setup.sh',
      ],
      message: 'Docker 安装需要在终端中手动执行以上命令',
    };
  }
  throw new Error(`不支持的安装方式：${method}`);
}

export async function updateOpenClaw() {
  const setup = await prepareOpenClawWindowsInstall();
  return runCommand(npmCommand(), ['install', '-g', 'openclaw@latest'], { env: setup.env });
}

export async function reinstallOpenClaw() {
  const setup = await prepareOpenClawWindowsInstall();
  return runCommand(npmCommand(), ['install', '-g', 'openclaw', '--force'], { env: setup.env });
}

export async function uninstallOpenClaw({ purge = false } = {}) {
  // If purge requested, remove the OpenClaw data directory (~/.openclaw)
  let purgedPaths = [];
  if (purge) {
    const home = openclawHome();
    try {
      await fs.rm(home, { recursive: true, force: true });
      purgedPaths.push(home);
    } catch { /* directory may not exist, that's fine */ }
  }
  const setup = await prepareOpenClawWindowsInstall();
  const result = await runCommand(npmCommand(), ['uninstall', '-g', 'openclaw'], { env: setup.env });
  return { ...result, purge, purgedPaths };
}

export async function launchOpenClaw({ cwd } = {}) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const state = await loadOpenClawState();
  const binary = state.binary;
  if (!binary?.installed) {
    throw new Error('OpenClaw 尚未安装，请先选择安装方式进行安装');
  }

  if (!state.configExists) {
    const onboard = await onboardOpenClaw({ cwd: targetCwd });
    return { ...onboard, mode: 'onboard', gatewayUrl: state.gatewayUrl };
  }

  if (state.gatewayReachable) {
    return {
      ok: true,
      cwd: targetCwd,
      mode: 'dashboard',
      gatewayUrl: state.gatewayUrl,
      message: 'OpenClaw Dashboard 已准备好',
    };
  }

  if (state.gatewayPortListening) {
    return {
      ok: true,
      cwd: targetCwd,
      mode: 'warming',
      gatewayUrl: state.gatewayUrl,
      command: '',
      background: true,
      message: 'OpenClaw Gateway 正在启动，稍后会自动就绪',
    };
  }

  const binaryPath = binary.path || 'openclaw';
  const commandText = process.platform === 'win32'
    ? buildWindowsCommand(binaryPath, ['gateway', '--force'])
    : `${binaryPath} gateway --force`;
  if (process.platform === 'win32') {
    const message = launchWindowsBackgroundCommand(targetCwd, commandText, {
      toolLabel: 'OpenClaw Gateway',
    });
    return { ok: true, cwd: targetCwd, mode: 'gateway', gatewayUrl: state.gatewayUrl, command: commandText, message, background: true };
  }
  const message = launchTerminalCommand(targetCwd, {
    commandText,
    binaryName: 'openclaw gateway',
    toolLabel: 'OpenClaw Gateway',
  });
  return { ok: true, cwd: targetCwd, mode: 'gateway', gatewayUrl: state.gatewayUrl, command: commandText, message };
}

export async function stopOpenClaw() {
  const state = await loadOpenClawState();
  const attempts = [];

  if (!state.binary?.installed) {
    return { stopped: true, attempts, gatewayReachable: false, message: 'OpenClaw 未安装，无需停止' };
  }

  const binaryPath = state.binary.path || 'openclaw';
  const cwd = openclawHome();
  let daemonDisabled = false;

  const runStopAttempt = async (command, args, options = {}) => {
    const result = await runCommand(command, args, options);
    attempts.push({ command: `${command} ${args.join(' ')}`.trim(), ok: result.ok, stdout: result.stdout, stderr: result.stderr });
    return result;
  };

  if (process.platform !== 'win32') {
    await runStopAttempt(binaryPath, ['daemon', 'stop'], { cwd });
    const uninstallResult = await runStopAttempt(binaryPath, ['daemon', 'uninstall'], { cwd });
    daemonDisabled = uninstallResult.ok;
  }

  for (const args of [['gateway', 'stop'], ['stop']]) {
    const result = await runStopAttempt(binaryPath, args, { cwd });
    if (result.ok) break;
  }

  if (process.platform === 'win32') {
    for (const pid of await findWindowsListeningPids(state.gatewayPort || '18789')) {
      await runStopAttempt('taskkill', ['/F', '/T', '/PID', String(pid)]);
    }
    await runStopAttempt('taskkill', ['/F', '/T', '/IM', 'openclaw.exe']);
  } else {
    await runStopAttempt('pkill', ['-f', 'openclaw']);
  }

  await new Promise((resolve) => setTimeout(resolve, 900));
  let after = await loadOpenClawState();

  if ((after.gatewayReachable || after.gatewayPortListening) && process.platform !== 'win32') {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await runStopAttempt('pkill', ['-f', 'openclaw']);
    await new Promise((resolve) => setTimeout(resolve, 900));
    after = await loadOpenClawState();
  }

  if (after.gatewayReachable || after.gatewayPortListening) {
    throw new Error('OpenClaw Gateway 仍在运行，已自动尝试停止常驻服务，请稍后重试或检查残留进程');
  }

  return {
    stopped: true,
    attempts,
    daemonDisabled,
    gatewayReachable: after.gatewayReachable,
    gatewayUrl: after.gatewayUrl,
    message: daemonDisabled ? 'OpenClaw Gateway 与常驻服务已停止' : 'OpenClaw Gateway 已停止',
  };
}

export async function setOpenClawDaemonEnabled({ enabled } = {}) {
  let state = await loadOpenClawState();
  if (!state.binary?.installed) throw new Error('OpenClaw 尚未安装');

  const binaryPath = state.binary.path || 'openclaw';
  const cwd = openclawHome();
  const attempts = [];
  const runAttempt = async (command, args, options = {}) => {
    const result = await runCommand(command, args, options);
    attempts.push({ command: `${command} ${args.join(' ')}`.trim(), ok: result.ok, stdout: result.stdout, stderr: result.stderr });
    return result;
  };

  if (!enabled) {
    const stopped = await stopOpenClaw();
    state = await loadOpenClawState();
    return {
      ok: true,
      enabled: false,
      attempts: [...attempts, ...(stopped.attempts || [])],
      daemon: state.daemon,
      message: 'OpenClaw 常驻服务已关闭',
    };
  }

  if (!state.configExists) {
    throw new Error('请先完成 OpenClaw 初始化，再开启常驻服务');
  }

  if (state.gatewayAuthMode === 'token' && !state.gatewayToken) {
    await runAttempt(binaryPath, ['doctor', '--generate-gateway-token'], { cwd });
    state = await loadOpenClawState();
  }

  const installArgs = ['daemon', 'install', '--force', '--port', String(state.gatewayPort || '18789')];
  if (state.gatewayAuthMode === 'token' && state.gatewayToken) {
    installArgs.push('--token', String(state.gatewayToken));
  }
  const installResult = await runAttempt(binaryPath, installArgs, { cwd });
  if (!installResult.ok) {
    throw new Error(tailText(installResult.stderr || installResult.stdout || '', 10) || '开启常驻服务失败');
  }

  await runAttempt(binaryPath, ['daemon', 'start'], { cwd });
  await new Promise((resolve) => setTimeout(resolve, 900));
  state = await loadOpenClawState();
  if (!state.daemonInstalled) {
    throw new Error('常驻服务安装后仍未生效');
  }

  return {
    ok: true,
    enabled: true,
    attempts,
    daemon: state.daemon,
    gatewayReachable: state.gatewayReachable,
    gatewayUrl: state.gatewayUrl,
    message: state.daemonRunning ? 'OpenClaw 常驻服务已开启并启动' : 'OpenClaw 常驻服务已开启',
  };
}

export async function killOpenClawPortOccupants({ pid } = {}) {
  const state = await loadOpenClawState();
  const targetPid = Number(pid || 0);
  const occupants = (state.gatewayPortOccupants || []).filter((item) => !targetPid || Number(item.pid) === targetPid);
  if (!occupants.length) {
    return { ok: true, killed: [], message: `未检测到 ${state.gatewayPort || '18789'} 端口占用进程` };
  }

  const killed = [];
  const failed = [];
  for (const occupant of occupants) {
    const result = process.platform === 'win32'
      ? await runCommand('taskkill', ['/F', '/T', '/PID', String(occupant.pid)])
      : await runCommand('kill', ['-9', String(occupant.pid)]);
    if (result.ok) killed.push({ ...occupant, stdout: result.stdout, stderr: result.stderr });
    else failed.push({ ...occupant, stdout: result.stdout, stderr: result.stderr });
  }

  const after = await loadOpenClawState();
  return {
    ok: failed.length === 0,
    killed,
    failed,
    gatewayPort: after.gatewayPort,
    gatewayUrl: after.gatewayUrl,
    gatewayStatus: after.gatewayStatus,
    gatewayPortOccupants: after.gatewayPortOccupants,
    message: failed.length ? '部分端口占用进程结束失败' : '端口占用进程已结束',
  };
}

export async function onboardOpenClaw({ cwd, authChoice, apiKey, apiKeyType } = {}) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const binary = findToolBinary('openclaw');
  if (!binary.installed) {
    throw new Error('OpenClaw 尚未安装，请先完成安装');
  }
  const binPath = binary.path || 'openclaw';

  // Build non-interactive command args
  const args = [
    'onboard',
    '--non-interactive',
    '--accept-risk',
    '--flow', 'quickstart',
    '--skip-channels',
    '--skip-skills',
    '--skip-search',
    '--json',
  ];
  if (process.platform !== 'win32') {
    args.push('--install-daemon');
  }

  // If user provided an auth choice + API key, pass them
  if (authChoice && authChoice !== 'skip') {
    args.push('--auth-choice', authChoice);
    if (apiKey) {
      // Map common auth choices to their flag names
      const keyFlagMap = {
        'anthropic': '--anthropic-api-key',
        'apiKey': '--custom-api-key',
        'openai-api-key': '--openai-api-key',
        'openrouter-api-key': '--openrouter-api-key',
        'gemini-api-key': '--gemini-api-key',
        'mistral-api-key': '--mistral-api-key',
        'together-api-key': '--together-api-key',
        'xai-api-key': '--xai-api-key',
        'custom-api-key': '--custom-api-key',
      };
      const flag = keyFlagMap[authChoice] || keyFlagMap[apiKeyType] || '--custom-api-key';
      args.push(flag, apiKey);
    }
  } else {
    args.push('--auth-choice', 'skip');
  }

  const commandText = `${binPath} ${args.join(' ')}`;

  // Run directly as child process (not in terminal)
  const { execFileSync } = await import('child_process');
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(binPath, args, {
      cwd: targetCwd,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      windowsHide: true,
    });
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || err.message || '';
  }

  // Try to parse JSON output from the command
  let jsonResult = null;
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { jsonResult = JSON.parse(jsonMatch[0]); } catch { /* ignore */ }
  }

  const configPath = path.join(openclawHome(), 'openclaw.json');
  if (existsSync(configPath)) {
    let config = {};
    try { config = JSON.parse(await readText(configPath) || '{}'); } catch { /* ignore */ }
    await ensureOpenClawGatewayDefaults(configPath, config);
  }

  const success = stdout.includes('Updated') || stdout.includes('openclaw.json') || jsonResult != null;

  return {
    ok: success,
    cwd: targetCwd,
    command: commandText,
    message: success ? 'OpenClaw 初始化完成' : `初始化可能未完成：${stderr || '请检查日志'}`,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    result: jsonResult,
  };
}

function applyOpenClawGatewayDefaults(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  if (!config.gateway || typeof config.gateway !== 'object' || Array.isArray(config.gateway)) config.gateway = {};
  if (!config.gateway.auth || typeof config.gateway.auth !== 'object' || Array.isArray(config.gateway.auth)) config.gateway.auth = {};
  let changed = false;
  if (!String(config.gateway.auth.mode || '').trim()) {
    config.gateway.auth.mode = 'token';
    changed = true;
  }
  if (config.gateway.auth.mode === 'token' && !String(config.gateway.auth.token || '').trim()) {
    config.gateway.auth.token = `oc_${crypto.randomBytes(16).toString('hex')}`;
    changed = true;
  }
  return changed;
}

async function ensureOpenClawGatewayDefaults(configPath, config) {
  if (!applyOpenClawGatewayDefaults(config)) return false;
  await ensureDir(path.dirname(configPath));
  await writeText(configPath, JSON.stringify(config, null, 2) + '\n');
  return true;
}

function normalizeOpenClawControlUiBasePath(value) {
  const input = String(value || '').trim();
  if (!input || input === '/') return '/';
  return `/${input.replace(/^\/+|\/+$/g, '')}`;
}

function buildOpenClawDashboardUrl({ gatewayUrl, config, gatewayToken }) {
  const base = String(gatewayUrl || '').trim();
  if (!base) return '';
  const url = new URL(base);
  url.pathname = normalizeOpenClawControlUiBasePath(config?.gateway?.controlUi?.basePath || '/');
  return normalizeOpenClawDashboardBootstrapUrl(url.toString(), gatewayToken);
}

function extractUrlFromText(text) {
  return String(text || '').match(/https?:\/\/\S+/)?.[0]?.replace(/[),.;]+$/, '') || '';
}

function extractOpenClawGatewayToken(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/(?:^|\b)(oc_[a-z0-9]+)(?:\b|$)/i);
    if (match) return match[1];
  }
  return '';
}

function normalizeOpenClawDashboardBootstrapUrl(rawUrl, gatewayToken) {
  const input = String(rawUrl || '').trim();
  if (!input) return '';
  const url = new URL(input);
  if (gatewayToken) {
    url.hash = '';
    url.searchParams.set('token', gatewayToken);
  }
  return url.toString();
}
