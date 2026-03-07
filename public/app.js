const state = {
  current: null,
  backups: [],
  detected: null,
  metaDirty: false,
  flashTimer: null,
  providerHealth: {},
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
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('easyaiconfig_theme', state.theme);
  applyTheme(state.theme);
}

// Apply theme before any rendering to prevent flash
initTheme();

const PAGE_META = {
  quick: { eyebrow: 'Quick Setup', title: '一键配置 Codex 工具', subtitle: '输入 URL 和 API Key，剩下交给 EasyAIConfig。' },
  providers: { eyebrow: 'Providers', title: 'Provider 与备份', subtitle: '集中查看已发现配置、检测状态与历史备份。' },
  system: { eyebrow: 'System', title: '系统与路径', subtitle: '处理工作区、权限、路径和 Codex 运行设置。' },
  about: { eyebrow: 'About', title: '关于 EasyAIConfig', subtitle: '查看桌面版本、更新源与当前运行信息。' },
  configEditor: { eyebrow: 'Current Config', title: '当前配置编辑', subtitle: '把常用 config.toml 配置转成高密度表单，右侧可看原始 TOML。' },
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
  const codex = state.current?.codexBinary || {};
  el('aboutAppVersion').textContent = info.currentVersion || '-';
  el('aboutUpdaterStatus').textContent = info.enabled ? (info.available ? `可更新到 ${info.version || '-'}` : '已配置') : '未配置';
  el('aboutCodexVersion').textContent = codex.installed ? (codex.version || '已安装') : '未安装';
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
  el('cfgHideReasoningCheck').checked = Boolean(configValue('hide_agent_reasoning', false));
  el('cfgShowRawReasoningCheck').checked = Boolean(configValue('show_raw_agent_reasoning', false));
  el('cfgDisableStorageCheck').checked = Boolean(configValue('disable_response_storage', false));
  el('cfgShellSnapshotCheck').checked = Boolean(configValue('features.shell_snapshot', false));
  el('cfgCompactPromptCheck').checked = Boolean(configValue('compact_prompt', false));
  el('cfgUpdateCheck').checked = Boolean(configValue('check_for_update_on_startup', false));
  el('cfgInstructionsTextarea').value = configValue('instructions', '');
  el('cfgBaseInstructionsTextarea').value = configValue('base_instructions', '');
  el('cfgRawTomlTextarea').value = state.current?.configToml || '';
}

function numOrNull(value) {
  const text = String(value || '').trim();
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
  setBusy('applyConfigEditorBtn', false);
  if (!json.ok) return flash(json.error || '表单配置保存失败', 'error');
  await loadState({ preserveForm: true });
  populateConfigEditor();
  await launchCodex('applyConfigEditorBtn', '表单配置已生效并启动 Codex');
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
  const providerKey = el('providerKeyInput').value.trim() || inferProviderKey(baseUrl);
  return {
    scope: el('scopeSelect').value,
    projectPath: el('projectPathInput').value.trim(),
    codexHome: el('codexHomeInput').value.trim(),
    providerKey,
    providerLabel: el('providerLabelInput').value.trim() || inferProviderLabel(baseUrl),
    baseUrl,
    apiKey: el('apiKeyInput').value.trim(),
    envKey: el('envKeyInput').value.trim() || inferEnvKey(providerKey),
    model: el('manualModelInput').value.trim() || el('modelSelect').value,
    approvalPolicy: el('approvalPolicySelect').value,
    sandboxMode: el('sandboxModeSelect').value,
    reasoningEffort: el('reasoningEffortSelect').value,
  };
}

function applyDerivedMeta(force = false) {
  if (state.metaDirty && !force) return renderQuickSummary();
  const baseUrl = normalizeBaseUrl(el('baseUrlInput').value);
  const providerKey = inferProviderKey(baseUrl);
  el('providerKeyInput').value = providerKey;
  el('providerLabelInput').value = inferProviderLabel(baseUrl);
  el('envKeyInput').value = inferEnvKey(providerKey);
  renderQuickSummary();
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
  const pill = el('codexPill');
  pill.className = `badge ${codex.installed ? 'success' : 'warning'}`;
  pill.textContent = codex.installed ? (codex.version || '已安装') : '未安装';

  const updateBtn = el('updateCodexBtn');
  const reinstallBtn = el('reinstallCodexBtn');
  const uninstallBtn = el('uninstallCodexBtn');

  updateBtn.textContent = codex.installed ? '更新 Codex' : '安装 Codex';
  reinstallBtn.hidden = !codex.installed;
  uninstallBtn.hidden = !codex.installed;
}

