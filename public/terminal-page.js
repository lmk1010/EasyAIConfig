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

// 一次性挂全局 Tauri 事件监听：terminal-data / terminal-exit
// Rust reader 线程读到一段就 emit 一次 — 真 push 流，60fps 取决于 PTY 实际产出
let __eaTermListenersBound = false;
async function installTermEventListeners() {
  console.warn('[ea-term] installTermEventListeners called', { bound: __eaTermListenersBound, tauri: !!window.__TAURI__ });
  if (__eaTermListenersBound) return;
  let listen = window.__TAURI__?.event?.listen;
  // Tauri inject 有时晚于 module 加载；最多重试 30 次 × 100ms
  let tries = 0;
  while (typeof listen !== 'function' && tries < 30) {
    await new Promise((r) => setTimeout(r, 100));
    listen = window.__TAURI__?.event?.listen;
    tries++;
  }
  if (typeof listen !== 'function') {
    console.warn('[ea-term] listen unavailable after', tries, 'tries');
    return;
  }
  console.warn('[ea-term] listen ok, registering 4 listeners');
  __eaTermListenersBound = true;
  window.__eaTermDiag = { ...(window.__eaTermDiag || {}), listenOk: true, listenAt: Date.now() };
  // 自检事件 — Rust install() 3 秒后会 emit 一次。收到 → bridge 完全通
  await listen('terminal-self-test', (event) => {
    console.warn('[ea-term] SELF-TEST event arrived', event?.payload);
    window.__eaTermDiag = { ...(window.__eaTermDiag || {}), selfTestAt: Date.now(), selfTestPayload: event?.payload };
  });
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
    inst.recvBytes += chunk.length;
    inst.cursor += chunk.length;

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
  // 注意：token 必须存在 session 上（永远存在），不能依赖 instance（mount/unmount 会丢）
  await listen('terminal-tokens', (event) => {
    console.warn('[ea-term] terminal-tokens event ARRIVED', event?.payload);
    window.__eaTermDiag = { ...(window.__eaTermDiag || {}), lastTokenEventAt: Date.now(), lastTokenPayload: event?.payload };
    const payload = event.payload || {};
    const { sessionId } = payload;
    if (!sessionId) { console.warn('[ea-term] no sessionId in payload'); return; }
    const tp = getState()?.terminalPage;
    if (!tp) {
      // state.terminalPage 还没初始化 — 先把数据存全局 buffer，等用户进入 terminal 页时回灌
      window.__eaPendingTokens = window.__eaPendingTokens || {};
      window.__eaPendingTokens[sessionId] = payload;
      console.warn('[ea-term] no tp yet, buffered');
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
    const allIds = tp.sessions.map((s) => s.id);
    const matched = allIds.includes(sessionId);
    console.log('[terminal-tokens]', sessionId.slice(0, 8), 'matched=', matched, 'activeId=', tp.activeSessionId?.slice(0, 8), 'allIds=', allIds.map(i => i.slice(0, 8)));
    // 1) 写到 session 对象（一定存在，即便 instance 还没 mount / 已 unmount）
    const sess = tp.sessions.find((s) => s.id === sessionId);
    if (sess) {
      sess.tokens = tokens;
      sess.tokensUpdatedAt = Date.now();
    } else {
      // sessionId 不在 tp.sessions 里 — 仍然存到 pending，等会话被 list/spawn 添加进来
      window.__eaPendingTokens = window.__eaPendingTokens || {};
      window.__eaPendingTokens[sessionId] = payload;
      console.warn('[ea-term] sessionId NOT in tp.sessions, pending it. ids:', allIds);
    }
    // 2) instance 上同步一份（已 mount 时 status bar 也会从这取）
    const inst = tp.instances?.[sessionId];
    if (inst) {
      inst.tokens = tokens;
      inst.tokensUpdatedAt = Date.now();
    }
    // 3) 立即刷 — 直接在这里 inline 更新 DOM，避免任何中间层
    console.error('[ea-term] TOKEN WRITE OK input=', tokens.input, 'output=', tokens.output, 'sess?', !!sess);
    try {
      // 状态栏内部 HTML 直接重渲染
      const host = document.getElementById('eaTermPage');
      const statusEl = host?.querySelector('.ea-term-status');
      if (statusEl) {
        statusEl.innerHTML = renderStatusBarInner(tp);
        console.error('[ea-term] status DOM rewritten, first 100 chars:', statusEl.innerHTML.slice(0, 100));
      } else {
        console.error('[ea-term] CANNOT FIND .ea-term-status in DOM', host);
      }
      renderTermSidebar();
    } catch (e) {
      console.error('[ea-term] render throw', e);
    }
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

// ANSI escape codes 去掉，再正则抓 token 数字
function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function parseTokenChunk(inst, chunk) {
  const clean = stripAnsi(chunk);
  // 形如 "input: 12,345" / "cached: 8,200" / "output: 423" 或 "tokens: ..."
  // Codex / Claude TUI 通常一行打印 status-line。这里全部抓最后命中的值，作为"最新值"
  const matchNum = (label) => {
    const re = new RegExp(`${label}\\s*[:：]?\\s*([\\d,]+)`, 'gi');
    let m, last = null;
    while ((m = re.exec(clean)) !== null) last = m[1];
    return last ? parseInt(last.replace(/,/g, ''), 10) : null;
  };
  const t = inst.tokens || {};
  const fields = [
    ['input', /input/],
    ['cached', /cache|cached/],
    ['output', /output/],
    ['reasoning', /reasoning|thinking/],
    ['total', /total/],
  ];
  let touched = false;
  for (const [key, kw] of fields) {
    const v = matchNum(kw.source);
    if (v != null && Number.isFinite(v)) {
      t[key] = v;
      touched = true;
    }
  }
  if (touched) {
    inst.tokens = t;
    inst.tokensUpdatedAt = Date.now();
  }
}

function renderTermSidebar() {
  const tp = getState()?.terminalPage;
  if (!tp) return;
  const listEl = document.getElementById('eaTermSecList');
  const countEl = document.getElementById('eaTermSecCount');
  if (!listEl) return;
  if (countEl) countEl.textContent = String(tp.sessions.length);
  if (!tp.sessions.length) {
    listEl.innerHTML = '<div class="sec-empty">还没有会话 · 点右下角 + 新建</div>';
    return;
  }
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
  listEl.innerHTML = tp.sessions.map((s) => {
    const isActive = s.id === tp.activeSessionId;
    return `
      <button type="button" class="sec-item ${isActive ? 'active' : ''}" data-eat-sec-tab="${esc(s.id)}" style="${toolAccent(s.tool)}">
        <span class="sec-ico">${toolIcon(s.tool)}</span>
        <span class="sec-text">
          <span class="sec-name">${esc(s.title || s.command || s.id.slice(0,8))}</span>
          <span class="sec-subtitle"><span class="ea-term-sec-dot ${s.running ? 'is-on' : 'is-off'}"></span>${esc(toolLabel(s.tool))}${s.running ? '' : ' · 已退出'}</span>
        </span>
        <span class="sec-chev" aria-hidden="true">›</span>
      </button>`;
  }).join('');
  // 状态栏的实时用量也同步刷新
  renderTermStatus();
}

// 单独刷状态栏
function renderTermStatus() {
  const tp = getState()?.terminalPage;
  if (!tp) { console.warn('[ea-term] renderTermStatus: tp missing'); return; }
  const host = document.getElementById('eaTermPage');
  if (!host) { console.warn('[ea-term] renderTermStatus: host missing'); return; }
  const statusEl = host.querySelector('.ea-term-status');
  if (!statusEl) { console.warn('[ea-term] renderTermStatus: .ea-term-status missing'); return; }
  const sess = tp.sessions.find((s) => s.id === tp.activeSessionId);
  console.log('[ea-term] renderTermStatus tokens=', sess?.tokens);
  statusEl.innerHTML = renderStatusBarInner(tp);
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
  // Rust 后端返回的字段是 rows 不是 sessions（之前写错了 → 永远空数组）
  if (!tp._loadedOnce) {
    tp._loadedOnce = true;
    try {
      const res = await api('/api/terminal/list');
      const rows = res?.ok && Array.isArray(res.data?.rows) ? res.data.rows : [];
      if (rows.length) {
        const known = new Set(tp.sessions.map((s) => s.id));
        for (const row of rows.map(normalizeSession)) {
          if (!known.has(row.id)) tp.sessions.push(row);
        }
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
      ${tp.starting ? '<div class="ea-term-progress" aria-label="启动中"><span class="ea-term-progress-bar"></span></div>' : ''}
      <div class="ea-term-canvas">
        <div class="ea-term-host" id="eaTermHost"></div>
        ${tp.sessions.length ? '' : '<div class="ea-term-empty">还没有会话 · 点右下角 <kbd>+</kbd> 新建 · 或 <kbd>⌘T</kbd> 配置启动 · <kbd>⌘K</kbd> 命令面板</div>'}
      </div>
      ${renderStatusBar(tp)}
      ${renderFab(tp)}
      ${tp.launcherOpen ? `<div class="ea-term-launcher-scrim" data-eat-launcher-scrim></div>${renderLauncherPopover(tp, allProviders)}` : ''}
    </div>
    ${tp.paletteOpen ? renderPalette(tp, allProviders) : ''}
  `;

  bindEvents(host);
  // 重挂当前 active 的 xterm 到 #eaTermHost（若已存在 instance 则复用）
  const active = tp.sessions.find((s) => s.id === tp.activeSessionId);
  if (active) {
    mountTerminal(active.id);
  }
  renderTermSidebar();
}

function renderFab(tp) {
  const open = Boolean(tp.launcherOpen);
  return `
    <button type="button" class="ea-term-fab ${open ? 'is-open' : ''}" data-eat-fab title="新建终端 / 配置启动参数">
      ${open
        ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg>'
        : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v12M2 8h12"/></svg>'}
    </button>`;
}

function renderLauncherPopover(tp, providers) {
  const esc = escapeHtml;
  const opts = providers.map((p) => `<option value="${esc(p.key)}" ${p.key === tp.launcher.providerKey ? 'selected' : ''}>${p.isActive ? '● ' : ''}${esc(p.name || p.key)}</option>`).join('');
  // 没有 scrim — 直接锚定 FAB 右上方的浮卡（点外面有外部 listener 关，下面会接）
  return `
    <div class="ea-term-launcher-card" data-eat-launcher-card>
      <div class="ea-term-launcher-head">
        <span class="ea-term-launcher-eyebrow">NEW SESSION</span>
        <button type="button" class="ea-term-launcher-close" data-eat-launcher-close title="关闭 (Esc)">×</button>
      </div>
      <div class="ea-term-launcher-body">
        <label class="ea-term-launcher-field">
          <span>工具</span>
          <select data-eat-launch="tool">
            <option value="codex" ${tp.launcher.tool === 'codex' ? 'selected' : ''}>Codex</option>
            <option value="claudecode" ${tp.launcher.tool === 'claudecode' ? 'selected' : ''}>Claude Code</option>
          </select>
        </label>
        <label class="ea-term-launcher-field">
          <span>Provider</span>
          <select data-eat-launch="providerKey">${opts || '<option value="">无可用 provider</option>'}</select>
        </label>
        <div class="ea-term-launcher-field ea-term-launcher-field-wide">
          <span>工作目录</span>
          <div class="ea-term-launcher-cwd">
            <input type="text" data-eat-launch="cwd" placeholder="默认 = $HOME" value="${esc(tp.launcher.cwd || '')}"/>
            <button type="button" class="ea-term-launcher-pick" data-eat-pick-cwd title="浏览…">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.4l1.2 1.4h5.4A1.5 1.5 0 0 1 14 5.9V11.5A1.5 1.5 0 0 1 12.5 13H3.5A1.5 1.5 0 0 1 2 11.5z"/></svg>
            </button>
          </div>
        </div>
        <label class="ea-term-launcher-field ea-term-launcher-field-wide">
          <span>启动参数</span>
          <input type="text" data-eat-launch="flags" value="${esc(tp.launcher.flags || '')}" placeholder="--flag …"/>
        </label>
      </div>
      <div class="ea-term-launcher-foot">
        <button type="button" class="ea-term-launcher-go ${tp.starting ? 'is-busy' : ''}" data-eat-spawn ${tp.starting ? 'disabled' : ''}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v12l10-6z"/></svg>
          ${tp.starting ? '启动中…' : '启动'}
        </button>
      </div>
    </div>`;
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
  // 上下文用量条：累计 input vs context window
  const usedPct = ctxWindow > 0 ? Math.min(100, (input / ctxWindow) * 100) : 0;
  const cachePctOfInput = input > 0 ? Math.min(100, (cached / input) * 100) : 0;
  // 诊断 chip：精确告诉你卡在哪一步
  const allZero = input === 0 && cached === 0 && output === 0;
  let diagChip = '';
  if (allZero) {
    const d = window.__eaTermDiag || {};
    if (!d.listenOk) {
      diagChip = `<span class="ea-term-status-diag is-bad" title="Tauri event listener 未注册 (window.__TAURI__ 没注入或拒绝)">✗ listener 未启</span>`;
    } else if (!d.selfTestAt) {
      diagChip = `<span class="ea-term-status-diag is-bad" title="Rust install() 3 秒后会 emit terminal-self-test 但前端没收到 → Tauri event bridge 断了，可能是 capability 权限问题">✗ bridge 断开</span>`;
    } else if (!d.lastTokenEventAt) {
      diagChip = `<span class="ea-term-status-diag is-warn" title="bridge 通了（self-test ✓）但 Rust 还没 emit terminal-tokens。Console.app 看 [token-watcher] 日志">⏳ 等 token emit (bridge ✓)</span>`;
    } else if (Date.now() - d.lastTokenEventAt > 30000) {
      const ago = Math.round((Date.now() - d.lastTokenEventAt) / 1000);
      diagChip = `<span class="ea-term-status-diag is-warn" title="最近一次 token 事件: ${ago}s 前 sessionId=${esc(d.lastTokenPayload?.sessionId || '?')}">⏳ 上次 ${esc(String(ago))}s 前</span>`;
    } else {
      const sid = String(d.lastTokenPayload?.sessionId || '?').slice(0, 8);
      diagChip = `<span class="ea-term-status-diag is-warn" title="刚收到 token 事件但 sessionId 不匹配本会话: ${esc(sid)}">⚠ sid 不匹配 (${esc(sid)})</span>`;
    }
  }
  return `
    <span class="ea-term-status-dot ${session.running ? 'is-on' : 'is-off'}"></span>
    <span class="ea-term-status-text">${esc(session.title || session.command || '')}</span>
    <span class="ea-term-status-sep">·</span>
    <span class="ea-term-status-text-faint">${esc(session.running ? '运行中' : '已退出')}</span>
    ${session.cwd ? `<span class="ea-term-status-sep">·</span><span class="ea-term-status-text-faint ea-term-status-cwd" title="${esc(session.cwd)}">${esc(session.cwd)}</span>` : ''}
    ${diagChip}
    <span class="ea-term-status-spacer"></span>
    ${ctxWindow > 0 ? `
      <span class="ea-term-status-ctx" title="上下文：${esc(fmt(input))} / ${esc(fmt(ctxWindow))} · 缓存 ${esc(fmt(cached))}">
        <span class="ea-term-status-ctx-label">上下文</span>
        <span class="ea-term-status-ctx-bar">
          <span class="ea-term-status-ctx-fill" style="width:${usedPct.toFixed(1)}%"></span>
          <span class="ea-term-status-ctx-cache" style="width:${(usedPct * cachePctOfInput / 100).toFixed(1)}%"></span>
        </span>
        <span class="ea-term-status-ctx-num">${esc(fmt(input))} / ${esc(fmt(ctxWindow))}</span>
      </span>
    ` : ''}
    <span class="ea-term-status-pill" title="输入 token">输入 ${esc(fmt(input))}</span>
    <span class="ea-term-status-pill" title="缓存命中 token">缓存 ${esc(fmt(cached))}</span>
    <span class="ea-term-status-pill ea-term-status-pill-tokens" title="输出 token">输出 ${esc(fmt(output))}</span>
  `;
}

function renderTabStrip(tp) {
  const esc = escapeHtml;
  return `
    <div class="ea-term-tabs ${tp.sessions.length ? '' : 'is-empty'}">
      ${tp.sessions.map((s) => `
        <button type="button" class="ea-term-tab ${s.id === tp.activeSessionId ? 'is-active' : ''}" data-eat-tab="${esc(s.id)}">
          <span class="ea-term-tab-dot ${s.running ? 'is-on' : ''}"></span>
          <span class="ea-term-tab-label">${esc(s.title || s.command || s.id.slice(0, 8))}</span>
          <span class="ea-term-tab-close" data-eat-tab-close="${esc(s.id)}" title="关闭">×</span>
        </button>`).join('')}
      ${tp.sessions.length ? '<button type="button" class="ea-term-tab-new" data-eat-tab-new title="新建终端 (⌘T)"><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2v12M2 8h12"/></svg></button>' : ''}
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
  if (t.closest('[data-eat-fab]') || t.closest('[data-eat-tab-new]')) {
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
  // ⌘T 新建终端
  if (meta && e.key.toLowerCase() === 't') {
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

// Token 兜底 poll：自适应频率 + 仅当 terminal 页可见时才跑（性能）
// - 未拿到 token 时 2 秒一次（快速发现）
// - 已拿到 token 时 6 秒一次（节流，避免狂 lsof）
let __eaTermTokenPollTimer = 0;
function startTokenPollLoop() {
  if (__eaTermTokenPollTimer) return;
  const tick = async () => {
    try {
      const tp = getState()?.terminalPage;
      if (!tp) return;
      // 不在 terminal 页时跳过（节省 CPU / 不打扰别处）
      if (getState()?.activePage !== 'terminal') return;
      let interval = 6000;
      for (const s of tp.sessions) {
        if (!s.running) continue;
        try {
          const res = await api(`/api/terminal/token-snapshot?sessionId=${encodeURIComponent(s.id)}`);
          if (!res?.ok) {
            tp._lastDiag = { ok: false, error: res?.error || 'endpoint missing', at: Date.now() };
            interval = 2000;
            continue;
          }
          const data = res.data || {};
          tp._lastDiag = { ok: true, pid: data.pid, path: data.path, tokens: data.tokens, source: data.source, reason: data.reason, at: Date.now() };
          const tokens = data.tokens;
          if (tokens && Number.isFinite(tokens.input) && tokens.input > 0) {
            const inst = tp.instances?.[s.id];
            if (!inst) continue;
            inst.tokens = tokens;
            inst.tokensUpdatedAt = Date.now();
            if (!inst._sidebarRaf) {
              inst._sidebarRaf = requestAnimationFrame(() => {
                inst._sidebarRaf = 0;
                renderTermSidebar();
                renderTermStatus();
              });
            }
          } else {
            interval = 2000; // 还没拿到，下次快点
          }
        } catch (err) {
          if (tp) tp._lastDiag = { ok: false, error: String(err?.message || err), at: Date.now() };
          interval = 2000;
        }
      }
      renderTermStatus();
      // 调整下次间隔
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
  if (!tp.launcher.providerKey) { flash('请先选 provider', 'warning'); return; }
  const bin = TOOL_LAUNCH_BIN[tp.launcher.tool] || tp.launcher.tool;
  const args = (tp.launcher.flags || '').trim().split(/\s+/).filter(Boolean);
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
        title,
        commandPreview,
        cols: 120,
        rows: 32,
      }),
    });
    if (res?.ok && res.data?.terminalSession) {
      const session = normalizeSession(res.data.terminalSession);
      tp.sessions.unshift(session);
      tp.activeSessionId = session.id;
      tp.launcherOpen = false; // 启动后自动收 popover
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
        fontFamily: '"MesloLGS NF", "JetBrainsMono Nerd Font", "FiraCode Nerd Font Mono", "SF Mono", "Menlo", "Consolas", monospace',
        fontSize: 12.5,
        scrollback: 5000,
        theme: currentTermTheme(),
        allowProposedApi: true,
        macOptionIsMeta: true,
        rightClickSelectsWord: true,
      });
      const fit = new FitAddon();
      const webLinks = new WebLinksAddon((event, uri) => {
        try {
          if (typeof window.openExternalUrl === 'function') window.openExternalUrl(uri);
          else window.open(uri, '_blank');
        } catch (_) { window.open(uri, '_blank'); }
      });
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(webLinks);
      term.loadAddon(search);

      const instance = {
        term, fit, search,
        cursor: 0,
        mountedTo: null,
        pollTimer: 0,
        sentBytes: 0,
        recvBytes: 0,
        lastResize: { cols: 0, rows: 0 },
        resizeObserver: null,
        firstChunk: true,
      };
      tp.instances[sessionId] = instance;

      const target = document.getElementById('eaTermHost');
      if (!target) return;
      term.open(target);
      instance.mountedTo = target;
      // 字体 metrics 稳定后再 fit
      setTimeout(() => {
        try {
          // 守卫 0×0（display:none 时容器塌陷会让 PTY cols 设成 0 / 1，shell 排版乱）
          if (target.clientWidth === 0 || target.clientHeight === 0) return;
          fit.fit();
          notifyResize(sessionId, instance);
        } catch (_) {}
      }, 0);

      term.onData((data) => {
        instance.sentBytes += data.length;
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

  // 已有实例但 mountedTo 是旧 host（被 innerHTML 替换掉了）→ re-attach 到当前 host
  // 但 NOT 重新初始化 — buffer / 状态全部保留
  try { inst.term.options.theme = currentTermTheme(); } catch (_) {}
  try { inst.term.open(hostEl); } catch (_) {}
  inst.mountedTo = hostEl;
  // 不再 fit / 不再 notifyResize（避免 SIGWINCH 让 codex 重画导致内容重复）
  try { inst.term.focus(); } catch (_) {}
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
      let data = res.data.data || '';
      // 首条数据去掉前导 \n / \r\n（shell rc / starship 习惯先打空行让 prompt 错开行）
      if (data && inst.firstChunk) {
        inst.firstChunk = false;
        data = data.replace(/^(?:\r?\n)+/, '');
      }
      if (data) {
        inst.term.write(data);
        inst.recvBytes += data.length;
      }
      if (typeof res.data.cursor === 'number') inst.cursor = res.data.cursor;
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
