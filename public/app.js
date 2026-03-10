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
  providerHealth: {},
  providerSecrets: {},
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
  openClawSetupFlowId: 0,
  openClawSetupContext: null,
  openClawConfigView: localStorage.getItem('easyaiconfig_oc_config_view') === 'minimal' ? 'minimal' : 'full',
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

  const compact = window.innerWidth <= 980;
  if (!compact) {
    const tips = Array.isArray(state.quickTips) ? state.quickTips : [];
    titleEl.textContent = '配置提示';
    bodyEl.className = 'feature-list';
    bodyEl.innerHTML = tips.map((text, index) => `<div class="feature-row"><span>${index + 1}</span><strong>${escapeHtml(text)}</strong></div>`).join('');
    return;
  }

  const heroTitle = document.querySelector('.hero-title');
  const heroSubtitle = document.querySelector('.hero-subtitle');
  const heroIndicators = document.querySelector('.hero-indicators');
  const hasStatusRows = Boolean(heroSubtitle?.querySelector('.oc-status-row'));

  titleEl.textContent = heroTitle?.textContent || '摘要';
  bodyEl.className = 'quick-summary-list';

  const compactCopy = state.activeTool === 'codex'
    ? '填 URL 和 API Key 即可。'
    : state.activeTool === 'claudecode'
      ? ''
      : (heroSubtitle?.textContent || '');

  const compactClaudeRows = state.activeTool === 'claudecode' && heroSubtitle?.innerHTML
    ? heroSubtitle.innerHTML.split('<br>').map((row) => row.trim()).filter(Boolean)
    : [];

  bodyEl.innerHTML = [
    heroIndicators?.innerHTML ? `<div class="quick-summary-pills">${heroIndicators.innerHTML}</div>` : '',
    !hasStatusRows && compactCopy ? `<div class="quick-summary-copy">${escapeHtml(compactCopy)}</div>` : '',
    compactClaudeRows.length ? `<div class="quick-summary-plain">${compactClaudeRows.map((row) => `<div class="quick-summary-line">${row}</div>`).join('')}</div>` : '',
    hasStatusRows && heroSubtitle?.innerHTML ? `<div class="quick-summary-body">${heroSubtitle.innerHTML}</div>` : '',
  ].join('');
}

