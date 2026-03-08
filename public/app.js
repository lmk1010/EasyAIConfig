const state = {
  current: null,
  backups: [],
  detected: null,
  metaDirty: false,
  flashTimer: null,
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
  appUpdate: null,
  updateDialogOpen: false,
  updateDialogTimer: null,
  updateDialogResolver: null,
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
};

const el = (id) => document.getElementById(id);
const tauriInvoke = window.__TAURI__?.core?.invoke || null;

/* ── Theme ── */
function initTheme() {
  const saved = localStorage.getItem('easyaiconfig_theme') || 'dark';
  state.theme = saved;
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const label = el('themeLabel');
  if (label) label.textContent = theme === 'dark' ? '黑夜模式' : '白天模式';
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
  const toolActions = {
    codex: {
      update: updateCodex,
      reinstall: reinstallCodex,
      uninstall: uninstallCodex,
    },
    claudecode: {
      update: updateClaudeCodeTool,
      reinstall: reinstallClaudeCodeTool,
      uninstall: uninstallClaudeCodeTool,
    },
  };

  const handler = toolActions[toolId]?.[action];
  if (handler) await handler(btn);
}

// Claude Code tool actions
async function updateClaudeCodeTool() {
  await runToolAction('claudecode', '/api/claudecode/update', '更新中...', 'Claude Code 已更新');
}
async function reinstallClaudeCodeTool(btn) {
  const confirmed = await openUpdateDialog({
    eyebrow: 'Claude Code',
    title: '重装 Claude Code',
    body: '<p>这会重新全局安装当前版本 Claude Code。</p>',
    confirmText: '确认重装',
    cancelText: '取消',
  });
  if (!confirmed) return;
  await runToolAction('claudecode', '/api/claudecode/reinstall', '重装中...', 'Claude Code 重装完成');
}
async function uninstallClaudeCodeTool(btn) {
  const confirmed = await openUpdateDialog({
    eyebrow: 'Claude Code',
    title: '卸载 Claude Code',
    body: '<p>卸载后将无法直接从工具里启动 Claude Code。</p>',
    confirmText: '确认卸载',
    cancelText: '取消',
    tone: 'danger',
  });
  if (!confirmed) return;
  await runToolAction('claudecode', '/api/claudecode/uninstall', '卸载中...', 'Claude Code 已卸载');
}

async function runToolAction(toolId, apiPath, busyText, successText) {
  try {
    const json = await api(apiPath, { method: 'POST' });
    if (!json.ok) {
      flash(json.error || '操作失败', 'error');
      return false;
    }
    if (successText) flash(successText, 'success');
    loadTools(); // Refresh tool cards
    return true;
  } catch (e) {
    flash(e.message || '操作失败', 'error');
    return false;
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
    const toolId = tab.dataset.tool;
    const tool = state.tools.find(t => t.id === toolId);
    if (tool) {
      tab.disabled = !tool.supported;
      tab.classList.toggle('active', toolId === state.activeTool);
    }
  });
}

