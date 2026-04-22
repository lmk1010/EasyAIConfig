import {
  enrichConfigStoreRecipes,
  getConfigStoreSuggestionChips,
  normalizeStoreText,
  runConfigStoreAssistant,
  searchConfigStoreRecipes,
} from './config-store-engine.js';
import {
  getAllConfigStoreRecipes,
  getConfigStoreRecipesByTool,
} from './config-store-recipes.js';

const state = {
  current: null,
  backups: [],
  detected: null,
  metaDirty: false,
  claudeCodeState: null,
  opencodeState: null,
  codexAppState: null,
  openCodeDesktopState: null,
  openCodeEcosystemState: null,
  toolsCatalogQuery: '',
  toolsCatalogTag: 'all',
  toolsCatalogPage: 1,
  toolsCatalogPageSize: 9,
  providerHealth: {},
  claudeProviderHealth: {},
  openCodeProviderHealth: {},
  providerSecrets: {},
  claudeSelectedProviderKey: '',
  claudeProviderDetailKey: '',
  openCodeProviderDetailKey: '',
  openCodeProviderSearch: '',
  openCodeProviderDraftModels: [],
  configEditorSearchOpen: false,
  apiKeyField: {
    providerKey: '',
    baseUrl: '',
    maskedValue: '',
    actualValue: '',
    hasStored: false,
    revealed: false,
    dirty: false,
  },
  providerDropdownOpen: false,
  advancedOpen: false,
  advancedTimer: null,
  configEditorOpen: false,
  configEditorTimer: null,
  configEditorTool: 'codex',
  appUpdate: null,
  appUpdateProgress: null,
  appUpdateProgressTimer: 0,
  updateDialogOpen: false,
  updateDialogTimer: null,
  updateDialogResolver: null,
  updateDialogCancelHandler: null,
  updateDialogLocked: false,
  aboutOpen: false,
  aboutTimer: null,
  activePage: 'quick',
  // Setup Wizard
  wizardOpen: false,
  wizardStep: 0,
  wizardEnv: null,
  wizardDetected: null,
  // Theme
  theme: 'dark',
  // Multi-tool
  activeTool: 'codex',
  tools: [],
  toolLastPage: {},
  consoleTool: 'codex',
  dashboardTool: 'codex',
  dashboardDays: Number(localStorage.getItem('easyaiconfig_dashboard_days') || 30) || 30,
  dashboardMetrics: { codex: null, opencode: null },
  dashboardLoading: false,
  dashboardRefreshing: false,
  dashboardMetricsFetchedAt: 0,
  dashboardAutoRefreshTimer: null,
  dashboardAutoRefreshMs: Math.max(0, Number(localStorage.getItem('easyaiconfig_dashboard_auto_refresh_ms') || (30 * 60 * 1000)) || 0),
  consoleRefreshing: false,
  // Wizard
  wizardSelectedTool: 'codex',
  wizardSelectedMethod: 'npm',
  // Tasks
  tasks: [],
  openClawInstallView: {
    lastRenderKey: '',
    lastLogsText: '',
    pauseUntil: 0,
    pendingTask: null,
    activeTaskId: '',
    cancelBusy: false,
  },
  openCodeInstallView: {
    lastRenderKey: '',
    lastLogsText: '',
    pauseUntil: 0,
    pendingTask: null,
    timerId: 0,
    activeTaskId: '',
    cancelBusy: false,
  },
  toolRuntimeSync: {
    running: null,
    lastAt: 0,
  },
  openClawSetupFlowId: 0,
  openClawSetupContext: null,
  openClawLastRepair: null,
  openClawConfigView: localStorage.getItem('easyaiconfig_oc_config_view') === 'minimal' ? 'minimal' : 'full',
  codexAuthView: localStorage.getItem('easyaiconfig_codex_auth_view') === 'api_key' ? 'api_key' : 'official',
  codexTerminalProfile: 'auto',
  codexTerminalProfiles: [],
  codexTerminalMenuOpen: false,
  codexResumeSessions: [],
  codexResumeLoading: false,
  codexResumeShowAll: false,
  systemStorage: null,
  systemStorageLoading: false,
  configStoreGuide: { recipeId: '', values: {} },
  configStoreAssistant: { recipeId: '', values: {}, missing: [] },
};

const el = (id) => document.getElementById(id);
const tauriInvoke = window.__TAURI__?.core?.invoke || null;
const rawCodeEditors = new Map();

function renderQuickRailSupportPanel() {
  const titleEl = el('configTipsTitle');
  const bodyEl = el('configTipsList');
  if (!titleEl || !bodyEl) return;

  const tips = Array.isArray(state.quickTips) ? state.quickTips : [];
  titleEl.textContent = '配置提示';
  bodyEl.className = 'feature-list';
  bodyEl.innerHTML = tips.map((text, index) => `<div class="feature-row"><span>${index + 1}</span><strong>${escapeHtml(text)}</strong></div>`).join('');
}

function buildOpenClawDashboardFallbackUrl(baseUrl) {
  const raw = baseUrl || state.openclawState?.dashboardUrl || state.openclawState?.gatewayUrl || '';
  if (!raw) return '';
  const url = new URL(raw, window.location.origin);
  const token = state.openclawState?.config?.gateway?.auth?.token || state.openclawState?.gatewayToken || '';
  if (token) {
    url.hash = '';
    url.searchParams.set('token', token);
  }
  return url.toString();
}

function isLikelyOpenClawBootstrapUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    return Boolean(url.hash || url.searchParams.get('token') || url.pathname !== '/');
  } catch {
    return false;
  }
}

async function openOpenClawDashboard(baseUrl) {
  let url = isLikelyOpenClawBootstrapUrl(baseUrl) ? String(baseUrl || '').trim() : '';
  if (!url) {
    try {
      const json = await api('/api/openclaw/dashboard-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: state.current?.launch?.cwd || '' }),
      });
      url = (json?.ok ? (json.data?.url || '') : '') || buildOpenClawDashboardFallbackUrl(baseUrl);
    } catch { /* ignore */ }
  }
  if (!url) return;
  api('/api/open-url', { method: 'POST', body: JSON.stringify({ url }) }).then(res => {
    if (!res?.ok) window.open(url, '_blank');
  }).catch(() => window.open(url, '_blank'));
}

/* ── Task Manager ── */
let _taskId = 0;

function addTask(name, meta = {}) {
  const id = ++_taskId;
  const task = { id, name, status: 'running', progress: -1, message: '', startTime: Date.now(), ...meta };
  state.tasks.push(task);
  renderSidebarTasks();
  _ensureTaskTimer();
  return id;
}

function updateTask(id, updates) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  if (updates.status && updates.status !== 'running' && !task.endTime) {
    updates.endTime = Date.now();
  }
  Object.assign(task, updates);
  renderSidebarTasks();
  renderTasksPage();
}

function removeTask(id, delay = 0) {
  if (delay > 0) {
    setTimeout(() => {
      state.tasks = state.tasks.filter(t => t.id !== id);
      renderSidebarTasks();
      renderTasksPage();
    }, delay);
  } else {
    state.tasks = state.tasks.filter(t => t.id !== id);
    renderSidebarTasks();
    renderTasksPage();
  }
}

function renderSidebarTasks() {
  // Update nav badge with running count
  const badge = el('taskNavBadge');
  const running = state.tasks.filter(t => t.status === 'running').length;
  if (badge) {
    if (running > 0) {
      badge.style.display = '';
      badge.textContent = running;
    } else {
      badge.style.display = 'none';
    }
  }
}

function _formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

let _taskPageFilter = 'all';

function renderTasksPage() {
  const list = el('tasksPageList');
  const empty = el('tasksEmpty');
  if (!list) return;

  let tasks = [...state.tasks].reverse(); // newest first
  if (_taskPageFilter !== 'all') {
    tasks = tasks.filter(t => t.status === _taskPageFilter);
  }

  if (tasks.length === 0) {
    if (empty) empty.style.display = '';
    list.querySelectorAll('.task-page-item').forEach(e => e.remove());
    return;
  }
  if (empty) empty.style.display = 'none';

  const now = Date.now();
  const html = tasks.map(t => {
    let indicator, statusClass;
    if (t.status === 'running') {
      indicator = '<div class="sti-spinner"></div>';
      statusClass = 'running';
    } else if (t.status === 'done') {
      indicator = '<svg class="sti-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>';
      statusClass = 'done';
    } else if (t.status === 'cancelled') {
      indicator = '<svg class="sti-fail" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 8l8 8"/><path d="M16 8l-8 8"/></svg>';
      statusClass = 'error';
    } else {
      indicator = '<svg class="sti-fail" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
      statusClass = 'error';
    }

    const elapsed = _formatElapsed((t.endTime || now) - t.startTime);
    const statusLabel = t.status === 'running' ? '进行中' : t.status === 'done' ? '完成' : t.status === 'cancelled' ? '已中断' : '失败';
    const timeStr = new Date(t.startTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    const progressBar = t.status === 'running'
      ? `<div class="tpi-progress"><div class="sti-progress-fill ${t.progress < 0 ? 'indeterminate' : ''}" style="width:${t.progress < 0 ? '100' : t.progress}%"></div></div>`
      : '';

    return `
      <div class="task-page-item ${statusClass}">
        <div class="tpi-head">
          ${indicator}
          <span class="tpi-name">${escapeHtml(t.name)}</span>
          <span class="tpi-time">${timeStr}</span>
        </div>
        <div class="tpi-meta">
          <span class="tpi-status-label ${statusClass}">${statusLabel}</span>
          <span class="tpi-elapsed">${elapsed}</span>
          ${t.message ? `<span class="tpi-message">${escapeHtml(t.message)}</span>` : ''}
        </div>
        ${progressBar}
      </div>
    `;
  }).join('');

  // Keep the empty div, replace task items
  list.querySelectorAll('.task-page-item').forEach(e => e.remove());
  list.insertAdjacentHTML('beforeend', html);
}

// Auto-tick running task elapsed time
let _taskTimer = null;
function _ensureTaskTimer() {
  const hasRunning = state.tasks.some(t => t.status === 'running');
  if (hasRunning && !_taskTimer) {
    _taskTimer = setInterval(() => {
      if (!state.tasks.some(t => t.status === 'running')) {
        clearInterval(_taskTimer);
        _taskTimer = null;
        return;
      }
      renderSidebarTasks();
      renderTasksPage();
    }, 1000);
  }
}

/* ── Theme ── */
function getAutoTheme() {
  const hour = new Date().getHours();
  return (hour >= 6 && hour < 18) ? 'light' : 'dark';
}

function resolveTheme(preference) {
  if (preference === 'auto') return getAutoTheme();
  return preference;
}

function initTheme() {
  const saved = localStorage.getItem('easyaiconfig_theme') || 'auto';
  state.themePreference = saved; // 'dark' | 'light' | 'auto'
  state.theme = resolveTheme(saved);
  applyTheme(state.theme);
  // Re-evaluate auto theme every minute
  const themeTimer = setInterval(() => {
    if (state.themePreference === 'auto') {
      const next = getAutoTheme();
      if (next !== state.theme) {
        state.theme = next;
        applyTheme(next);
      }
    }
  }, 60000);
  window.addEventListener('beforeunload', () => clearInterval(themeTimer));
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Update range slider fills for new theme colors
  document.querySelectorAll('.config-range').forEach(updateRangeFill);
  syncRawCodeEditorTheme();
  syncSystemThemeButtons();
  const titles = { dark: '暗黑模式 · 点击切换浅色', light: '浅色模式 · 点击切换自动', auto: '自动模式 · 点击切换暗黑' };
  document.querySelectorAll('[data-role="theme-toggle"]').forEach((btn) => {
    btn.dataset.themePref = state.themePreference;
    btn.title = titles[state.themePreference] || '切换主题';
    btn.setAttribute('aria-label', btn.title);
  });
}

function toggleTheme() {
  // Cycle: dark → light → auto
  const order = ['dark', 'light', 'auto'];
  const idx = order.indexOf(state.themePreference);
  state.themePreference = order[(idx + 1) % order.length];
  state.theme = resolveTheme(state.themePreference);
  localStorage.setItem('easyaiconfig_theme', state.themePreference);
  applyTheme(state.theme);
  const labels = { dark: '已切换：暗黑模式', light: '已切换：浅色模式', auto: '已切换：自动模式（跟随时间）' };
  flash(labels[state.themePreference] || '', 'success');
}

// Apply theme before any rendering to prevent flash
initTheme();

/* ── Multi-tool Support ── */
function ensureKnownTools(tools = []) {
  const known = [
    { id: 'codex', name: 'Codex CLI', description: 'OpenAI 官方 AI 编程助手' },
    { id: 'claudecode', name: 'Claude Code', description: 'Anthropic 终端原生 AI 编程助手' },
    { id: 'opencode', name: 'OpenCode', description: '开放式 AI 编程助手 CLI' },
    { id: 'openclaw', name: 'OpenClaw', description: '开源多渠道 AI 助手平台' },
  ];
  const map = new Map((tools || []).map((tool) => [tool.id, tool]));
  return known.map((tool) => map.get(tool.id) || {
    ...tool,
    supported: true,
    configFormat: 'json',
    installMethod: tool.id === 'opencode' ? 'auto' : 'npm',
    npmPackage: tool.id === 'codex' ? '@openai/codex' : tool.id === 'claudecode' ? '@anthropic-ai/claude-code' : tool.id === 'opencode' ? 'opencode-ai' : 'openclaw',
    binary: { installed: false, version: null, path: null },
  });
}

async function loadOpenCodeDesktopState({ render = true } = {}) {
  try {
    const json = await api('/api/opencode/desktop/state');
    if (json.ok && json.data) {
      state.openCodeDesktopState = json.data;
      if (render && state.activePage === 'tools') renderToolsPage();
    }
  } catch { /* silent */ }
}

async function loadCodexAppState({ render = true } = {}) {
  try {
    const json = await api('/api/codex-app/state');
    if (json.ok && json.data) {
      state.codexAppState = json.data;
      if (render && state.activePage === 'tools') renderToolsPage();
    }
  } catch { /* silent */ }
}

async function loadOpenCodeEcosystemState({ render = true } = {}) {
  try {
    const cwd = el('launchCwdInput')?.value?.trim() || state.current?.launch?.cwd || '';
    const params = new URLSearchParams();
    if (cwd) params.set('cwd', cwd);
    const json = await api(`/api/opencode/ecosystem/state${params.toString() ? `?${params.toString()}` : ''}`);
    if (json.ok && json.data) {
      state.openCodeEcosystemState = json.data;
      if (render && state.activePage === 'tools') renderToolsPage();
    }
  } catch { /* silent */ }
}

async function loadTools() {
  try {
    const json = await api('/api/tools');
if (json.ok && json.data) {
      state.tools = ensureKnownTools(json.data);
      renderStatus();
      renderToolsPage();
      updateToolSelector();
      await loadCodexAppState({ render: false }).catch((e) => console.warn('[loadTools] loadCodexAppState failed:', e));
      await loadOpenCodeDesktopState({ render: false }).catch((e) => console.warn('[loadTools] loadOpenCodeDesktopState failed:', e));
      await loadOpenCodeEcosystemState({ render: false }).catch((e) => console.warn('[loadTools] loadOpenCodeEcosystemState failed:', e));
      renderCurrentConfig();
      renderToolConsole();
      if (state.activePage === 'tools') renderToolsPage();
    }
  } catch { /* silent */ }
}

function shouldResyncToolRuntimeState() {
  return state.activePage === 'quick'
    || state.activePage === 'configEditor'
    || state.activePage === 'console'
    || state.activePage === 'tools';
}

async function refreshToolRuntimeAfterMutation(toolId = '') {
  await loadTools().catch((e) => console.warn('[refreshToolRuntimeAfterMutation] loadTools failed:', e));
  if (!toolId || toolId === 'codex') {
    await loadState({ preserveForm: true }).catch((e) => console.warn('[refreshToolRuntimeAfterMutation] loadState failed:', e));
  }
  if (!toolId || toolId === 'claudecode') {
    await loadClaudeCodeQuickState({ force: false, cacheOnly: false }).catch((e) => console.warn('[refreshToolRuntimeAfterMutation] loadClaudeCodeQuickState failed:', e));
  }
  if (!toolId || toolId === 'opencode') {
    await loadOpenCodeQuickState().catch((e) => console.warn('[refreshToolRuntimeAfterMutation] loadOpenCodeQuickState failed:', e));
  }
  if (!toolId || toolId === 'openclaw') {
    await loadOpenClawQuickState().catch((e) => console.warn('[refreshToolRuntimeAfterMutation] loadOpenClawQuickState failed:', e));
  }
  renderCurrentConfig();
  renderToolConsole();
}

async function resyncToolRuntimeState({ force = false } = {}) {
  if (!force && !shouldResyncToolRuntimeState()) return;
  const now = Date.now();
  if (!force && state.toolRuntimeSync.running) return state.toolRuntimeSync.running;
  if (!force && now - (state.toolRuntimeSync.lastAt || 0) < 1200) return;

  const job = refreshToolRuntimeAfterMutation(state.activeTool || '').catch((e) => console.warn('[resyncToolRuntimeState] refresh failed:', e));

  state.toolRuntimeSync.running = job;
  try {
    await job;
    state.toolRuntimeSync.lastAt = Date.now();
  } finally {
    state.toolRuntimeSync.running = null;
  }
}

const OPENCODE_DESKTOP_DOWNLOAD_URL = 'https://opencode.ai/download';
const OPENCODE_DESKTOP_HOME_URL = 'https://opencode.ai/';
const OPENCODE_IDE_DOCS_URL = 'https://opencode.ai/docs/ide';
const OPENCODE_GITHUB_DOCS_URL = 'https://opencode.ai/docs/github';
const OPENCODE_GITLAB_DOCS_URL = 'https://opencode.ai/docs/gitlab';
const CODEX_APP_DOCS_URL = 'https://developers.openai.com/codex/app';
const CODEX_APP_MAC_DOWNLOAD_URL = 'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg';
const CODEX_APP_WIN_STORE_URL = 'https://apps.microsoft.com/detail/9plm9xgg6vks';

function getOpenCodeDesktopPlatformLabel(platform = '') {
  const text = String(platform || navigator.platform || '').toLowerCase();
  if (text.includes('darwin') || text.includes('mac')) return 'macOS';
  if (text.includes('win')) return 'Windows';
  if (text.includes('linux')) return 'Linux';
  return '桌面端';
}

function getToolsCatalogQuery() {
  return normalizeStoreText(state.toolsCatalogQuery || '');
}

function getToolsCatalogTag() {
  return String(state.toolsCatalogTag || 'all');
}

function getCodexAppCatalogItem() {
  const data = state.codexAppState || {};
  const platformLabel = getOpenCodeDesktopPlatformLabel(data.platform);
  const supported = data.supported !== false && ['macOS', 'Windows'].includes(platformLabel);
  const installed = Boolean(data.installed);
  const fallbackDownloadUrl = platformLabel === 'Windows' ? CODEX_APP_WIN_STORE_URL : CODEX_APP_MAC_DOWNLOAD_URL;
  const docsUrl = data.docsUrl || CODEX_APP_DOCS_URL;
  return {
    id: 'codex-app',
    kind: 'desktop',
    iconId: 'codex-app',
    typeLabel: '客户端',
    name: 'Codex App',
    description: 'OpenAI 官方 Codex 客户端，独立于 Codex CLI。',
    supported,
    installed,
    version: installed ? (data.installPath || `${platformLabel} 已安装`) : supported ? `${platformLabel} 一键安装` : `${platformLabel} 暂未支持`,
    badge: installed ? '已安装' : supported ? '可安装' : '官方入口',
    tags: ['desktop'].concat(installed ? ['installed'] : []),
    chips: [platformLabel, installed ? '已安装' : '未安装', '独立客户端'],
    primaryAction: { toolId: 'codex-app', action: installed ? 'open' : 'install', label: installed ? '打开 App' : '一键安装', disabled: !supported },
    secondaryAction: installed
      ? { toolId: 'codex-app', action: 'reinstall', label: '重新安装' }
      : { externalUrl: data.downloadUrl || fallbackDownloadUrl, label: platformLabel === 'Windows' ? '打开商店' : '下载安装包' },
    tertiaryAction: { externalUrl: docsUrl, label: '官方说明' },
  };
}

function getOpenCodeDesktopCatalogItem() {
  const data = state.openCodeDesktopState || {};
  const platformLabel = getOpenCodeDesktopPlatformLabel(data.platform);
  const supported = data.supported !== false && ['macOS', 'Windows'].includes(platformLabel);
  const installed = Boolean(data.installed);
  return {
    id: 'opencode-desktop',
    kind: 'desktop',
    iconId: 'opencode-desktop',
    typeLabel: '桌面版',
    name: 'OpenCode Desktop',
    description: '内置下载器自动拉取官方桌面版，安装过程尽量全自动。',
    supported,
    installed,
    version: installed ? (data.installPath || `${platformLabel} 已安装`) : supported ? `${platformLabel} 一键安装` : `${platformLabel} 暂未接入自动安装`,
    badge: installed ? '已安装' : supported ? '可自动安装' : '官方入口',
    tags: ['desktop', 'automation'].concat(installed ? ['installed'] : []),
    chips: [platformLabel, installed ? '已安装' : '桌面端', supported ? '自动下载' : '需手动处理'],
    primaryAction: { toolId: 'opencode-desktop', action: installed ? 'open' : 'install', label: installed ? '打开桌面版' : '一键安装', disabled: !supported },
    secondaryAction: installed
      ? { toolId: 'opencode-desktop', action: 'reinstall', label: '重新安装' }
      : { externalUrl: OPENCODE_DESKTOP_HOME_URL, label: '官网' },
  };
}

function getOpenCodeEcosystemCatalogItems() {
  const ecosystem = state.openCodeEcosystemState || {};
  const targets = ecosystem.targets || {};
  const specs = [
    { key: 'vscode', id: 'opencode-vscode', name: 'OpenCode · VS Code', typeLabel: '扩展', desc: '调用 `code` 一键安装官方扩展。', docsUrl: OPENCODE_IDE_DOCS_URL, unavailable: '未检测到 `code` 命令' },
    { key: 'cursor', id: 'opencode-cursor', name: 'OpenCode · Cursor', typeLabel: '扩展', desc: '调用 `cursor` 一键安装官方扩展。', docsUrl: OPENCODE_IDE_DOCS_URL, unavailable: '未检测到 `cursor` 命令' },
    { key: 'windsurf', id: 'opencode-windsurf', name: 'OpenCode · Windsurf', typeLabel: '扩展', desc: '调用 `windsurf` 一键安装官方扩展。', docsUrl: OPENCODE_IDE_DOCS_URL, unavailable: '未检测到 `windsurf` 命令' },
    { key: 'vscodium', id: 'opencode-vscodium', name: 'OpenCode · VSCodium', typeLabel: '扩展', desc: '调用 `codium` 一键安装官方扩展。', docsUrl: OPENCODE_IDE_DOCS_URL, unavailable: '未检测到 `codium` 命令' },
    { key: 'zed', id: 'opencode-zed', name: 'OpenCode · Zed', typeLabel: '扩展', desc: '自动写入 Zed 配置，打开 Zed 后自动装扩展。', docsUrl: OPENCODE_IDE_DOCS_URL, unavailable: '未检测到 Zed 环境' },
    { key: 'github', id: 'opencode-github', name: 'OpenCode · GitHub', typeLabel: '集成', desc: '一键生成 GitHub Actions 工作流。', docsUrl: OPENCODE_GITHUB_DOCS_URL, unavailable: '请先打开一个 Git 仓库' },
    { key: 'gitlab', id: 'opencode-gitlab', name: 'OpenCode · GitLab', typeLabel: '集成', desc: '一键生成 GitLab CI 模板文件。', docsUrl: OPENCODE_GITLAB_DOCS_URL, unavailable: '请先打开一个 Git 仓库' },
  ];
  return specs.map((spec) => {
    const target = targets[spec.key] || {};
    const available = target.available !== false;
    const installed = Boolean(target.installed);
    const statusValue = installed
      ? (target.commandPath || target.workflowPath || target.settingsPath || target.repoRoot || '已配置')
      : available
        ? (target.commandPath || target.repoRoot || '可一键处理')
        : spec.unavailable;
    return {
      id: spec.id,
      kind: 'ecosystem',
      target: spec.key,
      iconId: spec.id,
      typeLabel: spec.typeLabel,
      name: spec.name,
      description: spec.desc,
      supported: available,
      installed,
      version: statusValue,
      badge: installed ? '已就绪' : available ? '可自动化' : '待检测',
      tags: [spec.typeLabel === '扩展' ? 'extension' : 'integration', 'automation'].concat(installed ? ['installed'] : []),
      chips: [spec.typeLabel, installed ? '已配置' : '未配置', available ? '一键处理' : '待环境就绪'],
      primaryAction: { toolId: spec.id, action: 'ecosystem-install', label: target.actionLabel || (installed ? '重新处理' : '立即安装'), disabled: !available, ecosystemTarget: spec.key },
      secondaryAction: { externalUrl: spec.docsUrl, label: '官方文档' },
    };
  });
}

function getToolCatalogItems() {
  const baseItems = (state.tools || []).map((tool) => {
    const isSoon = !tool.supported;
    const installed = Boolean(tool.binary?.installed);
    return {
      id: tool.id,
      kind: 'tool',
      iconId: tool.id,
      typeLabel: 'CLI',
      name: tool.name,
      description: tool.description,
      supported: !isSoon,
      installed,
      version: installed ? (tool.binary?.version || tool.binary?.path || '已安装') : (isSoon ? '暂未支持' : '未安装'),
      badge: installed ? '已安装' : isSoon ? '即将支持' : 'CLI',
      tags: ['cli'].concat(installed ? ['installed'] : []),
      chips: ['CLI'],
      tool,
    };
  });
  return [...baseItems, getCodexAppCatalogItem(), getOpenCodeDesktopCatalogItem(), ...getOpenCodeEcosystemCatalogItems()];
}

function filterToolCatalogItems(items = []) {
  const query = getToolsCatalogQuery();
  const tag = getToolsCatalogTag();
  return items.filter((item) => {
    if (tag !== 'all' && !(item.tags || []).includes(tag)) return false;
    if (!query) return true;
    const haystack = normalizeStoreText([
      item.name,
      item.description,
      item.typeLabel,
      item.version,
      ...(item.tags || []),
      ...(item.chips || []),
    ].join(' '));
    return haystack.includes(query);
  });
}

function compareToolCatalogSidebarItems(a, b) {
  const kindOrder = { tool: 0, desktop: 1, ecosystem: 2 };
  const aOrder = kindOrder[a.kind] ?? 9;
  const bOrder = kindOrder[b.kind] ?? 9;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
}

function getToolsSidebarBadge(item) {
  if (item.installed) return item.kind === 'ecosystem' ? '已就绪' : '已安装';
  return item.kind === 'ecosystem' ? '待配置' : '待安装';
}

function renderToolsSidebarEmpty(title, detail) {
  return `
    <div class="sec-empty tools-sec-empty">
      ${escapeHtml(title)}
      ${detail ? `<span>${escapeHtml(detail)}</span>` : ''}
    </div>
  `;
}

function renderToolsSidebarItem(item) {
  const active = getToolsCatalogQuery() === normalizeStoreText(item.name || '');
  const subtitle = [item.typeLabel, item.version].filter(Boolean).join(' · ');
  const badge = getToolsSidebarBadge(item);
  return `
    <button
      type="button"
      class="sec-item tools-sec-item ${active ? 'active' : ''}"
      data-tools-side-id="${escapeHtml(item.id)}"
      data-tools-side-query="${escapeHtml(item.name)}"
      data-tools-side-tag="${item.installed ? 'installed' : 'all'}"
    >
      <span class="tools-sec-ico tool-icon tool-icon-${item.iconId}">
        ${toolIconSvg(item.iconId)}
      </span>
      <span class="sec-text">
        <span class="sec-name">${escapeHtml(item.name)}</span>
        <span class="sec-subtitle">${escapeHtml(subtitle)}</span>
      </span>
      <span class="tools-sec-badge ${item.installed ? 'is-installed' : 'is-pending'}">${escapeHtml(badge)}</span>
    </button>
  `;
}

function bindToolsSecondaryPanel() {
  const body = el('secondaryBody');
  if (!body || body._toolsSidebarBound) return;
  body._toolsSidebarBound = true;
  body.addEventListener('click', (event) => {
    const item = event.target.closest('.sec-item[data-tools-side-id]');
    if (!item || state.activePage !== 'tools') return;
    state.toolsCatalogQuery = item.dataset.toolsSideQuery || '';
    state.toolsCatalogTag = item.dataset.toolsSideTag || 'all';
    state.toolsCatalogPage = 1;
    const searchInput = el('toolsCatalogSearchInput');
    if (searchInput) searchInput.value = state.toolsCatalogQuery;
    renderToolsPage();
  });
}

function renderToolsSecondaryPanel() {
  const installedList = el('toolsInstalledList');
  const pendingList = el('toolsPendingList');
  if (!installedList || !pendingList) return;
  bindToolsSecondaryPanel();

  const installedCount = el('toolsSideInstalledCount');
  const pendingCount = el('toolsSidePendingCount');
  const installedMeta = el('toolsInstalledMeta');
  const pendingMeta = el('toolsPendingMeta');

  if (!state.tools.length) {
    if (installedCount) installedCount.textContent = '0';
    if (pendingCount) pendingCount.textContent = '0';
    if (installedMeta) installedMeta.textContent = '读取中';
    if (pendingMeta) pendingMeta.textContent = '读取中';
    installedList.innerHTML = renderToolsSidebarEmpty('正在读取工具状态', '安装状态和扩展集成会显示在这里');
    pendingList.innerHTML = '';
    return;
  }

  const items = getToolCatalogItems().sort(compareToolCatalogSidebarItems);
  const installedItems = items.filter((item) => item.installed);
  const pendingItems = items.filter((item) => item.supported && !item.installed);

  if (installedCount) installedCount.textContent = String(installedItems.length);
  if (pendingCount) pendingCount.textContent = String(pendingItems.length);
  if (installedMeta) installedMeta.textContent = `${installedItems.length} 项`;
  if (pendingMeta) pendingMeta.textContent = `${pendingItems.length} 项`;

  installedList.innerHTML = installedItems.length
    ? installedItems.slice(0, 6).map((item) => renderToolsSidebarItem(item)).join('')
    : renderToolsSidebarEmpty('还没有已安装项', '先从右侧列表安装 CLI、桌面版或扩展');
  pendingList.innerHTML = pendingItems.length
    ? pendingItems.slice(0, 5).map((item) => renderToolsSidebarItem(item)).join('')
    : renderToolsSidebarEmpty('当前已补齐', '没有待处理的安装或配置项');
}

function renderToolCardActions(item, actionSvgs) {
  if (item.kind === 'tool') {
    const tool = item.tool;
    const isInstalled = item.installed;
    if (!item.supported) return '<button class="secondary tool-action-btn" disabled>安装</button>';
    return `
      <button class="secondary tool-action-btn" data-tool-action="update" data-tool-id="${tool.id}">
        ${actionSvgs.update}
        <span>${isInstalled ? '更新' : '安装'}</span>
      </button>
      ${isInstalled ? `
        <button class="secondary tool-action-btn" data-tool-action="reinstall" data-tool-id="${tool.id}">
          ${actionSvgs.reinstall}
          <span>重装</span>
        </button>
        <button class="secondary tool-action-btn tool-action-danger" data-tool-action="uninstall" data-tool-id="${tool.id}">
          ${actionSvgs.uninstall}
          <span>卸载</span>
        </button>
      ` : ''}
    `;
  }
  const buttons = [item.primaryAction, item.secondaryAction, item.tertiaryAction].filter(Boolean).map((action) => {
    if (action.externalUrl) {
      return `
        <button class="secondary tool-action-btn" data-external-url="${escapeHtml(action.externalUrl)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
          <span>${escapeHtml(action.label)}</span>
        </button>
      `;
    }
    return `
      <button class="secondary tool-action-btn" data-tool-id="${escapeHtml(action.toolId)}" data-tool-action="${escapeHtml(action.action)}" ${action.ecosystemTarget ? `data-ecosystem-target="${escapeHtml(action.ecosystemTarget)}"` : ''} ${action.disabled ? 'disabled' : ''}>
        ${action.action === 'reinstall' ? actionSvgs.reinstall : action.action === 'open' ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>' : actionSvgs.update}
        <span>${escapeHtml(action.label)}</span>
      </button>
    `;
  });
  return buttons.join('');
}

function renderToolCatalogCard(item, actionSvgs) {
  const chips = (item.chips || []).filter(Boolean);
  return `
    <div class="tool-card ${!item.supported ? 'tool-card-soon' : ''}" data-tool-id="${item.id}">
      <div class="tool-card-head">
        <div class="tool-icon tool-icon-${item.iconId}">
          ${toolIconSvg(item.iconId)}
        </div>
        <div class="tool-info">
          <div class="tool-name-row">
            <div class="tool-name">${escapeHtml(item.name)}</div>
            <span class="tool-type-tag">${escapeHtml(item.typeLabel)}</span>
          </div>
          <div class="tool-desc">${escapeHtml(item.description)}</div>
        </div>
      </div>
      ${chips.length ? `
      <div class="tool-chip-row">
        ${chips.map((chip, index) => `<span class="tool-chip ${index === 1 && item.installed ? 'tool-chip-active' : ''}">${escapeHtml(chip)}</span>`).join('')}
      </div>` : ''}
      <div class="tool-status">
        <span class="tool-version ${!item.installed ? 'tool-version-muted' : ''}">${escapeHtml(item.version)}</span>
        <span class="tool-badge ${item.installed ? 'tool-badge-ok' : ''}">${escapeHtml(item.badge)}</span>
      </div>
      <div class="tool-actions">${renderToolCardActions(item, actionSvgs)}</div>
    </div>
  `;
}


function bindToolsCatalogControls() {
  const searchInput = el('toolsCatalogSearchInput');
  if (searchInput && !searchInput._bound) {
    searchInput._bound = true;
    searchInput.addEventListener('input', () => {
      state.toolsCatalogQuery = searchInput.value || '';
      state.toolsCatalogPage = 1;
      renderToolsPage();
    });
  }
  const tagWrap = el('toolsCatalogTags');
  if (tagWrap && !tagWrap._bound) {
    tagWrap._bound = true;
    tagWrap.addEventListener('click', (event) => {
      const button = event.target.closest('[data-tools-tag]');
      if (!button) return;
      state.toolsCatalogTag = button.dataset.toolsTag || 'all';
      state.toolsCatalogPage = 1;
      renderToolsPage();
    });
  }
}

function renderToolsPage() {
  const grid = document.querySelector('.tools-page .tools-grid');
  renderToolsSecondaryPanel();
  if (!grid || !state.tools.length) return;
  bindToolsCatalogControls();

  const actionSvgs = {
    update: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.36 6.36L3 21M3 12a9 9 0 0 1 15.36-6.36L21 3" /></svg>',
    reinstall: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2v6h6" /><path d="M2.5 8A10 10 0 1 1 4.34 16" /></svg>',
    uninstall: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>',
  };

  const items = filterToolCatalogItems(getToolCatalogItems());
  const searchInput = el('toolsCatalogSearchInput');
  if (searchInput && searchInput.value !== state.toolsCatalogQuery) searchInput.value = state.toolsCatalogQuery;
  document.querySelectorAll('[data-tools-tag]').forEach((node) => {
    node.classList.toggle('active', node.dataset.toolsTag === getToolsCatalogTag());
  });

  const pageSize = Math.max(1, Number(state.toolsCatalogPageSize || 9));
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  state.toolsCatalogPage = Math.min(Math.max(1, Number(state.toolsCatalogPage || 1)), totalPages);
  const start = (state.toolsCatalogPage - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  grid.innerHTML = pageItems.map((item) => renderToolCatalogCard(item, actionSvgs)).join('');
  el('toolsCatalogEmpty')?.classList.toggle('hide', items.length > 0);
  const pagination = el('toolsCatalogPagination');
  const prevBtn = el('toolsCatalogPrevBtn');
  const nextBtn = el('toolsCatalogNextBtn');
  const pageMeta = el('toolsCatalogPageMeta');
  if (pagination) pagination.classList.toggle('hide', items.length <= pageSize);
  if (prevBtn) prevBtn.disabled = state.toolsCatalogPage <= 1;
  if (nextBtn) nextBtn.disabled = state.toolsCatalogPage >= totalPages;
  if (pageMeta) pageMeta.textContent = `第 ${state.toolsCatalogPage} / ${totalPages} 页 · 共 ${items.length} 项`;

  if (pagination && !pagination._bound) {
    pagination._bound = true;
    prevBtn?.addEventListener('click', () => {
      if (state.toolsCatalogPage <= 1) return;
      state.toolsCatalogPage -= 1;
      renderToolsPage();
    });
    nextBtn?.addEventListener('click', () => {
      state.toolsCatalogPage += 1;
      renderToolsPage();
    });
  }

  if (!grid._toolsBound) {
    grid._toolsBound = true;
    grid.addEventListener('click', (e) => {
      const linkBtn = e.target.closest('[data-external-url]');
      if (linkBtn) {
        void openExternalUrl(linkBtn.dataset.externalUrl || '');
        return;
      }
      const btn = e.target.closest('[data-tool-action]');
      if (!btn) return;
      handleToolAction(btn.dataset.toolId, btn.dataset.toolAction, btn);
    });
  }
}

// Generic tool action handler
async function handleToolAction(toolId, action, btn) {
  const toolNames = { codex: 'Codex', claudecode: 'Claude Code', opencode: 'OpenCode', 'codex-app': 'Codex App', 'opencode-desktop': 'OpenCode Desktop', openclaw: 'OpenClaw' };
  const toolName = toolNames[toolId] || toolId;

  const apiPrefixMap = { codex: 'codex', claudecode: 'claudecode', opencode: 'opencode', openclaw: 'openclaw' };
  const apiPrefix = apiPrefixMap[toolId] || toolId;

  if (toolId === 'openclaw' && action === 'update') {
    await openClawInstallMethodDialog(btn);
    return;
  }

  if (toolId === 'openclaw' && action === 'uninstall') {
    await openClawUninstallDialog(btn);
    return;
  }

  if (action === 'ecosystem-install') {
    const target = btn?.dataset?.ecosystemTarget || toolId.replace('opencode-', '');
    setToolBtnBusy(btn, true, '处理中…');
    try {
      const cwd = el('launchCwdInput')?.value?.trim() || state.current?.launch?.cwd || '';
      const json = await api('/api/opencode/ecosystem/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, cwd }),
      });
      if (!json.ok) {
        flash(json.error || 'OpenCode 生态项处理失败', 'error');
        return;
      }
      flash(json.data?.message || 'OpenCode 生态项已处理', 'success');
      await loadOpenCodeEcosystemState({ render: state.activePage === 'tools' });
    } catch (error) {
      flash(error?.message || 'OpenCode 生态项处理失败', 'error');
    } finally {
      setToolBtnBusy(btn, false);
    }
    return;
  }

  if (toolId === 'opencode-desktop') {
    if (action === 'install') {
      await runOpenCodeDesktopInstallAction(btn, { reinstall: false });
      return;
    }
    if (action === 'reinstall') {
      await runOpenCodeDesktopInstallAction(btn, { reinstall: true });
      return;
    }
    if (action === 'open') {
      setToolBtnBusy(btn, true, '打开中…');
      try {
        const json = await api('/api/opencode/desktop/open', { method: 'POST' });
        if (!json.ok) {
          flash(json.error || '打开 OpenCode Desktop 失败', 'error');
          return;
        }
        flash('OpenCode Desktop 已打开', 'success');
        await loadOpenCodeDesktopState({ render: state.activePage === 'tools' });
      } catch (error) {
        flash(error?.message || '打开 OpenCode Desktop 失败', 'error');
      } finally {
        setToolBtnBusy(btn, false);
      }
      return;
    }
  }

  if (toolId === 'codex-app') {
    if (action === 'install' || action === 'reinstall') {
      setToolBtnBusy(btn, true, action === 'reinstall' ? '重装中…' : '安装中…');
      try {
        const json = await api('/api/codex-app/install', { method: 'POST' });
        if (!json.ok) {
          flash(json.error || 'Codex App 安装失败', 'error');
          return;
        }
        flash(json.data?.message || '已触发 Codex App 安装流程', 'success');
        await loadCodexAppState({ render: state.activePage === 'tools' });
      } catch (error) {
        flash(error?.message || 'Codex App 安装失败', 'error');
      } finally {
        setToolBtnBusy(btn, false);
      }
      return;
    }
    if (action === 'open') {
      setToolBtnBusy(btn, true, '打开中…');
      try {
        const json = await api('/api/codex-app/open', { method: 'POST' });
        if (!json.ok) {
          flash(json.error || '打开 Codex App 失败', 'error');
          return;
        }
        flash(json.data?.message || 'Codex App 已打开', 'success');
        await loadCodexAppState({ render: state.activePage === 'tools' });
      } catch (error) {
        flash(error?.message || '打开 Codex App 失败', 'error');
      } finally {
        setToolBtnBusy(btn, false);
      }
      return;
    }
  }

  if (toolId === 'opencode' && ['update', 'reinstall', 'uninstall'].includes(action)) {
    await runOpenCodeToolAction(action, btn);
    return;
  }

  const actionConfig = {
    update: {
      api: `/api/${apiPrefix}/update`,
      busyText: '更新中…',
      successText: `${toolName} 已更新到最新版`,
      confirm: null,
    },
    reinstall: {
      api: `/api/${apiPrefix}/reinstall`,
      busyText: '重装中…',
      successText: `${toolName} 重装完成`,
      confirm: {
        eyebrow: toolName,
        title: `重装 ${toolName}`,
        body: `<p>这会重新全局安装当前版本 ${toolName}。</p>`,
        confirmText: '确认重装',
        cancelText: '取消',
      },
    },
    uninstall: {
      api: `/api/${apiPrefix}/uninstall`,
      busyText: '卸载中…',
      successText: `${toolName} 已卸载`,
      confirm: {
        eyebrow: toolName,
        title: `卸载 ${toolName}`,
        body: `<p>卸载后将无法直接从工具里启动 ${toolName}。</p>`,
        confirmText: '确认卸载',
        cancelText: '取消',
        tone: 'danger',
      },
    },
  };

  const config = actionConfig[action];
  if (!config) return;

  if (config.confirm) {
    const confirmed = await openUpdateDialog(config.confirm);
    if (!confirmed) {
      flash('操作已取消', 'info');
      return;
    }
  }

  setToolBtnBusy(btn, true, config.busyText);

  try {
    const json = await api(config.api, { method: 'POST' });
    if (!json.ok) {
      flash(json.error || `${toolName} 操作失败`, 'error');
      return;
    }
    flash(config.successText, 'success');
    await refreshToolRuntimeAfterMutation(toolId);
  } catch (e) {
    flash(e.message || `${toolName} 操作失败`, 'error');
  } finally {
    setToolBtnBusy(btn, false);
  }
}
const SPINNER_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.22-8.56" /></svg>';

function setToolBtnBusy(btn, busy, text) {
  if (!btn) return;
  if (busy) {
    btn._origHTML = btn.innerHTML;
    btn.innerHTML = `${SPINNER_SVG}<span>${text || '处理中…'}</span>`;
    btn.classList.add('tool-btn-busy');
    btn.disabled = true;
  } else {
    if (btn._origHTML) btn.innerHTML = btn._origHTML;
    btn.classList.remove('tool-btn-busy');
    btn.disabled = false;
  }
}

function getOpenCodeActionCopy(action, installedBefore = false) {
  if (action === 'desktop-install') {
    return installedBefore
      ? { busy: '重装中…', title: '正在重装 OpenCode Desktop', done: 'OpenCode Desktop 已重装完成' }
      : { busy: '安装中…', title: '正在安装 OpenCode Desktop', done: 'OpenCode Desktop 安装完成' };
  }
  if (action === 'install') {
    return { busy: '安装中…', title: '正在安装 OpenCode', done: 'OpenCode 安装完成' };
  }
  if (action === 'update') {
    return installedBefore
      ? { busy: '更新中…', title: '正在更新 OpenCode', done: 'OpenCode 已更新到最新版' }
      : { busy: '安装中…', title: '正在安装 OpenCode', done: 'OpenCode 安装完成' };
  }
  if (action === 'reinstall') {
    return { busy: '重装中…', title: '正在重装 OpenCode', done: 'OpenCode 重装完成' };
  }
  return { busy: '卸载中…', title: '正在卸载 OpenCode', done: 'OpenCode 已卸载' };
}

function getOpenCodeMethodLabel(method = '') {
  return ({
    auto: '自动检测',
    domestic: '国内 npm 镜像',
    script: '官方安装脚本',
    npm: 'npm 官方源',
    brew: 'Homebrew',
    scoop: 'Scoop',
    choco: 'Chocolatey',
  }[method] || method || '自动检测');
}

function getOpenCodeRequestedMethodLabel(method = '') {
  return method ? getOpenCodeMethodLabel(method) : '自动检测';
}

function getOpenCodeCommandPreview(action, requestedMethod = '') {
  if (action === 'desktop-install') {
    const isWin = navigator.platform?.startsWith('Win');
    return isWin
      ? ['内置下载器 → 官方 Windows 安装包', '下载完成后自动拉起安装器，尽量直接完成安装']
      : ['内置下载器 → 官方 macOS DMG', '下载完成后自动挂载并安装到 Applications'];
  }
  const isWin = navigator.platform?.startsWith('Win');
  const requested = requestedMethod || 'auto';
  const installMap = isWin
    ? {
      auto: ['Google 可达 → npm i -g opencode-ai@latest', 'Google 不可达 → npm i -g opencode-ai@latest --registry=https://registry.npmmirror.com'],
      domestic: ['npm i -g opencode-ai@latest --registry=https://registry.npmmirror.com'],
      npm: ['npm i -g opencode-ai@latest'],
      scoop: ['scoop install opencode'],
      choco: ['choco install opencode -y'],
    }
    : {
      auto: ['Google 可达 → curl -fsSL https://opencode.ai/install | bash', 'Google 不可达 → npm i -g opencode-ai@latest --registry=https://registry.npmmirror.com'],
      domestic: ['npm i -g opencode-ai@latest --registry=https://registry.npmmirror.com'],
      script: ['curl -fsSL https://opencode.ai/install | bash'],
      brew: ['brew install anomalyco/tap/opencode'],
      npm: ['npm i -g opencode-ai@latest'],
    };
  const uninstallMap = isWin
    ? {
      domestic: ['npm uninstall -g opencode-ai'],
      npm: ['npm uninstall -g opencode-ai'],
      scoop: ['scoop uninstall opencode'],
      choco: ['choco uninstall opencode -y'],
      auto: ['根据当前安装方式自动选择卸载命令'],
    }
    : {
      domestic: ['npm uninstall -g opencode-ai'],
      npm: ['npm uninstall -g opencode-ai'],
      script: ['rm -f <opencode-binary>'],
      brew: ['brew uninstall anomalyco/tap/opencode'],
      auto: ['根据当前安装方式自动选择卸载命令'],
    };
  const baseMap = action === 'uninstall' ? uninstallMap : installMap;
  return baseMap[requested] || baseMap.auto || [];
}

function createOpenCodeTracker(action, { installedBefore = false, requestedMethod = '' } = {}) {
  const copy = getOpenCodeActionCopy(action, installedBefore);
  const startedAt = new Date().toISOString();
  const uninstall = action === 'uninstall';
  const desktopInstall = action === 'desktop-install';
  const steps = desktopInstall
    ? [
      { key: 'inspect', title: '检查系统环境', description: '识别系统、架构与桌面版状态', status: 'running' },
      { key: 'download', title: '下载桌面安装器', description: '通过内置下载器拉取官方桌面版安装包', status: 'pending' },
      { key: 'install', title: '自动安装并启动', description: '自动安装 OpenCode Desktop 并尝试直接打开', status: 'pending' },
    ]
    : uninstall
      ? [
        { key: 'inspect', title: '检查当前安装', description: '确认当前 OpenCode 安装状态', status: 'running' },
        { key: 'remove', title: '执行卸载命令', description: '移除全局 OpenCode 命令与包', status: 'pending' },
        { key: 'verify', title: '验证卸载结果', description: '刷新工具状态并确认结果', status: 'pending' },
      ]
      : [
        { key: 'network', title: '检测网络环境', description: '检测 Google 可达性与当前网络情况', status: 'running' },
        { key: 'method', title: '确定安装方式', description: '根据网络和你的选择确认最终安装方案', status: 'pending' },
        { key: 'execute', title: '执行安装命令', description: '运行安装命令并等待依赖安装完成', status: 'pending' },
        { key: 'verify', title: '验证安装结果', description: '确认 opencode 命令已经可用', status: 'pending' },
      ];
  return {
    toolId: desktopInstall ? 'opencode-desktop' : 'opencode',
    action,
    installedBefore,
    requestedMethod,
    method: '',
    command: '',
    commandPreview: getOpenCodeCommandPreview(action, requestedMethod),
    googleReachable: null,
    usedDomesticMirror: null,
    status: 'running',
    progress: desktopInstall ? 10 : uninstall ? 10 : 8,
    stepIndex: 0,
    summary: desktopInstall ? copy.title : uninstall ? '正在检查当前 OpenCode 安装状态…' : '正在检测网络并准备安装 OpenCode…',
    hint: desktopInstall ? '会自动下载官方桌面版，不需要你自己找安装包。' : uninstall ? '先别关闭窗口，卸载完成后会自动刷新。' : '安装过程会自动继续，你现在不需要操作。',
    detail: desktopInstall ? '正在检查桌面版系统环境…' : uninstall ? '正在确认当前安装路径…' : '正在准备安装器…',
    steps,
    logs: [{ source: 'stdout', text: `${copy.title} 已开始`, at: startedAt }],
    startedAt,
    startedAtTs: Date.now(),
    completedAt: null,
    stdout: '',
    stderr: '',
    error: null,
    version: '',
    _markers: {},
  };
}

function stripAnsiControlText(text) {
  return String(text || '')
    .replace(/[\x1B\x9B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-ntqry=><~]|(?:].*?(?:\x07|\x1B\\)))/g, '')
    .replace(/\r/g, '')
    .trim();
}

function pushOpenCodeTrackerLog(task, source, text) {
  const cleaned = stripAnsiControlText(text);
  if (!cleaned) return;
  task.logs.push({ source, text: cleaned, at: new Date().toISOString() });
  if (task.logs.length > 120) task.logs.shift();
  task.detail = cleaned;
}

function setOpenCodeTrackerStep(task, stepIndex, overrides = {}) {
  const safeIndex = Math.max(0, Math.min(stepIndex, (task.steps || []).length - 1));
  if (safeIndex < task.stepIndex && task.status === 'running') return;
  task.stepIndex = safeIndex;
  task.progress = Math.max(task.progress || 0, overrides.progress || [18, 36, 82, 96][safeIndex] || task.progress || 0);
  if (overrides.summary) task.summary = overrides.summary;
  if (overrides.hint) task.hint = overrides.hint;
  if (overrides.detail) task.detail = overrides.detail;
  task.steps = task.steps.map((step, index) => ({
    ...step,
    status: index < safeIndex ? 'done' : index === safeIndex ? (overrides.status || 'running') : 'pending',
  }));
}

function updateOpenCodeTrackerHeartbeat(task) {
  if (!task || task.status !== 'running') return;
  const elapsed = Date.now() - Number(task.startedAtTs || Date.now());
  if (task.action === 'uninstall') {
    if (!task._markers.inspectLog && elapsed > 280) {
      task._markers.inspectLog = true;
      pushOpenCodeTrackerLog(task, 'stdout', '正在读取当前 OpenCode 安装状态…');
    }
    if (!task._markers.removeStep && elapsed > 900) {
      task._markers.removeStep = true;
      setOpenCodeTrackerStep(task, 1, {
        progress: 34,
        summary: '正在执行卸载命令…',
        hint: '卸载完成后会自动刷新工具状态。',
        detail: '正在移除 OpenCode 安装文件…',
      });
      pushOpenCodeTrackerLog(task, 'stdout', '开始执行卸载命令…');
    }
    if (task.stepIndex === 1) {
      task.progress = Math.max(task.progress, Math.min(88, 34 + Math.floor(Math.max(0, elapsed - 900) / 450) * 4));
    }
    return;
  }

  if (!task._markers.networkLog && elapsed > 300) {
    task._markers.networkLog = true;
    pushOpenCodeTrackerLog(task, 'stdout', '正在检测当前网络连通性…');
  }
  if (!task._markers.awaitInstallerResultLog && elapsed > 620) {
    task._markers.awaitInstallerResultLog = true;
    pushOpenCodeTrackerLog(task, 'stdout', task.commandPreview?.length
      ? 'Google 可达性与实际执行命令会在安装器返回后确认，当前先展示候选命令。'
      : 'Google 可达性与实际执行命令会在安装器返回后确认。');
  }
  if (!task._markers.methodStep && elapsed > 900) {
    task._markers.methodStep = true;
    setOpenCodeTrackerStep(task, 1, {
      progress: 26,
      summary: '正在确定 OpenCode 安装方式…',
      hint: '会优先选择最快、最稳定的安装方式。',
      detail: task.requestedMethod ? `已收到安装方式：${getOpenCodeRequestedMethodLabel(task.requestedMethod)}` : '正在根据网络自动选择安装方式…',
    });
    pushOpenCodeTrackerLog(task, 'stdout', task.requestedMethod
      ? `用户选择安装方式：${getOpenCodeRequestedMethodLabel(task.requestedMethod)}`
      : '未指定安装方式，将自动选择最合适的安装方案。');
  }
  if (!task._markers.executeStep && elapsed > 1700) {
    task._markers.executeStep = true;
    setOpenCodeTrackerStep(task, 2, {
      progress: 42,
      summary: '正在执行 OpenCode 安装命令…',
      hint: '这里通常耗时最长，期间没有新日志也正常。',
      detail: task.commandPreview?.length ? '正在安装依赖并写入全局命令…候选命令见下方日志。' : '正在安装依赖并写入全局命令…',
    });
    pushOpenCodeTrackerLog(task, 'stdout', task.command
      ? `安装命令已启动：${task.command}`
      : task.commandPreview?.length
        ? '安装命令已启动，实际执行命令等待安装器返回；候选命令见上。'
        : '安装命令已启动，正在等待依赖安装完成…');
  }
  if (task.stepIndex === 2) {
    task.progress = Math.max(task.progress, Math.min(90, 42 + Math.floor(Math.max(0, elapsed - 1700) / 550) * 4));
  }
}

function getOpenCodeTrackerLogsText(task) {
  return (task.logs || []).map((item) => {
    const time = item.at ? new Date(item.at).toLocaleTimeString() : '--:--:--';
    return `[${time}] ${item.source === 'stderr' ? 'ERR' : 'LOG'} ${item.text}`;
  }).join('\n') || '安装日志会显示在这里。';
}

function buildOpenCodeTrackerRenderKey(task) {
  return JSON.stringify({
    status: task.status,
    progress: task.progress,
    stepIndex: task.stepIndex,
    summary: task.summary,
    hint: task.hint,
    detail: task.detail,
    error: task.error,
    version: task.version,
    method: task.method,
    command: task.command,
    googleReachable: task.googleReachable,
    usedDomesticMirror: task.usedDomesticMirror,
    steps: (task.steps || []).map((step) => `${step.key}:${step.status}`).join('|'),
    logs: (task.logs || []).map((item) => `${item.source}:${item.text}`).join('\n'),
  });
}

function shouldPauseOpenCodeInstallRender() {
  if (Date.now() < (state.openCodeInstallView.pauseUntil || 0)) return true;
  const selection = window.getSelection?.();
  const node = selection?.anchorNode?.parentElement || selection?.anchorNode;
  return Boolean(selection?.toString()?.trim() && node?.closest?.('.install-tracker-log'));
}

function renderOpenCodeTrackerDialog(task) {
  const copy = getOpenCodeActionCopy(task.action, task.installedBefore);
  const desktopInstall = task.action === 'desktop-install';
  const platformLabel = getOpenCodeDesktopPlatformLabel(state.openCodeDesktopState?.platform || navigator.platform || '');
  const logs = getOpenCodeTrackerLogsText(task);
  const statusLabel = task.status === 'success'
    ? copy.done
    : task.status === 'cancelled'
      ? `${copy.title.replace('正在', '').trim()} 已中断`
      : task.status === 'cancelling'
        ? `${copy.title.replace('正在', '').trim()} 中断中`
        : task.status === 'error'
          ? `${copy.title.replace('正在', '').trim()} 失败`
          : copy.title;
  const detailText = task.detail || (task.status === 'running' || task.status === 'cancelling'
    ? (desktopInstall ? '正在等待新的下载 / 安装输出…' : '正在等待新的安装输出…')
    : '');
  const todoItems = desktopInstall
    ? (task.status === 'success'
      ? ['桌面版已经安装完成。', '现在可以直接点“打开桌面版”。', '如果你也要用 CLI，可继续安装 OpenCode 命令行版。']
      : task.status === 'cancelling'
        ? ['正在停止本次下载任务。', '正在等待后端清理临时状态。', '请先不要关闭窗口，完成后会自动提示。']
        : task.status === 'cancelled'
          ? ['本次桌面版安装已经停止。', '如果要继续，重新点击“一键安装”即可。', '下载阶段的残留文件会自动处理。']
          : task.status === 'error'
            ? ['先看下面“最后日志”的最后几行。', '如果是权限问题，允许系统安装后再试一次。', '如果是网络问题，稍后重试即可。']
            : ['你不需要手动找安装包。', '下载完成后会自动继续安装。', platformLabel === 'Windows' ? 'Windows 会自动拉起安装器。' : 'mac 会自动安装到 Applications。'])
    : (task.status === 'success'
      ? ['已完成安装流程。', '如果你是首次使用，下一步建议去快速配置 Provider 和默认模型。', '也可以直接从工具页启动 OpenCode。']
      : task.status === 'cancelling'
        ? ['正在停止安装进程。', '正在等待后端清理本次任务。', '请先不要关闭窗口，清理完成后会自动提示。']
        : task.status === 'cancelled'
          ? ['本次安装已经停止。', '如需继续，重新点击安装即可。', '如果有残留，下次安装或卸载会继续自动处理。']
          : task.status === 'error'
            ? ['先看下面“最后日志”里的最后几行。', '如果是网络问题，可改用国内优化方式。', '如果是环境问题，先确认 Node.js / npm / Homebrew 可用。']
            : ['先别关闭窗口，也别重复点击安装。', '如果 30–90 秒没有新日志，通常只是网络下载中。', '安装完成后，这里会自动给出结果。']);
  const infoItems = desktopInstall
    ? [
      `平台：${platformLabel}`,
      '来源：OpenCode 官方稳定版安装包',
      `方式：${platformLabel === 'Windows' ? '内置下载器 + 自动拉起安装器' : '内置下载器 + 自动安装到 Applications'}`,
      `耗时：${formatRelativeDuration(task.startedAt, task.completedAt)}`,
      task.command ? `执行：${task.command}` : task.commandPreview?.length ? `流程：${task.commandPreview.join('；')}` : '流程：等待开始',
    ].filter(Boolean)
    : [
      `请求方式：${getOpenCodeRequestedMethodLabel(task.requestedMethod)}`,
      task.method ? `实际方式：${getOpenCodeMethodLabel(task.method)}` : (task.stepIndex >= 1 ? '实际方式：等待安装器确认（候选命令已显示）' : '实际方式：等待检测'),
      typeof task.googleReachable === 'boolean' ? `Google 可达：${task.googleReachable ? '是' : '否'}` : (task.stepIndex >= 1 ? 'Google 可达：等待安装器返回结果（未最终确认）' : 'Google 可达：检测中'),
      typeof task.usedDomesticMirror === 'boolean' ? `国内镜像：${task.usedDomesticMirror ? '已使用' : '未使用'}` : '',
      `耗时：${formatRelativeDuration(task.startedAt, task.completedAt)}`,
      task.command ? `命令：${task.command}` : task.commandPreview?.length ? `命令预览：${task.commandPreview.join('；')}` : '命令：等待生成',
    ].filter(Boolean);
  return `
    <div class="install-tracker">
      <div class="install-tracker-top">
        <div>
          <div class="install-tracker-status">${escapeHtml(statusLabel)}</div>
          <div class="install-tracker-summary">${escapeHtml(task.summary || '')}</div>
        </div>
        <div class="install-tracker-percent">${Math.max(0, Math.min(100, Number(task.progress || 0)))}%</div>
      </div>
      <div class="sti-progress install-tracker-bar"><div class="sti-progress-fill ${task.status === 'running' ? 'indeterminate' : ''}" style="width:${Math.max(6, task.progress || 0)}%"></div></div>
      <div class="install-tracker-hint">${escapeHtml(task.hint || '你现在不需要操作，等它自己完成即可。')}</div>
      <div class="install-tracker-detail">${escapeHtml(detailText)}</div>
      <div class="install-tracker-grid">
        <div class="install-tracker-col">${(task.steps || []).map((step, index) => renderOpenClawInstallStep(step, index, task.status)).join('')}</div>
        <div class="install-tracker-col">
          <div class="install-tracker-note-card">
            <div class="install-tracker-note-title">当前状态</div>
            <ul class="install-tracker-list">${infoItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
          </div>
          <div class="install-tracker-note-card">
            <div class="install-tracker-note-title">你现在该做什么</div>
            <ul class="install-tracker-list">${todoItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
          </div>
        </div>
      </div>
      <div class="install-tracker-log-head">
        <div class="install-tracker-log-title">最后日志</div>
        <button type="button" class="secondary install-tracker-copy-btn" data-copy-opencode-log>复制日志</button>
      </div>
      <pre class="install-tracker-log">${escapeHtml(logs)}</pre>
    </div>
  `;
}

function renderTrackedOpenCodeDialog(task, { force = false } = {}) {
  const renderKey = buildOpenCodeTrackerRenderKey(task);
  state.openCodeInstallView.lastLogsText = getOpenCodeTrackerLogsText(task);
  if (!force && shouldPauseOpenCodeInstallRender()) {
    state.openCodeInstallView.pendingTask = task;
    return;
  }
  if (!force && renderKey === state.openCodeInstallView.lastRenderKey) return;

  const body = el('updateDialogBody');
  const oldLog = body?.querySelector('.install-tracker-log');
  const oldBodyScrollTop = body?.scrollTop || 0;
  const oldLogScrollTop = oldLog?.scrollTop || 0;
  const oldLogScrollHeight = oldLog?.scrollHeight || 0;
  const wasNearBottom = !oldLog || (oldLog.scrollTop + oldLog.clientHeight >= oldLog.scrollHeight - 28);

  const copy = getOpenCodeActionCopy(task.action, task.installedBefore);
  const eyebrow = task.action === 'desktop-install' ? 'OpenCode Desktop' : 'OpenCode';
  patchUpdateDialog({
    eyebrow,
    title: task.status === 'success'
      ? copy.done
      : task.status === 'cancelled'
        ? `${copy.title.replace('正在', '').trim()} 已中断`
        : task.status === 'cancelling'
          ? `${copy.title.replace('正在', '').trim()} 中断中`
          : task.status === 'error'
            ? `${copy.title.replace('正在', '').trim()} 失败`
            : copy.title,
    body: renderOpenCodeTrackerDialog(task),
    confirmText: task.status === 'running' ? '处理中…' : task.status === 'cancelling' ? '中断中…' : '知道了',
    confirmDisabled: task.status === 'running' || task.status === 'cancelling',
    cancelText: task.status === 'running' ? '中断安装' : task.status === 'cancelling' ? '中断中…' : '取消',
    cancelDisabled: task.status === 'cancelling',
    cancelHidden: !(task.status === 'running' || task.status === 'cancelling'),
    trackerMode: true,
  });

  if (task.status !== 'running' && task.status !== 'cancelling') {
    state.updateDialogCancelHandler = null;
  }

  const syncScroll = () => {
    const newBody = el('updateDialogBody');
    const newLog = newBody?.querySelector('.install-tracker-log');
    if (newBody) newBody.scrollTop = oldBodyScrollTop;
    if (newLog) {
      if (wasNearBottom) {
        newLog.scrollTop = newLog.scrollHeight;
      } else {
        newLog.scrollTop = Math.max(0, oldLogScrollTop + (newLog.scrollHeight - oldLogScrollHeight));
      }
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(syncScroll);
  else syncScroll();
  state.openCodeInstallView.lastRenderKey = renderKey;
  state.openCodeInstallView.pendingTask = null;
}

async function finishOpenCodeTracker(task, result, errorMessage = '') {
  if (result?.requestedMethod) task.requestedMethod = result.requestedMethod;
  if (result?.method) task.method = result.method;
  if (typeof result?.googleReachable === 'boolean') task.googleReachable = result.googleReachable;
  if (typeof result?.usedDomesticMirror === 'boolean') task.usedDomesticMirror = result.usedDomesticMirror;
  if (result?.command) task.command = result.command;
  if (result?.stdout) task.stdout = String(result.stdout || '');
  if (result?.stderr) task.stderr = String(result.stderr || '');

  if (result?.googleReachable !== undefined) {
    pushOpenCodeTrackerLog(task, 'stdout', `Google 可达性检测结果：${result.googleReachable ? '可访问' : '不可访问'}`);
  }
  if (result?.method) {
    pushOpenCodeTrackerLog(task, 'stdout', `最终安装方式：${getOpenCodeMethodLabel(result.method)}`);
  }
  if (result?.command) {
    pushOpenCodeTrackerLog(task, 'stdout', `执行命令：${result.command}`);
  }
  const outputText = String(result?.stdout || result?.stderr || '').trim();
  if (outputText) {
    outputText.split(/\r?\n/).filter(Boolean).slice(-12).forEach((line) => pushOpenCodeTrackerLog(task, result?.stderr ? 'stderr' : 'stdout', line));
  }

  if (errorMessage) {
    task.status = 'error';
    task.error = errorMessage;
    task.completedAt = new Date().toISOString();
    if (task.action === 'uninstall') {
      setOpenCodeTrackerStep(task, Math.max(1, task.stepIndex), { status: 'error', detail: errorMessage, summary: 'OpenCode 卸载失败', hint: '先看最后日志，一般会直接指出失败原因。' });
    } else {
      setOpenCodeTrackerStep(task, Math.max(2, task.stepIndex), { status: 'error', detail: errorMessage, summary: 'OpenCode 安装失败', hint: '先看最后日志，通常会告诉你是网络、权限还是依赖问题。' });
    }
    renderTrackedOpenCodeDialog(task, { force: true });
    return;
  }

  if (task.action === 'uninstall') {
    setOpenCodeTrackerStep(task, 2, {
      progress: 94,
      summary: '正在验证 OpenCode 卸载结果…',
      hint: '马上就完成了。',
      detail: '正在刷新工具状态并确认卸载结果…',
    });
    renderTrackedOpenCodeDialog(task, { force: true });
    await sleep(260);
    task.steps = task.steps.map((step) => ({ ...step, status: 'done' }));
    task.progress = 100;
    task.status = 'success';
    task.summary = 'OpenCode 已卸载完成';
    task.hint = '如需恢复，重新点击安装即可。';
    task.detail = '工具状态已经刷新完成。';
    task.completedAt = new Date().toISOString();
    renderTrackedOpenCodeDialog(task, { force: true });
    return;
  }

  setOpenCodeTrackerStep(task, 3, {
    progress: 94,
    summary: '正在验证 OpenCode 安装结果…',
    hint: '马上就完成了，正在确认命令可用。',
    detail: result?.command ? `安装命令已完成，正在验证：${result.command}` : '安装命令已完成，正在验证 opencode 命令…',
  });
  renderTrackedOpenCodeDialog(task, { force: true });
  await sleep(320);
  task.steps = task.steps.map((step) => ({ ...step, status: 'done' }));
  task.progress = 100;
  task.status = 'success';
  task.summary = task.action === 'update' && task.installedBefore ? 'OpenCode 已更新到最新版' : task.action === 'reinstall' ? 'OpenCode 重装完成' : 'OpenCode 安装完成';
  task.hint = '下一步可以直接启动 OpenCode，或先去配置 Provider / 模型。';
  task.detail = result?.stdout ? String(result.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '已完成安装验证。' : '已完成安装验证。';
  task.version = state.tools.find((tool) => tool.id === 'opencode')?.binary?.version || '';
  task.completedAt = new Date().toISOString();
  renderTrackedOpenCodeDialog(task, { force: true });
}


async function fetchOpenCodeInstallTask(taskId) {
  const json = await api(`/api/opencode/install/status?taskId=${encodeURIComponent(taskId)}`, { timeoutMs: 12000 });
  if (!json.ok) throw new Error(json.error || '获取 OpenCode 安装进度失败');
  return json.data;
}

async function cancelOpenCodeInstallTask(taskId) {
  const json = await api('/api/opencode/install/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
    timeoutMs: 120000,
  });
  if (!json.ok) throw new Error(json.error || '中断 OpenCode 安装失败');
  return json.data;
}

async function fetchOpenCodeDesktopInstallTask(taskId) {
  const json = await api(`/api/opencode/desktop/install/status?taskId=${encodeURIComponent(taskId)}`, { timeoutMs: 12000 });
  if (!json.ok) throw new Error(json.error || '获取 OpenCode Desktop 安装进度失败');
  return json.data;
}

async function cancelOpenCodeDesktopInstallTask(taskId) {
  const json = await api('/api/opencode/desktop/install/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
    timeoutMs: 120000,
  });
  if (!json.ok) throw new Error(json.error || '中断 OpenCode Desktop 安装失败');
  return json.data;
}

function syncOpenCodeTrackerWithTask(tracker, task) {
  if (!tracker || !task) return tracker;
  tracker.taskId = task.taskId || tracker.taskId || '';
  tracker.action = task.action || tracker.action;
  tracker.requestedMethod = task.requestedMethod || tracker.requestedMethod;
  tracker.method = task.method || '';
  tracker.command = task.command || '';
  tracker.googleReachable = typeof task.googleReachable === 'boolean' ? task.googleReachable : null;
  tracker.usedDomesticMirror = typeof task.usedDomesticMirror === 'boolean' ? task.usedDomesticMirror : null;
  tracker.status = task.status || tracker.status;
  tracker.progress = Number(task.progress || 0) || tracker.progress || 0;
  tracker.stepIndex = Number(task.stepIndex || 0) || 0;
  tracker.summary = task.summary || tracker.summary;
  tracker.hint = task.hint || tracker.hint;
  tracker.detail = task.detail || tracker.detail;
  tracker.steps = Array.isArray(task.steps) && task.steps.length ? task.steps : tracker.steps;
  tracker.logs = Array.isArray(task.logs) ? task.logs : tracker.logs;
  tracker.startedAt = task.startedAt || tracker.startedAt;
  tracker.completedAt = task.completedAt || null;
  tracker.version = task.version || '';
  tracker.error = task.error || null;
  return tracker;
}

function isUnsupportedOpenCodeTaskApi(error) {
  const message = String(error?.message || error || '');
  return message.includes('Unsupported request: POST /api/opencode/install/start')
    || message.includes('Unsupported request: GET /api/opencode/install/status')
    || message.includes('Unsupported request: POST /api/opencode/install/cancel');
}

async function runLegacyOpenCodeRequest(action, requestedMethod) {
  const apiMap = {
    install: '/api/opencode/install',
    update: '/api/opencode/update',
    reinstall: '/api/opencode/reinstall',
    uninstall: '/api/opencode/uninstall',
  };
  const json = await api(apiMap[action], {
    method: 'POST',
    headers: requestedMethod ? { 'Content-Type': 'application/json' } : undefined,
    body: requestedMethod ? JSON.stringify({ method: requestedMethod }) : undefined,
    timeoutMs: 180000,
  });
  if (!json.ok) throw new Error(json.error || 'OpenCode 操作失败');
  return json.data;
}

async function runTrackedOpenCodeTask(action, method, onUpdate) {
  const startJson = await api('/api/opencode/install/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, method }),
    timeoutMs: 12000,
  });
  if (!startJson.ok || !startJson.data?.taskId) {
    throw new Error(startJson.error || '启动 OpenCode 任务失败');
  }

  let task = startJson.data;
  if (typeof onUpdate === 'function') onUpdate(task);

  let refreshFailures = 0;
  while (task.status === 'running' || task.status === 'cancelling') {
    await sleep(900);
    try {
      task = await fetchOpenCodeInstallTask(task.taskId);
      refreshFailures = 0;
      if (typeof onUpdate === 'function') onUpdate(task);
    } catch (error) {
      refreshFailures += 1;
      if (refreshFailures >= 3) throw error;
    }
  }

  return task;
}

async function runTrackedOpenCodeDesktopTask(onUpdate, { reinstall = false } = {}) {
  const startJson = await api('/api/opencode/desktop/install/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reinstall: Boolean(reinstall) }),
    timeoutMs: 12000,
  });
  if (!startJson.ok || !startJson.data?.taskId) {
    throw new Error(startJson.error || '启动 OpenCode Desktop 安装任务失败');
  }

  let task = startJson.data;
  if (typeof onUpdate === 'function') onUpdate(task);

  let refreshFailures = 0;
  while (task.status === 'running' || task.status === 'cancelling') {
    await sleep(900);
    try {
      task = await fetchOpenCodeDesktopInstallTask(task.taskId);
      refreshFailures = 0;
      if (typeof onUpdate === 'function') onUpdate(task);
    } catch (error) {
      refreshFailures += 1;
      if (refreshFailures >= 3) throw error;
    }
  }

  return task;
}

async function runOpenCodeToolAction(action, btn, options = {}) {
  const installedBefore = action === 'install'
    ? false
    : Boolean(state.tools.find((tool) => tool.id === 'opencode')?.binary?.installed);
  const requestedMethod = String(options.method || '').trim();
  const suppressFlash = Boolean(options.suppressFlash);
  const copy = getOpenCodeActionCopy(action, installedBefore);
  const confirmMap = {
    reinstall: {
      eyebrow: 'OpenCode',
      title: '重装 OpenCode',
      body: '<p>这会重新全局安装当前版本 OpenCode。</p>',
      confirmText: '确认重装',
      cancelText: '取消',
    },
    uninstall: {
      eyebrow: 'OpenCode',
      title: '卸载 OpenCode',
      body: '<p>卸载后将无法直接从工具页启动 OpenCode。</p>',
      confirmText: '确认卸载',
      cancelText: '取消',
      tone: 'danger',
    },
  };

  if (confirmMap[action]) {
    const confirmed = await openUpdateDialog(confirmMap[action]);
    if (!confirmed) {
      flash('操作已取消', 'info');
      return { ok: false, cancelled: true };
    }
  }

  const tracker = createOpenCodeTracker(action, { installedBefore, requestedMethod });
  if (requestedMethod) {
    pushOpenCodeTrackerLog(tracker, 'stdout', `安装方式请求：${getOpenCodeRequestedMethodLabel(requestedMethod)}`);
  }
  (tracker.commandPreview || []).forEach((line, index) => {
    pushOpenCodeTrackerLog(tracker, 'stdout', `${tracker.commandPreview.length > 1 ? `候选命令 ${index + 1}` : '预计命令'}：${line}`);
  });
  if (tracker.commandPreview?.length) {
    pushOpenCodeTrackerLog(tracker, 'stdout', '说明：实际 Google 检测结果、最终方式、真实执行命令，将由后端安装器实时回传。');
  }

  setToolBtnBusy(btn, true, copy.busy);
  clearInterval(state.openCodeInstallView.timerId || 0);
  state.openCodeInstallView.timerId = 0;
  state.openCodeInstallView.activeTaskId = '';
  state.openCodeInstallView.cancelBusy = false;
  void openUpdateDialog({
    eyebrow: 'OpenCode',
    title: copy.title,
    body: renderOpenCodeTrackerDialog(tracker),
    confirmText: '处理中…',
    confirmDisabled: true,
    cancelText: '中断安装',
    cancelHidden: false,
    trackerMode: true,
  });
  setUpdateDialogLocked(true, copy.title);
  renderTrackedOpenCodeDialog(tracker, { force: true });
  state.updateDialogCancelHandler = async () => {
    const activeTaskId = state.openCodeInstallView.activeTaskId;
    if (!activeTaskId || state.openCodeInstallView.cancelBusy) return;
    state.openCodeInstallView.cancelBusy = true;
    patchUpdateDialog({
      cancelText: '中断中…',
      cancelDisabled: true,
      confirmText: '清理中…',
      confirmDisabled: true,
      trackerMode: true,
    });
    try {
      await cancelOpenCodeInstallTask(activeTaskId);
      flash('已发送 OpenCode 中断请求', 'info');
    } catch (error) {
      state.openCodeInstallView.cancelBusy = false;
      patchUpdateDialog({
        cancelText: '重试中断',
        cancelDisabled: false,
        confirmText: '处理中…',
        confirmDisabled: true,
        trackerMode: true,
      });
      flash(error.message || '中断 OpenCode 安装失败', 'error');
    }
  };

  try {
    const finalTask = await runTrackedOpenCodeTask(action, requestedMethod, (task) => {
      state.openCodeInstallView.activeTaskId = task.taskId || state.openCodeInstallView.activeTaskId;
      state.openCodeInstallView.cancelBusy = task.status === 'cancelling';
      syncOpenCodeTrackerWithTask(tracker, task);
      renderTrackedOpenCodeDialog(tracker);
    });

    state.updateDialogCancelHandler = null;
    state.openCodeInstallView.cancelBusy = false;
    syncOpenCodeTrackerWithTask(tracker, finalTask);
    renderTrackedOpenCodeDialog(tracker, { force: true });
    setUpdateDialogLocked(false);
    patchUpdateDialog({
      eyebrow: 'OpenCode',
      title: tracker.status === 'success' ? copy.done : tracker.status === 'cancelled' ? 'OpenCode 安装已中断' : tracker.status === 'error' ? `${copy.title.replace('正在', '').trim()} 失败` : copy.title,
      body: renderOpenCodeTrackerDialog(tracker),
      confirmText: '知道了',
      confirmDisabled: false,
      cancelHidden: true,
      cancelDisabled: false,
      trackerMode: true,
    });

    await refreshToolRuntimeAfterMutation('opencode');

    if (finalTask.status === 'success') {
      if (!suppressFlash) flash(copy.done, 'success');
      return { ok: true, data: finalTask };
    }
    if (finalTask.status === 'cancelled') {
      if (!suppressFlash) flash('OpenCode 安装已中断', 'info');
      return { ok: false, cancelled: true, data: finalTask };
    }

    const errMsg = finalTask.error || 'OpenCode 操作失败';
    if (!suppressFlash) flash(errMsg, 'error');
    return { ok: false, error: errMsg, data: finalTask };
  } catch (error) {
    if (isUnsupportedOpenCodeTaskApi(error)) {
      pushOpenCodeTrackerLog(tracker, 'stderr', '当前桌面后端还未升级到实时任务接口，已自动切换为兼容模式继续安装。');
      tracker.summary = '正在切换兼容模式继续执行…';
      tracker.hint = '不需要你手动执行命令；本次自动兼容，但暂时不支持实时中断。';
      tracker.detail = '正在调用旧版后端接口完成安装…';
      renderTrackedOpenCodeDialog(tracker, { force: true });
      patchUpdateDialog({
        cancelHidden: true,
        cancelDisabled: true,
        confirmText: '处理中…',
        confirmDisabled: true,
        trackerMode: true,
      });
      state.updateDialogCancelHandler = null;
      try {
        const legacyResult = await runLegacyOpenCodeRequest(action, requestedMethod);
        await refreshToolRuntimeAfterMutation('opencode');
        setUpdateDialogLocked(false);
        await finishOpenCodeTracker(tracker, legacyResult, legacyResult?.ok === false ? (legacyResult?.stderr || 'OpenCode 操作失败') : '');
        patchUpdateDialog({ confirmText: '知道了', confirmDisabled: false, cancelHidden: true, trackerMode: true });
        if (legacyResult?.ok === false) {
          const errMsg = legacyResult?.stderr || 'OpenCode 操作失败';
          if (!suppressFlash) flash(errMsg, 'error');
          return { ok: false, error: errMsg, data: legacyResult };
        }
        if (!suppressFlash) flash(copy.done, 'success');
        return { ok: true, data: legacyResult, compatibilityMode: true };
      } catch (legacyError) {
        const errMsg = legacyError?.message || 'OpenCode 操作失败';
        state.updateDialogCancelHandler = null;
        state.openCodeInstallView.cancelBusy = false;
        tracker.status = 'error';
        tracker.error = errMsg;
        tracker.completedAt = new Date().toISOString();
        tracker.summary = action === 'uninstall' ? 'OpenCode 卸载失败' : 'OpenCode 安装失败';
        tracker.hint = '兼容模式也执行失败了，请看最后日志。';
        tracker.detail = errMsg;
        renderTrackedOpenCodeDialog(tracker, { force: true });
        setUpdateDialogLocked(false);
        patchUpdateDialog({ confirmText: '知道了', confirmDisabled: false, cancelHidden: true, trackerMode: true });
        if (!suppressFlash) flash(errMsg, 'error');
        return { ok: false, error: errMsg };
      }
    }

    const errMsg = error?.message || 'OpenCode 操作失败';
    state.updateDialogCancelHandler = null;
    state.openCodeInstallView.cancelBusy = false;
    tracker.status = 'error';
    tracker.error = errMsg;
    tracker.completedAt = new Date().toISOString();
    tracker.summary = action === 'uninstall' ? 'OpenCode 卸载失败' : 'OpenCode 安装失败';
    tracker.hint = '无法继续获取实时安装状态，请重试。';
    tracker.detail = errMsg;
    renderTrackedOpenCodeDialog(tracker, { force: true });
    setUpdateDialogLocked(false);
    patchUpdateDialog({ confirmText: '知道了', confirmDisabled: false, cancelHidden: true, trackerMode: true });
    if (!suppressFlash) flash(errMsg, 'error');
    return { ok: false, error: errMsg };
  } finally {
    setToolBtnBusy(btn, false);
  }
}

async function runOpenCodeDesktopInstallAction(btn, { reinstall = false } = {}) {
  if (reinstall) {
    const confirmed = await openUpdateDialog({
      eyebrow: 'OpenCode Desktop',
      title: '重新安装 OpenCode Desktop',
      body: '<p>这会重新下载安装官方桌面版，并自动继续安装。</p>',
      confirmText: '确认重装',
      cancelText: '取消',
    });
    if (!confirmed) {
      flash('操作已取消', 'info');
      return { ok: false, cancelled: true };
    }
  }

  const installedBefore = Boolean(state.openCodeDesktopState?.installed);
  const copy = getOpenCodeActionCopy('desktop-install', reinstall || installedBefore);
  const tracker = createOpenCodeTracker('desktop-install', { installedBefore: reinstall || installedBefore });
  tracker.toolId = 'opencode-desktop';
  pushOpenCodeTrackerLog(tracker, 'stdout', '安装源：OpenCode 官方桌面版稳定渠道');
  (tracker.commandPreview || []).forEach((line, index) => {
    pushOpenCodeTrackerLog(tracker, 'stdout', `${tracker.commandPreview.length > 1 ? `预计步骤 ${index + 1}` : '预计步骤'}：${line}`);
  });

  const taskCardId = addTask(reinstall ? '重装 OpenCode Desktop' : '安装 OpenCode Desktop', {
    progress: Math.max(4, tracker.progress || 4),
    message: tracker.summary || copy.title,
  });

  setToolBtnBusy(btn, true, copy.busy);
  clearInterval(state.openCodeInstallView.timerId || 0);
  state.openCodeInstallView.timerId = 0;
  state.openCodeInstallView.activeTaskId = '';
  state.openCodeInstallView.cancelBusy = false;
  void openUpdateDialog({
    eyebrow: 'OpenCode Desktop',
    title: copy.title,
    body: renderOpenCodeTrackerDialog(tracker),
    confirmText: '处理中…',
    confirmDisabled: true,
    cancelText: '中断安装',
    cancelHidden: false,
    trackerMode: true,
  });
  setUpdateDialogLocked(true, copy.title);
  renderTrackedOpenCodeDialog(tracker, { force: true });
  state.updateDialogCancelHandler = async () => {
    const activeTaskId = state.openCodeInstallView.activeTaskId;
    if (!activeTaskId || state.openCodeInstallView.cancelBusy) return;
    state.openCodeInstallView.cancelBusy = true;
    patchUpdateDialog({
      cancelText: '中断中…',
      cancelDisabled: true,
      confirmText: '清理中…',
      confirmDisabled: true,
      trackerMode: true,
    });
    try {
      await cancelOpenCodeDesktopInstallTask(activeTaskId);
      flash('已发送 OpenCode Desktop 中断请求', 'info');
    } catch (error) {
      state.openCodeInstallView.cancelBusy = false;
      patchUpdateDialog({
        cancelText: '重试中断',
        cancelDisabled: false,
        confirmText: '处理中…',
        confirmDisabled: true,
        trackerMode: true,
      });
      flash(error.message || '中断 OpenCode Desktop 安装失败', 'error');
    }
  };

  try {
    const finalTask = await runTrackedOpenCodeDesktopTask((task) => {
      state.openCodeInstallView.activeTaskId = task.taskId || state.openCodeInstallView.activeTaskId;
      state.openCodeInstallView.cancelBusy = task.status === 'cancelling';
      syncOpenCodeTrackerWithTask(tracker, task);
      renderTrackedOpenCodeDialog(tracker);
      updateTask(taskCardId, {
        name: reinstall ? '重装 OpenCode Desktop' : '安装 OpenCode Desktop',
        status: task.status === 'running' || task.status === 'cancelling'
          ? 'running'
          : task.status === 'success'
            ? 'done'
            : task.status === 'cancelled'
              ? 'cancelled'
              : 'error',
        progress: Math.max(4, task.progress || 0),
        message: task.summary || '',
      });
    }, { reinstall });

    state.updateDialogCancelHandler = null;
    state.openCodeInstallView.cancelBusy = false;
    syncOpenCodeTrackerWithTask(tracker, finalTask);
    renderTrackedOpenCodeDialog(tracker, { force: true });
    setUpdateDialogLocked(false);
    patchUpdateDialog({
      eyebrow: 'OpenCode Desktop',
      title: tracker.status === 'success' ? copy.done : tracker.status === 'cancelled' ? 'OpenCode Desktop 安装已中断' : tracker.status === 'error' ? `${copy.title.replace('正在', '').trim()} 失败` : copy.title,
      body: renderOpenCodeTrackerDialog(tracker),
      confirmText: '知道了',
      confirmDisabled: false,
      cancelHidden: true,
      cancelDisabled: false,
      trackerMode: true,
    });

    await refreshToolRuntimeAfterMutation('opencode');

    if (finalTask.status === 'success') {
      flash(copy.done, 'success');
      updateTask(taskCardId, { status: 'done', progress: 100, message: '桌面版已安装完成' });
      return { ok: true, data: finalTask };
    }
    if (finalTask.status === 'cancelled') {
      flash('OpenCode Desktop 安装已中断', 'info');
      updateTask(taskCardId, { status: 'cancelled', progress: 100, message: finalTask.summary || '安装已中断' });
      return { ok: false, cancelled: true, data: finalTask };
    }

    const errMsg = finalTask.error || 'OpenCode Desktop 安装失败';
    flash(errMsg, 'error');
    updateTask(taskCardId, { status: 'error', message: errMsg });
    return { ok: false, error: errMsg, data: finalTask };
  } catch (error) {
    const errMsg = error?.message || 'OpenCode Desktop 安装失败';
    state.updateDialogCancelHandler = null;
    state.openCodeInstallView.cancelBusy = false;
    tracker.status = 'error';
    tracker.error = errMsg;
    tracker.completedAt = new Date().toISOString();
    tracker.summary = 'OpenCode Desktop 安装失败';
    tracker.hint = '无法继续获取实时安装状态，请重试。';
    tracker.detail = errMsg;
    renderTrackedOpenCodeDialog(tracker, { force: true });
    setUpdateDialogLocked(false);
    patchUpdateDialog({ eyebrow: 'OpenCode Desktop', confirmText: '知道了', confirmDisabled: false, cancelHidden: true, trackerMode: true });
    flash(errMsg, 'error');
    updateTask(taskCardId, { status: 'error', message: errMsg });
    return { ok: false, error: errMsg };
  } finally {
    setToolBtnBusy(btn, false);
  }
}

function toolIconSvg(toolId) {
  const icons = {
    codex: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7l9-5z" opacity="0.4" /><path d="M12 12l9-5M12 12v10M12 12L3 7" /></svg>',
    'codex-app': '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3" opacity="0.35" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>',
    claudecode: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" opacity="0.4" /><path d="M8 12h8M12 8v8" /></svg>',
    openclaw: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" opacity="0.4" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none" /></svg>',
    opencode: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5" opacity="0.4" /><path d="M9 8l-3 4 3 4" /><path d="M15 8l3 4-3 4" /><path d="M13 6l-2 12" /></svg>',
    'opencode-desktop': '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5" opacity="0.4" /><path d="M9 8l-3 4 3 4" /><path d="M15 8l3 4-3 4" /><path d="M13 6l-2 12" /></svg>',
    'opencode-vscode': '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3 6 8v8l9 5 6-3V6l-6-3Z" opacity="0.35" /><path d="m6 8 4 4-4 4" /><path d="m10 6 4 2v8l-4 2" /></svg>',
    'opencode-cursor': '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14v14H5z" opacity="0.35" /><path d="m8 8 4 4-4 4" /><path d="M13 8h3" /><path d="M13 16h3" /></svg>',
    'opencode-windsurf': '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15c2.5-5 5.5-7.5 9-7.5 3 0 5.3 1.4 7 4.5" opacity="0.4" /><path d="M4 12c2.5 5 5.5 7.5 9 7.5 3 0 5.3-1.4 7-4.5" /><path d="M8 12h8" /></svg>',
    'opencode-vscodium': '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3 6 8v8l9 5 6-3V6l-6-3Z" opacity="0.35" /><path d="m6 8 4 4-4 4" /><path d="m15-10-5 6 5 6" opacity="0.85" /></svg>',
    'opencode-zed': '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14v14H5z" opacity="0.35" /><path d="M8 8h8l-8 8h8" /></svg>',
    'opencode-github': '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-4.5 1.5-5-2-7-2" /><path d="M15 22v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 19 4.77 5.07 5.07 0 0 0 18.91 1S17.73.65 15 2.48a13.38 13.38 0 0 0-6 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77 5.44 5.44 0 0 0 3.5 8.5c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" /></svg>',
    'opencode-gitlab': '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 21 4.2-12.8H7.8L12 21Z" /><path d="M4.8 8.2 12 21l-7-5.2.8-7.6Z" opacity="0.45" /><path d="M19.2 8.2 12 21l7-5.2-.8-7.6Z" opacity="0.45" /></svg>',
  };
  return icons[toolId] || icons.codex;
}

function updateToolSelector() {
  document.querySelectorAll('.tool-tab').forEach(tab => {
    const tid = tab.dataset.tool;
    // Always toggle active class based on activeTool
    tab.classList.toggle('active', tid === state.activeTool);
    // Update disabled state from tools data if available
    const tool = state.tools.find(t => t.id === tid);
    if (tool) {
      tab.disabled = !tool.supported;
    }
  });
  document.querySelectorAll('.sec-item[data-sec-tool]').forEach(item => {
    const tid = item.dataset.secTool;
    item.classList.toggle('active', tid === state.activeTool);
    const tool = state.tools.find(t => t.id === tid);
    if (tool) item.disabled = !tool.supported;
  });
}

// Per-tool form state cache
const _toolFormCache = {};

function _getToolFormCache(toolId, create = false) {
  if (!toolId) return null;
  if (_toolFormCache[toolId]) return _toolFormCache[toolId];
  if (!create) return null;
  _toolFormCache[toolId] = { dirtyFields: {} };
  return _toolFormCache[toolId];
}

function _markCurrentToolFieldDirty(field, value) {
  const cache = _getToolFormCache(state.activeTool, true);
  if (!cache) return;
  cache[field] = value;
  cache.dirtyFields = cache.dirtyFields || {};
  cache.dirtyFields[field] = true;
}

function _shouldPreserveToolField(toolId, field) {
  return Boolean(_toolFormCache[toolId]?.dirtyFields?.[field]);
}

function _saveCurrentToolForm() {
  const toolId = state.activeTool;
  if (!toolId) return;
  const cache = _getToolFormCache(toolId, true);
  cache.baseUrl = el('baseUrlInput')?.value || '';
  cache.providerKey = el('claudeProviderKeyInput')?.value || '';
  cache.apiKey = el('apiKeyInput')?.value || '';
  cache.protocolValue = el('openClawProtocolSelect')?.value || '';
  cache.modelHtml = el('modelSelect')?.innerHTML || '';
  cache.modelValue = el('modelSelect')?.value || '';
}

function _restoreToolForm(toolId) {
  const cache = _getToolFormCache(toolId);
  if (!cache) return false;
  const baseUrlInput = el('baseUrlInput');
  const providerKeyInput = el('claudeProviderKeyInput');
  const apiKeyInput = el('apiKeyInput');
  const protocolSelect = el('openClawProtocolSelect');
  const modelSelect = el('modelSelect');
  if (baseUrlInput) baseUrlInput.value = cache.baseUrl || '';
  if (providerKeyInput) providerKeyInput.value = cache.providerKey || '';
  if (apiKeyInput) apiKeyInput.value = cache.apiKey || '';
  if (protocolSelect && cache.protocolValue) protocolSelect.value = cache.protocolValue;
  if (modelSelect) {
    modelSelect.innerHTML = cache.modelHtml || '';
    modelSelect.value = cache.modelValue || '';
  }
  return true;
}

function setActiveTool(toolId) {
  const tool = state.tools.find(t => t.id === toolId);
  if (tool && !tool.supported) return;
  if (toolId === state.activeTool) return;

  _saveCurrentToolForm();

  state.activeTool = toolId;
  updateToolSelector();

  const rememberedPage = state.toolLastPage[toolId] || 'quick';
  if (rememberedPage !== state.activePage) {
    setPage(rememberedPage);
  }
  const toolDisplayName = tool?.name || { codex: 'Codex', claudecode: 'Claude Code', openclaw: 'OpenClaw' }[toolId] || toolId;
  const launchBtn = el('launchBtn');
  if (launchBtn) launchBtn.textContent = `启动 ${toolDisplayName}`;
  const claudeOauthLoginBtn = el('claudeOauthLoginBtn');
  if (claudeOauthLoginBtn) claudeOauthLoginBtn.classList.add('hide');

  const baseUrlInput = el('baseUrlInput');
  const claudeProviderKeyField = el('claudeProviderKeyField');
  const apiKeyInput = el('apiKeyInput');
  const modelSelect = el('modelSelect');
  const detectBtn = el('detectBtn');
  const baseUrlField = baseUrlInput?.closest('.field');
  const detectField = detectBtn?.closest('.field');
  const protocolField = el('openClawProtocolField');
  const modelField = modelSelect?.closest('.field');
  const baseUrlLabel = baseUrlField?.querySelector('span');
  const apiKeyLabel = apiKeyInput?.closest('.field')?.querySelector('span');
  const detectLabel = detectField?.querySelector('span');
  const modelLabel = modelField?.querySelector('span');
  const detectionMeta = el('detectionMeta');
  const sectionTitle = document.querySelector('.flow-section .section-title');
  const modelChips = el('modelChips');
  const codexAuthBlock = el('codexAuthBlock');
  const modelRefreshBtn = el('modelRefreshBtn');
  const ocDashRow = el('ocDashboardQuickRow');
  const syncActions = el('sectionSyncActions');
  if (detectLabel) detectLabel.textContent = '连接检测';
  if (modelLabel) modelLabel.textContent = '可用模型';
  if (protocolField) protocolField.classList.add('hide');
  if (claudeProviderKeyField) claudeProviderKeyField.classList.add('hide');
  if (modelChips) modelChips.classList.add('hide');
  if (codexAuthBlock) codexAuthBlock.style.display = 'none';
  if (modelRefreshBtn) modelRefreshBtn.classList.remove('visible');
  if (ocDashRow) ocDashRow.classList.add('hide');
  if (syncActions) syncActions.style.display = 'none';

  if (toolId === 'claudecode') {
    if (claudeOauthLoginBtn) claudeOauthLoginBtn.classList.remove('hide');
    if (baseUrlField) baseUrlField.style.display = '';
    if (claudeProviderKeyField) claudeProviderKeyField.classList.remove('hide');
    if (modelField) modelField.style.display = '';
    if (baseUrlInput) {
      baseUrlInput.value = '';
      baseUrlInput.placeholder = 'ANTHROPIC_BASE_URL (留空则使用官方)';
    }
    if (apiKeyInput) {
      apiKeyInput.type = 'password';
      apiKeyInput.value = '';
      apiKeyInput.placeholder = 'ANTHROPIC_API_KEY (可选，已登录则无需填写)';
    }
    syncApiKeyToggle();
    if (detectField) detectField.style.display = 'none';
    if (sectionTitle) sectionTitle.textContent = 'Claude Code 设置';
    if (modelLabel) modelLabel.textContent = '默认模型';
    if (detectionMeta) detectionMeta.textContent = '支持 OAuth 与 API Key；已完成 OAuth 时 API Key 可以留空。';
    if (modelSelect) modelSelect.innerHTML = '<option value="">加载中...</option>';
    applyClaudeCodeQuickInstallState(state.claudeCodeState || {});
    loadClaudeCodeQuickState();
    renderCurrentConfig();
    return;
  }

  if (toolId === 'opencode') {
    if (baseUrlField) baseUrlField.style.display = '';
    if (detectField) detectField.style.display = '';
    if (modelField) modelField.style.display = '';
    if (sectionTitle) sectionTitle.textContent = 'OpenCode 快速配置';
    if (baseUrlLabel) baseUrlLabel.textContent = 'Provider Base URL';
    if (apiKeyLabel) apiKeyLabel.textContent = 'Provider API Key';
    if (modelLabel) modelLabel.textContent = '默认模型';
    if (detectionMeta) detectionMeta.textContent = '填写 OpenAI 兼容 URL / Key，再检测模型并写入 opencode.json。';
    if (baseUrlInput) {
      baseUrlInput.value = '';
      baseUrlInput.placeholder = 'https://your-provider.com/v1';
    }
    if (apiKeyInput) {
      apiKeyInput.type = 'password';
      apiKeyInput.value = '';
      apiKeyInput.placeholder = 'sk-...';
    }
    syncApiKeyToggle();
    applyOpenCodeQuickInstallState(state.opencodeState || {});
    loadOpenCodeQuickState();
    renderCurrentConfig();
    return;
  }

  if (toolId !== 'openclaw') {
    if (state.current?.login?.loggedIn && state.codexAuthView !== 'api_key') {
      state.codexAuthView = 'official';
    }
    if (baseUrlField) baseUrlField.style.display = '';
    if (detectField) detectField.style.display = '';
    if (modelField) modelField.style.display = '';
    if (sectionTitle) sectionTitle.textContent = '连接配置';
    if (detectionMeta) detectionMeta.textContent = '只需要 URL 和 API Key；缺少 http/https 会自动补全。';
    if (baseUrlInput) baseUrlInput.placeholder = 'https://your-provider.com/v1';
    if (apiKeyInput) {
      apiKeyInput.type = 'password';
      apiKeyInput.placeholder = state.apiKeyField?.maskedValue || 'sk-...';
    }
    syncApiKeyToggle();
    applyCodexQuickInstallState();

    if (!_restoreToolForm('codex')) {
      if (baseUrlInput && state.current?.config?.base_url) baseUrlInput.value = state.current.config.base_url;
      if (apiKeyInput) apiKeyInput.value = '';
      if (modelSelect) renderDefaultCodexModels(modelSelect, state.current?.summary?.model || '');
    }
    syncCodexAuthView();
    renderCurrentConfig();
    return;
  }

  if (baseUrlField) baseUrlField.style.display = '';
  if (detectField) detectField.style.display = 'none';
  if (protocolField) protocolField.classList.remove('hide');
  if (modelField) modelField.style.display = '';
  if (sectionTitle) sectionTitle.textContent = 'OpenClaw 模型配置';
  if (syncActions) syncActions.style.display = '';
  if (baseUrlLabel) baseUrlLabel.textContent = 'Base URL（可选，留空自动走官方）';
  if (apiKeyLabel) apiKeyLabel.textContent = '模型 API Key';
  if (modelLabel) modelLabel.textContent = '默认模型';
  if (detectionMeta) detectionMeta.textContent = '选择协议后会自动适配默认 URL、环境变量名和推荐模型。';
  loadOpenClawQuickState();
  renderCurrentConfig();
}

// Claude Code model aliases → display names
const CLAUDE_MODEL_ALIASES = [
  { value: 'opus', label: 'Opus (最强推理)', group: '别名' },
  { value: 'sonnet', label: 'Sonnet (均衡推荐)', group: '别名' },
  { value: 'haiku', label: 'Haiku (快速轻量)', group: '别名' },
];

// Claude model IDs (official docs + common gateway-compatible aliases)
const CLAUDE_MODEL_PRESETS = [
  // Latest family (official overview page)
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  // 4.5 compatibility (legacy/rollout variants seen in docs by locale)
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  // Official aliases and snapshots
  'claude-opus-4-1',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-20250514',
  'claude-sonnet-4-0',
  'claude-sonnet-4-20250514',
  'claude-3-7-sonnet',
  'claude-3-7-sonnet-latest',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-latest',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-latest',
  'claude-3-5-haiku-20241022',
  'claude-3-haiku-20240307',
];

function normalizeClaudeModelKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function dedupeClaudeModels(models = []) {
  const seen = new Set();
  const output = [];
  for (const raw of models) {
    const value = String(raw || '').trim();
    const key = normalizeClaudeModelKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function isClaudePresetModel(model = '') {
  const key = normalizeClaudeModelKey(model);
  if (!key) return false;
  return dedupeClaudeModels(CLAUDE_MODEL_PRESETS).some((item) => normalizeClaudeModelKey(item) === key);
}

function renderClaudeModelSelect(selectId, {
  usedModels = [],
  currentModel = '',
  emptyLabel = '从预置选择（可留空）',
} = {}) {
  const select = el(selectId);
  if (!select) return;
  const presets = dedupeClaudeModels(CLAUDE_MODEL_PRESETS);
  const history = dedupeClaudeModels(usedModels);
  const merged = dedupeClaudeModels([...presets, ...history]);
  let html = `<option value="">${escapeHtml(emptyLabel)}</option>`;
  html += merged.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
  const normalizedCurrent = normalizeClaudeModelKey(currentModel);
  if (normalizedCurrent && !merged.some((item) => normalizeClaudeModelKey(item) === normalizedCurrent)) {
    html += `<option value="${escapeHtml(currentModel)}">${escapeHtml(currentModel)} (当前自定义)</option>`;
  }
  select.innerHTML = html;
}

function setClaudeModelControl(selectId, customId, modelValue = '', usedModels = []) {
  const model = String(modelValue || '').trim();
  renderClaudeModelSelect(selectId, { usedModels, currentModel: model });
  const select = el(selectId);
  const custom = el(customId);
  const inSelect = model && [...(select?.options || [])].some((option) => normalizeClaudeModelKey(option.value) === normalizeClaudeModelKey(model));
  if (select) select.value = inSelect ? model : '';
  if (custom) custom.value = model && !inSelect ? model : '';
}

function readClaudeModelControl(selectId, customId) {
  const custom = el(customId)?.value?.trim() || '';
  const selected = el(selectId)?.value?.trim() || '';
  return custom || selected;
}

function renderClaudeModelPresetList() {
  const datalist = el('claudeModelPresetList');
  const uniqueModels = dedupeClaudeModels(CLAUDE_MODEL_PRESETS);
  if (datalist) {
    datalist.innerHTML = uniqueModels
      .map((model) => `<option value="${escapeHtml(model)}"></option>`)
      .join('');
  }
  const createSelect = el('ccProviderCreateModelSelect');
  if (createSelect) {
    const previous = createSelect.value || '';
    let html = '<option value="">从预置选择（可留空）</option>';
    html += uniqueModels.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
    if (previous && !uniqueModels.includes(previous)) {
      html += `<option value="${escapeHtml(previous)}">${escapeHtml(previous)} (当前自定义)</option>`;
    }
    createSelect.innerHTML = html;
    if (previous) createSelect.value = previous;
  }
}

async function loadClaudeCodeQuickState({ force = false, cacheOnly = false } = {}) {
  try {
    renderClaudeModelPresetList();
    const params = new URLSearchParams();
    if (force) params.set('forceUsageRefresh', '1');
    if (cacheOnly) params.set('cacheOnly', '1');
    const json = await api(`/api/claudecode/state${params.toString() ? `?${params.toString()}` : ''}`);
    if (!json.ok || !json.data) return { ok: false, error: json.error || '读取失败' };
    const data = json.data;
    if (data?.usage?.cacheMiss) return { ok: false, cacheMiss: true };
    if (!data?.usage || typeof data.usage !== 'object' || !data.usage.totals) {
      return { ok: false, invalidUsage: true };
    }
    state.claudeCodeState = data;
    applyClaudeCodeQuickInstallState(data);
    const claudeProviders = getClaudeProviderProfiles(data);
    const activeClaudeProvider = claudeProviders.find((provider) => provider.isActive) || claudeProviders[0] || null;
    const activeProviderKey = activeClaudeProvider?.key || '';
    const activeProviderBaseUrl = activeClaudeProvider?.baseUrl || '';
    state.claudeSelectedProviderKey = activeProviderKey;

    // Only update quick-page UI if Claude Code is the active tool
    if (state.activeTool !== 'claudecode') {
      // Still update console and side panel
      renderToolConsole();
      return { ok: true, data };
    }

    const modelSelect = el('modelSelect');
    if (modelSelect) {
      // Build model options: aliases + preset model IDs + used models from history
      let html = '<option value="">默认 (由 Claude Code 决定)</option>';
      const usedKeys = new Set();
      const markUsed = (value = '') => {
        const key = normalizeClaudeModelKey(value);
        if (!key || usedKeys.has(key)) return false;
        usedKeys.add(key);
        return true;
      };

      // Alias group
      html += '<optgroup label="模型别名 (推荐)">';
      for (const m of CLAUDE_MODEL_ALIASES) {
        if (!markUsed(m.value)) continue;
        const selected = data.model === m.value ? ' selected' : '';
        html += `<option value="${m.value}"${selected}>${m.label}</option>`;
      }
      html += '</optgroup>';

      html += '<optgroup label="Claude 预置模型 ID">';
      for (const modelId of dedupeClaudeModels(CLAUDE_MODEL_PRESETS)) {
        if (!markUsed(modelId)) continue;
        const selected = data.model === modelId ? ' selected' : '';
        html += `<option value="${escapeHtml(modelId)}"${selected}>${escapeHtml(modelId)}</option>`;
      }
      html += '</optgroup>';

      // Full model names from usage history
      const historyModels = dedupeClaudeModels(data.usedModels || []);
      if (historyModels.length) {
        html += '<optgroup label="历史使用模型">';
        for (const modelName of historyModels) {
          if (!markUsed(modelName)) continue;
          const selected = data.model === modelName ? ' selected' : '';
          html += `<option value="${escapeHtml(modelName)}"${selected}>${escapeHtml(modelName)}</option>`;
        }
        html += '</optgroup>';
      }

      modelSelect.innerHTML = html;
      if (data.model && ![...modelSelect.options].some((option) => normalizeClaudeModelKey(option.value) === normalizeClaudeModelKey(data.model))) {
        const customOption = document.createElement('option');
        customOption.value = data.model;
        customOption.textContent = `${data.model} (自定义)`;
        modelSelect.appendChild(customOption);
      }
      if (data.model) modelSelect.value = data.model;
    }

    const cache = _getToolFormCache('claudecode', true);

    // ── Show Base URL ──
    const ev = data.envVars || {};
    const baseUrlInput = el('baseUrlInput');
    if (baseUrlInput && !_shouldPreserveToolField('claudecode', 'baseUrl')) {
      const nextBaseUrl = activeClaudeProvider ? activeProviderBaseUrl : (ev.ANTHROPIC_BASE_URL?.set ? ev.ANTHROPIC_BASE_URL.value : '');
      baseUrlInput.value = nextBaseUrl;
      cache.baseUrl = nextBaseUrl;
    }
    const providerKeyInput = el('claudeProviderKeyInput');
    if (providerKeyInput && !_shouldPreserveToolField('claudecode', 'providerKey')) {
      const nextProviderKey = activeProviderKey
        || normalizeProviderKey(state.claudeSelectedProviderKey || inferClaudeProviderKey(baseUrlInput?.value || ''));
      providerKeyInput.value = nextProviderKey;
      cache.providerKey = nextProviderKey;
    }

    // ── Show API Key status ──
    const apiKeyInput = el('apiKeyInput');
    if (apiKeyInput) {
      let nextPlaceholder = 'ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN';
      if (activeClaudeProvider?.maskedAuthToken) {
        nextPlaceholder = `${activeClaudeProvider.maskedAuthToken} (Auth Token)`;
      } else if (activeClaudeProvider?.maskedApiKey) {
        nextPlaceholder = `${activeClaudeProvider.maskedApiKey} (API Key)`;
      } else if (data.maskedApiKey) {
        const srcLabel = { shell: 'Shell 环境变量', 'settings.json': 'settings.json', env: '进程环境变量' }[data.apiKeySource] || '';
        nextPlaceholder = `${data.maskedApiKey}${srcLabel ? ` (来自 ${srcLabel})` : ''}`;
      } else if (data.hasKeychainAuth) {
        nextPlaceholder = '已在 Keychain 检测到 API Key 凭据';
      }
      apiKeyInput.placeholder = nextPlaceholder;
      if (!_shouldPreserveToolField('claudecode', 'apiKey')) {
        apiKeyInput.value = '';
        cache.apiKey = '';
      }
    }

    renderCurrentConfig();
    renderToolConsole();
    return { ok: true, data };
    renderToolConsole();
    return { ok: true, data };
  } catch (error) {
    console.warn('[loadClaudeCodeQuickState] failed:', error);
    return { ok: false, error: error?.message || '读取失败' };
  }
}


async function ensureClaudeDashboardData({ force = false } = {}) {
  const result = await loadClaudeCodeQuickState({ force, cacheOnly: false });
  if (result?.ok) return result;
  if (!force) return loadClaudeCodeQuickState({ force: true, cacheOnly: false });
  return result;
}

function normalizeOpenCodeProviderKey(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'custom';
}

function openCodeProviderKeyFromModel(model = '') {
  const text = String(model || '').trim();
  return text.includes('/') ? text.split('/')[0] : '';
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

function getOpenCodeBuiltinProviderMeta(key = '') {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  return OPENCODE_BUILTIN_PROVIDER_CATALOG.find((item) => item.key === normalizeOpenCodeProviderKey(normalizedKey)) || null;
}

function getOpenCodeProviderHintKey({ providerKey = '', baseUrl = '' } = {}) {
  const rawKey = String(providerKey || '').trim();
  if (rawKey) return normalizeOpenCodeProviderKey(rawKey);
  const inferred = inferProviderKey(normalizeBaseUrl(baseUrl));
  return inferred ? normalizeOpenCodeProviderKey(inferred) : '';
}

function getOpenCodeProviderPackagePlaceholder(providerKey = '') {
  const builtin = getOpenCodeBuiltinProviderMeta(providerKey);
  if (!builtin) return '留空走默认 @ai-sdk/openai-compatible';
  if (builtin.recommendedPackage) return `内置推荐 ${builtin.recommendedPackage}`;
  return '内置 Provider，一般无需额外 npm 包';
}

function setOpenCodeProviderPackageField(inputId, { providerKey = '', npm = '' } = {}) {
  const input = el(inputId);
  if (!input) return;
  input.value = npm || '';
  input.placeholder = getOpenCodeProviderPackagePlaceholder(providerKey);
}

function buildOpenCodeProviderFromRuntimeMeta(runtime = {}) {
  const provider = {};
  if (runtime?.name && runtime.name !== runtime.key) provider.name = runtime.name;
  if (runtime?.npm) provider.npm = runtime.npm;
  if (runtime?.baseUrl) provider.options = { baseURL: runtime.baseUrl };
  const modelIds = normalizeOpenCodeProviderModelIds(runtime?.modelIds || []);
  if (modelIds.length) {
    provider.models = {};
    modelIds.forEach((modelId) => {
      provider.models[modelId] = {};
    });
  }
  return provider;
}

function getOpenCodeProviderEditorMap() {
  const configMap = cloneJson(getOpenCodeConfigEditorProviderMap() || {});
  const merged = cloneJson(configMap || {});
  (state.opencodeState?.providers || []).forEach((runtime) => {
    const providerKey = String(runtime?.key || '').trim();
    if (!providerKey) return;
    const runtimeProvider = buildOpenCodeProviderFromRuntimeMeta(runtime);
    const currentProvider = cloneJson(merged[providerKey] || {});
    const nextProvider = { ...runtimeProvider, ...currentProvider };
    const options = { ...(runtimeProvider.options || {}), ...(currentProvider.options || {}) };
    const models = { ...(runtimeProvider.models || {}), ...(currentProvider.models || {}) };
    if (isEmptyConfigValue(options)) delete nextProvider.options;
    else nextProvider.options = options;
    if (isEmptyConfigValue(models)) delete nextProvider.models;
    else nextProvider.models = models;
    merged[providerKey] = nextProvider;
  });
  return merged;
}

function getOpenCodeEditorProviderByKey(providerKey = '') {
  const key = String(providerKey || '').trim();
  if (!key) return null;
  const providerMap = getOpenCodeProviderEditorMap();
  return providerMap[key] ? cloneJson(providerMap[key]) : null;
}

function getOpenCodeConfiguredModels(data = {}) {
  const models = new Set();
  if (data.model) models.add(data.model);
  if (data.smallModel) models.add(data.smallModel);
  (data.providers || []).forEach((provider) => {
    (provider.modelIds || []).forEach((modelId) => models.add(`${provider.key}/${modelId}`));
  });
  return [...models].filter(Boolean).sort();
}

function renderOpenCodeModelOptions(selectId, { data = {}, currentModel = '' } = {}) {
  const select = el(selectId);
  if (!select) return;
  const models = getOpenCodeConfiguredModels(data);
  let html = '<option value="">选择默认模型</option>';
  html += models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
  if (currentModel && !models.includes(currentModel)) {
    html += `<option value="${escapeHtml(currentModel)}">${escapeHtml(currentModel)} (当前自定义)</option>`;
  }
  select.innerHTML = html;
  if (currentModel) select.value = currentModel;
}

function formatOpenCodeAuthExpiry(value = '') {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function renderOpenCodeCapabilitySummary(data = {}, { currentProviderKey = '' } = {}) {
  const loadOrderEl = el('opCfgLoadOrder');
  const builtinProvidersEl = el('opCfgBuiltinProviders');
  const authCapabilitiesEl = el('opCfgAuthCapabilities');
  const directoryCapabilitiesEl = el('opCfgDirectoryCapabilities');
  const metaEl = el('opCfgCapabilityMeta');
  const loadOrder = Array.isArray(data.loadOrder) && data.loadOrder.length ? data.loadOrder : [];
  const builtinProviders = Array.isArray(data.builtinProviders) && data.builtinProviders.length
    ? data.builtinProviders
    : OPENCODE_BUILTIN_PROVIDER_CATALOG;
  const authEntries = Array.isArray(data.authEntries) ? data.authEntries : [];
  const directoryFeatures = Array.isArray(data.directoryFeatures) ? data.directoryFeatures : [];
  const configuredKeys = new Set(Object.keys(getOpenCodeConfigEditorProviderMap() || {}).map((key) => normalizeOpenCodeProviderKey(key)));
  const runtimeKeys = new Set((data.providers || []).map((provider) => normalizeOpenCodeProviderKey(provider?.key || '')).filter(Boolean));
  const authKeys = new Set(authEntries.map((entry) => normalizeOpenCodeProviderKey(entry?.key || '')).filter(Boolean));
  const authTypes = new Set(authEntries.map((entry) => String(entry?.type || '').trim().toLowerCase()).filter(Boolean));
  const activeBuiltin = getOpenCodeBuiltinProviderMeta(currentProviderKey);

  if (loadOrderEl) {
    loadOrderEl.innerHTML = loadOrder.length
      ? loadOrder.map((item, index) => `<div class="feature-row"><span>${index + 1}</span><strong>${escapeHtml(item)}</strong></div>`).join('')
      : '<div class="inline-meta">暂无加载顺序信息</div>';
  }

  if (builtinProvidersEl) {
    builtinProvidersEl.innerHTML = builtinProviders.map((provider) => {
      const providerKey = normalizeOpenCodeProviderKey(provider?.key || '');
      const markers = [];
      if (configuredKeys.has(providerKey)) markers.push('已写入');
      else if (runtimeKeys.has(providerKey)) markers.push('已识别');
      if (authKeys.has(providerKey)) markers.push('auth');
      const label = markers.length ? `${providerKey} · ${markers.join(' · ')}` : providerKey;
      const tone = providerKey === currentProviderKey ? 'ok' : ((configuredKeys.has(providerKey) || runtimeKeys.has(providerKey) || authKeys.has(providerKey)) ? 'muted' : '');
      return `<span class="provider-pill ${tone}">${escapeHtml(label)}</span>`;
    }).join('');
  }

  if (authCapabilitiesEl) {
    const authCapabilityChips = [
      { label: 'oauth 登录', active: authTypes.has('oauth') },
      { label: 'api key', active: authTypes.has('api') },
      { label: '.well-known token', active: authTypes.has('wellknown') },
      ...authEntries.slice(0, 4).map((entry) => ({
        label: `${entry.key} · ${entry.type}`,
        active: Boolean(entry?.hasCredential),
      })),
    ];
    authCapabilitiesEl.innerHTML = authCapabilityChips.length
      ? authCapabilityChips.map((item) => `<span class="provider-pill ${item.active ? 'ok' : 'muted'}">${escapeHtml(item.label)}</span>`).join('')
      : '<span class="provider-pill muted">暂无 auth.json 记录</span>';
  }

  if (directoryCapabilitiesEl) {
    directoryCapabilitiesEl.innerHTML = directoryFeatures.length
      ? directoryFeatures.map((item) => `<span class="provider-pill muted">${escapeHtml(item)}</span>`).join('')
      : '<span class="provider-pill muted">暂无目录能力信息</span>';
  }

  if (metaEl) {
    metaEl.textContent = [
      `已识别 ${runtimeKeys.size} 个可用 Provider`,
      `auth.json ${authEntries.length} 条记录`,
      `当前默认 ${currentProviderKey || '未设置'}`,
      activeBuiltin?.recommendedPackage
        ? `留空可走内置推荐 ${activeBuiltin.recommendedPackage}`
        : (activeBuiltin ? '留空即可走内置 Provider' : '自定义网关可留空走默认 openai-compatible'),
    ].join('，');
  }
}

function getOpenCodeProviderByKey(key = '') {
  return (state.opencodeState?.providers || []).find((item) => item.key === key) || null;
}

function getOpenCodeSwitchModelValue(provider = {}) {
  const currentModel = String(el('modelSelect')?.value || state.opencodeState?.model || '').trim();
  const currentModelId = currentModel.includes('/') ? currentModel.split('/').slice(1).join('/') : currentModel;
  if (currentModelId && (provider.modelIds || []).includes(currentModelId)) return `${provider.key}/${currentModelId}`;
  if ((provider.modelIds || []).length) return `${provider.key}/${provider.modelIds[0]}`;
  return currentModelId ? `${provider.key}/${currentModelId}` : '';
}

function fillFromOpenCodeProvider(provider) {
  if (!provider?.key) return;
  const baseUrlInput = el('baseUrlInput');
  const apiKeyInput = el('apiKeyInput');
  const nextModel = getOpenCodeSwitchModelValue(provider);
  if (baseUrlInput) baseUrlInput.value = provider.baseUrl || '';
  if (apiKeyInput) {
    apiKeyInput.type = 'password';
    apiKeyInput.value = '';
    apiKeyInput.placeholder = provider.maskedApiKey || (provider.hasAuth ? `${provider.authType || 'Auth'} 已登录` : 'API Key（留空表示保持当前）');
  }
  renderOpenCodeModelOptions('modelSelect', { data: state.opencodeState || {}, currentModel: nextModel || state.opencodeState?.model || '' });
  if (nextModel && el('modelSelect')) el('modelSelect').value = nextModel;
  const detectionMeta = el('detectionMeta');
  if (detectionMeta) detectionMeta.textContent = `已载入 ${provider.name || provider.key}`;
}

async function quickSwitchOpenCodeProvider(provider) {
  if (!provider?.key) return { ok: false, error: 'Provider 无效' };
  fillFromOpenCodeProvider(provider);
  let config;
  try {
    config = buildOpenCodeConfigFromFields();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  setBusy('saveBtn', true, '切换中...');
  const json = await api('/api/opencode/config-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: el('scopeSelect')?.value || 'global',
      projectPath: el('projectPathInput')?.value?.trim() || '',
      configJson: JSON.stringify(config, null, 2),
    }),
  });
  setBusy('saveBtn', false);
  if (!json.ok) return json;
  await loadOpenCodeQuickState();
  renderCurrentConfig();
  return { ok: true, providerKey: provider.key };
}

function getOpenCodeProviderRuntimeMeta(key = '') {
  return (state.opencodeState?.providers || []).find((item) => item.key === key) || null;
}

function getOpenCodeEditorCurrentProviderKey() {
  return String(el('opCfgProviderKeyInput')?.value || '').trim()
    || openCodeProviderKeyFromModel(String(el('opCfgModelInput')?.value || '').trim())
    || state.opencodeState?.activeProviderKey
    || '';
}

function normalizeOpenCodeProviderModelIds(modelIds = []) {
  const seen = new Set();
  const normalized = [];
  (modelIds || []).forEach((item) => {
    const raw = String(item || '').trim();
    if (!raw) return;
    const value = raw.includes('/') ? raw.split('/').slice(1).join('/') : raw;
    if (!value || seen.has(value)) return;
    seen.add(value);
    normalized.push(value);
  });
  return normalized;
}

function getOpenCodeProviderDraftModelIds({ includeInput = true } = {}) {
  const inputModel = includeInput ? String(el('opProviderFormModelId')?.value || '').trim() : '';
  return normalizeOpenCodeProviderModelIds(inputModel ? [inputModel, ...(state.openCodeProviderDraftModels || [])] : (state.openCodeProviderDraftModels || []));
}

function openCodeProviderConnectivityLabel(providerKey = '', provider = null) {
  const health = state.openCodeProviderHealth[providerKey];
  if (health?.loading) return { tone: 'muted', text: '检测中' };
  if (health?.checked) return health.ok ? { tone: 'ok', text: '已通' } : { tone: 'bad', text: '失败' };
  const runtime = getOpenCodeProviderRuntimeMeta(providerKey);
  const target = provider || {};
  if (target.options?.apiKey || runtime?.maskedApiKey) return { tone: 'muted', text: '待检测' };
  if (runtime?.hasAuth) return { tone: 'ok', text: `${runtime.authType || 'Auth'} 就绪` };
  return { tone: 'warn', text: '缺少 Key' };
}

function renderOpenCodeProviderTestStatus(providerKey = '', provider = null) {
  const statusEl = el('opProviderTestStatus');
  if (!statusEl) return;
  const health = state.openCodeProviderHealth[providerKey];
  const runtime = getOpenCodeProviderRuntimeMeta(providerKey);
  if (health?.loading) {
    statusEl.textContent = '正在检测连通性与模型列表…';
    return;
  }
  if (health?.checked && health.ok) {
    const count = Array.isArray(health.models) ? health.models.length : 0;
    statusEl.textContent = count ? `连通成功 · 发现 ${count} 个模型` : '连通成功';
    return;
  }
  if (health?.checked && !health.ok) {
    statusEl.textContent = '最近一次检测失败，请检查 URL / Key / 网络。';
    return;
  }
  if (provider?.options?.apiKey || runtime?.maskedApiKey) {
    statusEl.textContent = '可直接做连通性检测，也可自动探测模型。';
    return;
  }
  if (runtime?.hasAuth) {
    statusEl.textContent = `${runtime.authType || 'Auth'} 已登录；如需通用 API 检测，可额外填写 API Key。`;
    return;
  }
  statusEl.textContent = '支持手动添加，也可自动探测。';
}

function renderOpenCodeProviderModelChips() {
  const chipsEl = el('opProviderModelsChips');
  const metaEl = el('opProviderModelMeta');
  if (!chipsEl) return;
  const models = getOpenCodeProviderDraftModelIds();
  chipsEl.innerHTML = models.map((model) => `
    <button type="button" class="chip op-provider-model-chip" data-op-provider-model="${escapeHtml(model)}">
      <span>${escapeHtml(model)}</span>
      <span class="op-provider-model-remove" data-op-provider-model-remove="${escapeHtml(model)}">×</span>
    </button>
  `).join('');
  chipsEl.classList.toggle('hide', models.length === 0);
  if (metaEl) metaEl.textContent = models.length ? `已维护 ${models.length} 个模型` : '未添加模型';
}

function setOpenCodeProviderDraftModelIds(modelIds = [], { syncInput = true } = {}) {
  state.openCodeProviderDraftModels = normalizeOpenCodeProviderModelIds(modelIds);
  if (syncInput && el('opProviderFormModelId')) {
    el('opProviderFormModelId').value = state.openCodeProviderDraftModels[0] || '';
  }
  renderOpenCodeProviderModelChips();
}

function buildOpenCodeProviderFromFormPreview() {
  const form = readOpenCodeProviderEditorForm();
  if (!form) return { providerKey: '', provider: null };
  const providerMap = getOpenCodeProviderEditorMap();
  const baseProvider = cloneJson(
    providerMap[form.providerKey]
    || ((form.originalKey && form.originalKey !== '__new__') ? providerMap[form.originalKey] : null)
    || {}
  );
  const provider = baseProvider;
  if (form.name) provider.name = form.name;
  else delete provider.name;
  if (form.providerPackage) provider.npm = form.providerPackage;
  else delete provider.npm;
  if (form.whitelist.length) provider.whitelist = form.whitelist;
  else delete provider.whitelist;
  if (form.blacklist.length) provider.blacklist = form.blacklist;
  else delete provider.blacklist;
  provider.options = { ...(provider.options || {}) };
  if (form.baseUrl) provider.options.baseURL = form.baseUrl;
  else delete provider.options.baseURL;
  if (form.apiKey) provider.options.apiKey = form.apiKey;
  if (form.enterpriseUrl) provider.options.enterpriseUrl = form.enterpriseUrl;
  else delete provider.options.enterpriseUrl;
  if (form.setCacheKey !== undefined) provider.options.setCacheKey = form.setCacheKey;
  else delete provider.options.setCacheKey;
  if (form.timeout !== undefined) provider.options.timeout = form.timeout;
  else delete provider.options.timeout;
  if (form.chunkTimeout !== undefined) provider.options.chunkTimeout = form.chunkTimeout;
  else delete provider.options.chunkTimeout;
  if (isEmptyConfigValue(provider.options)) delete provider.options;
  if (form.modelIds.length) {
    const previousModels = cloneJson(provider.models || {});
    provider.models = {};
    form.modelIds.forEach((modelId) => {
      provider.models[modelId] = previousModels[modelId] || {};
    });
  } else {
    delete provider.models;
  }
  return { providerKey: form.providerKey, provider };
}

async function testOpenCodeProviderConnectivity(providerInput = null, { providerKey = '', delayMs = 420, refreshModels = false } = {}) {
  const preview = providerInput ? { providerKey, provider: cloneJson(providerInput || {}) } : buildOpenCodeProviderFromFormPreview();
  const key = preview.providerKey || providerKey || '';
  const provider = cloneJson(preview.provider || {});
  const runtime = key ? getOpenCodeProviderRuntimeMeta(key) : null;
  const baseUrl = normalizeBaseUrl(provider.options?.baseURL || runtime?.baseUrl || '');
  const apiKey = String(provider.options?.apiKey || '').trim();
  const shouldRenderManager = Boolean(providerInput);

  if (!baseUrl) return { ok: false, error: '请先填写 Base URL' };
  if (!apiKey) {
    if (runtime?.hasAuth) return { ok: false, error: '当前 Provider 仅有 OpenCode 登录态，无法直接做通用 API Key 检测' };
    return { ok: false, error: '请先填写 API Key' };
  }

  if (key) state.openCodeProviderHealth[key] = { loading: true, checked: false, startedAt: Date.now() };
  if (shouldRenderManager) renderOpenCodeProviderManager(getOpenCodeEditorCurrentProviderKey());
  else renderOpenCodeProviderTestStatus(key, provider);

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const json = await api('/api/provider/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl,
      apiKey,
      timeoutMs: 10000,
    }),
    timeoutMs: 12000,
  });

  const models = normalizeOpenCodeProviderModelIds(json?.data?.models || []);
  if (key) state.openCodeProviderHealth[key] = {
    loading: false,
    checked: true,
    ok: Boolean(json?.ok),
    models,
    recommendedModel: pickRecommendedModel(models, models[0] || ''),
  };

  if (json?.ok && refreshModels && models.length) {
    setOpenCodeProviderDraftModelIds(models);
    if (el('opProviderFormModelId')) {
      el('opProviderFormModelId').value = pickRecommendedModel(models, models[0] || '');
    }
  }

  if (shouldRenderManager) renderOpenCodeProviderManager(getOpenCodeEditorCurrentProviderKey());
  else renderOpenCodeProviderTestStatus(key, provider);
  if (!json?.ok) return { ok: false, error: json?.error || '连通性检测失败' };
  return { ok: true, data: json.data };
}

function getOpenCodeConfigEditorProviderMap() {
  const fallback = cloneJson(state.opencodeState?.config?.provider || {});
  const raw = String(el('opCfgProviderJson')?.value || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return cloneJson(parsed);
  } catch {
    return fallback;
  }
}

function writeOpenCodeConfigEditorProviderMap(providerMap = {}) {
  writeJsonFragmentInput('opCfgProviderJson', providerMap || {});
}

function populateOpenCodeProviderEditorForm(provider = null, providerKey = '') {
  const target = cloneJson(provider || {});
  const key = providerKey || '';
  const runtime = key ? getOpenCodeProviderRuntimeMeta(key) : null;
  const modelIds = normalizeOpenCodeProviderModelIds([
    ...Object.keys(target.models || {}),
    ...(runtime?.modelIds || []),
  ]);
  const setValue = (id, value = '') => {
    const input = el(id);
    if (!input) return;
    input.value = value === null || value === undefined ? '' : String(value);
  };
  setValue('opProviderFormKey', key);
  setValue('opProviderFormName', target.name || '');
  setValue('opProviderFormBaseUrl', target.options?.baseURL || runtime?.baseUrl || '');
  setValue('opProviderFormModelId', modelIds[0] || '');
  setOpenCodeProviderPackageField('opProviderFormPackage', { providerKey: key, npm: target.npm || '' });
  setValue('opProviderFormWhitelist', Array.isArray(target.whitelist) ? target.whitelist.join(', ') : '');
  setValue('opProviderFormBlacklist', Array.isArray(target.blacklist) ? target.blacklist.join(', ') : '');
  setValue('opProviderFormEnterpriseUrl', target.options?.enterpriseUrl || '');
  setValue('opProviderFormSetCacheKey', typeof target.options?.setCacheKey === 'boolean' ? String(target.options.setCacheKey) : '');
  setValue('opProviderFormTimeout', target.options?.timeout === false ? 'false' : (target.options?.timeout || ''));
  setValue('opProviderFormChunkTimeout', target.options?.chunkTimeout || '');
  const apiKeyInput = el('opProviderFormApiKey');
  if (apiKeyInput) {
    apiKeyInput.value = '';
    apiKeyInput.placeholder = runtime?.maskedApiKey ? `${runtime.maskedApiKey} (留空保持当前)` : '留空表示保持当前';
  }
  setOpenCodeProviderDraftModelIds(modelIds, { syncInput: true });
  renderOpenCodeProviderTestStatus(key, target);
}

function readOpenCodeProviderEditorForm() {
  const getValue = (id) => String(el(id)?.value || '').trim();
  const parseCsv = (id) => {
    const raw = getValue(id);
    return raw ? raw.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) : [];
  };
  const originalKey = state.openCodeProviderDetailKey || '';
  const baseUrl = normalizeBaseUrl(getValue('opProviderFormBaseUrl'));
  const keyInput = getValue('opProviderFormKey');
  const name = getValue('opProviderFormName');
  const modelRaw = getValue('opProviderFormModelId');
  const providerKey = normalizeOpenCodeProviderKey(keyInput || (originalKey && originalKey !== '__new__' ? originalKey : '') || inferProviderKey(baseUrl) || '');
  const modelId = modelRaw.includes('/') ? modelRaw.split('/').slice(1).join('/') : modelRaw;
  const modelIds = normalizeOpenCodeProviderModelIds(modelId ? [modelId, ...getOpenCodeProviderDraftModelIds({ includeInput: false })] : getOpenCodeProviderDraftModelIds({ includeInput: false }));
  const providerPackage = getValue('opProviderFormPackage');
  const apiKey = getValue('opProviderFormApiKey');
  const whitelist = parseCsv('opProviderFormWhitelist');
  const blacklist = parseCsv('opProviderFormBlacklist');
  const enterpriseUrl = getValue('opProviderFormEnterpriseUrl');
  const setCacheKeyRaw = getValue('opProviderFormSetCacheKey');
  const timeoutRaw = getValue('opProviderFormTimeout');
  const chunkTimeoutRaw = getValue('opProviderFormChunkTimeout');
  const hasAny = [keyInput, name, baseUrl, modelRaw, providerPackage, apiKey, enterpriseUrl, timeoutRaw, chunkTimeoutRaw].some(Boolean) || whitelist.length || blacklist.length;
  if (!hasAny) return null;
  if (!providerKey) throw new Error('请先填写 Provider Key，或填写 Base URL 让系统自动推断');

  let timeout;
  if (timeoutRaw) {
    if (timeoutRaw === 'false') timeout = false;
    else {
      const parsed = Number(timeoutRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('Provider 请求超时必须是正整数，或 false');
      timeout = parsed;
    }
  }

  let chunkTimeout;
  if (chunkTimeoutRaw) {
    const parsed = Number(chunkTimeoutRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('流式分块超时必须是正整数');
    chunkTimeout = parsed;
  }

  let setCacheKey;
  if (setCacheKeyRaw === 'true') setCacheKey = true;
  if (setCacheKeyRaw === 'false') setCacheKey = false;

  return {
    originalKey,
    providerKey,
    name,
    baseUrl,
    modelId: modelId.trim(),
    modelIds,
    providerPackage,
    apiKey,
    whitelist,
    blacklist,
    enterpriseUrl,
    setCacheKey,
    timeout,
    chunkTimeout,
  };
}

function mergeOpenCodeProviderFormIntoMap(providerMap = {}) {
  const detailPanel = el('opProviderDetailPanel');
  if (!detailPanel || detailPanel.classList.contains('hide')) return cloneJson(providerMap || {});
  const form = readOpenCodeProviderEditorForm();
  if (!form) return cloneJson(providerMap || {});
  const nextMap = cloneJson(providerMap || {});
  const existingProvider = cloneJson(nextMap[form.providerKey] || (form.originalKey && form.originalKey !== '__new__' ? nextMap[form.originalKey] : {}) || {});
  if (form.originalKey && form.originalKey !== '__new__' && form.originalKey !== form.providerKey) {
    delete nextMap[form.originalKey];
  }
  if (form.name) existingProvider.name = form.name;
  else delete existingProvider.name;
  if (form.providerPackage) existingProvider.npm = form.providerPackage;
  else delete existingProvider.npm;
  if (form.whitelist.length) existingProvider.whitelist = form.whitelist;
  else delete existingProvider.whitelist;
  if (form.blacklist.length) existingProvider.blacklist = form.blacklist;
  else delete existingProvider.blacklist;
  existingProvider.options = { ...(existingProvider.options || {}) };
  if (form.baseUrl) existingProvider.options.baseURL = form.baseUrl;
  else delete existingProvider.options.baseURL;
  if (form.apiKey) existingProvider.options.apiKey = form.apiKey;
  if (form.enterpriseUrl) existingProvider.options.enterpriseUrl = form.enterpriseUrl;
  else delete existingProvider.options.enterpriseUrl;
  if (form.setCacheKey !== undefined) existingProvider.options.setCacheKey = form.setCacheKey;
  else delete existingProvider.options.setCacheKey;
  if (form.timeout !== undefined) existingProvider.options.timeout = form.timeout;
  else delete existingProvider.options.timeout;
  if (form.chunkTimeout !== undefined) existingProvider.options.chunkTimeout = form.chunkTimeout;
  else delete existingProvider.options.chunkTimeout;
  if (isEmptyConfigValue(existingProvider.options)) delete existingProvider.options;
  if (form.modelIds.length) {
    const previousModels = cloneJson(existingProvider.models || {});
    existingProvider.models = {};
    form.modelIds.forEach((modelId) => {
      existingProvider.models[modelId] = previousModels[modelId] || {};
    });
  } else {
    delete existingProvider.models;
  }
  if (isEmptyConfigValue(existingProvider.models)) delete existingProvider.models;
  nextMap[form.providerKey] = existingProvider;
  state.openCodeProviderDetailKey = form.providerKey;
  return nextMap;
}

function applyOpenCodeProviderToMainEditor(providerKey, provider = null, { setDefault = false, includeApiKey = true } = {}) {
  const target = cloneJson(provider || {});
  const modelId = Object.keys(target.models || {})[0] || '';
  if (el('opCfgProviderKeyInput')) el('opCfgProviderKeyInput').value = providerKey || '';
  if (el('opCfgProviderNameInput')) el('opCfgProviderNameInput').value = target.name || '';
  if (el('opCfgBaseUrlInput')) el('opCfgBaseUrlInput').value = target.options?.baseURL || '';
  setOpenCodeProviderPackageField('opCfgProviderPackageInput', { providerKey, npm: target.npm || '' });
  if (includeApiKey && target.options?.apiKey && el('opCfgApiKeyInput')) el('opCfgApiKeyInput').value = target.options.apiKey;
  if (el('opCfgProviderWhitelistInput')) el('opCfgProviderWhitelistInput').value = Array.isArray(target.whitelist) ? target.whitelist.join(', ') : '';
  if (el('opCfgProviderBlacklistInput')) el('opCfgProviderBlacklistInput').value = Array.isArray(target.blacklist) ? target.blacklist.join(', ') : '';
  if (el('opCfgProviderEnterpriseUrlInput')) el('opCfgProviderEnterpriseUrlInput').value = target.options?.enterpriseUrl || '';
  if (el('opCfgProviderSetCacheKeySelect')) el('opCfgProviderSetCacheKeySelect').value = typeof target.options?.setCacheKey === 'boolean' ? String(target.options.setCacheKey) : '';
  if (el('opCfgProviderTimeoutInput')) el('opCfgProviderTimeoutInput').value = target.options?.timeout === false ? 'false' : String(target.options?.timeout || '');
  if (el('opCfgProviderChunkTimeoutInput')) el('opCfgProviderChunkTimeoutInput').value = String(target.options?.chunkTimeout || '');
  if (setDefault && modelId && el('opCfgModelInput')) el('opCfgModelInput').value = `${providerKey}/${modelId}`;
}

function saveOpenCodeProviderFormToEditor({ setDefault = false, applyToMain = false } = {}) {
  const nextMap = mergeOpenCodeProviderFormIntoMap(getOpenCodeConfigEditorProviderMap());
  const providerKey = state.openCodeProviderDetailKey || '';
  const provider = providerKey ? cloneJson(nextMap[providerKey] || {}) : null;
  writeOpenCodeConfigEditorProviderMap(nextMap);
  if (providerKey && provider) {
    populateOpenCodeProviderEditorForm(provider, providerKey);
    if (applyToMain || setDefault) applyOpenCodeProviderToMainEditor(providerKey, provider, { setDefault });
  }
  return { providerKey, provider };
}

function deleteOpenCodeProviderFromEditor() {
  const providerKey = state.openCodeProviderDetailKey || '';
  if (!providerKey || providerKey === '__new__') {
    state.openCodeProviderDetailKey = '';
    return { ok: true, removed: false };
  }
  const providerMap = getOpenCodeConfigEditorProviderMap();
  if (!Object.prototype.hasOwnProperty.call(providerMap, providerKey)) {
    state.openCodeProviderDetailKey = '';
    state.openCodeProviderDraftModels = [];
    return { ok: true, removed: false, providerKey };
  }
  delete providerMap[providerKey];
  writeOpenCodeConfigEditorProviderMap(providerMap);
  if ((el('opCfgProviderKeyInput')?.value || '').trim() === providerKey) {
    if (el('opCfgProviderKeyInput')) el('opCfgProviderKeyInput').value = '';
    if (el('opCfgProviderNameInput')) el('opCfgProviderNameInput').value = '';
    if (el('opCfgBaseUrlInput')) el('opCfgBaseUrlInput').value = '';
    setOpenCodeProviderPackageField('opCfgProviderPackageInput', { providerKey: '', npm: '' });
  }
  delete state.openCodeProviderHealth[providerKey];
  state.openCodeProviderDraftModels = [];
  state.openCodeProviderDetailKey = '';
  return { ok: true, removed: true, providerKey };
}

function renderOpenCodeProviderManager(currentProviderKey = '') {
  const providerMap = getOpenCodeProviderEditorMap();
  const configuredProviderCount = Object.keys(getOpenCodeConfigEditorProviderMap() || {}).length;
  const providers = Object.entries(providerMap)
    .map(([key, value]) => ({ key, ...(cloneJson(value || {})) }))
    .sort((left, right) => {
      if (left.key === currentProviderKey) return -1;
      if (right.key === currentProviderKey) return 1;
      return left.key.localeCompare(right.key);
    });
  if (state.openCodeProviderDetailKey && state.openCodeProviderDetailKey !== '__new__' && !providers.some((provider) => provider.key === state.openCodeProviderDetailKey)) {
    state.openCodeProviderDetailKey = '';
  }
  const query = normalizeStoreText(state.openCodeProviderSearch || '');
  const visibleProviders = query
    ? providers.filter((provider) => {
      const runtime = getOpenCodeProviderRuntimeMeta(provider.key);
      const haystack = normalizeStoreText([
        provider.key,
        provider.name,
        provider.options?.baseURL,
        runtime?.baseUrl,
        ...Object.keys(provider.models || {}),
        ...(runtime?.modelIds || []),
      ].filter(Boolean).join(' '));
      return haystack.includes(query);
    })
    : providers;
  const providerList = el('opCfgProviderList');
  const providerMeta = el('opProviderListMeta');
  if (providerMeta) {
    providerMeta.textContent = query
      ? `搜索结果 ${visibleProviders.length} / ${providers.length}`
      : (providers.length ? `共 ${providers.length} 个 Provider，其中 ${configuredProviderCount} 个已写入配置` : '支持多 Provider 列表管理，可切默认模型');
  }
  if (providerList) {
    providerList.innerHTML = visibleProviders.length ? visibleProviders.map((provider) => {
      const runtime = getOpenCodeProviderRuntimeMeta(provider.key);
      const isActive = provider.key === currentProviderKey;
      const isOpen = provider.key === state.openCodeProviderDetailKey;
      const modelIds = normalizeOpenCodeProviderModelIds([...Object.keys(provider.models || {}), ...(runtime?.modelIds || [])]);
      const authText = runtime?.maskedApiKey ? runtime.maskedApiKey : runtime?.hasAuth ? `${runtime.authType || 'Auth'} 已登录` : (provider.options?.apiKey ? '已填 Key' : '未配 Key');
      const authTone = runtime?.maskedApiKey || runtime?.hasAuth || provider.options?.apiKey ? 'ok' : 'warn';
      const netBadge = openCodeProviderConnectivityLabel(provider.key, provider);
      return `
        <div class="provider-card cc-provider-row ${isActive ? 'active' : ''}" data-op-open-provider="${escapeHtml(provider.key)}">
          <div class="provider-main">
            <strong>${escapeHtml(provider.name || provider.key)}</strong>
            <div class="provider-meta">${escapeHtml(provider.key)} · ${escapeHtml(provider.options?.baseURL || runtime?.baseUrl || '默认')} · ${escapeHtml(`${modelIds.length} models`)}</div>
          </div>
          <div class="cc-provider-inline-actions">
            <span class="provider-pill ${authTone}">${escapeHtml(authText)}</span>
            <span class="provider-pill ${netBadge.tone}">${escapeHtml(netBadge.text)}</span>
            <button type="button" class="secondary tiny-btn" data-op-provider-action="check" data-op-provider-key="${escapeHtml(provider.key)}">检测</button>
            <button type="button" class="secondary tiny-btn" data-op-provider-action="apply" data-op-provider-key="${escapeHtml(provider.key)}">载入</button>
            <button type="button" class="secondary tiny-btn" data-op-provider-action="default" data-op-provider-key="${escapeHtml(provider.key)}">默认</button>
            <span class="provider-option-model">${escapeHtml(isOpen ? '已展开' : (isActive ? '当前' : '详情'))}</span>
          </div>
        </div>
      `;
    }).join('') : `<div class="provider-meta">${escapeHtml(query ? '没有匹配的 Provider' : '暂无 Provider')}</div>`;
  }
  const detailProvider = state.openCodeProviderDetailKey === '__new__'
    ? {}
    : cloneJson(providerMap[state.openCodeProviderDetailKey] || {});
  const hasDetail = state.openCodeProviderDetailKey === '__new__' || Boolean(state.openCodeProviderDetailKey && providerMap[state.openCodeProviderDetailKey]);
  const detailPanel = el('opProviderDetailPanel');
  const detailTitle = el('opProviderDetailTitle');
  if (detailPanel) detailPanel.classList.toggle('hide', !hasDetail);
  if (detailTitle) detailTitle.textContent = hasDetail
    ? `Provider 详情 · ${state.openCodeProviderDetailKey === '__new__' ? '新建 Provider' : (detailProvider.name || state.openCodeProviderDetailKey)}`
    : 'Provider 详情';
  if (hasDetail) {
    populateOpenCodeProviderEditorForm(detailProvider, state.openCodeProviderDetailKey === '__new__' ? '' : state.openCodeProviderDetailKey);
  } else {
    state.openCodeProviderDraftModels = [];
    renderOpenCodeProviderModelChips();
    renderOpenCodeProviderTestStatus('', null);
  }
}

function populateOpenCodeConfigEditor() {
  const data = state.opencodeState || {};
  const config = cloneJson(data.config || {});
  const active = data.activeProvider || {};
  const currentProviderKey = data.activeProviderKey || openCodeProviderKeyFromModel(config.model || '') || '';
  const currentProviderConfig = cloneJson(config.provider?.[currentProviderKey] || {});
  const apiInput = el('opCfgApiKeyInput');
  const setValue = (id, value = '') => {
    const input = el(id);
    if (!input) return;
    input.value = value === null || value === undefined ? '' : String(value);
  };
  const setCsv = (id, value) => {
    setValue(id, Array.isArray(value) ? value.join(', ') : '');
  };
  const setBoolSelect = (id, value) => {
    setValue(id, typeof value === 'boolean' ? String(value) : '');
  };
  const setAutoUpdate = (id, value) => {
    if (value === true || value === false || value === 'notify') {
      setValue(id, String(value));
      return;
    }
    setValue(id, '');
  };
  const setPermissionAction = (id, value) => {
    setValue(id, typeof value === 'string' ? value : '');
  };

  el('opCfgModelInput').value = data.model || config.model || '';
  el('opCfgSmallModelInput').value = data.smallModel || config.small_model || '';
  el('opCfgProviderKeyInput').value = currentProviderKey;
  el('opCfgProviderNameInput').value = active.name || currentProviderConfig.name || '';
  el('opCfgBaseUrlInput').value = active.baseUrl || currentProviderConfig.options?.baseURL || '';
  if (apiInput) {
    apiInput.value = '';
    apiInput.placeholder = active.maskedApiKey || '留空表示保持当前';
  }
  setOpenCodeProviderPackageField('opCfgProviderPackageInput', {
    providerKey: currentProviderKey,
    npm: active.npm || currentProviderConfig.npm || '',
  });
  el('opCfgConfigPath').value = data.configPath || '~/.config/opencode/opencode.json';
  el('opCfgAuthPath').value = data.authPath || '~/.local/share/opencode/auth.json';
  el('opCfgProvidersSummary').value = (data.providers || []).map((provider) => {
    const markers = [];
    if (provider.builtin) markers.push('内置');
    if (provider.configured) markers.push('已写入');
    if (provider.hasAuth) markers.push(provider.authType || 'auth');
    else if (provider.hasApiKey) markers.push('apiKey');
    return `${provider.key} · ${provider.baseUrl || '默认'} · ${(provider.modelIds || []).length} models${markers.length ? ` · ${markers.join(' · ')}` : ''}`;
  }).join('\n') || '暂无';
  if (el('opProviderSearchInput')) el('opProviderSearchInput').value = state.openCodeProviderSearch || '';

  setCsv('opCfgProviderWhitelistInput', currentProviderConfig.whitelist);
  setCsv('opCfgProviderBlacklistInput', currentProviderConfig.blacklist);
  setValue('opCfgProviderEnterpriseUrlInput', currentProviderConfig.options?.enterpriseUrl || '');
  setBoolSelect('opCfgProviderSetCacheKeySelect', currentProviderConfig.options?.setCacheKey);
  setValue('opCfgProviderTimeoutInput', currentProviderConfig.options?.timeout === false ? 'false' : (currentProviderConfig.options?.timeout || ''));
  setValue('opCfgProviderChunkTimeoutInput', currentProviderConfig.options?.chunkTimeout || '');

  const agentConfig = cloneJson(config.agent || config.mode || {});
  setValue('opCfgAgentBuildModelInput', agentConfig.build?.model || '');
  setValue('opCfgAgentBuildStepsInput', agentConfig.build?.steps || '');
  setValue('opCfgAgentBuildTemperatureInput', agentConfig.build?.temperature || '');
  setValue('opCfgAgentPlanModelInput', agentConfig.plan?.model || '');
  setValue('opCfgAgentPlanStepsInput', agentConfig.plan?.steps || '');
  setValue('opCfgAgentPlanTemperatureInput', agentConfig.plan?.temperature || '');
  setValue('opCfgAgentGeneralModelInput', agentConfig.general?.model || '');
  setValue('opCfgAgentGeneralStepsInput', agentConfig.general?.steps || '');
  setValue('opCfgAgentGeneralTemperatureInput', agentConfig.general?.temperature || '');
  setValue('opCfgAgentExploreModelInput', agentConfig.explore?.model || '');
  setValue('opCfgAgentExploreStepsInput', agentConfig.explore?.steps || '');
  setValue('opCfgAgentTitleModelInput', agentConfig.title?.model || '');
  setValue('opCfgAgentSummaryModelInput', agentConfig.summary?.model || '');
  setValue('opCfgAgentCompactionModelInput', agentConfig.compaction?.model || '');
  setValue('opCfgAgentCompactionStepsInput', agentConfig.compaction?.steps || '');

  const permissionConfig = config.permission;
  const permissionMap = typeof permissionConfig === 'string' ? { '*': permissionConfig } : (permissionConfig && typeof permissionConfig === 'object' ? permissionConfig : {});
  setPermissionAction('opCfgPermissionDefaultSelect', permissionMap['*']);
  setPermissionAction('opCfgPermissionReadSelect', permissionMap.read);
  setPermissionAction('opCfgPermissionEditSelect', permissionMap.edit);
  setPermissionAction('opCfgPermissionBashSelect', permissionMap.bash);
  setPermissionAction('opCfgPermissionTaskSelect', permissionMap.task);
  setPermissionAction('opCfgPermissionGlobSelect', permissionMap.glob);
  setPermissionAction('opCfgPermissionGrepSelect', permissionMap.grep);
  setPermissionAction('opCfgPermissionListSelect', permissionMap.list);
  setPermissionAction('opCfgPermissionWebFetchSelect', permissionMap.webfetch);
  setPermissionAction('opCfgPermissionWebSearchSelect', permissionMap.websearch);
  setPermissionAction('opCfgPermissionCodeSearchSelect', permissionMap.codesearch);
  setPermissionAction('opCfgPermissionSkillSelect', permissionMap.skill);
  setPermissionAction('opCfgPermissionLspSelect', permissionMap.lsp);
  setPermissionAction('opCfgPermissionExternalDirectorySelect', permissionMap.external_directory);
  setPermissionAction('opCfgPermissionTodoReadSelect', permissionMap.todoread);
  setPermissionAction('opCfgPermissionTodoWriteSelect', permissionMap.todowrite);
  setPermissionAction('opCfgPermissionDoomLoopSelect', permissionMap.doom_loop);
  setPermissionAction('opCfgPermissionQuestionSelect', permissionMap.question);

  setValue('opCfgLogLevel', config.logLevel || '');
  setValue('opCfgUsernameInput', config.username || '');
  setValue('opCfgDefaultAgentInput', config.default_agent || '');
  setValue('opCfgShareSelect', ['manual', 'auto', 'disabled'].includes(config.share) ? config.share : '');
  setAutoUpdate('opCfgAutoUpdateSelect', config.autoupdate);
  setBoolSelect('opCfgSnapshotSelect', config.snapshot);
  setCsv('opCfgDisabledProvidersInput', config.disabled_providers);
  setCsv('opCfgEnabledProvidersInput', config.enabled_providers);
  setCsv('opCfgInstructionsInput', config.instructions);
  setCsv('opCfgPluginListInput', config.plugin);

  setValue('opCfgServerPortInput', config.server?.port || '');
  setValue('opCfgServerHostnameInput', config.server?.hostname || '');
  setBoolSelect('opCfgServerMdnsSelect', config.server?.mdns);
  setValue('opCfgServerMdnsDomainInput', config.server?.mdnsDomain || '');
  setCsv('opCfgServerCorsInput', config.server?.cors);
  setValue('opCfgEnterpriseUrlInput', config.enterprise?.url || '');
  setCsv('opCfgSkillsPathsInput', config.skills?.paths);
  setCsv('opCfgSkillsUrlsInput', config.skills?.urls);
  setCsv('opCfgWatcherIgnoreInput', config.watcher?.ignore);

  setBoolSelect('opCfgCompactionAutoSelect', config.compaction?.auto);
  setBoolSelect('opCfgCompactionPruneSelect', config.compaction?.prune);
  setValue('opCfgCompactionReservedInput', config.compaction?.reserved || '');
  setBoolSelect('opCfgExperimentalBatchToolSelect', config.experimental?.batch_tool);
  setBoolSelect('opCfgExperimentalOpenTelemetrySelect', config.experimental?.openTelemetry);
  setBoolSelect('opCfgExperimentalContinueOnDenySelect', config.experimental?.continue_loop_on_deny);
  setBoolSelect('opCfgExperimentalDisablePasteSummarySelect', config.experimental?.disable_paste_summary);
  setValue('opCfgExperimentalMcpTimeoutInput', config.experimental?.mcp_timeout || '');
  setCsv('opCfgExperimentalPrimaryToolsInput', config.experimental?.primary_tools);

  writeJsonFragmentInput('opCfgProviderJson', config.provider || {});
  writeJsonFragmentInput('opCfgAgentJson', config.agent || config.mode || {});
  writeJsonFragmentInput('opCfgPermissionJson', config.permission);
  writeJsonFragmentInput('opCfgCommandJson', config.command || {});
  writeJsonFragmentInput('opCfgMcpJson', config.mcp || {});
  writeJsonFragmentInput('opCfgFormatterJson', config.formatter);
  writeJsonFragmentInput('opCfgLspJson', config.lsp);
  renderOpenCodeCapabilitySummary(data, { currentProviderKey });
  renderOpenCodeProviderManager(currentProviderKey);

  el('opCfgRawJsonTextarea').value = data.configJson || JSON.stringify(config, null, 2);
  syncRawConfigHighlight();
}

function getToolBinaryStatus(toolId = '', runtimeBinary = null) {
  const detectedBinary = state.tools.find((tool) => tool.id === toolId)?.binary || null;
  const runtime = runtimeBinary && typeof runtimeBinary === 'object' ? runtimeBinary : null;
  if (runtime?.installed) return { ...(detectedBinary || {}), ...runtime };
  if (detectedBinary?.installed) return { ...(runtime || {}), ...detectedBinary };
  return runtime || detectedBinary || { installed: false };
}

function isCodexInstalled() {
  return Boolean(getToolBinaryStatus('codex', state.current?.codexBinary).installed);
}

function isClaudeCodeInstalled(data = state.claudeCodeState || {}) {
  return Boolean(data.binary?.installed || state.tools.find((tool) => tool.id === 'claudecode')?.binary?.installed);
}

function isOpenCodeInstalled(data = state.opencodeState || {}) {
  return Boolean(data.binary?.installed || state.tools.find((tool) => tool.id === 'opencode')?.binary?.installed);
}

function isOpenClawInstalled(data = state.openclawState || {}) {
  return Boolean(data.binary?.installed || state.tools.find((tool) => tool.id === 'openclaw')?.binary?.installed);
}


function applyQuickInstallState({
  toolId,
  installed,
  installLabel,
  sectionTitleText,
  detectionMetaText,
  showBaseUrl = true,
  showApiKey = true,
  showDetect = true,
  showModel = true,
  showProtocol = false,
  showSyncActions = false,
  showOauthBtn = false,
  showProviderKey = false,
  showSaveBtn = true,
  showEditBtn = true,
  showProviderSwitch = true,
  showConfigEditorBtn = true,
  showModelRefreshBtn = false,
  showCodexAuthBlock = false,
} = {}) {
  if (state.activeTool !== toolId) return;
  const baseUrlField = el('baseUrlInput')?.closest('.field');
  const apiKeyField = el('apiKeyInput')?.closest('.field');
  const detectField = el('detectBtn')?.closest('.field');
  const modelField = el('modelSelect')?.closest('.field');
  const protocolField = el('openClawProtocolField');
  const saveBtn = el('saveBtn');
  const editBtn = el('editConfigQuickBtn');
  const launchBtn = el('launchBtn');
  const detectionMeta = el('detectionMeta');
  const sectionTitle = document.querySelector('.flow-section .section-title');
  const providerSwitchBtn = el('providerSwitchBtn');
  const configEditorBtn = el('configEditorBtn');
  const modelRefreshBtn = el('modelRefreshBtn');
  const modelChips = el('modelChips');
  const syncActions = el('sectionSyncActions');
  const claudeOauthLoginBtn = el('claudeOauthLoginBtn');
  const claudeProviderKeyField = el('claudeProviderKeyField');
  const codexAuthBlock = el('codexAuthBlock');

  if (!installed) {
    if (baseUrlField) baseUrlField.style.display = 'none';
    if (apiKeyField) apiKeyField.style.display = 'none';
    if (detectField) detectField.style.display = 'none';
    if (modelField) modelField.style.display = 'none';
    if (protocolField) protocolField.classList.add('hide');
    if (saveBtn) saveBtn.style.display = 'none';
    if (editBtn) editBtn.style.display = 'none';
    if (launchBtn) launchBtn.textContent = installLabel;
    if (detectionMeta) detectionMeta.textContent = detectionMetaText;
    if (sectionTitle) sectionTitle.textContent = sectionTitleText;
    if (providerSwitchBtn) providerSwitchBtn.style.display = 'none';
    if (configEditorBtn) configEditorBtn.style.display = 'none';
    if (modelRefreshBtn) modelRefreshBtn.classList.remove('visible');
    if (modelChips) modelChips.classList.add('hide');
    if (syncActions) syncActions.style.display = 'none';
    if (claudeOauthLoginBtn) claudeOauthLoginBtn.classList.add('hide');
    if (claudeProviderKeyField) claudeProviderKeyField.classList.add('hide');
    if (codexAuthBlock) codexAuthBlock.style.display = 'none';
    return;
  }

  if (baseUrlField) baseUrlField.style.display = showBaseUrl ? '' : 'none';
  if (apiKeyField) apiKeyField.style.display = showApiKey ? '' : 'none';
  if (detectField) detectField.style.display = showDetect ? '' : 'none';
  if (modelField) modelField.style.display = showModel ? '' : 'none';
  if (protocolField) protocolField.classList.toggle('hide', !showProtocol);
  if (saveBtn) saveBtn.style.display = showSaveBtn ? '' : 'none';
  if (editBtn) editBtn.style.display = showEditBtn ? '' : 'none';
  if (launchBtn) launchBtn.textContent = `启动 ${toolId === 'claudecode' ? 'Claude Code' : toolId === 'openclaw' ? 'OpenClaw' : toolId === 'opencode' ? 'OpenCode' : 'Codex'}`;
  if (detectionMeta) detectionMeta.textContent = detectionMetaText;
  if (sectionTitle) sectionTitle.textContent = sectionTitleText;
  if (providerSwitchBtn) providerSwitchBtn.style.display = showProviderSwitch ? '' : 'none';
  if (configEditorBtn) configEditorBtn.style.display = showConfigEditorBtn ? '' : 'none';
  if (modelRefreshBtn) modelRefreshBtn.classList.toggle('visible', showModelRefreshBtn);
  if (syncActions) syncActions.style.display = showSyncActions ? '' : 'none';
  if (claudeOauthLoginBtn) claudeOauthLoginBtn.classList.toggle('hide', !showOauthBtn);
  if (claudeProviderKeyField) claudeProviderKeyField.classList.toggle('hide', !showProviderKey);
  if (codexAuthBlock) codexAuthBlock.style.display = showCodexAuthBlock ? 'grid' : 'none';
}

function applyCodexQuickInstallState() {
  const showManualInputs = state.codexAuthView !== 'official';
  applyQuickInstallState({
    toolId: 'codex',
    installed: isCodexInstalled(),
    installLabel: '安装 Codex',
    sectionTitleText: isCodexInstalled() ? '连接配置' : 'Codex 未安装',
    detectionMetaText: isCodexInstalled() ? '只需要 URL 和 API Key；缺少 http/https 会自动补全。' : '当前未检测到 codex，请先安装；安装完成后这里才会显示登录和配置项。',
    showBaseUrl: showManualInputs,
    showApiKey: showManualInputs,
    showDetect: showManualInputs,
    showModel: true,
    showCodexAuthBlock: true,
  });
}

function applyClaudeCodeQuickInstallState(data = state.claudeCodeState || {}) {
  applyQuickInstallState({
    toolId: 'claudecode',
    installed: isClaudeCodeInstalled(data),
    installLabel: '安装 Claude Code',
    sectionTitleText: isClaudeCodeInstalled(data) ? 'Claude Code 设置' : 'Claude Code 未安装',
    detectionMetaText: isClaudeCodeInstalled(data) ? '支持 OAuth 与 API Key；已完成 OAuth 时 API Key 可以留空。' : '当前未检测到 claude，请先安装；安装完成后这里才会显示认证和模型配置。',
    showBaseUrl: true,
    showApiKey: true,
    showDetect: false,
    showModel: true,
    showOauthBtn: true,
    showProviderKey: true,
  });
}

function applyOpenCodeQuickInstallState(data = state.opencodeState || {}) {
  applyQuickInstallState({
    toolId: 'opencode',
    installed: isOpenCodeInstalled(data),
    installLabel: '安装 OpenCode',
    sectionTitleText: isOpenCodeInstalled(data) ? 'OpenCode 快速配置' : 'OpenCode 未安装',
    detectionMetaText: isOpenCodeInstalled(data) ? '填写 OpenAI 兼容 URL / Key，再检测模型并写入 opencode.json。' : '当前未检测到 opencode，请先安装；安装完成后这里才会显示配置项。',
    showBaseUrl: true,
    showApiKey: true,
    showDetect: true,
    showModel: true,
    showModelRefreshBtn: true,
  });
}

function applyOpenClawQuickInstallState(data = state.openclawState || {}) {
  applyQuickInstallState({
    toolId: 'openclaw',
    installed: isOpenClawInstalled(data),
    installLabel: '安装 OpenClaw',
    sectionTitleText: isOpenClawInstalled(data) ? 'OpenClaw 模型配置' : 'OpenClaw 未安装',
    detectionMetaText: isOpenClawInstalled(data) ? '选择协议后会自动适配默认 URL、环境变量名和推荐模型。' : '当前未检测到 openclaw，请先安装；安装完成后这里才会显示协议和模型配置。',
    showBaseUrl: true,
    showApiKey: true,
    showDetect: false,
    showModel: true,
    showProtocol: true,
    showSyncActions: true,
    showModelRefreshBtn: true,
  });
}
async function loadOpenCodeQuickState() {
  try {
    const params = new URLSearchParams({
      scope: el('scopeSelect')?.value || 'global',
      projectPath: el('projectPathInput')?.value?.trim() || '',
    });
    const json = await api(`/api/opencode/state?${params.toString()}`);
    if (!json.ok || !json.data) return { ok: false, error: json.error || '读取失败' };
    const data = json.data;
    state.opencodeState = data;
    if (state.activeTool !== 'opencode') {
      renderToolConsole();
      return { ok: true, data };
    }
    const baseUrlInput = el('baseUrlInput');
    const apiKeyInput = el('apiKeyInput');
    const cache = _getToolFormCache('opencode', true);
    if (baseUrlInput && !_shouldPreserveToolField('opencode', 'baseUrl')) {
      const nextBaseUrl = data.activeProvider?.baseUrl || '';
      baseUrlInput.value = nextBaseUrl;
      cache.baseUrl = nextBaseUrl;
    }
    if (apiKeyInput) {
      apiKeyInput.type = 'password';
      apiKeyInput.placeholder = data.activeProvider?.maskedApiKey || 'API Key（留空表示保持当前）';
      if (!_shouldPreserveToolField('opencode', 'apiKey')) {
        apiKeyInput.value = '';
        cache.apiKey = '';
      }
    }
    renderOpenCodeModelOptions('modelSelect', { data, currentModel: data.model || '' });
    applyOpenCodeQuickInstallState(data);
    renderCurrentConfig();
    renderToolConsole();
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error?.message || '读取失败' };
  }
}

function mergeModelsIntoOpenCodeDropdown(fetchedModels = []) {
  const modelSelect = el('modelSelect');
  if (!modelSelect) return;
  const data = state.opencodeState || {};
  const currentValue = modelSelect.value || data.model || '';
  const providerKey = data.activeProviderKey || normalizeOpenCodeProviderKey(inferProviderKey(el('baseUrlInput')?.value || ''));
  const models = [...new Set((fetchedModels || []).map((item) => `${providerKey}/${item}`))];
  let html = '<option value="">选择默认模型</option>';
  html += models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
  if (currentValue && !models.includes(currentValue)) {
    html += `<option value="${escapeHtml(currentValue)}">${escapeHtml(currentValue)} (当前)</option>`;
  }
  modelSelect.innerHTML = html;
  if (currentValue) modelSelect.value = currentValue;
}

function buildOpenCodeConfigFromFields() {
  const current = state.opencodeState || {};
  const existing = cloneJson(current.config || {});
  const inConfigEditor = state.activePage === 'configEditor' && getConfigEditorTool() === 'opencode';
  const _sv = (id) => String(el(id)?.value || '').trim();
  const _csvArr = (id) => {
    const raw = _sv(id);
    if (!raw) return undefined;
    return raw.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  };
  const _boolSelect = (id) => {
    const raw = _sv(id);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  };
  const _autoUpdate = (id) => {
    const raw = _sv(id);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'notify') return 'notify';
    return undefined;
  };
  const _int = (id, label, { min } = {}) => {
    const raw = _sv(id);
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value)) throw new Error(`${label} 必须是整数`);
    if (typeof min === 'number' && value < min) throw new Error(`${label} 不能小于 ${min}`);
    return value;
  };
  const _float = (id, label, { min, max } = {}) => {
    const raw = _sv(id);
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${label} 必须是数字`);
    if (typeof min === 'number' && value < min) throw new Error(`${label} 不能小于 ${min}`);
    if (typeof max === 'number' && value > max) throw new Error(`${label} 不能大于 ${max}`);
    return value;
  };
  const _timeoutValue = (id, label, { allowFalse = false } = {}) => {
    const raw = _sv(id);
    if (allowFalse && raw === 'false') return false;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数，或 false`);
    return value;
  };
  const _ensureObject = (value, label) => {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} 需要填写 JSON 对象`);
    }
    return cloneJson(value);
  };
  const _ensureObjectOrBoolean = (value, label) => {
    if (value === null || value === false) return value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} 需要填写 JSON 对象或 false`);
    }
    return cloneJson(value);
  };
  const _setTop = (key, value) => {
    setDeepConfigValue(existing, key, value);
  };

  const editorModel = _sv('opCfgModelInput');
  const quickModel = _sv('modelSelect');
  const model = (inConfigEditor ? (editorModel || quickModel || current.model || existing.model || '') : (quickModel || editorModel || current.model || existing.model || '')).trim();
  const smallModel = (inConfigEditor ? _sv('opCfgSmallModelInput') : (current.smallModel || existing.small_model || _sv('opCfgSmallModelInput') || '')).trim();
  const editorBaseUrl = _sv('opCfgBaseUrlInput');
  const quickBaseUrl = _sv('baseUrlInput');
  const baseUrl = normalizeBaseUrl(inConfigEditor ? (editorBaseUrl || quickBaseUrl || current.activeProvider?.baseUrl || '') : (quickBaseUrl || editorBaseUrl || current.activeProvider?.baseUrl || ''));
  const providerKeyInput = _sv('opCfgProviderKeyInput');
  const desiredProviderKey = (providerKeyInput || openCodeProviderKeyFromModel(model) || current.activeProviderKey || inferProviderKey(baseUrl) || '').trim();
  const providerKey = normalizeOpenCodeProviderKey(desiredProviderKey || 'custom');
  const editorApiKey = _sv('opCfgApiKeyInput');
  const quickApiKey = _sv('apiKeyInput');
  const apiKey = (inConfigEditor ? (editorApiKey || quickApiKey || '') : (quickApiKey || editorApiKey || '')).trim();
  const modelParts = model.includes('/') ? model.split('/') : [providerKey, model];
  const finalProviderKey = normalizeOpenCodeProviderKey(modelParts[0] || providerKey || 'custom');
  const modelId = (modelParts.slice(1).join('/') || '').trim();
  const providerNameInput = _sv('opCfgProviderNameInput');
  const providerPackageInput = _sv('opCfgProviderPackageInput');
  const existingProviderConfig = cloneJson(existing.provider?.[finalProviderKey] || {});
  const activeProviderKey = normalizeOpenCodeProviderKey(current.activeProviderKey || current.activeProvider?.key || '');
  const runtimeProvider = activeProviderKey === finalProviderKey ? cloneJson(current.activeProvider || {}) : {};
  const providerName = (inConfigEditor
    ? providerNameInput
    : (runtimeProvider.name || existingProviderConfig.name || providerNameInput || inferProviderLabel(baseUrl) || finalProviderKey)).trim();
  const providerPackage = (inConfigEditor
    ? providerPackageInput
    : (existingProviderConfig.npm || runtimeProvider.npm || providerPackageInput || '')).trim();

  existing.$schema = existing.$schema || 'https://opencode.ai/config.json';
  _setTop('model', modelId ? `${finalProviderKey}/${modelId}` : undefined);
  _setTop('small_model', smallModel || undefined);
  if (inConfigEditor) {
    _setTop('logLevel', _sv('opCfgLogLevel') || undefined);
    _setTop('username', _sv('opCfgUsernameInput') || undefined);
    _setTop('default_agent', _sv('opCfgDefaultAgentInput') || undefined);
    _setTop('share', _sv('opCfgShareSelect') || undefined);
    delete existing.autoshare;
    _setTop('autoupdate', _autoUpdate('opCfgAutoUpdateSelect'));
    _setTop('snapshot', _boolSelect('opCfgSnapshotSelect'));
    _setTop('disabled_providers', _csvArr('opCfgDisabledProvidersInput'));
    _setTop('enabled_providers', _csvArr('opCfgEnabledProvidersInput'));
    _setTop('instructions', _csvArr('opCfgInstructionsInput'));
    _setTop('plugin', _csvArr('opCfgPluginListInput'));

    _setTop('server.port', _int('opCfgServerPortInput', '服务端口', { min: 1 }));
    _setTop('server.hostname', _sv('opCfgServerHostnameInput') || undefined);
    _setTop('server.mdns', _boolSelect('opCfgServerMdnsSelect'));
    _setTop('server.mdnsDomain', _sv('opCfgServerMdnsDomainInput') || undefined);
    _setTop('server.cors', _csvArr('opCfgServerCorsInput'));
    _setTop('enterprise.url', _sv('opCfgEnterpriseUrlInput') || undefined);
    _setTop('skills.paths', _csvArr('opCfgSkillsPathsInput'));
    _setTop('skills.urls', _csvArr('opCfgSkillsUrlsInput'));
    _setTop('watcher.ignore', _csvArr('opCfgWatcherIgnoreInput'));

    _setTop('compaction.auto', _boolSelect('opCfgCompactionAutoSelect'));
    _setTop('compaction.prune', _boolSelect('opCfgCompactionPruneSelect'));
    _setTop('compaction.reserved', _int('opCfgCompactionReservedInput', '保留 Token', { min: 0 }));
    _setTop('experimental.batch_tool', _boolSelect('opCfgExperimentalBatchToolSelect'));
    _setTop('experimental.openTelemetry', _boolSelect('opCfgExperimentalOpenTelemetrySelect'));
    _setTop('experimental.continue_loop_on_deny', _boolSelect('opCfgExperimentalContinueOnDenySelect'));
    _setTop('experimental.disable_paste_summary', _boolSelect('opCfgExperimentalDisablePasteSummarySelect'));
    _setTop('experimental.mcp_timeout', _int('opCfgExperimentalMcpTimeoutInput', 'MCP 超时', { min: 1 }));
    _setTop('experimental.primary_tools', _csvArr('opCfgExperimentalPrimaryToolsInput'));
  }

  const providerFragment = inConfigEditor ? readJsonFragmentInput('opCfgProviderJson', 'Provider') : null;
  let providerMap = providerFragment === null ? cloneJson(existing.provider || {}) : _ensureObject(providerFragment, 'Provider');
  if (inConfigEditor) providerMap = mergeOpenCodeProviderFormIntoMap(providerMap);
  const shouldTouchProvider = Boolean(finalProviderKey) && (
    Object.keys(providerMap || {}).length
    || model
    || editorBaseUrl
    || quickBaseUrl
    || editorApiKey
    || quickApiKey
    || providerKeyInput
    || providerNameInput
    || providerPackageInput
    || _sv('opCfgProviderWhitelistInput')
    || _sv('opCfgProviderBlacklistInput')
    || _sv('opCfgProviderEnterpriseUrlInput')
    || _sv('opCfgProviderSetCacheKeySelect')
    || _sv('opCfgProviderTimeoutInput')
    || _sv('opCfgProviderChunkTimeoutInput')
    || current.activeProviderKey
  );

  if (shouldTouchProvider) {
    const provider = cloneJson(providerMap[finalProviderKey] || existing.provider?.[finalProviderKey] || {});
    if (providerName) provider.name = providerName;
    else delete provider.name;
    if (providerPackage) provider.npm = providerPackage;
    else delete provider.npm;
    provider.options = { ...(provider.options || {}) };
    if (baseUrl) provider.options.baseURL = baseUrl;
    else delete provider.options.baseURL;
    if (apiKey) provider.options.apiKey = apiKey;
    if (inConfigEditor) {
      const whitelist = _csvArr('opCfgProviderWhitelistInput');
      const blacklist = _csvArr('opCfgProviderBlacklistInput');
      const providerEnterpriseUrl = _sv('opCfgProviderEnterpriseUrlInput') || undefined;
      const setCacheKey = _boolSelect('opCfgProviderSetCacheKeySelect');
      const providerTimeout = _timeoutValue('opCfgProviderTimeoutInput', 'Provider 请求超时', { allowFalse: true });
      const chunkTimeout = _int('opCfgProviderChunkTimeoutInput', '流式分块超时', { min: 1 });
      if (whitelist) provider.whitelist = whitelist;
      else delete provider.whitelist;
      if (blacklist) provider.blacklist = blacklist;
      else delete provider.blacklist;
      if (providerEnterpriseUrl) provider.options.enterpriseUrl = providerEnterpriseUrl;
      else delete provider.options.enterpriseUrl;
      if (setCacheKey !== undefined) provider.options.setCacheKey = setCacheKey;
      else delete provider.options.setCacheKey;
      if (providerTimeout !== undefined) provider.options.timeout = providerTimeout;
      else delete provider.options.timeout;
      if (chunkTimeout !== undefined) provider.options.chunkTimeout = chunkTimeout;
      else delete provider.options.chunkTimeout;
    }
    if (modelId) {
      provider.models = { ...(provider.models || {}) };
      provider.models[modelId] = provider.models[modelId] || {};
    }
    if (isEmptyConfigValue(provider.options)) delete provider.options;
    if (isEmptyConfigValue(provider.models)) delete provider.models;
    if (isEmptyConfigValue(provider)) delete providerMap[finalProviderKey];
    else providerMap[finalProviderKey] = provider;
  }
  _setTop('provider', isEmptyConfigValue(providerMap) ? undefined : providerMap);

  if (inConfigEditor) {
    const agentFragment = readJsonFragmentInput('opCfgAgentJson', 'Agent');
    const agentMap = agentFragment === null ? cloneJson(existing.agent || {}) : _ensureObject(agentFragment, 'Agent');
    [
      ['build', 'Build', { steps: true, temperature: true }],
      ['plan', 'Plan', { steps: true, temperature: true }],
      ['general', 'General', { steps: true, temperature: true }],
      ['explore', 'Explore', { steps: true }],
      ['title', 'Title', {}],
      ['summary', 'Summary', {}],
      ['compaction', 'Compaction', { steps: true }],
    ].forEach(([agentKey, label, fields]) => {
      const nextAgent = cloneJson(agentMap[agentKey] || {});
      const modelValue = _sv(`opCfgAgent${label}ModelInput`) || undefined;
      const stepsValue = fields.steps ? _int(`opCfgAgent${label}StepsInput`, `${label} 步数`, { min: 1 }) : undefined;
      const temperatureValue = fields.temperature ? _float(`opCfgAgent${label}TemperatureInput`, `${label} 温度`) : undefined;
      if (modelValue) nextAgent.model = modelValue;
      else delete nextAgent.model;
      if (fields.steps) {
        if (stepsValue !== undefined) nextAgent.steps = stepsValue;
        else delete nextAgent.steps;
      }
      if (fields.temperature) {
        if (temperatureValue !== undefined) nextAgent.temperature = temperatureValue;
        else delete nextAgent.temperature;
      }
      if (isEmptyConfigValue(nextAgent)) delete agentMap[agentKey];
      else agentMap[agentKey] = nextAgent;
    });
    _setTop('agent', isEmptyConfigValue(agentMap) ? undefined : agentMap);
    delete existing.mode;

    const permissionFragment = readJsonFragmentInput('opCfgPermissionJson', 'Permission');
    if (permissionFragment !== null && typeof permissionFragment !== 'string' && (!permissionFragment || typeof permissionFragment !== 'object' || Array.isArray(permissionFragment))) {
      throw new Error('Permission 需要填写 JSON 对象或 ask/allow/deny');
    }
    const permissionMap = typeof permissionFragment === 'string'
      ? { '*': permissionFragment }
      : permissionFragment === null
        ? (typeof existing.permission === 'string' ? { '*': existing.permission } : cloneJson(existing.permission || {}))
        : cloneJson(permissionFragment);
    [
      ['*', 'opCfgPermissionDefaultSelect'],
      ['read', 'opCfgPermissionReadSelect'],
      ['edit', 'opCfgPermissionEditSelect'],
      ['bash', 'opCfgPermissionBashSelect'],
      ['task', 'opCfgPermissionTaskSelect'],
      ['glob', 'opCfgPermissionGlobSelect'],
      ['grep', 'opCfgPermissionGrepSelect'],
      ['list', 'opCfgPermissionListSelect'],
      ['webfetch', 'opCfgPermissionWebFetchSelect'],
      ['websearch', 'opCfgPermissionWebSearchSelect'],
      ['codesearch', 'opCfgPermissionCodeSearchSelect'],
      ['skill', 'opCfgPermissionSkillSelect'],
      ['lsp', 'opCfgPermissionLspSelect'],
      ['external_directory', 'opCfgPermissionExternalDirectorySelect'],
      ['todoread', 'opCfgPermissionTodoReadSelect'],
      ['todowrite', 'opCfgPermissionTodoWriteSelect'],
      ['doom_loop', 'opCfgPermissionDoomLoopSelect'],
      ['question', 'opCfgPermissionQuestionSelect'],
    ].forEach(([permissionKey, inputId]) => {
      const action = _sv(inputId);
      if (action) {
        permissionMap[permissionKey] = action;
        return;
      }
      if (typeof permissionMap[permissionKey] === 'string') {
        delete permissionMap[permissionKey];
      }
    });
    _setTop('permission', isEmptyConfigValue(permissionMap) ? undefined : permissionMap);

    const commandFragment = readJsonFragmentInput('opCfgCommandJson', 'Command');
    _setTop('command', commandFragment === null ? undefined : _ensureObject(commandFragment, 'Command'));

    const mcpFragment = readJsonFragmentInput('opCfgMcpJson', 'MCP');
    _setTop('mcp', mcpFragment === null ? undefined : _ensureObject(mcpFragment, 'MCP'));

    const formatterFragment = readJsonFragmentInput('opCfgFormatterJson', 'Formatter');
    _setTop('formatter', formatterFragment === null ? undefined : _ensureObjectOrBoolean(formatterFragment, 'Formatter'));

    const lspFragment = readJsonFragmentInput('opCfgLspJson', 'LSP');
    _setTop('lsp', lspFragment === null ? undefined : _ensureObjectOrBoolean(lspFragment, 'LSP'));
  }

  return existing;
}

async function saveOpenCodeConfigOnly() {
  let config;
  try {
    config = buildOpenCodeConfigFromFields();
  } catch (error) {
    return flash(error instanceof Error ? error.message : String(error), 'error');
  }
  setBusy('saveBtn', true, '保存中...');
  const json = await api('/api/opencode/config-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: el('scopeSelect')?.value || 'global',
      projectPath: el('projectPathInput')?.value?.trim() || '',
      configJson: JSON.stringify(config, null, 2),
    }),
  });
  setBusy('saveBtn', false);
  if (!json.ok) return flash(json.error || '保存失败', 'error');
  await loadOpenCodeQuickState();
  renderCurrentConfig();
  flash('OpenCode 配置已保存', 'success');
}

async function launchOpenCodeOnly() {
  if (!isOpenCodeInstalled(state.opencodeState || {})) {
    const result = await runOpenCodeToolAction('install', el('launchBtn'));
    await loadTools();
    await loadOpenCodeQuickState().catch(() => {});
    applyOpenCodeQuickInstallState(state.opencodeState || {});
    return Boolean(result?.ok);
  }
  setBusy('launchBtn', true, '启动中...');
  const launched = await api('/api/opencode/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: el('launchCwdInput')?.value?.trim() || '' }),
  });
  setBusy('launchBtn', false);
  if (!launched.ok) return flash(launched.error || '启动失败', 'error');
  flash('OpenCode 已启动', 'success');
  return true;
}


async function loadOpenClawQuickState() {
  try {
    const data = await fetchOpenClawStateData();
    const quick = deriveOpenClawQuickConfig(data);
    state.openClawQuickConfig = quick;
    applyOpenClawQuickInstallState(data);

    if (state.activeTool !== 'openclaw') {
      renderToolConsole();
      return;
    }

    const baseUrlInput = el('baseUrlInput');
    const apiKeyInput = el('apiKeyInput');
    const modelSelect = el('modelSelect');
    const protocolSelect = el('openClawProtocolSelect');
    const detectionMeta = el('detectionMeta');
    const cache = _getToolFormCache('openclaw', true);

    const launchBtn = el('launchBtn');
    const dashboardRow = el('ocDashboardQuickRow');
    state._ocGatewayUrl = data.gatewayUrl || '';
    const gatewayStatus = getOpenClawGatewayStatus(data);
    const dashboardStatus = document.querySelector('#ocDashboardQuickRow .oc-dashboard-status');
    const daemonBtn = el('ocDaemonBtn');
    if (gatewayStatus === 'online') {
      if (launchBtn) {
        launchBtn.innerHTML = '<span class="running-dot"></span>打开 Dashboard';
        launchBtn.classList.add('running');
      }
      if (dashboardRow) dashboardRow.classList.remove('hide');
      if (dashboardStatus) dashboardStatus.innerHTML = '<span class="running-dot"></span>OpenClaw 正在运行';
    } else if (gatewayStatus === 'warming') {
      if (launchBtn) {
        launchBtn.textContent = 'Gateway 启动中…';
        launchBtn.classList.remove('running');
      }
      if (dashboardRow) dashboardRow.classList.remove('hide');
      if (dashboardStatus) dashboardStatus.innerHTML = '<span class="running-dot"></span>OpenClaw 启动中';
    } else {
      if (launchBtn) {
        launchBtn.textContent = '启动 OpenClaw';
        launchBtn.classList.remove('running');
      }
      if (dashboardRow) dashboardRow.classList.toggle('hide', !data.binary?.installed);
      if (dashboardStatus) dashboardStatus.innerHTML = `<span class="running-dot" style="opacity:${data.daemonRunning ? '1' : '.35'}"></span>常驻服务：${escapeHtml(getOpenClawDaemonStatusLabel(data))}`;
    }
    if (daemonBtn) {
      daemonBtn.textContent = data.daemonInstalled ? '关闭常驻' : '开启常驻';
      daemonBtn.style.color = data.daemonInstalled ? '#fbbf24' : '';
    }

    if (protocolSelect) {
      protocolSelect.innerHTML = renderOpenClawProtocolOptions(quick.api || 'openai-completions');
      if (!_shouldPreserveToolField('openclaw', 'protocolValue')) {
        protocolSelect.value = quick.api || 'openai-completions';
        cache.protocolValue = quick.api || 'openai-completions';
      }
    }

    if (baseUrlInput && !_shouldPreserveToolField('openclaw', 'baseUrl')) {
      const nextBaseUrl = quick.baseUrl || '';
      baseUrlInput.value = nextBaseUrl;
      cache.baseUrl = nextBaseUrl;
    }

    if (apiKeyInput) {
      apiKeyInput.type = 'password';
      if (!_shouldPreserveToolField('openclaw', 'apiKey')) {
        apiKeyInput.value = '';
        cache.apiKey = '';
      }
    }
    syncApiKeyToggle();

    const synced = syncOpenClawQuickProtocol(
      (cache.protocolValue && _shouldPreserveToolField('openclaw', 'protocolValue')) ? cache.protocolValue : (quick.api || 'openai-completions'),
      quick.model || getOpenClawDefaultModel(quick.api || 'openai-completions')
    );
    if (modelSelect && !_shouldPreserveToolField('openclaw', 'modelValue')) {
      modelSelect.value = quick.model || synced.model;
      cache.modelValue = modelSelect.value || '';
    }
    syncOpenClawQuickHints(synced.api, {
      maskedApiKey: quick.maskedApiKey,
      hasStoredKey: quick.hasApiKey,
    });

    if (detectionMeta && !data.binary?.installed) {
      detectionMeta.textContent += ' 你也可以先保存好这套模型配置，安装完成后直接启动。';
    }

    renderCurrentConfig();
    renderToolConsole();

    if (quick.baseUrl && quick.hasApiKey && !_shouldPreserveToolField('openclaw', 'baseUrl') && !_shouldPreserveToolField('openclaw', 'apiKey')) {
      tryAutoFetchModels();
    }
  } catch {
    /* silent */
  }
}

async function fetchOpenClawStateData() {
  const json = await api('/api/openclaw/state');
  if (!json.ok || !json.data) {
    throw new Error(json.error || '读取 OpenClaw 状态失败');
  }
  state.openclawState = json.data;
  return json.data;
}

function getOpenClawGatewayStatus(data = {}) {
  if (data.gatewayReachable) return 'online';
  if (data.gatewayPortListening) return 'warming';
  return 'offline';
}

function getOpenClawGatewayStatusLabel(data = {}) {
  return ({ online: '在线', warming: '启动中', offline: '未启动' })[getOpenClawGatewayStatus(data)] || '未启动';
}

function getOpenClawDaemonStatusLabel(data = {}) {
  return data.daemon?.label || (data.daemonRunning ? '运行中' : data.daemonInstalled ? '已关闭' : '未启用');
}

function syncCodexAuthView() {
  const block = el('codexAuthBlock');
  const panel = el('codexOfficialAuthPanel');
  const baseUrlField = el('baseUrlInput')?.closest('.field');
  const apiKeyField = el('apiKeyInput')?.closest('.field');
  const detectField = el('detectBtn')?.closest('.field');
  if (!block || !panel || state.activeTool !== 'codex' || !isCodexInstalled()) {
    if (block) block.style.display = 'none';
    return;
  }

  const login = state.current?.login || {};
  const hasOfficialLogin = Boolean(login.loggedIn && login.method === 'chatgpt');
  if (!hasOfficialLogin && state.codexAuthView !== 'official') {
    state.codexAuthView = 'api_key';
  }

  block.style.display = 'grid';
  document.querySelectorAll('[data-codex-auth-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.codexAuthView === state.codexAuthView);
    if (button.dataset.codexAuthView === 'official') {
      button.disabled = false;
      button.title = hasOfficialLogin ? '使用 Codex 官方登录' : '使用 Codex 官方账号登录';
    }
  });

  if (state.codexAuthView === 'official') {
    if (baseUrlField) baseUrlField.style.display = 'none';
    if (apiKeyField) apiKeyField.style.display = 'none';
    if (detectField) detectField.style.display = 'none';
    panel.classList.add('show');
    panel.innerHTML = hasOfficialLogin ? `
      <div class="codex-auth-title">已识别 Codex 官方登录</div>
      <div class="codex-auth-desc">当前设备已经存在 Codex 官方登录态。你可以直接启动使用；如果想改成代理 / 中转 / 国内平台，再切到「API Key」填写自定义配置。</div>
      <div class="codex-auth-badges">
        <span class="provider-pill ok">${escapeHtml(login.method === 'chatgpt' ? 'ChatGPT / OpenAI 已登录' : '已登录')}</span>
        ${login.plan ? `<span class="provider-pill ok">${escapeHtml(login.plan)}</span>` : ''}
        ${login.email ? `<span class="provider-pill muted">${escapeHtml(login.email)}</span>` : ''}
        ${login.accountId ? `<span class="provider-pill muted">account: ${escapeHtml(login.accountId)}</span>` : ''}
      </div>
      <div class="codex-auth-actions">
        <button type="button" class="tiny-btn" data-codex-apply-official>设为默认 OpenAI Provider</button>
        <button type="button" class="secondary tiny-btn" data-codex-switch-api>切到 API Key 配置</button>
        <button type="button" class="secondary tiny-btn" data-codex-refresh-login>重新检测登录状态</button>
      </div>
    ` : `
      <div class="codex-auth-title">尚未检测到 Codex 官方登录</div>
      <div class="codex-auth-desc">当前你的 <code>~/.codex/auth.json</code> 里只有 API Key，没有官方登录产生的 <code>tokens.access_token</code> / <code>id_token</code>，现在可以直接点下面按钮拉起 <code>codex login</code>。</div>
      <div class="codex-auth-actions">
        <button type="button" class="tiny-btn" data-codex-start-login>立即官方登录</button>
        <button type="button" class="secondary tiny-btn" data-codex-switch-api>改用 API Key</button>
        <button type="button" class="secondary tiny-btn" data-codex-refresh-login>重新检测登录状态</button>
      </div>
    `;
  } else {
    if (baseUrlField) baseUrlField.style.display = '';
    if (apiKeyField) apiKeyField.style.display = '';
    if (detectField) detectField.style.display = '';
    panel.classList.remove('show');
    panel.innerHTML = '';
  }
}

function applyEnvImportToOcForm(envVars) {
  const applied = [];
  let providerType = '';
  let baseUrl = '';
  let apiKey = '';
  let envKeyName = '';

  const anthropicBaseUrl = envVars.ANTHROPIC_BASE_URL || '';
  const anthropicAuthToken = envVars.ANTHROPIC_AUTH_TOKEN || '';
  const anthropicApiKey = envVars.ANTHROPIC_API_KEY || '';
  const openaiBaseUrl = envVars.OPENAI_BASE_URL || '';
  const openaiApiKey = envVars.OPENAI_API_KEY || '';
  const codexApiKey = envVars.CODEX_API_KEY || envVars.CODEX_CLI_API_KEY || '';

  if (anthropicBaseUrl || anthropicAuthToken || anthropicApiKey) {
    providerType = 'anthropic';
    baseUrl = anthropicBaseUrl || 'https://api.anthropic.com';
    apiKey = anthropicAuthToken || anthropicApiKey;
    envKeyName = anthropicAuthToken ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
  } else if (openaiBaseUrl || openaiApiKey) {
    providerType = 'openai';
    baseUrl = openaiBaseUrl || 'https://api.openai.com/v1';
    apiKey = openaiApiKey;
    envKeyName = 'OPENAI_API_KEY';
  } else if (codexApiKey) {
    providerType = 'openai';
    baseUrl = envVars.CODEX_BASE_URL || 'https://api.openai.com/v1';
    apiKey = codexApiKey;
    envKeyName = 'CODEX_API_KEY';
  }

  if (!providerType) return { applied: [], providerType: '' };

  const apiProtocol = providerType === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
  const protocolMeta = OPENCLAW_PROTOCOL_META[apiProtocol];

  if (el('ocCfgProviderApi')) {
    el('ocCfgProviderApi').value = apiProtocol;
    if (el('ocCfgProviderApi')._customSelect) el('ocCfgProviderApi')._customSelect.renderOptions();
    applied.push(`协议 → ${protocolMeta.label}`);
  }

  if (baseUrl && el('ocCfgProviderBaseUrl')) {
    el('ocCfgProviderBaseUrl').value = baseUrl;
    applied.push(`Base URL → ${baseUrl}`);
  }
  if (apiKey && el('ocCfgProviderApiKey')) {
    el('ocCfgProviderApiKey').value = apiKey;
    applied.push(`API Key → ${apiKey.slice(0, 12)}...`);
  }

  if (envKeyName && el('ocCfgProviderEnvKey')) {
    el('ocCfgProviderEnvKey').value = envKeyName;
    applied.push(`Token 变量 → ${envKeyName}`);
  }

  // Set provider alias
  if (el('ocCfgProviderAlias')) {
    el('ocCfgProviderAlias').value = providerType;
    applied.push(`Provider → ${providerType}`);
  }

  // Set default model for protocol
  if (el('ocCfgModelPrimary') && !el('ocCfgModelPrimary').value) {
    el('ocCfgModelPrimary').value = protocolMeta.defaultModel;
    applied.push(`主模型 → ${protocolMeta.defaultModel}`);
  }

  if (window.refreshCustomSelects) window.refreshCustomSelects();
  return { applied, providerType };
}

/**
 * Apply a saved Codex provider to the OpenClaw config editor.
 * Properly detects protocol from wireApi and base URL, fetches API key.
 */
function applyProviderToOcForm(provider) {
  if (!provider) return;
  const baseUrl = provider.baseUrl || '';
  const providerKey = provider.key || '';
  const wireApi = (provider.wireApi || '').toLowerCase();
  const urlLower = baseUrl.toLowerCase();
  const keyLower = providerKey.toLowerCase();
  const nameLower = (provider.name || '').toLowerCase();

  // Determine protocol based on wireApi, URL patterns, and name
  let apiProtocol = 'openai-completions';  // default
  let providerType = 'openai';

  // Check for Anthropic/Claude first
  const isAnthropic = urlLower.includes('anthropic') || urlLower.includes('claude') ||
    keyLower.includes('anthropic') || keyLower.includes('claude') ||
    nameLower.includes('anthropic') || nameLower.includes('claude');

  if (isAnthropic) {
    apiProtocol = 'anthropic-messages';
    providerType = 'anthropic';
  } else if (wireApi === 'responses') {
    apiProtocol = 'openai-responses';
  } else if (wireApi === 'chat' || wireApi === 'completions' || wireApi === 'chat-completions') {
    apiProtocol = 'openai-completions';
  }

  const protocolMeta = OPENCLAW_PROTOCOL_META[apiProtocol];

  // Fill protocol
  if (el('ocCfgProviderApi')) {
    el('ocCfgProviderApi').value = apiProtocol;
    // Trigger the native select's change to sync custom select
    el('ocCfgProviderApi').dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Fill base URL
  if (baseUrl && el('ocCfgProviderBaseUrl')) {
    el('ocCfgProviderBaseUrl').value = baseUrl;
  }

  // Fill provider alias
  if (el('ocCfgProviderAlias')) {
    el('ocCfgProviderAlias').value = provider.name || providerKey;
  }

  // Fill env key based on provider's actual env_key or derive from protocol
  if (el('ocCfgProviderEnvKey')) {
    const envKey = provider.resolvedKeyName || provider.envKey || protocolMeta.defaultEnvKey;
    el('ocCfgProviderEnvKey').value = envKey;
  }

  // Fill default model
  if (el('ocCfgModelPrimary')) {
    el('ocCfgModelPrimary').value = protocolMeta.defaultModel;
  }

  // Fill model display name
  if (el('ocCfgProviderModelName')) {
    const modelName = inferOpenClawModelName ? inferOpenClawModelName(protocolMeta.defaultModel) : protocolMeta.defaultModel;
    el('ocCfgProviderModelName').value = modelName;
  }

  // Fetch the API key asynchronously
  const isClaudeCode = provider._isClaudeCode;
  if (isClaudeCode) {
    // For Claude Code: read from claudeCodeState env
    const ccState = state.claudeCodeState;
    if (ccState?.env) {
      const ev = ccState.env;
      const token = ev.ANTHROPIC_AUTH_TOKEN?.set ? ev.ANTHROPIC_AUTH_TOKEN.value : '';
      const key = ev.ANTHROPIC_API_KEY?.set ? ev.ANTHROPIC_API_KEY.value : '';
      const secret = token || key;
      if (secret && el('ocCfgProviderApiKey')) {
        el('ocCfgProviderApiKey').value = secret;
      }
      if (el('ocCfgProviderEnvKey')) {
        el('ocCfgProviderEnvKey').value = token ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
      }
    }
  } else if (provider.hasApiKey && providerKey) {
    // Fetch secret from backend
    (async () => {
      try {
        const json = await api('/api/provider/secret', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerKey }),
        });
        if (json.ok && json.data) {
          const secret = json.data.apiKey || json.data.secret || '';
          if (secret && el('ocCfgProviderApiKey')) {
            el('ocCfgProviderApiKey').value = secret;
            flash('API Key 已自动填入', 'success');
          }
          // Also update the env key name if resolved
          if (json.data.resolvedKeyName && el('ocCfgProviderEnvKey')) {
            el('ocCfgProviderEnvKey').value = json.data.resolvedKeyName;
          }
        }
      } catch { /* silent */ }
    })();
  }

  if (window.refreshCustomSelects) window.refreshCustomSelects();
}

/** Toggle the local provider dropdown in the env-import bar */
function toggleOcEnvLocalDropdown(forceOpen) {
  const dropdown = el('ocEnvLocalDropdown');
  const btn = el('ocEnvReadLocalBtn');
  if (!dropdown) return;
  const isOpen = dropdown.classList.contains('open');
  if (forceOpen === false || isOpen) {
    dropdown.classList.remove('open');
    return;
  }

  // Build categorized list from saved Codex providers + Claude Code auth
  const providers = state.current?.providers || [];

  // Categorize into Claude / OpenAI groups
  const claudeProviders = [];
  const openaiProviders = [];

  for (const p of providers) {
    const url = (p.baseUrl || '').toLowerCase();
    const key = (p.key || '').toLowerCase();
    const name = (p.name || '').toLowerCase();
    if (url.includes('anthropic') || url.includes('claude') || key.includes('anthropic') || key.includes('claude') || name.includes('anthropic') || name.includes('claude')) {
      claudeProviders.push(p);
    } else {
      openaiProviders.push(p);
    }
  }

  // Also include Claude Code auth if available
  const ccState = state.claudeCodeState;
  if (ccState?.env) {
    const ev = ccState.env;
    const ccBaseUrl = ev.ANTHROPIC_BASE_URL?.set ? ev.ANTHROPIC_BASE_URL.value : '';
    const ccHasKey = ev.ANTHROPIC_AUTH_TOKEN?.set || ev.ANTHROPIC_API_KEY?.set;
    if (ccBaseUrl || ccHasKey) {
      claudeProviders.push({
        key: '__claude_code__',
        name: 'Claude Code (本地)',
        baseUrl: ccBaseUrl || 'https://api.anthropic.com',
        hasApiKey: ccHasKey,
        _isClaudeCode: true,
      });
    }
  }

  const totalCount = claudeProviders.length + openaiProviders.length;

  if (totalCount === 0) {
    dropdown.innerHTML = `<div class="env-import-local-empty">暂无已保存的 Provider<br><span style="font-size:0.68rem;opacity:0.6">先在主页配置 Provider 后即可一键载入</span></div>`;
  } else {
    let html = '';
    if (claudeProviders.length) {
      html += `<div class="env-import-local-group">
        <div class="env-import-local-group-label">Claude / Anthropic</div>
        ${claudeProviders.map(p => `
          <div class="env-import-local-item" data-provider-key="${escapeHtml(p.key)}" ${p._isClaudeCode ? 'data-claude-code="1"' : ''}>
            <span class="eil-name">${escapeHtml(p.name || p.key)}</span>
            <span class="eil-url">${escapeHtml(p.baseUrl || '-')}</span>
          </div>
        `).join('')}
      </div>`;
    }
    if (openaiProviders.length) {
      html += `<div class="env-import-local-group">
        <div class="env-import-local-group-label">OpenAI / 其他</div>
        ${openaiProviders.map(p => `
          <div class="env-import-local-item" data-provider-key="${escapeHtml(p.key)}">
            <span class="eil-name">${escapeHtml(p.name || p.key)}</span>
            <span class="eil-url">${escapeHtml(p.baseUrl || '-')}</span>
          </div>
        `).join('')}
      </div>`;
    }
    dropdown.innerHTML = html;
  }

  // Position: fixed, below the button
  if (btn) {
    const rect = btn.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = rect.left + 'px';
  }

  dropdown.classList.add('open');
}

/** Toggle the paste import collapse area */
function toggleOcEnvPasteCollapse() {
  const collapse = el('ocEnvPasteCollapse');
  if (!collapse) return;
  collapse.classList.toggle('open');
  if (collapse.classList.contains('open')) {
    setTimeout(() => el('ocEnvPasteTextarea')?.focus(), 160);
  }
}

/** Handle paste in the env import textarea - auto-detect and fill */
function handleOcEnvPaste() {
  const textarea = el('ocEnvPasteTextarea');
  const resultEl = el('ocEnvImportResult');
  if (!textarea || !resultEl) return;

  const text = textarea.value.trim();
  if (!text) {
    resultEl.innerHTML = '';
    return;
  }

  const envVars = parseExportStatements(text);
  if (Object.keys(envVars).length === 0) {
    resultEl.innerHTML = `<div class="env-import-result error">未识别到有效的环境变量。请确认格式如：export ANTHROPIC_BASE_URL=https://...</div>`;
    return;
  }

  const { applied, providerType } = applyEnvImportToOcForm(envVars);
  if (applied.length === 0) {
    resultEl.innerHTML = `<div class="env-import-result error">未识别到支持的环境变量 (ANTHROPIC_* / OPENAI_* / CODEX_*)</div>`;
    return;
  }

  const typeLabel = providerType === 'anthropic' ? 'Claude / Anthropic' : 'OpenAI';
  resultEl.innerHTML = `<div class="env-import-result">
    ✓ 已识别为 <strong>${typeLabel}</strong> 配置，自动填写 ${applied.length} 项：<br>
    ${applied.map(a => `<span style="opacity:0.8;font-size:0.7rem">• ${escapeHtml(a)}</span>`).join('<br>')}
  </div>`;
}

function renderOpenClawInstallMethods(container) {
  const _s = (d) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const isWin = navigator.platform?.startsWith('Win');
  const methods = isWin
    ? [
      {
        id: 'domestic', icon: _s('<path d="M12 3l7 4v10l-7 4-7-4V7l7-4z"/><path d="M8 12h8"/><path d="M12 8v8"/>'), title: '一键安装', desc: '默认推荐，国内优化，自动补 Node.js 和 Git', tag: '默认推荐',
        cmdMac: '', cmdWin: 'npm install -g openclaw@latest --registry=https://registry.npmmirror.com'
      },
      {
        id: 'wsl', icon: _s('<path d="M4 6h16v12H4z"/><path d="M8 10l2 2-2 2"/><path d="M12 14h4"/>'), title: '高级 WSL2', desc: '适合熟悉 Linux 的用户，需要先装 WSL2 / Ubuntu', tag: '高级',
        cmdMac: '', cmdWin: 'wsl -d Ubuntu-24.04 -- bash -lc "curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm"'
      },
      {
        id: 'script', icon: _s('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'), title: '官方脚本', desc: '保持官方原始安装方式，适合网络和环境都比较稳时使用', tag: '官方',
        cmdMac: '', cmdWin: "$env:OPENCLAW_NO_ONBOARD='1'; iwr -useb https://openclaw.ai/install.ps1 | iex"
      },
    ]
    : [
      {
        id: 'script', icon: _s('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'), title: '一键脚本', desc: '推荐方式，自动检测 Node.js 并安装', tag: '推荐',
        cmdMac: 'curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm',
        cmdWin: "$env:OPENCLAW_NO_ONBOARD='1'; iwr -useb https://openclaw.ai/install.ps1 | iex"
      },
      {
        id: 'npm', icon: _s('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>'), title: 'npm / pnpm', desc: '已有 Node 22+ 环境时的最快方式', tag: '',
        cmdMac: 'npm install -g openclaw@latest', cmdWin: 'npm install -g openclaw@latest'
      },
      {
        id: 'source', icon: _s('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'), title: '源码构建', desc: '开发者模式，支持热重载与自定义', tag: '开发者',
        cmdMac: 'git clone + pnpm build', cmdWin: 'git clone + pnpm build'
      },
      {
        id: 'docker', icon: _s('<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M12 7V3M7 7V5M17 7V5"/>'), title: 'Docker 部署', desc: '容器化部署，适合服务器环境', tag: '服务器',
        cmdMac: './docker-setup.sh', cmdWin: './docker-setup.sh'
      },
    ];

  container.innerHTML = `
    <div class="openclaw-install-methods install-method-dialog">
      <div class="install-methods-title">选择安装方式</div>
      <div class="install-scope-switch">
        <button class="install-scope-btn is-active" data-install-scope="local">本地安装</button>
        <button class="install-scope-btn" data-install-scope="remote">远程服务器安装</button>
      </div>
      <div class="install-scope-panel is-active" data-install-scope-panel="local">
        <div class="install-methods-grid">
          ${methods.map(m => `
            <button class="install-method-card" data-install-method="${m.id}">
              <div class="imc-head">
                <span class="imc-icon">${m.icon}</span>
                <span class="imc-title">${m.title}</span>
                ${m.tag ? `<span class="imc-tag">${m.tag}</span>` : ''}
              </div>
              <div class="imc-desc">${m.desc}</div>
              <div class="imc-cmd">${escapeHtml(isWin ? m.cmdWin : m.cmdMac)}</div>
            </button>
          `).join('')}
        </div>
        <div class="install-methods-hint">${isWin ? 'Windows 提供三种模式：默认一键安装、WSL2 高级模式、官方脚本。' : '本地推荐四种安装方式，点击卡片开始安装。'}</div>
      </div>
      <div class="install-scope-panel" data-install-scope-panel="remote">
        <div class="remote-install-form">
          <div class="remote-install-row two-col">
            <label>
              <span>服务器 IP / 域名</span>
              <input type="text" placeholder="例如 10.10.10.8 或 server.example.com" data-remote-host>
            </label>
            <label>
              <span>SSH 端口</span>
              <input type="text" value="22" data-remote-port>
            </label>
          </div>
          <div class="remote-install-row">
            <label>
              <span>用户名</span>
              <input type="text" placeholder="root / ubuntu / admin" data-remote-username>
            </label>
          </div>
          <div class="remote-install-row three-col">
            <label>
              <span>远程系统</span>
              <div class="select-wrap"><select data-remote-os>
                <option value="unix">Linux / macOS</option>
                <option value="windows">Windows</option>
              </select></div>
            </label>
            <label>
              <span>登录方式</span>
              <div class="select-wrap"><select data-remote-auth-method>
                <option value="agent">SSH Agent（推荐）</option>
                <option value="password">密码登录</option>
                <option value="key">私钥文件</option>
              </select></div>
            </label>
            <label>
              <span>安装方式</span>
              <div class="select-wrap"><select data-remote-install-method>
                <option value="script">官方脚本（推荐）</option>
                <option value="npm">npm 全局安装</option>
              </select></div>
            </label>
          </div>
          <div class="remote-install-row" data-remote-auth-extra="password" hidden>
            <label>
              <span>登录密码</span>
              <input type="password" placeholder="输入远程服务器密码" data-remote-password>
            </label>
          </div>
          <div class="remote-install-row" data-remote-auth-extra="key" hidden>
            <label>
              <span>私钥路径</span>
              <input type="text" placeholder="~/.ssh/id_ed25519" data-remote-key-path>
            </label>
          </div>
          <div class="remote-install-note">将通过 SSH 登录到远程服务器并执行安装命令。</div>
          <button class="remote-install-submit-btn" data-remote-openclaw-install>连接并安装 OpenClaw</button>
        </div>
      </div>
    </div>
  `;

  // Upgrade selects to custom dropdowns
  if (window.initCustomSelect) {
    container.querySelectorAll('.select-wrap > select').forEach(s => window.initCustomSelect(s));
  }

  if (!container._openclawInstallMethodsBound) {
    container._openclawInstallMethodsBound = true;
    container.addEventListener('click', async (e) => {
      const card = e.target.closest('[data-install-method]');
      if (!card || !container.contains(card)) return;
      const method = card.dataset.installMethod;
      await executeOpenClawInstall(method, card);
    });
  }
}

function renderOpenClawInstalledView(container, data) {
  container.innerHTML = `
    <div class="openclaw-installed-view">
      <div class="oiv-status">
        <div class="oiv-badge">\u2713 已安装</div>
        <div class="oiv-version">${escapeHtml(data.binary?.version || '')}</div>
      </div>
      <div class="oiv-info">
        <div class="oiv-row"><span>配置目录</span><code>${escapeHtml(data.configHome)}</code></div>
        <div class="oiv-row"><span>Gateway 端口</span><code>${escapeHtml(data.gatewayPort)}</code></div>
        <div class="oiv-row"><span>首次初始化</span><code>${data.configExists ? '已完成' : '未完成'}</code></div>
        <div class="oiv-row"><span>Dashboard</span><code>${getOpenClawGatewayStatusLabel(data)}</code></div>
      </div>
      <div class="oiv-actions">
        <button id="openclawOnboardBtn">${data.needsOnboarding ? '一键完成初始化' : '重新运行初始化'}</button>
        <button class="secondary" id="openclawDashboardBtn">${data.gatewayReachable ? '打开 Dashboard' : data.gatewayPortListening ? '等待 Dashboard 就绪' : '检测并打开 Dashboard'}</button>
        <button class="secondary" id="openclawRefreshBtn">刷新状态</button>
      </div>
    </div>
  `;

  container.querySelector('#openclawOnboardBtn')?.addEventListener('click', async () => {
    try {
      await runOpenClawOnboardFlow({ autoOpenDashboard: true });
    } catch (error) {
      flash(error.message || '启动 OpenClaw 初始化失败', 'error');
    }
  });
  container.querySelector('#openclawDashboardBtn')?.addEventListener('click', async () => {
    try {
      if (data.gatewayReachable) {
        await repairOpenClawDashboard({ silent: true });
        return;
      }
      if (data.gatewayPortListening) {
        await repairOpenClawDashboard({ silent: true });
        flash('Gateway 已启动，正在等待 Dashboard 就绪', 'info');
        return;
      }
      await runOpenClawOnboardFlow({ autoOpenDashboard: true });
    } catch (error) {
      flash(error.message || '打开 OpenClaw Dashboard 失败', 'error');
    }
  });
  container.querySelector('#openclawRefreshBtn')?.addEventListener('click', () => loadOpenClawQuickState());
}

/** Build the local provider list for the onboard model config UI */
function _buildOnboardLocalProviders() {
  const providers = state.current?.providers || [];
  const claudeProviders = [];
  const openaiProviders = [];
  for (const p of providers) {
    const url = (p.baseUrl || '').toLowerCase();
    const key = (p.key || '').toLowerCase();
    const name = (p.name || '').toLowerCase();
    if (url.includes('anthropic') || url.includes('claude') || key.includes('anthropic') || key.includes('claude') || name.includes('anthropic') || name.includes('claude')) {
      claudeProviders.push(p);
    } else {
      openaiProviders.push(p);
    }
  }
  const ccState = state.claudeCodeState;
  if (ccState?.env) {
    const ev = ccState.env;
    const ccBaseUrl = ev.ANTHROPIC_BASE_URL?.set ? ev.ANTHROPIC_BASE_URL.value : '';
    const ccHasKey = ev.ANTHROPIC_AUTH_TOKEN?.set || ev.ANTHROPIC_API_KEY?.set;
    if (ccBaseUrl || ccHasKey) {
      claudeProviders.push({
        key: '__claude_code__',
        name: 'Claude Code (本地认证)',
        baseUrl: ccBaseUrl || 'https://api.anthropic.com',
        hasApiKey: ccHasKey,
        _isClaudeCode: true,
      });
    }
  }
  return { claudeProviders, openaiProviders };
}

/** Render the model config section HTML for onboard dialog */
function renderOnboardModelConfigHtml() {
  const { claudeProviders, openaiProviders } = _buildOnboardLocalProviders();
  const totalCount = claudeProviders.length + openaiProviders.length;
  const checkSvg = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';
  const presetHtml = OPENCLAW_CN_PROVIDER_PRESETS.map((preset) => `
    <button class="omc-preset-chip" type="button" data-omc-preset="${escapeHtml(preset.id)}">
      <span class="omc-preset-name">${escapeHtml(preset.label)}</span>
      <span class="omc-preset-tip">${escapeHtml(preset.tip)}</span>
    </button>
  `).join('');

  let localCardsHtml = '';
  if (totalCount === 0) {
    localCardsHtml = '<div class="omc-local-empty">暂无本地已保存的 Provider<br><span style="font-size:0.68rem;opacity:0.6">可切换到「手动输入」或「粘贴导入」</span></div>';
  } else {
    if (claudeProviders.length) {
      localCardsHtml += '<div class="omc-local-group-label">Claude / Anthropic</div>';
      localCardsHtml += claudeProviders.map((p) => {
        const claudeAttr = p._isClaudeCode ? ' data-omc-claude-code="1"' : '';
        return ''
          + '<button class="omc-local-card" data-omc-provider-key="' + escapeHtml(p.key) + '"' + claudeAttr + '>'
          + '<span class="olc-icon">A</span>'
          + '<span class="olc-info">'
          + '<span class="olc-name">' + escapeHtml(p.name || p.key) + '</span>'
          + '<span class="olc-url">' + escapeHtml(p.baseUrl || '-') + '</span>'
          + '</span>'
          + '<span class="olc-check">' + checkSvg + '</span>'
          + '</button>';
      }).join('');
    }
    if (openaiProviders.length) {
      localCardsHtml += '<div class="omc-local-group-label">OpenAI / Codex / 其他</div>';
      localCardsHtml += openaiProviders.map((p) => ''
        + '<button class="omc-local-card" data-omc-provider-key="' + escapeHtml(p.key) + '">'
        + '<span class="olc-icon">O</span>'
        + '<span class="olc-info">'
        + '<span class="olc-name">' + escapeHtml(p.name || p.key) + '</span>'
        + '<span class="olc-url">' + escapeHtml(p.baseUrl || '-') + '</span>'
        + '</span>'
        + '<span class="olc-check">' + checkSvg + '</span>'
        + '</button>').join('');
    }
  }

  return `
    <div class="onboard-model-config">
      <div class="omc-title">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/><circle cx="8" cy="8" r="3"/></svg>
        配置模型连接
        <span id="omcFilledBadge" class="omc-filled-badge" style="display:none">&#10003; 已填入</span>
      </div>
      <div class="omc-subtitle">选择或输入你的 AI 模型 Provider，支持自动加载本地 Codex / Claude Code 配置</div>

      <div class="omc-preset-block">
        <div class="omc-preset-title">国内宝宝一键预设</div>
        <div class="omc-preset-list">${presetHtml}</div>
      </div>

      <div class="omc-source-tabs">
        <button class="omc-source-tab is-active" data-omc-tab="local">本地配置</button>
        <button class="omc-source-tab" data-omc-tab="manual">手动输入</button>
        <button class="omc-source-tab" data-omc-tab="paste">粘贴导入</button>
      </div>

      <div class="omc-source-panel is-active" data-omc-panel="local">
        <div class="omc-local-list">${localCardsHtml}</div>
      </div>

      <div class="omc-source-panel" data-omc-panel="manual">
        <div class="omc-manual-form">
          <div class="omc-field-row">
            <div class="omc-field">
              <span>Base URL</span>
              <input id="omcManualBaseUrl" placeholder="https://api.openai.com/v1" />
            </div>
            <div class="omc-field">
              <span>API Key</span>
              <input id="omcManualApiKey" type="password" placeholder="sk-..." />
            </div>
          </div>
        </div>
      </div>

      <div class="omc-source-panel" data-omc-panel="paste">
        <div class="omc-paste-area">
          <textarea id="omcPasteTextarea" placeholder="粘贴 export 语句，例如：\nexport OPENAI_BASE_URL=https://api.openai.com/v1\nexport OPENAI_API_KEY=sk-xxxx"></textarea>
          <div class="omc-paste-hint">支持 export VAR=VALUE 格式，自动识别 OpenAI / Anthropic / Codex 环境变量</div>
          <button id="omcPasteParseBtn" class="secondary" style="width:fit-content;font-size:0.76rem;">识别并填入</button>
          <div id="omcPasteResult"></div>
        </div>
      </div>

      <div class="omc-detect-row">
        <button id="omcDetectBtn" class="secondary">检测模型</button>
        <span id="omcDetectStatus" class="omc-detect-status"></span>
      </div>
      <div class="omc-model-area" id="omcModelArea" style="display:none">
        <span>选择模型</span>
        <div class="select-wrap"><select id="omcModelSelect"><option value="">选择模型</option></select></div>
      </div>

      <div class="omc-confirm-row">
        <button id="omcConfirmBtn">确认模型配置</button>
        <span id="omcConfirmStatus" class="omc-confirm-status"></span>
      </div>
    </div>
  `;
}

function ensureOnboardModelConfigState() {
  if (!state._omcState) {
    state._omcState = {
      baseUrl: '',
      apiKey: '',
      model: '',
      confirmed: false,
      detectedModels: [],
      detectStatus: '',
      confirmStatus: '',
      selectedProviderKey: '',
      selectedProviderKind: '',
    };
  }
  return state._omcState;
}

function inferOnboardOpenClawApiMode(baseUrl = '', modelRef = '', providerKind = '') {
  const base = String(baseUrl || '').toLowerCase();
  const provider = String(providerKind || '').toLowerCase();
  if (provider.includes('claude') || base.includes('anthropic')) {
    return 'anthropic-messages';
  }
  return inferOpenClawApiMode(modelRef || '');
}

function syncOnboardModelSelect(models = [], preferred = '') {
  const area = document.getElementById('omcModelArea');
  const select = document.getElementById('omcModelSelect');
  if (!area || !select) return;

  const uniqueModels = [...new Set([preferred, ...(models || [])].map(item => String(item || '').trim()).filter(Boolean))];
  area.style.display = uniqueModels.length ? '' : 'none';
  select.innerHTML = '<option value="">选择模型</option>' + uniqueModels.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (preferred && uniqueModels.includes(preferred)) {
    select.value = preferred;
  }
  if (select._customSelect) {
    select._customSelect.renderOptions();
  } else if (window.initCustomSelect) {
    window.initCustomSelect(select);
  }
}

function syncOnboardModelConfigForm() {
  const omc = ensureOnboardModelConfigState();
  const baseUrlInput = document.getElementById('omcManualBaseUrl');
  const apiKeyInput = document.getElementById('omcManualApiKey');
  const pasteTextarea = document.getElementById('omcPasteTextarea');
  const detectStatus = document.getElementById('omcDetectStatus');
  const confirmStatus = document.getElementById('omcConfirmStatus');

  if (baseUrlInput && document.activeElement !== baseUrlInput) baseUrlInput.value = omc.baseUrl || '';
  if (apiKeyInput && document.activeElement !== apiKeyInput) apiKeyInput.value = omc.apiKey || '';
  if (pasteTextarea && typeof omc.pasteText === 'string' && document.activeElement !== pasteTextarea) pasteTextarea.value = omc.pasteText;
  if (detectStatus) detectStatus.textContent = omc.detectStatus || '';
  if (confirmStatus) confirmStatus.innerHTML = omc.confirmStatus || '';
  syncOnboardModelSelect(omc.detectedModels || [], omc.model || '');

  document.querySelectorAll('#updateDialogBody .omc-local-card').forEach((card) => {
    const cardKey = `${card.dataset.omcClaudeCode === '1' ? 'claudecode' : 'codex'}:${card.dataset.omcProviderKey || ''}`;
    card.classList.toggle('is-selected', cardKey === omc.selectedProviderKey);
  });
  _updateOmcFilledBadge();
}

function buildOpenClawConfigFromOnboardModelState() {
  const omc = ensureOnboardModelConfigState();
  const baseUrlInput = String(omc.baseUrl || '').trim();
  const apiKey = String(omc.apiKey || '').trim();
  const apiMode = inferOnboardOpenClawApiMode(baseUrlInput, omc.model || '', omc.selectedProviderKind || '');
  const modelRef = String(omc.model || getOpenClawDefaultModel(apiMode)).trim();
  const normalizedBaseUrl = normalizeOpenClawBaseUrl(baseUrlInput || getOpenClawDefaultBaseUrl(apiMode), modelRef, apiMode);
  const config = cloneJson(state.openclawState?.config || {});
  const currentQuick = deriveOpenClawQuickConfig(state.openclawState || {});
  const envKey = inferOpenClawBuiltInEnvKey(modelRef, apiMode) || getOpenClawDefaultEnvKey(apiMode);
  const modelId = extractOpenClawCustomModelId(modelRef) || modelRef;
  const providerAlias = normalizedBaseUrl
    ? buildOpenClawCustomProviderAlias(modelRef, apiMode)
    : (String(modelRef).split('/')[0] || inferOpenClawProviderFromEnvKey(envKey, apiMode) || 'openai');
  const previousAlias = String(currentQuick.storedModel || '').split('/')[0] || '';
  const existingProvider = cloneJson(config.models?.providers?.[providerAlias] || {});

  config.env = config.env || {};
  if (apiKey) config.env[envKey] = apiKey;

  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = config.agents.defaults.model || {};
  config.agents.defaults.model.primary = `${providerAlias}/${modelId}`;

  config.models = config.models || {};
  config.models.mode = config.models.mode || 'merge';
  config.models.providers = config.models.providers || {};
  if (previousAlias && previousAlias !== providerAlias && config.models.providers[previousAlias]?.baseUrl) {
    delete config.models.providers[previousAlias];
  }
  config.models.providers[providerAlias] = {
    ...existingProvider,
    baseUrl: normalizedBaseUrl,
    api: apiMode,
    apiKey: apiKey ? '${' + envKey + '}' : existingProvider.apiKey,
    models: [
      buildOpenClawModelDefinition({
        modelRef,
        apiMode,
        modelName: inferOpenClawModelName(modelRef),
      }),
    ],
  };

  return { config, modelRef };
}

function syncOpenClawSetupDialogSurface() {
  const panel = el('updateDialog')?.querySelector('.update-dialog-panel');
  if (panel) panel.classList.add('install-dialog-wide');
  bindOnboardModelConfigEvents();
  syncOnboardModelConfigForm();
}

function renderOpenClawSetupDialog({ stateData, command = '', terminalMessage = '', autoOpenDashboard = false, elapsedMs = 0, timedOut = false }) {
  const gatewayStatus = getOpenClawGatewayStatus(stateData);
  const gatewayReady = gatewayStatus === 'online';
  const gatewayWarming = gatewayStatus === 'warming';
  const steps = [
    { title: '后台初始化已开始', done: Boolean(terminalMessage), desc: terminalMessage || '正在准备初始化任务…' },
    { title: '自动生成首次配置', done: Boolean(stateData?.configExists), desc: stateData?.configExists ? '已检测到 OpenClaw 配置文件。' : '正在后台自动生成首次配置，一般不需要你手动处理。' },
    { title: '等待本地 Gateway 就绪', done: gatewayReady, desc: gatewayReady ? `Dashboard 已在线：${stateData.gatewayUrl}` : gatewayWarming ? `Gateway 端口已启动：${stateData.gatewayUrl}` : '配置完成后，这里会自动检测本地 Dashboard 是否已启动。' },
  ];
  const showModelConfig = Boolean(stateData?.configExists || gatewayReady || gatewayWarming || timedOut);
  return `
    <div class="install-tracker">
      <div class="install-tracker-top">
        <div>
          <div class="install-tracker-status">${gatewayReady ? '初始化完成' : timedOut ? '后台初始化仍在进行' : '正在自动初始化'}</div>
          <div class="install-tracker-summary">${gatewayReady ? 'OpenClaw 已准备好，建议先确认模型配置再打开 Dashboard。' : gatewayWarming ? 'Gateway 已启动，正在等待控制面板完全就绪。' : stateData?.configExists ? '配置已生成，正在等待 Gateway 启动。' : '后台初始化已经开始，正在自动完成首次配置。'}</div>
        </div>
        <div class="install-tracker-percent">${gatewayReady ? '100%' : gatewayWarming ? '90%' : stateData?.configExists ? '75%' : '35%'}</div>
      </div>
      <div class="install-tracker-hint">${timedOut ? '如果后台任务还在处理，不用重新安装；稍等片刻后点“刷新状态”即可。' : '这个步骤已经尽量自动化了；通常不需要你再打开终端。'}</div>
      <div class="install-tracker-detail">${escapeHtml(command || 'openclaw onboard --install-daemon')}</div>
      <div class="install-tracker-grid">
        <div class="install-tracker-col">${steps.map((step, index) => renderOpenClawInstallStep({ title: step.title, description: step.desc, status: step.done ? 'done' : (index === steps.findIndex((item) => !item.done) ? 'running' : 'pending') }, index, 0)).join('')}</div>
        <div class="install-tracker-col">
          <div class="install-tracker-note-card">
            <div class="install-tracker-note-title">你现在该做什么</div>
            <ul class="install-tracker-list">
              <li>不需要额外打开终端，当前窗口会自动帮你检测初始化进度。</li>
              <li>如果 Gateway 先显示“启动中”，通常只是在等待控制面板完全就绪。</li>
              <li>${autoOpenDashboard ? '一旦检测成功，会自动打开 Dashboard。' : '检测成功后你就可以直接打开 Dashboard。'}</li>
            </ul>
          </div>
          <div class="install-tracker-note-card">
            <div class="install-tracker-note-title">当前状态</div>
            <ul class="install-tracker-list">
              <li>配置文件：${stateData?.configExists ? '已检测到' : '还没检测到'}</li>
              <li>Gateway：${getOpenClawGatewayStatusLabel(stateData)}</li>
              <li>已等待：${formatRelativeDuration(new Date(Date.now() - elapsedMs).toISOString(), new Date().toISOString())}</li>
            </ul>
          </div>
        </div>
      </div>
      <div class="install-tracker-log-head">
        <div class="install-tracker-log-title">自动化说明</div>
        ${stateData?.gatewayReachable ? `<button type="button" class="secondary install-tracker-copy-btn" data-openclaw-open-dashboard>打开 Dashboard</button>` : `<button type="button" class="secondary install-tracker-copy-btn" data-openclaw-refresh-state>刷新状态</button>`}
      </div>
      <div class="install-tracker-note-card">
        <div class="install-tracker-detail">${escapeHtml(terminalMessage || '后台初始化命令准备中…')}</div>
      </div>
      ${showModelConfig ? renderOnboardModelConfigHtml() : ''}
    </div>
  `;
}

/** Bind events for the onboard model config UI inside the update dialog */
function bindOnboardModelConfigEvents() {
  const dialogBody = el('updateDialogBody');
  if (!dialogBody) return;

  const omc = ensureOnboardModelConfigState();

  // Tab switching
  dialogBody.querySelectorAll('[data-omc-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      dialogBody.querySelectorAll('[data-omc-tab]').forEach(t => t.classList.toggle('is-active', t === tab));
      dialogBody.querySelectorAll('[data-omc-panel]').forEach(p => p.classList.toggle('is-active', p.dataset.omcPanel === tab.dataset.omcTab));
    });
  });

  // Local provider card click
  dialogBody.querySelectorAll('.omc-local-card').forEach(card => {
    card.addEventListener('click', async () => {
      dialogBody.querySelectorAll('.omc-local-card').forEach(c => c.classList.remove('is-selected'));
      card.classList.add('is-selected');

      const providerKey = card.dataset.omcProviderKey;
      const isClaudeCode = card.dataset.omcClaudeCode === '1';
      let baseUrl = '';
      let apiKeyVal = '';
      let detectedModel = '';

      if (isClaudeCode) {
        const ccState = state.claudeCodeState;
        if (ccState?.env) {
          const ev = ccState.env;
          baseUrl = ev.ANTHROPIC_BASE_URL?.set ? ev.ANTHROPIC_BASE_URL.value : 'https://api.anthropic.com';
          apiKeyVal = ev.ANTHROPIC_AUTH_TOKEN?.set ? ev.ANTHROPIC_AUTH_TOKEN.value : (ev.ANTHROPIC_API_KEY?.set ? ev.ANTHROPIC_API_KEY.value : '');
          detectedModel = ccState.model || '';
        }
      } else {
        const provider = (state.current?.providers || []).find(p => p.key === providerKey);
        if (provider) {
          baseUrl = provider.baseUrl || '';
          if (provider.hasApiKey) {
            try {
              const json = await api('/api/provider/secret', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ providerKey }),
              });
              if (json.ok && json.data) apiKeyVal = json.data.apiKey || json.data.secret || '';
            } catch { /* silent */ }
          }
        }
        detectedModel = state.current?.config?.model || '';
      }

      omc.selectedProviderKey = `${isClaudeCode ? 'claudecode' : 'codex'}:${providerKey}`;
      omc.selectedProviderKind = isClaudeCode ? 'claudecode' : 'codex';
      omc.baseUrl = baseUrl;
      omc.apiKey = apiKeyVal;
      omc.model = detectedModel || omc.model || getOpenClawDefaultModel(inferOnboardOpenClawApiMode(baseUrl, detectedModel, omc.selectedProviderKind));
      omc.detectedModels = omc.model ? [omc.model] : [];
      omc.detectStatus = detectedModel ? '已从本机配置预填模型，可直接确认。' : '已加载本机 URL / Key，可继续检测模型。';
      omc.confirmStatus = '';
      syncOnboardModelConfigForm();
      flash('已加载 ' + (card.querySelector('.olc-name')?.textContent || providerKey) + ' 的配置', 'success');
    });
  });

  // Manual input sync
  const manualUrl = document.getElementById('omcManualBaseUrl');
  const manualKey = document.getElementById('omcManualApiKey');
  if (manualUrl) manualUrl.addEventListener('input', () => { omc.baseUrl = manualUrl.value.trim(); omc.confirmStatus = ''; _updateOmcFilledBadge(); });
  if (manualKey) manualKey.addEventListener('input', () => { omc.apiKey = manualKey.value.trim(); omc.confirmStatus = ''; _updateOmcFilledBadge(); });

  document.querySelectorAll('[data-omc-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = OPENCLAW_CN_PROVIDER_PRESETS.find((item) => item.id === button.dataset.omcPreset);
      if (!preset) return;
      omc.selectedProviderKey = '';
      omc.selectedProviderKind = preset.providerKind || 'openai';
      omc.baseUrl = preset.baseUrl;
      omc.model = preset.model;
      omc.detectedModels = preset.model ? [preset.model] : [];
      omc.detectStatus = `已应用 ${preset.label} 预设，请填入对应 API Key 后直接确认或检测模型。`;
      omc.confirmStatus = `建议使用 <code>${escapeHtml(preset.envKey || 'OPENAI_API_KEY')}</code> 保存该渠道的 Key。`;
      syncOnboardModelConfigForm();
      flash(`已应用 ${preset.label} 预设`, 'success');
    });
  });

  // Paste import
  const pasteBtn = document.getElementById('omcPasteParseBtn');
  if (pasteBtn) {
    pasteBtn.addEventListener('click', () => {
      const textarea = document.getElementById('omcPasteTextarea');
      const resultEl = document.getElementById('omcPasteResult');
      if (!textarea || !resultEl) return;
      const text = textarea.value.trim();
      omc.pasteText = textarea.value;
      if (!text) { resultEl.innerHTML = ''; return; }

      const envVars = parseExportStatements(text);
      if (Object.keys(envVars).length === 0) {
        resultEl.innerHTML = '<div class="omc-paste-result error">未识别到有效的环境变量。请确认格式如：export OPENAI_BASE_URL=https://...</div>';
        return;
      }

      let baseUrl = '';
      let apiKeyParsed = '';
      let providerType = '';
      const anthropicBaseUrl = envVars.ANTHROPIC_BASE_URL || '';
      const anthropicAuthToken = envVars.ANTHROPIC_AUTH_TOKEN || '';
      const anthropicApiKey = envVars.ANTHROPIC_API_KEY || '';
      const openaiBaseUrl = envVars.OPENAI_BASE_URL || '';
      const openaiApiKey = envVars.OPENAI_API_KEY || '';
      const codexApiKey = envVars.CODEX_API_KEY || envVars.CODEX_CLI_API_KEY || '';

      if (anthropicBaseUrl || anthropicAuthToken || anthropicApiKey) {
        providerType = 'Claude / Anthropic';
        baseUrl = anthropicBaseUrl || 'https://api.anthropic.com';
        apiKeyParsed = anthropicAuthToken || anthropicApiKey;
      } else if (openaiBaseUrl || openaiApiKey) {
        providerType = 'OpenAI';
        baseUrl = openaiBaseUrl || 'https://api.openai.com/v1';
        apiKeyParsed = openaiApiKey;
      } else if (codexApiKey) {
        providerType = 'Codex';
        baseUrl = envVars.CODEX_BASE_URL || 'https://api.openai.com/v1';
        apiKeyParsed = codexApiKey;
      }

      if (!providerType) {
        resultEl.innerHTML = '<div class="omc-paste-result error">未识别到支持的环境变量 (ANTHROPIC_* / OPENAI_* / CODEX_*)</div>';
        return;
      }

      omc.baseUrl = baseUrl;
      omc.apiKey = apiKeyParsed;
      omc.selectedProviderKey = '';
      omc.selectedProviderKind = providerType.includes('Claude') ? 'claudecode' : 'codex';
      omc.model = omc.model || getOpenClawDefaultModel(inferOnboardOpenClawApiMode(baseUrl, '', omc.selectedProviderKind));
      omc.detectedModels = omc.model ? [omc.model] : [];
      omc.detectStatus = '已从粘贴内容识别 URL / Key，可直接确认或重新检测。';
      omc.confirmStatus = '';
      syncOnboardModelConfigForm();
      resultEl.innerHTML = '<div class="omc-paste-result">&#10003; 已识别为 <strong>' + providerType + '</strong>，自动填写 Base URL 和 API Key</div>';
    });
  }

  // Detect models button
  const detectBtn = document.getElementById('omcDetectBtn');
  if (detectBtn) {
    detectBtn.addEventListener('click', async () => {
      const baseUrl = omc.baseUrl || document.getElementById('omcManualBaseUrl')?.value?.trim() || '';
      const apiKeyVal = omc.apiKey || document.getElementById('omcManualApiKey')?.value?.trim() || '';
      const statusEl = document.getElementById('omcDetectStatus');
      if (!baseUrl) { if (statusEl) statusEl.textContent = '请先填入 Base URL'; return; }

      detectBtn.disabled = true;
      detectBtn.textContent = '检测中...';
      if (statusEl) statusEl.textContent = '正在连接...';

      try {
        const json = await api('/api/provider/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: baseUrl, apiKey: apiKeyVal }),
          timeoutMs: 18000,
        });
        if (!json.ok) { if (statusEl) statusEl.textContent = json.error || '检测失败'; return; }

        const models = json.data?.models || [];
        omc.detectStatus = '检测成功 - ' + models.length + ' 个模型';
        if (statusEl) statusEl.textContent = omc.detectStatus;

        const modelArea = document.getElementById('omcModelArea');
        const modelSelect = document.getElementById('omcModelSelect');
        if (modelArea && modelSelect && models.length > 0) {
          omc.detectedModels = models.map(m => typeof m === 'string' ? m : m.id || m.name || '').filter(Boolean);
          const recommended = json.data?.recommendedModel;
          omc.model = recommended && omc.detectedModels.includes(recommended)
            ? recommended
            : (omc.model && omc.detectedModels.includes(omc.model) ? omc.model : omc.detectedModels[0] || omc.model);
          syncOnboardModelConfigForm();
        }
      } catch (e) {
        omc.detectStatus = e.message || '检测失败';
        if (statusEl) statusEl.textContent = omc.detectStatus;
      } finally {
        detectBtn.disabled = false;
        detectBtn.textContent = '检测模型';
      }
    });
  }

  // Model select change
  const modelSelect = document.getElementById('omcModelSelect');
  if (modelSelect) {
    modelSelect.addEventListener('change', () => { omc.model = modelSelect.value; omc.confirmStatus = ''; });
  }

  // Confirm button
  const confirmBtn = document.getElementById('omcConfirmBtn');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const baseUrl = omc.baseUrl || document.getElementById('omcManualBaseUrl')?.value?.trim() || '';
      const apiKeyVal = omc.apiKey || document.getElementById('omcManualApiKey')?.value?.trim() || '';
      const model = omc.model || document.getElementById('omcModelSelect')?.value || '';
      const confirmStatus = document.getElementById('omcConfirmStatus');

      if (!baseUrl || !apiKeyVal) {
        if (confirmStatus) confirmStatus.textContent = '请先选择或填入 URL 和 API Key';
        return;
      }

      omc.baseUrl = baseUrl;
      omc.apiKey = apiKeyVal;
      omc.model = model || getOpenClawDefaultModel(inferOnboardOpenClawApiMode(baseUrl, model, omc.selectedProviderKind));

      if (baseUrl && el('ocCfgProviderBaseUrl')) el('ocCfgProviderBaseUrl').value = baseUrl;
      if (apiKeyVal && el('ocCfgProviderApiKey')) el('ocCfgProviderApiKey').value = apiKeyVal;
      if (omc.model && el('ocCfgModelPrimary')) el('ocCfgModelPrimary').value = omc.model;

      try {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '保存中...';
        const { config, modelRef } = buildOpenClawConfigFromOnboardModelState();
        const json = await api('/api/openclaw/config-save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ configJson: JSON.stringify(config, null, 2) }),
          timeoutMs: 12000,
        });
        if (json.ok) {
          omc.model = modelRef;
          omc.confirmed = true;
          omc.confirmStatus = '&#10003; 已保存到 openclaw.json';
          flash('模型配置已保存', 'success');
          if (confirmStatus) confirmStatus.innerHTML = omc.confirmStatus;
          await loadOpenClawQuickState();
          if (state.openClawSetupContext?.autoOpenDashboard && state.openclawState?.gatewayReachable) {
            await repairOpenClawDashboard({ silent: true });
          }
        } else {
          throw new Error(json.error || '模型配置保存失败');
        }
      } catch (error) {
        omc.confirmStatus = error.message || '模型配置保存失败';
        flash(error.message || '模型配置保存失败', 'error');
        if (confirmStatus) confirmStatus.textContent = omc.confirmStatus;
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = '确认模型配置';
      }
    });
  }
}

function _updateOmcFilledBadge() {
  const badge = document.getElementById('omcFilledBadge');
  const hasData = !!(state._omcState?.baseUrl || state._omcState?.apiKey);
  if (badge) badge.style.display = hasData ? '' : 'none';
}

async function runOpenClawOnboardFlow({ autoOpenDashboard = false } = {}) {
  const flowId = Date.now();
  state.openClawSetupFlowId = flowId;
  ensureOnboardModelConfigState();
  if (!state.current) {
    await loadState({ preserveForm: true }).catch((e) => console.warn('[runOpenClawOnboardFlow] loadState failed:', e));
  }
  if (!state.claudeCodeState) {
    await loadClaudeCodeQuickState().catch((e) => console.warn('[runOpenClawOnboardFlow] loadClaudeCodeQuickState failed:', e));
  }

  const launchJson = await api('/api/openclaw/onboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    timeoutMs: 90000,
  });
  if (!launchJson.ok || !launchJson.data) {
    throw new Error(launchJson.error || '启动 OpenClaw 初始化失败');
  }

  let latestState = state.openclawState || { configExists: false, gatewayReachable: false, gatewayUrl: '' };
  const startedAt = Date.now();
  state.openClawSetupContext = {
    command: launchJson.data.command,
    terminalMessage: launchJson.data.message,
    autoOpenDashboard,
    startedAt,
  };

  openUpdateDialog({
    eyebrow: 'OpenClaw',
    title: '正在自动初始化',
    body: renderOpenClawSetupDialog({
      stateData: latestState,
      command: launchJson.data.command,
      terminalMessage: launchJson.data.message,
      autoOpenDashboard,
      elapsedMs: 0,
    }),
    confirmText: '关闭',
    confirmOnly: true,
    trackerMode: true,
  });
  syncOpenClawSetupDialogSurface();

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (state.openClawSetupFlowId !== flowId) return null;
    await sleep(2000);
    try {
      latestState = await fetchOpenClawStateData();
      patchUpdateDialog({
        eyebrow: 'OpenClaw',
        title: latestState.gatewayReachable ? '初始化完成' : '正在自动初始化',
        trackerMode: true,
        body: renderOpenClawSetupDialog({
          stateData: latestState,
          command: launchJson.data.command,
          terminalMessage: launchJson.data.message,
          autoOpenDashboard,
          elapsedMs: Date.now() - startedAt,
        }),
      });
      syncOpenClawSetupDialogSurface();
      if (latestState.gatewayReachable) {
        await loadOpenClawQuickState();
        flash('OpenClaw 初始化完成，请确认模型配置', 'success');
        return latestState;
      }
    } catch {
      // ignore transient refresh errors
    }
  }

  patchUpdateDialog({
    eyebrow: 'OpenClaw',
    title: '后台初始化仍在进行',
    trackerMode: true,
    body: renderOpenClawSetupDialog({
      stateData: latestState,
      command: launchJson.data.command,
      terminalMessage: launchJson.data.message,
      autoOpenDashboard,
      elapsedMs: Date.now() - startedAt,
      timedOut: true,
    }),
  });
  syncOpenClawSetupDialogSurface();
  flash('后台初始化可能仍在进行，稍后点“刷新状态”即可', 'info');
  return latestState;
}

async function fetchOpenClawInstallTask(taskId) {
  const json = await api(`/api/openclaw/install/status?taskId=${encodeURIComponent(taskId)}`, { timeoutMs: 12000 });
  if (!json.ok) throw new Error(json.error || '获取安装进度失败');
  return json.data;
}

async function cancelOpenClawInstallTask(taskId) {
  const json = await api('/api/openclaw/install/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
    timeoutMs: 120000,
  });
  if (!json.ok) throw new Error(json.error || '中断安装失败');
  return json.data;
}

async function runTrackedOpenClawInstall(method, onUpdate) {
  const startJson = await api('/api/openclaw/install/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method }),
    timeoutMs: 12000,
  });
  if (!startJson.ok || !startJson.data?.taskId) {
    throw new Error(startJson.error || '启动安装任务失败');
  }

  let task = startJson.data;
  if (typeof onUpdate === 'function') onUpdate(task);

  let refreshFailures = 0;
  while (task.status === 'running' || task.status === 'cancelling') {
    await sleep(900);
    try {
      task = await fetchOpenClawInstallTask(task.taskId);
      refreshFailures = 0;
      if (typeof onUpdate === 'function') onUpdate(task);
    } catch (error) {
      refreshFailures += 1;
      if (refreshFailures >= 3) throw error;
    }
  }

  return task;
}

async function executeOpenClawInstall(method, card) {
  if (method === 'source' || method === 'docker' || method === 'wsl') {
    // Show instruction dialog with copy button
    const isWin = navigator.platform?.startsWith('Win');
    const fallbackCmds = {
      wsl: ['wsl --status', 'wsl --install -d Ubuntu-24.04', 'wsl -d Ubuntu-24.04 -- bash -lc "curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm"', 'wsl -d Ubuntu-24.04 -- bash -lc "openclaw --version"'],
      source: ['git clone https://github.com/nicepkg/openclaw.git', 'cd openclaw', 'pnpm install', 'pnpm build'],
      docker: ['./docker-setup.sh'],
    };
    const titles = { wsl: 'WSL2 安装步骤', source: '源码构建步骤', docker: 'Docker 部署步骤' };

    let instructions = fallbackCmds[method] || [];
    let message = '请打开终端（Terminal），粘贴以下命令执行。';
    try {
      const json = await api('/api/openclaw/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method }),
      });
      if (json.ok && json.data?.instructions?.length) instructions = json.data.instructions;
      if (json.data?.message) message = json.data.message;
    } catch { /* use fallback */ }

    const cmds = instructions.map(c => `<code class="install-cmd-line">${escapeHtml(c)}</code>`).join('');
    const copyId = 'ocCopyCmdBtn_' + Date.now();
    await openUpdateDialog({
      eyebrow: 'OpenClaw',
      title: titles[method] || '安装步骤',
      body: `
        <div class="install-cmd-block">${cmds}</div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:12px;">
          <button id="${copyId}" class="secondary" style="font-size:0.78rem;padding:5px 12px;">复制命令</button>
          <span style="font-size:0.76rem;opacity:0.6;">${escapeHtml(message)}</span>
        </div>
      `,
      confirmText: '知道了',
      confirmOnly: true,
    });
    document.getElementById(copyId)?.addEventListener('click', () => {
      navigator.clipboard.writeText(instructions.join('\n')).then(() => {
        const btn = document.getElementById(copyId);
        if (btn) { btn.textContent = '已复制 ✓'; setTimeout(() => { btn.textContent = '复制命令'; }, 1500); }
      });
    });
    return;
  }
  const isWin = navigator.platform?.startsWith('Win');
  const commandMap = {
    domestic: 'npm install -g openclaw@latest --registry=https://registry.npmmirror.com',
    script: isWin ? "$env:OPENCLAW_NO_ONBOARD='1'; iwr -useb https://openclaw.ai/install.ps1 | iex" : 'curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm',
    npm: 'npm install -g openclaw@latest',
  };
  const cmdText = commandMap[method] || commandMap.npm;

  // ── Confirmation dialog ──
  const methodLabel = {
    domestic: '一键安装（国内优化）',
    script: '官方脚本安装',
    npm: 'npm 全局安装',
  }[method] || 'OpenClaw 安装';
  const confirmBody = `
    <div style="display:flex;flex-direction:column;gap:14px;">
      <div style="font-size:0.86rem;color:var(--text);line-height:1.55;">
        即将使用 <strong>${escapeHtml(methodLabel)}</strong> 安装 OpenClaw，安装过程可能需要 1–3 分钟，期间请勿关闭窗口。
      </div>
      <div style="font-size:0.72rem;font-family:'SF Mono','JetBrains Mono',monospace;color:var(--muted);background:rgba(0,0,0,0.12);padding:8px 12px;border-radius:8px;word-break:break-all;line-height:1.5;border:1px solid rgba(255,255,255,0.04);">
        ${escapeHtml(cmdText)}
      </div>
      <div style="font-size:0.76rem;color:var(--muted);opacity:0.7;">
        安装将在后台执行，你可以实时查看进度和日志。
      </div>
    </div>
  `;
  const confirmed = await openUpdateDialog({
    eyebrow: 'OpenClaw',
    title: '确认安装',
    body: confirmBody,
    confirmText: '开始安装',
    cancelText: '取消',
  });
  if (!confirmed) return;

  // ── Start tracked install ──
  const taskId = addTask('安装 OpenClaw', { progress: 4, message: '正在创建安装任务…' });

  openUpdateDialog({
    eyebrow: 'OpenClaw',
    title: '安装中',
    body: `<div class="install-tracker-empty">正在连接安装器…<br><code>${escapeHtml(cmdText)}</code></div>`,
    confirmText: '安装中…',
    cancelText: '中断安装',
  });
  state.openClawInstallView.activeTaskId = '';
  state.openClawInstallView.cancelBusy = false;
  state.updateDialogCancelHandler = async () => {
    const activeTaskId = state.openClawInstallView.activeTaskId;
    if (!activeTaskId || state.openClawInstallView.cancelBusy) return;
    state.openClawInstallView.cancelBusy = true;
    patchUpdateDialog({
      cancelText: '中断中…',
      cancelDisabled: true,
      confirmText: '清理中…',
      confirmDisabled: true,
      trackerMode: true,
    });
    try {
      await cancelOpenClawInstallTask(activeTaskId);
      flash('已发送中断请求，正在清理残留…', 'info');
    } catch (error) {
      state.openClawInstallView.cancelBusy = false;
      patchUpdateDialog({ cancelText: '重试中断', cancelDisabled: false, confirmText: '安装中…', confirmDisabled: true, trackerMode: true });
      flash(error.message || '中断安装失败', 'error');
    }
  };
  setUpdateDialogLocked(true, '安装进行中，请等待完成或点击“中断安装”');
  patchUpdateDialog({ trackerMode: true, confirmDisabled: true, cancelDisabled: false, cancelHidden: false });

  try {
    const finalTask = await runTrackedOpenClawInstall(method, (task) => {
      state.openClawInstallView.activeTaskId = task.taskId || state.openClawInstallView.activeTaskId;
      state.openClawInstallView.cancelBusy = task.status === 'cancelling';
      renderTrackedOpenClawDialog(task);
      updateTask(taskId, {
        name: '安装 OpenClaw',
        status: task.status === 'running' || task.status === 'cancelling'
          ? 'running'
          : task.status === 'success'
            ? 'done'
            : task.status === 'cancelled'
              ? 'cancelled'
              : 'error',
        progress: Math.max(4, task.progress || 0),
        message: task.summary || '',
      });
    });

    state.updateDialogCancelHandler = null;
    setUpdateDialogLocked(false);
    patchUpdateDialog({ confirmText: '关闭', confirmDisabled: false, trackerMode: true, cancelHidden: true, cancelDisabled: false });
    if (state.openClawInstallView.pendingTask) {
      renderTrackedOpenClawDialog(state.openClawInstallView.pendingTask, { force: true });
    }

    if (finalTask.status === 'success') {
      flash(finalTask.version ? `OpenClaw 安装完成（${finalTask.version}）` : 'OpenClaw 安装完成', 'success');
      await refreshToolRuntimeAfterMutation('openclaw');
      updateTask(taskId, { status: 'done', progress: 100, message: finalTask.version ? `已安装 ${finalTask.version}` : '安装完成' });
      // Fire-and-forget — onboard flow runs in its own dialog
      runOpenClawOnboardFlow({ autoOpenDashboard: true }).catch(error => {
        flash(error.message || '自动启动 OpenClaw 初始化失败', 'error');
      });
    } else if (finalTask.status === 'cancelled') {
      flash(finalTask.error ? `安装已中断：${finalTask.error}` : 'OpenClaw 安装已中断并清理', finalTask.error ? 'error' : 'info');
      updateTask(taskId, { status: 'cancelled', progress: 100, message: finalTask.summary || '安装已中断' });
    } else {
      flash(finalTask.error || 'OpenClaw 安装失败', 'error');
      updateTask(taskId, { status: 'error', message: finalTask.error || '安装失败' });
    }
  } catch (e) {
    state.updateDialogCancelHandler = null;
    setUpdateDialogLocked(false);
    patchUpdateDialog({
      eyebrow: 'OpenClaw',
      title: '安装状态获取失败',
      body: `<div class="install-tracker-empty">${escapeHtml(e.message || '无法获取安装进度，请重试。')}</div>`,
      confirmText: '关闭',
      confirmDisabled: false,
      cancelHidden: true,
      trackerMode: true,
    });
    flash(e.message || '安装失败', 'error');
    updateTask(taskId, { status: 'error', message: e.message || '安装失败' });
  }
}

function switchOpenClawInstallScope(root, scope) {
  if (!root) return;
  const selected = scope === 'remote' ? 'remote' : 'local';
  root.querySelectorAll('[data-install-scope]').forEach((btn) => {
    const active = btn.dataset.installScope === selected;
    btn.classList.toggle('is-active', active);
  });
  root.querySelectorAll('[data-install-scope-panel]').forEach((panel) => {
    const active = panel.dataset.installScopePanel === selected;
    panel.classList.toggle('is-active', active);
  });
}

function syncRemoteAuthFields(root) {
  if (!root) return;
  const authSelect = root.querySelector('[data-remote-auth-method]');
  const authMethod = String(authSelect?.value || 'agent').toLowerCase();
  root.querySelectorAll('[data-remote-auth-extra]').forEach((row) => {
    const show = row.dataset.remoteAuthExtra === authMethod;
    row.hidden = !show;
  });
}

function readRemoteInstallPayload(root) {
  if (!root) throw new Error('安装面板未就绪，请重试');
  const host = String(root.querySelector('[data-remote-host]')?.value || '').trim();
  const port = String(root.querySelector('[data-remote-port]')?.value || '').trim() || '22';
  const username = String(root.querySelector('[data-remote-username]')?.value || '').trim();
  const remoteOs = String(root.querySelector('[data-remote-os]')?.value || 'unix').trim();
  const authMethod = String(root.querySelector('[data-remote-auth-method]')?.value || 'agent').trim();
  const password = String(root.querySelector('[data-remote-password]')?.value || '');
  const keyPath = String(root.querySelector('[data-remote-key-path]')?.value || '').trim();
  const installMethod = String(root.querySelector('[data-remote-install-method]')?.value || 'script').trim();

  if (!host) throw new Error('请填写远程服务器 IP 或域名');
  if (!username) throw new Error('请填写远程登录用户名');
  if (authMethod === 'password' && !password.trim()) throw new Error('密码登录需要填写密码');
  if (authMethod === 'key' && !keyPath) throw new Error('私钥登录需要填写私钥路径');

  return {
    host,
    port,
    username,
    remoteOs,
    authMethod,
    password,
    keyPath,
    installMethod,
  };
}

async function executeOpenClawRemoteInstall(trigger) {
  const root = trigger?.closest('.install-method-dialog');
  const payload = readRemoteInstallPayload(root);
  const target = `${payload.username}@${payload.host}:${payload.port || 22}`;
  const taskId = addTask('远程安装 OpenClaw', { progress: 14, message: `正在连接 ${target}…` });

  if (!state.updateDialogOpen) {
    void openUpdateDialog({
      eyebrow: 'OpenClaw',
      title: '远程安装中',
      body: `<div class="install-tracker-empty">正在连接服务器并执行安装…<br><code>${escapeHtml(target)}</code></div>`,
      confirmText: '安装中…',
      confirmOnly: true,
    });
  }

  setUpdateDialogLocked(true, '远程安装进行中，请等待完成');
  patchUpdateDialog({
    eyebrow: 'OpenClaw',
    title: '远程安装中',
    body: `<div class="install-tracker-empty">正在连接服务器并执行安装…<br><code>${escapeHtml(target)}</code></div>`,
    confirmText: '安装中…',
    confirmDisabled: true,
  });

  try {
    const json = await api('/api/openclaw/install/remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 180000,
    });
    if (!json.ok || !json.data?.ok) {
      throw new Error(json.error || json.data?.error || '远程安装失败');
    }

    setUpdateDialogLocked(false);
    patchUpdateDialog({
      eyebrow: 'OpenClaw',
      title: '远程安装完成',
      body: `
        <div class="install-tracker-empty">
          已完成远程安装：<code>${escapeHtml(json.data.remote?.target || target)}</code><br>
          ${json.data.version ? `远程版本：<code>${escapeHtml(json.data.version)}</code>` : '已执行安装命令，请在服务器运行 `openclaw --version` 复核。'}
        </div>
      `,
      confirmText: '关闭',
      confirmDisabled: false,
    });
    updateTask(taskId, {
      status: 'done',
      progress: 100,
      message: json.data.version ? `已安装 ${json.data.version}` : '远程安装命令已完成',
    });
    flash('远程服务器安装完成', 'success');
  } catch (error) {
    setUpdateDialogLocked(false);
    patchUpdateDialog({
      eyebrow: 'OpenClaw',
      title: '远程安装失败',
      body: `<div class="install-tracker-empty">${escapeHtml(error.message || '远程安装失败')}</div>`,
      confirmText: '关闭',
      confirmDisabled: false,
    });
    updateTask(taskId, { status: 'error', message: error.message || '远程安装失败' });
    flash(error.message || '远程安装失败', 'error');
  }
}

async function openClawInstallMethodDialog(btn) {
  const isWin = navigator.platform?.startsWith('Win');
  const _svg = (d) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const icoScript = _svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>');
  const icoNpm = _svg('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>');
  const icoSource = _svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>');
  const icoDocker = _svg('<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M12 7V3M7 7V5M17 7V5"/>');

  const body = `
    <div class="install-method-dialog">
      <div class="install-scope-switch">
        <button class="install-scope-btn is-active" data-install-scope="local">本地安装</button>
        <button class="install-scope-btn" data-install-scope="remote">远程服务器安装</button>
      </div>

      <div class="install-scope-panel is-active" data-install-scope-panel="local">
        <div class="install-scope-hint">${isWin ? 'Windows 推荐先试一键安装；如果你熟悉 Linux，再选 WSL2。' : '推荐先选本地安装，下面四种方式都可用。'}</div>
        ${isWin ? `
        <button class="install-method-opt" data-method="domestic">
          <span class="imo-icon">${icoNpm}</span>
          <div class="imo-content">
            <div class="imo-title">一键安装 <span class="imc-tag">默认推荐</span></div>
            <div class="imo-cmd">npm install -g openclaw@latest --registry=https://registry.npmmirror.com</div>
          </div>
        </button>
        <button class="install-method-opt" data-method="wsl">
          <span class="imo-icon">${icoScript}</span>
          <div class="imo-content">
            <div class="imo-title">高级 WSL2</div>
            <div class="imo-cmd">wsl -d Ubuntu-24.04 -- bash -lc "curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm"</div>
          </div>
        </button>
        <button class="install-method-opt" data-method="script">
          <span class="imo-icon">${icoScript}</span>
          <div class="imo-content">
            <div class="imo-title">官方脚本</div>
            <div class="imo-cmd">${escapeHtml(isWin ? "$env:OPENCLAW_NO_ONBOARD='1'; iwr -useb https://openclaw.ai/install.ps1 | iex" : 'curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm')}</div>
          </div>
        </button>` : `
        <button class="install-method-opt" data-method="script">
          <span class="imo-icon">${icoScript}</span>
          <div class="imo-content">
            <div class="imo-title">一键安装脚本 <span class="imc-tag">推荐</span></div>
            <div class="imo-cmd">${escapeHtml(isWin ? "$env:OPENCLAW_NO_ONBOARD='1'; iwr -useb https://openclaw.ai/install.ps1 | iex" : 'curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm')}</div>
          </div>
        </button>
        <button class="install-method-opt" data-method="npm">
          <span class="imo-icon">${icoNpm}</span>
          <div class="imo-content">
            <div class="imo-title">npm 全局安装</div>
            <div class="imo-cmd">npm install -g openclaw@latest</div>
          </div>
        </button>
        <button class="install-method-opt" data-method="source">
          <span class="imo-icon">${icoSource}</span>
          <div class="imo-content">
            <div class="imo-title">源码构建 <span class="imc-tag">开发者</span></div>
            <div class="imo-cmd">git clone + pnpm build</div>
          </div>
        </button>
        <button class="install-method-opt" data-method="docker">
          <span class="imo-icon">${icoDocker}</span>
          <div class="imo-content">
            <div class="imo-title">Docker 部署 <span class="imc-tag">服务器</span></div>
            <div class="imo-cmd">./docker-setup.sh</div>
          </div>
        </button>`}
      </div>

      <div class="install-scope-panel" data-install-scope-panel="remote">
        <div class="remote-install-form">
          <div class="remote-install-row two-col">
            <label>
              <span>服务器 IP / 域名</span>
              <input type="text" placeholder="例如 10.10.10.8 或 server.example.com" data-remote-host>
            </label>
            <label>
              <span>SSH 端口</span>
              <input type="text" value="22" data-remote-port>
            </label>
          </div>
          <div class="remote-install-row">
            <label>
              <span>用户名</span>
              <input type="text" placeholder="root / ubuntu / admin" data-remote-username>
            </label>
          </div>
          <div class="remote-install-row three-col">
            <label>
              <span>远程系统</span>
              <div class="select-wrap"><select data-remote-os>
                <option value="unix">Linux / macOS</option>
                <option value="windows">Windows</option>
              </select></div>
            </label>
            <label>
              <span>登录方式</span>
              <div class="select-wrap"><select data-remote-auth-method>
                <option value="agent">SSH Agent（推荐）</option>
                <option value="password">密码登录</option>
                <option value="key">私钥文件</option>
              </select></div>
            </label>
            <label>
              <span>安装方式</span>
              <div class="select-wrap"><select data-remote-install-method>
                <option value="script">官方脚本（推荐）</option>
                <option value="npm">npm 全局安装</option>
              </select></div>
            </label>
          </div>
          <div class="remote-install-row" data-remote-auth-extra="password" hidden>
            <label>
              <span>登录密码</span>
              <input type="password" placeholder="输入远程服务器密码" data-remote-password>
            </label>
          </div>
          <div class="remote-install-row" data-remote-auth-extra="key" hidden>
            <label>
              <span>私钥路径</span>
              <input type="text" placeholder="~/.ssh/id_ed25519" data-remote-key-path>
            </label>
          </div>
          <div class="remote-install-note">将通过 SSH 登录到远程服务器并执行安装命令。</div>
          <button class="remote-install-submit-btn" data-remote-openclaw-install>连接并安装 OpenClaw</button>
        </div>
      </div>
    </div>
  `;

  await openUpdateDialog({
    eyebrow: 'OpenClaw',
    title: '选择安装方式',
    body,
    confirmOnly: true,
    hideActions: true,
  });

  // Widen dialog panel for install content (fallback for :has())
  const panel = el('updateDialog')?.querySelector('.update-dialog-panel');
  if (panel) panel.classList.add('install-dialog-wide');

  // Upgrade selects in the remote panel to custom dropdowns
  requestAnimationFrame(() => {
    const dialogBody = el('updateDialogBody');
    if (dialogBody && window.initCustomSelect) {
      dialogBody.querySelectorAll('.select-wrap > select').forEach(s => window.initCustomSelect(s));
    }
  });
}

/* ── OpenClaw Uninstall Dialog (choice → progress → result) ── */
async function openClawUninstallDialog(btn) {
  const _svg = (d) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const icoKeep = _svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>');
  const icoPurge = _svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M9 11l6 6M15 11l-6 6"/>');
  const icoShield = _svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>');
  const icoWarning = _svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>');

  const body = `
    <div class="uninstall-choice-dialog">
      <div class="uninstall-choice-hint">
        <span class="ucd-hint-icon">${icoWarning}</span>
        <span>卸载后将无法从 EasyAIConfig 直接启动 OpenClaw。请选择卸载方式：</span>
      </div>
      <button class="uninstall-choice-opt" data-uninstall-mode="keep">
        <span class="uco-icon uco-icon-keep">${icoKeep}</span>
        <div class="uco-content">
          <div class="uco-title">${icoShield} 保留数据卸载</div>
          <div class="uco-desc">仅卸载 OpenClaw 程序本身。<strong>保留</strong>配置文件、数据和日志（~/.openclaw）。重新安装后可立即恢复。</div>
        </div>
      </button>
      <button class="uninstall-choice-opt uninstall-choice-danger" data-uninstall-mode="purge">
        <span class="uco-icon uco-icon-purge">${icoPurge}</span>
        <div class="uco-content">
          <div class="uco-title">${icoWarning} 完整卸载</div>
          <div class="uco-desc">卸载程序并<strong>删除所有数据</strong>，包括 ~/.openclaw 目录下的配置文件、Gateway Token、日志等。此操作不可撤销。</div>
        </div>
      </button>
    </div>
  `;

  await openUpdateDialog({
    eyebrow: 'OpenClaw',
    title: '卸载 OpenClaw',
    body,
    confirmText: '取消',
    confirmOnly: true,
    tone: 'danger',
  });
}

// Delegated click handler for uninstall mode choice
document.addEventListener('click', async (e) => {
  const opt = e.target.closest('[data-uninstall-mode]');
  if (!opt) return;
  const mode = opt.dataset.uninstallMode;
  const purge = mode === 'purge';

  // Close the choice dialog
  closeUpdateDialog(false);

  // Small delay for visual transition
  await new Promise(r => setTimeout(r, 200));

  // Show progress dialog
  const progressBody = `
    <div class="uninstall-progress-dialog">
      <div class="upd-status">
        <div class="upd-spinner">${SPINNER_SVG}</div>
        <span class="upd-label">${purge ? '正在卸载程序并清理数据…' : '正在卸载 OpenClaw…'}</span>
      </div>
      <div class="upd-bar-wrap">
        <div class="upd-bar-track">
          <div class="upd-bar-fill" id="uninstallProgressFill"></div>
        </div>
        <div class="upd-bar-pct" id="uninstallProgressPct">0%</div>
      </div>
      <div class="upd-detail" id="uninstallProgressDetail">准备卸载环境…</div>
    </div>
  `;

  void openUpdateDialog({
    eyebrow: 'OpenClaw',
    title: purge ? '完整卸载中…' : '卸载中…',
    body: progressBody,
    confirmText: '请等待…',
    confirmOnly: true,
    tone: 'default',
  });
  setUpdateDialogLocked(true, '卸载过程中请等待');
  el('updateDialogConfirmBtn').disabled = true;

  // Simulate progress animation
  let progress = 0;
  const fillEl = el('uninstallProgressFill');
  const pctEl = el('uninstallProgressPct');
  const detailEl = el('uninstallProgressDetail');
  const stages = purge
    ? [
        { pct: 15, text: '正在清理 ~/.openclaw 数据目录…' },
        { pct: 40, text: '正在删除配置文件和日志…' },
        { pct: 60, text: '正在卸载 npm 全局包…' },
        { pct: 80, text: '正在清理残留文件…' },
      ]
    : [
        { pct: 20, text: '正在查找 OpenClaw 安装位置…' },
        { pct: 50, text: '正在卸载 npm 全局包…' },
        { pct: 80, text: '正在验证卸载结果…' },
      ];

  function setProgress(pct, text) {
    progress = pct;
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (detailEl && text) detailEl.textContent = text;
  }

  // Animate through initial stages
  let stageIndex = 0;
  const progressTimer = setInterval(() => {
    if (stageIndex < stages.length) {
      const stage = stages[stageIndex];
      setProgress(stage.pct, stage.text);
      stageIndex++;
    }
  }, 600);

  // Execute the actual uninstall
  try {
    const json = await api('/api/openclaw/uninstall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purge }),
    });
    clearInterval(progressTimer);

    if (!json.ok) {
      // Error result
      setProgress(100, '');
      setUpdateDialogLocked(false);
      const errSvg = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
      patchUpdateDialog({
        title: '卸载失败',
        body: `
          <div class="uninstall-result-dialog">
            <div class="urd-icon urd-icon-error">${errSvg}</div>
            <div class="urd-title">卸载未完成</div>
            <div class="urd-desc">${escapeHtml(json.error || '未知错误')}</div>
          </div>
        `,
        confirmText: '关闭',
        tone: 'default',
      });
      el('updateDialogConfirmBtn').disabled = false;
      flash('OpenClaw 卸载失败', 'error');
    } else {
      // Success result
      setProgress(100, '卸载完成 ✓');
      await new Promise(r => setTimeout(r, 300));
      setUpdateDialogLocked(false);

      const okSvg = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>';
      patchUpdateDialog({
        title: '卸载完成',
        body: `
          <div class="uninstall-result-dialog">
            <div class="urd-icon">${okSvg}</div>
            <div class="urd-title">OpenClaw 已成功卸载</div>
            <div class="urd-desc">${purge ? '程序和所有数据（~/.openclaw）已被彻底清除。' : '程序已卸载，配置和数据（~/.openclaw）仍保留在本地。'}</div>
          </div>
        `,
        confirmText: '完成',
        tone: 'default',
      });
      el('updateDialogConfirmBtn').disabled = false;
      flash(purge ? 'OpenClaw 已完整卸载，数据已清除' : 'OpenClaw 已卸载，数据已保留', 'success');
      await refreshToolRuntimeAfterMutation('openclaw');
    }
  } catch (err) {
    clearInterval(progressTimer);
    setProgress(100, '');
    setUpdateDialogLocked(false);
    const errSvg = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    patchUpdateDialog({
      title: '卸载失败',
      body: `
        <div class="uninstall-result-dialog">
          <div class="urd-icon urd-icon-error">${errSvg}</div>
          <div class="urd-title">卸载过程中出错</div>
          <div class="urd-desc">${escapeHtml(err.message || '网络或系统错误')}</div>
        </div>
      `,
      confirmText: '关闭',
      tone: 'default',
    });
    el('updateDialogConfirmBtn').disabled = false;
    flash('OpenClaw 卸载出错', 'error');
  }
});

// Attach delegated listener for install method dialog
document.addEventListener('click', (e) => {
  const scopeBtn = e.target.closest('[data-install-scope]');
  if (!scopeBtn) return;
  const root = scopeBtn.closest('.install-method-dialog');
  switchOpenClawInstallScope(root, scopeBtn.dataset.installScope || 'local');
});

document.addEventListener('change', (e) => {
  const authSelect = e.target.closest('[data-remote-auth-method]');
  if (!authSelect) return;
  const root = authSelect.closest('.install-method-dialog');
  syncRemoteAuthFields(root);
});

document.addEventListener('click', async (e) => {
  const submitBtn = e.target.closest('[data-remote-openclaw-install]');
  if (!submitBtn) return;
  e.preventDefault();
  await executeOpenClawRemoteInstall(submitBtn);
});

document.addEventListener('click', async (e) => {
  const opt = e.target.closest('.install-method-opt[data-method]');
  if (!opt) return;
  const method = opt.dataset.method;
  closeUpdateDialog(false);
  await executeOpenClawInstall(method, opt);
});

document.addEventListener('click', async (e) => {
  const openClawCopyBtn = e.target.closest('[data-copy-openclaw-log]');
  const openCodeCopyBtn = e.target.closest('[data-copy-opencode-log]');
  if (!openClawCopyBtn && !openCodeCopyBtn) return;
  const text = openClawCopyBtn ? (state.openClawInstallView.lastLogsText || '') : (state.openCodeInstallView.lastLogsText || '');
  if (!text.trim()) {
    flash('当前还没有可复制的日志', 'info');
    return;
  }
  try {
    await copyText(text);
    flash('安装日志已复制', 'success');
  } catch {
    flash('复制失败，请手动选择日志', 'error');
  }
});

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.install-tracker-log')) return;
  state.openClawInstallView.pauseUntil = Date.now() + 15000;
  state.openCodeInstallView.pauseUntil = Date.now() + 15000;
});

let _pointerupRenderTimer = null;

document.addEventListener('pointerup', () => {
  if (_pointerupRenderTimer) clearTimeout(_pointerupRenderTimer);
  _pointerupRenderTimer = setTimeout(() => {
    _pointerupRenderTimer = null;
    if (state.openClawInstallView.pendingTask && !shouldPauseOpenClawInstallRender()) {
      renderTrackedOpenClawDialog(state.openClawInstallView.pendingTask, { force: true });
    }
    if (state.openCodeInstallView.pendingTask && !shouldPauseOpenCodeInstallRender()) {
      renderTrackedOpenCodeDialog(state.openCodeInstallView.pendingTask, { force: true });
    }
  }, 120);
});

document.addEventListener('wheel', (e) => {
  const logEl = e.target.closest?.('.install-tracker-log');
  if (!logEl) return;
  state.openClawInstallView.pauseUntil = Date.now() + 15000;
  state.openCodeInstallView.pauseUntil = Date.now() + 15000;
  if (logEl.scrollHeight <= logEl.clientHeight) return;
  const maxScrollTop = Math.max(0, logEl.scrollHeight - logEl.clientHeight);
  const nextScrollTop = Math.max(0, Math.min(maxScrollTop, logEl.scrollTop + e.deltaY));
  if (nextScrollTop === logEl.scrollTop) return;
  logEl.scrollTop = nextScrollTop;
  e.preventDefault();
  e.stopPropagation();
}, { passive: false });

document.addEventListener('click', async (e) => {
  const refreshBtn = e.target.closest('[data-openclaw-refresh-state]');
  if (!refreshBtn) return;
  try {
    const data = await fetchOpenClawStateData();
    const ctx = state.openClawSetupContext;
    if (ctx) {
      patchUpdateDialog({
        eyebrow: 'OpenClaw',
        title: data.gatewayReachable ? '初始化完成' : '后台初始化仍在进行',
        trackerMode: true,
        body: renderOpenClawSetupDialog({
          stateData: data,
          command: ctx.command,
          terminalMessage: ctx.terminalMessage,
          autoOpenDashboard: ctx.autoOpenDashboard,
          elapsedMs: Date.now() - ctx.startedAt,
        }),
      });
      syncOpenClawSetupDialogSurface();
    }
    await loadOpenClawQuickState();
    flash('OpenClaw 状态已刷新', 'success');
  } catch {
    flash('刷新 OpenClaw 状态失败', 'error');
  }
});

document.addEventListener('click', async (e) => {
  const dashboardBtn = e.target.closest('[data-openclaw-open-dashboard]');
  if (!dashboardBtn) return;
  try {
    const data = await fetchOpenClawStateData();
    if (!data.gatewayReachable) {
      flash('Dashboard 还没准备好，后台初始化完成后再试', 'info');
      return;
    }
    await repairOpenClawDashboard({ silent: true });
  } catch {
    flash('打开 Dashboard 失败', 'error');
  }
});


const PAGE_META = {
  quick: { eyebrow: 'QUICK SETUP', title: '一键配置', subtitle: '输入 URL 和 API Key，剩下交给 EasyAIConfig。' },
  providers: { eyebrow: 'Providers', title: 'Provider 与备份', subtitle: '集中查看已发现配置、检测状态与历史备份。' },
  console: { eyebrow: 'Console', title: '运行控制台', subtitle: '集中查看 Codex、Claude Code、OpenClaw 的运行状态、异常检测与快速修复入口。' },
  dashboard: { eyebrow: 'Dashboard', title: '数据看板', subtitle: '集中查看 Codex、Claude Code、OpenClaw 的状态、用量与趋势。' },
  tools: { eyebrow: 'Tools', title: '工具安装与管理', subtitle: '安装、更新、重装或卸载 AI 编程工具。' },
  tasks: { eyebrow: 'Tasks', title: '任务管理', subtitle: '查看当前进行中和历史安装任务。' },
  about: { eyebrow: 'About', title: '关于 EasyAIConfig', subtitle: '查看桌面版本、更新源与当前运行信息。' },
  systemSettings: { eyebrow: 'System', title: '系统设置', subtitle: '管理界面模式、存储占用、缓存清理与卸载操作。' },
  configEditor: { eyebrow: 'Current Config', title: '配置编辑', subtitle: '表单编辑 + 原始配置，选择工具后搜索预设方案快速配置。' },
};

const TOOL_CONSOLE_META = {
  codex: { label: 'Codex', actionLabel: 'Codex CLI' },
  claudecode: { label: 'Claude Code', actionLabel: 'Claude Code' },
  opencode: { label: 'OpenCode', actionLabel: 'OpenCode' },
  openclaw: { label: 'OpenClaw', actionLabel: 'OpenClaw' },
};

const OPENCLAW_CHANNEL_LABELS = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  wechat: '微信公众号',
  wechatWork: '企业微信',
  wechatwork: '企业微信',
  line: 'LINE',
  whatsapp: 'WhatsApp',
  matrix: 'Matrix',
  webhook: 'Webhook',
  signal: 'Signal',
  googlechat: 'Google Chat',
  imessage: 'iMessage',
  irc: 'IRC',
  msteams: 'Teams',
};

const DASHBOARD_AUTO_REFRESH_STORAGE_KEY = 'easyaiconfig_dashboard_auto_refresh_ms';
const DASHBOARD_AUTO_REFRESH_OPTIONS = [
  { value: 0, label: '关闭自动刷新' },
  { value: 5 * 60 * 1000, label: '5 分钟' },
  { value: 30 * 60 * 1000, label: '30 分钟' },
  { value: 60 * 60 * 1000, label: '60 分钟' },
];

function formatDashboardMetric(value, { compact = true } = {}) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '-';
  if (!compact || Math.abs(num) < 1000) return String(Math.round(num));
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: num >= 1_000_000_000 ? 2 : 1 }).format(num);
}

function formatDashboardMetricFull(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '-';
  return Math.round(num).toLocaleString('en-US');
}

function formatDashboardUpdatedAt(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `上次更新 ${date.toLocaleString()}`;
}

function stopDashboardAutoRefresh() {
  if (state.dashboardAutoRefreshTimer) {
    clearInterval(state.dashboardAutoRefreshTimer);
    state.dashboardAutoRefreshTimer = null;
  }
}

function startDashboardAutoRefresh() {
  stopDashboardAutoRefresh();
  if (!(Number(state.dashboardAutoRefreshMs) > 0)) return;
state.dashboardAutoRefreshTimer = setInterval(() => {
    if (state.activePage !== 'dashboard' || document.hidden) return;
    const tool = state.dashboardTool || 'codex';
    if (tool === 'claudecode') {
      ensureClaudeDashboardData().then(() => renderDashboardPage()).catch((e) => console.warn('[dashboardAutoRefresh] ensureClaudeDashboardData failed:', e));
      return;
    }
    if (isApiDashboardTool(tool)) {
      refreshDashboardData({ silent: true, tool }).catch((e) => console.warn('[dashboardAutoRefresh] refreshDashboardData failed:', e));
    }
  }, Number(state.dashboardAutoRefreshMs));
}

function renderDashboardAutoRefreshOptions() {
  const current = Number(state.dashboardAutoRefreshMs) || 0;
  return DASHBOARD_AUTO_REFRESH_OPTIONS
    .map((item) => `<option value="${item.value}" ${item.value === current ? 'selected' : ''}>${escapeHtml(item.label)}</option>`)
    .join('');
}

function getDashboardCodexHome() {
  return el('codexHomeInput')?.value?.trim() || state.current?.codexHome || '';
}

function isApiDashboardTool(tool = '') {
  return tool === 'codex' || tool === 'opencode';
}

function getDashboardMetricsForTool(tool = '') {
  return state.dashboardMetrics?.[tool] || null;
}

async function loadDashboardSideStates() {
  const tasks = [];
  if (!state.current) {
    tasks.push(loadState({ preserveForm: true }));
  }
  if (!state.claudeCodeState) {
    tasks.push(loadClaudeCodeQuickState({ force: false, cacheOnly: false }));
  }
  if (!state.openclawState) {
    tasks.push(loadOpenClawQuickState());
  }
  if (!tasks.length) return;
  await Promise.allSettled(tasks);
}

function formatDashboardMeta(value) {
  return typeof value === 'number' ? formatDashboardMetric(value) : String(value ?? '0');
}

function renderDashboardLoadingCard() {
  return `
    <div class="dashboard-grid dashboard-grid-single dashboard-grid-loading">
      <section class="dashboard-card dashboard-panel span-12 dashboard-loading-panel">
        <div class="dashboard-loading-copy">
          <div class="dashboard-loading-badge">快速统计中</div>
          <div class="dashboard-loading-text">正在读取本地统计缓存…</div>
        </div>
        <div class="dashboard-loading-title"></div>
        <div class="dashboard-loading-sub"></div>
        <div class="dashboard-loading-stats">
          ${Array.from({ length: 5 }, () => '<div class="dashboard-loading-stat"></div>').join('')}
        </div>
        <div class="dashboard-loading-chart"></div>
      </section>
    </div>`;
}

// ── Model Pricing ($ per 1M tokens) ──
const CODEX_MODEL_PRICING = {
  'gpt-5.4':           { input: 5.00,  output: 22.50, cached: 0.50,  label: 'GPT-5.4' },
  'gpt-5.3-codex':     { input: 1.75,  output: 14.00, cached: 0.175, label: 'GPT-5.3 Codex' },
  'gpt-5.2':           { input: 1.75,  output: 14.00, cached: 0.175, label: 'GPT-5.2' },
  'gpt-5.2-codex':     { input: 1.75,  output: 14.00, cached: 0.175, label: 'GPT-5.2 Codex' },
  'gpt-5.1-codex-max': { input: 1.25,  output: 10.00, cached: 0.125, label: 'GPT-5.1 Codex Max' },
  'gpt-5.1-codex':     { input: 1.25,  output: 10.00, cached: 0.125, label: 'GPT-5.1 Codex' },
  'gpt-5.1':           { input: 1.25,  output: 10.00, cached: 0.125, label: 'GPT-5.1' },
  'o3':                { input: 2.00,  output: 8.00,  cached: 0.50,  label: 'o3' },
  'o3-pro':            { input: 20.00, output: 80.00, cached: 2.50,  label: 'o3-pro' },
  'o3-mini':           { input: 1.10,  output: 4.40,  cached: 0.275, label: 'o3-mini' },
  'o4-mini':           { input: 1.10,  output: 4.40,  cached: 0.275, label: 'o4-mini' },
  'gpt-4.1':           { input: 2.00,  output: 8.00,  cached: 0.50,  label: 'GPT-4.1' },
  'gpt-4.1-mini':      { input: 0.40,  output: 1.60,  cached: 0.10,  label: 'GPT-4.1 Mini' },
  'gpt-4.1-nano':      { input: 0.10,  output: 0.40,  cached: 0.025, label: 'GPT-4.1 Nano' },
  'gpt-4o':            { input: 2.50,  output: 10.00, cached: 1.25,  label: 'GPT-4o' },
  'gpt-4o-mini':       { input: 0.15,  output: 0.60,  cached: 0.075, label: 'GPT-4o Mini' },
  // Anthropic Claude models
  'claude-opus-4-5':           { input: 15.00, output: 75.00, cached: 1.50,  label: 'Claude Opus 4.5' },
  'claude-opus-4-5-thinking':  { input: 15.00, output: 75.00, cached: 1.50,  label: 'Opus 4.5 Thinking' },
  'claude-opus-4-6':           { input: 15.00, output: 75.00, cached: 1.50,  label: 'Claude Opus 4.6' },
  'claude-opus-4.6':           { input: 15.00, output: 75.00, cached: 1.50,  label: 'Claude Opus 4.6' },
  'claude-sonnet-4-5':         { input: 3.00,  output: 15.00, cached: 0.30,  label: 'Claude Sonnet 4.5' },
  'claude-sonnet-4-5-thinking':{ input: 3.00,  output: 15.00, cached: 0.30,  label: 'Sonnet 4.5 Thinking' },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00, cached: 0.30,  label: 'Claude Sonnet 4.6' },
  'claude-haiku-3-5':          { input: 0.80,  output: 4.00,  cached: 0.08,  label: 'Claude Haiku 3.5' },
  'claude-haiku-4':            { input: 0.80,  output: 4.00,  cached: 0.08,  label: 'Claude Haiku 4' },
};

function lookupModelPricingEntry(modelName) {
  const name = String(modelName || '').trim().toLowerCase();
  if (!name || name === 'unknown') return null;
  if (CODEX_MODEL_PRICING[name]) return { key: name, pricing: CODEX_MODEL_PRICING[name] };
  const keys = Object.keys(CODEX_MODEL_PRICING).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (name.startsWith(key)) return { key, pricing: CODEX_MODEL_PRICING[key] };
  }
  return null;
}

function lookupModelPricing(modelName) {
  return lookupModelPricingEntry(modelName)?.pricing || null;
}

function formatDashboardUsd(value, { min = 2, max = 4 } = {}) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '–';
  return '$' + num.toLocaleString('en-US', {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  });
}

function calcModelCost(modelEntry) {
  const pricing = lookupModelPricing(modelEntry.model);
  if (!pricing) return null;
  const inp = (modelEntry.totals?.input || 0) / 1e6;
  const out = (modelEntry.totals?.output || 0) / 1e6;
  const cachedRead = (modelEntry.totals?.cachedInput || modelEntry.totals?.cacheRead || 0) / 1e6;
  const cacheWrite = (modelEntry.totals?.cacheCreation || 0) / 1e6;
  const reasoning = (modelEntry.totals?.reasoning || 0) / 1e6;
  const inputCost = inp * pricing.input;
  const outputCost = (out + reasoning) * pricing.output;
  const cachedReadCost = cachedRead * pricing.cached;
  const cacheWriteCost = cacheWrite * (pricing.input * 1.25);
  const totalCost = inputCost + outputCost + cachedReadCost + cacheWriteCost;
  return { inputCost, outputCost, cachedReadCost, cacheWriteCost, totalCost, pricing };
}

function renderPricingStandardsCards(models = [], preferredKeys = []) {
  const detectedKeys = new Set(
    (models || [])
      .map((entry) => lookupModelPricingEntry(entry.model)?.key)
      .filter(Boolean)
  );
  const keys = [...new Set([...(preferredKeys || []), ...detectedKeys])].filter((key) => CODEX_MODEL_PRICING[key]).slice(0, 6);
  if (!keys.length) return '<div class="db2-empty">暂无可识别的官方计费标准。</div>';
  return `
    <div class="db3-standards-note">单位：USD / 1M tokens。缓存写入按输入单价 1.25x 估算。</div>
    <div class="db3-standards-list">
      ${keys.map((key) => {
        const pricing = CODEX_MODEL_PRICING[key];
        const detected = detectedKeys.has(key);
        return `<article class="db3-standard-card ${detected ? 'is-detected' : ''}">
          <div class="db3-standard-head">
            <div class="db3-standard-copy">
              <div class="db3-standard-name">${escapeHtml(pricing.label)}</div>
              <div class="db3-standard-key">${escapeHtml(key)}</div>
            </div>
            <span class="db3-standard-chip ${detected ? 'is-live' : ''}">${detected ? '已检测' : '未检测'}</span>
          </div>
          <div class="db3-standard-rates">
            <span>输入 ${escapeHtml(formatDashboardUsd(pricing.input, { min: pricing.input < 1 ? 3 : 2, max: 3 }))}</span>
            <span>输出 ${escapeHtml(formatDashboardUsd(pricing.output, { min: pricing.output < 1 ? 3 : 2, max: 3 }))}</span>
            <span>缓存 ${escapeHtml(formatDashboardUsd(pricing.cached, { min: pricing.cached < 1 ? 3 : 2, max: 3 }))}</span>
          </div>
        </article>`;
      }).join('')}
    </div>`;
}

function renderModelCostRows(models = [], totalTokens = 0) {
  if (!models.length) return '<div class="db2-empty">暂无模型计费数据。</div>';
  const totals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cachedRead: 0,
    cacheWrite: 0,
    totalCost: 0,
    matched: 0,
  };
  const rows = models.map((entry) => {
    const cost = calcModelCost(entry);
    const pricingEntry = lookupModelPricingEntry(entry.model);
    const tokens = entry.totals?.total || 0;
    const input = entry.totals?.input || 0;
    const output = entry.totals?.output || 0;
    const reasoning = entry.totals?.reasoning || 0;
    const cachedRead = entry.totals?.cachedInput || entry.totals?.cacheRead || 0;
    const cacheWrite = entry.totals?.cacheCreation || 0;
    const pct = totalTokens ? Math.round(tokens / totalTokens * 100) : 0;
    const modelLabel = cost?.pricing?.label || pricingEntry?.pricing?.label || entry.model;

    totals.input += input;
    totals.output += output;
    totals.reasoning += reasoning;
    totals.cachedRead += cachedRead;
    totals.cacheWrite += cacheWrite;
    if (cost) {
      totals.totalCost += cost.totalCost;
      totals.matched += 1;
    }

    const rateChips = pricingEntry
      ? `<div class="db3-price-rates db3-price-rates--matrix">
          <span class="db3-price-rate"><em>IN</em><strong>${escapeHtml(formatDashboardUsd(pricingEntry.pricing.input, { min: pricingEntry.pricing.input < 1 ? 3 : 2, max: 3 }))}</strong></span>
          <span class="db3-price-rate"><em>OUT</em><strong>${escapeHtml(formatDashboardUsd(pricingEntry.pricing.output, { min: pricingEntry.pricing.output < 1 ? 3 : 2, max: 3 }))}</strong></span>
          <span class="db3-price-rate"><em>CACHE</em><strong>${escapeHtml(formatDashboardUsd(pricingEntry.pricing.cached, { min: pricingEntry.pricing.cached < 1 ? 3 : 2, max: 3 }))}</strong></span>
        </div>`
      : '<div class="db3-price-rates db3-price-rates--na"><span>未匹配官方定价</span></div>';

    return `<div class="db3-price-row">
      <div class="db3-price-model-cell">
        <div class="db3-price-model-main">${escapeHtml(modelLabel)}</div>
        <div class="db3-price-model-meta">
          <span>${pct}% 占比</span>
          <span>${cost ? '已估算' : '待补齐映射'}</span>
        </div>
        ${modelLabel !== entry.model ? `<div class="db3-price-model-raw" title="${escapeHtml(entry.model)}">${escapeHtml(entry.model)}</div>` : ''}
      </div>
      <div class="db3-price-metric" title="${escapeHtml(formatDashboardMetricFull(input))}">
        <strong>${escapeHtml(formatDashboardMetric(input))}</strong>
        <span>输入</span>
      </div>
      <div class="db3-price-metric" title="${escapeHtml(formatDashboardMetricFull(output + reasoning))}">
        <strong>${escapeHtml(formatDashboardMetric(output + reasoning))}</strong>
        <span>${reasoning ? `推理 ${escapeHtml(formatDashboardMetric(reasoning))}` : '输出'}</span>
      </div>
      <div class="db3-price-metric" title="${escapeHtml(formatDashboardMetricFull(cachedRead))}">
        <strong>${escapeHtml(formatDashboardMetric(cachedRead))}</strong>
        <span>${cacheWrite ? `写 ${escapeHtml(formatDashboardMetric(cacheWrite))}` : '缓存读'}</span>
      </div>
      <div class="db3-price-rate-cell">${rateChips}</div>
      <div class="db3-price-total ${cost ? '' : 'db3-price-total--na'}">
        <strong>${escapeHtml(cost ? formatDashboardUsd(cost.totalCost, { min: 4, max: 4 }) : '–')}</strong>
        <span>${escapeHtml(cost ? `写入 ${formatDashboardUsd(cost.cacheWriteCost, { min: 4, max: 4 })}` : '无可用估算')}</span>
      </div>
    </div>`;
  });
  rows.push(`<div class="db3-price-row db3-price-row--total">
    <div class="db3-price-model-cell">
      <div class="db3-price-model-main">合计</div>
      <div class="db3-price-model-meta">
        <span>${totals.matched}/${models.length} 个模型已匹配定价</span>
      </div>
    </div>
    <div class="db3-price-metric">
      <strong>${escapeHtml(formatDashboardMetric(totals.input))}</strong>
      <span>输入</span>
    </div>
    <div class="db3-price-metric">
      <strong>${escapeHtml(formatDashboardMetric(totals.output + totals.reasoning))}</strong>
      <span>${totals.reasoning ? `推理 ${escapeHtml(formatDashboardMetric(totals.reasoning))}` : '输出'}</span>
    </div>
    <div class="db3-price-metric">
      <strong>${escapeHtml(formatDashboardMetric(totals.cachedRead))}</strong>
      <span>${totals.cacheWrite ? `写 ${escapeHtml(formatDashboardMetric(totals.cacheWrite))}` : '缓存读'}</span>
    </div>
    <div class="db3-price-rate-cell">
      <div class="db3-price-rates db3-price-rates--summary">
        <span>${escapeHtml(formatDashboardMetric(totalTokens))} total</span>
      </div>
    </div>
    <div class="db3-price-total">
      <strong>${escapeHtml(totals.totalCost ? formatDashboardUsd(totals.totalCost, { min: 4, max: 4 }) : '–')}</strong>
      <span>累计估算</span>
    </div>
  </div>`);
  return `<div class="db3-price-table">
    <div class="db3-price-grid">
      <div class="db3-price-row db3-price-row--head">
        <div>模型</div>
        <div>输入</div>
        <div>输出 / 推理</div>
        <div>缓存</div>
        <div>计费标准</div>
        <div>预估费用</div>
      </div>
      ${rows.join('')}
    </div>
  </div>`;
}

function renderDashboardPage() {
  const root = el('dashboardPage');
  if (!root) return;

  const codex = state.current || {};
  const claude = state.claudeCodeState || {};
  const openclaw = state.openclawState || {};
  const codexMetrics = state.dashboardMetrics.codex || { totals: { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 }, daily: [], providers: [], sessions: [], models: [] };
  const opencodeMetrics = state.dashboardMetrics.opencode || { totals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheCreation: 0, total: 0, cost: 0 }, daily: [], providers: [], sessions: [], models: [] };
  const openclawChannels = getOpenClawConsoleChannels(openclaw.config || {});
  const openclawProviders = getOpenClawConsoleProviders(openclaw.config || {});
  const dashboardTool = state.dashboardTool || 'codex';
  const isLoading = Boolean(state.dashboardLoading);
  const hasCodexMetrics = Boolean(state.dashboardMetrics.codex);
  const hasOpenCodeMetrics = Boolean(state.dashboardMetrics.opencode);
  const lastUpdated = formatDashboardUpdatedAt(codexMetrics.generatedAt);
  const opencodeLastUpdated = formatDashboardUpdatedAt(opencodeMetrics.generatedAt);
  const claudeLastUpdated = formatDashboardUpdatedAt(claude.usage?.generatedAt);
  const showDashboardRefresh = dashboardTool === 'codex' || dashboardTool === 'claudecode' || dashboardTool === 'opencode';
  const daysWindow = state.dashboardDays || 30;
  const dashboardStatusText = dashboardTool === 'claudecode'
    ? (isLoading ? '正在统计本地 Claude Code token…' : (claudeLastUpdated || '统计已完成'))
    : dashboardTool === 'opencode'
      ? (isLoading ? '正在统计本地 OpenCode token…' : (opencodeLastUpdated || '统计已完成'))
      : (isLoading ? '正在统计本地 Codex token…' : (lastUpdated || '统计已完成'));

  const tabs = [
    { key: 'codex', label: 'Codex', dot: '#4ade80', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 9l3 3-3 3M15 15h3"/></svg>' },
    { key: 'claudecode', label: 'Claude Code', dot: '#4ade80', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 3"/></svg>' },
    { key: 'opencode', label: 'OpenCode', dot: '#60a5fa', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l8-4 8 4v10l-8 4-8-4z"/><path d="M12 3v18M4 7l8 4 8-4"/></svg>' },
    { key: 'openclaw', label: 'OpenClaw', dot: '#fbbf24', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></svg>' },
  ];
  const toolLabel = (tabs.find((t) => t.key === dashboardTool) || tabs[0]).label;
  if (el('pageTitle')) el('pageTitle').textContent = '数据看板';
  if (el('pageSubtitle')) {
    el('pageSubtitle').textContent = dashboardTool === 'openclaw'
      ? `${toolLabel} · Gateway、渠道与 Provider 状态`
      : `${toolLabel} · ${dashboardStatusText} · 最近 ${daysWindow} 天`;
  }

  // ── Stat strip ──
  const statStrip = (items = []) => `
    <div class="db2-stat-cards">
      ${items.map(({ label, value, sub, accent, isCost }) => `
        <div class="db2-stat-card ${accent ? 'db2-stat-card--accent' : ''} ${isCost ? 'db2-stat-card--cost' : ''}">
          <div class="db2-sc-label">${escapeHtml(label)}</div>
          <div class="db2-sc-value">${escapeHtml(String(value))}</div>
          ${sub ? `<div class="db2-sc-sub">${escapeHtml(String(sub))}</div>` : ''}
        </div>
      `).join('')}
    </div>`;
  const heroStatsHtml = (stats) => `
    <div class="db3-hero-stats">
      ${stats.map((s) => `
        <div class="db3-hero-stat ${s.emphasis ? 'db3-hero-stat-emph' : ''}">
          <div class="db3-hero-value">${escapeHtml(String(s.value))}</div>
          <div class="db3-hero-label">${escapeHtml(s.label)}</div>
        </div>`).join('')}
    </div>`;

  // ── Mini bar list ──
  const miniBars = (items = []) => `
    <div class="dashboard-mini-bars">
      ${items.map((item) => {
        const rawWidth = Math.min(100, Number(item.value || 0));
        const width = rawWidth > 0 ? Math.max(4, rawWidth) : 0;
        const meta = formatDashboardMeta(item.meta ?? item.value ?? 0);
        const fullMeta = typeof (item.meta ?? item.value) === 'number' ? formatDashboardMetricFull(item.meta ?? item.value) : meta;
        return `<div class="dashboard-mini-bar"><span>${escapeHtml(item.label)}</span><div class="dashboard-mini-bar-track"><div class="dashboard-mini-bar-fill" style="width:${width}%"></div></div><strong title="${escapeHtml(fullMeta)}">${escapeHtml(meta)}</strong></div>`;
      }).join('')}
    </div>`;

  // ── Key-Value list ──
  const kvList = (rows = []) => `
    <div class="db2-kv-list">
      ${rows.map(({ label, value, accent }) => `
        <div class="db2-kv-row">
          <span class="db2-kv-label">${escapeHtml(label)}</span>
          <span class="db2-kv-value ${accent ? 'db2-kv-value--accent' : ''}">${escapeHtml(String(value))}</span>
        </div>
      `).join('')}
    </div>`;

  // ── Codex Token percentage bar ──
  // ── Filter daily data by calendar date cutoff ──
  const codexCutoff = new Date(Date.now() - daysWindow * 86400000).toISOString().slice(0, 10);
  const codexDaily = (codexMetrics.daily || []).filter(d => (d.date || '') >= codexCutoff);

  // Recompute totals from the sliced window
  const codexTotal = codexDaily.reduce((s, d) => s + (d.total || 0), 0);
  const codexInput = codexDaily.reduce((s, d) => s + (d.input || 0), 0);
  const codexOutput = codexDaily.reduce((s, d) => s + (d.output || 0), 0);
  const codexCached = codexDaily.reduce((s, d) => s + (d.cachedInput || 0), 0);
  const codexReasoning = codexDaily.reduce((s, d) => s + (d.reasoning || 0), 0);
  const codexModels = codexMetrics.models || [];
  const codexModelTotal = codexModels.reduce((sum, entry) => sum + (entry.totals?.total || 0), 0);
  
  const codexTotalCost = codexModels.reduce((sum, entry) => {
    const cost = calcModelCost(entry);
    // Scale cost proportionally to the window
    const allTotal = codexMetrics.totals?.total || 1;
    const windowShare = codexTotal / allTotal;
    return sum + (cost ? cost.totalCost * windowShare : 0);
  }, 0);

  const codexCacheHitPct = codexTotal ? Math.round(codexCached / codexTotal * 100) : 0;
  const codexInputPct = codexTotal ? Math.round(codexInput / codexTotal * 100) : 0;
  const codexTopModel = codexModels[0] ? (lookupModelPricingEntry(codexModels[0].model)?.pricing?.label || codexModels[0].model) : '—';
  const codexHeroStats = [
    { label: '本期消耗 · USD', value: codexTotalCost ? formatDashboardUsd(codexTotalCost, { min: 2, max: 2 }) : '$0.00', emphasis: true },
    { label: '总 Token', value: formatDashboardMetric(codexTotal) },
    { label: codexReasoning ? '输出 / 推理' : '输出 Token', value: formatDashboardMetric(codexOutput + codexReasoning) },
    { label: '缓存读取率', value: codexTotal ? `${codexCacheHitPct}%` : '—' },
  ];
  const codexBreakdownItems = [
    { label: '输入', value: codexInputPct, meta: codexInput },
    { label: '输出', value: codexTotal ? Math.round(codexOutput / codexTotal * 100) : 0, meta: codexOutput },
    { label: '缓存', value: codexCacheHitPct, meta: codexCached },
    { label: '推理', value: codexTotal ? Math.round(codexReasoning / codexTotal * 100) : 0, meta: codexReasoning },
  ];

  const codexHtml = (!hasCodexMetrics && isLoading) ? renderDashboardLoadingCard() : `
    <div class="db2-layout">
      <section class="db3-hero db3-hero--codex">
        ${heroStatsHtml(codexHeroStats)}
        <div class="db3-hero-chart-wrap">
          <div class="db3-hero-chart-head">
            <span class="db3-hero-chart-title">Token 用量趋势</span>
            <span class="db3-hero-chart-meta">近 ${daysWindow} 天 · ${codexModels.length} 个模型 · ${escapeHtml(codexTopModel)}</span>
          </div>
          ${renderDashboardInteractiveChart(codexDaily.map((item) => ({ label: item.date.slice(5), value: item.total || 0, input: item.input || 0, output: item.output || 0, cached: item.cachedInput || 0 })), { stroke: '#5b8cff', showCost: true, models: codexModels })}
        </div>
      </section>

      <div class="db3-dashboard-grid">
        <section class="db2-section db3-panel">
          <div class="db2-card-head">
          <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1.5v13M11.5 4.5H6.25a2.25 2.25 0 1 0 0 4.5H9.75a2.25 2.25 0 0 1 0 4.5H4"/></svg>
              GPT 计费标准
            </div>
            <div class="db2-card-meta">GPT-5.4 / GPT-5.3 Codex 检测结果</div>
          </div>
          ${renderPricingStandardsCards(codexModels, ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex'])}
        </section>

        <section class="db2-section db3-panel db3-panel--wide">
          <div class="db2-card-head">
            <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 6h4M6 8h4M6 10h2"/></svg>
              模型计费明细
            </div>
            <div class="db2-card-meta">按 OpenAI 官方定价估算 · 单位 USD / 1M tokens</div>
          </div>
          ${renderModelCostRows(codexModels, codexModelTotal)}
        </section>

        <section class="db2-section db3-panel">
          <div class="db2-card-head">
            <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10.5h12M3.5 8.5l2-2 2.5 2 4.5-4"/></svg>
              Token 构成
            </div>
            <div class="db2-card-meta">输入 / 输出 / 缓存 / 推理</div>
          </div>
          ${miniBars(codexBreakdownItems)}
        </section>

        <section class="db2-section db3-panel">
          <div class="db2-card-head">
            <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1.5v13M11.5 4.5H6.25a2.25 2.25 0 1 0 0 4.5H9.75a2.25 2.25 0 0 1 0 4.5H4"/></svg>
              费用趋势
            </div>
            <div class="db2-card-meta">每日预估消耗</div>
          </div>
          ${renderDashboardCostTrendChart(codexDaily, codexModels)}
        </section>

        <section class="db2-section db3-panel">
          <div class="db2-card-head">
            <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5l6-3 6 3v6l-6 3-6-3z"/><path d="M2 5l6 3m0 6V8m6-3l-6 3"/></svg>
              模型分布
            </div>
            <div class="db2-card-meta">累计扫描 ${codexModels.length} 个模型</div>
          </div>
          ${renderDashboardModelDistChart(codexModels, codexModelTotal)}
        </section>
      </div>
    </div>`;

  const opencodeCutoff = new Date(Date.now() - daysWindow * 86400000).toISOString().slice(0, 10);
  const opencodeDaily = (opencodeMetrics.daily || []).filter((d) => (d.date || '') >= opencodeCutoff);
  const opencodeTotal = opencodeDaily.reduce((sum, item) => sum + (item.total || 0), 0);
  const opencodeInput = opencodeDaily.reduce((sum, item) => sum + (item.input || 0), 0);
  const opencodeOutput = opencodeDaily.reduce((sum, item) => sum + (item.output || 0), 0);
  const opencodeReasoning = opencodeDaily.reduce((sum, item) => sum + (item.reasoning || 0), 0);
  const opencodeCacheRead = opencodeDaily.reduce((sum, item) => sum + (item.cacheRead || 0), 0);
  const opencodeCacheWrite = opencodeDaily.reduce((sum, item) => sum + (item.cacheCreation || 0), 0);
  const opencodeCost = opencodeDaily.reduce((sum, item) => sum + (item.cost || 0), 0);
  const opencodeModels = opencodeMetrics.models || [];
  const opencodeModelTotal = opencodeModels.reduce((sum, entry) => sum + (entry.totals?.total || 0), 0);
  const opencodeTopModel = opencodeModels[0]
    ? (lookupModelPricingEntry(opencodeModels[0].model)?.pricing?.label || opencodeModels[0].model)
    : '—';
  const opencodeCacheHitPct = opencodeTotal ? Math.round(opencodeCacheRead / opencodeTotal * 100) : 0;
  const opencodeHeroStats = [
    { label: '本期消耗 · USD', value: opencodeCost ? formatDashboardUsd(opencodeCost, { min: 2, max: 4 }) : '$0.00', emphasis: true },
    { label: '总 Token', value: formatDashboardMetric(opencodeTotal) },
    { label: opencodeReasoning ? '输出 / 推理' : '输出 Token', value: formatDashboardMetric(opencodeOutput + opencodeReasoning) },
    { label: '缓存读取率', value: opencodeTotal ? `${opencodeCacheHitPct}%` : '—' },
  ];
  const opencodeBreakdownItems = [
    { label: '输入', value: opencodeTotal ? Math.round(opencodeInput / opencodeTotal * 100) : 0, meta: opencodeInput },
    { label: '输出', value: opencodeTotal ? Math.round(opencodeOutput / opencodeTotal * 100) : 0, meta: opencodeOutput },
    { label: '推理', value: opencodeTotal ? Math.round(opencodeReasoning / opencodeTotal * 100) : 0, meta: opencodeReasoning },
    { label: '缓存读', value: opencodeTotal ? Math.round(opencodeCacheRead / opencodeTotal * 100) : 0, meta: opencodeCacheRead },
    { label: '缓存写', value: opencodeTotal ? Math.round(opencodeCacheWrite / opencodeTotal * 100) : 0, meta: opencodeCacheWrite },
  ];

  const opencodeHtml = (!hasOpenCodeMetrics && isLoading) ? renderDashboardLoadingCard() : `
    <div class="db2-layout">
      <section class="db3-hero db3-hero--codex">
        ${heroStatsHtml(opencodeHeroStats)}
        <div class="db3-hero-chart-wrap">
          <div class="db3-hero-chart-head">
            <span class="db3-hero-chart-title">Token 用量趋势</span>
            <span class="db3-hero-chart-meta">近 ${daysWindow} 天 · ${opencodeModels.length} 个模型 · ${escapeHtml(opencodeTopModel)}</span>
          </div>
          ${renderDashboardInteractiveChart(opencodeDaily.map((item) => ({ label: item.date.slice(5), value: item.total || 0, input: item.input || 0, output: (item.output || 0) + (item.reasoning || 0), cached: item.cacheRead || 0 })), { stroke: '#6b86ff' })}
        </div>
      </section>

      <div class="db3-dashboard-grid">
        <section class="db2-section db3-panel">
          <div class="db2-card-head">
            <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1.5v13M11.5 4.5H6.25a2.25 2.25 0 1 0 0 4.5H9.75a2.25 2.25 0 0 1 0 4.5H4"/></svg>
              官方计费标准
            </div>
            <div class="db2-card-meta">按已检测模型匹配 OpenAI / Anthropic 官方价目</div>
          </div>
          ${renderPricingStandardsCards(opencodeModels, ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex'])}
        </section>

        <section class="db2-section db3-panel db3-panel--wide">
          <div class="db2-card-head">
            <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 6h4M6 8h4M6 10h2"/></svg>
              模型计费明细
            </div>
            <div class="db2-card-meta">本地会话 token 统计 + 官方价目映射</div>
          </div>
          ${renderModelCostRows(opencodeModels, opencodeModelTotal)}
        </section>

        <section class="db2-section db3-panel">
          <div class="db2-card-head">
            <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10.5h12M3.5 8.5l2-2 2.5 2 4.5-4"/></svg>
              Token 构成
            </div>
            <div class="db2-card-meta">输入 / 输出 / 推理 / 缓存读写</div>
          </div>
          ${miniBars(opencodeBreakdownItems)}
        </section>

        <section class="db2-section db3-panel">
          <div class="db2-card-head">
            <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1.5v13M11.5 4.5H6.25a2.25 2.25 0 1 0 0 4.5H9.75a2.25 2.25 0 0 1 0 4.5H4"/></svg>
              费用趋势
            </div>
            <div class="db2-card-meta">来自 OpenCode 本地会话的实际 cost 字段</div>
          </div>
          ${renderCostTrendPanel(opencodeDaily.map((item) => ({ label: (item.date || '').slice(5), value: item.cost || 0 })), `近 ${daysWindow} 天合计`, 'background:linear-gradient(180deg,#d6deff 0%,#6b86ff 56%,#3558ff 100%)')}
        </section>

        <section class="db2-section db3-panel">
          <div class="db2-card-head">
            <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5l6-3 6 3v6l-6 3-6-3z"/><path d="M2 5l6 3m0 6V8m6-3l-6 3"/></svg>
              模型分布
            </div>
            <div class="db2-card-meta">累计扫描 ${opencodeModels.length} 个模型</div>
          </div>
          ${renderDashboardModelDistChart(opencodeModels, opencodeModelTotal)}
        </section>
      </div>
    </div>`;

  // ── Claude Code HTML ──
  const claudeAllTotal = claude.usage?.totals?.total || 0;
  const claudeAllInput = claude.usage?.totals?.input || 0;
  const claudeAllOutput = claude.usage?.totals?.output || 0;
  const claudeAllCacheRead = claude.usage?.totals?.cacheRead || 0;
  const claudeAllCacheCreate = claude.usage?.totals?.cacheCreation || 0;
  const claudeAllCost = claude.usage?.totals?.cost || 0;
  const claudeOfficialCost = claude.usage?.officialCost || 0;
  const claudeAllModels = claude.usage?.models || [];
  const claudeDaily = claude.usage?.daily || [];
  const claudeDailyModelTokens = claude.usage?.dailyModelTokens || [];

  // Filter by actual calendar date cutoff
  const claudeCutoff = new Date(Date.now() - daysWindow * 86400000).toISOString().slice(0, 10);
  const claudeDailySliced = claudeDaily.filter(d => (d.date || '') >= claudeCutoff);

  // Windowed totals from filtered daily data (no fallback — show 0 if no activity in window)
  const ct = {
    total: claudeDailySliced.reduce((s, d) => s + (d.total || 0), 0),
    input: claudeDailySliced.reduce((s, d) => s + (d.input || 0), 0),
    output: claudeDailySliced.reduce((s, d) => s + (d.output || 0), 0),
    cacheRead: claudeDailySliced.reduce((s, d) => s + (d.cacheRead || 0), 0),
    cacheCreate: claudeDailySliced.reduce((s, d) => s + (d.cacheCreation || 0), 0),
    cost: claudeDailySliced.reduce((s, d) => s + (d.cost || 0), 0),
  };

  // ── Compute windowed model distribution from dailyModelTokens ──
  const claudeWindowedDMT = claudeDailyModelTokens.filter(d => (d.date || '') >= claudeCutoff);
  let claudeModels;
  if (claudeWindowedDMT.length > 0) {
    const modelMap = {};
    claudeWindowedDMT.forEach(entry => {
      const byModel = entry.tokensByModel || {};
      for (const [model, tokens] of Object.entries(byModel)) {
        if (!modelMap[model]) modelMap[model] = 0;
        modelMap[model] += tokens;
      }
    });
    claudeModels = Object.entries(modelMap)
      .map(([model, total]) => ({ model, totals: { total, input: Math.round(total * 0.85), output: Math.round(total * 0.15) } }))
      .sort((a, b) => b.totals.total - a.totals.total);
  } else {
    claudeModels = claudeAllModels;
  }
  const claudeModelTotal = claudeModels.reduce((s, m) => s + (m.totals?.total || 0), 0);

  // ── New Hero (Claude Code) ───────────────────────────────────
  const claudeCacheHitPct = ct.total ? Math.round(ct.cacheRead / ct.total * 100) : 0;
  const claudeHeroStats = [
    { key: 'cost',   label: '本期消耗 · USD', value: ct.cost ? '$' + ct.cost.toFixed(2) : '$0.00', emphasis: true },
    { key: 'total',  label: '总 TOKEN',        value: formatDashboardMetric(ct.total) },
    { key: 'output', label: '输出',             value: formatDashboardMetric(ct.output) },
    { key: 'cache',  label: '缓存读取率',       value: ct.total ? claudeCacheHitPct + '%' : '—' },
  ];

  // Build filled series once so the hero chart + subsequent renders share it.
  const claudeFilledSeries = (() => {
    const dailyMap = {};
    claudeDailySliced.forEach((d) => { if (d.date) dailyMap[d.date] = d; });
    const out = [];
    for (let i = daysWindow - 1; i >= 0; i--) {
      const dt = new Date(Date.now() - i * 86400000);
      const key = dt.toISOString().slice(0, 10);
      const d = dailyMap[key] || {};
      out.push({ label: key.slice(5), value: d.total || 0, input: d.input || 0, output: d.output || 0, cached: d.cacheRead || 0 });
    }
    return out;
  })();

  const claudeHtml = `
    <div class="db2-layout">

      <!-- HERO · 4 指标 + 主体折线图 -->
      <section class="db3-hero">
        ${heroStatsHtml(claudeHeroStats)}
        <div class="db3-hero-chart-wrap">
          <div class="db3-hero-chart-head">
            <span class="db3-hero-chart-title">Token 用量趋势</span>
            <span class="db3-hero-chart-meta">近 ${daysWindow} 天 · 悬停看当日详情</span>
          </div>
          ${renderDashboardInteractiveChart(claudeFilledSeries, { stroke: '#7c3aed', showCost: true, models: claudeModels })}
        </div>
      </section>

      <div class="db3-dashboard-grid db3-dashboard-grid--claude">
        <section class="db2-section db3-panel db3-panel--chart">
          <div class="db2-card-head">
            <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 1.5v13M11.5 4.5H6.25a2.25 2.25 0 1 0 0 4.5H9.75a2.25 2.25 0 0 1 0 4.5H4"/></svg>
              费用趋势
            </div>
            <div class="db2-card-meta">按 Anthropic 官方定价估算</div>
          </div>
          ${renderClaudeCostTrendChart(claudeDailySliced, daysWindow)}
        </section>

        <section class="db2-section db3-panel">
          <div class="db2-card-head">
            <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5l6-3 6 3v6l-6 3-6-3z"/><path d="M2 5l6 3m0 6V8m6-3l-6 3"/></svg>
              模型分布
            </div>
            <div class="db2-card-meta">近 ${daysWindow} 天 · ${claudeModels.length} 个模型</div>
          </div>
          ${renderDashboardModelDistChart(claudeModels, claudeModelTotal)}
        </section>

        <section class="db2-section db3-panel db3-panel--wide db3-panel--pricing">
          <div class="db2-card-head">
            <div class="db2-card-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 6h4M6 8h4M6 10h2"/></svg>
              模型消耗明细
            </div>
            <div class="db2-card-meta">按 Anthropic 定价估算</div>
          </div>
          ${renderModelCostRows(claudeModels, claudeModelTotal)}
        </section>
      </div>
    </div>`;

  // ── OpenClaw HTML ──
  const openclawHtml = `
    <div class="db2-layout">
      ${statStrip([
        { label: 'Gateway', value: getOpenClawGatewayStatusLabel(openclaw), sub: openclaw.gatewayUrl || '–', accent: openclaw.gatewayReachable },
        { label: '渠道数', value: String(openclawChannels.length), sub: openclawChannels.slice(0, 3).map(c => c.label).join('、') || '–' },
        { label: 'Provider', value: String(openclawProviders.length), sub: '已配置接入' },
        { label: '端口监听', value: openclaw.gatewayPortListening ? '活跃' : '未检测', sub: '本地 Gateway 端口' },
        { label: '端口冲突', value: openclaw.gatewayPortConflict ? '⚠ 有冲突' : '无', sub: '' },
      ])}
      <div class="db2-main-grid">
        <!-- LEFT: Gateway details -->
        <div class="db2-col">
          <div class="db2-section">
            <div class="db2-card-head">
              <div class="db2-card-title">Gateway 状态详情</div>
            </div>
            ${kvList([
              { label: 'Gateway 状态', value: getOpenClawGatewayStatusLabel(openclaw) },
              { label: 'Gateway URL', value: openclaw.gatewayUrl || '–' },
              { label: '端口监听', value: openclaw.gatewayPortListening ? '是' : '否' },
              { label: '可达性', value: openclaw.gatewayReachable ? '✓ 已连通' : '✗ 不可达' },
              { label: '端口冲突', value: openclaw.gatewayPortConflict ? '⚠ 存在冲突' : '无' },
            ])}
          </div>
        </div>

        <!-- RIGHT: Channels + Providers -->
        <div class="db2-col">
          <div class="db2-section">
            <div class="db2-card-head">
              <div class="db2-card-title">渠道列表</div>
              <div class="db2-card-meta">${openclawChannels.length} 个</div>
            </div>
            ${openclawChannels.length ? kvList(openclawChannels.map(c => ({ label: c.label, value: c.key }))) : '<div class="db2-empty">暂无已配置渠道</div>'}
          </div>

          <div class="db2-section">
            <div class="db2-card-head">
              <div class="db2-card-title">Provider 列表</div>
              <div class="db2-card-meta">${openclawProviders.length} 个</div>
            </div>
            ${openclawProviders.length
    ? kvList(openclawProviders.slice(0, 12).map((provider) => ({
      label: provider.key,
      value: provider.api || '未知协议',
    })))
    : '<div class="db2-empty">暂无已配置 Provider</div>'}
          </div>
        </div>
      </div>
    </div>`;

  const content = dashboardTool === 'codex'
    ? codexHtml
    : dashboardTool === 'claudecode'
      ? claudeHtml
      : dashboardTool === 'opencode'
        ? opencodeHtml
      : dashboardTool === 'openclaw'
        ? openclawHtml
        : codexHtml;

  // Sync the left-rail active state with the current dashboardTool.
  document.querySelectorAll('[data-dashboard-rail-tool]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-dashboard-rail-tool') === dashboardTool);
  });

  root.innerHTML = `
    <div class="dashboard-shell ${isLoading ? 'is-loading' : ''}">
      <div class="db3-toolbar db3-toolbar--page">
        <div class="db3-toolbar-status">
          ${showDashboardRefresh ? `<span class="dashboard-fetch-state ${isLoading ? 'loading' : ''}">${escapeHtml(dashboardStatusText)}</span>` : ''}
        </div>
        <div class="db3-toolbar-actions">
          <span class="db2-period-wrap">
            <div class="db2-period-dropdown" data-period-dropdown>
              <button type="button" class="db2-period-trigger" data-period-trigger>${state.dashboardDays} 天 <svg width="8" height="5" viewBox="0 0 8 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 1l3 3 3-3"/></svg></button>
              <div class="db2-period-menu" data-period-menu>
                ${[7, 14, 30].map(d => `<div class="db2-period-option ${state.dashboardDays === d ? 'active' : ''}" data-dashboard-days="${d}">${d} 天</div>`).join('')}
              </div>
            </div>
          </span>
          ${showDashboardRefresh ? `<button type="button" class="dashboard-refresh-btn ${state.dashboardRefreshing ? 'is-busy' : ''}" data-dashboard-refresh ${state.dashboardRefreshing ? 'disabled' : ''}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/></svg>${escapeHtml(state.dashboardRefreshing ? '刷新中' : '刷新')}</button>` : ''}
        </div>
      </div>
      ${content}
    </div>
  `;
}

function renderDashboardStatCard(label, value, sub = '') {
  const compactValue = formatDashboardMetric(value);
  const fullValue = formatDashboardMetricFull(value);
  const subLabel = sub ? `${sub} · ${fullValue}` : fullValue;
  return `<div class="dashboard-stat-card"><div class="dashboard-stat-label">${escapeHtml(label)}</div><div class="dashboard-stat-value" title="${escapeHtml(fullValue)}">${escapeHtml(compactValue)}</div>${subLabel ? `<div class="dashboard-stat-sub">${escapeHtml(subLabel)}</div>` : ''}</div>`;
}

let __dbChartId = 0;

function renderDashboardInteractiveChart(series = [], { stroke = '#5b8cff', showCost = false, models = [] } = {}) {
  if (!series.length) return '<div class="dashboard-empty-note">暂无趋势数据。</div>';
  const chartId = 'dbCanvas_' + (++__dbChartId);
  const tooltipId = chartId + '_tip';
  const dataAttr = `data-db-chart-series="${escapeHtml(JSON.stringify(series))}" data-db-chart-stroke="${escapeHtml(stroke)}" data-db-chart-show-cost="${showCost ? '1' : ''}" data-db-chart-models="${escapeHtml(JSON.stringify(models))}"`;

  // Deferred init via MutationObserver
  setTimeout(() => { _initDbInteractiveChart(chartId); }, 0);

  return `
    <div class="db2-ichart-wrap" id="${chartId}_wrap" ${dataAttr}>
      <canvas id="${chartId}" class="db2-ichart-canvas" height="196"></canvas>
      <div id="${tooltipId}" class="db2-ichart-tooltip" style="display:none"></div>
    </div>`;
}

function _initDbInteractiveChart(chartId) {
  const tryInit = () => {
    const canvas = document.getElementById(chartId);
    if (!canvas) return false;
    const wrap = canvas.closest('.db2-ichart-wrap');
    if (!wrap) return false;
    const series = JSON.parse(wrap.getAttribute('data-db-chart-series') || '[]');
    const stroke = wrap.getAttribute('data-db-chart-stroke') || '#5b8cff';
    const showCost = wrap.getAttribute('data-db-chart-show-cost') === '1';
    const models = JSON.parse(wrap.getAttribute('data-db-chart-models') || '[]');
    if (!series.length) return true;

    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    const W = Math.round(rect.width) || 600;
    const H = 196;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const padL = 42, padR = 12, padT = 16, padB = 28;
    const cW = W - padL - padR;
    const cH = H - padT - padB;
    const values = series.map(s => Number(s.value || 0));
    const max = Math.max(...values, 1);
    const step = series.length > 1 ? cW / (series.length - 1) : 0;
    const pts = series.map((s, i) => ({
      x: padL + step * i,
      y: padT + cH - (values[i] / max) * cH
    }));

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const gridColor = isLight ? 'rgba(15,23,42,0.055)' : 'rgba(255,255,255,0.055)';
    const textColor = isLight ? 'rgba(15,23,42,0.32)' : 'rgba(255,255,255,0.28)';
    const bgGradStart = stroke + '26';
    const bgGradEnd = stroke + '03';

    // Draw
    function draw(hoverIdx) {
      ctx.clearRect(0, 0, W, H);

      // Grid lines + labels
      ctx.font = '9.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'right';
      for (let frac of [0, 0.25, 0.5, 0.75, 1.0]) {
        const y = padT + cH - frac * cH;
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(W - padR, y);
        ctx.stroke();
        ctx.fillStyle = textColor;
        ctx.fillText(formatDashboardMetric(max * frac), padL - 6, y + 3);
      }

      // X labels
      const labelStep = Math.max(1, Math.floor(series.length / 7));
      ctx.textAlign = 'center';
      pts.forEach((p, i) => {
        if (i % labelStep !== 0 && i !== series.length - 1) return;
        ctx.fillStyle = textColor;
        ctx.fillText(series[i].label, p.x, H - 6);
      });

      // Area fill gradient
      if (pts.length > 1) {
        const grad = ctx.createLinearGradient(0, padT, 0, padT + cH);
        grad.addColorStop(0, bgGradStart);
        grad.addColorStop(1, bgGradEnd);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          const cp1x = (pts[i-1].x + pts[i].x) / 2;
          ctx.bezierCurveTo(cp1x, pts[i-1].y, cp1x, pts[i].y, pts[i].x, pts[i].y);
        }
        ctx.lineTo(pts[pts.length-1].x, padT + cH);
        ctx.lineTo(pts[0].x, padT + cH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // Line
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const cp1x = (pts[i-1].x + pts[i].x) / 2;
        ctx.bezierCurveTo(cp1x, pts[i-1].y, cp1x, pts[i].y, pts[i].x, pts[i].y);
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2.15;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();

      // Dots
      pts.forEach((p, i) => {
        const isHover = i === hoverIdx;
        ctx.beginPath();
        ctx.arc(p.x, p.y, isHover ? 4.5 : 2.2, 0, Math.PI * 2);
        ctx.fillStyle = isHover ? '#fff' : stroke;
        ctx.fill();
        if (isHover) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 2.15;
          ctx.stroke();
        }
      });

      // Hover crosshair
      if (hoverIdx >= 0 && hoverIdx < pts.length) {
        const p = pts[hoverIdx];
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = isLight ? 'rgba(15,23,42,0.15)' : 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x, padT);
        ctx.lineTo(p.x, padT + cH);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(padL, p.y);
        ctx.lineTo(W - padR, p.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    draw(-1);

    // Hover
    const tooltip = document.getElementById(chartId + '_tip');
    let lastIdx = -1;

    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      // Find nearest
      let nearIdx = 0;
      let nearDist = Infinity;
      pts.forEach((p, i) => {
        const d = Math.abs(p.x - mx);
        if (d < nearDist) { nearDist = d; nearIdx = i; }
      });
      if (nearIdx === lastIdx) return;
      lastIdx = nearIdx;
      draw(nearIdx);

      if (tooltip && series[nearIdx]) {
        const s = series[nearIdx];
        const inp = formatDashboardMetric(s.input || 0);
        const out = formatDashboardMetric(s.output || 0);
        const cached = formatDashboardMetric(s.cached || 0);
        const total = formatDashboardMetricFull(s.value || 0);

        // Cost estimation
        let costLine = '';
        if (showCost && models.length) {
          const dayTotal = Number(s.value || 0);
          if (dayTotal > 0) {
            const totalAllModels = models.reduce((sum, m) => sum + (m.totals?.total || 0), 0) || 1;
            let dayCost = 0;
            models.forEach(m => {
              const pricing = lookupModelPricing(m.model);
              if (!pricing) return;
              const share = (m.totals?.total || 0) / totalAllModels;
              const dayTokens = dayTotal * share;
              const inpShare = (m.totals?.input || 0) / ((m.totals?.total || 1));
              const outShare = (m.totals?.output || 0) / ((m.totals?.total || 1));
              const cachedShare = ((m.totals?.cachedInput || m.totals?.cacheRead || 0)) / ((m.totals?.total || 1));
              const cacheWriteShare = (m.totals?.cacheCreation || 0) / ((m.totals?.total || 1));
              dayCost += (dayTokens * inpShare / 1e6 * pricing.input) + (dayTokens * outShare / 1e6 * pricing.output) + (dayTokens * cachedShare / 1e6 * pricing.cached) + (dayTokens * cacheWriteShare / 1e6 * (pricing.input * 1.25));
            });
            costLine = `<div class="db2-tip-row db2-tip-cost"><span>预估费用</span><strong>${escapeHtml(formatDashboardUsd(dayCost, { min: 4, max: 4 }))}</strong></div>`;
          }
        }

        tooltip.innerHTML = `
          <div class="db2-tip-date">${escapeHtml(s.label)}</div>
          <div class="db2-tip-total">${escapeHtml(total)} tokens</div>
          <div class="db2-tip-row"><span style="color:#5b8cff">● 输入</span><strong>${escapeHtml(inp)}</strong></div>
          <div class="db2-tip-row"><span style="color:#22c55e">● 输出</span><strong>${escapeHtml(out)}</strong></div>
          <div class="db2-tip-row"><span style="color:#7c3aed">● 缓存</span><strong>${escapeHtml(cached)}</strong></div>
          ${costLine}
        `;
        tooltip.style.display = '';
        const tipRect = tooltip.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        let tx = pts[nearIdx].x + 14;
        if (tx + tipRect.width > W - 10) tx = pts[nearIdx].x - tipRect.width - 14;
        tooltip.style.left = tx + 'px';
        tooltip.style.top = Math.max(4, pts[nearIdx].y - tipRect.height / 2) + 'px';
      }
    });

    canvas.addEventListener('mouseleave', () => {
      lastIdx = -1;
      draw(-1);
      if (tooltip) tooltip.style.display = 'none';
    });

    return true;
  };

  if (!tryInit()) {
    // Retry with rAF
    let tries = 0;
    const retry = () => {
      if (tryInit() || tries++ > 20) return;
      requestAnimationFrame(retry);
    };
    requestAnimationFrame(retry);
  }
}

// Model distribution donut/bar chart
function renderDashboardModelDistChart(models = [], totalTokens = 0) {
  if (!models.length) return '<div class="dashboard-empty-note">暂无模型分布数据。</div>';
  const chartId = 'dbModelDist_' + (++__dbChartId);
  const sorted = [...models].sort((a, b) => (b.totals?.total || 0) - (a.totals?.total || 0));
  const colors = ['#5b8cff', '#7c3aed', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316'];

  const bars = sorted.map((m, i) => {
    const tokens = m.totals?.total || 0;
    const pct = totalTokens ? (tokens / totalTokens * 100) : 0;
    const cost = calcModelCost(m);
    const costStr = cost ? '$' + cost.totalCost.toFixed(3) : '–';
    const label = cost?.pricing?.label || m.model;
    const color = colors[i % colors.length];
    return `
      <div class="db2-mdist-item" style="--bar-color:${color}">
        <div class="db2-mdist-hdr">
          <span class="db2-mdist-dot" style="background:${color}"></span>
          <span class="db2-mdist-name" title="${escapeHtml(m.model)}">${escapeHtml(label)}</span>
          <span class="db2-mdist-tokens">${escapeHtml(formatDashboardMetric(tokens))}</span>
          <span class="db2-mdist-cost">${escapeHtml(costStr)}</span>
        </div>
        <div class="db2-mdist-bar-track">
          <div class="db2-mdist-bar-fill" style="width:${Math.max(2, pct)}%;background:${color}">
            <span class="db2-mdist-bar-label">${Math.round(pct)}%</span>
          </div>
        </div>
      </div>`;
  }).join('');

  return `<div class="db2-mdist-chart" id="${chartId}">${bars}</div>`;
}

function renderCostTrendPanel(costSeries = [], summaryLabel = '', fillStyle = '') {
  if (!costSeries.length) return '<div class="dashboard-empty-note">暂无费用趋势数据。</div>';
  const maxCost = Math.max(...costSeries.map((s) => s.value || 0), 0.001);
  const totalCost = costSeries.reduce((sum, item) => sum + (item.value || 0), 0);
  const labelStep = Math.max(1, Math.floor((costSeries.length - 1) / 5));
  const usdFmt = (value) => formatDashboardUsd(value, { min: value < 1 ? 3 : 2, max: value < 1 ? 3 : 2 });
  const axis = [maxCost, maxCost / 2, 0].map((value) => `<span>${escapeHtml(usdFmt(value))}</span>`).join('');
  const bars = costSeries.map((item, index) => {
    const value = Number(item.value || 0);
    const pct = value > 0 ? Math.max(4, (value / maxCost) * 100) : 0;
    const tip = `${item.label}  ${usdFmt(value)}`;
    const showLabel = index === costSeries.length - 1 || index % labelStep === 0;
    return `<div class="db2-costbar" data-tip="${escapeHtml(tip)}">
      <div class="db2-costbar-fill" style="height:${pct}%;${fillStyle}"></div>
      <span class="db2-costbar-label ${showLabel ? 'is-visible' : ''}">${escapeHtml(item.label)}</span>
    </div>`;
  }).join('');

  return `
    <div class="db2-cost-trend">
      <div class="db2-cost-trend-plot">
        <div class="db2-cost-axis">${axis}</div>
        <div class="db2-cost-chart">
          <div class="db2-cost-grid"><span></span><span></span><span></span></div>
          <div class="db2-cost-trend-bars">${bars}</div>
        </div>
      </div>
      <div class="db2-cost-trend-summary">
        <span>${escapeHtml(summaryLabel)}</span>
        <div class="db2-cost-trend-totals">
          <em>峰值 ${escapeHtml(usdFmt(maxCost))}</em>
          <strong>${escapeHtml(usdFmt(totalCost))}</strong>
        </div>
      </div>
    </div>`;
}

// Claude cost trend uses actual cost from telemetry (not estimated)
function renderClaudeCostTrendChart(dailySlice = [], windowDays = 30) {
  if (!dailySlice.length) return '<div class="dashboard-empty-note">暂无费用趋势数据。</div>';
  const costSeries = dailySlice.map((item) => ({
    label: (item.date || '').slice(5),
    value: item.cost || 0,
  }));
  return renderCostTrendPanel(
    costSeries,
    `近 ${windowDays} 天合计`,
    'background:linear-gradient(180deg,#b794ff 0%,#7c3aed 58%,#5b21b6 100%)'
  );
}

function renderDashboardCostTrendChart(daily = [], models = []) {
  if (!daily.length || !models.length) return '<div class="dashboard-empty-note">暂无费用趋势数据。</div>';

  const totalAllModels = models.reduce((sum, m) => sum + (m.totals?.total || 0), 0) || 1;
  const costSeries = daily.map((item) => {
    const dayTotal = item.total || 0;
    let dayCost = 0;
    if (dayTotal > 0) {
      models.forEach((m) => {
        const pricing = lookupModelPricing(m.model);
        if (!pricing) return;
        const share = (m.totals?.total || 0) / totalAllModels;
        const dayTokens = dayTotal * share;
        const inpShare = (m.totals?.input || 0) / (m.totals?.total || 1);
        const outShare = (m.totals?.output || 0) / (m.totals?.total || 1);
        const cachedShare = (m.totals?.cachedInput || m.totals?.cacheRead || 0) / (m.totals?.total || 1);
        dayCost += (dayTokens * inpShare / 1e6 * pricing.input) + (dayTokens * outShare / 1e6 * pricing.output) + (dayTokens * cachedShare / 1e6 * pricing.cached);
      });
    }
    return { label: (item.date || '').slice(5), value: dayCost };
  });

  return renderCostTrendPanel(
    costSeries,
    `近 ${costSeries.length} 天合计`,
    'background:linear-gradient(180deg,#bcd0ff 0%,#5b8cff 56%,#3358ff 100%)'
  );
}

// Keep legacy function as wrapper
function renderDashboardLineChart(series = [], { stroke = '#5b8cff' } = {}) {
  return renderDashboardInteractiveChart(series, { stroke });
}

function renderDashboardStackChart(items = []) {
  if (!items.length) return '<div class="dashboard-empty-note">暂无结构分布数据。</div>';
  const total = items.reduce((sum, item) => sum + Number(item.value || 0), 0) || 1;
  return `
    <div class="dashboard-chart">
      <div class="dashboard-stack-track">${items.map((item, index) => `<div class="dashboard-stack-segment" style="width:${(Number(item.value || 0) / total) * 100}%;background:${['#5b8cff','#7c3aed','#22c55e','#f59e0b'][index % 4]}" title="${escapeHtml(formatDashboardMetricFull(item.value || 0))}"></div>`).join('')}</div>
      <div class="dashboard-chart-legend">${items.map((item, index) => `<span title="${escapeHtml(formatDashboardMetricFull(item.value || 0))}"><span class="dashboard-legend-dot" style="background:${['#5b8cff','#7c3aed','#22c55e','#f59e0b'][index % 4]}"></span>${escapeHtml(item.label)} · ${escapeHtml(formatDashboardMetric(item.value || 0))}</span>`).join('')}</div>
    </div>`;
}

async function refreshDashboardData({ force = false, silent = false, tool = state.dashboardTool || 'codex' } = {}) {
  if (!isApiDashboardTool(tool)) return;
  if (state.dashboardRefreshing) return;
  state.dashboardRefreshing = true;
  state.dashboardLoading = !silent || !getDashboardMetricsForTool(tool);
  if (state.activePage === 'dashboard') renderDashboardPage();

  try {
    const params = new URLSearchParams({ days: '30' });
    if (tool === 'codex') {
      params.set('codexHome', getDashboardCodexHome());
    }
    if (force) params.set('force', '1');
    const route = tool === 'opencode' ? '/api/dashboard/opencode-usage' : '/api/dashboard/codex-usage';
    const json = await api(`${route}?${params.toString()}`, { timeoutMs: force ? 120000 : 20000 });
    if (json.ok && json.data && json.data.totals && typeof json.data.totals === 'object') {
      state.dashboardMetrics[tool] = json.data;
      state.dashboardMetricsFetchedAt = Date.now();
    }
  } catch { /* ignore */ } finally {
    state.dashboardLoading = false;
    state.dashboardRefreshing = false;
    if (state.activePage === 'dashboard') renderDashboardPage();
  }
}

function getToolConsoleLabel(tool = 'codex') {
  return TOOL_CONSOLE_META[tool]?.label || tool;
}

const TC_STAT_ICONS = {
  install: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 8a5.5 5.5 0 0 1 11 0 5.5 5.5 0 0 1-11 0z"/><path d="M8 5v6M5.5 8.5L8 11l2.5-2.5"/></svg>',
  scope: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 6h4M6 8h4M6 10h2"/></svg>',
  provider: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.5 9.5a3.5 3.5 0 0 0 5 0l1-1a3.54 3.54 0 0 0-5-5l-.5.5"/><path d="M9.5 6.5a3.5 3.5 0 0 0-5 0l-1 1a3.54 3.54 0 0 0 5 5l.5-.5"/></svg>',
  health: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 14s-5.5-3.5-5.5-7A3.5 3.5 0 0 1 8 4.5 3.5 3.5 0 0 1 13.5 7C13.5 10.5 8 14 8 14z"/></svg>',
  auth: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>',
  model: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 5l6-3 6 3v6l-6 3-6-3z"/><path d="M2 5l6 3m0 6V8m6-3l-6 3"/></svg>',
  history: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2.5 1.5"/></svg>',
  dashboard: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 6h12M6 6v8"/></svg>',
  agent: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="5" r="2.5"/><path d="M3.5 14c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"/></svg>',
  channel: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 12l3-3h7a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8z"/></svg>',
};

const TC_CARD_ICONS = {
  status: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 6h4M6 8h4M6 10h2"/></svg>',
  providers: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.5 9.5a3.5 3.5 0 0 0 5 0l1-1a3.54 3.54 0 0 0-5-5l-.5.5"/><path d="M9.5 6.5a3.5 3.5 0 0 0-5 0l-1 1a3.54 3.54 0 0 0 5 5l.5-.5"/></svg>',
  issues: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 2l6 11H2L8 2z"/><path d="M8 7v3M8 12v.5"/></svg>',
  actions: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 2v12M2 8h12"/></svg>',
  models: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 5l6-3 6 3v6l-6 3-6-3z"/><path d="M2 5l6 3m0 6V8m6-3l-6 3"/></svg>',
  agent: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="5" r="2.5"/><path d="M3.5 14c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"/></svg>',
  channels: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 12l3-3h7a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8z"/></svg>',
  runtime: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 6h12M6 6v8"/></svg>',
};

const TC_ISSUE_ICONS = {
  warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 2l6 11H2L8 2z"/><path d="M8 7v3"/><circle cx="8" cy="12" r="0.5" fill="currentColor" stroke="none"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M10 6L6 10M6 6l4 4"/></svg>',
  ok: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M5.5 8l2 2 3.5-4"/></svg>',
};

function renderToolConsoleStat(label, value, sub = '', { icon = '' } = {}) {
  const iconHtml = icon && TC_STAT_ICONS[icon]
    ? `<span class="tc-stat-icon">${TC_STAT_ICONS[icon]}</span>`
    : '';
  return `
    <div class="tool-console-stat">
      <div class="tool-console-stat-label">${iconHtml}${escapeHtml(label)}</div>
      <div class="tool-console-stat-value">${escapeHtml(value || '-')}</div>
      ${sub ? `<div class="tool-console-stat-sub">${sub}</div>` : ''}
    </div>
  `;
}

function renderToolConsoleAction(action = {}) {
  const attrs = [
    `data-console-action="${escapeHtml(action.type || '')}"`,
    action.page ? `data-console-page="${escapeHtml(action.page)}"` : '',
    action.tool ? `data-console-tool-target="${escapeHtml(action.tool)}"` : '',
    action.provider ? `data-console-provider="${escapeHtml(action.provider)}"` : '',
    action.method ? `data-console-method="${escapeHtml(action.method)}"` : '',
    action.authKey ? `data-console-auth-key="${escapeHtml(action.authKey)}"` : '',
  ].filter(Boolean).join(' ');
  const klass = action.primary ? 'tiny-btn' : 'secondary tiny-btn';
  return `<button type="button" class="${klass}" ${attrs}>${escapeHtml(action.label || '操作')}</button>`;
}

function renderToolConsoleIssue(issue = {}) {
  const tone = issue.tone || 'warn';
  const iconSvg = TC_ISSUE_ICONS[tone] || TC_ISSUE_ICONS.warn;
  return `
    <div class="tool-console-issue ${escapeHtml(tone)}">
      <div class="tc-issue-indicator">${iconSvg}</div>
      <div class="tc-issue-body">
        <div class="tool-console-issue-title">${escapeHtml(issue.title || '提醒')}</div>
        <div class="tool-console-issue-copy">${escapeHtml(issue.copy || '')}</div>
        ${issue.action ? `<div class="tool-console-actions">${renderToolConsoleAction(issue.action)}</div>` : ''}
      </div>
    </div>
  `;
}

function renderToolConsoleIssueList(issues = [], emptyText = '暂未发现明显异常。') {
  if (!issues.length) return `<div class="tool-console-empty">${escapeHtml(emptyText)}</div>`;
  return `<div class="tool-console-issues">${issues.map(renderToolConsoleIssue).join('')}</div>`;
}

function renderToolConsoleRow(label, value, { html = false } = {}) {
  const renderedValue = html ? value : escapeHtml(value || '-');
  return `<div class="tool-console-row"><div class="tool-console-row-label">${escapeHtml(label)}</div><div class="tool-console-row-value">${renderedValue}</div></div>`;
}

function renderToolConsoleCard(title, copy, body, { icon = '', iconTone = '' } = {}) {
  const iconKey = icon || '';
  const iconSvg = TC_CARD_ICONS[iconKey] || '';
  const iconHtml = iconSvg
    ? `<span class="tc-card-icon ${escapeHtml(iconTone)}">${iconSvg}</span>`
    : '';
  return `
    <section class="tool-console-card">
      <div class="tool-console-card-head">
        <div class="tool-console-card-title">${iconHtml}${escapeHtml(title)}</div>
        ${copy ? `<div class="tool-console-card-copy">${escapeHtml(copy)}</div>` : ''}
      </div>
      ${body}
    </section>
  `;
}

function renderToolConsoleGroupLabel(text) {
  return `<div class="tool-console-group-label">${escapeHtml(text)}</div>`;
}

function renderToolConsoleItem({ title = '', meta = '', chips = [], body = '' } = {}) {
  return `
    <div class="tool-console-item">
      <div class="tool-console-item-head">
        <div>
          <div class="tool-console-item-title">${escapeHtml(title)}</div>
          ${meta ? `<div class="tool-console-item-meta">${escapeHtml(meta)}</div>` : ''}
        </div>
      </div>
      ${chips.length ? `<div class="tool-console-badges">${chips.map(renderToolConsoleChip).join('')}</div>` : ''}
      ${body ? `<div class="tool-console-item-body">${body}</div>` : ''}
    </div>
  `;
}

function renderToolConsoleChip(text) {
  return `<span class="tool-console-chip">${escapeHtml(text)}</span>`;
}

function getOpenClawConsoleChannels(config = {}) {
  return Object.entries(config.channels || {})
    .filter(([key, value]) => !['defaults', 'modelByChannel'].includes(key) && value && (typeof value !== 'object' || Object.keys(value).length > 0))
    .map(([key]) => ({ key, label: OPENCLAW_CHANNEL_LABELS[key] || key }));
}

function getOpenClawConsoleProviders(config = {}) {
  return Object.entries(config.models?.providers || {}).map(([key, provider]) => ({
    key,
    api: provider?.api || '-',
    baseUrl: provider?.baseUrl || '',
    modelCount: Array.isArray(provider?.models) ? provider.models.length : 0,
  }));
}

function getOpenClawConsoleAgents(config = {}) {
  const agents = config.agents || {};
  const defaults = agents.defaults || {};
  const customAgents = Object.entries(agents)
    .filter(([key, value]) => key !== 'defaults' && value && typeof value === 'object')
    .map(([key, value]) => ({
      key,
      model: value?.model?.primary || value?.model || '-',
      workspace: value?.workspace || '默认',
    }));
  return {
    defaults,
    customAgents,
  };
}

function deriveOpenClawDashboardAuthDiagnostics(data = {}, lastRepair = null) {
  const authMode = String(data.gatewayAuthMode || data.config?.gateway?.auth?.mode || 'token');
  const dashboardUrl = String(data.dashboardUrl || '');
  const hasTokenizedUrl = /[?&]token=/.test(dashboardUrl);
  const tokenReady = Boolean(data.gatewayTokenReady);
  const repairNotes = Array.isArray(lastRepair?.notes) ? lastRepair.notes.filter(Boolean) : [];

  if (!data.gatewayReachable) {
    return {
      tone: 'error',
      summary: getOpenClawGatewayStatusLabel(data),
      detail: 'Gateway 尚未运行，Dashboard 认证还没有开始。',
      session: '不可用',
      issues: [],
    };
  }

  if (authMode === 'none') {
    return {
      tone: 'ok',
      summary: '无需认证',
      detail: '当前 Control UI 不要求 token 或密码。',
      session: '无需会话',
      issues: [],
    };
  }

  if (authMode === 'password') {
    return {
      tone: 'warn',
      summary: '需手动输入密码',
      detail: '应用无法替你填写浏览器里的密码框。',
      session: '待人工确认',
      issues: [{ tone: 'warn', title: 'Dashboard 需要密码认证', copy: 'Gateway 已在线，但 Control UI 还需要你在浏览器里输入密码后才能连上。', action: { type: 'open-openclaw-dashboard', label: '打开 Dashboard' } }],
    };
  }

  if (!tokenReady) {
    return {
      tone: 'error',
      summary: '缺少 token',
      detail: 'Gateway 已启用 token 认证，但当前没有检测到可用 token。',
      session: '认证失败',
      issues: [{ tone: 'error', title: 'Gateway 缺少令牌', copy: '当前启用了 token 鉴权，但没有检测到可用 token，Dashboard 会提示 unauthorized / 4008。', action: { type: 'repair-openclaw-dashboard', label: '一键修复并打开' } }],
    };
  }

  if (!hasTokenizedUrl) {
    return {
      tone: 'error',
      summary: '缺少令牌化 URL',
      detail: '当前没有拿到带 token 的 Dashboard 启动链接。',
      session: '认证失败',
      issues: [{ tone: 'error', title: 'Dashboard 启动链接缺少 token', copy: 'Control UI 需要令牌化 URL 才能引导浏览器建立认证会话。', action: { type: 'repair-openclaw-dashboard', label: '重新生成并打开' } }],
    };
  }

  const copy = lastRepair
    ? '已执行自动修复，但应用无法直接读取外部浏览器会话；如果浏览器仍报 4008，通常是旧会话/旧 token 残留。'
    : '应用无法直接读取外部浏览器会话；如果浏览器仍报 4008，请重新打开令牌化 URL。';

  return {
    tone: 'warn',
    summary: '待浏览器确认',
    detail: copy,
    session: lastRepair ? '已修复待确认' : '未验证',
    issues: [{ tone: 'warn', title: 'Dashboard 认证需浏览器确认', copy, action: { type: 'repair-openclaw-dashboard', label: '重新打开认证链接' } }],
    notes: repairNotes,
  };
}

function buildCodexConsoleView() {
  const data = state.current || {};
  const codexBinary = getToolBinaryStatus('codex', data.codexBinary);
  const providers = data.providers || [];
  const active = data.activeProvider || null;
  const login = data.login || {};
  const health = active ? state.providerHealth[active.key] : null;
  const issues = [];

  if (!codexBinary.installed) {
    issues.push({ tone: 'error', title: 'Codex 未安装', copy: '还没检测到 codex 命令，先去"工具安装"里安装。', action: { type: 'goto-page', page: 'tools', label: '去安装' } });
  }
  if (!data.configExists) {
    issues.push({ tone: 'warn', title: '还没有 Codex 配置', copy: '当前作用域尚未写入 config.toml，建议先完成一次快速配置。', action: { type: 'goto-quick-tool', tool: 'codex', label: '去快速配置' } });
  }
  if (!providers.length && !login.loggedIn) {
    issues.push({ tone: 'error', title: '没有可用 Provider', copy: '当前配置里还没有保存任何 Provider，Codex 启动后通常无法正常请求模型。', action: { type: 'goto-config-editor-tool', tool: 'codex', label: '去配 Provider' } });
  }
  if (active && !active.hasApiKey) {
    issues.push({ tone: 'error', title: '当前 Provider 缺少密钥', copy: `活动 Provider "${active.name}" 已选中，但没有检测到可用 API Key。`, action: { type: 'goto-quick-tool', tool: 'codex', label: '去补 Key' } });
  }
  if (!active && login.loggedIn) {
    issues.push({ tone: 'warn', title: '已识别官方登录态', copy: '当前检测到 Codex 官方登录，可直接使用 OpenAI 官方线路；如果你想改成代理/中转，再单独保存 Provider。', action: { type: 'goto-quick-tool', tool: 'codex', label: '去快速配置' } });
  }
  if (health?.checked && !health.ok) {
    issues.push({ tone: 'warn', title: '当前 Provider 连通性异常', copy: `已对 "${active?.name || '当前 Provider'}" 做过检测，但结果不通过。`, action: { type: 'refresh-console', label: '重新检测' } });
  }

  const summary = [
    renderToolConsoleStat('安装状态', codexBinary.installed ? (codexBinary.version || '已安装') : '未安装', codexBinary.path ? `<span class="tool-console-code">${escapeHtml(codexBinary.path)}</span>` : '', { icon: 'install' }),
    renderToolConsoleStat('作用域', data.scope === 'project' ? '项目级' : '全局', data.rootPath ? `<span class="tool-console-code">${escapeHtml(data.rootPath)}</span>` : '', { icon: 'scope' }),
    renderToolConsoleStat('活动 Provider', active?.name || (login.loggedIn ? 'OpenAI 官方登录' : '未选择'), active?.baseUrl ? `<span class="tool-console-code">${escapeHtml(active.baseUrl)}</span>` : login.loggedIn ? (login.plan || login.email || 'ChatGPT / OpenAI 认证已就绪') : '还没有可用 Provider', { icon: 'provider' }),
    renderToolConsoleStat('健康检测', active ? (health?.loading ? '检测中' : health?.checked ? (health.ok ? '通过' : '失败') : '未检测') : login.loggedIn ? '已登录' : '未检测', active ? `模型：${escapeHtml(data.summary?.model || '-')}` : login.loggedIn ? '官方登录模式通常无需额外 Provider' : '先保存 Provider 再检测', { icon: 'health' }),
  ].join('');

  const providerBody = providers.length
    ? `<div class="tool-console-item-list">${providers.map((provider) => {
        const itemHealth = state.providerHealth[provider.key];
        const chips = [
          provider.isActive ? '当前使用' : '已保存',
          provider.hasApiKey ? 'Key 就绪' : '缺少 Key',
          itemHealth?.loading ? '检测中' : itemHealth?.checked ? (itemHealth.ok ? '连通通过' : '连通失败') : '待检测',
        ];
        return renderToolConsoleItem({
          title: provider.name,
          meta: provider.isActive ? '当前活动 Provider' : '已保存 Provider',
          chips,
          body: `<div class="tool-console-list compact">${renderToolConsoleRow('Base URL', `<span class="tool-console-code">${escapeHtml(provider.baseUrl || '-')}</span>`, { html: true })}${renderToolConsoleRow('密钥来源', provider.keySource || provider.resolvedKeyName || '-')}</div>`,
        });
      }).join('')}</div>`
    : login.loggedIn ? '<div class="tool-console-empty">当前未保存自定义 Provider，但已识别到 Codex 官方登录态，可直接使用官方 OpenAI 线路。</div>' : '<div class="tool-console-empty">当前没有已保存的 Codex Provider。</div>';

  const main = [
    renderToolConsoleCard('状态总览', '安装、配置与当前模型', `<div class="tool-console-list">${renderToolConsoleRow('配置文件', `<span class="tool-console-code">${escapeHtml(data.configPath || '-')}</span>`, { html: true })}${renderToolConsoleRow('环境变量文件', `<span class="tool-console-code">${escapeHtml(data.envPath || '-')}</span>`, { html: true })}${renderToolConsoleRow('Sandbox', data.summary?.sandboxMode || '默认')}${renderToolConsoleRow('审批策略', data.summary?.approvalPolicy || '默认')}${renderToolConsoleRow('推理强度', data.summary?.reasoningEffort || '默认')}</div>`, { icon: 'status' }),
    renderToolConsoleCard('Provider 检测', '已保存 Provider 与密钥状态', providerBody, { icon: 'providers' }),
    renderToolConsoleCard('异常检测', '会优先指出最影响启动与请求的问题', renderToolConsoleIssueList(issues, 'Codex 侧暂未发现明显阻塞项。'), { icon: 'issues', iconTone: issues.length ? (issues.some(i => i.tone === 'error') ? 'error' : 'warn') : 'ok' }),
  ].join('');

  const side = [
    renderToolConsoleCard('推荐操作', '常用排错入口', `<div class="tool-console-actions">${[
      { type: 'refresh-console', label: '重新检测', primary: true },
      { type: 'goto-config-editor-tool', tool: 'codex', label: '查看 Provider' },
      { type: 'goto-config-editor-tool', tool: 'codex', label: '打开配置编辑' },
      { type: 'goto-quick-tool', tool: 'codex', label: '切到快速配置' },
    ].map(renderToolConsoleAction).join('')}</div>`, { icon: 'actions' }),
  ].join('');

  return { summary, main, side, activity: '' };
}

function buildClaudeConsoleView() {
  const data = state.claudeCodeState || {};
  const login = data.login || {};
  const issues = [];

  if (!data.binary?.installed) issues.push({ tone: 'error', title: 'Claude Code 未安装', copy: '还没检测到 Claude Code 命令，先去"工具安装"完成安装。', action: { type: 'goto-page', page: 'tools', label: '去安装' } });
  if (!login.loggedIn && !data.hasApiKey) issues.push({ tone: 'error', title: 'Claude Code 尚未认证', copy: '当前既没有登录态，也没有检测到可用 API Key。', action: { type: 'goto-quick-tool', tool: 'claudecode', label: '去快速配置' } });
  if (!data.model) issues.push({ tone: 'warn', title: '默认模型未显式指定', copy: 'Claude Code 会回退到自身默认模型；如果你想可控，建议手动指定。', action: { type: 'goto-quick-tool', tool: 'claudecode', label: '设置模型' } });

  const summary = [
    renderToolConsoleStat('安装状态', data.binary?.installed ? (data.binary.version || '已安装') : '未安装', data.binary?.path ? `<span class="tool-console-code">${escapeHtml(data.binary.path)}</span>` : '', { icon: 'install' }),
    renderToolConsoleStat('认证状态', login.loggedIn ? (login.method === 'oauth' ? 'OAuth 已登录' : 'API Key 已就绪') : '未认证', login.email || login.orgName ? escapeHtml([login.email, login.orgName].filter(Boolean).join(' · ')) : '建议先完成认证', { icon: 'auth' }),
    renderToolConsoleStat('默认模型', data.model || '由 Claude Code 决定', data.alwaysThinkingEnabled ? 'Always thinking 已开启' : '按默认推理策略运行', { icon: 'model' }),
    renderToolConsoleStat('历史模型', String((data.usedModels || []).length || 0), (data.usedModels || []).length ? `${data.usedModels.length} 个历史模型别名/全名` : '还没有历史模型记录', { icon: 'history' }),
  ].join('');

  const modelsBody = (data.usedModels || []).length
    ? `<div class="tool-console-badges">${data.usedModels.map(renderToolConsoleChip).join('')}</div>`
    : '<div class="tool-console-empty">当前还没有历史模型记录。</div>';

  const main = [
    renderToolConsoleCard('状态总览', '登录、配置与行为开关', `<div class="tool-console-list">${renderToolConsoleRow('settings.json', `<span class="tool-console-code">${escapeHtml(data.settingsPath || '-')}</span>`, { html: true })}${renderToolConsoleRow('登录方式', login.loggedIn ? (login.method || '已登录') : '未登录')}${renderToolConsoleRow('Always thinking', data.alwaysThinkingEnabled ? '开启' : '关闭')}${renderToolConsoleRow('危险权限提示', data.skipDangerousModePermissionPrompt ? '已跳过' : '保持提示')}</div>`, { icon: 'status' }),
    renderToolConsoleCard('历史模型', '便于回看最近用过什么模型', modelsBody, { icon: 'models' }),
    renderToolConsoleCard('异常检测', '优先指出安装、登录和模型配置问题', renderToolConsoleIssueList(issues, 'Claude Code 侧暂未发现明显阻塞项。'), { icon: 'issues', iconTone: issues.length ? (issues.some(i => i.tone === 'error') ? 'error' : 'warn') : 'ok' }),
  ].join('');

  const side = [
    renderToolConsoleCard('推荐操作', '常用入口', `<div class="tool-console-actions">${[
      { type: 'refresh-console', label: '重新检测', primary: true },
      { type: 'goto-quick-tool', tool: 'claudecode', label: '切到快速配置' },
      { type: 'goto-page', page: 'tools', label: '查看安装状态' },
    ].map(renderToolConsoleAction).join('')}</div>`, { icon: 'actions' }),
  ].join('');

  return { summary, main, side, activity: '' };
}

function buildOpenCodeConsoleView() {
  const data = state.opencodeState || {};
  const active = data.activeProvider || null;
  const providers = data.providers || [];
  const authEntries = data.authEntries || [];
  const activeAuth = data.activeAuth || null;
  const issues = [];

  if (!data.binary?.installed) issues.push({ tone: 'error', title: 'OpenCode 未安装', copy: '当前还没检测到 opencode 命令，先去“工具安装”完成安装。', action: { type: 'goto-page', page: 'tools', label: '去安装' } });
  if (!data.configExists) issues.push({ tone: 'warn', title: '还没有 OpenCode 配置', copy: '当前作用域还没有写入 `opencode.json` / `opencode.jsonc`。', action: { type: 'goto-quick-tool', tool: 'opencode', label: '去快速配置' } });
  if (!data.model) issues.push({ tone: 'warn', title: '默认模型未设置', copy: 'OpenCode 模型格式通常是 `provider/model`，建议先固定默认模型。', action: { type: 'goto-quick-tool', tool: 'opencode', label: '去设置模型' } });
  if (!providers.length) issues.push({ tone: 'warn', title: '未配置 Provider', copy: '当前配置中还没有可用的 provider 节点。', action: { type: 'goto-config-editor-tool', tool: 'opencode', label: '去配置' } });
  if (active && !active.hasCredential) issues.push({ tone: 'warn', title: '当前 Provider 缺少凭证', copy: `活动 Provider "${active.name || active.key}" 还没有保存 API Key，也没有 auth 登录。`, action: { type: 'goto-quick-tool', tool: 'opencode', label: '去补凭证' } });
  if (!authEntries.length && !providers.some((provider) => provider.hasApiKey)) issues.push({ tone: 'warn', title: '尚未登录 OpenCode Provider', copy: '当前没发现 auth.json 凭证，也没发现已保存 API Key。', action: { type: 'opencode-auth-login', provider: active?.key || '', label: '启动 auth login' } });

  const summary = [
    renderToolConsoleStat('安装状态', data.binary?.installed ? (data.binary.version || '已安装') : '未安装', data.binary?.path ? `<span class="tool-console-code">${escapeHtml(data.binary.path)}</span>` : '', { icon: 'install' }),
    renderToolConsoleStat('作用域', data.scope === 'project' ? '项目级' : '全局', data.rootPath ? `<span class="tool-console-code">${escapeHtml(data.rootPath)}</span>` : '', { icon: 'scope' }),
    renderToolConsoleStat('默认模型', data.model || '未设置', data.smallModel || '未设置 small_model', { icon: 'model' }),
    renderToolConsoleStat('认证状态', activeAuth ? `${activeAuth.type || 'auth'} 已登录` : (active?.hasApiKey ? 'API Key 已保存' : '未认证'), activeAuth?.key || active?.baseUrl || '等待配置', { icon: 'auth' }),
  ].join('');

  const providerBody = providers.length
    ? `<div class="tool-console-item-list">${providers.map((provider) => renderToolConsoleItem({
        title: provider.name || provider.key,
        meta: provider.key,
        chips: [provider.hasCredential ? '凭证就绪' : '缺少凭证', provider.hasAuth ? `${provider.authType || 'auth'} 登录` : '未登录', `${(provider.modelIds || []).length} models`],
        body: `<div class="tool-console-list compact">${renderToolConsoleRow('Base URL', provider.baseUrl ? `<span class="tool-console-code">${escapeHtml(provider.baseUrl)}</span>` : '-', { html: Boolean(provider.baseUrl) })}${renderToolConsoleRow('npm', provider.npm || '@ai-sdk/openai-compatible')}${renderToolConsoleRow('模型', (provider.modelIds || []).join(', ') || '未显式声明')}</div>`,
      })).join('')}</div>`
    : '<div class="tool-console-empty">当前还没有配置任何 OpenCode Provider。</div>';

  const authBody = authEntries.length
    ? `<div class="tool-console-item-list">${authEntries.map((entry) => renderToolConsoleItem({
        title: entry.key,
        meta: entry.type || 'unknown',
        chips: [entry.hasCredential ? '已就绪' : '缺失', entry.expiresAt ? `到期 ${formatOpenCodeAuthExpiry(entry.expiresAt)}` : '长期有效'],
        body: `<div class="tool-console-list compact">${renderToolConsoleRow('凭证', entry.maskedSecret || '-')}${renderToolConsoleRow('到期', entry.expiresAt ? formatOpenCodeAuthExpiry(entry.expiresAt) : '-')}</div>`,
      })).join('')}</div>`
    : '<div class="tool-console-empty">当前还没有检测到 OpenCode auth.json 凭证。</div>';

  const actions = [
    { type: 'refresh-console', label: '重新检测', primary: true },
    { type: 'goto-quick-tool', tool: 'opencode', label: '切到快速配置' },
    { type: 'goto-config-editor-tool', tool: 'opencode', label: '打开配置编辑' },
    { type: 'goto-page', page: 'tools', label: '查看安装状态' },
  ];
  if (data.binary?.installed) actions.splice(1, 0, { type: 'opencode-auth-login', provider: active?.key || '', label: '启动 auth login' });
  if (activeAuth?.key) actions.splice(2, 0, { type: 'opencode-auth-remove', authKey: activeAuth.key, label: '移除当前凭证' });

  const main = [
    renderToolConsoleCard('状态总览', '安装、配置和当前模型', `<div class="tool-console-list">${renderToolConsoleRow('配置文件', `<span class="tool-console-code">${escapeHtml(data.configPath || '-')}</span>`, { html: true })}${renderToolConsoleRow('鉴权文件', `<span class="tool-console-code">${escapeHtml(data.authPath || '-')}</span>`, { html: true })}${renderToolConsoleRow('默认模型', data.model || '-')}${renderToolConsoleRow('Small model', data.smallModel || '-')}${renderToolConsoleRow('当前 Provider', active?.key || '-')}${renderToolConsoleRow('当前 auth', activeAuth?.key || '-')}</div>`, { icon: 'status' }),
    renderToolConsoleCard('Provider 列表', '按源码字段展示 provider / options / models', providerBody, { icon: 'providers' }),
    renderToolConsoleCard('认证状态', '来自 auth.json 的 Provider 登录凭证', authBody, { icon: 'actions' }),
    renderToolConsoleCard('异常检测', '优先提示安装、模型和凭证问题', renderToolConsoleIssueList(issues, 'OpenCode 侧暂未发现明显阻塞项。'), { icon: 'issues', iconTone: issues.length ? (issues.some(i => i.tone === 'error') ? 'error' : 'warn') : 'ok' }),
  ].join('');

  const side = [
    renderToolConsoleCard('推荐操作', '常用入口', `<div class="tool-console-actions">${actions.map(renderToolConsoleAction).join('')}</div>`, { icon: 'actions' }),
  ].join('');

  return { summary, main, side, activity: '' };
}

function buildOpenClawConsoleView() {
  const data = state.openclawState || {};
  const lastRepair = state.openClawLastRepair || null;
  const quick = deriveOpenClawQuickConfig(data);
  const config = data.config || {};
  const channels = getOpenClawConsoleChannels(config);
  const providers = getOpenClawConsoleProviders(config);
  const agentInfo = getOpenClawConsoleAgents(config);
  const defaults = agentInfo.defaults || {};
  const gatewayBind = String(config.gateway?.bind || 'local');
  const gatewayAuth = String(data.gatewayAuthMode || config.gateway?.auth?.mode || 'token');
  const dashboardAuth = deriveOpenClawDashboardAuthDiagnostics(data, lastRepair);
  const issues = [];

  if (!data.binary?.installed) issues.push({ tone: 'error', title: 'OpenClaw 未安装', copy: '当前还没检测到 openclaw 命令，先去"工具安装"完成安装。', action: { type: 'goto-page', page: 'tools', label: '去安装' } });
  if (!data.configExists) issues.push({ tone: 'warn', title: 'openclaw.json 尚未生成', copy: '说明还没完成初始化或还没真正保存过配置。', action: { type: 'goto-quick-tool', tool: 'openclaw', label: '去快速配置' } });
  if (data.needsOnboarding) issues.push({ tone: 'warn', title: 'OpenClaw 仍需初始化', copy: '当前还没有生成 `openclaw.json`，先完成首次初始化。', action: { type: 'launch-openclaw', label: '启动并初始化' } });
  if (!data.gatewayReachable && !data.gatewayPortListening) issues.push({ tone: 'warn', title: 'Dashboard 未在线', copy: '当前没探测到本地 Gateway，很多渠道回调和控制面板操作都会失效。', action: { type: 'launch-openclaw', label: '启动 Gateway' } });
  if (!data.gatewayReachable && data.gatewayPortListening) issues.push({ tone: 'warn', title: 'Gateway 正在启动中', copy: '端口已经监听，但控制面板还没完全就绪。通常再等几秒就会恢复。', action: { type: 'refresh-console', label: '重新检测' } });
  if (data.gatewayPortConflict) issues.push({ tone: 'error', title: `端口 ${data.gatewayPort || '18789'} 已被其他进程占用`, copy: '这会导致 OpenClaw Gateway 无法正常启动或一直显示启动中。', action: { type: 'kill-openclaw-port', label: '结束占用进程' } });
  if (!providers.length) issues.push({ tone: 'error', title: '没有配置模型 Provider', copy: 'OpenClaw 已安装，但 `models.providers` 里还没有可用模型源。', action: { type: 'goto-config-editor-tool', tool: 'openclaw', label: '去配置 Provider' } });
  if (!quick.model) issues.push({ tone: 'error', title: '默认 Agent 模型未设置', copy: '当前没有检测到 `agents.defaults.model.primary`，聊天入口通常无法正常出结果。', action: { type: 'goto-config-editor-tool', tool: 'openclaw', label: '去设置模型' } });
  if (providers.length && !quick.hasApiKey) issues.push({ tone: 'error', title: '默认 Provider 缺少 API Key', copy: `已检测到默认模型 ${quick.model || '-'}，但没有找到它对应的 API Key。`, action: { type: 'goto-quick-tool', tool: 'openclaw', label: '去补 Key' } });
  if ((gatewayBind === 'lan' || gatewayBind === '0.0.0.0') && gatewayAuth === 'none') issues.push({ tone: 'error', title: '网络已暴露但未启用认证', copy: '当前 Gateway 允许局域网/公网访问，但认证模式为 none，风险较高。', action: { type: 'goto-config-editor-tool', tool: 'openclaw', label: '去修安全配置' } });
  if (channels.some((item) => ['wechat', 'wechatWork', 'wechatwork', 'webhook'].includes(item.key)) && !config.gateway?.tls && !config.gateway?.trustProxy) issues.push({ tone: 'warn', title: '公网回调场景建议补 HTTPS / 反代', copy: '你已经在配公众号、企微或 Webhook，一般需要公网 HTTPS 或反向代理才能稳定接入。', action: { type: 'goto-config-editor-tool', tool: 'openclaw', label: '去配网关' } });
  issues.push(...(dashboardAuth.issues || []));

  const summary = [
    renderToolConsoleStat('安装状态', data.binary?.installed ? (data.binary.version || '已安装') : '未安装', data.binary?.path ? `<span class="tool-console-code">${escapeHtml(data.binary.path)}</span>` : '', { icon: 'install' }),
    renderToolConsoleStat('Dashboard', getOpenClawGatewayStatusLabel(data), (data.dashboardUrl || data.gatewayUrl) ? `<span class="tool-console-code">${escapeHtml(data.dashboardUrl || data.gatewayUrl)}</span>` : '等待本地 Gateway 启动', { icon: 'dashboard' }),
    renderToolConsoleStat('常驻服务', getOpenClawDaemonStatusLabel(data), data.daemon?.detail || '当前未启用常驻服务', { icon: 'runtime' }),
    renderToolConsoleStat('默认 Agent', quick.model || defaults.model?.primary || '未设置', defaults.thinkingDefault ? `thinking=${escapeHtml(defaults.thinkingDefault)}` : '建议先固定默认模型', { icon: 'agent' }),
  ].join('');

  const customAgentsBody = agentInfo.customAgents.length
    ? `<div class="tool-console-item-list">${agentInfo.customAgents.map((agent) => renderToolConsoleItem({
        title: agent.key,
        meta: '自定义 Agent',
        body: `<div class="tool-console-list compact">${renderToolConsoleRow('模型', agent.model)}${renderToolConsoleRow('Workspace', agent.workspace)}</div>`,
      })).join('')}</div>`
    : '<div class="tool-console-empty">当前只有默认 Agent，没有单独定义的命名 Agent。</div>';

  const providerBody = providers.length
    ? `<div class="tool-console-item-list">${providers.map((provider) => renderToolConsoleItem({
        title: provider.key,
        meta: provider.api,
        body: `<div class="tool-console-list compact">${renderToolConsoleRow('Base URL', provider.baseUrl ? `<span class="tool-console-code">${escapeHtml(provider.baseUrl)}</span>` : '-', { html: Boolean(provider.baseUrl) })}${renderToolConsoleRow('模型数量', provider.modelCount ? String(provider.modelCount) : '未显式配置')}</div>`,
      })).join('')}</div>`
    : '<div class="tool-console-empty">当前还没有配置任何 OpenClaw Provider。</div>';

  const channelBody = channels.length
    ? `<div class="tool-console-badges">${channels.map((item) => renderToolConsoleChip(item.label)).join('')}</div>`
    : '<div class="tool-console-empty">当前还没有接入聊天渠道。</div>';

  const main = [
    renderToolConsoleCard('Gateway 状态', '进程、认证与 Dashboard 引导链接', `<div class="tool-console-list">${renderToolConsoleRow('配置文件', `<span class="tool-console-code">${escapeHtml(data.configPath || '-')}</span>`, { html: true })}${renderToolConsoleRow('Gateway 状态', getOpenClawGatewayStatusLabel(data))}${renderToolConsoleRow('常驻服务', getOpenClawDaemonStatusLabel(data))}${renderToolConsoleRow('Gateway HTTP', data.gatewayReachable ? '在线' : data.gatewayPortListening ? '等待面板就绪' : '未就绪')}${renderToolConsoleRow('端口占用', renderOpenClawPortOccupants(data), { html: true })}${renderToolConsoleRow('Bind', gatewayBind)}${renderToolConsoleRow('Auth', gatewayAuth)}${renderToolConsoleRow('Token', data.gatewayTokenReady ? '已就绪' : '缺失')}${renderToolConsoleRow('Dashboard URL', data.dashboardUrl ? `<span class="tool-console-code">${escapeHtml(data.dashboardUrl)}</span>` : '-', { html: Boolean(data.dashboardUrl) })}${renderToolConsoleRow('Onboarding', data.needsOnboarding ? '待完成' : '已完成')}</div>`, { icon: 'runtime' }),
    renderToolConsoleCard('Dashboard 认证状态', 'Control UI 认证、令牌化链接与浏览器会话', `<div class="tool-console-list">${renderToolConsoleRow('状态', dashboardAuth.summary)}${renderToolConsoleRow('认证模式', gatewayAuth)}${renderToolConsoleRow('令牌化 URL', /[?&]token=/.test(String(data.dashboardUrl || '')) ? '已就绪' : '缺失')}${renderToolConsoleRow('浏览器会话', dashboardAuth.session)}${renderToolConsoleRow('诊断', dashboardAuth.detail)}${renderToolConsoleRow('修复备注', (dashboardAuth.notes || []).length ? (dashboardAuth.notes || []).join(' | ') : '无')}</div>`, { icon: 'issues', iconTone: dashboardAuth.tone === 'error' ? 'error' : dashboardAuth.tone === 'ok' ? 'ok' : 'warn' }),
    renderToolConsoleCard('修复结果', '最近一次一键修复的执行结果', lastRepair ? `<div class="tool-console-list">${renderToolConsoleRow('Token 生成', lastRepair.tokenGenerated ? '是' : '否')}${renderToolConsoleRow('要求重启', lastRepair.restartRequired ? '是' : '否')}${renderToolConsoleRow('修复后 Gateway', getOpenClawGatewayStatusLabel(lastRepair))}${renderToolConsoleRow('修复后 URL', lastRepair.dashboardUrl ? `<span class="tool-console-code">${escapeHtml(lastRepair.dashboardUrl)}</span>` : '-', { html: Boolean(lastRepair.dashboardUrl) })}${renderToolConsoleRow('备注', (lastRepair.notes || []).length ? escapeHtml(lastRepair.notes.join(' | ')) : '无')}</div>` : '<div class="tool-console-empty">还没有执行过“一键修复并打开”。</div>', { icon: 'actions' }),
  ].join('');

  const side = [
    renderToolConsoleCard('启动提醒', '是否已启动与优先处理事项', `<div class="tool-console-list">${renderToolConsoleRow('当前状态', getOpenClawGatewayStatusLabel(data))}${renderToolConsoleRow('是否可打开 Dashboard', data.gatewayReachable ? '可以' : data.gatewayPortListening ? '稍等片刻' : '还不行')}${renderToolConsoleRow('异常数量', issues.length ? String(issues.length) : '0')}</div>${renderToolConsoleIssueList(issues.slice(0, 3), '当前没有明显异常。')}`, { icon: 'issues', iconTone: issues.length ? (issues.some(i => i.tone === 'error') ? 'error' : 'warn') : 'ok' }),
    renderToolConsoleCard('快速操作', '检测、启动、停止', `<div class="tool-console-actions">${[
      { type: 'refresh-console', label: '重新检测', primary: true },
      data.gatewayReachable ? { type: 'open-openclaw-dashboard', label: '打开 Dashboard' } : data.gatewayPortListening ? { type: 'refresh-console', label: '查看启动状态' } : { type: 'launch-openclaw', label: '启动 OpenClaw' },
      { type: 'repair-openclaw-dashboard', label: '一键修复并打开' },
      data.gatewayPortOccupants?.length ? { type: 'kill-openclaw-port', label: '结束端口占用' } : null,
      { type: 'toggle-openclaw-daemon', label: data.daemonInstalled ? '关闭常驻服务' : '开启常驻服务' },
      { type: 'stop-openclaw', label: '停止 Gateway' },
      { type: 'goto-config-editor-tool', tool: 'openclaw', label: '打开配置编辑' },
      { type: 'goto-quick-tool', tool: 'openclaw', label: '切到快速配置' },
    ].filter(Boolean).map(renderToolConsoleAction).join('')}</div>`, { icon: 'actions' }),
    renderToolConsoleCard('渠道与 Provider', '接入的渠道和模型源', `${channelBody}${renderToolConsoleGroupLabel('Provider')}${providerBody}`, { icon: 'channels' }),
  ].join('');

  // Build activity panel (agent grid + issues log)
  const activitySections = [];

  // Error / Issue log (always show if issues exist)
  if (issues.length) {
    const logItems = issues.map((issue) => {
      const level = issue.tone === 'error' ? 'error' : issue.tone === 'ok' ? 'ok' : 'warn';
      return `<div class="tc-log-item"><div class="tc-log-level ${level}"></div><div class="tc-log-message">${escapeHtml(issue.title)}: ${escapeHtml(issue.copy)}</div></div>`;
    }).join('');
    activitySections.push(`
      <details class="tc-activity-section" open>
        <summary class="tc-activity-summary">
          <span class="tc-activity-icon logs"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 2l6 11H2L8 2z"/><path d="M8 7v3"/><circle cx="8" cy="12" r="0.5" fill="currentColor" stroke="none"/></svg></span>
          错误与告警
          <span class="tc-activity-badge">${issues.length} 项</span>
        </summary>
        <div class="tc-activity-body"><div class="tc-log-list">${logItems}</div></div>
      </details>
    `);
  }

  // Agent activity
  const allAgents = [
    { key: 'defaults', model: quick.model || defaults.model?.primary || '-', workspace: defaults.workspace || '~' },
    ...agentInfo.customAgents,
  ];
  if (allAgents.length) {
    const agentCards = allAgents.map((agent) => `
      <div class="tc-agent-card">
        <div class="tc-agent-name">${escapeHtml(agent.key)}</div>
        <div class="tc-agent-meta">模型: ${escapeHtml(agent.model)}<br>目录: ${escapeHtml(agent.workspace || '~')}</div>
      </div>
    `).join('');
    activitySections.push(`
      <details class="tc-activity-section">
        <summary class="tc-activity-summary">
          <span class="tc-activity-icon agents"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="5" r="2.5"/><path d="M3.5 14c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"/></svg></span>
          Agent 活动
          <span class="tc-activity-badge info">${allAgents.length} 个</span>
        </summary>
        <div class="tc-activity-body"><div class="tc-agent-grid">${agentCards}</div></div>
      </details>
    `);
  }

  // Channel listing (detailed)
  if (channels.length) {
    const channelItems = channels.map((ch) => `
      <div class="tc-log-item">
        <div class="tc-log-level ok"></div>
        <div class="tc-log-message">${escapeHtml(ch.label)}</div>
        <div class="tc-log-time">${escapeHtml(ch.key)}</div>
      </div>
    `).join('');
    activitySections.push(`
      <details class="tc-activity-section">
        <summary class="tc-activity-summary">
          <span class="tc-activity-icon channels"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 12l3-3h7a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v8z"/></svg></span>
          接入渠道
          <span class="tc-activity-badge info">${channels.length} 个</span>
        </summary>
        <div class="tc-activity-body"><div class="tc-log-list">${channelItems}</div></div>
      </details>
    `);
  }

  return { summary, main, side, activity: activitySections.join('') };
}

function getToolStatusDot(tool) {
  if (tool === 'codex') {
    const data = state.current || {};
    if (!getToolBinaryStatus('codex', data.codexBinary).installed) return 'error';
    const active = data.activeProvider;
    const login = data.login || {};
    if (active) {
      const health = state.providerHealth[active.key];
      if (health?.checked && !health.ok) return 'warning';
      if (health?.checked && health.ok) return 'online';
    }
    if (login.loggedIn) return 'online';
    return data.configExists ? 'online' : 'warning';
  }
  if (tool === 'claudecode') {
    const data = state.claudeCodeState || {};
    if (!data.binary?.installed) return 'error';
    const login = data.login || {};
    if (login.loggedIn || data.hasApiKey) return 'online';
    return 'warning';
  }
  if (tool === 'opencode') {
    const data = state.opencodeState || {};
    if (!data.binary?.installed) return 'error';
    if (data.activeProvider?.hasApiKey && data.model) return 'online';
    if (data.configExists) return 'warning';
    return 'offline';
  }
  if (tool === 'openclaw') {
    const data = state.openclawState || {};
    if (!data.binary?.installed) return 'error';
    if (data.gatewayReachable) return 'online';
    if (data.configExists) return 'warning';
    return 'offline';
  }
  return 'offline';
}

function renderToolConsole() {
  const tool = state.consoleTool || 'codex';

  // v2 page uses the hub-style lean layout; if the v2 container exists we
  // render into it and stop. Legacy tabs + 4-stat-card layout is retained
  // behind hidden DOM only to keep any ancient event listeners happy.
  const v2 = document.getElementById('toolConsolePage');
  if (v2 && v2.classList.contains('console-v2')) {
    // Sync the left-rail tool list active state.
    document.querySelectorAll('[data-console-rail-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-console-rail-tool') === tool);
    });
    renderConsoleV2(tool);
    return;
  }

  // ─── Legacy render path (kept for safety; not reachable with v2 DOM) ───
  const summary = el('toolConsoleSummary');
  const main = el('toolConsoleMain');
  const side = el('toolConsoleSide');
  const activityEl = el('toolConsoleActivity');
  if (!summary || !main || !side) return;

  document.querySelectorAll('[data-console-tool]').forEach((button) => {
    button.classList.toggle('active', button.dataset.consoleTool === tool);
  });
  const dotCodex = el('tcDotCodex');
  const dotClaude = el('tcDotClaude');
  const dotOpenCode = el('tcDotOpenCode');
  const dotOpenClaw = el('tcDotOpenClaw');
  if (dotCodex) dotCodex.className = `tc-tab-dot ${getToolStatusDot('codex')}`;
  if (dotClaude) dotClaude.className = `tc-tab-dot ${getToolStatusDot('claudecode')}`;
  if (dotOpenCode) dotOpenCode.className = `tc-tab-dot ${getToolStatusDot('opencode')}`;
  if (dotOpenClaw) dotOpenClaw.className = `tc-tab-dot ${getToolStatusDot('openclaw')}`;

  const view = tool === 'openclaw'
    ? buildOpenClawConsoleView()
    : tool === 'opencode'
      ? buildOpenCodeConsoleView()
      : tool === 'claudecode'
        ? buildClaudeConsoleView()
        : buildCodexConsoleView();

  summary.innerHTML = view.summary;
  main.innerHTML = view.main;
  side.innerHTML = view.side;

  if (activityEl) {
    if (view.activity) {
      activityEl.innerHTML = view.activity;
      activityEl.classList.add('has-content');
    } else {
      activityEl.innerHTML = '';
      activityEl.classList.remove('has-content');
    }
  }
}

// ─── Console v3 — cross-tool: IP firewall + procs + usage + meta ─
// Caches of async-loaded data (populated by loadConsoleSideData()). Each
// render uses the latest snapshot; stale-but-present beats flicker-and-empty.
window.__consoleV3 = window.__consoleV3 || {
  network: null,          // { ok, ip, country, countryCode, verdict, verdictCopy, ... }
  networkLoading: false,
  latency: null,          // { rows:[{label,ms,ok}], summary:{avgMs,reachable,total} }
  latencyLoading: false,
  procsByTool: {},        // { codex: [...], claudecode: [...], ... }
  procsLoading: {},
  codexStats: null,       // { total, today, week, latestMtime, recent, modelDistribution }
  claudeUsage: null,      // { messagesInWindow, windowFirstMessageAt, recent, ... }
};

// Persistent preference — lives on disk at
//   ~/.codex-config-ui/app-settings.json :: ipGateBlock
// NOT in localStorage; safety-critical toggles must survive browser storage
// wipes. Frontend holds a read-through cache; writes go through the backend
// and the cache is updated on success.
window.__appSettings = window.__appSettings || { loaded: false, data: null };

async function loadAppSettings() {
  try {
    const res = await api('/api/app-settings', { method: 'GET' });
    if (res?.ok) {
      window.__appSettings = { loaded: true, data: res.data || {} };
    } else {
      window.__appSettings = { loaded: true, data: {} };
    }
  } catch (_) {
    window.__appSettings = { loaded: true, data: {} };
  }
  return window.__appSettings.data;
}

async function patchAppSettings(patch) {
  try {
    const res = await api('/api/app-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch || {}),
    });
    if (res?.ok) {
      window.__appSettings = { loaded: true, data: res.data || {} };
      return true;
    }
  } catch (err) {
    console.warn('[app-settings] patch failed', err);
  }
  return false;
}

function isIpGateEnabled() {
  return Boolean(window.__appSettings?.data?.ipGateBlock);
}
async function setIpGateEnabled(enabled) {
  // Optimistic update so the toggle flips immediately; backend patch follows.
  window.__appSettings = window.__appSettings || { loaded: true, data: {} };
  window.__appSettings.data = { ...(window.__appSettings.data || {}), ipGateBlock: Boolean(enabled) };
  if (state.activePage === 'console') renderToolConsole();
  await patchAppSettings({ ipGateBlock: Boolean(enabled) });
}

// Called by launchCodex / launchClaudeCodeOnly / launchCodexLogin before
// actually spawning the terminal. Returns true when the caller should proceed.
// Never throws; degrades to "proceed" when the IP check itself errors out.
async function preLaunchIpFirewallCheck(toolLabel) {
  try {
    if (!window.__consoleV3?.network) {
      const res = await api('/api/network/status', { method: 'GET' });
      window.__consoleV3 = window.__consoleV3 || {};
      window.__consoleV3.network = res?.ok ? (res.data || null) : null;
    }
    const n = window.__consoleV3?.network;
    if (!n || n.ok === false) return true; // no IP = no verdict, let the user decide
    if (n.verdict !== 'block') return true;

    // Backend-persisted gate preference (NOT localStorage — must survive
    // browser-storage wipes since this is a safety toggle).
    if (!window.__appSettings?.loaded) await loadAppSettings();
    const gate = isIpGateEnabled();

    if (gate) {
      flash?.(`🚫 启动被防火墙拦截：${n.verdictCopy || '当前 IP 风险高'}`, 'error');
      return false;
    }
    const msg = `🛡 ${n.verdictCopy || '当前 IP 被判定为高风险。'}\n\n出口 IP: ${n.ip} (${n.countryCode})\n\n继续启动 ${toolLabel}？(建议 "取消" 并切换线路)`;
    return window.confirm(msg);
  } catch (_) {
    return true;
  }
}

async function loadConsoleNetworkStatus({ force = false } = {}) {
  if (window.__consoleV3.networkLoading) return;
  window.__consoleV3.networkLoading = true;
  try {
    const path = force ? '/api/network/check' : '/api/network/status';
    const res = await api(path, force ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    } : { method: 'GET' });
    window.__consoleV3.network = res?.ok ? (res.data || {}) : { ok: false, error: res?.error || 'network error' };
  } catch (err) {
    window.__consoleV3.network = { ok: false, error: String(err) };
  } finally {
    window.__consoleV3.networkLoading = false;
    if (state.activePage === 'console') renderToolConsole();
  }
}

async function loadConsoleLatency() {
  if (window.__consoleV3.latencyLoading) return;
  window.__consoleV3.latencyLoading = true;
  try {
    const res = await api('/api/network/latency', { method: 'GET', timeoutMs: 8000 });
    window.__consoleV3.latency = res?.ok ? (res.data || null) : null;
  } catch (_) {
    window.__consoleV3.latency = null;
  } finally {
    window.__consoleV3.latencyLoading = false;
    if (state.activePage === 'console') renderToolConsole();
  }
}

async function loadConsoleProcs(tool) {
  if (window.__consoleV3.procsLoading[tool]) return;
  window.__consoleV3.procsLoading[tool] = true;
  try {
    const res = await api(`/api/system/processes?tool=${encodeURIComponent(tool)}`, { method: 'GET' });
    window.__consoleV3.procsByTool[tool] = res?.ok ? (res.data?.rows || []) : [];
  } catch (err) {
    window.__consoleV3.procsByTool[tool] = [];
  } finally {
    window.__consoleV3.procsLoading[tool] = false;
    if (state.activePage === 'console' && (state.consoleTool || 'codex') === tool) renderToolConsole();
  }
}

async function loadConsoleCodexStats() {
  try {
    const res = await api('/api/codex/session-stats', { method: 'GET' });
    window.__consoleV3.codexStats = res?.ok ? (res.data || null) : null;
  } catch (_) { window.__consoleV3.codexStats = null; }
  if (state.activePage === 'console' && state.consoleTool === 'codex') renderToolConsole();
}

async function loadConsoleClaudeUsage() {
  try {
    const res = await api('/api/claudecode/local-usage', { method: 'GET' });
    window.__consoleV3.claudeUsage = res?.ok ? (res.data || null) : null;
  } catch (_) { window.__consoleV3.claudeUsage = null; }
  if (state.activePage === 'console' && state.consoleTool === 'claudecode') renderToolConsole();
}

async function primeConsoleV3(tool) {
  // Fire in parallel; each updates render-on-arrival.
  if (!window.__appSettings.loaded) loadAppSettings();
  if (!window.__consoleV3.network) loadConsoleNetworkStatus({ force: false });
  if (!window.__consoleV3.latency) loadConsoleLatency();
  if (!window.__consoleV3.procsByTool[tool]) loadConsoleProcs(tool);
  if (tool === 'codex' && !window.__consoleV3.codexStats) loadConsoleCodexStats();
  if (tool === 'claudecode' && !window.__consoleV3.claudeUsage) loadConsoleClaudeUsage();
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  return `${day} 天前`;
}

// Collapse verbose vendor model IDs into something a human reads at a glance.
//   claude-sonnet-4-5-20250929  → Sonnet 4.5
//   claude-3-7-opus-20250229    → Opus 3.7
//   gpt-5.4                     → GPT-5.4
//   gpt-4o-mini-2024-07-18      → GPT-4o mini
// Falls back to the raw string when the shape isn't recognized.
function formatModelLabel(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // Claude: claude-<tier>-<version>[-date]  (tier + version order varies)
  const c = s.match(/^claude[-_ ](?:(\d[\d-]*)[-_ ])?(sonnet|haiku|opus)[-_ ]?(\d[\d-]*)?(?:[-_ ]\d{6,})?$/i);
  if (c) {
    const tier = c[2][0].toUpperCase() + c[2].slice(1).toLowerCase();
    const ver = (c[1] || c[3] || '').replace(/-/g, '.');
    return ver ? `${tier} ${ver}` : tier;
  }
  // GPT: gpt-4o-mini-xxxx, gpt-5.4, gpt-4-turbo-xxxx
  const g = s.match(/^gpt[-_ ]?([\d.]+)(?:[-_ ](o|turbo|mini))?(?:[-_ ](mini|nano|turbo|pro))?/i);
  if (g) {
    const ver = g[1];
    const suffix = [g[2], g[3]].filter(Boolean).map((x) => x.toLowerCase()).join(' ');
    return suffix ? `GPT-${ver} ${suffix}` : `GPT-${ver}`;
  }
  return s;
}

// Minimal one-line SVGs reused across the strip. Outline / line style, not
// emoji — keeps the strip dense and consistent with the rest of the hub.
const CV3_ICONS = {
  shield: '<svg class="cv3-ico" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5 3 3.5v4c0 3.2 2.1 6 5 7 2.9-1 5-3.8 5-7v-4L8 1.5z"/></svg>',
  proxy:  '<svg class="cv3-ico" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6a6 6 0 0 1 12 0M4 8a4 4 0 0 1 8 0M6 10a2 2 0 0 1 4 0"/><circle cx="8" cy="12.5" r="0.9" fill="currentColor" stroke="none"/></svg>',
  lock:   '<svg class="cv3-ico" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
  unlock: '<svg class="cv3-ico" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0"/></svg>',
  refresh:'<svg class="cv3-ico" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 8A6 6 0 0 1 3.4 11.8L2 13M2 8a6 6 0 0 1 10.6-3.8L14 3"/><path d="M14 3v3.5h-3.5M2 13V9.5h3.5"/></svg>',
  // Section-head icons (14px, matched line style).
  globe:  '<svg class="cv3-sec-ico" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2.2 3 5 3 6s-1 3.8-3 6c-2-2.2-3-5-3-6s1-3.8 3-6z"/></svg>',
  cpu:    '<svg class="cv3-sec-ico" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6 4V2M10 4V2M6 14v-2M10 14v-2M4 6H2M4 10H2M14 6h-2M14 10h-2"/></svg>',
  clock:  '<svg class="cv3-sec-ico" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2.2 1.3"/></svg>',
  sliders:'<svg class="cv3-sec-ico" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.4" fill="currentColor" stroke="none"/><circle cx="11" cy="8" r="1.4" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
  alert:  '<svg class="cv3-sec-ico" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2 1.5 13.5h13L8 2z"/><path d="M8 6.5v3M8 11.5v.5"/></svg>',
};

// Helper to render a section head with icon + label + optional count + extras.
function cv3SectionHead(icon, label, { count, extras = '' } = {}) {
  const esc = escapeHtml;
  const countHtml = (count || count === 0) ? `<span class="count">· ${esc(String(count))}</span>` : '';
  return `<div class="console-v2-section-head">${icon || ''}<span class="cv3-sec-label">${esc(label)}</span>${countHtml}${extras}</div>`;
}

// Slim one-line IP strip embedded inside the hero card. Dense, no emoji
// decorations — just the IP, geo, verdict color, proxy hint, and the two
// control buttons. Target: 1 line on normal widths, wrapping to 2 lines
// only when the hero is very narrow.
function renderHeroIpStripHTML() {
  const esc = escapeHtml;
  const n = window.__consoleV3.network;
  if (!n) {
    return `<div class="cv3-ipstrip loading">${CV3_ICONS.shield}<span class="cv3-ipstrip-msg">正在检测出口 IP…</span></div>`;
  }
  const gateOn = isIpGateEnabled();
  const gateBtn = `<button type="button" class="cv3-ipstrip-toggle ${gateOn ? 'on' : ''}" data-console-v3-toggle-gate-btn title="${gateOn ? '硬拦截已开启 — 高风险 IP 时阻止启动' : '硬拦截已关闭 — 高风险仅弹窗提醒'}">${gateOn ? CV3_ICONS.lock + '硬拦截' : CV3_ICONS.unlock + '仅提醒'}</button>`;
  const refreshBtn = `<button type="button" class="cv3-ipstrip-refresh" data-console-v3-refresh-ip title="重新检测">${CV3_ICONS.refresh}</button>`;

  if (n.ok === false) {
    const proxyHint = n.proxy?.hasProxy
      ? `<span class="cv3-ipstrip-proxy" title="${esc((n.proxy.hints || []).join(' | '))}">${CV3_ICONS.proxy}代理</span>`
      : `<span class="cv3-ipstrip-proxy dim" title="没有识别到任何代理配置">${CV3_ICONS.proxy}无代理</span>`;
    return `
      <div class="cv3-ipstrip bad">
        <div class="cv3-ipstrip-left">
          ${CV3_ICONS.shield}
          <span class="cv3-ipstrip-label">无法获取 IP</span>
          ${proxyHint}
          <span class="cv3-ipstrip-err" title="${esc(n.error || '')}">${esc((n.error || '').slice(0, 60))}</span>
        </div>
        <div class="cv3-ipstrip-right">${gateBtn}${refreshBtn}</div>
      </div>`;
  }

  const verdict = n.verdict || 'warn';
  const cc = (n.countryCode || '').toUpperCase();
  const flagMap = { CN: '🇨🇳', US: '🇺🇸', SG: '🇸🇬', JP: '🇯🇵', HK: '🇭🇰', TW: '🇹🇼', KR: '🇰🇷', DE: '🇩🇪', GB: '🇬🇧', FR: '🇫🇷', CA: '🇨🇦', AU: '🇦🇺' };
  const flag = flagMap[cc] || '';
  const splitTag = n.splitTunnel ? `<span class="cv3-ipstrip-split" title="多个视角看到不同 IP（分流）">分流</span>` : '';
  const hasProxy = Boolean(n.proxy?.hasProxy);
  const locBits = [flag && flag, n.country, n.city, n.isp].filter(Boolean).join(' · ');

  return `
    <div class="cv3-ipstrip ${esc(verdict)}">
      <div class="cv3-ipstrip-left">
        ${CV3_ICONS.shield}
        <span class="cv3-ipstrip-ip"><code>${esc(n.ip || '-')}</code></span>
        <span class="cv3-ipstrip-geo">${esc(locBits)}</span>
        ${splitTag}
        ${hasProxy ? `<span class="cv3-ipstrip-proxy" title="${esc((n.proxy.hints || [])[0] || '')}">${CV3_ICONS.proxy}代理</span>` : ''}
      </div>
      <div class="cv3-ipstrip-right">${gateBtn}${refreshBtn}</div>
    </div>`;
}

// Multi-vantage matrix — mimics ip111.cn's "从国内测试 / 从国外测试 / 从谷歌测试"
// columns. Shows the IP each probe saw. When any row disagrees with the
// primary IP we highlight the mismatching cells so split-tunneling is
// obvious at a glance.
function renderConsoleV3Vantages() {
  const el = document.getElementById('consoleV2Vantages');
  if (!el) return;
  const esc = escapeHtml;
  const n = window.__consoleV3.network;
  if (!n) {
    el.innerHTML = `<div class="console-v2-section-head">网络视角</div><div class="cv3-proc-empty">检测中…</div>`;
    return;
  }

  const vantages = Array.isArray(n.vantages) ? n.vantages : [];
  if (!vantages.length) {
    el.innerHTML = `<div class="console-v2-section-head">网络视角
      <button type="button" class="cv3-link-btn" data-console-v3-refresh-ip>重测</button>
    </div>
    <div class="cv3-proc-empty">${esc(n.error || '无法获取视角数据')}</div>
    ${renderLatencyStripHTML()}`;
    return;
  }

  const primaryIp = n.ip || '';
  const rowsHtml = vantages.map((v) => {
    const okCell = v.ok === true;
    const ip = v.query || v.ip || '';
    const mismatch = okCell && primaryIp && ip && ip !== primaryIp;
    const statusCls = !okCell ? 'bad' : mismatch ? 'warn' : 'ok';
    const ipText = okCell ? (ip || '—') : '失败';
    const geo = okCell
      ? ((v.country ? esc(v.country) : '') + (v.city ? ' · ' + esc(v.city) : ''))
      : esc((v.error || '').slice(0, 40));
    const latency = v.ms ? `${v.ms}ms` : '';
    const transport = v.transport && v.transport !== 'none' ? v.transport : '';
    return `
      <div class="cv3-vantage ${statusCls}">
        <div class="cv3-vantage-head">
          <span class="cv3-vantage-label">${esc(v.label || '—')}</span>
          ${latency ? `<span class="cv3-vantage-ms">${esc(latency)}</span>` : ''}
        </div>
        <div class="cv3-vantage-ip"><code>${esc(ipText)}</code></div>
        <div class="cv3-vantage-geo">${geo || '&nbsp;'}</div>
        ${transport ? `<div class="cv3-vantage-via">via ${esc(transport)}</div>` : ''}
      </div>`;
  }).join('');

  const splitChip = n.splitTunnel ? '<span class="cv3-vantage-alert" title="多视角看到的 IP 不一致">⚠ 分流</span>' : '';
  const refreshBtn = '<button type="button" class="cv3-link-btn" data-console-v3-refresh-ip>重测</button>';
  el.innerHTML = `
    ${cv3SectionHead(CV3_ICONS.globe, '网络视角', {
      count: `${vantages.length} 路`,
      extras: splitChip + refreshBtn,
    })}
    <div class="cv3-vantage-grid">${rowsHtml}</div>
    ${renderLatencyStripHTML()}`;
}

// Small inline latency strip — shown inside the firewall card so users see
// network quality alongside the verdict.
function renderLatencyStripHTML() {
  const esc = escapeHtml;
  const l = window.__consoleV3.latency;
  if (!l) {
    return `<div class="cv3-latency-strip"><span class="cv3-latency-label">网络时延</span><span class="cv3-latency-hint">测量中…</span></div>`;
  }
  const rows = Array.isArray(l.rows) ? l.rows : [];
  if (!rows.length) return '';
  const pills = rows.map((r) => {
    if (!r.ok) {
      return `<span class="cv3-latency-pill bad" title="${esc(r.error || '')}">${esc(r.label)}: —</span>`;
    }
    const cls = r.ms > 500 ? 'warn' : r.ms > 150 ? 'okish' : 'ok';
    return `<span class="cv3-latency-pill ${cls}" title="${esc(r.host)} · ${esc(r.why || '')}">${esc(r.label)}: ${esc(String(r.ms))}ms</span>`;
  }).join('');
  const summary = l.summary ? `<span class="cv3-latency-sum">${l.summary.reachable}/${l.summary.total} 可达 · 平均 ${l.summary.avgMs}ms</span>` : '';
  return `<div class="cv3-latency-strip"><span class="cv3-latency-label">网络时延</span>${pills}${summary}<button type="button" class="cv3-link-btn cv3-latency-refresh" data-console-v3-refresh-latency>重测</button></div>`;
}

function renderConsoleV3Procs(tool, toolLabel) {
  const el = document.getElementById('consoleV2Procs');
  if (!el) return;
  const esc = escapeHtml;
  const rows = window.__consoleV3.procsByTool[tool] || null;
  const refreshProcsBtn = '<button type="button" class="cv3-link-btn" data-console-v3-refresh-procs>刷新</button>';
  const headLabel = `运行中的 ${toolLabel}`;
  if (rows === null) {
    el.innerHTML = `
      ${cv3SectionHead(CV3_ICONS.cpu, headLabel, { count: '…', extras: refreshProcsBtn })}
      <div class="cv3-proc-empty">正在扫描进程…</div>`;
    return;
  }
  if (!rows.length) {
    el.innerHTML = `
      ${cv3SectionHead(CV3_ICONS.cpu, headLabel, { count: 0, extras: refreshProcsBtn })}
      <div class="cv3-proc-empty">当前没有在跑的 ${esc(toolLabel)} 进程</div>`;
    return;
  }
  const rowsHtml = rows.map((p) => {
    const mem = p.memMB ? `${p.memMB} MB` : (p.memPct ? `${p.memPct.toFixed(1)}%` : '—');
    const cpu = (typeof p.cpu === 'number') ? `${p.cpu.toFixed(1)}%` : '—';
    // Trim the most common shell boilerplate for a cleaner command preview.
    const cmdClean = (p.command || '').replace(/^\S*\/node\s+/, 'node ').trim();
    const cwd = p.cwd ? `<span class="cv3-proc-cwd" title="${esc(p.cwd)}">${esc(p.cwd)}</span>` : '';
    return `
      <div class="cv3-proc-row">
        <div class="cv3-proc-head">
          <span class="cv3-proc-dot"></span>
          <span class="cv3-proc-pid">PID ${esc(String(p.pid))}</span>
          <span class="cv3-proc-elapsed" title="已运行">${esc(p.elapsed || '—')}</span>
          <span class="cv3-proc-cpu" title="CPU 占用">CPU ${esc(cpu)}</span>
          <span class="cv3-proc-mem" title="内存占用">MEM ${esc(mem)}</span>
          <span class="cv3-proc-actions">
            ${p.cwd ? `<button type="button" class="cv3-proc-btn" data-cv3-proc-reveal="${esc(p.cwd)}" title="在 Finder 打开该目录">打开目录</button>` : ''}
            <button type="button" class="cv3-proc-btn cv3-proc-btn-danger" data-cv3-proc-kill="${esc(String(p.pid))}" title="结束该进程 (SIGTERM)">结束</button>
          </span>
        </div>
        ${cmdClean ? `<div class="cv3-proc-cmd" title="${esc(cmdClean)}">${esc(cmdClean)}</div>` : ''}
        ${cwd ? `<div class="cv3-proc-cwd-row"><span class="cv3-proc-cwd-label">cwd</span>${cwd}</div>` : ''}
      </div>`;
  }).join('');
  el.innerHTML = `
    ${cv3SectionHead(CV3_ICONS.cpu, headLabel, { count: rows.length, extras: refreshProcsBtn })}
    <div class="cv3-proc-list">${rowsHtml}</div>`;
}

function renderConsoleV3Usage(tool) {
  const el = document.getElementById('consoleV2Usage');
  if (!el) return;
  const esc = escapeHtml;

  if (tool === 'codex') {
    const s = window.__consoleV3.codexStats;
    if (!s) {
      el.innerHTML = `${cv3SectionHead(CV3_ICONS.clock, '本地会话')}<div class="cv3-proc-empty">读取 ~/.codex/sessions/ 中…</div>`;
      return;
    }
    const dist = Array.isArray(s.modelDistribution) ? s.modelDistribution : [];
    const distHtml = dist.length ? `
      <div class="cv3-session-dist">
        <span class="cv3-session-dist-label">近 7 天模型分布</span>
        ${dist.map((d) => `<span class="cv3-session-dist-chip">${esc(d.model)} <em>${esc(String(d.count))}</em></span>`).join('')}
      </div>` : '';

    const recent = Array.isArray(s.recent) ? s.recent : [];
    const recentHtml = recent.length ? `
      <div class="cv3-session-list">
        ${recent.map((r) => {
          const modelLabel = formatModelLabel(r.model);
          const preview = (r.firstMessage || '').trim() || '(无用户消息)';
          return `
          <div class="cv3-session-row">
            <div class="cv3-session-row-main">
              <div class="cv3-session-title">${esc(preview)}</div>
              <div class="cv3-session-meta">
                ${modelLabel ? `<span class="cv3-session-chip">${esc(modelLabel)}</span>` : ''}
                <span class="cv3-session-count">${esc(String(r.messageCount || 0))} 条</span>
                <span class="cv3-session-when">${esc(formatRelativeTime(r.lastActiveAt))}</span>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>` : '<div class="cv3-proc-empty">暂无会话</div>';

    const refreshUsage = '<button type="button" class="cv3-link-btn" data-console-v3-refresh-usage>刷新</button>';
    el.innerHTML = `
      ${cv3SectionHead(CV3_ICONS.clock, '本地会话', { extras: refreshUsage })}
      <div class="cv3-usage-grid">
        <div class="cv3-usage-cell">
          <div class="cv3-usage-label">总数</div>
          <div class="cv3-usage-value">${esc(String(s.total || 0))}</div>
        </div>
        <div class="cv3-usage-cell">
          <div class="cv3-usage-label">近 24h</div>
          <div class="cv3-usage-value">${esc(String(s.today || 0))}</div>
        </div>
        <div class="cv3-usage-cell">
          <div class="cv3-usage-label">近 7 天</div>
          <div class="cv3-usage-value">${esc(String(s.week || 0))}</div>
        </div>
        <div class="cv3-usage-cell">
          <div class="cv3-usage-label">最近活动</div>
          <div class="cv3-usage-value">${s.latestMtime ? esc(formatRelativeTime(s.latestMtime)) : '无'}</div>
        </div>
      </div>
      ${distHtml}
      <div class="cv3-session-head">最近会话</div>
      ${recentHtml}`;
    return;
  }

  if (tool === 'claudecode') {
    const u = window.__consoleV3.claudeUsage;
    if (!u) {
      el.innerHTML = `${cv3SectionHead(CV3_ICONS.clock, '本地 5h 窗口 (估算)')}<div class="cv3-proc-empty">读取 ~/.claude/projects/ 中…</div>`;
      return;
    }
    const firstAt = u.windowFirstMessageAt ? new Date(u.windowFirstMessageAt) : null;
    const remainingMs = firstAt ? (firstAt.getTime() + 5 * 3600 * 1000) - Date.now() : 0;
    const remainingText = (!firstAt || remainingMs <= 0) ? '—' : (() => {
      const min = Math.max(0, Math.floor(remainingMs / 60000));
      const hr = Math.floor(min / 60);
      const rem = min % 60;
      return hr > 0 ? `${hr}h ${rem}m` : `${rem}m`;
    })();
    const recent = Array.isArray(u.recent) ? u.recent : [];
    const recentHtml = recent.length ? `
      <div class="cv3-session-list">
        ${recent.map((r) => {
          const modelLabel = formatModelLabel(r.model);
          const preview = (r.firstMessage || '').trim() || '(无用户消息)';
          // Claude's project slug is a flattened path — unflatten for display.
          const projDisplay = r.project ? r.project.replace(/^-+/, '').replace(/-+/g, '/') : '';
          return `
          <div class="cv3-session-row">
            <div class="cv3-session-row-main">
              <div class="cv3-session-title">${esc(preview)}</div>
              <div class="cv3-session-meta">
                ${modelLabel ? `<span class="cv3-session-chip">${esc(modelLabel)}</span>` : ''}
                ${projDisplay ? `<span class="cv3-session-proj" title="${esc(r.project || '')}">${esc(projDisplay)}</span>` : ''}
                <span class="cv3-session-count">${esc(String(r.messageCount || 0))} 条</span>
                <span class="cv3-session-when">${esc(formatRelativeTime(r.lastActiveAt))}</span>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>` : '<div class="cv3-proc-empty">暂无会话</div>';

    const refreshUsageClaude = '<button type="button" class="cv3-link-btn" data-console-v3-refresh-usage>刷新</button>';
    el.innerHTML = `
      ${cv3SectionHead(CV3_ICONS.clock, '本地 5h 窗口 (估算)', { extras: refreshUsageClaude })}
      <div class="cv3-usage-grid">
        <div class="cv3-usage-cell">
          <div class="cv3-usage-label">本机消息</div>
          <div class="cv3-usage-value">${esc(String(u.messagesInWindow || 0))}</div>
          <div class="cv3-usage-hint">窗口内</div>
        </div>
        <div class="cv3-usage-cell">
          <div class="cv3-usage-label">窗口起点</div>
          <div class="cv3-usage-value">${firstAt ? esc(firstAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })) : '—'}</div>
          <div class="cv3-usage-hint">${firstAt ? esc(formatRelativeTime(u.windowFirstMessageAt)) : '无活动'}</div>
        </div>
        <div class="cv3-usage-cell">
          <div class="cv3-usage-label">窗口剩余</div>
          <div class="cv3-usage-value">${esc(remainingText)}</div>
          <div class="cv3-usage-hint">到期后计数重置</div>
        </div>
        <div class="cv3-usage-cell">
          <div class="cv3-usage-label">近 24h 会话</div>
          <div class="cv3-usage-value">${esc(String(u.todaySessions || 0))}</div>
          <div class="cv3-usage-hint">共 ${esc(String(u.totalSessions || 0))} 个</div>
        </div>
      </div>
      <div class="cv3-session-head">最近会话</div>
      ${recentHtml}
      <div class="cv3-usage-note">⚠ 只统计本机 jsonl 历史；跨机 / web claude.ai 用量不在内，以账号服务端为准。</div>`;
    return;
  }

  // Other tools: just hide
  el.innerHTML = '';
}

// Reuse existing data sources but emit a leaner meta list.
function buildConsoleV2Model(tool) {
  const esc = typeof escapeHtml === 'function' ? escapeHtml : ((s) => String(s ?? ''));

  if (tool === 'codex') {
    const data = state.current || {};
    const codexBinary = typeof getToolBinaryStatus === 'function'
      ? getToolBinaryStatus('codex', data.codexBinary)
      : (data.codexBinary || {});
    const login = data.login || {};
    const active = data.activeProvider || null;
    const providers = Array.isArray(data.providers) ? data.providers : [];
    const health = active ? state.providerHealth[active.key] : null;

    const heroName = active?.name || (login.loggedIn ? (login.orgName || login.email || 'OpenAI 官方登录') : '尚未激活 Provider');
    const heroBase = active?.baseUrl || (login.loggedIn ? 'ChatGPT / OpenAI 官方' : '');
    const heroModel = data.summary?.model || '';
    const heroMode = active ? 'apikey' : (login.loggedIn ? 'oauth' : '');

    const issues = [];
    if (!codexBinary.installed) issues.push({ tone: 'error', title: 'Codex 未安装', copy: '还没检测到 codex 命令，先去「工具安装」页面。' });
    if (!data.configExists) issues.push({ tone: 'warn', title: '还没有 config.toml', copy: '当前作用域尚未写入 Codex 配置；建议先完成一次快速配置。' });
    if (!providers.length && !login.loggedIn) issues.push({ tone: 'error', title: '没有可用 Provider', copy: '既没有保存任何 Provider，也没有官方登录。' });
    if (active && !active.hasApiKey) issues.push({ tone: 'error', title: '当前 Provider 缺 Key', copy: `活动 Provider「${active.name}」未检测到可用 API Key。` });
    if (health?.checked && !health.ok) issues.push({ tone: 'warn', title: '连通性检测失败', copy: `最近一次对「${active?.name || '当前 Provider'}」的检测未通过。` });

    // Only fields that actually affect user decisions. Install path / env path
    // / reasoning strength etc. are one-click-away in the config editor.
    const meta = [
      { label: '版本', value: codexBinary.installed ? (codexBinary.version || '已安装') : '未安装' },
      { label: '作用域', value: data.scope === 'project' ? '项目级' : '全局' },
      { label: 'Sandbox', value: data.summary?.sandboxMode || '默认',
        tone: /danger/i.test(data.summary?.sandboxMode || '') ? 'warn' : '' },
      { label: '审批策略', value: data.summary?.approvalPolicy || '默认' },
    ];

    return {
      tool,
      toolLabel: 'Codex',
      hero: {
        name: heroName,
        baseUrl: heroBase,
        mode: heroMode,
        model: heroModel,
        plan: login.loggedIn ? (login.plan || '') : '',
        healthTxt: active ? (health?.loading ? '检测中' : health?.ok ? '已通' : health?.checked ? '失败' : '未检测') : (login.loggedIn ? '当前' : '未激活'),
        healthCls: active ? (health?.loading ? 'warn' : health?.ok ? 'ok' : health?.checked ? 'bad' : 'muted') : (login.loggedIn ? 'ok' : 'muted'),
      },
      meta,
      issues,
      providers: [],
      canLaunch: Boolean(codexBinary.installed),
    };
  }

  if (tool === 'claudecode') {
    const data = state.claudeCodeState || {};
    const login = data.login || {};
    const installed = Boolean(data.binary?.installed);

    const issues = [];
    if (!installed) issues.push({ tone: 'error', title: 'Claude Code 未安装', copy: '还没检测到 claude 命令，请先完成安装。' });
    if (!login.loggedIn && !data.hasApiKey) issues.push({ tone: 'error', title: '未认证', copy: '当前既没有 OAuth 登录，也没有检测到 ANTHROPIC_API_KEY。' });
    if (!data.model) issues.push({ tone: 'warn', title: '未显式指定模型', copy: '未设置默认模型时 Claude Code 会回退到内置默认值。' });

    // Hero already shows account + plan + model. Meta should be the
    // behavior-affecting switches only.
    const meta = [
      { label: '版本', value: installed ? (data.binary?.version || '已安装') : '未安装' },
      { label: '认证', value: login.loggedIn ? (login.method === 'oauth' ? 'OAuth' : 'API Key') : '未认证' },
      { label: 'Always thinking', value: data.alwaysThinkingEnabled ? '开启' : '关闭' },
      { label: '危险权限提示', value: data.skipDangerousModePermissionPrompt ? '已跳过' : '保持提示',
        tone: data.skipDangerousModePermissionPrompt ? 'warn' : '' },
    ];

    const historyModels = (data.usedModels || []).slice(0, 10);

    return {
      tool,
      toolLabel: 'Claude Code',
      hero: {
        name: login.email || login.orgName || (login.loggedIn ? '官方登录' : (installed ? '未登录' : '未安装')),
        baseUrl: login.loggedIn ? 'ChatGPT / Anthropic 官方' : 'https://api.anthropic.com',
        mode: login.method === 'oauth' ? 'oauth' : 'apikey',
        model: data.model || '',
        plan: login.plan || '',
        healthTxt: login.loggedIn ? '已登录' : (data.hasApiKey ? 'Key 就绪' : '未认证'),
        healthCls: login.loggedIn ? 'ok' : (data.hasApiKey ? 'ok' : 'muted'),
      },
      meta,
      issues,
      providers: [], // Claude providers are surfaced in the hub; console stays meta-only.
      historyModels,
      canLaunch: installed && (login.loggedIn || data.hasApiKey),
    };
  }

  if (tool === 'opencode') {
    const data = state.opencodeState || {};
    const active = data.activeProvider || null;
    const activeAuth = data.activeAuth || null;
    const installed = Boolean(data.binary?.installed);

    const issues = [];
    if (!installed) issues.push({ tone: 'error', title: 'OpenCode 未安装', copy: '没有检测到 opencode 命令，先到「工具安装」。' });
    if (!data.configExists) issues.push({ tone: 'warn', title: '还没有 opencode.json', copy: '当前作用域没有写入配置。' });
    if (!data.model) issues.push({ tone: 'warn', title: '默认模型未设置', copy: 'OpenCode 模型格式是 provider/model。' });
    if (active && !active.hasCredential) issues.push({ tone: 'warn', title: '当前 Provider 缺凭证', copy: `活动 Provider「${active.name || active.key}」还没有 Key / auth 登录。` });

    const meta = [
      { label: '版本', value: installed ? (data.binary?.version || '已安装') : '未安装' },
      { label: '作用域', value: data.scope === 'project' ? '项目级' : '全局' },
      { label: '默认模型', value: data.model || '—' },
      { label: '当前 Provider', value: active?.key || '—' },
    ];

    return {
      tool,
      toolLabel: 'OpenCode',
      hero: {
        name: active?.name || active?.key || '尚未激活 Provider',
        baseUrl: active?.baseUrl || '',
        mode: (activeAuth && String(activeAuth.type || '').toLowerCase().includes('oauth')) ? 'oauth' : 'apikey',
        model: data.model || '',
        plan: '',
        healthTxt: active?.hasCredential ? '凭证就绪' : '缺凭证',
        healthCls: active?.hasCredential ? 'ok' : 'warn',
      },
      meta,
      issues,
      providers: [],
      canLaunch: installed,
    };
  }

  // openclaw
  const data = state.openclawState || {};
  const installed = Boolean(data.binary?.installed);
  const gatewayUp = Boolean(data.gatewayStatus?.ok || data.gatewayRunning);
  const issues = [];
  if (!installed) issues.push({ tone: 'error', title: 'OpenClaw 未安装', copy: '请先在「工具安装」完成安装。' });
  else if (!gatewayUp) issues.push({ tone: 'warn', title: 'Gateway 未运行', copy: '点击启动后 Dashboard 才能用。' });

  const meta = [
    { label: '版本', value: installed ? (data.binary?.version || '已安装') : '未安装' },
    { label: 'Gateway', value: gatewayUp ? `运行中 · :${data.gatewayPort || '—'}` : '未运行',
      tone: gatewayUp ? '' : 'warn' },
    { label: 'Dashboard', code: data.dashboardUrl || '—' },
  ];

  return {
    tool: 'openclaw',
    toolLabel: 'OpenClaw',
    hero: {
      name: installed ? 'OpenClaw' : '未安装',
      baseUrl: data.dashboardUrl || '',
      mode: '',
      model: '',
      plan: '',
      healthTxt: gatewayUp ? '运行中' : '未运行',
      healthCls: gatewayUp ? 'ok' : 'warn',
    },
    meta,
    issues,
    providers: [],
    canLaunch: installed,
  };
}

function renderConsoleV2(tool) {
  const esc = typeof escapeHtml === 'function' ? escapeHtml : ((s) => String(s ?? ''));
  const model = buildConsoleV2Model(tool);

  // Kick off any data loads the v3 sections depend on. Safe to call each
  // render — each loader guards itself against re-entry.
  primeConsoleV3(tool);

  const titleToolEl = document.getElementById('consoleV2TitleTool');
  if (titleToolEl) titleToolEl.textContent = model.toolLabel;

  // v3 sections (vantage matrix replaces the old standalone firewall card).
  renderConsoleV3Procs(tool, model.toolLabel);
  renderConsoleV3Usage(tool);
  renderConsoleV3Vantages();

  const heroEl = document.getElementById('consoleV2Hero');
  if (heroEl) {
    const h = model.hero;
    const modeTxt = h.mode === 'oauth' ? 'OAUTH' : h.mode === 'apikey' ? 'API KEY' : '';
    heroEl.innerHTML = `
      <div class="console-v2-hero-info">
        <div class="console-v2-hero-eyebrow">
          <span>${esc(model.toolLabel.toUpperCase())} · SESSION</span>
          <span class="ch-status ${esc(h.healthCls)}">${esc(h.healthTxt)}</span>
        </div>
        <h2 class="console-v2-hero-name">${esc(h.name)}</h2>
        <div class="console-v2-hero-badges">
          ${modeTxt ? `<span class="ch-mode ${esc(h.mode)}">${modeTxt}</span>` : ''}
          ${h.plan ? `<span class="ch-row-plan" data-plan="${esc(String(h.plan).toLowerCase())}">${esc(String(h.plan).toUpperCase())}</span>` : ''}
          ${h.model ? `<span class="ch-hero-model">${esc(h.model)}</span>` : ''}
        </div>
        ${h.baseUrl ? `<div class="console-v2-hero-url">${esc(h.baseUrl)}</div>` : ''}
        ${renderHeroIpStripHTML()}
      </div>
      <div class="console-v2-hero-actions">
        <button type="button" class="ch-hero-ghost" data-console-v2-refresh>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.36 6.36L3 21M3 12a9 9 0 0 1 15.36-6.36L21 3"/></svg>
          重新检测
        </button>
        <button type="button" class="ch-hero-ghost" data-console-v2-goto-quick>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h16M4 6h16M4 18h10"/></svg>
          快速配置
        </button>
        <button type="button" class="ch-hero-ghost" data-console-v2-goto-editor>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3.5l6 6-11 11H3.5v-6l11-11z"/></svg>
          配置编辑
        </button>
      </div>`;
  }

  const metaEl = document.getElementById('consoleV2Meta');
  if (metaEl) {
    if (!model.meta.length) {
      metaEl.innerHTML = '';
    } else {
      metaEl.innerHTML = `
        ${cv3SectionHead(CV3_ICONS.sliders, '当前配置')}
        <div class="console-v2-meta-list">
          ${model.meta.map((m) => `
            <div class="console-v2-meta-row${m.tone ? ' cv3-meta-' + esc(m.tone) : ''}">
              <span class="console-v2-meta-label">${esc(m.label)}</span>
              <span class="console-v2-meta-value">
                ${m.value ? `<span>${esc(m.value)}</span>` : ''}
                ${m.code ? `<span class="console-v2-code">${esc(m.code)}</span>` : ''}
              </span>
            </div>`).join('')}
        </div>`;
    }
  }

  const issuesEl = document.getElementById('consoleV2Issues');
  if (issuesEl) {
    if (!model.issues.length) {
      issuesEl.innerHTML = '';
      issuesEl.classList.add('hide');
    } else {
      issuesEl.classList.remove('hide');
      issuesEl.innerHTML = `
        ${cv3SectionHead(CV3_ICONS.alert, '异常检测', { count: model.issues.length })}
        <div class="console-v2-issue-list">
          ${model.issues.map((i) => `
            <div class="console-v2-issue ${esc(i.tone || 'warn')}">
              <div class="console-v2-issue-title">${esc(i.title)}</div>
              <div class="console-v2-issue-copy">${esc(i.copy)}</div>
            </div>`).join('')}
        </div>`;
    }
  }

  const providersEl = document.getElementById('consoleV2Providers');
  if (providersEl) {
    if (!model.providers.length) {
      providersEl.innerHTML = '';
      providersEl.classList.add('hide');
    } else {
      providersEl.classList.remove('hide');
      providersEl.innerHTML = `
        <div class="console-v2-section-head">已保存 Provider<span class="count">· ${model.providers.length}</span></div>
        <div class="console-v2-provider-list">
          ${model.providers.map((p) => `
            <div class="console-v2-provider ${p.isActive ? 'current' : ''}">
              <span class="console-v2-provider-dot ${esc(p.statusCls)}"></span>
              <span class="console-v2-provider-body">
                <span class="console-v2-provider-name">${esc(p.name)}</span>
                ${p.baseUrl ? `<span class="console-v2-provider-url">${esc(p.baseUrl)}</span>` : ''}
              </span>
              <span class="ch-status ${esc(p.statusCls)}">${esc(p.statusTxt)}</span>
            </div>`).join('')}
        </div>`;
    }
  }
}



async function stopOpenClawGateway({ manual = true } = {}) {
  const result = await api('/api/openclaw/stop', { method: 'POST' });
  if (!result.ok) {
    if (manual) flash(result.error || '停止 Gateway 失败', 'error');
    return result;
  }
  await sleep(400);
  await refreshToolRuntimeAfterMutation('openclaw');
  if (manual) flash(result.data?.message || 'OpenClaw 已停止', 'success');
  return result;
}

async function setOpenClawDaemonEnabled(enabled, { manual = true } = {}) {
  const result = await api('/api/openclaw/daemon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: Boolean(enabled) }),
  });
  if (!result.ok) {
    if (manual) flash(result.error || (enabled ? '开启常驻服务失败' : '关闭常驻服务失败'), 'error');
    return result;
  }
  await sleep(400);
  await refreshToolRuntimeAfterMutation('openclaw');
  if (manual) flash(result.data?.message || (enabled ? 'OpenClaw 常驻服务已开启' : 'OpenClaw 常驻服务已关闭'), 'success');
  return result;
}

async function killOpenClawPortOccupants({ manual = true } = {}) {
  const data = state.openclawState || await fetchOpenClawStateData();
  const occupants = Array.isArray(data.gatewayPortOccupants) ? data.gatewayPortOccupants : [];
  if (!occupants.length) {
    if (manual) flash(`未检测到 ${data.gatewayPort || '18789'} 端口占用进程`, 'info');
    return { ok: true, data: { killed: [] } };
  }

  const confirmed = await openUpdateDialog({
    eyebrow: 'OpenClaw',
    title: `结束 ${data.gatewayPort || '18789'} 端口占用`,
    body: `<p>将尝试结束以下进程：</p><div class="install-cmd-block">${occupants.map((item) => escapeHtml(item.label || `${item.name || '未知进程'} (PID ${item.pid || '-'})`)).join('<br>')}</div>`,
    confirmText: '结束进程',
    cancelText: '取消',
    tone: 'danger',
  });
  if (!confirmed) return { ok: false, cancelled: true };

  const result = await api('/api/openclaw/port-kill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!result.ok) {
    if (manual) flash(result.error || '结束端口占用进程失败', 'error');
    return result;
  }
  await loadOpenClawQuickState();
  if (manual) flash(result.data?.message || '端口占用进程已结束', 'success');
  return result;
}

async function repairOpenClawDashboard({ silent = false } = {}) {
  const data = state.openclawState || await fetchOpenClawStateData();
  if (!data.binary?.installed) {
    if (!silent) flash('OpenClaw 尚未安装', 'error');
    return;
  }
  const json = await api('/api/openclaw/repair-dashboard-auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: state.current?.launch?.cwd || '' }),
  });
  if (!json.ok || !json.data?.dashboardUrl) {
    throw new Error(json.error || '修复 Gateway 认证失败');
  }
  state.openClawLastRepair = json.data;
  await fetchOpenClawStateData();
  await openOpenClawDashboard(json.data.dashboardUrl);
  if (!silent) {
    flash(json.data.tokenGenerated ? '已生成新 token 并重新打开 Dashboard' : '已重新打开带令牌的 Dashboard', 'success');
  }
}

async function refreshToolConsoleData({ manual = false } = {}) {
  if (state.consoleRefreshing) return;
  state.consoleRefreshing = true;
  const btn = el('toolConsoleRefreshBtn');
  const original = btn?.textContent || '↻ 刷新检测';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '检测中...';
  }
  try {
    await loadState({ preserveForm: true });
    await loadClaudeCodeQuickState();
    await loadOpenCodeQuickState();
    await loadOpenClawQuickState();
    renderToolConsole();
    if (manual) flash(`${getToolConsoleLabel(state.consoleTool)} 控制台已刷新`, 'success');
  } finally {
    state.consoleRefreshing = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = original;
    }
  }
}

async function handleToolConsoleAction(button) {
  const action = button?.dataset.consoleAction;
  const targetTool = button?.dataset.consoleToolTarget || '';
  if (!action) return;

  if (action === 'refresh-console') {
    await refreshToolConsoleData({ manual: true });
    return;
  }

  if (action === 'goto-page') {
    setPage(button.dataset.consolePage || 'quick');
    return;
  }

  if (action === 'goto-quick-tool') {
    if (targetTool) setActiveTool(targetTool);
    if (targetTool === 'codex') {
      const login = state.current?.login || {};
      if (login.loggedIn && String(login.method || '').toLowerCase() === 'chatgpt') {
        state.codexAuthView = 'official';
        localStorage.setItem('easyaiconfig_codex_auth_view', state.codexAuthView);
      }
    }
    setPage('quick');
    return;
  }

  if (action === 'goto-config-editor-tool') {
    if (targetTool === 'openclaw' && !state.openclawState) {
      await loadOpenClawQuickState();
    }
    if (targetTool === 'claudecode' && !state.claudeCodeState) {
      await loadClaudeCodeQuickState();
    }
    if (targetTool !== 'openclaw' && !state.current) {
      await loadState({ preserveForm: true });
    }
    state.configEditorTool = normalizeConfigEditorTool(targetTool);
    syncConfigEditorForTool();
    populateConfigEditor();
    if (window.refreshCustomSelects) window.refreshCustomSelects();
    setPage('configEditor');
    return;
  }

  if (action === 'opencode-auth-login') {
    const provider = button.dataset.consoleProvider || state.opencodeState?.activeProviderKey || '';
    const method = button.dataset.consoleMethod || '';
    const original = button.textContent || '启动 auth login';
    button.disabled = true;
    button.textContent = '启动中...';
    try {
      const json = await api('/api/opencode/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: el('launchCwdInput')?.value?.trim() || el('projectPathInput')?.value?.trim() || '',
          provider,
          method,
        }),
      });
      if (!json.ok) {
        flash(json.error || '启动 OpenCode 登录失败', 'error');
        return;
      }
      flash('已在终端打开 OpenCode auth login，请完成登录后点击刷新状态', 'success');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
    return;
  }

  if (action === 'opencode-auth-remove') {
    const provider = button.dataset.consoleAuthKey || button.dataset.consoleProvider || state.opencodeState?.activeAuth?.key || '';
    if (!provider) {
      flash('未找到可移除的 OpenCode 凭证', 'error');
      return;
    }
    if (!window.confirm(`确认移除 OpenCode 凭证「${provider}」吗？`)) return;
    const original = button.textContent || '移除当前凭证';
    button.disabled = true;
    button.textContent = '移除中...';
    try {
      const json = await api('/api/opencode/auth-remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: el('scopeSelect')?.value || 'global',
          projectPath: el('projectPathInput')?.value?.trim() || '',
          provider,
        }),
      });
      if (!json.ok) {
        flash(json.error || '移除 OpenCode 凭证失败', 'error');
        return;
      }
      await loadOpenCodeQuickState();
      if (state.activePage === 'configEditor' && getConfigEditorTool() === 'opencode') {
        populateConfigEditor();
      }
      renderToolConsole();
      renderCurrentConfig();
      flash('OpenCode 凭证已移除', 'success');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
    return;
  }

  if (action === 'launch-openclaw') {
    await launchOpenClawOnly();
    renderToolConsole();
    return;
  }

  if (action === 'open-openclaw-dashboard') {
    const data = state.openclawState || await fetchOpenClawStateData();
    if (!data.gatewayReachable) {
      flash('Dashboard 还没准备好，请先启动 OpenClaw', 'info');
      return;
    }
    await repairOpenClawDashboard({ silent: true });
    return;
  }

  if (action === 'repair-openclaw-dashboard') {
    await repairOpenClawDashboard();
    renderToolConsole();
    return;
  }

  if (action === 'kill-openclaw-port') {
    await killOpenClawPortOccupants({ manual: true });
    renderToolConsole();
    return;
  }

  if (action === 'stop-openclaw') {
    await stopOpenClawGateway({ manual: true });
    renderToolConsole();
    return;
  }

  if (action === 'toggle-openclaw-daemon') {
    const data = state.openclawState || await fetchOpenClawStateData();
    await setOpenClawDaemonEnabled(!data.daemonInstalled, { manual: true });
    renderToolConsole();
    return;
  }
}

function parseApiRequest(url, options = {}) {
  const target = new URL(url, window.location.origin);
  const query = Object.fromEntries(target.searchParams.entries());
  let body = undefined;
  if (options.body) {
    try {
      body = JSON.parse(options.body);
    } catch {
      body = undefined;
    }
  }
  return {
    path: target.pathname,
    method: options.method || 'GET',
    query,
    body,
  };
}

let localApiAuth = { token: '', header: 'x-local-token' };

async function ensureLocalApiAuth() {
  if (tauriInvoke || localApiAuth.token) return localApiAuth;
  const response = await fetch('/api/bootstrap', { cache: 'no-store' });
  const json = await response.json();
  if (!json?.ok || !json?.data?.token) {
    throw new Error(json?.error || '本地服务鉴权初始化失败');
  }
  localApiAuth = {
    token: String(json.data.token),
    header: String(json.data.header || 'x-local-token'),
  };
  return localApiAuth;
}

async function api(url, options = {}) {
  const timeoutMs = options.timeoutMs || 20000;

  if (tauriInvoke) {
    let timeoutId;
    try {
      const result = await Promise.race([
        tauriInvoke('backend_request', parseApiRequest(url, options)),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('请求超时')), timeoutMs);
        }),
      ]);
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const auth = await ensureLocalApiAuth();
  const headers = new Headers(options.headers || {});
  headers.set(auth.header, auth.token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, headers, signal: controller.signal });
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, error: '请求超时，请稍后再试' };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── TOML / JSON Syntax Highlighter ── */
function highlightToml(toml) {
  if (!toml) return '<span class="toml-hl-comment"># 暂无配置</span>';
  return toml.split('\n').map(line => {
    // Comment
    if (/^\s*#/.test(line)) return `<span class="toml-hl-comment">${escapeHtml(line)}</span>`;
    // Section header  [section] or [[array]]
    const secMatch = line.match(/^(\s*\[{1,2})([^\]]+)(\]{1,2})/);
    if (secMatch) return `<span class="toml-hl-section">${escapeHtml(line)}</span>`;
    // Key = value
    const kvMatch = line.match(/^(\s*)([A-Za-z0-9_.\-]+)(\s*=\s*)(.*)/);
    if (kvMatch) {
      const [, indent, key, eq, val] = kvMatch;
      return `${escapeHtml(indent)}<span class="toml-hl-key">${escapeHtml(key)}</span><span class="toml-hl-eq">${escapeHtml(eq)}</span>${highlightTomlValue(val)}`;
    }
    return escapeHtml(line);
  }).join('\n');
}

function highlightTomlValue(val) {
  const trimmed = val.trim();
  // String (double or single quoted)
  if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) return `<span class="toml-hl-str">${escapeHtml(val)}</span>`;
  // Multi-line string start
  if (/^"""/.test(trimmed) || /^'''/.test(trimmed)) return `<span class="toml-hl-str">${escapeHtml(val)}</span>`;
  // Boolean
  if (trimmed === 'true' || trimmed === 'false') return `<span class="toml-hl-bool">${escapeHtml(val)}</span>`;
  // Number
  if (/^-?\d[\d_.]*$/.test(trimmed) || /^0x[\da-fA-F]+$/.test(trimmed)) return `<span class="toml-hl-num">${escapeHtml(val)}</span>`;
  // Array
  if (trimmed.startsWith('[')) return `<span class="toml-hl-str">${escapeHtml(val)}</span>`;
  // Inline table
  if (trimmed.startsWith('{')) return `<span class="toml-hl-str">${escapeHtml(val)}</span>`;
  return escapeHtml(val);
}

function highlightJson(json) {
  if (!json) return '<span class="toml-hl-comment">// 暂无配置</span>';
  return json.split('\n').map(line => {
    // String key: "key":
    let result = line.replace(/"([^"]+)"\s*:/g, '<span class="toml-hl-key">"$1"</span><span class="toml-hl-eq">:</span>');
    // String values
    result = result.replace(/:\s*"([^"]*)"/g, ': <span class="toml-hl-str">"$1"</span>');
    // Booleans
    result = result.replace(/\b(true|false|null)\b/g, '<span class="toml-hl-bool">$1</span>');
    // Numbers
    result = result.replace(/:\s*(-?\d[\d.]*)/g, ': <span class="toml-hl-num">$1</span>');
    return result;
  }).join('\n');
}

function getRawCodeEditorTheme() {
  return state.theme === 'light' ? 'ace/theme/github' : 'ace/theme/tomorrow_night_eighties';
}

function ensureRawCodeEditor({ editorId, textareaId, mode }) {
  const host = el(editorId);
  const textarea = el(textareaId);
  if (!host || !textarea || !window.ace) return null;
  if (rawCodeEditors.has(textareaId)) return rawCodeEditors.get(textareaId);

  window.ace.config.set('basePath', '/vendor/ace');
  const editor = window.ace.edit(editorId);
  editor.session.setMode(mode);
  editor.session.setUseWorker(false);
  editor.session.setTabSize(2);
  editor.session.setUseSoftTabs(true);
  editor.setTheme(getRawCodeEditorTheme());
  editor.setOptions({
    fontSize: '12px',
    showPrintMargin: false,
    wrap: false,
    highlightActiveLine: true,
    scrollPastEnd: 0.15,
    animatedScroll: true,
  });
  editor.setValue(textarea.value || '', -1);
  editor.session.on('change', () => {
    textarea.value = editor.getValue();
  });
  rawCodeEditors.set(textareaId, editor);
  return editor;
}

function initRawCodeEditors() {
  if (!window.ace) {
    document.querySelectorAll('.raw-code-editor').forEach((node) => node.classList.add('hide'));
    document.querySelectorAll('.raw-config-native').forEach((node) => {
      node.classList.remove('raw-config-native');
      node.hidden = false;
      node.style.display = '';
    });
    return;
  }

  ensureRawCodeEditor({ editorId: 'cfgRawTomlEditor', textareaId: 'cfgRawTomlTextarea', mode: 'ace/mode/toml' });
  ensureRawCodeEditor({ editorId: 'cfgRawAuthEditor', textareaId: 'cfgRawAuthTextarea', mode: 'ace/mode/json' });
  ensureRawCodeEditor({ editorId: 'ccCfgRawJsonEditor', textareaId: 'ccCfgRawJsonTextarea', mode: 'ace/mode/json' });
  ensureRawCodeEditor({ editorId: 'opCfgRawJsonEditor', textareaId: 'opCfgRawJsonTextarea', mode: 'ace/mode/json' });
  ensureRawCodeEditor({ editorId: 'ocCfgRawJsonEditor', textareaId: 'ocCfgRawJsonTextarea', mode: 'ace/mode/json' });
  syncRawCodeEditorTheme();
}

function syncRawConfigHighlight() {
  initRawCodeEditors();
  rawCodeEditors.forEach((editor, textareaId) => {
    const textarea = el(textareaId);
    if (!textarea) return;
    const nextValue = textarea.value || '';
    if (editor.getValue() !== nextValue) editor.setValue(nextValue, -1);
  });
  refreshRawCodeEditors();
}

function syncRawCodeEditorTheme() {
  const theme = getRawCodeEditorTheme();
  rawCodeEditors.forEach((editor) => editor.setTheme(theme));
}

function refreshRawCodeEditors() {
  requestAnimationFrame(() => {
    rawCodeEditors.forEach((editor) => editor.resize());
  });
}

function switchConfigEditorView(view) {
  const layout = el('configEditorLayout');
  if (!layout) return;
  // Update toggle buttons
  document.querySelectorAll('.cfg-view-icon').forEach(b => {
    b.classList.toggle('active', b.dataset.cfgView === view);
  });
  // Apply view mode
  layout.dataset.viewMode = view;
  closeCfg3Drawer();
  syncConfigEditorShellView(view);
  refreshRawCodeEditors();
}

// Expose to global scope for onclick attributes (script is type="module")
window.switchConfigEditorView = switchConfigEditorView;

// Also add event delegation as fallback
document.addEventListener('click', (e) => {
  const viewBtn = e.target.closest('.cfg-view-icon');
  if (viewBtn) {
    const view = viewBtn.dataset.cfgView;
    if (view) switchConfigEditorView(view);
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

const OPENCLAW_DEFAULT_CONTEXT_WINDOW = 200000;
const OPENCLAW_DEFAULT_MAX_TOKENS = 8192;

const OPENCLAW_PROTOCOL_PRESETS = [
  { value: 'openai-completions', label: 'OpenAI Chat / Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Claude / Anthropic Messages' },
];

const OPENCLAW_PROTOCOL_META = {
  'openai-completions': {
    label: 'OpenAI Chat / Completions',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'openai/gpt-5.3-codex',
    defaultEnvKey: 'OPENAI_API_KEY',
    endpointHint: '/v1/chat/completions',
  },
  'openai-responses': {
    label: 'OpenAI Responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'openai/gpt-5.4',
    defaultEnvKey: 'OPENAI_API_KEY',
    endpointHint: '/v1/responses',
  },
  'anthropic-messages': {
    label: 'Claude / Anthropic Messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'anthropic/claude-sonnet-4-6',
    defaultEnvKey: 'ANTHROPIC_API_KEY',
    endpointHint: '/v1/messages',
  },
};

const OPENCLAW_CN_PROVIDER_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek/deepseek-chat', providerKind: 'openai', envKey: 'DEEPSEEK_API_KEY', tip: '官方直连，适合 DeepSeek Chat / Reasoner' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'siliconflow/deepseek-ai/DeepSeek-V3', providerKind: 'openai', envKey: 'SILICONFLOW_API_KEY', tip: '国内常用聚合线路，模型选择多' },
  { id: 'bailian', label: '阿里百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'bailian/qwen-plus', providerKind: 'openai', envKey: 'DASHSCOPE_API_KEY', tip: 'Qwen 生态，国内访问稳定' },
  { id: 'volcengine', label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'volcengine/doubao-seed-1-6-thinking-250715', providerKind: 'openai', envKey: 'ARK_API_KEY', tip: '豆包 / 多模型接入，适合国内网络' },
  { id: 'zhipu', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'zhipu/glm-4.5', providerKind: 'openai', envKey: 'ZHIPU_API_KEY', tip: 'GLM 系列，OpenAI 兼容接入' },
];

const OPENCLAW_MODEL_PRESETS = [
  {
    label: '国内推荐',
    options: [
      { value: 'deepseek/deepseek-chat', label: 'DeepSeek · DeepSeek Chat', apis: ['openai-completions'] },
      { value: 'deepseek/deepseek-reasoner', label: 'DeepSeek · DeepSeek Reasoner', apis: ['openai-completions'] },
      { value: 'siliconflow/deepseek-ai/DeepSeek-V3', label: '硅基流动 · DeepSeek V3', apis: ['openai-completions'] },
      { value: 'bailian/qwen-plus', label: '阿里百炼 · Qwen Plus', apis: ['openai-completions'] },
      { value: 'volcengine/doubao-seed-1-6-thinking-250715', label: '火山方舟 · 豆包 Thinking', apis: ['openai-completions'] },
      { value: 'zhipu/glm-4.5', label: '智谱 · GLM-4.5', apis: ['openai-completions'] },
    ],
  },
  {
    label: 'OpenAI / GPT',
    options: [
      { value: 'openai/gpt-5.4', label: 'GPT-5.4', apis: ['openai-responses', 'openai-completions'] },
      { value: 'openai/gpt-5.3-codex', label: 'GPT-5.3 Codex', apis: ['openai-responses', 'openai-completions'] },
      { value: 'openai/gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', apis: ['openai-responses', 'openai-completions'] },
      { value: 'openai/gpt-5.3-instant', label: 'GPT-5.3 Instant', apis: ['openai-responses', 'openai-completions'] },
      { value: 'openai/gpt-5.2', label: 'GPT-5.2', apis: ['openai-responses', 'openai-completions'] },
      { value: 'openai/gpt-5.1-codex', label: 'GPT-5.1 Codex', apis: ['openai-responses', 'openai-completions'] },
      { value: 'openai/gpt-5.1', label: 'GPT-5.1', apis: ['openai-completions', 'openai-responses'] },
      { value: 'openai/gpt-5.1-mini', label: 'GPT-5.1 Mini', apis: ['openai-completions', 'openai-responses'] },
      { value: 'openai/o3', label: 'o3', apis: ['openai-responses', 'openai-completions'] },
      { value: 'openai/o4-mini', label: 'o4-mini', apis: ['openai-responses', 'openai-completions'] },
    ],
  },
  {
    label: 'Anthropic / Claude',
    options: [
      { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6', apis: ['anthropic-messages'] },
      { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', apis: ['anthropic-messages'] },
      { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', apis: ['anthropic-messages'] },
      { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', apis: ['anthropic-messages'] },
      { value: 'anthropic/claude-haiku-3-5', label: 'Claude Haiku 3.5', apis: ['anthropic-messages'] },
    ],
  },
  {
    label: 'Google / Gemini',
    options: [
      { value: 'google/gemini-3-pro', label: 'Gemini 3 Pro', apis: ['openai-completions'] },
      { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', apis: ['openai-completions'] },
      { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', apis: ['openai-completions'] },
    ],
  },
  {
    label: '兼容服务示例',
    options: [
      { value: 'openrouter/anthropic/claude-sonnet-4-5', label: 'OpenRouter · Claude Sonnet 4.5', apis: ['openai-completions', 'openai-responses'] },
      { value: 'moonshot/kimi-k2.5', label: 'Moonshot · Kimi K2.5', apis: ['openai-completions'] },
      { value: 'deepseek/deepseek-r1', label: 'DeepSeek R1', apis: ['openai-completions'] },
    ],
  },
];

/** Model presets for Codex config editor (without provider prefix). */
const CODEX_MODEL_PRESETS = [
  {
    label: 'OpenAI / GPT',
    options: [
      { value: 'gpt-5.4', label: 'GPT-5.4' },
      { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
      { value: 'gpt-5.3-instant', label: 'GPT-5.3 Instant' },
      { value: 'gpt-5.2', label: 'GPT-5.2' },
      { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
      { value: 'gpt-5.1', label: 'GPT-5.1' },
      { value: 'gpt-5.1-mini', label: 'GPT-5.1 Mini' },
      { value: 'o3', label: 'o3' },
      { value: 'o4-mini', label: 'o4-mini' },
    ],
  },
  {
    label: 'Anthropic / Claude',
    options: [
      { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
      { value: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { value: 'claude-haiku-3-5', label: 'Claude Haiku 3.5' },
    ],
  },
  {
    label: 'Google / Gemini',
    options: [
      { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
  },
  {
    label: '其他',
    options: [
      { value: 'deepseek-r1', label: 'DeepSeek R1' },
    ],
  },
];

// Codex model context-window caps used by the config editor UI.
const CODEX_MODEL_CONTEXT_WINDOWS = {
  'gpt-5.4': 1048576,
  'gpt-5.3-codex': 272000,
  'gpt-5.2': 272000,
  'gpt-5.1-codex': 272000,
  'gpt-5.1': 272000,
};

function normalizeCodexModelSlug(value = '') {
  return String(value || '').trim().toLowerCase();
}

function resolveCodexModelContextWindowCap(modelValue = '') {
  const normalized = normalizeCodexModelSlug(modelValue);
  if (!normalized) return null;
  if (CODEX_MODEL_CONTEXT_WINDOWS[normalized]) return CODEX_MODEL_CONTEXT_WINDOWS[normalized];
  const parts = normalized.split('/');
  const tail = parts[parts.length - 1] || '';
  if (tail && CODEX_MODEL_CONTEXT_WINDOWS[tail]) return CODEX_MODEL_CONTEXT_WINDOWS[tail];
  return null;
}

function getCodexSelectedModelValue() {
  return String(el('cfgModelInput')?.value || configValue('model', '') || '').trim();
}

function getCodexSelectedModelContextCap() {
  return resolveCodexModelContextWindowCap(getCodexSelectedModelValue());
}

const OPENCLAW_MODEL_NAME_PRESETS = [
  {
    label: 'OpenAI',
    options: [
      { value: 'GPT-5.4', label: 'GPT-5.4' },
      { value: 'GPT-5.3 Codex', label: 'GPT-5.3 Codex' },
      { value: 'GPT-5.3 Codex Spark', label: 'GPT-5.3 Codex Spark' },
      { value: 'GPT-5.3 Instant', label: 'GPT-5.3 Instant' },
      { value: 'GPT-5.2', label: 'GPT-5.2' },
      { value: 'GPT-5.1 Codex', label: 'GPT-5.1 Codex' },
      { value: 'GPT-5.1', label: 'GPT-5.1' },
      { value: 'GPT-5.1 Mini', label: 'GPT-5.1 Mini' },
      { value: 'o3', label: 'o3' },
      { value: 'o4-mini', label: 'o4-mini' },
    ],
  },
  {
    label: 'Claude',
    options: [
      { value: 'Claude Opus 4.6', label: 'Opus 4.6' },
      { value: 'Claude Opus 4.5', label: 'Opus 4.5' },
      { value: 'Claude Sonnet 4.6', label: 'Sonnet 4.6' },
      { value: 'Claude Sonnet 4.5', label: 'Sonnet 4.5' },
      { value: 'Claude Haiku 3.5', label: 'Haiku 3.5' },
    ],
  },
  {
    label: 'Google',
    options: [
      { value: 'Gemini 3 Pro', label: 'Gemini 3 Pro' },
      { value: 'Gemini 2.5 Pro', label: 'Gemini 2.5 Pro' },
      { value: 'Gemini 2.5 Flash', label: 'Gemini 2.5 Flash' },
    ],
  },
  {
    label: '其他',
    options: [
      { value: 'DeepSeek R1', label: 'DeepSeek R1' },
    ],
  },
];

/**
 * Initialize a model combobox on a `.model-combobox` container.
 * @param {HTMLElement} container - The .model-combobox div
 * @param {Array} presets - Model presets array (grouped options)
 * @param {Object} [opts] - Options
 * @param {boolean} [opts.isFallbacks] - If true, supports comma-separated multi-value (insert only at end)
 */
function initModelCombobox(container, presets, opts = {}) {
  const input = container.querySelector('input');
  if (!input || container._comboboxInit) return;
  container._comboboxInit = true;

  // Create toggle button
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'model-combobox-toggle';
  toggle.tabIndex = -1;
  toggle.title = '选择模型';
  toggle.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>`;
  container.appendChild(toggle);

  // Create dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'model-combobox-dropdown';
  container.appendChild(dropdown);

  let highlightIndex = -1;
  let flatOptions = [];

  function getAllFlatOptions() {
    const result = [];
    for (const group of presets) {
      for (const opt of group.options) {
        result.push({ ...opt, group: group.label });
      }
    }
    return result;
  }

  function getFilterText() {
    const val = input.value || '';
    if (opts.isFallbacks) {
      // Get text after last comma
      const parts = val.split(',');
      return (parts[parts.length - 1] || '').trim();
    }
    return val.trim();
  }

  function renderDropdown() {
    const filter = getFilterText().toLowerCase();
    const currentValue = input.value.trim();
    let html = '';
    flatOptions = [];
    let totalVisible = 0;

    for (const group of presets) {
      const matched = group.options.filter(opt => {
        if (!filter) return true;
        return opt.value.toLowerCase().includes(filter) || opt.label.toLowerCase().includes(filter);
      });
      if (matched.length === 0) continue;
      html += `<div class="model-combobox-group">`;
      html += `<div class="model-combobox-group-label">${escapeHtml(group.label)}</div>`;
      for (const opt of matched) {
        const idx = flatOptions.length;
        const isSelected = !opts.isFallbacks && currentValue === opt.value;
        const isHighlighted = idx === highlightIndex;
        let cls = 'model-combobox-option';
        if (isSelected) cls += ' selected';
        if (isHighlighted) cls += ' highlighted';
        html += `<div class="${cls}" data-value="${escapeHtml(opt.value)}" data-index="${idx}">`;
        html += `<span class="model-combobox-option-value">${escapeHtml(opt.value)}</span>`;
        html += `<span class="model-combobox-option-label">${escapeHtml(opt.label)}</span>`;
        html += `</div>`;
        flatOptions.push(opt);
        totalVisible++;
      }
      html += `</div>`;
    }
    if (totalVisible === 0) {
      html = `<div class="model-combobox-empty">无匹配模型，可直接输入自定义名称</div>`;
    }
    html += `<div class="model-combobox-hint">输入搜索 · 点击选择 · 支持自定义模型名</div>`;
    dropdown.innerHTML = html;
  }

  function openDropdown() {
    highlightIndex = -1;
    renderDropdown();
    container.classList.add('open');
  }

  function closeDropdown() {
    container.classList.remove('open');
    highlightIndex = -1;
  }

  function isOpen() {
    return container.classList.contains('open');
  }

  function selectOption(value) {
    if (opts.isFallbacks) {
      // Append after last comma
      const val = input.value || '';
      const parts = val.split(',').map(s => s.trim()).filter(Boolean);
      // Remove any partial typed portion at the end
      const lastPart = (val.split(',').pop() || '').trim();
      if (lastPart && !parts.includes(lastPart) && !presets.some(g => g.options.some(o => o.value === lastPart))) {
        parts.pop();
      }
      // Add new value if not already present
      if (!parts.includes(value)) {
        parts.push(value);
      }
      input.value = parts.join(', ');
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    closeDropdown();
    input.focus();
  }

  function scrollHighlightedIntoView() {
    if (highlightIndex < 0) return;
    const optEl = dropdown.querySelector(`[data-index="${highlightIndex}"]`);
    if (optEl) optEl.scrollIntoView({ block: 'nearest' });
  }

  // Event listeners
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isOpen()) {
      closeDropdown();
    } else {
      openDropdown();
      input.focus();
    }
  });

  input.addEventListener('focus', () => {
    if (!isOpen()) openDropdown();
  });

  input.addEventListener('input', () => {
    if (!isOpen()) openDropdown();
    else renderDropdown();
  });

  input.addEventListener('keydown', (e) => {
    if (!isOpen()) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openDropdown();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightIndex = Math.min(highlightIndex + 1, flatOptions.length - 1);
      renderDropdown();
      scrollHighlightedIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightIndex = Math.max(highlightIndex - 1, 0);
      renderDropdown();
      scrollHighlightedIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIndex >= 0 && highlightIndex < flatOptions.length) {
        selectOption(flatOptions[highlightIndex].value);
      } else {
        closeDropdown();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeDropdown();
    }
  });

  dropdown.addEventListener('mousedown', (e) => {
    e.preventDefault(); // prevent input blur
    const opt = e.target.closest('.model-combobox-option');
    if (opt?.dataset.value) {
      selectOption(opt.dataset.value);
    }
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      closeDropdown();
    }
  });

  // Expose refresh method
  container._comboboxRefresh = renderDropdown;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function isEmptyConfigValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function setDeepConfigValue(target, path, value) {
  const keys = Array.isArray(path) ? path : String(path || '').split('.').filter(Boolean);
  if (!keys.length) return;

  const parents = [];
  let current = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) {
      current[key] = {};
    }
    parents.push([current, key]);
    current = current[key];
  }

  const leaf = keys[keys.length - 1];
  if (isEmptyConfigValue(value)) {
    delete current[leaf];
  } else {
    current[leaf] = value;
  }

  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const [parent, key] = parents[index];
    if (isEmptyConfigValue(parent[key])) {
      delete parent[key];
    }
  }
}

function readJsonFragmentInput(inputId, label) {
  const raw = String(el(inputId)?.value || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJsonFragmentInput(inputId, value) {
  const target = el(inputId);
  if (!target) return;
  target.value = isEmptyConfigValue(value) ? '' : JSON.stringify(value, null, 2);
}

function syncOpenClawConfigView() {
  const editor = document.querySelector('[data-tool-editor="openclaw"]');
  if (!editor) return;
  const mode = state.openClawConfigView === 'minimal' ? 'minimal' : 'full';
  editor.dataset.ocConfigView = mode;
  document.querySelectorAll('[data-oc-config-view]').forEach((button) => {
    const active = button.dataset.ocConfigView === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function setOpenClawConfigView(mode = 'full') {
  state.openClawConfigView = mode === 'minimal' ? 'minimal' : 'full';
  localStorage.setItem('easyaiconfig_oc_config_view', state.openClawConfigView);
  syncOpenClawConfigView();
}

function maskSecret(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 3)}***`;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function getOpenClawProtocolMeta(apiMode = 'openai-completions') {
  return OPENCLAW_PROTOCOL_META[apiMode] || OPENCLAW_PROTOCOL_META['openai-completions'];
}

function findOpenClawModelPreset(modelRef = '') {
  const raw = String(modelRef || '').trim();
  if (!raw) return null;
  for (const group of OPENCLAW_MODEL_PRESETS) {
    const hit = group.options.find((option) => option.value === raw);
    if (hit) return hit;
  }
  return null;
}

function renderOpenClawProtocolOptions(currentApi = 'openai-completions') {
  return OPENCLAW_PROTOCOL_PRESETS.map((option) => {
    const selected = option.value === currentApi ? ' selected' : '';
    return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
  }).join('');
}

function getOpenClawDefaultModel(apiMode = 'openai-completions') {
  return getOpenClawProtocolMeta(apiMode).defaultModel;
}

function getOpenClawDefaultBaseUrl(apiMode = 'openai-completions') {
  return getOpenClawProtocolMeta(apiMode).defaultBaseUrl;
}

function getOpenClawDefaultEnvKey(apiMode = 'openai-completions') {
  return getOpenClawProtocolMeta(apiMode).defaultEnvKey;
}

function openClawProtocolSupportsModel(apiMode = 'openai-completions', modelRef = '') {
  const preset = findOpenClawModelPreset(modelRef);
  if (preset?.apis?.length) {
    return preset.apis.includes(apiMode);
  }
  const provider = String(modelRef || '').split('/')[0];
  if (!provider) return true;
  if (apiMode === 'anthropic-messages') {
    return ['anthropic', 'synthetic', 'minimax', 'kimi-coding'].includes(provider);
  }
  return !['anthropic', 'synthetic', 'minimax', 'kimi-coding'].includes(provider);
}

function inferOpenClawModelName(modelRef = '') {
  const raw = String(modelRef || '').trim();
  if (!raw) return 'OpenClaw Model';
  const preset = findOpenClawModelPreset(raw);
  if (preset) return preset.label;
  const modelId = extractOpenClawCustomModelId(raw) || raw;
  return modelId
    .split(/[\/_:-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferOpenClawBuiltInEnvKey(modelRef = '', apiMode = '') {
  const provider = String(modelRef || '').split('/')[0];
  const envKey = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    moonshot: 'MOONSHOT_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    siliconflow: 'SILICONFLOW_API_KEY',
    bailian: 'DASHSCOPE_API_KEY',
    volcengine: 'ARK_API_KEY',
    zhipu: 'ZHIPU_API_KEY',
    'kimi-coding': 'KIMI_API_KEY',
    together: 'TOGETHER_API_KEY',
    google: 'GEMINI_API_KEY',
  }[provider] || '';
  if (envKey) return envKey;
  return getOpenClawDefaultEnvKey(apiMode || inferOpenClawApiMode(modelRef));
}

function inferOpenClawApiMode(modelRef = '') {
  const preset = findOpenClawModelPreset(modelRef);
  if (preset?.apis?.length === 1) {
    return preset.apis[0];
  }
  const provider = String(modelRef || '').split('/')[0];
  return ['anthropic', 'synthetic', 'minimax', 'kimi-coding'].includes(provider)
    ? 'anthropic-messages'
    : 'openai-completions';
}

function inferOpenClawProviderFromEnvKey(envKey = '', apiMode = '') {
  const upper = String(envKey || '').toUpperCase();
  if (upper.includes('ANTHROPIC')) return 'anthropic';
  if (upper.includes('OPENROUTER')) return 'openrouter';
  if (upper.includes('MOONSHOT')) return 'moonshot';
  if (upper.includes('DEEPSEEK')) return 'deepseek';
  if (upper.includes('SILICONFLOW')) return 'siliconflow';
  if (upper.includes('DASHSCOPE') || upper.includes('BAILIAN')) return 'bailian';
  if (upper.includes('ARK')) return 'volcengine';
  if (upper.includes('ZHIPU') || upper.includes('BIGMODEL')) return 'zhipu';
  if (upper.includes('GEMINI') || upper.includes('GOOGLE')) return 'google';
  if (upper.includes('KIMI')) return 'kimi-coding';
  if (upper.includes('TOGETHER')) return 'together';
  return apiMode === 'anthropic-messages' ? 'anthropic' : 'openai';
}

function resolveOpenClawProviderEnvKey(providerConfig = null, modelRef = '', apiMode = '') {
  const explicitEnvKey = extractOpenClawEnvRef(providerConfig?.apiKey || '');
  if (explicitEnvKey) return explicitEnvKey;
  return inferOpenClawBuiltInEnvKey(modelRef, apiMode);
}

function syncOpenClawQuickHints(apiMode = 'openai-completions', { maskedApiKey = '', hasStoredKey = false } = {}) {
  const meta = getOpenClawProtocolMeta(apiMode);
  const baseUrlInput = el('baseUrlInput');
  const apiKeyInput = el('apiKeyInput');
  const detectionMeta = el('detectionMeta');

  if (baseUrlInput && state.activeTool === 'openclaw') {
    baseUrlInput.placeholder = `留空自动使用 ${meta.defaultBaseUrl}`;
  }
  if (apiKeyInput && state.activeTool === 'openclaw') {
    apiKeyInput.placeholder = hasStoredKey && maskedApiKey
      ? `${maskedApiKey}（已保存到 ${meta.defaultEnvKey}，留空保持不变）`
      : `默认写入 ${meta.defaultEnvKey}`;
  }
  if (detectionMeta && state.activeTool === 'openclaw') {
    detectionMeta.textContent = `当前协议：${meta.label} · 默认 URL：${meta.defaultBaseUrl} · 默认 Token 变量：${meta.defaultEnvKey} · 默认模型：${meta.defaultModel}。常规场景只填 URL + Token 即可，其他细节去“配置编辑”。`;
  }
}

function buildOpenClawCustomProviderAlias(modelRef = '', apiMode = '') {
  const provider = String(modelRef || '').split('/')[0].replace(/^custom-/, '') || inferOpenClawProviderFromEnvKey('', apiMode) || 'provider';
  return `custom-${provider}`;
}

function normalizeOpenClawBaseUrl(baseUrl, modelRef = '', apiMode = '') {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  url.pathname = url.pathname.replace(/\/+$/, '');
  const resolvedApi = apiMode || inferOpenClawApiMode(modelRef);
  if (resolvedApi !== 'anthropic-messages' && (!url.pathname || url.pathname === '/')) {
    url.pathname = '/v1';
  }
  return url.toString().replace(/\/+$/, '');
}

function extractOpenClawEnvRef(value = '') {
  const text = String(value || '').trim();
  const match = text.match(/^\$?\{?([A-Z0-9_]+)\}?$/i);
  return match ? match[1] : '';
}

function extractOpenClawCustomModelId(modelRef = '') {
  const parts = String(modelRef || '').split('/').filter(Boolean);
  if (parts.length <= 1) return String(modelRef || '').trim();
  return parts.slice(1).join('/');
}

function renderOpenClawModelOptions(currentModel = '', apiMode = 'openai-completions') {
  const values = new Set();
  let html = '<option value="">选择默认模型</option>';
  for (const group of OPENCLAW_MODEL_PRESETS) {
    const options = group.options.filter((option) => openClawProtocolSupportsModel(apiMode, option.value));
    if (!options.length) continue;
    html += `<optgroup label="${escapeHtml(group.label)}">`;
    for (const option of options) {
      values.add(option.value);
      html += `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`;
    }
    html += '</optgroup>';
  }
  if (currentModel && !values.has(currentModel)) {
    html += `<optgroup label="当前自定义模型"><option value="${escapeHtml(currentModel)}">${escapeHtml(currentModel)}</option></optgroup>`;
  }
  return html;
}

function buildOpenClawModelDefinition({ modelRef = '', apiMode = 'openai-completions', modelName = '', contextWindow, maxTokens } = {}) {
  const id = extractOpenClawCustomModelId(modelRef) || modelRef || extractOpenClawCustomModelId(getOpenClawDefaultModel(apiMode));
  const name = modelName || inferOpenClawModelName(modelRef || id);
  const context = Math.max(1, Number(contextWindow) || OPENCLAW_DEFAULT_CONTEXT_WINDOW);
  const max = Math.min(Math.max(1, Number(maxTokens) || OPENCLAW_DEFAULT_MAX_TOKENS), context);
  return {
    id,
    name,
    api: apiMode,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: context,
    maxTokens: max,
  };
}

function resolveOpenClawProviderApiKeyValue(providerConfig = null, env = {}, envKey = '') {
  if (envKey && env[envKey]) return env[envKey];
  const raw = String(providerConfig?.apiKey || '').trim();
  return extractOpenClawEnvRef(raw) ? '' : raw;
}

function deriveOpenClawQuickConfig(data = {}) {
  const config = data.config || {};
  const env = config.env || {};
  const storedModel = config?.agents?.defaults?.model?.primary || '';
  const providerAlias = String(storedModel || '').split('/')[0] || '';
  const providerConfig = config?.models?.providers?.[providerAlias] || null;
  const modelId = extractOpenClawCustomModelId(storedModel);
  const modelConfig = providerConfig?.models?.find((item) => item?.id === modelId) || providerConfig?.models?.[0] || null;
  const api = providerConfig?.api || modelConfig?.api || inferOpenClawApiMode(storedModel);
  const baseUrl = providerConfig?.baseUrl || '';
  const envKey = resolveOpenClawProviderEnvKey(providerConfig, storedModel, api);
  const apiKey = resolveOpenClawProviderApiKeyValue(providerConfig, env, envKey);
  let model = storedModel || getOpenClawDefaultModel(api);

  if (providerConfig?.baseUrl && storedModel) {
    const providerFamily = inferOpenClawProviderFromEnvKey(envKey, api);
    const customModelId = extractOpenClawCustomModelId(storedModel);
    if (providerFamily && customModelId) {
      model = `${providerFamily}/${customModelId}`;
    }
  }

  return {
    api,
    model,
    storedModel,
    providerAlias,
    baseUrl,
    envKey,
    apiKey,
    hasApiKey: Boolean(apiKey),
    maskedApiKey: maskSecret(apiKey),
    modelName: modelConfig?.name || inferOpenClawModelName(model || storedModel),
    contextWindow: Number(modelConfig?.contextWindow) || OPENCLAW_DEFAULT_CONTEXT_WINDOW,
    maxTokens: Number(modelConfig?.maxTokens) || OPENCLAW_DEFAULT_MAX_TOKENS,
  };
}

function syncOpenClawQuickProtocol(apiMode = '', preferredModel = '') {
  const protocolSelect = el('openClawProtocolSelect');
  const modelSelect = el('modelSelect');
  const resolvedApi = apiMode || protocolSelect?.value || 'openai-completions';
  const nextModel = preferredModel && openClawProtocolSupportsModel(resolvedApi, preferredModel)
    ? preferredModel
    : getOpenClawDefaultModel(resolvedApi);

  if (protocolSelect) {
    protocolSelect.innerHTML = renderOpenClawProtocolOptions(resolvedApi);
    protocolSelect.value = resolvedApi;
  }
  if (modelSelect) {
    modelSelect.innerHTML = renderOpenClawModelOptions(nextModel, resolvedApi);
    modelSelect.value = nextModel;
  }
  if (window.refreshCustomSelects) window.refreshCustomSelects();
  return { api: resolvedApi, model: nextModel };
}

function formatRelativeDuration(startedAt, completedAt) {
  const start = startedAt ? new Date(startedAt).getTime() : Date.now();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const totalSeconds = Math.max(1, Math.round((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分 ${seconds}秒` : `${seconds}秒`;
}

function renderOpenClawInstallStep(step, index, currentStatus) {
  const statusText = step.status === 'done'
    ? '已完成'
    : step.status === 'running'
      ? '进行中'
      : step.status === 'error'
        ? (currentStatus === 'cancelled' || currentStatus === 'cancelling' ? '已中断' : '失败')
        : '等待中';
  const icon = step.status === 'done'
    ? '<svg class="sti-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>'
    : step.status === 'error'
      ? '<svg class="sti-fail" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>'
      : step.status === 'running'
        ? '<span class="sti-spinner"></span>'
        : '<span class="sti-pending-dot"></span>';
  const percent = step.status === 'done' ? 100 : step.status === 'running' ? Math.max(22, Math.min(96, (index + 1) * 18)) : 0;
  return `
    <div class="sidebar-task-item install-step-card ${step.status}">
      <div class="sti-head">
        ${icon}
        <span class="sti-name">${index + 1}. ${escapeHtml(step.title)}</span>
        <span class="sti-status">${statusText}</span>
      </div>
      <div class="install-step-desc">${escapeHtml(step.description)}</div>
      <div class="sti-progress"><div class="sti-progress-fill ${step.status === 'running' ? 'indeterminate' : ''}" style="width:${percent}%"></div></div>
    </div>
  `;
}

function getOpenClawInstallLogsText(task) {
  return (task.logs || []).map((item) => `[${item.source === 'stderr' ? 'ERR' : 'LOG'}] ${item.text}`).join('\n')
    || '安装日志会显示在这里；如果暂时没变化，通常只是网络下载中。';
}

function buildOpenClawInstallRenderKey(task) {
  return JSON.stringify({
    status: task.status || '',
    progress: task.progress || 0,
    stepIndex: task.stepIndex || 0,
    summary: task.summary || '',
    hint: task.hint || '',
    detail: task.detail || '',
    version: task.version || '',
    error: task.error || '',
    steps: (task.steps || []).map((step) => `${step.key}:${step.status}`).join('|'),
    logs: (task.logs || []).map((item) => `${item.source}:${item.text}`).join('\n'),
    nextActions: (task.nextActions || []).join('|'),
  });
}

function shouldPauseOpenClawInstallRender() {
  if (Date.now() < (state.openClawInstallView.pauseUntil || 0)) return true;
  const selection = window.getSelection?.();
  const node = selection?.anchorNode?.parentElement || selection?.anchorNode;
  return Boolean(selection?.toString()?.trim() && node?.closest?.('.install-tracker-log'));
}

function renderOpenClawInstallDialog(task) {
  const logs = getOpenClawInstallLogsText(task);
  const nextActions = (task.nextActions || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const statusLabel = task.status === 'success'
    ? '安装完成'
    : task.status === 'cancelled'
      ? '安装已中断'
      : task.status === 'cancelling'
        ? '正在中断'
        : task.status === 'error'
          ? '安装失败'
          : '安装进行中';
  const detailText = task.detail || (task.status === 'running' || task.status === 'cancelling' ? '正在等待新的安装输出…' : '');
  const todoItems = task.status === 'cancelling'
    ? ['正在停止安装进程。', '正在清理本次安装残留。', '请先不要关闭窗口，清理完成后会自动提示。']
    : task.status === 'cancelled'
      ? ['本次安装已经停止。', '残留清理结果在下方日志里。', '如需继续，重新点安装即可。']
      : ['先别关窗口，也别重复点安装按钮。', '如果 30~90 秒没新日志，通常只是网络下载中。', '安装结束后，这里会直接告诉你下一步。'];
  return `
    <div class="install-tracker">
      <div class="install-tracker-top">
        <div>
          <div class="install-tracker-status">${escapeHtml(statusLabel)}</div>
          <div class="install-tracker-summary">${escapeHtml(task.summary || '')}</div>
        </div>
        <div class="install-tracker-percent">${Math.max(0, Math.min(100, Number(task.progress || 0)))}%</div>
      </div>
      <div class="sti-progress install-tracker-bar"><div class="sti-progress-fill ${task.status === 'running' ? '' : ''}" style="width:${Math.max(6, task.progress || 0)}%"></div></div>
      <div class="install-tracker-hint">${escapeHtml(task.hint || '你现在不需要操作，等它自己完成即可。')}</div>
      <div class="install-tracker-detail">${escapeHtml(detailText)}</div>
      <div class="install-tracker-grid">
        <div class="install-tracker-col">${(task.steps || []).map((step, index) => renderOpenClawInstallStep(step, index, task.status)).join('')}</div>
        <div class="install-tracker-col">
          <div class="install-tracker-note-card">
            <div class="install-tracker-note-title">你现在该做什么</div>
            <ul class="install-tracker-list">${todoItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
          </div>
          <div class="install-tracker-note-card">
          <div class="install-tracker-note-title">安装信息</div>
          <ul class="install-tracker-list"><li>方式：${escapeHtml(({ domestic: '一键安装（国内优化）', script: '官方脚本安装', npm: 'npm 全局安装' }[task.method] || task.method || 'OpenClaw 安装'))}</li><li>耗时：${escapeHtml(formatRelativeDuration(task.startedAt, task.completedAt))}</li><li>命令：<code>${escapeHtml(task.command || '')}</code></li></ul>
        </div>
          ${nextActions ? `<div class="install-tracker-note-card"><div class="install-tracker-note-title">接下来怎么做</div><ul class="install-tracker-list">${nextActions}</ul></div>` : ''}
        </div>
      </div>
      <div class="install-tracker-log-head">
        <div class="install-tracker-log-title">最后日志</div>
        <button type="button" class="secondary install-tracker-copy-btn" data-copy-openclaw-log>复制日志</button>
      </div>
      <pre class="install-tracker-log">${escapeHtml(logs)}</pre>
    </div>
  `;
}

function renderTrackedOpenClawDialog(task, { force = false } = {}) {
  const renderKey = buildOpenClawInstallRenderKey(task);
  state.openClawInstallView.lastLogsText = getOpenClawInstallLogsText(task);

  if (!force && shouldPauseOpenClawInstallRender()) {
    state.openClawInstallView.pendingTask = task;
    return;
  }

  if (!force && renderKey === state.openClawInstallView.lastRenderKey) {
    return;
  }

  const body = el('updateDialogBody');
  const oldLog = body?.querySelector('.install-tracker-log');
  const oldBodyScrollTop = body?.scrollTop || 0;
  const oldLogScrollTop = oldLog?.scrollTop || 0;
  const oldLogScrollHeight = oldLog?.scrollHeight || 0;
  const wasNearBottom = !oldLog || (oldLog.scrollTop + oldLog.clientHeight >= oldLog.scrollHeight - 28);

  patchUpdateDialog({
    eyebrow: 'OpenClaw',
    title: task.status === 'success' ? '安装完成' : task.status === 'cancelled' ? '安装已中断' : task.status === 'cancelling' ? '中断中' : task.status === 'error' ? '安装失败' : '安装中',
    body: renderOpenClawInstallDialog(task),
    confirmText: task.status === 'running' ? '安装中…' : task.status === 'cancelling' ? '清理中…' : '关闭',
    confirmDisabled: task.status === 'running' || task.status === 'cancelling',
    cancelText: task.status === 'running' ? '中断安装' : task.status === 'cancelling' ? '中断中…' : '取消',
    cancelDisabled: task.status === 'cancelling',
    cancelHidden: !(task.status === 'running' || task.status === 'cancelling'),
    trackerMode: true,
  });

  if (task.status !== 'running' && task.status !== 'cancelling') {
    state.updateDialogCancelHandler = null;
  }

  const newBody = el('updateDialogBody');
  const newLog = newBody?.querySelector('.install-tracker-log');
  if (newBody) newBody.scrollTop = oldBodyScrollTop;
  if (newLog) {
    if (wasNearBottom) {
      newLog.scrollTop = newLog.scrollHeight;
    } else {
      newLog.scrollTop = Math.max(0, oldLogScrollTop + (newLog.scrollHeight - oldLogScrollHeight));
    }
  }

  state.openClawInstallView.lastRenderKey = renderKey;
  state.openClawInstallView.pendingTask = null;
}

function syncApiKeyToggle() {
  const button = el('apiKeyToggleBtn');
  const input = el('apiKeyInput');
  if (!button || !input) return;
  const revealed = input.type === 'text';
  state.apiKeyField.revealed = revealed;
  syncEyeIcon(button, revealed);
}

function syncEyeIcon(button, revealed) {
  const open = button.querySelector('.eye-open');
  const closed = button.querySelector('.eye-closed');
  if (open) open.style.display = revealed ? 'none' : '';
  if (closed) closed.style.display = revealed ? '' : 'none';
  button.title = revealed ? '隐藏 API Key' : '显示 API Key';
  button.setAttribute('aria-label', revealed ? '隐藏 API Key' : '显示 API Key');
  button.classList.toggle('active', revealed);
}

function setApiKeyFieldState(provider) {
  const input = el('apiKeyInput');
  if (!input) return;
  const providerKey = provider?.key || '';
  const cachedValue = providerKey ? (state.providerSecrets[providerKey] || '') : '';
  state.apiKeyField = {
    providerKey,
    baseUrl: normalizeBaseUrl(provider?.baseUrl || ''),
    maskedValue: provider?.maskedApiKey || '',
    actualValue: cachedValue,
    hasStored: Boolean(provider?.hasApiKey),
    inferred: Boolean(provider?.inferred),
    revealed: false,
    dirty: false,
  };
  input.type = 'password';
  input.value = '';
  input.placeholder = state.apiKeyField.maskedValue || 'sk-...';
  syncApiKeyToggle();
}

function currentApiKeyContext() {
  const baseUrl = normalizeBaseUrl(el('baseUrlInput').value);
  const providerKey = inferProviderKey(baseUrl);
  return { baseUrl, providerKey };
}

function canUseStoredApiKey({ baseUrl, providerKey } = currentApiKeyContext()) {
  return Boolean(
    state.apiKeyField.hasStored
    && !state.apiKeyField.inferred
    && providerKey
    && baseUrl
    && state.apiKeyField.providerKey === providerKey
    && state.apiKeyField.baseUrl === baseUrl
  );
}

function getApiKeyForSubmit({ baseUrl, providerKey } = currentApiKeyContext()) {
  const raw = el('apiKeyInput').value.trim();
  if (canUseStoredApiKey({ baseUrl, providerKey }) && !state.apiKeyField.dirty) {
    return '';
  }
  return raw;
}

async function toggleApiKeyVisibility() {
  const input = el('apiKeyInput');
  if (!input) return;

  // Claude Code mode: simple toggle only, never inject Codex keys
  if (state.activeTool === 'claudecode') {
    input.type = input.type === 'password' ? 'text' : 'password';
    syncApiKeyToggle();
    return;
  }

  if (!state.apiKeyField.hasStored) {
    input.type = input.type === 'password' ? 'text' : 'password';
    syncApiKeyToggle();
    return;
  }

  if (input.type === 'text') {
    input.type = 'password';
    if (!state.apiKeyField.dirty) input.value = '';
    syncApiKeyToggle();
    return;
  }

  if (!state.apiKeyField.actualValue) {
    const json = await api('/api/provider/secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: el('scopeSelect').value || 'global',
        projectPath: el('projectPathInput').value.trim(),
        codexHome: el('codexHomeInput').value.trim(),
        providerKey: state.apiKeyField.providerKey,
      }),
    });
    if (!json.ok) {
      flash(json.error || '读取 API Key 失败', 'error');
      return;
    }
    state.apiKeyField.actualValue = json.data?.apiKey || '';
    state.apiKeyField.maskedValue = json.data?.maskedApiKey || state.apiKeyField.maskedValue;
    if (state.apiKeyField.providerKey && state.apiKeyField.actualValue) {
      state.providerSecrets[state.apiKeyField.providerKey] = state.apiKeyField.actualValue;
    }
  }

  input.value = state.apiKeyField.actualValue;
  input.type = 'text';
  syncApiKeyToggle();
}

function toggleSimpleSecretInput(inputId, buttonId) {
  const input = el(inputId);
  const button = el(buttonId);
  if (!input || !button) return;
  const revealed = input.type === 'password';
  input.type = revealed ? 'text' : 'password';
  syncEyeIcon(button, revealed);
}

function setBusy(id, busy, text) {
  const button = el(id);
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = text;
    button.disabled = true;
    return;
  }
  button.textContent = button.dataset.label || button.textContent;
  button.disabled = false;
}

const TOAST_ICONS = {
  success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
};

function flash(message, type = 'info') {
  const container = el('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
    <span>${escapeHtml(message)}</span>
  `;

  // Click to dismiss
  toast.addEventListener('click', () => dismissToast(toast));

  container.appendChild(toast);

  // Limit max visible toasts
  while (container.children.length > 5) {
    dismissToast(container.firstElementChild);
  }

  // Auto-dismiss
  const timer = setTimeout(() => dismissToast(toast), 4000);
  toast._timer = timer;
}

function dismissToast(toast) {
  if (!toast || toast._dismissed) return;
  toast._dismissed = true;
  clearTimeout(toast._timer);
  toast.classList.add('toast-exit');
  toast.addEventListener('animationend', () => toast.remove(), { once: true });
  // Fallback removal in case animationend doesn't fire
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 400);
}

function closeUpdateDialog(result = false) {
  const panel = el('updateDialog');
  if (!panel) return;
  if (state.updateDialogLocked) return;
  const shouldResyncTools = Boolean(state.openCodeInstallView.activeTaskId || state.openClawInstallView.activeTaskId);
  clearTimeout(state.updateDialogTimer);
  state.updateDialogOpen = false;
  state.updateDialogLocked = false;
  state.updateDialogCancelHandler = null;
  state.openClawInstallView.lastRenderKey = '';
  state.openClawInstallView.lastLogsText = '';
  state.openClawInstallView.pauseUntil = 0;
  state.openClawInstallView.pendingTask = null;
  state.openClawInstallView.activeTaskId = '';
  state.openClawInstallView.cancelBusy = false;
  state.openCodeInstallView.lastRenderKey = '';
  state.openCodeInstallView.lastLogsText = '';
  state.openCodeInstallView.pauseUntil = 0;
  state.openCodeInstallView.pendingTask = null;
  state.openCodeInstallView.activeTaskId = '';
  state.openCodeInstallView.cancelBusy = false;
  clearInterval(state.openCodeInstallView.timerId || 0);
  state.openCodeInstallView.timerId = 0;
  state.openClawSetupContext = null;
  panel.classList.remove('dialog-locked', 'install-tracker-mode');
  // Clean up install dialog wide class and restore actions bar
  const panelInner = panel.querySelector('.update-dialog-panel');
  if (panelInner) panelInner.classList.remove('install-dialog-wide');
  const actionsBar = el('updateDialogConfirmBtn')?.parentElement;
  if (actionsBar) actionsBar.style.display = '';
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('update-dialog-open');
  state.updateDialogTimer = setTimeout(() => panel.classList.add('hide'), 180);
  if (state.updateDialogResolver) {
    const resolver = state.updateDialogResolver;
    state.updateDialogResolver = null;
    resolver(result);
  }
  if (shouldResyncTools) void resyncToolRuntimeState({ force: true });
}

function openUpdateDialog({ eyebrow = 'Update', title, body = '', meta = '', confirmText = '继续', cancelText = '取消', tone = 'default', confirmOnly = false, trackerMode = false, hideActions = false }) {
  const panel = el('updateDialog');
  if (!panel) return Promise.resolve(false);
  clearTimeout(state.updateDialogTimer);
  state.updateDialogOpen = true;
  state.updateDialogLocked = false;
  state.updateDialogCancelHandler = null;
  panel.classList.remove('dialog-locked');
  panel.classList.toggle('install-tracker-mode', trackerMode);
  el('updateDialogEyebrow').textContent = eyebrow;
  el('updateDialogTitle').textContent = title;
  el('updateDialogBody').innerHTML = body;
  el('updateDialogMeta').innerHTML = meta || '';
  el('updateDialogMeta').classList.toggle('hide', !meta);
  el('updateDialogConfirmBtn').textContent = confirmText;
  el('updateDialogConfirmBtn').dataset.tone = tone;
  el('updateDialogConfirmBtn').disabled = false;
  el('updateDialogCancelBtn').textContent = cancelText;
  el('updateDialogCancelBtn').disabled = false;
  el('updateDialogCancelBtn').hidden = Boolean(confirmOnly);
  // Hide the entire actions bar when requested (e.g. install dialog where × suffices)
  const actionsBar = el('updateDialogConfirmBtn')?.parentElement;
  if (actionsBar) actionsBar.style.display = hideActions ? 'none' : '';
  panel.classList.remove('hide');
  panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('update-dialog-open');
  requestAnimationFrame(() => panel.classList.add('open'));
  return new Promise((resolve) => {
    state.updateDialogResolver = resolve;
  });
}

function patchUpdateDialog({ eyebrow, title, body, meta, confirmText, cancelText, tone, confirmDisabled, cancelDisabled, cancelHidden, trackerMode } = {}) {
  const panel = el('updateDialog');
  if (!panel) return;
  if (typeof eyebrow === 'string') el('updateDialogEyebrow').textContent = eyebrow;
  if (typeof title === 'string') el('updateDialogTitle').textContent = title;
  if (typeof body === 'string') el('updateDialogBody').innerHTML = body;
  if (typeof meta === 'string') {
    el('updateDialogMeta').innerHTML = meta;
    el('updateDialogMeta').classList.toggle('hide', !meta);
  }
  if (typeof confirmText === 'string') el('updateDialogConfirmBtn').textContent = confirmText;
  if (typeof cancelText === 'string') el('updateDialogCancelBtn').textContent = cancelText;
  if (typeof tone === 'string') el('updateDialogConfirmBtn').dataset.tone = tone;
  if (typeof confirmDisabled === 'boolean') el('updateDialogConfirmBtn').disabled = confirmDisabled;
  if (typeof cancelDisabled === 'boolean') el('updateDialogCancelBtn').disabled = cancelDisabled;
  if (typeof cancelHidden === 'boolean') el('updateDialogCancelBtn').hidden = cancelHidden;
  if (typeof trackerMode === 'boolean') panel.classList.toggle('install-tracker-mode', trackerMode);
}

function setUpdateDialogLocked(locked, title = '') {
  state.updateDialogLocked = Boolean(locked);
  const panel = el('updateDialog');
  const closeBtn = el('closeUpdateDialogBtn');
  if (panel) panel.classList.toggle('dialog-locked', state.updateDialogLocked);
  if (closeBtn) {
    closeBtn.disabled = state.updateDialogLocked;
    closeBtn.title = state.updateDialogLocked ? (title || '安装过程中请先等待，不要关闭窗口') : '关闭';
  }
}

function updateLines(items = []) {
  return items.filter(Boolean).map((item) => `<div class="update-line">${escapeHtml(item)}</div>`).join('');
}

const SECONDARY_META = {
  quick:          { sub: '选择要配置的工具，或为同一工具保存多份预设。' },
  console:        { sub: '集中监控各 CLI 工具的运行状态与异常检测结果。' },
  dashboard:      { sub: '查看各工具的模型用量、会话趋势与耗时分布。' },
  configEditor:   { sub: '搜索配置项，直接编辑底层配置文件。' },
  tools:          { sub: '安装、更新、重装或卸载已接入的 AI 编程工具。' },
  tasks:          { sub: '查看当前进行中和历史的安装/更新任务。' },
  about:          { sub: '客户端版本、更新源与当前运行信息。' },
  systemSettings: { sub: '界面主题、存储占用与缓存清理。' },
};

function syncSecondaryPanel(page, meta) {
  const eyebrow = el('secondaryEyebrow');
  const title = el('secondaryTitle');
  const sub = el('secondarySub');
  if (eyebrow) eyebrow.textContent = meta.eyebrow || '';
  if (title) title.textContent = meta.title || '';
  if (sub) sub.textContent = (SECONDARY_META[page] && SECONDARY_META[page].sub) || meta.subtitle || '';
  let matched = false;
  document.querySelectorAll('.sec-group[data-sec-for]').forEach((grp) => {
    const target = grp.dataset.secFor;
    const hit = target === page;
    if (hit) matched = true;
    if (target !== '__fallback') grp.style.display = hit ? '' : 'none';
  });
  const fallback = document.querySelector('.sec-group[data-sec-for="__fallback"]');
  if (fallback) fallback.style.display = matched ? 'none' : '';
  const fbTitle = el('secondaryFallbackTitle');
  const fbSub = el('secondaryFallbackSub');
  if (fbTitle) fbTitle.textContent = meta.title || '当前页面';
  if (fbSub) fbSub.textContent = (SECONDARY_META[page] && SECONDARY_META[page].sub) || meta.subtitle || '';
}

function setPage(page = 'quick') {
  const meta = PAGE_META[page] || PAGE_META.quick;
  state.activePage = page;
  if (state.activeTool) state.toolLastPage[state.activeTool] = page;
  document.body.dataset.page = page;
  document.querySelectorAll('[data-page-target]').forEach((node) => {
    node.classList.toggle('active', node.dataset.pageTarget === page);
  });
  document.querySelectorAll('[data-page]').forEach((node) => {
    node.classList.toggle('active', node.dataset.page === page);
  });
  if (page !== 'configEditor') closeCfg3Drawer();
  if (el('pageEyebrow')) el('pageEyebrow').textContent = meta.eyebrow;
  if (el('pageTitle')) el('pageTitle').textContent = meta.title;
  if (el('pageSubtitle')) el('pageSubtitle').textContent = meta.subtitle;
  syncSecondaryPanel(page, meta);

  // Toggle action buttons
  const defaultActions = el('defaultActions');
  const configActions = el('configEditorActions');
  if (defaultActions) defaultActions.classList.toggle('hide', page === 'configEditor');
  if (configActions) configActions.classList.toggle('hide', page !== 'configEditor');
  el('secondaryThemeToggleBtn')?.classList.toggle('hide', page !== 'dashboard');
  el('themeToggleBtn')?.classList.toggle('hide', page === 'dashboard');

  // Render tasks page on navigate
  if (page !== 'dashboard') stopDashboardAutoRefresh();
  if (page === 'tasks') renderTasksPage();
  if (page === 'console') {
    renderToolConsole();
    if (!state.consoleRefreshing) void refreshToolConsoleData();
  }
  if (page === 'dashboard') {
    const dashboardTool = state.dashboardTool || 'codex';
    const hasCachedMetrics = Boolean(getDashboardMetricsForTool(dashboardTool));
    const isClaudeDashboard = dashboardTool === 'claudecode';
    const isApiDashboard = isApiDashboardTool(dashboardTool);
    if (!hasCachedMetrics && isApiDashboard) state.dashboardLoading = true;
    renderDashboardPage();
    startDashboardAutoRefresh();
    const sideP = loadDashboardSideStates();
    sideP.then(() => {
      if (state.activePage === 'dashboard') renderDashboardPage();
    });
    if (isApiDashboard) {
      void refreshDashboardData({ silent: hasCachedMetrics, tool: dashboardTool });
    }
  }
  if (page === 'configEditor') {
    applyConfigEditorSearch();
    renderConfigEditorShell(getConfigEditorTool());
  }
  if (page === 'systemSettings') {
    renderSystemSettingsPage();
    if (!state.systemStorageLoading) {
      void loadSystemStorageState({ silent: true });
    }
  }
  if (page === 'tools') {
    renderToolsPage();
    void loadOpenCodeDesktopState({ render: true });
    void loadOpenCodeEcosystemState({ render: true });
  }
}

function syncAboutUpdateActions() {
  const info = state.appUpdate || {};
  const installBtn = el('aboutInstallUpdateBtn');
  const checkBtn = el('aboutCheckUpdateBtn');
  if (!installBtn || !checkBtn) return;
  const progress = state.appUpdateProgress || {};
  const updating = ['checking', 'downloading', 'installing'].includes(String(progress.status || ''));
  installBtn.hidden = !Boolean(info.available);
  installBtn.disabled = updating;
  checkBtn.disabled = updating;
  checkBtn.classList.toggle('about-update-btn-secondary', Boolean(info.available));
}

function renderAboutUpdateProgress() {
  const wrap = el('aboutUpdateProgressWrap');
  const bar = el('aboutUpdateProgressBar');
  const meta = el('aboutUpdateProgressMeta');
  if (!wrap || !bar || !meta) return;
  const progress = state.appUpdateProgress || {};
  const status = String(progress.status || '');
  const active = ['checking', 'downloading', 'installing'].includes(status);
  if (!active) {
    wrap.classList.add('hide');
    bar.style.width = '0%';
    meta.textContent = '';
    return;
  }
  const pct = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  const downloaded = Number(progress.downloadedBytes || 0);
  const total = Number(progress.totalBytes || 0);
  wrap.classList.remove('hide');
  bar.style.width = `${pct.toFixed(1)}%`;
  if (status === 'downloading') {
    meta.textContent = total > 0
      ? `${pct.toFixed(1)}% · ${formatBytes(downloaded)} / ${formatBytes(total)}`
      : `${formatBytes(downloaded)} · 正在下载`;
    return;
  }
  if (status === 'checking') {
    meta.textContent = '正在检查可用更新包…';
    return;
  }
  meta.textContent = '下载完成，正在安装…';
}

function populateAboutPanel() {
  const info = state.appUpdate || {};
  const appVersion = info.currentVersion || '1.0.0';
  const progress = state.appUpdateProgress || {};
  const progressStatus = String(progress.status || '');
  const status = el('aboutUpdaterStatus');
  el('aboutAppVersion').textContent = appVersion;
  el('aboutCodexVersion').textContent = appVersion;
  if (progressStatus === 'checking') {
    status.textContent = '正在准备更新…';
    status.className = 'about-status';
  } else if (progressStatus === 'downloading') {
    const pct = Number(progress.percent || 0);
    status.textContent = `正在下载更新 ${pct.toFixed(1)}%`;
    status.className = 'about-status about-status-update';
  } else if (progressStatus === 'installing') {
    status.textContent = '正在安装更新…';
    status.className = 'about-status about-status-update';
  } else if (progressStatus === 'error') {
    const errMsg = progress.error || '更新失败';
    const isSigOrNet = /签名|signature|verify|网络|network|dns|timeout|connect/i.test(errMsg);
    if (isSigOrNet) {
      const repo = info.repository || 'lmk1010/EasyAIConfig';
      status.innerHTML = `${escapeHtml(errMsg)} <a href="https://github.com/${escapeHtml(repo)}/releases/latest" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline;margin-left:6px;white-space:nowrap">手动下载</a>`;
    } else {
      status.textContent = errMsg;
    }
    status.className = 'about-status about-status-error';
  } else if (info.available) {
    status.textContent = `可更新到 v${info.version || '-'}`;
    status.className = 'about-status about-status-update';
  } else if (info.networkBlocked) {
    status.textContent = info.statusMessage || '你的网络可能无法访问 GitHub 更新源，暂时无法检查更新。';
    status.className = 'about-status about-status-error';
  } else if (info.enabled) {
    status.textContent = '已是最新';
    status.className = 'about-status about-status-ok';
  } else {
    status.textContent = '';
    status.className = 'about-status';
  }
  renderAboutUpdateProgress();
  syncAboutUpdateActions();
  el('aboutRepo').textContent = info.repository || '-';
  el('aboutEndpoint').textContent = info.endpoint || '-';
  el('aboutPubkeyStatus').textContent = info.publicKeyConfigured ? '已配置' : '未配置';
}

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  const fixed = size >= 100 || idx === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(fixed)} ${units[idx]}`;
}

function getUiLocalStorageUsageBytes() {
  try {
    let total = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) || '';
      const value = localStorage.getItem(key) || '';
      total += (key.length + value.length) * 2;
    }
    return total;
  } catch {
    return 0;
  }
}

function syncSystemThemeButtons() {
  const group = el('sysThemeModes');
  if (!group) return;
  group.querySelectorAll('[data-sys-theme]').forEach((button) => {
    button.classList.toggle('active', button.dataset.sysTheme === state.themePreference);
  });
}

function renderSystemStorageState() {
  const localUsage = el('sysLocalStorageUsage');
  const localUsageBytes = getUiLocalStorageUsageBytes();
  if (localUsage) {
    localUsage.textContent = formatBytes(localUsageBytes);
  }

  const localList = el('sysStorageLocalList');
  const toolsList = el('sysStorageToolsList');
  const localTotal = el('sysStorageLocalTotal');
  const localFiles = el('sysStorageLocalFiles');
  const toolsTotal = el('sysStorageToolsTotal');
  const toolsFiles = el('sysStorageToolsFiles');
  const payload = state.systemStorage || {};
  const entries = Array.isArray(payload.entries) ? payload.entries : [];

  const isToolEntry = (item = {}) => ['codex_home', 'claude_home', 'openclaw_home'].includes(String(item.key || ''));
  const localEntries = entries.filter((item) => !isToolEntry(item));
  const toolEntries = entries.filter((item) => isToolEntry(item));
  const localBytes = localEntries.reduce((sum, item) => sum + Number(item.bytes || 0), 0) + localUsageBytes;
  const localFileCount = localEntries.reduce((sum, item) => sum + Number(item.fileCount || 0), 0);
  const toolBytes = toolEntries.reduce((sum, item) => sum + Number(item.bytes || 0), 0);
  const toolFileCount = toolEntries.reduce((sum, item) => sum + Number(item.fileCount || 0), 0);

  if (localTotal) localTotal.textContent = formatBytes(localBytes);
  if (localFiles) localFiles.textContent = Number(localFileCount).toLocaleString('en-US');
  if (toolsTotal) toolsTotal.textContent = formatBytes(toolBytes);
  if (toolsFiles) toolsFiles.textContent = Number(toolFileCount).toLocaleString('en-US');

  if (!localList || !toolsList) return;
  if (!entries.length) {
    const text = state.systemStorageLoading ? '读取中...' : '暂未读取存储信息';
    localList.innerHTML = `
      <div class="sys-storage-row">
        <span class="sys-storage-main"><span class="sys-storage-name">${text}</span></span>
        <strong class="sys-storage-size">-</strong>
      </div>`;
    toolsList.innerHTML = `
      <div class="sys-storage-row">
        <span class="sys-storage-main"><span class="sys-storage-name">${text}</span></span>
        <strong class="sys-storage-size">-</strong>
      </div>`;
    return;
  }

  const uiRow = {
    label: '界面缓存 (localStorage)',
    path: 'browser://localStorage',
    bytes: localUsageBytes,
  };
  const renderStorageRow = (item = {}) => `
    <div class="sys-storage-row">
      <span class="sys-storage-main">
        <span class="sys-storage-name">${escapeHtml(item.label || item.key || '-')}</span>
        <code class="sys-storage-path">${escapeHtml(item.path || '-')}</code>
      </span>
      <strong class="sys-storage-size">${escapeHtml(formatBytes(item.bytes || 0))}</strong>
    </div>
  `;

  localList.innerHTML = [uiRow, ...localEntries].map(renderStorageRow).join('');
  toolsList.innerHTML = toolEntries.map(renderStorageRow).join('') || `
    <div class="sys-storage-row">
      <span class="sys-storage-main"><span class="sys-storage-name">暂无第三方工具数据</span></span>
      <strong class="sys-storage-size">-</strong>
    </div>`;
}

function renderSystemSettingsPage() {
  syncSystemThemeButtons();
  renderSystemStorageState();
}

async function openExternalUrl(url) {
  const target = String(url || '').trim();
  if (!target) return false;
  const result = await api('/api/open-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: target }),
  });
  if (!result?.ok) {
    window.open(target, '_blank');
  }
  return true;
}

async function loadSystemStorageState({ silent = false } = {}) {
  state.systemStorageLoading = true;
  renderSystemStorageState();
  const json = await api('/api/system/storage');
  state.systemStorageLoading = false;
  if (!json.ok) {
    if (!silent) flash(json.error || '读取存储占用失败', 'error');
    renderSystemStorageState();
    return { ok: false, error: json.error || '读取失败' };
  }
  state.systemStorage = json.data || {};
  renderSystemStorageState();
  return { ok: true, data: state.systemStorage };
}

async function cleanupSystemStorage({ clearCache = true, clearBackups = false } = {}) {
  const json = await api('/api/system/cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearCache, clearBackups }),
  });
  if (!json.ok) return { ok: false, error: json.error || '清理失败' };
  if (json.data?.state) state.systemStorage = json.data.state;
  renderSystemStorageState();
  return { ok: true, data: json.data || {} };
}

async function uninstallToolForSystemSettings(toolId) {
  const endpointMap = {
    codex: '/api/codex/uninstall',
    claudecode: '/api/claudecode/uninstall',
    opencode: '/api/opencode/uninstall',
    openclaw: '/api/openclaw/uninstall',
  };
  const labelMap = {
    codex: 'Codex',
    claudecode: 'Claude Code',
    opencode: 'OpenCode',
    openclaw: 'OpenClaw',
  };
  const endpoint = endpointMap[toolId];
  if (!endpoint) return { ok: false, error: '未知工具' };
  const json = await api(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: toolId === 'openclaw' ? JSON.stringify({ purge: false }) : undefined,
    timeoutMs: 120000,
  });
  if (!json.ok || json.data?.ok === false) {
    return { ok: false, error: json.error || json.data?.stderr || `${labelMap[toolId]} 卸载失败` };
  }
  return { ok: true, label: labelMap[toolId] || toolId };
}

function openSystemUninstallEntry() {
  const platform = String(navigator.platform || '').toLowerCase();
  if (platform.includes('mac')) return openExternalUrl('file:///Applications');
  if (platform.includes('win')) return openExternalUrl('ms-settings:appsfeatures');
  return openExternalUrl('https://github.com/lmk1010/EasyAIConfig');
}

function clearUiStorageCache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i) || '';
    if (key.startsWith('easyaiconfig_') && key !== 'easyaiconfig_theme') {
      keys.push(key);
    }
  }
  keys.forEach((key) => localStorage.removeItem(key));
  renderSystemStorageState();
  flash(`已清理 ${keys.length} 项界面缓存`, 'success');
}

function setAboutOpen(open) {
  const panel = el('aboutView');
  if (!panel) return;
  clearTimeout(state.aboutTimer);
  state.aboutOpen = open;

  if (open) {
    populateAboutPanel();
    panel.classList.remove('hide');
    panel.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => panel.classList.add('open'));
    document.body.classList.add('about-open');
    return;
  }

  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('about-open');
  state.aboutTimer = setTimeout(() => panel.classList.add('hide'), 180);
}

function setAdvancedOpen(open) {
  const panel = el('advancedView');
  if (!panel) return;

  clearTimeout(state.advancedTimer);
  state.advancedOpen = open;

  if (open) {
    panel.classList.remove('hide');
    panel.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => panel.classList.add('open'));
    document.body.classList.add('advanced-open');
    return;
  }

  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('advanced-open');
  state.advancedTimer = setTimeout(() => panel.classList.add('hide'), 180);
}

function normalizeConfigEditorTool(toolId = '') {
  if (toolId === 'openclaw' || toolId === 'opencode' || toolId === 'claudecode' || toolId === 'codex') return toolId;
  return 'codex';
}

function getConfigEditorShellMeta(toolId = '') {
  const tool = normalizeConfigEditorTool(toolId);
  const table = {
    codex: {
      label: 'Codex',
      title: 'Codex 配置编辑',
      subtitle: '优先用表单调整模型、审批和上下文，复杂项再展开原始 config.toml 与 auth.json。',
      files: 'config.toml / auth.json',
      drawerTitle: '原始文件 · config.toml / auth.json',
    },
    claudecode: {
      label: 'Claude Code',
      title: 'Claude Code 配置编辑',
      subtitle: '整理模型、登录方式与 Provider，必要时直接修改 settings.json。',
      files: 'settings.json',
      drawerTitle: '原始文件 · settings.json',
    },
    opencode: {
      label: 'OpenCode',
      title: 'OpenCode 配置编辑',
      subtitle: '集中维护默认模型、Provider 与实验配置，原始 opencode.json 仍可随时打开。',
      files: 'opencode.json',
      drawerTitle: '原始文件 · opencode.json',
    },
    openclaw: {
      label: 'OpenClaw',
      title: 'OpenClaw 配置编辑',
      subtitle: '把常用运行项和高级 JSON 分层整理，先调主路径，再补充完整运行配置。',
      files: 'openclaw.json',
      drawerTitle: '原始文件 · openclaw.json',
    },
  };
  return table[tool] || table.codex;
}

function syncConfigEditorShellView(view = '') {
  const modeEl = el('configEditorShellMode');
  if (modeEl) modeEl.textContent = view === 'code' ? '原始文件全屏' : '表单编辑';
  const drawerBtn = el('cfg3OpenDrawerBtn');
  if (drawerBtn) drawerBtn.classList.toggle('hide', view === 'code');
}

function renderConfigEditorShell(toolId = '') {
  const meta = getConfigEditorShellMeta(toolId || getConfigEditorTool());
  const toolEl = el('configEditorShellTool');
  const titleEl = el('configEditorShellTitle');
  const subtitleEl = el('configEditorShellSubtitle');
  const fileEl = el('configEditorShellFile');
  const drawerTitleEl = el('cfg3DrawerTitle');
  const drawerBtn = el('cfg3OpenDrawerBtn');
  if (toolEl) toolEl.textContent = meta.label;
  if (titleEl) titleEl.textContent = meta.title;
  if (subtitleEl) subtitleEl.textContent = meta.subtitle;
  if (fileEl) fileEl.textContent = meta.files;
  if (drawerTitleEl) drawerTitleEl.textContent = meta.drawerTitle;
  if (drawerBtn) drawerBtn.title = `查看 ${meta.files}`;
  syncConfigEditorShellView(el('configEditorLayout')?.dataset.viewMode || 'form');
}

function getConfigEditorTool() {
  return normalizeConfigEditorTool(state.configEditorTool);
}

async function setConfigEditorOpen(open) {
  state.configEditorOpen = open;
  if (open) {
    state.configEditorTool = normalizeConfigEditorTool(state.activeTool || state.configEditorTool);
    if (getConfigEditorTool() === 'openclaw' && !state.openclawState) {
      await loadOpenClawQuickState();
    }
    if (getConfigEditorTool() === 'claudecode' && !state.claudeCodeState) {
      await loadClaudeCodeQuickState();
    }
    if (getConfigEditorTool() === 'opencode' && !state.opencodeState) {
      await loadOpenCodeQuickState();
    }
    if (getConfigEditorTool() === 'claudecode') {
      state.claudeProviderDetailKey = '';
    }
    populateConfigEditor();
    setPage('configEditor');
    if (window.refreshCustomSelects) window.refreshCustomSelects();
    refreshRawCodeEditors();
  } else {
    setPage('quick');
  }
}

function configValue(path, fallback = '') {
  return path.split('.').reduce((obj, key) => (obj && obj[key] !== undefined ? obj[key] : undefined), state.current?.config) ?? fallback;
}

function compactPromptEnabled(value = configValue('compact_prompt', null)) {
  if (value === null || value === undefined || value === '') return true;
  if (typeof value === 'string') return value.trim().toLowerCase() !== 'false';
  return Boolean(value);
}

function buildCompactPromptSetting() {
  if (!el('cfgCompactPromptCheck').checked) return 'false';

  const currentValue = configValue('compact_prompt', null);
  if (typeof currentValue === 'string' && currentValue.trim() && currentValue.trim().toLowerCase() !== 'false') {
    return currentValue;
  }

  return null;
}

const CODEX_CONTEXT_EFFECTIVE_RATIO = 0.95;
const CODEX_AUTO_COMPACT_LIMIT_RATIO = 0.9;

function getCodexContextWindowForUi() {
  return getConfigNumberValue('cfgContextWindowInput') || getCodexSelectedModelContextCap() || 272000;
}

function calcCodexEffectiveContextWindow(contextWindow) {
  return Math.round(Number(contextWindow || 0) * CODEX_CONTEXT_EFFECTIVE_RATIO);
}

function calcCodexAutoCompactCap(contextWindow) {
  return Math.round(Number(contextWindow || 0) * CODEX_AUTO_COMPACT_LIMIT_RATIO);
}

const CONFIG_NUMBER_FIELDS = {
  cfgContextWindowInput: {
    rangeId: 'cfgContextWindowRange',
    resetId: 'cfgContextWindowResetBtn',
    hintId: 'cfgContextWindowHint',
    min: 32000,
    max: 1048576,
    step: 1000,
    defaultValue: () => getCodexSelectedModelContextCap() || 272000,
    defaultPlaceholder: () => {
      const modelCap = getCodexSelectedModelContextCap();
      const model = getCodexSelectedModelValue();
      if (modelCap) return `默认 ${modelCap.toLocaleString('en-US')}（${model || '当前模型'} 上限）`;
      return '默认 272000';
    },
    hint: (value, empty) => {
      const modelCap = getCodexSelectedModelContextCap();
      const model = getCodexSelectedModelValue();
      const effective = calcCodexEffectiveContextWindow(value);
      const valueText = Number(value || 0).toLocaleString('en-US');
      const effectiveText = Number(effective || 0).toLocaleString('en-US');
      if (modelCap) {
        const capText = Number(modelCap).toLocaleString('en-US');
        return empty
          ? `${model || '当前模型'} 最大上下文 ${capText}；Codex 实际可用约 95%（≈ ${effectiveText}）。`
          : `当前设置 ${valueText}；模型上限 ${capText}，Codex 实际可用约 ${effectiveText} (95%)`;
      }
      return empty
        ? `拖动滑杆快速调整，也可直接输入数字。Codex 实际可用约为设置值的 95%（≈ ${effectiveText}）。`
        : `当前设置 ${valueText}；Codex 实际可用约 ${effectiveText} (95%)`;
    },
  },
  cfgCompactLimitInput: {
    rangeId: 'cfgCompactLimitRange',
    resetId: 'cfgCompactLimitResetBtn',
    hintId: 'cfgCompactLimitHint',
    min: 16000,
    max: 1048576,
    step: 1000,
    defaultValue: () => calcCodexAutoCompactCap(getCodexContextWindowForUi()),
    defaultPlaceholder: () => {
      const contextWindow = getCodexContextWindowForUi();
      const compactCap = calcCodexAutoCompactCap(contextWindow);
      const effective = calcCodexEffectiveContextWindow(contextWindow);
      return `默认 上下文90% ≈ ${compactCap}（有效窗口95%≈${effective}）`;
    },
    hint: (value, empty) => {
      const contextWindow = getCodexContextWindowForUi();
      const compactCap = calcCodexAutoCompactCap(contextWindow);
      const effective = calcCodexEffectiveContextWindow(contextWindow);
      return empty
        ? `默认使用上下文 90%（上限≈ ${compactCap}），有效窗口约 ${effective} (95%)。`
        : `当前设置 ${value}；建议不高于 ${compactCap}（上下文90%）`;
    },
  },
  cfgToolLimitInput: {
    rangeId: 'cfgToolLimitRange',
    resetId: 'cfgToolLimitResetBtn',
    hintId: 'cfgToolLimitHint',
    min: 1024,
    max: 65536,
    step: 512,
    defaultValue: () => 8192,
    defaultPlaceholder: () => '默认 无限制',
    hint: (value, empty) => empty ? '留空表示不限制；拖动后会写入具体上限。' : `当前设置 ${value}`,
  },
};

function sanitizeNumericText(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function getConfigNumberValue(inputId) {
  const input = el(inputId);
  if (!input) return null;
  const clean = sanitizeNumericText(input.value);
  if (!clean) return null;
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampConfigNumber(value, spec) {
  return Math.min(spec.max, Math.max(spec.min, value));
}

function syncConfigNumberField(inputId, source = 'init') {
  const spec = CONFIG_NUMBER_FIELDS[inputId];
  if (!spec) return;

  const input = el(inputId);
  const range = el(spec.rangeId);
  const hint = el(spec.hintId);
  if (range && !range.dataset.baseMax) {
    range.dataset.baseMax = String(range.max || spec.max);
  }
  if (inputId === 'cfgContextWindowInput') {
    const modelCap = getCodexSelectedModelContextCap();
    const baseMax = Number(range.dataset.baseMax || spec.max);
    range.max = String(Math.max(spec.min, modelCap || baseMax));
  }
  if (inputId === 'cfgCompactLimitInput') {
    const contextLimit = getCodexContextWindowForUi();
    const compactCap = calcCodexAutoCompactCap(contextLimit);
    range.max = String(Math.max(spec.min, compactCap));
  }
  const runtimeSpec = {
    ...spec,
    min: Number(range.min || spec.min),
    max: Number(range.max || spec.max),
  };
  const defaultValue = clampConfigNumber(spec.defaultValue(), runtimeSpec);

  input.placeholder = spec.defaultPlaceholder();

  if (source === 'range') {
    input.value = String(range.value);
  } else if (source === 'input') {
    const clean = sanitizeNumericText(input.value);
    input.value = clean;
    if (clean) {
      range.value = String(clampConfigNumber(Number(clean), runtimeSpec));
    }
  }

  const currentValue = getConfigNumberValue(inputId);
  const isEmpty = currentValue === null;
  const nextValue = isEmpty ? defaultValue : clampConfigNumber(currentValue, runtimeSpec);
  if (!isEmpty && currentValue !== nextValue) {
    input.value = String(nextValue);
  }
  range.value = String(nextValue);
  updateRangeFill(range);
  if (hint) {
    hint.textContent = spec.hint(nextValue, isEmpty);
  }
}

function updateRangeFill(range) {
  if (!range) return;
  const min = Number(range.min) || 0;
  const max = Number(range.max) || 100;
  const val = Number(range.value) || 0;
  const pct = max === min ? 0 : ((val - min) / (max - min)) * 100;
  const safePct = Math.max(0, Math.min(100, pct));
  range.style.setProperty('--range-progress', `${safePct}%`);
}

function refreshConfigNumberFields() {
  Object.keys(CONFIG_NUMBER_FIELDS).forEach((inputId) => syncConfigNumberField(inputId, 'refresh'));
}

function applySqliteHomePreset(mode = 'default') {
  const input = el('cfgSqliteHomeInput');
  if (!input) return;
  if (mode === 'default') {
    input.value = '';
    return;
  }
  input.value = el('codexHomeInput').value.trim() || state.current?.codexHome || '~/.codex';
}

async function pickDirectoryPath(targetInputId, { title = '选择目录' } = {}) {
  if (!tauriInvoke) {
    flash('Web 模式暂不支持原生目录选择，请手动输入路径', 'error');
    return;
  }

  const target = el(targetInputId);
  if (!target) return;

  const initialPath = target.value.trim() || el('codexHomeInput').value.trim() || state.current?.codexHome || '';
  const json = await api('/api/path/pick-directory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, initialPath }),
  });
  if (!json.ok) {
    flash(json.error || '打开目录选择器失败', 'error');
    return;
  }
  if (!json.data?.selected) return;
  target.value = json.data.path || '';
}

function openCfg3Drawer() {
  const drawer = document.getElementById('cfg3Drawer');
  const scrim = document.getElementById('cfg3DrawerScrim');
  if (!drawer) return;
  drawer.classList.add('open');
  if (scrim) scrim.classList.remove('hide');
  document.body.classList.add('cfg3-drawer-active');
}
function closeCfg3Drawer() {
  const drawer = document.getElementById('cfg3Drawer');
  const scrim = document.getElementById('cfg3DrawerScrim');
  if (!drawer) return;
  drawer.classList.remove('open');
  if (scrim) scrim.classList.add('hide');
  document.body.classList.remove('cfg3-drawer-active');
}
window.openCfg3Drawer = openCfg3Drawer;
window.closeCfg3Drawer = closeCfg3Drawer;

function populateConfigEditor() {
  syncConfigEditorForTool();

  const tool = getConfigEditorTool();

  if (tool === 'openclaw') {
    populateOpenClawConfigEditor();
    applyConfigEditorSearch();
    return;
  }

  if (tool === 'claudecode') {
    populateClaudeCodeConfigEditor();
    applyConfigEditorSearch();
    return;
  }

  if (tool === 'opencode') {
    populateOpenCodeConfigEditor();
    applyConfigEditorSearch();
    return;
  }

  // ── Codex (default) ──
  el('cfgModelInput').value = configValue('model', '');
  el('cfgProviderInput').value = configValue('model_provider', '');
  el('cfgServiceTierSelect').value = configValue('service_tier', '');
  el('cfgPersonalityInput').value = configValue('personality', '');
  el('cfgApprovalSelect').value = configValue('approval_policy', '');
  el('cfgSandboxSelect').value = configValue('sandbox_mode', '');
  el('cfgReasoningSelect').value = configValue('model_reasoning_effort', '');
  el('cfgPlanReasoningSelect').value = configValue('plan_mode_reasoning_effort', '');
  el('cfgContextWindowInput').value = configValue('model_context_window', '');
  el('cfgCompactLimitInput').value = configValue('model_auto_compact_token_limit', '');
  el('cfgToolLimitInput').value = configValue('tool_output_token_limit', '');
  el('cfgSqliteHomeInput').value = configValue('sqlite_home', '');
  el('cfgSqliteHomeInput').placeholder = `默认 ${state.current?.codexHome || '~/.codex'}`;
  el('cfgSqliteHomeUseCodexHomeBtn').title = state.current?.codexHome || '~/.codex';
  el('cfgHideReasoningCheck').checked = Boolean(configValue('hide_agent_reasoning', false));
  el('cfgShowRawReasoningCheck').checked = Boolean(configValue('show_raw_agent_reasoning', false));
  el('cfgDisableStorageCheck').checked = Boolean(configValue('disable_response_storage', false));
  el('cfgShellSnapshotCheck').checked = Boolean(configValue('features.shell_snapshot', false));
  el('cfgCompactPromptCheck').checked = compactPromptEnabled();
  el('cfgUpdateCheck').checked = Boolean(configValue('check_for_update_on_startup', false));
  el('cfgInstructionsTextarea').value = configValue('instructions', '');
  el('cfgBaseInstructionsTextarea').value = configValue('base_instructions', '');
  el('cfgRawTomlTextarea').value = state.current?.configToml || '';
  el('cfgRawAuthTextarea').value = state.current?.authJsonRaw || '{}';
  syncRawConfigHighlight();
  refreshConfigNumberFields();
  syncShortcutActiveState();
  applyConfigEditorSearch();
}

function claudeEnvSourceLabel(source = '') {
  const table = {
    shell: 'Shell',
    'settings.json': 'settings.json',
    env: '进程环境变量',
  };
  return table[source] || source || '';
}

function claudeLoginMethodLabel(login = {}) {
  if (!login?.loggedIn) return '未登录';
  const method = String(login.method || '').toLowerCase();
  if (method === 'oauth') return '官方登录 (OAuth)';
  if (method === 'keychain') return 'API Key (Keychain)';
  if (method === 'api_key') return 'API Key';
  return '已登录';
}

function claudeProviderAuthBadge(provider, data = {}) {
  const login = data.login || {};
  const method = String(login.method || '').toLowerCase();
  const envVars = data.envVars || {};
  const isOfficial = provider.key === 'official' || /api\.anthropic\.com/i.test(provider.baseUrl || '');
  if (isOfficial && login.loggedIn && method === 'oauth') {
    return { tone: 'ok', text: '官方登录 / OAuth' };
  }
  if (provider.maskedAuthToken) return { tone: 'ok', text: `${provider.maskedAuthToken} (Auth Token)` };
  if (provider.maskedApiKey) return { tone: 'ok', text: `${provider.maskedApiKey} (API Key)` };
  if (isOfficial && login.loggedIn && (method === 'api_key' || method === 'keychain')) {
    const masked = envVars.ANTHROPIC_AUTH_TOKEN?.set
      ? envVars.ANTHROPIC_AUTH_TOKEN.masked
      : envVars.ANTHROPIC_API_KEY?.set
      ? envVars.ANTHROPIC_API_KEY.masked
      : '';
    if (masked) return { tone: 'ok', text: `${masked} (API Key)` };
    return { tone: 'ok', text: 'API Key 已配置' };
  }
  return { tone: 'warn', text: '缺少 Key' };
}

function populateClaudeProviderEditorForm(provider, usedModels = []) {
  const target = provider || null;
  const keyInput = el('ccProviderFormKey');
  const nameInput = el('ccProviderFormName');
  const baseUrlInput = el('ccProviderFormBaseUrl');
  const apiKeyInput = el('ccProviderFormApiKey');
  const authTokenInput = el('ccProviderFormAuthToken');
  if (keyInput) keyInput.value = target?.key || '';
  if (nameInput) nameInput.value = target?.name || '';
  if (baseUrlInput) baseUrlInput.value = target?.baseUrl || '';
  setClaudeModelControl(
    'ccProviderFormModelSelect',
    'ccProviderFormModelCustom',
    target?.model || readClaudeModelControl('ccCfgModelSelect', 'ccCfgModelCustom') || '',
    usedModels,
  );
  if (apiKeyInput) {
    apiKeyInput.value = '';
    apiKeyInput.placeholder = target?.maskedApiKey ? `${target.maskedApiKey} (留空保持当前)` : '留空表示保持当前';
  }
  if (authTokenInput) {
    authTokenInput.value = '';
    authTokenInput.placeholder = target?.maskedAuthToken ? `${target.maskedAuthToken} (留空保持当前)` : '留空表示保持当前';
  }
}

function applyClaudeProviderFormToConfigEditor({ includeSecrets = true } = {}) {
  const providerKeyRaw = el('ccProviderFormKey')?.value?.trim() || '';
  const providerName = el('ccProviderFormName')?.value?.trim() || '';
  const baseUrl = el('ccProviderFormBaseUrl')?.value?.trim() || '';
  const model = readClaudeModelControl('ccProviderFormModelSelect', 'ccProviderFormModelCustom');
  const apiKey = el('ccProviderFormApiKey')?.value?.trim() || '';
  const authToken = el('ccProviderFormAuthToken')?.value?.trim() || '';
  const normalizedProviderKey = normalizeProviderKey(providerKeyRaw || inferClaudeProviderKey(baseUrl || ''));

  if (el('ccCfgProviderKeyInput')) el('ccCfgProviderKeyInput').value = normalizedProviderKey;
  if (el('ccCfgBaseUrlInput')) el('ccCfgBaseUrlInput').value = baseUrl;
  if (model) {
    setClaudeModelControl('ccCfgModelSelect', 'ccCfgModelCustom', model, state.claudeCodeState?.usedModels || []);
  }
  if (includeSecrets) {
    if (el('ccCfgApiKeyInput')) el('ccCfgApiKeyInput').value = apiKey;
    if (el('ccCfgAuthTokenInput')) el('ccCfgAuthTokenInput').value = authToken;
  }
  state.claudeSelectedProviderKey = normalizedProviderKey;
  return { providerKey: normalizedProviderKey, providerName };
}

function populateClaudeCodeConfigEditor() {
  renderClaudeModelPresetList();
  const data = state.claudeCodeState || {};
  const settings = data.settings || {};
  const settingsEnv = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const envVars = data.envVars || {};
  const login = data.login || {};
  const providers = getClaudeProviderProfiles(data);
  const activeProvider = providers.find((provider) => provider.key === state.claudeSelectedProviderKey)
    || providers.find((provider) => provider.isActive)
    || providers[0]
    || null;
  if (activeProvider?.key) state.claudeSelectedProviderKey = activeProvider.key;

  const usedModels = Array.isArray(data.usedModels) ? data.usedModels : [];
  setClaudeModelControl('ccCfgModelSelect', 'ccCfgModelCustom', data.model || settings.model || '', usedModels);
  el('ccCfgAlwaysThinkingCheck').checked = Boolean(
    settings.alwaysThinkingEnabled !== undefined ? settings.alwaysThinkingEnabled : data.alwaysThinkingEnabled,
  );
  el('ccCfgSkipDangerousPromptCheck').checked = Boolean(
    settings.skipDangerousModePermissionPrompt !== undefined
      ? settings.skipDangerousModePermissionPrompt
      : data.skipDangerousModePermissionPrompt,
  );

  const baseUrlFromSettings = typeof settingsEnv.ANTHROPIC_BASE_URL === 'string' ? settingsEnv.ANTHROPIC_BASE_URL.trim() : '';
  const baseUrlFromEnv = envVars.ANTHROPIC_BASE_URL?.set ? (envVars.ANTHROPIC_BASE_URL.value || '') : '';
  const providerKeyInput = el('ccCfgProviderKeyInput');
  if (providerKeyInput) {
    providerKeyInput.value = activeProvider?.key
      || normalizeProviderKey(state.claudeSelectedProviderKey || inferClaudeProviderKey(baseUrlFromSettings || baseUrlFromEnv || ''));
  }
  el('ccCfgBaseUrlInput').value = activeProvider?.baseUrl || baseUrlFromSettings || baseUrlFromEnv;

  const apiKeyInput = el('ccCfgApiKeyInput');
  if (apiKeyInput) {
    apiKeyInput.value = '';
    const source = claudeEnvSourceLabel(envVars.ANTHROPIC_API_KEY?.source || data.apiKeySource);
    apiKeyInput.placeholder = activeProvider?.maskedApiKey
      ? `${activeProvider.maskedApiKey} (Provider)`
      : envVars.ANTHROPIC_API_KEY?.set
      ? `${envVars.ANTHROPIC_API_KEY.masked}${source ? ` (${source})` : ''}`
      : '留空表示保持当前';
  }

  const authTokenInput = el('ccCfgAuthTokenInput');
  if (authTokenInput) {
    authTokenInput.value = '';
    const source = claudeEnvSourceLabel(envVars.ANTHROPIC_AUTH_TOKEN?.source);
    authTokenInput.placeholder = activeProvider?.maskedAuthToken
      ? `${activeProvider.maskedAuthToken} (Provider)`
      : envVars.ANTHROPIC_AUTH_TOKEN?.set
      ? `${envVars.ANTHROPIC_AUTH_TOKEN.masked}${source ? ` (${source})` : ''}`
      : '留空表示保持当前';
  }

  const loginMethod = claudeLoginMethodLabel(login);
  const loginSource = login.loggedIn && String(login.method || '').toLowerCase() === 'api_key'
    ? claudeEnvSourceLabel(
      envVars.ANTHROPIC_AUTH_TOKEN?.set
        ? envVars.ANTHROPIC_AUTH_TOKEN.source
        : envVars.ANTHROPIC_API_KEY?.source || data.apiKeySource,
    )
    : '';
  const loginIdentity = login.email || login.orgName || login.plan || '-';
  el('ccCfgLoginMethod').value = activeProvider?.key
    ? `${loginMethod}${loginSource ? ` · ${loginSource}` : ''} · provider:${activeProvider.key}`
    : `${loginMethod}${loginSource ? ` · ${loginSource}` : ''}`;
  el('ccCfgLoginIdentity').value = loginIdentity;
  el('ccCfgSettingsPath').value = data.settingsPath || '~/.claude/settings.json';
  el('ccCfgUsedModels').value = (data.usedModels || []).join(', ');
  el('ccCfgRawJsonTextarea').value = data.settingsJson || '{}';

  const providerList = el('ccCfgProviderList');
  if (state.claudeProviderDetailKey && !providers.some((provider) => provider.key === state.claudeProviderDetailKey)) {
    state.claudeProviderDetailKey = '';
  }
  if (providerList) {
    providerList.innerHTML = providers.length ? providers.map((provider) => {
      const isActive = provider.key === state.claudeSelectedProviderKey;
      const isOpen = provider.key === state.claudeProviderDetailKey;
      const isOfficial = provider.key === 'official' || /api\.anthropic\.com/i.test(provider.baseUrl || '');
      const kind = isOfficial ? '官方' : '自定义';
      const authBadge = claudeProviderAuthBadge(provider, data);
      const netBadge = claudeProviderConnectivityLabel(provider, data);
      return `
        <div class="provider-card cc-provider-row ${isActive ? 'active' : ''}" data-cc-open-provider="${escapeHtml(provider.key)}">
          <div class="provider-main">
            <strong>${escapeHtml(provider.name || provider.key)}</strong>
            <div class="provider-meta">${escapeHtml(kind)} · ${escapeHtml(provider.key)} · ${escapeHtml(provider.baseUrl || 'https://api.anthropic.com')}</div>
          </div>
          <div class="cc-provider-inline-actions">
            <span class="provider-pill ${authBadge.tone}">${escapeHtml(authBadge.text)}</span>
            <span class="provider-pill ${netBadge.tone}">${escapeHtml(netBadge.text)}</span>
            <button type="button" class="secondary tiny-btn" data-cc-provider-action="switch" data-cc-provider-key="${escapeHtml(provider.key)}">切换</button>
            <button type="button" class="secondary tiny-btn" data-cc-provider-action="check" data-cc-provider-key="${escapeHtml(provider.key)}">检测</button>
            <span class="provider-option-model">${escapeHtml(isOpen ? '已展开' : (isActive ? '当前' : '详情'))}</span>
          </div>
        </div>
      `;
    }).join('') : '<div class="provider-meta">暂无 Provider</div>';
  }
  const detailProvider = providers.find((provider) => provider.key === state.claudeProviderDetailKey) || null;
  const detailPanel = el('ccProviderDetailPanel');
  const detailTitle = el('ccProviderDetailTitle');
  if (detailPanel) detailPanel.classList.toggle('hide', !detailProvider);
  if (detailTitle) detailTitle.textContent = detailProvider
    ? `Provider 详情 · ${detailProvider.name || detailProvider.key}`
    : 'Provider 详情';
  if (detailProvider) populateClaudeProviderEditorForm(detailProvider, usedModels);

  syncRawConfigHighlight();
}

function getConfigEditorFieldSearchText(node) {
  const parts = [];
  const title = node.querySelector('span')?.textContent || node.textContent || '';
  parts.push(title);
  node.querySelectorAll('input, textarea, select').forEach((control) => {
    parts.push(control.id || '', control.placeholder || '');
  });
  return normalizeStoreText(parts.join(' '));
}

function rememberSearchOpenState(details) {
  if (details && details.dataset.searchPrevOpen === undefined) {
    details.dataset.searchPrevOpen = details.open ? '1' : '0';
  }
}

function restoreSearchOpenState(details) {
  if (details && details.dataset.searchPrevOpen !== undefined) {
    details.open = details.dataset.searchPrevOpen === '1';
    delete details.dataset.searchPrevOpen;
  }
}

function resetConfigEditorSearch(root) {
  if (!root) return;
  root.querySelectorAll('label.field, label.toggle-item').forEach((node) => {
    node.style.display = '';
  });
  root.querySelectorAll('details.oc-panel, details.oc-subpanel, details.cfg-section').forEach((node) => {
    node.style.display = '';
    restoreSearchOpenState(node);
  });
}

function filterCodexConfigEditor(root, query) {
  const items = [...root.querySelectorAll('label.field, label.toggle-item')];
  let matched = 0;
  items.forEach((node) => {
    const visible = !query || getConfigEditorFieldSearchText(node).includes(query);
    node.style.display = visible ? '' : 'none';
    if (visible) matched += 1;
  });
  // Expand all cfg-sections during search
  if (query) {
    root.querySelectorAll('details.cfg-section').forEach((d) => {
      rememberSearchOpenState(d);
      d.open = true;
    });
  }
  return matched;
}

function filterOpenClawConfigEditor(root, query) {
  const panels = [...root.querySelectorAll('details.oc-panel')];
  let matched = 0;

  panels.forEach((panel) => {
    const panelHeadText = normalizeStoreText(panel.querySelector('.oc-panel-head')?.textContent || '');
    const panelMatch = panelHeadText.includes(query);
    const subpanels = [...panel.querySelectorAll(':scope > .oc-panel-body > details.oc-subpanel')];

    if (subpanels.length) {
      let anySubpanelVisible = false;
      subpanels.forEach((subpanel) => {
        const text = normalizeStoreText(subpanel.textContent || '');
        const visible = panelMatch || text.includes(query);
        subpanel.style.display = visible ? 'block' : 'none';
        if (visible) {
          anySubpanelVisible = true;
          matched += 1;
          rememberSearchOpenState(subpanel);
          subpanel.open = true;
        } else {
          rememberSearchOpenState(subpanel);
        }
      });

      const visible = panelMatch || anySubpanelVisible;
      panel.style.display = visible ? 'block' : 'none';
      rememberSearchOpenState(panel);
      panel.open = visible;
      if (visible && panelMatch && !anySubpanelVisible) matched += 1;
      return;
    }

    const text = normalizeStoreText(panel.textContent || '');
    const visible = text.includes(query);
    panel.style.display = visible ? 'block' : 'none';
    rememberSearchOpenState(panel);
    panel.open = visible;
    if (visible) matched += 1;
  });

  return matched;
}

function syncConfigEditorSearchPopover() {
  const popover = el('configEditorSearchBar');
  const toggleBtn = el('configEditorSearchToggleBtn');
  const input = el('configEditorSearchInput');
  const hasQuery = Boolean(String(input?.value || '').trim());
  if (popover) popover.classList.toggle('hide', !state.configEditorSearchOpen);
  if (toggleBtn) toggleBtn.classList.toggle('active', state.configEditorSearchOpen || hasQuery);
}

function openConfigEditorSearchPopover({ focus = true } = {}) {
  state.configEditorSearchOpen = true;
  syncConfigEditorSearchPopover();
  if (focus) requestAnimationFrame(() => el('configEditorSearchInput')?.focus());
}

function closeConfigEditorSearchPopover({ force = false } = {}) {
  const hasQuery = Boolean(String(el('configEditorSearchInput')?.value || '').trim());
  if (!force && hasQuery) {
    state.configEditorSearchOpen = false;
    syncConfigEditorSearchPopover();
    return;
  }
  state.configEditorSearchOpen = false;
  syncConfigEditorSearchPopover();
}

function applyConfigEditorSearch() {
  const input = el('configEditorSearchInput');
  const clearBtn = el('configEditorSearchClearBtn');
  const empty = el('configEditorSearchEmpty');
  const root = document.querySelector(`[data-tool-editor="${getConfigEditorTool()}"]`);
  const query = normalizeStoreText(input?.value || '');
  syncConfigEditorSearchPopover();
  if (!root) return;

  if (!query) {
    resetConfigEditorSearch(root);
    if (clearBtn) clearBtn.classList.add('hide');
    if (empty) empty.classList.add('hide');
    return;
  }

  if (clearBtn) clearBtn.classList.remove('hide');
  const matched = getConfigEditorTool() === 'openclaw'
    ? filterOpenClawConfigEditor(root, query)
    : filterCodexConfigEditor(root, query);
  if (empty) empty.classList.toggle('hide', matched > 0);
}

/** Show/hide the correct editor panel and sidebar based on active tool. */
function syncConfigEditorForTool() {
  const tool = getConfigEditorTool();
  renderConfigEditorShell(tool);
  const tabs = document.getElementById('configEditorTabs');
  if (tabs) tabs.dataset.activeTool = tool;
  document.querySelectorAll('[data-tool-editor]').forEach(section => {
    section.classList.toggle('hide', section.dataset.toolEditor !== tool);
  });
  document.querySelectorAll('[data-tool-editor-side]').forEach(section => {
    section.classList.toggle('hide', section.dataset.toolEditorSide !== tool);
  });
  document.querySelectorAll('#configEditorTabs .cfg-editor-tab').forEach(tab => {
    const active = tab.dataset.cfgTool === tool;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-pressed', String(active));
  });
  // Update search placeholder per tool
  const searchInput = el('ocRecipeSearchInput');
  if (searchInput) {
    searchInput.placeholder = tool === 'openclaw'
      ? '搜索配置方案…如 Telegram、安全、代理'
      : tool === 'claudecode'
        ? 'Claude Code 配置商店即将支持'
      : '搜索配置方案…如 模型、推理、沙箱、上下文';
    searchInput.value = '';
  }
  const searchResults = el('ocRecipeResults');
  if (searchResults) searchResults.classList.add('hide');

  const fieldSearchInput = el('configEditorSearchInput');
  if (fieldSearchInput) {
    fieldSearchInput.placeholder = tool === 'openclaw'
      ? '搜索配置项…如 Telegram、网关、日志、Agent'
      : tool === 'claudecode'
        ? '搜索配置项…如 模型、认证、Base URL、Token'
      : '搜索配置项…如 沙箱、审批、推理、SQLite';
  }
  const storeBtn = el('openConfigStoreBtn');
  if (storeBtn) storeBtn.classList.toggle('hide', tool === 'claudecode');
  const resetBtn = el('resetConfigEditorBtn');
  if (resetBtn) {
    const resetSupported = tool === 'codex' || tool === 'claudecode';
    resetBtn.classList.toggle('hide', !resetSupported);
    resetBtn.title = tool === 'claudecode'
      ? '重置 Claude Code 非 Provider 配置（保留 Provider）'
      : '重置 Codex 配置（保留 Provider）';
  }
  // Show/hide OpenClaw header config switch
  const ocSwitch = el('ocHeaderConfigSwitch');
  if (ocSwitch) ocSwitch.classList.toggle('hide', tool !== 'openclaw');
  if (tool !== 'openclaw') {
    const sections = [...document.querySelectorAll(`[data-tool-editor="${tool}"] details.cfg-section`)];
    sections.forEach((section, index) => {
      section.open = index === 0;
    });
  }
  refreshRawCodeEditors();
}

/** Populate the OpenClaw config editor form from state.openclawState. */
function populateOpenClawConfigEditor() {
  const cfg = state.openclawState?.config || {};
  const quick = deriveOpenClawQuickConfig(state.openclawState || {});
  syncOpenClawConfigView();

  // ── Model ──
  const modelCfg = cfg.agents?.defaults?.model;
  el('ocCfgModelPrimary').value = modelCfg?.primary || quick.storedModel || '';
  el('ocCfgModelFallbacks').value = (modelCfg?.fallbacks || []).join(', ');
  el('ocCfgThinkingDefault').value = cfg.agents?.defaults?.thinkingDefault || '';
  el('ocCfgWorkspace').value = cfg.agents?.defaults?.workspace || '';
  if (el('ocCfgImageModel')) el('ocCfgImageModel').value = cfg.agents?.defaults?.imageModel || '';
  if (el('ocCfgContextTokens')) el('ocCfgContextTokens').value = cfg.agents?.defaults?.contextTokens || '';

  // ── Provider ──
  const providerApi = quick.api || inferOpenClawApiMode(modelCfg?.primary || '');
  const providerModelRef = quick.model || modelCfg?.primary || getOpenClawDefaultModel(providerApi);
  const providerAlias = quick.providerAlias || String(modelCfg?.primary || providerModelRef).split('/')[0] || inferOpenClawProviderFromEnvKey(quick.envKey, providerApi);
  const providerConfig = cfg?.models?.providers?.[providerAlias] || null;
  const providerEnvKey = quick.envKey || resolveOpenClawProviderEnvKey(providerConfig, providerModelRef, providerApi) || getOpenClawDefaultEnvKey(providerApi);
  el('ocCfgProviderAlias').value = providerAlias || '';
  el('ocCfgProviderApi').value = providerApi || 'openai-completions';
  el('ocCfgProviderBaseUrl').value = quick.baseUrl || getOpenClawDefaultBaseUrl(providerApi);
  el('ocCfgProviderApiKey').value = quick.apiKey || '';
  el('ocCfgProviderEnvKey').value = providerEnvKey;
  el('ocCfgProviderModelName').value = quick.modelName || inferOpenClawModelName(providerModelRef);
  el('ocCfgProviderContextWindow').value = quick.contextWindow || OPENCLAW_DEFAULT_CONTEXT_WINDOW;
  el('ocCfgProviderMaxTokens').value = quick.maxTokens || OPENCLAW_DEFAULT_MAX_TOKENS;

  // ── Channels — Telegram ──
  const tg = cfg.channels?.telegram || {};
  el('ocCfgTelegramToken').value = tg.botToken || '';
  if (el('ocCfgTgDmPolicy')) el('ocCfgTgDmPolicy').value = tg.dmPolicy || '';
  if (el('ocCfgTgGroupPolicy')) el('ocCfgTgGroupPolicy').value = tg.groupPolicy || '';
  if (el('ocCfgTgAllowFrom')) el('ocCfgTgAllowFrom').value = (tg.allowFrom || []).join(', ');
  if (el('ocCfgTgStreaming')) el('ocCfgTgStreaming').value = tg.streaming || '';
  if (el('ocCfgTgReactionLevel')) el('ocCfgTgReactionLevel').value = tg.reactionLevel || '';
  if (el('ocCfgTgHistoryLimit')) el('ocCfgTgHistoryLimit').value = tg.historyLimit || '';
  if (el('ocCfgTgTextChunkLimit')) el('ocCfgTgTextChunkLimit').value = tg.textChunkLimit || '';
  if (el('ocCfgTgDefaultAccount')) el('ocCfgTgDefaultAccount').value = cfg.channels?.telegram?.defaultAccount || '';
  if (el('ocCfgTgDefaultTo')) el('ocCfgTgDefaultTo').value = tg.defaultTo || '';
  if (el('ocCfgTgGroupAllowFrom')) el('ocCfgTgGroupAllowFrom').value = (tg.groupAllowFrom || []).join(', ');
  if (el('ocCfgTgDmHistoryLimit')) el('ocCfgTgDmHistoryLimit').value = tg.dmHistoryLimit || '';
  if (el('ocCfgTgChunkMode')) el('ocCfgTgChunkMode').value = tg.chunkMode || '';
  if (el('ocCfgTgReactionNotifications')) el('ocCfgTgReactionNotifications').value = tg.reactionNotifications || '';
  if (el('ocCfgTgReplyToMode')) el('ocCfgTgReplyToMode').value = tg.replyToMode || '';
  if (el('ocCfgTgWebhookPort')) el('ocCfgTgWebhookPort').value = tg.webhookPort || '';
  if (el('ocCfgTgWebhookPath')) el('ocCfgTgWebhookPath').value = tg.webhookPath || '';
  if (el('ocCfgTgResponsePrefix')) el('ocCfgTgResponsePrefix').value = tg.responsePrefix || '';
  if (el('ocCfgTgAckReaction')) el('ocCfgTgAckReaction').value = tg.ackReaction || '';
  if (el('ocCfgTgBlockStreaming')) el('ocCfgTgBlockStreaming').checked = Boolean(tg.blockStreaming);
  if (el('ocCfgTgLinkPreview')) el('ocCfgTgLinkPreview').checked = tg.linkPreview !== false;
  writeJsonFragmentInput('ocCfgTelegramJson', cfg.channels?.telegram || null);

  // ── Channels — Discord ──
  const dc = cfg.channels?.discord || {};
  el('ocCfgDiscordToken').value = dc.token || '';
  if (el('ocCfgDcDmPolicy')) el('ocCfgDcDmPolicy').value = dc.dm?.policy || '';
  if (el('ocCfgDcGroupPolicy')) el('ocCfgDcGroupPolicy').value = dc.groupPolicy || '';
  if (el('ocCfgDcAllowFrom')) el('ocCfgDcAllowFrom').value = (dc.dm?.allowFrom || []).join(', ');
  if (el('ocCfgDcStreaming')) el('ocCfgDcStreaming').value = dc.streaming || '';
  if (el('ocCfgDcTextChunkLimit')) el('ocCfgDcTextChunkLimit').value = dc.textChunkLimit || '';
  if (el('ocCfgDcDefaultAccount')) el('ocCfgDcDefaultAccount').value = cfg.channels?.discord?.defaultAccount || '';
  if (el('ocCfgDcDefaultTo')) el('ocCfgDcDefaultTo').value = dc.defaultTo || '';
  if (el('ocCfgDcResponsePrefix')) el('ocCfgDcResponsePrefix').value = dc.responsePrefix || '';
  if (el('ocCfgDcAckReaction')) el('ocCfgDcAckReaction').value = dc.ackReaction || '';
  if (el('ocCfgDcAckReactionScope')) el('ocCfgDcAckReactionScope').value = dc.ackReactionScope || '';
  if (el('ocCfgDcActivity')) el('ocCfgDcActivity').value = dc.activity || '';
  if (el('ocCfgDcStatus')) el('ocCfgDcStatus').value = dc.status || '';
  if (el('ocCfgDcAllowBots')) el('ocCfgDcAllowBots').checked = Boolean(dc.allowBots);
  if (el('ocCfgDcVoiceEnabled')) el('ocCfgDcVoiceEnabled').checked = dc.voice?.enabled !== false;
  writeJsonFragmentInput('ocCfgDiscordJson', cfg.channels?.discord || null);

  // ── Channels — Slack ──
  el('ocCfgSlackBotToken').value = cfg.channels?.slack?.botToken || '';
  el('ocCfgSlackAppToken').value = cfg.channels?.slack?.appToken || '';
  if (el('ocCfgSlackSigningSecret')) el('ocCfgSlackSigningSecret').value = cfg.channels?.slack?.signingSecret || '';
  if (el('ocCfgSlackWebhookPath')) el('ocCfgSlackWebhookPath').value = cfg.channels?.slack?.webhookPath || '';
  if (el('ocCfgSlackDefaultAccount')) el('ocCfgSlackDefaultAccount').value = cfg.channels?.slack?.defaultAccount || '';
  if (el('ocCfgSlackDefaultTo')) el('ocCfgSlackDefaultTo').value = cfg.channels?.slack?.defaultTo || '';
  if (el('ocCfgSlackGroupPolicy')) el('ocCfgSlackGroupPolicy').value = cfg.channels?.slack?.groupPolicy || '';
  if (el('ocCfgSlackTextChunkLimit')) el('ocCfgSlackTextChunkLimit').value = cfg.channels?.slack?.textChunkLimit || '';
  if (el('ocCfgSlackStreaming')) el('ocCfgSlackStreaming').value = cfg.channels?.slack?.streaming || '';
  if (el('ocCfgSlackResponsePrefix')) el('ocCfgSlackResponsePrefix').value = cfg.channels?.slack?.responsePrefix || '';
  if (el('ocCfgSlackAckReaction')) el('ocCfgSlackAckReaction').value = cfg.channels?.slack?.ackReaction || '';
  if (el('ocCfgSlackTypingReaction')) el('ocCfgSlackTypingReaction').value = cfg.channels?.slack?.typingReaction || '';
  if (el('ocCfgSlackAllowBots')) el('ocCfgSlackAllowBots').checked = Boolean(cfg.channels?.slack?.allowBots);
  if (el('ocCfgSlackRequireMention')) el('ocCfgSlackRequireMention').checked = Boolean(cfg.channels?.slack?.requireMention);
  writeJsonFragmentInput('ocCfgSlackJson', cfg.channels?.slack || null);

  // ── Channels — WhatsApp ──
  const wa = cfg.channels?.whatsapp || {};
  if (el('ocCfgWhatsAppEnabled')) el('ocCfgWhatsAppEnabled').checked = wa.enabled !== false;
  if (el('ocCfgWhatsAppDefaultTo')) el('ocCfgWhatsAppDefaultTo').value = wa.defaultTo || '';
  if (el('ocCfgWhatsAppDmPolicy')) el('ocCfgWhatsAppDmPolicy').value = wa.dmPolicy || '';
  if (el('ocCfgWhatsAppGroupPolicy')) el('ocCfgWhatsAppGroupPolicy').value = wa.groupPolicy || '';
  if (el('ocCfgWhatsAppAllowFrom')) el('ocCfgWhatsAppAllowFrom').value = (wa.allowFrom || []).join(', ');
  if (el('ocCfgWhatsAppGroupAllowFrom')) el('ocCfgWhatsAppGroupAllowFrom').value = (wa.groupAllowFrom || []).join(', ');
  if (el('ocCfgWhatsAppHistoryLimit')) el('ocCfgWhatsAppHistoryLimit').value = wa.historyLimit || '';
  if (el('ocCfgWhatsAppDmHistoryLimit')) el('ocCfgWhatsAppDmHistoryLimit').value = wa.dmHistoryLimit || '';
  if (el('ocCfgWhatsAppTextChunkLimit')) el('ocCfgWhatsAppTextChunkLimit').value = wa.textChunkLimit || '';
  if (el('ocCfgWhatsAppMediaMaxMb')) el('ocCfgWhatsAppMediaMaxMb').value = wa.mediaMaxMb || '';
  if (el('ocCfgWhatsAppResponsePrefix')) el('ocCfgWhatsAppResponsePrefix').value = wa.responsePrefix || '';
  if (el('ocCfgWhatsAppSelfChatMode')) el('ocCfgWhatsAppSelfChatMode').checked = Boolean(wa.selfChatMode);
  if (el('ocCfgWhatsAppSendReadReceipts')) el('ocCfgWhatsAppSendReadReceipts').checked = wa.sendReadReceipts !== false;

  // ── Channels — JSON fragments ──
  const signal = cfg.channels?.signal || {};
  if (el('ocCfgSignalAccount')) el('ocCfgSignalAccount').value = signal.account || '';
  if (el('ocCfgSignalHttpUrl')) el('ocCfgSignalHttpUrl').value = signal.httpUrl || '';
  if (el('ocCfgSignalCliPath')) el('ocCfgSignalCliPath').value = signal.cliPath || '';
  if (el('ocCfgSignalDmPolicy')) el('ocCfgSignalDmPolicy').value = signal.dmPolicy || '';
  if (el('ocCfgSignalGroupPolicy')) el('ocCfgSignalGroupPolicy').value = signal.groupPolicy || '';
  if (el('ocCfgSignalAllowFrom')) el('ocCfgSignalAllowFrom').value = (signal.allowFrom || []).join(', ');
  if (el('ocCfgSignalReactionNotifications')) el('ocCfgSignalReactionNotifications').value = signal.reactionNotifications || '';
  if (el('ocCfgSignalTextChunkLimit')) el('ocCfgSignalTextChunkLimit').value = signal.textChunkLimit || '';
  if (el('ocCfgSignalResponsePrefix')) el('ocCfgSignalResponsePrefix').value = signal.responsePrefix || '';
  if (el('ocCfgSignalEnabled')) el('ocCfgSignalEnabled').checked = signal.enabled !== false;
  if (el('ocCfgSignalAutoStart')) el('ocCfgSignalAutoStart').checked = signal.autoStart !== false;
  if (el('ocCfgSignalReadReceipts')) el('ocCfgSignalReadReceipts').checked = Boolean(signal.sendReadReceipts);
  writeJsonFragmentInput('ocCfgSignalJson', cfg.channels?.signal || null);

  const gc = cfg.channels?.googlechat || {};
  if (el('ocCfgGoogleChatServiceAccountFile')) el('ocCfgGoogleChatServiceAccountFile').value = gc.serviceAccountFile || '';
  if (el('ocCfgGoogleChatWebhookPath')) el('ocCfgGoogleChatWebhookPath').value = gc.webhookPath || '';
  if (el('ocCfgGoogleChatDefaultTo')) el('ocCfgGoogleChatDefaultTo').value = gc.defaultTo || '';
  if (el('ocCfgGoogleChatDmPolicy')) el('ocCfgGoogleChatDmPolicy').value = gc.dm?.policy || '';
  if (el('ocCfgGoogleChatGroupPolicy')) el('ocCfgGoogleChatGroupPolicy').value = gc.groupPolicy || '';
  if (el('ocCfgGoogleChatAllowFrom')) el('ocCfgGoogleChatAllowFrom').value = (gc.dm?.allowFrom || []).join(', ');
  if (el('ocCfgGoogleChatGroupAllowFrom')) el('ocCfgGoogleChatGroupAllowFrom').value = (gc.groupAllowFrom || []).join(', ');
  if (el('ocCfgGoogleChatTypingIndicator')) el('ocCfgGoogleChatTypingIndicator').value = gc.typingIndicator || '';
  if (el('ocCfgGoogleChatTextChunkLimit')) el('ocCfgGoogleChatTextChunkLimit').value = gc.textChunkLimit || '';
  if (el('ocCfgGoogleChatResponsePrefix')) el('ocCfgGoogleChatResponsePrefix').value = gc.responsePrefix || '';
  if (el('ocCfgGoogleChatEnabled')) el('ocCfgGoogleChatEnabled').checked = gc.enabled !== false;
  if (el('ocCfgGoogleChatAllowBots')) el('ocCfgGoogleChatAllowBots').checked = Boolean(gc.allowBots);
  writeJsonFragmentInput('ocCfgGoogleChatJson', cfg.channels?.googlechat || null);

  const imsg = cfg.channels?.imessage || {};
  if (el('ocCfgImessageCliPath')) el('ocCfgImessageCliPath').value = imsg.cliPath || '';
  if (el('ocCfgImessageService')) el('ocCfgImessageService').value = imsg.service || '';
  if (el('ocCfgImessageRemoteHost')) el('ocCfgImessageRemoteHost').value = imsg.remoteHost || '';
  if (el('ocCfgImessageDefaultTo')) el('ocCfgImessageDefaultTo').value = imsg.defaultTo || '';
  if (el('ocCfgImessageDmPolicy')) el('ocCfgImessageDmPolicy').value = imsg.dmPolicy || '';
  if (el('ocCfgImessageGroupPolicy')) el('ocCfgImessageGroupPolicy').value = imsg.groupPolicy || '';
  if (el('ocCfgImessageAllowFrom')) el('ocCfgImessageAllowFrom').value = (imsg.allowFrom || []).join(', ');
  if (el('ocCfgImessageTextChunkLimit')) el('ocCfgImessageTextChunkLimit').value = imsg.textChunkLimit || '';
  if (el('ocCfgImessageResponsePrefix')) el('ocCfgImessageResponsePrefix').value = imsg.responsePrefix || '';
  if (el('ocCfgImessageEnabled')) el('ocCfgImessageEnabled').checked = imsg.enabled !== false;
  if (el('ocCfgImessageIncludeAttachments')) el('ocCfgImessageIncludeAttachments').checked = Boolean(imsg.includeAttachments);
  writeJsonFragmentInput('ocCfgImessageJson', cfg.channels?.imessage || null);

  const irc = cfg.channels?.irc || {};
  if (el('ocCfgIrcHost')) el('ocCfgIrcHost').value = irc.host || '';
  if (el('ocCfgIrcPort')) el('ocCfgIrcPort').value = irc.port || '';
  if (el('ocCfgIrcNick')) el('ocCfgIrcNick').value = irc.nick || '';
  if (el('ocCfgIrcUsername')) el('ocCfgIrcUsername').value = irc.username || '';
  if (el('ocCfgIrcPassword')) el('ocCfgIrcPassword').value = irc.password || '';
  if (el('ocCfgIrcChannels')) el('ocCfgIrcChannels').value = (irc.channels || []).join(', ');
  if (el('ocCfgIrcDmPolicy')) el('ocCfgIrcDmPolicy').value = irc.dmPolicy || '';
  if (el('ocCfgIrcGroupPolicy')) el('ocCfgIrcGroupPolicy').value = irc.groupPolicy || '';
  if (el('ocCfgIrcAllowFrom')) el('ocCfgIrcAllowFrom').value = (irc.allowFrom || []).join(', ');
  if (el('ocCfgIrcTextChunkLimit')) el('ocCfgIrcTextChunkLimit').value = irc.textChunkLimit || '';
  if (el('ocCfgIrcMentionPatterns')) el('ocCfgIrcMentionPatterns').value = (irc.mentionPatterns || []).join(', ');
  if (el('ocCfgIrcEnabled')) el('ocCfgIrcEnabled').checked = irc.enabled !== false;
  if (el('ocCfgIrcTls')) el('ocCfgIrcTls').checked = irc.tls !== false;
  writeJsonFragmentInput('ocCfgIrcJson', cfg.channels?.irc || null);

  const teams = cfg.channels?.msteams || {};
  if (el('ocCfgMSTeamsAppId')) el('ocCfgMSTeamsAppId').value = teams.appId || '';
  if (el('ocCfgMSTeamsAppPassword')) el('ocCfgMSTeamsAppPassword').value = teams.appPassword || '';
  if (el('ocCfgMSTeamsTenantId')) el('ocCfgMSTeamsTenantId').value = teams.tenantId || '';
  if (el('ocCfgMSTeamsWebhookPort')) el('ocCfgMSTeamsWebhookPort').value = teams.webhook?.port || '';
  if (el('ocCfgMSTeamsWebhookPath')) el('ocCfgMSTeamsWebhookPath').value = teams.webhook?.path || '';
  if (el('ocCfgMSTeamsDefaultTo')) el('ocCfgMSTeamsDefaultTo').value = teams.defaultTo || '';
  if (el('ocCfgMSTeamsDmPolicy')) el('ocCfgMSTeamsDmPolicy').value = teams.dmPolicy || '';
  if (el('ocCfgMSTeamsGroupPolicy')) el('ocCfgMSTeamsGroupPolicy').value = teams.groupPolicy || '';
  if (el('ocCfgMSTeamsAllowFrom')) el('ocCfgMSTeamsAllowFrom').value = (teams.allowFrom || []).join(', ');
  if (el('ocCfgMSTeamsTextChunkLimit')) el('ocCfgMSTeamsTextChunkLimit').value = teams.textChunkLimit || '';
  if (el('ocCfgMSTeamsResponsePrefix')) el('ocCfgMSTeamsResponsePrefix').value = teams.responsePrefix || '';
  if (el('ocCfgMSTeamsEnabled')) el('ocCfgMSTeamsEnabled').checked = teams.enabled !== false;
  if (el('ocCfgMSTeamsRequireMention')) el('ocCfgMSTeamsRequireMention').checked = Boolean(teams.requireMention);
  writeJsonFragmentInput('ocCfgMSTeamsJson', cfg.channels?.msteams || null);
  writeJsonFragmentInput('ocCfgChannelModelByChannelJson', cfg.channels?.modelByChannel || null);
  if (el('ocCfgMatrixHomeserver')) el('ocCfgMatrixHomeserver').value = cfg.channels?.matrix?.homeserver || '';
  if (el('ocCfgMatrixToken')) el('ocCfgMatrixToken').value = cfg.channels?.matrix?.accessToken || '';
  if (el('ocCfgLineSecret')) el('ocCfgLineSecret').value = cfg.channels?.line?.channelSecret || '';
  if (el('ocCfgLineToken')) el('ocCfgLineToken').value = cfg.channels?.line?.accessToken || '';
  if (el('ocCfgWechatAppId')) el('ocCfgWechatAppId').value = cfg.channels?.wechat?.appId || '';
  if (el('ocCfgWechatToken')) el('ocCfgWechatToken').value = cfg.channels?.wechat?.token || '';
  if (el('ocCfgWechatAesKey')) el('ocCfgWechatAesKey').value = cfg.channels?.wechat?.encodingAESKey || '';
  if (el('ocCfgWechatWorkCorpId')) el('ocCfgWechatWorkCorpId').value = cfg.channels?.wechatwork?.corpId || '';
  if (el('ocCfgWechatWorkAgentId')) el('ocCfgWechatWorkAgentId').value = cfg.channels?.wechatwork?.agentId || '';
  if (el('ocCfgWechatWorkSecret')) el('ocCfgWechatWorkSecret').value = cfg.channels?.wechatwork?.secret || '';

  // ── Extension / runtime JSON fragments ──
  if (el('ocCfgMemoryBackend')) el('ocCfgMemoryBackend').value = cfg.memory?.backend || '';
  if (el('ocCfgMemoryCitations')) el('ocCfgMemoryCitations').value = cfg.memory?.citations || '';
  if (el('ocCfgMemoryQmdCommand')) el('ocCfgMemoryQmdCommand').value = cfg.memory?.qmd?.command || '';
  if (el('ocCfgMemoryQmdSearchMode')) el('ocCfgMemoryQmdSearchMode').value = cfg.memory?.qmd?.searchMode || '';
  if (el('ocCfgMemorySessionExportDir')) el('ocCfgMemorySessionExportDir').value = cfg.memory?.qmd?.sessions?.exportDir || '';
  if (el('ocCfgMemorySessionRetentionDays')) el('ocCfgMemorySessionRetentionDays').value = cfg.memory?.qmd?.sessions?.retentionDays || '';
  if (el('ocCfgMemoryUpdateInterval')) el('ocCfgMemoryUpdateInterval').value = cfg.memory?.qmd?.update?.interval || '';
  if (el('ocCfgMemoryEmbedInterval')) el('ocCfgMemoryEmbedInterval').value = cfg.memory?.qmd?.update?.embedInterval || '';
  if (el('ocCfgMemoryMaxResults')) el('ocCfgMemoryMaxResults').value = cfg.memory?.qmd?.limits?.maxResults || '';
  if (el('ocCfgMemoryMcporterServerName')) el('ocCfgMemoryMcporterServerName').value = cfg.memory?.qmd?.mcporter?.serverName || '';
  if (el('ocCfgMemoryIncludeDefaultMemory')) el('ocCfgMemoryIncludeDefaultMemory').checked = Boolean(cfg.memory?.qmd?.includeDefaultMemory);
  if (el('ocCfgMemorySessionsEnabled')) el('ocCfgMemorySessionsEnabled').checked = Boolean(cfg.memory?.qmd?.sessions?.enabled);
  if (el('ocCfgMemoryMcporterEnabled')) el('ocCfgMemoryMcporterEnabled').checked = Boolean(cfg.memory?.qmd?.mcporter?.enabled);
  if (el('ocCfgMemoryMcporterStartDaemon')) el('ocCfgMemoryMcporterStartDaemon').checked = cfg.memory?.qmd?.mcporter?.startDaemon !== false;
  writeJsonFragmentInput('ocCfgMemoryJson', cfg.memory || null);
  if (el('ocCfgSkillsExtraDirs')) el('ocCfgSkillsExtraDirs').value = (cfg.skills?.load?.extraDirs || []).join(', ');
  if (el('ocCfgSkillsNodeManager')) el('ocCfgSkillsNodeManager').value = cfg.skills?.install?.nodeManager || '';
  if (el('ocCfgSkillsMaxInPrompt')) el('ocCfgSkillsMaxInPrompt').value = cfg.skills?.limits?.maxSkillsInPrompt || '';
  if (el('ocCfgSkillsPromptChars')) el('ocCfgSkillsPromptChars').value = cfg.skills?.limits?.maxSkillsPromptChars || '';
  if (el('ocCfgSkillsWatch')) el('ocCfgSkillsWatch').checked = Boolean(cfg.skills?.load?.watch);
  if (el('ocCfgSkillsPreferBrew')) el('ocCfgSkillsPreferBrew').checked = Boolean(cfg.skills?.install?.preferBrew);
  writeJsonFragmentInput('ocCfgSkillsJson', cfg.skills || null);
  if (el('ocCfgPluginsAllow')) el('ocCfgPluginsAllow').value = (cfg.plugins?.allow || []).join(', ');
  if (el('ocCfgPluginsDeny')) el('ocCfgPluginsDeny').value = (cfg.plugins?.deny || []).join(', ');
  if (el('ocCfgPluginsPaths')) el('ocCfgPluginsPaths').value = (cfg.plugins?.load?.paths || []).join(', ');
  if (el('ocCfgPluginsMemorySlot')) el('ocCfgPluginsMemorySlot').value = cfg.plugins?.slots?.memory || '';
  if (el('ocCfgPluginsContextEngineSlot')) el('ocCfgPluginsContextEngineSlot').value = cfg.plugins?.slots?.contextEngine || '';
  if (el('ocCfgPluginsEnabled')) el('ocCfgPluginsEnabled').checked = Boolean(cfg.plugins?.enabled);
  writeJsonFragmentInput('ocCfgPluginsJson', cfg.plugins || null);
  if (el('ocCfgBrowserCdpUrl')) el('ocCfgBrowserCdpUrl').value = cfg.browser?.cdpUrl || '';
  if (el('ocCfgBrowserExecutablePath')) el('ocCfgBrowserExecutablePath').value = cfg.browser?.executablePath || '';
  if (el('ocCfgBrowserDefaultProfile')) el('ocCfgBrowserDefaultProfile').value = cfg.browser?.defaultProfile || '';
  if (el('ocCfgBrowserCdpPortRangeStart')) el('ocCfgBrowserCdpPortRangeStart').value = cfg.browser?.cdpPortRangeStart || '';
  if (el('ocCfgBrowserColor')) el('ocCfgBrowserColor').value = cfg.browser?.color || '';
  if (el('ocCfgBrowserExtraArgs')) el('ocCfgBrowserExtraArgs').value = (cfg.browser?.extraArgs || []).join(', ');
  if (el('ocCfgBrowserEnabled')) el('ocCfgBrowserEnabled').checked = Boolean(cfg.browser?.enabled);
  if (el('ocCfgBrowserHeadless')) el('ocCfgBrowserHeadless').checked = Boolean(cfg.browser?.headless);
  if (el('ocCfgBrowserAttachOnly')) el('ocCfgBrowserAttachOnly').checked = Boolean(cfg.browser?.attachOnly);
  if (el('ocCfgBrowserNoSandbox')) el('ocCfgBrowserNoSandbox').checked = Boolean(cfg.browser?.noSandbox);
  if (el('ocCfgBrowserEvaluateEnabled')) el('ocCfgBrowserEvaluateEnabled').checked = cfg.browser?.evaluateEnabled !== false;
  writeJsonFragmentInput('ocCfgBrowserJson', cfg.browser || null);
  if (el('ocCfgWebHeartbeatSeconds')) el('ocCfgWebHeartbeatSeconds').value = cfg.web?.heartbeatSeconds || '';
  if (el('ocCfgWebReconnectInitialMs')) el('ocCfgWebReconnectInitialMs').value = cfg.web?.reconnect?.initialMs || '';
  if (el('ocCfgWebReconnectMaxMs')) el('ocCfgWebReconnectMaxMs').value = cfg.web?.reconnect?.maxMs || '';
  if (el('ocCfgWebEnabled')) el('ocCfgWebEnabled').checked = cfg.web?.enabled !== false;
  if (el('ocCfgNodeHostAllowProfiles')) el('ocCfgNodeHostAllowProfiles').value = (cfg.nodeHost?.browserProxy?.allowProfiles || []).join(', ');
  if (el('ocCfgNodeHostBrowserProxyEnabled')) el('ocCfgNodeHostBrowserProxyEnabled').checked = Boolean(cfg.nodeHost?.browserProxy?.enabled);
  if (el('ocCfgDiscoveryDomain')) el('ocCfgDiscoveryDomain').value = cfg.discovery?.wideArea?.domain || '';
  if (el('ocCfgDiscoveryMdnsMode')) el('ocCfgDiscoveryMdnsMode').value = cfg.discovery?.mdns?.mode || '';
  if (el('ocCfgDiscoveryWideAreaEnabled')) el('ocCfgDiscoveryWideAreaEnabled').checked = Boolean(cfg.discovery?.wideArea?.enabled);
  if (el('ocCfgCanvasRoot')) el('ocCfgCanvasRoot').value = cfg.canvasHost?.root || '';
  if (el('ocCfgCanvasPort')) el('ocCfgCanvasPort').value = cfg.canvasHost?.port || '';
  if (el('ocCfgCanvasEnabled')) el('ocCfgCanvasEnabled').checked = Boolean(cfg.canvasHost?.enabled);
  if (el('ocCfgCanvasLiveReload')) el('ocCfgCanvasLiveReload').checked = cfg.canvasHost?.liveReload !== false;
  if (el('ocCfgTalkProvider')) el('ocCfgTalkProvider').value = cfg.talk?.provider || '';
  if (el('ocCfgTalkVoiceId')) el('ocCfgTalkVoiceId').value = cfg.talk?.voiceId || '';
  if (el('ocCfgTalkModelId')) el('ocCfgTalkModelId').value = cfg.talk?.modelId || '';
  if (el('ocCfgTalkOutputFormat')) el('ocCfgTalkOutputFormat').value = cfg.talk?.outputFormat || '';
  if (el('ocCfgTalkApiKey')) el('ocCfgTalkApiKey').value = cfg.talk?.apiKey || '';
  if (el('ocCfgTalkInterruptOnSpeech')) el('ocCfgTalkInterruptOnSpeech').checked = cfg.talk?.interruptOnSpeech !== false;
  if (el('ocCfgSecretsDefaultEnv')) el('ocCfgSecretsDefaultEnv').value = cfg.secrets?.defaults?.env || '';
  if (el('ocCfgSecretsDefaultFile')) el('ocCfgSecretsDefaultFile').value = cfg.secrets?.defaults?.file || '';
  if (el('ocCfgSecretsDefaultExec')) el('ocCfgSecretsDefaultExec').value = cfg.secrets?.defaults?.exec || '';
  if (el('ocCfgSecretsMaxProviderConcurrency')) el('ocCfgSecretsMaxProviderConcurrency').value = cfg.secrets?.resolution?.maxProviderConcurrency || '';
  writeJsonFragmentInput('ocCfgMediaJson', cfg.media || null);
  writeJsonFragmentInput('ocCfgInfraJson', {
    ...(cfg.discovery ? { discovery: cfg.discovery } : {}),
    ...(cfg.canvasHost ? { canvasHost: cfg.canvasHost } : {}),
    ...(cfg.talk ? { talk: cfg.talk } : {}),
  });
  writeJsonFragmentInput('ocCfgRuntimeJson', {
    ...(cfg.web ? { web: cfg.web } : {}),
    ...(cfg.nodeHost ? { nodeHost: cfg.nodeHost } : {}),
    ...(cfg.secrets ? { secrets: cfg.secrets } : {}),
  });
  writeJsonFragmentInput('ocCfgSystemJson', {
    ...(cfg.auth ? { auth: cfg.auth } : {}),
    ...(cfg.acp ? { acp: cfg.acp } : {}),
    ...(cfg.cli ? { cli: cfg.cli } : {}),
    ...(cfg.bindings ? { bindings: cfg.bindings } : {}),
    ...(cfg.broadcast ? { broadcast: cfg.broadcast } : {}),
    ...(cfg.audio ? { audio: cfg.audio } : {}),
  });

  // ── Channels defaults ──
  if (el('ocCfgChannelDefaultGroupPolicy')) el('ocCfgChannelDefaultGroupPolicy').value = cfg.channels?.defaults?.groupPolicy || '';

  // ── Agent & Reply ──
  const ad = cfg.agents?.defaults || {};
  if (el('ocCfgMaxConcurrent')) el('ocCfgMaxConcurrent').value = ad.maxConcurrent || '';
  if (el('ocCfgTimeoutSeconds')) el('ocCfgTimeoutSeconds').value = ad.timeoutSeconds || '';
  if (el('ocCfgVerboseDefault')) el('ocCfgVerboseDefault').value = ad.verboseDefault || '';
  if (el('ocCfgElevatedDefault')) el('ocCfgElevatedDefault').value = ad.elevatedDefault || '';
  if (el('ocCfgBlockStreamingDefault')) el('ocCfgBlockStreamingDefault').value = ad.blockStreamingDefault || '';
  if (el('ocCfgTypingMode')) el('ocCfgTypingMode').value = ad.typingMode || '';
  if (el('ocCfgHumanDelay')) el('ocCfgHumanDelay').value = ad.humanDelay || '';
  if (el('ocCfgResponsePrefix')) el('ocCfgResponsePrefix').value = cfg.messages?.responsePrefix || '';
  // Heartbeat
  const hb = ad.heartbeat || {};
  if (el('ocCfgHeartbeatEvery')) el('ocCfgHeartbeatEvery').value = hb.every || '';
  if (el('ocCfgHeartbeatTarget')) el('ocCfgHeartbeatTarget').value = hb.target || '';
  if (el('ocCfgHeartbeatModel')) el('ocCfgHeartbeatModel').value = hb.model || '';
  if (el('ocCfgHeartbeatLightContext')) el('ocCfgHeartbeatLightContext').checked = Boolean(hb.lightContext);

  // ── Tools ──
  if (el('ocCfgToolsProfile')) el('ocCfgToolsProfile').value = cfg.tools?.profile || '';
  if (el('ocCfgToolsAlsoAllow')) el('ocCfgToolsAlsoAllow').value = (cfg.tools?.allow || []).join(', ');
  if (el('ocCfgToolsDeny')) el('ocCfgToolsDeny').value = (cfg.tools?.deny || []).join(', ');
  if (el('ocCfgExecHost')) el('ocCfgExecHost').value = cfg.tools?.exec?.host || '';
  if (el('ocCfgExecSecurity')) el('ocCfgExecSecurity').value = cfg.tools?.exec?.security || '';
  if (el('ocCfgExecTimeout')) el('ocCfgExecTimeout').value = cfg.tools?.exec?.timeoutSec || '';
  if (el('ocCfgWebSearchProvider')) el('ocCfgWebSearchProvider').value = cfg.tools?.web?.search?.provider || '';
  if (el('ocCfgWebSearchApiKey')) el('ocCfgWebSearchApiKey').value = cfg.tools?.web?.search?.apiKey || '';

  // ── Security ──
  const cmds = cfg.commands || {};
  if (el('ocCfgCommandsText')) el('ocCfgCommandsText').value = cmds.text === false ? 'false' : cmds.text === true ? 'true' : '';
  if (el('ocCfgCommandsConfig')) el('ocCfgCommandsConfig').value = cmds.config === true ? 'true' : cmds.config === false ? 'false' : '';
  if (el('ocCfgCommandsBash')) el('ocCfgCommandsBash').value = cmds.bash === true ? 'true' : cmds.bash === false ? 'false' : '';
  if (el('ocCfgToolsElevatedEnabled')) el('ocCfgToolsElevatedEnabled').checked = cfg.tools?.elevated?.enabled !== false;
  if (el('ocCfgApprovalsEnabled')) el('ocCfgApprovalsEnabled').checked = Boolean(cfg.approvals?.enabled);

  // ── Session ──
  const sess = cfg.session || {};
  if (el('ocCfgSessionScope')) el('ocCfgSessionScope').value = sess.scope || '';
  if (el('ocCfgSessionIdleMinutes')) el('ocCfgSessionIdleMinutes').value = sess.idleMinutes || '';
  if (el('ocCfgSessionResetMode')) el('ocCfgSessionResetMode').value = sess.reset || '';
  if (el('ocCfgSessionResetTriggers')) el('ocCfgSessionResetTriggers').value = '';
  if (el('ocCfgSessionPruneAfter')) el('ocCfgSessionPruneAfter').value = sess.maintenance?.pruneAfter || '';
  if (el('ocCfgSessionMaxEntries')) el('ocCfgSessionMaxEntries').value = sess.maintenance?.maxEntries || '';

  // ── Gateway ──
  el('ocCfgGatewayPort').value = cfg.gateway?.port || 18789;
  if (el('ocCfgGatewayMode')) el('ocCfgGatewayMode').value = cfg.gateway?.mode || '';
  el('ocCfgGatewayBind').value = cfg.gateway?.bind || 'loopback';
  if (el('ocCfgGatewayCustomBindHost')) el('ocCfgGatewayCustomBindHost').value = cfg.gateway?.customBindHost || '';
  el('ocCfgGatewayAuthMode').value = cfg.gateway?.auth?.mode || 'token';
  el('ocCfgGatewayToken').value = cfg.gateway?.auth?.token || '';
  if (el('ocCfgGatewayPassword')) el('ocCfgGatewayPassword').value = cfg.gateway?.auth?.password || '';
  if (el('ocCfgGatewayTrustedProxyUserHeader')) el('ocCfgGatewayTrustedProxyUserHeader').value = cfg.gateway?.auth?.trustedProxy?.userHeader || '';
  if (el('ocCfgGatewayTrustedProxyRequiredHeaders')) el('ocCfgGatewayTrustedProxyRequiredHeaders').value = (cfg.gateway?.auth?.trustedProxy?.requiredHeaders || []).join(', ');
  if (el('ocCfgGatewayTrustedProxyAllowUsers')) el('ocCfgGatewayTrustedProxyAllowUsers').value = (cfg.gateway?.auth?.trustedProxy?.allowUsers || []).join(', ');
  if (el('ocCfgGatewayAllowTailscale')) el('ocCfgGatewayAllowTailscale').checked = Boolean(cfg.gateway?.auth?.allowTailscale);
  if (el('ocCfgGatewayReload')) el('ocCfgGatewayReload').value = cfg.gateway?.reload || '';
  if (el('ocCfgGatewayHealthCheck')) el('ocCfgGatewayHealthCheck').value = cfg.gateway?.channelHealthCheckMinutes || '';
  if (el('ocCfgGatewayTailscaleMode')) el('ocCfgGatewayTailscaleMode').value = cfg.gateway?.tailscale?.mode || '';
  if (el('ocCfgGatewayTlsEnabled')) el('ocCfgGatewayTlsEnabled').checked = Boolean(cfg.gateway?.tls?.enabled);
  if (el('ocCfgGatewayTlsAutoGenerate')) el('ocCfgGatewayTlsAutoGenerate').checked = cfg.gateway?.tls?.autoGenerate !== false;
  if (el('ocCfgGatewayTlsCertPath')) el('ocCfgGatewayTlsCertPath').value = cfg.gateway?.tls?.certPath || '';
  if (el('ocCfgGatewayTlsKeyPath')) el('ocCfgGatewayTlsKeyPath').value = cfg.gateway?.tls?.keyPath || '';
  if (el('ocCfgGatewayTlsCaPath')) el('ocCfgGatewayTlsCaPath').value = cfg.gateway?.tls?.caPath || '';
  if (el('ocCfgGatewayControlUiEnabled')) el('ocCfgGatewayControlUiEnabled').checked = cfg.gateway?.controlUi?.enabled !== false;
  if (el('ocCfgGatewayControlUiBasePath')) el('ocCfgGatewayControlUiBasePath').value = cfg.gateway?.controlUi?.basePath || '';
  if (el('ocCfgGatewayControlUiAllowedOrigins')) el('ocCfgGatewayControlUiAllowedOrigins').value = (cfg.gateway?.controlUi?.allowedOrigins || []).join(', ');
  if (el('ocCfgGatewayHttpChatCompletions')) el('ocCfgGatewayHttpChatCompletions').checked = Boolean(cfg.gateway?.http?.endpoints?.chatCompletions);
  if (el('ocCfgGatewayHttpResponses')) el('ocCfgGatewayHttpResponses').checked = Boolean(cfg.gateway?.http?.endpoints?.responses);
  if (el('ocCfgGatewayHttpChatBodyBytes')) el('ocCfgGatewayHttpChatBodyBytes').value = cfg.gateway?.http?.endpoints?.chatCompletions?.maxBodyBytes || '';
  if (el('ocCfgGatewayHttpResponsesBodyBytes')) el('ocCfgGatewayHttpResponsesBodyBytes').value = cfg.gateway?.http?.endpoints?.responses?.maxBodyBytes || '';

  // ── Cron & Hooks ──
  if (el('ocCfgCronEnabled')) el('ocCfgCronEnabled').checked = Boolean(cfg.cron?.enabled);
  if (el('ocCfgCronMaxConcurrent')) el('ocCfgCronMaxConcurrent').value = cfg.cron?.maxConcurrentRuns || '';
  if (el('ocCfgCronSessionRetention')) el('ocCfgCronSessionRetention').value = cfg.cron?.sessionRetention || '';
  if (el('ocCfgHooksEnabled')) el('ocCfgHooksEnabled').checked = Boolean(cfg.hooks?.enabled);
  if (el('ocCfgHooksPath')) el('ocCfgHooksPath').value = cfg.hooks?.path || '';
  if (el('ocCfgHooksToken')) el('ocCfgHooksToken').value = cfg.hooks?.token || '';

  // ── Identity ──
  el('ocCfgAssistantName').value = cfg.ui?.assistant?.name || 'OpenClaw';
  el('ocCfgAssistantAvatar').value = cfg.ui?.assistant?.avatar || '';
  const seamColor = cfg.ui?.seamColor || '#6366f1';
  el('ocCfgSeamColor').value = seamColor;
  el('ocCfgSeamColorText').value = seamColor;

  // ── Logging ──
  el('ocCfgLoggingLevel').value = cfg.logging?.level || '';
  el('ocCfgLoggingStyle').value = cfg.logging?.consoleStyle || '';
  if (el('ocCfgDiagnosticsEnabled')) el('ocCfgDiagnosticsEnabled').checked = Boolean(cfg.diagnostics?.enabled);

  // ── Update ──
  if (el('ocCfgUpdateChannel')) el('ocCfgUpdateChannel').value = cfg.update?.channel || '';
  if (el('ocCfgUpdateCheckOnStart')) el('ocCfgUpdateCheckOnStart').checked = cfg.update?.checkOnStart !== false;
  if (el('ocCfgUpdateAutoEnabled')) el('ocCfgUpdateAutoEnabled').checked = Boolean(cfg.update?.auto?.enabled);

  // ── Raw JSON ──
  el('ocCfgRawJsonTextarea').value = state.openclawState?.configJson || JSON.stringify(cfg, null, 2);
  syncRawConfigHighlight();
  if (window.refreshCustomSelects) window.refreshCustomSelects();

  // Update panel badges
  updateOcPanelBadges(cfg);
}

/** Update panel status badges based on current config values. */
function updateOcPanelBadges(cfg) {
  const _b = (id, text, active) => {
    const badge = el(id);
    if (!badge) return;
    badge.textContent = text;
    badge.classList.toggle('active', active);
  };
  const _hasAccounts = (value) => Boolean(value && typeof value === 'object' && Object.keys(value).length);
  // Model
  const model = cfg.agents?.defaults?.model?.primary;
  _b('ocBadgeModel', model ? model.split('/').pop() : '未配置', Boolean(model));
  // Provider
  const hasProvider = Object.keys(cfg.models?.providers || {}).length > 0;
  _b('ocBadgeProvider', hasProvider ? '已配置' : '未配置', hasProvider);
  // Channels
  const chans = [];
  if (cfg.channels?.telegram?.botToken || _hasAccounts(cfg.channels?.telegram?.accounts)) chans.push('TG');
  if (cfg.channels?.discord?.token || _hasAccounts(cfg.channels?.discord?.accounts)) chans.push('DC');
  if (cfg.channels?.slack?.botToken || _hasAccounts(cfg.channels?.slack?.accounts)) chans.push('Slack');
  if (cfg.channels?.whatsapp) chans.push('WA');
  if (cfg.channels?.signal) chans.push('Signal');
  if (cfg.channels?.googlechat) chans.push('GC');
  if (cfg.channels?.imessage) chans.push('iMsg');
  if (cfg.channels?.irc) chans.push('IRC');
  if (cfg.channels?.msteams) chans.push('Teams');
  if (cfg.channels?.matrix) chans.push('Matrix');
  if (cfg.channels?.line) chans.push('LINE');
  if (cfg.channels?.wechat) chans.push('微信');
  if (cfg.channels?.wechatwork) chans.push('企微');
  _b('ocBadgeChannels', chans.length ? `${chans.join(' + ')}` : '未启用', chans.length > 0);
  _b('ocBadgeTelegram', (cfg.channels?.telegram?.botToken || _hasAccounts(cfg.channels?.telegram?.accounts)) ? '已配置' : '未配置', Boolean(cfg.channels?.telegram?.botToken || _hasAccounts(cfg.channels?.telegram?.accounts)));
  _b('ocBadgeDiscord', (cfg.channels?.discord?.token || _hasAccounts(cfg.channels?.discord?.accounts)) ? '已配置' : '未配置', Boolean(cfg.channels?.discord?.token || _hasAccounts(cfg.channels?.discord?.accounts)));
  _b('ocBadgeSlack', (cfg.channels?.slack?.botToken || _hasAccounts(cfg.channels?.slack?.accounts)) ? '已配置' : '未配置', Boolean(cfg.channels?.slack?.botToken || _hasAccounts(cfg.channels?.slack?.accounts)));
  _b('ocBadgeWhatsApp', cfg.channels?.whatsapp ? '已配置' : '未配置', Boolean(cfg.channels?.whatsapp));
  _b('ocBadgeSignal', cfg.channels?.signal ? '已配置' : '未配置', Boolean(cfg.channels?.signal));
  _b('ocBadgeGoogleChat', cfg.channels?.googlechat ? '已配置' : '未配置', Boolean(cfg.channels?.googlechat));
  _b('ocBadgeImessage', cfg.channels?.imessage ? '已配置' : '未配置', Boolean(cfg.channels?.imessage));
  _b('ocBadgeIrc', cfg.channels?.irc ? '已配置' : '未配置', Boolean(cfg.channels?.irc));
  _b('ocBadgeMSTeams', cfg.channels?.msteams ? '已配置' : '未配置', Boolean(cfg.channels?.msteams));
  _b('ocBadgeMatrix', cfg.channels?.matrix ? '已配置' : '未配置', Boolean(cfg.channels?.matrix));
  _b('ocBadgeLine', cfg.channels?.line ? '已配置' : '未配置', Boolean(cfg.channels?.line));
  _b('ocBadgeWechat', cfg.channels?.wechat ? '已配置' : '未配置', Boolean(cfg.channels?.wechat));
  _b('ocBadgeWechatWork', cfg.channels?.wechatwork ? '已配置' : '未配置', Boolean(cfg.channels?.wechatwork));
  // Agent
  const agentCustom = cfg.agents?.defaults?.maxConcurrent || cfg.agents?.defaults?.timeoutSeconds || cfg.agents?.defaults?.heartbeat;
  _b('ocBadgeAgent', agentCustom ? '已定制' : '默认', Boolean(agentCustom));
  // Tools
  const toolProfile = cfg.tools?.profile || 'full';
  _b('ocBadgeTools', toolProfile, toolProfile !== 'full');
  // Security
  const secCustom = cfg.commands?.bash || cfg.commands?.config || cfg.approvals?.enabled;
  _b('ocBadgeSecurity', secCustom ? '已定制' : '默认', Boolean(secCustom));
  // Session
  const sessCustom = cfg.session?.scope || cfg.session?.reset;
  _b('ocBadgeSession', sessCustom ? cfg.session?.scope || '定制' : '默认', Boolean(sessCustom));
  // Gateway
  const gwPort = cfg.gateway?.port || 18789;
  _b('ocBadgeGateway', `端口 ${gwPort}`, gwPort !== 18789);
  // Cron
  _b('ocBadgeCron', cfg.cron?.enabled ? '已启用' : '关闭', Boolean(cfg.cron?.enabled));
  // Identity
  const name = cfg.ui?.assistant?.name || 'OpenClaw';
  _b('ocBadgeIdentity', name, name !== 'OpenClaw');
  // Logging
  _b('ocBadgeLogging', cfg.logging?.level || 'info', Boolean(cfg.logging?.level));
  // Update
  _b('ocBadgeUpdate', cfg.update?.channel || 'stable', Boolean(cfg.update?.channel));
  // Extensions
  const extCustom = cfg.memory || cfg.skills || cfg.plugins || cfg.browser || cfg.web || cfg.secrets || cfg.nodeHost || cfg.discovery || cfg.canvasHost || cfg.talk || cfg.auth || cfg.acp || cfg.cli || cfg.bindings || cfg.broadcast || cfg.audio;
  _b('ocBadgeExtensions', extCustom ? '已配置' : '未配置', Boolean(extCustom));
}
function getActiveRecipesRaw() {
  const tool = getConfigEditorTool();
  if (tool === 'claudecode') return [];
  return getConfigStoreRecipesByTool(tool);
}

/**
 * Get the combined recipe list based on the active config editor tool.
 */
function getActiveRecipes() {
  return enrichConfigStoreRecipes(getActiveRecipesRaw(), getConfigEditorTool());
}

function getRecipeById(recipeId, tool = getConfigEditorTool()) {
  return enrichConfigStoreRecipes(getConfigStoreRecipesByTool(tool), tool)
    .find((recipe) => recipe.id === recipeId) || null;
}

/**
 * Search config recipes by keyword query.
 * Uses fuzzy matching: splits query into tokens and matches against kw + name + desc.
 */
function searchOcRecipes(query) {
  return searchConfigStoreRecipes(getActiveRecipesRaw(), query, getConfigEditorTool());
}

/** Render recipe search results into the dropdown. */
function renderOcRecipeResults(recipes) {
  const container = el('ocRecipeResults');
  if (!container) return;
  if (recipes.length === 0) {
    container.innerHTML = '<div class="oc-recipe-empty">没有匹配的配置方案</div>';
    return;
  }
  container.innerHTML = recipes.map(r => `
    <button type="button" class="oc-recipe-card" data-recipe-id="${r.id}">
      <div class="oc-recipe-card-main">
        <div class="oc-recipe-card-name">${r.name}<span class="oc-recipe-tag">${r.cat}</span></div>
        <div class="oc-recipe-card-desc">${r.desc}${r._reason?.length ? ` · ${escapeHtml(r._reason[0])}` : ''}</div>
      </div>
      <span class="oc-recipe-card-action">进入引导</span>
    </button>
  `).join('');
}

/** Apply a recipe config patch (deep merge onto current config). */
function applyOcRecipePatch(patch) {
  const tool = getConfigEditorTool();
  if (tool === 'codex') {
    // Apply Codex patch: set form fields directly
    applyCodexRecipePatch(patch);
    return;
  }
  const cfg = state.openclawState?.config || {};
  const merged = deepMergeOcConfig(structuredClone(cfg), patch);
  state.openclawState = state.openclawState || {};
  state.openclawState.config = merged;
  state.openclawState.configJson = JSON.stringify(merged, null, 2);
  populateOpenClawConfigEditor();
  flash('配置方案已应用', 'success');
}

/** Apply a Codex recipe patch by setting form field values. */
function applyCodexRecipePatch(patch) {
  const fieldMap = {
    model: 'cfgModelInput',
    model_provider: 'cfgProviderInput',
    service_tier: 'cfgServiceTierSelect',
    personality: 'cfgPersonalityInput',
    approval_policy: 'cfgApprovalSelect',
    sandbox_mode: 'cfgSandboxSelect',
    model_reasoning_effort: 'cfgReasoningSelect',
    plan_mode_reasoning_effort: 'cfgPlanReasoningSelect',
    model_context_window: 'cfgContextWindowInput',
    model_auto_compact_token_limit: 'cfgCompactLimitInput',
    tool_output_token_limit: 'cfgToolLimitInput',
    hide_agent_reasoning: 'cfgHideReasoningCheck',
    show_raw_agent_reasoning: 'cfgShowRawReasoningCheck',
    disable_response_storage: 'cfgDisableStorageCheck',
    compact_prompt: 'cfgCompactPromptCheck',
    check_for_update_on_startup: 'cfgUpdateCheck',
  };
  for (const [key, value] of Object.entries(patch)) {
    const elId = fieldMap[key];
    if (!elId) continue;
    const field = el(elId);
    if (!field) continue;
    if (field.type === 'checkbox') {
      field.checked = key === 'compact_prompt' ? compactPromptEnabled(value) : Boolean(value);
    } else {
      field.value = value === null || value === undefined ? '' : String(value);
    }
  }
  // Sync number fields
  refreshConfigNumberFields();
  syncShortcutActiveState();
  flash('配置方案已应用', 'success');
}

/** Deep merge two config objects (right wins). */
function deepMergeOcConfig(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      deepMergeOcConfig(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

/** Open the recipe form modal for recipes that need user input. */
function openOcRecipeForm(recipe) {
  openConfigStoreGuide(recipe);
}

/** Close the recipe form modal. */
function closeOcRecipeForm() {
  closeConfigStoreGuide();
}

/** Collect recipe form values and apply. */
function submitOcRecipeForm() {
  applyConfigStoreGuide();
}

/* ═══════ Config Store Modal ═══════ */

let _configStoreActiveCat = 'all';

/** Get recipes for config store based on active config editor tool tab. */
function getConfigStoreRecipes() {
  return getActiveRecipes();
}

function renderConfigStoreSuggestions(query = '') {
  const container = el('configStoreSuggestions');
  if (!container) return;
  const suggestions = getConfigStoreSuggestionChips(getActiveRecipesRaw(), getConfigEditorTool(), query);
  container.innerHTML = suggestions.map((item) => `<button type="button" class="config-store-suggestion-chip" data-store-suggestion="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('');
}

function renderConfigStoreAssistantResult(payload = null) {
  const container = el('configStoreAssistantResult');
  if (!container) return;
  if (!payload) {
    container.textContent = '输入一句你的目标，我会推荐场景并告诉你下一步要填什么。';
    return;
  }
  if (payload.mode === 'no_match') {
    container.innerHTML = `
      <div class="config-store-assistant-recipe">还没找到特别合适的场景</div>
      <div>${escapeHtml(payload.message || '')}</div>
      <div class="config-store-assistant-actions">
        ${(payload.suggestions || []).map((item) => `<button type="button" class="secondary tiny-btn" data-store-suggestion="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('')}
      </div>
    `;
    return;
  }
  const missing = (payload.missing || []).map((field) => field.label).join('、');
  container.innerHTML = `
    <div class="config-store-assistant-recipe">推荐场景：${escapeHtml(payload.recipe.name)}</div>
    <div>${escapeHtml(payload.recipe.desc)}</div>
    ${payload.reason?.length ? `<div class="config-store-assistant-sub">匹配原因：${escapeHtml(payload.reason.join(' / '))}</div>` : ''}
    <div class="config-store-assistant-sub">下一步：${escapeHtml(payload.nextQuestion || '')}${missing ? `（待填：${escapeHtml(missing)}）` : ''}</div>
    <div class="config-store-assistant-actions">
      <button type="button" class="secondary tiny-btn" data-store-assistant-open="${escapeHtml(payload.recipe.id)}">进入引导</button>
      ${(payload.alternatives || []).map((item) => `<button type="button" class="secondary tiny-btn" data-store-assistant-open="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button>`).join('')}
    </div>
  `;
}

function runCurrentConfigStoreAssistant() {
  const query = el('configStoreAssistantInput')?.value || '';
  const payload = runConfigStoreAssistant(getActiveRecipesRaw(), query, getConfigEditorTool(), state.configStoreAssistant);
  state.configStoreAssistant = payload.mode === 'matched'
    ? { recipeId: payload.recipe.id, values: payload.values || {}, missing: payload.missing || [] }
    : { recipeId: '', values: {}, missing: [] };
  renderConfigStoreAssistantResult(payload);
}

/** Open the config store modal. */
function openConfigStore() {
  const modal = el('configStoreModal');
  if (!modal) return;

  const tool = getConfigEditorTool();
  if (tool === 'claudecode') {
    flash('Claude Code 配置商店即将支持，先用上方表单或右侧 settings.json 编辑。', 'info');
    return;
  }
  const toolNames = { codex: 'Codex', claudecode: 'Claude Code', opencode: 'OpenCode', openclaw: 'OpenClaw' };
  const badge = el('configStoreToolBadge');
  if (badge) badge.textContent = toolNames[tool] || tool;

  const searchInput = el('configStoreSearchInput');
  if (searchInput) {
    searchInput.value = '';
    if (tool === 'openclaw') {
      searchInput.placeholder = '搜索配置方案...如 Telegram、安全、代理、渠道';
    } else {
      searchInput.placeholder = '搜索配置方案...如 模型、推理、沙箱、上下文';
    }
  }

  const assistantInput = el('configStoreAssistantInput');
  if (assistantInput) assistantInput.value = '';
  state.configStoreAssistant = { recipeId: '', values: {}, missing: [] };
  renderConfigStoreAssistantResult(null);

  _configStoreActiveCat = 'all';
  renderConfigStoreCategories();
  renderConfigStoreCards();
  renderConfigStoreSuggestions('');

  modal.classList.remove('hide');
  setTimeout(() => searchInput?.focus(), 100);
}

/** Close the config store modal. */
function closeConfigStore() {
  const modal = el('configStoreModal');
  if (modal) modal.classList.add('hide');
}

/** Render category filter tabs. */
function renderConfigStoreCategories() {
  const container = el('configStoreCategories');
  if (!container) return;
  const recipes = getConfigStoreRecipes();
  const cats = [...new Set(recipes.map(r => r.cat))];
  const allHTML = `<button class="config-store-cat-btn ${_configStoreActiveCat === 'all' ? 'active' : ''}" data-store-cat="all">全部</button>`;
  const catBtns = cats.map(c =>
    `<button class="config-store-cat-btn ${_configStoreActiveCat === c ? 'active' : ''}" data-store-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`
  ).join('');
  container.innerHTML = allHTML + catBtns;
}

/** Render config store cards based on search and category filter. */
function renderConfigStoreCards() {
  const grid = el('configStoreGrid');
  const empty = el('configStoreEmpty');
  if (!grid) return;

  const query = el('configStoreSearchInput')?.value || '';
  let recipes = getConfigStoreRecipes();

  // Filter by category
  if (_configStoreActiveCat && _configStoreActiveCat !== 'all') {
    recipes = recipes.filter(r => r.cat === _configStoreActiveCat);
  }

  // Filter by search query (fuzzy match)
  recipes = query.trim()
    ? searchConfigStoreRecipes(recipes, query, getConfigEditorTool())
    : recipes;

  if (recipes.length === 0) {
    grid.innerHTML = '';
    if (empty) empty.classList.remove('hide');
    return;
  }

  if (empty) empty.classList.add('hide');

  renderConfigStoreSuggestions(query);

  grid.innerHTML = recipes.map(r => `
    <button type="button" class="cs-card" data-store-recipe-id="${r.id}">
      <span class="cs-card-tag" data-cat="${escapeHtml(r.cat)}">${escapeHtml(r.cat)}</span>
      <div class="cs-card-name">${escapeHtml(r.name)}</div>
      <div class="cs-card-desc">${escapeHtml(r.desc)}</div>
      ${r._reason?.length ? `<div class="config-store-assistant-sub">${escapeHtml(r._reason[0])}</div>` : ''}
      <span class="cs-card-action">进入引导 →</span>
    </button>
  `).join('');
}

function collectConfigStoreGuideValues(recipe) {
  const values = {};
  (recipe.guide.questions || []).forEach((field, index) => {
    values[field.key] = String(el(`configStoreGuideField_${index}`)?.value || '').trim();
  });
  return values;
}

function normalizeGuidePath(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function getConfigStoreGuideRuntime(values = {}) {
  const gatewayPort = state.openclawState?.gatewayPort || state.openclawState?.config?.gateway?.port || 18789;
  const gatewayUrl = state.openclawState?.gatewayUrl || `http://127.0.0.1:${gatewayPort}/`;
  const publicBaseUrl = 'https://你的域名';
  const webhookPath = normalizeGuidePath(values.path || '/webhook/my-channel');
  return {
    gatewayUrl,
    lanDashboardUrl: `http://你的局域网IP:${gatewayPort}/`,
    publicBaseUrl,
    publicWechatMpCallbackUrl: `${publicBaseUrl}/wechat/mp`,
    publicWecomCallbackUrl: `${publicBaseUrl}/wecom/callback`,
    publicWebhookUrl: `${publicBaseUrl}${webhookPath}`,
  };
}

function renderConfigStoreGuideText(text, values = {}) {
  const runtime = getConfigStoreGuideRuntime(values);
  const interpolated = String(text || '').replace(/\{\{(\w+)\}\}/g, (_, key) => runtime[key] || '');
  return escapeHtml(interpolated)
    .replace(/`([^`]+)`/g, '<code class="config-store-guide-code">$1</code>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<code class="config-store-guide-code">$1</code>');
}

function renderConfigStoreGuideList(items = [], values = {}) {
  return items.map((item) => `<li>${renderConfigStoreGuideText(item, values)}</li>`).join('');
}

function renderConfigStoreGuide(recipe, values = {}) {
  if (!recipe) return;
  el('configStoreGuideTitle').textContent = recipe.name;
  el('configStoreGuideDesc').textContent = recipe.guide.overview || recipe.desc;
  el('configStoreGuidePrep').innerHTML = renderConfigStoreGuideList(recipe.guide.prep || [], values);
  el('configStoreGuideAccess').innerHTML = renderConfigStoreGuideList(
    recipe.guide.access?.length ? recipe.guide.access : (getConfigEditorTool() === 'openclaw' ? ['本地 Dashboard：{{gatewayUrl}}'] : []),
    values,
  );
  el('configStoreGuideSteps').innerHTML = renderConfigStoreGuideList(recipe.guide.tutorial || [], values);
  el('configStoreGuideVerify').innerHTML = renderConfigStoreGuideList(recipe.guide.verify || [], values);
  const related = (recipe.guide.related || []).length
    ? recipe.guide.related.map((item) => `<button type="button" class="secondary tiny-btn" data-store-suggestion="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('')
    : (recipe.guide.examples || []).slice(0, 4).map((item) => `<button type="button" class="secondary tiny-btn" data-store-suggestion="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('');
  el('configStoreGuideRelated').innerHTML = related;

  const questions = recipe.guide.questions || [];
  el('configStoreGuideFields').innerHTML = questions.length
    ? questions.map((field, index) => `
      <label class="field config-store-guide-field"><div class="config-store-guide-field-head"><div class="config-store-guide-field-title">${escapeHtml(field.label)}</div><em class="config-store-guide-field-badge ${field.required ? 'required' : 'optional'}">${field.required ? '必填' : '可选'}</em></div>
        <input id="configStoreGuideField_${index}" type="${escapeHtml(field.type || 'text')}" placeholder="${escapeHtml(field.placeholder || '')}" value="${escapeHtml(values[field.key] || '')}" />
        ${field.help ? `<div class="config-store-guide-field-help">${renderConfigStoreGuideText(field.help, values)}</div>` : ''}
      </label>
    `).join('')
    : '<div class="config-store-assistant-sub">该方案无需额外输入，确认后即可应用。</div>';

  const missing = questions.filter((field) => field.required && !String(values[field.key] || '').trim());
  let preview = {};
  if (!missing.length) {
    try {
      preview = recipe.apply(values);
    } catch {
      preview = {};
    }
  }
  el('configStoreGuideDiff').innerHTML = missing.length
    ? escapeHtml(`请先填写：${missing.map((field) => field.label).join('、')}`)
    : colorizeJson(JSON.stringify(preview, null, 2));
}

function openConfigStoreGuide(recipe, presetValues = {}) {
  const modal = el('configStoreGuideModal');
  if (!modal || !recipe) return;
  state.configStoreGuide = { recipeId: recipe.id, values: { ...presetValues } };
  renderConfigStoreGuide(recipe, state.configStoreGuide.values);
  modal.classList.remove('hide');
  setTimeout(() => el('configStoreGuideField_0')?.focus(), 50);
}

function closeConfigStoreGuide() {
  el('configStoreGuideModal')?.classList.add('hide');
  state.configStoreGuide = { recipeId: '', values: {} };
}

function applyConfigStoreGuide() {
  const recipe = getRecipeById(state.configStoreGuide.recipeId);
  if (!recipe) return;
  const values = collectConfigStoreGuideValues(recipe);
  const missing = (recipe.guide.questions || []).filter((field) => field.required && !String(values[field.key] || '').trim());
  if (missing.length) {
    flash(`请填写: ${missing.map((field) => field.label).join(', ')}`, 'error');
    renderConfigStoreGuide(recipe, values);
    return;
  }
  const patch = recipe.apply(values);
  applyOcRecipePatch(patch);
  closeConfigStoreGuide();
  closeConfigStore();
}

/* ═══════ Recipe Confirm Modal ═══════ */

let _pendingRecipeConfirm = null;

/** Colorize JSON for diff display. */
function colorizeJson(str) {
  return escapeHtml(str)
    .replace(/&quot;([^&]*?)&quot;(?=\s*:)/g, '<span class="diff-key">"$1"</span>')
    .replace(/:\s*&quot;([^&]*)&quot;/g, ': <span class="diff-str">"$1"</span>')
    .replace(/:\s*(\d+(?:\.\d+)?)/g, ': <span class="diff-num">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="diff-bool">$1</span>');
}

/** Show recipe confirmation with config diff. */
function openRecipeConfirm(recipe) {
  const modal = el('recipeConfirmModal');
  if (!modal) return;
  _pendingRecipeConfirm = recipe;
  el('recipeConfirmName').textContent = recipe.name;
  el('recipeConfirmDesc').textContent = recipe.desc;
  const patch = recipe.apply();
  const json = JSON.stringify(patch, null, 2);
  el('recipeConfirmDiff').innerHTML = colorizeJson(json);
  modal.classList.remove('hide');
}

/** Close confirm modal. */
function closeRecipeConfirm() {
  el('recipeConfirmModal')?.classList.add('hide');
  _pendingRecipeConfirm = null;
}

/** Execute confirmed recipe. */
function executeRecipeConfirm() {
  const recipe = _pendingRecipeConfirm;
  if (!recipe) return;
  const patch = recipe.apply();
  applyOcRecipePatch(patch);
  closeRecipeConfirm();
  closeConfigStore();
}

/** Dispatch config validation based on active tool. */
function validateCurrentConfig() {
  const tool = getConfigEditorTool();
  if (tool === 'openclaw') {
    validateOpenClawConfig();
  } else if (tool === 'claudecode') {
    validateClaudeCodeConfig();
  } else {
    validateCodexConfig();
  }
}

/** Validate the current Codex configuration. */
function validateCodexConfig() {
  const btn = el('validateConfigBtn');
  if (!btn) return;
  btn.classList.remove('ok', 'err');
  const errors = [];
  const warnings = [];

  try {
    // Check raw TOML syntax
    const tomlEl = el('cfgRawTomlTextarea');
    if (tomlEl?.value?.trim()) {
      // Basic TOML structure validation
      const tomlText = tomlEl.value;
      // Check for unmatched brackets
      const openBrackets = (tomlText.match(/\[/g) || []).length;
      const closeBrackets = (tomlText.match(/\]/g) || []).length;
      if (openBrackets !== closeBrackets) {
        errors.push('TOML 语法错误: 方括号不匹配');
      }
      // Check for lines with = but no key
      const lines = tomlText.split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('=')) {
          errors.push(`TOML 第 ${i + 1} 行: 缺少键名`);
        }
        // Check for unclosed quotes
        if (trimmed.includes('=')) {
          const afterEq = trimmed.split('=').slice(1).join('=').trim();
          if ((afterEq.startsWith('"') && !afterEq.endsWith('"') && !afterEq.includes('#')) ||
              (afterEq.startsWith("'") && !afterEq.endsWith("'") && !afterEq.includes('#'))) {
            // Multi-line strings are valid in TOML, so just warn
            warnings.push(`TOML 第 ${i + 1} 行: 引号可能未闭合`);
          }
        }
      });
    }

    // Check model field
    const model = el('cfgModelInput')?.value?.trim();
    if (!model) {
      warnings.push('未设置默认模型 (将使用 Codex 内置默认值)');
    }

    // Check context window
    const ctxWindow = el('cfgContextWindowInput')?.value?.trim();
    if (ctxWindow) {
      const ctxNum = Number(ctxWindow);
      if (isNaN(ctxNum) || ctxNum < 1000) {
        errors.push(`上下文窗口值 "${ctxWindow}" 无效 (最小 1000)`);
      } else {
        const modelCap = getCodexSelectedModelContextCap();
        if (modelCap && ctxNum > modelCap) {
          errors.push(`上下文窗口 ${ctxNum} 超过所选模型上限 ${modelCap}`);
        } else if (!modelCap && ctxNum > 2097152) {
          warnings.push(`上下文窗口 ${ctxNum} 非常大，可能超出模型支持范围`);
        }
      }
    }

    // Check compact limit vs Codex auto-compact bound (context * 90%)
    const compactLimit = el('cfgCompactLimitInput')?.value?.trim();
    if (compactLimit) {
      const compactNum = Number(compactLimit);
      const fallbackContext = getCodexContextWindowForUi();
      const ctxNum = Number(ctxWindow || fallbackContext);
      const compactCap = calcCodexAutoCompactCap(ctxNum);
      if (compactNum > compactCap) {
        errors.push(`自动压缩阈值 (${compactNum}) 超过 Codex 上限 (${compactCap} = 上下文90%)`);
      } else if (compactNum >= Math.round(compactCap * 0.95)) {
        warnings.push(`自动压缩阈值 (${compactNum}) 已非常接近上限 (${compactCap})，建议再留余量`);
      }
    }

    // Check conflicting reasoning settings
    const hideReasoning = el('cfgHideReasoningCheck')?.checked;
    const showRawReasoning = el('cfgShowRawReasoningCheck')?.checked;
    if (hideReasoning && showRawReasoning) {
      warnings.push('同时隐藏推理又显示原始推理，两者冲突');
    }

    // Check sqlite home path
    const sqliteHome = el('cfgSqliteHomeInput')?.value?.trim();
    if (sqliteHome && !sqliteHome.startsWith('/') && !sqliteHome.startsWith('~')) {
      warnings.push('SQLite 目录路径建议使用绝对路径');
    }

  } catch (e) {
    errors.push(`配置校验出错: ${e.message}`);
  }

  if (errors.length) {
    btn.classList.add('err');
    flash(`❌ 配置有 ${errors.length} 个错误: ${errors[0]}`, 'error');
  } else if (warnings.length) {
    btn.classList.add('ok');
    flash(`⚠️ 配置基本正确，${warnings.length} 个建议: ${warnings[0]}`, 'warning');
  } else {
    btn.classList.add('ok');
    flash('✅ Codex 配置验证通过', 'success');
  }
  setTimeout(() => btn.classList.remove('ok', 'err'), 3000);
}

/** Validate the current OpenClaw configuration. */
function validateOpenClawConfig() {
  const btn = el('validateConfigBtn');
  if (!btn) return;
  btn.classList.remove('ok', 'err');
  const errors = [];
  const warnings = [];

  try {
    // Build config from form
    const cfg = buildOpenClawConfigFromForm();

    // Check model
    if (!cfg.agents?.defaults?.model?.primary) {
      warnings.push('未设置主模型');
    }

    // Check provider
    const providerNames = Object.keys(cfg.models?.providers || {});
    if (providerNames.length === 0) {
      warnings.push('未配置任何 Provider');
    } else {
      providerNames.forEach(name => {
        const p = cfg.models.providers[name];
        if (!p.baseUrl) errors.push(`Provider "${name}" 缺少 baseUrl`);
        if (!p.api) errors.push(`Provider "${name}" 缺少 api 协议`);
      });
    }

    // Check channel tokens
    if (cfg.channels?.telegram && !cfg.channels.telegram.botToken) {
      errors.push('Telegram 配置存在但缺少 botToken');
    }
    if (cfg.channels?.discord && !cfg.channels.discord.token) {
      errors.push('Discord 配置存在但缺少 token');
    }

    // Check gateway port
    const port = cfg.gateway?.port;
    if (port && (port < 1 || port > 65535)) {
      errors.push(`Gateway 端口 ${port} 超出有效范围 (1-65535)`);
    }

    // Check raw JSON parse
    const rawEl = el('ocCfgRawJsonTextarea');
    if (rawEl?.value?.trim()) {
      try { JSON.parse(rawEl.value); } catch { errors.push('原始 JSON 语法错误'); }
    }
  } catch (e) {
    errors.push(`配置构建出错: ${e.message}`);
  }

  if (errors.length) {
    btn.classList.add('err');
    flash(`❌ 配置有 ${errors.length} 个错误: ${errors[0]}`, 'error');
  } else if (warnings.length) {
    btn.classList.add('ok');
    flash(`⚠️ 配置基本正确，${warnings.length} 个建议: ${warnings[0]}`, 'warning');
  } else {
    btn.classList.add('ok');
    flash('✅ OpenClaw 配置验证通过', 'success');
  }
  setTimeout(() => btn.classList.remove('ok', 'err'), 3000);
}

/** Validate the current Claude Code configuration. */
function validateClaudeCodeConfig() {
  const btn = el('validateConfigBtn');
  if (!btn) return;
  btn.classList.remove('ok', 'err');
  const errors = [];
  const warnings = [];

  try {
    const model = readClaudeModelControl('ccCfgModelSelect', 'ccCfgModelCustom');
    if (model && !/^[a-zA-Z0-9._/\-]+$/.test(model)) {
      warnings.push('模型名称包含非常规字符，建议仅使用字母、数字、-、_、/、.');
    }
    const providerKeyRaw = el('ccCfgProviderKeyInput')?.value?.trim() || '';
    if (providerKeyRaw) {
      const normalizedKey = normalizeProviderKey(providerKeyRaw);
      if (!normalizedKey) {
        errors.push('Provider Key 无效，请使用字母、数字、- 或 _');
      } else if (normalizedKey !== providerKeyRaw) {
        warnings.push(`Provider Key 将规范化为 ${normalizedKey}`);
      }
    }
    const baseUrl = el('ccCfgBaseUrlInput')?.value?.trim() || '';
    if (baseUrl) {
      try {
        const parsed = new URL(baseUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          errors.push('Base URL 仅支持 http/https');
        }
      } catch {
        errors.push('Base URL 格式无效');
      }
    }

    const rawText = el('ccCfgRawJsonTextarea')?.value?.trim() || '';
    if (rawText) {
      try {
        JSON.parse(rawText);
      } catch {
        errors.push('settings.json 存在 JSON 语法错误');
      }
    }
  } catch (e) {
    errors.push(`配置校验出错: ${e.message}`);
  }

  if (errors.length) {
    btn.classList.add('err');
    flash(`❌ 配置有 ${errors.length} 个错误: ${errors[0]}`, 'error');
  } else if (warnings.length) {
    btn.classList.add('ok');
    flash(`⚠️ 配置基本正确，${warnings.length} 个建议: ${warnings[0]}`, 'warning');
  } else {
    btn.classList.add('ok');
    flash('✅ Claude Code 配置验证通过', 'success');
  }
  setTimeout(() => btn.classList.remove('ok', 'err'), 3000);
}

/** Build an OpenClaw config object from the form fields (merged onto existing config). */
function buildOpenClawConfigFromForm() {
  const base = structuredClone(state.openclawState?.config || {});
  const quick = deriveOpenClawQuickConfig(state.openclawState || {});

  // Model
  if (!base.agents) base.agents = {};
  if (!base.agents.defaults) base.agents.defaults = {};
  const primaryInput = el('ocCfgModelPrimary').value.trim();
  const fallbacksRaw = el('ocCfgModelFallbacks').value.trim();
  const fallbacks = fallbacksRaw ? fallbacksRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const providerApi = el('ocCfgProviderApi').value || quick.api || inferOpenClawApiMode(primaryInput);
  const desiredModelRef = primaryInput || quick.model || getOpenClawDefaultModel(providerApi);
  const providerAliasInput = el('ocCfgProviderAlias').value.trim();
  const providerAlias = providerAliasInput || quick.providerAlias || String(desiredModelRef).split('/')[0] || inferOpenClawProviderFromEnvKey(quick.envKey, providerApi);
  const providerModelId = extractOpenClawCustomModelId(desiredModelRef) || desiredModelRef;
  const normalizedPrimary = providerAlias ? `${providerAlias}/${providerModelId}` : desiredModelRef;
  if (normalizedPrimary || fallbacks.length) {
    base.agents.defaults.model = {};
    if (normalizedPrimary) base.agents.defaults.model.primary = normalizedPrimary;
    if (fallbacks.length) base.agents.defaults.model.fallbacks = fallbacks;
  } else {
    delete base.agents.defaults.model;
  }
  const thinking = el('ocCfgThinkingDefault').value;
  if (thinking) { base.agents.defaults.thinkingDefault = thinking; } else { delete base.agents.defaults.thinkingDefault; }
  const workspace = el('ocCfgWorkspace').value.trim();
  if (workspace) { base.agents.defaults.workspace = workspace; } else { delete base.agents.defaults.workspace; }
  // New model fields
  const imageModel = el('ocCfgImageModel')?.value?.trim();
  if (imageModel) { base.agents.defaults.imageModel = imageModel; } else { delete base.agents.defaults.imageModel; }
  const ctxTokens = el('ocCfgContextTokens')?.value?.trim();
  if (ctxTokens) { base.agents.defaults.contextTokens = Number(ctxTokens) || undefined; } else { delete base.agents.defaults.contextTokens; }

  // Agent & Reply defaults
  const _sv = (elId) => (el(elId)?.value || '').trim();
  const _csvArr = (elId) => (_sv(elId) ? _sv(elId).split(',').map(s => s.trim()).filter(Boolean) : []);
  const _boolSelect = (elId) => { const v = _sv(elId); return v === 'true' ? true : v === 'false' ? false : undefined; };

  const maxConc = _sv('ocCfgMaxConcurrent');
  if (maxConc) { base.agents.defaults.maxConcurrent = Number(maxConc); } else { delete base.agents.defaults.maxConcurrent; }
  const timeoutSec = _sv('ocCfgTimeoutSeconds');
  if (timeoutSec) { base.agents.defaults.timeoutSeconds = Number(timeoutSec); } else { delete base.agents.defaults.timeoutSeconds; }
  const verbose = _sv('ocCfgVerboseDefault');
  if (verbose) { base.agents.defaults.verboseDefault = verbose; } else { delete base.agents.defaults.verboseDefault; }
  const elevated = _sv('ocCfgElevatedDefault');
  if (elevated) { base.agents.defaults.elevatedDefault = elevated; } else { delete base.agents.defaults.elevatedDefault; }
  const blockStream = _sv('ocCfgBlockStreamingDefault');
  if (blockStream) { base.agents.defaults.blockStreamingDefault = blockStream; } else { delete base.agents.defaults.blockStreamingDefault; }
  const typingMode = _sv('ocCfgTypingMode');
  if (typingMode) { base.agents.defaults.typingMode = typingMode; } else { delete base.agents.defaults.typingMode; }
  const humanDelay = _sv('ocCfgHumanDelay');
  if (humanDelay) { base.agents.defaults.humanDelay = humanDelay; } else { delete base.agents.defaults.humanDelay; }

  // Heartbeat
  const hbEvery = _sv('ocCfgHeartbeatEvery');
  const hbTarget = _sv('ocCfgHeartbeatTarget');
  const hbModel = _sv('ocCfgHeartbeatModel');
  const hbLight = el('ocCfgHeartbeatLightContext')?.checked;
  if (hbEvery || hbTarget || hbModel || hbLight) {
    if (!base.agents.defaults.heartbeat) base.agents.defaults.heartbeat = {};
    if (hbEvery) base.agents.defaults.heartbeat.every = hbEvery; else delete base.agents.defaults.heartbeat.every;
    if (hbTarget) base.agents.defaults.heartbeat.target = hbTarget; else delete base.agents.defaults.heartbeat.target;
    if (hbModel) base.agents.defaults.heartbeat.model = hbModel; else delete base.agents.defaults.heartbeat.model;
    if (hbLight) base.agents.defaults.heartbeat.lightContext = true; else delete base.agents.defaults.heartbeat.lightContext;
    if (Object.keys(base.agents.defaults.heartbeat).length === 0) delete base.agents.defaults.heartbeat;
  } else {
    delete base.agents.defaults.heartbeat;
  }

  // Response prefix
  const respPrefix = _sv('ocCfgResponsePrefix');
  if (respPrefix) { if (!base.messages) base.messages = {}; base.messages.responsePrefix = respPrefix; }
  else if (base.messages) { delete base.messages.responsePrefix; if (Object.keys(base.messages).length === 0) delete base.messages; }

  if (Object.keys(base.agents.defaults).length === 0) delete base.agents.defaults;
  if (Object.keys(base.agents).length === 0) delete base.agents;

  // Provider quick adapter
  if (!base.models) base.models = {};
  if (!base.models.providers) base.models.providers = {};
  if (!base.env) base.env = {};
  const providerBaseUrlInput = el('ocCfgProviderBaseUrl').value.trim();
  const providerBaseUrl = normalizeOpenClawBaseUrl(providerBaseUrlInput || getOpenClawDefaultBaseUrl(providerApi), desiredModelRef, providerApi);
  const providerApiKey = el('ocCfgProviderApiKey').value.trim();
  const providerEnvKeyInput = extractOpenClawEnvRef(el('ocCfgProviderEnvKey').value) || String(el('ocCfgProviderEnvKey').value || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const providerModelName = el('ocCfgProviderModelName').value.trim() || inferOpenClawModelName(desiredModelRef);
  const providerContextWindow = el('ocCfgProviderContextWindow').value.trim();
  const providerMaxTokens = el('ocCfgProviderMaxTokens').value.trim();
  const existingProviderConfig = cloneJson(base.models.providers[providerAlias] || {});
  const previousEnvKey = quick.envKey || resolveOpenClawProviderEnvKey(existingProviderConfig, desiredModelRef, providerApi) || getOpenClawDefaultEnvKey(providerApi);
  const envKey = providerEnvKeyInput || previousEnvKey;
  if (providerApiKey) {
    base.env[envKey] = providerApiKey;
  } else if (envKey && previousEnvKey && envKey !== previousEnvKey && base.env[previousEnvKey] && !base.env[envKey]) {
    base.env[envKey] = base.env[previousEnvKey];
  }
  const existingApiKey = quick.apiKey || base.env[envKey] || base.env[previousEnvKey] || '';
  const previousAlias = quick.providerAlias || String(quick.storedModel || '').split('/')[0] || '';
  if (previousAlias && previousAlias !== providerAlias && base.models.providers[previousAlias]?.baseUrl) {
    delete base.models.providers[previousAlias];
  }
  base.models.mode = base.models.mode || 'merge';
  const providerPayload = {
    ...existingProviderConfig,
    baseUrl: providerBaseUrl,
    api: providerApi,
    models: [
      buildOpenClawModelDefinition({
        modelRef: desiredModelRef,
        apiMode: providerApi,
        modelName: providerModelName,
        contextWindow: providerContextWindow,
        maxTokens: providerMaxTokens,
      }),
    ],
  };
  if (providerApiKey || existingApiKey) {
    providerPayload.apiKey = `$${envKey}`;
  } else {
    delete providerPayload.apiKey;
  }
  base.models.providers[providerAlias] = providerPayload;

  // ── Channels ──
  const tgToken = el('ocCfgTelegramToken').value.trim();
  if (tgToken) {
    if (!base.channels) base.channels = {};
    if (!base.channels.telegram) base.channels.telegram = {};
    base.channels.telegram.botToken = tgToken;
    // Telegram extended
    const tgDm = _sv('ocCfgTgDmPolicy'); if (tgDm) base.channels.telegram.dmPolicy = tgDm; else delete base.channels.telegram.dmPolicy;
    const tgGp = _sv('ocCfgTgGroupPolicy'); if (tgGp) base.channels.telegram.groupPolicy = tgGp; else delete base.channels.telegram.groupPolicy;
    const tgAllow = _csvArr('ocCfgTgAllowFrom'); if (tgAllow.length) base.channels.telegram.allowFrom = tgAllow; else delete base.channels.telegram.allowFrom;
    const tgStream = _sv('ocCfgTgStreaming'); if (tgStream) base.channels.telegram.streaming = tgStream; else delete base.channels.telegram.streaming;
    const tgReact = _sv('ocCfgTgReactionLevel'); if (tgReact) base.channels.telegram.reactionLevel = tgReact; else delete base.channels.telegram.reactionLevel;
    const tgHist = _sv('ocCfgTgHistoryLimit'); if (tgHist) base.channels.telegram.historyLimit = Number(tgHist); else delete base.channels.telegram.historyLimit;
    const tgChunk = _sv('ocCfgTgTextChunkLimit'); if (tgChunk) base.channels.telegram.textChunkLimit = Number(tgChunk); else delete base.channels.telegram.textChunkLimit;
    if (el('ocCfgTgBlockStreaming')?.checked) base.channels.telegram.blockStreaming = true; else delete base.channels.telegram.blockStreaming;
    if (el('ocCfgTgLinkPreview') && !el('ocCfgTgLinkPreview').checked) base.channels.telegram.linkPreview = false; else delete base.channels.telegram.linkPreview;
  }
  const tgConfig = cloneJson(readJsonFragmentInput('ocCfgTelegramJson', 'Telegram') || base.channels?.telegram || {});
  setDeepConfigValue(tgConfig, 'botToken', el('ocCfgTelegramToken').value.trim() || null);
  setDeepConfigValue(tgConfig, 'dmPolicy', _sv('ocCfgTgDmPolicy'));
  setDeepConfigValue(tgConfig, 'groupPolicy', _sv('ocCfgTgGroupPolicy'));
  setDeepConfigValue(tgConfig, 'allowFrom', _csvArr('ocCfgTgAllowFrom'));
  setDeepConfigValue(tgConfig, 'streaming', _sv('ocCfgTgStreaming'));
  setDeepConfigValue(tgConfig, 'reactionLevel', _sv('ocCfgTgReactionLevel'));
  setDeepConfigValue(tgConfig, 'historyLimit', _sv('ocCfgTgHistoryLimit') ? Number(_sv('ocCfgTgHistoryLimit')) : null);
  setDeepConfigValue(tgConfig, 'textChunkLimit', _sv('ocCfgTgTextChunkLimit') ? Number(_sv('ocCfgTgTextChunkLimit')) : null);
  setDeepConfigValue(tgConfig, 'blockStreaming', el('ocCfgTgBlockStreaming')?.checked ? true : null);
  setDeepConfigValue(tgConfig, 'linkPreview', el('ocCfgTgLinkPreview')?.checked === false ? false : null);
  setDeepConfigValue(tgConfig, 'defaultAccount', _sv('ocCfgTgDefaultAccount'));
  setDeepConfigValue(tgConfig, 'defaultTo', _sv('ocCfgTgDefaultTo'));
  setDeepConfigValue(tgConfig, 'groupAllowFrom', _csvArr('ocCfgTgGroupAllowFrom'));
  setDeepConfigValue(tgConfig, 'dmHistoryLimit', _sv('ocCfgTgDmHistoryLimit') ? Number(_sv('ocCfgTgDmHistoryLimit')) : null);
  setDeepConfigValue(tgConfig, 'chunkMode', _sv('ocCfgTgChunkMode'));
  setDeepConfigValue(tgConfig, 'reactionNotifications', _sv('ocCfgTgReactionNotifications'));
  setDeepConfigValue(tgConfig, 'replyToMode', _sv('ocCfgTgReplyToMode'));
  setDeepConfigValue(tgConfig, 'webhookPort', _sv('ocCfgTgWebhookPort') ? Number(_sv('ocCfgTgWebhookPort')) : null);
  setDeepConfigValue(tgConfig, 'webhookPath', _sv('ocCfgTgWebhookPath'));
  setDeepConfigValue(tgConfig, 'responsePrefix', _sv('ocCfgTgResponsePrefix'));
  setDeepConfigValue(tgConfig, 'ackReaction', _sv('ocCfgTgAckReaction'));
  setDeepConfigValue(base, 'channels.telegram', tgConfig);

  const dcToken = el('ocCfgDiscordToken').value.trim();
  if (dcToken) {
    if (!base.channels) base.channels = {};
    if (!base.channels.discord) base.channels.discord = {};
    base.channels.discord.token = dcToken;
    // Discord extended
    const dcDm = _sv('ocCfgDcDmPolicy');
    const dcAllow = _csvArr('ocCfgDcAllowFrom');
    if (dcDm || dcAllow.length) {
      if (!base.channels.discord.dm) base.channels.discord.dm = {};
      if (dcDm) base.channels.discord.dm.policy = dcDm; else delete base.channels.discord.dm.policy;
      if (dcAllow.length) base.channels.discord.dm.allowFrom = dcAllow; else delete base.channels.discord.dm.allowFrom;
      if (Object.keys(base.channels.discord.dm).length === 0) delete base.channels.discord.dm;
    }
    const dcGp = _sv('ocCfgDcGroupPolicy'); if (dcGp) base.channels.discord.groupPolicy = dcGp; else delete base.channels.discord.groupPolicy;
    const dcStream = _sv('ocCfgDcStreaming'); if (dcStream) base.channels.discord.streaming = dcStream; else delete base.channels.discord.streaming;
    const dcChunk = _sv('ocCfgDcTextChunkLimit'); if (dcChunk) base.channels.discord.textChunkLimit = Number(dcChunk); else delete base.channels.discord.textChunkLimit;
    if (el('ocCfgDcAllowBots')?.checked) base.channels.discord.allowBots = true; else delete base.channels.discord.allowBots;
    if (el('ocCfgDcVoiceEnabled') && !el('ocCfgDcVoiceEnabled').checked) {
      if (!base.channels.discord.voice) base.channels.discord.voice = {};
      base.channels.discord.voice.enabled = false;
    } else if (base.channels?.discord?.voice) { delete base.channels.discord.voice; }
  }
  const dcConfig = cloneJson(readJsonFragmentInput('ocCfgDiscordJson', 'Discord') || base.channels?.discord || {});
  setDeepConfigValue(dcConfig, 'token', el('ocCfgDiscordToken').value.trim() || null);
  const dcDmConfig = cloneJson(dcConfig.dm || {});
  setDeepConfigValue(dcDmConfig, 'policy', _sv('ocCfgDcDmPolicy'));
  setDeepConfigValue(dcDmConfig, 'allowFrom', _csvArr('ocCfgDcAllowFrom'));
  setDeepConfigValue(dcConfig, 'dm', dcDmConfig);
  setDeepConfigValue(dcConfig, 'groupPolicy', _sv('ocCfgDcGroupPolicy'));
  setDeepConfigValue(dcConfig, 'streaming', _sv('ocCfgDcStreaming'));
  setDeepConfigValue(dcConfig, 'textChunkLimit', _sv('ocCfgDcTextChunkLimit') ? Number(_sv('ocCfgDcTextChunkLimit')) : null);
  setDeepConfigValue(dcConfig, 'allowBots', el('ocCfgDcAllowBots')?.checked ? true : null);
  setDeepConfigValue(dcConfig, 'voice.enabled', el('ocCfgDcVoiceEnabled')?.checked === false ? false : null);
  setDeepConfigValue(dcConfig, 'defaultAccount', _sv('ocCfgDcDefaultAccount'));
  setDeepConfigValue(dcConfig, 'defaultTo', _sv('ocCfgDcDefaultTo'));
  setDeepConfigValue(dcConfig, 'responsePrefix', _sv('ocCfgDcResponsePrefix'));
  setDeepConfigValue(dcConfig, 'ackReaction', _sv('ocCfgDcAckReaction'));
  setDeepConfigValue(dcConfig, 'ackReactionScope', _sv('ocCfgDcAckReactionScope'));
  setDeepConfigValue(dcConfig, 'activity', _sv('ocCfgDcActivity'));
  setDeepConfigValue(dcConfig, 'status', _sv('ocCfgDcStatus'));
  setDeepConfigValue(base, 'channels.discord', dcConfig);

  const slackBot = el('ocCfgSlackBotToken').value.trim();
  const slackApp = el('ocCfgSlackAppToken').value.trim();
  if (slackBot || slackApp) {
    if (!base.channels) base.channels = {};
    if (!base.channels.slack) base.channels.slack = {};
    if (slackBot) base.channels.slack.botToken = slackBot;
    if (slackApp) base.channels.slack.appToken = slackApp;
  }
  const slackConfig = cloneJson(readJsonFragmentInput('ocCfgSlackJson', 'Slack') || base.channels?.slack || {});
  setDeepConfigValue(slackConfig, 'botToken', slackBot || null);
  setDeepConfigValue(slackConfig, 'appToken', slackApp || null);
  setDeepConfigValue(slackConfig, 'signingSecret', _sv('ocCfgSlackSigningSecret'));
  setDeepConfigValue(slackConfig, 'webhookPath', _sv('ocCfgSlackWebhookPath'));
  setDeepConfigValue(slackConfig, 'defaultAccount', _sv('ocCfgSlackDefaultAccount'));
  setDeepConfigValue(slackConfig, 'defaultTo', _sv('ocCfgSlackDefaultTo'));
  setDeepConfigValue(slackConfig, 'groupPolicy', _sv('ocCfgSlackGroupPolicy'));
  setDeepConfigValue(slackConfig, 'textChunkLimit', _sv('ocCfgSlackTextChunkLimit') ? Number(_sv('ocCfgSlackTextChunkLimit')) : null);
  setDeepConfigValue(slackConfig, 'streaming', _sv('ocCfgSlackStreaming'));
  setDeepConfigValue(slackConfig, 'responsePrefix', _sv('ocCfgSlackResponsePrefix'));
  setDeepConfigValue(slackConfig, 'ackReaction', _sv('ocCfgSlackAckReaction'));
  setDeepConfigValue(slackConfig, 'typingReaction', _sv('ocCfgSlackTypingReaction'));
  setDeepConfigValue(slackConfig, 'allowBots', el('ocCfgSlackAllowBots')?.checked ? true : null);
  setDeepConfigValue(slackConfig, 'requireMention', el('ocCfgSlackRequireMention')?.checked ? true : null);
  setDeepConfigValue(base, 'channels.slack', slackConfig);

  const waEnabled = el('ocCfgWhatsAppEnabled')?.checked;
  const waDefaultTo = _sv('ocCfgWhatsAppDefaultTo');
  const waDmPolicy = _sv('ocCfgWhatsAppDmPolicy');
  const waGroupPolicy = _sv('ocCfgWhatsAppGroupPolicy');
  const waAllowFrom = _csvArr('ocCfgWhatsAppAllowFrom');
  const waGroupAllowFrom = _csvArr('ocCfgWhatsAppGroupAllowFrom');
  const waHistoryLimit = _sv('ocCfgWhatsAppHistoryLimit');
  const waDmHistoryLimit = _sv('ocCfgWhatsAppDmHistoryLimit');
  const waTextChunkLimit = _sv('ocCfgWhatsAppTextChunkLimit');
  const waMediaMaxMb = _sv('ocCfgWhatsAppMediaMaxMb');
  const waResponsePrefix = _sv('ocCfgWhatsAppResponsePrefix');
  const waSelfChatMode = el('ocCfgWhatsAppSelfChatMode')?.checked;
  const waSendReadReceipts = el('ocCfgWhatsAppSendReadReceipts')?.checked;
  if (waDefaultTo || waDmPolicy || waGroupPolicy || waAllowFrom.length || waGroupAllowFrom.length || waHistoryLimit || waDmHistoryLimit || waTextChunkLimit || waMediaMaxMb || waResponsePrefix || waSelfChatMode || waEnabled === false || waSendReadReceipts === false) {
    if (!base.channels) base.channels = {};
    if (!base.channels.whatsapp) base.channels.whatsapp = {};
    if (waEnabled === false) base.channels.whatsapp.enabled = false; else delete base.channels.whatsapp.enabled;
    if (waDefaultTo) base.channels.whatsapp.defaultTo = waDefaultTo; else delete base.channels.whatsapp.defaultTo;
    if (waDmPolicy) base.channels.whatsapp.dmPolicy = waDmPolicy; else delete base.channels.whatsapp.dmPolicy;
    if (waGroupPolicy) base.channels.whatsapp.groupPolicy = waGroupPolicy; else delete base.channels.whatsapp.groupPolicy;
    if (waAllowFrom.length) base.channels.whatsapp.allowFrom = waAllowFrom; else delete base.channels.whatsapp.allowFrom;
    if (waGroupAllowFrom.length) base.channels.whatsapp.groupAllowFrom = waGroupAllowFrom; else delete base.channels.whatsapp.groupAllowFrom;
    if (waHistoryLimit) base.channels.whatsapp.historyLimit = Number(waHistoryLimit); else delete base.channels.whatsapp.historyLimit;
    if (waDmHistoryLimit) base.channels.whatsapp.dmHistoryLimit = Number(waDmHistoryLimit); else delete base.channels.whatsapp.dmHistoryLimit;
    if (waTextChunkLimit) base.channels.whatsapp.textChunkLimit = Number(waTextChunkLimit); else delete base.channels.whatsapp.textChunkLimit;
    if (waMediaMaxMb) base.channels.whatsapp.mediaMaxMb = Number(waMediaMaxMb); else delete base.channels.whatsapp.mediaMaxMb;
    if (waResponsePrefix) base.channels.whatsapp.responsePrefix = waResponsePrefix; else delete base.channels.whatsapp.responsePrefix;
    if (waSelfChatMode) base.channels.whatsapp.selfChatMode = true; else delete base.channels.whatsapp.selfChatMode;
    if (waSendReadReceipts === false) base.channels.whatsapp.sendReadReceipts = false; else delete base.channels.whatsapp.sendReadReceipts;
  }

  // Channel defaults
  const chanDefGp = _sv('ocCfgChannelDefaultGroupPolicy');
  if (chanDefGp) {
    if (!base.channels) base.channels = {};
    if (!base.channels.defaults) base.channels.defaults = {};
    base.channels.defaults.groupPolicy = chanDefGp;
  } else if (base.channels?.defaults) { delete base.channels.defaults.groupPolicy; if (Object.keys(base.channels.defaults).length === 0) delete base.channels.defaults; }

  const signalConfig = cloneJson(readJsonFragmentInput('ocCfgSignalJson', 'Signal') || base.channels?.signal || {});
  setDeepConfigValue(signalConfig, 'account', _sv('ocCfgSignalAccount'));
  setDeepConfigValue(signalConfig, 'httpUrl', _sv('ocCfgSignalHttpUrl'));
  setDeepConfigValue(signalConfig, 'cliPath', _sv('ocCfgSignalCliPath'));
  setDeepConfigValue(signalConfig, 'dmPolicy', _sv('ocCfgSignalDmPolicy'));
  setDeepConfigValue(signalConfig, 'groupPolicy', _sv('ocCfgSignalGroupPolicy'));
  setDeepConfigValue(signalConfig, 'allowFrom', _csvArr('ocCfgSignalAllowFrom'));
  setDeepConfigValue(signalConfig, 'reactionNotifications', _sv('ocCfgSignalReactionNotifications'));
  setDeepConfigValue(signalConfig, 'textChunkLimit', _sv('ocCfgSignalTextChunkLimit') ? Number(_sv('ocCfgSignalTextChunkLimit')) : null);
  setDeepConfigValue(signalConfig, 'responsePrefix', _sv('ocCfgSignalResponsePrefix'));
  setDeepConfigValue(signalConfig, 'enabled', el('ocCfgSignalEnabled')?.checked === false ? false : null);
  setDeepConfigValue(signalConfig, 'autoStart', el('ocCfgSignalAutoStart')?.checked === false ? false : null);
  setDeepConfigValue(signalConfig, 'sendReadReceipts', el('ocCfgSignalReadReceipts')?.checked ? true : null);
  setDeepConfigValue(base, 'channels.signal', signalConfig);

  const googleChatConfig = cloneJson(readJsonFragmentInput('ocCfgGoogleChatJson', 'Google Chat') || base.channels?.googlechat || {});
  setDeepConfigValue(googleChatConfig, 'serviceAccountFile', _sv('ocCfgGoogleChatServiceAccountFile'));
  setDeepConfigValue(googleChatConfig, 'webhookPath', _sv('ocCfgGoogleChatWebhookPath'));
  setDeepConfigValue(googleChatConfig, 'defaultTo', _sv('ocCfgGoogleChatDefaultTo'));
  setDeepConfigValue(googleChatConfig, 'groupPolicy', _sv('ocCfgGoogleChatGroupPolicy'));
  setDeepConfigValue(googleChatConfig, 'groupAllowFrom', _csvArr('ocCfgGoogleChatGroupAllowFrom'));
  setDeepConfigValue(googleChatConfig, 'typingIndicator', _sv('ocCfgGoogleChatTypingIndicator'));
  setDeepConfigValue(googleChatConfig, 'textChunkLimit', _sv('ocCfgGoogleChatTextChunkLimit') ? Number(_sv('ocCfgGoogleChatTextChunkLimit')) : null);
  setDeepConfigValue(googleChatConfig, 'responsePrefix', _sv('ocCfgGoogleChatResponsePrefix'));
  setDeepConfigValue(googleChatConfig, 'enabled', el('ocCfgGoogleChatEnabled')?.checked === false ? false : null);
  setDeepConfigValue(googleChatConfig, 'allowBots', el('ocCfgGoogleChatAllowBots')?.checked ? true : null);
  const googleChatDm = cloneJson(googleChatConfig.dm || {});
  setDeepConfigValue(googleChatDm, 'policy', _sv('ocCfgGoogleChatDmPolicy'));
  setDeepConfigValue(googleChatDm, 'allowFrom', _csvArr('ocCfgGoogleChatAllowFrom'));
  setDeepConfigValue(googleChatConfig, 'dm', googleChatDm);
  setDeepConfigValue(base, 'channels.googlechat', googleChatConfig);

  const imessageConfig = cloneJson(readJsonFragmentInput('ocCfgImessageJson', 'iMessage') || base.channels?.imessage || {});
  setDeepConfigValue(imessageConfig, 'cliPath', _sv('ocCfgImessageCliPath'));
  setDeepConfigValue(imessageConfig, 'service', _sv('ocCfgImessageService'));
  setDeepConfigValue(imessageConfig, 'remoteHost', _sv('ocCfgImessageRemoteHost'));
  setDeepConfigValue(imessageConfig, 'defaultTo', _sv('ocCfgImessageDefaultTo'));
  setDeepConfigValue(imessageConfig, 'dmPolicy', _sv('ocCfgImessageDmPolicy'));
  setDeepConfigValue(imessageConfig, 'groupPolicy', _sv('ocCfgImessageGroupPolicy'));
  setDeepConfigValue(imessageConfig, 'allowFrom', _csvArr('ocCfgImessageAllowFrom'));
  setDeepConfigValue(imessageConfig, 'textChunkLimit', _sv('ocCfgImessageTextChunkLimit') ? Number(_sv('ocCfgImessageTextChunkLimit')) : null);
  setDeepConfigValue(imessageConfig, 'responsePrefix', _sv('ocCfgImessageResponsePrefix'));
  setDeepConfigValue(imessageConfig, 'enabled', el('ocCfgImessageEnabled')?.checked === false ? false : null);
  setDeepConfigValue(imessageConfig, 'includeAttachments', el('ocCfgImessageIncludeAttachments')?.checked ? true : null);
  setDeepConfigValue(base, 'channels.imessage', imessageConfig);

  const ircConfig = cloneJson(readJsonFragmentInput('ocCfgIrcJson', 'IRC') || base.channels?.irc || {});
  setDeepConfigValue(ircConfig, 'host', _sv('ocCfgIrcHost'));
  setDeepConfigValue(ircConfig, 'port', _sv('ocCfgIrcPort') ? Number(_sv('ocCfgIrcPort')) : null);
  setDeepConfigValue(ircConfig, 'nick', _sv('ocCfgIrcNick'));
  setDeepConfigValue(ircConfig, 'username', _sv('ocCfgIrcUsername'));
  setDeepConfigValue(ircConfig, 'password', _sv('ocCfgIrcPassword'));
  setDeepConfigValue(ircConfig, 'channels', _csvArr('ocCfgIrcChannels'));
  setDeepConfigValue(ircConfig, 'dmPolicy', _sv('ocCfgIrcDmPolicy'));
  setDeepConfigValue(ircConfig, 'groupPolicy', _sv('ocCfgIrcGroupPolicy'));
  setDeepConfigValue(ircConfig, 'allowFrom', _csvArr('ocCfgIrcAllowFrom'));
  setDeepConfigValue(ircConfig, 'textChunkLimit', _sv('ocCfgIrcTextChunkLimit') ? Number(_sv('ocCfgIrcTextChunkLimit')) : null);
  setDeepConfigValue(ircConfig, 'mentionPatterns', _csvArr('ocCfgIrcMentionPatterns'));
  setDeepConfigValue(ircConfig, 'enabled', el('ocCfgIrcEnabled')?.checked === false ? false : null);
  setDeepConfigValue(ircConfig, 'tls', el('ocCfgIrcTls')?.checked === false ? false : null);
  setDeepConfigValue(base, 'channels.irc', ircConfig);

  const msTeamsConfig = cloneJson(readJsonFragmentInput('ocCfgMSTeamsJson', 'Microsoft Teams') || base.channels?.msteams || {});
  setDeepConfigValue(msTeamsConfig, 'appId', _sv('ocCfgMSTeamsAppId'));
  setDeepConfigValue(msTeamsConfig, 'appPassword', _sv('ocCfgMSTeamsAppPassword'));
  setDeepConfigValue(msTeamsConfig, 'tenantId', _sv('ocCfgMSTeamsTenantId'));
  const msWebhook = cloneJson(msTeamsConfig.webhook || {});
  setDeepConfigValue(msWebhook, 'port', _sv('ocCfgMSTeamsWebhookPort') ? Number(_sv('ocCfgMSTeamsWebhookPort')) : null);
  setDeepConfigValue(msWebhook, 'path', _sv('ocCfgMSTeamsWebhookPath'));
  setDeepConfigValue(msTeamsConfig, 'webhook', msWebhook);
  setDeepConfigValue(msTeamsConfig, 'defaultTo', _sv('ocCfgMSTeamsDefaultTo'));
  setDeepConfigValue(msTeamsConfig, 'dmPolicy', _sv('ocCfgMSTeamsDmPolicy'));
  setDeepConfigValue(msTeamsConfig, 'groupPolicy', _sv('ocCfgMSTeamsGroupPolicy'));
  setDeepConfigValue(msTeamsConfig, 'allowFrom', _csvArr('ocCfgMSTeamsAllowFrom'));
  setDeepConfigValue(msTeamsConfig, 'textChunkLimit', _sv('ocCfgMSTeamsTextChunkLimit') ? Number(_sv('ocCfgMSTeamsTextChunkLimit')) : null);
  setDeepConfigValue(msTeamsConfig, 'responsePrefix', _sv('ocCfgMSTeamsResponsePrefix'));
  setDeepConfigValue(msTeamsConfig, 'enabled', el('ocCfgMSTeamsEnabled')?.checked === false ? false : null);
  setDeepConfigValue(msTeamsConfig, 'requireMention', el('ocCfgMSTeamsRequireMention')?.checked ? true : null);
  setDeepConfigValue(base, 'channels.msteams', msTeamsConfig);

  setDeepConfigValue(base, 'channels.modelByChannel', readJsonFragmentInput('ocCfgChannelModelByChannelJson', '按渠道模型覆盖'));

  const matrixHomeserver = _sv('ocCfgMatrixHomeserver');
  const matrixToken = _sv('ocCfgMatrixToken');
  if (matrixHomeserver || matrixToken) {
    if (!base.channels) base.channels = {};
    if (!base.channels.matrix) base.channels.matrix = {};
    if (matrixHomeserver) base.channels.matrix.homeserver = matrixHomeserver; else delete base.channels.matrix.homeserver;
    if (matrixToken) base.channels.matrix.accessToken = matrixToken; else delete base.channels.matrix.accessToken;
  } else if (base.channels?.matrix) {
    delete base.channels.matrix;
  }

  const lineSecret = _sv('ocCfgLineSecret');
  const lineToken = _sv('ocCfgLineToken');
  if (lineSecret || lineToken) {
    if (!base.channels) base.channels = {};
    if (!base.channels.line) base.channels.line = {};
    if (lineSecret) base.channels.line.channelSecret = lineSecret; else delete base.channels.line.channelSecret;
    if (lineToken) base.channels.line.accessToken = lineToken; else delete base.channels.line.accessToken;
  } else if (base.channels?.line) {
    delete base.channels.line;
  }

  const wechatAppId = _sv('ocCfgWechatAppId');
  const wechatToken = _sv('ocCfgWechatToken');
  const wechatAesKey = _sv('ocCfgWechatAesKey');
  if (wechatAppId || wechatToken || wechatAesKey) {
    if (!base.channels) base.channels = {};
    if (!base.channels.wechat) base.channels.wechat = {};
    if (wechatAppId) base.channels.wechat.appId = wechatAppId; else delete base.channels.wechat.appId;
    if (wechatToken) base.channels.wechat.token = wechatToken; else delete base.channels.wechat.token;
    if (wechatAesKey) base.channels.wechat.encodingAESKey = wechatAesKey; else delete base.channels.wechat.encodingAESKey;
  } else if (base.channels?.wechat) {
    delete base.channels.wechat;
  }

  const weworkCorpId = _sv('ocCfgWechatWorkCorpId');
  const weworkAgentId = _sv('ocCfgWechatWorkAgentId');
  const weworkSecret = _sv('ocCfgWechatWorkSecret');
  if (weworkCorpId || weworkAgentId || weworkSecret) {
    if (!base.channels) base.channels = {};
    if (!base.channels.wechatwork) base.channels.wechatwork = {};
    if (weworkCorpId) base.channels.wechatwork.corpId = weworkCorpId; else delete base.channels.wechatwork.corpId;
    if (weworkAgentId) base.channels.wechatwork.agentId = Number(weworkAgentId); else delete base.channels.wechatwork.agentId;
    if (weworkSecret) base.channels.wechatwork.secret = weworkSecret; else delete base.channels.wechatwork.secret;
  } else if (base.channels?.wechatwork) {
    delete base.channels.wechatwork;
  }

  // ── Tools ──
  const toolProfile = _sv('ocCfgToolsProfile');
  const toolAllow = _csvArr('ocCfgToolsAlsoAllow');
  const toolDeny = _csvArr('ocCfgToolsDeny');
  const execHost = _sv('ocCfgExecHost');
  const execSec = _sv('ocCfgExecSecurity');
  const execTimeout = _sv('ocCfgExecTimeout');
  const webProvider = _sv('ocCfgWebSearchProvider');
  const webKey = _sv('ocCfgWebSearchApiKey');
  if (toolProfile || toolAllow.length || toolDeny.length || execHost || execSec || execTimeout || webProvider || webKey) {
    if (!base.tools) base.tools = {};
    if (toolProfile) base.tools.profile = toolProfile; else delete base.tools.profile;
    if (toolAllow.length) base.tools.allow = toolAllow; else delete base.tools.allow;
    if (toolDeny.length) base.tools.deny = toolDeny; else delete base.tools.deny;
    if (execHost || execSec || execTimeout) {
      if (!base.tools.exec) base.tools.exec = {};
      if (execHost) base.tools.exec.host = execHost; else delete base.tools.exec.host;
      if (execSec) base.tools.exec.security = execSec; else delete base.tools.exec.security;
      if (execTimeout) base.tools.exec.timeoutSec = Number(execTimeout); else delete base.tools.exec.timeoutSec;
      if (Object.keys(base.tools.exec).length === 0) delete base.tools.exec;
    }
    if (webProvider || webKey) {
      if (!base.tools.web) base.tools.web = {};
      if (!base.tools.web.search) base.tools.web.search = {};
      if (webProvider) base.tools.web.search.provider = webProvider; else delete base.tools.web.search.provider;
      if (webKey) base.tools.web.search.apiKey = webKey; else delete base.tools.web.search.apiKey;
      if (Object.keys(base.tools.web.search).length === 0) delete base.tools.web.search;
      if (Object.keys(base.tools.web).length === 0) delete base.tools.web;
    }
    if (Object.keys(base.tools).length === 0) delete base.tools;
  }

  // Elevated tools
  if (el('ocCfgToolsElevatedEnabled') && !el('ocCfgToolsElevatedEnabled').checked) {
    if (!base.tools) base.tools = {};
    if (!base.tools.elevated) base.tools.elevated = {};
    base.tools.elevated.enabled = false;
  } else if (base.tools?.elevated) { delete base.tools.elevated; }

  // ── Security / Commands ──
  const cmdText = _boolSelect('ocCfgCommandsText');
  const cmdConfig = _boolSelect('ocCfgCommandsConfig');
  const cmdBash = _boolSelect('ocCfgCommandsBash');
  if (cmdText !== undefined || cmdConfig !== undefined || cmdBash !== undefined) {
    if (!base.commands) base.commands = {};
    if (cmdText !== undefined) base.commands.text = cmdText; else delete base.commands.text;
    if (cmdConfig !== undefined) base.commands.config = cmdConfig; else delete base.commands.config;
    if (cmdBash !== undefined) base.commands.bash = cmdBash; else delete base.commands.bash;
    if (Object.keys(base.commands).length === 0) delete base.commands;
  }

  // Approvals
  if (el('ocCfgApprovalsEnabled')?.checked) {
    if (!base.approvals) base.approvals = {};
    base.approvals.enabled = true;
  } else if (base.approvals) { delete base.approvals.enabled; if (Object.keys(base.approvals).length === 0) delete base.approvals; }

  // ── Session ──
  const sessScope = _sv('ocCfgSessionScope');
  const sessIdle = _sv('ocCfgSessionIdleMinutes');
  const sessReset = _sv('ocCfgSessionResetMode');
  const sessPrune = _sv('ocCfgSessionPruneAfter');
  const sessMax = _sv('ocCfgSessionMaxEntries');
  if (sessScope || sessIdle || sessReset || sessPrune || sessMax) {
    if (!base.session) base.session = {};
    if (sessScope) base.session.scope = sessScope; else delete base.session.scope;
    if (sessIdle) base.session.idleMinutes = Number(sessIdle); else delete base.session.idleMinutes;
    if (sessReset) base.session.reset = sessReset; else delete base.session.reset;
    if (sessPrune || sessMax) {
      if (!base.session.maintenance) base.session.maintenance = {};
      if (sessPrune) base.session.maintenance.pruneAfter = sessPrune; else delete base.session.maintenance.pruneAfter;
      if (sessMax) base.session.maintenance.maxEntries = Number(sessMax); else delete base.session.maintenance.maxEntries;
      if (Object.keys(base.session.maintenance).length === 0) delete base.session.maintenance;
    }
    if (Object.keys(base.session).length === 0) delete base.session;
  }

  // ── Gateway ──
  const gwPort = el('ocCfgGatewayPort').value.trim();
  const gwMode = _sv('ocCfgGatewayMode');
  const gwBind = el('ocCfgGatewayBind').value;
  const gwCustomBindHost = _sv('ocCfgGatewayCustomBindHost');
  const gwAuthMode = el('ocCfgGatewayAuthMode').value;
  const gwToken = el('ocCfgGatewayToken').value.trim();
  const gwPassword = _sv('ocCfgGatewayPassword');
  const gwTrustedProxyUserHeader = _sv('ocCfgGatewayTrustedProxyUserHeader');
  const gwTrustedProxyRequiredHeaders = _csvArr('ocCfgGatewayTrustedProxyRequiredHeaders');
  const gwTrustedProxyAllowUsers = _csvArr('ocCfgGatewayTrustedProxyAllowUsers');
  const gwAllowTailscale = el('ocCfgGatewayAllowTailscale')?.checked;
  const gwReload = _sv('ocCfgGatewayReload');
  const gwHealth = _sv('ocCfgGatewayHealthCheck');
  if (gwPort || gwMode || gwBind || gwCustomBindHost || gwAuthMode || gwToken || gwPassword || gwTrustedProxyUserHeader || gwTrustedProxyRequiredHeaders.length || gwTrustedProxyAllowUsers.length || gwAllowTailscale || gwReload || gwHealth) {
    if (!base.gateway) base.gateway = {};
    if (gwPort) base.gateway.port = Number(gwPort) || 18789; else delete base.gateway.port;
    if (gwMode) base.gateway.mode = gwMode; else delete base.gateway.mode;
    if (gwBind) base.gateway.bind = gwBind; else delete base.gateway.bind;
    if (gwCustomBindHost) base.gateway.customBindHost = gwCustomBindHost; else delete base.gateway.customBindHost;
    if (gwReload) base.gateway.reload = gwReload; else delete base.gateway.reload;
    if (gwHealth) base.gateway.channelHealthCheckMinutes = Number(gwHealth); else delete base.gateway.channelHealthCheckMinutes;
    if (gwAuthMode || gwToken || gwPassword || gwTrustedProxyUserHeader || gwTrustedProxyRequiredHeaders.length || gwTrustedProxyAllowUsers.length || gwAllowTailscale) {
      if (!base.gateway.auth) base.gateway.auth = {};
      if (gwAuthMode) base.gateway.auth.mode = gwAuthMode; else delete base.gateway.auth.mode;
      if (gwToken) base.gateway.auth.token = gwToken; else delete base.gateway.auth.token;
      if (gwPassword) base.gateway.auth.password = gwPassword; else delete base.gateway.auth.password;
      if (gwAllowTailscale) base.gateway.auth.allowTailscale = true; else delete base.gateway.auth.allowTailscale;
      if (gwTrustedProxyUserHeader || gwTrustedProxyRequiredHeaders.length || gwTrustedProxyAllowUsers.length) {
        if (!base.gateway.auth.trustedProxy) base.gateway.auth.trustedProxy = {};
        if (gwTrustedProxyUserHeader) base.gateway.auth.trustedProxy.userHeader = gwTrustedProxyUserHeader; else delete base.gateway.auth.trustedProxy.userHeader;
        if (gwTrustedProxyRequiredHeaders.length) base.gateway.auth.trustedProxy.requiredHeaders = gwTrustedProxyRequiredHeaders; else delete base.gateway.auth.trustedProxy.requiredHeaders;
        if (gwTrustedProxyAllowUsers.length) base.gateway.auth.trustedProxy.allowUsers = gwTrustedProxyAllowUsers; else delete base.gateway.auth.trustedProxy.allowUsers;
        if (Object.keys(base.gateway.auth.trustedProxy).length === 0) delete base.gateway.auth.trustedProxy;
      }
      if (Object.keys(base.gateway.auth).length === 0) delete base.gateway.auth;
    }
    const gwTailscaleMode = _sv('ocCfgGatewayTailscaleMode');
    if (gwTailscaleMode) {
      if (!base.gateway.tailscale) base.gateway.tailscale = {};
      base.gateway.tailscale.mode = gwTailscaleMode;
    } else if (base.gateway?.tailscale) {
      delete base.gateway.tailscale;
    }
    const gwTlsEnabled = el('ocCfgGatewayTlsEnabled')?.checked;
    const gwTlsAutoGenerate = el('ocCfgGatewayTlsAutoGenerate')?.checked;
    const gwTlsCertPath = _sv('ocCfgGatewayTlsCertPath');
    const gwTlsKeyPath = _sv('ocCfgGatewayTlsKeyPath');
    const gwTlsCaPath = _sv('ocCfgGatewayTlsCaPath');
    if (gwTlsEnabled || gwTlsCertPath || gwTlsKeyPath || gwTlsCaPath || gwTlsAutoGenerate === false) {
      if (!base.gateway.tls) base.gateway.tls = {};
      if (gwTlsEnabled) base.gateway.tls.enabled = true; else delete base.gateway.tls.enabled;
      if (gwTlsAutoGenerate === false) base.gateway.tls.autoGenerate = false; else delete base.gateway.tls.autoGenerate;
      if (gwTlsCertPath) base.gateway.tls.certPath = gwTlsCertPath; else delete base.gateway.tls.certPath;
      if (gwTlsKeyPath) base.gateway.tls.keyPath = gwTlsKeyPath; else delete base.gateway.tls.keyPath;
      if (gwTlsCaPath) base.gateway.tls.caPath = gwTlsCaPath; else delete base.gateway.tls.caPath;
      if (Object.keys(base.gateway.tls).length === 0) delete base.gateway.tls;
    } else if (base.gateway?.tls) {
      delete base.gateway.tls;
    }
    const gwControlUiEnabled = el('ocCfgGatewayControlUiEnabled')?.checked;
    const gwControlUiBasePath = _sv('ocCfgGatewayControlUiBasePath');
    const gwControlUiAllowedOrigins = _csvArr('ocCfgGatewayControlUiAllowedOrigins');
    if (gwControlUiBasePath || gwControlUiAllowedOrigins.length || gwControlUiEnabled === false) {
      if (!base.gateway.controlUi) base.gateway.controlUi = {};
      if (gwControlUiEnabled === false) base.gateway.controlUi.enabled = false; else delete base.gateway.controlUi.enabled;
      if (gwControlUiBasePath) base.gateway.controlUi.basePath = gwControlUiBasePath; else delete base.gateway.controlUi.basePath;
      if (gwControlUiAllowedOrigins.length) base.gateway.controlUi.allowedOrigins = gwControlUiAllowedOrigins; else delete base.gateway.controlUi.allowedOrigins;
      if (Object.keys(base.gateway.controlUi).length === 0) delete base.gateway.controlUi;
    } else if (base.gateway?.controlUi) {
      delete base.gateway.controlUi;
    }
    if (Object.keys(base.gateway).length === 0) delete base.gateway;
  }
  // Gateway HTTP endpoints
  const httpChat = el('ocCfgGatewayHttpChatCompletions')?.checked;
  const httpResp = el('ocCfgGatewayHttpResponses')?.checked;
  const httpChatBodyBytes = _sv('ocCfgGatewayHttpChatBodyBytes');
  const httpResponsesBodyBytes = _sv('ocCfgGatewayHttpResponsesBodyBytes');
  if (httpChat || httpResp || httpChatBodyBytes || httpResponsesBodyBytes) {
    if (!base.gateway) base.gateway = {};
    if (!base.gateway.http) base.gateway.http = {};
    if (!base.gateway.http.endpoints) base.gateway.http.endpoints = {};
    if (httpChat || httpChatBodyBytes) {
      base.gateway.http.endpoints.chatCompletions = {};
      if (httpChatBodyBytes) base.gateway.http.endpoints.chatCompletions.maxBodyBytes = Number(httpChatBodyBytes);
    } else delete base.gateway.http.endpoints.chatCompletions;
    if (httpResp || httpResponsesBodyBytes) {
      base.gateway.http.endpoints.responses = {};
      if (httpResponsesBodyBytes) base.gateway.http.endpoints.responses.maxBodyBytes = Number(httpResponsesBodyBytes);
    } else delete base.gateway.http.endpoints.responses;
    if (Object.keys(base.gateway.http.endpoints).length === 0) delete base.gateway.http.endpoints;
    if (Object.keys(base.gateway.http).length === 0) delete base.gateway.http;
  }

  // ── Cron & Hooks ──
  const cronEnabled = el('ocCfgCronEnabled')?.checked;
  const cronConc = _sv('ocCfgCronMaxConcurrent');
  const cronRet = _sv('ocCfgCronSessionRetention');
  if (cronEnabled || cronConc || cronRet) {
    if (!base.cron) base.cron = {};
    if (cronEnabled) base.cron.enabled = true; else delete base.cron.enabled;
    if (cronConc) base.cron.maxConcurrentRuns = Number(cronConc); else delete base.cron.maxConcurrentRuns;
    if (cronRet) base.cron.sessionRetention = cronRet; else delete base.cron.sessionRetention;
    if (Object.keys(base.cron).length === 0) delete base.cron;
  }
  const hooksEnabled = el('ocCfgHooksEnabled')?.checked;
  const hooksPath = _sv('ocCfgHooksPath');
  const hooksToken = _sv('ocCfgHooksToken');
  if (hooksEnabled || hooksPath || hooksToken) {
    if (!base.hooks) base.hooks = {};
    if (hooksEnabled) base.hooks.enabled = true; else delete base.hooks.enabled;
    if (hooksPath) base.hooks.path = hooksPath; else delete base.hooks.path;
    if (hooksToken) base.hooks.token = hooksToken; else delete base.hooks.token;
    if (Object.keys(base.hooks).length === 0) delete base.hooks;
  }

  // ── UI / Identity ──
  const assistantName = el('ocCfgAssistantName').value.trim();
  const assistantAvatar = el('ocCfgAssistantAvatar').value.trim();
  const seamColor = el('ocCfgSeamColorText').value.trim();
  if (assistantName || assistantAvatar || seamColor) {
    if (!base.ui) base.ui = {};
    if (seamColor) base.ui.seamColor = seamColor; else delete base.ui.seamColor;
    if (assistantName || assistantAvatar) {
      if (!base.ui.assistant) base.ui.assistant = {};
      if (assistantName) base.ui.assistant.name = assistantName; else delete base.ui.assistant.name;
      if (assistantAvatar) base.ui.assistant.avatar = assistantAvatar; else delete base.ui.assistant.avatar;
      if (Object.keys(base.ui.assistant).length === 0) delete base.ui.assistant;
    }
    if (Object.keys(base.ui).length === 0) delete base.ui;
  }

  // ── Logging ──
  const logLevel = el('ocCfgLoggingLevel').value;
  const logStyle = el('ocCfgLoggingStyle').value;
  if (logLevel || logStyle) {
    if (!base.logging) base.logging = {};
    if (logLevel) base.logging.level = logLevel; else delete base.logging.level;
    if (logStyle) base.logging.consoleStyle = logStyle; else delete base.logging.consoleStyle;
    if (Object.keys(base.logging).length === 0) delete base.logging;
  }

  // Diagnostics
  if (el('ocCfgDiagnosticsEnabled')?.checked) {
    if (!base.diagnostics) base.diagnostics = {};
    base.diagnostics.enabled = true;
  } else if (base.diagnostics) { delete base.diagnostics.enabled; if (Object.keys(base.diagnostics).length === 0) delete base.diagnostics; }

  // ── Update ──
  const updateCh = _sv('ocCfgUpdateChannel');
  const updateCheck = el('ocCfgUpdateCheckOnStart')?.checked;
  const updateAuto = el('ocCfgUpdateAutoEnabled')?.checked;
  if (updateCh || updateCheck === false || updateAuto) {
    if (!base.update) base.update = {};
    if (updateCh) base.update.channel = updateCh; else delete base.update.channel;
    if (updateCheck === false) base.update.checkOnStart = false; else delete base.update.checkOnStart;
    if (updateAuto) { if (!base.update.auto) base.update.auto = {}; base.update.auto.enabled = true; } else if (base.update?.auto) { delete base.update.auto; }
    if (Object.keys(base.update).length === 0) delete base.update;
  }

  const memoryJson = cloneJson(readJsonFragmentInput('ocCfgMemoryJson', 'Memory') || base.memory || {});
  setDeepConfigValue(memoryJson, 'backend', _sv('ocCfgMemoryBackend'));
  setDeepConfigValue(memoryJson, 'citations', _sv('ocCfgMemoryCitations'));
  setDeepConfigValue(memoryJson, 'qmd.command', _sv('ocCfgMemoryQmdCommand'));
  setDeepConfigValue(memoryJson, 'qmd.searchMode', _sv('ocCfgMemoryQmdSearchMode'));
  setDeepConfigValue(memoryJson, 'qmd.includeDefaultMemory', el('ocCfgMemoryIncludeDefaultMemory')?.checked ? true : null);
  setDeepConfigValue(memoryJson, 'qmd.sessions.enabled', el('ocCfgMemorySessionsEnabled')?.checked ? true : null);
  setDeepConfigValue(memoryJson, 'qmd.sessions.exportDir', _sv('ocCfgMemorySessionExportDir'));
  setDeepConfigValue(memoryJson, 'qmd.sessions.retentionDays', _sv('ocCfgMemorySessionRetentionDays') ? Number(_sv('ocCfgMemorySessionRetentionDays')) : null);
  setDeepConfigValue(memoryJson, 'qmd.update.interval', _sv('ocCfgMemoryUpdateInterval'));
  setDeepConfigValue(memoryJson, 'qmd.update.embedInterval', _sv('ocCfgMemoryEmbedInterval'));
  setDeepConfigValue(memoryJson, 'qmd.limits.maxResults', _sv('ocCfgMemoryMaxResults') ? Number(_sv('ocCfgMemoryMaxResults')) : null);
  setDeepConfigValue(memoryJson, 'qmd.mcporter.enabled', el('ocCfgMemoryMcporterEnabled')?.checked ? true : null);
  setDeepConfigValue(memoryJson, 'qmd.mcporter.serverName', _sv('ocCfgMemoryMcporterServerName'));
  setDeepConfigValue(memoryJson, 'qmd.mcporter.startDaemon', el('ocCfgMemoryMcporterStartDaemon')?.checked === false ? false : null);
  const skillsJson = cloneJson(readJsonFragmentInput('ocCfgSkillsJson', 'Skills') || base.skills || {});
  setDeepConfigValue(skillsJson, 'load.extraDirs', _csvArr('ocCfgSkillsExtraDirs'));
  setDeepConfigValue(skillsJson, 'load.watch', el('ocCfgSkillsWatch')?.checked ? true : null);
  setDeepConfigValue(skillsJson, 'install.preferBrew', el('ocCfgSkillsPreferBrew')?.checked ? true : null);
  setDeepConfigValue(skillsJson, 'install.nodeManager', _sv('ocCfgSkillsNodeManager'));
  setDeepConfigValue(skillsJson, 'limits.maxSkillsInPrompt', _sv('ocCfgSkillsMaxInPrompt') ? Number(_sv('ocCfgSkillsMaxInPrompt')) : null);
  setDeepConfigValue(skillsJson, 'limits.maxSkillsPromptChars', _sv('ocCfgSkillsPromptChars') ? Number(_sv('ocCfgSkillsPromptChars')) : null);
  const pluginsJson = cloneJson(readJsonFragmentInput('ocCfgPluginsJson', 'Plugins') || base.plugins || {});
  setDeepConfigValue(pluginsJson, 'enabled', el('ocCfgPluginsEnabled')?.checked ? true : null);
  setDeepConfigValue(pluginsJson, 'allow', _csvArr('ocCfgPluginsAllow'));
  setDeepConfigValue(pluginsJson, 'deny', _csvArr('ocCfgPluginsDeny'));
  setDeepConfigValue(pluginsJson, 'load.paths', _csvArr('ocCfgPluginsPaths'));
  setDeepConfigValue(pluginsJson, 'slots.memory', _sv('ocCfgPluginsMemorySlot'));
  setDeepConfigValue(pluginsJson, 'slots.contextEngine', _sv('ocCfgPluginsContextEngineSlot'));
  const browserJson = cloneJson(readJsonFragmentInput('ocCfgBrowserJson', 'Browser') || base.browser || {});
  setDeepConfigValue(browserJson, 'enabled', el('ocCfgBrowserEnabled')?.checked ? true : null);
  setDeepConfigValue(browserJson, 'headless', el('ocCfgBrowserHeadless')?.checked ? true : null);
  setDeepConfigValue(browserJson, 'attachOnly', el('ocCfgBrowserAttachOnly')?.checked ? true : null);
  setDeepConfigValue(browserJson, 'noSandbox', el('ocCfgBrowserNoSandbox')?.checked ? true : null);
  setDeepConfigValue(browserJson, 'evaluateEnabled', el('ocCfgBrowserEvaluateEnabled')?.checked === false ? false : null);
  setDeepConfigValue(browserJson, 'cdpUrl', _sv('ocCfgBrowserCdpUrl'));
  setDeepConfigValue(browserJson, 'executablePath', _sv('ocCfgBrowserExecutablePath'));
  setDeepConfigValue(browserJson, 'defaultProfile', _sv('ocCfgBrowserDefaultProfile'));
  setDeepConfigValue(browserJson, 'cdpPortRangeStart', _sv('ocCfgBrowserCdpPortRangeStart') ? Number(_sv('ocCfgBrowserCdpPortRangeStart')) : null);
  setDeepConfigValue(browserJson, 'color', _sv('ocCfgBrowserColor'));
  setDeepConfigValue(browserJson, 'extraArgs', _csvArr('ocCfgBrowserExtraArgs'));
  const mediaJson = readJsonFragmentInput('ocCfgMediaJson', 'Media');
  const infraJson = cloneJson(readJsonFragmentInput('ocCfgInfraJson', 'Discovery / Canvas / Talk') || {});
  setDeepConfigValue(infraJson, 'discovery.wideArea.enabled', el('ocCfgDiscoveryWideAreaEnabled')?.checked ? true : null);
  setDeepConfigValue(infraJson, 'discovery.wideArea.domain', _sv('ocCfgDiscoveryDomain'));
  setDeepConfigValue(infraJson, 'discovery.mdns.mode', _sv('ocCfgDiscoveryMdnsMode'));
  setDeepConfigValue(infraJson, 'canvasHost.enabled', el('ocCfgCanvasEnabled')?.checked ? true : null);
  setDeepConfigValue(infraJson, 'canvasHost.root', _sv('ocCfgCanvasRoot'));
  setDeepConfigValue(infraJson, 'canvasHost.port', _sv('ocCfgCanvasPort') ? Number(_sv('ocCfgCanvasPort')) : null);
  setDeepConfigValue(infraJson, 'canvasHost.liveReload', el('ocCfgCanvasLiveReload')?.checked === false ? false : null);
  setDeepConfigValue(infraJson, 'talk.provider', _sv('ocCfgTalkProvider'));
  setDeepConfigValue(infraJson, 'talk.voiceId', _sv('ocCfgTalkVoiceId'));
  setDeepConfigValue(infraJson, 'talk.modelId', _sv('ocCfgTalkModelId'));
  setDeepConfigValue(infraJson, 'talk.outputFormat', _sv('ocCfgTalkOutputFormat'));
  setDeepConfigValue(infraJson, 'talk.apiKey', _sv('ocCfgTalkApiKey'));
  setDeepConfigValue(infraJson, 'talk.interruptOnSpeech', el('ocCfgTalkInterruptOnSpeech')?.checked === false ? false : null);
  const runtimeJson = cloneJson(readJsonFragmentInput('ocCfgRuntimeJson', 'Web / NodeHost / Secrets') || {});
  setDeepConfigValue(runtimeJson, 'web.enabled', el('ocCfgWebEnabled')?.checked === false ? false : null);
  setDeepConfigValue(runtimeJson, 'web.heartbeatSeconds', _sv('ocCfgWebHeartbeatSeconds') ? Number(_sv('ocCfgWebHeartbeatSeconds')) : null);
  setDeepConfigValue(runtimeJson, 'web.reconnect.initialMs', _sv('ocCfgWebReconnectInitialMs') ? Number(_sv('ocCfgWebReconnectInitialMs')) : null);
  setDeepConfigValue(runtimeJson, 'web.reconnect.maxMs', _sv('ocCfgWebReconnectMaxMs') ? Number(_sv('ocCfgWebReconnectMaxMs')) : null);
  setDeepConfigValue(runtimeJson, 'nodeHost.browserProxy.enabled', el('ocCfgNodeHostBrowserProxyEnabled')?.checked ? true : null);
  setDeepConfigValue(runtimeJson, 'nodeHost.browserProxy.allowProfiles', _csvArr('ocCfgNodeHostAllowProfiles'));
  setDeepConfigValue(runtimeJson, 'secrets.defaults.env', _sv('ocCfgSecretsDefaultEnv'));
  setDeepConfigValue(runtimeJson, 'secrets.defaults.file', _sv('ocCfgSecretsDefaultFile'));
  setDeepConfigValue(runtimeJson, 'secrets.defaults.exec', _sv('ocCfgSecretsDefaultExec'));
  setDeepConfigValue(runtimeJson, 'secrets.resolution.maxProviderConcurrency', _sv('ocCfgSecretsMaxProviderConcurrency') ? Number(_sv('ocCfgSecretsMaxProviderConcurrency')) : null);
  const systemJson = readJsonFragmentInput('ocCfgSystemJson', 'Auth / ACP / CLI / Bindings / Broadcast / Audio');

  setDeepConfigValue(base, 'memory', memoryJson);
  setDeepConfigValue(base, 'skills', skillsJson);
  setDeepConfigValue(base, 'plugins', pluginsJson);
  setDeepConfigValue(base, 'browser', browserJson);
  setDeepConfigValue(base, 'media', mediaJson);
  setDeepConfigValue(base, 'discovery', infraJson?.discovery || null);
  setDeepConfigValue(base, 'canvasHost', infraJson?.canvasHost || null);
  setDeepConfigValue(base, 'talk', infraJson?.talk || null);
  setDeepConfigValue(base, 'web', runtimeJson?.web || null);
  setDeepConfigValue(base, 'nodeHost', runtimeJson?.nodeHost || null);
  setDeepConfigValue(base, 'secrets', runtimeJson?.secrets || null);
  setDeepConfigValue(base, 'auth', systemJson?.auth || null);
  setDeepConfigValue(base, 'acp', systemJson?.acp || null);
  setDeepConfigValue(base, 'cli', systemJson?.cli || null);
  setDeepConfigValue(base, 'bindings', systemJson?.bindings || null);
  setDeepConfigValue(base, 'broadcast', systemJson?.broadcast || null);
  setDeepConfigValue(base, 'audio', systemJson?.audio || null);

  return base;
}

/**
 * Sync shortcut button active state — no-op now that shortcuts
 * have been replaced by the Config Store modal.
 */
function syncShortcutActiveState() {
  // Shortcut buttons removed; config presets now applied via Config Store modal.
}

function numOrNull(value) {
  const text = sanitizeNumericText(value);
  return text ? Number(text) : null;
}

function buildSettingsPatch() {
  return {
    model: el('cfgModelInput').value.trim() || null,
    model_provider: el('cfgProviderInput').value.trim() || null,
    service_tier: el('cfgServiceTierSelect').value || null,
    personality: el('cfgPersonalityInput').value || null,
    approval_policy: el('cfgApprovalSelect').value || null,
    sandbox_mode: el('cfgSandboxSelect').value || null,
    model_reasoning_effort: el('cfgReasoningSelect').value || null,
    plan_mode_reasoning_effort: el('cfgPlanReasoningSelect').value || null,
    model_context_window: numOrNull(el('cfgContextWindowInput').value),
    model_auto_compact_token_limit: numOrNull(el('cfgCompactLimitInput').value),
    tool_output_token_limit: numOrNull(el('cfgToolLimitInput').value),
    sqlite_home: el('cfgSqliteHomeInput').value.trim() || null,
    hide_agent_reasoning: el('cfgHideReasoningCheck').checked,
    show_raw_agent_reasoning: el('cfgShowRawReasoningCheck').checked,
    disable_response_storage: el('cfgDisableStorageCheck').checked,
    compact_prompt: buildCompactPromptSetting(),
    check_for_update_on_startup: el('cfgUpdateCheck').checked,
    instructions: el('cfgInstructionsTextarea').value.trim() || null,
    base_instructions: el('cfgBaseInstructionsTextarea').value.trim() || null,
    features: {
      shell_snapshot: el('cfgShellSnapshotCheck').checked,
    },
  };
}

function normalizeProviderKey(value = '') {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  if (!key) return '';
  if (/^\d/.test(key)) return `provider-${key}`;
  return key;
}

function isClaudeOauthLoggedIn(data = state.claudeCodeState) {
  const login = data?.login || {};
  return Boolean(login.loggedIn && String(login.method || '').toLowerCase() === 'oauth');
}

function isClaudeOfficialProvider(provider = {}) {
  const key = String(provider?.key || '').trim().toLowerCase();
  const baseUrl = normalizeClaudeBaseUrl(provider?.baseUrl || '');
  return key === 'official' || !baseUrl || /api\.anthropic\.com/i.test(baseUrl);
}

function ensurePlainObject(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  return value;
}

function buildClaudeCodeSettingsFromFields({
  fromConfigEditor = false,
  preserveSecretWhenEmpty = true,
  providerNameOverride = '',
  useGlobalEnvFallback = true,
  preferOauthForOfficial = false,
} = {}) {
  const currentSettings = cloneJson(state.claudeCodeState?.settings || {});
  const settings = ensurePlainObject(currentSettings, {});
  settings.env = ensurePlainObject(settings.env, {});
  settings.easyaiconfig = ensurePlainObject(settings.easyaiconfig, {});
  settings.easyaiconfig.providers = ensurePlainObject(settings.easyaiconfig.providers, {});

  const modelValue = fromConfigEditor
    ? readClaudeModelControl('ccCfgModelSelect', 'ccCfgModelCustom')
    : (el('modelSelect')?.value?.trim() || '');
  if (modelValue) settings.model = modelValue;
  else delete settings.model;

  if (fromConfigEditor) {
    settings.alwaysThinkingEnabled = Boolean(el('ccCfgAlwaysThinkingCheck')?.checked);
    settings.skipDangerousModePermissionPrompt = Boolean(el('ccCfgSkipDangerousPromptCheck')?.checked);
  } else {
    settings.alwaysThinkingEnabled = Boolean(settings.alwaysThinkingEnabled);
    settings.skipDangerousModePermissionPrompt = Boolean(settings.skipDangerousModePermissionPrompt);
  }

  const baseUrlText = fromConfigEditor
    ? (el('ccCfgBaseUrlInput')?.value?.trim() || '')
    : (el('baseUrlInput')?.value?.trim() || '');
  const apiKeyText = fromConfigEditor
    ? (el('ccCfgApiKeyInput')?.value?.trim() || '')
    : (el('apiKeyInput')?.value?.trim() || '');
  const authTokenText = fromConfigEditor
    ? (el('ccCfgAuthTokenInput')?.value?.trim() || '')
    : '';
  const normalizedBaseUrl = normalizeClaudeBaseUrl(baseUrlText);

  const manualProviderKey = normalizeProviderKey(fromConfigEditor
    ? (el('ccCfgProviderKeyInput')?.value?.trim() || '')
    : (el('claudeProviderKeyInput')?.value?.trim() || ''));
  const selectedKey = normalizeProviderKey(manualProviderKey || state.claudeSelectedProviderKey || '');
  const inferredKey = normalizeProviderKey(inferClaudeProviderKey(normalizedBaseUrl || ''));
  const selectedProvider = selectedKey ? ensurePlainObject(settings.easyaiconfig.providers[selectedKey], {}) : {};
  const selectedBaseUrl = normalizeClaudeBaseUrl(selectedProvider.baseUrl || '');
  const keepSelectedKey = Boolean(selectedKey) && (!normalizedBaseUrl || selectedBaseUrl === normalizedBaseUrl);
  const providerKey = manualProviderKey || (keepSelectedKey ? selectedKey : (inferredKey || selectedKey || 'official'));
  const providers = settings.easyaiconfig.providers;
  const existingProvider = ensurePlainObject(providers[providerKey], {});

  const forceOauth = preferOauthForOfficial
    && !authTokenText
    && !apiKeyText
    && isClaudeOauthLoggedIn()
    && (providerKey === 'official' || !normalizedBaseUrl || /api\.anthropic\.com/i.test(normalizedBaseUrl));

  let finalAuthToken = authTokenText;
  let finalApiKey = '';
  if (forceOauth) {
    finalAuthToken = '';
    finalApiKey = '';
  } else if (finalAuthToken) {
    finalApiKey = '';
  } else if (apiKeyText) {
    finalApiKey = apiKeyText;
  } else if (preserveSecretWhenEmpty) {
    const fallbackAuth = String(existingProvider.authToken || (useGlobalEnvFallback ? settings.env.ANTHROPIC_AUTH_TOKEN : '') || '').trim();
    const fallbackApi = String(existingProvider.apiKey || (useGlobalEnvFallback ? settings.env.ANTHROPIC_API_KEY : '') || '').trim();
    finalAuthToken = fallbackAuth;
    finalApiKey = finalAuthToken ? '' : fallbackApi;
  }

  if (normalizedBaseUrl) settings.env.ANTHROPIC_BASE_URL = normalizedBaseUrl;
  else delete settings.env.ANTHROPIC_BASE_URL;

  if (forceOauth) {
    delete settings.env.ANTHROPIC_AUTH_TOKEN;
    delete settings.env.ANTHROPIC_API_KEY;
  } else if (finalAuthToken) {
    settings.env.ANTHROPIC_AUTH_TOKEN = finalAuthToken;
    delete settings.env.ANTHROPIC_API_KEY;
  } else if (finalApiKey) {
    settings.env.ANTHROPIC_API_KEY = finalApiKey;
    delete settings.env.ANTHROPIC_AUTH_TOKEN;
  } else if (!preserveSecretWhenEmpty) {
    delete settings.env.ANTHROPIC_API_KEY;
    delete settings.env.ANTHROPIC_AUTH_TOKEN;
  }

  const providerNameRaw = String(providerNameOverride || existingProvider.name || '').trim();
  const providerName = String(providerNameRaw || inferClaudeProviderLabel(normalizedBaseUrl || '') || providerKey).trim();
  providers[providerKey] = {
    ...existingProvider,
    name: providerName,
    baseUrl: normalizedBaseUrl,
    apiKey: finalApiKey || '',
    authToken: finalAuthToken || '',
    model: modelValue || '',
    updatedAt: new Date().toISOString(),
  };

  settings.easyaiconfig.activeProvider = providerKey;
  state.claudeSelectedProviderKey = providerKey;
  return settings;
}

async function saveClaudeCodeSettingsJson(settings) {
  const json = await api('/api/claudecode/raw-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      settingsJson: JSON.stringify(settings || {}, null, 2),
    }),
  });
  return json;
}

function buildClaudeCodeResetSettingsPreservingProviders() {
  const currentSettings = ensurePlainObject(cloneJson(state.claudeCodeState?.settings || {}), {});
  const currentEnv = ensurePlainObject(currentSettings.env, {});
  const easy = ensurePlainObject(currentSettings.easyaiconfig, {});
  const providers = ensurePlainObject(cloneJson(easy.providers || {}), {});
  const providerKeys = Object.keys(providers);
  let activeProviderKey = normalizeProviderKey(easy.activeProvider || state.claudeSelectedProviderKey || '');
  if (!activeProviderKey || !providers[activeProviderKey]) {
    activeProviderKey = normalizeProviderKey(providerKeys[0] || inferClaudeProviderKey(currentEnv.ANTHROPIC_BASE_URL || '') || 'official');
  }
  const activeProvider = ensurePlainObject(providers[activeProviderKey], {});

  const baseUrl = normalizeClaudeBaseUrl(activeProvider.baseUrl || currentEnv.ANTHROPIC_BASE_URL || '');
  const authToken = String(activeProvider.authToken || currentEnv.ANTHROPIC_AUTH_TOKEN || '').trim();
  const apiKey = authToken ? '' : String(activeProvider.apiKey || currentEnv.ANTHROPIC_API_KEY || '').trim();
  const model = String(activeProvider.model || currentSettings.model || '').trim();
  const nextEasy = ensurePlainObject(cloneJson(easy), {});
  nextEasy.providers = providers;
  if (activeProviderKey) nextEasy.activeProvider = activeProviderKey;

  const nextSettings = {
    env: {},
    model: model || undefined,
    alwaysThinkingEnabled: false,
    skipDangerousModePermissionPrompt: false,
    easyaiconfig: nextEasy,
  };
  if (baseUrl) nextSettings.env.ANTHROPIC_BASE_URL = baseUrl;
  if (authToken) nextSettings.env.ANTHROPIC_AUTH_TOKEN = authToken;
  else if (apiKey) nextSettings.env.ANTHROPIC_API_KEY = apiKey;
  return nextSettings;
}

async function resetConfigEditorPreservingProviders() {
  const tool = getConfigEditorTool();
  if (tool !== 'codex' && tool !== 'claudecode') return flash('当前工具暂不支持重置', 'warning');
  const confirmed = window.confirm(tool === 'claudecode'
    ? '将重置 Claude Code 的非 Provider 配置，并保留 Provider 列表与当前 Provider。\n\n是否继续？'
    : '将重置 Codex 配置，并保留 Provider / auth.json。\n\n是否继续？');
  if (!confirmed) return;

  setBusy('resetConfigEditorBtn', true, '重置中...');
  try {
    if (tool === 'claudecode') {
      const saved = await saveClaudeCodeSettingsJson(buildClaudeCodeResetSettingsPreservingProviders());
      if (!saved.ok) return flash(saved.error || 'Claude Code 配置重置失败', 'error');
      await loadClaudeCodeQuickState({ force: false, cacheOnly: false });
      populateConfigEditor();
      flash('Claude Code 配置已重置（Provider 保留）', 'success');
      return;
    }

    const json = await api('/api/config/raw-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: el('scopeSelect').value,
        projectPath: el('projectPathInput').value.trim(),
        codexHome: el('codexHomeInput').value.trim(),
        configToml: '',
      }),
    });
    if (!json.ok) return flash(json.error || 'Codex 配置重置失败', 'error');
    await loadState({ preserveForm: false });
    populateConfigEditor();
    flash('Codex 配置已重置（Provider 保留）', 'success');
  } catch (error) {
    flash(`配置重置失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    setBusy('resetConfigEditorBtn', false);
  }
}

function seedClaudeProviderCreateModal() {
  renderClaudeModelPresetList();
  const currentBaseUrl = normalizeClaudeBaseUrl(el('ccCfgBaseUrlInput')?.value?.trim() || '');
  const currentModel = readClaudeModelControl('ccCfgModelSelect', 'ccCfgModelCustom');
  const inferredKey = normalizeProviderKey(inferClaudeProviderKey(currentBaseUrl || '')) || 'official';
  if (el('ccProviderCreateKey')) el('ccProviderCreateKey').value = inferredKey;
  if (el('ccProviderCreateName')) el('ccProviderCreateName').value = inferClaudeProviderLabel(currentBaseUrl || '') || inferredKey;
  if (el('ccProviderCreateBaseUrl')) el('ccProviderCreateBaseUrl').value = currentBaseUrl;
  if (el('ccProviderCreateModelSelect')) {
    renderClaudeModelSelect('ccProviderCreateModelSelect', {
      usedModels: state.claudeCodeState?.usedModels || [],
      currentModel,
    });
    el('ccProviderCreateModelSelect').value = isClaudePresetModel(currentModel) ? currentModel : '';
  }
  if (el('ccProviderCreateModelCustom')) {
    el('ccProviderCreateModelCustom').value = currentModel && !isClaudePresetModel(currentModel) ? currentModel : '';
  }
  if (el('ccProviderCreateApiKey')) el('ccProviderCreateApiKey').value = '';
  if (el('ccProviderCreateAuthToken')) el('ccProviderCreateAuthToken').value = '';
}

function openClaudeProviderCreateModal() {
  seedClaudeProviderCreateModal();
  el('ccProviderCreateModal')?.classList.remove('hide');
}

function closeClaudeProviderCreateModal() {
  el('ccProviderCreateModal')?.classList.add('hide');
}

async function createClaudeProviderFromModal() {
  const baseUrl = normalizeClaudeBaseUrl(el('ccProviderCreateBaseUrl')?.value?.trim() || '');
  const providerKey = normalizeProviderKey(el('ccProviderCreateKey')?.value?.trim() || inferClaudeProviderKey(baseUrl || ''));
  const providerName = (el('ccProviderCreateName')?.value?.trim() || inferClaudeProviderLabel(baseUrl || '') || providerKey).trim();
  const modelPreset = el('ccProviderCreateModelSelect')?.value?.trim() || '';
  const modelCustom = el('ccProviderCreateModelCustom')?.value?.trim() || '';
  const model = modelCustom || modelPreset;
  const apiKey = el('ccProviderCreateApiKey')?.value?.trim() || '';
  const authToken = el('ccProviderCreateAuthToken')?.value?.trim() || '';
  if (!providerKey) return { ok: false, error: 'Provider Key 无效' };

  if (el('ccProviderFormKey')) el('ccProviderFormKey').value = providerKey;
  if (el('ccProviderFormName')) el('ccProviderFormName').value = providerName;
  if (el('ccProviderFormBaseUrl')) el('ccProviderFormBaseUrl').value = baseUrl;
  setClaudeModelControl('ccProviderFormModelSelect', 'ccProviderFormModelCustom', model, state.claudeCodeState?.usedModels || []);
  if (el('ccProviderFormApiKey')) el('ccProviderFormApiKey').value = apiKey;
  if (el('ccProviderFormAuthToken')) el('ccProviderFormAuthToken').value = authToken;
  state.claudeProviderDetailKey = providerKey;

  const saved = await saveClaudeProviderFormInConfigEditor({ switchOnly: false });
  if (!saved.ok) return saved;
  return { ok: true, providerKey };
}

async function saveClaudeProviderFormInConfigEditor({ switchOnly = false, provider } = {}) {
  if (provider) populateClaudeProviderEditorForm(provider);
  if (switchOnly) {
    if (el('ccCfgApiKeyInput')) el('ccCfgApiKeyInput').value = '';
    if (el('ccCfgAuthTokenInput')) el('ccCfgAuthTokenInput').value = '';
  }
  const { providerKey, providerName } = applyClaudeProviderFormToConfigEditor({ includeSecrets: !switchOnly });
  if (!providerKey) return { ok: false, error: 'Provider Key 不能为空' };
  const nextSettings = buildClaudeCodeSettingsFromFields({
    fromConfigEditor: true,
    providerNameOverride: providerName || provider?.name || '',
    useGlobalEnvFallback: false,
    preferOauthForOfficial: switchOnly,
  });
  const saved = await saveClaudeCodeSettingsJson(nextSettings);
  if (!saved.ok) return saved;
  await loadClaudeCodeQuickState({ force: false, cacheOnly: false });
  populateClaudeCodeConfigEditor();
  return { ok: true, providerKey };
}

async function saveConfigEditor() {
  setBusy('saveConfigEditorBtn', true, '保存中...');

  // ── OpenCode save ──
  if (getConfigEditorTool() === 'opencode') {
    const rawEl = el('opCfgRawJsonTextarea');
    const rawEdited = Boolean(rawEl && rawEl.value.trim() && rawEl.value !== (state.opencodeState?.configJson || ''));
    let json;
    if (rawEdited) {
      json = await api('/api/opencode/raw-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: el('scopeSelect')?.value || 'global',
          projectPath: el('projectPathInput')?.value?.trim() || '',
          configJson: rawEl?.value || '{}',
        }),
      });
    } else {
      try {
        json = await api('/api/opencode/config-save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: el('scopeSelect')?.value || 'global',
            projectPath: el('projectPathInput')?.value?.trim() || '',
            configJson: JSON.stringify(buildOpenCodeConfigFromFields(), null, 2),
          }),
        });
      } catch (error) {
        setBusy('saveConfigEditorBtn', false);
        return flash(error instanceof Error ? error.message : String(error), 'error');
      }
    }
    setBusy('saveConfigEditorBtn', false);
    if (!json.ok) return flash(json.error || 'OpenCode 配置保存失败', 'error');
    flash('OpenCode 配置已保存', 'success');
    await loadOpenCodeQuickState();
    populateConfigEditor();
    return;
  }

  // ── OpenClaw save ──
  if (getConfigEditorTool() === 'openclaw') {
    const rawEl = el('ocCfgRawJsonTextarea');
    const rawEdited = rawEl && rawEl.value.trim() && rawEl.value !== (state.openclawState?.configJson || '');
    let configJson = rawEl?.value || '';
    if (!rawEdited) {
      try {
        configJson = JSON.stringify(buildOpenClawConfigFromForm(), null, 2);
      } catch (error) {
        setBusy('saveConfigEditorBtn', false);
        return flash(error instanceof Error ? error.message : String(error), 'error');
      }
    }
    const json = await api('/api/openclaw/config-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configJson }),
    });
    setBusy('saveConfigEditorBtn', false);
    if (!json.ok) return flash(json.error || 'OpenClaw 配置保存失败', 'error');
    flash('OpenClaw 配置已保存', 'success');
    // Refresh state
    await loadOpenClawQuickState();
    populateConfigEditor();
    return;
  }

  // ── Claude Code save ──
  if (getConfigEditorTool() === 'claudecode') {
    const rawEl = el('ccCfgRawJsonTextarea');
    const rawEdited = Boolean(rawEl && rawEl.value.trim() && rawEl.value !== (state.claudeCodeState?.settingsJson || ''));
    const json = rawEdited
      ? await api('/api/claudecode/raw-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settingsJson: rawEl?.value || '{}' }),
      })
      : await saveClaudeCodeSettingsJson(buildClaudeCodeSettingsFromFields({
        fromConfigEditor: true,
        preferOauthForOfficial: true,
      }));
    setBusy('saveConfigEditorBtn', false);
    if (!json.ok) return flash(json.error || 'Claude Code 配置保存失败', 'error');
    flash('Claude Code 配置已保存', 'success');
    await loadClaudeCodeQuickState({ force: false, cacheOnly: false });
    populateConfigEditor();
    return;
  }

  // ── Codex save (default) ──
  const tomlEl = el('cfgRawTomlTextarea');
  const rawEdited = Boolean(tomlEl && tomlEl.value.trim() && tomlEl.value !== (state.current?.configToml || ''));
  const json = rawEdited
    ? await api('/api/config/raw-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: el('scopeSelect').value,
        projectPath: el('projectPathInput').value.trim(),
        codexHome: el('codexHomeInput').value.trim(),
        configToml: tomlEl?.value || '',
      }),
    })
    : await api('/api/config/settings-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: el('scopeSelect').value,
        projectPath: el('projectPathInput').value.trim(),
        codexHome: el('codexHomeInput').value.trim(),
        settings: buildSettingsPatch(),
      }),
    });
  setBusy('saveConfigEditorBtn', false);
  if (!json.ok) return flash(json.error || '配置保存失败', 'error');
  flash('当前配置已保存', 'success');
  await loadState({ preserveForm: true });
  populateConfigEditor();
}

async function saveRawConfigEditor() {
  setBusy('saveRawConfigEditorBtn', true, '保存中...');
  const authJsonVal = el('cfgRawAuthTextarea')?.value || '';
  const json = await api('/api/config/raw-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: el('scopeSelect').value,
      projectPath: el('projectPathInput').value.trim(),
      codexHome: el('codexHomeInput').value.trim(),
      configToml: el('cfgRawTomlTextarea').value,
      authJson: authJsonVal.trim() || undefined,
    }),
  });
  setBusy('saveRawConfigEditorBtn', false);
  if (!json.ok) return false;
  flash('配置已保存', 'success');
  await loadState({ preserveForm: true });
  populateConfigEditor();
  return true;
}

async function applyConfigEditor() {
  setBusy('applyConfigEditorBtn', true, '生效中...');

  // ── OpenCode apply ──
  if (getConfigEditorTool() === 'opencode') {
    const rawEl = el('opCfgRawJsonTextarea');
    const rawEdited = Boolean(rawEl && rawEl.value.trim() && rawEl.value !== (state.opencodeState?.configJson || ''));
    let json;
    if (rawEdited) {
      json = await api('/api/opencode/raw-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: el('scopeSelect')?.value || 'global',
          projectPath: el('projectPathInput')?.value?.trim() || '',
          configJson: rawEl?.value || '{}',
        }),
      });
    } else {
      try {
        json = await api('/api/opencode/config-save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: el('scopeSelect')?.value || 'global',
            projectPath: el('projectPathInput')?.value?.trim() || '',
            configJson: JSON.stringify(buildOpenCodeConfigFromFields(), null, 2),
          }),
        });
      } catch (error) {
        setBusy('applyConfigEditorBtn', false);
        return flash(error instanceof Error ? error.message : String(error), 'error');
      }
    }
    setBusy('applyConfigEditorBtn', false);
    if (!json.ok) return flash(json.error || 'OpenCode 配置保存失败', 'error');
    await loadOpenCodeQuickState();
    populateConfigEditor();
    await launchOpenCodeOnly();
    return;
  }

  // ── OpenClaw apply ──
  if (getConfigEditorTool() === 'openclaw') {
    const rawEl = el('ocCfgRawJsonTextarea');
    const rawEdited = rawEl && rawEl.value.trim() && rawEl.value !== (state.openclawState?.configJson || '');
    let configJson = rawEl?.value || '';
    if (!rawEdited) {
      try {
        configJson = JSON.stringify(buildOpenClawConfigFromForm(), null, 2);
      } catch (error) {
        setBusy('applyConfigEditorBtn', false);
        return flash(error instanceof Error ? error.message : String(error), 'error');
      }
    }
    const json = await api('/api/openclaw/config-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configJson }),
    });
    setBusy('applyConfigEditorBtn', false);
    if (!json.ok) return flash(json.error || 'OpenClaw 配置保存失败', 'error');
    await loadOpenClawQuickState();
    populateConfigEditor();
    // Launch OpenClaw after saving
    try {
      const launch = await api('/api/openclaw/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: el('launchCwdInput')?.value?.trim() || '' }),
      });
      if (launch.ok && launch.data?.gatewayUrl) {
        flash('配置已生效，OpenClaw Gateway 启动中', 'success');
        await repairOpenClawDashboard({ silent: true });
      } else {
        flash(launch.data?.message || '配置已保存', 'success');
      }
    } catch (e) {
      flash('配置已保存，但启动失败：' + e.message, 'warn');
    }
    return;
  }

  // ── Claude Code apply ──
  if (getConfigEditorTool() === 'claudecode') {
    const rawEl = el('ccCfgRawJsonTextarea');
    const rawEdited = Boolean(rawEl && rawEl.value.trim() && rawEl.value !== (state.claudeCodeState?.settingsJson || ''));
    const json = rawEdited
      ? await api('/api/claudecode/raw-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settingsJson: rawEl?.value || '{}' }),
      })
      : await saveClaudeCodeSettingsJson(buildClaudeCodeSettingsFromFields({ fromConfigEditor: true }));
    setBusy('applyConfigEditorBtn', false);
    if (!json.ok) return flash(json.error || 'Claude Code 配置保存失败', 'error');
    await loadClaudeCodeQuickState({ force: false, cacheOnly: false });
    populateConfigEditor();
    await launchClaudeCodeOnly();
    return;
  }

  // ── Codex apply (default) ──
  const tomlEl = el('cfgRawTomlTextarea');
  const rawEdited = Boolean(tomlEl && tomlEl.value.trim() && tomlEl.value !== (state.current?.configToml || ''));
  const json = rawEdited
    ? await api('/api/config/raw-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: el('scopeSelect').value,
        projectPath: el('projectPathInput').value.trim(),
        codexHome: el('codexHomeInput').value.trim(),
        configToml: tomlEl?.value || '',
      }),
    })
    : await api('/api/config/settings-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: el('scopeSelect').value,
        projectPath: el('projectPathInput').value.trim(),
        codexHome: el('codexHomeInput').value.trim(),
        settings: buildSettingsPatch(),
      }),
    });
  setBusy('applyConfigEditorBtn', false);
  if (!json.ok) return flash(json.error || '表单配置保存失败', 'error');
  await loadState({ preserveForm: true });
  populateConfigEditor();
  await launchCodex('applyConfigEditorBtn', '配置已生效并启动 Codex');
}

async function applyRawConfigEditor() {
  setBusy('applyRawConfigEditorBtn', true, '生效中...');
  const saved = await saveRawConfigEditor();
  setBusy('applyRawConfigEditorBtn', false);
  if (!saved) return flash('原始 TOML 生效失败', 'error');
  await launchCodex('applyRawConfigEditorBtn', '原始 TOML 已生效并启动 Codex');
}

function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    const withScheme = /^[a-z]+:\/\//i.test(raw)
      ? raw
      : (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(raw) ? `http://${raw}` : `https://${raw}`);
    const url = new URL(withScheme);
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

const COMMON_PROVIDER_HOST_SUFFIXES = new Set([
  'ac', 'ai', 'app', 'cc', 'cloud', 'cn', 'co', 'com', 'dev', 'fm', 'gg', 'hk', 'in', 'io', 'jp',
  'me', 'net', 'org', 'pro', 'ru', 'sg', 'sh', 'site', 'tech', 'top', 'tv', 'tw', 'uk', 'us', 'xyz',
]);

function inferSeed(baseUrl) {
  try {
    const parts = new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase().split('.').filter(Boolean);
    if (!parts.length) return 'custom';

    while (parts.length > 1) {
      const last = parts[parts.length - 1];
      if (COMMON_PROVIDER_HOST_SUFFIXES.has(last)) {
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

function inferProviderKey(baseUrl) {
  const slug = inferSeed(baseUrl).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return 'custom';
  return /^\d/.test(slug) ? `provider-${slug}` : slug;
}

function inferProviderLabel(baseUrl) {
  return inferSeed(baseUrl)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferEnvKey(providerKey) {
  return providerKey.replace(/-/g, '_').toUpperCase() + '_API_KEY';
}

const CODEX_OFFICIAL_PROVIDER_KEY = 'openai';
const CODEX_OFFICIAL_BASE_URL = 'https://api.openai.com/v1';

function buildCodexOfficialProvider(login = {}, providers = []) {
  const loggedIn = Boolean(login?.loggedIn);
  const method = String(login?.method || '').toLowerCase();
  if (!loggedIn || method !== 'chatgpt') return null;

  const hasOpenAiProvider = (Array.isArray(providers) ? providers : []).some((provider) => {
    const key = String(provider?.key || '').trim().toLowerCase();
    const baseUrl = normalizeBaseUrl(provider?.baseUrl || '');
    return key === CODEX_OFFICIAL_PROVIDER_KEY || baseUrl === CODEX_OFFICIAL_BASE_URL;
  });
  if (hasOpenAiProvider) return null;

  return {
    key: CODEX_OFFICIAL_PROVIDER_KEY,
    name: 'OpenAI Official',
    baseUrl: CODEX_OFFICIAL_BASE_URL,
    envKey: 'OPENAI_API_KEY',
    wireApi: 'responses',
    hasInlineBearerToken: false,
    isActive: false,
    hasApiKey: false,
    maskedApiKey: '',
    keySource: 'oauth',
    resolvedKeyName: 'OPENAI_API_KEY',
    inferred: true,
    historyOnly: false,
  };
}

const CODEX_PROVIDER_HISTORY_STORAGE_KEY = 'easyaiconfig_codex_provider_history_v1';
const CODEX_PROVIDER_HISTORY_MAX = 80;

function codexProviderHistoryId(provider = {}) {
  const key = String(provider?.key || '').trim().toLowerCase();
  return key || '';
}

function normalizeCodexProviderHistoryItem(item = {}) {
  const key = String(item.key || '').trim();
  if (!key) return null;
  const lastSeenAt = Number(item.lastSeenAt) || Date.now();
  const firstSeenAt = Number(item.firstSeenAt) || lastSeenAt;
  return {
    key,
    name: String(item.name || key).trim() || key,
    baseUrl: normalizeBaseUrl(String(item.baseUrl || '').trim()),
    envKey: String(item.envKey || '').trim(),
    wireApi: String(item.wireApi || 'responses').trim() || 'responses',
    firstSeenAt,
    lastSeenAt,
  };
}

function readCodexProviderHistory() {
  try {
    const raw = localStorage.getItem(CODEX_PROVIDER_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : []);
    return list
      .map((item) => normalizeCodexProviderHistoryItem(item))
      .filter(Boolean)
      .sort((left, right) => (right.lastSeenAt || 0) - (left.lastSeenAt || 0));
  } catch {
    return [];
  }
}

function writeCodexProviderHistory(items = []) {
  try {
    const normalized = items
      .map((item) => normalizeCodexProviderHistoryItem(item))
      .filter(Boolean)
      .sort((left, right) => (right.lastSeenAt || 0) - (left.lastSeenAt || 0))
      .slice(0, CODEX_PROVIDER_HISTORY_MAX);
    localStorage.setItem(CODEX_PROVIDER_HISTORY_STORAGE_KEY, JSON.stringify({ items: normalized }));
  } catch {
    // Ignore storage errors (private mode / quota / disabled storage).
  }
}

function persistCodexProviderHistory(currentProviders = []) {
  const historyMap = new Map();
  readCodexProviderHistory().forEach((item) => {
    const id = codexProviderHistoryId(item);
    if (id) historyMap.set(id, item);
  });
  const now = Date.now();
  currentProviders.forEach((provider) => {
    const id = codexProviderHistoryId(provider);
    if (!id) return;
    const previous = historyMap.get(id) || null;
    historyMap.set(id, normalizeCodexProviderHistoryItem({
      key: provider.key,
      name: provider.name || previous?.name || provider.key,
      baseUrl: provider.baseUrl || previous?.baseUrl || '',
      envKey: provider.envKey || previous?.envKey || '',
      wireApi: provider.wireApi || previous?.wireApi || 'responses',
      firstSeenAt: previous?.firstSeenAt || now,
      lastSeenAt: now,
    }));
  });
  writeCodexProviderHistory([...historyMap.values()]);
}

function mergeCodexProvidersWithHistory(currentProviders = []) {
  const merged = currentProviders.map((provider) => ({ ...provider, historyOnly: false }));
  const existing = new Set(merged.map((provider) => codexProviderHistoryId(provider)).filter(Boolean));
  readCodexProviderHistory().forEach((item) => {
    const id = codexProviderHistoryId(item);
    if (!id || existing.has(id)) return;
    merged.push({
      key: item.key,
      name: item.name || item.key,
      baseUrl: item.baseUrl || '',
      envKey: item.envKey || '',
      wireApi: item.wireApi || 'responses',
      hasInlineBearerToken: false,
      isActive: false,
      hasApiKey: false,
      maskedApiKey: '',
      keySource: 'history',
      resolvedKeyName: item.envKey || '',
      inferred: false,
      historyOnly: true,
    });
  });
  return merged;
}

function normalizeClaudeBaseUrl(baseUrl = '') {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withScheme);
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

function inferClaudeProviderKey(baseUrl = '') {
  const normalized = normalizeClaudeBaseUrl(baseUrl);
  if (!normalized || /api\.anthropic\.com/i.test(normalized)) return 'official';
  try {
    const host = new URL(normalized).hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    const ignored = new Set(['api', 'anthropic', 'claude', 'gateway', 'chat', 'www']);
    const seed = parts.find((part) => !ignored.has(part) && /[a-z]/.test(part)) || host;
    const slug = seed.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return 'custom';
    return /^\d/.test(slug) ? `provider-${slug}` : slug;
  } catch {
    return 'custom';
  }
}

function inferClaudeProviderLabel(baseUrl = '') {
  const normalized = normalizeClaudeBaseUrl(baseUrl);
  if (!normalized || /api\.anthropic\.com/i.test(normalized)) return 'Anthropic Official';
  const seed = inferClaudeProviderKey(normalized);
  return seed
    .replace(/^provider-/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Custom Provider';
}

function getClaudeProviderProfiles(data = state.claudeCodeState) {
  const settings = data?.settings && typeof data.settings === 'object' ? data.settings : {};
  const settingsEnv = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const runtimeEnv = data?.envVars && typeof data.envVars === 'object' ? data.envVars : {};
  const easy = settings.easyaiconfig && typeof settings.easyaiconfig === 'object' ? settings.easyaiconfig : {};
  const rawProviders = easy.providers && typeof easy.providers === 'object' ? easy.providers : {};
  const activeProviderKey = String(easy.activeProvider || '').trim();
  const oauthLoggedIn = isClaudeOauthLoggedIn(data);

  const providers = Object.entries(rawProviders).map(([key, raw]) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const baseUrl = normalizeClaudeBaseUrl(item.baseUrl || '');
    const apiKey = String(item.apiKey || '').trim();
    const authToken = String(item.authToken || '').trim();
    const model = String(item.model || '').trim();
    return {
      key,
      name: String(item.name || inferClaudeProviderLabel(baseUrl || '')),
      baseUrl,
      apiKey,
      authToken,
      model,
      maskedApiKey: maskSecret(apiKey),
      maskedAuthToken: maskSecret(authToken),
      hasApiKey: Boolean(apiKey || authToken),
      isActive: activeProviderKey && activeProviderKey === key,
      source: 'settings.easyaiconfig.providers',
    };
  });

  const envBaseUrl = normalizeClaudeBaseUrl(
    settingsEnv.ANTHROPIC_BASE_URL
      || (runtimeEnv.ANTHROPIC_BASE_URL?.set ? (runtimeEnv.ANTHROPIC_BASE_URL.value || '') : ''),
  );
  const envApiKey = String(settingsEnv.ANTHROPIC_API_KEY || '').trim();
  const envAuthToken = String(settingsEnv.ANTHROPIC_AUTH_TOKEN || '').trim();
  const runtimeMaskedApiKey = runtimeEnv.ANTHROPIC_API_KEY?.set ? String(runtimeEnv.ANTHROPIC_API_KEY.masked || '').trim() : '';
  const runtimeMaskedAuthToken = runtimeEnv.ANTHROPIC_AUTH_TOKEN?.set ? String(runtimeEnv.ANTHROPIC_AUTH_TOKEN.masked || '').trim() : '';
  const hasRuntimeSecret = Boolean(runtimeMaskedApiKey || runtimeMaskedAuthToken);
  const runtimeProviderKey = activeProviderKey || inferClaudeProviderKey(envBaseUrl);
  if (hasRuntimeSecret) {
    const runtimeProvider = providers.find((provider) => provider.key === runtimeProviderKey);
    if (runtimeProvider) {
      if (!runtimeProvider.maskedApiKey) runtimeProvider.maskedApiKey = runtimeMaskedApiKey;
      if (!runtimeProvider.maskedAuthToken) runtimeProvider.maskedAuthToken = runtimeMaskedAuthToken;
      runtimeProvider.hasApiKey = true;
    }
  }
  const syntheticKey = activeProviderKey || inferClaudeProviderKey(envBaseUrl);
  const shouldAddSynthetic = !providers.length || Boolean(activeProviderKey || envBaseUrl || envApiKey || envAuthToken || hasRuntimeSecret);
  if (shouldAddSynthetic && !providers.some((provider) => provider.key === syntheticKey)) {
    providers.push({
      key: syntheticKey || 'official',
      name: inferClaudeProviderLabel(envBaseUrl || ''),
      baseUrl: envBaseUrl,
      apiKey: envApiKey,
      authToken: envAuthToken,
      model: String(settings.model || '').trim(),
      maskedApiKey: maskSecret(envApiKey) || runtimeMaskedApiKey,
      maskedAuthToken: maskSecret(envAuthToken) || runtimeMaskedAuthToken,
      hasApiKey: Boolean(envApiKey || envAuthToken || hasRuntimeSecret),
      isActive: true,
      source: envApiKey || envAuthToken ? 'settings.env' : hasRuntimeSecret ? 'runtime.env' : 'settings.env',
    });
  }

  if (oauthLoggedIn && !providers.some((provider) => provider.key === 'official')) {
    providers.push({
      key: 'official',
      name: 'Anthropic Official',
      baseUrl: '',
      apiKey: '',
      authToken: '',
      model: String(settings.model || '').trim(),
      maskedApiKey: '',
      maskedAuthToken: '',
      hasApiKey: false,
      isActive: activeProviderKey === 'official' || !activeProviderKey,
      source: 'oauth',
    });
  }

  if (!providers.some((provider) => provider.isActive) && providers.length) {
    providers[0].isActive = true;
  }

  providers.sort((left, right) => {
    if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
    return String(left.name || left.key).localeCompare(String(right.name || right.key), 'zh-CN');
  });

  return providers;
}

function getClaudeProviderByKey(providerKey = '') {
  const key = String(providerKey || '').trim();
  if (!key) return null;
  return getClaudeProviderProfiles().find((provider) => provider.key === key) || null;
}

function fillFromClaudeProvider(provider) {
  if (!provider) return;
  state.claudeSelectedProviderKey = provider.key || '';
  const providerKeyInput = el('claudeProviderKeyInput');
  if (providerKeyInput) providerKeyInput.value = provider.key || '';
  const modelSelect = el('modelSelect');
  if (modelSelect && provider.model) {
    let found = false;
    for (const option of modelSelect.options) {
      if (option.value === provider.model) {
        found = true;
        break;
      }
    }
    if (!found) {
      const option = document.createElement('option');
      option.value = provider.model;
      option.textContent = provider.model;
      modelSelect.appendChild(option);
    }
    modelSelect.value = provider.model;
  }
  const baseUrlInput = el('baseUrlInput');
  if (baseUrlInput) baseUrlInput.value = provider.baseUrl || '';
  const apiKeyInput = el('apiKeyInput');
  if (apiKeyInput) {
    apiKeyInput.value = '';
    apiKeyInput.type = 'password';
    if (provider.maskedAuthToken) {
      apiKeyInput.placeholder = `${provider.maskedAuthToken} (Auth Token)`;
    } else if (provider.maskedApiKey) {
      apiKeyInput.placeholder = `${provider.maskedApiKey} (API Key)`;
    } else {
      apiKeyInput.placeholder = 'ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN';
    }
  }
  syncApiKeyToggle();
  const detectionMeta = el('detectionMeta');
  if (detectionMeta) {
    detectionMeta.textContent = `已载入 ${provider.name || provider.key}`;
  }
}

async function quickSwitchClaudeProvider(provider) {
  if (!provider?.key) return { ok: false, error: 'Provider 无效' };
  fillFromClaudeProvider(provider);
  setBusy('saveBtn', true, '切换中...');
  const nextSettings = buildClaudeCodeSettingsFromFields({
    fromConfigEditor: false,
    useGlobalEnvFallback: false,
    preferOauthForOfficial: true,
  });
  const saved = await saveClaudeCodeSettingsJson(nextSettings);
  setBusy('saveBtn', false);
  if (!saved.ok) return saved;
  await loadClaudeCodeQuickState({ force: false, cacheOnly: false });
  renderCurrentConfig();
  return { ok: true };
}

function getCodexSwitchModelValue() {
  const inConfigEditor = state.activePage === 'configEditor' && getConfigEditorTool() === 'codex';
  if (inConfigEditor) {
    return el('cfgModelInput')?.value?.trim() || state.current?.summary?.model || '';
  }
  return el('modelSelect')?.value?.trim() || state.current?.summary?.model || '';
}

async function quickSwitchCodexProvider(provider) {
  if (!provider?.key) return { ok: false, error: 'Provider 无效' };
  const baseUrl = normalizeBaseUrl(provider.baseUrl || '');
  if (!baseUrl) return { ok: false, error: `Provider「${provider.name || provider.key}」缺少 Base URL` };

  const payload = {
    scope: el('scopeSelect')?.value || 'global',
    projectPath: el('projectPathInput')?.value?.trim() || '',
    codexHome: el('codexHomeInput')?.value?.trim() || '',
    providerKey: provider.key,
    providerLabel: String(provider.name || provider.key || '').trim(),
    envKey: String(provider.envKey || inferEnvKey(provider.key)).trim(),
    baseUrl,
    apiKey: '',
    model: getCodexSwitchModelValue(),
  };

  const saved = await api('/api/config/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!saved.ok) return saved;

  await loadState({ preserveForm: false });
  if (state.activePage === 'configEditor' && getConfigEditorTool() === 'codex') {
    populateConfigEditor();
  }
  renderCurrentConfig();
  return { ok: true, providerKey: provider.key };
}

async function testCodexProviderConnectivity(provider, { delayMs = 420 } = {}) {
  if (!provider?.key) return { ok: false, error: 'Provider 无效' };
  if (provider.historyOnly) {
    return { ok: false, error: '历史 Provider 需先切换并保存到当前配置后再检测' };
  }
  if (!provider.hasApiKey) {
    return { ok: false, error: `Provider「${provider.name || provider.key}」缺少已保存的 Key` };
  }
  if (!provider.baseUrl) {
    return { ok: false, error: `Provider「${provider.name || provider.key}」缺少 Base URL` };
  }

  state.providerHealth[provider.key] = { loading: true, checked: false, startedAt: Date.now() };
  renderCurrentConfig();
  renderProviders();

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const json = await api('/api/provider/test-saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: el('scopeSelect')?.value || 'global',
      projectPath: el('projectPathInput')?.value?.trim() || '',
      codexHome: el('codexHomeInput')?.value?.trim() || '',
      providerKey: provider.key,
      timeoutMs: 8000,
    }),
    timeoutMs: 10000,
  });

  state.providerHealth[provider.key] = { loading: false, checked: true, ok: Boolean(json?.ok) };
  renderCurrentConfig();
  renderProviders();

  if (!json?.ok) return { ok: false, error: json?.error || '连通性检测失败' };
  return { ok: true };
}

function claudeProviderConnectivityLabel(provider, data = state.claudeCodeState) {
  const health = state.claudeProviderHealth[provider.key];
  if (health?.loading) return { tone: 'muted', text: '检测中' };
  if (health?.checked) return health.ok ? { tone: 'ok', text: '已通' } : { tone: 'bad', text: '失败' };

  const login = data?.login || {};
  const method = String(login.method || '').toLowerCase();
  const isOfficial = provider.key === 'official' || /api\.anthropic\.com/i.test(provider.baseUrl || '');
  if (isOfficial && login.loggedIn && method === 'oauth') {
    return { tone: 'ok', text: '官方登录' };
  }
  if (!(provider.authToken || provider.apiKey)) return { tone: 'warn', text: '缺少 Key' };
  return { tone: 'muted', text: '待检测' };
}

async function testClaudeProviderConnectivity(provider, { delayMs = 420 } = {}) {
  if (!provider?.key) return { ok: false, error: 'Provider 无效' };
  const baseUrl = normalizeClaudeBaseUrl(provider.baseUrl || '') || 'https://api.anthropic.com';
  const secret = String(provider.authToken || provider.apiKey || '').trim();
  const login = state.claudeCodeState?.login || {};
  const loginMethod = String(login.method || '').toLowerCase();
  const isOfficial = provider.key === 'official' || /api\.anthropic\.com/i.test(provider.baseUrl || '');
  if (!secret && isOfficial && login.loggedIn && loginMethod === 'oauth') {
    state.claudeProviderHealth[provider.key] = { loading: false, checked: true, ok: true };
    if (getConfigEditorTool() === 'claudecode') populateClaudeCodeConfigEditor();
    return { ok: true };
  }
  if (!secret) return { ok: false, error: `Provider「${provider.name || provider.key}」缺少可用 Key` };

  state.claudeProviderHealth[provider.key] = { loading: true, checked: false, startedAt: Date.now() };
  if (getConfigEditorTool() === 'claudecode') populateClaudeCodeConfigEditor();

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const json = await api('/api/provider/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl,
      apiKey: secret,
      timeoutMs: 10000,
    }),
    timeoutMs: 12000,
  });

  state.claudeProviderHealth[provider.key] = { loading: false, checked: true, ok: Boolean(json?.ok) };
  if (getConfigEditorTool() === 'claudecode') populateClaudeCodeConfigEditor();

  if (!json?.ok) return { ok: false, error: json?.error || '连通性检测失败' };
  return { ok: true };
}

function modelScore(model) {
  const text = String(model || '').toLowerCase();
  if (!text) return -Infinity;
  if (/(embedding|tts|whisper|audio|image|moderation|realtime|transcribe)/.test(text)) return -Infinity;
  const parts = [...text.matchAll(/\d+/g)].map((item) => Number(item[0]));
  const numeric = parts.reduce((sum, value, index) => sum + (value / Math.pow(100, index)), 0);
  let score = numeric;
  if (text.startsWith('gpt')) score += 1000;
  if (text.includes('mini')) score -= 6;
  if (text.includes('nano')) score -= 10;
  if (text.includes('preview')) score -= 3;
  if (text.includes('codex')) score -= 1;
  return score;
}

function pickRecommendedModel(models = [], fallback = '') {
  const unique = [...new Set(models.filter(Boolean))];
  if (!unique.length) return fallback || '';
  const ranked = [...unique].sort((a, b) => modelScore(b) - modelScore(a) || a.localeCompare(b));
  return ranked[0] || fallback || '';
}

function resolveCodexProviderForSave(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const providers = Array.isArray(state.current?.providers) ? state.current.providers : [];
  const cachedProviderKey = String(state.apiKeyField?.providerKey || '').trim();
  const cachedBaseUrl = normalizeBaseUrl(state.apiKeyField?.baseUrl || '');

  const cachedProvider = cachedProviderKey
    ? providers.find((item) => item.key === cachedProviderKey)
    : null;
  if (cachedProvider && cachedBaseUrl && cachedBaseUrl === normalized) {
    return {
      providerKey: cachedProvider.key,
      providerLabel: String(cachedProvider.name || ''),
      envKey: String(cachedProvider.envKey || ''),
      reuseExisting: !cachedProvider.inferred && !cachedProvider.historyOnly,
    };
  }

  const matchedByBaseUrl = providers.find((item) => normalizeBaseUrl(item.baseUrl || '') === normalized);
  if (matchedByBaseUrl) {
    return {
      providerKey: matchedByBaseUrl.key,
      providerLabel: String(matchedByBaseUrl.name || ''),
      envKey: String(matchedByBaseUrl.envKey || ''),
      reuseExisting: !matchedByBaseUrl.inferred && !matchedByBaseUrl.historyOnly,
    };
  }

  const providerKey = inferProviderKey(normalized);
  return {
    providerKey,
    providerLabel: inferProviderLabel(normalized),
    envKey: inferEnvKey(providerKey),
    reuseExisting: false,
  };
}

function currentPayload() {
  if (state.activeTool === 'codex' && state.codexAuthView === 'official' && state.current?.login?.loggedIn) {
    return {
      scope: el('scopeSelect').value,
      projectPath: el('projectPathInput').value.trim(),
      codexHome: el('codexHomeInput').value.trim(),
      providerKey: CODEX_OFFICIAL_PROVIDER_KEY,
      providerLabel: 'OpenAI Official',
      envKey: 'OPENAI_API_KEY',
      baseUrl: CODEX_OFFICIAL_BASE_URL,
      apiKey: '',
      model: el('modelSelect').value,
    };
  }
  const baseUrl = normalizeBaseUrl(el('baseUrlInput').value);
  const provider = resolveCodexProviderForSave(baseUrl);
  const payload = {
    scope: el('scopeSelect').value,
    projectPath: el('projectPathInput').value.trim(),
    codexHome: el('codexHomeInput').value.trim(),
    providerKey: provider.providerKey,
    baseUrl,
    apiKey: getApiKeyForSubmit({ baseUrl, providerKey: provider.providerKey }),
    model: el('modelSelect').value,
  };
  if (!provider.reuseExisting) {
    payload.providerLabel = provider.providerLabel;
    payload.envKey = provider.envKey;
  }
  return payload;
}

function applyDerivedMeta(force = false) {
  // No-op: auto-inference fields removed from UI
}

function renderAppUpdateStatus() {
  const pill = el('appUpdatePill');
  const button = el('appUpdateBtn');
  if (!pill || !button) return;

  if (!tauriInvoke) {
    pill.textContent = 'Web 模式';
    pill.className = 'badge';
    button.hidden = true;
    return;
  }

  const info = state.appUpdate;
  if (!info) {
    pill.textContent = '客户端检测中';
    pill.className = 'badge';
    button.hidden = true;
    return;
  }

  if (!info.enabled) {
    pill.textContent = `客户端 v${info.currentVersion || '-'}`;
    pill.className = 'badge';
    button.hidden = true;
    return;
  }

  if (info.networkBlocked) {
    pill.textContent = '客户端更新源不可达';
    pill.className = 'badge warning';
    button.hidden = false;
    button.textContent = '检查更新';
    return;
  }

  if (info.available) {
    pill.textContent = `客户端 ${info.currentVersion || '-'} → ${info.version || '-'}`;
    pill.className = 'badge warning';
    button.hidden = false;
    button.textContent = '更新应用';
    return;
  }

  pill.textContent = `客户端 v${info.currentVersion || '-'}`;
  pill.className = 'badge success';
  button.hidden = false;
  button.textContent = '检查更新';
}

function renderStatus() {
  renderAppUpdateStatus();
  const codex = getToolBinaryStatus('codex', state.current?.codexBinary);

  // Sidebar badge
  const pill = el('codexPill');
  pill.className = `badge ${codex.installed ? 'success' : 'warning'}`;
  pill.textContent = codex.installed ? (codex.version || '已安装') : '未安装';

  // Tools page card
  const versionEl = el('toolCodexVersion');
  const badgeEl = el('toolCodexBadge');
  const updateBtn = el('updateCodexBtn');
  const reinstallBtn = el('reinstallCodexBtn');
  const uninstallBtn = el('uninstallCodexBtn');

  if (versionEl) {
    versionEl.textContent = codex.installed ? (codex.version || '已安装') : '未安装';
    versionEl.classList.toggle('tool-version-muted', !codex.installed);
  }
  if (badgeEl) {
    badgeEl.textContent = codex.installed ? '已安装' : '';
    badgeEl.className = `tool-badge ${codex.installed ? 'tool-badge-ok' : ''}`;
  }
  if (updateBtn) updateBtn.querySelector('span').textContent = codex.installed ? '更新' : '安装';
  if (reinstallBtn) reinstallBtn.hidden = !codex.installed;
  if (uninstallBtn) uninstallBtn.hidden = !codex.installed;
}

function renderQuickSummary() {
  // No-op: summary panel removed from Provider page
}

function providerHealthLabel(provider) {
  const item = state.providerHealth[provider.key];
  const login = state.current?.login || {};
  const isOfficial = String(provider?.key || '').toLowerCase() === CODEX_OFFICIAL_PROVIDER_KEY
    || normalizeBaseUrl(provider?.baseUrl || '') === CODEX_OFFICIAL_BASE_URL;
  if (provider.historyOnly) return { text: '历史', tone: 'muted' };
  if (isOfficial && login.loggedIn && String(login.method || '').toLowerCase() === 'chatgpt') {
    return { text: 'OAuth', tone: 'ok' };
  }
  if (!provider.hasApiKey) return { text: '缺少 Key', tone: 'warn' };
  if (!item) return { text: '待检测', tone: 'muted' };
  if (item.loading) return { text: '检测中', tone: 'muted' };
  if (item.ok) return { text: '已通', tone: 'ok' };
  return { text: '失败', tone: 'bad' };
}

function renderCurrentConfig() {
  // Keep the new connection hub in sync with every state change that the legacy
  // rail re-render covers. Hub-layer render is cheap and side-effect-free.
  // Reach via window.* because this file is an ES module — bare identifier
  // wouldn't resolve across module/IIFE scopes.
  try { window.renderConnectionHub?.(); } catch (_) { /* hub optional during early boot */ }

  // ── Claude Code tab ──
  if (state.activeTool === 'claudecode') {
    const cc = state.claudeCodeState;
    if (!isClaudeCodeInstalled(cc)) {
      el('currentConfigMain').innerHTML = '<span class="current-provider">Claude Code</span><span class="current-model">未安装</span>';
      el('currentConfigMeta').innerHTML = '<span class="provider-pill warn">未安装</span><span class="meta-sep">·</span><span class="current-url">请先安装 Claude Code</span>';
      el('providerDropdown').innerHTML = '<div class="provider-empty">当前还没安装 Claude Code，请先安装后再配置。</div>';
      el('providerDropdown').classList.add('hide');
      el('providerSwitchBtn').setAttribute('aria-expanded', 'false');
      state.quickTips = [
        '当前未检测到 claude 命令',
        '先点下方“安装 Claude Code”自动安装',
        '安装成功后再显示 OAuth、API Key、模型等配置项',
      ];
      applyClaudeCodeQuickInstallState(cc || {});
      renderQuickRailSupportPanel();
      return;
    }
    const model = cc?.model || el('modelSelect')?.value || '未选择模型';
    const login = cc?.login || {};
    const providers = getClaudeProviderProfiles(cc);
    const activeProvider = providers.find((provider) => provider.key === state.claudeSelectedProviderKey)
      || providers.find((provider) => provider.isActive)
      || providers[0]
      || null;
    state.claudeSelectedProviderKey = activeProvider?.key || '';

    let providerName = activeProvider?.name || 'Claude Code';
    if (!activeProvider && login.orgName) providerName = login.orgName;
    else if (!activeProvider && login.email) providerName = login.email;

    let statusText, statusTone;
    const loginMethod = String(login.method || '').toLowerCase();
    const activeOfficial = isClaudeOfficialProvider(activeProvider || {});
    const activeHasKey = Boolean(activeProvider?.hasApiKey);
    const activeOauthReady = activeOfficial && isClaudeOauthLoggedIn(cc);
    if (activeHasKey) { statusText = 'API Key'; statusTone = 'ok'; }
    else if (activeOauthReady) { statusText = 'OAuth'; statusTone = 'ok'; }
    else if (login.loggedIn && (loginMethod === 'api_key' || loginMethod === 'keychain')) { statusText = 'API Key'; statusTone = 'ok'; }
    else if (login.loggedIn && loginMethod === 'oauth') { statusText = 'OAuth'; statusTone = 'ok'; }
    else if (cc?.maskedApiKey) { statusText = '已配置 Key'; statusTone = 'ok'; }
    else { statusText = '未认证'; statusTone = 'warn'; }

    const ev = cc?.envVars || {};
    const baseUrl = activeProvider?.baseUrl || (ev.ANTHROPIC_BASE_URL?.set ? ev.ANTHROPIC_BASE_URL.value : 'https://api.anthropic.com');

    el('currentConfigMain').innerHTML = `<span class="current-provider">${escapeHtml(providerName)}</span><span class="current-model">${escapeHtml(model || '-')}</span>`;
    const providerKeyLabel = activeProvider?.key ? activeProvider.key : 'active';
    el('currentConfigMeta').innerHTML = `状态 <span class="provider-pill ${statusTone}">${escapeHtml(statusText)}</span><span class="meta-sep">·</span><span class="provider-pill ok">${escapeHtml(providerKeyLabel)}</span><span class="meta-sep">·</span><span class="current-url">${escapeHtml(baseUrl)}</span>`;

    el('providerDropdown').innerHTML = providers.length ? providers.map((provider) => {
      const oauthReady = isClaudeOfficialProvider(provider) && isClaudeOauthLoggedIn(cc);
      const hasCredential = provider.hasApiKey || oauthReady;
      const keyMask = provider.maskedAuthToken || provider.maskedApiKey || (oauthReady ? 'OAuth 已登录' : '未保存 Key');
      return `
        <button class="provider-option ${provider.key === state.claudeSelectedProviderKey ? 'active' : ''}" data-load-claude-provider="${escapeHtml(provider.key)}">
          <span class="provider-option-main">
            <strong>${escapeHtml(provider.name || provider.key)}</strong>
            <span>${escapeHtml(provider.baseUrl || 'https://api.anthropic.com')}</span>
          </span>
          <span class="provider-option-side">
            <span class="provider-pill ${hasCredential ? 'ok' : 'warn'}">${escapeHtml(hasCredential ? keyMask : '缺少 Key')}</span>
            <span class="provider-option-model">${escapeHtml(provider.key === state.claudeSelectedProviderKey ? '当前' : '切换')}</span>
          </span>
        </button>
      `;
    }).join('') : '<div class="provider-empty">暂无 Provider 配置</div>';
    el('providerDropdown').classList.toggle('hide', !state.providerDropdownOpen);
    el('providerSwitchBtn').setAttribute('aria-expanded', String(state.providerDropdownOpen));

    state.quickTips = [
      '支持多 Provider：右上角下拉点击即切换 URL 与 Key',
      '支持 OAuth 授权和 API Key 两种认证方式',
      '模型别名（sonnet / opus / haiku）可直接使用',
      '保存后会把当前 URL / Key 写入 Provider，并设为当前激活',
    ];
    renderQuickRailSupportPanel();
    return;
  }

  // ── OpenCode tab ──
  if (state.activeTool === 'opencode') {
    const data = state.opencodeState || {};
    const active = data.activeProvider || null;
    const installed = isOpenCodeInstalled(data);
    if (!installed) {
      el('currentConfigMain').innerHTML = '<span class="current-provider">OpenCode</span><span class="current-model">未安装</span>';
      el('currentConfigMeta').innerHTML = '<span class="provider-pill warn">未安装</span><span class="meta-sep">·</span><span class="current-url">请先安装 OpenCode</span>';
      el('providerDropdown').innerHTML = '<div class="provider-empty">当前还没安装 OpenCode，请先安装后再配置。</div>';
      el('providerDropdown').classList.add('hide');
      el('providerSwitchBtn').setAttribute('aria-expanded', 'false');
      state.quickTips = [
        '当前未检测到 opencode 命令',
        '先点下方“安装 OpenCode”自动安装',
        '安装成功后再显示 URL、Key、模型等配置项',
      ];
      applyOpenCodeQuickInstallState(data);
      renderQuickRailSupportPanel();
      return;
    }
    const model = data.model || el('modelSelect')?.value || '未选择模型';
    const providerName = active?.name || active?.key || 'OpenCode';
    el('currentConfigMain').innerHTML = `<span class="current-provider">${escapeHtml(providerName)}</span><span class="current-model">${escapeHtml(model)}</span>`;
    el('currentConfigMeta').innerHTML = [
      `<span class="provider-pill ${active?.hasCredential ? 'ok' : 'warn'}">${active?.hasCredential ? '凭证已就绪' : '缺少凭证'}</span>`,
      `<span class="provider-pill ok">${escapeHtml(data.scope === 'project' ? '项目级' : '全局')}</span>`,
      active?.baseUrl ? `<span class="current-url">${escapeHtml(active.baseUrl)}</span>` : '未填写 Base URL',
    ].join('<span class="meta-sep">·</span>');

    el('providerDropdown').innerHTML = (data.providers || []).length
      ? (data.providers || []).map((provider) => `
        <button class="provider-option ${provider.key === data.activeProviderKey ? 'active' : ''}" data-load-opencode-provider="${escapeHtml(provider.key)}">
          <span class="provider-option-main">
            <strong>${escapeHtml(provider.name || provider.key)}</strong>
            <span>${escapeHtml(provider.baseUrl || '默认')}</span>
          </span>
          <span class="provider-option-side">
            <span class="provider-pill ${provider.hasCredential ? 'ok' : 'warn'}">${provider.hasCredential ? (provider.hasAuth ? `${provider.authType || 'Auth'} 已登录` : 'Key 已就绪') : '缺少凭证'}</span>
            <span class="provider-option-model">${escapeHtml(provider.key === data.activeProviderKey ? '当前' : ((provider.modelIds || []).length ? `${provider.modelIds.length} models` : '切换'))}</span>
          </span>
        </button>
      `).join('')
      : '<div class="provider-empty">暂无 Provider 配置</div>';
    el('providerDropdown').classList.toggle('hide', !state.providerDropdownOpen);
    el('providerSwitchBtn').setAttribute('aria-expanded', String(state.providerDropdownOpen));

    state.quickTips = [
      '模型格式使用 provider/model，例如 openai/gpt-5',
      '支持全局 `~/.config/opencode/opencode.json` 和项目级 `opencode.json` / `.opencode/opencode.json`',
      '鉴权文件位于 `~/.local/share/opencode/auth.json`，当前快速配置先写 provider.options.apiKey',
    ];
    applyOpenCodeQuickInstallState(data);
    renderQuickRailSupportPanel();
    return;
  }

  // ── OpenClaw tab ──
  if (state.activeTool === 'openclaw') {
    const quick = state.openClawQuickConfig;
    const ocState = state.openclawState;
    if (!isOpenClawInstalled(ocState || {})) {
      el('currentConfigMain').innerHTML = '<span class="current-provider">OpenClaw</span><span class="current-model">未安装</span>';
      el('currentConfigMeta').innerHTML = '<span class="provider-pill warn">未安装</span><span class="meta-sep">·</span><span class="current-url">请先安装 OpenClaw</span>';
      el('providerDropdown').innerHTML = '<div class="provider-empty">当前还没安装 OpenClaw，请先安装后再配置。</div>';
      el('providerDropdown').classList.add('hide');
      el('providerSwitchBtn').setAttribute('aria-expanded', 'false');
      state.quickTips = [
        '当前未检测到 openclaw 命令',
        '先点下方“安装 OpenClaw”自动安装',
        '安装成功后再显示协议、模型、Token 等配置项',
      ];
      applyOpenClawQuickInstallState(ocState || {});
      renderQuickRailSupportPanel();
      return;
    }
    const model = quick?.model || el('modelSelect')?.value || '未选择默认模型';

    el('currentConfigMain').innerHTML = `<span class="current-provider">OpenClaw</span><span class="current-model">${escapeHtml(model)}</span>`;

    const meta = [
      `<span class="provider-pill ok">${escapeHtml(getOpenClawProtocolMeta(quick?.api || 'openai-completions').label)}</span>`,
      quick?.baseUrl ? `<span class="current-url">${escapeHtml(quick.baseUrl)}</span>` : '官方默认端点',
      `<span class="provider-pill ${quick?.hasApiKey ? 'ok' : 'warn'}">${quick?.hasApiKey ? '已保存 Key' : '缺少 Key'}</span>`,
      `<span class="provider-pill ${ocState?.gatewayReachable ? 'ok' : ocState?.gatewayPortListening ? 'warn' : 'muted'}">${ocState?.gatewayReachable ? 'Dashboard 在线' : ocState?.gatewayPortListening ? 'Gateway 启动中' : 'Dashboard 未启动'}</span>`,
      `<span class="provider-pill ${ocState?.daemonRunning ? 'ok' : ocState?.daemonInstalled ? 'muted' : 'warn'}">常驻：${escapeHtml(getOpenClawDaemonStatusLabel(ocState || {}))}</span>`,
    ];
    el('currentConfigMeta').innerHTML = meta.join('<span class="meta-sep">·</span>');

    el('providerDropdown').innerHTML = '<div class="provider-empty">OpenClaw 不使用 Provider 切换</div>';
    el('providerDropdown').classList.toggle('hide', !state.providerDropdownOpen);
    el('providerSwitchBtn').setAttribute('aria-expanded', String(state.providerDropdownOpen));

    state.quickTips = [
      '选择默认模型后保存，启动时无需再手动指定',
      `Token 默认写入 ${quick?.envKey || getOpenClawDefaultEnvKey(quick?.api || 'openai-completions')}，想改就在“配置编辑”里改`,
      '官方 OpenAI / Claude 直连时 Base URL 可留空，代理/中转再填 URL',
    ];
    renderQuickRailSupportPanel();
    return;
  }

  // ── Codex tab (default) ──
  if (!isCodexInstalled()) {
    el('currentConfigMain').innerHTML = '<span class="current-provider">Codex</span><span class="current-model">未安装</span>';
    el('currentConfigMeta').innerHTML = '<span class="provider-pill warn">未安装</span><span class="meta-sep">·</span><span class="current-url">请先安装 Codex</span>';
    el('providerDropdown').innerHTML = '<div class="provider-empty">当前还没安装 Codex，请先安装后再配置。</div>';
    el('providerDropdown').classList.add('hide');
    el('providerSwitchBtn').setAttribute('aria-expanded', 'false');
    state.quickTips = [
      '当前未检测到 codex 命令',
      '先点下方“安装 Codex”自动安装',
      '安装成功后再显示官方登录、API Key、模型等配置项',
    ];
    applyCodexQuickInstallState();
    renderQuickRailSupportPanel();
    return;
  }
  applyCodexQuickInstallState();
  const active = state.current?.activeProvider || null;
  const login = state.current?.login || {};
  const model = state.current?.summary?.model || el('modelSelect').value || '未选择模型';
  const providerName = active ? (active.name || active.key) : (login.loggedIn ? 'OpenAI 官方登录' : '未配置');
  const status = active ? providerHealthLabel(active) : login.loggedIn ? { text: '已登录', tone: 'ok' } : { text: '未配置', tone: 'muted' };
  el('currentConfigMain').innerHTML = `<span class="current-provider">${escapeHtml(providerName)}</span><span class="current-model">${escapeHtml(model || '-')}</span>`;
  el('currentConfigMeta').innerHTML = active
    ? `状态 <span class="provider-pill ${status.tone}">${escapeHtml(status.text)}</span>${active.inferred ? '<span class="meta-sep">·</span><span class="provider-pill ok">自动识别</span>' : ''}<span class="meta-sep">·</span><span class="current-url">${escapeHtml(active.baseUrl || '-')}</span>`
    : login.loggedIn
      ? `状态 <span class="provider-pill ok">已登录</span><span class="meta-sep">·</span><span class="current-url">${escapeHtml(login.plan || login.email || 'ChatGPT / OpenAI 官方认证')}</span>`
    : '当前还没有可用 Provider';

  const providers = state.current?.providers || [];
  el('providerDropdown').innerHTML = providers.length ? providers.map((provider) => {
    const badge = providerHealthLabel(provider);
    const modelLabel = provider.isActive
      ? (state.current?.summary?.model || '-')
      : (provider.historyOnly ? '历史条目' : '切换');
    return `
      <button class="provider-option ${provider.isActive ? 'active' : ''}" data-load-provider="${escapeHtml(provider.key)}">
        <span class="provider-option-main">
          <strong>${escapeHtml(provider.name || provider.key)}</strong>
          ${provider.historyOnly ? '<span class="provider-pill muted">历史</span>' : ''}
          ${provider.inferred && !provider.historyOnly ? '<span class="provider-pill ok">自动识别</span>' : ''}
          <span>${escapeHtml(provider.baseUrl || '-')}</span>
        </span>
        <span class="provider-option-side">
          <span class="provider-pill ${badge.tone}">${escapeHtml(badge.text)}</span>
          <span class="provider-option-model">${escapeHtml(modelLabel)}</span>
        </span>
      </button>
    `;
  }).join('') : '<div class="provider-empty">暂无 Provider 配置</div>';

  el('providerDropdown').classList.toggle('hide', !state.providerDropdownOpen);
  el('providerSwitchBtn').setAttribute('aria-expanded', String(state.providerDropdownOpen));

  state.quickTips = login.loggedIn
    ? [
      '已识别 Codex 官方登录，可直接启动使用',
      '切到「API Key」可改用代理 / 中转 / 国内平台',
      '如果只想用官方线路，通常无需再手动填写 URL 和 Key',
    ]
    : [
      '检测模型后自动推荐最新可用模型',
      '保存后写入 Codex 配置并保留备份',
      '未安装 Codex 时，启动会弹窗引导自动安装',
    ];
  renderQuickRailSupportPanel();
}

async function refreshProviderHealth(force = false) {
  const providers = (state.current?.providers || []).filter((provider) => provider.hasApiKey && provider.baseUrl);
  // Respect the user-configured auto-detect interval when deciding whether a
  // cached result is still fresh. Without this, every loadState() (triggered
  // e.g. by a row-switch) would spray /api/provider/test-saved across every
  // saved provider, regardless of the "30 分钟" setting.
  let freshnessWindowMs = 300000; // 5 min default for recently-checked results
  try {
    const raw = localStorage.getItem('easyaiconfig_ch_autodetect_interval_sec');
    const sec = raw ? Math.max(0, parseInt(raw, 10) || 0) : 0;
    if (sec > 0) freshnessWindowMs = sec * 1000;
  } catch (_) { /* fall back to default */ }

  await Promise.all(providers.map(async (provider) => {
    const existing = state.providerHealth[provider.key];
    if (!force && existing) {
      if (existing.loading && existing.startedAt && (Date.now() - existing.startedAt < 12000)) return;
      if (existing.checked && existing.checkedAt && (Date.now() - existing.checkedAt < freshnessWindowMs)) return;
      // No checkedAt → legacy record; still treat as fresh so we don't retest
      if (existing.checked && !existing.checkedAt) return;
    }
    state.providerHealth[provider.key] = { loading: true, checked: false, startedAt: Date.now() };
    renderCurrentConfig();
    try {
      const result = await Promise.race([
        api('/api/provider/test-saved', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: el('scopeSelect').value || 'global',
            projectPath: el('projectPathInput').value.trim(),
            codexHome: el('codexHomeInput').value.trim(),
            providerKey: provider.key,
            timeoutMs: 6000,
          }),
          timeoutMs: 8000,
        }),
        new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'timeout' }), 9000)),
      ]);
      state.providerHealth[provider.key] = { loading: false, checked: true, ok: Boolean(result?.ok), checkedAt: Date.now() };
    } catch (err) {
      console.warn('Provider health check failed:', provider.key, err);
      state.providerHealth[provider.key] = { loading: false, checked: true, ok: false, checkedAt: Date.now() };
    }
    renderCurrentConfig();
  }));
}

function toggleProviderDropdown(force) {
  state.providerDropdownOpen = typeof force === 'boolean' ? force : !state.providerDropdownOpen;
  renderCurrentConfig();
  if (state.providerDropdownOpen) {
    if (state.activeTool === 'codex') {
      refreshProviderHealth();
    }
    positionProviderDropdown();
  }
}

function positionProviderDropdown() {
  const btn = el('providerSwitchBtn');
  const dropdown = el('providerDropdown');
  if (!btn || !dropdown || dropdown.classList.contains('hide')) return;
  const rect = btn.getBoundingClientRect();
  const dropdownWidth = 380;
  // Align right edge of dropdown to right edge of button
  let left = rect.right - dropdownWidth;
  // Ensure it doesn't go off-screen left
  if (left < 8) left = 8;
  // Ensure it doesn't go off-screen right
  if (left + dropdownWidth > window.innerWidth - 8) left = window.innerWidth - dropdownWidth - 8;
  dropdown.style.top = (rect.bottom + 6) + 'px';
  dropdown.style.left = left + 'px';
}

/** Default GPT models to show in the Codex model dropdown before detection. */
const CODEX_DEFAULT_MODELS = [
  { value: 'gpt-5.4', label: 'GPT-5.4 (最新旗舰)' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex (编程专用)' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark (快速)' },
  { value: 'gpt-5.3-instant', label: 'GPT-5.3 Instant' },
  { value: 'o3', label: 'o3' },
  { value: 'o4-mini', label: 'o4-mini' },
];

/** Render default GPT model options into a <select> when no detection has been run. */
function renderDefaultCodexModels(selectEl, currentModel) {
  if (!selectEl) return;
  let html = '<option value="">选择默认模型</option>';
  html += '<optgroup label="OpenAI / GPT">';
  for (const m of CODEX_DEFAULT_MODELS) {
    const sel = currentModel === m.value ? ' selected' : '';
    html += `<option value="${escapeHtml(m.value)}"${sel}>${escapeHtml(m.label)}</option>`;
  }
  html += '</optgroup>';
  selectEl.innerHTML = html;
  if (currentModel) selectEl.value = currentModel;
}

function renderModelOptions(models = state.detected?.models || [], preferred = '') {
  // Skip when Claude Code / OpenCode are active — they manage model lists separately
  if (state.activeTool === 'claudecode' || state.activeTool === 'opencode') return;

  const selected = preferred || el('modelSelect').value || state.current?.summary?.model || '';
  const unique = [...new Set([selected, state.detected?.recommendedModel, ...models].filter(Boolean))];

  if (unique.length) {
    el('modelSelect').innerHTML = unique.map((model) => `<option value="${escapeHtml(model)}" ${model === selected ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('');
  } else {
    // No detected models — show curated default list
    renderDefaultCodexModels(el('modelSelect'), selected);
  }
  el('modelChips').innerHTML = unique.slice(0, 16).map((model) => `<button class="chip ${model === selected ? 'active' : ''}" data-model="${escapeHtml(model)}">${escapeHtml(model)}</button>`).join('');
  el('modelChips').classList.toggle('hide', unique.length === 0);
}

function renderProviders() {
  const providers = state.current?.providers || [];
  el('savedProviders').innerHTML = providers.length ? providers.map((provider) => `
    <div class="provider-card ${provider.isActive ? 'active' : ''}">
      <div class="provider-main">
        <div class="provider-title-row">
          <strong>${escapeHtml(provider.name || provider.key)}</strong>
          <div class="provider-tag-row">
            ${provider.historyOnly ? '<span class="provider-pill muted">历史</span>' : ''}
            ${provider.inferred && !provider.historyOnly ? '<span class="provider-pill ok">自动识别</span>' : ''}
          </div>
        </div>
        <div class="provider-meta provider-url">${escapeHtml(provider.baseUrl || '-')}</div>
      </div>
      <div class="provider-actions-row">
        <button class="secondary tiny-btn" data-load-provider="${escapeHtml(provider.key)}">切换</button>
        <button class="secondary tiny-btn" data-check-provider="${escapeHtml(provider.key)}">检测</button>
      </div>
    </div>
  `).join('') : '<div class="provider-meta">暂无 Provider</div>';
}

function renderBackups() {
  el('backups').innerHTML = state.backups.length ? state.backups.map((item) => `
    <div class="backup-row">
      <span>${escapeHtml(item.name)}</span>
      <button class="secondary tiny-btn" data-restore="${escapeHtml(item.name)}">恢复</button>
    </div>
  `).join('') : '<div class="provider-meta">暂无备份</div>';
}

function getSelectedCodexTerminalProfile() {
  return String(state.codexTerminalProfile || 'auto').trim() || 'auto';
}

function getCodexTerminalProfiles() {
  const fromState = Array.isArray(state.current?.launch?.terminalProfiles)
    ? state.current.launch.terminalProfiles
    : (Array.isArray(state.codexTerminalProfiles) ? state.codexTerminalProfiles : []);
  const platform = state.current?.launch?.platform || '';
  if (fromState.length) {
    if (platform === 'darwin') {
      const allowed = new Set(['auto', 'terminal', 'iterm', 'termius']);
      const normalized = fromState
        .filter((item) => allowed.has(String(item?.id || '').trim()))
        .map((item) => {
          const id = String(item?.id || '').trim();
          if (id === 'terminal') return { ...item, id, label: '系统终端' };
          if (id === 'termius') return { ...item, id, label: 'Termius' };
          return { ...item, id };
        });
      if (normalized.length) return normalized;
    }
    return fromState;
  }

  if (platform === 'darwin') {
    return [
      { id: 'auto', label: '自动选择（推荐）' },
      { id: 'terminal', label: '系统终端' },
      { id: 'iterm', label: 'iTerm' },
      { id: 'termius', label: 'Termius' },
    ];
  }
  if (platform === 'win32') {
    return [
      { id: 'auto', label: '自动选择（推荐）' },
      { id: 'windows-terminal', label: 'Windows Terminal' },
      { id: 'powershell-7', label: 'PowerShell 7' },
      { id: 'powershell', label: 'Windows PowerShell' },
      { id: 'cmd', label: '命令提示符 CMD' },
    ];
  }
  return [];
}

function closeCodexTerminalMenu() {
  state.codexTerminalMenuOpen = false;
  el('codexTerminalMenu')?.classList.add('hide');
}

function openCodexTerminalMenu() {
  const menu = el('codexTerminalMenu');
  const button = el('launchBtn');
  const profiles = getCodexTerminalProfiles();
  if (!menu || !button || !profiles.length) return false;

  const selected = getSelectedCodexTerminalProfile();
  menu.innerHTML = profiles.map((profile) => `
    <button type="button" class="provider-option ${profile.id === selected ? 'active' : ''}" data-codex-terminal-launch="${escapeHtml(profile.id)}">
      <div class="provider-main">
        <strong>${escapeHtml(profile.label)}</strong>
        <div class="provider-meta">${escapeHtml(profile.id === 'auto' ? '自动选择终端并启动 Codex' : `使用 ${profile.label} 启动 Codex`)}</div>
      </div>
    </button>
  `).join('');

  const rect = button.getBoundingClientRect();
  const width = Math.min(360, Math.max(260, rect.width + 80));
  let left = rect.right - width;
  if (left < 12) left = 12;
  if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
  menu.style.width = `${width}px`;
  menu.style.left = `${left}px`;
  menu.classList.remove('hide');
  menu.style.visibility = 'hidden';
  const menuHeight = menu.offsetHeight || 220;
  let top = rect.top - menuHeight - 8;
  if (top < 12) top = rect.bottom + 8;
  menu.style.top = `${top}px`;
  menu.style.visibility = '';
  menu.classList.remove('hide');
  state.codexTerminalMenuOpen = true;
  return true;
}

function renderCodexTerminalPicker() {
  const row = el('codexTerminalRow');
  const hint = el('codexTerminalHint');
  if (!row || !hint) return;

  const platform = state.current?.launch?.platform || '';
  const isSupported = platform === 'win32' || platform === 'darwin';
  const profiles = getCodexTerminalProfiles();

  state.codexTerminalProfiles = profiles;
  if (!isSupported || !profiles.length) {
    row.classList.add('hide');
    hint.textContent = '';
    closeCodexTerminalMenu();
    return;
  }

  const profileIds = new Set(profiles.map((item) => String(item.id || '').trim()).filter(Boolean));
  if (!profileIds.has(state.codexTerminalProfile)) {
    state.codexTerminalProfile = 'auto';
  }

  hint.textContent = '';
  row.classList.add('hide');
}

function getCodexResumeContext() {
  return {
    cwd: el('launchCwdInput')?.value?.trim() || state.current?.launch?.cwd || '',
    codexHome: el('codexHomeInput')?.value?.trim() || state.current?.codexHome || '',
  };
}

function quotePosixShellArg(value = '') {
  const raw = String(value || '');
  if (!raw) return "''";
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function buildCodexResumeCommand(sessionId = '') {
  const id = String(sessionId || '').trim();
  if (!id) return 'codex resume --last';
  return `codex resume ${quotePosixShellArg(id)}`;
}

function downloadTextFile(fileName, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([String(content || '')], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = String(fileName || 'codex-session.txt');
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 300);
}

function formatCodexResumeTime(value = '') {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知时间' : date.toLocaleString();
}

function formatCodexSessionDetailHtml(summary = {}, stats = {}, events = []) {
  const sessionId = String(summary.sessionId || '').trim();
  const cwd = String(summary.cwd || '').trim();
  const command = buildCodexResumeCommand(sessionId);
  const statsText = [
    `行数 ${Number(stats.totalLines || 0)}`,
    `事件 ${Number(stats.parsedEvents || 0)}`,
    Number(stats.invalidLines || 0) > 0 ? `坏行 ${Number(stats.invalidLines || 0)}` : '',
  ].filter(Boolean).join(' · ');
  const rows = (Array.isArray(events) ? events : []).map((event) => {
    const line = Number(event.line || 0);
    const type = String(event.type || 'unknown').trim();
    const role = String(event.role || '').trim();
    const stamp = formatCodexResumeTime(event.timestamp);
    const preview = String(event.preview || '').trim() || '-';
    return `
      <tr>
        <td>${line || '-'}</td>
        <td>${escapeHtml(type)}</td>
        <td>${escapeHtml(role || '-')}</td>
        <td>${escapeHtml(stamp)}</td>
        <td title="${escapeHtml(preview)}">${escapeHtml(preview)}</td>
      </tr>
    `;
  }).join('');
  return `
    <div class="codex-session-detail">
      <div class="codex-session-detail-meta">
        <div><strong>ID</strong><span>${escapeHtml(sessionId || '-')}</span></div>
        <div><strong>模型</strong><span>${escapeHtml(String(summary.model || 'unknown'))}</span></div>
        <div><strong>Provider</strong><span>${escapeHtml(String(summary.provider || 'unknown'))}</span></div>
        <div><strong>更新时间</strong><span>${escapeHtml(formatCodexResumeTime(summary.updatedAt))}</span></div>
        <div class="wide"><strong>目录</strong><span title="${escapeHtml(cwd)}">${escapeHtml(cwd || '-')}</span></div>
        <div class="wide"><strong>恢复命令</strong><span class="mono" title="${escapeHtml(command)}">${escapeHtml(command)}</span></div>
      </div>
      <div class="codex-session-detail-stats">${escapeHtml(statsText)}</div>
      <div class="codex-session-detail-actions">
        <button type="button" class="secondary tiny-btn" data-codex-detail-copy-command="${escapeHtml(command)}">复制恢复命令</button>
        <button type="button" class="secondary tiny-btn" data-codex-detail-export-format="jsonl" data-codex-detail-file-path="${escapeHtml(String(summary.filePath || ''))}">导出 JSONL</button>
        <button type="button" class="secondary tiny-btn" data-codex-detail-export-format="json" data-codex-detail-file-path="${escapeHtml(String(summary.filePath || ''))}">导出 JSON</button>
      </div>
      <div class="codex-session-detail-table-wrap">
        <table class="codex-session-detail-table">
          <thead><tr><th>行</th><th>类型</th><th>角色</th><th>时间</th><th>预览</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5">暂无可显示事件</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderCodexResumeSessions() {
  const listEl = el('codexResumeSessions');
  const hintEl = el('codexResumeHint');
  const scopeBtn = el('codexResumeScopeBtn');
  if (!listEl || !hintEl) return;

  if (scopeBtn) {
    scopeBtn.textContent = state.codexResumeShowAll ? '只看当前目录' : '显示全部';
  }

  if (!isCodexInstalled()) {
    state.codexResumeLoading = false;
    state.codexResumeSessions = [];
    listEl.innerHTML = '';
    hintEl.textContent = '当前未检测到 Codex。请先安装，再使用会话恢复。';
    return;
  }

  if (state.codexResumeLoading) {
    listEl.innerHTML = '<div class="provider-meta">正在扫描最近会话…</div>';
    hintEl.textContent = '正在读取 ~/.codex/sessions 里的最近记录。';
    return;
  }

  const items = Array.isArray(state.codexResumeSessions) ? state.codexResumeSessions : [];
  if (!items.length) {
    listEl.innerHTML = '<div class="provider-meta">暂无可恢复会话</div>';
    hintEl.textContent = state.codexResumeShowAll
      ? '还没发现可恢复的 Codex 会话。先在终端里跑一次 Codex，再回来这里恢复。'
      : '当前仅显示与启动目录相关的会话。若没找到，可点“显示全部”。';
    return;
  }

  hintEl.textContent = state.codexResumeShowAll
    ? `已列出最近 ${items.length} 个会话，可直接继续或分叉恢复。`
    : `已按当前启动目录筛出 ${items.length} 个会话；点“显示全部”可看全部历史。`;

  listEl.innerHTML = items.map((item) => {
    const sessionId = String(item.sessionId || '').trim();
    const title = String(item.title || sessionId || '未命名会话').trim();
    const provider = String(item.provider || 'unknown').trim();
    const model = String(item.model || 'unknown').trim();
    const cwd = String(item.cwd || '').trim();
    const filePath = String(item.filePath || '').trim();
    const resumeCommand = buildCodexResumeCommand(sessionId);
    const meta = [sessionId, model, provider, formatCodexResumeTime(item.updatedAt)].filter(Boolean);
    return `
      <div class="resume-session-card">
        <div class="resume-session-main">
          <div class="resume-session-title">${escapeHtml(title)}</div>
          <div class="resume-session-meta">${meta.map((part) => `<span>${escapeHtml(part)}</span>`).join('<span class="resume-session-dot">•</span>')}</div>
          <div class="resume-session-command" title="${escapeHtml(resumeCommand)}">${escapeHtml(resumeCommand)}</div>
          <div class="resume-session-cwd">${escapeHtml(cwd || '未记录工作目录')}</div>
        </div>
        <div class="resume-session-actions">
          <button type="button" class="secondary tiny-btn" data-codex-resume-id="${escapeHtml(sessionId)}">继续</button>
          <button type="button" class="secondary tiny-btn" data-codex-fork-id="${escapeHtml(sessionId)}">分叉</button>
          <button type="button" class="secondary tiny-btn" data-codex-detail-path="${escapeHtml(filePath)}">详情</button>
          <button type="button" class="secondary tiny-btn" data-codex-export-path="${escapeHtml(filePath)}">导出</button>
          <button type="button" class="secondary tiny-btn" data-codex-copy-resume-command="${escapeHtml(resumeCommand)}">复制命令</button>
        </div>
      </div>
    `;
  }).join('');
}

async function loadCodexResumeSessions({ silent = true } = {}) {
  const listEl = el('codexResumeSessions');
  if (!listEl) return;
  if (!isCodexInstalled()) {
    state.codexResumeLoading = false;
    state.codexResumeSessions = [];
    renderCodexResumeSessions();
    return;
  }

  state.codexResumeLoading = true;
  renderCodexResumeSessions();
  const context = getCodexResumeContext();
  const params = new URLSearchParams({
    cwd: context.cwd,
    codexHome: context.codexHome,
    limit: '20',
    all: state.codexResumeShowAll ? '1' : '0',
  });
  const json = await api(`/api/codex/sessions?${params.toString()}`);
  state.codexResumeLoading = false;
  if (!json.ok) {
    state.codexResumeSessions = [];
    renderCodexResumeSessions();
    if (!silent) flash(json.error || '读取会话失败', 'error');
    return;
  }
  state.codexResumeSessions = json.data?.items || [];
  renderCodexResumeSessions();
}

async function exportCodexSessionByPath(filePath, format = 'jsonl') {
  const targetPath = String(filePath || '').trim();
  if (!targetPath) {
    flash('缺少会话文件路径', 'error');
    return false;
  }
  const context = getCodexResumeContext();
  const json = await api('/api/codex/session-export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath: targetPath,
      codexHome: context.codexHome,
      format: String(format || 'jsonl').trim().toLowerCase() === 'json' ? 'json' : 'jsonl',
    }),
  });
  if (!json.ok) {
    flash(json.error || '导出会话失败', 'error');
    return false;
  }
  const payload = json.data || {};
  downloadTextFile(payload.fileName || `codex-session.${payload.format || 'jsonl'}`, payload.content || '', payload.mime || 'text/plain;charset=utf-8');
  flash(`已导出 ${payload.fileName || '会话文件'}`, 'success');
  return true;
}

async function openCodexSessionDetailByPath(filePath) {
  const targetPath = String(filePath || '').trim();
  if (!targetPath) {
    flash('缺少会话文件路径', 'error');
    return false;
  }
  const context = getCodexResumeContext();
  const params = new URLSearchParams({
    filePath: targetPath,
    codexHome: context.codexHome,
    limit: '120',
  });
  const json = await api(`/api/codex/session-detail?${params.toString()}`);
  if (!json.ok) {
    flash(json.error || '读取会话详情失败', 'error');
    return false;
  }
  const data = json.data || {};
  const body = formatCodexSessionDetailHtml(data.summary || {}, data.stats || {}, data.recentEvents || []);
  void openUpdateDialog({
    eyebrow: 'Codex Session',
    title: String(data.summary?.title || data.summary?.sessionId || '会话详情'),
    body,
    confirmText: '关闭',
    confirmOnly: true,
  });
  return true;
}

async function triggerCodexResumeAction(action, button, { sessionId = '', last = false } = {}) {
  const endpoint = action === 'fork' ? '/api/codex/fork' : '/api/codex/resume';
  const payload = {
    cwd: getCodexResumeContext().cwd,
    sessionId,
    last,
    terminalProfile: getSelectedCodexTerminalProfile(),
  };
  const originalText = button?.textContent || '';
  if (button) {
    button.disabled = true;
    button.textContent = action === 'fork' ? '分叉中...' : '恢复中...';
  }
  const json = await api(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (button) {
    button.disabled = false;
    button.textContent = originalText;
  }
  if (!json.ok) {
    flash(json.error || (action === 'fork' ? '分叉恢复失败' : '恢复会话失败'), 'error');
    return false;
  }
  flash(json.data?.message || (action === 'fork' ? '已打开 Codex 分叉恢复' : '已打开 Codex 会话恢复'), 'success');
  return true;
}

function fillAdvancedFromState() {
  el('scopeSelect').value = state.current?.scope || 'global';
  el('projectPathInput').value = state.current?.projectPath || '';
  el('codexHomeInput').value = state.current?.codexHome || '';
  if (!el('launchCwdInput').value) el('launchCwdInput').value = state.current?.launch?.cwd || '';
}

function fillFromProvider(provider) {
  if (!provider) return;
  if (state.activeTool === 'claudecode') return; // Codex-only
  el('baseUrlInput').value = provider.baseUrl || '';
  setApiKeyFieldState(provider);
  state.detected = null;
  state.metaDirty = true;
  const model = provider.isActive ? (state.current?.summary?.model || '') : '';
  renderModelOptions([], model);
  renderCurrentConfig();
  if (provider.historyOnly) {
    el('detectionMeta').textContent = `已载入历史 Provider「${provider.name || provider.key}」，请补充 Key 后保存以恢复到当前配置`;
  } else {
    el('detectionMeta').textContent = provider.hasApiKey
      ? `已载入 ${provider.name || provider.key}${provider.inferred ? '（来自 OpenAI 认证自动识别）' : ''}，Key 已保存，可点击右侧眼睛查看`
      : `已载入 ${provider.name || provider.key}，但未发现 Key`;
  }
}

/* ── Sync from Codex environment → OpenClaw quick-setup form ── */
async function syncFromCodexEnv() {
  const btn = el('syncFromCodexBtn');
  if (btn) btn.classList.add('loading');
  try {
    if (!state.current) {
      const params = new URLSearchParams({
        scope: el('scopeSelect')?.value || 'global',
        projectPath: el('projectPathInput')?.value?.trim() || '',
        codexHome: el('codexHomeInput')?.value?.trim() || '',
      });
      const json = await api(`/api/state?${params.toString()}`);
      if (json.ok && json.data) state.current = json.data;
    }
    const providers = state.current?.providers || [];
    const active = state.current?.activeProvider || providers[0];
    if (!active) {
      flash('未检测到 Codex Provider 配置，请先在 Codex 中完成配置', 'info');
      return;
    }
    const parts = [];

    // Protocol → openai-responses (Codex uses OpenAI Responses API)
    // Set protocol FIRST so the change handler resets placeholders,
    // then we overwrite with actual synced values below.
    const protocolSelect = el('openClawProtocolSelect');
    if (protocolSelect) {
      protocolSelect.value = 'openai-responses';
      protocolSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Base URL (after protocol change so URL normalization is correct)
    if (active.baseUrl) {
      el('baseUrlInput').value = active.baseUrl;
      parts.push('Base URL');
    }

    // API Key (after protocol change so placeholder isn't overwritten)
    if (active.hasApiKey || active.maskedApiKey) {
      const apiKeyInput = el('apiKeyInput');
      if (apiKeyInput) {
        apiKeyInput.value = '';
        apiKeyInput.type = 'password';
        apiKeyInput.placeholder = active.maskedApiKey
          ? `${active.maskedApiKey} (来自 Codex)`
          : '已检测到 Key (来自 Codex)';
      }
      syncApiKeyToggle();
      parts.push('API Key');
    }

    // Model
    const model = state.current?.summary?.model || '';
    if (model) {
      const prefixed = model.includes('/') ? model : `openai/${model}`;
      const modelSelect = el('modelSelect');
      if (modelSelect) {
        let found = false;
        for (const opt of modelSelect.options) { if (opt.value === prefixed) { found = true; break; } }
        if (!found) {
          const opt = document.createElement('option');
          opt.value = prefixed;
          opt.textContent = prefixed;
          modelSelect.appendChild(opt);
        }
        modelSelect.value = prefixed;
      }
      parts.push(`模型 (${prefixed})`);
    }

    const detectionMeta = el('detectionMeta');
    if (parts.length) {
      flash(`已从 Codex 同步：${parts.join('、')}`, 'success');
      if (detectionMeta) detectionMeta.textContent = `已同步 Codex — ${active.name || active.key}`;
    } else {
      flash('Codex 环境中未找到有效配置', 'info');
    }
  } catch (err) {
    flash('读取 Codex 环境失败：' + (err.message || '未知错误'), 'error');
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}

/* ── Sync from Claude Code environment → OpenClaw quick-setup form ── */
async function syncFromClaudeCodeEnv() {
  const btn = el('syncFromClaudeBtn');
  if (btn) btn.classList.add('loading');
  try {
    const json = await api('/api/claudecode/state');
    if (!json.ok || !json.data) {
      flash('未检测到 Claude Code 环境，请确认已安装并配置', 'info');
      return;
    }
    const data = json.data;
    state.claudeCodeState = data;
    const ev = data.envVars || {};
    const parts = [];

    // Protocol → anthropic-messages
    const protocolSelect = el('openClawProtocolSelect');
    if (protocolSelect) {
      protocolSelect.value = 'anthropic-messages';
      protocolSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Base URL
    if (ev.ANTHROPIC_BASE_URL?.set && ev.ANTHROPIC_BASE_URL.value) {
      el('baseUrlInput').value = ev.ANTHROPIC_BASE_URL.value;
      parts.push('Base URL');
    }

    // API Key
    const apiKeyInput = el('apiKeyInput');
    if (apiKeyInput) {
      if (ev.ANTHROPIC_API_KEY?.set) {
        apiKeyInput.value = '';
        apiKeyInput.type = 'password';
        apiKeyInput.placeholder = `${ev.ANTHROPIC_API_KEY.masked} (来自 Claude Code)`;
        parts.push('API Key');
      } else if (ev.ANTHROPIC_AUTH_TOKEN?.set) {
        apiKeyInput.value = '';
        apiKeyInput.type = 'password';
        apiKeyInput.placeholder = `${ev.ANTHROPIC_AUTH_TOKEN.masked} (Auth Token)`;
        parts.push('Auth Token');
      } else if (data.maskedApiKey) {
        apiKeyInput.value = '';
        apiKeyInput.type = 'password';
        apiKeyInput.placeholder = `${data.maskedApiKey} (来自 Claude Code)`;
        parts.push('API Key');
      }
    }
    syncApiKeyToggle();

    // Model
    const ccModel = data.model;
    if (ccModel) {
      const ALIAS_MAP = {
        'sonnet': 'anthropic/claude-sonnet-4-6',
        'opus': 'anthropic/claude-opus-4-6',
        'haiku': 'anthropic/claude-haiku-3-5',
      };
      const mapped = ALIAS_MAP[ccModel] || (ccModel.includes('/') ? ccModel : `anthropic/${ccModel}`);
      const modelSelect = el('modelSelect');
      if (modelSelect) {
        let found = false;
        for (const opt of modelSelect.options) { if (opt.value === mapped) { found = true; break; } }
        if (!found) {
          const opt = document.createElement('option');
          opt.value = mapped;
          opt.textContent = mapped;
          modelSelect.appendChild(opt);
        }
        modelSelect.value = mapped;
      }
      parts.push(`模型 (${mapped})`);
    }

    const detectionMeta = el('detectionMeta');
    if (parts.length) {
      const loginInfo = data.login || {};
      const source = loginInfo.loggedIn ? (loginInfo.email || loginInfo.orgName || 'Claude Code') : 'Claude Code';
      flash(`已从 Claude Code 同步：${parts.join('、')}`, 'success');
      if (detectionMeta) detectionMeta.textContent = `已同步 Claude Code — ${source}`;
    } else {
      flash('Claude Code 环境中未找到可同步的配置', 'info');
    }
  } catch (err) {
    flash('读取 Claude Code 环境失败：' + (err.message || '未知错误'), 'error');
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}


async function loadState({ preserveForm = true } = {}) {
  const snapshot = preserveForm ? {
    baseUrl: el('baseUrlInput').value,
    apiKey: el('apiKeyInput').value,
    apiKeyType: el('apiKeyInput').type,
    apiKeyPlaceholder: el('apiKeyInput').placeholder,
    apiKeyField: { ...state.apiKeyField },
    selectedModel: el('modelSelect').value,
    metaDirty: state.metaDirty,
  } : null;
  const params = new URLSearchParams({
    scope: el('scopeSelect').value || 'global',
    projectPath: el('projectPathInput').value.trim(),
    codexHome: el('codexHomeInput').value.trim(),
  });
  const json = await api(`/api/state?${params.toString()}`);
  if (!json.ok) return flash(json.error || '读取状态失败', 'error');
  state.current = json.data;
  if (state.current && Array.isArray(state.current.providers)) {
    persistCodexProviderHistory(state.current.providers);
    state.current.providers = mergeCodexProvidersWithHistory(state.current.providers);
    const officialProvider = buildCodexOfficialProvider(state.current?.login, state.current.providers);
    if (officialProvider) {
      state.current.providers.unshift(officialProvider);
    }
    const activeKey = String(state.current?.activeProvider?.key || state.current?.summary?.modelProvider || '').trim();
    if (activeKey) {
      state.current.providers.forEach((provider) => {
        provider.isActive = provider.key === activeKey;
      });
      const activeFromMerged = state.current.providers.find((provider) => provider.key === activeKey);
      if (activeFromMerged) state.current.activeProvider = activeFromMerged;
    }
  }
  // Preserve providerHealth across loadState so the user-configured
  // auto-detect cadence actually sticks. refreshProviderHealth() has its own
  // freshness window check that respects the localStorage interval, and
  // prunes stale keys for providers that no longer exist.
  if (state.providerHealth && typeof state.providerHealth === 'object') {
    const validKeys = new Set((state.current?.providers || []).map((p) => p.key));
    for (const k of Object.keys(state.providerHealth)) {
      if (!validKeys.has(k)) delete state.providerHealth[k];
    }
  } else {
    state.providerHealth = {};
  }
  state.codexTerminalProfiles = Array.isArray(state.current?.launch?.terminalProfiles) ? state.current.launch.terminalProfiles : [];
  fillAdvancedFromState();
  renderCodexTerminalPicker();
  renderCodexResumeSessions();
  renderStatus();
  renderProviders();
  syncCodexAuthView();
  renderCurrentConfig();

// Skip Codex form restoration when non-Codex tool is active
  if (state.activeTool === 'claudecode' || state.activeTool === 'opencode' || state.activeTool === 'openclaw') {
    loadCodexResumeSessions({ silent: true }).catch((e) => console.warn('[restoreFromSnapshot] loadCodexResumeSessions failed:', e));
    refreshProviderHealth();
    renderToolConsole();
    return;
  }

  if (snapshot && (snapshot.baseUrl || snapshot.apiKey || snapshot.apiKeyField?.hasStored)) {
    el('baseUrlInput').value = snapshot.baseUrl;
    el('apiKeyInput').value = snapshot.apiKey;
    el('apiKeyInput').type = snapshot.apiKeyType || 'password';
    el('apiKeyInput').placeholder = snapshot.apiKeyPlaceholder || 'sk-...';
    state.apiKeyField = snapshot.apiKeyField || { ...state.apiKeyField };
    syncApiKeyToggle();
    state.metaDirty = snapshot.metaDirty;
    renderModelOptions([], snapshot.selectedModel);
    syncCodexAuthView();
    renderCurrentConfig();
    loadCodexResumeSessions({ silent: true }).catch((e) => console.warn('[restoreFromSnapshot] loadCodexResumeSessions failed:', e));
    refreshProviderHealth();
    syncShortcutActiveState();
    renderToolConsole();
    return;
  }
  fillFromProvider(state.current.activeProvider || state.current.providers?.[0]);
  syncCodexAuthView();
  renderCurrentConfig();

  loadCodexResumeSessions({ silent: true }).catch((e) => console.warn('[restoreFromSnapshot] loadCodexResumeSessions failed:', e));

  // Auto-trigger provider health check so the card doesn't stay "待检测"
  refreshProviderHealth();

  // Sync shortcut active states based on loaded config
  syncShortcutActiveState();
  renderToolConsole();
}

async function loadBackups() {
  const json = await api('/api/backups');
  if (!json.ok) return;
  state.backups = json.data || [];
  renderBackups();
}

async function getReleaseInfo() {
  const json = await api('/api/codex/release');
  if (!json.ok) {
    flash(json.error || '读取版本信息失败', 'error');
    return null;
  }
  return json.data;
}

async function loadAppUpdateState({ manual = false } = {}) {
  if (!tauriInvoke) {
    state.appUpdate = { enabled: false, currentVersion: '' };
    renderAppUpdateStatus();
    return null;
  }

  if (manual) setBusy('appUpdateBtn', true, '检测中...');
  const json = await api('/api/app/update');
  if (manual) setBusy('appUpdateBtn', false);
  if (!json.ok) {
    if (manual) flash(json.error || '检测客户端更新失败', 'error');
    return null;
  }
  state.appUpdate = json.data || null;
  renderAppUpdateStatus();
  populateAboutPanel();
  if (!manual) return state.appUpdate;
  // manual toast feedback is only used from sidebar, not about page
  return state.appUpdate;
}

function stopAppUpdateProgressPolling() {
  if (state.appUpdateProgressTimer) {
    clearInterval(state.appUpdateProgressTimer);
    state.appUpdateProgressTimer = 0;
  }
}

async function loadAppUpdateProgressState({ silent = true } = {}) {
  const json = await api('/api/app/update/progress');
  if (!json.ok) {
    if (!silent) flash(json.error || '读取更新进度失败', 'error');
    return null;
  }
  state.appUpdateProgress = json.data || null;
  const status = String(state.appUpdateProgress?.status || '');
  if (!['checking', 'downloading', 'installing'].includes(status)) {
    stopAppUpdateProgressPolling();
  }
  populateAboutPanel();
  return state.appUpdateProgress;
}

function startAppUpdateProgressPolling() {
  stopAppUpdateProgressPolling();
  void loadAppUpdateProgressState({ silent: true });
  state.appUpdateProgressTimer = window.setInterval(() => {
    void loadAppUpdateProgressState({ silent: true });
  }, 600);
}

async function handleAppUpdate(buttonId = 'appUpdateBtn', { skipConfirm = false } = {}) {
  const info = state.appUpdate || await loadAppUpdateState({ manual: true });
  if (!info) return;
  if (!info.enabled) return;
  if (!info.available) return;

  if (!skipConfirm) {
    const confirmed = window.confirm(`当前版本：${info.currentVersion}
最新版本：${info.version}

确定下载并安装客户端更新吗？安装后会自动重启。`);
    if (!confirmed) return;
  }

  setBusy('appUpdateBtn', true, '下载中...');
  if (buttonId !== 'appUpdateBtn') setBusy(buttonId, true, '更新中...');
  startAppUpdateProgressPolling();
  const json = await api('/api/app/update', { method: 'POST', timeoutMs: 300000 });
  await loadAppUpdateProgressState({ silent: true });
  setBusy('appUpdateBtn', false);
  if (buttonId !== 'appUpdateBtn') setBusy(buttonId, false);
  if (!json.ok) {
    const errorText = json.error || '客户端更新失败';
    const isSignatureError = /签名|signature|verify/i.test(errorText);
    const isNetworkError = /网络|network|dns|timeout|timed out|connect|reset|tls|certificate/i.test(errorText);
    const repo = info.repository || 'lmk1010/EasyAIConfig';
    const releaseUrl = `https://github.com/${repo}/releases/latest`;
    if (isSignatureError || isNetworkError) {
      const hint = isSignatureError
        ? '更新包在下载过程中可能被损坏（网络不稳定），导致签名校验失败。'
        : '下载更新时网络出现异常，请检查网络连接。';
      void openUpdateDialog({
        eyebrow: '更新失败',
        title: isSignatureError ? '签名校验失败' : '网络异常',
        body: `<div style="display:flex;flex-direction:column;gap:12px">
          <div style="color:var(--text-secondary);line-height:1.6">${escapeHtml(hint)}</div>
          <div style="background:var(--bg-inset,rgba(255,255,255,.04));border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.7;color:var(--text-tertiary);word-break:break-all">${escapeHtml(errorText)}</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <div style="font-weight:600;color:var(--text-primary)">建议操作：</div>
            <div style="color:var(--text-secondary);line-height:1.6">1. 点击「重试更新」再试一次（有时换个时间段网络会恢复）</div>
            <div style="color:var(--text-secondary);line-height:1.6">2. 或直接从 GitHub Releases 手动下载最新 .dmg 安装包覆盖安装</div>
          </div>
        </div>`,
        confirmText: '重试更新',
        cancelText: '手动下载',
        tone: 'default',
      }).then((retry) => {
        if (retry) {
          void handleAppUpdate(buttonId, { skipConfirm: true });
        } else {
          window.open(releaseUrl, '_blank');
        }
      });
    } else {
      return flash(errorText, 'error');
    }
    return;
  }
  flash(`客户端已更新到 ${json.data?.version || info.version}，应用即将重启`, 'success');
}

async function runCodexAction(buttonId, endpoint, busyText, successText) {
  setBusy(buttonId, true, busyText);
  const json = await api(endpoint, { method: 'POST', timeoutMs: 120000 });
  setBusy(buttonId, false);
  if (!json.ok || (json.data && json.data.ok === false)) {
    flash(json.error || json.data?.stderr || '操作失败', 'error');
    return false;
  }
  if (successText) flash(successText, 'success');
  await refreshToolRuntimeAfterMutation('codex');
  return true;
}

/** Get base URL and API Key from the current form, works for supported quick modes. */
function _getDetectParams() {
  const rawBaseUrl = el('baseUrlInput')?.value?.trim() || '';
  const baseUrl = state.activeTool === 'claudecode'
    ? normalizeClaudeBaseUrl(rawBaseUrl)
    : normalizeBaseUrl(rawBaseUrl);
  const apiKey = el('apiKeyInput')?.value?.trim() || '';
  if (state.activeTool === 'codex') {
    const payload = currentPayload();
    const useStored = canUseStoredApiKey({ baseUrl: payload.baseUrl, providerKey: payload.providerKey }) && !payload.apiKey;
    return { baseUrl: payload.baseUrl || baseUrl, apiKey: payload.apiKey || apiKey, useStored, payload };
  }
  if (state.activeTool === 'opencode') {
    const active = state.opencodeState?.activeProvider || {};
    return {
      baseUrl: baseUrl || normalizeBaseUrl(active.baseUrl || ''),
      apiKey,
      useStored: false,
      payload: null,
    };
  }
  const storedKey = state.openClawQuickConfig?.apiKey || '';
  return { baseUrl, apiKey: apiKey || storedKey, useStored: false, payload: null };
}

async function detectModels() {
  const params = _getDetectParams();
  if (state.activeTool === 'codex' && state.codexAuthView === 'official') {
    return flash('官方登录模式下无需手动检测 URL / Key；直接启动即可。', 'info');
  }
  if (!params.baseUrl || (!params.apiKey && !params.useStored)) return flash('先填 URL 和 API Key', 'error');
  setBusy('detectBtn', true, '检测中...');
  const json = await api(params.useStored ? '/api/provider/test-saved' : '/api/provider/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params.useStored
      ? {
        scope: params.payload.scope,
        projectPath: params.payload.projectPath,
        codexHome: params.payload.codexHome,
        providerKey: params.payload.providerKey,
        timeoutMs: 18000,
      }
      : { baseUrl: params.baseUrl, apiKey: params.apiKey }),
    timeoutMs: 18000,
  });
  setBusy('detectBtn', false);
  if (!json.ok) {
    state.detected = null;
    if (state.activeTool === 'openclaw') {
      // Keep OpenClaw preset list
    } else if (state.activeTool === 'opencode') {
      renderOpenCodeModelOptions('modelSelect', { data: state.opencodeState || {}, currentModel: state.opencodeState?.model || '' });
    } else {
      renderModelOptions();
    }
    el('detectionMeta').textContent = json.error || '检测失败';
    el('detectionMeta').className = 'inline-meta';
    return flash(json.error || '检测失败', 'error');
  }
  state.detected = json.data;
  const models = json.data.models || [];
  if (state.activeTool === 'openclaw') {
    _mergeModelsIntoOpenClawDropdown(models);
  } else if (state.activeTool === 'opencode') {
    mergeModelsIntoOpenCodeDropdown(models);
  } else {
    state.detected.recommendedModel = pickRecommendedModel(models, json.data.recommendedModel);
    renderModelOptions(models, state.detected.recommendedModel);
  }
  renderQuickSummary();
  el('detectionMeta').textContent = `检测成功 · ${models.length} 个模型`;
}

/**
 * Silently try to auto-fetch models from the base URL's /models endpoint.
 * Works for both Codex and OpenClaw. Does not show error flashes on failure.
 */
let _autoFetchAbort = null;
async function tryAutoFetchModels() {
  if (state.activeTool !== 'codex' && state.activeTool !== 'opencode' && state.activeTool !== 'openclaw') return;
  const params = _getDetectParams();
  if (!params.baseUrl || (!params.apiKey && !params.useStored)) return;

  // Cancel previous auto-fetch if still in progress
  if (_autoFetchAbort) _autoFetchAbort.abort();
  _autoFetchAbort = new AbortController();

  const meta = el('detectionMeta');
  if (meta) meta.textContent = '正在从 URL 获取模型列表...';

  try {
    const json = await api(params.useStored ? '/api/provider/test-saved' : '/api/provider/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params.useStored
        ? {
          scope: params.payload.scope,
          projectPath: params.payload.projectPath,
          codexHome: params.payload.codexHome,
          providerKey: params.payload.providerKey,
          timeoutMs: 10000,
        }
        : { baseUrl: params.baseUrl, apiKey: params.apiKey }),
      timeoutMs: 10000,
      signal: _autoFetchAbort.signal,
    });
    if (!json.ok) {
      if (meta) meta.textContent = '自动获取模型失败，可手动选择或点击"检测模型"';
      return;
    }
    state.detected = json.data;
    const models = json.data.models || [];
    if (state.activeTool === 'openclaw') {
      _mergeModelsIntoOpenClawDropdown(models);
    } else {
      state.detected.recommendedModel = pickRecommendedModel(models, json.data.recommendedModel);
      renderModelOptions(models, state.detected.recommendedModel);
    }
    renderQuickSummary();
    if (meta) meta.textContent = `已获取 ${models.length} 个模型`;
  } catch {
    // Silent failure — keep default/preset model list
    if (meta) meta.textContent = '可手动选择默认模型或点击"检测模型"';
  }
}

/**
 * Replace the OpenClaw model dropdown with models fetched from the URL.
 * Only shows fetched models — no preset duplication.
 * If fetchedModels is empty, falls back to preset list.
 */
function _mergeModelsIntoOpenClawDropdown(fetchedModels = []) {
  const modelSelect = el('modelSelect');
  if (!modelSelect) return;

  const currentValue = modelSelect.value;
  const apiMode = el('openClawProtocolSelect')?.value || 'openai-completions';

  // No models fetched — fall back to presets
  if (!fetchedModels.length) {
    modelSelect.innerHTML = renderOpenClawModelOptions(currentValue, apiMode);
    if (currentValue) modelSelect.value = currentValue;
    if (window.refreshCustomSelects) window.refreshCustomSelects();
    return;
  }

  // Only show fetched models
  let html = '<option value="">选择默认模型</option>';
  html += '<optgroup label="从 URL 获取的模型">';
  for (const modelId of fetchedModels) {
    const provider = inferOpenClawProviderFromModel(modelId);
    const value = provider ? `${provider}/${modelId}` : modelId;
    const selected = currentValue === value ? ' selected' : '';
    html += `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(modelId)}</option>`;
  }
  html += '</optgroup>';

  modelSelect.innerHTML = html;
  if (currentValue) modelSelect.value = currentValue;
  if (window.refreshCustomSelects) window.refreshCustomSelects();
}

/** Infer OpenClaw provider prefix from a model ID string. */
function inferOpenClawProviderFromModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4') || id.startsWith('chatgpt')) return 'openai';
  if (id.startsWith('claude')) return 'anthropic';
  if (id.startsWith('gemini')) return 'google';
  if (id.startsWith('deepseek')) return 'deepseek';
  return '';
}


async function saveConfigOnly() {
  if (state.activeTool === 'claudecode') {
    return saveClaudeCodeConfigOnly();
  }
  if (state.activeTool === 'opencode') {
    return saveOpenCodeConfigOnly();
  }
  if (state.activeTool === 'openclaw') {
    return saveOpenClawConfigOnly();
  }
  const payload = currentPayload();
  const canReuseStoredKey = canUseStoredApiKey({ baseUrl: payload.baseUrl, providerKey: payload.providerKey });
  if (!(state.activeTool === 'codex' && state.codexAuthView === 'official' && state.current?.login?.loggedIn)) {
    if (!payload.baseUrl || (!payload.apiKey && !canReuseStoredKey)) return flash('先填 URL 和 API Key', 'error');
  }

  setBusy('saveBtn', true, '保存中...');
  const saved = await api('/api/config/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  setBusy('saveBtn', false);
  if (!saved.ok) return flash(saved.error || '保存失败', 'error');
  flash('配置已保存', 'success');
  await loadState({ preserveForm: true });
  await loadBackups();
  loadAppUpdateState();
}

async function saveOpenClawConfigOnly() {
  const currentQuick = deriveOpenClawQuickConfig(state.openclawState || {});
  const protocolSelect = el('openClawProtocolSelect');
  const apiMode = protocolSelect?.value || currentQuick.api || 'openai-completions';
  const selectedModel = el('modelSelect')?.value?.trim() || getOpenClawDefaultModel(apiMode);
  const rawBaseUrl = el('baseUrlInput')?.value?.trim() || '';
  const normalizedBaseUrl = normalizeOpenClawBaseUrl(rawBaseUrl || getOpenClawDefaultBaseUrl(apiMode), selectedModel, apiMode);
  const apiKey = el('apiKeyInput')?.value?.trim() || '';

  if (!selectedModel) return flash('先选一个默认模型', 'error');

  const envKey = currentQuick.envKey || inferOpenClawBuiltInEnvKey(selectedModel, apiMode) || getOpenClawDefaultEnvKey(apiMode);
  const canReuseStoredKey = currentQuick.hasApiKey && currentQuick.envKey === envKey;
  if (!apiKey && !canReuseStoredKey) {
    return flash('请填写和当前协议匹配的 API Key', 'error');
  }

  const config = cloneJson(state.openclawState?.config || {});
  config.env = config.env || {};
  if (apiKey) {
    config.env[envKey] = apiKey;
  }

  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = config.agents.defaults.model || {};

  const modelId = extractOpenClawCustomModelId(selectedModel) || selectedModel;
  const providerFamily = inferOpenClawProviderFromEnvKey(envKey, apiMode);
  const nextProviderAlias = rawBaseUrl
    ? buildOpenClawCustomProviderAlias(selectedModel, apiMode)
    : (String(selectedModel).split('/')[0] || providerFamily || 'openai');
  config.agents.defaults.model.primary = `${nextProviderAlias}/${modelId}`;

  config.models = config.models || {};
  config.models.mode = config.models.mode || 'merge';
  config.models.providers = config.models.providers || {};

  const previousAlias = String(currentQuick.storedModel || '').split('/')[0] || '';
  if (previousAlias && config.models.providers[previousAlias] && previousAlias !== nextProviderAlias && config.models.providers[previousAlias]?.baseUrl) {
    delete config.models.providers[previousAlias];
  }

  const existingProvider = cloneJson(config.models.providers[nextProviderAlias] || {});
  config.models.providers[nextProviderAlias] = {
    ...existingProvider,
    baseUrl: normalizedBaseUrl,
    api: apiMode,
    apiKey: '${' + envKey + '}',
    models: [
      buildOpenClawModelDefinition({
        modelRef: selectedModel,
        apiMode,
        modelName: inferOpenClawModelName(selectedModel),
      }),
    ],
  };

  setBusy('saveBtn', true, '保存中...');
  const saved = await api('/api/openclaw/config-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configJson: JSON.stringify(config, null, 2) }),
  });
  setBusy('saveBtn', false);
  if (!saved.ok) return flash(saved.error || '保存失败', 'error');

  flash('OpenClaw 配置已保存：协议、URL、模型、Token 都已自动适配', 'success');
  await loadOpenClawQuickState();
}

async function saveClaudeCodeConfigOnly() {
  const model = el('modelSelect')?.value || '';
  const apiKey = el('apiKeyInput')?.value?.trim() || '';
  const baseUrl = el('baseUrlInput')?.value?.trim() || '';

  // Safety: don't save OpenAI keys into Claude Code config
  if (apiKey && /^sk-(?!ant)/i.test(apiKey) && apiKey.length > 30) {
    flash('检测到 OpenAI Key，请勿填入 Claude Code 配置', 'error');
    return;
  }

  // If user manually changed URL and no provider is selected, infer one for this save.
  if (!state.claudeSelectedProviderKey && (baseUrl || model || apiKey)) {
    state.claudeSelectedProviderKey = inferClaudeProviderKey(baseUrl || '');
  }

  setBusy('saveBtn', true, '保存中...');
  const nextSettings = buildClaudeCodeSettingsFromFields({
    fromConfigEditor: false,
    preferOauthForOfficial: true,
  });
  const saved = await saveClaudeCodeSettingsJson(nextSettings);
  setBusy('saveBtn', false);
  if (!saved.ok) return flash(saved.error || '保存失败', 'error');
  await loadClaudeCodeQuickState({ force: false, cacheOnly: false });
  renderCurrentConfig();
  const activeProvider = getClaudeProviderByKey(state.claudeSelectedProviderKey);
  const providerLabel = activeProvider?.name || state.claudeSelectedProviderKey || '当前';
  flash(`Claude Code 配置已保存，当前 Provider：${providerLabel}`, 'success');
}

function getCodexLaunchCredentialWarning() {
  const data = state.current || {};
  const active = data.activeProvider || null;
  const providers = Array.isArray(data.providers) ? data.providers : [];
  const login = data.login || {};

  if (active) {
    if (active.hasApiKey) return '';
    return `当前 Provider「${active.name || active.key || '当前'}」还没配置 API Key；如果继续启动，通常无法直接请求模型。`;
  }

  if (providers.some((provider) => provider.hasApiKey)) return '';
  if (login.loggedIn) return '';
  return '当前还没有配置 API Key，也没有官方登录态；继续启动后通常无法直接请求模型。';
}

async function launchCodex(buttonId = 'launchBtn', successMessage = 'Codex 已启动', terminalProfile = '') {
  const codexInstalled = isCodexInstalled();
  if (!codexInstalled) {
    const installed = await installCodex({ silent: true });
    if (!installed) return false;
  }

  if (!(await preLaunchIpFirewallCheck('Codex'))) return false;

  const credentialWarning = getCodexLaunchCredentialWarning();
  setBusy(buttonId, true, '启动中...');
  const launched = await api('/api/codex/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: el('launchCwdInput').value.trim() || state.current?.launch?.cwd || '',
      terminalProfile: terminalProfile || getSelectedCodexTerminalProfile(),
    }),
  });
  setBusy(buttonId, false);
  if (!launched.ok) {
    flash(launched.error || '启动失败', 'error');
    return false;
  }
  const launchMessage = launched.data?.message || successMessage;
  flash(credentialWarning ? `${launchMessage}；注意：${credentialWarning}` : launchMessage, credentialWarning ? 'warning' : 'success');
  return true;
}

async function launchCodexLogin(buttonId = '', terminalProfile = '') {
  const codexInstalled = isCodexInstalled();
  if (!codexInstalled) {
    const installed = await installCodex({ silent: true });
    if (!installed) return false;
  }

  if (!(await preLaunchIpFirewallCheck('Codex 官方登录'))) return false;
  if (buttonId) setBusy(buttonId, true, '启动中...');
  const launched = await api('/api/codex/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: el('launchCwdInput').value.trim() || state.current?.launch?.cwd || '',
      terminalProfile: terminalProfile || getSelectedCodexTerminalProfile(),
    }),
  });
  if (buttonId) setBusy(buttonId, false);
  if (!launched.ok) {
    flash(launched.error || '启动官方登录失败', 'error');
    return false;
  }
  const launchMessage = launched.data?.message || '已在终端中打开 codex login';
  flash(`${launchMessage}，完成浏览器授权后点“重新检测登录状态”`, 'success');
  return true;
}

async function launchOpenClawOnly() {
  const launchBtn = el('launchBtn');
  const orig = launchBtn?.textContent || '启动 OpenClaw';
  if (!isOpenClawInstalled(state.openclawState || {})) {
    await openClawInstallMethodDialog(launchBtn);
    await loadTools();
    await loadOpenClawQuickState().catch((e) => console.warn('[launchOpenClawOnly] loadOpenClawQuickState failed:', e));
    return false;
  }
  if (launchBtn) launchBtn.textContent = '启动中...';


  // --- build launch tracker state ---
  const startedAt = Date.now();
  const launchSteps = [
    { key: 'check', title: '检查安装状态', desc: '确认 openclaw 是否已安装', status: 'running' },
    { key: 'config', title: '检查配置与初始化', desc: '检测配置文件和 onboard 状态', status: 'pending' },
    { key: 'gateway', title: '启动 Gateway 服务', desc: '后台启动 openclaw gateway', status: 'pending' },
    { key: 'ready', title: '打开 Dashboard', desc: '等待 Dashboard 上线并自动打开', status: 'pending' },
  ];
  let currentStep = 0;
  let detail = '正在获取 OpenClaw 状态…';
  let hint = '稍等一下，马上就好。';
  let gatewayUrl = '';
  let terminalMsg = '';
  let isBackgroundLaunch = false;
  const launchLogs = [];
  let launchTimerId = null;
  let lastStatusLabel = '启动中';
  let lastSummary = '正在检查 OpenClaw 状态…';

  function pushLog(text) {
    launchLogs.push({ text, at: new Date().toLocaleTimeString() });
    if (launchLogs.length > 50) launchLogs.shift();
  }
  pushLog('启动流程开始');

  function stepProgress() {
    return [15, 35, 65, 100][Math.min(currentStep, 3)];
  }

  function advanceStep(index, overrides = {}) {
    if (index <= currentStep && index < 3) return;
    currentStep = index;
    for (let i = 0; i < launchSteps.length; i++) {
      launchSteps[i].status = i < index ? 'done' : i === index ? 'running' : 'pending';
    }
    if (overrides.desc) launchSteps[index].desc = overrides.desc;
    if (overrides.detail) detail = overrides.detail;
    if (overrides.hint) hint = overrides.hint;
  }

  function elapsedText() {
    const sec = Math.floor((Date.now() - startedAt) / 1000);
    if (sec < 60) return `${sec}秒`;
    return `${Math.floor(sec / 60)}分${sec % 60}秒`;
  }

  function renderLaunchDialog(statusLabel, summary) {
    const progress = stepProgress();
    const stepsHtml = launchSteps.map((step, i) =>
      renderOpenClawInstallStep({ title: step.title, description: step.desc, status: step.status }, i, currentStep)
    ).join('');
    const logsHtml = launchLogs.map(l => `[${l.at}] ${l.text}`).join('\n') || '等待日志…';
    return `
      <div class="install-tracker">
        <div class="install-tracker-top">
          <div>
            <div class="install-tracker-status">${escapeHtml(statusLabel)}</div>
            <div class="install-tracker-summary">${escapeHtml(summary)}</div>
          </div>
          <div class="install-tracker-percent">${progress}%</div>
        </div>
        <div class="sti-progress install-tracker-bar"><div class="sti-progress-fill${currentStep < 3 ? ' indeterminate' : ''}" style="width:${progress}%"></div></div>
        <div class="install-tracker-hint">${escapeHtml(hint)}</div>
        <div class="install-tracker-detail">${escapeHtml(detail)}</div>
        <div class="install-tracker-grid">
          <div class="install-tracker-col">${stepsHtml}</div>
          <div class="install-tracker-col">
            <div class="install-tracker-note-card">
              <div class="install-tracker-note-title">当前状态</div>
              <ul class="install-tracker-list">
                <li>已用时：${elapsedText()}</li>
                ${gatewayUrl ? `<li>Dashboard：${escapeHtml(gatewayUrl)}</li>` : ''}
                ${terminalMsg ? `<li>${escapeHtml(terminalMsg)}</li>` : ''}
              </ul>
            </div>
            <div class="install-tracker-note-card">
              <div class="install-tracker-note-title">你现在该做什么</div>
              <ul class="install-tracker-list">
                <li>${currentStep <= 1 ? '不需要操作，自动检测中。' : currentStep === 2 ? '不需要操作，Gateway 状态会自动显示在这里。' : '一切就绪，Dashboard 马上打开。'}</li>
              </ul>
            </div>
          </div>
        </div>
        <div class="install-tracker-log-title">启动日志</div>
        <pre class="install-tracker-log">${escapeHtml(logsHtml)}</pre>
      </div>
    `;
  }

  function updateDialog(statusLabel, summary) {
    lastStatusLabel = statusLabel;
    lastSummary = summary;
    patchUpdateDialog({
      eyebrow: 'OpenClaw',
      title: statusLabel,
      body: renderLaunchDialog(statusLabel, summary),
      confirmText: currentStep >= 3 ? '关闭' : '启动中…',
      confirmDisabled: currentStep < 3,
      trackerMode: true,
    });
  }

  function stopTimer() {
    if (launchTimerId) { clearInterval(launchTimerId); launchTimerId = null; }
  }

  // --- open dialog immediately ---
  openUpdateDialog({
    eyebrow: 'OpenClaw',
    title: '启动中',
    body: renderLaunchDialog('启动中', '正在检查 OpenClaw 状态…'),
    confirmText: '启动中…',
    confirmOnly: true,
    trackerMode: true,
  });
  setUpdateDialogLocked(true, '启动进行中，请等待完成');
  patchUpdateDialog({ confirmDisabled: true, trackerMode: true });
  if (launchBtn) launchBtn.textContent = orig;

  // Live timer — refresh elapsed every second
  launchTimerId = setInterval(() => {
    if (currentStep >= 3) { stopTimer(); return; }
    updateDialog(lastStatusLabel, lastSummary);
  }, 1000);

  try {
    // === STEP 0: check install ===
    pushLog('正在获取 OpenClaw 状态…');
    let stateData;
    try {
      const json = await api('/api/openclaw/state', { timeoutMs: 15000 });
      if (!json.ok || !json.data) throw new Error(json.error || '读取状态失败');
      state.openclawState = json.data;
      stateData = json.data;
      pushLog('状态获取成功');
    } catch (fetchErr) {
      pushLog(`获取状态失败：${fetchErr.message}`);
      throw new Error(`无法读取 OpenClaw 状态：${fetchErr.message}`);
    }
    gatewayUrl = stateData.gatewayUrl || `http://127.0.0.1:${stateData.gatewayPort || 18789}/`;

    if (!stateData.binary?.installed) {
      pushLog('未检测到 openclaw 命令');
      advanceStep(0, { detail: '未检测到 openclaw 命令', hint: '请先在"工具安装"页面安装 OpenClaw。' });
      launchSteps[0].status = 'error';
      stopTimer();
      setUpdateDialogLocked(false);
      updateDialog('未安装', 'OpenClaw 尚未安装，请先完成安装');
      patchUpdateDialog({ confirmText: '关闭', confirmDisabled: false });
      return;
    }

    pushLog(`已检测到 openclaw ${stateData.binary.version || ''}`);
    detail = `已检测到 openclaw ${stateData.binary.version || ''}`;
    advanceStep(1, { detail, hint: '安装正常，正在检查配置…' });
    updateDialog('启动中', '安装检查通过，正在检查配置…');

    // === STEP 1: check config ===
    pushLog('正在检查配置文件…');

    if (!stateData.configExists || stateData.needsOnboarding) {
      pushLog('需要首次初始化');
      advanceStep(1, {
        detail: '正在执行自动初始化（非交互式）…',
        hint: '全部自动完成，不需要你操作。',
      });
      updateDialog('初始化中', '正在自动配置 OpenClaw…');

      // call non-interactive onboard
      pushLog('调用 openclaw onboard --non-interactive …');
      const onboardJson = await api('/api/openclaw/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        timeoutMs: 90000,
      });

      // Log the output
      const onboardData = onboardJson.data || {};
      if (onboardData.stdout) {
        for (const line of onboardData.stdout.split('\n').filter(Boolean)) {
          pushLog(line);
        }
      }
      if (onboardData.stderr) {
        pushLog(`stderr: ${onboardData.stderr}`);
      }
      const daemonInstallFailed = /Gateway service install failed|schtasks create failed|Access is denied|拒绝访问/i
        .test(`${onboardData.stdout || ''}\n${onboardData.stderr || ''}`);

      if (!onboardJson.ok && !onboardData.ok) {
        pushLog(`初始化失败：${onboardJson.error || onboardData.message || '未知错误'}`);
        throw new Error(onboardJson.error || onboardData.message || '自动初始化失败');
      }

      pushLog('✓ ' + (onboardData.message || '初始化完成'));
      terminalMsg = onboardData.message || '初始化完成';
      launchSteps[1].status = 'done';
      launchSteps[1].desc = '自动初始化完成';
      detail = onboardData.command || 'openclaw onboard --non-interactive';
      hint = '初始化已完成，正在检查 Gateway…';
      advanceStep(2, { detail, hint });
      updateDialog('启动中', '初始化完成，正在检查 Gateway…');
      if (daemonInstallFailed) {
        pushLog('检测到守护服务安装失败，改为手动启动 Gateway…');
      }

      // Brief poll to wait for gateway (daemon should start automatically)
      for (let attempt = 0; attempt < (daemonInstallFailed ? 2 : 20); attempt++) {
        await sleep(1500);
        try {
          const refreshed = await fetchOpenClawStateData();
          if (refreshed.gatewayReachable) {
            pushLog(`✓ Dashboard 已在线：${refreshed.gatewayUrl || gatewayUrl}`);
            advanceStep(3, { detail: `Dashboard 已在线：${refreshed.gatewayUrl || gatewayUrl}`, hint: '一切就绪！' });
            launchSteps[2].status = 'done';
            launchSteps[3].status = 'done';
            stopTimer();
            updateDialog('启动完成', 'OpenClaw 已准备好');
            setUpdateDialogLocked(false);
            patchUpdateDialog({ confirmText: '关闭', confirmDisabled: false });
            await repairOpenClawDashboard({ silent: true });
            flash('OpenClaw Dashboard 已打开', 'success');
            await loadOpenClawQuickState();
            return;
          }
          if (refreshed.gatewayPortListening) {
            pushLog(`Gateway 端口已启动：${refreshed.gatewayUrl || gatewayUrl}`);
            hint = 'Gateway 进程已启动，正在等待控制面板就绪…';
            updateDialog('启动中', 'Gateway 已启动，等待控制面板就绪…');
          }
          if (attempt % 5 === 4) {
            pushLog(`第 ${attempt + 1} 次检测：Gateway=${refreshed.gatewayReachable ? '在线' : refreshed.gatewayPortListening ? '启动中' : '未响应'}`);
          }
        } catch { /* ignore */ }
      }

      pushLog('Gateway 还未就绪，正在补发手动启动命令…');
      const launchJson = await api('/api/openclaw/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: state.current?.launch?.cwd || '' }),
      });
      if (!launchJson.ok) {
        throw new Error(launchJson.error || '启动 Gateway 失败');
      }

      isBackgroundLaunch = Boolean(launchJson.data?.background);
      terminalMsg = launchJson.data?.message || '启动命令已发送';
      pushLog(terminalMsg);
      if (launchJson.data?.command) {
        pushLog(`命令：${launchJson.data.command}`);
      }
      detail = launchJson.data?.command || 'openclaw gateway start';
      hint = isBackgroundLaunch
        ? '已补发后台启动命令，正在等待 Gateway 服务响应…'
        : '已补发 Gateway 启动命令，正在等待服务响应…';
      updateDialog('启动中', isBackgroundLaunch ? 'Gateway 已在后台启动，等待服务响应…' : 'Gateway 启动命令已发送，等待服务响应…');

      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(1500);
        try {
          const refreshed = await fetchOpenClawStateData();
          if (refreshed.gatewayReachable) {
            pushLog(`✓ Dashboard 已在线：${refreshed.gatewayUrl || gatewayUrl}`);
            advanceStep(3, { detail: `Dashboard 已在线：${refreshed.gatewayUrl || gatewayUrl}`, hint: '一切就绪！' });
            launchSteps[2].status = 'done';
            launchSteps[3].status = 'done';
            stopTimer();
            updateDialog('启动完成', 'OpenClaw 已准备好');
            setUpdateDialogLocked(false);
            patchUpdateDialog({ confirmText: '关闭', confirmDisabled: false });
            await repairOpenClawDashboard({ silent: true });
            flash('OpenClaw Dashboard 已打开', 'success');
            await loadOpenClawQuickState();
            return;
          }
          if (attempt % 5 === 4) {
            pushLog(`第 ${attempt + 1} 次补发后检测：Gateway=${refreshed.gatewayReachable ? '在线' : '未响应'}`);
          }
        } catch { /* ignore */ }
      }

      pushLog('Gateway 还未就绪，但初始化已完成');
      hint = '初始化已完成，但 Gateway 尚未响应。可稍后重试，或点“刷新状态”再次检测。';
      stopTimer();
      updateDialog('初始化完成', isBackgroundLaunch ? 'Gateway 仍未就绪，请查看这里的日志' : 'Gateway 仍未就绪，请稍后刷新状态');
      setUpdateDialogLocked(false);
      patchUpdateDialog({ confirmText: '关闭', confirmDisabled: false });
      return;
    }

    // config exists, no onboarding needed
    pushLog('✓ 配置文件就绪');
    launchSteps[1].status = 'done';
    launchSteps[1].desc = `配置文件就绪${stateData.binary.version ? ` · ${stateData.binary.version}` : ''}`;
    advanceStep(2, { detail: '配置正常', hint: '正在检查 Gateway 状态…' });
    updateDialog('启动中', '配置检查通过…');

    // === STEP 2: check/start gateway ===
    pushLog(`正在检测 Gateway：${gatewayUrl}`);

    if (stateData.gatewayReachable) {
      // Gateway already up — skip straight to done
      pushLog('✓ Gateway 已在运行中');
      launchSteps[2].status = 'done';
      launchSteps[2].desc = 'Gateway 已在运行中';
      advanceStep(3, { detail: `Dashboard 已在线：${gatewayUrl}`, hint: '直接打开！' });
      launchSteps[3].status = 'done';
      stopTimer();
      updateDialog('启动完成', 'Dashboard 已就绪');
      setUpdateDialogLocked(false);
      patchUpdateDialog({ confirmText: '关闭', confirmDisabled: false });
      await repairOpenClawDashboard({ silent: true });
      flash('OpenClaw Dashboard 已打开', 'success');
      return;
    }

    if (stateData.gatewayPortListening) {
      pushLog('Gateway 已在启动中，继续等待就绪…');
      detail = `Gateway 端口已启动：${gatewayUrl}`;
      hint = '服务进程已经起来了，正在等待控制面板完全就绪。';
      updateDialog('启动中', 'Gateway 已启动，等待控制面板就绪…');
    } else {
      pushLog('Gateway 未运行，正在启动…');
      detail = '正在启动 Gateway…';
      hint = '启动后这里会自动显示日志并检测服务状态。';
      updateDialog('启动中', '正在启动 Gateway 服务…');

      pushLog('调用 /api/openclaw/launch …');
      const launchJson = await api('/api/openclaw/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: state.current?.launch?.cwd || '' }),
      });
      if (!launchJson.ok) {
        throw new Error(launchJson.error || '启动 Gateway 失败');
      }

      isBackgroundLaunch = Boolean(launchJson.data?.background);
      terminalMsg = launchJson.data?.message || '启动命令已发送';
      pushLog(terminalMsg);
      if (launchJson.data?.command) pushLog(`命令：${launchJson.data.command}`);
      detail = launchJson.data?.command || 'openclaw gateway start';
      hint = isBackgroundLaunch
        ? '已在后台启动，正在等待 Gateway 服务响应…'
      : '启动命令已发送，正在等待 Gateway 服务响应…';
    updateDialog('启动中', isBackgroundLaunch ? 'Gateway 已在后台启动，等待服务响应…' : 'Gateway 命令已执行，等待服务响应…');
    }

    // === STEP 3: poll until gateway is reachable ===
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(1500);
      try {
        const refreshed = await fetchOpenClawStateData();
        if (refreshed.gatewayReachable) {
          pushLog(`✓ Gateway 已响应：${refreshed.gatewayUrl || gatewayUrl}`);
          launchSteps[2].status = 'done';
          launchSteps[2].desc = 'Gateway 已启动';
          advanceStep(3, { detail: `Dashboard 在线：${refreshed.gatewayUrl || gatewayUrl}`, hint: '一切就绪！' });
          launchSteps[3].status = 'done';
          stopTimer();
          updateDialog('启动完成', 'OpenClaw Dashboard 已准备好');
          setUpdateDialogLocked(false);
          patchUpdateDialog({ confirmText: '关闭', confirmDisabled: false });
          await repairOpenClawDashboard({ silent: true });
          flash('OpenClaw Dashboard 已打开', 'success');
          await loadOpenClawQuickState();
          return;
        }
        if (refreshed.gatewayPortListening) {
          launchSteps[2].desc = 'Gateway 已启动，等待控制面板就绪';
          detail = `Gateway 端口已启动：${refreshed.gatewayUrl || gatewayUrl}`;
          hint = `Gateway 已启动，正在等待控制面板响应…（第 ${attempt + 1} 次检测）`;
          updateDialog('启动中', 'Gateway 已启动，等待控制面板就绪…');
        }
        if (attempt % 5 === 4) {
          pushLog(`第 ${attempt + 1} 次轮询：Gateway ${refreshed.gatewayPortListening ? '启动中' : '仍未响应'}`);
        }
        if (!refreshed.gatewayPortListening) {
          hint = `正在等待 Gateway 响应…（第 ${attempt + 1} 次检测）`;
          updateDialog('启动中', 'Gateway 启动中，等待服务响应…');
        }
      } catch { /* ignore */ }
    }

    // timed out waiting for gateway
    pushLog('等待超时：Gateway 未在预期时间内响应');
    hint = 'Gateway 可能需要手动检查。你也可以直接在浏览器访问 Dashboard 地址试试。';
    launchSteps[2].desc = 'Gateway 未在预期时间内响应';
    stopTimer();
    updateDialog('等待超时', 'Gateway 还未就绪，请查看日志并稍后重试');
    setUpdateDialogLocked(false);
    patchUpdateDialog({ confirmText: '关闭', confirmDisabled: false });
  } catch (e) {
    pushLog(`错误：${e.message || '启动失败'}`);
    stopTimer();
    setUpdateDialogLocked(false);
    patchUpdateDialog({
      eyebrow: 'OpenClaw',
      title: '启动失败',
      body: renderLaunchDialog('启动失败', e.message || '启动失败'),
      confirmText: '关闭',
      confirmDisabled: false,
      trackerMode: true,
    });
    flash(e.message || '启动失败', 'error');
  }
}

async function launchClaudeCodeOnly() {
  const launchBtn = el('launchBtn');
  const orig = launchBtn?.textContent || '启动 Claude Code';
  if (!isClaudeCodeInstalled(state.claudeCodeState || {})) {
    setBusy('launchBtn', true, '安装中...');
    const json = await api('/api/claudecode/install', { method: 'POST', timeoutMs: 180000 });
    setBusy('launchBtn', false);
    if (!json.ok || json.data?.ok === false) {
      flash(json.error || json.data?.stderr || 'Claude Code 安装失败', 'error');
      return false;
    }
    await loadTools();
await loadClaudeCodeQuickState({ force: false, cacheOnly: false }).catch((e) => console.warn('[launchClaudeCodeOnly] loadClaudeCodeQuickState failed:', e));
    return true;
  }
  if (!(await preLaunchIpFirewallCheck('Claude Code'))) return false;
  if (launchBtn) launchBtn.textContent = '启动中...';
  try {
    const json = await api('/api/claudecode/launch', {
      method: 'POST',
      body: { cwd: state.current?.launch?.cwd || '' },
    });
    if (json.ok) {
      flash(json.data?.message || 'Claude Code 已启动', 'success');
    } else {
      flash(json.error || '启动失败', 'error');
    }
  } catch (e) {
    flash(e.message || '启动失败', 'error');
  } finally {
    if (launchBtn) launchBtn.textContent = orig;
  }
}

async function launchClaudeCodeOAuthLogin(buttonId = 'claudeOauthLoginBtn') {
  const button = el(buttonId);
  const originalText = button?.textContent || 'OAuth 登录';
  if (button) {
    button.disabled = true;
    button.textContent = '启动中...';
  }
  try {
    const json = await api('/api/claudecode/login', {
      method: 'POST',
      body: { cwd: state.current?.launch?.cwd || '' },
    });
    if (!json.ok) {
      flash(json.error || '启动 OAuth 登录失败', 'error');
      return false;
    }
    flash('已在终端中打开 Claude Code OAuth 登录，请完成浏览器授权后点击刷新状态', 'success');
    return true;
  } catch (error) {
    flash(error instanceof Error ? error.message : '启动 OAuth 登录失败', 'error');
    return false;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function installCodex({ silent = false } = {}) {
  const ok = await runCodexAction('updateCodexBtn', '/api/codex/install', '安装中...', silent ? '' : 'Codex 安装完成');
  return ok;
}

async function reinstallCodex() {
  const confirmed = await openUpdateDialog({
    eyebrow: 'Codex',
    title: '重装 Codex',
    body: '<p>这会重新全局安装当前稳定版 Codex。</p>',
    confirmText: '确认重装',
    cancelText: '取消',
  });
  if (!confirmed) return;
  await runCodexAction('reinstallCodexBtn', '/api/codex/reinstall', '重装中...', 'Codex 重装完成');
}

async function uninstallCodex() {
  const confirmed = await openUpdateDialog({
    eyebrow: 'Codex',
    title: '卸载 Codex',
    body: '<p>卸载后将无法直接从工具里启动 Codex。</p>',
    confirmText: '确认卸载',
    cancelText: '取消',
    tone: 'danger',
  });
  if (!confirmed) return;
  await runCodexAction('uninstallCodexBtn', '/api/codex/uninstall', '卸载中...', 'Codex 已卸载');
}

async function updateCodex() {
  const release = await getReleaseInfo();
  if (!release) return;

  if (!release.isInstalled) {
    const confirmed = window.confirm(`未检测到 Codex。\n最新稳定版：${release.latestStable || '未知'}\n预览版：${release.latestAlpha || '无'}\n\n是否立即安装稳定版？`);
    if (!confirmed) return;
    await installCodex();
    return;
  }

  if (!release.hasStableUpdate) {
    window.alert(`当前版本：${release.currentVersion || '未知'}\n最新稳定版：${release.latestStable || '未知'}\n预览版：${release.latestAlpha || '无'}\n\n当前已经是最新稳定版。`);
    return;
  }

  const confirmed = window.confirm(`当前版本：${release.currentVersion}\n最新稳定版：${release.latestStable}\n预览版：${release.latestAlpha || '无'}\n\n确定更新到稳定版 ${release.latestStable} 吗？`);
  if (!confirmed) return;
  await runCodexAction('updateCodexBtn', '/api/codex/update', '更新中...', `Codex 已更新到 ${release.latestStable}`);
}

async function restoreBackup(name) {
  const json = await api('/api/backups/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      backupName: name,
      scope: el('scopeSelect').value,
      projectPath: el('projectPathInput').value.trim(),
      codexHome: el('codexHomeInput').value.trim(),
    }),
  });
  if (!json.ok) return flash(json.error || '恢复失败', 'error');
  flash('备份已恢复', 'success');
  await loadState({ preserveForm: false });
  await loadBackups();
}

/* ── Welcome / Onboarding ── */

function isFirstVisit() {
  return !localStorage.getItem('easyaiconfig_onboarded');
}

function markOnboarded() {
  localStorage.setItem('easyaiconfig_onboarded', Date.now().toString());
}

function showWelcome() {
  const overlay = el('welcomeOverlay');
  overlay.classList.remove('hide');
  overlay.setAttribute('aria-hidden', 'false');
  el('welcomeStatusHint').textContent = '';
  el('welcomeStatusHint').className = 'welcome-hint';
}

function hideWelcome() {
  const overlay = el('welcomeOverlay');
  overlay.classList.add('hide');
  overlay.setAttribute('aria-hidden', 'true');
}

async function handleExpertPath() {
  // Show detecting state
  const hint = el('welcomeStatusHint');
  hint.textContent = '正在快速检测环境…';
  hint.className = 'welcome-hint detecting';
  el('welcomeExpertBtn').style.pointerEvents = 'none';
  el('welcomeBeginnerBtn').style.pointerEvents = 'none';

  try {
    const json = await api('/api/setup/check');
    if (json.ok) {
      const env = json.data;
      const allGood = env.node?.installed && env.node?.sufficient
        && env.npm?.installed && env.codex?.installed
        && env.config?.hasProviders;

      if (allGood) {
        // Everything ready, go directly to main
        hint.textContent = '\u2713 环境就绪，正在进入…';
        hint.className = 'welcome-hint';
        markOnboarded();
        await new Promise(r => setTimeout(r, 600));
        hideWelcome();
        return;
      }
      // Something missing, show hint then open wizard
      const missing = [];
      if (!env.codex?.installed) missing.push('Codex CLI');
      if (!env.config?.hasProviders) missing.push('API 配置');
      hint.textContent = `! 缺少: ${missing.join('、')}，即将启动配置向导…`;
      hint.className = 'welcome-hint';
      markOnboarded();
      await new Promise(r => setTimeout(r, 1000));
      hideWelcome();
      openSetupWizard();
    } else {
      hint.textContent = '检测失败，将启动配置向导…';
      hint.className = 'welcome-hint';
      markOnboarded();
      await new Promise(r => setTimeout(r, 800));
      hideWelcome();
      openSetupWizard();
    }
  } catch (err) {
    hint.textContent = '检测出错，将启动配置向导…';
    hint.className = 'welcome-hint';
    markOnboarded();
    await new Promise(r => setTimeout(r, 800));
    hideWelcome();
    openSetupWizard();
  } finally {
    el('welcomeExpertBtn').style.pointerEvents = '';
    el('welcomeBeginnerBtn').style.pointerEvents = '';
  }
}

async function handleBeginnerPath() {
  markOnboarded();
  const hint = el('welcomeStatusHint');
  hint.textContent = '正在启动配置向导…';
  hint.className = 'welcome-hint detecting';
  await new Promise(r => setTimeout(r, 400));
  hideWelcome();
  openSetupWizard();
}

/* ── Setup Wizard ── */

function setWizardStep(step) {
  state.wizardStep = step;
  document.querySelectorAll('.wizard-step').forEach((node) => {
    const idx = Number(node.dataset.wizardStep);
    node.classList.toggle('active', idx === step);
    node.classList.toggle('done', idx < step);
  });
  document.querySelectorAll('.wizard-panel').forEach((panel) => {
    const idx = Number(panel.dataset.wizardPanel);
    panel.classList.toggle('active', idx === step);
  });
}

function openSetupWizard() {
  state.wizardOpen = true;
  state.wizardStep = 0;
  state.wizardEnv = null;
  state.wizardDetected = null;
  state.wizardSelectedTool = 'codex';
  state.wizardSelectedMethod = 'npm';
  const overlay = el('setupWizard');
  overlay.classList.remove('hide');
  overlay.setAttribute('aria-hidden', 'false');
  // Reset UI for all steps
  setWizardStep(0);
  resetWizardEnvUI();
  resetWizardInstallUI();
  resetWizardConfigUI();
  // Run environment check
  runWizardEnvCheck();
}

function closeSetupWizard() {
  state.wizardOpen = false;
  // Remember that user dismissed the wizard — don't auto-open next time
  localStorage.setItem('easyaiconfig_wizard_dismissed', '1');
  const overlay = el('setupWizard');
  overlay.classList.add('hide');
  overlay.setAttribute('aria-hidden', 'true');
}

function resetWizardEnvUI() {
  ['wcNode', 'wcNpm', 'wcConfig'].forEach((id) => {
    const item = el(id);
    if (!item) return;
    item.className = 'wc-item';
    const indicator = item.querySelector('.wc-indicator');
    if (indicator) indicator.className = 'wc-indicator loading';
  });
  el('wcNodeStatus').textContent = '检测中…';
  el('wcNpmStatus').textContent = '检测中…';
  el('wcConfigStatus').textContent = '检测中…';
  el('wizardEnvSummary').textContent = '';
  el('wizardEnvNextBtn').disabled = true;
  el('wizardEnvRetryBtn').style.display = 'none';
}

function resetWizardInstallUI() {
  el('wizardInstallProgress').classList.add('hide');
  el('wizardInstallResult').classList.add('hide');
  el('wizardInstallResult').className = 'wib-result hide';
  el('wizardInstallResult').textContent = '';
  el('wizardInstallBtn').style.display = '';
  el('wizardInstallBtn').disabled = false;
  el('wizardInstallSkipBtn').style.display = 'none';
  el('wizardInstallNextBtn').style.display = 'none';
  // Reset tool picker selection
  document.querySelectorAll('.wizard-tool-card').forEach(c => {
    c.classList.toggle('active', c.dataset.wizardTool === state.wizardSelectedTool);
  });
  renderWizardInstallMethods();
}

function resetWizardConfigUI() {
  el('wizardBaseUrl').value = '';
  el('wizardApiKey').value = '';
  el('wizardDetectStatus').textContent = '';
  el('wizardDetectStatus').className = 'wizard-detect-status';
  el('wizardModelField').style.display = 'none';
  renderDefaultCodexModels(el('wizardModelSelect'), '');
  el('wizardConfigNextBtn').disabled = true;
  state.wizardDetected = null;
}

function setWcItemStatus(itemId, statusId, tone, statusText) {
  const item = document.getElementById(itemId);
  const indicator = item?.querySelector('.wc-indicator');
  if (item) item.className = `wc-item ${tone}`;
  if (indicator) indicator.className = `wc-indicator ${tone}`;
  const statusEl = document.getElementById(statusId);
  if (statusEl) statusEl.textContent = statusText;
}

async function runWizardEnvCheck() {
  resetWizardEnvUI();
  try {
    const json = await api('/api/setup/check');
    if (!json.ok) {
      el('wizardEnvSummary').textContent = `检测失败：${json.error || '未知错误'}`;
      el('wizardEnvRetryBtn').style.display = '';
      return;
    }
    const env = json.data;
    state.wizardEnv = env;

    // Animate results with staggered delays
    await new Promise(r => setTimeout(r, 200));
    // Node.js
    if (env.node.installed && env.node.sufficient) {
      setWcItemStatus('wcNode', 'wcNodeStatus', 'ok', env.node.version);
    } else if (env.node.installed) {
      setWcItemStatus('wcNode', 'wcNodeStatus', 'warn', `${env.node.version} (需要 ≥18)`);
    } else {
      setWcItemStatus('wcNode', 'wcNodeStatus', 'fail', '未安装');
    }

    await new Promise(r => setTimeout(r, 150));
    // npm
    if (env.npm.installed) {
      setWcItemStatus('wcNpm', 'wcNpmStatus', 'ok', `v${env.npm.version}`);
    } else {
      setWcItemStatus('wcNpm', 'wcNpmStatus', 'fail', '未安装');
    }

    await new Promise(r => setTimeout(r, 150));
    // Config
    if (env.config.exists && (env.config.hasProviders || env.config.hasLogin)) {
      setWcItemStatus('wcConfig', 'wcConfigStatus', 'ok', '已配置');
    } else if (env.config.exists) {
      setWcItemStatus('wcConfig', 'wcConfigStatus', 'warn', env.config.hasLogin ? '已登录官方账号' : '无 Provider');
    } else {
      setWcItemStatus('wcConfig', 'wcConfigStatus', 'warn', '未创建');
    }

    // Summary — use inline SVG mini-icons instead of emoji
    const _i = (d) => `<svg class="wes-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const _warn = _i('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>');
    const _ok = _i('<circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/>');
    const _pkg = _i('<path d="M12 3v12M12 15l-4-4M12 15l4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>');
    const _bolt = _i('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>');
    const _tools = _i('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>');

    const lines = [];
    if (!env.node.installed) {
      lines.push(`${_warn} Node.js 未安装，请先安装 Node.js ≥18`);
    } else if (!env.node.sufficient) {
      lines.push(`${_warn} Node.js 版本过低 (${env.node.version})，需要 ≥18`);
    }
    if (!env.npm.installed) {
      lines.push(`${_warn} npm 未安装`);
    }
    // Check all tools
    const toolsInstalled = [];
    if (env.codex?.installed) toolsInstalled.push('Codex');
    if (state.tools.find(t => t.id === 'claudecode')?.binary?.installed) toolsInstalled.push('Claude Code');
    if (state.tools.find(t => t.id === 'opencode')?.binary?.installed) toolsInstalled.push('OpenCode');
    if (state.tools.find(t => t.id === 'openclaw')?.binary?.installed) toolsInstalled.push('OpenClaw');
    if (toolsInstalled.length > 0) {
      lines.push(`${_tools} 已安装：${toolsInstalled.join('、')}`);
    } else {
      lines.push(`${_pkg} 下一步选择要安装的 AI 工具`);
    }
    if (!env.config.hasProviders && !env.config.hasLogin) {
      lines.push(`${_bolt} 需要配置 API Provider`);
    } else if (env.login?.loggedIn) {
      lines.push(`${_ok} 已识别 Codex 官方登录：${escapeHtml(env.login.plan || env.login.email || 'OpenAI / ChatGPT')}`);
    }
    if (toolsInstalled.length > 0 && (env.config.hasProviders || env.config.hasLogin)) {
      lines.push(`${_ok} 环境已就绪！可以跳过向导，直接使用主界面。`);
    }
    el('wizardEnvSummary').innerHTML = lines.join('<br>');

    // Can proceed if Node+npm exist
    const canProceed = env.node.installed && env.node.sufficient && env.npm.installed;
    el('wizardEnvNextBtn').disabled = !canProceed;
    el('wizardEnvRetryBtn').style.display = '';

  } catch (err) {
    el('wizardEnvSummary').textContent = `检测出错：${err.message || err}`;
    el('wizardEnvRetryBtn').style.display = '';
  }
}

const WIZARD_TOOL_META = {
  codex: {
    name: 'Codex CLI',
    package: '@openai/codex',
    installApi: '/api/codex/install',
    methods: [{ id: 'npm', label: 'npm', cmd: 'npm install -g @openai/codex' }],
    binaryKey: 'codex',
    configLabel: '~/.codex/config.toml',
  },
  claudecode: {
    name: 'Claude Code',
    package: '@anthropic-ai/claude-code',
    installApi: '/api/claudecode/install',
    methods: [{ id: 'npm', label: 'npm', cmd: 'npm install -g @anthropic-ai/claude-code' }],
    binaryKey: 'claudecode',
    configLabel: '~/.claude/settings.json',
  },
  opencode: {
    name: 'OpenCode',
    package: 'opencode / opencode-ai',
    installApi: '/api/opencode/install',
    methods: navigator.platform?.startsWith('Win')
      ? [
        { id: 'auto', label: '自动检测', cmd: '自动检测 Google 可达性：可访问走官方，不可访问走国内 npm 镜像', tag: '默认推荐' },
        { id: 'domestic', label: '国内优化', cmd: 'npm i -g opencode-ai@latest --registry=https://registry.npmmirror.com', tag: '国内' },
        { id: 'npm', label: 'npm', cmd: 'npm i -g opencode-ai@latest', tag: '官方' },
        { id: 'scoop', label: 'Scoop', cmd: 'scoop install opencode', tag: '官方' },
        { id: 'choco', label: 'Chocolatey', cmd: 'choco install opencode', tag: '官方' },
      ]
      : [
        { id: 'auto', label: '自动检测', cmd: '自动检测 Google 可达性：可访问走官方脚本，不可访问走国内 npm 镜像', tag: '默认推荐' },
        { id: 'domestic', label: '国内优化', cmd: 'npm i -g opencode-ai@latest --registry=https://registry.npmmirror.com', tag: '国内' },
        { id: 'script', label: '官方脚本', cmd: 'curl -fsSL https://opencode.ai/install | bash', tag: '官方推荐' },
        { id: 'brew', label: 'Homebrew', cmd: 'brew install anomalyco/tap/opencode', tag: '官方' },
        { id: 'npm', label: 'npm', cmd: 'npm i -g opencode-ai@latest' },
      ],
    binaryKey: 'opencode',
    configLabel: '~/.config/opencode/opencode.json',
  },
  openclaw: {
    name: 'OpenClaw',
    package: 'openclaw',
    installApi: '/api/openclaw/install',
    methods: navigator.platform?.startsWith('Win')
      ? [
        { id: 'domestic', label: '一键安装', cmd: 'npm install -g openclaw@latest --registry=https://registry.npmmirror.com', tag: '默认推荐' },
        { id: 'wsl', label: 'WSL2', cmd: 'wsl -d Ubuntu-24.04 -- bash -lc "curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm"', tag: '高级' },
        { id: 'script', label: '官方脚本', cmd: "$env:OPENCLAW_NO_ONBOARD='1'; iwr -useb https://openclaw.ai/install.ps1 | iex", tag: '官方' },
      ]
      : [
        { id: 'script', label: '一键脚本', cmd: 'curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm', tag: '推荐' },
        { id: 'npm', label: 'npm', cmd: 'npm install -g openclaw@latest' },
        { id: 'source', label: '源码', cmd: 'git clone + pnpm build', tag: '开发者' },
        { id: 'docker', label: 'Docker', cmd: './docker-setup.sh', tag: '服务器' },
      ],
    binaryKey: 'openclaw',
    configLabel: '~/.openclaw/openclaw.json',
  },
};

function renderWizardInstallMethods() {
  const tool = state.wizardSelectedTool;
  const meta = WIZARD_TOOL_META[tool];
  const container = el('wizardInstallMethods');
  if (!container || !meta) return;

  // If only one method, hide the selector
  const area = el('wizardInstallMethodArea');
  if (meta.methods.length <= 1) {
    if (area) area.style.display = 'none';
    state.wizardSelectedMethod = meta.methods[0].id;
  } else {
    if (area) area.style.display = '';
  }

  container.innerHTML = meta.methods.map(m => `
    <button class="wizard-method-pill ${m.id === state.wizardSelectedMethod ? 'active' : ''}" data-wizard-method="${m.id}">
      <span>${m.label}</span>
      ${m.tag ? `<span class="wmp-tag">${m.tag}</span>` : ''}
    </button>
  `).join('');

  // Update command display
  const selected = meta.methods.find(m => m.id === state.wizardSelectedMethod) || meta.methods[0];
  const cmdEl = el('wizardInstallCommand');
  if (cmdEl) cmdEl.textContent = selected.cmd;
}

function selectWizardTool(toolId) {
  state.wizardSelectedTool = toolId;
  const meta = WIZARD_TOOL_META[toolId];
  // Default to first method
  state.wizardSelectedMethod = meta?.methods[0]?.id || 'npm';
  // Toggle active class
  document.querySelectorAll('.wizard-tool-card').forEach(c => {
    c.classList.toggle('active', c.dataset.wizardTool === toolId);
  });
  renderWizardInstallMethods();
  // Check if already installed
  const binary = state.tools.find(t => t.id === toolId)?.binary;
  if (binary?.installed) {
    el('wizardInstallBtn').style.display = 'none';
    el('wizardInstallSkipBtn').style.display = '';
    el('wizardInstallNextBtn').style.display = '';
    el('wizardInstallResult').classList.remove('hide');
    el('wizardInstallResult').className = 'wib-result success';
    el('wizardInstallResult').textContent = `${meta.name} 已安装 (${binary.version || '已安装'})，可直接跳过此步。`;
  } else {
    el('wizardInstallBtn').style.display = '';
    el('wizardInstallBtn').disabled = false;
    el('wizardInstallSkipBtn').style.display = 'none';
    el('wizardInstallNextBtn').style.display = 'none';
    el('wizardInstallResult').classList.add('hide');
  }
}

function wizardGoToInstall() {
  const env = state.wizardEnv;
  setWizardStep(1);
  resetWizardInstallUI();
  // Check if selected tool is already installed from tools data
  selectWizardTool(state.wizardSelectedTool);
}

async function wizardRunInstall() {
  const tool = state.wizardSelectedTool;
  const method = state.wizardSelectedMethod;
  const meta = WIZARD_TOOL_META[tool];
  const selectedMethod = meta.methods.find(m => m.id === method);

  // Source / Docker → show instruction dialog (multi-step manual)
  if (method === 'source' || method === 'docker') {
    const titles = { source: '源码构建步骤', docker: 'Docker 部署步骤' };
    let instructions = [selectedMethod?.cmd || ''];
    let message = '请打开终端（Terminal），粘贴以下命令执行。';
    try {
      const json = await api(meta.installApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method }),
      });
      if (json.ok && json.data?.instructions?.length) instructions = json.data.instructions;
      if (json.data?.message) message = json.data.message;
    } catch { /* use fallback */ }

    const cmds = instructions.map(c => `<code class="install-cmd-line">${escapeHtml(c)}</code>`).join('');
    const copyId = 'wizardCopyCmdBtn_' + Date.now();
    await openUpdateDialog({
      eyebrow: meta.name,
      title: titles[method] || '安装步骤',
      body: `
        <div class="install-cmd-block">${cmds}</div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:12px;">
          <button id="${copyId}" class="secondary" style="font-size:0.78rem;padding:5px 12px;">复制命令</button>
          <span style="font-size:0.76rem;opacity:0.6;">${escapeHtml(message)}</span>
        </div>
      `,
      confirmText: '知道了',
      confirmOnly: true,
    });
    document.getElementById(copyId)?.addEventListener('click', () => {
      navigator.clipboard.writeText(instructions.join('\n')).then(() => {
        const btn = document.getElementById(copyId);
        if (btn) { btn.textContent = '已复制 ✓'; setTimeout(() => { btn.textContent = '复制命令'; }, 1500); }
      });
    });
    return;
  }

  // Script / npm → auto-execute via backend
  const taskId = addTask(`安装 ${meta.name} (${method})`);
  el('wizardInstallBtn').disabled = true;
  const progressEl = el('wizardInstallProgress');
  const cmdText = selectedMethod?.cmd || '';
  if (tool === 'opencode') {
    progressEl.classList.add('hide');
    progressEl.innerHTML = '<div class="wib-spinner"></div>';
  } else {
    progressEl.classList.remove('hide');
    progressEl.innerHTML = `
      <div class="wib-spinner"></div>
      <div class="wib-progress-info">
        <div style="font-size:0.82rem;font-weight:600;">正在安装 ${escapeHtml(meta.name)}…</div>
        <code style="font-size:0.72rem;opacity:0.6;margin-top:4px;display:block;word-break:break-all;">${escapeHtml(cmdText)}</code>
      </div>
    `;
  }
  el('wizardInstallResult').classList.add('hide');

  try {
    if (tool === 'openclaw') {
      const finalTask = await runTrackedOpenClawInstall(method, (task) => {
        const lastLog = (task.logs || []).at(-1)?.text || task.command || cmdText;
        progressEl.innerHTML = `
          <div class="wib-progress-bar"><div class="wib-progress-fill" style="width:${Math.max(4, task.progress || 0)}%"></div></div>
          <div class="wib-progress-info">
            <div style="font-size:0.82rem;font-weight:600;">${escapeHtml(task.summary || '正在安装 OpenClaw…')}</div>
            <div style="font-size:0.74rem;opacity:0.7;line-height:1.5;">${escapeHtml(task.detail || task.hint || '')}</div>
            <code style="font-size:0.7rem;opacity:0.6;margin-top:4px;display:block;word-break:break-all;">${escapeHtml(lastLog)}</code>
          </div>
        `;
        // Sync to sidebar task
        updateTask(taskId, {
          status: task.status === 'running' ? 'running' : task.status === 'success' ? 'done' : 'error',
          progress: Math.max(4, task.progress || 0),
          message: task.summary || '',
        });
      });

      progressEl.classList.add('hide');
      progressEl.innerHTML = '<div class="wib-spinner"></div>';

      if (finalTask.status === 'success') {
        el('wizardInstallResult').classList.remove('hide');
        el('wizardInstallResult').className = 'wib-result success';
        el('wizardInstallResult').innerHTML = `
          <div>✓ ${escapeHtml(meta.name)} 安装成功！</div>
          ${finalTask.version ? `<div style="font-size:0.76rem;opacity:0.6;margin-top:2px;">版本：${escapeHtml(finalTask.version)}</div>` : ''}
        `;
        el('wizardInstallBtn').style.display = 'none';
        el('wizardInstallNextBtn').style.display = '';
        loadTools();
        updateTask(taskId, { status: 'done', progress: 100, message: finalTask.version ? `已安装 ${finalTask.version}` : '安装完成' });
      } else {
        el('wizardInstallResult').classList.remove('hide');
        el('wizardInstallResult').className = 'wib-result error';
        el('wizardInstallResult').innerHTML = `
          <div>安装失败</div>
          <pre style="font-size:0.72rem;opacity:0.7;margin-top:6px;max-height:120px;overflow:auto;white-space:pre-wrap;word-break:break-all;">${escapeHtml(finalTask.error || '未知错误')}</pre>
        `;
        el('wizardInstallBtn').disabled = false;
        updateTask(taskId, { status: 'error', message: finalTask.error || '安装失败' });
      }
      return;
    }

    if (tool === 'opencode') {
      const result = await runOpenCodeToolAction('install', null, { method, suppressFlash: true });
      progressEl.classList.add('hide');
      progressEl.innerHTML = '<div class="wib-spinner"></div>';

      if (result?.ok) {
        const version = state.tools.find(t => t.id === 'opencode')?.binary?.version || result.data?.stdout?.match(/[\d]+\.[\d]+\.[\d]+/)?.[0] || '';
        const methodText = result.data?.method ? `方式：${getOpenCodeMethodLabel(result.data.method)}` : '';
        el('wizardInstallResult').classList.remove('hide');
        el('wizardInstallResult').className = 'wib-result success';
        el('wizardInstallResult').innerHTML = `
          <div>✓ ${escapeHtml(meta.name)} 安装成功！</div>
          ${version ? `<div style="font-size:0.76rem;opacity:0.6;margin-top:2px;">版本：${escapeHtml(version)}</div>` : ''}
          ${methodText ? `<div style="font-size:0.76rem;opacity:0.6;margin-top:2px;">${escapeHtml(methodText)}</div>` : ''}
        `;
        el('wizardInstallBtn').style.display = 'none';
        el('wizardInstallNextBtn').style.display = '';
        updateTask(taskId, { status: 'done', progress: 100, message: version ? `已安装 ${version}` : '安装完成' });
      } else {
        el('wizardInstallResult').classList.remove('hide');
        el('wizardInstallResult').className = 'wib-result error';
        el('wizardInstallResult').innerHTML = `
          <div>安装失败</div>
          <pre style="font-size:0.72rem;opacity:0.7;margin-top:6px;max-height:120px;overflow:auto;white-space:pre-wrap;word-break:break-all;">${escapeHtml(result?.error || '未知错误')}</pre>
        `;
        el('wizardInstallBtn').disabled = false;
        updateTask(taskId, { status: 'error', message: result?.error || '安装失败' });
      }
      return;
    }

    const bodyPayload = (tool === 'openclaw' || tool === 'opencode') ? { method } : undefined;
    const json = await api(meta.installApi, {
      method: 'POST',
      headers: bodyPayload ? { 'Content-Type': 'application/json' } : undefined,
      body: bodyPayload ? JSON.stringify(bodyPayload) : undefined,
      timeoutMs: 180000,
    });
    progressEl.classList.add('hide');
    progressEl.innerHTML = '<div class="wib-spinner"></div>';

    if (json.ok && (json.data?.ok !== false)) {
      el('wizardInstallResult').classList.remove('hide');
      el('wizardInstallResult').className = 'wib-result success';
      const version = json.data?.stdout?.match(/[\d]+\.[\d]+\.[\d]+/)?.[0];
      el('wizardInstallResult').innerHTML = `
        <div>\u2713 ${escapeHtml(meta.name)} 安装成功！</div>
        ${version ? `<div style="font-size:0.76rem;opacity:0.6;margin-top:2px;">版本：${escapeHtml(version)}</div>` : ''}
      `;
      el('wizardInstallBtn').style.display = 'none';
      el('wizardInstallNextBtn').style.display = '';
      loadTools(); // Refresh tool state
      updateTask(taskId, { status: 'done' });
    } else {
      const errMsg = json.data?.stderr || json.error || '未知错误';
      el('wizardInstallResult').classList.remove('hide');
      el('wizardInstallResult').className = 'wib-result error';
      el('wizardInstallResult').innerHTML = `
        <div>安装失败</div>
        <pre style="font-size:0.72rem;opacity:0.7;margin-top:6px;max-height:120px;overflow:auto;white-space:pre-wrap;word-break:break-all;">${escapeHtml(errMsg)}</pre>
      `;
      el('wizardInstallBtn').disabled = false;
      updateTask(taskId, { status: 'error' });
    }
  } catch (err) {
    progressEl.classList.add('hide');
    progressEl.innerHTML = '<div class="wib-spinner"></div>';
    el('wizardInstallResult').classList.remove('hide');
    el('wizardInstallResult').className = 'wib-result error';
    el('wizardInstallResult').textContent = `安装出错：${err.message || err}`;
    el('wizardInstallBtn').disabled = false;
    updateTask(taskId, { status: 'error' });
  }
}

function wizardGoToConfig() {
  const tool = state.wizardSelectedTool;
  const meta = WIZARD_TOOL_META[tool];

  // OpenClaw: skip config step, go directly to complete
  if (tool === 'openclaw') {
    setWizardStep(3);
    const descEl = el('wizardCompleteDesc');
    if (descEl) descEl.textContent = `${meta.name} 已安装完成，可通过 openclaw onboard 进行配置。`;
    el('wizardCompleteSummary').innerHTML = [
      ['工具', meta.name],
      ['配置目录', meta.configLabel],
    ].map(([label, value]) =>
      `<div class="wcs-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
    ).join('');
    el('wizardLaunchBtn').textContent = `启动 ${meta.name}`;
    return;
  }

  setWizardStep(2);
  resetWizardConfigUI();

  // Claude Code: adjust field labels
  if (tool === 'claudecode') {
    el('wizardBaseUrl').placeholder = 'ANTHROPIC_BASE_URL (留空则使用官方)';
    el('wizardApiKey').placeholder = 'ANTHROPIC_API_KEY (可选)';
  } else {
    el('wizardBaseUrl').placeholder = 'https://your-provider.com/v1';
    el('wizardApiKey').placeholder = 'sk-...';
  }

  // Pre-fill from main form if available
  const mainUrl = el('baseUrlInput').value.trim();
  const mainKey = el('apiKeyInput').value.trim();
  if (mainUrl) el('wizardBaseUrl').value = mainUrl;
  if (mainKey) el('wizardApiKey').value = mainKey;
  wizardUpdateConfigBtn();
}

function wizardUpdateConfigBtn() {
  const hasUrl = el('wizardBaseUrl').value.trim();
  const hasKey = el('wizardApiKey').value.trim();
  el('wizardConfigNextBtn').disabled = !hasUrl || !hasKey;
}

async function wizardDetectModels() {
  const baseUrl = state.wizardSelectedTool === 'claudecode'
    ? normalizeClaudeBaseUrl(el('wizardBaseUrl').value)
    : normalizeBaseUrl(el('wizardBaseUrl').value);
  const apiKey = el('wizardApiKey').value.trim();
  if (!baseUrl || !apiKey) {
    el('wizardDetectStatus').textContent = '请先填写 URL 和 Key';
    el('wizardDetectStatus').className = 'wizard-detect-status error';
    return;
  }

  el('wizardDetectStatus').textContent = '检测中…';
  el('wizardDetectStatus').className = 'wizard-detect-status';
  setBusy('wizardDetectBtn', true, '检测中…');

  try {
    const json = await api('/api/provider/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey }),
      timeoutMs: 18000,
    });
    setBusy('wizardDetectBtn', false);

    if (!json.ok) {
      el('wizardDetectStatus').textContent = json.error || '检测失败';
      el('wizardDetectStatus').className = 'wizard-detect-status error';
      return;
    }

    state.wizardDetected = json.data;
    state.wizardDetected.recommendedModel = pickRecommendedModel(json.data.models, json.data.recommendedModel);
    el('wizardDetectStatus').textContent = `成功 · ${json.data.models.length} 个模型`;
    el('wizardDetectStatus').className = 'wizard-detect-status success';

    // Populate model select
    const models = json.data.models || [];
    const recommended = state.wizardDetected.recommendedModel;
    el('wizardModelSelect').innerHTML = models.map((m) =>
      `<option value="${escapeHtml(m)}" ${m === recommended ? 'selected' : ''}>${escapeHtml(m)}</option>`
    ).join('') || '<option value="">无可用模型</option>';
    el('wizardModelField').style.display = '';
    // Initialize custom select
    if (window.initCustomSelect) {
      window.initCustomSelect(el('wizardModelSelect'));
    }

    el('wizardConfigNextBtn').disabled = false;
  } catch (err) {
    setBusy('wizardDetectBtn', false);
    el('wizardDetectStatus').textContent = err.message || '检测出错';
    el('wizardDetectStatus').className = 'wizard-detect-status error';
  }
}

async function wizardSaveAndComplete() {
  const tool = state.wizardSelectedTool;
  const meta = WIZARD_TOOL_META[tool];
  const baseUrl = tool === 'claudecode'
    ? normalizeClaudeBaseUrl(el('wizardBaseUrl').value)
    : normalizeBaseUrl(el('wizardBaseUrl').value);
  const apiKey = el('wizardApiKey').value.trim();
  const model = el('wizardModelSelect').value || (state.wizardDetected?.recommendedModel || '');
  const providerKey = inferProviderKey(baseUrl);

  setBusy('wizardConfigNextBtn', true, '保存中…');
  try {
    let json;
    if (tool === 'claudecode') {
      // Save Claude Code config
      const payload = {};
      if (apiKey) payload.env = { ANTHROPIC_API_KEY: apiKey };
      if (baseUrl && !baseUrl.includes('api.anthropic.com')) payload.env = { ...payload.env, ANTHROPIC_BASE_URL: baseUrl };
      json = await api('/api/claudecode/config-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else if (tool === 'codex') {
      // Save Codex config
      json = await api('/api/config/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'global',
          projectPath: '',
          codexHome: '',
          providerKey,
          providerLabel: inferProviderLabel(baseUrl),
          baseUrl,
          apiKey,
          envKey: inferEnvKey(providerKey),
          model,
          approvalPolicy: '',
          sandboxMode: '',
          reasoningEffort: '',
        }),
      });
    } else {
      throw new Error('OpenClaw 向导不写入 Codex 配置，请在主界面单独保存 OpenClaw 配置。');
    }
    setBusy('wizardConfigNextBtn', false);

    if (!json.ok) {
      flash(json.error || '保存失败', 'error');
      return;
    }

    // Go to complete step
    setWizardStep(3);
    const descEl = el('wizardCompleteDesc');
    if (descEl) descEl.textContent = `你的 ${meta.name} 已经配置好了，可以开始使用了`;
    el('wizardLaunchBtn').textContent = `启动 ${meta.name}`;

    el('wizardCompleteSummary').innerHTML = [
      ['工具', meta.name],
      ['Model', model || '—'],
      ['Base URL', baseUrl],
      ['配置文件', meta.configLabel],
    ].map(([label, value]) =>
      `<div class="wcs-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
    ).join('');

    // Sync main form  (Codex only)
    if (tool === 'codex') {
      el('baseUrlInput').value = baseUrl;
      state.providerSecrets[providerKey] = apiKey;
      state.apiKeyField = {
        providerKey,
        baseUrl,
        maskedValue: '',
        actualValue: apiKey,
        hasStored: true,
        revealed: false,
        dirty: false,
      };
      el('apiKeyInput').value = '';
      el('apiKeyInput').type = 'password';
      el('apiKeyInput').placeholder = '已保存，刷新后显示掩码';
      syncApiKeyToggle();
      if (model) renderModelOptions([], model);
      state.metaDirty = false;
      applyDerivedMeta(true);
    }

    // Reload main state in background
    loadState({ preserveForm: false }).then(() => loadBackups());
  } catch (err) {
    setBusy('wizardConfigNextBtn', false);
    flash(err.message || '保存出错', 'error');
  }
}

function bindEvents() {
  el('baseUrlInput').addEventListener('input', () => {
    _markCurrentToolFieldDirty('baseUrl', el('baseUrlInput').value);
    applyDerivedMeta(false);
  });
  el('baseUrlInput').addEventListener('blur', () => {
    const rawValue = el('baseUrlInput').value;
    const value = state.activeTool === 'openclaw'
      ? normalizeOpenClawBaseUrl(rawValue, el('modelSelect')?.value || '', el('openClawProtocolSelect')?.value || '')
      : state.activeTool === 'claudecode'
        ? normalizeClaudeBaseUrl(rawValue)
        : normalizeBaseUrl(rawValue);
    if (value) {
      el('baseUrlInput').value = value;
      _markCurrentToolFieldDirty('baseUrl', value);
    }
    applyDerivedMeta(false);
    if ((state.activeTool === 'codex' || state.activeTool === 'opencode' || state.activeTool === 'openclaw') && value) {
      tryAutoFetchModels();
    }
  });
  el('claudeProviderKeyInput')?.addEventListener('input', (event) => {
    if (state.activeTool !== 'claudecode') return;
    const normalized = normalizeProviderKey(event.target.value || '');
    _markCurrentToolFieldDirty('providerKey', event.target.value || '');
    state.claudeSelectedProviderKey = normalized || state.claudeSelectedProviderKey || '';
    renderCurrentConfig();
  });
  el('claudeProviderKeyInput')?.addEventListener('blur', (event) => {
    const normalized = normalizeProviderKey(event.target.value || '');
    event.target.value = normalized;
    _markCurrentToolFieldDirty('providerKey', normalized);
    if (state.activeTool === 'claudecode' && normalized) {
      state.claudeSelectedProviderKey = normalized;
      renderCurrentConfig();
    }
  });
  el('apiKeyInput').addEventListener('input', () => {
    _markCurrentToolFieldDirty('apiKey', el('apiKeyInput').value);
    const raw = el('apiKeyInput').value.trim();
    const currentActual = state.apiKeyField.actualValue.trim();
    state.apiKeyField.dirty = Boolean(raw) && (!state.apiKeyField.hasStored || !currentActual || raw !== currentActual);
    renderQuickSummary();
  });
  el('apiKeyToggleBtn').addEventListener('click', toggleApiKeyVisibility);
  el('detectBtn').addEventListener('click', detectModels);
  el('codexAuthTabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-codex-auth-view]');
    if (!button) return;
    state.codexAuthView = button.dataset.codexAuthView === 'api_key' ? 'api_key' : 'official';
    localStorage.setItem('easyaiconfig_codex_auth_view', state.codexAuthView);
    syncCodexAuthView();
  });
  el('codexOfficialAuthPanel')?.addEventListener('click', async (event) => {
    const loginButton = event.target.closest('[data-codex-start-login]');
    if (loginButton) {
      await launchCodexLogin();
      return;
    }
    if (event.target.closest('[data-codex-switch-api]')) {
      state.codexAuthView = 'api_key';
      localStorage.setItem('easyaiconfig_codex_auth_view', state.codexAuthView);
      syncCodexAuthView();
      flash('已切换到 API Key 配置模式', 'success');
      return;
    }
    if (event.target.closest('[data-codex-apply-official]')) {
      await saveConfigOnly();
      return;
    }
    if (event.target.closest('[data-codex-refresh-login]')) {
      await loadState({ preserveForm: true });
      flash('Codex 登录状态已刷新', 'success');
    }
  });

  // Model refresh button (inline, next to model select)
  el('modelRefreshBtn')?.addEventListener('click', () => {
    const params = _getDetectParams();
    if (!params.baseUrl || (!params.apiKey && !params.useStored)) {
      flash('先填 URL 和 API Key', 'error');
      return;
    }
    const btn = el('modelRefreshBtn');
    btn?.classList.add('spinning');
    tryAutoFetchModels().finally(() => {
      btn?.classList.remove('spinning');
    });
  });

  // Auto-fetch models when model select is opened (for OpenClaw / OpenCode)
  let _lastModelFetch = 0;
  el('modelSelect')?.addEventListener('mousedown', () => {
    if (state.activeTool !== 'openclaw' && state.activeTool !== 'opencode') return;
    const now = Date.now();
    if (now - _lastModelFetch < 5000) return; // Debounce: skip if fetched < 5s ago
    _lastModelFetch = now;
    const params = _getDetectParams();
    if (params.baseUrl && (params.apiKey || params.useStored)) {
      tryAutoFetchModels();
    }
  });

  el('editConfigQuickBtn').addEventListener('click', () => setConfigEditorOpen(true));
  el('ocHeaderConfigSwitch')?.addEventListener('click', (e) => {
    const button = e.target.closest('[data-oc-config-view]');
    if (!button) return;
    setOpenClawConfigView(button.dataset.ocConfigView || 'full');
  });
  // ── Sync from environment buttons ──
  el('syncFromCodexBtn')?.addEventListener('click', syncFromCodexEnv);
  el('syncFromClaudeBtn')?.addEventListener('click', syncFromClaudeCodeEnv);
  // Task filter buttons
  el('taskFilters')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.task-filter');
    if (!btn) return;
    el('taskFilters').querySelectorAll('.task-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _taskPageFilter = btn.dataset.filter;
    renderTasksPage();
  });
  el('saveBtn').addEventListener('click', saveConfigOnly);
  el('claudeOauthLoginBtn')?.addEventListener('click', () => launchClaudeCodeOAuthLogin('claudeOauthLoginBtn'));
  el('launchBtn').addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.activeTool === 'codex') {
      let platform = state.current?.launch?.platform || '';
      let profiles = getCodexTerminalProfiles();
      if ((platform === 'win32' || platform === 'darwin') && !profiles.length) {
        await loadState({ preserveForm: true });
        platform = state.current?.launch?.platform || platform;
        profiles = getCodexTerminalProfiles();
      }
      if (platform === 'win32' || platform === 'darwin') {
        if (state.codexTerminalMenuOpen) closeCodexTerminalMenu();
        else openCodexTerminalMenu();
        return false;
      }
    }
    await launchCodexOnly();
    return false;
  });
  // OpenClaw dashboard quick button
  if (el('ocOpenDashboardBtn')) {
    el('ocOpenDashboardBtn').addEventListener('click', async () => {
      if (state._ocGatewayUrl) {
        await repairOpenClawDashboard({ silent: true });
        flash('OpenClaw Dashboard 已打开', 'success');
      }
    });
  }
  // OpenClaw stop button
  if (el('ocStopBtn')) {
    el('ocStopBtn').addEventListener('click', async () => {
      const btn = el('ocStopBtn');
      const orig = btn.textContent;
      btn.textContent = '停止中...';
      btn.disabled = true;
      try {
        const result = await stopOpenClawGateway({ manual: false });
        if (!result?.ok) throw new Error(result?.error || '停止失败');
        await refreshToolRuntimeAfterMutation('openclaw');
        flash(result.data?.message || 'OpenClaw 已停止', 'success');
      } catch (e) {
        flash('停止失败：' + (e.message || e), 'error');
      } finally {
        btn.textContent = orig;
        btn.disabled = false;
      }
    });
  }

  if (el('ocDaemonBtn')) {
    el('ocDaemonBtn').addEventListener('click', async () => {
      const btn = el('ocDaemonBtn');
      const data = state.openclawState || await fetchOpenClawStateData();
      const enable = !data.daemonInstalled;
      const orig = btn.textContent;
      btn.textContent = enable ? '开启中...' : '关闭中...';
      btn.disabled = true;
      try {
        const result = await setOpenClawDaemonEnabled(enable, { manual: false });
        if (!result?.ok) throw new Error(result?.error || (enable ? '开启失败' : '关闭失败'));
        flash(result.data?.message || (enable ? 'OpenClaw 常驻服务已开启' : 'OpenClaw 常驻服务已关闭'), 'success');
      } catch (e) {
        flash((enable ? '开启常驻失败：' : '关闭常驻失败：') + (e.message || e), 'error');
      } finally {
        btn.textContent = orig;
        btn.disabled = false;
      }
    });
  }
  // Tool selector tabs
  el('toolSelector')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.tool-tab');
    if (tab && !tab.disabled) setActiveTool(tab.dataset.tool);
  });
  // Secondary-panel tool list (new shell)
  el('secondaryToolList')?.addEventListener('click', (e) => {
    const item = e.target.closest('.sec-item[data-sec-tool]');
    if (!item || item.disabled) return;
    const targetTool = item.dataset.secTool;
    if (state.activePage !== 'quick') setPage('quick');
    setActiveTool(targetTool);
  });
  el('appUpdateBtn').addEventListener('click', async () => {
    const info = await loadAppUpdateState({ manual: true });
    if (!info) {
      flash('检测客户端更新失败，请检查网络连接', 'error');
      return;
    }
    if (info.networkBlocked) {
      flash(info.statusMessage || '你的网络可能无法访问 GitHub 更新源，暂时无法检查更新。', 'error');
      return;
    }
    if (info.available) {
      return handleAppUpdate();
    }
    flash(`客户端已是最新版本 v${info.currentVersion || '-'}`, 'success');
  });
  el('updateCodexBtn')?.addEventListener('click', updateCodex);
  el('reinstallCodexBtn')?.addEventListener('click', reinstallCodex);
  el('uninstallCodexBtn')?.addEventListener('click', uninstallCodex);
  el('refreshBtn').addEventListener('click', () => loadState({ preserveForm: true }));
  el('reloadBackupsBtn').addEventListener('click', loadBackups);
  el('codexResumeRefreshBtn')?.addEventListener('click', () => loadCodexResumeSessions({ silent: false }));
  el('codexResumeLastBtn')?.addEventListener('click', async (event) => {
    await triggerCodexResumeAction('resume', event.currentTarget, { last: true });
  });
  el('codexResumeScopeBtn')?.addEventListener('click', () => {
    state.codexResumeShowAll = !state.codexResumeShowAll;
    renderCodexResumeSessions();
    loadCodexResumeSessions({ silent: true });
  });
  el('launchCwdInput')?.addEventListener('blur', () => loadCodexResumeSessions({ silent: true }));
  el('codexHomeInput')?.addEventListener('blur', () => loadCodexResumeSessions({ silent: true }));
  el('codexTerminalMenu')?.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-codex-terminal-launch]');
    if (!option) return;
    const selectedProfile = String(option.dataset.codexTerminalLaunch || 'auto').trim() || 'auto';
    state.codexTerminalProfile = selectedProfile;
    renderCodexTerminalPicker();
    closeCodexTerminalMenu();
    await launchCodexOnly(selectedProfile);
  });

  el('codexResumeSessions')?.addEventListener('click', async (event) => {
    const resumeBtn = event.target.closest('[data-codex-resume-id]');
    if (resumeBtn) {
      await triggerCodexResumeAction('resume', resumeBtn, { sessionId: resumeBtn.dataset.codexResumeId || '' });
      return;
    }
    const forkBtn = event.target.closest('[data-codex-fork-id]');
    if (forkBtn) {
      await triggerCodexResumeAction('fork', forkBtn, { sessionId: forkBtn.dataset.codexForkId || '' });
      return;
    }
    const detailBtn = event.target.closest('[data-codex-detail-path]');
    if (detailBtn) {
      await openCodexSessionDetailByPath(detailBtn.dataset.codexDetailPath || '');
      return;
    }
    const exportBtn = event.target.closest('[data-codex-export-path]');
    if (exportBtn) {
      await exportCodexSessionByPath(exportBtn.dataset.codexExportPath || '', 'jsonl');
      return;
    }
    const copyCommandBtn = event.target.closest('[data-codex-copy-resume-command]');
    if (copyCommandBtn) {
      try {
        await copyText(copyCommandBtn.dataset.codexCopyResumeCommand || '');
        flash('恢复命令已复制', 'success');
      } catch {
        flash('复制失败', 'error');
      }
    }
  });

  // ── Quick Shortcut buttons ──
  function applyShortcut(patch, label) {
    // Apply values to config editor fields
    if ('model_reasoning_effort' in patch) el('cfgReasoningSelect').value = patch.model_reasoning_effort || '';
    if ('plan_mode_reasoning_effort' in patch) el('cfgPlanReasoningSelect').value = patch.plan_mode_reasoning_effort || '';
    if ('service_tier' in patch) el('cfgServiceTierSelect').value = patch.service_tier || '';
    if ('model_context_window' in patch) {
      el('cfgContextWindowInput').value = patch.model_context_window || '';
      el('cfgContextWindowRange').value = patch.model_context_window || 272000;
    }
    if ('model_auto_compact_token_limit' in patch) {
      el('cfgCompactLimitInput').value = patch.model_auto_compact_token_limit || '';
      el('cfgCompactLimitRange').value = patch.model_auto_compact_token_limit || 244800;
    }
    // Update active state
    document.querySelectorAll('.shortcut-btn').forEach(b => b.classList.remove('active'));
    const activeBtn = { 'Fast': 'shortcutFast', '1M Token': 'shortcut1M', 'Max': 'shortcutMaxPerf', '默认': 'shortcutReset' }[label];
    if (activeBtn) el(activeBtn)?.classList.add('active');
    // Auto-save the config settings
    saveSettingsFromEditor().then(() => {
      flash(`已切换到「${label}」模式`, 'success');
    });
  }

  async function saveSettingsFromEditor() {
    const patch = buildSettingsPatch();
    const payload = {
      scope: el('scopeSelect').value || 'global',
      projectPath: el('projectPathInput').value.trim(),
      codexHome: el('codexHomeInput').value.trim(),
      settings: patch,
    };
    const json = await api('/api/config/settings-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!json.ok) flash(json.error || '配置保存失败', 'error');
    await loadState({ preserveForm: true });
    populateConfigEditor();
  }

  // ── Config Store button ──
  if (el('openConfigStoreBtn')) {
    el('openConfigStoreBtn').addEventListener('click', openConfigStore);
  }

  // ── Config Store modal events ──
  const csModal = el('configStoreModal');
  if (csModal) {
    // Close on backdrop click
    csModal.querySelector('.config-store-backdrop')?.addEventListener('click', closeConfigStore);
    // Close button
    el('configStoreCloseBtn')?.addEventListener('click', closeConfigStore);

    // Search input
    const csSearchInput = el('configStoreSearchInput');
    if (csSearchInput) {
      csSearchInput.addEventListener('input', renderConfigStoreCards);
    }

    // Category tabs
    el('configStoreCategories')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-store-cat]');
      if (!btn) return;
      _configStoreActiveCat = btn.dataset.storeCat;
      renderConfigStoreCategories();
      renderConfigStoreCards();
    });

    // Card clicks
    el('configStoreGrid')?.addEventListener('click', (e) => {
      const card = e.target.closest('[data-store-recipe-id]');
      if (!card) return;
      const recipe = getRecipeById(card.dataset.storeRecipeId);
      if (!recipe) return;
      openConfigStoreGuide(recipe);
    });

    el('configStoreSuggestions')?.addEventListener('click', (e) => {
      const button = e.target.closest('[data-store-suggestion]');
      if (!button) return;
      const query = button.dataset.storeSuggestion || '';
      if (el('configStoreSearchInput')) el('configStoreSearchInput').value = query;
      if (el('configStoreAssistantInput')) el('configStoreAssistantInput').value = query;
      renderConfigStoreCards();
      runCurrentConfigStoreAssistant();
    });

    el('configStoreAssistantRunBtn')?.addEventListener('click', runCurrentConfigStoreAssistant);
    el('configStoreAssistantInput')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      runCurrentConfigStoreAssistant();
    });
    el('configStoreAssistantResult')?.addEventListener('click', (e) => {
      const button = e.target.closest('[data-store-assistant-open]');
      if (!button) return;
      const recipe = getRecipeById(button.dataset.storeAssistantOpen);
      if (!recipe) return;
      const presetValues = state.configStoreAssistant.recipeId === recipe.id ? (state.configStoreAssistant.values || {}) : {};
      openConfigStoreGuide(recipe, presetValues);
    });

    // ESC key — close confirm modal first, then config store
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const confirmModal = el('recipeConfirmModal');
        if (confirmModal && !confirmModal.classList.contains('hide')) {
          closeRecipeConfirm();
          return;
        }
        if (!csModal.classList.contains('hide')) {
          closeConfigStore();
        }
      }
    });
  }

  // Recipe confirm modal listeners
  el('recipeConfirmApplyBtn')?.addEventListener('click', executeRecipeConfirm);
  el('recipeConfirmCancelBtn')?.addEventListener('click', closeRecipeConfirm);
  el('recipeConfirmCloseBtn')?.addEventListener('click', closeRecipeConfirm);
  el('recipeConfirmModal')?.querySelector('.recipe-confirm-backdrop')?.addEventListener('click', closeRecipeConfirm);
  el('openClawProtocolSelect')?.addEventListener('change', (event) => {
    if (state.activeTool !== 'openclaw') return;
    const synced = syncOpenClawQuickProtocol(event.target.value, el('modelSelect')?.value || '');
    const baseUrlInput = el('baseUrlInput');
    if (baseUrlInput && baseUrlInput.value.trim()) {
      baseUrlInput.value = normalizeOpenClawBaseUrl(baseUrlInput.value, synced.model, synced.api);
    }
    syncOpenClawQuickHints(synced.api, {
      maskedApiKey: state.openClawQuickConfig?.maskedApiKey || '',
      hasStoredKey: Boolean(state.openClawQuickConfig?.hasApiKey),
    });
    renderCurrentConfig();
  });
  el('modelSelect').addEventListener('change', (event) => {
    if (state.activeTool === 'openclaw' || state.activeTool === 'opencode') {
      renderCurrentConfig();
      return;
    }
    renderModelOptions(state.detected?.models || [], event.target.value);
  });
  el('modelChips').addEventListener('click', (event) => {
    const button = event.target.closest('[data-model]');
    if (!button) return;
    renderModelOptions(state.detected?.models || [], button.dataset.model);
  });
  el('savedProviders').addEventListener('click', async (event) => {
    const checkBtn = event.target.closest('[data-check-provider]');
    if (checkBtn) {
      const providerKey = checkBtn.dataset.checkProvider;
      const provider = (state.current?.providers || []).find((item) => item.key === providerKey);
      if (!provider) return;
      const result = await testCodexProviderConnectivity(provider, { delayMs: 420 });
      if (!result.ok) flash(result.error || '检测失败', 'error');
      else flash(`Provider「${provider.name || provider.key}」已连通`, 'success');
      return;
    }
    const button = event.target.closest('[data-load-provider]');
    if (!button) return;
    const providerKey = button.dataset.loadProvider;
    const provider = (state.current?.providers || []).find((item) => item.key === providerKey);
    if (!provider) return;
    const switched = await quickSwitchCodexProvider(provider);
    if (!switched.ok) return flash(switched.error || '切换失败', 'error');
    flash(`已切换到 Provider「${provider.name || provider.key}」`, 'success');
  });
  el('ccCfgProviderList')?.addEventListener('click', async (event) => {
    const actionBtn = event.target.closest('[data-cc-provider-action]');
    if (actionBtn) {
      event.preventDefault();
      event.stopPropagation();
      const providerKey = actionBtn.dataset.ccProviderKey || '';
      const provider = getClaudeProviderByKey(providerKey);
      if (!provider) return;

      if (actionBtn.dataset.ccProviderAction === 'switch') {
        const switched = await saveClaudeProviderFormInConfigEditor({ switchOnly: true, provider });
        if (!switched.ok) return flash(switched.error || '切换失败', 'error');
        flash(`已切换到 Provider「${switched.providerKey}」`, 'success');
        return;
      }

      if (actionBtn.dataset.ccProviderAction === 'check') {
        const checked = await testClaudeProviderConnectivity(provider, { delayMs: 420 });
        if (!checked.ok) return flash(checked.error || '检测失败', 'error');
        flash(`Provider「${provider.name || provider.key}」已连通`, 'success');
        return;
      }
    }

    const row = event.target.closest('[data-cc-open-provider]');
    if (!row) return;
    const provider = getClaudeProviderByKey(row.dataset.ccOpenProvider || '');
    if (!provider) return;
    state.claudeProviderDetailKey = state.claudeProviderDetailKey === provider.key ? '' : (provider.key || '');
    populateClaudeCodeConfigEditor();
  });
  el('ccProviderDetailCloseBtn')?.addEventListener('click', () => {
    state.claudeProviderDetailKey = '';
    populateClaudeCodeConfigEditor();
  });
  el('ccProviderOpenCreateBtn')?.addEventListener('click', openClaudeProviderCreateModal);
  el('ccProviderCreateCloseBtn')?.addEventListener('click', closeClaudeProviderCreateModal);
  el('ccProviderCreateCancelBtn')?.addEventListener('click', closeClaudeProviderCreateModal);
  el('ccProviderCreateModal')?.querySelector('.oc-recipe-modal-backdrop')?.addEventListener('click', closeClaudeProviderCreateModal);
  el('ccProviderCreateSaveBtn')?.addEventListener('click', async () => {
    setBusy('ccProviderCreateSaveBtn', true, '创建中...');
    const created = await createClaudeProviderFromModal();
    setBusy('ccProviderCreateSaveBtn', false);
    if (!created.ok) return flash(created.error || '创建失败', 'error');
    closeClaudeProviderCreateModal();
    flash(`Provider「${created.providerKey}」已创建并设为当前`, 'success');
  });
  el('ccProviderFormApplyBtn')?.addEventListener('click', () => {
    const result = applyClaudeProviderFormToConfigEditor({ includeSecrets: true });
    if (!result.providerKey) return flash('Provider Key 无效', 'error');
    flash('已载入到主表单，点击“保存配置”后生效', 'success');
  });
  el('ccProviderFormSwitchBtn')?.addEventListener('click', async () => {
    setBusy('ccProviderFormSwitchBtn', true, '切换中...');
    const switched = await saveClaudeProviderFormInConfigEditor({ switchOnly: true });
    setBusy('ccProviderFormSwitchBtn', false);
    if (!switched.ok) return flash(switched.error || '切换失败', 'error');
    flash(`已切换到 Provider「${switched.providerKey}」`, 'success');
  });
  el('ccProviderFormSaveBtn')?.addEventListener('click', async () => {
    setBusy('ccProviderFormSaveBtn', true, '保存中...');
    const saved = await saveClaudeProviderFormInConfigEditor({ switchOnly: false });
    setBusy('ccProviderFormSaveBtn', false);
    if (!saved.ok) return flash(saved.error || '保存失败', 'error');
    flash(`Provider「${saved.providerKey}」已保存并设为当前`, 'success');
  });
  el('ccProviderFormKey')?.addEventListener('blur', (event) => {
    event.target.value = normalizeProviderKey(event.target.value || '');
  });
  el('ccProviderFormBaseUrl')?.addEventListener('blur', (event) => {
    const normalized = normalizeClaudeBaseUrl(event.target.value || '');
    event.target.value = normalized;
    const keyInput = el('ccProviderFormKey');
    if (keyInput && !keyInput.value.trim()) {
      keyInput.value = normalizeProviderKey(inferClaudeProviderKey(normalized || ''));
    }
    const nameInput = el('ccProviderFormName');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = inferClaudeProviderLabel(normalized || '');
    }
  });
  el('ccProviderCreateKey')?.addEventListener('blur', (event) => {
    event.target.value = normalizeProviderKey(event.target.value || '');
  });
  el('ccProviderCreateBaseUrl')?.addEventListener('blur', (event) => {
    const normalized = normalizeClaudeBaseUrl(event.target.value || '');
    event.target.value = normalized;
    const keyInput = el('ccProviderCreateKey');
    if (keyInput && !keyInput.value.trim()) {
      keyInput.value = normalizeProviderKey(inferClaudeProviderKey(normalized || ''));
    }
    const nameInput = el('ccProviderCreateName');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = inferClaudeProviderLabel(normalized || '');
    }
  });
  el('opCfgProviderList')?.addEventListener('click', async (event) => {
    const actionBtn = event.target.closest('[data-op-provider-action]');
    if (actionBtn) {
      event.preventDefault();
      event.stopPropagation();
      const providerKey = actionBtn.dataset.opProviderKey || '';
      const provider = getOpenCodeEditorProviderByKey(providerKey);
      if (!providerKey || !provider) return;
      state.openCodeProviderDetailKey = providerKey;
      if (actionBtn.dataset.opProviderAction === 'check') {
        const checked = await testOpenCodeProviderConnectivity(provider, { providerKey, delayMs: 420 });
        if (!checked.ok) return flash(checked.error || '检测失败', 'error');
        flash(`Provider「${providerKey}」已连通`, 'success');
        return;
      }
      if (actionBtn.dataset.opProviderAction === 'apply') {
        applyOpenCodeProviderToMainEditor(providerKey, provider, { setDefault: false });
        renderOpenCodeProviderManager(getOpenCodeEditorCurrentProviderKey());
        flash(`已载入 Provider「${providerKey}」`, 'success');
        return;
      }
      if (actionBtn.dataset.opProviderAction === 'default') {
        applyOpenCodeProviderToMainEditor(providerKey, provider, { setDefault: true });
        renderOpenCodeProviderManager(getOpenCodeEditorCurrentProviderKey());
        flash(`已设为默认 Provider「${providerKey}」`, 'success');
      }
      return;
    }

    const row = event.target.closest('[data-op-open-provider]');
    if (!row) return;
    const providerKey = row.dataset.opOpenProvider || '';
    state.openCodeProviderDetailKey = state.openCodeProviderDetailKey === providerKey ? '' : providerKey;
    renderOpenCodeProviderManager(getOpenCodeEditorCurrentProviderKey());
  });
  el('opProviderSearchInput')?.addEventListener('input', (event) => {
    state.openCodeProviderSearch = String(event.target.value || '').trim();
    renderOpenCodeProviderManager(getOpenCodeEditorCurrentProviderKey());
  });
  el('opProviderOpenCreateBtn')?.addEventListener('click', () => {
    state.openCodeProviderDetailKey = '__new__';
    state.openCodeProviderDraftModels = [];
    renderOpenCodeProviderManager(getOpenCodeEditorCurrentProviderKey());
  });
  el('opProviderDetailCloseBtn')?.addEventListener('click', () => {
    state.openCodeProviderDetailKey = '';
    state.openCodeProviderDraftModels = [];
    renderOpenCodeProviderManager(getOpenCodeEditorCurrentProviderKey());
  });
  el('opProviderFormApplyBtn')?.addEventListener('click', () => {
    try {
      const result = saveOpenCodeProviderFormToEditor({ applyToMain: true });
      renderOpenCodeProviderManager(result.providerKey || getOpenCodeEditorCurrentProviderKey());
      if (!result.providerKey) return flash('Provider Key 无效', 'error');
      flash(`已载入 Provider「${result.providerKey}」`, 'success');
    } catch (error) {
      flash(error?.message || '载入失败', 'error');
    }
  });
  el('opProviderFormDefaultBtn')?.addEventListener('click', () => {
    try {
      const result = saveOpenCodeProviderFormToEditor({ setDefault: true, applyToMain: true });
      renderOpenCodeProviderManager(result.providerKey || getOpenCodeEditorCurrentProviderKey());
      if (!result.providerKey) return flash('Provider Key 无效', 'error');
      flash(`已设为默认 Provider「${result.providerKey}」`, 'success');
    } catch (error) {
      flash(error?.message || '设置失败', 'error');
    }
  });
  el('opProviderFormSaveBtn')?.addEventListener('click', () => {
    try {
      const result = saveOpenCodeProviderFormToEditor();
      renderOpenCodeProviderManager(result.providerKey || getOpenCodeEditorCurrentProviderKey());
      if (!result.providerKey) return flash('Provider Key 无效', 'error');
      flash(`Provider「${result.providerKey}」已保存到列表`, 'success');
    } catch (error) {
      flash(error?.message || '保存失败', 'error');
    }
  });
  el('opProviderFormDeleteBtn')?.addEventListener('click', () => {
    const result = deleteOpenCodeProviderFromEditor();
    renderOpenCodeProviderManager(getOpenCodeEditorCurrentProviderKey());
    if (!result.removed) return flash('已关闭 Provider 详情', 'success');
    flash(`Provider「${result.providerKey}」已删除`, 'success');
  });
  el('opProviderFormTestBtn')?.addEventListener('click', async () => {
    setBusy('opProviderFormTestBtn', true, '检测中...');
    try {
      const checked = await testOpenCodeProviderConnectivity(null, { delayMs: 180 });
      setBusy('opProviderFormTestBtn', false);
      if (!checked.ok) return flash(checked.error || '检测失败', 'error');
      flash('Provider 已连通', 'success');
    } catch (error) {
      setBusy('opProviderFormTestBtn', false);
      flash(error?.message || '检测失败', 'error');
    }
  });
  el('opProviderModelDetectBtn')?.addEventListener('click', async () => {
    setBusy('opProviderModelDetectBtn', true, '探测中...');
    try {
      const checked = await testOpenCodeProviderConnectivity(null, { delayMs: 180, refreshModels: true });
      setBusy('opProviderModelDetectBtn', false);
      if (!checked.ok) return flash(checked.error || '模型探测失败', 'error');
      flash(`已探测到 ${(checked.data?.models || []).length} 个模型`, 'success');
    } catch (error) {
      setBusy('opProviderModelDetectBtn', false);
      flash(error?.message || '模型探测失败', 'error');
    }
  });
  el('opProviderModelAddBtn')?.addEventListener('click', () => {
    const input = el('opProviderModelInput');
    const modelId = String(input?.value || '').trim();
    if (!modelId) return;
    setOpenCodeProviderDraftModelIds([...getOpenCodeProviderDraftModelIds(), modelId]);
    if (input) input.value = '';
  });
  el('opProviderModelInput')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    el('opProviderModelAddBtn')?.click();
  });
  el('opProviderModelsClearBtn')?.addEventListener('click', () => {
    setOpenCodeProviderDraftModelIds([]);
  });
  el('opProviderModelsChips')?.addEventListener('click', (event) => {
    const removeBtn = event.target.closest('[data-op-provider-model-remove]');
    if (!removeBtn) return;
    const modelId = removeBtn.dataset.opProviderModelRemove || '';
    setOpenCodeProviderDraftModelIds(getOpenCodeProviderDraftModelIds().filter((item) => item !== modelId));
  });
  el('opProviderFormKey')?.addEventListener('blur', (event) => {
    event.target.value = normalizeOpenCodeProviderKey(event.target.value || '');
    setOpenCodeProviderPackageField('opProviderFormPackage', {
      providerKey: event.target.value || '',
      npm: el('opProviderFormPackage')?.value || '',
    });
  });
  el('opProviderFormModelId')?.addEventListener('blur', (event) => {
    const modelId = String(event.target.value || '').trim();
    setOpenCodeProviderDraftModelIds(modelId ? [modelId, ...getOpenCodeProviderDraftModelIds({ includeInput: false })] : getOpenCodeProviderDraftModelIds({ includeInput: false }));
  });
  el('opProviderFormBaseUrl')?.addEventListener('blur', (event) => {
    const normalized = normalizeBaseUrl(event.target.value || '');
    event.target.value = normalized;
    const keyInput = el('opProviderFormKey');
    if (keyInput && !keyInput.value.trim()) {
      keyInput.value = normalizeOpenCodeProviderKey(inferProviderKey(normalized || ''));
    }
    const nameInput = el('opProviderFormName');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = inferProviderLabel(normalized || '');
    }
    setOpenCodeProviderPackageField('opProviderFormPackage', {
      providerKey: getOpenCodeProviderHintKey({
        providerKey: keyInput?.value || '',
        baseUrl: normalized || '',
      }),
      npm: el('opProviderFormPackage')?.value || '',
    });
  });
  const syncOpenCodeMainProviderPackage = () => {
    setOpenCodeProviderPackageField('opCfgProviderPackageInput', {
      providerKey: getOpenCodeProviderHintKey({
        providerKey: el('opCfgProviderKeyInput')?.value || '',
        baseUrl: el('opCfgBaseUrlInput')?.value || '',
      }),
      npm: el('opCfgProviderPackageInput')?.value || '',
    });
  };
  el('opCfgProviderKeyInput')?.addEventListener('input', syncOpenCodeMainProviderPackage);
  el('opCfgBaseUrlInput')?.addEventListener('blur', (event) => {
    event.target.value = normalizeBaseUrl(event.target.value || '');
    syncOpenCodeMainProviderPackage();
  });
  document.querySelectorAll('[data-page-target]').forEach((node) => {
    if (node.dataset.pageTarget === '__wizard__') return; // handled separately
    node.addEventListener('click', () => {
      if (node.dataset.pageTarget === 'configEditor') {
        setConfigEditorOpen(true);
        return;
      }
      setPage(node.dataset.pageTarget);
    });
  });
  el('openAdvancedBtn').addEventListener('click', () => setConfigEditorOpen(true));
  el('openAboutBtn').addEventListener('click', async () => {
    if (!state.appUpdate) await loadAppUpdateState();
    await loadAppUpdateProgressState({ silent: true });
    populateAboutPanel();
    setPage('about');
  });
  el('openSystemSettingsBtn')?.addEventListener('click', () => setPage('systemSettings'));
  document.querySelectorAll('[data-role="theme-toggle"]').forEach((node) => {
    node.addEventListener('click', toggleTheme);
  });
  el('configEditorBtn').addEventListener('click', () => setConfigEditorOpen(true));
  el('closeConfigEditorBtn').addEventListener('click', () => setConfigEditorOpen(false));
  el('resetConfigEditorBtn')?.addEventListener('click', resetConfigEditorPreservingProviders);
  el('saveConfigEditorBtn').addEventListener('click', saveConfigEditor);
  el('applyConfigEditorBtn').addEventListener('click', applyConfigEditor);

  // ── Validate button ──
  if (el('validateConfigBtn')) {
    el('validateConfigBtn').addEventListener('click', validateCurrentConfig);
  }

  // ── Config recipe search ──
  const recipeInput = el('ocRecipeSearchInput');
  const recipeResults = el('ocRecipeResults');
  if (recipeInput && recipeResults) {
    recipeInput.addEventListener('focus', () => {
      const results = searchOcRecipes(recipeInput.value);
      renderOcRecipeResults(results);
      recipeResults.classList.remove('hide');
    });
    recipeInput.addEventListener('input', () => {
      const results = searchOcRecipes(recipeInput.value);
      renderOcRecipeResults(results);
      recipeResults.classList.remove('hide');
    });
    // Click on recipe card
    recipeResults.addEventListener('click', (e) => {
      const card = e.target.closest('[data-recipe-id]');
      if (!card) return;
      const recipe = getAllConfigStoreRecipes().find(r => r.id === card.dataset.recipeId);
      if (!recipe) return;
      openConfigStoreGuide(getRecipeById(recipe.id) || recipe);
    });
    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#ocSearchWrap')) {
        recipeResults.classList.add('hide');
      }
    });
  }

  // ── Recipe form modal ──
  if (el('ocRecipeFormApplyBtn')) el('ocRecipeFormApplyBtn').addEventListener('click', submitOcRecipeForm);
  if (el('ocRecipeFormCancelBtn')) el('ocRecipeFormCancelBtn').addEventListener('click', closeOcRecipeForm);
  if (el('ocRecipeFormCloseBtn')) el('ocRecipeFormCloseBtn').addEventListener('click', closeOcRecipeForm);
  const recipeModalBackdrop = document.querySelector('.oc-recipe-modal-backdrop');
  if (recipeModalBackdrop) recipeModalBackdrop.addEventListener('click', closeOcRecipeForm);
  el('configStoreGuideCloseBtn')?.addEventListener('click', closeConfigStoreGuide);
  el('configStoreGuideCancelBtn')?.addEventListener('click', closeConfigStoreGuide);
  el('configStoreGuideApplyBtn')?.addEventListener('click', applyConfigStoreGuide);
  el('configStoreGuideModal')?.querySelector('.config-store-guide-backdrop')?.addEventListener('click', closeConfigStoreGuide);
  el('configStoreGuideFields')?.addEventListener('input', () => {
    const recipe = getRecipeById(state.configStoreGuide.recipeId);
    if (!recipe) return;
    renderConfigStoreGuide(recipe, collectConfigStoreGuideValues(recipe));
  });
  el('configStoreGuideRelated')?.addEventListener('click', (e) => {
    const suggestion = e.target.closest('[data-store-suggestion]')?.dataset.storeSuggestion;
    if (suggestion) {
      if (el('configStoreSearchInput')) el('configStoreSearchInput').value = suggestion;
      renderConfigStoreCards();
      return;
    }
  });
  if (el('ocCfgSeamColor')) {
    el('ocCfgSeamColor').addEventListener('input', () => {
      el('ocCfgSeamColorText').value = el('ocCfgSeamColor').value;
    });
  }
  if (el('ocCfgSeamColorText')) {
    el('ocCfgSeamColorText').addEventListener('change', () => {
      const v = el('ocCfgSeamColorText').value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v)) el('ocCfgSeamColor').value = v;
    });
  }

  // ── Provider Quick Import bindings ──
  if (el('ocEnvReadLocalBtn')) {
    el('ocEnvReadLocalBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleOcEnvLocalDropdown();
    });
  }
  if (el('ocEnvLocalDropdown')) {
    el('ocEnvLocalDropdown').addEventListener('click', (e) => {
      const item = e.target.closest('[data-provider-key]');
      if (!item) return;
      const providerKey = item.dataset.providerKey;
      const isClaudeCode = item.hasAttribute('data-claude-code');

      let provider;
      if (isClaudeCode) {
        // Synthetic Claude Code provider
        const ccState = state.claudeCodeState;
        const ccBaseUrl = ccState?.env?.ANTHROPIC_BASE_URL?.set ? ccState.env.ANTHROPIC_BASE_URL.value : 'https://api.anthropic.com';
        provider = {
          key: '__claude_code__',
          name: 'Claude Code (本地)',
          baseUrl: ccBaseUrl,
          hasApiKey: true,
          wireApi: '',
          _isClaudeCode: true,
        };
      } else {
        provider = (state.current?.providers || []).find(p => p.key === providerKey);
      }

      if (provider) {
        applyProviderToOcForm(provider);
        flash(`已载入 Provider「${provider.name || provider.key}」`, 'success');
      }
      toggleOcEnvLocalDropdown(false);
    });
  }
  // Close local dropdown on click outside
  document.addEventListener('click', (e) => {
    const dropdown = el('ocEnvLocalDropdown');
    if (dropdown && dropdown.classList.contains('open') && !e.target.closest('.env-import-btn-wrap')) {
      dropdown.classList.remove('open');
    }
  });
  if (el('ocEnvPasteToggleBtn')) {
    el('ocEnvPasteToggleBtn').addEventListener('click', () => toggleOcEnvPasteCollapse());
  }
  if (el('ocEnvPasteTextarea')) {
    // Auto-detect on paste
    el('ocEnvPasteTextarea').addEventListener('paste', () => {
      setTimeout(handleOcEnvPaste, 50);
    });
    // Also detect on input (for manual typing)
    el('ocEnvPasteTextarea').addEventListener('input', () => {
      // Debounce: only trigger after user stops typing for 400ms
      clearTimeout(el('ocEnvPasteTextarea')._debounce);
      el('ocEnvPasteTextarea')._debounce = setTimeout(handleOcEnvPaste, 400);
    });
  }

  if (el('ocCfgProviderApi')) {
    el('ocCfgProviderApi').addEventListener('change', () => {
      const apiMode = el('ocCfgProviderApi').value || 'openai-completions';
      const baseUrlField = el('ocCfgProviderBaseUrl');
      const envKeyField = el('ocCfgProviderEnvKey');
      const modelField = el('ocCfgModelPrimary');
      const knownBaseUrls = new Set(Object.values(OPENCLAW_PROTOCOL_META).map((item) => item.defaultBaseUrl));
      const knownEnvKeys = new Set(Object.values(OPENCLAW_PROTOCOL_META).map((item) => item.defaultEnvKey));
      const knownModels = new Set(Object.values(OPENCLAW_PROTOCOL_META).map((item) => item.defaultModel));

      if (baseUrlField) {
        const current = baseUrlField.value.trim();
        if (!current || knownBaseUrls.has(current)) {
          baseUrlField.value = getOpenClawDefaultBaseUrl(apiMode);
        }
      }
      if (envKeyField) {
        const current = envKeyField.value.trim();
        if (!current || knownEnvKeys.has(current)) {
          envKeyField.value = getOpenClawDefaultEnvKey(apiMode);
        }
      }
      if (modelField) {
        const current = modelField.value.trim();
        if (!current || knownModels.has(current)) {
          modelField.value = getOpenClawDefaultModel(apiMode);
        }
      }
    });
  }

  // Config Editor tab switcher (legacy in-page tabs + new left-rail buttons)
  async function cfgEditorSwitchTool(tool) {
    tool = normalizeConfigEditorTool(tool || 'codex');
    if (tool === getConfigEditorTool()) return;
    state.configEditorTool = tool;
    syncConfigEditorForTool();
    if (tool === 'openclaw' && !state.openclawState) await loadOpenClawQuickState();
    if (tool === 'claudecode' && !state.claudeCodeState) await loadClaudeCodeQuickState();
    populateConfigEditor();
  }

  const cfgRailList = document.getElementById('configEditorToolList');
  if (cfgRailList) {
    cfgRailList.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-cfg-rail-tool]') : null;
      if (!btn) return;
      cfgEditorSwitchTool(btn.getAttribute('data-cfg-rail-tool') || 'codex');
      // Sync rail active state
      cfgRailList.querySelectorAll('[data-cfg-rail-tool]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
    });
  }

  const cfgEditorTabs = document.getElementById('configEditorTabs');
  if (cfgEditorTabs) {
    cfgEditorTabs.addEventListener('click', async (e) => {
      const tab = e.target.closest('[data-cfg-tool]');
      if (!tab) return;
      e.preventDefault();
      const tool = normalizeConfigEditorTool(tab.dataset.cfgTool || 'codex');
      if (tool === getConfigEditorTool()) return;

      state.configEditorTool = tool;
      syncConfigEditorForTool();
      // Mirror the change to the left rail.
      document.querySelectorAll('[data-cfg-rail-tool]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-cfg-rail-tool') === tool);
      });

      if (tool === 'openclaw' && !state.openclawState) {
        await loadOpenClawQuickState();
      }
      if (tool === 'claudecode' && !state.claudeCodeState) {
        await loadClaudeCodeQuickState();
      }

      populateConfigEditor();

      if (window.refreshCustomSelects) window.refreshCustomSelects();
    });
  }

  // Drawer open/close
  document.getElementById('cfg3OpenDrawerBtn')?.addEventListener('click', () => openCfg3Drawer());
  document.getElementById('cfg3CloseDrawerBtn')?.addEventListener('click', () => closeCfg3Drawer());
  document.getElementById('cfg3DrawerScrim')?.addEventListener('click', () => closeCfg3Drawer());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const drawer = document.getElementById('cfg3Drawer');
    if (drawer && drawer.classList.contains('open')) closeCfg3Drawer();
  });

  const consoleTabs = el('toolConsoleTabs');
  if (consoleTabs) {
    consoleTabs.addEventListener('click', (e) => {
      const button = e.target.closest('[data-console-tool]');
      if (!button) return;
      state.consoleTool = button.dataset.consoleTool || 'codex';
      renderToolConsole();
    });
  }

  // Console v2 left-rail tool switcher
  const consoleRailList = document.getElementById('consoleToolList');
  if (consoleRailList) {
    consoleRailList.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-console-rail-tool]') : null;
      if (!btn) return;
      state.consoleTool = btn.getAttribute('data-console-rail-tool') || 'codex';
      renderToolConsole();
    });
  }

  // Dashboard left-rail tool switcher (mirrors console's pattern)
  const dashboardRailList = document.getElementById('dashboardToolList');
  if (dashboardRailList) {
    dashboardRailList.addEventListener('click', async (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-dashboard-rail-tool]') : null;
      if (!btn) return;
      const tool = btn.getAttribute('data-dashboard-rail-tool') || 'codex';
      state.dashboardTool = tool;
      if (tool === 'claudecode') {
        const hasCachedData = state.claudeCodeState?.usage?.daily?.length > 0;
        if (!hasCachedData) {
          state.dashboardLoading = true;
          renderDashboardPage();
          try { await ensureClaudeDashboardData(); } catch (_) {}
          state.dashboardLoading = false;
        }
      } else if (isApiDashboardTool(tool)) {
        const hasCachedData = Boolean(getDashboardMetricsForTool(tool));
        if (!hasCachedData) {
          state.dashboardLoading = true;
          renderDashboardPage();
          try { await refreshDashboardData({ tool }); } catch (_) {}
          state.dashboardLoading = false;
        }
      }
      renderDashboardPage();
    });
  }

  // Console v2 hero actions (delegated on the page root)
  const consoleV2Root = document.getElementById('toolConsolePage');
  if (consoleV2Root) {
    consoleV2Root.addEventListener('click', (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t) return;
      if (t.closest('[data-console-v2-refresh]')) {
        refreshToolConsoleData({ manual: true });
        return;
      }
      if (t.closest('[data-console-v2-goto-quick]')) {
        const tool = state.consoleTool || 'codex';
        if (state.toolLastPage) state.toolLastPage[tool] = 'quick';
        state.activeTool = tool;
        setPage?.('quick');
        return;
      }
      if (t.closest('[data-console-v2-goto-editor]')) {
        const tool = state.consoleTool || 'codex';
        state.activeTool = tool;
        setPage?.('configEditor');
        return;
      }
      // Console v3 refresh buttons
      if (t.closest('[data-console-v3-refresh-ip]')) {
        window.__consoleV3.network = null;
        renderToolConsole();
        loadConsoleNetworkStatus({ force: true });
        loadConsoleLatency();
        return;
      }
      if (t.closest('[data-console-v3-refresh-latency]')) {
        window.__consoleV3.latency = null;
        renderToolConsole();
        loadConsoleLatency();
        return;
      }
      // Inline hero gate-toggle button (tap = flip).
      const gateBtn = t.closest('[data-console-v3-toggle-gate-btn]');
      if (gateBtn) {
        const next = !isIpGateEnabled();
        setIpGateEnabled(next);
        if (typeof flash === 'function') {
          flash(next ? '✅ 已开启防火墙硬拦截' : '已关闭硬拦截（保留弹窗提醒）', 'success');
        }
        return;
      }
      if (t.closest('[data-console-v3-refresh-procs]')) {
        const tool = state.consoleTool || 'codex';
        window.__consoleV3.procsByTool[tool] = null;
        renderConsoleV3Procs(tool, tool === 'claudecode' ? 'Claude Code' : tool);
        loadConsoleProcs(tool);
        return;
      }
      if (t.closest('[data-console-v3-refresh-usage]')) {
        const tool = state.consoleTool || 'codex';
        if (tool === 'claudecode') { window.__consoleV3.claudeUsage = null; loadConsoleClaudeUsage(); }
        else if (tool === 'codex') { window.__consoleV3.codexStats = null; loadConsoleCodexStats(); }
        return;
      }
      const killBtn = t.closest('[data-cv3-proc-kill]');
      if (killBtn) {
        const pid = parseInt(killBtn.getAttribute('data-cv3-proc-kill'), 10);
        if (!pid) return;
        if (!window.confirm(`结束进程 PID ${pid}？\n会发送 SIGTERM 让它优雅退出；如果进程无响应可以再次点击以 SIGKILL 强制结束。`)) return;
        (async () => {
          const res = await api('/api/system/process-kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pid, signal: 'TERM' }),
          });
          if (res?.ok) {
            flash?.(`已发送 SIGTERM 到 PID ${pid}`, 'success');
            setTimeout(() => loadConsoleProcs(state.consoleTool || 'codex'), 600);
          } else {
            flash?.(res?.error || '结束进程失败', 'error');
          }
        })();
        return;
      }
      const revealBtn = t.closest('[data-cv3-proc-reveal]');
      if (revealBtn) {
        const path = revealBtn.getAttribute('data-cv3-proc-reveal');
        if (!path) return;
        // Reuse the existing shell "open in file manager" path.
        api('/api/open-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: `file://${path}` }),
        }).catch(() => {});
        return;
      }
    });
    // Checkbox change — can't be delegated from the click listener above
    // since `click` fires on <input type="checkbox"> after the value toggles;
    // we want the final value so `change` is the right event.
    consoleV2Root.addEventListener('change', (e) => {
      const t = e.target instanceof HTMLInputElement ? e.target : null;
      if (!t) return;
      if (t.matches('[data-console-v3-toggle-gate]')) {
        setIpGateEnabled(t.checked);
        if (typeof flash === 'function') {
          flash(t.checked ? '✅ 已开启防火墙硬拦截' : '已关闭硬拦截（仍有弹窗提醒）', 'success');
        }
      }
    });
  }

  el('toolConsoleRefreshBtn')?.addEventListener('click', () => {
    refreshToolConsoleData({ manual: true });
  });

  el('dashboardPage')?.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-dashboard-tool]');
    if (tab) {
      state.dashboardTool = tab.dataset.dashboardTool || 'codex';
      if (state.dashboardTool === 'claudecode') {
        const hasCachedData = state.claudeCodeState?.usage?.daily?.length > 0;
        if (!hasCachedData) {
          state.dashboardLoading = true;
          renderDashboardPage();
          await ensureClaudeDashboardData();
          state.dashboardLoading = false;
        }
        renderDashboardPage();
      } else if (isApiDashboardTool(state.dashboardTool)) {
        const hasCachedData = Boolean(getDashboardMetricsForTool(state.dashboardTool));
        if (!hasCachedData) {
          state.dashboardLoading = true;
          renderDashboardPage();
          await refreshDashboardData({ tool: state.dashboardTool });
          state.dashboardLoading = false;
        }
        renderDashboardPage();
      } else {
        renderDashboardPage();
      }
      return;
    }
    // Custom period dropdown trigger
    const periodTrigger = e.target.closest('[data-period-trigger]');
    if (periodTrigger) {
      const dropdown = periodTrigger.closest('[data-period-dropdown]');
      if (dropdown) dropdown.classList.toggle('open');
      return;
    }
    const daysPill = e.target.closest('[data-dashboard-days]');
    if (daysPill) {
      state.dashboardDays = Number(daysPill.dataset.dashboardDays) || 30;
      localStorage.setItem('easyaiconfig_dashboard_days', String(state.dashboardDays));
      // Close dropdown
      const dropdown = daysPill.closest('[data-period-dropdown]');
      if (dropdown) dropdown.classList.remove('open');
      renderDashboardPage();
      return;
    }
    const refreshBtn = e.target.closest('[data-dashboard-refresh]');
    if (refreshBtn) {
      e.preventDefault();
      if (state.dashboardTool === 'claudecode') {
        state.dashboardRefreshing = true;
        state.dashboardLoading = true;
        renderDashboardPage();
        await ensureClaudeDashboardData({ force: true });
        state.dashboardRefreshing = false;
        state.dashboardLoading = false;
        renderDashboardPage();
        return;
      }
      await refreshDashboardData({ force: true, tool: state.dashboardTool });
    }
  });

  el('dashboardPage')?.addEventListener('change', (e) => {
    const daysSelect = e.target.closest('[data-dashboard-days-select]');
    if (daysSelect) {
      state.dashboardDays = Number(daysSelect.value) || 30;
      localStorage.setItem('easyaiconfig_dashboard_days', String(state.dashboardDays));
      renderDashboardPage();
      return;
    }
    const select = e.target.closest('[data-dashboard-auto-refresh]');
    if (!select) return;
    state.dashboardAutoRefreshMs = Math.max(0, Number(select.value) || 0);
    localStorage.setItem(DASHBOARD_AUTO_REFRESH_STORAGE_KEY, String(state.dashboardAutoRefreshMs));
    startDashboardAutoRefresh();
    flash(state.dashboardAutoRefreshMs > 0 ? `仪表板已改为每 ${Math.round(state.dashboardAutoRefreshMs / 60000)} 分钟自动刷新` : '仪表板自动刷新已关闭', 'success');
  });

  el('toolConsolePage')?.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-console-action]');
    if (!button) return;
    e.preventDefault();
    await handleToolConsoleAction(button);
  });

  // ── Raw file tab switching (config.toml / auth.json) ──
  el('cfgRawTabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.cfg-raw-tab');
    if (!tab) return;
    const file = tab.dataset.rawFile;
    const tabs = el('cfgRawTabs');
    tabs.dataset.active = file; // drives the CSS sliding pill
    tabs.querySelectorAll('.cfg-raw-tab').forEach(t => t.classList.toggle('active', t === tab));
    const tomlWrap = el('cfgRawTomlWrap');
    const authWrap = el('cfgRawAuthWrap');
    if (tomlWrap) tomlWrap.style.display = file === 'toml' ? '' : 'none';
    if (authWrap) authWrap.style.display = file === 'auth' ? '' : 'none';
    refreshRawCodeEditors();
  });

  el('configEditorSearchToggleBtn')?.addEventListener('click', () => {
    if (state.configEditorSearchOpen) {
      closeConfigEditorSearchPopover();
      return;
    }
    openConfigEditorSearchPopover({ focus: true });
  });
  el('configEditorSearchInput')?.addEventListener('input', applyConfigEditorSearch);
  el('configEditorSearchInput')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeConfigEditorSearchPopover({ force: true });
    el('configEditorSearchToggleBtn')?.focus();
  });
  el('configEditorSearchClearBtn')?.addEventListener('click', () => {
    const input = el('configEditorSearchInput');
    if (!input) return;
    input.value = '';
    applyConfigEditorSearch();
    input.focus();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#configEditorSearchAnchor')) {
      closeConfigEditorSearchPopover();
    }
  });
  syncConfigEditorSearchPopover();
  Object.entries(CONFIG_NUMBER_FIELDS).forEach(([inputId, spec]) => {
    el(inputId).addEventListener('input', () => {
      syncConfigNumberField(inputId, 'input');
      if (inputId === 'cfgContextWindowInput') syncConfigNumberField('cfgCompactLimitInput', 'refresh');
    });
    el(spec.rangeId).addEventListener('input', () => {
      syncConfigNumberField(inputId, 'range');
      if (inputId === 'cfgContextWindowInput') syncConfigNumberField('cfgCompactLimitInput', 'refresh');
    });
    el(spec.resetId).addEventListener('click', () => {
      el(inputId).value = '';
      syncConfigNumberField(inputId, 'refresh');
      if (inputId === 'cfgContextWindowInput') syncConfigNumberField('cfgCompactLimitInput', 'refresh');
    });
  });
  const syncCodexContextLimitsFromModel = () => {
    syncConfigNumberField('cfgContextWindowInput', 'refresh');
    syncConfigNumberField('cfgCompactLimitInput', 'refresh');
  };
  el('cfgModelInput')?.addEventListener('input', syncCodexContextLimitsFromModel);
  el('cfgModelInput')?.addEventListener('change', syncCodexContextLimitsFromModel);
  el('cfgSqliteHomeBrowseBtn').addEventListener('click', () => pickDirectoryPath('cfgSqliteHomeInput', { title: '选择 SQLite 目录' }));
  el('cfgSqliteHomeUseCodexHomeBtn').addEventListener('click', () => applySqliteHomePreset('codex-home'));
  el('cfgSqliteHomeResetBtn').addEventListener('click', () => applySqliteHomePreset('default'));

  // ── Model Combobox Init ──
  const cfgModelCombobox = document.getElementById('cfgModelCombobox');
  if (cfgModelCombobox) initModelCombobox(cfgModelCombobox, CODEX_MODEL_PRESETS);
  const ocModelPrimaryCombobox = document.getElementById('ocModelPrimaryCombobox');
  if (ocModelPrimaryCombobox) initModelCombobox(ocModelPrimaryCombobox, OPENCLAW_MODEL_PRESETS);
  const ocModelFallbacksCombobox = document.getElementById('ocModelFallbacksCombobox');
  if (ocModelFallbacksCombobox) initModelCombobox(ocModelFallbacksCombobox, OPENCLAW_MODEL_PRESETS, { isFallbacks: true });
  const ocModelNameCombobox = document.getElementById('ocModelNameCombobox');
  if (ocModelNameCombobox) initModelCombobox(ocModelNameCombobox, OPENCLAW_MODEL_NAME_PRESETS);

  el('providerSwitchBtn').addEventListener('click', () => toggleProviderDropdown());
  el('providerRefreshBtn').addEventListener('click', () => {
    if (state.activeTool === 'claudecode') {
      loadClaudeCodeQuickState({ force: false, cacheOnly: false });
      return;
    }
    refreshProviderHealth(true);
  });
  el('providerDropdown').addEventListener('click', async (event) => {
    const claudeButton = event.target.closest('[data-load-claude-provider]');
    if (claudeButton) {
      const provider = getClaudeProviderByKey(claudeButton.dataset.loadClaudeProvider || '');
      if (provider) {
        const switched = await quickSwitchClaudeProvider(provider);
        if (!switched.ok) flash(switched.error || '切换失败', 'error');
        else flash(`已切换到 Provider「${provider.name || provider.key}」`, 'success');
      }
      toggleProviderDropdown(false);
      return;
    }
    const openCodeButton = event.target.closest('[data-load-opencode-provider]');
    if (openCodeButton) {
      const provider = getOpenCodeProviderByKey(openCodeButton.dataset.loadOpencodeProvider || '');
      if (provider) {
        const switched = await quickSwitchOpenCodeProvider(provider);
        if (!switched.ok) flash(switched.error || '切换失败', 'error');
        else flash(`已切换到 Provider「${provider.name || provider.key}」`, 'success');
      }
      toggleProviderDropdown(false);
      return;
    }
    const button = event.target.closest('[data-load-provider]');
    if (!button) return;
    const provider = (state.current?.providers || []).find((item) => item.key === button.dataset.loadProvider);
    if (provider) {
      const switched = await quickSwitchCodexProvider(provider);
      if (!switched.ok) flash(switched.error || '切换失败', 'error');
      else flash(`已切换到 Provider「${provider.name || provider.key}」`, 'success');
    }
    toggleProviderDropdown(false);
  });
  document.addEventListener('click', (event) => {
    const card = el('currentConfigCard');
    const dropdown = el('providerDropdown');
    if (state.providerDropdownOpen && card && !card.contains(event.target) && (!dropdown || !dropdown.contains(event.target))) {
      toggleProviderDropdown(false);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.providerDropdownOpen) toggleProviderDropdown(false);
      if (state.advancedOpen) setAdvancedOpen(false);
      if (state.configEditorOpen) setConfigEditorOpen(false);
      if (state.updateDialogOpen) closeUpdateDialog(false);
      if (state.aboutOpen) setAboutOpen(false);
    }
  });
  el('backups').addEventListener('click', (event) => {
    const button = event.target.closest('[data-restore]');
    if (button) restoreBackup(button.dataset.restore);
  });
  el('closeAboutBtn').addEventListener('click', () => setPage('quick'));
  el('aboutCheckUpdateBtn').addEventListener('click', async () => {
    const btn = el('aboutCheckUpdateBtn');
    const status = el('aboutUpdaterStatus');
    btn.classList.add('checking');
    btn.querySelector('span').textContent = '检查中...';
    status.textContent = '';
    status.className = 'about-status';

    const result = await loadAppUpdateState({ manual: true });

    btn.classList.remove('checking');
    btn.querySelector('span').textContent = '检查更新';

    if (!result) {
      status.textContent = '检测失败，请检查网络连接';
      status.className = 'about-status about-status-error';
    } else if (result.networkBlocked) {
      status.textContent = result.statusMessage || '你的网络可能无法访问 GitHub 更新源，暂时无法检查更新。';
      status.className = 'about-status about-status-error';
    } else if (result.available) {
      status.textContent = `发现新版本 v${result.version}`;
      status.className = 'about-status about-status-update';
    } else {
      status.textContent = '已是最新版本';
      status.className = 'about-status about-status-ok';
    }
    populateAboutPanel();
  });
  el('aboutInstallUpdateBtn')?.addEventListener('click', () => handleAppUpdate('aboutInstallUpdateBtn'));
  el('aboutFeedbackBtn')?.addEventListener('click', () => {
    void openExternalUrl('https://github.com/lmk1010/EasyAIConfig/issues/new/choose');
  });
  el('aboutOpenSystemSettingsBtn')?.addEventListener('click', () => setPage('systemSettings'));

  el('sysThemeModes')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-sys-theme]');
    if (!button) return;
    const next = String(button.dataset.sysTheme || '');
    if (!['auto', 'light', 'dark'].includes(next)) return;
    state.themePreference = next;
    state.theme = resolveTheme(next);
    localStorage.setItem('easyaiconfig_theme', next);
    applyTheme(state.theme);
    const labels = { auto: '已切换：自动模式', light: '已切换：浅色模式', dark: '已切换：深色模式' };
    flash(labels[next] || '已更新主题', 'success');
  });

  el('sysRefreshStorageBtn')?.addEventListener('click', async () => {
    setBusy('sysRefreshStorageBtn', true, '刷新中...');
    await loadSystemStorageState();
    setBusy('sysRefreshStorageBtn', false);
  });
  el('sysClearCacheBtn')?.addEventListener('click', async () => {
    const confirmed = window.confirm('确认清理应用缓存吗？');
    if (!confirmed) return;
    setBusy('sysClearCacheBtn', true, '清理中...');
    const result = await cleanupSystemStorage({ clearCache: true, clearBackups: false });
    setBusy('sysClearCacheBtn', false);
    if (!result.ok) return flash(result.error || '清理缓存失败', 'error');
    flash('缓存已清理', 'success');
  });
  el('sysClearBackupsBtn')?.addEventListener('click', async () => {
    const confirmed = window.confirm('确认清理所有配置备份吗？该操作不可恢复。');
    if (!confirmed) return;
    setBusy('sysClearBackupsBtn', true, '清理中...');
    const result = await cleanupSystemStorage({ clearCache: false, clearBackups: true });
    setBusy('sysClearBackupsBtn', false);
    if (!result.ok) return flash(result.error || '清理备份失败', 'error');
    flash('备份已清理', 'success');
  });
  el('sysClearUiCacheBtn')?.addEventListener('click', () => {
    const confirmed = window.confirm('确认清理界面缓存吗？');
    if (!confirmed) return;
    clearUiStorageCache();
  });

  async function runSystemToolUninstall(buttonId, toolId) {
    const label = { codex: 'Codex', claudecode: 'Claude Code', openclaw: 'OpenClaw' }[toolId] || toolId;
    const confirmed = window.confirm(`确认卸载 ${label} 吗？`);
    if (!confirmed) return false;
    setBusy(buttonId, true, '卸载中...');
    const result = await uninstallToolForSystemSettings(toolId);
    setBusy(buttonId, false);
    if (!result.ok) {
      flash(result.error || `${label} 卸载失败`, 'error');
      return false;
    }
    flash(`${label} 已卸载`, 'success');
    await refreshToolRuntimeAfterMutation(toolId);
    await loadSystemStorageState({ silent: true });
    return true;
  }

  el('sysUninstallCodexBtn')?.addEventListener('click', () => {
    void runSystemToolUninstall('sysUninstallCodexBtn', 'codex');
  });
  el('sysUninstallClaudeBtn')?.addEventListener('click', () => {
    void runSystemToolUninstall('sysUninstallClaudeBtn', 'claudecode');
  });
  el('sysUninstallOpenClawBtn')?.addEventListener('click', () => {
    void runSystemToolUninstall('sysUninstallOpenClawBtn', 'openclaw');
  });
  el('sysUninstallAllToolsBtn')?.addEventListener('click', async () => {
    const confirmed = window.confirm('确认卸载全部工具（Codex / Claude Code / OpenCode / OpenClaw）吗？');
    if (!confirmed) return;
    setBusy('sysUninstallAllToolsBtn', true, '卸载中...');
    await uninstallToolForSystemSettings('codex');
    await uninstallToolForSystemSettings('claudecode');
    await uninstallToolForSystemSettings('opencode');
    await uninstallToolForSystemSettings('openclaw');
    setBusy('sysUninstallAllToolsBtn', false);
    await refreshToolRuntimeAfterMutation();
    await loadSystemStorageState({ silent: true });
    flash('全部卸载流程已完成，请检查工具状态', 'success');
  });

  el('sysOpenUninstallEntryBtn')?.addEventListener('click', async () => {
    await openSystemUninstallEntry();
    flash('已打开系统卸载入口', 'success');
  });
  el('sysOpenIssueBtn')?.addEventListener('click', () => {
    void openExternalUrl('https://github.com/lmk1010/EasyAIConfig/issues/new/choose');
  });
  el('closeUpdateDialogBtn').addEventListener('click', () => closeUpdateDialog(false));
  el('updateDialogCancelBtn').addEventListener('click', () => {
    if (typeof state.updateDialogCancelHandler === 'function') {
      state.updateDialogCancelHandler();
      return;
    }
    closeUpdateDialog(false);
  });
  el('updateDialogConfirmBtn').addEventListener('click', () => closeUpdateDialog(true));
  document.querySelectorAll('[data-close-update-dialog]').forEach((node) => node.addEventListener('click', () => closeUpdateDialog(false)));
  el('updateDialogBody')?.addEventListener('click', async (event) => {
    const copyCmdBtn = event.target.closest('[data-codex-detail-copy-command]');
    if (copyCmdBtn) {
      try {
        await copyText(copyCmdBtn.dataset.codexDetailCopyCommand || '');
        flash('恢复命令已复制', 'success');
      } catch {
        flash('复制失败', 'error');
      }
      return;
    }
    const exportBtn = event.target.closest('[data-codex-detail-export-format]');
    if (exportBtn) {
      await exportCodexSessionByPath(
        exportBtn.dataset.codexDetailFilePath || '',
        exportBtn.dataset.codexDetailExportFormat || 'jsonl',
      );
    }
  });

  // ── Setup Wizard bindings ──
  el('setupWizardNavBtn').addEventListener('click', (e) => {
    e.preventDefault();
    openSetupWizard();
  });
  el('wizardCloseBtn').addEventListener('click', closeSetupWizard);
  el('wizardEnvRetryBtn').addEventListener('click', runWizardEnvCheck);
  el('wizardEnvNextBtn').addEventListener('click', wizardGoToInstall);
  el('wizardInstallBackBtn').addEventListener('click', () => setWizardStep(0));
  el('wizardInstallBtn').addEventListener('click', wizardRunInstall);
  el('wizardInstallSkipBtn').addEventListener('click', wizardGoToConfig);
  el('wizardInstallNextBtn').addEventListener('click', wizardGoToConfig);

  // Tool picker in wizard
  el('wizardToolPicker').addEventListener('click', (e) => {
    const card = e.target.closest('[data-wizard-tool]');
    if (!card) return;
    selectWizardTool(card.dataset.wizardTool);
  });
  // Install method pills in wizard
  el('wizardInstallMethods').addEventListener('click', (e) => {
    const pill = e.target.closest('[data-wizard-method]');
    if (!pill) return;
    state.wizardSelectedMethod = pill.dataset.wizardMethod;
    document.querySelectorAll('.wizard-method-pill').forEach(p => p.classList.toggle('active', p.dataset.wizardMethod === state.wizardSelectedMethod));
    const meta = WIZARD_TOOL_META[state.wizardSelectedTool];
    const selected = meta?.methods.find(m => m.id === state.wizardSelectedMethod);
    if (selected) {
      const cmdEl = el('wizardInstallCommand');
      if (cmdEl) cmdEl.textContent = selected.cmd;
    }
  });

  el('wizardConfigBackBtn').addEventListener('click', () => setWizardStep(1));
  el('wizardDetectBtn').addEventListener('click', wizardDetectModels);
  el('wizardBaseUrl').addEventListener('input', wizardUpdateConfigBtn);
  el('wizardApiKey').addEventListener('input', wizardUpdateConfigBtn);
  el('wizardApiKeyToggleBtn').addEventListener('click', () => toggleSimpleSecretInput('wizardApiKey', 'wizardApiKeyToggleBtn'));
  el('wizardConfigNextBtn').addEventListener('click', wizardSaveAndComplete);
  el('wizardFinishBtn').addEventListener('click', () => {
    closeSetupWizard();
    // Switch to the selected tool
    if (state.wizardSelectedTool && state.wizardSelectedTool !== state.activeTool) {
      setActiveTool(state.wizardSelectedTool);
    }
    setPage('quick');
  });
  el('wizardLaunchBtn').addEventListener('click', async () => {
    closeSetupWizard();
    // Switch to the selected tool and launch
    if (state.wizardSelectedTool && state.wizardSelectedTool !== state.activeTool) {
      setActiveTool(state.wizardSelectedTool);
    }
    await launchCodexOnly();
  });
  el('setupWizard').querySelector('.wizard-backdrop').addEventListener('click', closeSetupWizard);

  // ── Welcome / Onboarding bindings ──
  el('welcomeExpertBtn').addEventListener('click', handleExpertPath);
  el('welcomeBeginnerBtn').addEventListener('click', handleBeginnerPath);
}

bindEvents();
window.addEventListener('click', (e) => {
  if (!e.target.closest('[data-period-dropdown]')) {
    document.querySelectorAll('[data-period-dropdown].open').forEach(el => el.classList.remove('open'));
  }
  if (state.codexTerminalMenuOpen && !e.target.closest('#launchBtn') && !e.target.closest('#codexTerminalMenu')) {
    closeCodexTerminalMenu();
  }
});
window.addEventListener('resize', () => {
  refreshRawCodeEditors();
  renderQuickRailSupportPanel();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (state.activePage === 'dashboard') {
    if (state.dashboardTool === 'claudecode') {
      void ensureClaudeDashboardData();
    } else if (isApiDashboardTool(state.dashboardTool)) {
      void refreshDashboardData({ silent: true, tool: state.dashboardTool });
    }
    return;
  }
  void resyncToolRuntimeState();
});
window.addEventListener('focus', () => {
  void resyncToolRuntimeState();
});
setPage('quick');
applyDerivedMeta(true);
renderModelOptions();
renderCurrentConfig();
loadState({ preserveForm: false }).then(() => {
  if (isFirstVisit()) {
    // First time opening the app — show welcome chooser
    showWelcome();
  } else {
    // Returning user — only auto-trigger wizard if never dismissed before
    const wizardDismissed = localStorage.getItem('easyaiconfig_wizard_dismissed');
    if (!wizardDismissed && state.current && (!state.current.codexBinary?.installed || !state.current.configExists || !(state.current.providers?.length > 0))) {
      openSetupWizard();
    }
  }
});
loadBackups();
loadAppUpdateState();
loadAppUpdateProgressState({ silent: true });
loadTools();

/* ── Window drag support ── */
(function initWindowDrag() {
  // Try multiple API access paths for Tauri v2
  const appWindow =
    window.__TAURI__?.window?.getCurrentWindow?.() ||
    window.__TAURI__?.window?.Window?.getCurrent?.() ||
    null;

  if (!appWindow || typeof appWindow.startDragging !== 'function') {
    console.log('[drag] Tauri window API not available, skip drag init');
    return;
  }

  console.log('[drag] Tauri window API found, initializing drag regions');

  const INTERACTIVE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A', 'LABEL']);
  const INTERACTIVE_CLASSES = ['nav-item', 'badge', 'ghost-btn', 'subtle-btn', 'tiny-btn', 'tiny-icon-btn', 'chip', 'provider-option'];

  function isInteractive(target) {
    let node = target;
    while (node && node !== document.body) {
      if (INTERACTIVE_TAGS.has(node.tagName)) return true;
      if (node.classList) {
        for (const cls of INTERACTIVE_CLASSES) {
          if (node.classList.contains(cls)) return true;
        }
      }
      if (node.getAttribute('role') === 'button') return true;
      if (node.hasAttribute('data-load-provider')) return true;
      if (node.hasAttribute('data-load-claude-provider')) return true;
      node = node.parentElement;
    }
    return false;
  }

  function handleDrag(e) {
    if (e.button !== 0) return;
    if (isInteractive(e.target)) return;
    e.preventDefault();
    appWindow.startDragging();
  }

  // Attach to all explicit drag regions
  document.querySelectorAll('[data-tauri-drag-region]').forEach((region) => {
    region.addEventListener('mousedown', handleDrag);
  });

  // Also listen on the entire document for top-area drags (top 48px)
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.clientY > 48) return;
    if (isInteractive(e.target)) return;
    e.preventDefault();
    appWindow.startDragging();
  });
})();

/* ── Custom Select Dropdown ── */
(function initCustomSelects() {
  function buildCustomSelect(selectEl) {
    const wrap = selectEl.closest('.select-wrap');
    if (!wrap) return;
    // Skip if already enhanced
    if (wrap.querySelector('.custom-select-trigger')) return;

    const container = document.createElement('div');
    container.className = 'custom-select';

    // Move select inside container
    wrap.parentNode.insertBefore(container, wrap);
    container.appendChild(wrap);
    // Hide the .select-wrap (we keep it for the hidden select)
    wrap.style.position = 'absolute';
    wrap.style.opacity = '0';
    wrap.style.width = '0';
    wrap.style.height = '0';
    wrap.style.overflow = 'hidden';
    wrap.style.pointerEvents = 'none';

    // Trigger button
    const trigger = document.createElement('div');
    trigger.className = 'custom-select-trigger';
    trigger.innerHTML = `<span class="cs-value"></span><span class="cs-arrow">▾</span>`;
    container.insertBefore(trigger, wrap);

    // Dropdown panel
    const dropdown = document.createElement('div');
    dropdown.className = 'custom-select-dropdown';
    container.appendChild(dropdown);

    function renderOptions() {
      const opts = Array.from(selectEl.options);
      dropdown.innerHTML = opts.map((opt, i) => {
        const sel = selectEl.selectedIndex === i ? ' selected' : '';
        return `<div class="custom-select-option${sel}" data-value="${opt.value}" data-index="${i}">${opt.textContent}</div>`;
      }).join('');

      // Update trigger text
      const selectedOpt = opts[selectEl.selectedIndex];
      const valSpan = trigger.querySelector('.cs-value');
      if (selectedOpt) {
        valSpan.textContent = selectedOpt.textContent;
        valSpan.classList.toggle('placeholder', selectEl.dataset.emptyPlaceholder === 'true' && !selectedOpt.value);
      }
    }

    renderOptions();

    // Toggle open
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = container.classList.contains('open');
      closeAllCustomSelects();
      if (!wasOpen) {
        container.classList.add('open');
        renderOptions(); // refresh options
      }
    });

    // Option click
    dropdown.addEventListener('click', (e) => {
      const opt = e.target.closest('.custom-select-option');
      if (!opt) return;
      selectEl.value = opt.dataset.value;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      container.classList.remove('open');
      renderOptions();
    });

    // Watch for programmatic changes to the select
    const observer = new MutationObserver(() => renderOptions());
    observer.observe(selectEl, { childList: true, subtree: true, attributes: true });

    // Store ref for later re-render
    selectEl._customSelect = { renderOptions, container };
  }

  function closeAllCustomSelects() {
    document.querySelectorAll('.custom-select.open').forEach(cs => cs.classList.remove('open'));
  }

  // Close on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-select')) {
      closeAllCustomSelects();
    }
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllCustomSelects();
  });

  // Initialize all existing selects inside .select-wrap
  document.querySelectorAll('.select-wrap > select').forEach(buildCustomSelect);

  // Expose for dynamic selects
  window.initCustomSelect = buildCustomSelect;
  window.refreshCustomSelects = function () {
    document.querySelectorAll('.select-wrap > select').forEach(sel => {
      if (sel._customSelect) {
        sel._customSelect.renderOptions();
      } else {
        buildCustomSelect(sel);
      }
    });
  };
})();

/* ══════════════════════════════════════════════════════════════════════════
   CONNECTION HUB — render + wiring.
   Reuses existing state + quickSwitchXxxProvider() functions.
   ══════════════════════════════════════════════════════════════════════════ */
(function connectionHub() {
  'use strict';

  const TOOL_LABELS = {
    codex: 'Codex',
    claudecode: 'Claude Code',
    opencode: 'OpenCode',
    openclaw: 'OpenClaw',
  };
  const LAUNCH_LABELS = {
    codex: '启动 Codex',
    claudecode: '启动 Claude Code',
    opencode: '启动 OpenCode',
    openclaw: '启动 OpenClaw',
  };

  function safeEscape(v) {
    if (typeof escapeHtml === 'function') return escapeHtml(v);
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function hubState() {
    // `state` is the module-level object declared at the top of app.js; accessible via closure.
    if (typeof state === 'undefined' || !state) return null;
    if (typeof state.chSearch !== 'string') state.chSearch = '';
    if (typeof state.chFilter !== 'string') state.chFilter = 'all';
    return state;
  }

  // ── Provider row model (tool-agnostic) ──────────────────────────────
  function buildProviderRows(tool) {
    const s = hubState();
    if (!s) return [];

    if (tool === 'codex') {
      if (typeof isCodexInstalled === 'function' && !isCodexInstalled()) return [];
      const providers = Array.isArray(s.current?.providers) ? s.current.providers : [];
      const login = s.current?.login || {};
      const health = s.providerHealth || {};
      // Hide template / placeholder providers that don't have a real key set
      // — they clutter the list as "缺 KEY" ghost rows. Keep if active, keep
      // if marked history (old key got deleted, still useful to see).
      const rows = providers
        .filter((p) => p.isActive || p.hasApiKey || p.historyOnly)
        .map((p) => {
          const h = health[p.key];
          return {
            key: p.key,
            name: p.name || p.key,
            baseUrl: p.baseUrl || '',
            model: p.isActive ? (s.current?.summary?.model || '') : '',
            mode: 'apikey',
            kind: 'codex-apikey',
            isActive: Boolean(p.isActive),
            hasCredential: Boolean(p.hasApiKey),
            historyOnly: Boolean(p.historyOnly),
            health: h || null,
            ref: p,
            tool,
          };
        });

      const oauthCache = window.__chOauthProfiles || { loaded: false, data: null };
      const oauthData = oauthCache.data || { profiles: [], active: '', live: {}, liveHasUnsavedTokens: false };
      const savedProfiles = Array.isArray(oauthData.profiles) ? oauthData.profiles : [];
      const oauthIsChosen = login.loggedIn && !providers.some((p) => p.isActive);

      for (const prof of savedProfiles) {
        const id = prof.id || '';
        const isActiveProfile = Boolean(oauthData.active && oauthData.active === id);
        const isChosen = isActiveProfile && oauthIsChosen;
        rows.push({
          key: `__codex_oauth_profile:${id}`,
          name: prof.name || prof.email || 'OAuth 账号',
          baseUrl: 'ChatGPT 官方登录',
          model: isChosen ? (login.plan || prof.plan || '') : '',
          mode: 'oauth',
          kind: 'codex-oauth-profile',
          isActive: isChosen,
          hasCredential: true,
          health: isActiveProfile ? { ok: true, checked: true } : null,
          ref: prof,
          plan: prof.plan || '',
          email: prof.email || '',
          profileId: id,
          tool,
        });
      }

      // Live tokens exist but don't map to any saved profile → offer "save as profile".
      if (oauthCache.loaded && oauthData.liveHasUnsavedTokens) {
        rows.push({
          key: '__codex_oauth_unsaved__',
          name: '未保存的官方登录',
          baseUrl: 'ChatGPT 官方登录 · 尚未存入 profile',
          model: (oauthData.live && oauthData.live.plan) || login.plan || '',
          mode: 'oauth',
          kind: 'codex-oauth-unsaved',
          isActive: oauthIsChosen,
          hasCredential: true,
          health: { ok: true, checked: true },
          ref: null,
          plan: (oauthData.live && oauthData.live.plan) || '',
          email: (oauthData.live && oauthData.live.email) || '',
          tool,
        });
      }

      // Fallback synthetic row: no cache yet, but login exists — show legacy pill
      // so the hub never blinks empty on the very first render.
      if (!oauthCache.loaded && login.loggedIn && savedProfiles.length === 0) {
        rows.push({
          key: '__codex_oauth_unsaved__',
          name: login.orgName || login.email || '官方登录',
          baseUrl: 'ChatGPT 官方登录',
          model: login.plan || '',
          mode: 'oauth',
          kind: 'codex-oauth-unsaved',
          isActive: oauthIsChosen,
          hasCredential: true,
          health: { ok: true, checked: true },
          ref: null,
          plan: login.plan || '',
          email: login.email || '',
          tool,
        });
      }

      return rows;
    }

    if (tool === 'claudecode') {
      const cc = s.claudeCodeState || {};
      if (typeof isClaudeCodeInstalled === 'function' && !isClaudeCodeInstalled(cc)) return [];
      const profiles = typeof getClaudeProviderProfiles === 'function' ? (getClaudeProviderProfiles(cc) || []) : [];
      const selectedKey = s.claudeSelectedProviderKey;
      const oauthAuthInUse = typeof isClaudeOauthLoggedIn === 'function' && isClaudeOauthLoggedIn(cc);
      // Render Claude providers as API-KEY rows. Two filters:
      //   1. When the user's official-Anthropic auth is OAuth, hide the
      //      official API-KEY row (OAuth profile rows represent it).
      //   2. Hide template / placeholder providers with no API key set
      //      (they appear as "缺 KEY" ghosts otherwise).
      const rows = profiles
        .filter((p) => {
          const isOfficial = typeof isClaudeOfficialProvider === 'function' ? isClaudeOfficialProvider(p) : false;
          if (isOfficial && oauthAuthInUse) return false;
          if (p.key === selectedKey) return true; // always keep whatever's active
          if (!p.hasApiKey) return false;
          return true;
        })
        .map((p) => {
          const hasCredential = Boolean(p.hasApiKey);
          return {
            key: p.key,
            name: p.name || p.key,
            baseUrl: p.baseUrl || 'https://api.anthropic.com',
            model: (p.key === selectedKey) ? (cc.model || '') : '',
            mode: 'apikey',
            kind: 'claudecode-apikey',
            isActive: p.key === selectedKey,
            hasCredential,
            health: hasCredential ? { ok: true, checked: true } : null,
            ref: p,
            tool,
          };
        });

      // Our OAuth profile store → one row per saved profile + one "default"
      // row representing the un-managed ~/.claude/ login.
      const ccCache = window.__chClaudeOauthProfiles || { loaded: false, data: null };
      const ccData = ccCache.data || { active: '', profiles: [], lastSwitchAt: 0 };
      const savedProfiles = Array.isArray(ccData.profiles) ? ccData.profiles : [];
      const activeId = ccData.active || '';
      const ccLogin = cc.login || {};
      const cliLoggedIn = typeof isClaudeOauthLoggedIn === 'function' && isClaudeOauthLoggedIn(cc);

      // "默认" row — represents ~/.claude/ (Claude Code's default CONFIG_DIR).
      // We render it whenever we have *any* signal of a default login. To
      // avoid the first-paint flicker (cc.login often races the profile list
      // fetch), we combine three independent signals:
      //   1. isClaudeOauthLoggedIn(cc)        — from load_claudecode_state
      //   2. ccData.defaultPlan.subscriptionType  — from our profiles list
      //                                              (reads Keychain)
      //   3. ccData.defaultPlan.hasDefault    — future flag for "file exists"
      // As long as any one is set, the row is stable across renders.
      const defaultPlanObj = ccData.defaultPlan || {};
      const defaultPlan = defaultPlanObj.plan || '';
      const defaultHasTokens = Boolean(defaultPlanObj.subscriptionType) || cliLoggedIn;

      if (defaultHasTokens) {
        // Name prefers our own backend's defaultPlan.email (read directly from
        // ~/.claude.json by /api/claudecode/oauth/profiles) over cc.login.email
        // (populated by the slower load_claudecode_state path). This way the
        // hero shows the right identity on the very first paint instead of
        // flashing "默认账号" until cc.login arrives.
        const defaultEmail = defaultPlanObj.email || ccLogin.email || '';
        const defaultOrg = defaultPlanObj.organizationName || ccLogin.orgName || '';
        rows.push({
          key: '__claudecode_oauth_default__',
          name: defaultEmail || defaultOrg || '默认账号',
          baseUrl: '~/.claude/ · Claude Code 默认',
          model: activeId === '' ? defaultPlan : '',
          mode: 'oauth',
          kind: 'claudecode-oauth-default',
          isActive: activeId === '',
          hasCredential: true,
          health: { ok: true, checked: true },
          ref: null,
          plan: defaultPlan,
          email: defaultEmail,
          tool,
        });
      }

      // One row per saved profile.
      for (const prof of savedProfiles) {
        const id = prof.id || '';
        const profHasTokens = Boolean(prof.hasTokens);
        const isActiveProfile = activeId === id;
        rows.push({
          key: `__claudecode_oauth_profile:${id}`,
          name: prof.name || prof.email || 'Claude 账号',
          baseUrl: profHasTokens
            ? `${prof.organizationName || 'Claude 官方'}${prof.email ? ' · ' + prof.email : ''}`
            : '未完成登录 · 点击重新登录',
          model: isActiveProfile ? (prof.plan || '') : '',
          mode: 'oauth',
          kind: 'claudecode-oauth-profile',
          isActive: isActiveProfile,
          hasCredential: profHasTokens,
          health: profHasTokens ? { ok: true, checked: true } : null,
          ref: prof,
          plan: prof.plan || '',
          email: prof.email || '',
          profileId: id,
          profileConfigDir: prof.configDir || '',
          tool,
        });
      }

      return rows;
    }

    if (tool === 'opencode') {
      const data = s.opencodeState || {};
      if (typeof isOpenCodeInstalled === 'function' && !isOpenCodeInstalled(data)) return [];
      const providers = Array.isArray(data.providers) ? data.providers : [];
      return providers.map((p) => {
        const authType = String(p.authType || '').toLowerCase();
        const isOauth = Boolean(p.hasAuth) && authType.includes('oauth');
        return {
          key: p.key,
          name: p.name || p.key,
          baseUrl: p.baseUrl || '',
          model: (p.key === data.activeProviderKey) ? (data.model || '') : '',
          mode: isOauth ? 'oauth' : 'apikey',
          isActive: p.key === data.activeProviderKey,
          hasCredential: Boolean(p.hasCredential),
          health: p.hasCredential ? { ok: true, checked: true } : null,
          ref: p,
          tool,
        };
      });
    }

    // openclaw: no provider concept
    return [];
  }

  // ── Hero HTML ─────────────────────────────────────────────────────
  function renderHeroHTML(active, tool) {
    if (!active) {
      return `
        <div class="ch-hero-info">
          <div class="ch-hero-eyebrow">CURRENT SESSION</div>
          <div class="ch-hero-empty-title">还没有激活的 Provider</div>
          <div class="ch-hero-empty-sub">点击下方任意一项切换，或 <strong>新增 Provider</strong> 开始配置。</div>
        </div>
        <div class="ch-hero-actions">
          <button type="button" class="ch-hero-ghost" data-ch-add>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
            新增
          </button>
        </div>`;
    }
    const h = active.health || {};
    const isOauth = active.mode === 'oauth';
    // Official OAuth sessions: no connectivity probing — status is always
    // "当前 (OAUTH)". Only API-key sessions show the actual probe result.
    const statusCls = isOauth
      ? 'ok'
      : (active.isActive && h.ok ? 'ok' : h.loading ? 'warn loading' : h.ok ? 'ok' : h.checked ? 'bad' : 'muted');
    const statusTxt = isOauth
      ? '当前'
      : (h.loading ? '检测中' : h.ok ? '已通' : h.checked ? '失败' : '未检测');
    const launchLabel = LAUNCH_LABELS[tool] || '启动';
    const modeTxt = isOauth ? 'OAUTH' : 'API KEY';

    return `
      <div class="ch-hero-info">
        <div class="ch-hero-eyebrow">
          <span>CURRENT SESSION</span>
          <span class="ch-status ${statusCls}">${safeEscape(statusTxt)}</span>
        </div>
        <h2 class="ch-hero-name">${safeEscape(active.name)}</h2>
        <div class="ch-hero-badges">
          <span class="ch-mode ${active.mode}">${modeTxt}</span>
          ${active.model ? `<span class="ch-hero-model">${safeEscape(active.model)}</span>` : ''}
        </div>
        ${active.baseUrl ? `<div class="ch-hero-url">${safeEscape(active.baseUrl)}</div>` : ''}
      </div>
      <div class="ch-hero-actions">
        ${isOauth ? '' : `<button type="button" class="ch-hero-ghost" data-ch-detect title="重新检测连接">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.36 6.36L3 21M3 12a9 9 0 0 1 15.36-6.36L21 3"/></svg>
          重检
        </button>`}
        ${isOauth ? '' : `<button type="button" class="ch-hero-ghost" data-ch-edit title="编辑当前 provider">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3.5l6 6-11 11H3.5v-6l11-11z"/></svg>
          编辑
        </button>`}
        <button type="button" class="ch-hero-launch" data-ch-launch>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>
          ${safeEscape(launchLabel)}
        </button>
      </div>`;
  }

  // ── List HTML ─────────────────────────────────────────────────────
  function rowHTML(r) {
    const h = r.health || {};
    const isOauth = r.mode === 'oauth';
    let dotCls, statusCls, statusTxt;
    if (r.isActive) {
      dotCls = 'current';
      statusCls = 'active';
      statusTxt = '当前';
    } else if (isOauth) {
      // Official OAuth identities don't get probed — row is pure metadata.
      dotCls = 'ok'; statusCls = ''; statusTxt = '';
    } else if (h.loading) {
      dotCls = 'warn'; statusCls = 'warn loading'; statusTxt = '检测中';
    } else if (h.ok) {
      dotCls = 'ok'; statusCls = 'ok'; statusTxt = '已通';
    } else if (h.checked) {
      dotCls = 'bad'; statusCls = 'bad'; statusTxt = '失败';
    } else if (r.historyOnly) {
      dotCls = 'muted'; statusCls = 'muted'; statusTxt = '历史';
    } else if (!r.hasCredential) {
      dotCls = 'muted'; statusCls = 'warn'; statusTxt = '缺 Key';
    } else {
      dotCls = 'muted'; statusCls = 'muted'; statusTxt = '未检测';
    }

    let actions = '';
    if (r.kind === 'codex-oauth-profile') {
      actions = `
          <button type="button" class="ch-row-icon-btn" data-ch-oauth-rename="${safeEscape(r.profileId || '')}" title="重命名" aria-label="重命名 ${safeEscape(r.name)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3.5l6 6-11 11H3.5v-6l11-11z"/></svg>
          </button>
          <button type="button" class="ch-row-icon-btn" data-ch-oauth-delete="${safeEscape(r.profileId || '')}" title="删除" aria-label="删除 ${safeEscape(r.name)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
          </button>`;
    } else if (r.kind === 'codex-oauth-unsaved') {
      actions = `
          <button type="button" class="ch-row-icon-btn primary" data-ch-oauth-save-current="1" title="保存为 OAuth profile" aria-label="保存为 OAuth profile">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          </button>`;
    } else if (r.kind === 'claudecode-oauth-profile') {
      actions = `
          <button type="button" class="ch-row-icon-btn" data-ch-cc-oauth-rename="${safeEscape(r.profileId || '')}" title="重命名" aria-label="重命名 ${safeEscape(r.name)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3.5l6 6-11 11H3.5v-6l11-11z"/></svg>
          </button>
          <button type="button" class="ch-row-icon-btn" data-ch-cc-oauth-relogin="${safeEscape(r.profileId || '')}" title="重新登录 (替换 token)" aria-label="重新登录">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.36 6.36L3 21M3 12a9 9 0 0 1 15.36-6.36L21 3"/></svg>
          </button>
          <button type="button" class="ch-row-icon-btn" data-ch-cc-oauth-delete="${safeEscape(r.profileId || '')}" title="删除" aria-label="删除 ${safeEscape(r.name)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
          </button>`;
    } else if (r.kind === 'claudecode-oauth-default') {
      actions = '';
    } else {
      // API-key provider rows — edit / detect / delete. Delete for Codex
      // and Claude Code only (OpenCode uses a different flow).
      const canDelete = r.kind === 'codex-apikey' || r.kind === 'claudecode-apikey';
      actions = `
          <button type="button" class="ch-row-icon-btn" data-ch-row-edit="${safeEscape(r.key)}" title="编辑" aria-label="编辑 ${safeEscape(r.name)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3.5l6 6-11 11H3.5v-6l11-11z"/></svg>
          </button>
          <button type="button" class="ch-row-icon-btn" data-ch-row-detect="${safeEscape(r.key)}" title="重检" aria-label="重检 ${safeEscape(r.name)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.36 6.36L3 21M3 12a9 9 0 0 1 15.36-6.36L21 3"/></svg>
          </button>
          ${canDelete ? `<button type="button" class="ch-row-icon-btn danger" data-ch-row-delete="${safeEscape(r.key)}" data-ch-row-delete-kind="${safeEscape(r.kind)}" title="删除" aria-label="删除 ${safeEscape(r.name)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
          </button>` : ''}`;
    }

    const planPill = r.plan ? `<span class="ch-row-plan" data-plan="${safeEscape(String(r.plan).toLowerCase())}">${safeEscape(String(r.plan).toUpperCase())}</span>` : '';

    return `
      <div class="ch-row ${r.isActive ? 'current' : ''}" role="listitem" data-ch-key="${safeEscape(r.key)}" tabindex="0">
        <span class="ch-row-dot ${dotCls}"></span>
        <span class="ch-row-body">
          <span class="ch-row-title">
            <span class="ch-row-name">${safeEscape(r.name)}</span>
            ${planPill}
            ${r.isActive ? '<span class="ch-row-current-tag">当前</span>' : ''}
          </span>
          <span class="ch-row-meta">
            ${r.model ? `<span class="ch-row-model">${safeEscape(r.model)}</span>` : ''}
            ${r.baseUrl ? `<span class="ch-row-url">${safeEscape(r.baseUrl)}</span>` : ''}
          </span>
        </span>
        <span class="ch-row-status">${statusTxt ? `<span class="ch-status ${statusCls}">${safeEscape(statusTxt)}</span>` : ''}</span>
        <span class="ch-row-actions">${actions}
        </span>
      </div>`;
  }

  function renderListHTML(rows) {
    const s = hubState();
    const tool = s?.activeTool || 'codex';
    const oauth = rows.filter((r) => r.mode === 'oauth');
    const apikey = rows.filter((r) => r.mode === 'apikey');
    const pieces = [];

    // For Codex / ClaudeCode we always render the OAuth group header (even
    // when empty) so the "+ 新增 OAuth 账号" button is discoverable.
    const showOauthGroup = oauth.length || tool === 'codex' || tool === 'claudecode';
    if (showOauthGroup) {
      let addBtn = '';
      if (tool === 'codex') {
        addBtn = `<button type="button" class="ch-group-head-add" data-ch-oauth-add title="新增 OAuth 账号 (codex login)" aria-label="新增 OAuth 账号">
             <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
             <span class="ch-group-head-add-label">新增</span>
           </button>`;
      } else if (tool === 'claudecode') {
        addBtn = `<button type="button" class="ch-group-head-add" data-ch-cc-oauth-add title="新增 Claude 账号 (claude auth login)" aria-label="新增 Claude 账号">
             <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
             <span class="ch-group-head-add-label">新增</span>
           </button>`;
      }
      pieces.push(`<div class="ch-group-head"><span class="ch-group-head-text">OAUTH<span class="count">· ${oauth.length}</span></span>${addBtn}</div>`);
      if (oauth.length) pieces.push(oauth.map(rowHTML).join(''));
    }

    if (apikey.length) {
      pieces.push(`<div class="ch-group-head">API KEY<span class="count">· ${apikey.length}</span></div>`);
      pieces.push(apikey.map(rowHTML).join(''));
    }
    if (!rows.length && tool !== 'codex') {
      return '<div class="ch-list-empty">没有匹配的 provider</div>';
    }
    return pieces.join('');
  }

  function updateRibbonCounts(allRows) {
    const all = allRows.length;
    const oauth = allRows.filter((r) => r.mode === 'oauth').length;
    const apikey = allRows.filter((r) => r.mode === 'apikey').length;
    document.querySelectorAll('#chRibbon [data-count]').forEach((el) => {
      const k = el.dataset.count;
      const n = k === 'all' ? all : k === 'oauth' ? oauth : apikey;
      el.textContent = String(n);
    });
  }

  // ── Public render entry ────────────────────────────────────────
  function renderConnectionHub() {
    const hub = document.getElementById('connectionHub');
    if (!hub) return;
    const heroEl = document.getElementById('chHero');
    const listEl = document.getElementById('chList');
    const emptyEl = document.getElementById('chEmpty');
    const toolTitleEl = document.getElementById('chTitleTool');
    const s = hubState();
    if (!s || !heroEl || !listEl) return;

    const tool = s.activeTool || 'codex';
    if (toolTitleEl) toolTitleEl.textContent = TOOL_LABELS[tool] || tool;

    // Loading sentinel: if the OAuth profile fetch for this tool hasn't
    // resolved yet, render an explicit loading state instead of either (a)
    // guessing with stale cached data or (b) showing a misleading empty
    // "还没有激活的 Provider" hero. Honest over snappy.
    const codexLoaded = Boolean(window.__chOauthProfiles && window.__chOauthProfiles.loaded);
    const claudeLoaded = Boolean(window.__chClaudeOauthProfiles && window.__chClaudeOauthProfiles.loaded);
    const isLoading = (tool === 'codex' && !codexLoaded) || (tool === 'claudecode' && !claudeLoaded);
    if (isLoading) {
      heroEl.classList.add('empty');
      heroEl.innerHTML = `
        <div class="ch-hero-info">
          <div class="ch-hero-eyebrow"><span>CURRENT SESSION</span></div>
          <div class="ch-hero-empty-title">加载中…</div>
          <div class="ch-hero-empty-sub">从本地配置读取 OAuth 状态…</div>
        </div>`;
      listEl.innerHTML = '<div class="ch-list-empty">加载中…</div>';
      updateRibbonCounts([]);
      if (emptyEl) emptyEl.classList.add('hide');
      return;
    }

    const allRows = buildProviderRows(tool);
    updateRibbonCounts(allRows);

    // Apply search + filter
    const search = (s.chSearch || '').trim().toLowerCase();
    const filter = s.chFilter || 'all';
    const filtered = allRows.filter((r) => {
      if (filter === 'oauth' && r.mode !== 'oauth') return false;
      if (filter === 'apikey' && r.mode !== 'apikey') return false;
      if (!search) return true;
      const hay = [r.name, r.baseUrl, r.model, r.key].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(search);
    });

    const active = allRows.find((r) => r.isActive) || null;
    heroEl.innerHTML = renderHeroHTML(active, tool);
    heroEl.classList.toggle('empty', !active);
    listEl.innerHTML = renderListHTML(filtered);

    if (emptyEl) emptyEl.classList.toggle('hide', allRows.length > 0);
  }

  // ── Interactions ────────────────────────────────────────────────
  // Populate the underlying form with a provider's current values WITHOUT saving.
  // The user can then edit and hit 保存配置 to apply; a save also re-activates
  // that provider, so "click row → edit → save" is the one-click switch path.
  function loadProviderIntoForm(key) {
    if (!key) return null;
    const s = hubState();
    if (!s) return null;
    const tool = s.activeTool || 'codex';
    if (tool === 'codex') {
      if (key === '__codex_official_oauth__') return null;
      if (key === '__codex_oauth_unsaved__' || key.startsWith('__codex_oauth_profile:')) return null;
      const p = (s.current?.providers || []).find((x) => x.key === key);
      if (p && typeof fillFromProvider === 'function') {
        try { fillFromProvider(p); } catch (err) { console.warn('[ch] fillFromProvider failed', err); }
      }
      return p || null;
    }
    if (tool === 'claudecode') {
      if (key === '__claudecode_oauth_default__' || key.startsWith('__claudecode_oauth_profile:')) return null;
      const profiles = typeof getClaudeProviderProfiles === 'function' ? getClaudeProviderProfiles(s.claudeCodeState) : [];
      return (profiles || []).find((x) => x.key === key) || null;
    }
    if (tool === 'opencode') {
      return ((s.opencodeState?.providers) || []).find((x) => x.key === key) || null;
    }
    return null;
  }

  function openSlideover(mode, providerKey) {
    const so = document.getElementById('chSlideover');
    if (!so) return;

    // OAuth mode is chosen at the outer-list level; inside the drawer we only
    // ever show the API-Key form. Pin the state + rerun the form visibility
    // sync (hides the now-invisible auth block but unhides URL / Key fields).
    const s = hubState();
    if (s && (s.activeTool || 'codex') === 'codex') {
      s.codexAuthView = 'api_key';
      if (typeof syncCodexAuthView === 'function') {
        try { syncCodexAuthView(); } catch (_) {}
      }
    }

    so.classList.remove('hide');
    // Two rAFs so the initial display:block commits before .open animates in
    requestAnimationFrame(() => requestAnimationFrame(() => so.classList.add('open')));
    so.setAttribute('aria-hidden', 'false');
    document.body.classList.add('ch-so-active');
    const title = document.getElementById('chSlideoverTitle');

    if (mode === 'edit' && providerKey) {
      const provider = loadProviderIntoForm(providerKey);
      if (title) title.textContent = provider ? `编辑 · ${provider.name || provider.key}` : '编辑 Provider';
    } else if (mode === 'add') {
      if (title) title.textContent = '新增 Provider';
      const urlEl = document.getElementById('baseUrlInput');
      const keyEl = document.getElementById('apiKeyInput');
      if (urlEl) urlEl.value = '';
      if (keyEl) keyEl.value = '';
      setTimeout(() => urlEl && urlEl.focus(), 260);
    } else if (title) {
      title.textContent = '编辑 Provider';
    }
  }

  function closeSlideover() {
    const so = document.getElementById('chSlideover');
    if (!so) return;
    so.classList.remove('open');
    so.setAttribute('aria-hidden', 'true');
    setTimeout(() => so.classList.add('hide'), 220);
    document.body.classList.remove('ch-so-active');
  }

  // ── Codex OAuth profile store (remote) ─────────────────────────
  // Cache layout: { loaded: bool, data: {active, profiles, live, liveHasUnsavedTokens} }
  window.__chOauthProfiles = window.__chOauthProfiles || { loaded: false, data: null };

  async function loadCodexOauthProfiles(opts) {
    const allowAutoSave = !(opts && opts.skipAutoSave);
    try {
      const res = await api('/api/codex/oauth/profiles', { method: 'GET' });
      if (!res || !res.ok) {
        window.__chOauthProfiles = { loaded: true, data: { active: '', profiles: [], live: {}, liveHasUnsavedTokens: false } };
        renderConnectionHub();
        return;
      }
      window.__chOauthProfiles = { loaded: true, data: res.data || {} };
    } catch (err) {
      console.warn('[ch] load oauth profiles failed', err);
      window.__chOauthProfiles = { loaded: true, data: { active: '', profiles: [], live: {}, liveHasUnsavedTokens: false } };
      renderConnectionHub();
      return;
    }

    // Auto-save: if the live auth.json has OAuth tokens that aren't mapped to
    // any saved profile yet, snapshot it silently. The backend picks a sensible
    // default name (email / "OAuth (PLAN)"); user can rename via ✏ later.
    // Re-entrancy guarded by opts.skipAutoSave so the post-save reload doesn't
    // loop.
    if (allowAutoSave && window.__chOauthProfiles.data?.liveHasUnsavedTokens) {
      try {
        const saveRes = await api('/api/codex/oauth/profiles/save-current', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '' }),
        });
        if (saveRes?.ok) {
          if (typeof flash === 'function') flash('已自动保存官方登录为 OAuth profile', 'success');
          await loadCodexOauthProfiles({ skipAutoSave: true });
          return;
        }
      } catch (err) {
        console.warn('[ch] auto-save oauth profile failed', err);
      }
    }

    renderConnectionHub();
  }

  async function deleteApiKeyProvider(key, kind) {
    if (!key) return;
    const s = hubState();
    const rows = buildProviderRows(s?.activeTool || 'codex');
    const row = rows.find((r) => r.key === key);
    const nameForPrompt = row?.name || key;
    const confirmed = window.confirm(`删除 provider「${nameForPrompt}」？\n会同时清掉配置里的 baseUrl / API Key，不可恢复。`);
    if (!confirmed) return;

    try {
      if (kind === 'codex-apikey') {
        const res = await api('/api/config/delete-provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerKey: key,
            codexHome: s?.current?.codexHome || '',
            scope: document.getElementById('scopeSelect')?.value || 'global',
          }),
        });
        if (!res || !res.ok) {
          flash?.(res?.error || '删除失败', 'error');
          return;
        }
        flash?.('已删除 provider', 'success');
        if (typeof loadState === 'function') await loadState();
      } else if (kind === 'claudecode-apikey') {
        const res = await api('/api/claudecode/provider-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerKey: key }),
        });
        if (!res || !res.ok) {
          flash?.(res?.error || '删除失败', 'error');
          return;
        }
        flash?.('已删除 provider', 'success');
        if (typeof loadClaudeCodeState === 'function') await loadClaudeCodeState();
      }
    } catch (err) {
      console.warn('[ch] delete provider failed', err);
      flash?.('删除失败', 'error');
    }
  }

  async function reloadCodexStateThenHub() {
    try {
      if (typeof loadState === 'function') await loadState();
    } catch (err) {
      console.warn('[ch] loadState failed', err);
    }
    await loadCodexOauthProfiles();
  }

  async function saveCurrentOauthAsProfile() {
    const defaultName = (() => {
      const d = window.__chOauthProfiles?.data;
      const live = d?.live || {};
      if (live.email) return live.email;
      if (live.plan) return `OAuth (${String(live.plan).toUpperCase()})`;
      return '';
    })();
    const name = window.prompt('给这个 OAuth 账号起个名字（可留空自动命名）', defaultName || '') ;
    if (name === null) return; // cancelled
    const res = await api('/api/codex/oauth/profiles/save-current', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!res || !res.ok) {
      if (typeof flash === 'function') flash(res?.error || '保存 OAuth profile 失败', 'error');
      return;
    }
    if (typeof flash === 'function') flash('已保存为 OAuth profile', 'success');
    await loadCodexOauthProfiles();
  }

  async function switchOauthProfile(id) {
    if (!id) return;
    const res = await api('/api/codex/oauth/profiles/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res || !res.ok) {
      if (typeof flash === 'function') flash(res?.error || '切换 OAuth 账号失败', 'error');
      return;
    }
    if (typeof flash === 'function') flash('已切换 OAuth 账号', 'success');
    await reloadCodexStateThenHub();
  }

  async function renameOauthProfile(id) {
    if (!id) return;
    const current = (window.__chOauthProfiles?.data?.profiles || []).find((p) => p.id === id);
    const name = window.prompt('新的名字', current?.name || '');
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await api('/api/codex/oauth/profiles/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: trimmed }),
    });
    if (!res || !res.ok) {
      if (typeof flash === 'function') flash(res?.error || '重命名失败', 'error');
      return;
    }
    await loadCodexOauthProfiles();
  }

  async function deleteOauthProfile(id) {
    if (!id) return;
    const confirmed = window.confirm('删除该 OAuth profile（只删除我们存储的副本，不会登出 ChatGPT）？');
    if (!confirmed) return;
    const res = await api('/api/codex/oauth/profiles/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res || !res.ok) {
      if (typeof flash === 'function') flash(res?.error || '删除失败', 'error');
      return;
    }
    if (typeof flash === 'function') flash('已删除该 profile', 'success');
    await loadCodexOauthProfiles();
  }

  async function addNewOauthAccount() {
    const data = window.__chOauthProfiles?.data || {};
    if (data.liveHasUnsavedTokens) {
      const saveFirst = window.confirm('检测到当前 ~/.codex/auth.json 里有一个还没保存成 profile 的官方登录。\n新登录会覆盖它 —— 要不要先把当前的存成 profile？\n\n确定 = 先保存；取消 = 直接继续新登录（当前登录会被覆盖）。');
      if (saveFirst) {
        await saveCurrentOauthAsProfile();
      }
    }
    const go = window.confirm('接下来会在终端里打开 codex login 进行浏览器授权。\n完成授权后回到这里，再次点击“新增 OAuth 账号”就会自动保存为 profile。');
    if (!go) return;
    try {
      if (typeof launchCodexLogin === 'function') {
        await launchCodexLogin();
      } else {
        if (typeof flash === 'function') flash('未找到 codex login 启动器', 'error');
        return;
      }
    } catch (err) {
      console.warn('[ch] launchCodexLogin failed', err);
    }

    // Poll a few times so the "未保存登录" row shows up once the CLI finishes writing auth.json.
    let tries = 0;
    const pollId = setInterval(async () => {
      tries += 1;
      await reloadCodexStateThenHub();
      const d = window.__chOauthProfiles?.data;
      if ((d && d.liveHasUnsavedTokens) || tries >= 60) clearInterval(pollId);
    }, 2500);
  }

  // ── Claude Code OAuth profile store ─────────────────────────────
  // Single source of truth: the backend reads
  //   ~/.codex-config-ui/claudecode-oauth-profiles/profiles.json
  //   + ~/.claude/.claude.json + macOS Keychain entry for the default dir.
  // We hold the last-good response in a module-scoped cache so repeat
  // renders during the same session don't re-fetch. When the cache is
  // `loaded: false` the hub renders a "loading" state instead of guessing
  // — no localStorage, no optimistic rendering.
  window.__chClaudeOauthProfiles = window.__chClaudeOauthProfiles || { loaded: false, data: null };

  async function loadClaudeCodeOauthProfiles() {
    try {
      const res = await api('/api/claudecode/oauth/profiles', { method: 'GET' });
      if (!res || !res.ok) {
        window.__chClaudeOauthProfiles = { loaded: true, data: { active: '', profiles: [], lastSwitchAt: 0 } };
      } else {
        window.__chClaudeOauthProfiles = { loaded: true, data: res.data || {} };
      }
    } catch (err) {
      console.warn('[ch] load claudecode oauth profiles failed', err);
      window.__chClaudeOauthProfiles = { loaded: true, data: { active: '', profiles: [], lastSwitchAt: 0 } };
    }
    renderConnectionHub();
  }

  // Switch active Claude Code OAuth identity. Empty id = back to default
  // (~/.claude/). Backend enforces a 60s throttle.
  async function switchClaudeCodeOauthProfile(id) {
    const res = await api('/api/claudecode/oauth/profiles/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id || '' }),
    });
    if (!res || !res.ok) {
      if (typeof flash === 'function') flash(res?.error || '切换 Claude 账号失败', 'error');
      return;
    }
    if (typeof flash === 'function') {
      flash(id ? '已切换 Claude 账号（下次启动 Claude Code 会使用该账号）' : '已切回默认 Claude 账号 (~/.claude/)', 'success');
    }
    await loadClaudeCodeOauthProfiles();
  }

  async function renameClaudeCodeOauthProfile(id) {
    if (!id) return;
    const current = (window.__chClaudeOauthProfiles?.data?.profiles || []).find((p) => p.id === id);
    const name = window.prompt('新的名字', current?.name || '');
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await api('/api/claudecode/oauth/profiles/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: trimmed }),
    });
    if (!res || !res.ok) {
      if (typeof flash === 'function') flash(res?.error || '重命名失败', 'error');
      return;
    }
    await loadClaudeCodeOauthProfiles();
  }

  async function deleteClaudeCodeOauthProfile(id) {
    if (!id) return;
    const confirmed = window.confirm('删除这个 Claude 账号 profile？\n只会删除我们保存的副本（目录 + Keychain 会留作残留，手动用 Keychain Access 清理）。\n你在 anthropic 的账号本身不受影响。');
    if (!confirmed) return;
    const res = await api('/api/claudecode/oauth/profiles/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res || !res.ok) {
      if (typeof flash === 'function') flash(res?.error || '删除失败', 'error');
      return;
    }
    if (typeof flash === 'function') flash('已删除该 profile', 'success');
    await loadClaudeCodeOauthProfiles();
  }

  async function addNewClaudeCodeOauthProfile() {
    const ok = window.confirm('接下来会：\n1) 创建一个独立的 Claude 配置目录（profile）\n2) 在终端里用该目录跑 claude auth login\n3) 你在浏览器完成授权后，token 会存到该 profile 独立的 Keychain 条目里\n\n整个过程不影响你现有的 ~/.claude/ 登录。继续？');
    if (!ok) return;

    const createRes = await api('/api/claudecode/oauth/profiles/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    if (!createRes || !createRes.ok) {
      if (typeof flash === 'function') flash(createRes?.error || '创建 profile 失败', 'error');
      return;
    }
    const newId = createRes.data?.id;
    if (!newId) return;

    // Launch `CLAUDE_CONFIG_DIR=<dir> claude auth login` in a terminal.
    const loginRes = await api('/api/claudecode/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: newId }),
    });
    if (!loginRes || !loginRes.ok) {
      if (typeof flash === 'function') flash(loginRes?.error || '启动 claude login 失败', 'error');
      return;
    }
    if (typeof flash === 'function') flash('已在终端打开登录窗口。完成浏览器授权后回到这里。', 'info');

    // Poll the profiles list — once the target profile picks up an accountUuid
    // from its .claude.json, auto-activate it.
    let tries = 0;
    const pollId = setInterval(async () => {
      tries += 1;
      await loadClaudeCodeOauthProfiles();
      const prof = (window.__chClaudeOauthProfiles?.data?.profiles || []).find((p) => p.id === newId);
      if (prof && prof.hasTokens) {
        clearInterval(pollId);
        await switchClaudeCodeOauthProfile(newId);
      } else if (tries >= 72) {
        clearInterval(pollId);
      }
    }, 2500);
  }

  async function reloginClaudeCodeOauthProfile(id) {
    if (!id) return;
    const ok = window.confirm('重新登录会覆盖这个 profile 的 token。原账号状态保留在服务端，只是本机这份凭证换成新的。继续？');
    if (!ok) return;
    const res = await api('/api/claudecode/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: id }),
    });
    if (!res || !res.ok) {
      if (typeof flash === 'function') flash(res?.error || '启动 claude login 失败', 'error');
      return;
    }
    if (typeof flash === 'function') flash('已打开登录窗口。完成授权后账号元数据会自动刷新。', 'info');
    let tries = 0;
    const pollId = setInterval(async () => {
      tries += 1;
      await loadClaudeCodeOauthProfiles();
      if (tries >= 48) clearInterval(pollId);
    }, 2500);
  }

  // Row-body click: activate this provider (modifies Codex's model_provider
  // pointer). Editing that same provider's URL / Key / model is done via the
  // ✏ icon which opens the drawer.
  async function switchRow(key) {
    if (!key) return;
    const s = hubState();
    if (!s) return;
    const tool = s.activeTool || 'codex';
    try {
      if (tool === 'codex') {
        if (key === '__codex_official_oauth__') return;
        if (key === '__codex_oauth_unsaved__') {
          // Body click on the unsaved OAuth row = save it as a profile.
          await saveCurrentOauthAsProfile();
          return;
        }
        if (key.startsWith('__codex_oauth_profile:')) {
          const id = key.slice('__codex_oauth_profile:'.length);
          await switchOauthProfile(id);
          return;
        }
        const p = (s.current?.providers || []).find((x) => x.key === key);
        if (p && typeof quickSwitchCodexProvider === 'function') await quickSwitchCodexProvider(p);
      } else if (tool === 'claudecode') {
        if (key === '__claudecode_oauth_default__') {
          await switchClaudeCodeOauthProfile('');
          return;
        }
        if (key.startsWith('__claudecode_oauth_profile:')) {
          const id = key.slice('__claudecode_oauth_profile:'.length);
          await switchClaudeCodeOauthProfile(id);
          return;
        }
        const profiles = typeof getClaudeProviderProfiles === 'function' ? getClaudeProviderProfiles(s.claudeCodeState) : [];
        const p = (profiles || []).find((x) => x.key === key);
        if (p && typeof quickSwitchClaudeProvider === 'function') await quickSwitchClaudeProvider(p);
      } else if (tool === 'opencode') {
        const p = ((s.opencodeState?.providers) || []).find((x) => x.key === key);
        if (p && typeof quickSwitchOpenCodeProvider === 'function') await quickSwitchOpenCodeProvider(p);
      }
    } catch (err) {
      console.warn('[ch] switch failed', err);
    }
  }

  async function detectRow(key) {
    const s = hubState();
    if (!s) return;
    const tool = s.activeTool || 'codex';
    if (tool === 'codex') {
      const p = (s.current?.providers || []).find((x) => x.key === key);
      if (p && typeof testCodexProviderConnectivity === 'function') {
        try {
          const result = await testCodexProviderConnectivity(p);
          if (result && result.ok === false && result.error && typeof flash === 'function') {
            flash(result.error, 'warning');
          }
        } catch (err) {
          console.warn('[ch] detect failed', err);
        }
        return;
      }
    }
    document.getElementById('detectBtn')?.click();
  }

  // ── Auto-detect frequency ────────────────────────────────────────
  // Persist user's preferred cadence in localStorage. When > 0, schedules a
  // refreshProviderHealth(true) tick so every saved provider gets re-tested.
  const AUTODETECT_LS_KEY = 'easyaiconfig_ch_autodetect_interval_sec';
  const AUTODETECT_MIN_SEC = 30; // guard against <30s cadence (server-side pressure)
  let autodetectTimerId = 0;

  function clearAutodetectTimer() {
    if (autodetectTimerId) {
      clearInterval(autodetectTimerId);
      autodetectTimerId = 0;
    }
  }

  function scheduleAutodetect(sec) {
    clearAutodetectTimer();
    if (!sec || sec < AUTODETECT_MIN_SEC) return;
    autodetectTimerId = setInterval(() => {
      // Only run for tools that have a health-check function wired
      const s = hubState();
      if (!s) return;
      if (document.hidden) return; // skip when window backgrounded
      if (typeof refreshProviderHealth === 'function' && (s.activeTool || 'codex') === 'codex') {
        try { refreshProviderHealth(true); } catch (_) {}
      }
    }, sec * 1000);
  }

  const AUTODETECT_OPTIONS = [
    { value: 0,    label: '关闭' },
    { value: 60,   label: '60 秒' },
    { value: 300,  label: '5 分钟' },
    { value: 1800, label: '30 分钟' },
    { value: 3600, label: '1 小时' },
  ];

  function labelForInterval(sec) {
    const opt = AUTODETECT_OPTIONS.find((o) => o.value === sec);
    return opt ? opt.label : '关闭';
  }

  function applyAutodetectUi(sec) {
    const container = document.getElementById('chAutodetect');
    if (container) container.classList.toggle('is-on', sec > 0);
    const valueEl = document.getElementById('chAutodetectValue');
    if (valueEl) valueEl.textContent = labelForInterval(sec);
    document.querySelectorAll('#chAutodetectMenu [data-ad-value]').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.getAttribute('data-ad-value')) === sec);
    });
  }

  function closeAutodetectMenu() {
    const menu = document.getElementById('chAutodetectMenu');
    const trigger = document.getElementById('chAutodetectTrigger');
    const container = document.getElementById('chAutodetect');
    if (menu) menu.classList.add('hide');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (container) container.dataset.open = 'false';
  }

  function openAutodetectMenu() {
    const menu = document.getElementById('chAutodetectMenu');
    const trigger = document.getElementById('chAutodetectTrigger');
    const container = document.getElementById('chAutodetect');
    if (menu) menu.classList.remove('hide');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    if (container) container.dataset.open = 'true';
  }

  function initAutodetect() {
    const trigger = document.getElementById('chAutodetectTrigger');
    const menu = document.getElementById('chAutodetectMenu');
    if (!trigger || !menu) return;

    let saved = 0;
    try {
      const raw = localStorage.getItem(AUTODETECT_LS_KEY);
      if (raw != null) saved = Math.max(0, parseInt(raw, 10) || 0);
    } catch (_) { /* localStorage may be denied; fall back to off */ }
    const allowed = AUTODETECT_OPTIONS.map((o) => o.value);
    if (!allowed.includes(saved)) saved = 0;
    applyAutodetectUi(saved);
    scheduleAutodetect(saved);

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !menu.classList.contains('hide');
      if (isOpen) closeAutodetectMenu();
      else openAutodetectMenu();
    });

    menu.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-ad-value]') : null;
      if (!btn) return;
      const sec = Math.max(0, parseInt(btn.getAttribute('data-ad-value'), 10) || 0);
      try { localStorage.setItem(AUTODETECT_LS_KEY, String(sec)); } catch (_) {}
      applyAutodetectUi(sec);
      scheduleAutodetect(sec);
      closeAutodetectMenu();
      if (sec > 0 && typeof refreshProviderHealth === 'function') {
        try { refreshProviderHealth(true); } catch (_) {}
      }
    });

    // Dismiss on outside click / Escape
    document.addEventListener('click', (e) => {
      const container = document.getElementById('chAutodetect');
      if (!container || menu.classList.contains('hide')) return;
      if (!container.contains(e.target)) closeAutodetectMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.classList.contains('hide')) closeAutodetectMenu();
    });

    window.addEventListener('beforeunload', clearAutodetectTimer);
  }

  // ── Delegated event wiring (runs once on DOMContentLoaded) ─────
  function wire() {
    const hub = document.getElementById('connectionHub');
    if (!hub || hub.dataset.chWired === '1') return;
    hub.dataset.chWired = '1';

    // Add button
    document.getElementById('chAddBtn')?.addEventListener('click', () => openSlideover('add'));

    // Hero actions
    const hero = document.getElementById('chHero');
    hero?.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const launch = target.closest('[data-ch-launch]');
      if (launch) {
        const s = hubState();
        const tool = s?.activeTool || 'codex';
        // Call the underlying launch function directly — the real #launchBtn lives
        // inside the slide-over (display:none) so simulating its click would make
        // the terminal picker menu position at (0,0).
        if (tool === 'codex' && typeof launchCodex === 'function') {
          launchCodex('launchBtn', 'Codex 已启动', 'auto').catch(console.warn);
        } else {
          document.getElementById('launchBtn')?.click();
        }
        return;
      }
      const edit = target.closest('[data-ch-edit]');
      if (edit) { openSlideover('edit'); return; }
      const detect = target.closest('[data-ch-detect]');
      if (detect) {
        const s = hubState();
        const rows = buildProviderRows(s?.activeTool || 'codex');
        const active = rows.find((r) => r.isActive);
        if (active && !active.readOnly) detectRow(active.key);
        else document.getElementById('detectBtn')?.click();
        return;
      }
      const add = target.closest('[data-ch-add]');
      if (add) { openSlideover('add'); return; }
    });

    // Row clicks
    const list = document.getElementById('chList');
    list?.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      // OAuth profile actions (rename / delete / save-current / add-new)
      const addOauth = target.closest('[data-ch-oauth-add]');
      if (addOauth) { e.stopPropagation(); addNewOauthAccount(); return; }
      const saveOauth = target.closest('[data-ch-oauth-save-current]');
      if (saveOauth) { e.stopPropagation(); saveCurrentOauthAsProfile(); return; }
      const renameOauth = target.closest('[data-ch-oauth-rename]');
      if (renameOauth) { e.stopPropagation(); renameOauthProfile(renameOauth.getAttribute('data-ch-oauth-rename')); return; }
      const deleteOauth = target.closest('[data-ch-oauth-delete]');
      if (deleteOauth) { e.stopPropagation(); deleteOauthProfile(deleteOauth.getAttribute('data-ch-oauth-delete')); return; }

      // Claude Code OAuth profile actions
      const ccAddOauth = target.closest('[data-ch-cc-oauth-add]');
      if (ccAddOauth) { e.stopPropagation(); addNewClaudeCodeOauthProfile(); return; }
      const ccRename = target.closest('[data-ch-cc-oauth-rename]');
      if (ccRename) { e.stopPropagation(); renameClaudeCodeOauthProfile(ccRename.getAttribute('data-ch-cc-oauth-rename')); return; }
      const ccRelogin = target.closest('[data-ch-cc-oauth-relogin]');
      if (ccRelogin) { e.stopPropagation(); reloginClaudeCodeOauthProfile(ccRelogin.getAttribute('data-ch-cc-oauth-relogin')); return; }
      const ccDelete = target.closest('[data-ch-cc-oauth-delete]');
      if (ccDelete) { e.stopPropagation(); deleteClaudeCodeOauthProfile(ccDelete.getAttribute('data-ch-cc-oauth-delete')); return; }

      const editBtn = target.closest('[data-ch-row-edit]');
      if (editBtn) { e.stopPropagation(); openSlideover('edit', editBtn.getAttribute('data-ch-row-edit')); return; }
      const detectBtn = target.closest('[data-ch-row-detect]');
      if (detectBtn) { e.stopPropagation(); detectRow(detectBtn.getAttribute('data-ch-row-detect')); return; }
      const delBtn = target.closest('[data-ch-row-delete]');
      if (delBtn) {
        e.stopPropagation();
        const key = delBtn.getAttribute('data-ch-row-delete');
        const kind = delBtn.getAttribute('data-ch-row-delete-kind') || '';
        deleteApiKeyProvider(key, kind);
        return;
      }
      const row = target.closest('[data-ch-key]');
      if (row) {
        const key = row.getAttribute('data-ch-key');
        // OAuth is managed by `codex login`; can't switch / edit in-app.
        if (key === '__codex_official_oauth__') {
          if (typeof flash === 'function') {
            flash('官方登录由 Codex CLI 管理，请在终端运行 codex login', 'info');
          }
          return;
        }
        // Body click = switch to / activate this provider.
        // Editing its contents is the ✏ icon (opens the drawer).
        switchRow(key);
      }
    });
    list?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = e.target instanceof Element ? e.target : null;
      const row = target && target.closest('[data-ch-key]');
      if (row) {
        const key = row.getAttribute('data-ch-key');
        if (key === '__codex_official_oauth__') return;
        e.preventDefault();
        switchRow(key);
      }
    });

    // Ribbon filter
    const ribbon = document.getElementById('chRibbon');
    ribbon?.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const btn = target && target.closest('[data-ch-filter]');
      if (!btn) return;
      const s = hubState();
      if (!s) return;
      s.chFilter = btn.getAttribute('data-ch-filter');
      ribbon.querySelectorAll('.ch-ribbon-item').forEach((b) => b.classList.toggle('active', b === btn));
      renderConnectionHub();
    });

    // Search
    const search = document.getElementById('chSearchInput');
    const clear = document.getElementById('chSearchClear');
    if (search) {
      search.addEventListener('input', () => {
        const s = hubState();
        if (!s) return;
        s.chSearch = search.value;
        if (clear) clear.classList.toggle('hide', !search.value);
        renderConnectionHub();
      });
    }
    if (clear) {
      clear.addEventListener('click', () => {
        if (search) { search.value = ''; search.focus(); }
        const s = hubState();
        if (s) s.chSearch = '';
        clear.classList.add('hide');
        renderConnectionHub();
      });
    }

    // Close slide-over (scrim, X button, Escape)
    document.querySelectorAll('[data-ch-close]').forEach((el) => el.addEventListener('click', closeSlideover));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const so = document.getElementById('chSlideover');
        if (so && so.classList.contains('open')) closeSlideover();
      }
    });

    // Save button: when the drawer is open we want edit-in-place semantics —
    // the save should update this provider's URL / Key / model, but NOT change
    // Codex's active pointer (switching is a separate, outer action). The
    // legacy save call always re-activates whatever the form points at, so we
    // intercept in the capture phase, perform the save ourselves, and then
    // restore the previous active provider if it was different from the edit
    // target. When the drawer is closed the default save handler takes over.
    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async (e) => {
        const so = document.getElementById('chSlideover');
        if (!so || !so.classList.contains('open')) return; // let default handler run
        // Only Codex supports the restore-active flow; other tools keep their
        // normal save semantics.
        const s = hubState();
        if (!s || (s.activeTool || 'codex') !== 'codex') return;
        e.stopImmediatePropagation();
        e.preventDefault();

        const prevActive = s.current?.activeProvider || null;
        const prevActiveKey = prevActive?.key || null;

        try {
          if (typeof saveConfigOnly === 'function') {
            await saveConfigOnly();
          }
        } catch (err) {
          console.warn('[ch] drawer save failed', err);
        }

        // After save, if active got switched to the edit target (which the
        // save API always does), restore the previous active provider.
        const s2 = hubState();
        const newActiveKey = s2?.current?.activeProvider?.key || null;
        if (prevActiveKey && newActiveKey && prevActiveKey !== newActiveKey) {
          const prev = (s2.current.providers || []).find((p) => p.key === prevActiveKey);
          if (prev && typeof quickSwitchCodexProvider === 'function') {
            try { await quickSwitchCodexProvider(prev); } catch (_) {}
          }
        }

        if (so.classList.contains('open')) closeSlideover();
      }, true); // capture phase — runs before the bubble-phase saveConfigOnly listener
    }

    // Launch button: close drawer after launch (same as before, no save-restore needed)
    const launchBtn = document.getElementById('launchBtn');
    if (launchBtn) {
      launchBtn.addEventListener('click', () => {
        setTimeout(() => {
          const so = document.getElementById('chSlideover');
          if (so && so.classList.contains('open')) closeSlideover();
        }, 120);
      });
    }

    // Auto-detect frequency
    initAutodetect();
  }

  // Expose hub render so renderCurrentConfig() can call it
  window.renderConnectionHub = renderConnectionHub;
  window.__chLoadOauthProfiles = loadCodexOauthProfiles;
  window.__chLoadClaudeCodeOauthProfiles = loadClaudeCodeOauthProfiles;

  async function initialLoad() {
    wire();
    // Prime persistent app settings (ipGateBlock etc.) so launches have the
    // right policy even if the user never opens the console page.
    if (typeof loadAppSettings === 'function') loadAppSettings();
    // Kick off both OAuth profile fetches in parallel. Each loader calls
    // renderConnectionHub() on completion, so the first user-visible render
    // already has real backend data — no localStorage cache, no guessing.
    // If renderCurrentConfig / tool switches call renderConnectionHub in the
    // meantime, the hub falls back to an explicit "加载中..." state for the
    // still-loading tool (handled in renderConnectionHub itself).
    await Promise.all([
      loadCodexOauthProfiles(),
      loadClaudeCodeOauthProfiles(),
    ]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialLoad);
  } else {
    initialLoad();
  }
})();
