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

const POLL_INTERVAL_MS = 220;

const TOOL_LAUNCH_BIN = {
  codex: 'codex',
  claudecode: 'claude',
};

function getState() { return window.state; }
function api(path, opts) { return window.api(path, opts); }
function flash(msg, type) { return typeof window.flash === 'function' ? window.flash(msg, type) : console.log(`[flash:${type || ''}] ${msg}`); }
function escapeHtml(v) { return typeof window.escapeHtml === 'function' ? window.escapeHtml(v) : String(v ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] || c)); }

export function initTerminalPageState() {
  const st = getState();
  if (st.terminalPage) return;
  st.terminalPage = {
    sessions: [],            // [{ id, tool, title, command, createdAt, running, cwd }]
    activeSessionId: '',
    launcher: {
      tool: 'codex',
      providerKey: '',
      cwd: '',
      flags: '--dangerously-bypass-approvals-and-sandbox',
    },
    paletteOpen: false,
    instances: {},           // sessionId -> { term, fit, cursor, container, pollTimer, sentBytes, recvBytes }
    sidebarOpen: true,
    starting: false,
  };
}

export async function renderTerminalPage() {
  initTerminalPageState();
  const host = document.getElementById('eaTerminalPage');
  if (!host) return;
  const st = getState();
  const tp = st.terminalPage;

  // 首次进来：拉一次现有 sessions
  if (!tp._loadedOnce) {
    tp._loadedOnce = true;
    try {
      const res = await api('/api/terminal/list');
      if (res?.ok && Array.isArray(res.data?.sessions)) {
        tp.sessions = res.data.sessions.map(normalizeSession);
        if (!tp.activeSessionId && tp.sessions[0]) tp.activeSessionId = tp.sessions[0].id;
      }
    } catch (_) {}
  }

  const codexProviders = listProviderRows('codex');
  const claudeProviders = listProviderRows('claudecode');
  const allProviders = tp.launcher.tool === 'codex' ? codexProviders : claudeProviders;

  // 默认填一个 provider（如果没选）
  if (!tp.launcher.providerKey) {
    const active = allProviders.find((p) => p.isActive);
    tp.launcher.providerKey = active?.key || allProviders[0]?.key || '';
  }

  host.innerHTML = `
    <div class="ea-term-shell">
      ${renderTopBar(tp, allProviders)}
      ${renderTabStrip(tp)}
      <div class="ea-term-canvas">
        <div class="ea-term-host" id="eaTermHost"></div>
        ${tp.sessions.length ? '' : '<div class="ea-term-empty">还没有会话 · 选好 Provider 点 <strong>启动</strong> · 或 <kbd>⌘K</kbd> 打开命令面板</div>'}
      </div>
      ${renderStatusBar(tp)}
    </div>
    ${tp.paletteOpen ? renderPalette(tp, allProviders) : ''}
  `;

  bindEvents(host);
  // 重挂当前 active 的 xterm 到 #eaTermHost（若已存在 instance 则复用）
  const active = tp.sessions.find((s) => s.id === tp.activeSessionId);
  if (active) {
    mountTerminal(active.id);
  }
}

function renderTopBar(tp, providers) {
  const esc = escapeHtml;
  const opts = providers.map((p) => `<option value="${esc(p.key)}" ${p.key === tp.launcher.providerKey ? 'selected' : ''}>${p.isActive ? '● ' : ''}${esc(p.name || p.key)}</option>`).join('');
  // 一行：工具 + provider + cwd + flags + 启动；没有右侧 icon chips
  return `
    <div class="ea-term-topbar">
      <select class="ea-term-mini-select" data-eat-launch="tool" title="选工具 (⌘K 内可切)">
        <option value="codex" ${tp.launcher.tool === 'codex' ? 'selected' : ''}>Codex</option>
        <option value="claudecode" ${tp.launcher.tool === 'claudecode' ? 'selected' : ''}>Claude Code</option>
      </select>
      <select class="ea-term-mini-select" data-eat-launch="providerKey" title="选 provider">${opts || '<option value="">无可用 provider</option>'}</select>
      <input type="text" class="ea-term-mini-input" data-eat-launch="cwd" placeholder="cwd · 默认 $HOME" value="${esc(tp.launcher.cwd || '')}" title="工作目录"/>
      <input type="text" class="ea-term-mini-input ea-term-mini-input-flags" data-eat-launch="flags" value="${esc(tp.launcher.flags || '')}" placeholder="启动参数" title="启动参数"/>
      <button type="button" class="ea-term-mini-btn ea-term-mini-btn-primary ${tp.starting ? 'is-busy' : ''}" data-eat-spawn ${tp.starting ? 'disabled' : ''}>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v12l10-6z"/></svg>
        ${tp.starting ? '启动中' : '启动'}
      </button>
    </div>`;
}