function setActiveTool(toolId) {
  const tool = state.tools.find(t => t.id === toolId);
  if (!tool || !tool.supported) return;
  state.activeTool = toolId;
  updateToolSelector();

  // Update launch button
  const launchBtn = el('launchBtn');
  if (launchBtn) launchBtn.textContent = `启动 ${tool.name}`;

  // Update quick setup context
  const baseUrlField = el('baseUrlInput')?.closest('.field');
  const apiKeyInput = el('apiKeyInput');
  const detectBtn = el('detectBtn');
  const detectField = detectBtn?.closest('.field');
  const heroTitle = document.querySelector('.hero-title');
  const heroSubtitle = document.querySelector('.hero-subtitle');
  const sectionTitle = document.querySelector('.flow-section .section-title');
  const modelSelect = el('modelSelect');
  const shortcutsRow = document.querySelector('.quick-shortcuts');

  if (toolId === 'claudecode') {
    // Claude Code mode
    if (baseUrlField) baseUrlField.style.display = 'none';
    if (detectField) detectField.style.display = 'none';
    if (apiKeyInput) {
      apiKeyInput.placeholder = 'ANTHROPIC_API_KEY (可选，已登录则无需填写)';
      apiKeyInput.value = '';
    }
    if (heroTitle) heroTitle.textContent = 'Claude Code 配置';
    if (heroSubtitle) heroSubtitle.textContent = '配置模型与认证方式，支持 claude login 和 API Key。';
    if (sectionTitle) sectionTitle.textContent = 'Claude Code 设置';
    if (shortcutsRow) shortcutsRow.style.display = 'none';

    // Placeholder while loading
    if (modelSelect) {
      modelSelect.innerHTML = '<option value="">加载中...</option>';
    }

    // Load and prefill
    loadClaudeCodeQuickState();
  } else {
    // Codex mode: restore original UI
    if (baseUrlField) baseUrlField.style.display = '';
    if (detectField) detectField.style.display = '';
    if (apiKeyInput) apiKeyInput.placeholder = 'sk-...';
    if (heroTitle) heroTitle.textContent = '最快路径';
    if (heroSubtitle) heroSubtitle.textContent = '用户通常只需要 `URL` 和 `API Key`，这里一步完成。';
    if (sectionTitle) sectionTitle.textContent = '连接配置';
    if (shortcutsRow) shortcutsRow.style.display = '';

    // Restore model selector
    if (modelSelect) {
      modelSelect.innerHTML = '<option value="">先检测模型</option>';
    }
  }
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
          const displayName = modelName
            .replace('claude-', '')
            .replace(/-/g, ' ')
            .replace(/(\d)/g, ' $1')
            .trim();
          html += `<option value="${escapeHtml(modelName)}"${selected}>${escapeHtml(modelName)}</option>`;
        }
        html += '</optgroup>';
      }

      modelSelect.innerHTML = html;
      if (data.model) modelSelect.value = data.model;
    }

    // Show login status in hero subtitle
    const heroSubtitle = document.querySelector('.hero-subtitle');
    if (heroSubtitle && data.login) {
      const loginInfo = data.login;
      let statusText = '配置模型与认证方式。';
      if (loginInfo.loggedIn) {
        if (loginInfo.method === 'oauth') {
          statusText = `已登录：${loginInfo.email || ''}${loginInfo.orgName ? ` (${loginInfo.orgName})` : ''} · 配置模型与偏好。`;
        } else {
          statusText = '已通过 API Key 认证 · 配置模型与偏好。';
        }
      } else {
        statusText = '未登录 · 运行 claude login 或填入 API Key 认证。';
      }
      heroSubtitle.textContent = statusText;
    }

    // Show binary version
    const heroTitle = document.querySelector('.hero-title');
    if (heroTitle && data.binary?.version) {
      heroTitle.textContent = `Claude Code · ${data.binary.version}`;
    }

  } catch { /* silent */ }
}


