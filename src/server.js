import crypto from 'node:crypto';
import express from 'express';
import open from 'open';
import fs from 'node:fs/promises';
import { createWriteStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  detectProvider,
} from './lib/provider-check.js';
import {
  checkSetupEnvironment,
  getProviderSecret,
  getCodexReleaseInfo,
  getCodexUsageMetrics,
  getOpenCodeUsageMetrics,
  listCodexSessions,
  getSystemStorageState,
  installClaudeCode,
  installOpenCode,
  installCodex,
  installOpenClaw,
  installOpenClawRemote,
  killOpenClawPortOccupants,
  cancelOpenClawInstallTask,
  cancelOpenCodeInstallTask,
  getOpenClawInstallTask,
  getOpenCodeInstallTask,
  getOpenClawDashboardUrl,
  onboardOpenClaw,
  repairOpenClawDashboardAuth,
  launchClaudeCode,
  launchOpenCode,
  loadOpenCodeState,
  loginClaudeCode,
  loginOpenCode,
  logoutOpenCodeAuth,
  launchCodex,
  loginCodex,
  resumeCodexSession,
  forkCodexSession,
  launchOpenClaw,
  listBackups,
  listTools,
  loadClaudeCodeState,
  loadOpenClawState,
  loadState,
  reinstallClaudeCode,
  reinstallOpenCode,
  reinstallCodex,
  reinstallOpenClaw,
  restoreBackup,
  saveClaudeCodeConfig,
  saveClaudeCodeRawConfig,
  saveOpenCodeConfig,
  saveOpenCodeRawConfig,
  saveConfig,
  saveOpenClawConfig,
  saveRawConfig,
  saveSettings,
  cleanupSystemStorage,
  startOpenClawInstallTask,
  startOpenCodeInstallTask,
  stopOpenClaw,
  setOpenClawDaemonEnabled,
  testSavedProvider,
  uninstallClaudeCode,
  uninstallOpenCode,
  uninstallCodex,
  uninstallOpenClaw,
  updateClaudeCode,
  updateOpenCode,
  updateCodex,
  updateOpenClaw,
} from './lib/config-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');
const LOCAL_API_TOKEN_HEADER = 'x-local-token';

function ok(res, data) {
  res.json({ ok: true, ...data });
}