function renderStatusBar(tp) {
  const esc = escapeHtml;
  const session = tp.sessions.find((s) => s.id === tp.activeSessionId);
  if (!session) {
    return `<div class="ea-term-status"><span class="ea-term-status-faint">没有运行中的会话</span></div>`;
  }
  const inst = tp.instances[session.id];
  const recv = inst?.recvBytes || 0;
  const sent = inst?.sentBytes || 0;
  const approxTokens = Math.round(recv / 4);
  return `
    <div class="ea-term-status">
      <span class="ea-term-status-dot ${session.running ? 'is-on' : 'is-off'}"></span>
      <span class="ea-term-status-text">${esc(session.title || session.command || '')}</span>
      <span class="ea-term-status-sep">·</span>
      <span class="ea-term-status-text-faint">${esc(session.running ? '运行中' : '已退出')}</span>
      ${session.cwd ? `<span class="ea-term-status-sep">·</span><span class="ea-term-status-text-faint ea-term-status-cwd" title="${esc(session.cwd)}">${esc(session.cwd)}</span>` : ''}
      <span class="ea-term-status-spacer"></span>
      <span class="ea-term-status-pill">读 ${esc(fmtBytes(recv))}</span>
      <span class="ea-term-status-pill">写 ${esc(fmtBytes(sent))}</span>
      <span class="ea-term-status-pill ea-term-status-pill-tokens">≈ ${esc(approxTokens.toLocaleString())} tokens</span>
    </div>`;
}

function renderTabStrip(tp) {
  const esc = escapeHtml;
  if (!tp.sessions.length) return '<div class="ea-term-tabs ea-term-tabs-empty"></div>';
  return `
    <div class="ea-term-tabs">
      ${tp.sessions.map((s) => `
        <button type="button" class="ea-term-tab ${s.id === tp.activeSessionId ? 'is-active' : ''}" data-eat-tab="${esc(s.id)}">
          <span class="ea-term-tab-dot ${s.running ? 'is-on' : ''}"></span>
          <span class="ea-term-tab-label">${esc(s.title || s.command || s.id.slice(0, 8))}</span>
          <span class="ea-term-tab-close" data-eat-tab-close="${esc(s.id)}" title="关闭">×</span>
        </button>`).join('')}
    </div>`;
}