/** Open OpenClaw dashboard with auth token appended */
function openOpenClawDashboard(baseUrl) {
  if (!baseUrl) return;
  // Try to get the gateway auth token from config or state
  const token = state.openclawState?.config?.gateway?.auth?.token
    || state.openclawState?.gatewayToken
    || '';
  let url = baseUrl;
  if (token) {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}token=${encodeURIComponent(token)}`;
  }
  // Use backend API to open in default browser (window.open doesn't work in Tauri)
  api('/api/open-url', { method: 'POST', body: JSON.stringify({ url }) }).then(res => {
    if (!res?.ok) window.open(url, '_blank');
  }).catch(() => {
    window.open(url, '_blank');
  });
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
function initTheme() {
  const saved = localStorage.getItem('easyaiconfig_theme') || 'dark';
  state.theme = saved;
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Update range slider fills for new theme colors
  document.querySelectorAll('.config-range').forEach(updateRangeFill);
  syncRawCodeEditorTheme();
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('easyaiconfig_theme', state.theme);
  applyTheme(state.theme);
}

// Apply theme before any rendering to prevent flash
initTheme();

/* ── Multi-tool Support ── */
async function loadTools() {
  try {
    const json = await api('/api/tools');
    if (json.ok && json.data) {
      state.tools = json.data;
      renderToolsPage();
      updateToolSelector();
    }
  } catch { /* silent */ }
}

function renderToolsPage() {
  const grid = document.querySelector('.tools-page .tools-grid');
  if (!grid || !state.tools.length) return;

  const actionSvgs = {
    update: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 1-15.36 6.36L3 21M3 12a9 9 0 0 1 15.36-6.36L21 3" /></svg>',
    reinstall: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2v6h6" /><path d="M2.5 8A10 10 0 1 1 4.34 16" /></svg>',
    uninstall: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>',
  };

  grid.innerHTML = state.tools.map(tool => {
    const isSoon = !tool.supported;
    const isInstalled = tool.binary?.installed;
    const version = tool.binary?.version || '';

    const actionButtons = tool.supported ? `
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
    ` : '<button class="secondary tool-action-btn" disabled>安装</button>';

    return `
      <div class="tool-card ${isSoon ? 'tool-card-soon' : ''}" data-tool-id="${tool.id}">
        <div class="tool-card-head">
          <div class="tool-icon tool-icon-${tool.id}">
            ${toolIconSvg(tool.id)}
          </div>
          <div class="tool-info">
            <div class="tool-name">${escapeHtml(tool.name)}${isSoon ? ' <span class="tool-soon-tag">即将支持</span>' : ''}</div>
            <div class="tool-desc">${escapeHtml(tool.description)}</div>
          </div>
        </div>
        <div class="tool-status">
          <span class="tool-version ${!isInstalled ? 'tool-version-muted' : ''}">${isInstalled ? escapeHtml(version) : (isSoon ? '暂未支持' : '未安装')}</span>
          ${isInstalled ? '<span class="tool-badge tool-badge-ok">已安装</span>' : ''}
        </div>
        <div class="tool-actions">${actionButtons}</div>
      </div>
    `;
  }).join('');

  // Event delegation - only bind once
  if (!grid._toolsBound) {
    grid._toolsBound = true;
    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tool-action]');
      if (!btn) return;
      const toolId = btn.dataset.toolId;
      const action = btn.dataset.toolAction;
      handleToolAction(toolId, action, btn);
    });
  }
}

// Generic tool action handler
async function handleToolAction(toolId, action, btn) {
  const toolNames = { codex: 'Codex', claudecode: 'Claude Code', openclaw: 'OpenClaw' };
  const toolName = toolNames[toolId] || toolId;

  // Map tool ID to API prefix
  const apiPrefix = toolId === 'codex' ? 'codex' : toolId === 'claudecode' ? 'claudecode' : 'openclaw';

  // OpenClaw install has a special handler
  if (toolId === 'openclaw' && action === 'update') {
    await openClawInstallMethodDialog(btn);
    return;
  }

  // OpenClaw uninstall has a special handler with purge choice + progress
  if (toolId === 'openclaw' && action === 'uninstall') {
    await openClawUninstallDialog(btn);
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

  // Confirm dialog if needed
  if (config.confirm) {
    const confirmed = await openUpdateDialog(config.confirm);
    if (!confirmed) {
      flash('操作已取消', 'info');
      return;
    }
  }

  // Set button busy state with spinner
  setToolBtnBusy(btn, true, config.busyText);

  try {
    const json = await api(config.api, { method: 'POST' });
    if (!json.ok) {
      flash(json.error || `${toolName} 操作失败`, 'error');
      return;
    }
    flash(config.successText, 'success');
    loadTools(); // Refresh tool cards
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

function toolIconSvg(toolId) {
  const icons = {
    codex: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7l9-5z" opacity="0.4" /><path d="M12 12l9-5M12 12v10M12 12L3 7" /></svg>',
    claudecode: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" opacity="0.4" /><path d="M8 12h8M12 8v8" /></svg>',
    openclaw: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" opacity="0.4" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none" /></svg>',
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
}

// Per-tool form state cache
const _toolFormCache = {};

function _saveCurrentToolForm() {
  const toolId = state.activeTool;
  if (!toolId) return;
  _toolFormCache[toolId] = {
    baseUrl: el('baseUrlInput')?.value || '',
    apiKey: el('apiKeyInput')?.value || '',
    protocolValue: el('openClawProtocolSelect')?.value || '',
    modelHtml: el('modelSelect')?.innerHTML || '',
    modelValue: el('modelSelect')?.value || '',
  };
}

function _restoreToolForm(toolId) {
  const cache = _toolFormCache[toolId];
  if (!cache) return false;
  const baseUrlInput = el('baseUrlInput');
  const apiKeyInput = el('apiKeyInput');
  const protocolSelect = el('openClawProtocolSelect');
  const modelSelect = el('modelSelect');
  if (baseUrlInput) baseUrlInput.value = cache.baseUrl;
  if (apiKeyInput) apiKeyInput.value = cache.apiKey;
  if (protocolSelect && cache.protocolValue) protocolSelect.value = cache.protocolValue;
  if (modelSelect) {
    modelSelect.innerHTML = cache.modelHtml;
    modelSelect.value = cache.modelValue;
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

  // Restore last active page for this tool (tab memory)
  const rememberedPage = state.toolLastPage[toolId] || 'quick';
  if (rememberedPage !== state.activePage) {
    setPage(rememberedPage);
  }
  const toolDisplayName = tool?.name || { codex: 'Codex', claudecode: 'Claude Code', openclaw: 'OpenClaw' }[toolId] || toolId;
  const launchBtn = el('launchBtn');
  if (launchBtn) launchBtn.textContent = `启动 ${toolDisplayName}`;

  const baseUrlInput = el('baseUrlInput');
  const apiKeyInput = el('apiKeyInput');
  const modelSelect = el('modelSelect');
  const detectBtn = el('detectBtn');
  const protocolSelect = el('openClawProtocolSelect');
  const baseUrlField = baseUrlInput?.closest('.field');
  const apiKeyField = apiKeyInput?.closest('.field');
  const detectField = detectBtn?.closest('.field');
  const protocolField = el('openClawProtocolField');
  const modelField = modelSelect?.closest('.field');
  const baseUrlLabel = baseUrlField?.querySelector('span');
  const apiKeyLabel = apiKeyField?.querySelector('span');
  const detectLabel = detectField?.querySelector('span');
  const modelLabel = modelField?.querySelector('span');
  const detectionMeta = el('detectionMeta');
  const heroTitle = document.querySelector('.hero-title');
  const heroSubtitle = document.querySelector('.hero-subtitle');
  const sectionTitle = document.querySelector('.flow-section .section-title');
  const modelChips = el('modelChips');

  if (baseUrlLabel) baseUrlLabel.textContent = 'Base URL';
  if (apiKeyLabel) apiKeyLabel.textContent = 'API Key';
  if (detectLabel) detectLabel.textContent = '连接检测';
  if (modelLabel) modelLabel.textContent = '可用模型';
  if (protocolField) protocolField.classList.add('hide');
  if (modelChips) modelChips.classList.add('hide');

  // Show/hide model refresh button based on tool
  const modelRefreshBtn = el('modelRefreshBtn');
  if (modelRefreshBtn) modelRefreshBtn.classList.remove('visible');

  // Hide OpenClaw running status bar when not on OpenClaw
  const ocDashRow = el('ocDashboardQuickRow');
  if (ocDashRow) ocDashRow.classList.add('hide');

  // Hide sync-env buttons (only shown for OpenClaw)
  const syncActions = el('sectionSyncActions');
  if (syncActions) syncActions.style.display = 'none';

  if (toolId === 'claudecode') {
    if (baseUrlField) baseUrlField.style.display = '';
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
    if (protocolField) protocolField.classList.add('hide');
    if (heroTitle) heroTitle.textContent = 'Claude Code 配置';
    if (heroSubtitle) heroSubtitle.textContent = '配置模型与认证方式，支持 claude login 和 API Key。';
    if (sectionTitle) sectionTitle.textContent = 'Claude Code 设置';
    if (modelLabel) modelLabel.textContent = '默认模型';
    if (detectionMeta) detectionMeta.textContent = '如果已经执行过 claude login，API Key 可以留空。';

    if (modelSelect) {
      modelSelect.innerHTML = '<option value="">加载中...</option>';
    }

    if (!_restoreToolForm('claudecode')) {
      loadClaudeCodeQuickState();
    } else {
      loadClaudeCodeQuickState();
    }
    // Show placeholder right-panel while async load runs
    renderCurrentConfig();
    return;
  }

  if (toolId !== 'openclaw') {
    if (baseUrlField) baseUrlField.style.display = '';
    if (detectField) detectField.style.display = '';
    if (modelField) modelField.style.display = '';
    if (heroTitle) heroTitle.textContent = '最快路径';
    if (protocolField) protocolField.classList.add('hide');
    if (heroSubtitle) heroSubtitle.textContent = '用户通常只需要 `URL` 和 `API Key`，这里一步完成。';
    if (sectionTitle) sectionTitle.textContent = '连接配置';
    if (detectionMeta) detectionMeta.textContent = '默认只需要 URL 和 API Key；缺少 http/https 会自动补全。';
    if (baseUrlInput) baseUrlInput.placeholder = 'https://your-provider.com/v1';
    if (apiKeyInput) {
      apiKeyInput.type = 'password';
      apiKeyInput.placeholder = 'sk-...';
    }
    syncApiKeyToggle();

    if (!_restoreToolForm('codex')) {
      if (baseUrlInput && state.current?.config?.base_url) {
        baseUrlInput.value = state.current.config.base_url;
      }
      if (apiKeyInput) {
        apiKeyInput.value = state.apiKeyField?.maskedValue || '';
      }
      if (modelSelect) {
        renderDefaultCodexModels(modelSelect, state.current?.summary?.model || '');
      }
    }
    renderCurrentConfig();
    return;
  }

  if (baseUrlField) baseUrlField.style.display = '';
  if (detectField) detectField.style.display = 'none';
  if (protocolField) protocolField.classList.remove('hide');
  if (modelField) modelField.style.display = '';
  if (heroTitle) heroTitle.textContent = 'OpenClaw';
  if (heroSubtitle) heroSubtitle.textContent = '支持 Claude / OpenAI / OpenAI Responses 三种常用协议，先填 URL 和 Token 就能跑。';
  if (sectionTitle) sectionTitle.textContent = 'OpenClaw 模型配置';
  // Show sync-env buttons for OpenClaw
  const syncActionsOc = el('sectionSyncActions');
  if (syncActionsOc) syncActionsOc.style.display = '';
  if (baseUrlLabel) baseUrlLabel.textContent = 'Base URL（可选，留空自动走官方）';
  if (apiKeyLabel) apiKeyLabel.textContent = '模型 API Key';
  if (modelLabel) modelLabel.textContent = '默认模型';
  // Show refresh button next to model select for OpenClaw
  const modelRefreshBtnOc = el('modelRefreshBtn');
  if (modelRefreshBtnOc) modelRefreshBtnOc.classList.add('visible');
  if (protocolSelect) {
    protocolSelect.innerHTML = renderOpenClawProtocolOptions();
    protocolSelect.value = 'openai-completions';
  }
  if (baseUrlInput) {
    baseUrlInput.value = '';
  }
  if (apiKeyInput) {
    apiKeyInput.type = 'password';
    apiKeyInput.value = '';
  }
  syncApiKeyToggle();
  if (modelSelect) {
    const synced = syncOpenClawQuickProtocol(protocolSelect?.value || 'openai-completions');
    modelSelect.value = synced.model;
    syncOpenClawQuickHints(synced.api);
  }

  if (!_restoreToolForm('openclaw')) {
    loadOpenClawQuickState();
  } else {
    loadOpenClawQuickState();
  }
  // Show right-panel immediately while async load runs
  renderCurrentConfig();
}

// Claude Code model aliases → display names
const CLAUDE_MODEL_ALIASES = [
  { value: 'opus', label: 'Opus (最强推理)', group: '别名' },
  { value: 'sonnet', label: 'Sonnet (均衡推荐)', group: '别名' },
  { value: 'haiku', label: 'Haiku (快速轻量)', group: '别名' },
];

async function loadClaudeCodeQuickState() {
  try {
    const json = await api('/api/claudecode/state');
    if (!json.ok || !json.data) return;
    const data = json.data;
    state.claudeCodeState = data;

    // Only update quick-page UI if Claude Code is the active tool
    if (state.activeTool !== 'claudecode') {
      // Still update console and side panel
      renderToolConsole();
      return;
    }

    const modelSelect = el('modelSelect');
    if (modelSelect) {
      // Build model options: aliases + used models from history
      let html = '<option value="">默认 (由 Claude Code 决定)</option>';

      // Alias group
      html += '<optgroup label="模型别名 (推荐)">';
      for (const m of CLAUDE_MODEL_ALIASES) {
        const selected = data.model === m.value ? ' selected' : '';
        html += `<option value="${m.value}"${selected}>${m.label}</option>`;
      }
      html += '</optgroup>';

      // Full model names from usage history
      const usedModels = data.usedModels || [];
      if (usedModels.length) {
        html += '<optgroup label="历史使用模型">';
        for (const modelName of usedModels) {
          const selected = data.model === modelName ? ' selected' : '';
          html += `<option value="${escapeHtml(modelName)}"${selected}>${escapeHtml(modelName)}</option>`;
        }
        html += '</optgroup>';
      }

      modelSelect.innerHTML = html;
      if (data.model) modelSelect.value = data.model;
    }

    // ── Show Base URL ──
    const ev = data.envVars || {};
    const baseUrlInput = el('baseUrlInput');
    if (baseUrlInput && ev.ANTHROPIC_BASE_URL?.set) {
      baseUrlInput.value = ev.ANTHROPIC_BASE_URL.value;
    }

    // ── Show API Key status ──
    const apiKeyInput = el('apiKeyInput');
    if (apiKeyInput) {
      if (data.maskedApiKey) {
        const srcLabel = { shell: 'Shell 环境变量', 'settings.json': 'settings.json', env: '进程环境变量' }[data.apiKeySource] || '';
        apiKeyInput.placeholder = `${data.maskedApiKey}${srcLabel ? ` (来自 ${srcLabel})` : ''}`;
        apiKeyInput.value = '';
      } else if (data.hasKeychainAuth) {
        apiKeyInput.placeholder = '已通过 claude login 认证 (Keychain)';
        apiKeyInput.value = '';
      } else {
        apiKeyInput.placeholder = 'ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN';
      }
    }

    // ── Show auth & env status in hero subtitle ──
    const heroSubtitle = document.querySelector('.hero-subtitle');
    if (heroSubtitle) {
      const loginInfo = data.login || {};
      const ev = data.envVars || {};
      const parts = [];

      // Auth method
      if (loginInfo.loggedIn) {
        if (loginInfo.method === 'oauth') {
          parts.push(`\u2713 OAuth：${loginInfo.email || ''}${loginInfo.orgName ? ` (${loginInfo.orgName})` : ''}`);
        } else if (loginInfo.method === 'keychain') {
          parts.push('\u2713 Keychain 认证');
        } else if (loginInfo.method === 'api_key') {
          parts.push('\u2713 Token 认证');
        }
      } else {
        parts.push('! 未认证');
      }

      // Base URL — official vs proxy
      if (ev.ANTHROPIC_BASE_URL?.set) {
        const url = ev.ANTHROPIC_BASE_URL.value;
        const isOfficial = data.isOfficial;
        parts.push(isOfficial ? `📡 官方 API` : `📡 代理：${url}`);
      }

      // Token info
      if (ev.ANTHROPIC_AUTH_TOKEN?.set) {
        parts.push(`Token: ${ev.ANTHROPIC_AUTH_TOKEN.masked}`);
      } else if (ev.ANTHROPIC_API_KEY?.set) {
        parts.push(`Key: ${ev.ANTHROPIC_API_KEY.masked}`);
      }

      heroSubtitle.innerHTML = parts.map(p => `<span>${escapeHtml(p)}</span>`).join('<br>');
    }

    // Show binary version
    const heroTitle = document.querySelector('.hero-title');
    if (heroTitle && data.binary?.version) {
      heroTitle.textContent = `Claude Code · ${data.binary.version}`;
    }

    // Update right-side panel with Claude Code data
    renderCurrentConfig();
    renderToolConsole();
  } catch { /* silent */ }
}

/* ── OpenClaw Quick State ── */
async function loadOpenClawQuickState() {
  try {
    const data = await fetchOpenClawStateData();
    const quick = deriveOpenClawQuickConfig(data);
    state.openClawQuickConfig = quick;

    // Only update quick-page UI if OpenClaw is the active tool
    if (state.activeTool !== 'openclaw') {
      // Still update console and side panel
      renderToolConsole();
      return;
    }

    const heroTitle = document.querySelector('.hero-title');
    const heroSubtitle = document.querySelector('.hero-subtitle');
    const baseUrlInput = el('baseUrlInput');
    const apiKeyInput = el('apiKeyInput');
    const modelSelect = el('modelSelect');
    const protocolSelect = el('openClawProtocolSelect');
    const detectionMeta = el('detectionMeta');

    if (heroTitle && data.binary?.version) {
      heroTitle.textContent = `OpenClaw · ${data.binary.version}`;
    } else if (heroTitle) {
      heroTitle.textContent = 'OpenClaw';
    }

    var _si = function (d, color) { return '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;flex-shrink:0">' + d + '</svg>'; };
    var iOk = _si('<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>', '#4ade80');
    var iNo = _si('<circle cx="8" cy="8" r="3" stroke-width="1.4"/>', 'rgba(255,255,255,0.3)');
    var iUrl = _si('<path d="M4 12 12 4M12 4H6M12 4v6"/>', '#60a5fa');
    var iKey = _si('<circle cx="10" cy="6" r="3"/><path d="M7.8 8.2 3 13M5.5 10.5 7 12"/>', '#f59e0b');
    var iPlug = _si('<path d="M6 2v4M10 2v4M4 6h8v3a4 4 0 0 1-8 0V6zM8 13v2"/>', '#a78bfa');

    var rows = [];
    rows.push((data.binary?.installed ? iOk : iNo) + '<span>' + (data.binary?.installed ? ('已安装：' + escapeHtml(data.binary.version || '已检测到')) : '未安装，可先配置') + '</span>');
    rows.push((data.configExists ? iOk : iNo) + '<span>' + (data.configExists ? 'openclaw.json 就绪' : '保存后自动创建') + '</span>');
    rows.push(iOk + '<span>协议：' + escapeHtml(getOpenClawProtocolMeta(quick.api || 'openai-completions').label) + '</span>');
    rows.push((quick.model ? iOk : iNo) + '<span>' + (quick.model ? ('模型：' + escapeHtml(quick.model)) : '先选默认模型') + '</span>');
    rows.push(iUrl + '<span>' + (quick.baseUrl ? ('URL：' + escapeHtml(quick.baseUrl)) : '官方直连') + '</span>');
    rows.push(iPlug + '<span>Token：' + escapeHtml(quick.envKey || getOpenClawDefaultEnvKey(quick.api || 'openai-completions')) + '</span>');
    rows.push((quick.hasApiKey ? iKey : iNo) + '<span>' + (quick.hasApiKey ? ('Key：' + escapeHtml(quick.maskedApiKey)) : '未保存 API Key') + '</span>');
    rows.push((data.gatewayToken ? iOk : iNo) + '<span>' + (data.gatewayToken ? 'Gateway Token 就绪' : 'Token 待生成') + '</span>');

    // Update launch button + dashboard quick row
    var _lb = el('launchBtn');
    var _dqr = el('ocDashboardQuickRow');
    state._ocGatewayUrl = data.gatewayUrl || '';
    if (data.gatewayReachable) {
      if (_lb) {
        _lb.innerHTML = '<span class="running-dot"></span>打开 Dashboard';
        _lb.classList.add('running');
      }
      if (_dqr) _dqr.classList.remove('hide');
    } else {
      if (_lb) {
        _lb.textContent = '启动 OpenClaw';
        _lb.classList.remove('running');
      }
      if (_dqr) _dqr.classList.add('hide');
    }

    if (heroSubtitle) {
      heroSubtitle.innerHTML = rows.map(function (r) { return '<div class="oc-status-row">' + r + '</div>'; }).join('');
    }

    if (protocolSelect) {
      protocolSelect.innerHTML = renderOpenClawProtocolOptions(quick.api || 'openai-completions');
      protocolSelect.value = quick.api || 'openai-completions';
    }

    if (baseUrlInput) {
      baseUrlInput.value = quick.baseUrl || '';
    }

    if (apiKeyInput) {
      apiKeyInput.type = 'password';
      apiKeyInput.value = '';
    }
    syncApiKeyToggle();

    const synced = syncOpenClawQuickProtocol(quick.api || 'openai-completions', quick.model || getOpenClawDefaultModel(quick.api || 'openai-completions'));
    if (modelSelect) {
      modelSelect.value = quick.model || synced.model;
    }
    syncOpenClawQuickHints(synced.api, {
      maskedApiKey: quick.maskedApiKey,
      hasStoredKey: quick.hasApiKey,
    });

    if (detectionMeta && !data.binary?.installed) {
      detectionMeta.textContent += ' 你也可以先保存好这套模型配置，安装完成后直接启动。';
    }

    // Update right-side panel with OpenClaw data
    renderCurrentConfig();
    renderToolConsole();

    // Auto-fetch models from URL if we have both URL and key
    if (quick.baseUrl && quick.hasApiKey) {
      tryAutoFetchModels();
    }
  } catch { /* silent */ }
}

async function fetchOpenClawStateData() {
  const json = await api('/api/openclaw/state');
  if (!json.ok || !json.data) {
    throw new Error(json.error || '读取 OpenClaw 状态失败');
  }
  state.openclawState = json.data;
  return json.data;
}

/* ── Provider Quick Import (Env Paste / Local Read) ── */

/**
 * Parse export statements like:
 *   export ANTHROPIC_BASE_URL=https://code.newcli.com/claude/droid
 *   export ANTHROPIC_AUTH_TOKEN=sk-ant-oat01-...
 *   export OPENAI_API_KEY=sk-...
 *   CODEX_API_KEY=sk-...
 * Returns an object mapping env var names to their values.
 */
function parseExportStatements(text) {
  const result = {};
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Match: [export] VAR_NAME=VALUE  (with or without quotes)
    const match = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.+)$/i);
    if (match) {
      const key = match[1].toUpperCase();
      let val = match[2].trim();
      // Remove surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }
  return result;
}

/**
 * Apply parsed env vars to the OpenClaw config editor form.
 * Detects provider type (anthropic/openai/codex) and fills fields automatically.
 * Returns { applied: string[], providerType: string } for feedback.
 */
function applyEnvImportToOcForm(envVars) {
  const applied = [];
  let providerType = '';
  let baseUrl = '';
  let apiKey = '';
  let envKeyName = '';

  // Detect provider type from env var names
  const keys = Object.keys(envVars);

  // Anthropic / Claude
  const anthropicBaseUrl = envVars.ANTHROPIC_BASE_URL || '';
  const anthropicAuthToken = envVars.ANTHROPIC_AUTH_TOKEN || '';
  const anthropicApiKey = envVars.ANTHROPIC_API_KEY || '';

  // OpenAI
  const openaiBaseUrl = envVars.OPENAI_BASE_URL || '';
  const openaiApiKey = envVars.OPENAI_API_KEY || '';

  // Codex
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

  // Select correct API protocol
  const apiProtocol = providerType === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
  const protocolMeta = OPENCLAW_PROTOCOL_META[apiProtocol];

  // Fill form fields
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
  const methods = [
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

  const isWin = navigator.platform?.startsWith('Win');

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
        <div class="install-methods-hint">本地推荐四种安装方式，点击卡片开始安装。</div>
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
        <div class="oiv-row"><span>Dashboard</span><code>${data.gatewayReachable ? '在线' : '未就绪'}</code></div>
      </div>
      <div class="oiv-actions">
        <button id="openclawOnboardBtn">${data.needsOnboarding ? '一键完成初始化' : '重新运行初始化'}</button>
        <button class="secondary" id="openclawDashboardBtn">${data.gatewayReachable ? '打开 Dashboard' : '检测并打开 Dashboard'}</button>
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
        openOpenClawDashboard(data.gatewayUrl || `http://127.0.0.1:${data.gatewayPort}/`);
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
  const steps = [
    { title: '已自动打开终端', done: Boolean(terminalMessage), desc: terminalMessage || '正在准备终端窗口…' },
    { title: '按终端向导完成初始化', done: Boolean(stateData?.configExists), desc: stateData?.configExists ? '已检测到 OpenClaw 配置文件。' : '终端里会引导你完成首次配置，这一步你只需要按提示继续。' },
    { title: '等待本地 Gateway 就绪', done: Boolean(stateData?.gatewayReachable), desc: stateData?.gatewayReachable ? `Dashboard 已在线：${stateData.gatewayUrl}` : '完成终端向导后，这里会自动检测本地 Dashboard 是否已启动。' },
  ];
  const showModelConfig = Boolean(stateData?.configExists || stateData?.gatewayReachable || timedOut);
  return `
    <div class="install-tracker">
      <div class="install-tracker-top">
        <div>
          <div class="install-tracker-status">${stateData?.gatewayReachable ? '初始化完成' : timedOut ? '等待你完成终端向导' : '正在自动初始化'}</div>
          <div class="install-tracker-summary">${stateData?.gatewayReachable ? 'OpenClaw 已准备好，建议先确认模型配置再打开 Dashboard。' : stateData?.configExists ? '配置已生成，正在等待 Gateway 启动。' : '终端已经自动打开，请跟着向导完成。'}</div>
        </div>
        <div class="install-tracker-percent">${stateData?.gatewayReachable ? '100%' : stateData?.configExists ? '75%' : '35%'}</div>
      </div>
      <div class="install-tracker-hint">${timedOut ? '如果终端还在运行，不用重新安装；完成后点"刷新状态"即可。' : '这个步骤已经尽量自动化了；你只需要处理终端里真正必须人工确认的内容。'}</div>
      <div class="install-tracker-detail">${escapeHtml(command || 'openclaw onboard --install-daemon')}</div>
      <div class="install-tracker-grid">
        <div class="install-tracker-col">${steps.map((step, index) => renderOpenClawInstallStep({ title: step.title, description: step.desc, status: step.done ? 'done' : (index === steps.findIndex((item) => !item.done) ? 'running' : 'pending') }, index, 0)).join('')}</div>
        <div class="install-tracker-col">
          <div class="install-tracker-note-card">
            <div class="install-tracker-note-title">你现在该做什么</div>
            <ul class="install-tracker-list">
              <li>看新弹出的终端窗口，按 OpenClaw 向导一步一步完成。</li>
              <li>这个窗口会自动帮你检测有没有配置成功。</li>
              <li>${autoOpenDashboard ? '一旦检测成功，会自动打开 Dashboard。' : '检测成功后你就可以直接打开 Dashboard。'}</li>
            </ul>
          </div>
          <div class="install-tracker-note-card">
            <div class="install-tracker-note-title">当前状态</div>
            <ul class="install-tracker-list">
              <li>配置文件：${stateData?.configExists ? '已检测到' : '还没检测到'}</li>
              <li>Gateway：${stateData?.gatewayReachable ? '已在线' : '未就绪'}</li>
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
        <div class="install-tracker-detail">${escapeHtml(terminalMessage || '终端命令准备中…')}</div>
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
            openOpenClawDashboard(state.openclawState.gatewayUrl || `http://127.0.0.1:${state.openclawState.gatewayPort}/`);
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
    await loadState({ preserveForm: true }).catch(() => {});
  }
  if (!state.claudeCodeState) {
    await loadClaudeCodeQuickState().catch(() => {});
  }

  const launchJson = await api('/api/openclaw/onboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    timeoutMs: 12000,
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
    title: '请完成终端向导',
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
  flash('终端向导可能仍在运行，完成后点“刷新状态”即可', 'info');
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
  if (method === 'source' || method === 'docker') {
    // Show instruction dialog with copy button
    const isWin = navigator.platform?.startsWith('Win');
    const fallbackCmds = {
      source: ['git clone https://github.com/nicepkg/openclaw.git', 'cd openclaw', 'pnpm install', 'pnpm build'],
      docker: ['./docker-setup.sh'],
    };
    const titles = { source: '源码构建步骤', docker: 'Docker 部署步骤' };

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
  const cmdText = method === 'script'
    ? (isWin ? "$env:OPENCLAW_NO_ONBOARD='1'; iwr -useb https://openclaw.ai/install.ps1 | iex" : 'curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm')
    : 'npm install -g openclaw@latest';

  // ── Confirmation dialog ──
  const methodLabel = method === 'script' ? '一键安装脚本' : 'npm 全局安装';
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
      loadTools();
      await loadOpenClawQuickState();
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
        <div class="install-scope-hint">推荐先选本地安装，下面四种方式都可用。</div>
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
        </button>
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
      loadTools();
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
  const copyBtn = e.target.closest('[data-copy-openclaw-log]');
  if (!copyBtn) return;
  const text = state.openClawInstallView.lastLogsText || '';
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
});

