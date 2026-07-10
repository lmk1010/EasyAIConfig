// 内置终端页面：一站启动 codex / claude code，多 session tab，
// 右侧 sidebar 显示当前 provider / token 估算 / 进程状态。
//
// 跟旧的 embeddedTerminal（只 Windows）独立：这是一个全平台的、
// 主推的终端入口。
//
// 依赖：
// - 全局 `state` 对象（在 app.js 里）
// - 全局 `api()` / `escapeHtml()` / `flash()`
// - xterm.js Terminal + FitAddon（app.js 已经 import 过，这里通过
//   window.__xterm 注入；如未注入则页面提示）

import { Terminal } from './vendor/xterm/xterm.mjs';
import { FitAddon } from './vendor/xterm/addon-fit.mjs';
import { WebglAddon } from './vendor/xterm/addon-webgl.mjs';
import { Unicode11Addon } from './vendor/xterm/addon-unicode11.mjs';
import { WebLinksAddon } from './vendor/xterm/addon-web-links.mjs';
import { SearchAddon } from './vendor/xterm/addon-search.mjs';

// PTY 数据走 Tauri push 事件（terminal-data / terminal-exit）。
// 保留 poll 作为兜底（首次 mount 时把已积压的历史 buffer 拉一次）。
const POLL_INTERVAL_MS = 1200; // 兜底轮询间隔（慢，事件流为主）

const TOOL_LAUNCH_BIN = {
  codex: 'codex',
  claudecode: 'claude',
};

function getState() { return window.state; }

// 全局 Tauri 事件监听：terminal-data / terminal-tokens / terminal-exit
// Rust reader 线程每读到一段 PTY 输出就 emit 一次（真 push 流），
// codex jsonl watcher 每检测到一条 token_count 也 emit。
let __eaTermListenersBound = false;
async function installTermEventListeners() {
  if (__eaTermListenersBound) return;
  let listen = window.__TAURI__?.event?.listen;
  // Tauri 全局注入有时晚于 module 加载；最多重试 30 × 100ms
  let tries = 0;
  while (typeof listen !== 'function' && tries < 30) {
    await new Promise((r) => setTimeout(r, 100));
    listen = window.__TAURI__?.event?.listen;
    tries++;
  }
  if (typeof listen !== 'function') return;
  __eaTermListenersBound = true;
  await listen('terminal-data', (event) => {
    const { sessionId, data } = event.payload || {};
    if (!sessionId || !data) return;
    const tp = getState()?.terminalPage;
    if (!tp) return;
    const inst = tp.instances?.[sessionId];
    if (!inst?.term) return;
    let chunk = data;
    if (inst.firstChunk) {
      inst.firstChunk = false;
      chunk = chunk.replace(/^(?:\r?\n)+/, '');
    }
    inst.term.write(chunk);
    inst.recvBytes += utf8ByteLength(chunk);
    inst.cursor += utf8ByteLength(chunk);

    // 不再 regex 解 TUI 文本（容易把 "output_tokens" 字样误判）。
    // 真 token 走 terminal-tokens 事件（Rust 直接 tail codex jsonl）
    // 节流 sidebar + 状态栏重渲染 (rAF) — 字节计数仍然更新
    if (!inst._sidebarRaf) {
      inst._sidebarRaf = requestAnimationFrame(() => {
        inst._sidebarRaf = 0;
        renderTermSidebar();
        renderTermStatus();
      });
    }
  });
  // 真实 token 事件来自 codex jsonl watcher（terminal-tokens）
  // token 写到 session 而不是 instance — instance 在 mount/unmount 时会丢
  await listen('terminal-tokens', (event) => {
    const payload = event.payload || {};
    const { sessionId } = payload;
    if (!sessionId) return;
    const tp = getState()?.terminalPage;
    if (!tp) {
      // 用户还没进入 terminal 页：缓存 payload，renderTerminalPage 启动时回灌
      window.__eaPendingTokens = window.__eaPendingTokens || {};
      window.__eaPendingTokens[sessionId] = payload;
      return;
    }
    const tokens = {
      input: Number(payload.input || 0),
      cached: Number(payload.cached || 0),
      output: Number(payload.output || 0),
      reasoning: Number(payload.reasoning || 0),
      total: Number(payload.total || 0),
      contextWindow: Number(payload.contextWindow || 0),
    };
    const sess = tp.sessions.find((s) => s.id === sessionId);
    if (sess) {
      sess.tokens = tokens;
      sess.tokensUpdatedAt = Date.now();
      // codexSessionId 第一次拿到时 persist 一份，下次 ghost 重启就能 codex resume
      if (payload.codexSessionId && sess.codexSessionId !== payload.codexSessionId) {
        sess.codexSessionId = payload.codexSessionId;
        persistOneSession(sess);
      }
    } else {
      // 会话还没出现在 tp.sessions（race condition）— 缓存等出现
      window.__eaPendingTokens = window.__eaPendingTokens || {};
      window.__eaPendingTokens[sessionId] = payload;
    }
    const inst = tp.instances?.[sessionId];
    if (inst) {
      inst.tokens = tokens;
      inst.tokensUpdatedAt = Date.now();
    }
    // 直接 inline 刷状态栏 — token 频率低（每轮对话一次），不需要 rAF 节流
    try {
      const host = document.getElementById('eaTerminalPage');
      const statusEl = host?.querySelector('.ea-term-status');
      if (statusEl) statusEl.innerHTML = renderStatusBarInner(tp);
      renderTermSidebar();
    } catch (_) {}
  });
  await listen('terminal-exit', (event) => {
    const { sessionId, exitCode } = event.payload || {};
    const tp = getState()?.terminalPage;
    if (!tp) return;
    const sess = tp.sessions.find((s) => s.id === sessionId);
    if (sess) { sess.running = false; sess.exitCode = exitCode ?? null; }
    const inst = tp.instances?.[sessionId];
    if (inst?.term) {
      inst.term.write(`\r\n\x1b[31m[已退出${exitCode != null ? ` · code ${exitCode}` : ''}]\x1b[0m\r\n`);
    }
  });
}
installTermEventListeners().catch(() => {});
function api(path, opts) { return window.api(path, opts); }
function flash(msg, type) { return typeof window.flash === 'function' ? window.flash(msg, type) : console.log(`[flash:${type || ''}] ${msg}`); }
function escapeHtml(v) { return typeof window.escapeHtml === 'function' ? window.escapeHtml(v) : String(v ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] || c)); }