function renderSidebar(tp) {
  const esc = escapeHtml;
  const session = tp.sessions.find((s) => s.id === tp.activeSessionId);
  const inst = session ? tp.instances[session.id] : null;
  const sent = inst?.sentBytes ?? 0;
  const recv = inst?.recvBytes ?? 0;
  // 粗估 token：大概 4 char ≈ 1 token (英文)；中文密集时偏低，但用作展示足够
  const approxTokens = Math.round(recv / 4);
  return `
    <aside class="ea-term-side">
      <div class="ea-term-side-section">
        <div class="ea-term-side-eyebrow">CURRENT</div>
        ${session ? `
          <div class="ea-term-side-title">${esc(session.title || session.command || '')}</div>
          <div class="ea-term-side-meta">
            <span class="ea-term-side-status ${session.running ? 'is-on' : 'is-off'}">${session.running ? '运行中' : '已退出'}</span>
            <span>${esc(formatRelative(session.createdAt))}</span>
          </div>
          ${session.cwd ? `<div class="ea-term-side-cwd"><span>CWD</span><code>${esc(session.cwd)}</code></div>` : ''}
        ` : `<div class="ea-term-side-empty">未选会话</div>`}
      </div>
      <div class="ea-term-side-section">
        <div class="ea-term-side-eyebrow">STREAM</div>
        <div class="ea-term-side-rows">
          <div class="ea-term-side-row"><span>已读字节</span><strong>${esc(fmtBytes(recv))}</strong></div>
          <div class="ea-term-side-row"><span>已写字节</span><strong>${esc(fmtBytes(sent))}</strong></div>
          <div class="ea-term-side-row"><span>估算 tokens</span><strong>≈ ${esc(approxTokens.toLocaleString())}</strong></div>
        </div>
      </div>
      <div class="ea-term-side-section">
        <div class="ea-term-side-eyebrow">ACTIONS</div>
        <div class="ea-term-side-actions">
          <button type="button" class="ea-term-side-btn" data-eat-action="clear">⌃L 清屏</button>
          <button type="button" class="ea-term-side-btn" data-eat-action="copy-cmd">复制启动命令</button>
          <button type="button" class="ea-term-side-btn ea-term-side-btn-danger" data-eat-action="kill" ${!session?.running ? 'disabled' : ''}>结束进程</button>
        </div>
      </div>
    </aside>`;
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
    return window.__chBuildRows(tool).filter((r) => r.mode === 'apikey' && !r.historyOnly && r.hasCredential);
  } catch (_) { return []; }
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
  // 一次性 wire（避免每次 render 重复绑）
  if (host.dataset.eatBound === '1') return;
  host.dataset.eatBound = '1';
  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  host.addEventListener('input', onInput);
  // 全局 Cmd+K
  if (!window.__eaTermKeyBound) {
    window.__eaTermKeyBound = true;
    window.addEventListener('keydown', onGlobalKey);
  }
}

function onClick(e) {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const tp = getState().terminalPage;
  if (t.closest('[data-eat-spawn]')) { spawnSession(); return; }
  if (t.closest('[data-eat-launcher-toggle]')) { tp._launcherOpen = !tp._launcherOpen; renderTerminalPage(); return; }
  if (t.closest('[data-eat-search]')) { openSearch(); return; }
  if (t.closest('[data-eat-palette]')) { tp.paletteOpen = true; renderTerminalPage(); return; }
  if (t.closest('[data-eat-palette-scrim]') && !t.closest('.ea-term-palette-box')) {
    tp.paletteOpen = false; renderTerminalPage(); return;
  }
  const paletteAct = t.closest('[data-eat-palette-act]');
  if (paletteAct) { handlePaletteAction(paletteAct.dataset.eatPaletteAct); return; }
  const tabClose = t.closest('[data-eat-tab-close]');
  if (tabClose) { e.stopPropagation(); closeSession(tabClose.dataset.eatTabClose); return; }
  const tab = t.closest('[data-eat-tab]');
  if (tab) { tp.activeSessionId = tab.dataset.eatTab; renderTerminalPage(); return; }
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
    renderTerminalPage();
  }
}

function onInput(e) {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const key = t.getAttribute('data-eat-launch');
  if (key === 'cwd' || key === 'flags') {
    getState().terminalPage.launcher[key] = t.value || '';
  }
}

