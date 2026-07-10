// touched on 2026-05-11
import fs from 'node:fs/promises';

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import TOML from '@iarna/toml';
import { detectProvider, readDiag } from './provider-check.js';
import { applyAdapterToProvider } from './cn-provider-adapters.js';
import { extractProviderImportItems } from './provider-catalog.js';

const APP_HOME_DIRNAME = '.codex-config-ui';
const BACKUPS_DIRNAME = 'backups';
const OPENAI_CODEX_PACKAGE = '@openai/codex';
const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code';
const GEMINI_CLI_PACKAGE = '@google/gemini-cli';
const QWEN_CODE_PACKAGE = '@qwen-code/qwen-code';
const CODEBUDDY_CODE_PACKAGE = '@tencent-ai/codebuddy-code';
const OPENCODE_PACKAGE = 'opencode-ai';
const OPENCLAW_PACKAGE = 'openclaw';
const OPENCODE_INSTALL_SCRIPT_UNIX = 'curl -fsSL https://opencode.ai/install | bash';
const OPENCODE_INSTALL_TASK_TTL_MS = 30 * 60 * 1000;
const OPENCODE_INSTALL_TASKS = new Map();
const OPENCLAW_INSTALL_TASK_TTL_MS = 30 * 60 * 1000;
const OPENCLAW_INSTALL_TASKS = new Map();
const OPENCLAW_NPM_REGISTRY_CN = 'https://registry.npmmirror.com';
const NPM_REGISTRY_GLOBAL = 'https://registry.npmjs.org';
const NPM_REGISTRY_CN = 'https://registry.npmmirror.com';
const TOOL_VERSION_TIMEOUT_MS = 2500;

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
    supportStage: 'active',
  },
  'claude-desktop': {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    description: 'Anthropic 桌面端，重点接入 MCP 与本地配置同步',
    configHome: () => {
      if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
      if (process.platform === 'win32') return path.join(process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude');
      return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'Claude');
    },
    configFormat: 'json',
    configFileName: 'claude_desktop_config.json',
    envFileName: null,
    binaryName: 'Claude',
    npmPackage: '',
    installMethod: 'manual',
    providerKeyField: null,
    projectConfigDir: '.claude',
    supported: true,
    supportStage: 'active',
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
    supportStage: 'active',
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
    npmPackage: OPENCLAW_PACKAGE,
    installMethod: 'multi',
    providerKeyField: 'provider',
    projectConfigDir: '.openclaw',
    supported: true,
    supportStage: 'active',
    installMethods: process.platform === 'win32' ? ['domestic', 'wsl', 'script'] : ['script', 'npm', 'source', 'docker'],
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    description: 'Google Gemini 命令行编程助手，后续接入 provider / prompts / sessions',
    configHome: () => path.join(os.homedir(), '.gemini'),
    configFormat: 'json',
    configFileName: 'settings.json',
    envFileName: null,
    binaryName: 'gemini',
    npmPackage: GEMINI_CLI_PACKAGE,
    installMethod: 'npm',
    providerKeyField: null,
    projectConfigDir: '.gemini',
    supported: true,
    supportStage: 'active',
  },
  'qwen-code': {
    id: 'qwen-code',
    name: 'Qwen Code CLI',
    description: '阿里 Qwen Code 命令行工具，安装、更新与版本回滚已接入',
    configHome: () => path.join(os.homedir(), '.qwen'),
    configFormat: 'unknown',
    configFileName: '',
    envFileName: null,
    binaryName: 'qwen',
    npmPackage: QWEN_CODE_PACKAGE,
    installMethod: 'npm',
    providerKeyField: null,
    projectConfigDir: '.qwen',
    supported: true,
    supportStage: 'active',
  },
  'codebuddy-code': {
    id: 'codebuddy-code',
    name: 'CodeBuddy Code CLI',
    description: '腾讯 CodeBuddy CLI，安装、更新与版本回滚已接入',
    configHome: () => path.join(os.homedir(), '.codebuddy'),
    configFormat: 'unknown',
    configFileName: '',
    envFileName: null,
    binaryName: 'codebuddy',
    npmPackage: CODEBUDDY_CODE_PACKAGE,
    installMethod: 'npm',
    providerKeyField: null,
    projectConfigDir: '.codebuddy',
    supported: true,
    supportStage: 'active',
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes Agent',
    description: 'Hermes Agent 工作区、Router Provider 与会话能力',
    configHome: () => path.join(os.homedir(), '.hermes'),
    configFormat: 'yaml',
    configFileName: 'config.yaml',
    envFileName: '.env',
    binaryName: 'hermes',
    npmPackage: '',
    installMethod: 'manual',
    providerKeyField: null,
    projectConfigDir: '.hermes',
    supported: true,
    supportStage: 'active',
  },
};

const ROUTER_CLIENT_PROVIDER_KEY = 'easyai-router';
const ROUTER_CLIENT_API_KEY = 'easyai-router';
const ROUTER_CLIENT_PROVIDER_NAME = 'EasyAIConfig Router';
const ROUTER_CLIENT_ENV_KEY = 'EASYAI_ROUTER_API_KEY';
const LOCAL_ROUTER_NO_PROXY_ITEMS = ['127.0.0.1', 'localhost', '::1'];