const UTF8_ENCODER = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const UTF8_DECODER = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function isApplePlatform() {
  const platform = typeof navigator !== 'undefined' ? (navigator.platform || '') : '';
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

function terminalShortcutModifier(event) {
  return isApplePlatform() ? event.metaKey : (event.ctrlKey && event.shiftKey);
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('.xterm')) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function utf8ByteLength(text) {
  const value = String(text || '');
  if (!value) return 0;
  if (UTF8_ENCODER) return UTF8_ENCODER.encode(value).length;
  try { return unescape(encodeURIComponent(value)).length; } catch (_) { return value.length; }
}

function dropUtf8PrefixBytes(text, byteCount) {
  const value = String(text || '');
  const count = Math.max(0, Number(byteCount || 0));
  if (!value || count <= 0) return value;
  if (!UTF8_ENCODER || !UTF8_DECODER) return value.slice(count);
  const bytes = UTF8_ENCODER.encode(value);
  if (count >= bytes.length) return '';
  return UTF8_DECODER.decode(bytes.slice(count));
}

function normalizeTerminalPaste(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function shellQuotePath(path) {
  const text = String(path || '');
  if (!text) return '';
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function renderTermSidebar() {
  const tp = getState()?.terminalPage;
  if (!tp) return;
  const listEl = document.getElementById('eaTermSecList');
  const countEl = document.getElementById('eaTermSecCount');
  if (!listEl) return;
  if (countEl) countEl.textContent = String(tp.sessions.length);
  const esc = escapeHtml;
  const toolAccent = (tool) => tool === 'codex'
    ? '--accent-a:#ffd0a8;--accent-b:#ff8c5a'
    : tool === 'claudecode'
      ? '--accent-a:#ffc69a;--accent-b:#e07a3f'
      : '--accent-a:#a0c8ff;--accent-b:#5b8cff';
  const toolIcon = (tool) => {
    if (tool === 'codex') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7l9-5z" opacity="0.5"/><path d="M12 12l9-5M12 12v10M12 12L3 7"/></svg>';
    }
    if (tool === 'claudecode') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 3"/></svg>';
    }
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>';
  };
  const toolLabel = (tool) => tool === 'codex' ? 'Codex' : tool === 'claudecode' ? 'Claude Code' : tool || 'Shell';
  // 顶部的 "+ 新建会话" 卡片永远在
  const newSessionRow = `
    <button type="button" class="sec-item sec-item-new" data-eat-launcher-toggle title="新建会话 (⌘T)">
      <span class="sec-ico sec-ico-new">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
      </span>
      <span class="sec-text">
        <span class="sec-name">新建会话</span>
        <span class="sec-subtitle">codex · claude code · 自定义</span>
      </span>
    </button>`;
  const sessionRows = tp.sessions.map((s) => {
    const isActive = s.id === tp.activeSessionId;
    const deleteLabel = s._ghost || !s.running ? '删除会话记录' : '结束并删除会话';
    return `
      <div class="sec-item sec-item-session ${isActive ? 'active' : ''}" style="${toolAccent(s.tool)}">
        <button type="button" class="sec-main" data-eat-sec-tab="${esc(s.id)}" title="切换到 ${esc(s.title || s.command || s.id.slice(0,8))}">
          <span class="sec-ico">${toolIcon(s.tool)}</span>
          <span class="sec-text">
            <span class="sec-name">${esc(s.title || s.command || s.id.slice(0,8))}</span>
            <span class="sec-subtitle"><span class="ea-term-sec-dot ${s.running ? 'is-on' : 'is-off'}"></span>${esc(toolLabel(s.tool))}${s.running ? '' : ' · 已退出'}</span>
          </span>
          <span class="sec-chev" aria-hidden="true">›</span>
        </button>
        <button type="button" class="sec-session-delete" data-eat-session-delete="${esc(s.id)}" title="${deleteLabel}" aria-label="${deleteLabel}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
        </button>
      </div>`;
  }).join('');
  listEl.innerHTML = newSessionRow + sessionRows;
  // 状态栏的实时用量也同步刷新
  renderTermStatus();
}

// 单独刷状态栏（terminal-data / terminal-tokens 触发）
function renderTermStatus() {
  const tp = getState()?.terminalPage;
  if (!tp) return;
  const host = document.getElementById('eaTerminalPage');
  if (!host) return;
  const statusEl = host.querySelector('.ea-term-status');
  if (statusEl) statusEl.innerHTML = renderStatusBarInner(tp);
}

window.renderTermSidebar = renderTermSidebar;

export function initTerminalPageState() {
  const st = getState();
  if (st.terminalPage) return;
  st.terminalPage = {
    sessions: [],            // [{ id, tool, title, command, createdAt, running, cwd }]
    activeSessionId: '',
    launcher: {
      tool: 'codex',
      source: 'provider',          // codex: 'official' (用 ~/.codex 登录态) | 'provider' (走自管 provider)
      providerKey: '',
      officialProfileId: '',        // codex official 时选哪个 oauth 账号
      cwd: '',
      model: '',                    // '' = 默认；'custom' = modelCustom 文本
      modelCustom: '',
      reasoningEffort: '',          // codex: '' | minimal | low | medium | high | xhigh | max | ultra
      profile: '',                  // codex 可空：--profile
      sandbox: 'bypass',            // bypass | workspace-write | read-only | none
      flags: '',                    // 额外参数
      moreOpen: false,
    },
    officialProfiles: [],            // [{id, name, email, plan, codexHome, ...}]
    officialActiveId: '',
    officialProfilesLoadedAt: 0,
    claudeStateLoadedAt: 0,
    claudeStateLoading: false,
    providerModels: {},              // { [providerKey]: [model-id, ...] }
    providerModelsLoading: {},       // { [providerKey]: bool }
    providerModelsFailed: {},        // { [tool:providerKey]: true }
    paletteOpen: false,
    instances: {},           // sessionId -> { term, fit, cursor, container, pollTimer, sentBytes, recvBytes }
    sidebarOpen: true,
    starting: false,
  };
}

function looksLikeClaudeModel(model = '') {
  const text = String(model || '').trim().toLowerCase();
  if (!text) return false;
  return text === 'opus' || text === 'sonnet' || text === 'haiku' || text.includes('claude');
}

function sanitizeClaudeLauncherModel(model = '') {
  const value = String(model || '').trim();
  return looksLikeClaudeModel(value) ? value : '';
}

export async function renderTerminalPage() {
  initTerminalPageState();
  // 把还没拿到 tp 时缓存住的 token 事件灌回 session
  const pending = window.__eaPendingTokens || {};
  const stPending = getState()?.terminalPage;
  if (stPending && Object.keys(pending).length) {
    for (const sid of Object.keys(pending)) {
      const p = pending[sid];
      const sess = stPending.sessions.find((s) => s.id === sid);
      if (sess) {
        sess.tokens = {
          input: Number(p.input || 0),
          cached: Number(p.cached || 0),
          output: Number(p.output || 0),
          reasoning: Number(p.reasoning || 0),
          total: Number(p.total || 0),
          contextWindow: Number(p.contextWindow || 0),
        };
      }
    }
    window.__eaPendingTokens = {};
  }
  const host = document.getElementById('eaTerminalPage');
  if (!host) return;
  const st = getState();
  const tp = st.terminalPage;

  // 首次进来 / 回到 terminal 页都重新拉一次现有 sessions
  if (!tp._loadedOnce) {
    tp._loadedOnce = true;
    // (a) 从 SQLite 拉持久化元数据（关 app / 重启 dev 都不丢）
    try {
      const pres = await api('/api/terminal/persisted');
      const persisted = pres?.ok && Array.isArray(pres.data?.rows) ? pres.data.rows : [];
      for (const p of persisted) {
        tp.sessions.push({
          id: p.sessionId,
          tool: p.tool,
          title: p.title,
          command: p.command,
          cwd: p.cwd,
          program: p.program,
          args: p.args,
          env: p.env,
          codexSessionId: p.codexSessionId || '',
          createdAt: p.createdAtMs ? new Date(p.createdAtMs).toISOString() : new Date().toISOString(),
          running: false,
          _ghost: true,
        });
      }
    } catch (_) {}
    // (b) 拉 Rust 当前活的 sessions，覆盖/合并
    try {
      const res = await api('/api/terminal/list');
      const rows = res?.ok && Array.isArray(res.data?.rows) ? res.data.rows : [];
      const liveIds = new Set();
      for (const row of rows.map(normalizeSession)) {
        liveIds.add(row.id);
        const existing = tp.sessions.find((s) => s.id === row.id);
        if (existing) {
          Object.assign(existing, row, { _ghost: false });
        } else {
          tp.sessions.push(row);
        }
      }
      // 不在 live 里的标 ghost（上次的会话，PTY 已死，需要重启）
      for (const s of tp.sessions) {
        if (!liveIds.has(s.id)) { s.running = false; s._ghost = true; }
      }
      if (!tp.activeSessionId && tp.sessions[0]) tp.activeSessionId = tp.sessions[0].id;
    } catch (_) {}
  }

  const codexProviders = listProviderRows('codex');
  const claudeProviders = listProviderRows('claudecode');
  const allProviders = tp.launcher.tool === 'codex' ? codexProviders : claudeProviders;
  const currentProvider = allProviders.find((p) => p.key === tp.launcher.providerKey) || null;
  if (tp.launcher.providerKey && !currentProvider) {
    tp.launcher.providerKey = '';
  }

  // 默认填一个 provider（如果没选）
  if (!tp.launcher.providerKey) {
    const active = allProviders.find((p) => p.isActive);
    tp.launcher.providerKey = active?.key || allProviders[0]?.key || '';
  }

  // canvas 三态：launcher 表单 / ghost 会话提示 / 活动 xterm
  const activeSess = tp.sessions.find((s) => s.id === tp.activeSessionId);
  const showLauncher = !!tp.launcherOpen;
  const showGhost = !showLauncher && activeSess?._ghost;
  // launcher 打开 + codex + official → 异步拉账号列表（30s 缓存自动）
  if (showLauncher && tp.launcher.tool === 'codex' && tp.launcher.source === 'official') {
    loadOfficialProfiles();
  }
  if (showLauncher && tp.launcher.tool === 'claudecode') {
    loadClaudeTerminalState();
  }
  // launcher 打开 + 自管 provider 已选 → 首次自动后台拉模型（缓存到 launcher 关）
  if (showLauncher && !((tp.launcher.tool === 'codex') && (tp.launcher.source === 'official'))
      && tp.launcher.providerKey
      && !tp.launcher.providerKey.startsWith('__claudecode_')
      && (selectedProviderRow(tp.launcher.tool, tp.launcher.providerKey)?.mode || '') === 'apikey'
      && !tp.providerModels[tp.launcher.providerKey]
      && !tp.providerModelsFailed?.[`${tp.launcher.tool}:${tp.launcher.providerKey}`]
      && !tp.providerModelsLoading[tp.launcher.providerKey]) {
    fetchProviderModels(tp.launcher.providerKey, tp.launcher.tool);
  }
  host.innerHTML = `
    <div class="ea-term-shell">
      ${tp.starting ? '<div class="ea-term-progress" aria-label="启动中"><span class="ea-term-progress-bar"></span></div>' : ''}
      <div class="ea-term-canvas">
        ${showLauncher ? renderLauncherPage(tp, allProviders) : (showGhost ? `
          <div class="ea-term-ghost">
            <div class="ea-term-ghost-title">这个会话已退出</div>
            <div class="ea-term-ghost-meta">
              <code>${escapeHtml(activeSess.command || activeSess.title || activeSess.program || 'codex')}</code><br>
              <span class="muted">cwd: ${escapeHtml(activeSess.cwd || '~')}</span>
              ${activeSess.codexSessionId ? `<br><span class="muted">codex session: ${escapeHtml(activeSess.codexSessionId.slice(0, 8))}…</span>` : ''}
            </div>
            ${activeSess.tool === 'codex' && activeSess.codexSessionId ? `
              <button type="button" class="ea-term-ghost-btn" data-eat-resume="${escapeHtml(activeSess.id)}" title="codex resume — 继承上次完整上下文">▶ 接着上次对话继续</button>
              <button type="button" class="ea-term-ghost-btn-secondary" data-eat-restart="${escapeHtml(activeSess.id)}">或重新开一个新会话</button>
            ` : `
              <button type="button" class="ea-term-ghost-btn" data-eat-restart="${escapeHtml(activeSess.id)}">用相同参数重新启动</button>
            `}
            <button type="button" class="ea-term-ghost-btn-secondary" data-eat-forget="${escapeHtml(activeSess.id)}">忘掉这个会话</button>
          </div>
        ` : `<div class="ea-term-host" id="eaTermHost"></div>`)}
      </div>
      ${renderStatusBar(tp)}
    </div>
    ${tp.paletteOpen ? renderPalette(tp, allProviders) : ''}
  `;

  bindEvents(host);
  // ghost / launcher 时不挂 xterm
  const active = tp.sessions.find((s) => s.id === tp.activeSessionId);
  if (active && !active._ghost && !tp.launcherOpen) {
    mountTerminal(active.id);
  }
  renderTermSidebar();
}


// 拉 codex 官方 OAuth 账号列表（缓存 30 秒）
async function loadOfficialProfiles(force) {
  const tp = getState()?.terminalPage;
  if (!tp) return;
  if (!force && tp.officialProfilesLoadedAt && Date.now() - tp.officialProfilesLoadedAt < 30000) return;
  try {
    const res = await api('/api/codex/oauth/profiles');
    if (res?.ok) {
      tp.officialProfiles = Array.isArray(res.data?.profiles) ? res.data.profiles : [];
      tp.officialActiveId = res.data?.active || '';
      tp.officialProfilesLoadedAt = Date.now();
      // 默认选 active
      if (!tp.launcher.officialProfileId && tp.officialActiveId) {
        tp.launcher.officialProfileId = tp.officialActiveId;
      } else if (!tp.launcher.officialProfileId && tp.officialProfiles[0]) {
        tp.launcher.officialProfileId = tp.officialProfiles[0].id;
      }
      // 重渲让 select 显示
      if (tp.launcherOpen && getState()?.activePage === 'terminal') {
        renderTerminalPage();
      }
    }
  } catch (_) {}
}

// 从指定 provider 拉真实 /v1/models 列表 — 用 test-saved 端点
async function loadClaudeTerminalState(force) {
  const st = getState();
  const tp = st?.terminalPage;
  if (!tp || tp.claudeStateLoading) return;
  if (!force && st.claudeCodeState && tp.claudeStateLoadedAt && Date.now() - tp.claudeStateLoadedAt < 30000) return;
  tp.claudeStateLoading = true;
  try {
    const [stateRes, profilesRes] = await Promise.all([
      api('/api/claudecode/state'),
      api('/api/claudecode/oauth/profiles').catch(() => null),
    ]);
    if (stateRes?.ok && stateRes.data) {
      st.claudeCodeState = stateRes.data;
      tp.claudeStateLoadedAt = Date.now();
    }
    if (profilesRes?.ok) {
      window.__chClaudeOauthProfiles = { loaded: true, data: profilesRes.data || {} };
    }
    const rows = listProviderRows('claudecode');
    if (!rows.some((row) => row.key === tp.launcher.providerKey)) {
      const active = rows.find((row) => row.isActive) || rows[0];
      tp.launcher.providerKey = active?.key || '';
    }
    if (tp.launcherOpen && getState()?.activePage === 'terminal') {
      renderTerminalPage();
    }
  } catch (err) {
    console.warn('[terminal] load Claude Code state failed:', err);
  } finally {
    tp.claudeStateLoading = false;
  }
}

async function fetchProviderModels(providerKey, tool) {
  if (!providerKey) return;
  if (tool === 'claudecode' && providerKey.startsWith('__claudecode_')) return;
  const tp = getState()?.terminalPage;
  if (!tp) return;
  const normalizedTool = tool || 'codex';
  const selected = selectedProviderRow(normalizedTool, providerKey);
  if (!selected || selected.mode !== 'apikey') return;
  const failureKey = `${normalizedTool}:${providerKey}`;
  if (tp.providerModelsFailed?.[failureKey]) return;
  tp.providerModelsLoading[providerKey] = true;
  renderTerminalPage();
  try {
    const provider = selected.ref || selected;
    const isClaude = normalizedTool === 'claudecode';
    const res = isClaude
      ? await api('/api/provider/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerKey,
          baseUrl: selected.baseUrl || provider.baseUrl || '',
          apiKey: provider.authToken || provider.apiKey || selected.authToken || selected.apiKey || '',
          timeoutMs: 15000,
        }),
      })
      : await api('/api/provider/test-saved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey, tool: normalizedTool, codexHome: '' }),
      });
    if (res?.ok && Array.isArray(res.data?.models)) {
      tp.providerModels[providerKey] = res.data.models;
      delete tp.providerModelsFailed[failureKey];
      flash(`已拉取 ${res.data.models.length} 个模型`, 'success');
    } else {
      tp.providerModelsFailed[failureKey] = true;
      flash(`拉取模型失败: ${res?.error || '未知'}`, 'warning');
    }
  } catch (err) {
    tp.providerModelsFailed[failureKey] = true;
    flash(`拉取模型异常: ${err?.message || err}`, 'warning');
  } finally {
    tp.providerModelsLoading[providerKey] = false;
    renderTerminalPage();
  }
}

