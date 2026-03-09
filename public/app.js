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
};

const el = (id) => document.getElementById(id);
const tauriInvoke = window.__TAURI__?.core?.invoke || null;

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
  } catch { /* silent */ }
}

/* ── OpenClaw Quick State ── */
async function loadOpenClawQuickState() {
  try {
    const data = await fetchOpenClawStateData();
    const quick = deriveOpenClawQuickConfig(data);
    state.openClawQuickConfig = quick;

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
      if (_lb && state.activeTool === 'openclaw') {
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
  quick: { eyebrow: 'Quick Setup', title: '一键配置 Codex 工具', subtitle: '输入 URL 和 API Key，剩下交给 EasyAIConfig。' },
  providers: { eyebrow: 'Providers', title: 'Provider 与备份', subtitle: '集中查看已发现配置、检测状态与历史备份。' },
  tools: { eyebrow: 'Tools', title: '工具安装与管理', subtitle: '安装、更新、重装或卸载 AI 编程工具。' },
  tasks: { eyebrow: 'Tasks', title: '任务管理', subtitle: '查看当前进行中和历史安装任务。' },
  about: { eyebrow: 'About', title: '关于 EasyAIConfig', subtitle: '查看桌面版本、更新源与当前运行信息。' },
  configEditor: { eyebrow: 'Current Config', title: '配置编辑', subtitle: '表单编辑 + 原始配置，选择工具后搜索预设方案快速配置。' },
};

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
}

function populateAboutPanel() {
  const info = state.appUpdate || {};
  const appVersion = info.currentVersion || '1.0.0';
  el('aboutAppVersion').textContent = appVersion;
  // INFO section: show client version
  el('aboutCodexVersion').textContent = appVersion;
  if (info.available) {
    el('aboutUpdaterStatus').textContent = `可更新到 v${info.version || '-'}`;
  } else if (info.enabled) {
    el('aboutUpdaterStatus').textContent = '已是最新';
  } else {
    el('aboutUpdaterStatus').textContent = '';
  }
  // Keep hidden elements populated for debug
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
  refreshConfigNumberFields();
  syncShortcutActiveState();
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
}

/** Populate the OpenClaw config editor form from state.openclawState. */
function populateOpenClawConfigEditor() {
  const cfg = state.openclawState?.config || {};
  const quick = deriveOpenClawQuickConfig(state.openclawState || {});

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
  if (el('ocCfgTgBlockStreaming')) el('ocCfgTgBlockStreaming').checked = Boolean(tg.blockStreaming);
  if (el('ocCfgTgLinkPreview')) el('ocCfgTgLinkPreview').checked = tg.linkPreview !== false;

  // ── Channels — Discord ──
  const dc = cfg.channels?.discord || {};
  el('ocCfgDiscordToken').value = dc.token || '';
  if (el('ocCfgDcDmPolicy')) el('ocCfgDcDmPolicy').value = dc.dm?.policy || '';
  if (el('ocCfgDcGroupPolicy')) el('ocCfgDcGroupPolicy').value = dc.groupPolicy || '';
  if (el('ocCfgDcAllowFrom')) el('ocCfgDcAllowFrom').value = (dc.dm?.allowFrom || []).join(', ');
  if (el('ocCfgDcStreaming')) el('ocCfgDcStreaming').value = dc.streaming || '';
  if (el('ocCfgDcTextChunkLimit')) el('ocCfgDcTextChunkLimit').value = dc.textChunkLimit || '';
  if (el('ocCfgDcAllowBots')) el('ocCfgDcAllowBots').checked = Boolean(dc.allowBots);
  if (el('ocCfgDcVoiceEnabled')) el('ocCfgDcVoiceEnabled').checked = dc.voice?.enabled !== false;

  // ── Channels — Slack ──
  el('ocCfgSlackBotToken').value = cfg.channels?.slack?.botToken || '';
  el('ocCfgSlackAppToken').value = cfg.channels?.slack?.appToken || '';

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
  el('ocCfgGatewayBind').value = cfg.gateway?.bind || 'loopback';
  el('ocCfgGatewayAuthMode').value = cfg.gateway?.auth?.mode || 'token';
  el('ocCfgGatewayToken').value = cfg.gateway?.auth?.token || '';
  if (el('ocCfgGatewayReload')) el('ocCfgGatewayReload').value = cfg.gateway?.reload || '';
  if (el('ocCfgGatewayHealthCheck')) el('ocCfgGatewayHealthCheck').value = cfg.gateway?.channelHealthCheckMinutes || '';
  if (el('ocCfgGatewayHttpChatCompletions')) el('ocCfgGatewayHttpChatCompletions').checked = Boolean(cfg.gateway?.http?.endpoints?.chatCompletions);
  if (el('ocCfgGatewayHttpResponses')) el('ocCfgGatewayHttpResponses').checked = Boolean(cfg.gateway?.http?.endpoints?.responses);

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
  // Model
  const model = cfg.agents?.defaults?.model?.primary;
  _b('ocBadgeModel', model ? model.split('/').pop() : '未配置', Boolean(model));
  // Provider
  const hasProvider = Object.keys(cfg.models?.providers || {}).length > 0;
  _b('ocBadgeProvider', hasProvider ? '已配置' : '未配置', hasProvider);
  // Channels
  const chans = [];
  if (cfg.channels?.telegram?.botToken) chans.push('TG');
  if (cfg.channels?.discord?.token) chans.push('DC');
  if (cfg.channels?.slack?.botToken) chans.push('Slack');
  _b('ocBadgeChannels', chans.length ? `${chans.join(' + ')}` : '未启用', chans.length > 0);
  _b('ocBadgeTelegram', cfg.channels?.telegram?.botToken ? '已配置' : '未配置', Boolean(cfg.channels?.telegram?.botToken));
  _b('ocBadgeDiscord', cfg.channels?.discord?.token ? '已配置' : '未配置', Boolean(cfg.channels?.discord?.token));
  _b('ocBadgeSlack', cfg.channels?.slack?.botToken ? '已配置' : '未配置', Boolean(cfg.channels?.slack?.botToken));
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
}

// ════════════════════════════════════════════════════════════════
// Config Recipes — preset configurations for quick setup
// ════════════════════════════════════════════════════════════════

const CODEX_CONFIG_RECIPES = [
  // ── Model Presets ──
  {
    id: 'cx-model-o3', name: '使用 o3 模型', cat: '模型', desc: '切换默认模型为 o3', kw: 'o3 model 模型 openai', tool: 'codex',
    apply: () => ({ model: 'o3' })
  },
  {
    id: 'cx-model-o4-mini', name: '使用 o4-mini 模型', cat: '模型', desc: '切换到更快速的 o4-mini 模型', kw: 'o4-mini model 模型 openai fast 快速', tool: 'codex',
    apply: () => ({ model: 'o4-mini' })
  },
  {
    id: 'cx-model-custom', name: '自定义模型', cat: '模型', desc: '设置自定义模型名称', kw: 'model 模型 自定义 custom', tool: 'codex',
    fields: [{ key: 'model', label: '模型名称', placeholder: '如: gpt-5.1, deepseek-r3' }],
    apply: (v) => ({ model: v.model })
  },
  // ── Reasoning ──
  {
    id: 'cx-reasoning-high', name: '高推理模式', cat: '推理', desc: '将推理强度设为 high，适合复杂任务', kw: '推理 reasoning high 高 复杂', tool: 'codex',
    apply: () => ({ model_reasoning_effort: 'high', plan_mode_reasoning_effort: 'high' })
  },
  {
    id: 'cx-reasoning-minimal', name: '快速推理模式', cat: '推理', desc: '最小推理适合简单任务，响应更快', kw: '推理 reasoning minimal 快速 最小 fast', tool: 'codex',
    apply: () => ({ model_reasoning_effort: 'minimal', plan_mode_reasoning_effort: 'minimal' })
  },
  {
    id: 'cx-reasoning-xhigh', name: '极致推理模式', cat: '推理', desc: '最高推理强度，适合最复杂的编程任务', kw: '推理 reasoning xhigh 极致 最高 最强', tool: 'codex',
    apply: () => ({ model_reasoning_effort: 'xhigh', plan_mode_reasoning_effort: 'xhigh' })
  },
  // ── Context Window ──
  {
    id: 'cx-ctx-1m', name: '1M Token 上下文', cat: '上下文', desc: '将上下文窗口扩展到 1048576 tokens', kw: '上下文 context window 1m token 大 扩展', tool: 'codex',
    apply: () => ({ model_context_window: 1048576, model_auto_compact_token_limit: Math.round(1048576 * 0.9) })
  },
  {
    id: 'cx-ctx-512k', name: '512K Token 上下文', cat: '上下文', desc: '中等大小的上下文窗口', kw: '上下文 context window 512k token', tool: 'codex',
    apply: () => ({ model_context_window: 512000, model_auto_compact_token_limit: Math.round(512000 * 0.9) })
  },
  {
    id: 'cx-ctx-default', name: '默认上下文', cat: '上下文', desc: '恢复默认 272K 上下文窗口', kw: '上下文 context window 默认 default', tool: 'codex',
    apply: () => ({ model_context_window: 272000, model_auto_compact_token_limit: Math.round(272000 * 0.9) })
  },
  // ── Sandbox / Approval ──
  {
    id: 'cx-sandbox-full', name: '完全访问模式', cat: '安全', desc: '关闭沙箱限制，允许完全文件系统访问', kw: '沙箱 sandbox full access 完全 访问 danger', tool: 'codex',
    apply: () => ({ sandbox_mode: 'danger-full-access', approval_policy: 'on-failure' })
  },
  {
    id: 'cx-sandbox-safe', name: '安全模式', cat: '安全', desc: '只读沙箱 + suggest 审批策略', kw: '安全 sandbox safe 只读 readonly suggest', tool: 'codex',
    apply: () => ({ sandbox_mode: 'read-only', approval_policy: 'suggest' })
  },
  {
    id: 'cx-workspace-write', name: '工作区写入模式', cat: '安全', desc: '允许向工作区写入文件', kw: '工作区 workspace write 写入', tool: 'codex',
    apply: () => ({ sandbox_mode: 'workspace-write' })
  },
  // ── Service ──
  {
    id: 'cx-service-fast', name: '快速服务层', cat: '服务', desc: '使用 Fast 服务层优先响应速度', kw: '服务 service fast 快速', tool: 'codex',
    apply: () => ({ service_tier: 'fast' })
  },
  {
    id: 'cx-service-flex', name: 'Flex 服务层', cat: '服务', desc: '使用 Flex 服务层平衡性价比', kw: '服务 service flex 灵活 便宜', tool: 'codex',
    apply: () => ({ service_tier: 'flex' })
  },
  // ── Personality ──
  {
    id: 'cx-persona-friendly', name: '友好助手风格', cat: '个性', desc: '设置为友好风格', kw: '个性 personality friendly 友好', tool: 'codex',
    apply: () => ({ personality: 'friendly' })
  },
  {
    id: 'cx-persona-pragmatic', name: '务实风格', cat: '个性', desc: '设置为务实风格，简洁高效', kw: '个性 personality pragmatic 务实 简洁', tool: 'codex',
    apply: () => ({ personality: 'pragmatic' })
  },
  // ── Workflow ──
  {
    id: 'cx-max-perf', name: '最大性能模式', cat: '工作流', desc: 'high 推理 + 1M Token + Fast 服务', kw: '最大 max performance 性能 高性能', tool: 'codex',
    apply: () => ({ model_reasoning_effort: 'high', plan_mode_reasoning_effort: 'high', model_context_window: 1048576, model_auto_compact_token_limit: Math.round(1048576 * 0.9), service_tier: 'fast' })
  },
  {
    id: 'cx-minimal', name: '极简模式', cat: '工作流', desc: '最小推理 + 默认上下文 + 紧凑提示', kw: '极简 minimal 精简 快速', tool: 'codex',
    apply: () => ({ model_reasoning_effort: 'minimal', plan_mode_reasoning_effort: 'minimal', compact_prompt: true })
  },
  {
    id: 'cx-debug-mode', name: '调试模式', cat: '工作流', desc: '显示原始推理过程，方便调试', kw: '调试 debug 推理 原始 reasoning raw', tool: 'codex',
    apply: () => ({ show_raw_agent_reasoning: true, hide_agent_reasoning: false })
  },
  {
    id: 'cx-reset-defaults', name: '恢复默认', cat: '工作流', desc: '将所有设置重置为 Codex 默认值', kw: '默认 reset 恢复 重置 default', tool: 'codex',
    apply: () => ({ model_reasoning_effort: null, plan_mode_reasoning_effort: null, model_context_window: null, model_auto_compact_token_limit: null, service_tier: null, sandbox_mode: null, approval_policy: null, personality: null, compact_prompt: false })
  },
];

const OC_CONFIG_RECIPES = [
  // ── Channels ──
  {
    id: 'tg-basic', name: '接入 Telegram Bot', cat: '渠道', desc: '配置 Telegram Bot Token，开启私聊 + 群组', kw: 'telegram tg bot 电报 机器人 聊天 channel 渠道 接入',
    fields: [{ key: 'token', label: 'Bot Token', placeholder: '123456:ABCDEF...', type: 'password' }],
    apply: (v) => ({ channels: { telegram: { botToken: v.token, dmPolicy: 'open', groupPolicy: 'open' } } }),
    panel: 'ocCfgTelegramToken'
  },
  {
    id: 'tg-private', name: 'Telegram 仅私聊', cat: '渠道', desc: '仅允许私聊，关闭群组响应', kw: 'telegram tg 私聊 private dm 电报 channel 渠道',
    fields: [{ key: 'token', label: 'Bot Token', placeholder: '123456:ABCDEF...', type: 'password' }],
    apply: (v) => ({ channels: { telegram: { botToken: v.token, dmPolicy: 'open', groupPolicy: 'disabled' } } }),
    panel: 'ocCfgTelegramToken'
  },
  {
    id: 'tg-whitelist', name: 'Telegram 白名单', cat: '渠道', desc: '仅允许指定用户 ID 发消息', kw: 'telegram tg 白名单 allowlist whitelist 电报 安全 channel 渠道',
    fields: [{ key: 'token', label: 'Bot Token', placeholder: '123456:ABCDEF...', type: 'password' }, { key: 'users', label: '允许的用户 ID（逗号分隔）', placeholder: '12345, 67890' }],
    apply: (v) => ({ channels: { telegram: { botToken: v.token, dmPolicy: 'allowlist', allowFrom: v.users.split(',').map(s => s.trim()).filter(Boolean) } } }),
    panel: 'ocCfgTelegramToken'
  },
  {
    id: 'dc-basic', name: '接入 Discord Bot', cat: '渠道', desc: '配置 Discord Bot Token 接入服务器', kw: 'discord dc bot 机器人 聊天 channel 渠道 接入 服务器',
    fields: [{ key: 'token', label: 'Bot Token', placeholder: 'Discord Bot Token', type: 'password' }],
    apply: (v) => ({ channels: { discord: { token: v.token } } }),
    panel: 'ocCfgDiscordToken'
  },
  {
    id: 'slack-basic', name: '接入 Slack Bot', cat: '渠道', desc: '配置 Slack Bot + App Token 接入工作空间', kw: 'slack 工作空间 workspace bot channel 渠道 接入 企业',
    fields: [{ key: 'bot', label: 'Bot Token', placeholder: 'xoxb-...', type: 'password' }, { key: 'app', label: 'App Token', placeholder: 'xapp-...', type: 'password' }],
    apply: (v) => ({ channels: { slack: { botToken: v.bot, appToken: v.app } } }),
    panel: 'ocCfgSlackBotToken'
  },
  {
    id: 'wechat-mp', name: '接入微信公众号', cat: '渠道', desc: '配置微信公众号 AppID 和 Token 接入', kw: '微信 wechat 公众号 mp 聊天 channel 渠道 接入 weixin',
    fields: [{ key: 'appId', label: 'AppID', placeholder: 'wx...' }, { key: 'token', label: '验证 Token', placeholder: '公众号后台设置的 Token' }, { key: 'aesKey', label: 'EncodingAESKey', placeholder: '消息加解密密钥', optional: true }],
    apply: (v) => ({ channels: { wechat: { appId: v.appId, token: v.token, encodingAESKey: v.aesKey || undefined } } })
  },
  {
    id: 'wechat-work', name: '接入企业微信', cat: '渠道', desc: '配置企业微信应用接入', kw: '企业微信 wechat work wecom 公司 channel 渠道 接入 weixin',
    fields: [{ key: 'corpId', label: 'CorpID', placeholder: '企业 ID' }, { key: 'agentId', label: 'AgentID', placeholder: '应用 ID' }, { key: 'secret', label: 'Secret', placeholder: '应用密钥', type: 'password' }],
    apply: (v) => ({ channels: { wechatWork: { corpId: v.corpId, agentId: Number(v.agentId), secret: v.secret } } })
  },
  {
    id: 'line-basic', name: '接入 LINE Bot', cat: '渠道', desc: '配置 LINE Messaging API 接入', kw: 'line bot 聊天 channel 渠道 接入 日本 messaging',
    fields: [{ key: 'secret', label: 'Channel Secret', placeholder: 'Channel Secret', type: 'password' }, { key: 'token', label: 'Access Token', placeholder: 'Long-lived access token', type: 'password' }],
    apply: (v) => ({ channels: { line: { channelSecret: v.secret, accessToken: v.token } } })
  },
  {
    id: 'whatsapp-basic', name: '接入 WhatsApp', cat: '渠道', desc: '通过 WhatsApp Business API 接入', kw: 'whatsapp wa 聊天 channel 渠道 接入 facebook meta business',
    fields: [{ key: 'token', label: 'Access Token', placeholder: 'WhatsApp Business API Token', type: 'password' }, { key: 'phoneId', label: 'Phone Number ID', placeholder: '电话号码 ID' }],
    apply: (v) => ({ channels: { whatsapp: { accessToken: v.token, phoneNumberId: v.phoneId } } })
  },
  {
    id: 'matrix-basic', name: '接入 Matrix', cat: '渠道', desc: '连接 Matrix/Element 聊天网络', kw: 'matrix element 聊天 channel 渠道 接入 开源 federated',
    fields: [{ key: 'homeserver', label: 'Homeserver URL', placeholder: 'https://matrix.org' }, { key: 'token', label: 'Access Token', placeholder: 'syt_...', type: 'password' }],
    apply: (v) => ({ channels: { matrix: { homeserver: v.homeserver, accessToken: v.token } } })
  },
  {
    id: 'webhook-channel', name: '自定义 Webhook 渠道', cat: '渠道', desc: '通过 HTTP Webhook 接收消息', kw: 'webhook http 自定义 custom channel 渠道 接入 api 回调',
    fields: [{ key: 'path', label: 'Webhook 路径', placeholder: '/webhook/my-channel' }],
    apply: (v) => ({ channels: { webhook: { enabled: true, path: v.path || '/webhook' } } })
  },
  // ── Provider ──
  {
    id: 'openai-proxy', name: 'OpenAI 代理 / 中转', cat: 'Provider', desc: '设置 OpenAI 兼容 API 代理地址', kw: 'openai proxy 代理 中转 api url base 转发 one-api 模型 provider',
    fields: [{ key: 'url', label: '代理 Base URL', placeholder: 'https://your-proxy.com/v1' }, { key: 'key', label: 'API Key', placeholder: 'sk-...', type: 'password' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { openai: { baseUrl: v.url, api: 'openai-completions', apiKey: `$OPENAI_API_KEY` } } }, env: { OPENAI_API_KEY: v.key } }),
    panel: 'ocCfgProviderBaseUrl'
  },
  {
    id: 'claude-direct', name: 'Claude / Anthropic 直连', cat: 'Provider', desc: '直接使用 Anthropic API', kw: 'claude anthropic 直连 api 模型 provider sonnet opus haiku',
    fields: [{ key: 'key', label: 'Anthropic API Key', placeholder: 'sk-ant-...', type: 'password' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { anthropic: { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', apiKey: '$ANTHROPIC_API_KEY' } } }, env: { ANTHROPIC_API_KEY: v.key } }),
    panel: 'ocCfgProviderApiKey'
  },
  {
    id: 'gemini-direct', name: 'Google Gemini 直连', cat: 'Provider', desc: '使用 Google AI Studio / Gemini API', kw: 'gemini google ai studio 谷歌 模型 provider',
    fields: [{ key: 'key', label: 'Gemini API Key', placeholder: 'AIza...', type: 'password' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { google: { baseUrl: 'https://generativelanguage.googleapis.com', api: 'google-gemini', apiKey: '$GOOGLE_API_KEY' } } }, env: { GOOGLE_API_KEY: v.key } })
  },
  {
    id: 'deepseek-direct', name: 'DeepSeek 直连', cat: 'Provider', desc: '使用 DeepSeek API（V3/R1）', kw: 'deepseek 深度求索 模型 provider v3 r1 coder chat',
    fields: [{ key: 'key', label: 'DeepSeek API Key', placeholder: 'sk-...', type: 'password' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { deepseek: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKey: '$DEEPSEEK_API_KEY' } } }, env: { DEEPSEEK_API_KEY: v.key } })
  },
  {
    id: 'ollama-local', name: 'Ollama 本地模型', cat: 'Provider', desc: '连接本地 Ollama 服务运行开源模型', kw: 'ollama 本地 local 开源 llama qwen mistral 模型 provider 免费',
    fields: [{ key: 'url', label: 'Ollama URL', placeholder: 'http://localhost:11434' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { ollama: { baseUrl: v.url || 'http://localhost:11434', api: 'openai-completions' } } } })
  },
  {
    id: 'azure-openai', name: 'Azure OpenAI', cat: 'Provider', desc: '通过 Azure 部署的 OpenAI 模型', kw: 'azure openai 微软 microsoft 云 模型 provider 企业',
    fields: [{ key: 'url', label: 'Azure Endpoint', placeholder: 'https://xxx.openai.azure.com' }, { key: 'key', label: 'API Key', placeholder: 'Azure API Key', type: 'password' }, { key: 'deploy', label: '部署名称', placeholder: 'gpt-4o' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { azure: { baseUrl: v.url, api: 'openai-completions', apiKey: '$AZURE_API_KEY', deployment: v.deploy } } }, env: { AZURE_API_KEY: v.key } })
  },
  {
    id: 'groq-direct', name: 'Groq 极速推理', cat: 'Provider', desc: '使用 Groq LPU 获得超快推理速度', kw: 'groq 极速 fast 快 推理 模型 provider lpu',
    fields: [{ key: 'key', label: 'Groq API Key', placeholder: 'gsk_...', type: 'password' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { groq: { baseUrl: 'https://api.groq.com/openai', api: 'openai-completions', apiKey: '$GROQ_API_KEY' } } }, env: { GROQ_API_KEY: v.key } })
  },
  // ── Agent ──
  {
    id: 'agent-fast', name: '快速响应模式', cat: 'Agent', desc: '最小推理 + 即时响应，适合简单问答', kw: '快速 fast 速度 minimal 推理 响应 agent 回复',
    apply: () => ({ agents: { defaults: { thinkingDefault: 'minimal', humanDelay: 'off', typingMode: 'never' } } })
  },
  {
    id: 'agent-deep', name: '深度思考模式', cat: 'Agent', desc: '高推理强度 + 详细输出', kw: '深度 deep thinking 推理 high 思考 agent 详细',
    apply: () => ({ agents: { defaults: { thinkingDefault: 'high', verboseDefault: 'on' } } })
  },
  {
    id: 'agent-concurrent', name: '多并发处理', cat: 'Agent', desc: '允许同时处理多个请求', kw: '并发 concurrent 多任务 parallel agent 同时',
    fields: [{ key: 'n', label: '最大并发数', placeholder: '3' }],
    apply: (v) => ({ agents: { defaults: { maxConcurrent: Number(v.n) || 3 } } })
  },
  {
    id: 'heartbeat', name: '开启心跳回复', cat: 'Agent', desc: '定期自动发送心跳消息', kw: '心跳 heartbeat 自动 定期 auto agent 定时',
    fields: [{ key: 'every', label: '心跳间隔', placeholder: '30m' }],
    apply: (v) => ({ agents: { defaults: { heartbeat: { every: v.every || '30m', target: 'last' } } } })
  },
  {
    id: 'system-prompt', name: '自定义系统提示词', cat: 'Agent', desc: '设置 AI 的角色和行为指令', kw: '系统 system prompt 提示词 角色 人设 指令 agent persona',
    fields: [{ key: 'prompt', label: '系统提示词', placeholder: '你是一个有帮助的助手...' }],
    apply: (v) => ({ agents: { defaults: { systemPrompt: v.prompt } } })
  },
  {
    id: 'max-tokens', name: '控制回复长度', cat: 'Agent', desc: '限制每次回复的最大 Token 数', kw: '长度 token 限制 max 回复 输出 agent 字数',
    fields: [{ key: 'n', label: '最大 Token 数', placeholder: '4096' }],
    apply: (v) => ({ agents: { defaults: { maxTokens: Number(v.n) || 4096 } } })
  },
  // ── Security ──
  {
    id: 'security-lock', name: '安全锁定模式', cat: '安全', desc: '禁用所有危险命令和提权', kw: '安全 security lock 锁定 禁用 命令 限制',
    apply: () => ({ commands: { bash: false, config: false }, tools: { elevated: { enabled: false }, exec: { security: 'deny' } } })
  },
  {
    id: 'security-open', name: '开发者完全开放', cat: '安全', desc: '允许所有命令和工具（仅限可信环境）', kw: '开放 open 开发 developer 全部 命令 bash 完全',
    apply: () => ({ commands: { bash: true, config: true, text: true }, tools: { elevated: { enabled: true }, exec: { security: 'full', host: 'gateway' } } })
  },
  {
    id: 'approvals', name: '启用审批转发', cat: '安全', desc: '将执行审批请求转发到聊天渠道', kw: '审批 approval 转发 确认 安全',
    apply: () => ({ approvals: { enabled: true } })
  },
  // ── Tools ──
  {
    id: 'tools-minimal', name: '最小工具集', cat: '工具', desc: '仅保留最基础的工具', kw: '工具 tools minimal 最小 精简 基础',
    apply: () => ({ tools: { profile: 'minimal' } })
  },
  {
    id: 'tools-coding', name: '编程工具集', cat: '工具', desc: '适合编程场景的工具配置', kw: '工具 tools coding 编程 开发 代码 程序',
    apply: () => ({ tools: { profile: 'coding' } })
  },
  {
    id: 'web-search', name: '启用 Web 搜索', cat: '工具', desc: '配置搜索引擎让 AI 能联网搜索', kw: '搜索 search web 联网 brave perplexity 工具 google 谷歌',
    fields: [{ key: 'provider', label: '搜索引擎', placeholder: 'brave / perplexity / grok' }, { key: 'key', label: 'API Key', placeholder: '搜索引擎 API Key', type: 'password' }],
    apply: (v) => ({ tools: { web: { search: { provider: v.provider, apiKey: v.key } } } })
  },
  // ── Session ──
  {
    id: 'session-global', name: '全局共享会话', cat: '会话', desc: '所有用户共享同一上下文', kw: '会话 session global 全局 共享 上下文',
    apply: () => ({ session: { scope: 'global' } })
  },
  {
    id: 'session-daily-reset', name: '每日自动重置', cat: '会话', desc: '每天自动清空会话历史', kw: '重置 reset daily 每日 清空 会话 自动',
    apply: () => ({ session: { reset: 'daily' } })
  },
  {
    id: 'session-per-user', name: '多用户会话隔离', cat: '会话', desc: '每个用户独立会话上下文', kw: '用户 user 隔离 独立 会话 session 多人 multi',
    apply: () => ({ session: { scope: 'user' } })
  },
  {
    id: 'auto-summary', name: '自动摘要压缩', cat: '会话', desc: '会话过长时自动生成摘要保留上下文', kw: '摘要 summary 压缩 自动 上下文 记忆 会话',
    apply: () => ({ session: { autoSummary: true } })
  },
  // ── Gateway ──
  {
    id: 'gw-lan', name: '局域网访问', cat: '网络', desc: '允许局域网内设备访问 Gateway', kw: '局域网 lan 网络 gateway 访问 绑定 内网',
    apply: () => ({ gateway: { bind: 'lan', auth: { mode: 'token' } } })
  },
  {
    id: 'gw-noauth', name: '关闭 Gateway 认证', cat: '网络', desc: '移除认证（仅限本地使用）', kw: '认证 auth none 关闭 gateway 无密码 网络',
    apply: () => ({ gateway: { auth: { mode: 'none' } } })
  },
  {
    id: 'gw-https', name: '启用 HTTPS', cat: '网络', desc: '配置 SSL 证书启用加密访问', kw: 'https ssl tls 证书 加密 安全 网络 gateway',
    fields: [{ key: 'cert', label: '证书路径', placeholder: '/path/to/cert.pem' }, { key: 'key', label: '私钥路径', placeholder: '/path/to/key.pem' }],
    apply: (v) => ({ gateway: { tls: { cert: v.cert, key: v.key } } })
  },
  {
    id: 'gw-reverse-proxy', name: '反向代理模式', cat: '网络', desc: '配置为反向代理后端（信任 X-Forwarded-For）', kw: '反向代理 reverse proxy nginx caddy 网络 gateway 部署',
    apply: () => ({ gateway: { trustProxy: true, bind: '0.0.0.0' } })
  },
  // ── Cron ──
  {
    id: 'cron-enable', name: '启用定时任务', cat: '定时', desc: '开启 Cron 定时任务功能', kw: '定时 cron 任务 计划 schedule 自动',
    apply: () => ({ cron: { enabled: true } })
  },
  {
    id: 'hooks-enable', name: '启用 Webhooks', cat: '钩子', desc: '开启 Webhook 接收功能', kw: 'webhook hook 钩子 回调 触发',
    apply: () => ({ hooks: { enabled: true } })
  },
  {
    id: 'hooks-secret', name: 'Webhook 签名验证', cat: '钩子', desc: '设置 Webhook Secret 验证请求签名', kw: 'webhook secret 签名 验证 安全 钩子',
    fields: [{ key: 'secret', label: 'Webhook Secret', placeholder: '自定义签名密钥', type: 'password' }],
    apply: (v) => ({ hooks: { enabled: true, secret: v.secret } })
  },
  // ── Logging ──
  {
    id: 'log-debug', name: '调试日志模式', cat: '日志', desc: '切换到 debug 级别查看详细日志', kw: '日志 log debug 调试 详细 排错',
    apply: () => ({ logging: { level: 'debug', consoleStyle: 'pretty' } })
  },
  {
    id: 'log-silent', name: '静默日志', cat: '日志', desc: '关闭所有日志输出', kw: '静默 silent 关闭 日志 log quiet 生产',
    apply: () => ({ logging: { level: 'silent' } })
  },
  {
    id: 'log-file', name: '日志输出到文件', cat: '日志', desc: '将日志写入文件方便排查问题', kw: '日志 log file 文件 输出 记录 保存',
    fields: [{ key: 'path', label: '日志文件路径', placeholder: './logs/openclaw.log' }],
    apply: (v) => ({ logging: { level: 'info', file: v.path || './logs/openclaw.log' } })
  },
  // ── Identity ──
  {
    id: 'identity-custom', name: '自定义助手身份', cat: '身份', desc: '设置助手名称和头像', kw: '身份 identity 名称 头像 avatar 名字 人设 助手',
    fields: [{ key: 'name', label: '助手名称', placeholder: '小助手' }, { key: 'avatar', label: '头像 URL（可选）', placeholder: 'https://...', optional: true }],
    apply: (v) => ({ identity: { name: v.name, avatar: v.avatar || undefined } })
  },
];

