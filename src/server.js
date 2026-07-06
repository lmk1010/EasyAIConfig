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
  listOauthProfiles as listCodexOauthProfiles,
  saveCurrentOauthProfile as saveCurrentCodexOauthProfile,
  createOauthProfile as createCodexOauthProfile,
  switchOauthProfile as switchCodexOauthProfile,
  renameOauthProfile as renameCodexOauthProfile,
  deleteOauthProfile as deleteCodexOauthProfile,
} from './lib/codex-oauth-profiles.js';
import {
  listClaudecodeOauthProfiles,
  createClaudecodeOauthProfile,
  switchClaudecodeOauthProfile,
  renameClaudecodeOauthProfile,
  deleteClaudecodeOauthProfile,
} from './lib/claudecode-oauth-profiles.js';
import {
  getProjectBinding,
  setProjectBinding,
  removeProjectBinding,
  listProjectBindings,
  summarizeBindingsForCwd,
} from './lib/project-bindings.js';
import {
  listAdapters as listCnProviderAdapters,
  getAdapterForBaseUrl,
} from './lib/cn-provider-adapters.js';
import {
  buildAssetImportDeepLink,
  exportAssetBundle,
  exportProviderCatalog,
  getProviderPreset,
  listProviderPresets,
  previewAssetImport,
  providerCatalogSummary,
} from './lib/provider-catalog.js';
import {
  applyMcpImport,
  listMcpInventory,
  planMcpSync,
  previewMcpImport,
} from './lib/mcp-manager.js';
import {
  applyPromptImport,
  listPromptInventory,
  previewPromptImport,
} from './lib/prompt-manager.js';
import {
  applySkillImport,
  listSkillInventory,
  previewSkillImport,
} from './lib/skill-manager.js';
import {
  archiveSession,
  listSessionInventory,
  listSessionTrash,
  restoreSession,
} from './lib/session-manager.js';
import {
  listUsageInventory,
  readCustomPriceBook,
  saveCustomPriceBook,
} from './lib/usage-manager.js';
import {
  listSyncTargets,
  listSyncSnapshots,
  pushSyncSnapshot,
  readSyncSnapshot,
  saveSyncTargets,
} from './lib/sync-manager.js';
import {
  buildLocalRoutingPlan,
  localRoutingCapabilities,
  previewRequestRectifier,
  previewResponseRectifier,
  redactLocalRoutingLogEntry,
} from './lib/local-routing-manager.js';
import {
  checkSetupEnvironment,
  getProviderSecret,
  getProviderExtras,
  setProviderExtras,
  getAllProviderHealth,
  getProviderHealth,
  getCodexReleaseInfo,
  getCodexUsageMetrics,
  getOpenCodeUsageMetrics,
  listCodexSessions,
  getSystemStorageState,
  getToolUpdatesInfo,
  installClaudeCode,
  installClaudeCodeVersion,
  installCodeBuddyCode,
  installCodeBuddyCodeVersion,
  installOpenCode,
  installOpenCodeVersion,
  installCodex,
  installCodexVersion,
  installGemini,
  installGeminiVersion,
  installOpenClaw,
  installOpenClawVersion,
  installOpenClawRemote,
  installQwenCode,
  installQwenCodeVersion,
  killOpenClawPortOccupants,
  cancelOpenClawInstallTask,
  cancelOpenCodeInstallTask,
  getOpenClawInstallTask,
  getOpenCodeInstallTask,
  getOpenClawDashboardUrl,
  onboardOpenClaw,
  repairOpenClawDashboardAuth,
  launchClaudeCode,
  launchClaudeDesktop,
  launchGemini,
  launchHermes,
  loadGeminiState,
  launchOpenCode,
  loadHermesState,
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
  reinstallCodeBuddyCode,
  reinstallOpenCode,
  reinstallCodex,
  reinstallGemini,
  reinstallOpenClaw,
  reinstallQwenCode,
  restoreBackup,
  saveClaudeCodeConfig,
  saveClaudeCodeRawConfig,
  saveOpenCodeConfig,
  saveOpenCodeRawConfig,
  saveConfig,
  applyProviderRouterClientConfig,
  applyProviderCatalogImport,
  deleteProviderConfig,
  useOauthConfig,
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
  uninstallCodeBuddyCode,
  uninstallOpenCode,
  uninstallCodex,
  uninstallGemini,
  uninstallOpenClaw,
  uninstallQwenCode,
  updateClaudeCode,
  updateClaudeCodeDomestic,
  updateCodeBuddyCode,
  updateCodeBuddyCodeDomestic,
  updateOpenCode,
  updateCodex,
  updateCodexDomestic,
  updateGemini,
  updateGeminiDomestic,
  updateOpenClaw,
  updateOpenClawDomestic,
  updateQwenCode,
  updateQwenCodeDomestic,
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

function emptyAssetImportResult({
  schema,
  dryRun,
  targetTool,
  summaryKey,
  total = 0,
} = {}) {
  return {
    schema,
    dryRun: dryRun !== false,
    targetTool,
    summary: {
      [summaryKey]: total,
      created: 0,
      updated: 0,
      appended: 0,
      unchanged: 0,
      conflicts: 0,
      stale: 0,
      skipped: 0,
      changed: false,
      written: false,
    },
    operations: [],
    backupPath: null,
  };
}

function sumImportSummary(results = {}) {
  const summaries = Object.values(results).map((result) => result?.summary || {});
  const sum = (key) => summaries.reduce((total, summary) => total + Number(summary?.[key] || 0), 0);
  return {
    totalProviders: sum('totalProviders'),
    totalMcpServers: sum('totalServers'),
    totalPrompts: sum('totalPrompts'),
    totalSkills: sum('totalSkills'),
    created: sum('created'),
    updated: sum('updated'),
    appended: sum('appended'),
    unchanged: sum('unchanged'),
    conflicts: sum('conflicts'),
    stale: sum('stale'),
    skipped: sum('skipped'),
    changed: summaries.some((summary) => Boolean(summary?.changed)),
    written: summaries.some((summary) => Boolean(summary?.written)),
  };
}

function categorizedOperations(category, result = {}) {
  return (Array.isArray(result.operations) ? result.operations : [])
    .map((operation) => ({ category, ...operation }));
}

async function applyUnifiedAssetImport(input = {}, options = {}) {
  const dryRun = options.dryRun ?? input.dryRun ?? true;
  const targetTool = String(options.targetTool || input.targetTool || 'all').trim() || 'all';
  const preview = previewAssetImport(input);
  const counts = preview.counts || {};
  const providerResult = (Number(counts.providers || 0) > 0 || Boolean(options.includeCatalogPresets || input.includeCatalogPresets))
    ? await applyProviderCatalogImport(input, {
        ...options,
        dryRun,
        targetTool,
      })
    : emptyAssetImportResult({
        schema: 'easyaiconfig.provider-import-apply.v1',
        dryRun,
        targetTool,
        summaryKey: 'totalProviders',
      });
  const mcpResult = Number(counts.mcpServers || 0) > 0
    ? await applyMcpImport(input, {
        ...options,
        dryRun,
        targetTool,
      })
    : emptyAssetImportResult({
        schema: 'easyaiconfig.mcp-import-apply.v1',
        dryRun,
        targetTool,
        summaryKey: 'totalServers',
      });
  const promptResult = Number(counts.prompts || 0) > 0
    ? await applyPromptImport(input, {
        ...options,
        dryRun,
        targetTool,
      })
    : emptyAssetImportResult({
        schema: 'easyaiconfig.prompt-import-apply.v1',
        dryRun,
        targetTool,
        summaryKey: 'totalPrompts',
      });
  const skillResult = Number(counts.skills || 0) > 0
    ? await applySkillImport(input, {
        ...options,
        dryRun,
        targetTool,
      })
    : emptyAssetImportResult({
        schema: 'easyaiconfig.skill-import-apply.v1',
        dryRun,
        targetTool,
        summaryKey: 'totalSkills',
      });
  const results = {
    providers: providerResult,
    mcp: mcpResult,
    prompts: promptResult,
    skills: skillResult,
  };
  const summary = sumImportSummary(results);
  return {
    schema: 'easyaiconfig.asset-import-apply.v2',
    dryRun: dryRun !== false,
    targetTool,
    source: {
      schema: preview.schema,
      app: preview.app,
      version: preview.version,
    },
    counts,
    summary,
    results,
    operations: [
      ...categorizedOperations('providers', providerResult),
      ...categorizedOperations('mcp', mcpResult),
      ...categorizedOperations('prompts', promptResult),
      ...categorizedOperations('skills', skillResult),
    ],
    backupPaths: {
      providers: providerResult.backupPath || null,
      mcp: mcpResult.backupPath || null,
      prompts: promptResult.backupPath || null,
      skills: skillResult.backupPath || null,
    },
    backupPath: providerResult.backupPath || null,
    paths: providerResult.paths || {},
  };
}

async function buildAssetExportBundle({
  includeLocal = false,
  projectPath = '',
  cwd = '',
  codexHome = '',
  limit = 100,
} = {}) {
  const bundle = exportAssetBundle();
  if (!includeLocal) return bundle;
  const [mcpInventory, promptInventory, skillInventory, sessionInventory] = await Promise.all([
    listMcpInventory({ codexHome: codexHome || undefined }),
    listPromptInventory({ projectPath: projectPath || '' }),
    listSkillInventory(),
    listSessionInventory({
      codexHome: codexHome || undefined,
      cwd: cwd || '',
      limit,
    }),
  ]);
  bundle.assets.mcpInventory = mcpInventory;
  bundle.assets.promptInventory = promptInventory;
  bundle.assets.skillInventory = skillInventory;
  bundle.assets.sessionInventory = sessionInventory;
  return bundle;
}


const OPENCODE_DESKTOP_TASKS = new Map();
const OPENCODE_DESKTOP_TASK_TTL_MS = 30 * 60 * 1000;
let opencodeDesktopTaskSeq = 0;
const CODEX_APP_TASKS = new Map();
const CODEX_APP_TASK_TTL_MS = 30 * 60 * 1000;
let codexAppTaskSeq = 0;
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

function readMacAppBundleVersion(appPath) {
  const infoPath = path.join(appPath || '', 'Contents', 'Info.plist');
  if (!existsSync(infoPath)) return '';
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const result = spawnSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', infoPath], {
      encoding: 'utf8',
      timeout: 1000,
      windowsHide: true,
    });
    const value = String(result.stdout || '').trim();
    if (result.status === 0 && value) return value;
  }
  try {
    const text = readFileSync(infoPath, 'utf8');
    const match = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)
      || text.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function readWindowsFileVersion(filePath) {
  if (!filePath) return '';
  const escaped = quotePowerShellText(filePath);
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`,
  ], {
    encoding: 'utf8',
    timeout: 1500,
    windowsHide: true,
  });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function getCodexAppVersion(installPath) {
  if (!installPath) return '';
  if (process.platform === 'darwin') return readMacAppBundleVersion(installPath);
  if (process.platform === 'win32') return readWindowsFileVersion(installPath);
  return '';
}

function getCodexAppState() {
  const supported = process.platform === 'darwin' || process.platform === 'win32';
  const installPath = getCodexAppInstallationCandidates().find((item) => existsSync(item)) || '';
  const version = getCodexAppVersion(installPath);
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
    version,
    currentVersion: version,
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

function cleanupCodexAppTasks() {
  const now = Date.now();
  for (const [taskId, task] of CODEX_APP_TASKS.entries()) {
    if (task.status !== 'running' && task.status !== 'cancelling' && (now - task.updatedAtTs) > CODEX_APP_TASK_TTL_MS) {
      CODEX_APP_TASKS.delete(taskId);
    }
  }
}

function createCodexAppTask({ reinstall = false } = {}) {
  cleanupCodexAppTasks();
  const isWin = process.platform === 'win32';
  const steps = isWin
    ? [
      { key: 'inspect', title: '检查系统环境', description: '确认 Windows 商店安装入口', status: 'running', progress: 12 },
      { key: 'store', title: '打开 Microsoft Store', description: '交给系统商店安装或更新 Codex App', status: 'pending', progress: 72 },
      { key: 'verify', title: '等待商店确认', description: '商店确认后系统会继续安装或更新', status: 'pending', progress: 96 },
    ]
    : [
      { key: 'inspect', title: '检查系统环境', description: '识别 macOS 安装位置与权限', status: 'running', progress: 8 },
      { key: 'download', title: '下载安装包', description: '下载 Codex App 官方 DMG', status: 'pending', progress: 46 },
      { key: 'install', title: '安装并打开', description: '挂载 DMG 并复制到 Applications', status: 'pending', progress: 86 },
      { key: 'verify', title: '验证安装结果', description: '确认 Codex App 已可打开', status: 'pending', progress: 96 },
    ];
  const startedAt = nowIso();
  const task = {
    id: `codex-app-${Date.now()}-${codexAppTaskSeq += 1}`,
    toolId: 'codex-app',
    action: reinstall ? 'reinstall' : 'install',
    reinstall,
    status: 'running',
    progress: steps[0]?.progress || 8,
    stepIndex: 0,
    summary: reinstall ? '正在更新 Codex App…' : '正在安装 Codex App…',
    hint: isWin ? '会打开 Microsoft Store，请在商店里确认安装或更新。' : '会自动下载、挂载并复制到 Applications。',
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
  CODEX_APP_TASKS.set(task.id, task);
  return task;
}

function touchCodexAppTask(task) {
  task.updatedAt = nowIso();
  task.updatedAtTs = Date.now();
}

function setCodexAppStep(task, stepIndex, overrides = {}) {
  const safeStepIndex = Math.max(0, Math.min(stepIndex, task.steps.length - 1));
  task.stepIndex = safeStepIndex;
  task.progress = Math.max(task.progress, overrides.progress || task.steps[safeStepIndex]?.progress || task.progress);
  if (overrides.summary) task.summary = overrides.summary;
  if (overrides.hint) task.hint = overrides.hint;
  if (overrides.detail) task.detail = overrides.detail;
  task.steps = task.steps.map((step, index) => ({
    ...step,
    status: index < safeStepIndex ? 'done' : index === safeStepIndex ? (overrides.status || 'running') : 'pending',
  }));
  touchCodexAppTask(task);
}

function pushCodexAppTaskLog(task, source, text) {
  const cleaned = String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!cleaned) return;
  task.logs.push({ source, text: cleaned, at: nowIso() });
  if (task.logs.length > 160) task.logs.shift();
  task.detail = cleaned;
  touchCodexAppTask(task);
}

function serializeCodexAppTask(task) {
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

function finalizeCodexAppCancelled(task, reason = '') {
  task.status = 'cancelled';
  task.progress = 100;
  task.completedAt = nowIso();
  task.error = null;
  task.summary = 'Codex App 安装已中断';
  task.hint = '重新点击安装即可继续。';
  task.detail = reason || '已按你的要求中断当前安装任务。';
  task.steps = task.steps.map((step, index) => ({
    ...step,
    status: index < task.stepIndex ? 'done' : index === task.stepIndex ? 'cancelled' : 'pending',
  }));
  touchCodexAppTask(task);
}

async function cancelCodexAppInstallTask({ taskId } = {}) {
  cleanupCodexAppTasks();
  const task = CODEX_APP_TASKS.get(String(taskId || '').trim());
  if (!task) throw new Error('Codex App 任务不存在，可能已过期');
  if (task.status === 'success' || task.status === 'error' || task.status === 'cancelled') {
    return serializeCodexAppTask(task);
  }
  if (task.stepIndex >= 2 && !task._abortController) {
    throw new Error('安装阶段已经开始，当前阶段无法立即中断');
  }
  task._cancelRequested = true;
  task.status = 'cancelling';
  task.summary = '正在中断 Codex App 安装…';
  task.hint = '正在停止下载并清理临时状态。';
  task.detail = '已收到中断请求，正在处理…';
  pushCodexAppTaskLog(task, 'stderr', '已收到中断请求。');
  if (task._abortController) task._abortController.abort();
  touchCodexAppTask(task);
  return serializeCodexAppTask(task);
}

async function downloadCodexAppInstaller(task, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const controller = new AbortController();
  task._abortController = controller;
  const response = await fetch(CODEX_APP_MAC_DOWNLOAD_URL, { redirect: 'follow', signal: controller.signal });
  if (!response.ok || !response.body) {
    throw new Error(`下载安装包失败：HTTP ${response.status}`);
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
        pushCodexAppTaskLog(task, 'stdout', `已下载 ${downloadedMb} MB / ${totalMb} MB`);
        task.progress = Math.max(task.progress, Math.min(80, 46 + Math.floor((downloadedBytes / Math.max(totalBytes || downloadedBytes, 1)) * 32)));
        touchCodexAppTask(task);
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
  pushCodexAppTaskLog(task, 'stdout', '安装包下载完成');
  return destinationPath;
}

async function installCodexAppOnMac(task, installerPath) {
  pushCodexAppTaskLog(task, 'stdout', '正在挂载 DMG 镜像…');
  const attach = runCommandLocal('hdiutil', ['attach', '-nobrowse', installerPath]);
  if (!attach.ok) throw new Error((attach.stderr || attach.stdout || '挂载 DMG 失败').trim());
  const mountPoint = parseMountedVolume(`${attach.stdout}\n${attach.stderr}`);
  if (!mountPoint) throw new Error('无法识别 DMG 挂载路径');
  pushCodexAppTaskLog(task, 'stdout', 'DMG 已挂载');
  try {
    const entries = await fs.readdir(mountPoint, { withFileTypes: true });
    const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
    if (!appEntry) throw new Error('DMG 中未找到 Codex.app');
    const sourceAppPath = path.join(mountPoint, appEntry.name);
    const appTargets = ['/Applications', path.join(os.homedir(), 'Applications')];
    let installedPath = '';
    for (const appDir of appTargets) {
      await fs.mkdir(appDir, { recursive: true }).catch(() => {});
      const targetAppPath = path.join(appDir, appEntry.name);
      const script = `rm -rf ${quotePosixArg(targetAppPath)} && cp -R ${quotePosixArg(sourceAppPath)} ${quotePosixArg(appDir)}`;
      const copy = runCommandLocal('sh', ['-lc', script]);
      pushCodexAppTaskLog(task, copy.ok ? 'stdout' : 'stderr', copy.ok ? `已安装到 ${targetAppPath}` : (copy.stderr || copy.stdout || `复制到 ${targetAppPath} 失败`));
      if (copy.ok) {
        installedPath = targetAppPath;
        runCommandLocal('xattr', ['-dr', 'com.apple.quarantine', targetAppPath]);
        break;
      }
    }
    if (!installedPath) throw new Error('无法把 Codex.app 安装到 Applications');
    pushCodexAppTaskLog(task, 'stdout', '正在打开 Codex App…');
    await open(installedPath);
    return { installedPath, opened: true };
  } finally {
    runCommandLocal('hdiutil', ['detach', mountPoint]);
  }
}

async function runCodexAppInstallTask(task) {
  try {
    const appState = getCodexAppState();
    if (!appState.supported) throw new Error('当前系统暂不支持 Codex App 自动安装');
    pushCodexAppTaskLog(task, 'stdout', `当前系统：${appState.platform}`);

    if (process.platform === 'win32') {
      setCodexAppStep(task, 1, {
        summary: '正在打开 Microsoft Store…',
        hint: '请在商店里确认安装或更新。',
        detail: '正在交给系统商店处理…',
        progress: 72,
      });
      try {
        await open(CODEX_APP_WIN_STORE_URI);
        pushCodexAppTaskLog(task, 'stdout', '已打开 Microsoft Store');
      } catch {
        await open(CODEX_APP_WIN_STORE_URL);
        pushCodexAppTaskLog(task, 'stdout', '已打开 Microsoft Store 网页');
      }
      setCodexAppStep(task, 2, {
        summary: '已打开商店，请确认安装或更新',
        hint: 'Windows 商店安装由系统接管，确认后会自动继续。',
        detail: '等待商店确认…',
        progress: 96,
      });
      task.status = 'success';
      task.progress = 100;
      task.completedAt = nowIso();
      task.summary = 'Codex App 商店入口已打开';
      task.hint = '在 Microsoft Store 里确认即可完成安装或更新。';
      task.steps = task.steps.map((step) => ({ ...step, status: 'done' }));
      touchCodexAppTask(task);
      return;
    }

    if (process.platform !== 'darwin') throw new Error('当前系统暂不支持 Codex App 自动安装');

    if (task._cancelRequested) {
      finalizeCodexAppCancelled(task);
      return;
    }

    setCodexAppStep(task, 1, {
      summary: '正在下载 Codex App 安装包…',
      hint: '下载完成后会自动安装。',
      detail: '正在连接官方安装源…',
      progress: 46,
    });
    const downloadsDir = path.join(os.homedir(), 'Downloads', 'EasyAIConfig');
    const installerPath = await downloadCodexAppInstaller(task, path.join(downloadsDir, 'Codex.dmg'));

    if (task._cancelRequested) {
      finalizeCodexAppCancelled(task);
      return;
    }

    setCodexAppStep(task, 2, {
      summary: '正在安装 Codex App…',
      hint: '会自动挂载 DMG 并复制到 Applications。',
      detail: '正在准备安装…',
      progress: 86,
    });
    await installCodexAppOnMac(task, installerPath);

    setCodexAppStep(task, 3, {
      summary: '正在验证 Codex App…',
      hint: '马上完成。',
      detail: '正在确认安装结果…',
      progress: 96,
    });
    const nextState = getCodexAppState();
    if (!nextState.installed) throw new Error('安装命令完成，但还未检测到 Codex App');
    task.status = 'success';
    task.progress = 100;
    task.completedAt = nowIso();
    task.summary = task.reinstall ? 'Codex App 更新完成' : 'Codex App 安装完成';
    task.hint = nextState.version ? `当前版本 ${nextState.version}` : 'Codex App 已准备好。';
    task.steps = task.steps.map((step) => ({ ...step, status: 'done' }));
    touchCodexAppTask(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = task._cancelRequested || (error instanceof Error && error.name === 'AbortError');
    if (aborted) {
      pushCodexAppTaskLog(task, 'stderr', '安装任务已中断');
      finalizeCodexAppCancelled(task, '已停止当前下载安装任务。');
      if (task._downloadPath) await fs.rm(task._downloadPath, { force: true }).catch(() => {});
    } else {
      task.status = 'error';
      task.error = message;
      task.completedAt = nowIso();
      task.summary = 'Codex App 安装失败';
      task.hint = '请查看最后一条日志确认是网络、权限还是系统商店问题。';
      pushCodexAppTaskLog(task, 'stderr', message);
      touchCodexAppTask(task);
    }
  } finally {
    task._abortController = null;
  }
}

async function startCodexAppInstallTask({ reinstall = false } = {}) {
  const task = createCodexAppTask({ reinstall: Boolean(reinstall) });
  void runCodexAppInstallTask(task);
  return serializeCodexAppTask(task);
}

async function getCodexAppInstallTask({ taskId } = {}) {
  cleanupCodexAppTasks();
  const task = CODEX_APP_TASKS.get(String(taskId || '').trim());
  if (!task) throw new Error('Codex App 任务不存在，可能已过期');
  return serializeCodexAppTask(task);
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
    summary: reinstall ? '正在更新 OpenCode Desktop…' : '正在安装 OpenCode Desktop…',
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
      detail: '正在连接官方下载源',
      progress: 46,
    });
    const downloadsDir = path.join(os.homedir(), 'Downloads', 'EasyAIConfig');
    const installerPath = await downloadOpenCodeDesktopInstaller(task, state.downloadUrl, path.join(downloadsDir, state.fileName));

    if (task._cancelRequested) {
      finalizeOpenCodeDesktopCancelled(task);
      return;
    }

    setOpenCodeDesktopStep(task, 2, {
      summary: task.reinstall ? '正在更新 OpenCode Desktop…' : '正在自动安装 OpenCode Desktop…',
      hint: task.reinstall
        ? (process.platform === 'darwin' ? '会覆盖到 Applications 并尝试打开。' : '会拉起安装器并尽量直接完成更新。')
        : (process.platform === 'darwin' ? '会自动安装到 Applications 并尝试打开。' : '会自动拉起安装器并尽量直接完成安装。'),
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
    task.summary = task.reinstall ? 'OpenCode Desktop 更新完成' : 'OpenCode Desktop 安装完成';
    task.hint = task.reinstall ? '桌面版已更新，可以直接打开。' : '桌面版已经为你准备好。';
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

export async function startServer(options = {}) {
  const app = express();
  const localApiToken = createLocalApiToken();
  app.use(express.json({ limit: '1mb' }));

  // 安全头：Web 模式 (npm install -g easyaiconfig) 没有 Tauri 的 webview CSP，
  // 在浏览器里运行时需要服务端发安全头来防 XSS / clickjack / 跨源请求
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        // 内联脚本是 vanilla-JS 现状所必需的（HTML 里有大量 <script>...</script>）
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "connect-src 'self' http://127.0.0.1:* http://localhost:* https://api.github.com",
        "font-src 'self' data:",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

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
  // no-store on html/css/js so the embedded webview (WKWebView caches very
  // aggressively and ignores max-age=0) always picks up fresh assets on reload
  app.use(express.static(publicDir, {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (/\.(html|css|js)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));

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
      ok(res, { data: listTools({ passive: true }) });

    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/tools/updates', async (_req, res) => {
    try {
      ok(res, { data: await getToolUpdatesInfo() });
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
      const diag = error?.diag || null;
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        diag,
      });
    }
  });

  app.post('/api/provider/secret', async (req, res) => {
    try {
      ok(res, { data: await getProviderSecret(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  // Per-provider extras: 当前用于 per-provider 代理 (HTTPS_PROXY) 等元数据。
  // 储存在 ~/.codex-config-ui/provider-extras.json，不写进用户的 codex/config.toml
  app.get('/api/provider/extras', async (req, res) => {
    try {
      const providerKey = String(req.query.providerKey || '').trim();
      ok(res, { data: { extras: await getProviderExtras(providerKey) } });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/provider/extras', async (req, res) => {
    try {
      const body = req.body || {};
      const providerKey = String(body.providerKey || '').trim();
      const patch = body.patch || {};
      ok(res, { data: { extras: await setProviderExtras(providerKey, patch) } });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/provider/test-saved', async (req, res) => {
    try {
      ok(res, { data: await testSavedProvider(req.body || {}) });
    } catch (error) {
      // 把诊断信息透传给前端：列表上的红绿灯需要知道是 DNS / TLS / Auth 哪一类
      const diag = error?.diag || null;
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        diag,
      });
    }
  });

  // 列表加载时一次性拉所有 provider 最近一次健康快照，画红绿灯用
  app.get('/api/provider/health-all', async (_req, res) => {
    try {
      ok(res, { data: { providers: await getAllProviderHealth() } });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/provider/health', async (req, res) => {
    try {
      const providerKey = String(req.query.providerKey || '').trim();
      ok(res, { data: { snapshot: await getProviderHealth(providerKey) } });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/local-routing/capabilities', async (_req, res) => {
    try {
      ok(res, { data: localRoutingCapabilities() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/local-routing/plan', async (req, res) => {
    try {
      ok(res, { data: buildLocalRoutingPlan(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/local-routing/rectifier/preview', async (req, res) => {
    try {
      ok(res, { data: previewRequestRectifier(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/local-routing/response-rectifier/preview', async (req, res) => {
    try {
      ok(res, { data: previewResponseRectifier(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/local-routing/log/redact', async (req, res) => {
    try {
      ok(res, { data: redactLocalRoutingLogEntry(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/provider/catalog', async (req, res) => {
    try {
      ok(res, {
        data: {
          summary: providerCatalogSummary(),
          presets: listProviderPresets({
            query: req.query.query,
            tool: req.query.tool,
            region: req.query.region,
            protocol: req.query.protocol,
            tag: req.query.tag,
          }),
        },
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/provider/catalog/export', async (req, res) => {
    try {
      ok(res, {
        data: exportProviderCatalog({
          query: req.query.query,
          tool: req.query.tool,
          region: req.query.region,
          protocol: req.query.protocol,
          tag: req.query.tag,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/provider/catalog/:id', async (req, res) => {
    try {
      const preset = getProviderPreset(req.params.id);
      if (!preset) throw new Error('Provider preset not found');
      ok(res, { data: { preset } });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/provider-router/apply-client', async (req, res) => {
    try {
      ok(res, { data: await applyProviderRouterClientConfig(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/assets/export', async (req, res) => {
    try {
      const includeLocal = req.query.local === '1' || req.query.local === 'true';
      const projectPath = validatePathOrThrow(req.query.projectPath, 'projectPath');
      const cwd = validatePathOrThrow(req.query.cwd, 'cwd');
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      const bundle = await buildAssetExportBundle({
        includeLocal,
        projectPath: projectPath || '',
        cwd: cwd || '',
        codexHome: codexHome || '',
        limit: req.query.limit || 100,
      });
      ok(res, { data: bundle });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/assets/index', async (req, res) => {
    try {
      const projectPath = validatePathOrThrow(req.query.projectPath, 'projectPath');
      const cwd = validatePathOrThrow(req.query.cwd, 'cwd');
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      const qwenHome = validatePathOrThrow(req.query.qwenHome, 'qwenHome');
      const codeBuddyHome = validatePathOrThrow(req.query.codeBuddyHome, 'codeBuddyHome');
      const geminiSettingsPath = validatePathOrThrow(req.query.geminiSettingsPath, 'geminiSettingsPath');
      const qwenSettingsPath = validatePathOrThrow(req.query.qwenSettingsPath, 'qwenSettingsPath');
      const codeBuddyMcpPath = validatePathOrThrow(req.query.codeBuddyMcpPath, 'codeBuddyMcpPath');
      const codeBuddySkillsRoot = validatePathOrThrow(req.query.codeBuddySkillsRoot, 'codeBuddySkillsRoot');
      const includeUsage = req.query.usage === '1' || req.query.usage === 'true';
      const [providerCatalog, mcpInventory, promptInventory, skillInventory, sessionInventory, usageInventory] = await Promise.all([
        Promise.resolve(exportProviderCatalog()),
        listMcpInventory({
          codexHome: codexHome || undefined,
          geminiSettingsPath: geminiSettingsPath || undefined,
          qwenSettingsPath: qwenSettingsPath || undefined,
          codeBuddyMcpPath: codeBuddyMcpPath || undefined,
        }),
        listPromptInventory({
          projectPath: projectPath || '',
          codexHome: codexHome || undefined,
          qwenHome: qwenHome || undefined,
          codeBuddyHome: codeBuddyHome || undefined,
        }),
        listSkillInventory({
          codeBuddySkillsRoot: codeBuddySkillsRoot || undefined,
        }),
        listSessionInventory({
          codexHome: codexHome || undefined,
          qwenHome: qwenHome || undefined,
          codeBuddyHome: codeBuddyHome || undefined,
          cwd: cwd || '',
          limit: req.query.limit || 100,
        }),
        includeUsage
          ? listUsageInventory({
            codexHome: codexHome || undefined,
            qwenHome: qwenHome || undefined,
            codeBuddyHome: codeBuddyHome || undefined,
            days: req.query.days || undefined,
            cacheOnly: req.query.cacheOnly === '1' || req.query.cacheOnly === 'true',
          })
          : Promise.resolve(null),
      ]);
      ok(res, {
        data: {
          schema: 'easyaiconfig.asset-index.v1',
          generatedAt: new Date().toISOString(),
          providerCatalog,
          mcpInventory,
          promptInventory,
          skillInventory,
          sessionInventory,
          usageInventory,
        },
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/assets/import/preview', async (req, res) => {
    try {
      ok(res, { data: previewAssetImport(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/assets/import/preview', async (req, res) => {
    try {
      if (req.query.payload) {
        ok(res, { data: previewAssetImport({ url: `easyai://import?payload=${req.query.payload}` }) });
        return;
      }
      ok(res, { data: previewAssetImport({ url: req.query.url || req.query.text || '' }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/assets/import/apply', async (req, res) => {
    try {
      const codexHome = validatePathOrThrow(req.body?.codexHome, 'codexHome');
      const projectPath = validatePathOrThrow(req.body?.projectPath, 'projectPath');
      const claudeSettingsPath = validatePathOrThrow(req.body?.claudeSettingsPath, 'claudeSettingsPath');
      const claudeDesktopConfigPath = validatePathOrThrow(req.body?.claudeDesktopConfigPath, 'claudeDesktopConfigPath');
      const openCodeConfigPath = validatePathOrThrow(req.body?.openCodeConfigPath, 'openCodeConfigPath');
      const geminiSettingsPath = validatePathOrThrow(req.body?.geminiSettingsPath, 'geminiSettingsPath');
      const qwenSettingsPath = validatePathOrThrow(req.body?.qwenSettingsPath, 'qwenSettingsPath');
      const codeBuddyMcpPath = validatePathOrThrow(req.body?.codeBuddyMcpPath, 'codeBuddyMcpPath');
      const qwenHome = validatePathOrThrow(req.body?.qwenHome, 'qwenHome');
      const codeBuddyHome = validatePathOrThrow(req.body?.codeBuddyHome, 'codeBuddyHome');
      const codexSkillsRoot = validatePathOrThrow(req.body?.codexSkillsRoot, 'codexSkillsRoot');
      const claudeSkillsRoot = validatePathOrThrow(req.body?.claudeSkillsRoot, 'claudeSkillsRoot');
      const codeBuddySkillsRoot = validatePathOrThrow(req.body?.codeBuddySkillsRoot, 'codeBuddySkillsRoot');
      const easyaiSkillsRoot = validatePathOrThrow(req.body?.easyaiSkillsRoot, 'easyaiSkillsRoot');
      ok(res, {
        data: await applyUnifiedAssetImport(req.body || {}, {
          codexHome: codexHome || undefined,
          projectPath: projectPath || '',
          claudeSettingsPath: claudeSettingsPath || undefined,
          claudeDesktopConfigPath: claudeDesktopConfigPath || undefined,
          openCodeConfigPath: openCodeConfigPath || undefined,
          geminiSettingsPath: geminiSettingsPath || undefined,
          qwenSettingsPath: qwenSettingsPath || undefined,
          codeBuddyMcpPath: codeBuddyMcpPath || undefined,
          qwenHome: qwenHome || undefined,
          codeBuddyHome: codeBuddyHome || undefined,
          codexSkillsRoot: codexSkillsRoot || undefined,
          claudeSkillsRoot: claudeSkillsRoot || undefined,
          codeBuddySkillsRoot: codeBuddySkillsRoot || undefined,
          easyaiSkillsRoot: easyaiSkillsRoot || undefined,
          scope: req.body?.scope || 'global',
          dryRun: req.body?.dryRun !== false,
          overwrite: Boolean(req.body?.overwrite),
          append: Boolean(req.body?.append),
          installMode: req.body?.installMode || req.body?.mode || 'copy',
          includeCatalogPresets: Boolean(req.body?.includeCatalogPresets),
          targetTool: req.body?.targetTool || 'all',
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/assets/deep-link/build', async (req, res) => {
    try {
      const payload = req.body?.payload || exportAssetBundle();
      ok(res, { data: { url: buildAssetImportDeepLink(payload) } });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/mcp/inventory', async (req, res) => {
    try {
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      const geminiSettingsPath = validatePathOrThrow(req.query.geminiSettingsPath, 'geminiSettingsPath');
      const qwenSettingsPath = validatePathOrThrow(req.query.qwenSettingsPath, 'qwenSettingsPath');
      const codeBuddyMcpPath = validatePathOrThrow(req.query.codeBuddyMcpPath, 'codeBuddyMcpPath');
      ok(res, {
        data: await listMcpInventory({
          codexHome: codexHome || undefined,
          geminiSettingsPath: geminiSettingsPath || undefined,
          qwenSettingsPath: qwenSettingsPath || undefined,
          codeBuddyMcpPath: codeBuddyMcpPath || undefined,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/mcp/sync-plan', async (req, res) => {
    try {
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      const geminiSettingsPath = validatePathOrThrow(req.query.geminiSettingsPath, 'geminiSettingsPath');
      const qwenSettingsPath = validatePathOrThrow(req.query.qwenSettingsPath, 'qwenSettingsPath');
      const codeBuddyMcpPath = validatePathOrThrow(req.query.codeBuddyMcpPath, 'codeBuddyMcpPath');
      ok(res, {
        data: await planMcpSync({
          codexHome: codexHome || undefined,
          geminiSettingsPath: geminiSettingsPath || undefined,
          qwenSettingsPath: qwenSettingsPath || undefined,
          codeBuddyMcpPath: codeBuddyMcpPath || undefined,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/mcp/import/preview', async (req, res) => {
    try {
      const codexHome = validatePathOrThrow(req.body?.codexHome, 'codexHome');
      const claudeSettingsPath = validatePathOrThrow(req.body?.claudeSettingsPath, 'claudeSettingsPath');
      const claudeDesktopConfigPath = validatePathOrThrow(req.body?.claudeDesktopConfigPath, 'claudeDesktopConfigPath');
      const openCodeConfigPath = validatePathOrThrow(req.body?.openCodeConfigPath, 'openCodeConfigPath');
      const geminiSettingsPath = validatePathOrThrow(req.body?.geminiSettingsPath, 'geminiSettingsPath');
      const qwenSettingsPath = validatePathOrThrow(req.body?.qwenSettingsPath, 'qwenSettingsPath');
      const codeBuddyMcpPath = validatePathOrThrow(req.body?.codeBuddyMcpPath, 'codeBuddyMcpPath');
      ok(res, {
        data: await previewMcpImport(req.body || {}, {
          codexHome: codexHome || undefined,
          claudeSettingsPath: claudeSettingsPath || undefined,
          claudeDesktopConfigPath: claudeDesktopConfigPath || undefined,
          openCodeConfigPath: openCodeConfigPath || undefined,
          geminiSettingsPath: geminiSettingsPath || undefined,
          qwenSettingsPath: qwenSettingsPath || undefined,
          codeBuddyMcpPath: codeBuddyMcpPath || undefined,
          targetTool: req.body?.targetTool || 'codex',
          overwrite: Boolean(req.body?.overwrite),
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/mcp/import/preview', async (req, res) => {
    try {
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      const claudeSettingsPath = validatePathOrThrow(req.query.claudeSettingsPath, 'claudeSettingsPath');
      const claudeDesktopConfigPath = validatePathOrThrow(req.query.claudeDesktopConfigPath, 'claudeDesktopConfigPath');
      const openCodeConfigPath = validatePathOrThrow(req.query.openCodeConfigPath, 'openCodeConfigPath');
      const geminiSettingsPath = validatePathOrThrow(req.query.geminiSettingsPath, 'geminiSettingsPath');
      const qwenSettingsPath = validatePathOrThrow(req.query.qwenSettingsPath, 'qwenSettingsPath');
      const codeBuddyMcpPath = validatePathOrThrow(req.query.codeBuddyMcpPath, 'codeBuddyMcpPath');
      const input = req.query.payload
        ? { url: `easyai://import?payload=${req.query.payload}` }
        : { url: req.query.url || req.query.text || '' };
      ok(res, {
        data: await previewMcpImport(input, {
          codexHome: codexHome || undefined,
          claudeSettingsPath: claudeSettingsPath || undefined,
          claudeDesktopConfigPath: claudeDesktopConfigPath || undefined,
          openCodeConfigPath: openCodeConfigPath || undefined,
          geminiSettingsPath: geminiSettingsPath || undefined,
          qwenSettingsPath: qwenSettingsPath || undefined,
          codeBuddyMcpPath: codeBuddyMcpPath || undefined,
          targetTool: req.query.targetTool || 'codex',
          overwrite: req.query.overwrite === '1' || req.query.overwrite === 'true',
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/mcp/import/apply', async (req, res) => {
    try {
      const codexHome = validatePathOrThrow(req.body?.codexHome, 'codexHome');
      const claudeSettingsPath = validatePathOrThrow(req.body?.claudeSettingsPath, 'claudeSettingsPath');
      const claudeDesktopConfigPath = validatePathOrThrow(req.body?.claudeDesktopConfigPath, 'claudeDesktopConfigPath');
      const openCodeConfigPath = validatePathOrThrow(req.body?.openCodeConfigPath, 'openCodeConfigPath');
      const geminiSettingsPath = validatePathOrThrow(req.body?.geminiSettingsPath, 'geminiSettingsPath');
      const qwenSettingsPath = validatePathOrThrow(req.body?.qwenSettingsPath, 'qwenSettingsPath');
      const codeBuddyMcpPath = validatePathOrThrow(req.body?.codeBuddyMcpPath, 'codeBuddyMcpPath');
      ok(res, {
        data: await applyMcpImport(req.body || {}, {
          codexHome: codexHome || undefined,
          claudeSettingsPath: claudeSettingsPath || undefined,
          claudeDesktopConfigPath: claudeDesktopConfigPath || undefined,
          openCodeConfigPath: openCodeConfigPath || undefined,
          geminiSettingsPath: geminiSettingsPath || undefined,
          qwenSettingsPath: qwenSettingsPath || undefined,
          codeBuddyMcpPath: codeBuddyMcpPath || undefined,
          targetTool: req.body?.targetTool || 'codex',
          dryRun: req.body?.dryRun !== false,
          overwrite: Boolean(req.body?.overwrite),
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/prompts/inventory', async (req, res) => {
    try {
      const projectPath = validatePathOrThrow(req.query.projectPath, 'projectPath');
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      const qwenHome = validatePathOrThrow(req.query.qwenHome, 'qwenHome');
      const codeBuddyHome = validatePathOrThrow(req.query.codeBuddyHome, 'codeBuddyHome');
      ok(res, {
        data: await listPromptInventory({
          projectPath: projectPath || '',
          codexHome: codexHome || undefined,
          qwenHome: qwenHome || undefined,
          codeBuddyHome: codeBuddyHome || undefined,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/prompts/import/preview', async (req, res) => {
    try {
      const projectPath = validatePathOrThrow(req.body?.projectPath, 'projectPath');
      const codexHome = validatePathOrThrow(req.body?.codexHome, 'codexHome');
      const qwenHome = validatePathOrThrow(req.body?.qwenHome, 'qwenHome');
      const codeBuddyHome = validatePathOrThrow(req.body?.codeBuddyHome, 'codeBuddyHome');
      ok(res, {
        data: await previewPromptImport(req.body || {}, {
          projectPath: projectPath || '',
          codexHome: codexHome || undefined,
          qwenHome: qwenHome || undefined,
          codeBuddyHome: codeBuddyHome || undefined,
          scope: req.body?.scope || undefined,
          targetTool: req.body?.targetTool || undefined,
          overwrite: Boolean(req.body?.overwrite),
          append: Boolean(req.body?.append),
          expectedSha256ByPath: req.body?.expectedSha256ByPath,
          expectedSha256ById: req.body?.expectedSha256ById,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/prompts/import/preview', async (req, res) => {
    try {
      const projectPath = validatePathOrThrow(req.query.projectPath, 'projectPath');
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      const qwenHome = validatePathOrThrow(req.query.qwenHome, 'qwenHome');
      const codeBuddyHome = validatePathOrThrow(req.query.codeBuddyHome, 'codeBuddyHome');
      const input = req.query.payload
        ? { url: `easyai://import?payload=${req.query.payload}` }
        : { url: req.query.url || req.query.text || '' };
      ok(res, {
        data: await previewPromptImport(input, {
          projectPath: projectPath || '',
          codexHome: codexHome || undefined,
          qwenHome: qwenHome || undefined,
          codeBuddyHome: codeBuddyHome || undefined,
          scope: req.query.scope || undefined,
          targetTool: req.query.targetTool || undefined,
          overwrite: req.query.overwrite === '1' || req.query.overwrite === 'true',
          append: req.query.append === '1' || req.query.append === 'true',
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/prompts/import/apply', async (req, res) => {
    try {
      const projectPath = validatePathOrThrow(req.body?.projectPath, 'projectPath');
      const codexHome = validatePathOrThrow(req.body?.codexHome, 'codexHome');
      const qwenHome = validatePathOrThrow(req.body?.qwenHome, 'qwenHome');
      const codeBuddyHome = validatePathOrThrow(req.body?.codeBuddyHome, 'codeBuddyHome');
      ok(res, {
        data: await applyPromptImport(req.body || {}, {
          projectPath: projectPath || '',
          codexHome: codexHome || undefined,
          qwenHome: qwenHome || undefined,
          codeBuddyHome: codeBuddyHome || undefined,
          scope: req.body?.scope || undefined,
          targetTool: req.body?.targetTool || undefined,
          dryRun: req.body?.dryRun !== false,
          overwrite: Boolean(req.body?.overwrite),
          append: Boolean(req.body?.append),
          expectedSha256: req.body?.expectedSha256,
          expectedSha256ByPath: req.body?.expectedSha256ByPath,
          expectedSha256ById: req.body?.expectedSha256ById,
          requireExpectedSha256: Boolean(req.body?.requireExpectedSha256),
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/skills/inventory', async (req, res) => {
    try {
      const codeBuddySkillsRoot = validatePathOrThrow(req.query.codeBuddySkillsRoot, 'codeBuddySkillsRoot');
      ok(res, {
        data: await listSkillInventory({
          codeBuddySkillsRoot: codeBuddySkillsRoot || undefined,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/skills/import/preview', async (req, res) => {
    try {
      const codexHome = validatePathOrThrow(req.body?.codexHome, 'codexHome');
      const codexSkillsRoot = validatePathOrThrow(req.body?.codexSkillsRoot, 'codexSkillsRoot');
      const claudeSkillsRoot = validatePathOrThrow(req.body?.claudeSkillsRoot, 'claudeSkillsRoot');
      const codeBuddySkillsRoot = validatePathOrThrow(req.body?.codeBuddySkillsRoot, 'codeBuddySkillsRoot');
      const easyaiSkillsRoot = validatePathOrThrow(req.body?.easyaiSkillsRoot, 'easyaiSkillsRoot');
      ok(res, {
        data: await previewSkillImport(req.body || {}, {
          codexHome: codexHome || undefined,
          codexSkillsRoot: codexSkillsRoot || undefined,
          claudeSkillsRoot: claudeSkillsRoot || undefined,
          codeBuddySkillsRoot: codeBuddySkillsRoot || undefined,
          easyaiSkillsRoot: easyaiSkillsRoot || undefined,
          targetTool: req.body?.targetTool || 'codex',
          installMode: req.body?.installMode || req.body?.mode || 'copy',
          overwrite: Boolean(req.body?.overwrite),
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/skills/import/preview', async (req, res) => {
    try {
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      const codexSkillsRoot = validatePathOrThrow(req.query.codexSkillsRoot, 'codexSkillsRoot');
      const claudeSkillsRoot = validatePathOrThrow(req.query.claudeSkillsRoot, 'claudeSkillsRoot');
      const codeBuddySkillsRoot = validatePathOrThrow(req.query.codeBuddySkillsRoot, 'codeBuddySkillsRoot');
      const easyaiSkillsRoot = validatePathOrThrow(req.query.easyaiSkillsRoot, 'easyaiSkillsRoot');
      const input = req.query.payload
        ? { url: `easyai://import?payload=${req.query.payload}` }
        : { url: req.query.url || req.query.text || '' };
      ok(res, {
        data: await previewSkillImport(input, {
          codexHome: codexHome || undefined,
          codexSkillsRoot: codexSkillsRoot || undefined,
          claudeSkillsRoot: claudeSkillsRoot || undefined,
          codeBuddySkillsRoot: codeBuddySkillsRoot || undefined,
          easyaiSkillsRoot: easyaiSkillsRoot || undefined,
          targetTool: req.query.targetTool || 'codex',
          installMode: req.query.installMode || req.query.mode || 'copy',
          overwrite: req.query.overwrite === '1' || req.query.overwrite === 'true',
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/skills/import/apply', async (req, res) => {
    try {
      const codexHome = validatePathOrThrow(req.body?.codexHome, 'codexHome');
      const codexSkillsRoot = validatePathOrThrow(req.body?.codexSkillsRoot, 'codexSkillsRoot');
      const claudeSkillsRoot = validatePathOrThrow(req.body?.claudeSkillsRoot, 'claudeSkillsRoot');
      const codeBuddySkillsRoot = validatePathOrThrow(req.body?.codeBuddySkillsRoot, 'codeBuddySkillsRoot');
      const easyaiSkillsRoot = validatePathOrThrow(req.body?.easyaiSkillsRoot, 'easyaiSkillsRoot');
      ok(res, {
        data: await applySkillImport(req.body || {}, {
          codexHome: codexHome || undefined,
          codexSkillsRoot: codexSkillsRoot || undefined,
          claudeSkillsRoot: claudeSkillsRoot || undefined,
          codeBuddySkillsRoot: codeBuddySkillsRoot || undefined,
          easyaiSkillsRoot: easyaiSkillsRoot || undefined,
          targetTool: req.body?.targetTool || 'codex',
          installMode: req.body?.installMode || req.body?.mode || 'copy',
          dryRun: req.body?.dryRun !== false,
          overwrite: Boolean(req.body?.overwrite),
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/sessions/inventory', async (req, res) => {
    try {
      const cwd = validatePathOrThrow(req.query.cwd, 'cwd');
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      const claudeHome = validatePathOrThrow(req.query.claudeHome, 'claudeHome');
      const geminiHome = validatePathOrThrow(req.query.geminiHome, 'geminiHome');
      const qwenHome = validatePathOrThrow(req.query.qwenHome, 'qwenHome');
      const codeBuddyHome = validatePathOrThrow(req.query.codeBuddyHome, 'codeBuddyHome');
      const openClawHome = validatePathOrThrow(req.query.openClawHome, 'openClawHome');
      const hermesHome = validatePathOrThrow(req.query.hermesHome, 'hermesHome');
      const includeTools = req.query.tools
        ? String(req.query.tools).split(',').map((item) => item.trim()).filter(Boolean)
        : undefined;
      ok(res, {
        data: await listSessionInventory({
          codexHome: codexHome || undefined,
          claudeHome: claudeHome || undefined,
          geminiHome: geminiHome || undefined,
          qwenHome: qwenHome || undefined,
          codeBuddyHome: codeBuddyHome || undefined,
          openClawHome: openClawHome || undefined,
          hermesHome: hermesHome || undefined,
          cwd: cwd || '',
          query: req.query.query || '',
          tool: req.query.tool || '',
          provider: req.query.provider || '',
          project: req.query.project || '',
          limit: req.query.limit || undefined,
          includeTools,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/sessions/trash', async (req, res) => {
    try {
      const trashRoot = validatePathOrThrow(req.query.trashRoot, 'trashRoot');
      ok(res, {
        data: await listSessionTrash({
          trashRoot: trashRoot || undefined,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/sessions/archive', async (req, res) => {
    try {
      const body = req.body || {};
      const sourcePath = validatePathOrThrow(body.sourcePath || body.filePath, 'sourcePath');
      const codexHome = validatePathOrThrow(body.codexHome, 'codexHome');
      const claudeHome = validatePathOrThrow(body.claudeHome, 'claudeHome');
      const geminiHome = validatePathOrThrow(body.geminiHome, 'geminiHome');
      const qwenHome = validatePathOrThrow(body.qwenHome, 'qwenHome');
      const codeBuddyHome = validatePathOrThrow(body.codeBuddyHome, 'codeBuddyHome');
      const openClawHome = validatePathOrThrow(body.openClawHome, 'openClawHome');
      const hermesHome = validatePathOrThrow(body.hermesHome, 'hermesHome');
      const trashRoot = validatePathOrThrow(body.trashRoot, 'trashRoot');
      ok(res, {
        data: await archiveSession({
          ...body,
          sourcePath,
        }, {
          codexHome: codexHome || undefined,
          claudeHome: claudeHome || undefined,
          geminiHome: geminiHome || undefined,
          qwenHome: qwenHome || undefined,
          codeBuddyHome: codeBuddyHome || undefined,
          openClawHome: openClawHome || undefined,
          hermesHome: hermesHome || undefined,
          trashRoot: trashRoot || undefined,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/sessions/restore', async (req, res) => {
    try {
      const body = req.body || {};
      const codexHome = validatePathOrThrow(body.codexHome, 'codexHome');
      const claudeHome = validatePathOrThrow(body.claudeHome, 'claudeHome');
      const geminiHome = validatePathOrThrow(body.geminiHome, 'geminiHome');
      const qwenHome = validatePathOrThrow(body.qwenHome, 'qwenHome');
      const codeBuddyHome = validatePathOrThrow(body.codeBuddyHome, 'codeBuddyHome');
      const openClawHome = validatePathOrThrow(body.openClawHome, 'openClawHome');
      const hermesHome = validatePathOrThrow(body.hermesHome, 'hermesHome');
      const targetPath = validatePathOrThrow(body.targetPath, 'targetPath');
      const trashRoot = validatePathOrThrow(body.trashRoot, 'trashRoot');
      ok(res, {
        data: await restoreSession({
          ...body,
          targetPath: targetPath || undefined,
        }, {
          codexHome: codexHome || undefined,
          claudeHome: claudeHome || undefined,
          geminiHome: geminiHome || undefined,
          qwenHome: qwenHome || undefined,
          codeBuddyHome: codeBuddyHome || undefined,
          openClawHome: openClawHome || undefined,
          hermesHome: hermesHome || undefined,
          trashRoot: trashRoot || undefined,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/usage/inventory', async (req, res) => {
    try {
      const codexHome = validatePathOrThrow(req.query.codexHome, 'codexHome');
      const qwenHome = validatePathOrThrow(req.query.qwenHome, 'qwenHome');
      const codeBuddyHome = validatePathOrThrow(req.query.codeBuddyHome, 'codeBuddyHome');
      const includeTools = req.query.tools
        ? String(req.query.tools).split(',').map((item) => item.trim()).filter(Boolean)
        : undefined;
      ok(res, {
        data: await listUsageInventory({
          codexHome: codexHome || undefined,
          qwenHome: qwenHome || undefined,
          codeBuddyHome: codeBuddyHome || undefined,
          days: req.query.days || undefined,
          force: req.query.force === '1' || req.query.force === 'true',
          cacheOnly: req.query.cacheOnly === '1' || req.query.cacheOnly === 'true',
          claudeUsageScope: req.query.claudeUsageScope || req.query.usageScope || 'active',
          limit: req.query.limit || undefined,
          includeTools,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/usage/custom-prices', async (_req, res) => {
    try {
      ok(res, { data: await readCustomPriceBook() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/usage/custom-prices', async (req, res) => {
    try {
      ok(res, { data: await saveCustomPriceBook(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/sync/targets', async (_req, res) => {
    try {
      ok(res, { data: await listSyncTargets() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/sync/targets', async (req, res) => {
    try {
      ok(res, { data: await saveSyncTargets(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/sync/snapshots', async (req, res) => {
    try {
      const targetPath = validatePathOrThrow(req.query.targetPath || req.query.path, 'targetPath');
      ok(res, {
        data: await listSyncSnapshots({
          ...req.query,
          targetPath: targetPath || undefined,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/sync/push', async (req, res) => {
    try {
      const body = req.body || {};
      const targetPath = validatePathOrThrow(body.targetPath || body.path, 'targetPath');
      const projectPath = validatePathOrThrow(body.projectPath, 'projectPath');
      const cwd = validatePathOrThrow(body.cwd, 'cwd');
      const codexHome = validatePathOrThrow(body.codexHome, 'codexHome');
      const bundle = body.bundle && typeof body.bundle === 'object'
        ? body.bundle
        : await buildAssetExportBundle({
            includeLocal: Boolean(body.includeLocal || body.local),
            projectPath: projectPath || '',
            cwd: cwd || '',
            codexHome: codexHome || '',
            limit: body.limit || 100,
          });
      ok(res, {
        data: await pushSyncSnapshot({
          ...body,
          targetPath: targetPath || undefined,
          bundle,
          dryRun: body.dryRun !== false,
        }),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/sync/pull', async (req, res) => {
    try {
      const body = req.body || {};
      const targetPath = validatePathOrThrow(body.targetPath || body.path, 'targetPath');
      const codexHome = validatePathOrThrow(body.codexHome, 'codexHome');
      const projectPath = validatePathOrThrow(body.projectPath, 'projectPath');
      const claudeSettingsPath = validatePathOrThrow(body.claudeSettingsPath, 'claudeSettingsPath');
      const claudeDesktopConfigPath = validatePathOrThrow(body.claudeDesktopConfigPath, 'claudeDesktopConfigPath');
      const openCodeConfigPath = validatePathOrThrow(body.openCodeConfigPath, 'openCodeConfigPath');
      const codexSkillsRoot = validatePathOrThrow(body.codexSkillsRoot, 'codexSkillsRoot');
      const claudeSkillsRoot = validatePathOrThrow(body.claudeSkillsRoot, 'claudeSkillsRoot');
      const easyaiSkillsRoot = validatePathOrThrow(body.easyaiSkillsRoot, 'easyaiSkillsRoot');
      const snapshot = await readSyncSnapshot({
        ...body,
        targetPath: targetPath || undefined,
      });
      const importResult = await applyUnifiedAssetImport({
        ...body,
        payload: snapshot.bundle,
        dryRun: body.dryRun !== false,
      }, {
        codexHome: codexHome || undefined,
        projectPath: projectPath || '',
        claudeSettingsPath: claudeSettingsPath || undefined,
        claudeDesktopConfigPath: claudeDesktopConfigPath || undefined,
        openCodeConfigPath: openCodeConfigPath || undefined,
        codexSkillsRoot: codexSkillsRoot || undefined,
        claudeSkillsRoot: claudeSkillsRoot || undefined,
        easyaiSkillsRoot: easyaiSkillsRoot || undefined,
        scope: body.scope || 'global',
        dryRun: body.dryRun !== false,
        overwrite: Boolean(body.overwrite),
        append: Boolean(body.append),
        installMode: body.installMode || body.mode || 'copy',
        includeCatalogPresets: body.includeCatalogPresets !== false,
        targetTool: body.targetTool || 'all',
      });
      ok(res, {
        data: {
          schema: 'easyaiconfig.sync-pull-apply.v1',
          dryRun: body.dryRun !== false,
          changed: Boolean(importResult.summary?.written),
          target: snapshot.target,
          entry: snapshot.entry,
          importResult,
          summary: {
            pulled: 1,
            bytes: snapshot.summary?.bytes || snapshot.entry?.bytes || 0,
            changed: Boolean(importResult.summary?.changed),
            written: Boolean(importResult.summary?.written),
            conflicts: Number(importResult.summary?.conflicts || 0),
          },
        },
      });
    } catch (error) {
      fail(res, error);
    }
  });

  // ─── Per-project Provider bindings (P0 #3 ⭐) ────────────────────
  app.get('/api/project-binding', async (req, res) => {
    try {
      const cwd = String(req.query.cwd || '').trim();
      const tool = String(req.query.tool || '').trim();
      ok(res, { data: { binding: await getProjectBinding(cwd, tool) } });
    } catch (error) { fail(res, error); }
  });
  app.post('/api/project-binding', async (req, res) => {
    try { ok(res, { data: await setProjectBinding(req.body || {}) }); }
    catch (error) { fail(res, error); }
  });
  app.delete('/api/project-binding', async (req, res) => {
    try { ok(res, { data: await removeProjectBinding(req.body || {}) }); }
    catch (error) { fail(res, error); }
  });
  app.get('/api/project-bindings', async (_req, res) => {
    try { ok(res, { data: { bindings: await listProjectBindings() } }); }
    catch (error) { fail(res, error); }
  });
  app.get('/api/project-binding/summary', async (req, res) => {
    try {
      const cwd = String(req.query.cwd || '').trim();
      ok(res, { data: await summarizeBindingsForCwd(cwd) });
    } catch (error) { fail(res, error); }
  });

  // ─── 国产 API 适配器（P1 #5） ─────────────────────────────────
  app.get('/api/cn-provider-adapters', async (_req, res) => {
    try { ok(res, { data: { adapters: listCnProviderAdapters() } }); }
    catch (error) { fail(res, error); }
  });
  app.get('/api/cn-provider-adapter/match', async (req, res) => {
    try {
      const baseUrl = String(req.query.baseUrl || '').trim();
      const adapter = getAdapterForBaseUrl(baseUrl);
      ok(res, { data: { adapter: adapter ? {
        slug: adapter.slug,
        name: adapter.name,
        wireApi: adapter.wireApi,
        defaultModel: adapter.defaultModel,
        envKey: adapter.envKey,
        hint: adapter.hint,
        knownModels: [...adapter.knownModels],
      } : null } });
    } catch (error) { fail(res, error); }
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


  app.post('/api/config/delete-provider', async (req, res) => {
    try {
      ok(res, { data: await deleteProviderConfig(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/config/use-oauth', async (req, res) => {
    try {
      ok(res, { data: await useOauthConfig(req.body || {}) });
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

  app.post('/api/codex/update-domestic', async (_req, res) => {
    try {
      ok(res, { data: await updateCodexDomestic() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/install-version', async (req, res) => {
    try {
      ok(res, { data: await installCodexVersion(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex/install-version-domestic', async (req, res) => {
    try {
      ok(res, { data: await installCodexVersion({ ...(req.body || {}), domestic: true }) });
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

  // ─── Codex OAuth profiles (multi-account, P0 #2) ──────────────
  app.get('/api/codex/oauth/profiles', async (req, res) => {
    try {
      ok(res, { data: await listCodexOauthProfiles({ codexHome: req.query.codexHome }) });
    } catch (error) { fail(res, error); }
  });
  app.post('/api/codex/oauth/profiles/save-current', async (req, res) => {
    try {
      ok(res, { data: await saveCurrentCodexOauthProfile(req.body || {}) });
    } catch (error) { fail(res, error); }
  });
  app.post('/api/codex/oauth/profiles/create', async (req, res) => {
    try {
      ok(res, { data: await createCodexOauthProfile(req.body || {}) });
    } catch (error) { fail(res, error); }
  });
  app.post('/api/codex/oauth/profiles/switch', async (req, res) => {
    try {
      ok(res, { data: await switchCodexOauthProfile(req.body || {}) });
    } catch (error) { fail(res, error); }
  });
  app.post('/api/codex/oauth/profiles/rename', async (req, res) => {
    try {
      ok(res, { data: await renameCodexOauthProfile(req.body || {}) });
    } catch (error) { fail(res, error); }
  });
  app.post('/api/codex/oauth/profiles/delete', async (req, res) => {
    try {
      ok(res, { data: await deleteCodexOauthProfile(req.body || {}) });
    } catch (error) { fail(res, error); }
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

  app.post('/api/codex-app/install/start', async (req, res) => {
    try {
      ok(res, { data: await startCodexAppInstallTask(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/codex-app/install/status', async (req, res) => {
    try {
      ok(res, { data: await getCodexAppInstallTask({ taskId: req.query.taskId || '' }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codex-app/install/cancel', async (req, res) => {
    try {
      ok(res, { data: await cancelCodexAppInstallTask(req.body || {}) });
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

  app.post('/api/claudecode/update-domestic', async (_req, res) => {
    try {
      ok(res, { data: await updateClaudeCodeDomestic() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/install-version', async (req, res) => {
    try {
      ok(res, { data: await installClaudeCodeVersion(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/claudecode/install-version-domestic', async (req, res) => {
    try {
      ok(res, { data: await installClaudeCodeVersion({ ...(req.body || {}), domestic: true }) });
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

  app.post('/api/claude-desktop/launch', async (req, res) => {
    try {
      ok(res, { data: await launchClaudeDesktop(req.body || {}) });
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

  // ─── Claude Code OAuth profiles (multi-account, P0 #2) ──────────
  app.get('/api/claudecode/oauth/profiles', async (_req, res) => {
    try { ok(res, { data: await listClaudecodeOauthProfiles() }); }
    catch (error) { fail(res, error); }
  });
  app.post('/api/claudecode/oauth/profiles/create', async (req, res) => {
    try { ok(res, { data: await createClaudecodeOauthProfile(req.body || {}) }); }
    catch (error) { fail(res, error); }
  });
  app.post('/api/claudecode/oauth/profiles/switch', async (req, res) => {
    try { ok(res, { data: await switchClaudecodeOauthProfile(req.body || {}) }); }
    catch (error) { fail(res, error); }
  });
  app.post('/api/claudecode/oauth/profiles/rename', async (req, res) => {
    try { ok(res, { data: await renameClaudecodeOauthProfile(req.body || {}) }); }
    catch (error) { fail(res, error); }
  });
  app.post('/api/claudecode/oauth/profiles/delete', async (req, res) => {
    try { ok(res, { data: await deleteClaudecodeOauthProfile(req.body || {}) }); }
    catch (error) { fail(res, error); }
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

  app.post('/api/opencode/install-version', async (req, res) => {
    try {
      ok(res, { data: await installOpenCodeVersion(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/opencode/install-version-domestic', async (req, res) => {
    try {
      ok(res, { data: await installOpenCodeVersion({ ...(req.body || {}), domestic: true }) });
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

  // ─── Hermes Agent endpoints ───
  app.get('/api/hermes/state', async (_req, res) => {
    try {
      ok(res, { data: await loadHermesState() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/gemini/state', async (_req, res) => {
    try {
      ok(res, { data: await loadGeminiState() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/gemini/install', async (_req, res) => {
    try {
      ok(res, { data: await installGemini() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/gemini/reinstall', async (_req, res) => {
    try {
      ok(res, { data: await reinstallGemini() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/gemini/update', async (_req, res) => {
    try {
      ok(res, { data: await updateGemini() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/gemini/update-domestic', async (_req, res) => {
    try {
      ok(res, { data: await updateGeminiDomestic() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/gemini/install-version', async (req, res) => {
    try {
      ok(res, { data: await installGeminiVersion(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/gemini/install-version-domestic', async (req, res) => {
    try {
      ok(res, { data: await installGeminiVersion({ ...(req.body || {}), domestic: true }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/gemini/uninstall', async (_req, res) => {
    try {
      ok(res, { data: await uninstallGemini() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/qwen-code/install', async (_req, res) => {
    try {
      ok(res, { data: await installQwenCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/qwen-code/reinstall', async (_req, res) => {
    try {
      ok(res, { data: await reinstallQwenCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/qwen-code/update', async (_req, res) => {
    try {
      ok(res, { data: await updateQwenCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/qwen-code/update-domestic', async (_req, res) => {
    try {
      ok(res, { data: await updateQwenCodeDomestic() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/qwen-code/install-version', async (req, res) => {
    try {
      ok(res, { data: await installQwenCodeVersion(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/qwen-code/install-version-domestic', async (req, res) => {
    try {
      ok(res, { data: await installQwenCodeVersion({ ...(req.body || {}), domestic: true }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/qwen-code/uninstall', async (_req, res) => {
    try {
      ok(res, { data: await uninstallQwenCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codebuddy-code/install', async (_req, res) => {
    try {
      ok(res, { data: await installCodeBuddyCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codebuddy-code/reinstall', async (_req, res) => {
    try {
      ok(res, { data: await reinstallCodeBuddyCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codebuddy-code/update', async (_req, res) => {
    try {
      ok(res, { data: await updateCodeBuddyCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codebuddy-code/update-domestic', async (_req, res) => {
    try {
      ok(res, { data: await updateCodeBuddyCodeDomestic() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codebuddy-code/install-version', async (req, res) => {
    try {
      ok(res, { data: await installCodeBuddyCodeVersion(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codebuddy-code/install-version-domestic', async (req, res) => {
    try {
      ok(res, { data: await installCodeBuddyCodeVersion({ ...(req.body || {}), domestic: true }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/codebuddy-code/uninstall', async (_req, res) => {
    try {
      ok(res, { data: await uninstallCodeBuddyCode() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/hermes/launch', async (req, res) => {
    try {
      ok(res, { data: await launchHermes(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/gemini/launch', async (req, res) => {
    try {
      ok(res, { data: await launchGemini(req.body || {}) });
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

  app.post('/api/openclaw/update-domestic', async (_req, res) => {
    try {
      ok(res, { data: await updateOpenClawDomestic() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/install-version', async (req, res) => {
    try {
      ok(res, { data: await installOpenClawVersion(req.body || {}) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/openclaw/install-version-domestic', async (req, res) => {
    try {
      ok(res, { data: await installOpenClawVersion({ ...(req.body || {}), domestic: true }) });
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
  if (options.openBrowser !== false) {
    open(url).catch(() => { });
  }

  return { app, server, url, localApiToken };
}