function fail(res, error) {
  res.status(400).json({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

function forbidden(res, message = 'Forbidden') {
  res.status(403).json({ ok: false, error: message });
}

function createLocalApiToken() {
  return crypto.randomBytes(32).toString('hex');
}

const ALLOWED_PATH_ROOTS = [
  os.homedir(),
  process.cwd(),
  '/tmp',
  '/var/tmp',
  process.platform === 'win32' ? process.env.TEMP : null,
  process.platform === 'win32' ? process.env.TMP : null,
].filter(Boolean);

function isPathAllowed(userPath) {
  if (!userPath || typeof userPath !== 'string') return false;
  const normalized = path.resolve(userPath);
  return ALLOWED_PATH_ROOTS.some((root) => normalized.startsWith(root + path.sep) || normalized === root);
}

function validatePathOrThrow(userPath, paramName = 'path') {
  if (userPath && !isPathAllowed(userPath)) {
    throw new Error(`Invalid ${paramName}: path traversal detected`);
  }
  return userPath;
}


const OPENCODE_DESKTOP_TASKS = new Map();
const OPENCODE_DESKTOP_TASK_TTL_MS = 30 * 60 * 1000;
let opencodeDesktopTaskSeq = 0;
const CODEX_APP_MAC_DOWNLOAD_URL = 'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg';
const CODEX_APP_WIN_STORE_URL = 'https://apps.microsoft.com/detail/9plm9xgg6vks';
const CODEX_APP_WIN_STORE_URI = 'ms-windows-store://pdp/?ProductId=9PLM9XGG6VKS';
const CODEX_APP_DOCS_URL = 'https://developers.openai.com/codex/app';

const OPENCODE_DESKTOP_DOWNLOADS = {
  darwin: {
    arm64: {
      url: 'https://opencode.ai/download/stable/darwin-aarch64',
      fileName: 'OpenCode-Desktop-macOS-AppleSilicon.dmg',
    },
    x64: {
      url: 'https://opencode.ai/download/stable/darwin-x64',
      fileName: 'OpenCode-Desktop-macOS-Intel.dmg',
    },
  },
  win32: {
    x64: {
      url: 'https://opencode.ai/download/stable/windows-x64-nsis',
      fileName: 'OpenCode-Desktop-Setup.exe',
    },
    arm64: {
      url: 'https://opencode.ai/download/stable/windows-x64-nsis',
      fileName: 'OpenCode-Desktop-Setup.exe',
    },
  },
};


const OPENCODE_VSCODE_EXTENSION_ID = 'sst-dev.opencode';
const OPENCODE_GITHUB_WORKFLOW_TEMPLATE = `name: opencode

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  opencode:
    if: |
      contains(github.event.comment.body, '/oc') ||
      contains(github.event.comment.body, '/opencode')
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          fetch-depth: 1
          persist-credentials: false

      - name: Run OpenCode
        uses: anomalyco/opencode/github@latest
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: anthropic/claude-sonnet-4-20250514
          # share: true
          # github_token: xxxx
`;
const OPENCODE_GITLAB_TEMPLATE = `include:
  - component: \${CI_SERVER_FQDN}/nagyv/gitlab-opencode/opencode@2
    inputs:
      config_dir: \${CI_PROJECT_DIR}/opencode-config
      auth_json: \$OPENCODE_AUTH_JSON
      command: optional-custom-command
      message: "Your prompt here"
`;
const OPENCODE_ECOSYSTEM_EDITOR_SPECS = {
  vscode: { label: 'VS Code', command: 'code', type: 'vscode' },
  cursor: { label: 'Cursor', command: 'cursor', type: 'vscode' },
  windsurf: { label: 'Windsurf', command: 'windsurf', type: 'vscode' },
  vscodium: { label: 'VSCodium', command: 'codium', type: 'vscode' },
  zed: { label: 'Zed', command: 'zed', type: 'zed' },
};

function getCodexAppInstallationCandidates() {
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Codex.app');
    candidates.push(path.join(os.homedir(), 'Applications', 'Codex.app'));
  } else if (process.platform === 'win32') {
    candidates.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Codex', 'Codex.exe'));
    candidates.push(path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local', 'Programs', 'Codex', 'Codex.exe'));
  }
  return candidates;
}

function getCodexAppState() {
  const supported = process.platform === 'darwin' || process.platform === 'win32';
  const installPath = getCodexAppInstallationCandidates().find((item) => existsSync(item)) || '';
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform;
  const downloadUrl = process.platform === 'darwin'
    ? CODEX_APP_MAC_DOWNLOAD_URL
    : process.platform === 'win32'
      ? CODEX_APP_WIN_STORE_URL
      : CODEX_APP_DOCS_URL;
  return {
    toolId: 'codex-app',
    platform,
    supported,
    installed: Boolean(installPath),
    installPath,
    downloadUrl,
    docsUrl: CODEX_APP_DOCS_URL,
    storeUrl: CODEX_APP_WIN_STORE_URL,
  };
}

async function installCodexAppDesktop() {
  if (process.platform === 'darwin') {
    await open(CODEX_APP_MAC_DOWNLOAD_URL);
    return { ok: true, method: 'download', url: CODEX_APP_MAC_DOWNLOAD_URL, message: '已开始下载 Codex App 安装包（dmg）' };
  }
  if (process.platform === 'win32') {
    try {
      await open(CODEX_APP_WIN_STORE_URI);
      return { ok: true, method: 'store', url: CODEX_APP_WIN_STORE_URI, message: '已打开 Microsoft Store，可直接安装 Codex App' };
    } catch {
      await open(CODEX_APP_WIN_STORE_URL);
      return { ok: true, method: 'store-web', url: CODEX_APP_WIN_STORE_URL, message: '已打开 Microsoft Store 网页，请继续安装 Codex App' };
    }
  }
  throw new Error('当前系统暂不支持 Codex App 一键安装');
}

async function openCodexAppDesktop() {
  const state = getCodexAppState();
  if (state.installed && state.installPath) {
    await open(state.installPath);
    return { ok: true, opened: true, path: state.installPath };
  }
  return installCodexAppDesktop();
}

function nowIso() {
  return new Date().toISOString();
}

function quotePosixArg(value = '') {
  return `'${String(value).replace(/'/g, `"'"'`)}'`;
}

function quotePowerShellText(value = '') {
  return String(value).replace(/'/g, "''");
}

function runCommandLocal(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function commandExistsLocal(command) {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const result = runCommandLocal(lookup, [command]);
  return result.ok ? String(result.stdout || '').split(/\r?\n/).find(Boolean) || '' : '';
}

function cleanupOpenCodeDesktopTasks() {
  const now = Date.now();
  for (const [taskId, task] of OPENCODE_DESKTOP_TASKS.entries()) {
    if (task.status !== 'running' && task.status !== 'cancelling' && (now - task.updatedAtTs) > OPENCODE_DESKTOP_TASK_TTL_MS) {
      OPENCODE_DESKTOP_TASKS.delete(taskId);
    }
  }
}

function normalizeOpenCodeDesktopArch() {
  if (process.arch === 'arm64') return 'arm64';
  return 'x64';
}

function getOpenCodeDesktopSpec() {
  const platform = process.platform;
  const arch = normalizeOpenCodeDesktopArch();
  const platformSpec = OPENCODE_DESKTOP_DOWNLOADS[platform] || null;
  const download = platformSpec ? (platformSpec[arch] || platformSpec.x64 || null) : null;
  return {
    platform,
    arch,
    supported: Boolean(download),
    download,
  };
}

function getOpenCodeDesktopCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/OpenCode.app',
      path.join(os.homedir(), 'Applications', 'OpenCode.app'),
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles?.trim() || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)']?.trim() || 'C:\\Program Files (x86)';
    return [
      path.join(localAppData, 'Programs', 'OpenCode', 'OpenCode.exe'),
      path.join(localAppData, 'Programs', 'opencode-desktop', 'OpenCode.exe'),
      path.join(programFiles, 'OpenCode', 'OpenCode.exe'),
      path.join(programFilesX86, 'OpenCode', 'OpenCode.exe'),
    ];
  }
  return [];
}

async function getOpenCodeDesktopState() {
  const spec = getOpenCodeDesktopSpec();
  const installPath = getOpenCodeDesktopCandidates().find((candidate) => existsSync(candidate)) || '';
  return {
    toolId: 'opencode-desktop',
    name: 'OpenCode Desktop',
    platform: spec.platform,
    arch: spec.arch,
    supported: spec.supported,
    installed: Boolean(installPath),
    installPath,
    downloadUrl: spec.download?.url || '',
    fileName: spec.download?.fileName || '',
    recommendedMethod: spec.platform === 'darwin' ? (commandExistsLocal('brew') ? 'brew' : 'direct') : 'direct',
    brewAvailable: Boolean(commandExistsLocal('brew')),
  };
}

function createOpenCodeDesktopTask({ reinstall = false } = {}) {
  cleanupOpenCodeDesktopTasks();
  const steps = [
    { key: 'inspect', title: '检查系统环境', description: '识别当前系统、架构与桌面版状态', status: 'running', progress: 10 },
    { key: 'download', title: '下载桌面安装器', description: '通过内置下载器拉取官方桌面版安装包', status: 'pending', progress: 46 },
    { key: 'install', title: '自动安装并启动', description: '自动安装桌面版并尝试直接打开', status: 'pending', progress: 88 },
  ];
  const startedAt = nowIso();
  const task = {
    id: `opencode-desktop-${Date.now()}-${opencodeDesktopTaskSeq += 1}`,
    toolId: 'opencode-desktop',
    action: 'desktop-install',
    reinstall,
    status: 'running',
    progress: 10,
    stepIndex: 0,
    summary: reinstall ? '正在重装 OpenCode Desktop…' : '正在安装 OpenCode Desktop…',
    hint: '会自动下载并拉起安装器，你不需要手动找安装包。',
    detail: '正在检查当前系统环境…',
    steps,
    logs: [],
    startedAt,
    updatedAt: startedAt,
    updatedAtTs: Date.now(),
    completedAt: null,
    error: null,
    _abortController: null,
    _downloadPath: '',
    _cancelRequested: false,
  };
  OPENCODE_DESKTOP_TASKS.set(task.id, task);
  return task;
}

function touchOpenCodeDesktopTask(task) {
  task.updatedAt = nowIso();
  task.updatedAtTs = Date.now();
}

function setOpenCodeDesktopStep(task, stepIndex, overrides = {}) {
  const safeStepIndex = Math.max(0, Math.min(stepIndex, task.steps.length - 1));
  task.stepIndex = safeStepIndex;
  task.progress = Math.max(task.progress, overrides.progress || task.steps[safeStepIndex]?.progress || task.progress);
  if (overrides.summary) task.summary = overrides.summary;
  if (overrides.hint) task.hint = overrides.hint;
  if (overrides.detail) task.detail = overrides.detail;
  task.steps = task.steps.map((step, index) => ({
    ...step,
    status: index < safeStepIndex ? 'done' : index == safeStepIndex ? (overrides.status || 'running') : 'pending',
  }));
  touchOpenCodeDesktopTask(task);
}

function pushOpenCodeDesktopTaskLog(task, source, text) {
  const cleaned = String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!cleaned) return;
  task.logs.push({ source, text: cleaned, at: nowIso() });
  if (task.logs.length > 180) task.logs.shift();
  task.detail = cleaned;
  touchOpenCodeDesktopTask(task);
}

function serializeOpenCodeDesktopTask(task) {
  return {
    taskId: task.id,
    toolId: task.toolId,
    action: task.action,
    status: task.status,
    progress: task.progress,
    stepIndex: task.stepIndex,
    summary: task.summary,
    hint: task.hint,
    detail: task.detail,
    steps: task.steps,
    logs: task.logs.slice(-24),
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    error: task.error,
  };
}

function finalizeOpenCodeDesktopCancelled(task, reason = '') {
  task.status = 'cancelled';
  task.progress = 100;
  task.completedAt = nowIso();
  task.error = null;
  task.summary = 'OpenCode Desktop 安装已中断';
  task.hint = '如需继续，重新点击“一键安装”即可。';
  task.detail = reason || '已按你的要求中断本次桌面版安装。';
  task.steps = task.steps.map((step, index) => ({
    ...step,
    status: index < task.stepIndex ? 'done' : index === task.stepIndex ? 'cancelled' : 'pending',
  }));
  touchOpenCodeDesktopTask(task);
}

async function cancelOpenCodeDesktopInstallTask({ taskId } = {}) {
  cleanupOpenCodeDesktopTasks();
  const task = OPENCODE_DESKTOP_TASKS.get(String(taskId || '').trim());
  if (!task) throw new Error('OpenCode Desktop 任务不存在，可能已过期');
  if (task.status === 'success' || task.status === 'error' || task.status === 'cancelled') {
    return serializeOpenCodeDesktopTask(task);
  }
  if (task.stepIndex >= 2 && !task._abortController) {
    throw new Error('安装器已经启动，当前阶段暂不支持立即中断，请等待本步骤完成');
  }
  task._cancelRequested = true;
  task.status = 'cancelling';
  task.summary = '正在中断 OpenCode Desktop 安装…';
  task.hint = '正在停止下载任务并清理临时状态。';
  task.detail = '已收到中断请求，正在处理…';
  pushOpenCodeDesktopTaskLog(task, 'stderr', '已收到中断请求，正在停止下载 / 安装任务…');
  if (task._abortController) task._abortController.abort();
  touchOpenCodeDesktopTask(task);
  return serializeOpenCodeDesktopTask(task);
}

async function downloadOpenCodeDesktopInstaller(task, url, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const controller = new AbortController();
  task._abortController = controller;
  const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
  if (!response.ok || !response.body) {
    throw new Error(`下载安装器失败：HTTP ${response.status}`);
  }
  const totalBytes = Number(response.headers.get('content-length') || 0);
  const writer = createWriteStream(destinationPath);
  const stream = Readable.fromWeb(response.body);
  let downloadedBytes = 0;
  let nextLogBytes = totalBytes ? Math.max(1, Math.floor(totalBytes / 10)) : 5 * 1024 * 1024;
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (downloadedBytes >= nextLogBytes) {
        const downloadedMb = (downloadedBytes / 1024 / 1024).toFixed(1);
        const totalMb = totalBytes ? (totalBytes / 1024 / 1024).toFixed(1) : '?';
        pushOpenCodeDesktopTaskLog(task, 'stdout', `已下载 ${downloadedMb} MB / ${totalMb} MB`);
        task.progress = Math.max(task.progress, Math.min(80, 46 + Math.floor((downloadedBytes / Math.max(totalBytes || downloadedBytes, 1)) * 32)));
        nextLogBytes += totalBytes ? Math.max(1, Math.floor(totalBytes / 10)) : 5 * 1024 * 1024;
      }
    });
    stream.on('error', reject);
    writer.on('error', reject);
    writer.on('finish', resolve);
    stream.pipe(writer);
  });
  task._abortController = null;
  task._downloadPath = destinationPath;
  pushOpenCodeDesktopTaskLog(task, 'stdout', `安装器下载完成：${destinationPath}`);
  return destinationPath;
}

function parseMountedVolume(text = '') {
  const line = String(text || '').split(/\r?\n/).map((item) => item.trim()).find((item) => item.includes('/Volumes/')) || '';
  const match = line.match(/(\/Volumes\/.+)$/);
  return match ? match[1].trim() : '';
}

async function installOpenCodeDesktopOnMac(task, installerPath) {
  pushOpenCodeDesktopTaskLog(task, 'stdout', '正在挂载 DMG 镜像…');
  const attach = runCommandLocal('hdiutil', ['attach', '-nobrowse', installerPath]);
  if (!attach.ok) throw new Error((attach.stderr || attach.stdout || '挂载 DMG 失败').trim());
  const mountPoint = parseMountedVolume(`${attach.stdout}
${attach.stderr}`);
  if (!mountPoint) throw new Error('无法识别 DMG 挂载路径');
  pushOpenCodeDesktopTaskLog(task, 'stdout', `已挂载：${mountPoint}`);
  const entries = await fs.readdir(mountPoint, { withFileTypes: true });
  const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (!appEntry) throw new Error('DMG 中未找到 .app 应用');
  const sourceAppPath = path.join(mountPoint, appEntry.name);
  const appTargets = ['/Applications', path.join(os.homedir(), 'Applications')];
  let installedPath = '';
  for (const appDir of appTargets) {
    await fs.mkdir(appDir, { recursive: true }).catch(() => {});
    const targetAppPath = path.join(appDir, appEntry.name);
    const script = `rm -rf ${quotePosixArg(targetAppPath)} && cp -R ${quotePosixArg(sourceAppPath)} ${quotePosixArg(appDir)}`;
    const copy = runCommandLocal('sh', ['-lc', script]);
    pushOpenCodeDesktopTaskLog(task, copy.ok ? 'stdout' : 'stderr', copy.ok ? `已复制到 ${targetAppPath}` : (copy.stderr || copy.stdout || `复制到 ${targetAppPath} 失败`));
    if (copy.ok) {
      installedPath = targetAppPath;
      runCommandLocal('xattr', ['-dr', 'com.apple.quarantine', targetAppPath]);
      break;
    }
  }
  runCommandLocal('hdiutil', ['detach', mountPoint]);
  if (!installedPath) throw new Error('无法把 OpenCode.app 安装到 Applications');
  pushOpenCodeDesktopTaskLog(task, 'stdout', '正在打开 OpenCode Desktop…');
  await open(installedPath);
  return { installedPath, opened: true };
}

async function installOpenCodeDesktopOnWindows(task, installerPath) {
  pushOpenCodeDesktopTaskLog(task, 'stdout', '正在尝试静默安装 Windows 桌面版…');
  const silentScript = `$p = Start-Process -FilePath '${quotePowerShellText(installerPath)}' -ArgumentList '/S' -Wait -PassThru; exit $p.ExitCode`;
  const silent = runCommandLocal('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', silentScript]);
  if (!silent.ok) {
    pushOpenCodeDesktopTaskLog(task, 'stderr', silent.stderr || silent.stdout || '静默安装失败，准备打开图形安装器');
    await open(installerPath);
    return { openedInstaller: true, installedPath: '' };
  }
  const state = await getOpenCodeDesktopState();
  if (state.installPath) {
    pushOpenCodeDesktopTaskLog(task, 'stdout', '安装完成，正在打开 OpenCode Desktop…');
    await open(state.installPath);
    return { openedInstaller: false, installedPath: state.installPath };
  }
  await open(installerPath);
  return { openedInstaller: true, installedPath: '' };
}

async function runOpenCodeDesktopInstallTask(task) {
  try {
    const state = await getOpenCodeDesktopState();
    if (!state.supported) throw new Error('当前系统暂不支持一键安装 OpenCode Desktop');
    pushOpenCodeDesktopTaskLog(task, 'stdout', `当前系统：${state.platform} / ${state.arch}`);
    if (state.installed && !task.reinstall) {
      pushOpenCodeDesktopTaskLog(task, 'stdout', `已检测到桌面版：${state.installPath}`);
      task.status = 'success';
      task.progress = 100;
      task.completedAt = nowIso();
      task.summary = 'OpenCode Desktop 已安装';
      task.hint = '你可以直接点“打开桌面版”。';
      task.steps = task.steps.map((step) => ({ ...step, status: 'done' }));
      touchOpenCodeDesktopTask(task);
      return;
    }

    if (task._cancelRequested) {
      finalizeOpenCodeDesktopCancelled(task);
      return;
    }

    setOpenCodeDesktopStep(task, 1, {
      summary: '正在下载 OpenCode Desktop 安装器…',
      hint: '下载完成后会自动继续安装。',
      detail: `下载地址：${state.downloadUrl}`,
      progress: 46,
    });
    const downloadsDir = path.join(os.homedir(), 'Downloads', 'EasyAIConfig');
    const installerPath = await downloadOpenCodeDesktopInstaller(task, state.downloadUrl, path.join(downloadsDir, state.fileName));

    if (task._cancelRequested) {
      finalizeOpenCodeDesktopCancelled(task);
      return;
    }

    setOpenCodeDesktopStep(task, 2, {
      summary: '正在自动安装 OpenCode Desktop…',
      hint: process.platform === 'darwin' ? '会自动安装到 Applications 并尝试打开。' : '会自动拉起安装器并尽量直接完成安装。',
      detail: installerPath,
      progress: 88,
    });

    if (process.platform === 'darwin') {
      await installOpenCodeDesktopOnMac(task, installerPath);
    } else if (process.platform === 'win32') {
      await installOpenCodeDesktopOnWindows(task, installerPath);
    } else {
      throw new Error('当前平台暂未接入桌面版自动安装');
    }

    task.status = 'success';
    task.progress = 100;
    task.completedAt = nowIso();
    task.summary = 'OpenCode Desktop 安装完成';
    task.hint = '桌面版已经为你准备好。';
    task.steps = task.steps.map((step) => ({ ...step, status: 'done' }));
    touchOpenCodeDesktopTask(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = task._cancelRequested || (error instanceof Error && error.name === 'AbortError');
    if (aborted) {
      pushOpenCodeDesktopTaskLog(task, 'stderr', '安装任务已中断');
      finalizeOpenCodeDesktopCancelled(task, '已停止当前下载安装任务。');
      if (task._downloadPath) await fs.rm(task._downloadPath, { force: true }).catch(() => {});
    } else {
      task.status = 'error';
      task.error = message;
      task.completedAt = nowIso();
      task.summary = 'OpenCode Desktop 安装失败';
      task.hint = '先看最后日志，通常会直接说明是下载、权限还是安装器问题。';
      pushOpenCodeDesktopTaskLog(task, 'stderr', task.error);
      touchOpenCodeDesktopTask(task);
    }
  } finally {
    task._abortController = null;
  }
}

async function startOpenCodeDesktopInstallTask({ reinstall = false } = {}) {
  const task = createOpenCodeDesktopTask({ reinstall: Boolean(reinstall) });
  void runOpenCodeDesktopInstallTask(task);
  return serializeOpenCodeDesktopTask(task);
}

async function getOpenCodeDesktopInstallTask({ taskId } = {}) {
  cleanupOpenCodeDesktopTasks();
  const task = OPENCODE_DESKTOP_TASKS.get(String(taskId || '').trim());
  if (!task) throw new Error('OpenCode Desktop 任务不存在，可能已过期');
  return serializeOpenCodeDesktopTask(task);
}

async function openOpenCodeDesktopApp() {
  const state = await getOpenCodeDesktopState();
  if (!state.installed || !state.installPath) throw new Error('当前未检测到 OpenCode Desktop');
  await open(state.installPath);
  return { opened: true, installPath: state.installPath };
}


function listCommandOutputLines(text = '') {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function resolveGitRepoRootLocal(cwd = '') {
  let current = path.resolve(cwd || process.cwd());
  while (current) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return '';
}

function resolveGitDirLocal(repoRoot = '') {
  if (!repoRoot) return '';
  const gitEntry = path.join(repoRoot, '.git');
  if (!existsSync(gitEntry)) return '';
  try {
    const raw = readFileSync(gitEntry, 'utf8');
    const match = raw.match(/^gitdir:\s*(.+)\s*$/im);
    if (match) return path.resolve(repoRoot, match[1].trim());
  } catch { /* .git is a directory */ }
  return gitEntry;
}

function readGitOriginUrlLocal(repoRoot = '') {
  const gitDir = resolveGitDirLocal(repoRoot);
  if (!gitDir) return '';
  const configPath = path.join(gitDir, 'config');
  if (!existsSync(configPath)) return '';
  try {
    const raw = readFileSync(configPath, 'utf8');
    const block = raw.match(/\[remote\s+"origin"\]([\s\S]*?)(?:\n\[|$)/i);
    const url = block?.[1]?.match(/^\s*url\s*=\s*(.+)\s*$/im)?.[1] || '';
    return String(url || '').trim();
  } catch {
    return '';
  }
}

function detectGitHosting(cwd = '') {
  const repoRoot = resolveGitRepoRootLocal(cwd);
  if (!repoRoot) return { repoRoot: '', provider: '' };
  const remoteUrl = readGitOriginUrlLocal(repoRoot).toLowerCase();
  const provider = remoteUrl.includes('github') ? 'github' : remoteUrl.includes('gitlab') ? 'gitlab' : '';
  return { repoRoot, provider };
}

async function readJsonFileSafe(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function getZedSettingsPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming'), 'Zed', 'settings.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), '.config', 'zed', 'settings.json');
  }
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(configHome, 'zed', 'settings.json');
}

function getZedExtensionsInstalledPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local'), 'Zed', 'extensions', 'installed');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Zed', 'extensions', 'installed');
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'zed', 'extensions', 'installed');
}

function getVSCodeLikeExtensionDirs(commandName) {
  const home = os.homedir();
  const mapping = {
    code: [path.join(home, '.vscode', 'extensions')],
    cursor: [path.join(home, '.cursor', 'extensions')],
    windsurf: [path.join(home, '.windsurf', 'extensions')],
    codium: [path.join(home, '.vscode-oss', 'extensions'), path.join(home, '.vscodium', 'extensions')],
  };
  return mapping[commandName] || [];
}

function getVSCodeLikeCommandCandidates(commandName) {
  if (process.platform !== 'win32') return [];
  const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles?.trim() || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)']?.trim() || 'C:\\Program Files (x86)';
  const mapping = {
    code: [
      path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
      path.join(programFiles, 'Microsoft VS Code', 'bin', 'code.cmd'),
      path.join(programFilesX86, 'Microsoft VS Code', 'bin', 'code.cmd'),
    ],
    cursor: [
      path.join(localAppData, 'Programs', 'Cursor', 'resources', 'app', 'bin', 'cursor.cmd'),
      path.join(localAppData, 'Programs', 'Cursor', 'bin', 'cursor.cmd'),
    ],
    windsurf: [
      path.join(localAppData, 'Programs', 'Windsurf', 'resources', 'app', 'bin', 'windsurf.cmd'),
      path.join(localAppData, 'Programs', 'Windsurf', 'bin', 'windsurf.cmd'),
    ],
    codium: [
      path.join(localAppData, 'Programs', 'VSCodium', 'bin', 'codium.cmd'),
      path.join(programFiles, 'VSCodium', 'bin', 'codium.cmd'),
      path.join(programFilesX86, 'VSCodium', 'bin', 'codium.cmd'),
    ],
  };
  return mapping[commandName] || [];
}

function hasOpenCodeExtensionInstalled(dirPaths = []) {
  const prefix = `${OPENCODE_VSCODE_EXTENSION_ID.toLowerCase()}-`;
  for (const dirPath of dirPaths) {
    if (!dirPath || !existsSync(dirPath)) continue;
    try {
      const entries = readdirSync(dirPath);
      if (entries.some((entry) => {
        const lower = String(entry || '').toLowerCase();
        return lower === OPENCODE_VSCODE_EXTENSION_ID || lower.startsWith(prefix);
      })) {
        return true;
      }
    } catch { /* ignore */ }
  }
  return false;
}

function findKnownCommandPath(commandName) {
  return getVSCodeLikeCommandCandidates(commandName).find((candidate) => existsSync(candidate)) || '';
}

function getVSCodeLikeExtensionState(commandName, { passive = false } = {}) {
  const extensionDirs = getVSCodeLikeExtensionDirs(commandName);
  const installedFromDisk = hasOpenCodeExtensionInstalled(extensionDirs);
  const knownCommandPath = findKnownCommandPath(commandName);
  if (passive && process.platform === 'win32') {
    return {
      available: Boolean(knownCommandPath || extensionDirs.some((dirPath) => existsSync(dirPath))),
      commandPath: knownCommandPath,
      installed: installedFromDisk,
    };
  }
  const commandPath = knownCommandPath || commandExistsLocal(commandName);
  if (!commandPath) {
    return { available: installedFromDisk, commandPath: '', installed: installedFromDisk };
  }
  if (installedFromDisk) {
    return { available: true, commandPath, installed: true };
  }
  const result = runCommandLocal(commandName, ['--list-extensions']);
  const installed = result.ok && listCommandOutputLines(result.stdout).some((item) => item.toLowerCase() === OPENCODE_VSCODE_EXTENSION_ID);
  return { available: true, commandPath, installed };
}

function findKnownZedCommandPath() {
  if (process.platform !== 'win32') return '';
  const localAppData = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles?.trim() || 'C:\\Program Files';
  return [
    path.join(localAppData, 'Programs', 'Zed', 'Zed.exe'),
    path.join(programFiles, 'Zed', 'Zed.exe'),
  ].find((candidate) => existsSync(candidate)) || '';
}

async function getZedExtensionState({ passive = false } = {}) {
  const settingsPath = getZedSettingsPath();
  const settings = await readJsonFileSafe(settingsPath);
  const autoInstall = Boolean(settings?.auto_install_extensions?.opencode === true);
  const extensionsDir = getZedExtensionsInstalledPath();
  const installedDir = path.join(extensionsDir, 'opencode');
  const knownCommandPath = findKnownZedCommandPath();
  const commandPath = passive && process.platform === 'win32' ? knownCommandPath : (knownCommandPath || commandExistsLocal('zed'));
  return {
    available: Boolean(commandPath || existsSync(settingsPath) || existsSync(extensionsDir)),
    commandPath,
    settingsPath,
    installed: autoInstall || existsSync(installedDir),
    autoInstallEnabled: autoInstall,
  };
}

async function getOpenCodeEcosystemState({ cwd = '' } = {}) {
  const passiveWindows = process.platform === 'win32';
  const vscode = getVSCodeLikeExtensionState('code', { passive: passiveWindows });
  const cursor = getVSCodeLikeExtensionState('cursor', { passive: passiveWindows });
  const windsurf = getVSCodeLikeExtensionState('windsurf', { passive: passiveWindows });
  const vscodium = getVSCodeLikeExtensionState('codium', { passive: passiveWindows });
  const zed = await getZedExtensionState({ passive: passiveWindows });
  const repo = detectGitHosting(cwd);
  const githubWorkflowPath = repo.repoRoot ? path.join(repo.repoRoot, '.github', 'workflows', 'opencode.yml') : '';
  const gitlabCiPath = repo.repoRoot ? path.join(repo.repoRoot, '.gitlab-ci.yml') : '';
  const gitlabTemplatePath = repo.repoRoot ? path.join(repo.repoRoot, 'opencode.gitlab-ci.yml') : '';
  const gitlabContent = gitlabCiPath && existsSync(gitlabCiPath) ? await fs.readFile(gitlabCiPath, 'utf8').catch(() => '') : '';
  return {
    repoRoot: repo.repoRoot,
    repoProvider: repo.provider,
    targets: {
      vscode: { ...vscode, label: 'VS Code', actionLabel: vscode.installed ? '重装扩展' : '安装扩展' },
      cursor: { ...cursor, label: 'Cursor', actionLabel: cursor.installed ? '重装扩展' : '安装扩展' },
      windsurf: { ...windsurf, label: 'Windsurf', actionLabel: windsurf.installed ? '重装扩展' : '安装扩展' },
      vscodium: { ...vscodium, label: 'VSCodium', actionLabel: vscodium.installed ? '重装扩展' : '安装扩展' },
      zed: { ...zed, label: 'Zed', actionLabel: zed.installed ? '刷新配置' : '配置自动安装' },
      github: {
        available: Boolean(repo.repoRoot),
        installed: Boolean(githubWorkflowPath && existsSync(githubWorkflowPath)),
        repoRoot: repo.repoRoot,
        workflowPath: githubWorkflowPath,
        actionLabel: githubWorkflowPath && existsSync(githubWorkflowPath) ? '查看工作流' : '初始化仓库',
      },
      gitlab: {
        available: Boolean(repo.repoRoot),
        installed: Boolean((gitlabCiPath && gitlabContent.includes('gitlab-opencode')) || (gitlabTemplatePath && existsSync(gitlabTemplatePath))),
        repoRoot: repo.repoRoot,
        workflowPath: gitlabTemplatePath,
        actionLabel: (gitlabTemplatePath && existsSync(gitlabTemplatePath)) ? '重写模板' : '生成模板',
      },
    },
  };
}

async function installVSCodeLikeOpenCodeExtension(target) {
  const spec = OPENCODE_ECOSYSTEM_EDITOR_SPECS[target];
  if (!spec) throw new Error('未知的编辑器目标');
  const state = getVSCodeLikeExtensionState(spec.command);
  if (!state.available) throw new Error(`${spec.label} CLI 不可用，请先安装并把命令加入 PATH`);
  const result = runCommandLocal(spec.command, ['--install-extension', OPENCODE_VSCODE_EXTENSION_ID, '--force']);
  if (!result.ok) throw new Error((result.stderr || result.stdout || `${spec.label} 扩展安装失败`).trim());
  return {
    target,
    installed: true,
    command: `${spec.command} --install-extension ${OPENCODE_VSCODE_EXTENSION_ID} --force`,
    message: `${spec.label} 的 OpenCode 扩展已安装`,
  };
}

async function installZedOpenCodeExtension({ cwd = '' } = {}) {
  const settingsPath = getZedSettingsPath();
  const settings = await readJsonFileSafe(settingsPath);
  const next = {
    ...settings,
    auto_install_extensions: {
      ...(settings.auto_install_extensions || {}),
      opencode: true,
    },
  };
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}
`, 'utf8');
  const zedCommand = commandExistsLocal('zed');
  if (zedCommand) {
    const result = runCommandLocal('zed', [path.resolve(cwd || process.cwd())]);
    if (!result.ok) {
      return { target: 'zed', installed: true, settingsPath, message: '已写入 Zed 自动安装配置，请打开 Zed 让扩展自动装上' };
    }
  }
  return { target: 'zed', installed: true, settingsPath, message: '已写入 Zed 自动安装配置' };
}

async function installOpenCodeGitHubIntegration({ cwd = '' } = {}) {
  const { repoRoot } = detectGitHosting(cwd);
  if (!repoRoot) throw new Error('请先打开一个 Git 仓库，再初始化 GitHub 集成');
  const workflowPath = path.join(repoRoot, '.github', 'workflows', 'opencode.yml');
  await fs.mkdir(path.dirname(workflowPath), { recursive: true });
  if (!existsSync(workflowPath)) {
    await fs.writeFile(workflowPath, OPENCODE_GITHUB_WORKFLOW_TEMPLATE, 'utf8');
  }
  return {
    target: 'github',
    installed: true,
    workflowPath,
    repoRoot,
    message: 'GitHub 工作流已写入，请去 GitHub 安装 App 并配置 Secrets',
  };
}

async function installOpenCodeGitLabIntegration({ cwd = '' } = {}) {
  const repoRoot = resolveGitRepoRootLocal(cwd || process.cwd()) || path.resolve(cwd || process.cwd());
  const templatePath = path.join(repoRoot, 'opencode.gitlab-ci.yml');
  await fs.writeFile(templatePath, OPENCODE_GITLAB_TEMPLATE, 'utf8');
  return {
    target: 'gitlab',
    installed: true,
    workflowPath: templatePath,
    repoRoot,
    message: 'GitLab CI 模板已生成，请在 .gitlab-ci.yml 中 include 它并配置变量',
  };
}

async function installOpenCodeEcosystemTarget({ target = '', cwd = '' } = {}) {
  const normalizedTarget = String(target || '').trim().toLowerCase();
  if (!normalizedTarget) throw new Error('缺少安装目标');
  if (['vscode', 'cursor', 'windsurf', 'vscodium'].includes(normalizedTarget)) {
    return installVSCodeLikeOpenCodeExtension(normalizedTarget);
  }
  if (normalizedTarget === 'zed') {
    return installZedOpenCodeExtension({ cwd });
  }
  if (normalizedTarget === 'github') {
    return installOpenCodeGitHubIntegration({ cwd });
  }
  if (normalizedTarget === 'gitlab') {
    return installOpenCodeGitLabIntegration({ cwd });
  }
  throw new Error('暂不支持这个 OpenCode 生态目标');
}

export async function startServer() {
  const app = express();
  const localApiToken = createLocalApiToken();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/bootstrap') return next();
    const token = String(req.get(LOCAL_API_TOKEN_HEADER) || '');
    if (token !== localApiToken) {
      forbidden(res, 'Invalid local API token');
      return;
    }
    next();
  });
  app.use(express.static(publicDir));

  app.get('/api/bootstrap', (_req, res) => {
    ok(res, {
      data: {
        token: localApiToken,
        header: LOCAL_API_TOKEN_HEADER,
      },
    });
  });

  app.get('/api/tools', async (_req, res) => {
    try {
      ok(res, { data: listTools({ passive: process.platform === 'win32' }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/setup/check', async (req, res) => {
    try {
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      const data = await checkSetupEnvironment({
        codexHome: codexHome || undefined,
      });
      ok(res, { data });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/state', async (req, res) => {
    try {
      const projectPath = validatePathOrThrow(req.query.projectPath, 'projectPath');
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      const data = await loadState({
        scope: req.query.scope || 'global',
        projectPath: projectPath || '',
        codexHome: codexHome || undefined,
      });
      ok(res, { data });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/provider/test', async (req, res) => {
    try {
      const result = await detectProvider(req.body || {});
      ok(res, { data: result });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/provider/secret', async (req, res) => {
    try {
      ok(res, { data: await getProviderSecret(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/provider/test-saved', async (req, res) => {
    try {
      ok(res, { data: await testSavedProvider(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/config/save', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.baseUrl) throw new Error('Base URL is required');
      if (!body.providerKey) throw new Error('Provider key is required');
      const result = await saveConfig(body);
      ok(res, { data: result });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/config/raw-save', async (req, res) => {
    try {
      ok(res, { data: await saveRawConfig(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/config/settings-save', async (req, res) => {
    try {
      ok(res, { data: await saveSettings(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/install', async (_req, res) => {
    try {
      ok(res, { data: await installCodex() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/codex/release', async (_req, res) => {
    try {
      ok(res, { data: await getCodexReleaseInfo() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/reinstall', async (_req, res) => {
    try {
      ok(res, { data: await reinstallCodex() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/update', async (_req, res) => {
    try {
      ok(res, { data: await updateCodex() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/uninstall', async (_req, res) => {
    try {
      ok(res, { data: await uninstallCodex() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/launch', async (req, res) => {
    try {
      ok(res, { data: await launchCodex(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/login', async (req, res) => {
    try {
      ok(res, { data: await loginCodex(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

app.get('/api/codex/sessions', async (req, res) => {
    try {
      const cwd = validatePathOrThrow(req.query.cwd, 'cwd');
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      ok(res, { data: await listCodexSessions({
        cwd: cwd || undefined,
        codexHome: codexHome || undefined,
        limit: req.query.limit || undefined,
        all: req.query.all === '1' || req.query.all === 'true',
      }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/resume', async (req, res) => {
    try {
      ok(res, { data: await resumeCodexSession(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/fork', async (req, res) => {
    try {
      ok(res, { data: await forkCodexSession(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

app.get('/api/dashboard/codex-usage', async (req, res) => {
    try {
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      ok(res, { data: await getCodexUsageMetrics({
        codexHome: codexHome || undefined,
        days: req.query.days || undefined,
        force: req.query.force === '1' || req.query.force === 'true',
        cacheOnly: req.query.cacheOnly === '1' || req.query.cacheOnly === 'true',
      }) });
    } catch (error) {
      fail(res, error);
    }
  });

app.get('/api/dashboard/opencode-usage', async (req, res) => {
    try {
      ok(res, { data: await getOpenCodeUsageMetrics({
        days: req.query.days || undefined,
      }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/codex-app/state', async (_req, res) => {
    try {
      ok(res, { data: getCodexAppState() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex-app/install', async (_req, res) => {
    try {
      ok(res, { data: await installCodexAppDesktop() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex-app/open', async (_req, res) => {
    try {
      ok(res, { data: await openCodexAppDesktop() });
    } catch (error) {
      fail(res, error);
    }
  });

  // ─── Claude Code endpoints ───
  app.get('/api/claudecode/state', async (req, res) => {
    try {
      ok(res, { data: await loadClaudeCodeState(req.query || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/config-save', async (req, res) => {
    try {
      ok(res, { data: await saveClaudeCodeConfig(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/raw-save', async (req, res) => {
    try {
      ok(res, { data: await saveClaudeCodeRawConfig(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/install', async (_req, res) => {
    try {
      ok(res, { data: await installClaudeCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/reinstall', async (_req, res) => {
    try {
      ok(res, { data: await reinstallClaudeCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/update', async (_req, res) => {
    try {
      ok(res, { data: await updateClaudeCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/uninstall', async (_req, res) => {
    try {
      ok(res, { data: await uninstallClaudeCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/launch', async (req, res) => {
    try {
      ok(res, { data: await launchClaudeCode(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/login', async (req, res) => {
    try {
      ok(res, { data: await loginClaudeCode(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/opencode/state', async (req, res) => {
    try {
      ok(res, { data: await loadOpenCodeState(req.query || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/config-save', async (req, res) => {
    try {
      ok(res, { data: await saveOpenCodeConfig(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/raw-save', async (req, res) => {
    try {
      ok(res, { data: await saveOpenCodeRawConfig(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  // ─── OpenCode endpoints ───
  app.post('/api/opencode/install/start', async (req, res) => {
    try {
      ok(res, { data: await startOpenCodeInstallTask(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/opencode/install/status', async (req, res) => {
    try {
      ok(res, { data: await getOpenCodeInstallTask({ taskId: req.query.taskId || '' }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/install/cancel', async (req, res) => {
    try {
      ok(res, { data: await cancelOpenCodeInstallTask(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/install', async (req, res) => {
    try {
      ok(res, { data: await installOpenCode(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/reinstall', async (req, res) => {
    try {
      ok(res, { data: await reinstallOpenCode(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/update', async (req, res) => {
    try {
      ok(res, { data: await updateOpenCode(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/uninstall', async (req, res) => {
    try {
      ok(res, { data: await uninstallOpenCode(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/launch', async (req, res) => {
    try {
      ok(res, { data: await launchOpenCode(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/login', async (req, res) => {
    try {
      ok(res, { data: await loginOpenCode(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/auth-remove', async (req, res) => {
    try {
      ok(res, { data: await logoutOpenCodeAuth(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });


  app.get('/api/opencode/desktop/state', async (_req, res) => {
    try {
      ok(res, { data: await getOpenCodeDesktopState() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/desktop/install/start', async (req, res) => {
    try {
      ok(res, { data: await startOpenCodeDesktopInstallTask(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/opencode/desktop/install/status', async (req, res) => {
    try {
      ok(res, { data: await getOpenCodeDesktopInstallTask({ taskId: req.query.taskId || '' }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/desktop/install/cancel', async (req, res) => {
    try {
      ok(res, { data: await cancelOpenCodeDesktopInstallTask(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/desktop/open', async (_req, res) => {
    try {
      ok(res, { data: await openOpenCodeDesktopApp() });
    } catch (error) {
      fail(res, error);
    }
  });

app.get('/api/opencode/ecosystem/state', async (req, res) => {
    try {
      const cwd = validatePathOrThrow(req.query.cwd, 'cwd');
      ok(res, { data: await getOpenCodeEcosystemState({ cwd: cwd || '' }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/ecosystem/install', async (req, res) => {
    try {
      ok(res, { data: await installOpenCodeEcosystemTarget(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  // ─── OpenClaw endpoints ───
  app.get('/api/openclaw/state', async (_req, res) => {
    try {
      ok(res, { data: await loadOpenClawState() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/config-save', async (req, res) => {
    try {
      ok(res, { data: await saveOpenClawConfig(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/install', async (req, res) => {
    try {
      ok(res, { data: await installOpenClaw(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/install/start', async (req, res) => {
    try {
      ok(res, { data: await startOpenClawInstallTask(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/install/remote', async (req, res) => {
    try {
      ok(res, { data: await installOpenClawRemote(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/openclaw/install/status', async (req, res) => {
    try {
      ok(res, { data: await getOpenClawInstallTask({ taskId: req.query.taskId || '' }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/install/cancel', async (req, res) => {
    try {
      ok(res, { data: await cancelOpenClawInstallTask(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/update', async (_req, res) => {
    try {
      ok(res, { data: await updateOpenClaw() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/reinstall', async (_req, res) => {
    try {
      ok(res, { data: await reinstallOpenClaw() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/uninstall', async (req, res) => {
    try {
      ok(res, { data: await uninstallOpenClaw(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/launch', async (req, res) => {
    try {
      ok(res, { data: await launchOpenClaw(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/onboard', async (req, res) => {
    try {
      ok(res, { data: await onboardOpenClaw(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/dashboard-url', async (req, res) => {
    try {
      ok(res, { data: await getOpenClawDashboardUrl(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/repair-dashboard-auth', async (req, res) => {
    try {
      ok(res, { data: await repairOpenClawDashboardAuth(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/stop', async (_req, res) => {
    try {
      ok(res, { data: await stopOpenClaw() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/daemon', async (req, res) => {
    try {
      ok(res, { data: await setOpenClawDaemonEnabled(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/port-kill', async (req, res) => {
    try {
      ok(res, { data: await killOpenClawPortOccupants(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/system/storage', async (_req, res) => {
    try {
      ok(res, { data: await getSystemStorageState() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/system/cleanup', async (req, res) => {
    try {
      ok(res, { data: await cleanupSystemStorage(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/open-url', async (req, res) => {
    try {
      const url = String(req.body?.url || '').trim();
      if (!url) throw new Error('url is required');
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only http/https URLs are allowed');
      }
      await open(parsed.toString());
      ok(res, { data: { opened: true, url: parsed.toString() } });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/backups', async (_req, res) => {
    try {
      ok(res, { data: await listBackups() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/backups/restore', async (req, res) => {
    try {
      ok(res, { data: await restoreBackup(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.on('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 3210;
  const url = `http://127.0.0.1:${port}`;

  console.log(`[easyaiconfig] running at ${url}`);
  open(url).catch(() => { });

  return { app, server, url, localApiToken };
}
