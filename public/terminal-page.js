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
      cwd: '',
      model: '',                    // 可空：传 --model
      profile: '',                  // codex 可空：--profile
      sandbox: 'bypass',            // bypass | workspace-write | read-only | none
      flags: '',                    // 额外参数
      moreOpen: false,
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

  // 默认填一个 provider（如果没选）
  if (!tp.launcher.providerKey) {
    const active = allProviders.find((p) => p.isActive);
    tp.launcher.providerKey = active?.key || allProviders[0]?.key || '';
  }

  // 当前活动 session 是 ghost（上次 app 留下的）→ 不挂 xterm，显示"已退出 + 重启"占位
  const activeSess = tp.sessions.find((s) => s.id === tp.activeSessionId);
  const showGhost = activeSess?._ghost;
  host.innerHTML = `
    <div class="ea-term-shell">
      ${tp.starting ? '<div class="ea-term-progress" aria-label="启动中"><span class="ea-term-progress-bar"></span></div>' : ''}
      <div class="ea-term-canvas">
        ${showGhost ? `
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
        ` : `<div class="ea-term-host" id="eaTermHost"></div>`}
        ${tp.sessions.length ? '' : '<div class="ea-term-empty">还没有会话 · 点右下角 <kbd>+</kbd> 新建 · 或 <kbd>⌘T</kbd> 配置启动 · <kbd>⌘K</kbd> 命令面板</div>'}
      </div>
      ${renderStatusBar(tp)}
      ${renderFab(tp)}
      ${tp.launcherOpen ? `<div class="ea-term-launcher-scrim" data-eat-launcher-scrim></div>${renderLauncherPopover(tp, allProviders)}` : ''}
    </div>
    ${tp.paletteOpen ? renderPalette(tp, allProviders) : ''}
  `;

  bindEvents(host);
  // ghost session 不挂 xterm
  const active = tp.sessions.find((s) => s.id === tp.activeSessionId);
  if (active && !active._ghost) {
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
  const isCodex = tp.launcher.tool === 'codex';
  const isOfficial = isCodex && tp.launcher.source === 'official';
  const providerOpts = providers.map((p) => `<option value="${esc(p.key)}" ${p.key === tp.launcher.providerKey ? 'selected' : ''}>${esc(p.name || p.key)}${p.isActive ? ' · 当前' : ''}</option>`).join('');
  const sandboxOpts = [
    ['bypass', '完全放开 (--dangerously-bypass)'],
    ['workspace-write', '工作目录可写'],
    ['read-only', '只读'],
    ['none', '不设置'],
  ];
  // 顶部：标题 + 关闭。然后扁平垂直布局，无卡片阴影感
  return `
    <div class="ea-term-launcher2" data-eat-launcher-card>
      <div class="ea-term-l2-head">
        <span class="ea-term-l2-title">新建会话</span>
        <button type="button" class="ea-term-l2-close" data-eat-launcher-close title="关闭 (Esc)" aria-label="关闭">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>

      <div class="ea-term-l2-row">
        <span class="ea-term-l2-label">工具</span>
        <div class="ea-term-l2-seg">
          <button type="button" class="${isCodex ? 'is-on' : ''}" data-eat-launch-set="tool" data-value="codex">Codex</button>
          <button type="button" class="${!isCodex ? 'is-on' : ''}" data-eat-launch-set="tool" data-value="claudecode">Claude Code</button>
        </div>
      </div>

      ${isCodex ? `
        <div class="ea-term-l2-row">
          <span class="ea-term-l2-label">登录方式</span>
          <div class="ea-term-l2-seg">
            <button type="button" class="${isOfficial ? 'is-on' : ''}" data-eat-launch-set="source" data-value="official" title="使用 ~/.codex 官方登录态">官方</button>
            <button type="button" class="${!isOfficial ? 'is-on' : ''}" data-eat-launch-set="source" data-value="provider" title="使用自管 provider API">自管 Provider</button>
          </div>
        </div>
      ` : ''}

      ${!isOfficial ? `
        <div class="ea-term-l2-row">
          <span class="ea-term-l2-label">Provider</span>
          <select class="ea-term-l2-select" data-eat-launch="providerKey">
            ${providerOpts || '<option value="">（无可用 provider）</option>'}
          </select>
        </div>
      ` : ''}

      <div class="ea-term-l2-row">
        <span class="ea-term-l2-label">工作目录</span>
        <div class="ea-term-l2-cwd">
          <input type="text" data-eat-launch="cwd" placeholder="默认 = $HOME" value="${esc(tp.launcher.cwd || '')}"/>
          <button type="button" class="ea-term-l2-icon" data-eat-pick-cwd title="浏览…" aria-label="浏览">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.4l1.2 1.4h5.4A1.5 1.5 0 0 1 14 5.9V11.5A1.5 1.5 0 0 1 12.5 13H3.5A1.5 1.5 0 0 1 2 11.5z"/></svg>
          </button>
        </div>
      </div>

      ${isCodex ? `
        <div class="ea-term-l2-row">
          <span class="ea-term-l2-label">沙箱模式</span>
          <select class="ea-term-l2-select" data-eat-launch="sandbox">
            ${sandboxOpts.map(([v, lab]) => `<option value="${v}" ${tp.launcher.sandbox === v ? 'selected' : ''}>${esc(lab)}</option>`).join('')}
          </select>
        </div>
      ` : ''}

      <button type="button" class="ea-term-l2-more" data-eat-launch-more aria-expanded="${tp.launcher.moreOpen ? 'true' : 'false'}">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${tp.launcher.moreOpen ? 'is-open' : ''}"><path d="M4 6l4 4 4-4"/></svg>
        <span>更多参数</span>
      </button>

      ${tp.launcher.moreOpen ? `
        <div class="ea-term-l2-more-body">
          <div class="ea-term-l2-row">
            <span class="ea-term-l2-label">模型</span>
            <input type="text" class="ea-term-l2-input" data-eat-launch="model" placeholder="留空 = 默认 (例: gpt-5)" value="${esc(tp.launcher.model || '')}"/>
          </div>
          ${isCodex ? `
            <div class="ea-term-l2-row">
              <span class="ea-term-l2-label">Profile</span>
              <input type="text" class="ea-term-l2-input" data-eat-launch="profile" placeholder="可选：~/.codex/config.toml 里的 profile 名" value="${esc(tp.launcher.profile || '')}"/>
            </div>
          ` : ''}
          <div class="ea-term-l2-row">
            <span class="ea-term-l2-label">额外参数</span>
            <input type="text" class="ea-term-l2-input ea-term-l2-mono" data-eat-launch="flags" value="${esc(tp.launcher.flags || '')}" placeholder="--flag 值 …"/>
          </div>
        </div>
      ` : ''}

      <div class="ea-term-l2-foot">
        <button type="button" class="ea-term-l2-go ${tp.starting ? 'is-busy' : ''}" data-eat-spawn ${tp.starting ? 'disabled' : ''}>
          ${tp.starting ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6" opacity="0.3"/><path d="M8 2a6 6 0 0 1 6 6" class="spin"/></svg> 启动中…' : '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M3 2v12l10-6z"/></svg> 启动'}
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
  const resume = t.closest('[data-eat-resume]');
  if (resume) { resumeGhostSession(resume.dataset.eatResume); return; }
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
  if (!isOfficial && !tp.launcher.providerKey) { flash('请先选 provider', 'warning'); return; }
  const bin = TOOL_LAUNCH_BIN[tp.launcher.tool] || tp.launcher.tool;
  // 组装 args：sandbox + model + profile + 额外 flags
  const args = [];
  if (isCodex) {
    const sb = tp.launcher.sandbox;
    if (sb === 'bypass') args.push('--dangerously-bypass-approvals-and-sandbox');
    else if (sb === 'workspace-write') args.push('--sandbox', 'workspace-write');
    else if (sb === 'read-only') args.push('--sandbox', 'read-only');
    if (tp.launcher.profile) args.push('--profile', tp.launcher.profile);
  }
  if (tp.launcher.model) args.push('--model', tp.launcher.model);
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
      // 从 Rust 拉一次完整 PTY 缓存 — re-mount / 切 tab / 新挂载都把历史灌回来
      api(`/api/terminal/buffer?sessionId=${encodeURIComponent(sessionId)}&cursor=0`).then((res) => {
        const data = res?.ok && res.data?.data ? res.data.data : '';
        if (!data) return;
        try {
          // 把 base64/raw 写进 xterm（terminal_buffer 返回的是 base64 编码的字节）
          const bytes = typeof data === 'string' && /^[A-Za-z0-9+/=]+$/.test(data)
            ? atob(data)
            : data;
          term.write(bytes);
          instance.cursor = res.data.cursor || bytes.length;
        } catch (_) {}
      }).catch(() => {});

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