/**
 * Get the combined recipe list based on the active config editor tool.
 */
function getActiveRecipes() {
  const tool = getConfigEditorTool();
  if (tool === 'openclaw') return OC_CONFIG_RECIPES;
  return CODEX_CONFIG_RECIPES;
}

/**
 * Search config recipes by keyword query.
 * Uses fuzzy matching: splits query into tokens and matches against kw + name + desc.
 */
function searchOcRecipes(query) {
  const recipes = getActiveRecipes();
  if (!query || !query.trim()) return recipes;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return recipes.filter(r => {
    const haystack = `${r.name} ${r.desc} ${r.kw} ${r.cat}`.toLowerCase();
    return tokens.every(t => haystack.includes(t));
  });
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
        <div class="oc-recipe-card-desc">${r.desc}</div>
      </div>
      <span class="oc-recipe-card-action">${r.fields ? '配置' : '应用'}</span>
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
  const modal = el('ocRecipeFormModal');
  const body = el('ocRecipeFormBody');
  const title = el('ocRecipeFormTitle');
  if (!modal || !body || !title) return;
  title.textContent = recipe.name;
  body.innerHTML = recipe.fields.map((f, i) => `
    <label class="field"><span>${f.label}</span>
      <input id="ocRecipeField_${i}" type="${f.type || 'text'}" placeholder="${f.placeholder || ''}" />
    </label>
  `).join('');
  modal.classList.remove('hide');
  modal._recipe = recipe;
  // Focus first field
  setTimeout(() => el('ocRecipeField_0')?.focus(), 100);
}