function normalizeToolRegistryId(toolId) {
  const value = String(toolId || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (['claude-desktop', 'claudedesktop'].includes(value)) return 'claude-desktop';
  if (['claude-code', 'claudecode'].includes(value)) return 'claudecode';
  if (['gemini', 'gemini-cli', 'google-gemini'].includes(value)) return 'gemini';
  if (['qwen', 'qwen-code', 'qwen-code-cli', 'qwen-cli'].includes(value)) return 'qwen-code';
  if (['codebuddy', 'codebuddy-code', 'codebuddy-cli', 'tencent-codebuddy'].includes(value)) return 'codebuddy-code';
  if (['open-code', 'opencode'].includes(value)) return 'opencode';
  if (['open-claw', 'openclaw'].includes(value)) return 'openclaw';
  if (['hermes', 'hermes-agent'].includes(value)) return 'hermes';
  return value || 'codex';
}

function getToolDef(toolId) {
  return TOOL_REGISTRY[normalizeToolRegistryId(toolId)] || TOOL_REGISTRY.codex;
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

function nvmVersionBinDirs() {
  if (process.platform === 'win32') return [];
  const nvmDir = process.env.NVM_DIR?.trim() || path.join(os.homedir(), '.nvm');
  const versionsRoot = path.join(nvmDir, 'versions', 'node');
  if (!existsSync(versionsRoot)) return [];
  try {
    return readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(versionsRoot, entry.name, 'bin'))
      .filter((dir) => existsSync(dir))
      // 新版本（高字典序）优先：v22.x > v20.x，避免 codex 多版本时挑到老的
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

function unixSystemBinDirs() {
  if (process.platform === 'win32') return [];
  // GUI 启动（Tauri/Electron）下 PATH 通常很瘦，把 macOS / Linux 上
  // brew、系统、用户级 bin 全部补一遍，保证 commandExists 不依赖原生 PATH。
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
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
    add(path.join(home, 'bin'));
    // nvm 多版本：用户没在 GUI shell 里 source nvm 也能找到 codex
    nvmVersionBinDirs().forEach(add);
    // 系统 / brew 路径，必须放最后，优先级低于用户 node 版本
    unixSystemBinDirs().forEach(add);
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

function envPathBinDirs() {
  const dirs = new Set();
  const rawPath = process.env.PATH || process.env.Path || '';
  for (const entry of String(rawPath || '').split(path.delimiter)) {
    const resolved = safeResolveDir(entry);
    if (resolved) dirs.add(resolved);
  }
  return [...dirs];
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

function toolBinaryCandidates(toolId, { passive = false } = {}) {
  const tool = getToolDef(toolId);
  const binaryName = tool.binaryName;
  const candidates = new Set();
  const passiveWindows = Boolean(passive && process.platform === 'win32');
  const addCandidate = (candidate) => {
    if (candidate) candidates.add(candidate);
  };

  if (process.platform === 'win32') {
    const preferredPrefix = toolId === 'openclaw'
      ? openClawNpmPrefix()
      : passiveWindows
        ? ''
        : npmGlobalPrefix();
    const appData = process.env.APPDATA?.trim();
    const home = os.homedir();
    const winCandidates = [
      ...binaryCandidatesFromDir(binaryName, preferredPrefix),
      ...binaryCandidatesFromDir(binaryName, appData ? path.join(appData, 'npm') : ''),
      ...envPathBinDirs().flatMap((dirPath) => binaryCandidatesFromDir(binaryName, dirPath)),
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

  if (!passiveWindows) {
    const scanDirs = [...managerGlobalBinDirs(), ...managerReportedBinDirs()];
    // Unix 还要扫一遍当前进程 PATH 里出现的目录（Tauri GUI 模式下可能补到
    // 一些用户自定义的 export PATH=...）
    if (process.platform !== 'win32') {
      scanDirs.push(...envPathBinDirs());
    }
    for (const dirPath of scanDirs) {
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

    // Tauri/Electron GUI 进程的 PATH 通常很瘦（macOS .app 不继承登录 shell PATH）。
    // 兜底：通过登录 shell 拿一遍真实 PATH，覆盖用户在 .zshrc / .bashrc 里加的目录。
    if (process.platform !== 'win32') {
      const loginShellPath = readLoginShellPath();
      if (loginShellPath) {
        for (const entry of loginShellPath.split(':')) {
          const dir = safeResolveDir(entry);
          if (!dir) continue;
          for (const candidate of binaryCandidatesFromDir(binaryName, dir)) {
            if (candidate && existsSync(candidate)) addCandidate(candidate);
          }
        }
      }
    }
  }

  return [...candidates];
}

// 跑用户登录 shell（zsh / bash）的 PATH，并缓存一次，避免每次启动都 spawn。
let cachedLoginShellPath = null;
function readLoginShellPath() {
  if (cachedLoginShellPath !== null) return cachedLoginShellPath;
  if (process.platform === 'win32') {
    cachedLoginShellPath = '';
    return cachedLoginShellPath;
  }
  const shell = process.env.SHELL?.trim() || '/bin/zsh';
  const result = runSpawnSync(shell, ['-lc', 'echo $PATH'], { encoding: 'utf8', timeout: 1500 });
  cachedLoginShellPath = result.status === 0 ? String(result.stdout || '').trim() : '';
  return cachedLoginShellPath;
}

function windowsBinaryCandidateRank(binPath = '') {
  const lower = String(binPath || '').toLowerCase();
  if (lower.endsWith('.cmd')) return 0;
  if (lower.endsWith('.exe')) return 1;
  if (lower.endsWith('.bat')) return 2;
  if (lower.endsWith('.ps1')) return 4;
  return 3;
}

function readBinaryVersion(binPath, { passive = true } = {}) {
  if (!binPath) return { installed: false, version: null, path: null };
  const lower = String(binPath || '').toLowerCase();
  if (!existsSync(binPath)) {
    return {
      installed: false,
      version: null,
      path: binPath,
    };
  }

  let result;
  try {
    if (process.platform === 'win32' && lower.endsWith('.ps1')) {
      result = runSpawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', binPath, '--version'], { encoding: 'utf8', timeout: TOOL_VERSION_TIMEOUT_MS });
    } else if (process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
      result = runSpawnSync('cmd.exe', ['/d', '/s', '/c', `"${binPath}" --version`], { encoding: 'utf8', timeout: TOOL_VERSION_TIMEOUT_MS });
    } else {
      result = runSpawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: passive ? TOOL_VERSION_TIMEOUT_MS : 5000 });
    }
  } catch {
    return {
      installed: true,
      version: null,
      path: binPath,
    };
  }

  const versionText = result.status === 0
    ? String(result.stdout || result.stderr || '').trim()
    : null;
  return {
    installed: true,
    version: versionText,
    path: binPath,
  };
}


function findToolBinary(toolId, options = {}) {
  const candidates = toolBinaryCandidates(toolId, options).map((candidatePath) => readBinaryVersion(candidatePath, options)).filter((item) => item.installed);
  candidates.sort((left, right) => {
    if (!options.passive) {
      const versionOrder = compareVersions(right.version || '', left.version || '');
      if (versionOrder !== 0) return versionOrder;
    }
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

export function listTools(options = {}) {
  return Object.values(TOOL_REGISTRY).map(tool => ({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    supported: tool.supported,
    supportStage: tool.supportStage || (tool.supported ? 'active' : 'planned'),
    configFormat: tool.configFormat,
    installMethod: tool.installMethod,
    npmPackage: tool.npmPackage,
    configFileName: tool.configFileName,
    projectConfigDir: tool.projectConfigDir,
    binary: findToolBinary(tool.id, options),
  }));
}

const TOOL_UPDATE_SPECS = [
  { id: 'codex', name: 'Codex CLI', packageName: OPENAI_CODEX_PACKAGE, repositoryUrl: 'https://github.com/openai/codex' },
  { id: 'claudecode', name: 'Claude Code', packageName: CLAUDE_CODE_PACKAGE, repositoryUrl: 'https://github.com/anthropics/claude-code' },
  { id: 'gemini', name: 'Gemini CLI', packageName: GEMINI_CLI_PACKAGE, repositoryUrl: 'https://github.com/google-gemini/gemini-cli' },
  { id: 'qwen-code', name: 'Qwen Code CLI', packageName: QWEN_CODE_PACKAGE, repositoryUrl: 'https://github.com/QwenLM/qwen-code' },
  { id: 'codebuddy-code', name: 'CodeBuddy Code CLI', packageName: CODEBUDDY_CODE_PACKAGE, repositoryUrl: 'https://cnb.cool/codebuddy/codebuddy-code' },
  { id: 'opencode', name: 'OpenCode', packageName: OPENCODE_PACKAGE, repositoryUrl: 'https://github.com/opencode-ai/opencode' },
  { id: 'openclaw', name: 'OpenClaw', packageName: OPENCLAW_PACKAGE, repositoryUrl: 'https://github.com/openclaw/openclaw' },
];

function npmPackageMetadataUrl(registry, packageName) {
  return `${String(registry || NPM_REGISTRY_GLOBAL).replace(/\/+$/, '')}/${encodeURIComponent(packageName)}`;
}

function npmPackageLatestUrl(registry, packageName) {
  return `${npmPackageMetadataUrl(registry, packageName)}/latest`;
}

function npmPackageWebUrl(packageName) {
  return `https://www.npmjs.com/package/${encodeURIComponent(packageName)}`;
}

function npmPackageVersionWebUrl(packageName, version) {
  return `${npmPackageWebUrl(packageName)}/v/${encodeURIComponent(version)}`;
}

function normalizeRepositoryUrl(repository) {
  const raw = typeof repository === 'string'
    ? repository
    : (repository && typeof repository === 'object' ? repository.url : '');
  let url = String(raw || '').trim();
  if (!url) return '';
  url = url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://');
  url = url.replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/');
  url = url.replace(/^git@github\.com:/, 'https://github.com/');
  url = url.replace(/\.git(?:#.*)?$/, '');
  return url;
}

function requestJson(url, { timeoutMs = 3000, maxBytes = 5 * 1024 * 1024, redirects = 2, accept = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let hardTimer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      fn(value);
    };
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: {
        Accept: accept,
        'User-Agent': 'EasyAIConfig update checker',
      },
    }, (res) => {
      const statusCode = Number(res.statusCode || 0);
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(statusCode) && location && redirects > 0) {
        res.resume();
        const nextUrl = new URL(location, url).toString();
        requestJson(nextUrl, { timeoutMs, maxBytes, redirects: redirects - 1, accept }).then(
          (value) => settle(resolve, value),
          (error) => settle(reject, error),
        );
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        settle(reject, new Error(`HTTP ${statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          settle(reject, new Error('响应过大'));
          req.destroy();
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          settle(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch (error) {
          settle(reject, error);
        }
      });
    });
    hardTimer = setTimeout(() => req.destroy(new Error('请求超时')), timeoutMs);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (error) => settle(reject, error));
  });
}

function latestNpmMetadataFallback(packageName, latest) {
  const version = String(latest?.version || '').trim();
  return {
    name: latest?.name || packageName,
    description: latest?.description || '',
    'dist-tags': { latest: version },
    versions: version ? { [version]: latest } : {},
    time: {},
    repository: latest?.repository || null,
    homepage: latest?.homepage || '',
    bugs: latest?.bugs || null,
  };
}

function mergeLatestNpmMetadata(packageName, latest, metadata) {
  const latestVersion = String(latest?.version || metadata?.['dist-tags']?.latest || metadata?.version || '').trim();
  const versions = {
    ...(metadata?.versions && typeof metadata.versions === 'object' ? metadata.versions : {}),
  };
  if (latestVersion) {
    versions[latestVersion] = versions[latestVersion]
      ? { ...latest, ...versions[latestVersion], description: versions[latestVersion].description || latest?.description || '' }
      : latest;
  }
  return {
    ...metadata,
    name: metadata?.name || latest?.name || packageName,
    description: metadata?.description || latest?.description || '',
    'dist-tags': {
      ...(metadata?.['dist-tags'] && typeof metadata['dist-tags'] === 'object' ? metadata['dist-tags'] : {}),
      latest: latestVersion,
    },
    versions,
    repository: metadata?.repository || latest?.repository || null,
    homepage: metadata?.homepage || latest?.homepage || '',
    bugs: metadata?.bugs || latest?.bugs || null,
  };
}

async function fetchNpmMetadata(registry, packageName) {
  let latest = null;
  try {
    latest = await requestJson(npmPackageLatestUrl(registry, packageName), {
      timeoutMs: 2500,
      maxBytes: 512 * 1024,
    });
  } catch (latestError) {
    try {
      return await requestJson(npmPackageMetadataUrl(registry, packageName), {
        timeoutMs: 4500,
        maxBytes: 2 * 1024 * 1024,
        accept: 'application/vnd.npm.install-v1+json',
      });
    } catch (metadataError) {
      throw new Error(`${latestError instanceof Error ? latestError.message : String(latestError)}; metadata ${metadataError instanceof Error ? metadataError.message : String(metadataError)}`);
    }
  }

  const fallback = latestNpmMetadataFallback(packageName, latest);
  try {
    const metadata = await requestJson(npmPackageMetadataUrl(registry, packageName), {
      timeoutMs: 4500,
      maxBytes: 2 * 1024 * 1024,
      accept: 'application/vnd.npm.install-v1+json',
    });
    return mergeLatestNpmMetadata(packageName, latest, metadata);
  } catch {
    return fallback;
  }
}

function compactVersionText(value, maxLength = 1000) {
  const text = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function normalizeNpmVersionNote(value, depth = 0) {
  if (value == null || depth > 2) return '';
  if (typeof value === 'string') return compactVersionText(value);
  if (Array.isArray(value)) {
    return compactVersionText(value.map((item) => normalizeNpmVersionNote(item, depth + 1)).filter(Boolean).join('\n'));
  }
  if (typeof value === 'object') {
    const fields = ['releaseNotes', 'release_notes', 'changelog', 'changeLog', 'changes', 'notes', 'body', 'markdown', 'text', 'summary'];
    for (const field of fields) {
      const note = normalizeNpmVersionNote(value[field], depth + 1);
      if (note) return note;
    }
  }
  return '';
}

function pickNpmVersionReleaseNotes(versionMeta) {
  if (!versionMeta || typeof versionMeta !== 'object') return '';
  const fields = ['releaseNotes', 'release_notes', 'changelog', 'changeLog', 'changes', 'notes'];
  for (const field of fields) {
    const note = normalizeNpmVersionNote(versionMeta[field]);
    if (note) return note;
  }
  return '';
}

function normalizeReleaseVersionKey(value) {
  let text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  text = text.replace(/^refs\/tags\//, '');
  text = text.replace(/^rust[-_/]v?/, '');
  text = text.replace(/^release[-_/]v?/, '');
  text = text.replace(/^codex[-_/]v?/, '');
  text = text.replace(/^cli[-_/]v?/, '');
  text = text.replace(/^v(?=\d)/, '');
  return text;
}

function releaseVersionCandidates(release) {
  const candidates = new Set();
  const add = (value) => {
    const key = normalizeReleaseVersionKey(value);
    if (key) candidates.add(key);
  };
  add(release?.tag_name);
  add(release?.name);
  [release?.tag_name, release?.name].forEach((value) => {
    String(value || '').match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*/g)?.forEach(add);
  });
  return Array.from(candidates);
}

function githubReleasesApiUrl(repositoryUrl) {
  const normalized = normalizeRepositoryUrl(repositoryUrl).replace(/[?#].*$/, '').replace(/\/+$/, '');
  const match = normalized.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/i);
  if (!match) return '';
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, '');
  if (!owner || !repo) return '';
  return `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;
}

async function fetchGithubReleaseNotes(repositoryUrl) {
  const url = githubReleasesApiUrl(repositoryUrl);
  if (!url) return new Map();
  try {
    const releases = await requestJson(url, {
      timeoutMs: 15000,
      maxBytes: 30 * 1024 * 1024,
      accept: 'application/vnd.github+json',
    });
    if (!Array.isArray(releases)) return new Map();
    const byVersion = new Map();
    releases.forEach((release) => {
      const body = compactVersionText(release?.body || '', 1200);
      if (!body) return;
      const releaseInfo = {
        releaseNotes: body,
        releaseUrl: String(release?.html_url || '').trim(),
        releaseName: String(release?.name || release?.tag_name || '').trim(),
        releaseTag: String(release?.tag_name || '').trim(),
      };
      releaseVersionCandidates(release).forEach((key) => {
        if (key && !byVersion.has(key)) byVersion.set(key, releaseInfo);
      });
    });
    return byVersion;
  } catch {
    return new Map();
  }
}

function recentNpmVersions(metadata, packageName = '', releaseNotesByVersion = new Map(), limit = 20) {
  const versions = Object.keys(metadata?.versions || {});
  const time = metadata?.time || {};
  versions.sort((left, right) => {
    const leftTime = Date.parse(time[left] || '');
    const rightTime = Date.parse(time[right] || '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return compareCodexVersions(right, left);
  });
  return versions.slice(0, limit).map((version) => ({
    version,
    publishedAt: time[version] || '',
    ...(() => {
      const versionMeta = metadata?.versions?.[version] || {};
      const releaseInfo = releaseNotesByVersion.get(normalizeReleaseVersionKey(version)) || null;
      const releaseNotes = releaseInfo?.releaseNotes || pickNpmVersionReleaseNotes(versionMeta);
      return {
        description: compactVersionText(versionMeta?.description || metadata?.description || '', 360),
        releaseNotes,
        hasReleaseNotes: Boolean(releaseNotes),
        releaseUrl: releaseInfo?.releaseUrl || '',
        releaseName: releaseInfo?.releaseName || '',
        npmUrl: packageName ? npmPackageVersionWebUrl(packageName, version) : '',
      };
    })(),
  }));
}

function normalizeNpmPackageInfo(spec, metadata, source, releaseNotesByVersion = new Map()) {
  const distTags = metadata?.['dist-tags'] || {};
  const latestVersion = String(distTags.latest || metadata?.version || '').trim();
  const latestMeta = latestVersion && metadata?.versions ? metadata.versions[latestVersion] || null : null;
  const repositoryUrl = normalizeRepositoryUrl(latestMeta?.repository || metadata?.repository || spec.repositoryUrl);
  const homepage = String(latestMeta?.homepage || metadata?.homepage || repositoryUrl || npmPackageWebUrl(spec.packageName)).trim();
  const bugsUrl = metadata?.bugs && typeof metadata.bugs === 'object' ? String(metadata.bugs.url || '').trim() : '';
  return {
    toolId: spec.id,
    name: spec.name,
    packageName: spec.packageName,
    latestVersion,
    distTags,
    description: String(latestMeta?.description || metadata?.description || '').trim(),
    license: String(latestMeta?.license || metadata?.license || '').trim(),
    publishedAt: metadata?.time?.[latestVersion] || metadata?.time?.modified || '',
    recentVersions: recentNpmVersions(metadata, spec.packageName, releaseNotesByVersion),
    source,
    packageUrl: npmPackageWebUrl(spec.packageName),
    registryUrl: npmPackageMetadataUrl(source.registry, spec.packageName),
    repositoryUrl,
    homepage,
    bugsUrl,
    tarballUrl: String(latestMeta?.dist?.tarball || '').trim(),
    install: {
      global: `${npmCommand()} install -g ${spec.packageName}@latest`,
      domestic: `${npmCommand()} install -g ${spec.packageName}@latest --registry=${NPM_REGISTRY_CN}`,
    },
    regions: ['global', 'domestic'],
  };
}

function getNpmMetadataLatestVersion(metadata) {
  return String(metadata?.['dist-tags']?.latest || metadata?.version || '').trim();
}

function pickBestNpmMetadataResult(results) {
  const sourceRank = new Map([
    ['global', 0],
    ['domestic', 1],
  ]);
  return results
    .filter((item) => item.ok && item.metadata)
    .sort((left, right) => {
      const versionOrder = compareCodexVersions(
        getNpmMetadataLatestVersion(right.metadata),
        getNpmMetadataLatestVersion(left.metadata),
      );
      if (versionOrder !== 0) return versionOrder;
      return (sourceRank.get(left.source.id) ?? 99) - (sourceRank.get(right.source.id) ?? 99);
    })[0] || null;
}

async function fetchNpmPackageInfo(spec) {
  const sources = [
    { id: 'global', label: '海外', registry: NPM_REGISTRY_GLOBAL },
    { id: 'domestic', label: '国内', registry: NPM_REGISTRY_CN },
  ];
  const checks = sources.map(async (source) => {
    try {
      const metadata = await fetchNpmMetadata(source.registry, spec.packageName);
      return {
        ok: true,
        source,
        metadata,
      };
    } catch (error) {
      return {
        ok: false,
        source,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const results = await Promise.all(checks);
  const attempts = results.map((item) => ({
    id: item.source.id,
    label: item.source.label,
    ok: item.ok,
    ...(item.ok ? { version: getNpmMetadataLatestVersion(item.metadata) } : { error: item.error || 'failed' }),
  }));
  const success = pickBestNpmMetadataResult(results);
  if (success) {
    const repositoryUrl = normalizeRepositoryUrl(
      success.metadata?.versions?.[getNpmMetadataLatestVersion(success.metadata)]?.repository
      || success.metadata?.repository
      || spec.repositoryUrl,
    );
    const releaseNotesByVersion = await fetchGithubReleaseNotes(repositoryUrl);
    return {
      ...normalizeNpmPackageInfo(spec, success.metadata, success.source, releaseNotesByVersion),
      attempts,
    };
  }
  const message = attempts.map((item) => `${item.label || item.id}: ${item.error || 'failed'}`).join('; ') || '版本源不可达';
  return {
    toolId: spec.id,
    name: spec.name,
    packageName: spec.packageName,
    latestVersion: '',
    recentVersions: [],
    source: null,
    attempts,
    packageUrl: npmPackageWebUrl(spec.packageName),
    registryUrl: '',
    install: {
      global: `${npmCommand()} install -g ${spec.packageName}@latest`,
      domestic: `${npmCommand()} install -g ${spec.packageName}@latest --registry=${NPM_REGISTRY_CN}`,
    },
    regions: ['global', 'domestic'],
    error: message,
  };
}

export async function getToolUpdatesInfo() {
  const entries = await Promise.all(TOOL_UPDATE_SPECS.map(fetchNpmPackageInfo));
  return {
    generatedAt: new Date().toISOString(),
    intervalMs: 12 * 60 * 60 * 1000,
    sources: [
      { id: 'global', label: '海外', registry: NPM_REGISTRY_GLOBAL },
      { id: 'domestic', label: '国内', registry: NPM_REGISTRY_CN },
    ],
    items: Object.fromEntries(entries.map((item) => [item.toolId, item])),
  };
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
  const byProviderModel = new Map();
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

    if (!byProvider.has(providerKey)) byProvider.set(providerKey, { provider: providerKey, totals: createCodexUsageTotals(), events: 0, requests: null });
    byProvider.get(providerKey).totals.total += totalTokens;
    byProvider.get(providerKey).events += 1;

    if (!byModel.has(modelKey)) byModel.set(modelKey, { model: modelKey, totals: createCodexUsageTotals(), events: 0, requests: null });
    byModel.get(modelKey).totals.total += totalTokens;
    byModel.get(modelKey).events += 1;

    const providerModelKey = `${providerKey}\u0000${modelKey}`;
    if (!byProviderModel.has(providerModelKey)) byProviderModel.set(providerModelKey, { provider: providerKey, model: modelKey, totals: createCodexUsageTotals(), events: 0, requests: null });
    byProviderModel.get(providerModelKey).totals.total += totalTokens;
    byProviderModel.get(providerModelKey).events += 1;

    sessions.push({
      sessionId: String(row?.id || '').trim(),
      provider: providerKey,
      model: modelKey,
      cwd: String(row?.cwd || '').trim(),
      updatedAt,
      requests: null,
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
    providerModels: [...byProviderModel.values()].sort((a, b) => b.totals.total - a.totals.total),
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
      totals: createCodexUsageTotals(), daily: [], providers: [], models: [], providerModels: [], sessions: [],
    };
  }

  // ── Path 2: Scan JSONL files → build metrics → save to cache ──
  const now = Date.now();
  const windowStartMs = now - dayCount * 24 * 60 * 60 * 1000;
  const totals = createCodexUsageTotals();
  const byDay = new Map();
  const byProvider = new Map();
  const byModel = new Map();
  const byProviderModel = new Map();
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
          requests: 0,
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

      if (!byProvider.has(providerKey)) byProvider.set(providerKey, { provider: providerKey, totals: createCodexUsageTotals(), events: 0, requests: 0 });
      addCodexUsageTotals(byProvider.get(providerKey).totals, usage);
      byProvider.get(providerKey).events += 1;
      byProvider.get(providerKey).requests += 1;

      const modelKey = currentModel || payload.info?.model || 'unknown';
      if (!byModel.has(modelKey)) byModel.set(modelKey, { model: modelKey, totals: createCodexUsageTotals(), events: 0, requests: 0 });
      addCodexUsageTotals(byModel.get(modelKey).totals, usage);
      byModel.get(modelKey).events += 1;
      byModel.get(modelKey).requests += 1;

      const providerModelKey = `${providerKey}\u0000${modelKey}`;
      if (!byProviderModel.has(providerModelKey)) byProviderModel.set(providerModelKey, { provider: providerKey, model: modelKey, totals: createCodexUsageTotals(), events: 0, requests: 0 });
      addCodexUsageTotals(byProviderModel.get(providerModelKey).totals, usage);
      byProviderModel.get(providerModelKey).events += 1;
      byProviderModel.get(providerModelKey).requests += 1;

      addCodexUsageTotals(item.totals, usage);
      item.requests += 1;
    }
  }

  const daily = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, sum]) => ({ date, ...sum }));
  const providers = [...byProvider.values()].sort((a, b) => b.totals.total - a.totals.total);
  const models = [...byModel.values()].sort((a, b) => b.totals.total - a.totals.total);
  const providerModels = [...byProviderModel.values()].sort((a, b) => b.totals.total - a.totals.total);
  const sessions = [...bySession.values()].filter((item) => item.totals.total > 0).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12).map((item) => ({
    sessionId: item.sessionId,
    provider: item.provider,
    model: item.model,
    cwd: item.cwd,
    updatedAt: item.updatedAt,
    requests: item.requests,
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
    providerModels,
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

// ─── Provider extras (sidecar) ─────────────────────────────────────────
// 给 provider 加 EasyAIConfig-only 的元数据（per-provider proxy 等）。
// 不写进用户的 codex/config.toml，避免污染原生配置文件。
//
// 存储: ~/.codex-config-ui/provider-extras.json
//   { "providers": { "<providerKey>": { proxyUrl, notes } } }
//
// Tauri Rust 端读同一份文件即可（后续 backfill src-tauri/src/provider.rs）
function providerExtrasPath() {
  return path.join(appHome(), 'provider-extras.json');
}

async function readProviderExtrasFile() {
  const raw = await readText(providerExtrasPath());
  if (!raw.trim()) return { providers: {} };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { providers: {} }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { providers: {} };
  if (!parsed.providers || typeof parsed.providers !== 'object') parsed.providers = {};
  return parsed;
}

export async function getProviderExtras(providerKey = '') {
  const key = String(providerKey || '').trim();
  if (!key) return null;
  const all = await readProviderExtrasFile();
  return all.providers[key] || null;
}

export async function setProviderExtras(providerKey = '', patch = {}) {
  const key = String(providerKey || '').trim();
  if (!key) throw new Error('providerKey is required');
  const all = await readProviderExtrasFile();
  const existing = all.providers[key] || {};
  const next = { ...existing };

  // patch 字段白名单 — proxyUrl / notes 等用户可写的元数据
  // null 删 key，undefined 不动 key（同 applyPatch 语义）
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) { delete next[k]; continue; }
    if (v === undefined) continue;
    // proxyUrl: 空字符串 = 删除
    if (k === 'proxyUrl') {
      const trimmed = String(v).trim();
      if (!trimmed) { delete next.proxyUrl; continue; }
      next.proxyUrl = trimmed;
      continue;
    }
    next[k] = v;
  }

  if (Object.keys(next).length === 0) {
    delete all.providers[key];
  } else {
    all.providers[key] = next;
  }
  await writeJsonFile(providerExtrasPath(), all);
  return next;
}

// 给 spawn 出去的子进程注入 per-provider 代理 env (HTTPS_PROXY / HTTP_PROXY)
// 用法：spawn(cmd, args, { env: { ...process.env, ...await buildProviderEnv(providerKey) } })
// 或在 launchTerminalCommand 里把它前置到 shell 命令字符串。
export async function buildProviderProxyEnv(providerKey = '') {
  const extras = await getProviderExtras(providerKey);
  if (!extras?.proxyUrl) return {};
  return {
    HTTPS_PROXY: extras.proxyUrl,
    HTTP_PROXY: extras.proxyUrl,
    https_proxy: extras.proxyUrl,
    http_proxy: extras.proxyUrl,
  };
}

// ─── Provider 健康快照（sidecar） ────────────────────────────────────
// 每次 testSavedProvider / detectProvider 完成后写入。前端启动时 GET 全量，
// 用来在列表里直接画红绿灯，不用等用户点检测。
//
// 存储: ~/.codex-config-ui/provider-health.json
//   { "providers": { "<providerKey>": ProbeSnapshot } }
//
// ProbeSnapshot 字段：
//   ok          — boolean
//   stage       — ok | dns | tls | connect | timeout | auth | notfound | http | body | unknown
//   hint        — string | null（失败时的人话提示）
//   errorMessage— string | null
//   statusCode  — number | null
//   latencyMs   — number | null
//   modelCount  — number | null  （成功时记录探到几个 model）
//   baseUrl     — string | null
//   probedAt    — epoch ms
function providerHealthPath() {
  return path.join(appHome(), 'provider-health.json');
}

async function readProviderHealthFile() {
  const raw = await readText(providerHealthPath());
  if (!raw.trim()) return { providers: {} };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { providers: {} }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { providers: {} };
  if (!parsed.providers || typeof parsed.providers !== 'object') parsed.providers = {};
  return parsed;
}

export async function getAllProviderHealth() {
  const all = await readProviderHealthFile();
  return all.providers || {};
}

export async function getProviderHealth(providerKey = '') {
  const key = String(providerKey || '').trim();
  if (!key) return null;
  const all = await readProviderHealthFile();
  return all.providers[key] || null;
}

export async function recordProviderHealth(providerKey = '', snapshot = {}) {
  const key = String(providerKey || '').trim();
  if (!key) return null;
  const all = await readProviderHealthFile();
  const next = {
    ok: Boolean(snapshot.ok),
    stage: String(snapshot.stage || (snapshot.ok ? 'ok' : 'unknown')),
    hint: snapshot.hint || null,
    errorMessage: snapshot.errorMessage || null,
    statusCode: snapshot.statusCode ?? null,
    latencyMs: snapshot.latencyMs ?? null,
    modelCount: snapshot.modelCount ?? null,
    baseUrl: snapshot.baseUrl || null,
    probedAt: Date.now(),
  };
  all.providers[key] = next;
  try { await writeJsonFile(providerHealthPath(), all); } catch (_) { /* 写盘失败不影响主流程 */ }
  return next;
}

export async function clearProviderHealth(providerKey = '') {
  const key = String(providerKey || '').trim();
  if (!key) return;
  const all = await readProviderHealthFile();
  if (all.providers[key]) {
    delete all.providers[key];
    try { await writeJsonFile(providerHealthPath(), all); } catch (_) { /* swallow */ }
  }
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

function findCodexBinary(options = {}) {
  const detected = findToolBinary('codex', options);
  return {
    ...detected,
    path: detected.path || (options.passive ? null : commandExists('codex')),
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
      authPath: path.join(normalizedCodexHome, 'auth.json'),
    };
  }

  return {
    scope: 'global',
    rootPath: normalizedCodexHome,
    configPath: path.join(normalizedCodexHome, 'config.toml'),
    envPath: path.join(normalizedCodexHome, '.env'),
    authPath: path.join(normalizedCodexHome, 'auth.json'),
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
  // 全部使用 0600 写入 —— 此函数所有调用点都是 .env / config.toml /
  // auth.json / settings.json 等可能含 API key 或 OAuth token 的配置，
  // 默认 umask (0644) 在多用户机上会被其他用户 `cat` 读走
  await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
  // fs.writeFile 的 mode 只对新建文件生效；对已存在文件不改权限，因此再 chmod 一次
  if (process.platform !== 'win32') {
    try { await fs.chmod(filePath, 0o600); } catch (_) {}
  }
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

// Non-destructive merge：切 provider / 改配置时只动 patch 提到的 key，
// patch 没提的 key 原样保留 (plugins / hooks / mcpServers / statusLine /
// skills / customCommands 等用户自定义字段全部不动)。
//
// 实现原则：parse → patch in place → stringify 全对象。
// 退化护栏: tests/non-destructive-merge.test.js
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

const PROJECT_IGNORED_CODEX_CONFIG_KEYS = [
  'openai_base_url',
  'chatgpt_base_url',
  'apps_mcp_product_sku',
  'model_provider',
  'model_providers',
  'notify',
  'profile',
  'profiles',
  'experimental_realtime_ws_base_url',
  'otel',
];

function normalizeSettingsPatchForScope(patch, scope = 'global') {
  const normalized = normalizeSettingsPatch(patch);
  if (scope !== 'project') return normalized;
  for (const key of PROJECT_IGNORED_CODEX_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      if (normalized[key] === null) continue;
      delete normalized[key];
    }
  }
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

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Base URL 不合法：${raw}`);
  }

  // 只做最小处理：去掉多余尾部斜杠，路径段原样保留。
  // 不替用户做任何"智能补全"——有的网关就是不要 /v1，自动加上会 404。
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

function parseJsonSafe(raw) {
  if (!String(raw || '').trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function readAuthJson(codexHome) {
  const raw = await readText(path.join(codexHome, 'auth.json'));
  return parseJsonSafe(raw);
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
    const incoming = value.trim();
    const existing = String(env[key] || '').trim();
    // 旧版本：env 里已有值就直接 skip 掉，导致用户在 Codex CLI 重新 login
    // 拿到的新 OPENAI_API_KEY 永远写不进 .env，UI 一直看老 key。
    // 现在：incoming 非空且与现有值不同时覆盖，仍跳过同值（避免空写）。
    if (!incoming || incoming === existing) {
      continue;
    }
    env[key] = incoming;
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

  // 第三方 OpenAI 兼容网关（NewAPI / oneapi / packycode 等）默认就用
  // `OPENAI_API_KEY` 作为环境变量名。旧逻辑无条件给它 -60，会反复出现
  // ".env 里明明有 key UI 却显示未配置"的问题。现在不再特殊处罚——
  //   1. provider.envKey 显式存在时，本身有 +1000 分，OPENAI_API_KEY 也赢不过；
  //   2. 真正存在其他名字更贴近的 key（ANTHROPIC_API_KEY 等）时，自然胜出；
  //   3. 否则 OPENAI_API_KEY 就是合理的回退。
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

  const [configContent, envContent, authContent] = await Promise.all([
    readText(paths.configPath),
    readText(paths.envPath),
    readText(paths.authPath),
  ]);
  const authJson = parseJsonSafe(authContent);

  return {
    normalizedCodexHome,
    paths,
    configContent,
    envContent,
    authContent,
    authJson,
    config: parseToml(configContent),
    env: parseEnv(envContent),
  };
}

async function createBackup({ configPath, envPath, authPath, scope }) {
  // 备份根目录 0700、备份子目录 0700、备份文件 0600 ——
  // .env.bak / auth.json.bak 含 API key / OAuth token，
  // config.toml.bak 可能含自定义 env / 路径
  const root = backupsRoot();
  await ensureDir(root);
  if (process.platform !== 'win32') {
    try { await fs.chmod(root, 0o700); } catch (_) {}
  }
  const targetDir = path.join(root, `${timestamp()}-${scope}`);
  await ensureDir(targetDir);
  if (process.platform !== 'win32') {
    try { await fs.chmod(targetDir, 0o700); } catch (_) {}
  }
  await writeText(path.join(targetDir, 'config.toml.bak'), await readText(configPath));
  await writeText(path.join(targetDir, '.env.bak'), await readText(envPath));
  if (authPath && await pathExists(authPath)) {
    await writeText(path.join(targetDir, 'auth.json.bak'), await readText(authPath));
  }
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
chcp 65001>nul
cd /d ${quoteWindowsCmdArg(normalizeWindowsCmdPath(cwd))}
${commandText}
`;
  writeFileSync(launcherPath, script, 'utf8');
  return launcherPath;
}

function writeWindowsPowerShellLauncher(cwd, commandText, cmdLauncherPath = '') {
  const launcherDir = path.join(os.tmpdir(), 'easy-ai-config', 'launchers');
  mkdirSync(launcherDir, { recursive: true });
  const launcherPath = path.join(launcherDir, `launch-${crypto.randomUUID()}.ps1`);
  const escapedCwd = String(normalizeWindowsCmdPath(cwd)).replace(/'/g, "''");
  const cmdLauncher = cmdLauncherPath || writeWindowsTerminalLauncher(cwd, commandText);
  const escapedCmdLauncher = String(normalizeWindowsCmdPath(cmdLauncher)).replace(/'/g, "''");
  const script = [
    `$ErrorActionPreference = 'Continue'`,
    `Set-Location -LiteralPath '${escapedCwd}'`,
    `& cmd.exe /d /k '${escapedCmdLauncher}'`,
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

function findDarwinApplication(appNames = []) {
  if (process.platform !== 'darwin') return null;
  const roots = [
    '/Applications',
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    path.join(os.homedir(), 'Applications'),
  ];
  for (const appName of appNames) {
    const cleanName = String(appName || '').replace(/\.app$/i, '').trim();
    if (!cleanName) continue;
    for (const root of roots) {
      const appPath = path.join(root, `${cleanName}.app`);
      if (existsSync(appPath)) return { appName: cleanName, appPath };
    }
  }
  return null;
}

function findDarwinCommandOrBundle(commandNames = [], appInfo = null, executableNames = commandNames) {
  for (const command of commandNames) {
    const found = commandExists(command);
    if (found) return found;
  }
  if (appInfo?.appPath) {
    for (const executable of executableNames) {
      const candidate = path.join(appInfo.appPath, 'Contents', 'MacOS', executable);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

function makeDarwinAppProfile({ id, label, appNames, launchMode = 'type-command', command = '' }) {
  const appInfo = findDarwinApplication(appNames);
  return {
    id,
    label,
    available: Boolean(appInfo?.appPath),
    command: command || appInfo?.appName || '',
    appName: appInfo?.appName || appNames?.[0] || '',
    appPath: appInfo?.appPath || '',
    launchMode,
  };
}

function listDarwinTerminalProfiles() {
  if (process.platform !== 'darwin') return [];

  const terminalApp = findDarwinApplication(['Terminal']);
  const itermApp = findDarwinApplication(['iTerm', 'iTerm2']);
  const weztermApp = findDarwinApplication(['WezTerm']);
  const ghosttyApp = findDarwinApplication(['Ghostty']);
  const alacrittyApp = findDarwinApplication(['Alacritty']);
  const kittyApp = findDarwinApplication(['kitty']);
  const wezterm = findDarwinCommandOrBundle(['wezterm'], weztermApp, ['wezterm']);
  const ghostty = findDarwinCommandOrBundle(['ghostty'], ghosttyApp, ['ghostty']);
  const alacritty = findDarwinCommandOrBundle(['alacritty'], alacrittyApp, ['alacritty']);
  const kitty = findDarwinCommandOrBundle(['kitty'], kittyApp, ['kitty']);

  const profiles = [
    { id: 'auto', label: '自动选择外部终端', available: true, command: '' },
    {
      id: 'terminal',
      label: 'Terminal.app',
      available: Boolean(terminalApp?.appPath),
      command: 'Terminal',
      appName: 'Terminal',
      appPath: terminalApp?.appPath || '',
      launchMode: 'applescript',
    },
    {
      id: 'iterm',
      label: itermApp?.appName === 'iTerm2' ? 'iTerm2' : 'iTerm',
      available: Boolean(itermApp?.appPath),
      command: 'iTerm',
      appName: itermApp?.appName || 'iTerm',
      appPath: itermApp?.appPath || '',
      launchMode: 'applescript',
    },
    makeDarwinAppProfile({ id: 'termius', label: 'Termius', appNames: ['Termius'] }),
    makeDarwinAppProfile({ id: 'terminus', label: 'Terminus', appNames: ['Terminus'] }),
    makeDarwinAppProfile({ id: 'tabby', label: 'Tabby / Terminus', appNames: ['Tabby'] }),
    makeDarwinAppProfile({ id: 'warp', label: 'Warp', appNames: ['Warp'] }),
    makeDarwinAppProfile({ id: 'hyper', label: 'Hyper', appNames: ['Hyper'] }),
    { id: 'wezterm', label: 'WezTerm', available: Boolean(wezterm), command: wezterm || '', appName: weztermApp?.appName || 'WezTerm', appPath: weztermApp?.appPath || '', launchMode: 'cli' },
    { id: 'ghostty', label: 'Ghostty', available: Boolean(ghostty), command: ghostty || '', appName: ghosttyApp?.appName || 'Ghostty', appPath: ghosttyApp?.appPath || '', launchMode: 'cli' },
    { id: 'alacritty', label: 'Alacritty', available: Boolean(alacritty), command: alacritty || '', appName: alacrittyApp?.appName || 'Alacritty', appPath: alacrittyApp?.appPath || '', launchMode: 'cli' },
    { id: 'kitty', label: 'kitty', available: Boolean(kitty), command: kitty || '', appName: kittyApp?.appName || 'kitty', appPath: kittyApp?.appPath || '', launchMode: 'cli' },
  ];

  return profiles
    .filter((profile) => profile.id === 'auto' || profile.available)
    .map((profile) => ({
      id: profile.id,
      label: profile.label,
      command: profile.command,
      available: profile.available,
      appName: profile.appName || '',
      appPath: profile.appPath || '',
      launchMode: profile.launchMode || '',
    }));
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
    || profiles.find((profile) => profile.id === 'alacritty')
    || profiles.find((profile) => profile.id === 'kitty')
    || profiles.find((profile) => profile.id === 'termius')
    || profiles.find((profile) => profile.id === 'terminus')
    || profiles.find((profile) => profile.id === 'tabby')
    || profiles.find((profile) => profile.id === 'warp')
    || profiles.find((profile) => profile.id === 'hyper')
    || profiles.find((profile) => profile.id !== 'auto')
    || { id: 'terminal', label: 'Terminal.app', command: 'Terminal', available: true };
}

function launchDarwinAppAndTypeCommand(profile, shellCommand, toolLabel) {
  const appName = String(profile.appName || profile.command || profile.label || '').replace(/\.app$/i, '').trim();
  if (!appName) throw new Error(`当前终端 ${profile.label} 缺少 App 名称`);
  const opened = spawnSync('open', ['-a', appName], { encoding: 'utf8' });
  if (opened.status !== 0) {
    throw new Error((opened.stderr || opened.stdout || `Failed to open ${appName}`).trim());
  }
  const scriptLines = [
    `tell application "${escapeAppleScriptText(appName)}" to activate`,
    'delay 0.45',
  ];
  if (appName.toLowerCase() === 'termius') {
    scriptLines.push(
      'tell application "System Events"',
      'keystroke "l" using command down',
      'end tell',
      'delay 0.55',
    );
  }
  scriptLines.push(
    `set the clipboard to "${escapeAppleScriptText(shellCommand)}"`,
    'tell application "System Events"',
    'keystroke "v" using command down',
    'key code 36',
    'end tell',
  );
  const appleScript = scriptLines.join('\n');
  const typed = spawnSync('osascript', ['-e', appleScript], { encoding: 'utf8' });
  if (typed.status === 0) return `${toolLabel} 已在 ${profile.label} 中启动`;
  const message = (typed.stderr || typed.stdout || '').trim();
  throw new Error(message
    ? `${profile.label} 自动输入失败：${message}`
    : `${toolLabel} 已打开 ${profile.label}，但自动输入失败。请在 macOS 系统设置里允许本应用控制辅助功能后重试。`);
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
  if (profile.launchMode === 'type-command' || ['termius', 'terminus', 'tabby', 'warp', 'hyper'].includes(profile.id)) {
    return launchDarwinAppAndTypeCommand(profile, shellCommand, toolLabel);
  }
  const [command, args] = terminalMap[profile.id] || [];
  if (!command) {
    throw new Error(`当前终端 ${profile.label} 暂不支持自动启动命令`);
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return `${toolLabel} 已在 ${profile.label} 中启动`;
}

export function listWindowsTerminalProfiles({ passive = false } = {}) {
  if (process.platform !== 'win32') return [];

  const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles?.trim() || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)']?.trim() || 'C:\\Program Files (x86)';
  const systemRoot = process.env.SystemRoot?.trim() || 'C:\\Windows';
  const windowsTerminalCommand = passive
    ? firstWindowsExistingPath([path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe')])
    : firstWindowsCommand(['wt.exe', 'wt']) || firstWindowsExistingPath([path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe')]);
  const powerShell7Command = passive
    ? firstWindowsExistingPath([
      path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      path.join(programFilesX86, 'PowerShell', '7', 'pwsh.exe'),
      path.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
      path.join(programFilesX86, 'PowerShell', '7-preview', 'pwsh.exe'),
    ])
    : firstWindowsCommand(['pwsh.exe', 'pwsh']);
  const windowsPowerShellCommand = passive
    ? firstWindowsExistingPath([path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')])
    : firstWindowsCommand(['powershell.exe', 'powershell']);
  const cmdCommand = passive
    ? firstWindowsExistingPath([path.join(systemRoot, 'System32', 'cmd.exe')]) || 'cmd.exe'
    : firstWindowsCommand(['cmd.exe', 'cmd']) || 'cmd.exe';
  const weztermCommand = passive
    ? firstWindowsExistingPath([
      path.join(localAppData, 'Programs', 'WezTerm', 'wezterm-gui.exe'),
      path.join(programFiles, 'WezTerm', 'wezterm-gui.exe'),
      path.join(programFilesX86, 'WezTerm', 'wezterm-gui.exe'),
    ])
    : firstWindowsCommand(['wezterm.exe', 'wezterm']) || firstWindowsExistingPath([
      path.join(localAppData, 'Programs', 'WezTerm', 'wezterm-gui.exe'),
      path.join(programFiles, 'WezTerm', 'wezterm-gui.exe'),
      path.join(programFilesX86, 'WezTerm', 'wezterm-gui.exe'),
    ]);

  const profiles = [
    { id: 'auto', label: '自动选择外部终端', command: '', available: true },
    { id: 'windows-terminal', label: 'Windows Terminal', command: windowsTerminalCommand, available: false },
    { id: 'powershell-7', label: 'PowerShell 7', command: powerShell7Command, available: false },
    { id: 'powershell', label: 'Windows PowerShell', command: windowsPowerShellCommand, available: false },
    { id: 'cmd', label: '命令提示符 CMD', command: cmdCommand, available: true },
    { id: 'wezterm', label: 'WezTerm', command: weztermCommand, available: false },
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
    const psLauncherPath = writeWindowsPowerShellLauncher(cwd, commandText, launcherCmdPath);
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

function listLinuxTerminalProfiles() {
  if (process.platform !== 'linux') return [];
  const specs = [
    { id: 'x-terminal-emulator', label: '系统默认终端', command: 'x-terminal-emulator' },
    { id: 'gnome-terminal', label: 'GNOME Terminal', command: 'gnome-terminal' },
    { id: 'konsole', label: 'Konsole', command: 'konsole' },
    { id: 'wezterm', label: 'WezTerm', command: 'wezterm' },
    { id: 'alacritty', label: 'Alacritty', command: 'alacritty' },
    { id: 'kitty', label: 'kitty', command: 'kitty' },
    { id: 'tilix', label: 'Tilix', command: 'tilix' },
    { id: 'xfce4-terminal', label: 'Xfce Terminal', command: 'xfce4-terminal' },
    { id: 'lxterminal', label: 'LXTerminal', command: 'lxterminal' },
    { id: 'xterm', label: 'xterm', command: 'xterm' },
  ];
  const profiles = specs
    .map((profile) => ({ ...profile, command: commandExists(profile.command) || '' }))
    .filter((profile) => Boolean(profile.command));
  return [
    { id: 'auto', label: '自动选择外部终端', command: '', available: true },
    ...profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      command: profile.command,
      available: true,
      launchMode: 'cli',
    })),
  ];
}

function resolveLinuxTerminalProfile(profileId = 'auto') {
  const profiles = listLinuxTerminalProfiles();
  const requested = profiles.find((profile) => profile.id === String(profileId || 'auto').trim());
  if (requested && requested.id !== 'auto') return requested;
  return profiles.find((profile) => profile.id === 'x-terminal-emulator')
    || profiles.find((profile) => profile.id === 'gnome-terminal')
    || profiles.find((profile) => profile.id === 'konsole')
    || profiles.find((profile) => profile.id === 'wezterm')
    || profiles.find((profile) => profile.id === 'alacritty')
    || profiles.find((profile) => profile.id === 'kitty')
    || profiles.find((profile) => profile.id !== 'auto')
    || null;
}

function linuxTerminalArgs(profileId, cwd, shellCommand) {
  const cwdText = String(cwd || process.cwd());
  switch (profileId) {
    case 'gnome-terminal':
      return ['--', 'bash', '-lc', shellCommand];
    case 'wezterm':
      return ['start', '--cwd', cwdText, '--', 'bash', '-lc', shellCommand];
    case 'alacritty':
      return ['--working-directory', cwdText, '-e', 'bash', '-lc', shellCommand];
    case 'kitty':
      return ['--directory', cwdText, 'bash', '-lc', shellCommand];
    case 'tilix':
      return ['--working-directory', cwdText, '-e', 'bash', '-lc', shellCommand];
    case 'xfce4-terminal':
      return ['--working-directory', cwdText, '-e', `bash -lc ${quotePosixShellArg(shellCommand)}`];
    case 'lxterminal':
      return ['--working-directory', cwdText, '-e', 'bash', '-lc', shellCommand];
    case 'konsole':
    case 'x-terminal-emulator':
    case 'xterm':
    default:
      return ['-e', 'bash', '-lc', shellCommand];
  }
}

function launchLinuxTerminal(cwd, commandText, { toolLabel = 'Codex', terminalProfile = 'auto' } = {}) {
  const profile = resolveLinuxTerminalProfile(terminalProfile);
  if (!profile?.command) {
    throw new Error(`没有找到可用终端，请先手动运行 ${commandText}`);
  }
  const normalizedCwd = String(cwd || process.cwd());
  const shellCommand = `cd ${quotePosixShellArg(normalizedCwd)} && ${commandText}`;
  const child = spawn(profile.command, linuxTerminalArgs(profile.id, normalizedCwd, shellCommand), {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return `${toolLabel} 已在 ${profile.label} 中启动`;
}

// Build a POSIX shell prefix that exports given env vars before running cmd.
// 用于把 per-provider 的 HTTPS_PROXY 注入到 AppleScript / bash -lc 的新终端会话。
// 输出形如: `export HTTPS_PROXY='http://proxy:8080' HTTP_PROXY='http://proxy:8080'; `
function buildPosixEnvPrefix(extraEnv = {}) {
  const entries = Object.entries(extraEnv || {}).filter(([_, v]) => v != null && v !== '');
  if (!entries.length) return '';
  const exports = entries
    .map(([k, v]) => `${k}=${quotePosixShellArg(String(v))}`)
    .join(' ');
  return `export ${exports}; `;
}

function launchTerminalCommand(cwd, { binaryPath, binaryName = 'codex', toolLabel = 'Codex', commandText = '', terminalProfile = 'auto', extraEnv = {} } = {}) {
  // POSIX 平台必须把 binaryPath 用 quotePosixShellArg 包裹，否则路径里
  // 含空格 / nvm 多版本目录会被 shell 拆分（典型："/Users/张三/.nvm/.../codex"）。
  // 如果调用方已经传了 commandText（资深路径，自己拼接好的命令字符串），
  // 就信任它原样使用。
  const envPrefix = buildPosixEnvPrefix(extraEnv);
  const rawBin = commandText
    || (binaryPath ? quotePosixShellArg(String(binaryPath)) : binaryName);
  const posixBin = envPrefix ? `${envPrefix}${rawBin}` : rawBin;
  const windowsBin = commandText || (binaryPath ? buildWindowsBinaryCommand(binaryPath, [], binaryName) : binaryName);

  if (process.platform === 'darwin') {
    return launchDarwinTerminal(cwd, posixBin, { toolLabel, terminalProfile });
  }

  if (process.platform === 'win32') {
    // Windows: 走 cmd /c 通过 set 命令注入 env
    const winEnvSet = Object.entries(extraEnv || {})
      .filter(([_, v]) => v != null && v !== '')
      .map(([k, v]) => `set ${k}=${String(v).replace(/[&|<>^"]/g, '')} && `)
      .join('');
    const winCmd = winEnvSet ? `${winEnvSet}${windowsBin}` : windowsBin;
    return launchWindowsTerminal(cwd, winCmd, { toolLabel, terminalProfile });
  }

  if (process.platform === 'linux') {
    return launchLinuxTerminal(cwd, posixBin, { toolLabel, terminalProfile });
  }

  const quotedCwd = quotePosixShellArg(String(cwd || process.cwd()));
  const terminals = [
    ['x-terminal-emulator', ['-e', `bash -lc 'cd ${quotedCwd} && ${posixBin}'`]],
    ['gnome-terminal', ['--', 'bash', '-lc', `cd ${quotedCwd} && ${posixBin}`]],
    ['konsole', ['-e', 'bash', '-lc', `cd ${quotedCwd} && ${posixBin}`]],
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
  if (process.platform === 'win32') {
    return {
      supported: false,
      installed: false,
      loaded: false,
      running: false,
      status: 'unsupported',
      label: '不支持',
      detail: 'Windows 当前不支持 OpenClaw daemon 状态检测',
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
  const codexBinary = findCodexBinary({ passive: true });


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
  const { normalizedCodexHome, paths, configContent, envContent, authContent, authJson, config, env } = await readScopeState({
    scope,
    projectPath,
    codexHome,
  });
  const providers = summarizeProviders(config, env, authJson);
  const implicitProvider = providers.length ? null : buildImplicitCodexProvider(env, authJson);
  if (implicitProvider) providers.push(implicitProvider);
  const activeProvider = providers.find((provider) => provider.isActive) || null;
  const login = summarizeCodexLogin(authJson);
  const codexBinary = findCodexBinary({ passive: true });


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
    authJsonRaw: authContent,
    config,
    providers,
    activeProvider,
    login,
    summary: {
      model: config.model || '',
      modelProvider: config.model_provider || '',
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
        ? listWindowsTerminalProfiles({ passive: true })
        : process.platform === 'darwin'
          ? listDarwinTerminalProfiles()
          : process.platform === 'linux'
            ? listLinuxTerminalProfiles()
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
    wireApi: base.wireApi,
    hasApiKey: true,
    maskedApiKey: maskSecretValue(secret.value),
    apiKey: secret.value,
    keySource: secret.source,
    resolvedKeyName: secret.key,
  };
}

function resolveClaudeCodeProviderSecret(settings = {}, providerKey = '') {
  const safeKey = String(providerKey || '').trim();
  if (!safeKey) {
    throw new Error('providerKey is required');
  }
  const settingsEnv = settings?.env && typeof settings.env === 'object' ? settings.env : {};
  const easy = settings?.easyaiconfig && typeof settings.easyaiconfig === 'object' ? settings.easyaiconfig : {};
  const providers = easy.providers && typeof easy.providers === 'object' ? easy.providers : {};
  const activeProvider = String(easy.activeProvider || '').trim();
  const configured = providers[safeKey] && typeof providers[safeKey] === 'object' ? providers[safeKey] : null;
  const officialKey = !String(settingsEnv.ANTHROPIC_BASE_URL || '').trim() || /anthropic\.com/i.test(String(settingsEnv.ANTHROPIC_BASE_URL || ''));
  const envKey = activeProvider || (officialKey ? 'official' : slugifyProviderKey(inferProviderSeed(String(settingsEnv.ANTHROPIC_BASE_URL || ''))));

  if (!configured && safeKey !== envKey && !(safeKey === 'official' && officialKey)) {
    throw new Error(`未找到 Claude Code Provider：${safeKey}`);
  }

  const useEnvFallback = !configured || safeKey === activeProvider || safeKey === envKey;
  const baseUrl = String(
    configured?.baseUrl
    || (useEnvFallback ? settingsEnv.ANTHROPIC_BASE_URL : '')
    || process.env.ANTHROPIC_BASE_URL
    || 'https://api.anthropic.com'
  ).trim();
  const authToken = String(
    configured?.authToken
    || (useEnvFallback ? settingsEnv.ANTHROPIC_AUTH_TOKEN : '')
    || process.env.ANTHROPIC_AUTH_TOKEN
    || ''
  ).trim();
  const apiKey = String(
    configured?.apiKey
    || (useEnvFallback ? settingsEnv.ANTHROPIC_API_KEY : '')
    || process.env.ANTHROPIC_API_KEY
    || ''
  ).trim();
  const secret = authToken || apiKey;
  if (!secret) {
    throw new Error(`Claude Code Provider ${configured?.name || safeKey} 未找到 API Key / Auth Token`);
  }

  return {
    providerKey: safeKey,
    providerName: String(configured?.name || inferProviderLabel(baseUrl, safeKey) || safeKey),
    baseUrl,
    model: String(configured?.model || settings.model || '').trim(),
    apiKey: secret,
    credentialType: authToken ? 'auth_token' : 'api_key',
    keySource: authToken ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY',
    maskedApiKey: maskSecretValue(secret),
  };
}

export async function getClaudeCodeProviderSecret({ providerKey = '' } = {}) {
  const home = claudeCodeHome();
  const settingsPath = path.join(home, 'settings.json');
  const settings = await readJsonFile(settingsPath);
  return resolveClaudeCodeProviderSecret(settings, providerKey);
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

  try {
    const result = await detectProvider({ baseUrl: base.baseUrl, apiKey: secret.value, timeoutMs });
    await recordProviderHealth(safeProviderKey, {
      ok: true,
      stage: 'ok',
      latencyMs: result.latencyMs ?? null,
      statusCode: result.statusCode ?? 200,
      modelCount: Array.isArray(result.models) ? result.models.length : null,
      baseUrl: result.baseUrl || base.baseUrl,
    });
    return result;
  } catch (error) {
    const diag = readDiag(error);
    await recordProviderHealth(safeProviderKey, {
      ok: false,
      stage: diag.stage,
      hint: diag.hint,
      errorMessage: diag.errorMessage,
      statusCode: diag.statusCode ?? null,
      latencyMs: diag.latencyMs ?? null,
      baseUrl: base.baseUrl,
    });
    // attach diag onto the thrown error so the API layer can pass it through to UI
    if (!error.diag) error.diag = diag;
    throw error;
  }
}

function providerImportBlock(item) {
  const block = {
    name: item.name || item.key,
    base_url: item.baseUrl,
    env_key: item.envKey || inferEnvKey(item.key),
    wire_api: item.wireApi || 'responses',
  };
  const adapterResult = applyAdapterToProvider(block, item.baseUrl);
  if (adapterResult.applied && adapterResult.providerBlock) {
    Object.assign(block, adapterResult.providerBlock);
  }
  if (!block.wire_api) block.wire_api = 'responses';
  return block;
}

function sameProviderImportBlock(left = {}, right = {}) {
  return ['name', 'base_url', 'env_key', 'wire_api']
    .every((key) => String(left?.[key] || '').trim() === String(right?.[key] || '').trim());
}

export async function applyProviderCatalogImport(input = {}, options = {}) {
  const dryRun = options.dryRun ?? input.dryRun ?? true;
  const overwrite = Boolean(options.overwrite ?? input.overwrite);
  const includeCatalogPresets = Boolean(options.includeCatalogPresets ?? input.includeCatalogPresets);
  const targetTool = String(options.targetTool || input.targetTool || 'codex').trim().toLowerCase() || 'codex';
  const codexHome = assertAllowedPath(options.codexHome || input.codexHome || defaultCodexHome(), 'codexHome');
  const scope = String(options.scope || input.scope || 'global').trim() || 'global';
  if (scope !== 'global') {
    throw new Error('Provider import currently writes only global Codex config');
  }

  const extracted = extractProviderImportItems(input, { includeCatalogPresets, targetTool });
  const paths = scopePaths({ scope: 'global', codexHome });
  const configContent = await readText(paths.configPath);
  const config = parseToml(configContent);
  const originalConfig = structuredClone(config);
  if (!config.model_providers || typeof config.model_providers !== 'object') {
    config.model_providers = {};
  }

  const operations = [];
  for (const item of extracted.providers) {
    const providerKey = slugifyProviderKey(item.key);
    if (!providerKey) {
      operations.push({ action: 'skipped', reason: 'invalid_key', sourceId: item.sourceId || '' });
      continue;
    }
    let baseUrl = '';
    try {
      baseUrl = normalizeBaseUrl(item.baseUrl);
    } catch (error) {
      operations.push({
        action: 'skipped',
        reason: 'invalid_base_url',
        key: providerKey,
        name: item.name || providerKey,
        baseUrl: item.baseUrl || '',
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const nextBlock = providerImportBlock({ ...item, key: providerKey, baseUrl });
    const existing = config.model_providers[providerKey];
    if (existing && !overwrite) {
      const same = sameProviderImportBlock(existing, nextBlock);
      operations.push({
        action: same ? 'unchanged' : 'conflict',
        key: providerKey,
        name: nextBlock.name,
        baseUrl,
        reason: same ? 'same_provider' : 'provider_exists',
      });
      continue;
    }

    if (existing && overwrite) {
      config.model_providers[providerKey] = { ...existing, ...nextBlock };
      operations.push({ action: 'updated', key: providerKey, name: nextBlock.name, baseUrl });
      continue;
    }

    config.model_providers[providerKey] = nextBlock;
    operations.push({ action: 'created', key: providerKey, name: nextBlock.name, baseUrl });
  }

  const configChanged = JSON.stringify(config) !== JSON.stringify(originalConfig);
  const shouldWrite = configChanged && dryRun === false;
  const backupPath = shouldWrite ? await createBackup(paths) : null;
  if (shouldWrite) {
    await writeText(paths.configPath, TOML.stringify(config));
  }

  const countAction = (action) => operations.filter((item) => item.action === action).length;
  return {
    schema: 'easyaiconfig.asset-import-apply.v1',
    dryRun: dryRun !== false,
    targetTool,
    includeCatalogPresets,
    overwrite,
    source: {
      schema: extracted.schema,
      app: extracted.app,
      version: extracted.version,
    },
    summary: {
      totalProviders: extracted.providers.length,
      created: countAction('created'),
      updated: countAction('updated'),
      unchanged: countAction('unchanged'),
      conflicts: countAction('conflict'),
      skipped: countAction('skipped'),
      changed: configChanged,
      written: shouldWrite,
    },
    operations,
    backupPath,
    paths: {
      configPath: paths.configPath,
    },
  };
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
  // 收集前端可展示的提示。仅保留"真正动了用户配置"的项（清理 env、替换 providerKey）。
  // 不主动告诉用户 URL 被加了 https:// / 去了尾部斜杠之类的纯字面规范化——
  // 那些是无侵入修整，闹腾反而吵。
  const hints = [];
  // 是否在保存时同时把 model_provider 切到这条新 provider。默认 false：
  // 保存就是保存，UI 拿到 needsActivation:true 后弹窗让用户确认才再发激活请求，
  // 避免在 list 上点"保存"误把当前活跃 provider 切走。
  const activate = Boolean(payload.activate);
  const previousActiveProvider = String(config.model_provider || '').trim();
  if (activate) {
    config.model_provider = providerKey;
  }
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
  // P1 #5：先看是不是国产 OpenAI 兼容 API，命中就用 chat 协议（不是 responses）
  // 避免用户保存 DeepSeek / 智谱 / Kimi 等后第一次跑就 4xx。已有 wire_api 不动。
  const adapterResult = applyAdapterToProvider(nextProvider, baseUrl);
  let adapterHint = null;
  if (adapterResult.applied && adapterResult.providerBlock) {
    Object.assign(nextProvider, adapterResult.providerBlock);
    if (adapterResult.adapter) {
      adapterHint = {
        slug: adapterResult.adapter.slug,
        name: adapterResult.adapter.name,
        wireApi: adapterResult.adapter.wireApi,
        hint: adapterResult.adapter.hint,
      };
      hints.push({
        code: 'cn_provider_adapter_applied',
        message: `检测到 ${adapterResult.adapter.name}，已自动设置 wire_api = "${adapterResult.adapter.wireApi}"（${adapterResult.adapter.hint}）`,
      });
    }
  }
  if (!nextProvider.wire_api) {
    nextProvider.wire_api = 'responses';
  }
  config.model_providers[providerKey] = nextProvider;

  // 收集所有要被废弃 / 替换的旧 env_key，准备从 .env 清理掉。
  // 触发条件：
  //   1. 同 URL 匹配到旧 providerKey 且 != 新 providerKey，旧 provider 整条被删；
  //   2. 当前 providerKey 改名了 env_key（例如改 URL 推断变成新名字）。
  const obsoleteEnvKeys = new Set();
  if (matchedProviderKey && matchedProviderKey !== providerKey) {
    const oldEnvKey = String(matchedProvider?.env_key || '').trim();
    if (oldEnvKey && oldEnvKey !== envKey) obsoleteEnvKeys.add(oldEnvKey);
    delete config.model_providers[matchedProviderKey];
    hints.push({
      code: 'provider_key_replaced',
      message: `已替换旧 provider「${matchedProviderKey}」为「${providerKey}」（同一 Base URL）`,
    });
  }
  const prevEnvKeyForKey = String(currentProvider?.env_key || '').trim();
  if (prevEnvKeyForKey && prevEnvKeyForKey !== envKey) {
    obsoleteEnvKeys.add(prevEnvKeyForKey);
  }

  if (apiKey && envKey) {
    env[envKey] = apiKey;
  }
  // 清理孤儿 env_key：只在该变量没有被用户主动复用（即不是当前要写入的 envKey），
  // 而且 .env 里确实存在时再删。避免误删用户共享给其他工具的环境变量。
  const removedEnvKeys = [];
  for (const oldKey of obsoleteEnvKeys) {
    if (!oldKey || oldKey === envKey) continue;
    if (Object.prototype.hasOwnProperty.call(env, oldKey)) {
      delete env[oldKey];
      removedEnvKeys.push(oldKey);
    }
  }
  if (removedEnvKeys.length) {
    hints.push({
      code: 'env_keys_cleaned',
      message: `已清理失效的 .env 变量：${removedEnvKeys.join(', ')}`,
      detail: { keys: removedEnvKeys },
    });
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
    activated: activate,
    activeProvider: activate ? providerKey : previousActiveProvider,
    savedProviderKey: providerKey,
    previousActiveProvider,
    needsActivation: !activate && previousActiveProvider !== providerKey,
    baseUrl,
    envKey,
    hints,
    changed: {
      config: configChanged,
      env: envChanged,
    },
  };
}

function normalizeProviderRouterClientTool(toolId = '') {
  const tool = normalizeToolRegistryId(toolId || 'codex');
  if (!Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, tool)) {
    throw new Error(`Unsupported router client tool: ${toolId || ''}`);
  }
  return tool;
}

function appendRouterNoProxyItems(current = '') {
  const items = String(current || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of LOCAL_ROUTER_NO_PROXY_ITEMS) {
    if (!items.some((existing) => existing.toLowerCase() === item.toLowerCase())) {
      items.push(item);
    }
  }
  return items.join(',');
}

function routerClientModel(payload = {}) {
  return String(payload.model || '').trim();
}

function routerClientEndpoint(payload = {}) {
  return normalizeBaseUrl(payload.endpoint || payload.baseUrl || `http://127.0.0.1:18791/v1`);
}

function readJsonObjectFile(filePath) {
  return readJsonFile(filePath).then((value) => (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  ));
}

function routerClientProfile({ tool, endpoint, apiKey, noProxy, model }) {
  const openAiEnv = {
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    OPENAI_BASE_URL: endpoint,
    OPENAI_API_KEY: apiKey,
  };
  const anthropicEnv = {
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    ANTHROPIC_BASE_URL: endpoint,
    ANTHROPIC_API_KEY: apiKey,
  };
  const env = ['claudecode', 'claude-desktop'].includes(tool) ? anthropicEnv : openAiEnv;
  return {
    providerKey: ROUTER_CLIENT_PROVIDER_KEY,
    name: ROUTER_CLIENT_PROVIDER_NAME,
    tool,
    baseUrl: endpoint,
    apiKey,
    model,
    env,
    updatedAt: new Date().toISOString(),
  };
}

function mergeRouterClientNamespace(config, profile) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  if (!config.easyaiconfig || typeof config.easyaiconfig !== 'object' || Array.isArray(config.easyaiconfig)) {
    config.easyaiconfig = {};
  }
  config.easyaiconfig.router = {
    ...(config.easyaiconfig.router && typeof config.easyaiconfig.router === 'object' ? config.easyaiconfig.router : {}),
    ...profile,
  };
  config.easyaiconfig.activeProvider = ROUTER_CLIENT_PROVIDER_KEY;
  return config;
}

function canOverrideToolConfigHome() {
  return process.env.NODE_ENV === 'test' || process.env.EASYAICONFIG_ALLOW_CONFIG_HOME_OVERRIDE === '1';
}

function resolveToolConfigHome(tool, configHome) {
  if (configHome && canOverrideToolConfigHome()) return path.resolve(String(configHome));
  return getToolDef(tool).configHome();
}

async function applyClaudeCodeRouterClient({ endpoint, apiKey, noProxy, model }) {
  const home = claudeCodeHome();
  const settingsPath = path.join(home, 'settings.json');
  const settings = await readJsonObjectFile(settingsPath);
  settings.env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
  settings.easyaiconfig = settings.easyaiconfig && typeof settings.easyaiconfig === 'object' && !Array.isArray(settings.easyaiconfig) ? settings.easyaiconfig : {};
  settings.easyaiconfig.providers = settings.easyaiconfig.providers && typeof settings.easyaiconfig.providers === 'object' && !Array.isArray(settings.easyaiconfig.providers) ? settings.easyaiconfig.providers : {};
  settings.env.NO_PROXY = noProxy;
  settings.env.no_proxy = noProxy;
  settings.env.ANTHROPIC_BASE_URL = endpoint;
  settings.env.ANTHROPIC_API_KEY = apiKey;
  delete settings.env.ANTHROPIC_AUTH_TOKEN;
  if (model) settings.model = model;
  settings.easyaiconfig.providers[ROUTER_CLIENT_PROVIDER_KEY] = {
    ...(settings.easyaiconfig.providers[ROUTER_CLIENT_PROVIDER_KEY] || {}),
    name: ROUTER_CLIENT_PROVIDER_NAME,
    baseUrl: endpoint,
    apiKey,
    authToken: '',
    model,
    updatedAt: new Date().toISOString(),
  };
  settings.easyaiconfig.activeProvider = ROUTER_CLIENT_PROVIDER_KEY;
  await writeJsonFile(settingsPath, settings);
  return { saved: true, tool: 'claudecode', settingsPath, configPath: settingsPath };
}

async function applyNamespacedJsonRouterClient({ tool, endpoint, apiKey, noProxy, model, configHome }) {
  const def = getToolDef(tool);
  const home = resolveToolConfigHome(tool, configHome);
  const configPath = path.join(home, def.configFileName);
  const config = await readJsonObjectFile(configPath);
  const profile = routerClientProfile({ tool, endpoint, apiKey, noProxy, model });
  mergeRouterClientNamespace(config, profile);
  await writeJsonFile(configPath, config);
  return { saved: true, tool, configPath };
}

function yamlQuotedScalar(value = '') {
  return JSON.stringify(String(value ?? ''));
}

function hermesRouterModelId(model = '') {
  return routerProviderModelId(model) || 'gpt-5.5';
}

function renderHermesRouterModelBlock({ endpoint, apiKey, model }) {
  const modelId = hermesRouterModelId(model);
  return [
    'model:',
    '  provider: "custom"',
    `  default: ${yamlQuotedScalar(modelId)}`,
    `  base_url: ${yamlQuotedScalar(endpoint)}`,
    `  api_key: ${yamlQuotedScalar(apiKey)}`,
    '',
  ].join('\n');
}

function unquoteYamlScalar(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    try {
      return text.startsWith('"') ? JSON.parse(text) : text.slice(1, -1);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

function readTopLevelYamlObjectBlock(raw = '', key = '') {
  const normalized = String(raw || '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const keyPattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  const start = lines.findIndex((line) => keyPattern.test(line.trimEnd()) && line.trimStart() === line);
  if (start < 0) return {};
  const out = {};
  const inlineValue = lines[start].replace(keyPattern, '').trim();
  if (inlineValue) out.value = unquoteYamlScalar(inlineValue);
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.trimStart() === line) break;
    const match = line.match(/^\s+([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    out[match[1]] = unquoteYamlScalar(match[2]);
  }
  return out;
}

function upsertTopLevelYamlBlock(raw = '', key = '', block = '') {
  const normalized = String(raw || '').replace(/\r\n/g, '\n');
  const cleanBlock = String(block || '').replace(/\n*$/, '').split('\n');
  if (!normalized.trim()) return `${cleanBlock.join('\n')}\n`;
  const lines = normalized.split('\n');
  const keyPattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  const start = lines.findIndex((line) => keyPattern.test(line.trimEnd()) && line.trimStart() === line);
  if (start < 0) {
    const prefix = normalized.replace(/\n*$/, '');
    return `${prefix}\n\n${cleanBlock.join('\n')}\n`;
  }
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (!line.trim() || /^\s/.test(line) || line.trimStart().startsWith('#')) {
      end += 1;
      continue;
    }
    break;
  }
  return [
    ...lines.slice(0, start),
    ...cleanBlock,
    ...lines.slice(end),
  ].join('\n').replace(/\n*$/, '\n');
}

async function applyHermesRouterClient({ endpoint, apiKey, noProxy, model, configHome }) {
  const home = resolveToolConfigHome('hermes', configHome);
  const configPath = path.join(home, 'config.yaml');
  const envPath = path.join(home, '.env');
  const indexPath = path.join(home, 'config.json');
  const modelId = hermesRouterModelId(model);

  const rawYaml = await readText(configPath);
  const nextYaml = upsertTopLevelYamlBlock(
    rawYaml,
    'model',
    renderHermesRouterModelBlock({ endpoint, apiKey, model: modelId }),
  );
  await writeText(configPath, nextYaml);

  const env = parseEnv(await readText(envPath));
  env.EASYAI_ROUTER_API_KEY = apiKey;
  env.OPENAI_API_KEY = apiKey;
  env.OPENAI_BASE_URL = endpoint;
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  await writeText(envPath, stringifyEnv(env));

  const index = await readJsonObjectFile(indexPath);
  const profile = routerClientProfile({ tool: 'hermes', endpoint, apiKey, noProxy, model: modelId });
  profile.nativeProvider = {
    configPath,
    envPath,
    provider: 'custom',
    model: modelId,
  };
  mergeRouterClientNamespace(index, profile);
  await writeJsonFile(indexPath, index);

  return {
    saved: true,
    tool: 'hermes',
    configPath,
    envPath,
    indexPath,
    nativeProvider: true,
  };
}

export async function loadHermesState(options = {}) {
  const home = resolveToolConfigHome('hermes', options?.configHome);
  const configPath = path.join(home, 'config.yaml');
  const envPath = path.join(home, '.env');
  const indexPath = path.join(home, 'config.json');
  const [rawYaml, rawEnv, index] = await Promise.all([
    readText(configPath),
    readText(envPath),
    readJsonObjectFile(indexPath),
  ]);
  const env = parseEnv(rawEnv);
  const modelBlock = readTopLevelYamlObjectBlock(rawYaml, 'model');
  const nativeApiKey = String(modelBlock.api_key || '').trim();
  const envApiKey = String(env.EASYAI_ROUTER_API_KEY || env.OPENAI_API_KEY || '').trim();
  const routerProfile = index?.easyaiconfig?.router && typeof index.easyaiconfig.router === 'object'
    ? index.easyaiconfig.router
    : null;
  const model = String(modelBlock.default || routerProfile?.model || '').trim();
  const baseUrl = String(modelBlock.base_url || env.OPENAI_BASE_URL || routerProfile?.baseUrl || '').trim();
  const hasApiKey = Boolean(nativeApiKey || envApiKey || routerProfile?.apiKey);
  const noProxy = String(env.NO_PROXY || env.no_proxy || routerProfile?.env?.NO_PROXY || '').trim();

  return {
    toolId: 'hermes',
    configHome: home,
    configPath,
    envPath,
    indexPath,
    binary: findToolBinary('hermes', { passive: true }),
    configExists: Boolean(rawYaml.trim()),
    envExists: Boolean(rawEnv.trim()),
    indexExists: Boolean(Object.keys(index || {}).length),
    configYaml: rawYaml,
    model,
    baseUrl,
    activeProviderKey: routerProfile?.providerKey || (modelBlock.provider ? 'custom' : ''),
    nativeProvider: {
      provider: String(modelBlock.provider || '').trim(),
      model,
      baseUrl,
      hasApiKey,
      maskedApiKey: maskSecret(nativeApiKey || envApiKey || routerProfile?.apiKey || ''),
      configPath,
      envPath,
    },
    env: {
      hasEasyAiRouterKey: Boolean(env.EASYAI_ROUTER_API_KEY),
      hasOpenAiKey: Boolean(env.OPENAI_API_KEY),
      openAiBaseUrl: env.OPENAI_BASE_URL || '',
      noProxy,
    },
    routerProfile,
  };
}

export async function loadGeminiState(options = {}) {
  const home = resolveToolConfigHome('gemini', options?.configHome);
  const configPath = path.join(home, 'settings.json');
  const raw = await readText(configPath);
  let settings = {};
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      settings = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      settings = {};
    }
  }
  const routerProfile = settings?.easyaiconfig?.router && typeof settings.easyaiconfig.router === 'object'
    ? settings.easyaiconfig.router
    : null;
  const model = String(routerProfile?.model || settings?.model || '').trim();
  const baseUrl = String(routerProfile?.baseUrl || '').trim();
  const apiKey = String(routerProfile?.apiKey || '').trim();
  return {
    toolId: 'gemini',
    configHome: home,
    configPath,
    binary: findToolBinary('gemini', { passive: true }),
    configExists: Boolean(raw.trim()),
    settings,
    model,
    baseUrl,
    activeProviderKey: routerProfile?.providerKey || '',
    routerProfile,
    safeProfile: {
      provider: routerProfile?.providerKey || '',
      model,
      baseUrl,
      hasApiKey: Boolean(apiKey),
      maskedApiKey: maskSecret(apiKey),
      configPath,
    },
  };
}

export async function launchGemini({ cwd } = {}) {
  const targetCwd = resolveLaunchCwd(cwd);
  const binary = findToolBinary('gemini');
  if (!binary.installed) {
    throw new Error('Gemini CLI 尚未安装，请先安装 @google/gemini-cli 并确保 gemini 命令在 PATH 中');
  }
  const message = launchTerminalCommand(targetCwd, {
    binaryPath: binary.path,
    binaryName: 'gemini',
    toolLabel: 'Gemini CLI',
  });
  return { ok: true, cwd: targetCwd, message };
}

async function npmCliToolAction(packageName, args) {
  const result = await runCommand(npmCommand(), args);
  return { ...result, command: `${npmCommand()} ${args.join(' ')}`, packageName };
}

function npmCliInstallArgs(packageName, { version = 'latest', domestic = false, force = false } = {}) {
  const packageSpec = version === 'latest' ? `${packageName}@latest` : npmPackageVersionSpec(packageName, version);
  const args = ['install', '-g', packageSpec];
  if (force) args.push('--force');
  if (domestic) args.push('--registry', NPM_REGISTRY_CN);
  return args;
}

function npmCliUninstallArgs(packageName) {
  return ['uninstall', '-g', packageName];
}

export async function installGemini() {
  return npmCliToolAction(GEMINI_CLI_PACKAGE, npmCliInstallArgs(GEMINI_CLI_PACKAGE, { version: 'latest' }));
}

export async function reinstallGemini() {
  return npmCliToolAction(GEMINI_CLI_PACKAGE, npmCliInstallArgs(GEMINI_CLI_PACKAGE, { version: 'latest', force: true }));
}

export async function updateGemini() {
  return installGemini();
}

export async function updateGeminiDomestic() {
  return npmCliToolAction(GEMINI_CLI_PACKAGE, npmCliInstallArgs(GEMINI_CLI_PACKAGE, { version: 'latest', domestic: true }));
}

export async function installGeminiVersion({ version, domestic = false } = {}) {
  return npmCliToolAction(GEMINI_CLI_PACKAGE, npmCliInstallArgs(GEMINI_CLI_PACKAGE, { version, domestic }));
}

export async function uninstallGemini() {
  return npmCliToolAction(GEMINI_CLI_PACKAGE, npmCliUninstallArgs(GEMINI_CLI_PACKAGE));
}

export async function installQwenCode() {
  return npmCliToolAction(QWEN_CODE_PACKAGE, npmCliInstallArgs(QWEN_CODE_PACKAGE, { version: 'latest' }));
}

export async function reinstallQwenCode() {
  return npmCliToolAction(QWEN_CODE_PACKAGE, npmCliInstallArgs(QWEN_CODE_PACKAGE, { version: 'latest', force: true }));
}

export async function updateQwenCode() {
  return installQwenCode();
}

export async function updateQwenCodeDomestic() {
  return npmCliToolAction(QWEN_CODE_PACKAGE, npmCliInstallArgs(QWEN_CODE_PACKAGE, { version: 'latest', domestic: true }));
}

export async function installQwenCodeVersion({ version, domestic = false } = {}) {
  return npmCliToolAction(QWEN_CODE_PACKAGE, npmCliInstallArgs(QWEN_CODE_PACKAGE, { version, domestic }));
}

export async function uninstallQwenCode() {
  return npmCliToolAction(QWEN_CODE_PACKAGE, npmCliUninstallArgs(QWEN_CODE_PACKAGE));
}

export async function installCodeBuddyCode() {
  return npmCliToolAction(CODEBUDDY_CODE_PACKAGE, npmCliInstallArgs(CODEBUDDY_CODE_PACKAGE, { version: 'latest' }));
}

export async function reinstallCodeBuddyCode() {
  return npmCliToolAction(CODEBUDDY_CODE_PACKAGE, npmCliInstallArgs(CODEBUDDY_CODE_PACKAGE, { version: 'latest', force: true }));
}

export async function updateCodeBuddyCode() {
  return installCodeBuddyCode();
}

export async function updateCodeBuddyCodeDomestic() {
  return npmCliToolAction(CODEBUDDY_CODE_PACKAGE, npmCliInstallArgs(CODEBUDDY_CODE_PACKAGE, { version: 'latest', domestic: true }));
}

export async function installCodeBuddyCodeVersion({ version, domestic = false } = {}) {
  return npmCliToolAction(CODEBUDDY_CODE_PACKAGE, npmCliInstallArgs(CODEBUDDY_CODE_PACKAGE, { version, domestic }));
}

export async function uninstallCodeBuddyCode() {
  return npmCliToolAction(CODEBUDDY_CODE_PACKAGE, npmCliUninstallArgs(CODEBUDDY_CODE_PACKAGE));
}

async function readHermesLaunchEnv() {
  const home = getToolDef('hermes').configHome();
  const env = parseEnv(await readText(path.join(home, '.env')));
  return Object.fromEntries(
    ['EASYAI_ROUTER_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'NO_PROXY', 'no_proxy']
      .map((key) => [key, env[key]])
      .filter(([_, value]) => value != null && String(value).trim() !== '')
  );
}

export async function launchHermes({ cwd } = {}) {
  const targetCwd = resolveLaunchCwd(cwd);
  const binary = findToolBinary('hermes');
  if (!binary.installed) {
    throw new Error('Hermes Agent 尚未安装，请先按官方方式安装并确保 hermes 命令在 PATH 中');
  }
  const extraEnv = await readHermesLaunchEnv();
  const message = launchTerminalCommand(targetCwd, {
    binaryPath: binary.path,
    binaryName: 'hermes',
    toolLabel: 'Hermes Agent',
    extraEnv,
  });
  return { ok: true, cwd: targetCwd, message, envInjected: Object.keys(extraEnv).sort() };
}

function launchDetachedApp(command, args = [], { cwd = process.cwd() } = {}) {
  const child = runSpawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function claudeDesktopWindowsCandidates() {
  const home = os.homedir();
  return [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Claude', 'Claude.exe') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Claude', 'Claude.exe') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Claude', 'Claude.exe') : '',
    path.join(home, 'AppData', 'Local', 'Programs', 'Claude', 'Claude.exe'),
  ].filter(Boolean);
}

export async function launchClaudeDesktop({ cwd } = {}) {
  const targetCwd = resolveLaunchCwd(cwd);

  if (process.platform === 'darwin') {
    const opened = runSpawnSync('open', ['-a', 'Claude'], { encoding: 'utf8' });
    if (opened.status !== 0) {
      const detail = String(opened.stderr || opened.stdout || '').trim();
      throw new Error(detail || 'Claude Desktop 尚未安装，或 macOS 无法通过 open -a Claude 打开');
    }
    return { ok: true, cwd: targetCwd, message: 'Claude Desktop 已打开', method: 'open -a Claude' };
  }

  if (process.platform === 'win32') {
    const binary = findToolBinary('claude-desktop', { passive: true });
    const binaryPath = binary.installed && binary.path
      ? binary.path
      : claudeDesktopWindowsCandidates().find((candidate) => existsSync(candidate));
    if (!binaryPath) {
      throw new Error('Claude Desktop 尚未安装，或未在常见安装路径中检测到 Claude.exe');
    }
    launchDetachedApp(binaryPath, [], { cwd: targetCwd });
    return { ok: true, cwd: targetCwd, message: 'Claude Desktop 已打开', method: 'Claude.exe' };
  }

  const linuxBinary = commandExists('claude-desktop');
  if (!linuxBinary) {
    throw new Error('当前平台未检测到 Claude Desktop 启动入口；请手动打开 Claude Desktop');
  }
  launchDetachedApp(linuxBinary, [], { cwd: targetCwd });
  return { ok: true, cwd: targetCwd, message: 'Claude Desktop 已打开', method: 'claude-desktop' };
}

async function applyOpenCodeRouterClient({ endpoint, apiKey, model, scope, projectPath }) {
  const paths = resolveOpenCodePaths({ scope, projectPath });
  const raw = await readText(paths.configPath);
  let config = {};
  if (raw.trim()) {
    try {
      config = parseJsonc(raw);
    } catch (error) {
      throw new Error(`OpenCode 配置解析失败：${error.message}`);
    }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  config.$schema = config.$schema || 'https://opencode.ai/config.json';
  config.provider = config.provider && typeof config.provider === 'object' && !Array.isArray(config.provider) ? config.provider : {};
  const provider = config.provider[ROUTER_CLIENT_PROVIDER_KEY] && typeof config.provider[ROUTER_CLIENT_PROVIDER_KEY] === 'object'
    ? config.provider[ROUTER_CLIENT_PROVIDER_KEY]
    : {};
  provider.name = ROUTER_CLIENT_PROVIDER_NAME;
  provider.options = provider.options && typeof provider.options === 'object' && !Array.isArray(provider.options) ? provider.options : {};
  provider.options.baseURL = endpoint;
  provider.options.apiKey = apiKey;
  const modelId = routerProviderModelId(model);
  if (modelId) {
    provider.models = provider.models && typeof provider.models === 'object' && !Array.isArray(provider.models) ? provider.models : {};
    provider.models[modelId] = provider.models[modelId] || {};
    config.model = `${ROUTER_CLIENT_PROVIDER_KEY}/${modelId}`;
  }
  config.provider[ROUTER_CLIENT_PROVIDER_KEY] = provider;
  config.easyaiconfig = config.easyaiconfig && typeof config.easyaiconfig === 'object' && !Array.isArray(config.easyaiconfig) ? config.easyaiconfig : {};
  config.easyaiconfig.router = routerClientProfile({ tool: 'opencode', endpoint, apiKey, noProxy, model: modelId });
  await writeText(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { saved: true, tool: 'opencode', scope: paths.scope, configPath: paths.configPath };
}

function routerProviderModelId(model = '') {
  const parts = String(model || '').split('/').filter(Boolean);
  if (parts.length <= 1) return String(model || '').trim();
  return parts.slice(1).join('/') || parts[0] || '';
}

function routerOpenClawModelId(model = '') {
  return routerProviderModelId(model) || 'gpt-5.5';
}

async function applyOpenClawRouterClient({ endpoint, apiKey, model, noProxy }) {
  const home = openclawHome();
  const configPath = path.join(home, 'openclaw.json');
  let config = {};
  const raw = await readText(configPath);
  if (raw.trim()) {
    try {
      config = JSON.parse(raw);
    } catch (error) {
      throw new Error(`OpenClaw JSON 解析失败：${error.message}`);
    }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  config.env = config.env && typeof config.env === 'object' && !Array.isArray(config.env) ? config.env : {};
  config.env[ROUTER_CLIENT_ENV_KEY] = apiKey;
  config.agents = config.agents && typeof config.agents === 'object' && !Array.isArray(config.agents) ? config.agents : {};
  config.agents.defaults = config.agents.defaults && typeof config.agents.defaults === 'object' && !Array.isArray(config.agents.defaults) ? config.agents.defaults : {};
  config.agents.defaults.model = config.agents.defaults.model && typeof config.agents.defaults.model === 'object' && !Array.isArray(config.agents.defaults.model) ? config.agents.defaults.model : {};
  const modelId = routerOpenClawModelId(model);
  config.agents.defaults.model.primary = `${ROUTER_CLIENT_PROVIDER_KEY}/${modelId}`;
  config.models = config.models && typeof config.models === 'object' && !Array.isArray(config.models) ? config.models : {};
  config.models.mode = config.models.mode || 'merge';
  config.models.providers = config.models.providers && typeof config.models.providers === 'object' && !Array.isArray(config.models.providers) ? config.models.providers : {};
  config.models.providers[ROUTER_CLIENT_PROVIDER_KEY] = {
    ...(config.models.providers[ROUTER_CLIENT_PROVIDER_KEY] || {}),
    baseUrl: endpoint,
    api: 'openai-completions',
    apiKey: `$${ROUTER_CLIENT_ENV_KEY}`,
    models: [
      {
        id: modelId,
        name: modelId,
        api: 'openai-completions',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  };
  config.easyaiconfig = config.easyaiconfig && typeof config.easyaiconfig === 'object' && !Array.isArray(config.easyaiconfig) ? config.easyaiconfig : {};
  config.easyaiconfig.router = routerClientProfile({ tool: 'openclaw', endpoint, apiKey, noProxy, model: modelId });
  applyOpenClawGatewayDefaults(config);
  await writeText(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { saved: true, tool: 'openclaw', configPath };
}

export async function applyProviderRouterClientConfig(payload = {}) {
  const tool = normalizeProviderRouterClientTool(payload.tool || 'codex');
  const endpoint = routerClientEndpoint(payload);
  const apiKey = String(payload.apiKey || ROUTER_CLIENT_API_KEY).trim() || ROUTER_CLIENT_API_KEY;
  const noProxy = appendRouterNoProxyItems(payload.noProxy || '');
  const model = routerClientModel(payload);

  if (tool === 'codex') {
    const codexHome = assertAllowedPath(payload.codexHome || defaultCodexHome(), 'codexHome');
    const saved = await saveConfig({
      scope: payload.scope || 'global',
      projectPath: payload.projectPath || '',
      codexHome,
      providerKey: ROUTER_CLIENT_PROVIDER_KEY,
      providerLabel: ROUTER_CLIENT_PROVIDER_NAME,
      baseUrl: endpoint,
      apiKey,
      envKey: ROUTER_CLIENT_ENV_KEY,
      model,
      activate: true,
    });
    return { ...saved, tool, configPath: saved.paths?.configPath, envPath: saved.paths?.envPath };
  }

  if (tool === 'claudecode') {
    return applyClaudeCodeRouterClient({ endpoint, apiKey, noProxy, model });
  }

  if (tool === 'opencode') {
    return applyOpenCodeRouterClient({
      endpoint,
      apiKey,
      noProxy,
      model,
      scope: payload.scope || 'global',
      projectPath: payload.projectPath || '',
    });
  }

  if (tool === 'openclaw') {
    return applyOpenClawRouterClient({ endpoint, apiKey, noProxy, model });
  }

  if (tool === 'hermes') {
    return applyHermesRouterClient({ endpoint, apiKey, noProxy, model, configHome: payload.configHome });
  }

  return applyNamespacedJsonRouterClient({ tool, endpoint, apiKey, noProxy, model, configHome: payload.configHome });
}


export async function deleteProviderConfig(payload) {
  const codexHome = assertAllowedPath(payload.codexHome || defaultCodexHome(), 'codexHome');
  const paths = scopePaths({
    scope: payload.scope || 'global',
    projectPath: payload.projectPath || '',
    codexHome,
  });

  const providerKey = slugifyProviderKey(payload.providerKey || '');
  if (!providerKey) throw new Error('Provider key is required');

  const [configContent, envContent] = await Promise.all([
    readText(paths.configPath),
    readText(paths.envPath),
  ]);

  const config = parseToml(configContent);
  const originalConfig = structuredClone(config);
  const env = parseEnv(envContent);
  const originalEnv = { ...env };
  const providers = config.model_providers && typeof config.model_providers === 'object'
    ? config.model_providers
    : {};

  const targetProvider = providers[providerKey];
  if (!targetProvider) {
    return {
      removed: false,
      reason: 'not_found',
      providerKey,
      paths,
      changed: { config: false, env: false },
    };
  }

  const targetEnvKey = String(targetProvider.env_key || '').trim();
  delete providers[providerKey];
  config.model_providers = providers;

  if (String(config.model_provider || '').trim() === providerKey) {
    const fallbackKey = Object.keys(providers)[0] || '';
    if (fallbackKey) config.model_provider = fallbackKey;
    else delete config.model_provider;
  }

  if (targetEnvKey) {
    const stillUsed = Object.entries(providers).some(([key, provider]) => {
      if (key === providerKey) return false;
      return String(provider?.env_key || '').trim() === targetEnvKey;
    });
    if (!stillUsed && Object.prototype.hasOwnProperty.call(env, targetEnvKey)) {
      delete env[targetEnvKey];
    }
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
    removed: true,
    providerKey,
    removedEnvKey: targetEnvKey && !Object.prototype.hasOwnProperty.call(env, targetEnvKey) ? targetEnvKey : '',
    backupPath,
    paths,
    activeProvider: config.model_provider || '',
    changed: {
      config: configChanged,
      env: envChanged,
    },
  };
}

export async function useOauthConfig(payload) {
  const codexHome = assertAllowedPath(payload.codexHome || defaultCodexHome(), 'codexHome');
  const paths = scopePaths({
    scope: payload.scope || 'global',
    projectPath: payload.projectPath || '',
    codexHome,
  });

  const configContent = await readText(paths.configPath);
  const config = parseToml(configContent);
  const originalConfig = structuredClone(config);

  if (config && typeof config === 'object' && !Array.isArray(config)) {
    delete config.model_provider;
  }

  const configChanged = JSON.stringify(config) !== JSON.stringify(originalConfig);
  const backupPath = configChanged ? await createBackup(paths) : null;

  if (configChanged) {
    await writeText(paths.configPath, TOML.stringify(config));
  }

  return {
    saved: true,
    backupPath,
    paths,
    activeProvider: '',
    changed: { config: configChanged, env: false },
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
  applyPatch(config, normalizeSettingsPatchForScope(payload.settings || {}, paths.scope));

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

  const hasAuthJsonPayload = Object.prototype.hasOwnProperty.call(payload, 'authJson');
  const authJsonRaw = hasAuthJsonPayload ? String(payload.authJson || '') : '';
  let authChanged = false;
  if (authJsonRaw.trim()) {
    try {
      JSON.parse(authJsonRaw);
    } catch (error) {
      throw new Error(`auth.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const currentAuth = await readText(paths.authPath);
    authChanged = currentAuth !== authJsonRaw;
  }

  const backupPath = changed || authChanged ? await createBackup(paths) : null;
  if (changed) {
    await writeText(paths.configPath, configToml);
  }
  if (authChanged) {
    await writeText(paths.authPath, authJsonRaw);
  }

  return {
    saved: true,
    backupPath,
    paths,
    changed: changed || authChanged,
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
  const authBackupPath = path.join(backupDir, 'auth.json.bak');
  const [configContent, envContent] = await Promise.all([
    readText(path.join(backupDir, 'config.toml.bak')),
    readText(path.join(backupDir, '.env.bak')),
  ]);

  await writeText(paths.configPath, configContent);
  await writeText(paths.envPath, envContent);
  if (await pathExists(authBackupPath)) {
    await writeText(paths.authPath, await readText(authBackupPath));
  }
  return { restored: true, paths };
}

async function codexNpmAction(args) {
  const result = await runCommand(npmCommand(), args);
  return {
    ...result,
    command: `${npmCommand()} ${args.join(' ')}`,
  };
}

function assertSafeNpmPackageVersion(input) {
  const version = String(input || '').trim();
  if (!version) throw new Error('缺少目标版本');
  if (version.length > 128 || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) {
    throw new Error('目标版本格式无效');
  }
  return version;
}

function npmPackageVersionSpec(packageName, version) {
  return `${packageName}@${assertSafeNpmPackageVersion(version)}`;
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

export async function updateCodexDomestic() {
  return codexNpmAction(['install', '-g', `${OPENAI_CODEX_PACKAGE}@latest`, '--registry', NPM_REGISTRY_CN]);
}

export async function installCodexVersion({ version, domestic = false } = {}) {
  const args = ['install', '-g', npmPackageVersionSpec(OPENAI_CODEX_PACKAGE, version)];
  if (domestic) args.push('--registry', NPM_REGISTRY_CN);
  return codexNpmAction(args);
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

// 把用户传入的 cwd 做完整规范化：展开 ~ 、收敛到绝对路径、并校验存在性。
// Codex / Claude 启动场景下，UI 可能会传 "~/Projects" 或者拷贝粘贴的路径，
// 直接 path.resolve 会得到 "<server cwd>/~/Projects" 这种悬空路径。
function resolveLaunchCwd(cwd) {
  const resolved = resolveMaybeHomePath(cwd, process.cwd()) || process.cwd();
  return path.resolve(resolved);
}

function describeCodexInstallError() {
  // 启动时找不到 codex 的最常见原因是 GUI 进程 PATH 不含 nvm。
  // 给一个有方向感的提示，而不是干巴巴一句"尚未安装"。
  if (process.platform === 'darwin') {
    return 'Codex 尚未安装，或当前 PATH 没扫到。如确认本机已 `npm i -g @openai/codex`，可在终端执行 `which codex` 验证；GUI 启动场景下我们已经会扫 nvm/asdf/volta/brew，仍找不到请点击重新安装。';
  }
  return 'Codex 尚未安装，请先点击安装';
}

async function launchCodexSessionAction({ cwd, sessionId = '', action = 'resume', last = false, terminalProfile = 'auto' } = {}) {
  const targetCwd = resolveLaunchCwd(cwd);
  const codexBinary = findCodexBinary();
  if (!codexBinary.installed) {
    throw new Error(describeCodexInstallError());
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

// 读当前 Codex active provider 的 per-provider 代理 env
async function getCodexActiveProviderProxyEnv(codexHome = defaultCodexHome()) {
  try {
    const configContent = await readText(path.join(codexHome, 'config.toml'));
    const config = parseToml(configContent);
    const activeKey = String(config.model_provider || '').trim();
    if (!activeKey) return {};
    return await buildProviderProxyEnv(activeKey);
  } catch (_) {
    return {};
  }
}

// Per-project provider binding：launch 前查 cwd → 切 model_provider 到绑定的
// provider（如果当前 active 不匹配）。不写日志、不弹窗，让用户感受到"项目自动切"。
async function applyProjectBindingForLaunch({ cwd, tool, codexHome }) {
  try {
    const { getProjectBinding } = await import('./project-bindings.js');
    const binding = await getProjectBinding(cwd, tool);
    if (!binding?.providerKey) return null;

    if (tool === 'codex') {
      const home = codexHome || defaultCodexHome();
      const configPath = path.join(home, 'config.toml');
      const raw = await readText(configPath);
      const config = parseToml(raw);
      const currentActive = String(config.model_provider || '').trim();
      if (currentActive === binding.providerKey) return { tool, providerKey: binding.providerKey, changed: false };
      // 目标 provider 必须已存在于 model_providers 才允许切（避免引用空 provider）
      if (!config.model_providers || !config.model_providers[binding.providerKey]) return null;
      config.model_provider = binding.providerKey;
      await writeText(configPath, stringifyToml(config));
      return { tool, providerKey: binding.providerKey, changed: true, matchedDir: binding.matchedDir };
    }
    // Claude / OpenCode 的 per-project 绑定在 launchClaudeCode / launchOpenCode 里单独处理
    return null;
  } catch (err) {
    console.warn('[project-binding] apply skipped:', err?.message || err);
    return null;
  }
}

export async function launchCodex({ cwd, terminalProfile = 'auto', codexHome = '' } = {}) {
  const targetCwd = resolveLaunchCwd(cwd);
  const codexBinary = findCodexBinary();
  if (!codexBinary.installed) {
    throw new Error(describeCodexInstallError());
  }

  // P0 #3：如果当前 cwd 有 codex 绑定，silent switch 到绑定的 provider
  const bindingApplied = await applyProjectBindingForLaunch({ cwd: targetCwd, tool: 'codex', codexHome });

  const extraEnv = await getCodexActiveProviderProxyEnv();
  const message = launchTerminalCommand(targetCwd, {
    binaryPath: codexBinary.path,
    binaryName: 'codex',
    toolLabel: 'Codex',
    terminalProfile,
    extraEnv,
  });
  return { ok: true, cwd: targetCwd, message, projectBinding: bindingApplied };
}

export async function loginCodex({ cwd, terminalProfile = 'auto', codexHome = '' } = {}) {
  const targetCwd = resolveLaunchCwd(cwd);
  const resolvedHome = String(codexHome || '').trim() || defaultCodexHome();
  const authPath = path.join(resolvedHome, 'auth.json');
  const authRaw = await readText(authPath);
  if (authRaw.trim()) {
    await preserveCodexAuthJsonEntriesToEnv({ codexHome: resolvedHome, authRaw });
    await backupCodexAuthJson(authRaw);
  }
  const codexBinary = findCodexBinary();
  if (!codexBinary.installed) {
    throw new Error(describeCodexInstallError());
  }

  // 给目标 profile 注入 CODEX_HOME，让 codex login 把 auth.json 写到 profile dir 而不是默认 ~/.codex
  const extraEnv = resolvedHome !== defaultCodexHome() ? { CODEX_HOME: resolvedHome } : {};

  const message = launchTerminalCommand(targetCwd, {
    binaryPath: codexBinary.path,
    binaryName: 'codex',
    toolLabel: 'Codex 登录',
    commandText: buildCodexSessionCommand(codexBinary, ['login']),
    terminalProfile,
    extraEnv,
  });
  return { ok: true, cwd: targetCwd, message };
}

/* ═══════════════  Claude Code  ═══════════════ */
const CLAUDECODE_PROFILES_DIRNAME = 'claudecode-oauth-profiles';
const CLAUDECODE_PROFILES_INDEX = 'profiles.json';

// Tauri 后端写的 profiles 索引,Web 端只读跟随。
// 路径: ~/.codex-config-ui/claudecode-oauth-profiles/profiles.json
// 结构: { version, active, lastSwitchAt, profiles: [{id,...}] }
function claudecodeProfilesRoot() {
  return path.join(os.homedir(), APP_HOME_DIRNAME, CLAUDECODE_PROFILES_DIRNAME);
}

function readActiveClaudeProfileDir() {
  try {
    const indexPath = path.join(claudecodeProfilesRoot(), CLAUDECODE_PROFILES_INDEX);
    if (!existsSync(indexPath)) return null;
    const raw = readFileSync(indexPath, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    const active = String(parsed?.active || '').trim();
    if (!active) return null;
    // 路径注入防御:active 是 UI 给定的 id,应当是纯 prof_xxx,
    // 不允许路径分隔符或 .. 之类的片段。
    if (active.includes('/') || active.includes('\\') || active.includes('..')) return null;
    const dir = path.join(claudecodeProfilesRoot(), active);
    // 目录不存在时(用户 rm -rf 了 / 从另一台机迁移过来没同步) fallthrough
    // 回默认,避免 Dashboard/settings 写到一个悬空路径。Rust 侧 active_profile_config_dir
    // 行为一致。
    if (!existsSync(dir)) return null;
    return dir;
  } catch {
    return null;
  }
}

// 当激活了某个 CLAUDE_CONFIG_DIR profile,Claude Code 会把所有 home 文件
// (settings.json / projects/ / .claude.json 等)写到那个 profile dir 下,
// 把它当 ~/.claude 用。没激活时退回默认 ~/.claude。
function claudeCodeHome() {
  const profileHome = readActiveClaudeProfileDir();
  if (profileHome) return profileHome;
  return path.join(os.homedir(), '.claude');
}

// 全局 config 文件 (.claude.json) 在 Claude Code 源码里:
//   join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')
// - 默认模式: ~/.claude.json (注意是 homedir 下,不是 ~/.claude/ 里)
// - profile 模式: <profile_dir>/.claude.json
function claudeGlobalConfigPath() {
  const profileHome = readActiveClaudeProfileDir();
  if (profileHome) return path.join(profileHome, '.claude.json');
  return path.join(os.homedir(), '.claude.json');
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
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', {
    encoding: 'utf8', mode: 0o600,
  });
  if (process.platform !== 'win32') {
    try { await fs.chmod(filePath, 0o600); } catch (_) {}
  }
}


// 列出所有可扫描的 Claude 账号目录(含默认 ~/.claude 和所有 profile 目录),
// 给 Dashboard 聚合视图用。返回 [{ scopeId, label, home, claudeJsonPath }]。
// - scopeId: 'default' 或 'prof_xxx',前端标识用
// - home: 扫 projects/*.jsonl 的 root
// - claudeJsonPath: 读 officialCost 的路径
function listClaudeScopes() {
  const scopes = [];
  const defaultHome = path.join(os.homedir(), '.claude');
  scopes.push({
    scopeId: 'default',
    label: '默认账号',
    home: defaultHome,
    claudeJsonPath: path.join(os.homedir(), '.claude.json'),
  });
  try {
    const root = claudecodeProfilesRoot();
    const indexPath = path.join(root, CLAUDECODE_PROFILES_INDEX);
    if (existsSync(indexPath)) {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8') || '{}');
      for (const p of (parsed.profiles || [])) {
        const id = String(p?.id || '').trim();
        if (!id || id.includes('/') || id.includes('\\') || id.includes('..')) continue;
        const dir = path.join(root, id);
        if (!existsSync(dir)) continue;
        scopes.push({
          scopeId: id,
          label: String(p?.name || id),
          home: dir,
          claudeJsonPath: path.join(dir, '.claude.json'),
        });
      }
    }
  } catch { /* fallthrough: just default */ }
  return scopes;
}

// 根据 scope 参数决定读哪个/哪些账号:
// - undefined / 'active':读当前激活的(原行为)
// - 'all':扫所有账号并聚合
// - 'default':只读 ~/.claude
// - 'prof_xxx':只读指定 profile
// 返回要传给 readClaudeTelemetryUsage 的 { home, claudeJsonPath } 数组。
function resolveClaudeScopeHomes(scope) {
  const all = listClaudeScopes();
  const s = String(scope || 'active');
  if (s === 'all') return all;
  if (s === 'default') {
    return [all.find(x => x.scopeId === 'default')].filter(Boolean);
  }
  if (s === 'active') {
    // 当前激活:readActiveClaudeProfileDir() 返回 profile dir 或 null(=默认)
    const profileDir = readActiveClaudeProfileDir();
    if (profileDir) {
      const id = path.basename(profileDir);
      const hit = all.find(x => x.scopeId === id);
      if (hit) return [hit];
    }
    return [all.find(x => x.scopeId === 'default')].filter(Boolean);
  }
  // 指定 profile id
  const hit = all.find(x => x.scopeId === s);
  return hit ? [hit] : [];
}

async function readClaudeTelemetryUsage({ days = 30, scope = 'active' } = {}) {
  const homes = resolveClaudeScopeHomes(scope);
  if (homes.length === 0) {
    // scope 指向了一个不存在的 profile —— 回退到空数据,不崩
    return readClaudeTelemetryUsageForHome({
      days,
      home: path.join(os.homedir(), '.claude'),
      claudeJsonPath: path.join(os.homedir(), '.claude.json'),
      scopeLabel: '(未找到)',
    });
  }
  if (homes.length === 1) {
    return readClaudeTelemetryUsageForHome({
      days,
      home: homes[0].home,
      claudeJsonPath: homes[0].claudeJsonPath,
      scopeLabel: homes[0].label,
    });
  }
  // 多账号聚合
  const perScope = [];
  for (const h of homes) {
    const u = await readClaudeTelemetryUsageForHome({
      days,
      home: h.home,
      claudeJsonPath: h.claudeJsonPath,
      scopeLabel: h.label,
    });
    perScope.push({ scopeId: h.scopeId, label: h.label, usage: u });
  }
  return mergeClaudeUsages(perScope, days);
}

async function readClaudeTelemetryUsageForHome({ days = 30, home, claudeJsonPath, scopeLabel = '' } = {}) {
  const projectsRoot = path.join(home, 'projects');
  const cutoffMs = Date.now() - Math.max(1, Math.min(90, Number(days) || 30)) * 24 * 60 * 60 * 1000;
  const sessions = new Map();
  const daily = new Map();
  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cost: 0 };
  const modelTotals = new Map(); // model -> { input, output, cacheRead, cacheCreation, total }
  const dailyModelTokens = new Map(); // date -> { tokensByModel: { model: total } }


  // Pricing per million tokens (Anthropic official)
  const PRICING = {
    'claude-fable-5':    { input: 10, output: 50, cacheRead: 1, cacheCreate: 12.5 },
    'claude-mythos-5':   { input: 10, output: 50, cacheRead: 1, cacheCreate: 12.5 },
    'claude-sonnet-5': Date.now() < Date.parse('2026-09-01T00:00:00Z')
      ? { input: 2, output: 10, cacheRead: 0.2, cacheCreate: 2.5 }
      : { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
    'claude-opus-4-6':   { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 },
    'claude-sonnet-4-6': { input: 3,  output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
    'claude-haiku-4-5':  { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 },
  };
  function matchPricing(model) {
    const m = (model || '').toLowerCase().replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
    if (m.includes('fable-5')) return PRICING['claude-fable-5'];
    if (m.includes('mythos-5')) return PRICING['claude-mythos-5'];
    if (m.includes('sonnet-5')) return PRICING['claude-sonnet-5'];
    if (m.includes('opus'))   return PRICING['claude-opus-4-6'];
    if (m.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
    if (m.includes('haiku'))  return PRICING['claude-haiku-4-5'];
    return PRICING['claude-sonnet-4-6'];
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
          idPaths: ['requestId', 'request_id', 'request.id', 'message.requestId', 'message.request_id', 'messageId', 'message_id', 'id'],
          parentPaths: ['conversationId', 'conversation_id', 'threadId', 'thread_id'],
        }) || `${sessionId}:${u.input}:${u.output}:${u.cacheRead}:${u.cacheCreation}`;
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

  // Read official cumulative cost from the scope's own .claude.json.
  // 单账号模式下由上层传入 claudeJsonPath,聚合模式在 mergeClaudeUsages 里按每个
  // 账号单独读再累加。
  let officialCost = 0;
  let officialModels = [];
  try {
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
    scopeLabel,
    aggregated: false,
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

// 把多账号 usage 合并成一份视图。对用户场景"两个号扩容"特别有用:
// 合并后 totals / daily / models / officialCost 是两个号相加的真实消耗。
// sessions 合并按 updatedAt 倒序取前 12,并在每条里带 scopeLabel 供 UI 打标。
function mergeClaudeUsages(perScope, days) {
  const totals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cost: 0 };
  const dailyMap = new Map();           // date -> { date, ...sums }
  const modelsMap = new Map();          // model -> { input, output, cacheRead, cacheCreation, total }
  const dailyModelMap = new Map();      // date -> { date, tokensByModel: {model: total} }
  const sessions = [];
  let officialCost = 0;
  let officialModels = [];

  for (const { label, usage } of perScope) {
    if (!usage) continue;
    const u = usage;
    // totals
    for (const k of Object.keys(totals)) totals[k] += Number(u.totals?.[k] || 0);
    officialCost += Number(u.officialCost || 0);
    if (Array.isArray(u.officialModels)) officialModels.push(...u.officialModels);
    // daily
    for (const d of (u.daily || [])) {
      const cur = dailyMap.get(d.date) || { date: d.date, input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cost: 0 };
      for (const k of ['input', 'output', 'cacheCreation', 'cacheRead', 'total', 'cost']) {
        cur[k] = Number(cur[k] || 0) + Number(d[k] || 0);
      }
      dailyMap.set(d.date, cur);
    }
    // models
    for (const m of (u.models || [])) {
      const cur = modelsMap.get(m.model) || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
      for (const k of Object.keys(cur)) cur[k] += Number(m.totals?.[k] || 0);
      modelsMap.set(m.model, cur);
    }
    // dailyModelTokens
    for (const d of (u.dailyModelTokens || [])) {
      const cur = dailyModelMap.get(d.date) || { date: d.date, tokensByModel: {} };
      for (const [mk, mv] of Object.entries(d.tokensByModel || {})) {
        cur.tokensByModel[mk] = Number(cur.tokensByModel[mk] || 0) + Number(mv || 0);
      }
      dailyModelMap.set(d.date, cur);
    }
    // sessions:带上来源 label,让前端能标"哪个账号"的
    for (const s of (u.sessions || [])) sessions.push({ ...s, scopeLabel: label });
  }

  const models = [...modelsMap.entries()]
    .map(([model, t]) => ({ model, totals: t }))
    .sort((a, b) => b.totals.total - a.totals.total);

  return {
    days: Math.max(1, Math.min(90, Number(days) || 30)),
    source: `聚合(${perScope.length} 个账号)`,
    scopeLabel: perScope.map(p => p.label).join(' + '),
    aggregated: true,
    perScope: perScope.map(({ scopeId, label, usage }) => ({
      scopeId, label,
      totals: usage?.totals || null,
      officialCost: usage?.officialCost || 0,
    })),
    generatedAt: new Date().toISOString(),
    totals,
    officialCost,
    officialModels,
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    sessions: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12),
    models,
    dailyModelTokens: [...dailyModelMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export async function loadClaudeCodeState(options = {}) {
  const home = claudeCodeHome();
  const settingsPath = path.join(home, 'settings.json');
  const settings = await readJsonFile(settingsPath);
  const binary = findToolBinary('claudecode', { passive: process.platform === 'win32' });
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

  // 读 .claude.json 拿登录态/projects/userID。
  // Claude Code 源码把它放在 (CLAUDE_CONFIG_DIR || homedir())/.claude.json,
  // 所以激活 profile 时要跟着走到 profile 目录下。
  const claudeJsonPath = claudeGlobalConfigPath();
  const claudeJson = await readJsonFile(claudeJsonPath);
  const activeProfileDir = readActiveClaudeProfileDir();

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
  // scope:'active' / 'all' / 'default' / 'prof_xxx' —— 决定 Dashboard 在看哪个账号
  const usageScope = (() => {
    const raw = String(options.usageScope || 'active').trim();
    if (!raw) return 'active';
    if (/^(all|active|default)$/i.test(raw)) return raw.toLowerCase();
    // 其它只允许 prof_xxx 白名单,避免路径注入
    if (/^prof_[A-Za-z0-9_-]+$/.test(raw)) return raw;
    return 'active';
  })();
  const usage = cacheOnly
    ? await readClaudeTelemetryUsage({ days: 30, scope: usageScope })
    : await readClaudeTelemetryUsage({ days: 30, scope: usageScope });

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
    activeProfile: activeProfileDir
      ? { dir: activeProfileDir, id: path.basename(activeProfileDir) }
      : null,
    usageScope,
    // 可用账号列表供 Dashboard 下拉渲染(前端不再单独调 /api/claudecode/oauth/profiles
    // 就能知道有哪些账号)。不含 hasTokens 等敏感元数据,只含 scopeId + label。
    availableScopes: listClaudeScopes().map(s => ({ scopeId: s.scopeId, label: s.label })),
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

export async function updateClaudeCodeDomestic() {
  return claudeCodeNpmAction(['install', '-g', `${CLAUDE_CODE_PACKAGE}@latest`, '--registry', NPM_REGISTRY_CN]);
}

export async function installClaudeCodeVersion({ version, domestic = false } = {}) {
  const args = ['install', '-g', npmPackageVersionSpec(CLAUDE_CODE_PACKAGE, version)];
  if (domestic) args.push('--registry', NPM_REGISTRY_CN);
  return claudeCodeNpmAction(args);
}

export async function uninstallClaudeCode() {
  return claudeCodeNpmAction(['uninstall', '-g', CLAUDE_CODE_PACKAGE]);
}

// 读当前 Claude active provider 的 proxy。Claude 没有「当前 provider」这个概念,
// 用 settings.json 里 env.ANTHROPIC_BASE_URL 的 host 反查 providerKey。
async function getClaudeActiveProviderProxyEnv() {
  try {
    const settingsPath = path.join(claudeCodeHome(), 'settings.json');
    const settings = await readJsonFile(settingsPath);
    const baseUrl = settings?.env?.ANTHROPIC_BASE_URL || '';
    if (!baseUrl) return {};
    // 用 baseUrl host 作为 provider key 近似（和 saveClaude provider 命名一致）
    const slug = slugifyProviderKey(inferProviderSeed(baseUrl));
    if (!slug) return {};
    return await buildProviderProxyEnv(slug);
  } catch (_) {
    return {};
  }
}

export async function launchClaudeCode({ cwd } = {}) {
  const targetCwd = resolveLaunchCwd(cwd);
  const binary = findToolBinary('claudecode');
  if (!binary.installed) {
    throw new Error('Claude Code 尚未安装，请先点击安装');
  }
  const extraEnv = await getClaudeActiveProviderProxyEnv();
  // 如果当前激活了某个 OAuth profile，注入 CLAUDE_CONFIG_DIR 让 Claude 用对应账号
  try {
    const { activeClaudecodeConfigDir } = await import('./claudecode-oauth-profiles.js');
    const dir = await activeClaudecodeConfigDir();
    if (dir) extraEnv.CLAUDE_CONFIG_DIR = dir;
  } catch (_) { /* swallow */ }
  const message = launchTerminalCommand(targetCwd, {
    binaryPath: binary.path,
    binaryName: 'claude',
    toolLabel: 'Claude Code',
    extraEnv,
  });
  return { ok: true, cwd: targetCwd, message };
}

export async function loginClaudeCode({ cwd, profileId = '' } = {}) {
  const targetCwd = resolveLaunchCwd(cwd);
  const binary = findToolBinary('claudecode');
  if (!binary.installed) {
    throw new Error('Claude Code 尚未安装，请先点击安装');
  }
  const binaryPath = String(binary.path || 'claude');
  // 如果指定了 profileId，把 CLAUDE_CONFIG_DIR 指到 profile dir，让 claude auth login 把 token 写到 profile 里
  const extraEnv = {};
  const cleanProfileId = String(profileId || '').trim();
  if (cleanProfileId) {
    try {
      const home = process.env.CODEX_CONFIG_UI_HOME || path.join(os.homedir(), APP_HOME_DIRNAME);
      const dir = path.join(home, 'claudecode-oauth-profiles', cleanProfileId);
      if (!cleanProfileId.includes('/') && !cleanProfileId.includes('\\') && !cleanProfileId.includes('..')) {
        extraEnv.CLAUDE_CONFIG_DIR = dir;
      }
    } catch (_) {}
  }
  const message = launchTerminalCommand(targetCwd, {
    commandText: process.platform === 'win32'
      ? buildWindowsBinaryCommand(binaryPath, ['auth', 'login'], 'claude')
      : `${quotePosixShellArg(binaryPath)} auth login`,
    toolLabel: 'Claude Code OAuth 登录',
    extraEnv,
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

async function openCodeInstallVersionAction({ version, domestic = false } = {}) {
  const packageSpec = npmPackageVersionSpec(OPENCODE_PACKAGE, version);
  const result = await openCodeNpmAction(['install', '-g', packageSpec], { domestic });
  return {
    ...result,
    requestedMethod: domestic ? 'domestic' : 'npm',
    method: domestic ? 'domestic' : 'npm',
    googleReachable: null,
    usedDomesticMirror: Boolean(domestic),
  };
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

  const binary = findToolBinary('opencode', { passive: process.platform === 'win32' });
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

export async function installOpenCodeVersion({ version, domestic = false } = {}) {
  return openCodeInstallVersionAction({ version, domestic });
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
  const binary = findToolBinary('opencode', { passive: process.platform === 'win32' });
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
  const binary = findToolBinary('openclaw', { passive: process.platform === 'win32' });

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
  const gatewayPortOccupants = process.platform === 'win32' ? [] : await inspectOpenClawPortOccupants(gatewayPort);
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

export async function updateOpenClawDomestic() {
  const setup = await prepareOpenClawWindowsInstall();
  return runCommand(npmCommand(), ['install', '-g', 'openclaw@latest', '--registry', NPM_REGISTRY_CN], { env: setup.env });
}

export async function installOpenClawVersion({ version, domestic = false } = {}) {
  const setup = await prepareOpenClawWindowsInstall();
  const args = ['install', '-g', npmPackageVersionSpec(OPENCLAW_PACKAGE, version)];
  if (domestic) args.push('--registry', NPM_REGISTRY_CN);
  const result = await runCommand(npmCommand(), args, { env: setup.env });
  return { ...result, command: `${npmCommand()} ${args.join(' ')}` };
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
