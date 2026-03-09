import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import TOML from '@iarna/toml';
import { detectProvider } from './provider-check.js';

const APP_HOME_DIRNAME = '.codex-config-ui';
const BACKUPS_DIRNAME = 'backups';
const OPENAI_CODEX_PACKAGE = '@openai/codex';
const OPENCLAW_INSTALL_TASK_TTL_MS = 30 * 60 * 1000;
const OPENCLAW_INSTALL_TASKS = new Map();

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
    installMethods: ['script', 'npm', 'source', 'docker'],
  },
};

function getToolDef(toolId) {
  return TOOL_REGISTRY[toolId] || TOOL_REGISTRY.codex;
}

function findToolBinary(toolId) {
  const tool = getToolDef(toolId);
  const binaryName = tool.binaryName;

  const whichResult = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    [binaryName],
    { encoding: 'utf8' }
  );

  if (whichResult.status === 0) {
    const binPath = (whichResult.stdout || '').split(/\r?\n/).find(Boolean) || null;
    if (binPath) {
      const versionResult = spawnSync(binPath, ['--version'], { encoding: 'utf8' });
      return {
        installed: versionResult.status === 0,
        version: versionResult.status === 0 ? (versionResult.stdout || versionResult.stderr || '').trim() : null,
        path: binPath,
      };
    }
  }

  return { installed: false, version: null, path: null };
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

function appHome() {
  return path.join(os.homedir(), APP_HOME_DIRNAME);
}