function onGlobalKey(e) {
  const st = getState();
  if (!st.terminalPage) return;
  if (st.activePage !== 'terminal') return;
  const meta = e.metaKey || e.ctrlKey;
  // ⌘K 命令面板
  if (meta && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    st.terminalPage.paletteOpen = !st.terminalPage.paletteOpen;
    renderTerminalPage();
    return;
  }
  // ⌘F 搜索（针对当前 active session）
  if (meta && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openSearch();
    return;
  }
  // ⌘+/⌘- 字号微调
  if (meta && (e.key === '=' || e.key === '+')) {
    e.preventDefault(); bumpFontSize(+1); return;
  }
  if (meta && e.key === '-') {
    e.preventDefault(); bumpFontSize(-1); return;
  }
  if (e.key === 'Escape') {
    if (st.terminalPage.paletteOpen) { st.terminalPage.paletteOpen = false; renderTerminalPage(); return; }
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

// 离开 terminal 页面时清理（disposeAll）
export function disposeTerminalInstances() {
  const tp = getState()?.terminalPage;
  if (!tp) return;
  for (const inst of Object.values(tp.instances || {})) {
    try { clearInterval(inst.pollTimer); } catch (_) {}
    try { inst.resizeObserver?.disconnect(); } catch (_) {}
    try { inst.webglAddon?.dispose(); } catch (_) {}
    try { inst.term?.dispose(); } catch (_) {}
  }
  tp.instances = {};
  closeSearch();
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

async function spawnSession() {
  const tp = getState().terminalPage;
  if (tp.starting) return;
  if (!tp.launcher.providerKey) { flash('请先选 provider', 'warning'); return; }
  const bin = TOOL_LAUNCH_BIN[tp.launcher.tool] || tp.launcher.tool;
  const args = (tp.launcher.flags || '').trim().split(/\s+/).filter(Boolean);
  const command = [bin, ...args];
  tp.starting = true;
  renderTerminalPage();
  try {
    const res = await api('/api/terminal/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: tp.launcher.tool,
        command,
        cwd: tp.launcher.cwd || '',
        cols: 120,
        rows: 32,
      }),
    });
    if (res?.ok && res.data?.terminalSession) {
      const session = normalizeSession(res.data.terminalSession);
      tp.sessions.unshift(session);
      tp.activeSessionId = session.id;
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
  renderTerminalPage();
}

// Termius 级深色主题（精选拉满对比度，cursor / selection 都按品牌蓝）
// 注意 background 透明 (rgba 0/0/0/0) 让 page 渐变透出，不再有"白卡"
const TERM_THEME_DARK = {
  background: 'rgba(0,0,0,0)',
  foreground: '#e6ecf5',
  cursor: '#8dbdff',
  cursorAccent: '#0b1020',
  selectionBackground: 'rgba(91,140,255,0.36)',
  selectionForeground: '#ffffff',
  // ANSI 16 色：调成 Termius "One Dark" 风格
  black:        '#1a1f2e',
  red:          '#ff6b6d',
  green:        '#5dd39e',
  yellow:       '#ffd166',
  blue:         '#5b8cff',
  magenta:      '#c084fc',
  cyan:         '#5eead4',
  white:        '#c9d1d9',
  brightBlack:  '#3d4452',
  brightRed:    '#ff8085',
  brightGreen:  '#7bf1b8',
  brightYellow: '#ffe085',
  brightBlue:   '#7da6ff',
  brightMagenta:'#d4b0ff',
  brightCyan:   '#80f0d6',
  brightWhite:  '#f6f8fa',
};
const TERM_THEME_LIGHT = {
  background: 'rgba(0,0,0,0)',
  foreground: '#1f2937',
  cursor: '#3358ff',
  cursorAccent: '#fafbfc',
  selectionBackground: 'rgba(51,88,255,0.22)',
  selectionForeground: '#1f2937',
  black:        '#0f172a',
  red:          '#dc2626',
  green:        '#16a34a',
  yellow:       '#ca8a04',
  blue:         '#2563eb',
  magenta:      '#9333ea',
  cyan:         '#0891b2',
  white:        '#475569',
  brightBlack:  '#475569',
  brightRed:    '#ef4444',
  brightGreen:  '#22c55e',
  brightYellow: '#eab308',
  brightBlue:   '#3b82f6',
  brightMagenta:'#a855f7',
  brightCyan:   '#06b6d4',
  brightWhite:  '#0f172a',
};

function currentTermTheme() {
  return document.documentElement.dataset.theme === 'light' ? TERM_THEME_LIGHT : TERM_THEME_DARK;
}

function mountTerminal(sessionId) {
  const tp = getState().terminalPage;
  const hostEl = document.getElementById('eaTermHost');
  if (!hostEl) return;
  hostEl.innerHTML = '';
  let inst = tp.instances[sessionId];
  if (!inst) {
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      // SF Mono / JetBrains Mono / 系统等宽 fallback
      fontFamily: 'JetBrains Mono, SF Mono, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.18,
      letterSpacing: 0,
      scrollback: 5000,
      drawBoldTextInBrightColors: false,
      smoothScrollDuration: 80,
      theme: currentTermTheme(),
      allowProposedApi: true,
      windowsMode: false,
      allowTransparency: true,    // 让 page 渐变透出来，无白卡
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    const unicode11 = new Unicode11Addon();
    const webLinks = new WebLinksAddon((event, uri) => {
      // 用 Tauri opener 而不是 window.open（避免 webview 内导航）
      try {
        if (typeof window.openExternalUrl === 'function') window.openExternalUrl(uri);
        else window.open(uri, '_blank');
      } catch (_) { window.open(uri, '_blank'); }
    });
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = '11';
    term.loadAddon(webLinks);
    term.loadAddon(search);

    inst = {
      term, fit, search,
      cursor: 0,
      container: hostEl,
      pollTimer: 0,
      sentBytes: 0,
      recvBytes: 0,
      lastResize: { cols: 120, rows: 32 },
      webglAddon: null,
      resizeObserver: null,
    };
    tp.instances[sessionId] = inst;
    term.onData((data) => {
      inst.sentBytes += data.length;
      sendInput(sessionId, data).catch(() => {});
    });
  } else {
    // 切回已有 session：主题可能变了（dark/light 切换）
    try { inst.term.options.theme = currentTermTheme(); } catch (_) {}
  }

  inst.container = hostEl;
  inst.term.open(hostEl);

  // 挂 WebGL renderer（必须 open 之后才能挂）
  if (!inst.webglAddon) {
    try {
      const webgl = new WebglAddon();
      // 浏览器 context lost 时自动 dispose，掉回 canvas renderer
      webgl.onContextLoss(() => {
        try { webgl.dispose(); inst.webglAddon = null; } catch (_) {}
      });
      inst.term.loadAddon(webgl);
      inst.webglAddon = webgl;
    } catch (err) {
      // WebGL 不可用（罕见），xterm 自动退回 canvas，不影响功能
      console.warn('[ea-term] WebGL renderer unavailable, falling back', err);
    }
  }

  // Fit + 通知后端 resize
  try { inst.fit.fit(); } catch (_) {}
  notifyResize(sessionId, inst);

  // ResizeObserver：窗口拉动时同步 cols/rows
  if (!inst.resizeObserver && typeof ResizeObserver === 'function') {
    inst.resizeObserver = new ResizeObserver(() => {
      try { inst.fit.fit(); } catch (_) {}
      notifyResize(sessionId, inst);
    });
    inst.resizeObserver.observe(hostEl);
  }

  // 启动轮询输出
  if (inst.pollTimer) clearInterval(inst.pollTimer);
  inst.pollTimer = setInterval(() => pollOutput(sessionId), POLL_INTERVAL_MS);
  inst.term.focus();
}

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
  if (inst._reading) return;
  inst._reading = true;
  try {
    const params = new URLSearchParams({ sessionId, cursor: String(inst.cursor || 0) });
    const res = await api(`/api/terminal/read?${params.toString()}`);
    if (res?.ok && res.data) {
      const data = res.data.data || '';
      if (data) {
        inst.term.write(data);
        inst.recvBytes += data.length;
      }
      if (typeof res.data.cursor === 'number') inst.cursor = res.data.cursor;
      // 更新 running / exit
      const sess = tp.sessions.find((s) => s.id === sessionId);
      if (sess && res.data.session) {
        sess.running = Boolean(res.data.session.running);
        sess.exitCode = res.data.session.exitCode ?? sess.exitCode;
      }
    }
  } catch (_) {}
  inst._reading = false;
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