/** Close the recipe form modal. */
function closeOcRecipeForm() {
  const modal = el('ocRecipeFormModal');
  if (modal) { modal.classList.add('hide'); modal._recipe = null; }
}

/** Collect recipe form values and apply. */
function submitOcRecipeForm() {
  const modal = el('ocRecipeFormModal');
  const recipe = modal?._recipe;
  if (!recipe) return;
  const values = {};
  recipe.fields.forEach((f, i) => {
    values[f.key] = (el(`ocRecipeField_${i}`)?.value || '').trim();
  });
  // Check required fields
  const missing = recipe.fields.filter((f, i) => !values[f.key] && !f.optional);
  if (missing.length) {
    flash(`请填写: ${missing.map(f => f.label).join(', ')}`, 'error');
    return;
  }
  const patch = recipe.apply(values);
  applyOcRecipePatch(patch);
  closeOcRecipeForm();
  // Close search results
  el('ocRecipeResults')?.classList.add('hide');
  el('ocRecipeSearchInput').value = '';
  // Close config store modal if open
  closeConfigStore();
}

/* ═══════ Config Store Modal ═══════ */

let _configStoreActiveCat = 'all';

/** Get recipes for config store based on active config editor tool tab. */
function getConfigStoreRecipes() {
  const tool = getConfigEditorTool();
  if (tool === 'openclaw') return OC_CONFIG_RECIPES;
  return CODEX_CONFIG_RECIPES;
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

  _configStoreActiveCat = 'all';
  renderConfigStoreCategories();
  renderConfigStoreCards();

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
  if (query.trim()) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    recipes = recipes.filter(r => {
      const haystack = `${r.name} ${r.desc} ${r.kw} ${r.cat}`.toLowerCase();
      return tokens.every(t => haystack.includes(t));
    });
  }

  if (recipes.length === 0) {
    grid.innerHTML = '';
    if (empty) empty.classList.remove('hide');
    return;
  }

  if (empty) empty.classList.add('hide');

  grid.innerHTML = recipes.map(r => `
    <button type="button" class="cs-card" data-store-recipe-id="${r.id}">
      <span class="cs-card-tag" data-cat="${escapeHtml(r.cat)}">${escapeHtml(r.cat)}</span>
      <div class="cs-card-name">${escapeHtml(r.name)}</div>
      <div class="cs-card-desc">${escapeHtml(r.desc)}</div>
      <span class="cs-card-action">${r.fields ? '配置 →' : '应用 ✓'}</span>
    </button>
  `).join('');
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

  const slackBot = el('ocCfgSlackBotToken').value.trim();
  const slackApp = el('ocCfgSlackAppToken').value.trim();
  if (slackBot || slackApp) {
    if (!base.channels) base.channels = {};
    if (!base.channels.slack) base.channels.slack = {};
    if (slackBot) base.channels.slack.botToken = slackBot;
    if (slackApp) base.channels.slack.appToken = slackApp;
  }

  // Channel defaults
  const chanDefGp = _sv('ocCfgChannelDefaultGroupPolicy');
  if (chanDefGp) {
    if (!base.channels) base.channels = {};
    if (!base.channels.defaults) base.channels.defaults = {};
    base.channels.defaults.groupPolicy = chanDefGp;
  } else if (base.channels?.defaults) { delete base.channels.defaults.groupPolicy; if (Object.keys(base.channels.defaults).length === 0) delete base.channels.defaults; }

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
  const gwBind = el('ocCfgGatewayBind').value;
  const gwAuthMode = el('ocCfgGatewayAuthMode').value;
  const gwToken = el('ocCfgGatewayToken').value.trim();
  const gwReload = _sv('ocCfgGatewayReload');
  const gwHealth = _sv('ocCfgGatewayHealthCheck');
  if (gwPort || gwBind || gwAuthMode || gwToken || gwReload || gwHealth) {
    if (!base.gateway) base.gateway = {};
    if (gwPort) base.gateway.port = Number(gwPort) || 18789; else delete base.gateway.port;
    if (gwBind) base.gateway.bind = gwBind; else delete base.gateway.bind;
    if (gwReload) base.gateway.reload = gwReload; else delete base.gateway.reload;
    if (gwHealth) base.gateway.channelHealthCheckMinutes = Number(gwHealth); else delete base.gateway.channelHealthCheckMinutes;
    if (gwAuthMode || gwToken) {
      if (!base.gateway.auth) base.gateway.auth = {};
      if (gwAuthMode) base.gateway.auth.mode = gwAuthMode; else delete base.gateway.auth.mode;
      if (gwToken) base.gateway.auth.token = gwToken; else delete base.gateway.auth.token;
      if (Object.keys(base.gateway.auth).length === 0) delete base.gateway.auth;
    }
    if (Object.keys(base.gateway).length === 0) delete base.gateway;
  }
  // Gateway HTTP endpoints
  const httpChat = el('ocCfgGatewayHttpChatCompletions')?.checked;
  const httpResp = el('ocCfgGatewayHttpResponses')?.checked;
  if (httpChat || httpResp) {
    if (!base.gateway) base.gateway = {};
    if (!base.gateway.http) base.gateway.http = {};
    if (!base.gateway.http.endpoints) base.gateway.http.endpoints = {};
    if (httpChat) base.gateway.http.endpoints.chatCompletions = true; else delete base.gateway.http.endpoints.chatCompletions;
    if (httpResp) base.gateway.http.endpoints.responses = true; else delete base.gateway.http.endpoints.responses;
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
    const configJson = rawEdited ? rawEl.value : JSON.stringify(buildOpenClawConfigFromForm(), null, 2);
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
    const configJson = rawEdited ? rawEl.value : JSON.stringify(buildOpenClawConfigFromForm(), null, 2);
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

    const tips = el('configTipsList');
    if (tips) tips.innerHTML = [
      '支持 claude login 和 API Key 两种认证方式',
      '模型别名（sonnet / opus / haiku）可直接使用',
      '可通过 Base URL 配置代理或第三方 API',
    ].map((t, i) => `<div class="feature-row"><span>${i + 1}</span><strong>${t}</strong></div>`).join('');
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

    const tips = el('configTipsList');
    if (tips) tips.innerHTML = [
      '选择默认模型后保存，启动时无需再手动指定',
      `Token 默认写入 ${quick?.envKey || getOpenClawDefaultEnvKey(quick?.api || 'openai-completions')}，想改就在“配置编辑”里改`,
      '官方 OpenAI / Claude 直连时 Base URL 可留空，代理/中转再填 URL',
    ].map((t, i) => `<div class="feature-row"><span>${i + 1}</span><strong>${t}</strong></div>`).join('');
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

  const tips = el('configTipsList');
  if (tips) tips.innerHTML = [
    '检测模型后自动推荐最新可用模型',
    '保存后写入 Codex 配置并保留备份',
    '未安装 Codex 时，启动会弹窗引导自动安装',
  ].map((t, i) => `<div class="feature-row"><span>${i + 1}</span><strong>${t}</strong></div>`).join('');
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
    return;
  }
  fillFromProvider(state.current.activeProvider || state.current.providers?.[0]);
  renderCurrentConfig();

  // Auto-trigger provider health check so the card doesn't stay "待检测"
  refreshProviderHealth();

  // Sync shortcut active states based on loaded config
  syncShortcutActiveState();
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