// 自定义下拉：避开 macOS 原生 select 蓝色高亮 popup
// options: [{value, label, hint?}]
function renderLaunchSelect(name, options, value) {
  const esc = escapeHtml;
  const open = (getState()?.terminalPage?._lcsOpen === name);
  const current = options.find((o) => o.value === value) || options[0] || { label: '' };
  return `
    <div class="ea-term-lcs ${open ? 'is-open' : ''}" data-eat-lcs="${esc(name)}">
      <button type="button" class="ea-term-lcs-btn" data-eat-lcs-toggle="${esc(name)}" aria-haspopup="listbox" aria-expanded="${open ? 'true' : 'false'}">
        <span class="ea-term-lcs-val">${esc(current.label || '')}${current.hint ? `<span class="ea-term-lcs-hint">${esc(current.hint)}</span>` : ''}</span>
        <svg class="ea-term-lcs-caret" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2 4l3 3 3-3"/></svg>
      </button>
      ${open ? `
        <div class="ea-term-lcs-pop" role="listbox">
          ${options.map((o) => `
            <button type="button" role="option" class="ea-term-lcs-opt ${o.value === value ? 'is-on' : ''}" data-eat-lcs-pick="${esc(name)}" data-value="${esc(o.value)}">
              ${o.value === value ? '<svg class="ea-term-lcs-tick" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5l2.5 2.5 5-5"/></svg>' : '<span class="ea-term-lcs-tick-space"></span>'}
              <span class="ea-term-lcs-opt-lab">${esc(o.label)}</span>
              ${o.hint ? `<span class="ea-term-lcs-opt-hint">${esc(o.hint)}</span>` : ''}
            </button>
          `).join('')}
        </div>
      ` : ''}
    </div>`;
}