const PAGE_META = {
  quick: { eyebrow: 'Quick Setup', title: '一键配置 Codex 工具', subtitle: '输入 URL 和 API Key，剩下交给 EasyAIConfig。' },
  providers: { eyebrow: 'Providers', title: 'Provider 与备份', subtitle: '集中查看已发现配置、检测状态与历史备份。' },
  tools: { eyebrow: 'Tools', title: '工具安装与管理', subtitle: '安装、更新、重装或卸载 AI 编程工具。' },
  about: { eyebrow: 'About', title: '关于 EasyAIConfig', subtitle: '查看桌面版本、更新源与当前运行信息。' },
  configEditor: { eyebrow: 'Current Config', title: '配置编辑', subtitle: '把常用 config.toml 配置转成高密度表单，右侧可看原始 TOML。' },
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
  if (tauriInvoke) {
    try {
      return await tauriInvoke('backend_request', parseApiRequest(url, options));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 20000;
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

function flash(message, type = 'info') {
  const node = el('flash');
  node.textContent = message;
  node.className = `flash ${type}`;
  clearTimeout(state.flashTimer);
  state.flashTimer = setTimeout(() => node.classList.add('hide'), 4000);
}

function closeUpdateDialog(result = false) {
  const panel = el('updateDialog');
  if (!panel) return;
  clearTimeout(state.updateDialogTimer);
  state.updateDialogOpen = false;
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

function openUpdateDialog({ eyebrow = 'Update', title, body = '', meta = '', confirmText = '继续', cancelText = '取消', tone = 'default', confirmOnly = false }) {
  const panel = el('updateDialog');
  if (!panel) return Promise.resolve(false);
  clearTimeout(state.updateDialogTimer);
  state.updateDialogOpen = true;
  el('updateDialogEyebrow').textContent = eyebrow;
  el('updateDialogTitle').textContent = title;
  el('updateDialogBody').innerHTML = body;
  el('updateDialogMeta').innerHTML = meta || '';
  el('updateDialogMeta').classList.toggle('hide', !meta);
  el('updateDialogConfirmBtn').textContent = confirmText;
  el('updateDialogConfirmBtn').dataset.tone = tone;
  el('updateDialogCancelBtn').textContent = cancelText;
  el('updateDialogCancelBtn').hidden = Boolean(confirmOnly);
  panel.classList.remove('hide');
  panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('update-dialog-open');
  requestAnimationFrame(() => panel.classList.add('open'));
  return new Promise((resolve) => {
    state.updateDialogResolver = resolve;
  });
}

function updateLines(items = []) {
  return items.filter(Boolean).map((item) => `<div class="update-line">${escapeHtml(item)}</div>`).join('');
}

function setPage(page = 'quick') {
  const meta = PAGE_META[page] || PAGE_META.quick;
  state.activePage = page;
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

function setConfigEditorOpen(open) {
  state.configEditorOpen = open;
  if (open) {
    populateConfigEditor();
    setPage('configEditor');
    // Init custom selects for config editor (hidden on initial load)
    if (window.refreshCustomSelects) window.refreshCustomSelects();
  } else {
    setPage('quick');
  }
}

function configValue(path, fallback = '') {
  return path.split('.').reduce((obj, key) => (obj && obj[key] !== undefined ? obj[key] : undefined), state.current?.config) ?? fallback;
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
  el('cfgCompactPromptCheck').checked = Boolean(configValue('compact_prompt', false));
  el('cfgUpdateCheck').checked = Boolean(configValue('check_for_update_on_startup', false));
  el('cfgInstructionsTextarea').value = configValue('instructions', '');
  el('cfgBaseInstructionsTextarea').value = configValue('base_instructions', '');
  el('cfgRawTomlTextarea').value = state.current?.configToml || '';
  refreshConfigNumberFields();
  syncShortcutActiveState();
}

/**
 * Sync shortcut button active state based on current config values.
 * Determines which preset (if any) matches the loaded configuration.
 */
function syncShortcutActiveState() {
  document.querySelectorAll('.shortcut-btn').forEach(b => b.classList.remove('active'));

  const reasoning = configValue('model_reasoning_effort', '');
  const planReasoning = configValue('plan_mode_reasoning_effort', '');
  const serviceTier = configValue('service_tier', '');
  const ctxWindow = configValue('model_context_window', '');
  const compactLimit = configValue('model_auto_compact_token_limit', '');

  const ctxNum = ctxWindow ? Number(ctxWindow) : 0;
  const compactNum = compactLimit ? Number(compactLimit) : 0;

  // Check "Max" first (most specific: high reasoning + 1M window)
  if (reasoning === 'high' && planReasoning === 'high' && ctxNum >= 1048576) {
    el('shortcutMaxPerf')?.classList.add('active');
    return;
  }

  // Check "Fast" mode: minimal reasoning + fast service tier
  const isFast = (reasoning === 'minimal' || planReasoning === 'minimal') && serviceTier === 'fast';
  // Check "1M Token" mode: large context window
  const is1M = ctxNum >= 1048576;

  if (isFast && is1M) {
    // Both are on but doesn't match Max – highlight both
    el('shortcutFast')?.classList.add('active');
    el('shortcut1M')?.classList.add('active');
    return;
  }

  if (isFast) {
    el('shortcutFast')?.classList.add('active');
    return;
  }

  if (is1M) {
    el('shortcut1M')?.classList.add('active');
    return;
  }

  // Check if everything is default (all empty/unset)
  const allDefault = !reasoning && !planReasoning && !serviceTier && !ctxWindow && !compactLimit;
  if (allDefault) {
    el('shortcutReset')?.classList.add('active');
  }
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
    compact_prompt: el('cfgCompactPromptCheck').checked,
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
  // Save form settings
  const json = await api('/api/config/settings-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: el('scopeSelect').value,
      projectPath: el('projectPathInput').value.trim(),
      codexHome: el('codexHomeInput').value.trim(),
      settings: buildSettingsPatch(),
    }),
  });
  // Also save raw TOML if it was edited
  const tomlEl = el('cfgRawTomlTextarea');
  if (tomlEl && tomlEl.value.trim() && tomlEl.value !== (state.current?.configToml || '')) {
    await api('/api/config/raw-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: el('scopeSelect').value,
        projectPath: el('projectPathInput').value.trim(),
        codexHome: el('codexHomeInput').value.trim(),
        configToml: tomlEl.value,
      }),
    });
  }
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
  const json = await api('/api/config/settings-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: el('scopeSelect').value,
      projectPath: el('projectPathInput').value.trim(),
      codexHome: el('codexHomeInput').value.trim(),
      settings: buildSettingsPatch(),
    }),
  });
  // Also save raw TOML if it was edited
  const tomlEl = el('cfgRawTomlTextarea');
  if (tomlEl && tomlEl.value.trim() && tomlEl.value !== (state.current?.configToml || '')) {
    await api('/api/config/raw-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: el('scopeSelect').value,
        projectPath: el('projectPathInput').value.trim(),
        codexHome: el('codexHomeInput').value.trim(),
        configToml: tomlEl.value,
      }),
    });
  }
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