async function handleAppUpdate() {
  const info = state.appUpdate || await loadAppUpdateState({ manual: true });
  if (!info) return;
  if (!info.enabled) return;
  if (!info.available) return;

  const confirmed = window.confirm(`当前版本：${info.currentVersion}\n最新版本：${info.version}\n\n确定下载并安装客户端更新吗？安装后会自动重启。`);
  if (!confirmed) return;

  setBusy('appUpdateBtn', true, '下载中...');
  const json = await api('/api/app/update', { method: 'POST', timeoutMs: 300000 });
  setBusy('appUpdateBtn', false);
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
      const allRecipes = [...CODEX_CONFIG_RECIPES, ...OC_CONFIG_RECIPES];
      const recipe = allRecipes.find(r => r.id === card.dataset.storeRecipeId);
      if (!recipe) return;
      if (recipe.fields) {
        openOcRecipeForm(recipe);
      } else {
        openRecipeConfirm(recipe);
      }
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
      const recipe = [...CODEX_CONFIG_RECIPES, ...OC_CONFIG_RECIPES].find(r => r.id === card.dataset.recipeId);
      if (!recipe) return;
      if (recipe.fields) {
        openOcRecipeForm(recipe);
      } else {
        const patch = recipe.apply();
        applyOcRecipePatch(patch);
        recipeResults.classList.add('hide');
        recipeInput.value = '';
      }
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
    // Start spinning animation
    btn.classList.add('checking');
    btn.querySelector('span').textContent = '检查中...';
    status.textContent = '';
    status.className = 'about-status';

    const result = await loadAppUpdateState({ manual: true });

    // Stop spinning
    btn.classList.remove('checking');
    btn.querySelector('span').textContent = '检查更新';

    if (!result) {
      status.textContent = '检测失败，请检查网络连接';
      status.className = 'about-status about-status-error';
    } else if (result.available) {
      status.textContent = `发现新版本 v${result.version}`;
      status.className = 'about-status about-status-update';
    } else {
      status.textContent = `已是最新版本`;
      status.className = 'about-status about-status-ok';
    }
    populateAboutPanel();
  });
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