// Canvas 内嵌的"新建会话"页面 — 替代旧 popover。
// 居中容器 + 项目原生 field 风格 (label 左、控件右、24px 高)
function renderLauncherPage(tp, providers) {
  const esc = escapeHtml;
  const isCodex = tp.launcher.tool === 'codex';
  const isOfficial = isCodex && tp.launcher.source === 'official';
  const providerOpts = providers.map((p) => `<option value="${esc(p.key)}" ${p.key === tp.launcher.providerKey ? 'selected' : ''}>${esc(p.name || p.key)}${p.isActive ? ' · 当前' : ''}</option>`).join('');
  const sandboxOpts = [
    ['bypass', '完全放开 (--dangerously-bypass)'],
    ['workspace-write', '工作目录可写'],
    ['read-only', '只读'],
    ['none', '不设置'],
  ];
  // 默认模型列表（最新 → 老）；provider 模式下会从 /v1/models 拉真实列表合并到前
  const codexModelOpts = [
    { value: '', label: '默认 (账号/profile 设定)' },
    { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol · 旗舰' },
    { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
    { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
    { value: 'gpt-5.5', label: 'gpt-5.5' },
    { value: 'gpt-5.4', label: 'gpt-5.4' },
    { value: 'gpt-5-codex', label: 'gpt-5-codex' },
    { value: 'gpt-5', label: 'gpt-5' },
    { value: 'gpt-5-mini', label: 'gpt-5-mini' },
    { value: 'o3', label: 'o3' },
    { value: 'o3-mini', label: 'o3-mini' },
    { value: 'custom', label: '自定义…' },
  ];
  const claudeModelOpts = [
    { value: '', label: '默认' },
    { value: 'claude-fable-5', label: 'claude-fable-5' },
    { value: 'claude-mythos-5', label: 'claude-mythos-5' },
    { value: 'claude-sonnet-5', label: 'claude-sonnet-5 · 首发价' },
    { value: 'claude-opus-4-8', label: 'claude-opus-4-8' },
    { value: 'claude-opus-4-7', label: 'claude-opus-4-7 (1M)' },
    { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
    { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
    { value: 'custom', label: '自定义…' },
  ];
  // 从 provider 拉到的真实模型（如果有）— 拼到前面
  const liveModels = (tp.providerModels?.[tp.launcher.providerKey] || []).filter((model) => isCodex || looksLikeClaudeModel(model));
  const liveOpts = liveModels.map((m) => ({ value: m, label: m, hint: '来自 provider' }));
  const baseOpts = isCodex ? codexModelOpts : claudeModelOpts;
  // 去重：live 命中的从 baseOpts 中去掉
  const liveSet = new Set(liveModels);
  const mergedModelOpts = [
    baseOpts[0],                                             // 默认始终首位
    ...liveOpts,
    ...baseOpts.slice(1).filter((o) => !liveSet.has(o.value)),
  ];
  const reasoningOpts = [
    { value: '', label: '默认 (跟 profile)' },
    { value: 'ultra', label: 'ultra · 自动任务委派 (5.6 Sol/Terra)' },
    { value: 'max', label: 'max · 最大推理 (GPT-5.6)' },
    { value: 'xhigh', label: 'xhigh · 极致推理' },
    { value: 'high', label: 'high · 深度思考' },
    { value: 'medium', label: 'medium · 平衡' },
    { value: 'low', label: 'low · 快速' },
    { value: 'minimal', label: 'minimal · 最低' },
  ];
  const modelOpts = mergedModelOpts;
  const launcherModel = isCodex ? (tp.launcher.model || '') : sanitizeClaudeLauncherModel(tp.launcher.model || '');
  const isCustomModel = tp.launcher.model === 'custom';
  const modelsLoading = tp.providerModelsLoading?.[tp.launcher.providerKey];
  const cwdDisplay = tp.launcher.cwd || '~ ($HOME)';
  return `
    <div class="ea-term-launch-page">
      <div class="ea-term-launch-card">
        <div class="ea-term-launch-head">
          <div class="ea-term-launch-title">新建会话</div>
          <button type="button" class="ea-term-launch-x" data-eat-launcher-close title="关闭 (Esc)" aria-label="关闭">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <div class="ea-term-launch-body">
          <div class="ea-term-launch-row">
            <label class="ea-term-launch-lab">工具</label>
            <div class="ea-term-launch-seg">
              <button type="button" class="${isCodex ? 'is-on' : ''}" data-eat-launch-set="tool" data-value="codex">Codex</button>
              <button type="button" class="${!isCodex ? 'is-on' : ''}" data-eat-launch-set="tool" data-value="claudecode">Claude Code</button>
            </div>
          </div>
          ${isCodex ? `
            <div class="ea-term-launch-row">
              <label class="ea-term-launch-lab">登录方式</label>
              <div class="ea-term-launch-seg">
                <button type="button" class="${isOfficial ? 'is-on' : ''}" data-eat-launch-set="source" data-value="official" title="使用 ~/.codex 官方登录态">官方</button>
                <button type="button" class="${!isOfficial ? 'is-on' : ''}" data-eat-launch-set="source" data-value="provider" title="使用自管 provider API">自管 Provider</button>
              </div>
            </div>
          ` : ''}
          ${!isOfficial ? `
            <div class="ea-term-launch-row">
              <label class="ea-term-launch-lab">Provider</label>
              ${renderLaunchSelect('providerKey',
                providers.length
                  ? providers.map((p) => ({ value: p.key, label: p.name || p.key, hint: p.isActive ? '当前' : '' }))
                  : [{ value: '', label: '（无可用 provider）' }],
                tp.launcher.providerKey)}
            </div>
          ` : `
            <div class="ea-term-launch-row">
              <label class="ea-term-launch-lab">账号</label>
              ${tp.officialProfiles.length ? renderLaunchSelect('officialProfileId',
                tp.officialProfiles.map((p) => ({
                  value: p.id,
                  label: p.email || p.name || p.id,
                  hint: p.id === tp.officialActiveId ? '当前' : '',
                })),
                tp.launcher.officialProfileId) : `
                <div class="ea-term-launch-empty">还没有保存的 codex 账号 · <a href="#" data-eat-goto-oauth>去管理</a></div>
              `}
            </div>
          `}
          <div class="ea-term-launch-row">
            <label class="ea-term-launch-lab">工作目录</label>
            <div class="ea-term-launch-cwd-wrap">
              <span class="ea-term-launch-cwd-ico" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.4l1.2 1.4h5.4A1.5 1.5 0 0 1 14 5.9V11.5A1.5 1.5 0 0 1 12.5 13H3.5A1.5 1.5 0 0 1 2 11.5z"/></svg>
              </span>
              <input class="ea-term-launch-ctl ea-term-launch-cwd" type="text" data-eat-launch="cwd" placeholder="~ ($HOME)" value="${esc(tp.launcher.cwd || '')}"/>
              <button type="button" class="ea-term-launch-pick" data-eat-pick-cwd title="选择目录" aria-label="选择目录">选择</button>
            </div>
          </div>
          <div class="ea-term-launch-row">
            <label class="ea-term-launch-lab">模型</label>
            <div class="ea-term-launch-cwd-wrap">
              ${renderLaunchSelect('model', modelOpts, launcherModel)}
              ${!isOfficial && tp.launcher.providerKey ? `
                <button type="button" class="ea-term-launch-pick" data-eat-fetch-models title="从 provider /v1/models 拉真实列表" aria-label="刷新模型">
                  ${modelsLoading ? '…' : '↻'}
                </button>
              ` : ''}
            </div>
          </div>
          ${isCustomModel ? `
            <div class="ea-term-launch-row">
              <label class="ea-term-launch-lab"></label>
              <input class="ea-term-launch-ctl ea-term-launch-mono" type="text" data-eat-launch="modelCustom" placeholder="模型名（如 gpt-5-pro / claude-opus-4-x）" value="${esc(tp.launcher.modelCustom || '')}"/>
            </div>
          ` : ''}
          ${isCodex ? `
            <div class="ea-term-launch-row">
              <label class="ea-term-launch-lab">推理强度</label>
              ${renderLaunchSelect('reasoningEffort', reasoningOpts, tp.launcher.reasoningEffort)}
            </div>
            <div class="ea-term-launch-row">
              <label class="ea-term-launch-lab">沙箱模式</label>
              ${renderLaunchSelect('sandbox',
                sandboxOpts.map(([v, lab]) => ({ value: v, label: lab })),
                tp.launcher.sandbox)}
            </div>
          ` : ''}
          <button type="button" class="ea-term-launch-more" data-eat-launch-more aria-expanded="${tp.launcher.moreOpen ? 'true' : 'false'}">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${tp.launcher.moreOpen ? 'is-open' : ''}"><path d="M4 6l4 4 4-4"/></svg>
            <span>更多参数</span>
          </button>
          ${tp.launcher.moreOpen ? `
            <div class="ea-term-launch-more-body">
              ${isCodex ? `
                <div class="ea-term-launch-row">
                  <label class="ea-term-launch-lab">Profile</label>
                  <input class="ea-term-launch-ctl" type="text" data-eat-launch="profile" placeholder="~/.codex/config.toml 里的 profile 名" value="${esc(tp.launcher.profile || '')}"/>
                </div>
              ` : ''}
              <div class="ea-term-launch-row">
                <label class="ea-term-launch-lab">额外参数</label>
                <input class="ea-term-launch-ctl ea-term-launch-mono" type="text" data-eat-launch="flags" value="${esc(tp.launcher.flags || '')}" placeholder="--flag 值 …"/>
              </div>
            </div>
          ` : ''}
        </div>
        <div class="ea-term-launch-foot">
          <span class="ea-term-launch-hint">${isCodex ? 'codex' : 'claude'} 将在选定目录启动并接管终端</span>
          <button type="button" class="ea-term-launch-go ${tp.starting ? 'is-busy' : ''}" data-eat-spawn ${tp.starting ? 'disabled' : ''}>
            ${tp.starting ? '启动中…' : '启动'}
          </button>
        </div>
      </div>
    </div>`;
}


function renderStatusBar(tp) {
  return `<div class="ea-term-status">${renderStatusBarInner(tp)}</div>`;
}

function renderStatusBarInner(tp) {
  const esc = escapeHtml;
  const session = tp.sessions.find((s) => s.id === tp.activeSessionId);
  if (!session) {
    return `<span class="ea-term-status-faint">没有运行中的会话</span>`;
  }
  const inst = tp.instances[session.id];
  // session 是数据真源（不依赖 xterm 是否 mount）；instance 上的是同步副本
  const tokens = session.tokens || inst?.tokens || {};
  const input = Number(tokens.input || 0);
  const cached = Number(tokens.cached || 0);
  const output = Number(tokens.output || 0);
  const reasoning = Number(tokens.reasoning || 0);
  const total = Number(tokens.total || (input + output + reasoning));
  const ctxWindow = Number(tokens.contextWindow || 0);
  const fmt = (n) => (n || 0).toLocaleString();
  // 紧凑显示：1500 → 1.5K · 1_200_000 → 1.2M · 1_500_000_000 → 1.5B
  const fmtShort = (n) => {
    const v = Number(n || 0);
    if (v < 1000) return String(v);
    if (v < 1_000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
    if (v < 1_000_000_000) return (v / 1_000_000).toFixed(v < 10_000_000 ? 1 : 0).replace(/\.0$/, '') + 'M';
    return (v / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  };
  // 工具名提炼：codex --dangerously-bypass-... → codex
  const titleRaw = String(session.title || session.command || '');
  const titleShort = titleRaw.split(/\s+/)[0] || titleRaw;
  // 上下文用量条：累计 input vs context window
  const usedPct = ctxWindow > 0 ? Math.min(100, (input / ctxWindow) * 100) : 0;
  const cachePctOfInput = input > 0 ? Math.min(100, (cached / input) * 100) : 0;
  // 还没有任何 token 数据时显示"等待…"，避免视觉上跟真实 0 token 难分
  const noTokens = ctxWindow === 0 && input === 0 && cached === 0 && output === 0;
  return `
    <span class="ea-term-status-dot ${session.running ? 'is-on' : 'is-off'}"></span>
    <span class="ea-term-status-text" title="${esc(titleRaw)}">${esc(titleShort)}</span>
    <span class="ea-term-status-sep">·</span>
    <span class="ea-term-status-text-faint">${esc(session.running ? '运行中' : '已退出')}</span>
    <span class="ea-term-status-spacer"></span>
    ${noTokens ? `
      <span class="ea-term-status-pill ea-term-status-pill-faint" title="正在等待 codex 写入第一条 token_count 事件">等待 token…</span>
    ` : `
      ${ctxWindow > 0 ? `
        <span class="ea-term-status-ctx" title="上下文 ${fmt(input)} / ${fmt(ctxWindow)} · 缓存 ${fmt(cached)}">
          <span class="ea-term-status-ctx-label">上下文</span>
          <span class="ea-term-status-ctx-bar">
            <span class="ea-term-status-ctx-fill" style="width:${usedPct.toFixed(1)}%"></span>
            <span class="ea-term-status-ctx-cache" style="width:${(usedPct * cachePctOfInput / 100).toFixed(1)}%"></span>
          </span>
          <span class="ea-term-status-ctx-num">${esc(fmtShort(input))}/${esc(fmtShort(ctxWindow))}</span>
        </span>
      ` : ''}
      <span class="ea-term-status-pill" title="输入 token: ${fmt(input)}">入 ${esc(fmtShort(input))}</span>
      <span class="ea-term-status-pill" title="缓存命中 token: ${fmt(cached)} (节省 ${input > 0 ? (cached / input * 100).toFixed(0) : 0}%)">缓 ${esc(fmtShort(cached))}</span>
      <span class="ea-term-status-pill ea-term-status-pill-tokens" title="输出 token: ${fmt(output)}">出 ${esc(fmtShort(output))}</span>
    `}
  `;
}

function renderPalette(tp, providers) {
  const esc = escapeHtml;
  return `
    <div class="ea-term-palette" data-eat-palette-scrim>
      <div class="ea-term-palette-box" role="dialog">
        <input type="text" class="ea-term-palette-input" id="eaTermPaletteInput" placeholder="输入命令… (新会话 / 切换 / 清屏)" autofocus />
        <div class="ea-term-palette-list">
          <button type="button" class="ea-term-palette-item" data-eat-palette-act="spawn"><span>启动新会话</span><em>当前工具 ${esc(tp.launcher.tool)}</em></button>
          ${providers.slice(0, 6).map((p) => `<button type="button" class="ea-term-palette-item" data-eat-palette-act="set-provider:${esc(p.key)}"><span>切到 Provider · ${esc(p.name || p.key)}</span><em>${esc(p.baseUrl || '')}</em></button>`).join('')}
          <button type="button" class="ea-term-palette-item" data-eat-palette-act="clear"><span>清屏</span><em>⌃L</em></button>
          <button type="button" class="ea-term-palette-item" data-eat-palette-act="close"><span>关闭命令面板</span><em>Esc</em></button>
        </div>
      </div>
    </div>`;
}

function listProviderRows(tool) {
  if (typeof window.__chBuildRows !== 'function') return [];
  try {
    const rows = window.__chBuildRows(tool) || [];
    if (tool === 'claudecode') {
      const usable = rows.filter((r) => !r.historyOnly && (r.hasCredential || r.mode === 'oauth'));
      if (usable.length) return usable;
      const data = getState()?.claudeCodeState || {};
      if (data.binary?.installed || data.configHome || data.settingsPath) {
        return [{
          key: '__claudecode_default__',
          name: '默认 Claude Code 配置',
          baseUrl: data.configHome || '~/.claude',
          model: data.model || '',
          mode: 'default',
          kind: 'claudecode-default',
          isActive: true,
          hasCredential: true,
          health: { ok: true, checked: true },
          tool,
        }];
      }
      return [];
    }
    return rows.filter((r) => r.mode === 'apikey' && !r.historyOnly && r.hasCredential);
  } catch (_) { return []; }
}

function selectedProviderRow(tool, providerKey) {
  return listProviderRows(tool).find((row) => row.key === providerKey) || null;
}

// 用 Rust SQLite 落盘单个 session 元数据 (写入 ~/.codex-config-ui/cache/terminals.db)
// localStorage 在 Tauri webview 缓存清理 / dev rebuild 时会丢，SQLite 才真持久
async function persistOneSession(s) {
  if (!s?.id) return;
  try {
    await api('/api/terminal/persist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: s.id,
        tool: s.tool || '',
        title: s.title || '',
        command: s.command || '',
        cwd: s.cwd || '',
        program: s.program || '',
        args: s.args || [],
        env: s.env || {},
        codexSessionId: s.codexSessionId || '',
      }),
    });
  } catch (_) {}
}
async function forgetPersistedSession(sessionId) {
  if (!sessionId) return;
  try {
    await api('/api/terminal/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch (_) {}
}

function normalizeSession(s) {
  return {
    id: s.sessionId || s.id || '',
    tool: s.tool || '',
    title: s.title || '',
    command: s.commandPreview || s.command || '',
    cwd: s.cwd || '',
    createdAt: s.createdAt || '',
    running: Boolean(s.running),
    exitCode: s.exitCode ?? null,
  };
}

function bindEvents(host) {
  if (host.dataset.eatBound === '1') return;
  host.dataset.eatBound = '1';
  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  host.addEventListener('input', onInput);
  // 全局 Cmd+K + sidebar 点击（在 host 外，document 级监听）
  if (!window.__eaTermKeyBound) {
    window.__eaTermKeyBound = true;
    window.addEventListener('keydown', onGlobalKey);
    document.addEventListener('click', (e) => {
      const tp = getState()?.terminalPage;
      if (!tp) return;
      const target = e.target instanceof Element ? e.target : null;
      const newBtn = target?.closest('[data-eat-launcher-toggle]');
      if (newBtn && !target.closest('#eaTerminalPage')) {
        tp.launcherOpen = !tp.launcherOpen;
        renderTerminalPage();
        return;
      }
      const deleteBtn = target?.closest('[data-eat-session-delete]');
      if (deleteBtn) {
        e.preventDefault();
        e.stopPropagation();
        deleteTerminalSession(deleteBtn.dataset.eatSessionDelete);
        return;
      }
      const secTab = target?.closest('[data-eat-sec-tab]');
      if (secTab) {
        tp.activeSessionId = secTab.dataset.eatSecTab;
        renderTerminalPage();
      }
    });
  }
}

function onClick(e) {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const tp = getState().terminalPage;
  if (t.closest('[data-eat-spawn]')) { spawnSession(); return; }
  if (t.closest('[data-eat-tab-new]')) {
    tp.launcherOpen = !tp.launcherOpen;
    renderTerminalPage();
    return;
  }
  if (t.closest('[data-eat-launcher-close]')) { tp.launcherOpen = false; renderTerminalPage(); return; }
  if (t.closest('[data-eat-launcher-scrim]')) {
    tp.launcherOpen = false; renderTerminalPage(); return;
  }
  if (t.closest('[data-eat-pick-cwd]')) { pickCwd(); return; }
  if (t.closest('[data-eat-launcher-toggle]')) { tp.launcherOpen = !tp.launcherOpen; renderTerminalPage(); return; }
  if (t.closest('[data-eat-search]')) { openSearch(); return; }
  if (t.closest('[data-eat-palette]')) { tp.paletteOpen = true; renderTerminalPage(); return; }
  if (t.closest('[data-eat-palette-scrim]') && !t.closest('.ea-term-palette-box')) {
    tp.paletteOpen = false; renderTerminalPage(); return;
  }
  const paletteAct = t.closest('[data-eat-palette-act]');
  if (paletteAct) { handlePaletteAction(paletteAct.dataset.eatPaletteAct); return; }
  const tabClose = t.closest('[data-eat-tab-close]');
  if (tabClose) { e.stopPropagation(); closeSession(tabClose.dataset.eatTabClose); return; }
  const sessionDelete = t.closest('[data-eat-session-delete]');
  if (sessionDelete) {
    e.preventDefault();
    e.stopPropagation();
    deleteTerminalSession(sessionDelete.dataset.eatSessionDelete);
    return;
  }
  const resume = t.closest('[data-eat-resume]');
  if (resume) { resumeGhostSession(resume.dataset.eatResume); return; }
  // 刷新模型列表
  if (t.closest('[data-eat-fetch-models]')) {
    fetchProviderModels(tp.launcher.providerKey, tp.launcher.tool);
    return;
  }
  // 自定义下拉：toggle / pick / outside-close
  const lcsToggle = t.closest('[data-eat-lcs-toggle]');
  if (lcsToggle) {
    const tp = getState().terminalPage;
    const name = lcsToggle.dataset.eatLcsToggle;
    tp._lcsOpen = (tp._lcsOpen === name) ? '' : name;
    renderTerminalPage();
    return;
  }
  const lcsPick = t.closest('[data-eat-lcs-pick]');
  if (lcsPick) {
    const tp = getState().terminalPage;
    const name = lcsPick.dataset.eatLcsPick;
    const val = lcsPick.dataset.value || '';
    tp.launcher[name] = val;
    tp._lcsOpen = '';
    renderTerminalPage();
    return;
  }
  // 点 launch page 内但不在下拉内 → 关下拉
  const tpForClose = getState()?.terminalPage;
  if (tpForClose?._lcsOpen && !t.closest('.ea-term-lcs')) {
    tpForClose._lcsOpen = '';
    renderTerminalPage();
    // 不 return — 继续走其它分支
  }
  // launcher 分段开关：工具 / 登录方式
  const segBtn = t.closest('[data-eat-launch-set]');
  if (segBtn) {
    const tp = getState().terminalPage;
    const key = segBtn.dataset.eatLaunchSet;
    const val = segBtn.dataset.value || '';
    tp.launcher[key] = val;
    if (key === 'tool') {
      // 工具换了 → provider 列表清空让重选
      tp.launcher.providerKey = '';
      tp.launcher.model = '';
      tp.launcher.modelCustom = '';
      if (val === 'claudecode') tp.launcher.source = 'provider';
    }
    renderTerminalPage();
    return;
  }
  if (t.closest('[data-eat-launch-more]')) {
    const tp = getState().terminalPage;
    tp.launcher.moreOpen = !tp.launcher.moreOpen;
    renderTerminalPage();
    return;
  }
  const restart = t.closest('[data-eat-restart]');
  if (restart) { restartGhostSession(restart.dataset.eatRestart); return; }
  const forget = t.closest('[data-eat-forget]');
  if (forget) { forgetGhostSession(forget.dataset.eatForget); return; }
  const tab = t.closest('[data-eat-tab]');
  if (tab) { tp.activeSessionId = tab.dataset.eatTab; renderTerminalPage(); return; }
  const secTab = t.closest('[data-eat-sec-tab]');
  if (secTab) { tp.activeSessionId = secTab.dataset.eatSecTab; renderTerminalPage(); return; }
  const action = t.closest('[data-eat-action]');
  if (action) { handleSidebarAction(action.dataset.eatAction); return; }
}

function onChange(e) {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const tp = getState().terminalPage;
  const key = t.getAttribute('data-eat-launch');
  if (!key) return;
  tp.launcher[key] = t.value || '';
  if (key === 'tool') {
    // 工具变 → provider 列表变；强制重 render
    tp.launcher.providerKey = '';
    tp.launcher.model = '';
    tp.launcher.modelCustom = '';
    renderTerminalPage();
  }
}

function onInput(e) {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const key = t.getAttribute('data-eat-launch');
  if (!key) return;
  // 文本字段：cwd / flags / model / profile 直接写
  if (['cwd', 'flags', 'model', 'profile'].includes(key)) {
    getState().terminalPage.launcher[key] = t.value || '';
  }
}

function onGlobalKey(e) {
  const st = getState();
  if (!st.terminalPage) return;
  if (st.activePage !== 'terminal') return;
  const shortcut = terminalShortcutModifier(e);
  const targetIsEditable = isEditableTarget(e.target);
  // ⌘K 命令面板
  if (!targetIsEditable && shortcut && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    st.terminalPage.paletteOpen = !st.terminalPage.paletteOpen;
    renderTerminalPage();
    return;
  }
  // ⌘F 搜索（针对当前 active session）
  if (!targetIsEditable && shortcut && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openSearch();
    return;
  }
  // ⌘+/⌘- 字号微调
  if (!targetIsEditable && shortcut && (e.key === '=' || e.key === '+')) {
    e.preventDefault(); bumpFontSize(+1); return;
  }
  if (!targetIsEditable && shortcut && e.key === '-') {
    e.preventDefault(); bumpFontSize(-1); return;
  }
  // ⌘T 新建终端
  if (!targetIsEditable && shortcut && e.key.toLowerCase() === 't') {
    e.preventDefault();
    st.terminalPage.launcherOpen = !st.terminalPage.launcherOpen;
    renderTerminalPage();
    return;
  }
  if (e.key === 'Escape') {
    if (st.terminalPage.paletteOpen) { st.terminalPage.paletteOpen = false; renderTerminalPage(); return; }
    if (st.terminalPage.launcherOpen) { st.terminalPage.launcherOpen = false; renderTerminalPage(); return; }
    closeSearch();
  }
}

function openSearch() {
  let bar = document.getElementById('eaTermSearch');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'eaTermSearch';
    bar.className = 'ea-term-search';
    bar.innerHTML = `
      <input type="text" id="eaTermSearchInput" placeholder="搜索 (Esc 关 · Enter 下一个 · Shift+Enter 上一个)" />
      <button type="button" data-eat-search-prev title="上一个 (Shift+Enter)">↑</button>
      <button type="button" data-eat-search-next title="下一个 (Enter)">↓</button>
      <button type="button" data-eat-search-close title="关闭 (Esc)">×</button>`;
    document.body.appendChild(bar);
    bar.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('[data-eat-search-close]')) { closeSearch(); return; }
      const tp = getState().terminalPage;
      const inst = tp.instances[tp.activeSessionId];
      if (!inst?.search) return;
      const q = document.getElementById('eaTermSearchInput')?.value || '';
      if (t.closest('[data-eat-search-prev]')) inst.search.findPrevious(q);
      if (t.closest('[data-eat-search-next]')) inst.search.findNext(q);
    });
    const input = bar.querySelector('input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeSearch(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const tp = getState().terminalPage;
        const inst = tp.instances[tp.activeSessionId];
        if (!inst?.search) return;
        const q = input.value || '';
        if (e.shiftKey) inst.search.findPrevious(q);
        else inst.search.findNext(q);
      }
    });
  }
  bar.classList.add('is-open');
  document.getElementById('eaTermSearchInput')?.focus();
}