function currentPayload() {
  const baseUrl = normalizeBaseUrl(el('baseUrlInput').value);
  const providerKey = inferProviderKey(baseUrl);
  return {
    scope: el('scopeSelect').value,
    projectPath: el('projectPathInput').value.trim(),
    codexHome: el('codexHomeInput').value.trim(),
    providerKey,
    providerLabel: inferProviderLabel(baseUrl),
    baseUrl,
    apiKey: getApiKeyForSubmit({ baseUrl, providerKey }),
    envKey: inferEnvKey(providerKey),
    model: el('modelSelect').value,
  };
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

function renderModelOptions(models = state.detected?.models || [], preferred = '') {
  const selected = preferred || el('modelSelect').value || state.current?.summary?.model || '';
  const unique = [...new Set([selected, state.detected?.recommendedModel, ...models].filter(Boolean))];
  el('modelSelect').innerHTML = unique.length
    ? unique.map((model) => `<option value="${escapeHtml(model)}" ${model === selected ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')
    : '<option value="">先检测模型</option>';
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

async function detectModels() {
  const payload = currentPayload();
  if (payload.baseUrl && payload.baseUrl !== el('baseUrlInput').value.trim()) el('baseUrlInput').value = payload.baseUrl;
  const useStoredApiKey = canUseStoredApiKey({ baseUrl: payload.baseUrl, providerKey: payload.providerKey }) && !payload.apiKey;
  if (!payload.baseUrl || (!payload.apiKey && !useStoredApiKey)) return flash('先填 URL 和 API Key', 'error');
  setBusy('detectBtn', true, '检测中...');
  const json = await api(useStoredApiKey ? '/api/provider/test-saved' : '/api/provider/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(useStoredApiKey
      ? {
        scope: payload.scope,
        projectPath: payload.projectPath,
        codexHome: payload.codexHome,
        providerKey: payload.providerKey,
        timeoutMs: 18000,
      }
      : { baseUrl: payload.baseUrl, apiKey: payload.apiKey }),
    timeoutMs: 18000,
  });
  setBusy('detectBtn', false);
  if (!json.ok) {
    state.detected = null;
    renderModelOptions();
    el('detectionMeta').textContent = json.error || '检测失败';
    el('detectionMeta').className = 'inline-meta';
    return flash(json.error || '检测失败', 'error');
  }
  state.detected = json.data;
  state.detected.recommendedModel = pickRecommendedModel(json.data.models, json.data.recommendedModel);
  // Model detection result — update selection via renderModelOptions
  renderModelOptions(json.data.models, state.detected.recommendedModel);
  renderQuickSummary();
  el('detectionMeta').textContent = `检测成功 · ${json.data.models.length} 个模型 · 推荐 ${state.detected.recommendedModel || '-'}`;
}


async function saveConfigOnly() {
  if (state.activeTool === 'claudecode') {
    return saveClaudeCodeConfigOnly();
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

async function saveClaudeCodeConfigOnly() {
  const model = el('modelSelect')?.value || '';
  const apiKey = el('apiKeyInput')?.value?.trim() || '';

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
  await launchCodex('launchBtn', 'Codex 已启动');
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
        hint.textContent = '✅ 环境就绪，正在进入…';
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
      hint.textContent = `⚠️ 缺少: ${missing.join('、')}，即将启动配置向导…`;
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
  ['wcNode', 'wcNpm', 'wcCodex', 'wcConfig'].forEach((id) => {
    const item = el(id);
    if (!item) return;
    item.className = 'wc-item';
    const indicator = item.querySelector('.wc-indicator');
    if (indicator) indicator.className = 'wc-indicator loading';
  });
  el('wcNodeStatus').textContent = '检测中…';
  el('wcNpmStatus').textContent = '检测中…';
  el('wcCodexStatus').textContent = '检测中…';
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
  el('wizardInstallSkipBtn').style.display = 'none';
  el('wizardInstallNextBtn').style.display = 'none';
}

function resetWizardConfigUI() {
  el('wizardBaseUrl').value = '';
  el('wizardApiKey').value = '';
  el('wizardDetectStatus').textContent = '';
  el('wizardDetectStatus').className = 'wizard-detect-status';
  el('wizardModelField').style.display = 'none';
  el('wizardModelSelect').innerHTML = '<option value="">先检测模型</option>';
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
    // Codex
    if (env.codex.installed) {
      setWcItemStatus('wcCodex', 'wcCodexStatus', 'ok', env.codex.version || '已安装');
    } else {
      setWcItemStatus('wcCodex', 'wcCodexStatus', 'warn', '未安装');
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

    // Summary
    const lines = [];
    if (!env.node.installed) {
      lines.push('⚠️ Node.js 未安装，请先安装 Node.js ≥18');
    } else if (!env.node.sufficient) {
      lines.push(`⚠️ Node.js 版本过低 (${env.node.version})，需要 ≥18`);
    }
    if (!env.npm.installed) {
      lines.push('⚠️ npm 未安装');
    }
    if (!env.codex.installed) {
      lines.push('📦 下一步将安装 Codex CLI');
    }
    if (!env.config.hasProviders) {
      lines.push('⚡ 需要配置 API Provider');
    }
    if (env.codex.installed && env.config.hasProviders) {
      lines.push('✅ 环境已就绪！可以跳过向导，直接使用主界面。');
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

function wizardGoToInstall() {
  const env = state.wizardEnv;
  setWizardStep(1);
  resetWizardInstallUI();
  if (env?.codex.installed) {
    // Already installed, show skip button
    el('wizardInstallBtn').style.display = 'none';
    el('wizardInstallSkipBtn').style.display = '';
    el('wizardInstallNextBtn').style.display = '';
    el('wizardInstallResult').classList.remove('hide');
    el('wizardInstallResult').className = 'wib-result success';
    el('wizardInstallResult').textContent = `Codex 已安装 (${env.codex.version || '已安装'})，可直接跳过此步。`;
  }
}

async function wizardRunInstall() {
  el('wizardInstallBtn').disabled = true;
  el('wizardInstallProgress').classList.remove('hide');
  el('wizardInstallResult').classList.add('hide');

  try {
    const json = await api('/api/codex/install', { method: 'POST', timeoutMs: 120000 });
    el('wizardInstallProgress').classList.add('hide');

    if (json.ok && (json.data?.ok !== false)) {
      el('wizardInstallResult').classList.remove('hide');
      el('wizardInstallResult').className = 'wib-result success';
      el('wizardInstallResult').textContent = '✅ Codex 安装成功！';
      el('wizardInstallBtn').style.display = 'none';
      el('wizardInstallNextBtn').style.display = '';
      // Refresh env to pick up new state
      state.wizardEnv = state.wizardEnv || {};
      state.wizardEnv.codex = { installed: true };
    } else {
      el('wizardInstallResult').classList.remove('hide');
      el('wizardInstallResult').className = 'wib-result error';
      el('wizardInstallResult').textContent = `安装失败：${json.error || json.data?.stderr || '未知错误'}`;
      el('wizardInstallBtn').disabled = false;
    }
  } catch (err) {
    el('wizardInstallProgress').classList.add('hide');
    el('wizardInstallResult').classList.remove('hide');
    el('wizardInstallResult').className = 'wib-result error';
    el('wizardInstallResult').textContent = `安装出错：${err.message || err}`;
    el('wizardInstallBtn').disabled = false;
  }
}

function wizardGoToConfig() {
  setWizardStep(2);
  resetWizardConfigUI();
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
  const baseUrl = normalizeBaseUrl(el('wizardBaseUrl').value);
  const apiKey = el('wizardApiKey').value.trim();
  const model = el('wizardModelSelect').value || (state.wizardDetected?.recommendedModel || '');
  const providerKey = inferProviderKey(baseUrl);

  setBusy('wizardConfigNextBtn', true, '保存中…');
  try {
    const json = await api('/api/config/save', {
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
    setBusy('wizardConfigNextBtn', false);

    if (!json.ok) {
      flash(json.error || '保存失败', 'error');
      return;
    }

    // Go to complete step
    setWizardStep(3);
    el('wizardCompleteSummary').innerHTML = [
      ['Provider', inferProviderLabel(baseUrl)],
      ['Model', model || '—'],
      ['Base URL', baseUrl],
      ['Config', '~/.codex/config.toml'],
    ].map(([label, value]) =>
      `<div class="wcs-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
    ).join('');

    // Sync main form
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

    // Reload main state in background
    loadState({ preserveForm: false }).then(() => loadBackups());
  } catch (err) {
    setBusy('wizardConfigNextBtn', false);
    flash(err.message || '保存出错', 'error');
  }
}