function renderQuickSummary() {
  const payload = currentPayload();
  el('quickSummary').innerHTML = [
    ['Provider', payload.providerKey || 'custom'],
    ['Env Key', payload.envKey || '-'],
    ['Model', payload.model || state.current?.summary?.model || '待检测'],
    ['当前', state.current?.summary?.modelProvider || '-'],
  ].map(([label, value]) => `<div class="summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
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
        api('/api/provider/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: provider.baseUrl, apiKey: provider.envValue, timeoutMs: 6000 }),
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
  if (state.providerDropdownOpen) refreshProviderHealth();
}

function renderModelOptions(models = state.detected?.models || [], preferred = '') {
  const selected = preferred || el('manualModelInput').value.trim() || state.current?.summary?.model || '';
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
  el('approvalPolicySelect').value = state.current?.summary?.approvalPolicy || '';
  el('sandboxModeSelect').value = state.current?.summary?.sandboxMode || '';
  el('reasoningEffortSelect').value = state.current?.summary?.reasoningEffort || '';
  if (!el('launchCwdInput').value) el('launchCwdInput').value = state.current?.launch?.cwd || '';
}

function fillFromProvider(provider) {
  if (!provider) return;
  el('baseUrlInput').value = provider.baseUrl || '';
  el('apiKeyInput').value = provider.envValue || '';
  el('providerKeyInput').value = provider.key || '';
  el('providerLabelInput').value = provider.name || '';
  el('envKeyInput').value = provider.resolvedKeyName || provider.envKey || '';
  el('manualModelInput').value = provider.isActive ? (state.current?.summary?.model || '') : '';
  state.detected = null;
  state.metaDirty = true;
  renderModelOptions([], el('manualModelInput').value);
  renderQuickSummary();
  renderCurrentConfig();
  el('detectionMeta').textContent = provider.hasApiKey ? `已载入 ${provider.name || provider.key}` : `已载入 ${provider.name || provider.key}，但未发现 Key`;
}

async function loadState({ preserveForm = true } = {}) {
  const snapshot = preserveForm ? {
    baseUrl: el('baseUrlInput').value,
    apiKey: el('apiKeyInput').value,
    providerKey: el('providerKeyInput').value,
    providerLabel: el('providerLabelInput').value,
    envKey: el('envKeyInput').value,
    manualModel: el('manualModelInput').value,
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
  renderQuickSummary();
  renderCurrentConfig();
  if (snapshot && (snapshot.baseUrl || snapshot.apiKey || snapshot.providerKey)) {
    el('baseUrlInput').value = snapshot.baseUrl;
    el('apiKeyInput').value = snapshot.apiKey;
    el('providerKeyInput').value = snapshot.providerKey;
    el('providerLabelInput').value = snapshot.providerLabel;
    el('envKeyInput').value = snapshot.envKey;
    el('manualModelInput').value = snapshot.manualModel;
    state.metaDirty = snapshot.metaDirty;
    renderModelOptions([], snapshot.selectedModel || snapshot.manualModel);
    renderQuickSummary();
    renderCurrentConfig();
    refreshProviderHealth();
    return;
  }
  fillFromProvider(state.current.activeProvider || state.current.providers?.[0]);
  renderCurrentConfig();

  // Auto-trigger provider health check so the card doesn't stay "待检测"
  refreshProviderHealth();
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
  if (!manual) return state.appUpdate;
  if (!state.appUpdate?.enabled) {
    flash('自动更新未配置，请先配置 GitHub Releases 和签名公钥', 'error');
  } else if (state.appUpdate?.available) {
    flash(`发现客户端新版本 ${state.appUpdate.version}`, 'success');
  } else {
    flash(`当前已是最新版本 ${state.appUpdate?.currentVersion || ''}`, 'success');
  }
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
  if (!payload.baseUrl || !payload.apiKey) return flash('先填 URL 和 API Key', 'error');
  setBusy('detectBtn', true, '检测中...');
  const json = await api('/api/provider/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: payload.baseUrl, apiKey: payload.apiKey }),
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
  if (!el('manualModelInput').value && state.detected.recommendedModel) el('manualModelInput').value = state.detected.recommendedModel;
  renderModelOptions(json.data.models, state.detected.recommendedModel);
  renderQuickSummary();
  el('detectionMeta').textContent = `检测成功 · ${json.data.models.length} 个模型 · 推荐 ${state.detected.recommendedModel || '-'}`;
}


async function saveConfigOnly() {
  const payload = currentPayload();
  if (payload.baseUrl && payload.baseUrl !== el('baseUrlInput').value.trim()) el('baseUrlInput').value = payload.baseUrl;
  if (!payload.baseUrl || !payload.apiKey) return flash('先填 URL 和 API Key', 'error');

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
  await launchCodex('launchBtn', 'Codex 已启动');
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
    el('apiKeyInput').value = apiKey;
    if (model) el('manualModelInput').value = model;
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
  el('apiKeyInput').addEventListener('input', renderQuickSummary);
  el('detectBtn').addEventListener('click', detectModels);
  el('editConfigQuickBtn').addEventListener('click', () => setConfigEditorOpen(true));
  el('saveBtn').addEventListener('click', saveConfigOnly);
  el('launchBtn').addEventListener('click', launchCodexOnly);
  el('appUpdateBtn').addEventListener('click', async () => {
    const info = await loadAppUpdateState({ manual: true });
    if (info?.available) return handleAppUpdate();
  });
  el('updateCodexBtn').addEventListener('click', updateCodex);
  el('reinstallCodexBtn').addEventListener('click', reinstallCodex);
  el('uninstallCodexBtn').addEventListener('click', uninstallCodex);
  el('refreshBtn').addEventListener('click', () => loadState({ preserveForm: true }));
  el('reloadBackupsBtn').addEventListener('click', loadBackups);
  el('modelSelect').addEventListener('change', (event) => {
    el('manualModelInput').value = event.target.value;
    renderModelOptions(state.detected?.models || [], event.target.value);
    renderQuickSummary();
  });
  el('modelChips').addEventListener('click', (event) => {
    const button = event.target.closest('[data-model]');
    if (!button) return;
    el('manualModelInput').value = button.dataset.model;
    renderModelOptions(state.detected?.models || [], button.dataset.model);
    renderQuickSummary();
  });
  ['providerKeyInput', 'providerLabelInput', 'envKeyInput'].forEach((id) => {
    el(id).addEventListener('input', () => {
      state.metaDirty = true;
      renderQuickSummary();
    });
  });
  ['manualModelInput', 'projectPathInput', 'codexHomeInput', 'launchCwdInput'].forEach((id) => el(id).addEventListener('input', renderQuickSummary));
  ['scopeSelect', 'approvalPolicySelect', 'sandboxModeSelect', 'reasoningEffortSelect'].forEach((id) => el(id).addEventListener('change', renderQuickSummary));
  el('savedProviders').addEventListener('click', (event) => {
    const button = event.target.closest('[data-load-provider]');
    if (button) fillFromProvider((state.current?.providers || []).find((item) => item.key === button.dataset.loadProvider));
  });
  document.querySelectorAll('[data-page-target]').forEach((node) => {
    if (node.dataset.pageTarget === '__wizard__') return; // handled separately
    node.addEventListener('click', () => setPage(node.dataset.pageTarget));
  });
  el('openAdvancedBtn').addEventListener('click', () => setPage('system'));
  el('openAboutBtn').addEventListener('click', async () => {
    if (!state.appUpdate) await loadAppUpdateState();
    populateAboutPanel();
    setPage('about');
  });
  el('closeAdvancedBtn').addEventListener('click', () => setPage('quick'));
  el('themeToggleBtn').addEventListener('click', toggleTheme);
  el('configEditorBtn').addEventListener('click', () => setConfigEditorOpen(true));
  if (el('configEditorShortcutBtn')) el('configEditorShortcutBtn').addEventListener('click', () => setConfigEditorOpen(true));
  el('closeConfigEditorBtn').addEventListener('click', () => setConfigEditorOpen(false));
  el('saveConfigEditorBtn').addEventListener('click', saveConfigEditor);
  el('applyConfigEditorBtn').addEventListener('click', applyConfigEditor);
  el('saveRawConfigEditorBtn').addEventListener('click', saveRawConfigEditor);
  el('applyRawConfigEditorBtn').addEventListener('click', applyRawConfigEditor);
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
    if (state.providerDropdownOpen && card && !card.contains(event.target)) {
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
    await loadAppUpdateState({ manual: true });
    populateAboutPanel();
  });
  el('aboutOpenAdvancedBtn').addEventListener('click', () => setPage('system'));
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
        valSpan.classList.toggle('placeholder', !selectedOpt.value);
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