function closeSearch() {
  const bar = document.getElementById('eaTermSearch');
  if (bar) bar.classList.remove('is-open');
  const tp = getState().terminalPage;
  const inst = tp?.instances?.[tp.activeSessionId];
  try { inst?.search?.clearDecorations(); } catch (_) {}
  try { inst?.term?.focus(); } catch (_) {}
}

function bumpFontSize(delta) {
  const tp = getState().terminalPage;
  const inst = tp.instances[tp.activeSessionId];
  if (!inst) return;
  const next = Math.max(10, Math.min(22, Number(inst.term.options.fontSize || 13) + delta));
  inst.term.options.fontSize = next;
  try { inst.fit.fit(); } catch (_) {}
  notifyResize(tp.activeSessionId, inst);
}

// 监听主题切换，同步所有已挂 instance 的 theme
(function bindThemeWatcher() {
  if (window.__eaTermThemeBound) return;
  window.__eaTermThemeBound = true;
  const apply = () => {
    const tp = getState?.()?.terminalPage;
    if (!tp) return;
    const theme = currentTermTheme();
    Object.values(tp.instances || {}).forEach((inst) => {
      try { inst.term.options.theme = theme; } catch (_) {}
    });
  };
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();

// 离开 terminal 页面时**不** dispose xterm 实例 — 让 scrollback / PTY 连接保留。
// 下次回到 terminal 页 mountTerminal 会重新 attach 到新 host，buffer 完整保留。
// 只关掉 search 框这种 UI 浮窗。
export function disposeTerminalInstances() {
  closeSearch();
  // 解 resize observer（DOM 变了再 observe 新的）
  const tp = getState()?.terminalPage;
  if (!tp) return;
  for (const inst of Object.values(tp.instances || {})) {
    try { inst.resizeObserver?.disconnect(); inst.resizeObserver = null; } catch (_) {}
    try { inst.hostCleanup?.(); inst.hostCleanup = null; inst.boundHost = null; } catch (_) {}
    // mountedTo 标记清除，下次回 terminal 页强制 re-attach
    inst.mountedTo = null;
  }
}
window.disposeTerminalInstances = disposeTerminalInstances;

function handlePaletteAction(act) {
  const tp = getState().terminalPage;
  if (act === 'spawn') { tp.paletteOpen = false; renderTerminalPage(); spawnSession(); return; }
  if (act === 'clear') { tp.paletteOpen = false; renderTerminalPage(); writeToActive(''); return; }
  if (act === 'close') { tp.paletteOpen = false; renderTerminalPage(); return; }
  if (act.startsWith('set-provider:')) {
    tp.launcher.providerKey = act.slice('set-provider:'.length);
    tp.paletteOpen = false; renderTerminalPage();
    return;
  }
}

function handleSidebarAction(act) {
  if (act === 'clear') { writeToActive(''); return; }
  if (act === 'kill') { writeToActive(''); return; } // SIGINT via ^C
  if (act === 'copy-cmd') {
    const tp = getState().terminalPage;
    const session = tp.sessions.find((s) => s.id === tp.activeSessionId);
    if (!session) return;
    navigator.clipboard?.writeText(session.command || '').then(() => flash('已复制命令', 'success')).catch(() => flash('复制失败', 'warning'));
  }
}

async function pickCwd() {
  try {
    const tp = getState().terminalPage;
    const initialPath = tp.launcher.cwd || '';
    const res = await api('/api/path/pick-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '选择工作目录', initialPath }),
    });
    if (res?.ok && res.data?.path) {
      tp.launcher.cwd = res.data.path;
      renderTerminalPage();
    } else if (res?.ok && !res.data?.path) {
      // 用户取消，不报错
    } else {
      flash(res?.error || '打开目录选择器失败', 'error');
    }
  } catch (err) {
    flash(`选择目录失败: ${err.message || err}`, 'error');
  }
}

// Token 兜底 poll：terminal-tokens push 是主源，poll 是 fallback。
// 自适应频率 + 仅 terminal 页可见时才跑：
//   - 当前会话还没 token 数据：2 秒/次（快速发现）
//   - 已拿到 token：6 秒/次（节流，避免狂打 lsof）
let __eaTermTokenPollTimer = 0;
function startTokenPollLoop() {
  if (__eaTermTokenPollTimer) return;
  const tick = async () => {
    try {
      const tp = getState()?.terminalPage;
      if (!tp) return;
      if (getState()?.activePage !== 'terminal') return;
      let interval = 6000;
      for (const s of tp.sessions) {
        if (!s.running) continue;
        try {
          const res = await api(`/api/terminal/token-snapshot?sessionId=${encodeURIComponent(s.id)}`);
          if (!res?.ok) { interval = 2000; continue; }
          const tokens = res.data?.tokens;
          if (tokens && Number.isFinite(tokens.input) && tokens.input > 0) {
            s.tokens = tokens;
            s.tokensUpdatedAt = Date.now();
            const inst = tp.instances?.[s.id];
            if (inst) { inst.tokens = tokens; inst.tokensUpdatedAt = Date.now(); }
          } else {
            interval = 2000;
          }
        } catch (_) { interval = 2000; }
      }
      renderTermStatus();
      if (__eaTermTokenPollTimer) clearTimeout(__eaTermTokenPollTimer);
      __eaTermTokenPollTimer = setTimeout(tick, interval);
    } catch (_) {
      __eaTermTokenPollTimer = setTimeout(tick, 6000);
    }
  };
  __eaTermTokenPollTimer = setTimeout(tick, 1500);
}
startTokenPollLoop();

async function spawnSession() {
  const tp = getState().terminalPage;
  if (tp.starting) return;
  const isCodex = tp.launcher.tool === 'codex';
  const isOfficial = isCodex && tp.launcher.source === 'official';
  const selectedProvider = selectedProviderRow(tp.launcher.tool, tp.launcher.providerKey);
  if (isCodex && !isOfficial && !tp.launcher.providerKey) { flash('请先选 provider', 'warning'); return; }
  // official 模式：必须选一个账号 + 用它的 codexHome 当 CODEX_HOME env
  let officialEnv = null;
  if (isOfficial) {
    if (!tp.launcher.officialProfileId) { flash('请先选 codex 账号', 'warning'); return; }
    const prof = tp.officialProfiles.find((p) => p.id === tp.launcher.officialProfileId);
    if (!prof?.codexHome) { flash('选中账号缺 codexHome', 'error'); return; }
    officialEnv = { CODEX_HOME: prof.codexHome };
  }
  if (!isCodex && selectedProvider?.homePath) {
    officialEnv = { ...(officialEnv || {}), CLAUDE_CONFIG_DIR: selectedProvider.homePath };
  }
  const bin = TOOL_LAUNCH_BIN[tp.launcher.tool] || tp.launcher.tool;
  // 组装 args：sandbox + model + reasoning + profile + 额外 flags
  const args = [];
  // model：'custom' → modelCustom 文本；其它非空 → 直接传
  const finalModel = tp.launcher.model === 'custom'
    ? (tp.launcher.modelCustom || '').trim()
    : tp.launcher.model;
  if (isCodex) {
    const sb = tp.launcher.sandbox;
    if (sb === 'bypass') args.push('--dangerously-bypass-approvals-and-sandbox');
    else if (sb === 'workspace-write') args.push('--sandbox', 'workspace-write');
    else if (sb === 'read-only') args.push('--sandbox', 'read-only');
    if (tp.launcher.profile) args.push('--profile', tp.launcher.profile);
    if (tp.launcher.reasoningEffort) {
      args.push('-c', `model_reasoning_effort="${tp.launcher.reasoningEffort}"`);
    }
  }
  if (finalModel) args.push('--model', finalModel);
  // 额外 raw 参数最后追
  const rawFlags = (tp.launcher.flags || '').trim().split(/\s+/).filter(Boolean);
  args.push(...rawFlags);
  const title = `${bin}${args.length ? ' ' + args[0] : ''}`;
  const commandPreview = [bin, ...args].join(' ');
  tp.starting = true;
  renderTerminalPage();
  try {
    // 后端期望 program + args，不是 command 数组
    const res = await api('/api/terminal/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: tp.launcher.tool,
        program: bin,
        args,
        cwd: tp.launcher.cwd || '',
        env: officialEnv || undefined,
        title,
        commandPreview,
        cols: 120,
        rows: 32,
      }),
    });
    if (res?.ok && res.data?.terminalSession) {
      const session = normalizeSession(res.data.terminalSession);
      // 记下原始 spawn 参数 — 给 [重启] 用
      session.program = bin;
      session.args = args;
      session.tool = tp.launcher.tool;
      session.cwd = tp.launcher.cwd || session.cwd || '';
      tp.sessions.unshift(session);
      tp.activeSessionId = session.id;
      tp.launcherOpen = false; // 启动后自动收 popover
      persistOneSession(session);
      flash(`已启动 ${bin}`, 'success');
    } else {
      flash(`启动失败: ${res?.error || '未知'}`, 'error');
    }
  } catch (err) {
    flash(`启动异常: ${err.message || err}`, 'error');
  } finally {
    tp.starting = false;
    renderTerminalPage();
  }
}