function bindEvents() {
  el('baseUrlInput').addEventListener('input', () => applyDerivedMeta(false));
  el('baseUrlInput').addEventListener('blur', () => { const value = normalizeBaseUrl(el('baseUrlInput').value); if (value) el('baseUrlInput').value = value; applyDerivedMeta(false); });
  el('apiKeyInput').addEventListener('input', () => {
    const raw = el('apiKeyInput').value.trim();
    const currentActual = state.apiKeyField.actualValue.trim();
    state.apiKeyField.dirty = Boolean(raw) && (!state.apiKeyField.hasStored || !currentActual || raw !== currentActual);
    renderQuickSummary();
  });
  el('apiKeyToggleBtn').addEventListener('click', toggleApiKeyVisibility);
  el('detectBtn').addEventListener('click', detectModels);
  el('editConfigQuickBtn').addEventListener('click', () => setConfigEditorOpen(true));
  el('saveBtn').addEventListener('click', saveConfigOnly);
  el('launchBtn').addEventListener('click', launchCodexOnly);
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

  el('shortcutFast').addEventListener('click', () => {
    applyShortcut({
      model_reasoning_effort: 'minimal',
      plan_mode_reasoning_effort: 'minimal',
      service_tier: 'fast',
    }, 'Fast');
  });

  el('shortcut1M').addEventListener('click', () => {
    applyShortcut({
      model_context_window: 1048576,
      model_auto_compact_token_limit: 943718,
    }, '1M Token');
  });

  el('shortcutMaxPerf').addEventListener('click', () => {
    applyShortcut({
      model_reasoning_effort: 'high',
      plan_mode_reasoning_effort: 'high',
      model_context_window: 1048576,
      model_auto_compact_token_limit: 943718,
    }, 'Max');
  });

  el('shortcutReset').addEventListener('click', () => {
    applyShortcut({
      model_reasoning_effort: '',
      plan_mode_reasoning_effort: '',
      service_tier: '',
      model_context_window: '',
      model_auto_compact_token_limit: '',
    }, '默认');
  });
  el('modelSelect').addEventListener('change', (event) => {
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
  el('updateDialogCancelBtn').addEventListener('click', () => closeUpdateDialog(false));
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
  el('wizardConfigBackBtn').addEventListener('click', () => setWizardStep(1));
  el('wizardDetectBtn').addEventListener('click', wizardDetectModels);
  el('wizardBaseUrl').addEventListener('input', wizardUpdateConfigBtn);
  el('wizardApiKey').addEventListener('input', wizardUpdateConfigBtn);
  el('wizardApiKeyToggleBtn').addEventListener('click', () => toggleSimpleSecretInput('wizardApiKey', 'wizardApiKeyToggleBtn'));
  el('wizardConfigNextBtn').addEventListener('click', wizardSaveAndComplete);
  el('wizardFinishBtn').addEventListener('click', () => {
    closeSetupWizard();
    setPage('quick');
  });
  el('wizardLaunchBtn').addEventListener('click', async () => {
    closeSetupWizard();
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