function backupsRoot() {
  return path.join(appHome(), BACKUPS_DIRNAME);
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
  const result = spawnSync(lookup, [command], { encoding: 'utf8' });
  return result.status === 0 ? (result.stdout || '').split(/\r?\n/).find(Boolean) || null : null;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
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
  const result = spawnSync(npmCommand(), ['prefix', '-g'], { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function npmGlobalRoot() {
  const result = spawnSync(npmCommand(), ['root', '-g'], { encoding: 'utf8' });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

async function captureOpenClawInstallSnapshot() {
  const homePath = openclawHome();
  const npmPrefix = npmGlobalPrefix();
  const npmRoot = npmGlobalRoot();
  const binary = findToolBinary('openclaw');
  const packagePath = npmRoot ? path.join(npmRoot, 'openclaw') : '';
  const binPaths = !npmPrefix
    ? []
    : process.platform === 'win32'
      ? [path.join(npmPrefix, 'openclaw'), path.join(npmPrefix, 'openclaw.cmd'), path.join(npmPrefix, 'openclaw.ps1')]
      : [path.join(npmPrefix, 'bin', 'openclaw')];

  return {
    hadBinary: Boolean(binary.installed),
    homePath,
    homeExisted: await pathExists(homePath),
    packagePath,
    binPaths,
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
    const child = spawn(command, args, {
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
  const isScript = task.method === 'script';
  const command = isScript
    ? (process.platform === 'win32' ? 'powershell' : 'bash')
    : npmCommand();
  const args = isScript
    ? (process.platform === 'win32' ? ['-Command', OPENCLAW_INSTALL_SCRIPT_WIN] : ['-lc', OPENCLAW_INSTALL_SCRIPT_UNIX])
    : ['install', '-g', 'openclaw@latest'];

  try {
    if (isOpenClawInstallCancelled(task)) return;
    if (isScript && process.platform !== 'win32' && !commandExists('curl')) {
      throw new Error('未检测到 `curl`，无法执行脚本安装。请先安装 curl，或改用 npm 安装。');
    }
    if (!isScript) {
      const nodeResult = spawnSync('node', ['--version'], { encoding: 'utf8' });
      const npmResult = spawnSync(npmCommand(), ['--version'], { encoding: 'utf8' });
      if (nodeResult.status !== 0) throw new Error('未检测到 Node.js，请先安装 Node.js 18+。');
      if (npmResult.status !== 0) throw new Error('未检测到 npm，请先修复 npm 环境后重试。');
      pushOpenClawInstallLog(task, 'stdout', `Node.js ${String(nodeResult.stdout || '').trim()} / npm ${String(npmResult.stdout || '').trim()}`);
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

    const result = await runTrackedCommand(task, command, args);
    clearTimeout(autoAdvanceTimer);
    if (isOpenClawInstallCancelled(task)) return;
    if (!result.ok) throw new Error(result.stderr || `安装命令退出码：${result.code}`);

    // Ensure install step is marked done before moving to verify
    if (task.stepIndex < 2) {
      setOpenClawInstallStep(task, 2, { detail: '安装命令已完成，准备验证…' });
    }
    // Small settle delay so user sees "install done" before "verifying"
    await new Promise(r => setTimeout(r, 600));
    if (isOpenClawInstallCancelled(task)) return;

    setOpenClawInstallStep(task, 3, { detail: '安装命令已执行完成，正在验证 openclaw 命令…' });
    const binary = findToolBinary('openclaw');
    if (!binary.installed) throw new Error('安装命令已执行完成，但系统里仍未找到 `openclaw` 命令。');

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
  const paths = new Set();
  const whichResult = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['-a', 'codex'], { encoding: 'utf8' });
  if (whichResult.status === 0) {
    for (const line of (whichResult.stdout || '').split(/\r?\n/)) {
      if (line.trim()) paths.add(line.trim());
    }
  }
  const home = os.homedir();
  const explicit = [
    path.join(home, '.npm-global', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ];
  for (const entry of explicit) {
    if (entry) paths.add(entry);
  }
  return [...paths];
}

function findCodexBinary() {
  const candidates = codexCandidates().map((candidatePath) => {
    const result = spawnSync(candidatePath, ['--version'], { encoding: 'utf8' });
    return {
      path: candidatePath,
      installed: result.status === 0,
      version: result.status === 0 ? (result.stdout || result.stderr || '').trim() : null,
    };
  }).filter((item) => item.installed);

  candidates.sort((left, right) => compareVersions(right.version, left.version));
  const selected = candidates[0];

  return {
    installed: Boolean(selected),
    version: selected?.version || null,
    path: selected?.path || commandExists('codex'),
    candidates,
    installCommand: `${npmCommand()} install -g ${OPENAI_CODEX_PACKAGE}`,
  };
}

function scopePaths({ scope, projectPath, codexHome }) {
  if (scope === 'project') {
    if (!projectPath || !projectPath.trim()) {
      throw new Error('Project path is required for project scope');
    }
    const normalizedProjectPath = path.resolve(projectPath.trim());
    return {
      scope,
      rootPath: normalizedProjectPath,
      configPath: path.join(normalizedProjectPath, '.codex', 'config.toml'),
      envPath: path.join(codexHome, '.env'),
    };
  }

  return {
    scope: 'global',
    rootPath: codexHome,
    configPath: path.join(codexHome, 'config.toml'),
    envPath: path.join(codexHome, '.env'),
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
    .filter(([key]) => key && !key.toUpperCase().startsWith('CODEX_'))
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
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/v1';
  } else if (!/\/v1$/i.test(url.pathname)) {
    url.pathname = `${url.pathname}/v1`;
  }
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

function inferProviderSeed(baseUrl) {
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

function launchTerminalCommand(cwd, { binaryPath, binaryName = 'codex', toolLabel = 'Codex', commandText = '' } = {}) {
  const bin = commandText || binaryPath || binaryName;
  const escapedCwd = String(cwd).replace(/([\\"$])/g, '\\$1');
  const escapedBin = String(bin).replace(/([\\"$])/g, '\\$1');

  if (process.platform === 'darwin') {
    const appleScript = [
      'tell application "Terminal"',
      'activate',
      `do script "cd ${escapedCwd} && ${escapedBin}"`,
      'end tell',
    ].join('\n');
    const result = spawnSync('osascript', ['-e', appleScript], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'Failed to open Terminal').trim());
    }
    return `${toolLabel} 已在 Terminal 中启动`;
  }

  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', `cd /d "${cwd}" && "${bin}"`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return `${toolLabel} 已在新命令窗口中启动`;
  }

  const terminals = [
    ['x-terminal-emulator', ['-e', `bash -lc "cd ${cwd} && ${bin}"`]],
    ['gnome-terminal', ['--', 'bash', '-lc', `cd ${cwd} && ${bin}`]],
    ['konsole', ['-e', 'bash', '-lc', `cd ${cwd} && ${bin}`]],
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

async function checkOpenClawGatewayReachable(gatewayUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    const response = await fetch(gatewayUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.status > 0;
  } catch {
    return false;
  }
}

export async function checkSetupEnvironment({ codexHome = defaultCodexHome() } = {}) {
  const normalizedCodexHome = path.resolve(codexHome);

  // 1. Check Node.js
  const nodeResult = spawnSync('node', ['--version'], { encoding: 'utf8' });
  const nodeInstalled = nodeResult.status === 0;
  const nodeVersion = nodeInstalled ? (nodeResult.stdout || '').trim() : null;
  const nodeMajor = nodeVersion ? parseInt((nodeVersion.match(/v?(\d+)/) || [])[1] || '0', 10) : 0;

  // 2. Check npm
  const npmResult = spawnSync(npmCommand(), ['--version'], { encoding: 'utf8' });
  const npmInstalled = npmResult.status === 0;
  const npmVersion = npmInstalled ? (npmResult.stdout || '').trim() : null;

  // 3. Check codex binary
  const codexBinary = findCodexBinary();

  // 4. Check config files
  const globalConfigPath = path.join(normalizedCodexHome, 'config.toml');
  const globalEnvPath = path.join(normalizedCodexHome, '.env');
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
  const needsSetup = !codexBinary.installed || !configExists || !hasProviders;

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
      configPath: globalConfigPath,
      envPath: globalEnvPath,
    },
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
  const activeProvider = providers.find((provider) => provider.isActive) || null;
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
  const codexHome = path.resolve(payload.codexHome || defaultCodexHome());
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
  const providerKey = slugifyProviderKey(payload.providerKey || inferProviderSeed(baseUrl));
  const currentProvider = config.model_providers?.[providerKey] || {};
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
  const codexHome = path.resolve(payload.codexHome || defaultCodexHome());
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
  const codexHome = path.resolve(payload.codexHome || defaultCodexHome());
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
  if (!backupName) {
    throw new Error('Backup name is required');
  }

  const normalizedCodexHome = path.resolve(codexHome);
  const paths = scopePaths({ scope, projectPath, codexHome: normalizedCodexHome });
  const backupDir = path.join(backupsRoot(), backupName);
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

export async function launchCodex({ cwd } = {}) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const codexBinary = findCodexBinary();
  if (!codexBinary.installed) {
    throw new Error('Codex 尚未安装，请先点击安装');
  }

  const message = launchTerminalCommand(targetCwd, {
    binaryPath: codexBinary.path,
    binaryName: 'codex',
    toolLabel: 'Codex',
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

export async function loadClaudeCodeState() {
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

  const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || '18789';
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}/`;
  const gatewayReachable = await checkOpenClawGatewayReachable(gatewayUrl);
  const needsOnboarding = binary.installed && (!configExists || !gatewayReachable);

  return {
    toolId: 'openclaw',
    configHome: home,
    configPath,
    configExists,
    config,
    configJson: JSON.stringify(config, null, 2),
    binary,
    gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || null,
    gatewayPort,
    gatewayUrl,
    gatewayReachable,
    needsOnboarding,
    installMethods: ['script', 'npm', 'source', 'docker'],
  };
}

export async function saveOpenClawConfig({ configJson }) {
  if (!configJson || !configJson.trim()) throw new Error('配置内容不能为空');
  let parsed;
  try { parsed = JSON.parse(configJson); } catch (e) {
    throw new Error(`JSON 解析失败：${e.message}`);
  }
  const home = openclawHome();
  const configPath = path.join(home, 'openclaw.json');
  await ensureDir(home);
  await writeText(configPath, JSON.stringify(parsed, null, 2) + '\n');
  return { saved: true, configPath };
}

export async function startOpenClawInstallTask({ method = 'npm' } = {}) {
  if (!['script', 'npm'].includes(method)) {
    throw new Error('只有脚本安装和 npm 安装支持实时进度追踪');
  }

  const command = method === 'script'
    ? (process.platform === 'win32' ? OPENCLAW_INSTALL_SCRIPT_WIN : OPENCLAW_INSTALL_SCRIPT_UNIX)
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

export async function installOpenClaw({ method = 'npm' } = {}) {
  if (method === 'script') {
    if (process.platform === 'win32') {
      const result = await runCommand('powershell', ['-Command', OPENCLAW_INSTALL_SCRIPT_WIN]);
      return { ...result, method: 'script', command: OPENCLAW_INSTALL_SCRIPT_WIN };
    } else {
      const result = await runCommand('bash', ['-c', OPENCLAW_INSTALL_SCRIPT_UNIX]);
      return { ...result, method: 'script', command: OPENCLAW_INSTALL_SCRIPT_UNIX };
    }
  }
  if (method === 'npm') {
    const result = await runCommand(npmCommand(), ['install', '-g', 'openclaw@latest']);
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
  return runCommand(npmCommand(), ['install', '-g', 'openclaw@latest']);
}

export async function reinstallOpenClaw() {
  return runCommand(npmCommand(), ['install', '-g', 'openclaw', '--force']);
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
  const result = await runCommand(npmCommand(), ['uninstall', '-g', 'openclaw']);
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

  const binaryPath = binary.path || 'openclaw';
  const commandText = `${binaryPath} gateway start || ${binaryPath} gateway`;
  const message = launchTerminalCommand(targetCwd, {
    commandText,
    binaryName: 'openclaw gateway',
    toolLabel: 'OpenClaw Gateway',
  });
  return { ok: true, cwd: targetCwd, mode: 'gateway', gatewayUrl: state.gatewayUrl, command: commandText, message };
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
    '--install-daemon',
    '--skip-channels',
    '--skip-skills',
    '--skip-search',
    '--json',
  ];

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