// 用 `codex resume <id>` 接着上次对话继续 — 完整上下文 + 历史消息全部回来
async function resumeGhostSession(sessionId) {
  const tp = getState().terminalPage;
  const ghost = tp.sessions.find((s) => s.id === sessionId);
  if (!ghost || !ghost.codexSessionId) {
    flash('缺少 codex session id，无法 resume', 'warning');
    return;
  }
  const bin = ghost.program || 'codex';
  // codex resume <session-id> + 原始 flags（去掉 resume 本身）
  const origArgs = Array.isArray(ghost.args) ? ghost.args.filter((a) => a !== 'resume' && !a.startsWith('--last')) : [];
  const args = ['resume', ghost.codexSessionId, ...origArgs];
  try {
    const res = await api('/api/terminal/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: ghost.tool, program: bin, args,
        cwd: ghost.cwd || '', title: `codex ↩ ${ghost.codexSessionId.slice(0, 8)}`,
        commandPreview: [bin, ...args].join(' '),
        cols: 120, rows: 32,
      }),
    });
    if (res?.ok && res.data?.terminalSession) {
      const fresh = normalizeSession(res.data.terminalSession);
      fresh.program = bin; fresh.args = args; fresh.tool = ghost.tool; fresh.cwd = ghost.cwd;
      fresh.codexSessionId = ghost.codexSessionId; // 复用同一个 codex session id
      const idx = tp.sessions.findIndex((s) => s.id === sessionId);
      if (idx >= 0) tp.sessions[idx] = fresh;
      else tp.sessions.unshift(fresh);
      tp.activeSessionId = fresh.id;
      forgetPersistedSession(sessionId);
      persistOneSession(fresh);
      flash('已接续 codex 会话', 'success');
    } else {
      flash(`resume 失败: ${res?.error || '未知'}`, 'error');
    }
  } catch (err) {
    flash(`resume 异常: ${err.message || err}`, 'error');
  }
  renderTerminalPage();
}