document.addEventListener('pointerup', () => {
  if (!state.openClawInstallView.pendingTask) return;
  setTimeout(() => {
    if (shouldPauseOpenClawInstallRender()) return;
    if (!state.openClawInstallView.pendingTask) return;
    renderTrackedOpenClawDialog(state.openClawInstallView.pendingTask, { force: true });
  }, 120);
});

document.addEventListener('click', async (e) => {
  const refreshBtn = e.target.closest('[data-openclaw-refresh-state]');
  if (!refreshBtn) return;
  try {
    const data = await fetchOpenClawStateData();
    const ctx = state.openClawSetupContext;
    if (ctx) {
      patchUpdateDialog({
        eyebrow: 'OpenClaw',
        title: data.gatewayReachable ? '初始化完成' : '请继续完成终端向导',
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
      flash('Dashboard 还没准备好，请先完成终端向导', 'info');
      return;
    }
    openOpenClawDashboard(data.gatewayUrl || `http://127.0.0.1:${data.gatewayPort}/`);
  } catch {
    flash('打开 Dashboard 失败', 'error');
  }
});


const PAGE_META = {
  quick: { eyebrow: 'QUICK SETUP', title: '一键配置', subtitle: '输入 URL 和 API Key，剩下交给 EasyAIConfig。' },
  providers: { eyebrow: 'Providers', title: 'Provider 与备份', subtitle: '集中查看已发现配置、检测状态与历史备份。' },
  console: { eyebrow: 'Console', title: '运行控制台', subtitle: '集中查看 Codex、Claude Code、OpenClaw 的运行状态、异常检测与快速修复入口。' },
  tools: { eyebrow: 'Tools', title: '工具安装与管理', subtitle: '安装、更新、重装或卸载 AI 编程工具。' },
  tasks: { eyebrow: 'Tasks', title: '任务管理', subtitle: '查看当前进行中和历史安装任务。' },
  about: { eyebrow: 'About', title: '关于 EasyAIConfig', subtitle: '查看桌面版本、更新源与当前运行信息。' },
  configEditor: { eyebrow: 'Current Config', title: '配置编辑', subtitle: '表单编辑 + 原始配置，选择工具后搜索预设方案快速配置。' },
};

const TOOL_CONSOLE_META = {
  codex: { label: 'Codex', actionLabel: 'Codex CLI' },
  claudecode: { label: 'Claude Code', actionLabel: 'Claude Code' },
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

function buildCodexConsoleView() {
  const data = state.current || {};
  const providers = data.providers || [];
  const active = data.activeProvider || null;
  const health = active ? state.providerHealth[active.key] : null;
  const issues = [];

  if (!data.codexBinary?.installed) {
    issues.push({ tone: 'error', title: 'Codex 未安装', copy: '还没检测到 codex 命令，先去"工具安装"里安装。', action: { type: 'goto-page', page: 'tools', label: '去安装' } });
  }
  if (!data.configExists) {
    issues.push({ tone: 'warn', title: '还没有 Codex 配置', copy: '当前作用域尚未写入 config.toml，建议先完成一次快速配置。', action: { type: 'goto-quick-tool', tool: 'codex', label: '去快速配置' } });
  }
  if (!providers.length) {
    issues.push({ tone: 'error', title: '没有可用 Provider', copy: '当前配置里还没有保存任何 Provider，Codex 启动后通常无法正常请求模型。', action: { type: 'goto-page', page: 'providers', label: '去看 Provider' } });
  }
  if (active && !active.hasApiKey) {
    issues.push({ tone: 'error', title: '当前 Provider 缺少密钥', copy: `活动 Provider "${active.name}" 已选中，但没有检测到可用 API Key。`, action: { type: 'goto-quick-tool', tool: 'codex', label: '去补 Key' } });
  }
  if (health?.checked && !health.ok) {
    issues.push({ tone: 'warn', title: '当前 Provider 连通性异常', copy: `已对 "${active?.name || '当前 Provider'}" 做过检测，但结果不通过。`, action: { type: 'refresh-console', label: '重新检测' } });
  }

  const summary = [
    renderToolConsoleStat('安装状态', data.codexBinary?.installed ? (data.codexBinary.version || '已安装') : '未安装', data.codexBinary?.path ? `<span class="tool-console-code">${escapeHtml(data.codexBinary.path)}</span>` : '', { icon: 'install' }),
    renderToolConsoleStat('作用域', data.scope === 'project' ? '项目级' : '全局', data.rootPath ? `<span class="tool-console-code">${escapeHtml(data.rootPath)}</span>` : '', { icon: 'scope' }),
    renderToolConsoleStat('活动 Provider', active?.name || '未选择', active?.baseUrl ? `<span class="tool-console-code">${escapeHtml(active.baseUrl)}</span>` : '还没有可用 Provider', { icon: 'provider' }),
    renderToolConsoleStat('健康检测', health?.loading ? '检测中' : health?.checked ? (health.ok ? '通过' : '失败') : '未检测', active ? `模型：${escapeHtml(data.summary?.model || '-')}` : '先保存 Provider 再检测', { icon: 'health' }),
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
    : '<div class="tool-console-empty">当前没有已保存的 Codex Provider。</div>';

  const main = [
    renderToolConsoleCard('状态总览', '安装、配置与当前模型', `<div class="tool-console-list">${renderToolConsoleRow('配置文件', `<span class="tool-console-code">${escapeHtml(data.configPath || '-')}</span>`, { html: true })}${renderToolConsoleRow('环境变量文件', `<span class="tool-console-code">${escapeHtml(data.envPath || '-')}</span>`, { html: true })}${renderToolConsoleRow('Sandbox', data.summary?.sandboxMode || '默认')}${renderToolConsoleRow('审批策略', data.summary?.approvalPolicy || '默认')}${renderToolConsoleRow('推理强度', data.summary?.reasoningEffort || '默认')}</div>`, { icon: 'status' }),
    renderToolConsoleCard('Provider 检测', '已保存 Provider 与密钥状态', providerBody, { icon: 'providers' }),
    renderToolConsoleCard('异常检测', '会优先指出最影响启动与请求的问题', renderToolConsoleIssueList(issues, 'Codex 侧暂未发现明显阻塞项。'), { icon: 'issues', iconTone: issues.length ? (issues.some(i => i.tone === 'error') ? 'error' : 'warn') : 'ok' }),
  ].join('');

  const side = [
    renderToolConsoleCard('推荐操作', '常用排错入口', `<div class="tool-console-actions">${[
      { type: 'refresh-console', label: '重新检测', primary: true },
      { type: 'goto-page', page: 'providers', label: '查看 Provider' },
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

function buildOpenClawConsoleView() {
  const data = state.openclawState || {};
  const quick = deriveOpenClawQuickConfig(data);
  const config = data.config || {};
  const channels = getOpenClawConsoleChannels(config);
  const providers = getOpenClawConsoleProviders(config);
  const agentInfo = getOpenClawConsoleAgents(config);
  const defaults = agentInfo.defaults || {};
  const gatewayBind = String(config.gateway?.bind || 'local');
  const gatewayAuth = String(config.gateway?.auth?.mode || 'token');
  const issues = [];

  if (!data.binary?.installed) issues.push({ tone: 'error', title: 'OpenClaw 未安装', copy: '当前还没检测到 openclaw 命令，先去"工具安装"完成安装。', action: { type: 'goto-page', page: 'tools', label: '去安装' } });
  if (!data.configExists) issues.push({ tone: 'warn', title: 'openclaw.json 尚未生成', copy: '说明还没完成初始化或还没真正保存过配置。', action: { type: 'goto-quick-tool', tool: 'openclaw', label: '去快速配置' } });
  if (data.needsOnboarding) issues.push({ tone: 'warn', title: 'OpenClaw 仍需初始化', copy: '安装后还没完成 onboard，或 Gateway 尚未真正启动。', action: { type: 'launch-openclaw', label: '启动并初始化' } });
  if (!data.gatewayReachable) issues.push({ tone: 'warn', title: 'Dashboard 未在线', copy: '当前没探测到本地 Gateway，很多渠道回调和控制面板操作都会失效。', action: { type: 'launch-openclaw', label: '启动 Gateway' } });
  if (!providers.length) issues.push({ tone: 'error', title: '没有配置模型 Provider', copy: 'OpenClaw 已安装，但 `models.providers` 里还没有可用模型源。', action: { type: 'goto-config-editor-tool', tool: 'openclaw', label: '去配置 Provider' } });
  if (!quick.model) issues.push({ tone: 'error', title: '默认 Agent 模型未设置', copy: '当前没有检测到 `agents.defaults.model.primary`，聊天入口通常无法正常出结果。', action: { type: 'goto-config-editor-tool', tool: 'openclaw', label: '去设置模型' } });
  if (providers.length && !quick.hasApiKey) issues.push({ tone: 'error', title: '默认 Provider 缺少 API Key', copy: `已检测到默认模型 ${quick.model || '-'}，但没有找到它对应的 API Key。`, action: { type: 'goto-quick-tool', tool: 'openclaw', label: '去补 Key' } });
  if ((gatewayBind === 'lan' || gatewayBind === '0.0.0.0') && gatewayAuth === 'none') issues.push({ tone: 'error', title: '网络已暴露但未启用认证', copy: '当前 Gateway 允许局域网/公网访问，但认证模式为 none，风险较高。', action: { type: 'goto-config-editor-tool', tool: 'openclaw', label: '去修安全配置' } });
  if (channels.some((item) => ['wechat', 'wechatWork', 'wechatwork', 'webhook'].includes(item.key)) && !config.gateway?.tls && !config.gateway?.trustProxy) issues.push({ tone: 'warn', title: '公网回调场景建议补 HTTPS / 反代', copy: '你已经在配公众号、企微或 Webhook，一般需要公网 HTTPS 或反向代理才能稳定接入。', action: { type: 'goto-config-editor-tool', tool: 'openclaw', label: '去配网关' } });

  const summary = [
    renderToolConsoleStat('安装状态', data.binary?.installed ? (data.binary.version || '已安装') : '未安装', data.binary?.path ? `<span class="tool-console-code">${escapeHtml(data.binary.path)}</span>` : '', { icon: 'install' }),
    renderToolConsoleStat('Dashboard', data.gatewayReachable ? '在线' : '未启动', data.gatewayUrl ? `<span class="tool-console-code">${escapeHtml(data.gatewayUrl)}</span>` : '等待本地 Gateway 启动', { icon: 'dashboard' }),
    renderToolConsoleStat('默认 Agent', quick.model || defaults.model?.primary || '未设置', defaults.thinkingDefault ? `thinking=${escapeHtml(defaults.thinkingDefault)}` : '建议先固定默认模型', { icon: 'agent' }),
    renderToolConsoleStat('接入渠道', String(channels.length), channels.length ? channels.map((item) => item.label).slice(0, 3).join(' · ') : '尚未接入任何聊天渠道', { icon: 'channel' }),
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
    renderToolConsoleCard('运行状态', 'Gateway、配置与认证', `<div class="tool-console-list">${renderToolConsoleRow('配置文件', `<span class="tool-console-code">${escapeHtml(data.configPath || '-')}</span>`, { html: true })}${renderToolConsoleRow('Gateway', data.gatewayReachable ? '在线' : '未就绪')}${renderToolConsoleRow('Bind', gatewayBind)}${renderToolConsoleRow('Auth', gatewayAuth)}${renderToolConsoleRow('Onboarding', data.needsOnboarding ? '待完成' : '已完成')}</div>`, { icon: 'runtime' }),
    renderToolConsoleCard('异常检测', '优先指出启动、模型、认证和暴露风险', renderToolConsoleIssueList(issues, 'OpenClaw 侧暂未发现明显阻塞项。'), { icon: 'issues', iconTone: issues.length ? (issues.some(i => i.tone === 'error') ? 'error' : 'warn') : 'ok' }),
  ].join('');

  const side = [
    renderToolConsoleCard('渠道与 Provider', '接入的渠道和模型源', `${channelBody}${renderToolConsoleGroupLabel('Provider')}${providerBody}`, { icon: 'channels' }),
    renderToolConsoleCard('快速操作', '检测、启动、停止', `<div class="tool-console-actions">${[
      { type: 'refresh-console', label: '重新检测', primary: true },
      data.gatewayReachable ? { type: 'open-openclaw-dashboard', label: '打开 Dashboard' } : { type: 'launch-openclaw', label: '启动 OpenClaw' },
      { type: 'stop-openclaw', label: '停止 Gateway' },
      { type: 'goto-config-editor-tool', tool: 'openclaw', label: '打开配置编辑' },
      { type: 'goto-quick-tool', tool: 'openclaw', label: '切到快速配置' },
    ].map(renderToolConsoleAction).join('')}</div>`, { icon: 'actions' }),
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
    if (!data.codexBinary?.installed) return 'error';
    const active = data.activeProvider;
    if (active) {
      const health = state.providerHealth[active.key];
      if (health?.checked && !health.ok) return 'warning';
      if (health?.checked && health.ok) return 'online';
    }
    return data.configExists ? 'online' : 'warning';
  }
  if (tool === 'claudecode') {
    const data = state.claudeCodeState || {};
    if (!data.binary?.installed) return 'error';
    const login = data.login || {};
    if (login.loggedIn || data.hasApiKey) return 'online';
    return 'warning';
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
  const summary = el('toolConsoleSummary');
  const main = el('toolConsoleMain');
  const side = el('toolConsoleSide');
  const activityEl = el('toolConsoleActivity');
  if (!summary || !main || !side) return;

  const tool = state.consoleTool || 'codex';
  document.querySelectorAll('[data-console-tool]').forEach((button) => {
    button.classList.toggle('active', button.dataset.consoleTool === tool);
  });

  // Update status dots
  const dotCodex = el('tcDotCodex');
  const dotClaude = el('tcDotClaude');
  const dotOpenClaw = el('tcDotOpenClaw');
  if (dotCodex) dotCodex.className = `tc-tab-dot ${getToolStatusDot('codex')}`;
  if (dotClaude) dotClaude.className = `tc-tab-dot ${getToolStatusDot('claudecode')}`;
  if (dotOpenClaw) dotOpenClaw.className = `tc-tab-dot ${getToolStatusDot('openclaw')}`;

  const view = tool === 'openclaw'
    ? buildOpenClawConsoleView()
    : tool === 'claudecode'
      ? buildClaudeConsoleView()
      : buildCodexConsoleView();

  summary.innerHTML = view.summary;
  main.innerHTML = view.main;
  side.innerHTML = view.side;

  // Activity panel (only for OpenClaw currently)
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



async function stopOpenClawGateway({ manual = true } = {}) {
  const result = await api('/api/openclaw/stop', { method: 'POST' });
  if (!result.ok) {
    if (manual) flash(result.error || '停止 OpenClaw 失败', 'error');
    return result;
  }
  await sleep(700);
  await loadOpenClawQuickState();
  if (manual) flash('OpenClaw Gateway 已停止', 'success');
  return result;
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
    setPage('quick');
    return;
  }

  if (action === 'goto-config-editor-tool') {
    if (targetTool === 'openclaw' && !state.openclawState) {
      await loadOpenClawQuickState();
    }
    if (targetTool !== 'openclaw' && !state.current) {
      await loadState({ preserveForm: true });
    }
    state.configEditorTool = targetTool === 'openclaw' ? 'openclaw' : 'codex';
    syncConfigEditorForTool();
    populateConfigEditor();
    if (window.refreshCustomSelects) window.refreshCustomSelects();
    setPage('configEditor');
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
    openOpenClawDashboard(data.gatewayUrl || `http://127.0.0.1:${data.gatewayPort || 18789}/`);
    return;
  }

  if (action === 'stop-openclaw') {
    await stopOpenClawGateway({ manual: true });
    renderToolConsole();
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

async function api(url, options = {}) {
  const timeoutMs = options.timeoutMs || 20000;

  if (tauriInvoke) {
    try {
      const result = await Promise.race([
        tauriInvoke('backend_request', parseApiRequest(url, options)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('请求超时')), timeoutMs)),
      ]);
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
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

const OPENCLAW_MODEL_PRESETS = [
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
            <ul class="install-tracker-list"><li>方式：${escapeHtml(task.method === 'script' ? '一键脚本' : 'npm 全局安装')}</li><li>耗时：${escapeHtml(formatRelativeDuration(task.startedAt, task.completedAt))}</li><li>命令：<code>${escapeHtml(task.command || '')}</code></li></ul>
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
  if (el('pageEyebrow')) el('pageEyebrow').textContent = meta.eyebrow;
  if (el('pageTitle')) el('pageTitle').textContent = meta.title;
  if (el('pageSubtitle')) el('pageSubtitle').textContent = meta.subtitle;

  // Toggle action buttons
  const defaultActions = el('defaultActions');
  const configActions = el('configEditorActions');
  if (defaultActions) defaultActions.classList.toggle('hide', page === 'configEditor');
  if (configActions) configActions.classList.toggle('hide', page !== 'configEditor');

  // Render tasks page on navigate
  if (page === 'tasks') renderTasksPage();
  if (page === 'console') {
    renderToolConsole();
    if (!state.consoleRefreshing) void refreshToolConsoleData();
  }
  if (page === 'configEditor') {
    applyConfigEditorSearch();
  }
}

function syncAboutUpdateActions() {
  const info = state.appUpdate || {};
  const installBtn = el('aboutInstallUpdateBtn');
  const checkBtn = el('aboutCheckUpdateBtn');
  if (!installBtn || !checkBtn) return;
  installBtn.hidden = !Boolean(info.available);
  checkBtn.classList.toggle('about-update-btn-secondary', Boolean(info.available));
}

function populateAboutPanel() {
  const info = state.appUpdate || {};
  const appVersion = info.currentVersion || '1.0.0';
  const status = el('aboutUpdaterStatus');
  el('aboutAppVersion').textContent = appVersion;
  el('aboutCodexVersion').textContent = appVersion;
  if (info.available) {
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
  syncAboutUpdateActions();
  el('aboutRepo').textContent = info.repository || '-';
  el('aboutEndpoint').textContent = info.endpoint || '-';
  el('aboutPubkeyStatus').textContent = info.publicKeyConfigured ? '已配置' : '未配置';
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

function getConfigEditorTool() {
  return state.configEditorTool === 'openclaw' ? 'openclaw' : 'codex';
}

async function setConfigEditorOpen(open) {
  state.configEditorOpen = open;
  if (open) {
    if (getConfigEditorTool() === 'openclaw' && !state.openclawState) {
      await loadOpenClawQuickState();
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

const CONFIG_NUMBER_FIELDS = {
  cfgContextWindowInput: {
    rangeId: 'cfgContextWindowRange',
    resetId: 'cfgContextWindowResetBtn',
    hintId: 'cfgContextWindowHint',
    min: 32000,
    max: 512000,
    step: 1000,
    defaultValue: () => 272000,
    defaultPlaceholder: () => '默认 272000',
    hint: (value, empty) => empty ? '拖动滑杆快速调整，也可直接输入数字。' : `当前设置 ${value}`,
  },
  cfgCompactLimitInput: {
    rangeId: 'cfgCompactLimitRange',
    resetId: 'cfgCompactLimitResetBtn',
    hintId: 'cfgCompactLimitHint',
    min: 16000,
    max: 512000,
    step: 1000,
    defaultValue: () => Math.round((getConfigNumberValue('cfgContextWindowInput') || 272000) * 0.9),
    defaultPlaceholder: () => `默认 上下文90% ≈ ${Math.round((getConfigNumberValue('cfgContextWindowInput') || 272000) * 0.9)}`,
    hint: (value, empty) => empty ? '默认使用上下文大小的 90%。' : `当前设置 ${value}`,
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
  if (inputId === 'cfgCompactLimitInput') {
    const contextLimit = getConfigNumberValue('cfgContextWindowInput') || 272000;
    range.max = String(Math.max(spec.min, contextLimit));
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
  const pct = ((val - min) / (max - min)) * 100;
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const fillColor = isDark
    ? 'linear-gradient(90deg, rgba(141,192,255,0.35), rgba(141,192,255,0.65))'
    : 'linear-gradient(90deg, rgba(59,130,246,0.35), rgba(59,130,246,0.65))';
  const trackColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  range.style.background = `${fillColor} 0% / ${pct}% 100% no-repeat, ${trackColor}`;
  range.style.borderRadius = '999px';
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

function populateConfigEditor() {
  syncConfigEditorForTool();

  if (getConfigEditorTool() === 'openclaw') {
    populateOpenClawConfigEditor();
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
  syncRawConfigHighlight();
  refreshConfigNumberFields();
  syncShortcutActiveState();
  applyConfigEditorSearch();
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

function applyConfigEditorSearch() {
  const input = el('configEditorSearchInput');
  const clearBtn = el('configEditorSearchClearBtn');
  const empty = el('configEditorSearchEmpty');
  const root = document.querySelector(`[data-tool-editor="${getConfigEditorTool()}"]`);
  const query = normalizeStoreText(input?.value || '');
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
      : '搜索配置方案…如 模型、推理、沙箱、上下文';
    searchInput.value = '';
  }
  const searchResults = el('ocRecipeResults');
  if (searchResults) searchResults.classList.add('hide');

  const fieldSearchInput = el('configEditorSearchInput');
  if (fieldSearchInput) {
    fieldSearchInput.placeholder = tool === 'openclaw'
      ? '搜索配置项…如 Telegram、网关、日志、Agent'
      : '搜索配置项…如 沙箱、审批、推理、SQLite';
  }
  // Show/hide OpenClaw header config switch
  const ocSwitch = el('ocHeaderConfigSwitch');
  if (ocSwitch) ocSwitch.classList.toggle('hide', tool !== 'openclaw');
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
  return getConfigStoreRecipesByTool(getConfigEditorTool());
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
  const toolNames = { codex: 'Codex', claudecode: 'Claude Code', openclaw: 'OpenClaw' };
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
      } else if (ctxNum > 2097152) {
        warnings.push(`上下文窗口 ${ctxNum} 非常大，可能超出模型支持范围`);
      }
    }

    // Check compact limit vs context window
    const compactLimit = el('cfgCompactLimitInput')?.value?.trim();
    if (compactLimit && ctxWindow) {
      const compactNum = Number(compactLimit);
      const ctxNum = Number(ctxWindow);
      if (compactNum > ctxNum) {
        errors.push(`自动压缩阈值 (${compactNum}) 大于上下文窗口 (${ctxNum})`);
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

async function saveConfigEditor() {
  setBusy('saveConfigEditorBtn', true, '保存中...');

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
  const json = await api('/api/config/raw-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: el('scopeSelect').value,
      projectPath: el('projectPathInput').value.trim(),
      codexHome: el('codexHomeInput').value.trim(),
      configToml: el('cfgRawTomlTextarea').value,
    }),
  });
  setBusy('saveRawConfigEditorBtn', false);
  if (!json.ok) return false;
  flash('原始 TOML 已保存', 'success');
  await loadState({ preserveForm: true });
  populateConfigEditor();
  return true;
}

async function applyConfigEditor() {
  setBusy('applyConfigEditorBtn', true, '生效中...');

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
        openOpenClawDashboard(launch.data.gatewayUrl);
      } else {
        flash(launch.data?.message || '配置已保存', 'success');
      }
    } catch (e) {
      flash('配置已保存，但启动失败：' + e.message, 'warn');
    }
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
    if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
    else if (!/\/v1$/i.test(url.pathname)) url.pathname = `${url.pathname}/v1`;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}

function inferSeed(baseUrl) {
  try {
    const parts = new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase().replace(/^www\./, '').split('.');
    const ignored = new Set(['api', 'openai', 'codex', 'gateway', 'chat', 'www', 'dapi']);
    return parts.find((part) => !ignored.has(part) && /[a-z]/.test(part)) || 'custom';
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
      reuseExisting: true,
    };
  }

  const matchedByBaseUrl = providers.find((item) => normalizeBaseUrl(item.baseUrl || '') === normalized);
  if (matchedByBaseUrl) {
    return {
      providerKey: matchedByBaseUrl.key,
      providerLabel: String(matchedByBaseUrl.name || ''),
      envKey: String(matchedByBaseUrl.envKey || ''),
      reuseExisting: true,
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
  const codex = state.current?.codexBinary || { installed: false };

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
  if (!provider.hasApiKey) return { text: '缺少 Key', tone: 'warn' };
  if (!item) return { text: '待检测', tone: 'muted' };
  if (item.loading) return { text: '检测中', tone: 'muted' };
  if (item.ok) return { text: '已通', tone: 'ok' };
  return { text: '失败', tone: 'bad' };
}

function renderCurrentConfig() {
  // ── Claude Code tab ──
  if (state.activeTool === 'claudecode') {
    const cc = state.claudeCodeState;
    const model = cc?.model || el('modelSelect')?.value || '未选择模型';
    const login = cc?.login || {};
    let providerName = 'Claude Code';
    if (login.orgName) providerName = login.orgName;
    else if (login.email) providerName = login.email;

    let statusText, statusTone;
    if (login.loggedIn) { statusText = '已通'; statusTone = 'ok'; }
    else if (cc?.maskedApiKey) { statusText = '已配置 Key'; statusTone = 'ok'; }
    else { statusText = '未认证'; statusTone = 'warn'; }

    const ev = cc?.envVars || {};
    const baseUrl = ev.ANTHROPIC_BASE_URL?.set ? ev.ANTHROPIC_BASE_URL.value : 'https://api.anthropic.com';

    el('currentConfigMain').innerHTML = `<span class="current-provider">${escapeHtml(providerName)}</span><span class="current-model">${escapeHtml(model || '-')}</span>`;
    el('currentConfigMeta').innerHTML = `状态 <span class="provider-pill ${statusTone}">${escapeHtml(statusText)}</span><span class="meta-sep">·</span><span class="current-url">${escapeHtml(baseUrl)}</span>`;

    el('providerDropdown').innerHTML = '<div class="provider-empty">Claude Code 不使用 Provider 切换</div>';
    el('providerDropdown').classList.toggle('hide', !state.providerDropdownOpen);
    el('providerSwitchBtn').setAttribute('aria-expanded', String(state.providerDropdownOpen));

    state.quickTips = [
      '支持 claude login 和 API Key 两种认证方式',
      '模型别名（sonnet / opus / haiku）可直接使用',
      '可通过 Base URL 配置代理或第三方 API',
    ];
    renderQuickRailSupportPanel();
    return;
  }

  // ── OpenClaw tab ──
  if (state.activeTool === 'openclaw') {
    const quick = state.openClawQuickConfig;
    const ocState = state.openclawState;
    const model = quick?.model || el('modelSelect')?.value || '未选择默认模型';

    el('currentConfigMain').innerHTML = `<span class="current-provider">OpenClaw</span><span class="current-model">${escapeHtml(model)}</span>`;

    const meta = [
      `<span class="provider-pill ok">${escapeHtml(getOpenClawProtocolMeta(quick?.api || 'openai-completions').label)}</span>`,
      quick?.baseUrl ? `<span class="current-url">${escapeHtml(quick.baseUrl)}</span>` : '官方默认端点',
      `<span class="provider-pill ${quick?.hasApiKey ? 'ok' : 'warn'}">${quick?.hasApiKey ? '已保存 Key' : '缺少 Key'}</span>`,
      `<span class="provider-pill ${ocState?.gatewayReachable ? 'ok' : 'muted'}">${ocState?.gatewayReachable ? 'Dashboard 在线' : 'Dashboard 未启动'}</span>`,
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
  const active = state.current?.activeProvider || null;
  const model = state.current?.summary?.model || el('modelSelect').value || '未选择模型';
  const providerName = active ? (active.name || active.key) : '未配置';
  const status = active ? providerHealthLabel(active) : { text: '未配置', tone: 'muted' };
  el('currentConfigMain').innerHTML = `<span class="current-provider">${escapeHtml(providerName)}</span><span class="current-model">${escapeHtml(model || '-')}</span>`;
  el('currentConfigMeta').innerHTML = active
    ? `状态 <span class="provider-pill ${status.tone}">${escapeHtml(status.text)}</span><span class="meta-sep">·</span><span class="current-url">${escapeHtml(active.baseUrl || '-')}</span>`
    : '当前还没有可用 Provider';

  const providers = state.current?.providers || [];
  el('providerDropdown').innerHTML = providers.length ? providers.map((provider) => {
    const badge = providerHealthLabel(provider);
    return `
      <button class="provider-option ${provider.isActive ? 'active' : ''}" data-load-provider="${escapeHtml(provider.key)}">
        <span class="provider-option-main">
          <strong>${escapeHtml(provider.name || provider.key)}</strong>
          <span>${escapeHtml(provider.baseUrl || '-')}</span>
        </span>
        <span class="provider-option-side">
          <span class="provider-pill ${badge.tone}">${escapeHtml(badge.text)}</span>
          <span class="provider-option-model">${escapeHtml(provider.isActive ? (state.current?.summary?.model || '-') : '切换')}</span>
        </span>
      </button>
    `;
  }).join('') : '<div class="provider-empty">暂无 Provider 配置</div>';

  el('providerDropdown').classList.toggle('hide', !state.providerDropdownOpen);
  el('providerSwitchBtn').setAttribute('aria-expanded', String(state.providerDropdownOpen));

  state.quickTips = [
    '检测模型后自动推荐最新可用模型',
    '保存后写入 Codex 配置并保留备份',
    '未安装 Codex 时，启动会弹窗引导自动安装',
  ];
  renderQuickRailSupportPanel();
}

async function refreshProviderHealth(force = false) {
  const providers = (state.current?.providers || []).filter((provider) => provider.hasApiKey && provider.baseUrl);
  await Promise.all(providers.map(async (provider) => {
    const existing = state.providerHealth[provider.key];
    // Skip if already checked or currently loading (with a staleness guard of 12s)
    if (!force && existing) {
      if (existing.checked) return;
      if (existing.loading && existing.startedAt && (Date.now() - existing.startedAt < 12000)) return;
    }
    state.providerHealth[provider.key] = { loading: true, checked: false, startedAt: Date.now() };
    renderCurrentConfig();
    try {
      // Race: API call vs hard timeout so we never stay stuck
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
      state.providerHealth[provider.key] = { loading: false, checked: true, ok: Boolean(result?.ok) };
    } catch (err) {
      console.warn('Provider health check failed:', provider.key, err);
      state.providerHealth[provider.key] = { loading: false, checked: true, ok: false };
    }
    renderCurrentConfig();
  }));
}

function toggleProviderDropdown(force) {
  state.providerDropdownOpen = typeof force === 'boolean' ? force : !state.providerDropdownOpen;
  renderCurrentConfig();
  if (state.providerDropdownOpen) {
    refreshProviderHealth();
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
  // Skip when Claude Code is active — its model list is managed separately
  if (state.activeTool === 'claudecode') return;

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
        <strong>${escapeHtml(provider.name || provider.key)}</strong>
        <div class="provider-meta">${escapeHtml(provider.baseUrl || '-')}</div>
      </div>
      <button class="secondary tiny-btn" data-load-provider="${escapeHtml(provider.key)}">载入</button>
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
  el('detectionMeta').textContent = provider.hasApiKey
    ? `已载入 ${provider.name || provider.key}，Key 已保存，可点击右侧眼睛查看`
    : `已载入 ${provider.name || provider.key}，但未发现 Key`;
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
  state.providerHealth = {};
  fillAdvancedFromState();
  renderStatus();
  renderProviders();
  renderCurrentConfig();

  // Skip Codex form restoration when non-Codex tool is active
  if (state.activeTool === 'claudecode' || state.activeTool === 'openclaw') {
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
    renderCurrentConfig();
    refreshProviderHealth();
    syncShortcutActiveState();
    renderToolConsole();
    return;
  }
  fillFromProvider(state.current.activeProvider || state.current.providers?.[0]);
  renderCurrentConfig();

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

async function handleAppUpdate(buttonId = 'appUpdateBtn') {
  const info = state.appUpdate || await loadAppUpdateState({ manual: true });
  if (!info) return;
  if (!info.enabled) return;
  if (!info.available) return;

  const confirmed = window.confirm(`当前版本：${info.currentVersion}
最新版本：${info.version}

确定下载并安装客户端更新吗？安装后会自动重启。`);
  if (!confirmed) return;

  setBusy('appUpdateBtn', true, '下载中...');
  if (buttonId !== 'appUpdateBtn') setBusy(buttonId, true, '更新中...');
  const json = await api('/api/app/update', { method: 'POST', timeoutMs: 300000 });
  setBusy('appUpdateBtn', false);
  if (buttonId !== 'appUpdateBtn') setBusy(buttonId, false);
  if (!json.ok) return flash(json.error || '客户端更新失败', 'error');
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
  await loadState({ preserveForm: true });
  return true;
}

/** Get base URL and API Key from the current form, works for both Codex and OpenClaw. */
function _getDetectParams() {
  const baseUrl = normalizeBaseUrl(el('baseUrlInput')?.value?.trim() || '');
  const apiKey = el('apiKeyInput')?.value?.trim() || '';
  // For Codex: also check stored key
  if (state.activeTool === 'codex') {
    const payload = currentPayload();
    const useStored = canUseStoredApiKey({ baseUrl: payload.baseUrl, providerKey: payload.providerKey }) && !payload.apiKey;
    return { baseUrl: payload.baseUrl || baseUrl, apiKey: payload.apiKey || apiKey, useStored, payload };
  }
  // For OpenClaw: check if key was stored in openclawState
  const storedKey = state.openClawQuickConfig?.apiKey || '';
  return { baseUrl, apiKey: apiKey || storedKey, useStored: false, payload: null };
}

async function detectModels() {
  const params = _getDetectParams();
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
  if (state.activeTool !== 'codex' && state.activeTool !== 'openclaw') return;
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
  if (state.activeTool === 'openclaw') {
    return saveOpenClawConfigOnly();
  }
  const payload = currentPayload();
  if (payload.baseUrl && payload.baseUrl !== el('baseUrlInput').value.trim()) el('baseUrlInput').value = payload.baseUrl;
  const canReuseStoredKey = canUseStoredApiKey({ baseUrl: payload.baseUrl, providerKey: payload.providerKey });
  if (!payload.baseUrl || (!payload.apiKey && !canReuseStoredKey)) return flash('先填 URL 和 API Key', 'error');

  setBusy('saveBtn', true, '保存中...');
  const saved = await api('/api/config/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  setBusy('saveBtn', false);
  if (!saved.ok) return flash(saved.error || '保存失败', 'error');
  flash('配置已保存', 'success');
  await loadState({ preserveForm: false });
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

  // Safety: don't save OpenAI keys into Claude Code config
  if (apiKey && apiKey.startsWith('sk-') && apiKey.length > 30) {
    flash('检测到 OpenAI Key，请勿填入 Claude Code 配置', 'error');
    return;
  }

  setBusy('saveBtn', true, '保存中...');
  const payload = { model };
  if (apiKey) {
    payload.env = { ANTHROPIC_API_KEY: apiKey };
  }

  const saved = await api('/api/claudecode/config-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  setBusy('saveBtn', false);
  if (!saved.ok) return flash(saved.error || '保存失败', 'error');
  flash('Claude Code 配置已保存', 'success');
}

async function launchCodex(buttonId = 'launchBtn', successMessage = 'Codex 已启动') {
  const codexInstalled = state.current?.codexBinary?.installed;
  if (!codexInstalled) {
    const shouldInstall = await openUpdateDialog({
      eyebrow: 'Codex',
      title: '未检测到 Codex',
      body: '<p>当前设备还没有安装 Codex，可以立即自动安装后再启动。</p>',
      confirmText: '立即安装',
      cancelText: '取消',
    });
    if (!shouldInstall) return false;
    const installed = await installCodex({ silent: true });
    if (!installed) return false;
  }

  setBusy(buttonId, true, '启动中...');
  const launched = await api('/api/codex/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: el('launchCwdInput').value.trim() || state.current?.launch?.cwd || '' }),
  });
  setBusy(buttonId, false);
  if (!launched.ok) {
    flash(launched.error || '启动失败', 'error');
    return false;
  }
  flash(successMessage, 'success');
  return true;
}

async function launchCodexOnly() {
  if (state.activeTool === 'claudecode') {
    return launchClaudeCodeOnly();
  }
  if (state.activeTool === 'openclaw') {
    // If already running, just open the dashboard
    if (el('launchBtn')?.classList.contains('running') && state._ocGatewayUrl) {
      openOpenClawDashboard(state._ocGatewayUrl);
      flash('OpenClaw Dashboard 已打开', 'success');
      return;
    }
    return launchOpenClawOnly();
  }
  await launchCodex('launchBtn', 'Codex 已启动');
}

async function launchOpenClawOnly() {
  const launchBtn = el('launchBtn');
  const orig = launchBtn?.textContent || '启动 OpenClaw';
  if (launchBtn) launchBtn.textContent = '启动中...';

  // --- build launch tracker state ---
  const startedAt = Date.now();
  const launchSteps = [
    { key: 'check', title: '检查安装状态', desc: '确认 openclaw 是否已安装', status: 'running' },
    { key: 'config', title: '检查配置与初始化', desc: '检测配置文件和 onboard 状态', status: 'pending' },
    { key: 'gateway', title: '启动 Gateway 服务', desc: '在终端中启动 openclaw gateway', status: 'pending' },
    { key: 'ready', title: '打开 Dashboard', desc: '等待 Dashboard 上线并自动打开', status: 'pending' },
  ];
  let currentStep = 0;
  let detail = '正在获取 OpenClaw 状态…';
  let hint = '稍等一下，马上就好。';
  let gatewayUrl = '';
  let terminalMsg = '';
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
                <li>${currentStep <= 1 ? '不需要操作，自动检测中。' : currentStep === 2 ? '如果终端弹出来了，保持它运行就行。' : '一切就绪，Dashboard 马上打开。'}</li>
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

      // Brief poll to wait for gateway (daemon should start automatically)
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
            openOpenClawDashboard(refreshed.gatewayUrl || gatewayUrl);
            flash('OpenClaw Dashboard 已打开', 'success');
            await loadOpenClawQuickState();
            return;
          }
          if (attempt % 5 === 4) {
            pushLog(`第 ${attempt + 1} 次检测：Gateway=${refreshed.gatewayReachable ? '在线' : '未响应'}`);
          }
        } catch { /* ignore */ }
      }

      // Gateway didn't come up in 30s, still show success for init
      pushLog('Gateway 还未就绪，但初始化已完成');
      hint = '初始化已完成，Gateway 可能还在启动中。稍后可再点"启动 OpenClaw"。';
      stopTimer();
      updateDialog('初始化完成', 'Gateway 正在启动，稍后可再试');
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
      openOpenClawDashboard(gatewayUrl);
      flash('OpenClaw Dashboard 已打开', 'success');
      return;
    }

    // Gateway not running — launch it
    pushLog('Gateway 未运行，正在启动…');
    detail = '正在通过终端启动 Gateway…';
    hint = '终端会自动打开。Gateway 启动后这里会自动检测。';
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

    terminalMsg = launchJson.data?.message || '启动命令已发送';
    pushLog(terminalMsg);
    pushLog(`命令：${launchJson.data?.command || 'openclaw gateway start'}`);
    detail = launchJson.data?.command || 'openclaw gateway start';
    hint = '终端已打开，正在等待 Gateway 服务响应…';
    updateDialog('启动中', 'Gateway 命令已执行，等待服务响应…');

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
          openOpenClawDashboard(refreshed.gatewayUrl || gatewayUrl);
          flash('OpenClaw Dashboard 已打开', 'success');
          await loadOpenClawQuickState();
          return;
        }
        if (attempt % 5 === 4) {
          pushLog(`第 ${attempt + 1} 次轮询：Gateway 仍未响应`);
        }
        hint = `正在等待 Gateway 响应…（第 ${attempt + 1} 次检测）`;
        updateDialog('启动中', 'Gateway 启动中，等待服务响应…');
      } catch { /* ignore */ }
    }

    // timed out waiting for gateway
    pushLog('等待超时：Gateway 未在预期时间内响应');
    hint = 'Gateway 可能需要手动检查。你也可以直接在浏览器访问 Dashboard 地址试试。';
    launchSteps[2].desc = 'Gateway 未在预期时间内响应';
    stopTimer();
    updateDialog('等待超时', 'Gateway 还未就绪，请检查终端');
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
    if (env.config.exists && env.config.hasProviders) {
      setWcItemStatus('wcConfig', 'wcConfigStatus', 'ok', '已配置');
    } else if (env.config.exists) {
      setWcItemStatus('wcConfig', 'wcConfigStatus', 'warn', '无 Provider');
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
    if (state.tools.find(t => t.id === 'openclaw')?.binary?.installed) toolsInstalled.push('OpenClaw');
    if (toolsInstalled.length > 0) {
      lines.push(`${_tools} 已安装：${toolsInstalled.join('、')}`);
    } else {
      lines.push(`${_pkg} 下一步选择要安装的 AI 工具`);
    }
    if (!env.config.hasProviders) {
      lines.push(`${_bolt} 需要配置 API Provider`);
    }
    if (toolsInstalled.length > 0 && env.config.hasProviders) {
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
  openclaw: {
    name: 'OpenClaw',
    package: 'openclaw',
    installApi: '/api/openclaw/install',
    methods: [
      { id: 'script', label: '一键脚本', cmd: navigator.platform?.startsWith('Win') ? "$env:OPENCLAW_NO_ONBOARD='1'; iwr -useb https://openclaw.ai/install.ps1 | iex" : 'curl -fsSL https://openclaw.ai/install.sh | OPENCLAW_NO_ONBOARD=1 bash -s -- --no-onboard --install-method npm', tag: '推荐' },
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
  progressEl.classList.remove('hide');
  // Show which command is running
  const cmdText = selectedMethod?.cmd || '';
  progressEl.innerHTML = `
    <div class="wib-spinner"></div>
    <div class="wib-progress-info">
      <div style="font-size:0.82rem;font-weight:600;">正在安装 ${escapeHtml(meta.name)}…</div>
      <code style="font-size:0.72rem;opacity:0.6;margin-top:4px;display:block;word-break:break-all;">${escapeHtml(cmdText)}</code>
    </div>
  `;
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

    const bodyPayload = (tool === 'openclaw') ? { method } : undefined;
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
  const baseUrl = normalizeBaseUrl(el('wizardBaseUrl').value);
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
  const baseUrl = normalizeBaseUrl(el('wizardBaseUrl').value);
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
  el('baseUrlInput').addEventListener('input', () => applyDerivedMeta(false));
  el('baseUrlInput').addEventListener('blur', () => {
    const rawValue = el('baseUrlInput').value;
    const value = state.activeTool === 'openclaw'
      ? normalizeOpenClawBaseUrl(rawValue, el('modelSelect')?.value || '', el('openClawProtocolSelect')?.value || '')
      : normalizeBaseUrl(rawValue);
    if (value) el('baseUrlInput').value = value;
    applyDerivedMeta(false);
    // Auto-fetch models from URL for Codex and OpenClaw
    if ((state.activeTool === 'codex' || state.activeTool === 'openclaw') && value) {
      tryAutoFetchModels();
    }
  });
  el('apiKeyInput').addEventListener('input', () => {
    const raw = el('apiKeyInput').value.trim();
    const currentActual = state.apiKeyField.actualValue.trim();
    state.apiKeyField.dirty = Boolean(raw) && (!state.apiKeyField.hasStored || !currentActual || raw !== currentActual);
    renderQuickSummary();
  });
  el('apiKeyToggleBtn').addEventListener('click', toggleApiKeyVisibility);
  el('detectBtn').addEventListener('click', detectModels);

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

  // Auto-fetch models when model select is opened (for OpenClaw)
  let _lastModelFetch = 0;
  el('modelSelect')?.addEventListener('mousedown', () => {
    if (state.activeTool !== 'openclaw') return;
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
  el('launchBtn').addEventListener('click', launchCodexOnly);
  // OpenClaw dashboard quick button
  if (el('ocOpenDashboardBtn')) {
    el('ocOpenDashboardBtn').addEventListener('click', () => {
      if (state._ocGatewayUrl) {
        openOpenClawDashboard(state._ocGatewayUrl);
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
        await api('/api/openclaw/stop', { method: 'POST' });
        flash('OpenClaw Gateway 已停止', 'success');
        // Wait a moment then refresh state
        await new Promise(r => setTimeout(r, 1000));
        await loadOpenClawQuickState();
      } catch (e) {
        flash('停止失败：' + (e.message || e), 'error');
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
      patch,
    };
    const json = await api('/api/config/patch', {
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
    if (state.activeTool === 'openclaw') {
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
  el('savedProviders').addEventListener('click', (event) => {
    const button = event.target.closest('[data-load-provider]');
    if (!button) return;
    const providerKey = button.dataset.loadProvider;
    fillFromProvider((state.current?.providers || []).find((item) => item.key === providerKey));
    // Update visual active state on provider cards
    el('savedProviders').querySelectorAll('.provider-card').forEach(card => card.classList.remove('active'));
    const card = button.closest('.provider-card');
    if (card) card.classList.add('active');
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
    populateAboutPanel();
    setPage('about');
  });
  el('themeToggleBtn').addEventListener('click', toggleTheme);
  el('configEditorBtn').addEventListener('click', () => setConfigEditorOpen(true));
  el('closeConfigEditorBtn').addEventListener('click', () => setConfigEditorOpen(false));
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

  // Config Editor tab switcher
  const cfgEditorTabs = document.getElementById('configEditorTabs');
  if (cfgEditorTabs) {
    cfgEditorTabs.addEventListener('click', async (e) => {
      const tab = e.target.closest('[data-cfg-tool]');
      if (!tab) return;
      e.preventDefault();
      const tool = tab.dataset.cfgTool === 'openclaw' ? 'openclaw' : 'codex';
      if (tool === getConfigEditorTool()) return;

      state.configEditorTool = tool;
      syncConfigEditorForTool();

      if (tool === 'openclaw' && !state.openclawState) {
        await loadOpenClawQuickState();
      }

      populateConfigEditor();

      if (window.refreshCustomSelects) window.refreshCustomSelects();
    });
  }

  const consoleTabs = el('toolConsoleTabs');
  if (consoleTabs) {
    consoleTabs.addEventListener('click', (e) => {
      const button = e.target.closest('[data-console-tool]');
      if (!button) return;
      state.consoleTool = button.dataset.consoleTool || 'codex';
      renderToolConsole();
    });
  }

  el('toolConsoleRefreshBtn')?.addEventListener('click', () => {
    refreshToolConsoleData({ manual: true });
  });

  el('toolConsolePage')?.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-console-action]');
    if (!button) return;
    e.preventDefault();
    await handleToolConsoleAction(button);
  });

  el('configEditorSearchInput')?.addEventListener('input', applyConfigEditorSearch);
  el('configEditorSearchClearBtn')?.addEventListener('click', () => {
    const input = el('configEditorSearchInput');
    if (!input) return;
    input.value = '';
    applyConfigEditorSearch();
    input.focus();
  });
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
  el('providerRefreshBtn').addEventListener('click', () => refreshProviderHealth(true));
  el('providerDropdown').addEventListener('click', (event) => {
    const button = event.target.closest('[data-load-provider]');
    if (!button) return;
    fillFromProvider((state.current?.providers || []).find((item) => item.key === button.dataset.loadProvider));
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
  el('aboutOpenAdvancedBtn').addEventListener('click', () => setConfigEditorOpen(true));
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
window.addEventListener('resize', () => {
  refreshRawCodeEditors();
  renderQuickRailSupportPanel();
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
    // Returning user — auto-trigger wizard only if setup is needed
    if (state.current && (!state.current.codexBinary?.installed || !state.current.configExists || !(state.current.providers?.length > 0))) {
      openSetupWizard();
    }
  }
});
loadBackups();
loadAppUpdateState();
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