async function restartGhostSession(sessionId) {
  const tp = getState().terminalPage;
  const ghost = tp.sessions.find((s) => s.id === sessionId);
  if (!ghost) return;
  const bin = ghost.program || (ghost.tool === 'codex' ? 'codex' : ghost.tool === 'claudecode' ? 'claude' : 'codex');
  const args = Array.isArray(ghost.args) ? ghost.args : [];
  // 直接调 spawn 接口（绕过 launcher 表单）
  try {
    const res = await api('/api/terminal/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: ghost.tool, program: bin, args,
        cwd: ghost.cwd || '', title: ghost.title || bin,
        commandPreview: ghost.command || [bin, ...args].join(' '),
        cols: 120, rows: 32,
      }),
    });
    if (res?.ok && res.data?.terminalSession) {
      const fresh = normalizeSession(res.data.terminalSession);
      fresh.program = bin; fresh.args = args; fresh.tool = ghost.tool; fresh.cwd = ghost.cwd;
      // 替换 ghost
      const idx = tp.sessions.findIndex((s) => s.id === sessionId);
      if (idx >= 0) tp.sessions[idx] = fresh;
      else tp.sessions.unshift(fresh);
      tp.activeSessionId = fresh.id;
      // SQLite 里把旧 ghost id 删了再写新 id（活的 session id 跟着）
      forgetPersistedSession(sessionId);
      persistOneSession(fresh);
      flash('已重启会话', 'success');
    } else {
      flash(`重启失败: ${res?.error || '未知'}`, 'error');
    }
  } catch (err) {
    flash(`重启异常: ${err.message || err}`, 'error');
  }
  renderTerminalPage();
}

function forgetGhostSession(sessionId) {
  const tp = getState().terminalPage;
  tp.sessions = tp.sessions.filter((s) => s.id !== sessionId);
  if (tp.activeSessionId === sessionId) tp.activeSessionId = tp.sessions[0]?.id || '';
  forgetPersistedSession(sessionId);
  renderTerminalPage();
}

function deleteTerminalSession(sessionId) {
  const tp = getState()?.terminalPage;
  if (!tp || !sessionId) return;
  const sess = tp.sessions.find((s) => s.id === sessionId);
  if (sess?._ghost) {
    forgetGhostSession(sessionId);
    return;
  }
  closeSession(sessionId);
}

async function closeSession(sessionId) {
  const tp = getState().terminalPage;
  try {
    await api('/api/terminal/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch (_) {}
  // 拆 instance
  const inst = tp.instances[sessionId];
  if (inst) {
    try { clearInterval(inst.pollTimer); } catch (_) {}
    try { inst.term.dispose(); } catch (_) {}
    delete tp.instances[sessionId];
  }
  tp.sessions = tp.sessions.filter((s) => s.id !== sessionId);
  if (tp.activeSessionId === sessionId) {
    tp.activeSessionId = tp.sessions[0]?.id || '';
  }
  // 用户手动 close = 完全删，SQLite 里也清掉
  forgetPersistedSession(sessionId);
  renderTerminalPage();
}

// xterm theme — 抄 Neox 的方法：动态读 page 真实 bg 色给 xterm，
// 终端跟 page 完全一色，无视觉边界。
function readCssVar(name, fallback) {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function parseColorLuminance(color) {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (hex) return parseInt(hex[1], 16) * 0.299 + parseInt(hex[2], 16) * 0.587 + parseInt(hex[3], 16) * 0.114;
  const rgb = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (rgb) return parseInt(rgb[1]) * 0.299 + parseInt(rgb[2]) * 0.587 + parseInt(rgb[3]) * 0.114;
  return null;
}
// 取真实背景：优先读 app 的权威 --bg 变量；fallback 到 host / body 计算 bg
function resolveRealBgColor() {
  if (typeof document === 'undefined') return '#0b1020';
  const bgVar = readCssVar('--bg', '');
  if (bgVar && parseColorLuminance(bgVar) !== null) return bgVar;
  const host = document.getElementById('eaTermHost');
  for (const el of [host, document.body, document.documentElement]) {
    if (!el) continue;
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
      if (parseColorLuminance(bg) !== null) return bg;
    }
  }
  return document.documentElement.dataset.theme === 'light' ? '#f5f7fa' : '#090c12';
}
function isCanvasDark() {
  const lum = parseColorLuminance(resolveRealBgColor());
  return lum != null ? lum < 128 : true;
}
function currentTermTheme() {
  const bg = resolveRealBgColor();
  const isDark = isCanvasDark();
  const fg = isDark ? readCssVar('--s2-text', '#e6ecf5') : readCssVar('--s2-text', '#0f172a');
  if (isDark) {
    return {
      background: bg, foreground: fg,
      cursor: '#8dbdff', cursorAccent: bg,
      selectionBackground: 'rgba(91,140,255,0.36)',
      black: '#1a1f2e', red: '#ff6b6d', green: '#5dd39e', yellow: '#ffd166',
      blue: '#5b8cff', magenta: '#c084fc', cyan: '#5eead4', white: '#c9d1d9',
      brightBlack: '#3d4452', brightRed: '#ff8085', brightGreen: '#7bf1b8',
      brightYellow: '#ffe085', brightBlue: '#7da6ff', brightMagenta: '#d4b0ff',
      brightCyan: '#80f0d6', brightWhite: '#f6f8fa',
    };
  }
  return {
    background: bg, foreground: fg,
    cursor: '#3358ff', cursorAccent: bg,
    selectionBackground: 'rgba(51,88,255,0.22)',
    black: '#0f172a', red: '#D63A3A', green: '#1F8C4D', yellow: '#B27800',
    blue: '#2563EB', magenta: '#7C3AED', cyan: '#0E7490', white: '#3A3F4D',
    brightBlack: '#6B7080', brightRed: '#E04545', brightGreen: '#28A75F',
    brightYellow: '#C28800', brightBlue: '#3B7BFA', brightMagenta: '#9755F0',
    brightCyan: '#1A8DA8', brightWhite: '#141824',
  };
}

function mountTerminal(sessionId) {
  const tp = getState().terminalPage;
  const hostEl = document.getElementById('eaTermHost');
  if (!hostEl) return;
  let inst = tp.instances[sessionId];

  // 已经挂在当前 host：什么都不做，避免每次 renderTerminalPage 都重 attach
  if (inst && inst.mountedTo === hostEl) {
    try { inst.term.focus(); } catch (_) {}
    return;
  }

  if (!inst) {
    // 等所有 in-flight 字体加载完成再创建，避免 fallback 字体测量错 glyph 宽度
    const start = () => {
      if (tp.instances[sessionId]) return; // 已被并发创建
      const isDark = isCanvasDark();
      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: isDark ? 'block' : 'bar',
        cursorInactiveStyle: 'outline',
        fontFamily: '"MesloLGS NF", "JetBrainsMono Nerd Font", "FiraCode Nerd Font Mono", "SF Mono", "Menlo", "Consolas", monospace',
        fontSize: 13,
        lineHeight: 1.15,
        letterSpacing: 0,
        scrollback: 10000,
        scrollSensitivity: 1,
        fastScrollModifier: 'alt',
        fastScrollSensitivity: 5,
        theme: currentTermTheme(),
        allowProposedApi: true,
        macOptionIsMeta: true,
        altClickMovesCursor: true,
        rightClickSelectsWord: true,
        minimumContrastRatio: 4.5,
        drawBoldTextInBrightColors: true,
        tabStopWidth: 8,
        customGlyphs: true,
      });
      const fit = new FitAddon();
      const webLinks = new WebLinksAddon((event, uri) => {
        try {
          if (typeof window.openExternalUrl === 'function') window.openExternalUrl(uri);
          else window.open(uri, '_blank');
        } catch (_) { window.open(uri, '_blank'); }
      });
      const search = new SearchAddon();
      const unicode = new Unicode11Addon();
      term.loadAddon(fit);
      term.loadAddon(webLinks);
      term.loadAddon(search);
      try {
        term.loadAddon(unicode);
        term.unicode.activeVersion = '11';
      } catch (_) {}

      const instance = {
        term, fit, search, unicode,
        cursor: 0,
        mountedTo: null,
        pollTimer: 0,
        sentBytes: 0,
        recvBytes: 0,
        lastResize: { cols: 0, rows: 0 },
        resizeObserver: null,
        hostCleanup: null,
        boundHost: null,
        keyHandlerInstalled: false,
        webgl: null,
        firstChunk: true,
      };
      tp.instances[sessionId] = instance;

      const target = document.getElementById('eaTermHost');
      if (!target) return;
      if (!attachTerminalElement(sessionId, instance, target)) return;
      installTerminalKeyHandler(sessionId, instance);
      bindTerminalHostInteractions(sessionId, instance, target);
      enableTerminalRenderAddons(instance);
      scheduleTerminalFit(sessionId, instance, target);
      // 从 Rust 拉一次完整 PTY 缓存 — 新挂载时把已经输出的内容灌回来。
      readTerminalOutput(sessionId, instance, { cursor: 0 });

      term.onData((data) => {
        instance.sentBytes += utf8ByteLength(data);
        sendInput(sessionId, data).catch(() => {});
      });

      // ResizeObserver，rAF coalesce，0×0 直接跳过
      if (typeof ResizeObserver === 'function') {
        let rafId = 0;
        instance.resizeObserver = new ResizeObserver(() => {
          if (rafId) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            if (target.clientWidth === 0 || target.clientHeight === 0) return;
            try { fit.fit(); } catch (_) {}
            notifyResize(sessionId, instance);
          });
        });
        instance.resizeObserver.observe(target);
      }

      // 推送流是唯一数据源 — 不再 setInterval 轮询，避免和 push 重叠导致内容重复
      try { term.focus(); } catch (_) {}
    };
    if (document.fonts?.ready) document.fonts.ready.then(start, start);
    else start();
    return;
  }

  // 已有实例但 mountedTo 是旧 host（被 innerHTML 替换掉了）→ re-attach 到当前 host。
  // xterm 的 open() 不是可靠的二次挂载 API；直接移动已存在的 DOM，保留 buffer / PTY / scrollback。
  try { inst.term.options.theme = currentTermTheme(); } catch (_) {}
  if (!attachTerminalElement(sessionId, inst, hostEl)) return;
  installTerminalKeyHandler(sessionId, inst);
  bindTerminalHostInteractions(sessionId, inst, hostEl);
  enableTerminalRenderAddons(inst);
  // ResizeObserver 之前断开了，要重新接上，否则切回来 size 变化不响应
  if (typeof ResizeObserver === 'function' && !inst.resizeObserver) {
    let rafId = 0;
    inst.resizeObserver = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (hostEl.clientWidth === 0 || hostEl.clientHeight === 0) return;
        try { inst.fit.fit(); } catch (_) {}
        notifyResize(sessionId, inst);
      });
    });
    inst.resizeObserver.observe(hostEl);
  }
  scheduleTerminalFit(sessionId, inst, hostEl);
  // 切页回来时事件流可能已经写进 xterm，但 canvas 脱离 DOM 后不会自动重绘；
  // 再补一次后端 buffer 增量，保证 Tauri 事件丢帧时也能恢复。
  readTerminalOutput(sessionId, inst);
  try { inst.term.focus(); } catch (_) {}
}

function attachTerminalElement(sessionId, inst, hostEl) {
  if (!inst?.term || !hostEl) return false;
  try {
    const existingElement = inst.term.element;
    if (existingElement) {
      if (existingElement.parentElement !== hostEl) {
        hostEl.replaceChildren(existingElement);
      }
    } else {
      inst.term.open(hostEl);
    }
    inst.mountedTo = hostEl;
    return true;
  } catch (error) {
    console.warn('[terminal] attach failed', sessionId, error);
    return false;
  }
}

function installTerminalKeyHandler(sessionId, inst) {
  if (!inst?.term || inst.keyHandlerInstalled) return;
  inst.keyHandlerInstalled = true;
  try {
    inst.term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const key = String(event.key || '').toLowerCase();
      const apple = isApplePlatform();
      const copyShortcut = (apple && event.metaKey && key === 'c') || (!apple && event.ctrlKey && event.shiftKey && key === 'c');
      const pasteShortcut = (apple && event.metaKey && key === 'v') || (!apple && event.ctrlKey && event.shiftKey && key === 'v');
      const selectAllShortcut = apple && event.metaKey && key === 'a';
      if (copyShortcut) {
        const selection = inst.term.getSelection?.() || '';
        if (selection) copyTerminalSelection(inst);
        return false;
      }
      if (pasteShortcut) {
        pasteFromClipboard(sessionId, inst);
        return false;
      }
      if (selectAllShortcut) {
        try { inst.term.selectAll(); } catch (_) {}
        return false;
      }
      return true;
    });
  } catch (_) {}
}

function bindTerminalHostInteractions(sessionId, inst, hostEl) {
  if (!inst?.term || !hostEl) return;
  if (inst.boundHost === hostEl) return;
  try { inst.hostCleanup?.(); } catch (_) {}
  const focusTerm = () => {
    try { inst.term.focus(); } catch (_) {}
  };
  const onCopy = (event) => {
    const selection = inst.term.getSelection?.() || '';
    if (!selection) return;
    try {
      event.clipboardData?.setData('text/plain', selection);
      event.preventDefault();
    } catch (_) {}
  };
  const onPaste = (event) => {
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!text) return;
    event.preventDefault();
    pasteTextToTerminal(sessionId, inst, text);
  };
  const onContextMenu = (event) => {
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
    const selection = inst.term.getSelection?.() || '';
    if (selection) {
      copyTerminalSelection(inst);
      return;
    }
    pasteFromClipboard(sessionId, inst);
  };
  const onAuxClick = (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    pasteFromClipboard(sessionId, inst);
  };
  const onDragOver = (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files || []);
    const paths = files
      .map((file) => file.path || file.webkitRelativePath || file.name || '')
      .filter(Boolean);
    const plainText = event.dataTransfer.getData('text/plain') || '';
    const text = paths.length ? paths.map(shellQuotePath).join(' ') : plainText;
    if (text) pasteTextToTerminal(sessionId, inst, text);
  };
  hostEl.addEventListener('mousedown', focusTerm);
  hostEl.addEventListener('copy', onCopy);
  hostEl.addEventListener('paste', onPaste);
  hostEl.addEventListener('contextmenu', onContextMenu);
  hostEl.addEventListener('auxclick', onAuxClick);
  hostEl.addEventListener('dragover', onDragOver);
  hostEl.addEventListener('drop', onDrop);
  inst.boundHost = hostEl;
  inst.hostCleanup = () => {
    hostEl.removeEventListener('mousedown', focusTerm);
    hostEl.removeEventListener('copy', onCopy);
    hostEl.removeEventListener('paste', onPaste);
    hostEl.removeEventListener('contextmenu', onContextMenu);
    hostEl.removeEventListener('auxclick', onAuxClick);
    hostEl.removeEventListener('dragover', onDragOver);
    hostEl.removeEventListener('drop', onDrop);
  };
}

function enableTerminalRenderAddons(inst) {
  if (!inst?.term || inst.webgl || inst.webglUnavailable) return;
  const attach = () => {
    if (inst.webgl || inst.webglUnavailable) return;
    if (!inst.term.element?.isConnected) return;
    try {
      const webgl = new WebglAddon();
      inst.term.loadAddon(webgl);
      if (typeof webgl.onContextLoss === 'function') {
        webgl.onContextLoss((event) => {
          try { event?.preventDefault?.(); } catch (_) {}
          try { webgl.dispose(); } catch (_) {}
          inst.webgl = null;
          inst.webglUnavailable = true;
        });
      }
      inst.webgl = webgl;
    } catch (_) {
      inst.webglUnavailable = true;
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(attach);
  else setTimeout(attach, 0);
}

function copyTerminalSelection(inst) {
  const selection = inst?.term?.getSelection?.() || '';
  if (!selection) return false;
  try {
    navigator.clipboard?.writeText(selection).catch(() => {});
    return true;
  } catch (_) {
    return false;
  }
}

async function pasteFromClipboard(sessionId, inst) {
  try {
    const text = await navigator.clipboard?.readText?.();
    if (text) pasteTextToTerminal(sessionId, inst, text);
  } catch (_) {}
}

function pasteTextToTerminal(sessionId, inst, text) {
  const data = normalizeTerminalPaste(text);
  if (!data) return;
  try {
    if (typeof inst.term.paste === 'function') inst.term.paste(data);
    else sendInput(sessionId, data).catch(() => {});
  } catch (_) {
    sendInput(sessionId, data).catch(() => {});
  }
  try { inst.term.focus(); } catch (_) {}
}

function scheduleTerminalFit(sessionId, inst, hostEl) {
  const fitOnce = () => {
    try {
      if (!hostEl?.isConnected || hostEl.clientWidth === 0 || hostEl.clientHeight === 0) return;
      inst.fit.fit();
      inst.term.refresh(0, Math.max(0, inst.term.rows - 1));
      notifyResize(sessionId, inst);
    } catch (_) {}
  };
  requestAnimationFrame(fitOnce);
  setTimeout(fitOnce, 0);
  setTimeout(fitOnce, 80);
}

function scheduleMountedTerminalFits() {
  const tp = getState()?.terminalPage;
  if (!tp || getState()?.activePage !== 'terminal') return;
  for (const [sessionId, inst] of Object.entries(tp.instances || {})) {
    const hostEl = inst?.mountedTo;
    if (!hostEl?.isConnected) continue;
    scheduleTerminalFit(sessionId, inst, hostEl);
  }
}

function installTerminalViewportListeners() {
  if (window.__eaTermViewportBound) return;
  window.__eaTermViewportBound = true;
  let timer = 0;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      scheduleMountedTerminalFits();
    }, 40);
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('focus', schedule);
  window.addEventListener('pageshow', schedule);
  window.addEventListener('orientationchange', schedule);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule();
  });
}
installTerminalViewportListeners();

function notifyResize(sessionId, inst) {
  try {
    const cols = inst.term.cols, rows = inst.term.rows;
    if (cols && rows && (cols !== inst.lastResize.cols || rows !== inst.lastResize.rows)) {
      inst.lastResize = { cols, rows };
      api('/api/terminal/resize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, cols, rows }),
      }).catch(() => {});
    }
  } catch (_) {}
}

async function sendInput(sessionId, data) {
  try {
    await api('/api/terminal/write', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, data }),
    });
  } catch (_) {}
}

async function pollOutput(sessionId) {
  const tp = getState().terminalPage;
  const inst = tp.instances[sessionId];
  if (!inst) return;
  await readTerminalOutput(sessionId, inst);
}

async function readTerminalOutput(sessionId, inst, opts = {}) {
  const tp = getState().terminalPage;
  if (inst._reading) return;
  inst._reading = true;
  try {
    const startCursor = opts.cursor != null ? opts.cursor : (inst.cursor || 0);
    const params = new URLSearchParams({ sessionId, cursor: String(startCursor) });
    const res = await api(`/api/terminal/read?${params.toString()}`);
    if (res?.ok && res.data) {
      let data = res.data.data || '';
      const currentCursor = Number(inst.cursor || 0);
      if (currentCursor > startCursor && data) {
        data = dropUtf8PrefixBytes(data, currentCursor - startCursor);
      }
      // 首条数据去掉前导 \n / \r\n（shell rc / starship 习惯先打空行让 prompt 错开行）
      if (data && inst.firstChunk) {
        inst.firstChunk = false;
        data = data.replace(/^(?:\r?\n)+/, '');
      }
      if (data) {
        inst.term.write(data);
        inst.recvBytes += utf8ByteLength(data);
      }
      if (typeof res.data.cursor === 'number') inst.cursor = Math.max(Number(inst.cursor || 0), res.data.cursor);
      const sess = tp.sessions.find((s) => s.id === sessionId);
      if (sess && res.data.session) {
        sess.running = Boolean(res.data.session.running);
        sess.exitCode = res.data.session.exitCode ?? sess.exitCode;
      }
    }
  } catch (_) {
  } finally {
    inst._reading = false;
  }
}

function writeToActive(data) {
  const tp = getState().terminalPage;
  if (!tp.activeSessionId) return;
  sendInput(tp.activeSessionId, data).catch(() => {});
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatRelative(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.round(diff / 60000)} 分钟前`;
  if (diff < 24 * 3600 * 1000) return `${Math.round(diff / 3600000)} 小时前`;
  return `${Math.round(diff / 86400000)} 天前`;
}

// 暴露给 app.js setPage 调用
window.renderTerminalPage = renderTerminalPage;
window.initTerminalPageState = initTerminalPageState;
