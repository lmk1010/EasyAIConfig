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

/** 按当前终端画布估测 cols/rows，避免 spawn 时写死 120×32 导致 TUI 左侧挤、右侧空。 */
function measureTerminalSpawnSize() {
  const host =
    document.getElementById('eaTermHost')
    || document.querySelector('.shell-v2 .ea-term-canvas')
    || document.querySelector('.shell-v2 .page-view[data-page="terminal"]');
  const fontSize = Number((typeof getSavedFontSize === 'function' ? getSavedFontSize() : 13) || 13) || 13;
  const cellW = Math.max(6, fontSize * 0.62);
  const cellH = Math.max(10, fontSize * 1.15);
  // host 尚未铺开时，用主工作区估算（扣掉 rail + secondary）
  let w = host?.clientWidth || 0;
  let h = host?.clientHeight || 0;
  if (w < 80 || h < 40) {
    const workspace = document.querySelector('.shell-v2 .workspace');
    const sec = getComputedStyle(document.body).getPropertyValue('--sec-w');
    const rail = getComputedStyle(document.body).getPropertyValue('--rail-w');
    const secW = parseFloat(sec) || 220;
    const railW = parseFloat(rail) || 66;
    w = Math.max(320, (workspace?.clientWidth || window.innerWidth || 1200) - secW - railW - 24);
    h = Math.max(240, (workspace?.clientHeight || window.innerHeight || 800) - 48);
  }
  return {
    cols: Math.max(80, Math.min(300, Math.floor(w / cellW))),
    rows: Math.max(18, Math.min(120, Math.floor(h / cellH))),
  };
}

function getState() { return window.state; }

/** 去掉 ANSI / OSC，便于从 PTY 流里认 Codex 启动态 */
function stripAnsiForBootDetect(text) {
  return String(text || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r/g, '');
}

/**
 * Codex TUI 在 SessionConfigured 前会把提交放进 Queued follow-up（model: loading）。
 * 这不是我们的队列 bug，但体验差——用 bootPhase 明确提示。
 */
function updateCodexBootPhaseFromChunk(sess, chunk) {
  if (!sess) return;
  const plain = stripAnsiForBootDetect(chunk);
  if (!plain) return;
  let next = sess.bootPhase || 'unknown';
  if (/model\s*:\s*loading/i.test(plain) || /Queued follow-up inputs/i.test(plain)) {
    next = 'starting';
  }
  // header 里 model 已变成真实名，或开始 Working
  if (
    /model\s*:\s*(?!loading\b)[A-Za-z0-9._+/-]+/i.test(plain)
    || /\bWorking\b/.test(plain)
    || /token_count/i.test(plain)
  ) {
    if (next === 'starting' || next === 'unknown') next = 'ready';
  }
  if (next !== sess.bootPhase) {
    const prev = sess.bootPhase;
    sess.bootPhase = next;
    if (next === 'ready' && prev === 'starting') {
      try { flash('Codex 已就绪 — 排队首句会自动发出', 'success'); } catch (_) {}
    }
    try { updateBootBannerDom(sess); } catch (_) {}
  }
}

function updateBootBannerDom(sess) {
  const canvas = document.querySelector('.shell-v2 .ea-term-canvas');
  if (!canvas) return;
  const tp = getState()?.terminalPage;
  const activeId = tp?.activeSessionId;
  if (!sess || sess.id !== activeId) return;
  let banner = canvas.querySelector('.ea-term-boot-banner');
  if (sess.bootPhase === 'starting' && !sess.bridge) {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'ea-term-boot-banner';
      banner.setAttribute('role', 'status');
      banner.innerHTML = `
        <strong>模型加载中</strong>
        <span>Codex 正在完成 SessionConfigured（TUI 会显示 model: loading）。就绪前首句可能进排队，请稍候。</span>
        <em>通道：模拟终端 PTY</em>`;
      const host = canvas.querySelector('#eaTermHost') || canvas.firstElementChild;
      if (host) canvas.insertBefore(banner, host.nextSibling);
      else canvas.prepend(banner);
    }
  } else if (banner) {
    banner.remove();
  }
}

function markCodexBootReady(sessionId) {
  const tp = getState()?.terminalPage;
  const sess = tp?.sessions?.find((s) => s.id === sessionId);
  if (!sess) return;
  if (sess.bootPhase === 'ready') return;
  const prev = sess.bootPhase;
  sess.bootPhase = 'ready';
  if (prev === 'starting') {
    try { flash('Codex 已就绪 — 排队首句会自动发出', 'success'); } catch (_) {}
  }
  try { updateBootBannerDom(sess); } catch (_) {}
  try { renderTermStatus(); } catch (_) {}
}

/**
 * 滤掉漏到画面上的终端能力查询回包。
 * 典型泄漏：Secondary DA `ESC [ > 0 ; 276 ; 0 c` → 可见 `0;276;0c` / `>0;276;0c`
 * （xterm 版本号 276；对用户无意义，纯显示污染）
 */
function sanitizeTerminalOutputChunk(chunk) {
  if (!chunk) return chunk;
  let out = String(chunk);
  // 完整 CSI DA / DA2（含 ESC 前缀）
  out = out.replace(/\x1b\[[?>]?[\d;]*[cC]/g, '');
  // ESC 被吃掉后残留的可见垃圾：单独一行的 `>0;276;0c` / `0;276;0c`
  out = out.replace(/(^|\r?\n)\s*>?\s*\d+;\d+;\d+[cC](?=\r?\n|$)/g, '$1');
  // 夹在文本中间的同类残留（截图红框那种）
  out = out.replace(/(^|\s)>\s*\d+;\d+;\d+[cC](?=\s|$)/g, '$1');
  out = out.replace(/(^|\s)\d+;\d+;\d+[cC](?=\s|$)/g, (m, p1) => {
    // 避免误伤普通数字；DA 回包第三段多为 0，中间段为版本号
    const body = m.trim();
    if (/^\d+;\d+;0c$/i.test(body) || /^>\d+;\d+;\d+c$/i.test(body)) return p1;
    return m;
  });
  return out;
}

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
    chunk = sanitizeTerminalOutputChunk(chunk);
    if (!chunk) return;
    inst.term.write(chunk);
    inst.recvBytes += utf8ByteLength(chunk);
    inst.cursor += utf8ByteLength(chunk);

    // Codex 启动门闩：SessionConfigured 前 model 显示 loading，首句会进 Queued follow-up。
    // 从 PTY 文本推断就绪态，状态芯片提示「启动中 / 已就绪」。
    try {
      const sess = tp.sessions?.find((s) => s.id === sessionId);
      if (sess && (sess.tool === 'codex' || !sess.tool)) {
        updateCodexBootPhaseFromChunk(sess, chunk);
      }
    } catch (_) {}

    // 状态芯片可随 token/boot 轻量刷新；会话列表禁止跟 PTY 字节流重绘，
    // 否则 listEl.innerHTML 会反复重建 <img>，左侧工具图标会疯狂闪烁。
    if (!inst._statusRaf) {
      inst._statusRaf = requestAnimationFrame(() => {
        inst._statusRaf = 0;
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
      markCodexBootReady(sessionId);
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
      refreshStatusOverlay(tp);
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

// ─── localStorage 小工具（只存 UI 偏好；Tauri webview 清缓存会丢，能接受）───
const LS = {
  fontSize: 'ea_term_font_size',
  titles: 'ea_term_titles',
  rememberBinding: 'ea_term_remember_binding',
  remotePort: 'ea_remote_port',
  remoteTunnel: 'ea_remote_tunnel_form',
};
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch (_) { return fallback; }
}
function lsSet(key, val) { try { localStorage.setItem(key, String(val)); } catch (_) {} }
function lsGetJson(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return fallback;
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) { return fallback; }
}
function lsSetJson(key, val) { try { localStorage.setItem(key, JSON.stringify(val || {})); } catch (_) {} }

// 终端字号：持久化 10–22，新挂载的实例读它作初始值
const TERM_FONT_MIN = 10, TERM_FONT_MAX = 22, TERM_FONT_DEFAULT = 13;
function clampFontSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return TERM_FONT_DEFAULT;
  return Math.max(TERM_FONT_MIN, Math.min(TERM_FONT_MAX, v));
}
function getSavedFontSize() { return clampFontSize(lsGet(LS.fontSize, TERM_FONT_DEFAULT)); }
function saveFontSize(n) { lsSet(LS.fontSize, clampFontSize(n)); }

// 会话自定义标题（sidebar 双击重命名）— 按 sessionId 存 localStorage
function getCustomTitles() { return lsGetJson(LS.titles, {}); }
function getSessionTitle(s) {
  if (!s) return '';
  try {
    const custom = getCustomTitles()[s.id];
    if (custom && String(custom).trim()) return String(custom);
  } catch (_) {}
  // 名称优先用「会话第一句话」(后端 displayName)，其次工具默认名/命令
  const first = (s.displayName || '').trim();
  if (first && !isGenericSessionName(first)) return first;
  return s.title || s.command || (s.id ? s.id.slice(0, 8) : '');
}

// 判断是否是无信息量的通用名（如程序名、纯 shell 命令）
function isGenericSessionName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return true;
  return ['codex', 'claude', 'claude code', 'claudecode', 'shell', 'bash', 'zsh', 'sh', '命令'].includes(n);
}

// 相对时间：几秒前 / 几分钟前 / 几小时前 / MM-DD HH:mm
function formatRelativeTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function setSessionCustomTitle(sessionId, title) {
  if (!sessionId) return;
  const map = getCustomTitles();
  const val = String(title || '').trim();
  if (val) map[sessionId] = val; else delete map[sessionId];
  lsSetJson(LS.titles, map);
}

// 工具中文名（状态栏 / 提示用）
function toolDisplayLabel(tool) {
  return tool === 'codex' ? 'Codex' : tool === 'claudecode' ? 'Claude Code' : (tool || 'Shell');
}

function renderTermSidebar() {
  const tp = getState()?.terminalPage;
  if (!tp) return;
  if (tp._renamingSessionId) return; // 正在就地重命名，别把 input 冲掉
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
  const toolLogoSrc = (tool) => tool === 'codex'
    ? '/tool-icons/openai.png'
    : (tool === 'claudecode' || tool === 'claude')
      ? '/tool-icons/claude-code.png'
      : '';
  const toolIcon = (tool) => {
    const src = toolLogoSrc(tool);
    if (src) return `<img class="sec-tool-logo" src="${src}" alt="" loading="lazy" decoding="async">`;
    // Shell / 自定义：终端图标
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>';
  };
  const toolLabel = (tool) => tool === 'codex' ? 'Codex' : (tool === 'claudecode' || tool === 'claude') ? 'Claude Code' : (tool || 'Shell');
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
  // 状态/来源标记：无边框、无背景、纯文字，全部并入同一行 meta。
  // 默认「电脑」不显示（几乎每条都是，纯噪声）；只标注值得注意的状态。
  // 快速=app-server 桥；模拟=本机 PTY TUI（切模型慢，model:loading 常见）。
  const flagsHtml = (s) => {
    const bits = [];
    if (s.bridge) {
      bits.push('<span class="sec-flag sec-flag-fast" title="app-server 快速通道（手机 Timeline）">快速</span>');
    } else if (s.tool === 'codex') {
      bits.push('<span class="sec-flag sec-flag-sim" title="模拟终端 PTY（刮屏切模型）">模拟</span>');
    }
    if (s.origin === 'phone') bits.push('<span class="sec-flag sec-flag-phone" title="手机新建的会话">手机</span>');
    if (s.remoteActive) bits.push('<span class="sec-flag sec-flag-live" title="手机端正在查看此会话">在看</span>');
    if (s.persistent) bits.push('<span class="sec-flag sec-flag-keep" title="常驻:进程跑在 tmux 里，重启不丢">常驻</span>');
    return bits.join('');
  };
  const renderRow = (s) => {
    const isActive = s.id === tp.activeSessionId;
    const deleteLabel = s._ghost || !s.running ? '删除会话记录' : '结束并删除会话';
    const sessTitle = getSessionTitle(s);
    const timeStr = formatRelativeTime(s.createdAt);
    const brand = Boolean(toolLogoSrc(s.tool));
    // 工具已由图标表达，第二行不再重复工具名（省空间、更优雅）。
    const metaParts = [];
    if (!s.running) metaParts.push('已退出');
    if (timeStr) metaParts.push(timeStr);
    const metaText = metaParts.join(' · ');
    const toolTip = `${toolLabel(s.tool)} · ${sessTitle}`;
    return `
      <div class="sec-item sec-item-session ${isActive ? 'active' : ''}" style="${toolAccent(s.tool)}">
        <button type="button" class="sec-main" data-eat-sec-tab="${esc(s.id)}" title="切换到 ${esc(toolTip)} · 双击标题可重命名">
          <span class="sec-ico ${brand ? 'sec-ico-brand' : ''}" title="${esc(toolLabel(s.tool))}">${toolIcon(s.tool)}</span>
          <span class="sec-text">
            <span class="sec-name" data-eat-sec-name="${esc(s.id)}">${esc(sessTitle)}</span>
            <span class="sec-meta">
              <span class="ea-term-sec-dot ${s.running ? 'is-on' : 'is-off'}"></span>${metaText ? `<span class="sec-meta-dim">${esc(metaText)}</span>` : ''}${flagsHtml(s)}
            </span>
          </span>
        </button>
        <button type="button" class="sec-session-delete" data-eat-session-delete="${esc(s.id)}" title="${deleteLabel}" aria-label="${deleteLabel}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
        </button>
      </div>`;
  };
  // 按时间分组：运行中 / 今天 / 昨天 / 近 7 天 / 更早
  const sessTimeMs = (s) => {
    const raw = s.updatedAt || s.createdAt || s.created_at || '';
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const todayStart = dayStart.getTime();
  const DAY = 86_400_000;
  const bucketOf = (s) => {
    if (s.running) return 'live';
    const t = sessTimeMs(s);
    if (t >= todayStart) return 'today';
    if (t >= todayStart - DAY) return 'yesterday';
    if (t >= todayStart - 6 * DAY) return 'week';
    return 'older';
  };
  const sortByTimeDesc = (a, b) => {
    const dt = sessTimeMs(b) - sessTimeMs(a);
    if (dt !== 0) return dt;
    // 无时间戳时，运行中靠前，再按 id 稳定排序
    if (!!a.running !== !!b.running) return a.running ? -1 : 1;
    return String(b.id || '').localeCompare(String(a.id || ''));
  };
  // 底层数组也按时间排，避免其它入口读到乱序
  tp.sessions.sort(sortByTimeDesc);
  const bucketDefs = [
    { key: 'live', label: '运行中' },
    { key: 'today', label: '今天' },
    { key: 'yesterday', label: '昨天' },
    { key: 'week', label: '近 7 天' },
    { key: 'older', label: '更早' },
  ];
  const buckets = bucketDefs
    .map((g) => ({
      ...g,
      items: tp.sessions.filter((s) => bucketOf(s) === g.key).sort(sortByTimeDesc),
    }))
    .filter((g) => g.items.length);
  const sessionRows = buckets.map((g) => `
        <div class="sec-group-label sec-group-label--time">${esc(g.label)}<span class="sec-group-count">${g.items.length}</span></div>
        ${g.items.map(renderRow).join('')}
      `).join('');
  listEl.innerHTML = newSessionRow + sessionRows;
  // 状态栏的实时用量也同步刷新
  renderTermStatus();
}

// 单独刷状态芯片 / 菜单（terminal-data / terminal-tokens 触发）
function renderTermStatus() {
  refreshStatusOverlay(getState()?.terminalPage);
}

function refreshStatusOverlay(tp) {
  if (!tp) return;
  const host = document.getElementById('eaTerminalPage');
  if (!host) return;
  const chip = host.querySelector('[data-eat-status-chip]');
  if (chip) chip.innerHTML = renderStatusChipInner(tp);
  const menu = host.querySelector('[data-eat-status-menu]');
  if (menu && tp._statusMenuOpen) menu.innerHTML = renderStatusMenuInner(tp);
  const overlay = host.querySelector('[data-eat-status-overlay]');
  if (overlay) overlay.classList.toggle('is-open', !!tp._statusMenuOpen);
  if (menu) menu.classList.toggle('hide', !tp._statusMenuOpen);
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
      rememberBinding: lsGet(LS.rememberBinding, '1') !== '0', // 记住「项目→provider」默认（可取消）
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
  return value === 'custom' ? '' : value;
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
  // 打开 launcher 且填了绝对路径 cwd → 查该项目绑定的 provider 并自动预选（每个 cwd 查一次）
  if (showLauncher && tp.launcher.cwd && tp.launcher.cwd.startsWith('/')
      && tp._bindingLookupKey !== `${tp.launcher.tool}:${tp.launcher.cwd}`) {
    tp._bindingLookupKey = `${tp.launcher.tool}:${tp.launcher.cwd}`;
    applyProjectBindingToLauncher(tp.launcher.cwd, tp.launcher.tool);
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
  startTermSessionsPoller();
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
            ` : activeSess.tool === 'claudecode' ? `
              <button type="button" class="ea-term-ghost-btn" data-eat-claude-continue="${escapeHtml(activeSess.id)}" title="claude --continue — 继续该目录最近一次对话">▶ 接着上次对话继续</button>
              <button type="button" class="ea-term-ghost-btn-secondary" data-eat-restart="${escapeHtml(activeSess.id)}">或重新开一个新会话</button>
            ` : `
              <button type="button" class="ea-term-ghost-btn" data-eat-restart="${escapeHtml(activeSess.id)}">用相同参数重新启动</button>
            `}
            <button type="button" class="ea-term-ghost-btn-secondary" data-eat-forget="${escapeHtml(activeSess.id)}">忘掉这个会话</button>
          </div>
        ` : activeSess?.bridge ? `
          <div class="ea-term-bridge-panel" style="position:relative;top:auto;left:auto;right:auto;margin:24px 16px;pointer-events:auto;">
            <strong>快速通道会话</strong>
            <span>此会话走 app-server（手机 Timeline）。桌面内置终端不能挂载其 TUI，请在手机 App 里查看与操作。</span>
            <em>通道：快速 · app-server</em>
          </div>
        ` : `<div class="ea-term-host" id="eaTermHost"></div>`)}
        ${!showLauncher && !showGhost && !activeSess?.bridge && activeSess?.bootPhase === 'starting' ? `
          <div class="ea-term-boot-banner" role="status">
            <strong>模型加载中</strong>
            <span>Codex 正在完成 SessionConfigured（TUI 会显示 model: loading）。就绪前首句可能进排队，请稍候。</span>
            <em>通道：模拟终端 PTY</em>
          </div>
        ` : ''}
        ${renderStatusBar(tp)}
      </div>
    </div>
    ${tp.paletteOpen ? renderPalette(tp, allProviders) : ''}
  `;

  bindEvents(host);
  bindStatusChipInteractions(host);
  // ghost / launcher / bridge 时不挂 xterm
  const active = tp.sessions.find((s) => s.id === tp.activeSessionId);
  if (active && !active._ghost && !active.bridge && !tp.launcherOpen) {
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
          protocol: 'anthropic',
          credentialType: (provider.authToken || selected.authToken) ? 'auth_token' : 'api_key',
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
  const liveModels = (tp.providerModels?.[tp.launcher.providerKey] || []).filter(Boolean);
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
            ${tp.launcher.providerKey ? `
              <div class="ea-term-launch-row">
                <label class="ea-term-launch-lab"></label>
                <button type="button" class="ea-term-launch-check ${tp.launcher.rememberBinding ? 'is-on' : ''}" data-eat-launch-remember title="勾选后：下次在该目录启动会自动选中此 provider">
                  <span class="ea-term-launch-check-box">${tp.launcher.rememberBinding ? '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5l2.5 2.5 5-5"/></svg>' : ''}</span>
                  <span>记住为该项目默认</span>
                </button>
              </div>
            ` : ''}
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


/** 会话状态：不再占一整行；右下角小芯片 + 长按/点击弹出详情菜单 */
function renderStatusBar(tp) {
  const open = !!tp._statusMenuOpen;
  return `
    <div class="ea-term-status-overlay ${open ? 'is-open' : ''}" data-eat-status-overlay>
      <button type="button" class="ea-term-status-chip" data-eat-status-chip
        title="点击或长按查看会话 / token 详情" aria-label="会话状态" aria-expanded="${open ? 'true' : 'false'}">
        ${renderStatusChipInner(tp)}
      </button>
      <div class="ea-term-status-menu ${open ? '' : 'hide'}" data-eat-status-menu role="dialog" aria-label="会话详情">
        ${renderStatusMenuInner(tp)}
      </div>
    </div>`;
}

function statusSessionMeta(tp) {
  const session = tp.sessions.find((s) => s.id === tp.activeSessionId);
  if (!session) return null;
  const inst = tp.instances[session.id];
  const tokens = session.tokens || inst?.tokens || {};
  const input = Number(tokens.input || 0);
  const cached = Number(tokens.cached || 0);
  const output = Number(tokens.output || 0);
  const reasoning = Number(tokens.reasoning || 0);
  const ctxWindow = Number(tokens.contextWindow || 0);
  const fmt = (n) => (n || 0).toLocaleString();
  const fmtShort = (n) => {
    const v = Number(n || 0);
    if (v < 1000) return String(v);
    if (v < 1_000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
    if (v < 1_000_000_000) return (v / 1_000_000).toFixed(v < 10_000_000 ? 1 : 0).replace(/\.0$/, '') + 'M';
    return (v / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  };
  const customTitle = (() => { try { return (getCustomTitles()[session.id] || '').trim(); } catch (_) { return ''; } })();
  const titleRaw = customTitle || String(session.title || session.command || '');
  const titleShort = customTitle || (titleRaw.split(/\s+/)[0] || titleRaw);
  const noTokens = ctxWindow === 0 && input === 0 && cached === 0 && output === 0;
  const usedPct = ctxWindow > 0 ? Math.min(100, (input / ctxWindow) * 100) : 0;
  const cachePctOfInput = input > 0 ? Math.min(100, (cached / input) * 100) : 0;
  return {
    session, tokens, input, cached, output, reasoning, ctxWindow,
    fmt, fmtShort, titleRaw, titleShort, noTokens, usedPct, cachePctOfInput,
    cwdText: session.cwd || '~',
    toolText: toolDisplayLabel(session.tool),
    providerText: session.providerName || session.providerKey || '',
    isGhost: !!session._ghost,
  };
}

function renderStatusChipInner(tp) {
  const esc = escapeHtml;
  const m = statusSessionMeta(tp);
  if (!m) {
    return `<span class="ea-term-status-faint">无会话</span>`;
  }
  const tokenBrief = m.session.bootPhase === 'starting'
    ? '模型加载中…'
    : (m.noTokens
      ? (m.session.bootPhase === 'ready' ? '已就绪' : '等待 token…')
      : (m.ctxWindow > 0
        ? `${m.fmtShort(m.input)}/${m.fmtShort(m.ctxWindow)}`
        : `入 ${m.fmtShort(m.input)}`));
  return `
    <span class="ea-term-status-dot ${m.session.running ? 'is-on' : 'is-off'} ${m.session.bootPhase === 'starting' ? 'is-boot' : ''}"></span>
    <span class="ea-term-status-chip-title">${esc(m.titleShort)}</span>
    <span class="ea-term-status-chip-sep">·</span>
    <span class="ea-term-status-chip-token ${m.session.bootPhase === 'starting' ? 'is-boot-text' : ''}">${esc(tokenBrief)}</span>
    <span class="ea-term-status-chip-caret" aria-hidden="true">▾</span>
  `;
}

function renderStatusMenuInner(tp) {
  const esc = escapeHtml;
  const m = statusSessionMeta(tp);
  if (!m) {
    return `<div class="ea-term-status-menu-empty">没有运行中的会话</div>`;
  }
  return `
    <div class="ea-term-status-menu-head">
      <span class="ea-term-status-dot ${m.session.running ? 'is-on' : 'is-off'}"></span>
      <div class="ea-term-status-menu-titles">
        <strong title="${esc(m.titleRaw)}">${esc(m.titleShort)}</strong>
        <em>${esc(m.session.running ? '运行中' : '已退出')} · ${esc(m.toolText)}${m.providerText ? ` · ${esc(m.providerText)}` : ''}</em>
      </div>
      <button type="button" class="ea-term-status-menu-x" data-eat-status-close aria-label="关闭">×</button>
    </div>
    <div class="ea-term-status-menu-cwd" title="${esc(m.cwdText)}">${esc(m.cwdText)}</div>
    ${m.noTokens ? `
      <div class="ea-term-status-menu-wait">等待 token…（首条 token_count 写入后显示用量）</div>
    ` : `
      ${m.ctxWindow > 0 ? `
        <div class="ea-term-status-ctx" title="上下文 ${m.fmt(m.input)} / ${m.fmt(m.ctxWindow)} · 缓存 ${m.fmt(m.cached)}">
          <span class="ea-term-status-ctx-label">上下文</span>
          <span class="ea-term-status-ctx-bar">
            <span class="ea-term-status-ctx-fill" style="width:${m.usedPct.toFixed(1)}%"></span>
            <span class="ea-term-status-ctx-cache" style="width:${(m.usedPct * m.cachePctOfInput / 100).toFixed(1)}%"></span>
          </span>
          <span class="ea-term-status-ctx-num">${esc(m.fmtShort(m.input))}/${esc(m.fmtShort(m.ctxWindow))}</span>
        </div>
      ` : ''}
      <div class="ea-term-status-menu-pills">
        <span class="ea-term-status-pill" title="输入 token: ${m.fmt(m.input)}">入 ${esc(m.fmtShort(m.input))}</span>
        <span class="ea-term-status-pill" title="缓存命中: ${m.fmt(m.cached)}">缓 ${esc(m.fmtShort(m.cached))}</span>
        <span class="ea-term-status-pill ea-term-status-pill-tokens" title="输出 token: ${m.fmt(m.output)}">出 ${esc(m.fmtShort(m.output))}</span>
      </div>
    `}
    ${m.isGhost ? '' : `
      <div class="ea-term-status-menu-actions">
        <button type="button" class="ea-term-status-tool" data-eat-term-action="scroll-bottom" title="滚动到底部">滚动到底</button>
        <button type="button" class="ea-term-status-tool" data-eat-term-action="copy-all" title="复制全部输出">复制输出</button>
        <button type="button" class="ea-term-status-tool" data-eat-term-action="clear" title="清屏 (⌃L)">清屏</button>
      </div>
    `}
  `;
}

/** @deprecated keep name for token refresh callers — refreshes chip + open menu */
function renderStatusBarInner(tp) {
  return renderStatusChipInner(tp);
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

// 记住「项目目录 → provider」绑定（复用 /api/project-binding，与主界面同一份存储）
async function rememberProjectBinding(cwd, tool, providerKey) {
  if (!cwd || !cwd.startsWith('/') || !providerKey) return;
  const boundTool = tool === 'claudecode' ? 'claudecode' : tool === 'codex' ? 'codex' : '';
  if (!boundTool) return;
  try {
    await api('/api/project-binding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, tool: boundTool, providerKey }),
    });
  } catch (_) {}
}

// 查该项目绑定的 provider，若存在且在可用列表里则自动预选到 launcher
async function applyProjectBindingToLauncher(cwd, tool) {
  const boundTool = tool === 'claudecode' ? 'claudecode' : tool === 'codex' ? 'codex' : '';
  if (!boundTool) return;
  try {
    const res = await api(`/api/project-binding?cwd=${encodeURIComponent(cwd)}&tool=${encodeURIComponent(boundTool)}`);
    const key = res?.ok && res.data?.binding?.providerKey ? res.data.binding.providerKey : '';
    if (!key) return;
    const tp = getState()?.terminalPage;
    if (!tp || !tp.launcherOpen) return;
    // 只有该 provider 仍在可用列表里才预选，避免选到已删除的
    const rows = listProviderRows(tp.launcher.tool);
    if (rows.some((r) => r.key === key) && tp.launcher.providerKey !== key) {
      tp.launcher.providerKey = key;
      if (getState()?.activePage === 'terminal') renderTerminalPage();
    }
  } catch (_) {}
}

function normalizeSession(s) {
  return {
    id: s.sessionId || s.id || '',
    tool: s.tool || '',
    title: s.title || '',
    displayName: s.displayName || '',
    command: s.commandPreview || s.command || '',
    cwd: s.cwd || '',
    createdAt: s.createdAt || '',
    origin: s.origin || '',
    remoteActive: Boolean(s.remoteActive),
    persistent: Boolean(s.persistent),
    running: Boolean(s.running),
    exitCode: s.exitCode ?? null,
    bridge: Boolean(s.bridge),
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
    // sidebar 双击会话名 → 就地重命名
    document.addEventListener('dblclick', (e) => {
      const tp = getState()?.terminalPage;
      if (!tp) return;
      const target = e.target instanceof Element ? e.target : null;
      const nameEl = target?.closest('[data-eat-sec-name]');
      if (nameEl) {
        e.preventDefault();
        startRenameSession(nameEl.dataset.eatSecName);
      }
    });
  }
}

function setStatusMenuOpen(open) {
  const tp = getState()?.terminalPage;
  if (!tp) return;
  tp._statusMenuOpen = !!open;
  refreshStatusOverlay(tp);
}

function bindStatusChipInteractions(host) {
  const chip = host.querySelector('[data-eat-status-chip]');
  if (!chip || chip.dataset.bound === '1') return;
  chip.dataset.bound = '1';
  let pressTimer = 0;
  let longPressed = false;
  const clearPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0; }
  };
  chip.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    longPressed = false;
    clearPress();
    pressTimer = window.setTimeout(() => {
      longPressed = true;
      setStatusMenuOpen(true);
    }, 420);
  });
  chip.addEventListener('pointerup', () => {
    clearPress();
  });
  chip.addEventListener('pointerleave', clearPress);
  chip.addEventListener('pointercancel', clearPress);
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (longPressed) { longPressed = false; return; }
    const tp = getState()?.terminalPage;
    setStatusMenuOpen(!tp?._statusMenuOpen);
  });
  chip.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    setStatusMenuOpen(true);
  });
}

function onClick(e) {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const tp = getState().terminalPage;
  if (t.closest('[data-eat-status-close]')) {
    setStatusMenuOpen(false);
    return;
  }
  // 点菜单外（含终端区域）关闭；点芯片本身由 chip handler 处理
  if (tp._statusMenuOpen
      && !t.closest('[data-eat-status-menu]')
      && !t.closest('[data-eat-status-chip]')) {
    setStatusMenuOpen(false);
  }
  const termAct = t.closest('[data-eat-term-action]');
  if (termAct) { handleTermToolbarAction(termAct.dataset.eatTermAction); return; }
  if (t.closest('[data-eat-launch-remember]')) {
    tp.launcher.rememberBinding = !tp.launcher.rememberBinding;
    lsSet(LS.rememberBinding, tp.launcher.rememberBinding ? '1' : '0');
    renderTerminalPage();
    return;
  }
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
  const claudeContinue = t.closest('[data-eat-claude-continue]');
  if (claudeContinue) { continueClaudeGhostSession(claudeContinue.dataset.eatClaudeContinue); return; }
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
  const next = clampFontSize(Number(inst.term.options.fontSize || getSavedFontSize()) + delta);
  inst.term.options.fontSize = next;
  saveFontSize(next);                 // 持久化，跨会话 / 重启生效
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

// 把 xterm 完整 scrollback + 可视区拼成纯文本（供"复制全部输出"）
function getTerminalBufferText(term) {
  try {
    const buf = term?.buffer?.active;
    if (!buf) return '';
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n').replace(/\s+$/, '') + '\n';
  } catch (_) { return ''; }
}

// 终端状态栏工具条：清屏 / 复制全部输出 / 滚动到底（作用于当前 active session）
function handleTermToolbarAction(act) {
  const tp = getState()?.terminalPage;
  if (!tp) return;
  const inst = tp.instances?.[tp.activeSessionId];
  if (!inst?.term) { flash('当前没有可操作的终端', 'warning'); return; }
  if (act === 'clear') {
    try { inst.term.clear(); } catch (_) {}
    try { inst.term.focus(); } catch (_) {}
    return;
  }
  if (act === 'scroll-bottom') {
    try { inst.term.scrollToBottom(); } catch (_) {}
    try { inst.term.focus(); } catch (_) {}
    return;
  }
  if (act === 'copy-all') {
    const text = getTerminalBufferText(inst.term);
    if (!text.trim()) { flash('没有可复制的输出', 'warning'); return; }
    try {
      navigator.clipboard?.writeText(text)
        .then(() => flash('已复制全部输出', 'success'))
        .catch(() => flash('复制失败', 'warning'));
    } catch (_) { flash('复制失败', 'warning'); }
    return;
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
    // 项目绑定/选中 provider 直接生效：用 -c 覆盖本次启动的 model_provider，
    // 不改全局 config.toml（provider 定义已存在于 config，codex 照常解析其 key）。
    if (!isOfficial && tp.launcher.providerKey && !tp.launcher.providerKey.startsWith('__')) {
      args.push('-c', `model_provider="${tp.launcher.providerKey}"`);
    }
  }
  if (finalModel) args.push('--model', finalModel);
  // 额外 raw 参数最后追
  const rawFlags = (tp.launcher.flags || '').trim().split(/\s+/).filter(Boolean);
  args.push(...rawFlags);
  const title = `${bin}${args.length ? ' ' + args[0] : ''}`;
  const commandPreview = [bin, ...args].join(' ');
  const spawnSize = measureTerminalSpawnSize();
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
        cols: spawnSize.cols,
        rows: spawnSize.rows,
      }),
    });
    if (res?.ok && res.data?.terminalSession) {
      const session = normalizeSession(res.data.terminalSession);
      // 记下原始 spawn 参数 — 给 [重启] 用
      session.program = bin;
      session.args = args;
      session.tool = tp.launcher.tool;
      session.cwd = tp.launcher.cwd || session.cwd || '';
      if (isCodex) session.bootPhase = 'starting';
      // 记下本次 provider — 状态栏展示 + 语义化
      session.providerKey = (!isOfficial && tp.launcher.providerKey && !tp.launcher.providerKey.startsWith('__')) ? tp.launcher.providerKey : '';
      session.providerName = isOfficial ? '官方登录' : (selectedProvider?.name || '');
      tp.sessions.unshift(session);
      tp.activeSessionId = session.id;
      tp.launcherOpen = false; // 启动后自动收 popover
      persistOneSession(session);
      // 记住「该项目目录 → 该 provider」，下次同目录启动自动预选（勾选时才写）
      if (tp.launcher.rememberBinding && !isOfficial && tp.launcher.providerKey && !tp.launcher.providerKey.startsWith('__')) {
        rememberProjectBinding(tp.launcher.cwd, tp.launcher.tool, tp.launcher.providerKey);
      }
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
  const spawnSize = measureTerminalSpawnSize();
  try {
    const res = await api('/api/terminal/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: ghost.tool, program: bin, args,
        cwd: ghost.cwd || '', title: `codex ↩ ${ghost.codexSessionId.slice(0, 8)}`,
        commandPreview: [bin, ...args].join(' '),
        cols: spawnSize.cols, rows: spawnSize.rows,
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

// 用 `claude --continue` 接着该目录最近一次对话继续（Claude Code 没有独立的
// session-id 流，--continue 会自动挑当前 cwd 里最近的会话）。
async function continueClaudeGhostSession(sessionId) {
  const tp = getState().terminalPage;
  const ghost = tp.sessions.find((s) => s.id === sessionId);
  if (!ghost) return;
  const bin = ghost.program || 'claude';
  const origArgs = Array.isArray(ghost.args)
    ? ghost.args.filter((a) => a !== '--continue' && a !== '-c' && a !== '--resume')
    : [];
  const args = ['--continue', ...origArgs];
  const spawnSize = measureTerminalSpawnSize();
  try {
    const res = await api('/api/terminal/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: ghost.tool, program: bin, args,
        cwd: ghost.cwd || '', title: `claude ↩ 续接`,
        commandPreview: [bin, ...args].join(' '),
        env: ghost.env || undefined,
        cols: spawnSize.cols, rows: spawnSize.rows,
      }),
    });
    if (res?.ok && res.data?.terminalSession) {
      const fresh = normalizeSession(res.data.terminalSession);
      fresh.program = bin; fresh.args = args; fresh.tool = ghost.tool; fresh.cwd = ghost.cwd; fresh.env = ghost.env;
      const idx = tp.sessions.findIndex((s) => s.id === sessionId);
      if (idx >= 0) tp.sessions[idx] = fresh;
      else tp.sessions.unshift(fresh);
      tp.activeSessionId = fresh.id;
      forgetPersistedSession(sessionId);
      persistOneSession(fresh);
      flash('已接续 Claude 会话', 'success');
    } else {
      flash(`续接失败: ${res?.error || '未知'}`, 'error');
    }
  } catch (err) {
    flash(`续接异常: ${err.message || err}`, 'error');
  }
  renderTerminalPage();
}

async function restartGhostSession(sessionId) {
  const tp = getState().terminalPage;
  const ghost = tp.sessions.find((s) => s.id === sessionId);
  if (!ghost) return;
  const bin = ghost.program || (ghost.tool === 'codex' ? 'codex' : ghost.tool === 'claudecode' ? 'claude' : 'codex');
  const args = Array.isArray(ghost.args) ? ghost.args : [];
  const spawnSize = measureTerminalSpawnSize();
  // 直接调 spawn 接口（绕过 launcher 表单）
  try {
    const res = await api('/api/terminal/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: ghost.tool, program: bin, args,
        cwd: ghost.cwd || '', title: ghost.title || bin,
        commandPreview: ghost.command || [bin, ...args].join(' '),
        cols: spawnSize.cols, rows: spawnSize.rows,
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

// 轻量 in-DOM 确认框（避开 window.confirm）— 返回 Promise<boolean>。
// message 允许传入已转义的 HTML（调用方负责 escapeHtml）。
function confirmModal({ title = '确认', message = '', confirmText = '确认', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    ensureRemoteStyles();
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { document.removeEventListener('keydown', onKey, true); } catch (_) {}
      try { scrim.remove(); } catch (_) {}
      resolve(val);
    };
    const scrim = document.createElement('div');
    scrim.className = 'ea-term-confirm-scrim';
    scrim.innerHTML = `
      <div class="ea-term-confirm-box" role="dialog" aria-modal="true">
        <div class="ea-term-confirm-title">${escapeHtml(title)}</div>
        ${message ? `<div class="ea-term-confirm-msg">${message}</div>` : ''}
        <div class="ea-term-confirm-foot">
          <button type="button" class="ea-term-confirm-btn ghost" data-cf="cancel">${escapeHtml(cancelText)}</button>
          <button type="button" class="ea-term-confirm-btn ${danger ? 'danger' : ''}" data-cf="ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    scrim.addEventListener('click', (e) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el === scrim) { finish(false); return; }
      const btn = el?.closest('[data-cf]');
      if (btn) finish(btn.dataset.cf === 'ok');
    });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    requestAnimationFrame(() => { try { scrim.querySelector('[data-cf="ok"]')?.focus(); } catch (_) {} });
  });
}

// sidebar 会话名就地重命名：把 .sec-name 换成 input，Enter/失焦保存到 localStorage
function startRenameSession(sessionId) {
  const listEl = document.getElementById('eaTermSecList');
  if (!listEl || !sessionId) return;
  let selector = '';
  try {
    const safe = (window.CSS && typeof CSS.escape === 'function') ? CSS.escape(sessionId) : sessionId;
    selector = `[data-eat-sec-name="${safe}"]`;
  } catch (_) { selector = ''; }
  const nameEl = selector ? listEl.querySelector(selector) : null;
  if (!nameEl || nameEl.querySelector('input')) return;
  const tp = getState()?.terminalPage;
  if (!tp) return;
  const sess = tp.sessions.find((s) => s.id === sessionId);
  const current = getSessionTitle(sess);
  tp._renamingSessionId = sessionId; // 阻止 renderTermSidebar 冲掉 input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ea-term-sec-rename-input';
  input.value = current;
  input.maxLength = 60;
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  try { input.select(); } catch (_) {}
  let closed = false;
  const commit = (save) => {
    if (closed) return;
    closed = true;
    if (save) setSessionCustomTitle(sessionId, input.value);
    if (getState()?.terminalPage) getState().terminalPage._renamingSessionId = '';
    renderTermSidebar();
  };
  const stop = (e) => e.stopPropagation();
  input.addEventListener('mousedown', stop);
  input.addEventListener('click', stop);
  input.addEventListener('dblclick', stop);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

async function deleteTerminalSession(sessionId) {
  const tp = getState()?.terminalPage;
  if (!tp || !sessionId) return;
  const sess = tp.sessions.find((s) => s.id === sessionId);
  if (sess?._ghost) {
    forgetGhostSession(sessionId);
    return;
  }
  // 运行中的会话：先确认再结束（关闭会 kill PTY 进程）
  if (sess?.running) {
    const ok = await confirmModal({
      title: '结束并删除会话？',
      message: `“${escapeHtml(getSessionTitle(sess))}”正在运行，关闭会终止该终端进程且不可恢复。`,
      confirmText: '结束会话',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
  }
  closeSession(sessionId);
}

async function closeSession(sessionId) {
  const tp = getState().terminalPage;
  try {
    await api('/api/terminal/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // remove:true → 同时从 Rust session map 删除，避免已关闭会话堆积泄漏
      body: JSON.stringify({ sessionId, remove: true }),
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
        fontSize: getSavedFontSize(),
        lineHeight: 1.15,
        letterSpacing: 0,
        scrollback: 10000,
        scrollSensitivity: 1,
        fastScrollModifier: 'alt',
        fastScrollSensitivity: 5,
        theme: currentTermTheme(),
        allowProposedApi: true,
        macOptionIsMeta: true,
        altClickMovesCursor: false,
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
      // Codex TUI（/usage 日历、model picker）列宽不够会截断/乱码；列数过少时自动略缩字号再 fit
      inst.fit.fit();
      let cols = inst.term.cols || 0;
      const fontNow = Number(inst.term.options.fontSize || getSavedFontSize());
      if (cols > 0 && cols < 110 && fontNow > TERM_FONT_MIN + 1) {
        const next = Math.max(TERM_FONT_MIN, fontNow - 1);
        if (next !== fontNow) {
          inst.term.options.fontSize = next;
          // 不写入 localStorage：只是本次窗口自适应，避免永久改用户偏好
          inst.fit.fit();
          cols = inst.term.cols || cols;
        }
      }
      inst.term.refresh(0, Math.max(0, inst.term.rows - 1));
      notifyResize(sessionId, inst);
    } catch (_) {}
  };
  requestAnimationFrame(fitOnce);
  setTimeout(fitOnce, 0);
  setTimeout(fitOnce, 80);
  setTimeout(fitOnce, 220);
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

const __termWriteQueues = new Map();

async function sendInput(sessionId, data) {
  if (!sessionId || data == null || data === '') return;
  // 同帧合并按键/鼠标序列，串行 flush，避免每个字符一次 IPC 造成卡顿与乱序
  let q = __termWriteQueues.get(sessionId);
  if (!q) {
    q = { buf: '', flushing: false, raf: 0 };
    __termWriteQueues.set(sessionId, q);
  }
  q.buf += data;
  if (q.raf || q.flushing) return;
  q.raf = requestAnimationFrame(() => {
    q.raf = 0;
    flushTerminalWriteQueue(sessionId);
  });
}

async function flushTerminalWriteQueue(sessionId) {
  const q = __termWriteQueues.get(sessionId);
  if (!q || q.flushing) return;
  q.flushing = true;
  try {
    while (q.buf) {
      const payload = q.buf;
      q.buf = '';
      try {
        await api('/api/terminal/write', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, data: payload }),
          timeoutMs: 8000,
        });
      } catch (_) {}
    }
  } finally {
    q.flushing = false;
    if (q.buf) {
      q.raf = requestAnimationFrame(() => {
        q.raf = 0;
        flushTerminalWriteQueue(sessionId);
      });
    }
  }
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
      data = sanitizeTerminalOutputChunk(data);
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

// ─── 手机端远程访问面板 ────────────────────────────────────────────────
// 独立挂到 body，不受 terminal 页 re-render 影响。调用 /api/remote/* 后端。
let __eaRemoteStatus = null;
let __eaRemoteBusy = false;      // 请求进行中 → 按钮禁用
let __eaRemoteTimer = 0;         // 面板打开时的 3s 自动刷新
let __eaRemoteError = '';        // 最近一次拉取错误
let __eaRemoteCheckResult = null; // VPS 前置检查结果
let __eaRemoteTab = 'wifi';        // 'wifi' | 'vps'

// 隧道表单 + 端口偏好：持久化到 localStorage，重启后回填
function defaultTunnelForm() { return { host: '', sshUser: 'root', sshPort: '22', remotePort: '8790', identityFile: '' }; }
function loadRemotePrefs() {
  const saved = lsGetJson(LS.remoteTunnel, null);
  window.__eaRemoteTunnelForm = { ...defaultTunnelForm(), ...(saved && typeof saved === 'object' ? saved : {}) };
  window.__eaRemotePort = lsGet(LS.remotePort, '');
}
function saveRemotePrefs() {
  try { lsSetJson(LS.remoteTunnel, window.__eaRemoteTunnelForm || defaultTunnelForm()); } catch (_) {}
  try { lsSet(LS.remotePort, window.__eaRemotePort || ''); } catch (_) {}
}

function ensureRemoteStyles() {
  // 每次都刷新内容：避免旧样式赖在 DOM 里不更新（之前"改了没生效"的坑）。
  let style = document.getElementById('eaRemoteStyles');
  if (!style) {
    style = document.createElement('style');
    style.id = 'eaRemoteStyles';
    document.head.appendChild(style);
  }
  style.textContent = `
    /* 全部跟随 App 主题变量（明/暗自动切换），扁平、无卡片、用分隔线区隔。 */
    .ea-remote-scrim{position:fixed;inset:0;background:rgba(4,7,12,.5);backdrop-filter:blur(4px);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px}
    .ea-remote-box{width:min(460px,96vw);max-height:92vh;overflow:auto;background:var(--bg-elevated);border:1px solid var(--line);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.28);padding:20px}
    .ea-remote-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
    .ea-remote-title{font-size:16px;font-weight:700;color:var(--text)}
    .ea-remote-x{background:transparent!important;border:none!important;color:var(--muted)!important;font-size:20px;cursor:pointer;line-height:1;height:auto!important;padding:2px 6px!important;box-shadow:none!important}
    .ea-remote-sub{font-size:12.5px;color:var(--muted);line-height:1.6;margin:0 0 6px}
    /* 行：无填充框，仅上下分隔线 */
    .ea-remote-row{margin:0}
    .ea-remote-toggle,.ea-remote-autostart{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 0;border-top:1px solid var(--line-soft)}
    .ea-remote-toggle b,.ea-remote-autostart b{font-size:14px;font-weight:600;color:var(--text)}
    .ea-remote-toggle .st,.ea-remote-autostart span{display:block;font-size:12px;color:var(--muted);margin-top:2px}
    .ea-remote-btn{border:none!important;border-radius:9px!important;height:auto!important;padding:9px 16px!important;font-size:13px;font-weight:600;cursor:pointer;color:#fff!important;background:var(--accent)!important;box-shadow:none;transition:filter .12s,opacity .12s}
    .ea-remote-btn:hover{filter:brightness(1.05)}
    .ea-remote-btn.off{background:var(--bg-btn-secondary)!important;color:var(--text)!important;box-shadow:none}
    .ea-remote-btn.ghost{background:transparent!important;color:var(--text)!important;border:1px solid var(--line)!important;box-shadow:none}
    .ea-remote-btn.ghost:hover{border-color:var(--accent)!important}
    .ea-remote-btn[disabled]{opacity:.5;cursor:not-allowed;filter:none;box-shadow:none}
    .ea-remote-btn.busy{opacity:.7;cursor:progress}
    /* QR：功能性白底块（扫码需高对比），居中、无多余装饰 */
    .ea-remote-qr{display:flex;flex-direction:column;align-items:center;gap:10px;width:fit-content;margin:16px auto;padding:14px;border-radius:14px;background:#fff;border:1px solid var(--line)}
    .ea-remote-qr svg{width:190px;height:190px;display:block}
    .ea-remote-url{max-width:220px;font-size:11.5px;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;color:#0b0e14;text-align:center}
    .ea-remote-field{margin:10px 0}
    .ea-remote-field label{display:block;font-size:11.5px;color:var(--muted);margin-bottom:5px}
    .ea-remote-field input,.ea-remote-port input{width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--line);background:var(--bg-input);color:var(--text);font-size:13px;outline:none}
    .ea-remote-field input::placeholder,.ea-remote-port input::placeholder{color:var(--text-placeholder)}
    .ea-remote-field input:focus,.ea-remote-port input:focus{border-color:var(--accent)}
    .ea-remote-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .ea-remote-sec{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
    .ea-remote-sec-h{font-size:13.5px;font-weight:700;color:var(--text);margin-bottom:6px}
    .ea-remote-warn{font-size:11.5px;color:var(--muted);line-height:1.55;margin-top:8px}
    .ea-remote-howto{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.55;color:var(--muted);padding:12px 0}
    .ea-remote-howto b{color:var(--text);font-weight:600}
    .ea-remote-howto svg{flex:0 0 auto;margin-top:1px;color:var(--accent)}
    .ea-remote-live{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)}
    .ea-remote-live .dot{width:6px;height:6px;border-radius:50%;background:#3fbf72;box-shadow:0 0 6px rgba(63,191,114,.6)}
    .ea-remote-copyrow{display:flex;gap:8px;margin-top:2px}
    .ea-remote-copyrow .ea-remote-btn{flex:1}
    .ea-remote-port{margin:14px 0 4px}
    .ea-remote-port label{display:block;font-size:11.5px;color:var(--muted);margin-bottom:5px}
    .ea-remote-port input{font-variant-numeric:tabular-nums}
    .ea-remote-apk{font-size:11.5px;color:var(--muted);text-align:center;margin:8px 0 2px}
    .ea-remote-apk-card{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 16px;margin:0 0 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg-input)}
    .ea-remote-apk-copy{min-width:0}
    .ea-remote-apk-copy b{display:block;font-size:14px;font-weight:700;color:var(--text)}
    .ea-remote-apk-copy span{display:block;margin-top:3px;font-size:12px;color:var(--muted);line-height:1.45}
    .ea-remote-apk-btn{flex:0 0 auto;white-space:nowrap}
    .ea-remote-error{font-size:12px;color:#e0564f;background:rgba(224,86,79,.08);border:1px solid rgba(224,86,79,.25);border-radius:10px;padding:9px 11px;margin:8px 0;display:flex;align-items:center;justify-content:space-between;gap:8px}
    .ea-remote-error button{background:transparent!important;border:1px solid rgba(224,86,79,.4)!important;color:#e0564f!important;border-radius:8px!important;height:auto!important;padding:4px 10px!important;font-size:11px;cursor:pointer;box-shadow:none!important}
    .ea-remote-switch{position:relative;width:44px!important;height:26px!important;border-radius:999px!important;border:none!important;background:var(--bg-hover)!important;cursor:pointer;flex:0 0 auto;padding:0!important;box-shadow:none!important;transition:background .18s}
    .ea-remote-switch .knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .18s}
    .ea-remote-switch.on{background:var(--accent)!important}
    .ea-remote-switch.on .knob{left:21px}
    .ea-remote-switch[disabled]{opacity:.5;cursor:not-allowed}
    .ea-remote-check{margin-top:12px;padding:12px;border-radius:10px;font-size:12px;border:1px solid var(--line)}
    .ea-remote-check.ok{border-color:rgba(63,191,114,.4);background:rgba(63,191,114,.08)}
    .ea-remote-check.warn{border-color:rgba(224,150,60,.4);background:rgba(224,150,60,.08)}
    .ea-remote-check.bad{border-color:rgba(224,86,79,.4);background:rgba(224,86,79,.08)}
    .ea-remote-check-row{display:flex;align-items:center;justify-content:space-between;color:var(--muted);margin-bottom:4px}
    .ea-remote-check-row b{color:var(--text)}
    .ea-remote-check-hint{margin-top:7px;font-size:11.5px;line-height:1.55;color:var(--muted)}
    .ea-remote-loading{display:flex;align-items:center;justify-content:center;gap:8px;font-size:12px;color:var(--muted);padding:20px 0}
    .ea-remote-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--accent);animation:eaRemoteSpin .7s linear infinite}
    @keyframes eaRemoteSpin{to{transform:rotate(360deg)}}
    /* Tab（本地 WiFi / VPS 中转）：下划线式，和「全部/官方 OAuth」一致，无填色块 */
    .ea-remote-tabs{display:flex;gap:24px;margin:20px 0 2px;padding:0;background:transparent;border-bottom:1px solid var(--line)}
    .ea-remote-tab{display:inline-flex;align-items:center;gap:7px;height:auto!important;padding:10px 2px!important;border:none!important;border-bottom:2px solid transparent!important;border-radius:0!important;margin-bottom:-1px;background:transparent!important;color:var(--muted)!important;font-size:13.5px;font-weight:600;cursor:pointer;box-shadow:none!important;transition:color .14s,border-color .14s}
    .ea-remote-tab svg{opacity:.8}
    .ea-remote-tab:hover{color:var(--text)!important;transform:none!important}
    .ea-remote-tab.on{color:var(--text)!important;border-bottom-color:var(--accent)!important}
    .ea-remote-tabbody{padding-top:6px}
    .ea-remote-hint{font-size:12.5px;color:var(--muted);line-height:1.6;padding:12px 0 4px}
    .ea-remote-linkbtn{background:none!important;border:none!important;color:var(--accent)!important;font-size:12.5px;cursor:pointer;height:auto!important;padding:0 2px!important;box-shadow:none!important;text-decoration:underline}
    .ea-remote-ips{display:flex;flex-wrap:wrap;gap:8px}
    .ea-remote-ip{height:auto!important;padding:7px 12px!important;border-radius:8px!important;border:1px solid var(--line)!important;background:var(--bg-input)!important;color:var(--text)!important;font-size:12.5px;font-variant-numeric:tabular-nums;cursor:pointer;box-shadow:none!important;transition:border-color .12s,background .12s}
    .ea-remote-ip:hover{border-color:var(--accent)!important;transform:none!important}
    .ea-remote-ip.on{border-color:var(--accent)!important;background:var(--accent-glow)!important;color:var(--accent-strong)!important}
    .ea-remote-ip.ghost{background:transparent!important;color:var(--muted)!important}
    /* 独立「远程」页面：占满主区宽度，宽屏配置与二维码并排 */
    .ea-remote-view{width:100%;max-width:none;margin:0;padding:4px 4px 28px;box-sizing:border-box}
    .ea-remote-toolbar{display:none}
    .ea-remote-view-card{background:transparent;border:none;padding:0;min-width:0;width:100%}
    .ea-remote-side{display:none}
    .ea-remote-cols{display:block;margin-top:0}
    .ea-remote-status-actions{display:inline-flex;align-items:center;gap:8px;flex-shrink:0}
    .ea-remote-wifi-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,320px);gap:28px 36px;align-items:start;margin-top:8px}
    @media (max-width:980px){.ea-remote-wifi-grid{grid-template-columns:1fr}}
    .ea-remote-wifi-main{min-width:0}
    .ea-remote-wifi-qr{display:flex;flex-direction:column;align-items:center;gap:10px;justify-self:end}
    @media (max-width:980px){.ea-remote-wifi-qr{justify-self:center}}
    .ea-remote-qr{display:flex;flex-direction:column;align-items:center;gap:10px;width:fit-content;margin:0;padding:16px;border-radius:14px;background:#fff;border:1px solid var(--line)}
    .ea-remote-qr svg{width:220px;height:220px;display:block}
    .ea-remote-url{max-width:260px;font-size:11.5px;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;color:#0b0e14;text-align:center}
    /* 二级栏已连接列表 */
    #eaRemoteSecList{display:flex;flex-direction:column;gap:6px;padding:4px 0 12px}
    #eaRemoteSecList .ea-remote-client{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;background:var(--bg-input);border:1px solid transparent}
    #eaRemoteSecList .ea-remote-client.online{border-color:rgba(63,191,114,.28)}
    #eaRemoteSecList .ea-remote-client-dot{width:8px;height:8px;flex:0 0 auto;border-radius:50%;background:var(--muted)}
    #eaRemoteSecList .ea-remote-client.online .ea-remote-client-dot{background:#3fbf72;box-shadow:0 0 6px rgba(63,191,114,.55)}
    #eaRemoteSecList .ea-remote-client-main{min-width:0;flex:1}
    #eaRemoteSecList .ea-remote-client-ip{font-size:13px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #eaRemoteSecList .ea-remote-client-meta{font-size:11px;color:var(--muted);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #eaRemoteSecList .ea-remote-client.offline{opacity:.55}
    #eaRemoteSecList .ea-remote-clients-empty{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;color:var(--muted);padding:28px 12px;font-size:12.5px}
    #eaRemoteSecList .ea-remote-clients-empty svg{color:var(--faint);opacity:.7}
    #eaRemoteSecCount.on{color:#2fa860}
    .ea-remote-side-head,.ea-remote-side-count,.ea-remote-hero,.ea-remote-hero-badge,.ea-remote-hero-text,.ea-remote-hero-title,.ea-remote-hero-sub{display:none}
    .ea-remote-clients{display:flex;flex-direction:column;gap:6px;max-height:60vh;overflow:auto}
    .ea-remote-client{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;background:var(--bg-input);border:1px solid transparent}
    .ea-remote-client.online{border-color:rgba(63,191,114,.28)}
    .ea-remote-client-dot{width:8px;height:8px;flex:0 0 auto;border-radius:50%;background:var(--muted)}
    .ea-remote-client.online .ea-remote-client-dot{background:#3fbf72;box-shadow:0 0 6px rgba(63,191,114,.6)}
    .ea-remote-client-main{min-width:0;flex:1}
    .ea-remote-client-ip{font-size:13px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ea-remote-client-meta{font-size:11px;color:var(--muted);margin-top:1px}
    .ea-remote-client.offline{opacity:.6}
    .ea-remote-clients-empty{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;color:var(--muted);padding:26px 10px;font-size:12.5px}
    .ea-remote-clients-empty svg{color:var(--faint);opacity:.7}
    .ea-remote-clients-empty span{font-size:11px;color:var(--faint)}
    /* 轻量确认框（结束运行中会话前）*/
    .ea-term-confirm-scrim{position:fixed;inset:0;background:rgba(4,7,12,.5);backdrop-filter:blur(3px);z-index:9600;display:flex;align-items:center;justify-content:center;padding:20px}
    .ea-term-confirm-box{width:min(360px,94vw);background:var(--bg-elevated);border:1px solid var(--line);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.28);padding:18px}
    .ea-term-confirm-title{font-size:15px;font-weight:700;color:var(--text);margin-bottom:8px}
    .ea-term-confirm-msg{font-size:12.5px;line-height:1.6;color:var(--muted);margin-bottom:16px}
    .ea-term-confirm-foot{display:flex;justify-content:flex-end;gap:10px}
    .ea-term-confirm-btn{border:1px solid var(--line)!important;border-radius:9px!important;height:auto!important;padding:8px 16px!important;font-size:13px;font-weight:600;cursor:pointer;color:var(--text)!important;background:transparent!important;box-shadow:none!important;transition:border-color .12s,background .12s}
    .ea-term-confirm-btn.ghost:hover{border-color:var(--accent)!important}
    .ea-term-confirm-btn.danger{background:#e0564f!important;color:#fff!important;border-color:transparent!important}
    .ea-term-confirm-btn.danger:hover{filter:brightness(1.05)}
  `;
}

async function openRemotePanel() {
  ensureRemoteStyles();
  loadRemotePrefs();
  __eaRemoteError = '';
  let scrim = document.getElementById('eaRemoteScrim');
  if (!scrim) {
    scrim = document.createElement('div');
    scrim.id = 'eaRemoteScrim';
    scrim.className = 'ea-remote-scrim';
    document.body.appendChild(scrim);
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) { closeRemotePanel(); return; }
      const act = e.target instanceof Element ? e.target.closest('[data-rmt]') : null;
      if (act) handleRemoteAction(act.dataset.rmt, act);
    });
  }
  scrim.style.display = 'flex';
  renderRemotePanel({ loading: true });
  await refreshRemoteStatus();
  // 面板打开期间每 3s 自动刷新状态；关闭 / 面板消失时清掉
  if (__eaRemoteTimer) { clearInterval(__eaRemoteTimer); __eaRemoteTimer = 0; }
  __eaRemoteTimer = setInterval(() => {
    const el = document.getElementById('eaRemoteScrim');
    if (!el || el.style.display === 'none') { clearInterval(__eaRemoteTimer); __eaRemoteTimer = 0; return; }
    if (__eaRemoteBusy) return; // 有请求在飞就跳过这一拍，避免打断
    refreshRemoteStatus({ silent: true });
  }, 3000);
}

function closeRemotePanel() {
  if (__eaRemoteTimer) { clearInterval(__eaRemoteTimer); __eaRemoteTimer = 0; }
  const scrim = document.getElementById('eaRemoteScrim');
  if (scrim) scrim.style.display = 'none';
}

async function refreshRemoteStatus(opts = {}) {
  try {
    const res = await api('/api/remote/status');
    if (res?.ok) { __eaRemoteStatus = res.data || { enabled: false }; __eaRemoteError = ''; }
    else { __eaRemoteStatus = __eaRemoteStatus || { enabled: false }; __eaRemoteError = res?.error || '读取远程状态失败'; }
  } catch (err) {
    __eaRemoteStatus = __eaRemoteStatus || { enabled: false };
    __eaRemoteError = err?.message || '读取远程状态失败';
  }
  renderRemotePanel(opts);
}

// 远程面板主体（头部之后的公共内容），模态弹窗与独立页面共用。
// 结构：状态区（服务开关 / 开机自启）→ Tab（本地 WiFi / VPS 中转）→ 对应内容。
function remoteBodyMarkup(s, opts = {}) {
  const esc = escapeHtml;
  const enabled = !!s.enabled;
  const loading = !!opts.loading && !__eaRemoteStatus;
  const busy = __eaRemoteBusy;
  const dis = busy ? 'disabled' : '';
  const busyCls = busy ? 'busy' : '';

  if (loading) {
    return `<div class="ea-remote-loading"><span class="ea-remote-spin"></span>正在读取远程服务状态…</div>`;
  }

  const statusBlock = `
    ${__eaRemoteError ? `<div class="ea-remote-error"><span>⚠ ${esc(__eaRemoteError)}</span><button data-rmt="refresh">重试</button></div>` : ''}
    <div class="ea-remote-apk-card">
      <div class="ea-remote-apk-copy">
        <b>还没装手机 App？</b>
        <span>先下载 Android APK 安装，再扫码连接本机。</span>
      </div>
      <button class="ea-remote-btn ea-remote-apk-btn" data-rmt="download-apk" type="button">下载 APK</button>
    </div>
    <div class="ea-remote-toggle">
      <div><b>本机远程服务</b><span class="st">${enabled ? `运行中 · 端口 ${esc(String(s.port || ''))} <span class="ea-remote-live"><span class="dot"></span>实时</span>` : '已关闭'}</span></div>
      <div class="ea-remote-status-actions">
        <button class="ea-remote-btn ghost ${busyCls}" data-rmt="refresh" ${dis}>刷新</button>
        <button class="ea-remote-btn ${enabled ? 'off' : ''} ${busyCls}" data-rmt="toggle-server" ${dis}>${busy ? '处理中…' : (enabled ? '关闭' : '开启')}</button>
      </div>
    </div>
    <div class="ea-remote-autostart">
      <div><b>开机自启</b><span>桌面启动即自动开启远程${s.autoStart ? '（含已保存的 VPS 隧道）' : ''}</span></div>
      <button class="ea-remote-switch ${s.autoStart ? 'on' : ''} ${busyCls}" data-rmt="toggle-autostart" ${dis} role="switch" aria-checked="${s.autoStart ? 'true' : 'false'}"><span class="knob"></span></button>
    </div>`;

  const tabs = `
    <div class="ea-remote-tabs" role="tablist">
      <button class="ea-remote-tab ${__eaRemoteTab === 'wifi' ? 'on' : ''}" data-rmt="tab-wifi" role="tab">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5a10 10 0 0 1 14 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M12 19.5h.01"/></svg>
        本地 WiFi
      </button>
      <button class="ea-remote-tab ${__eaRemoteTab === 'vps' ? 'on' : ''}" data-rmt="tab-vps" role="tab">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/></svg>
        VPS 中转
      </button>
    </div>`;

  const body = __eaRemoteTab === 'wifi'
    ? remoteWifiTab(s, esc, busy, dis, busyCls, enabled)
    : remoteVpsTab(s, esc, busy, dis, busyCls, enabled);

  return `${statusBlock}${tabs}<div class="ea-remote-tabbody">${body}</div>`;
}

// 本地 WiFi tab：未开→提示先开；已开→二维码 + IP 选择 + 复制。
function remoteWifiTab(s, esc, busy, dis, busyCls, enabled) {
  const portVal = window.__eaRemotePort != null ? window.__eaRemotePort : '';
  if (!enabled) {
    return `
      <div class="ea-remote-hint">先开启本机远程服务，即可生成二维码，手机同一 WiFi 下扫码直连。</div>
      <div class="ea-remote-field">
        <label>自定义端口（可选，留空自动分配）</label>
        <input data-rmt-port type="number" min="1" max="65535" value="${esc(String(portVal))}" placeholder="如 8790" ${dis}/>
      </div>`;
  }
  const urls = Array.isArray(s.urls) ? s.urls : [];
  const chosen = s.chosenIp || '';
  const ipOptions = urls.length ? `
    <div class="ea-remote-field">
      <label>手机要连的本机地址（多网卡 / 有 VPN 时可切换）</label>
      <div class="ea-remote-ips">
        ${urls.map((u) => `<button class="ea-remote-ip ${u.ip === chosen ? 'on' : ''} ${busyCls}" data-rmt="pick-ip" data-ip="${esc(u.ip)}" ${dis}>${esc(u.ip)}</button>`).join('')}
        <button class="ea-remote-ip ghost ${busyCls}" data-rmt="manual-ip" ${dis}>手动填 IP</button>
      </div>
    </div>` : `
    <div class="ea-remote-hint">未检测到局域网地址。点「手动填 IP」输入电脑在 WiFi 里的地址（形如 192.168.x.x）。
      <button class="ea-remote-linkbtn" data-rmt="manual-ip">手动填 IP</button>
    </div>`;
  return `
    <div class="ea-remote-wifi-grid">
      <div class="ea-remote-wifi-main">
        ${ipOptions}
        <div class="ea-remote-copyrow">
          <button class="ea-remote-btn ghost ${busyCls}" data-rmt="copy" ${dis}>复制链接</button>
          <button class="ea-remote-btn ghost ${busyCls}" data-rmt="copy-token" ${dis}>复制 token</button>
        </div>
        <div class="ea-remote-warn">手机 App 或浏览器扫码 / 粘贴链接即可配对。该地址仅局域网可达、凭 token 授权，用完可关闭服务。</div>
      </div>
      ${s.qrSvg ? `
        <div class="ea-remote-wifi-qr">
          <div class="ea-remote-qr">
            ${s.qrSvg}
            <div class="ea-remote-url">${esc(s.primaryUrl || '')}</div>
          </div>
        </div>
      ` : ''}
    </div>`;
}

// VPS tab：需要先开本机服务；再填 VPS 建反向隧道走公网 / 4G。
function remoteVpsTab(s, esc, busy, dis, busyCls, enabled) {
  const t = (window.__eaRemoteTunnelForm = window.__eaRemoteTunnelForm || defaultTunnelForm());
  const tunnel = s.tunnel || { active: false };
  if (!enabled) {
    return `<div class="ea-remote-hint">请先在上方开启本机远程服务，再建立 VPS 隧道。</div>`;
  }
  if (tunnel.active) {
    return `
      <div class="ea-remote-toggle">
        <div><b>隧道运行中</b><span class="st">${esc(tunnel.url || `${tunnel.host || ''}:${tunnel.remotePort || ''}`)}</span></div>
        <button class="ea-remote-btn off ${busyCls}" data-rmt="tunnel-stop" ${dis}>断开</button>
      </div>
      <div class="ea-remote-warn">手机在任意网络（4G / 其它 WiFi）下访问上面的地址即可远程操作。</div>`;
  }
  return `
    <div class="ea-remote-hint">通过一台有公网 IP 的 VPS 反向中转，手机可跨网络访问。需本机已配置 ssh 免密登录该 VPS。</div>
    <div class="ea-remote-field"><label>VPS 地址 (host / IP)</label><input data-rmt-f="host" value="${esc(t.host)}" placeholder="例如 1.2.3.4 或 vps.example.com"/></div>
    <div class="ea-remote-grid">
      <div class="ea-remote-field"><label>SSH 用户</label><input data-rmt-f="sshUser" value="${esc(t.sshUser)}" placeholder="root"/></div>
      <div class="ea-remote-field"><label>SSH 端口</label><input data-rmt-f="sshPort" value="${esc(t.sshPort)}" placeholder="22"/></div>
    </div>
    <div class="ea-remote-grid">
      <div class="ea-remote-field"><label>VPS 对外端口</label><input data-rmt-f="remotePort" value="${esc(t.remotePort)}" placeholder="8790"/></div>
      <div class="ea-remote-field"><label>私钥文件（可选）</label><input data-rmt-f="identityFile" value="${esc(t.identityFile)}" placeholder="~/.ssh/id_rsa"/></div>
    </div>
    <div class="ea-remote-grid" style="margin-top:6px">
      <button class="ea-remote-btn ghost ${busyCls}" data-rmt="tunnel-check" ${dis}>${busy ? '…' : '① 检查 VPS'}</button>
      <button class="ea-remote-btn ${busyCls}" data-rmt="tunnel-start" ${dis}>${busy ? '处理中…' : '② 建立隧道'}</button>
    </div>
    ${__eaRemoteCheckResult ? `
      <div class="ea-remote-check ${__eaRemoteCheckResult.sshOk ? (__eaRemoteCheckResult.gatewayPorts === 'yes' ? 'ok' : 'warn') : 'bad'}">
        <div class="ea-remote-check-row"><span>SSH 免密登录</span><b>${__eaRemoteCheckResult.sshOk ? '✓ 已通' : '✗ 未通'}</b></div>
        <div class="ea-remote-check-row"><span>GatewayPorts</span><b>${__eaRemoteCheckResult.gatewayPorts === 'yes' ? '✓ 已开启' : __eaRemoteCheckResult.gatewayPorts === 'no' ? '✗ 未开启' : '? 未知'}</b></div>
        <div class="ea-remote-check-hint">${esc(__eaRemoteCheckResult.hint || '')}</div>
      </div>
    ` : ''}
    <div class="ea-remote-warn">需 VPS 的 sshd 开启 <code>GatewayPorts yes</code> 才能对外暴露端口。</div>`;
}

function captureRemoteFocus(container) {
  const activeEl = document.activeElement;
  const focusKey = (activeEl && container.contains(activeEl))
    ? ((activeEl.dataset && activeEl.dataset.rmtF) || (activeEl.hasAttribute && activeEl.hasAttribute('data-rmt-port') ? '__port__' : ''))
    : '';
  let selStart = null, selEnd = null;
  try { selStart = activeEl && activeEl.selectionStart; selEnd = activeEl && activeEl.selectionEnd; } catch (_) {}
  return { focusKey, selStart, selEnd };
}

function bindRemoteInputs(container) {
  container.querySelectorAll('[data-rmt-f]').forEach((inp) => {
    inp.addEventListener('input', () => {
      window.__eaRemoteTunnelForm[inp.dataset.rmtF] = inp.value;
      saveRemotePrefs();
    });
  });
  const portInp = container.querySelector('[data-rmt-port]');
  if (portInp) {
    portInp.addEventListener('input', () => { window.__eaRemotePort = portInp.value; saveRemotePrefs(); });
  }
}

function restoreRemoteFocus(container, cap) {
  if (!cap || !cap.focusKey) return;
  const sel = cap.focusKey === '__port__'
    ? container.querySelector('[data-rmt-port]')
    : container.querySelector(`[data-rmt-f="${cap.focusKey}"]`);
  if (sel) {
    try { sel.focus(); } catch (_) {}
    try { if (cap.selStart != null) sel.setSelectionRange(cap.selStart, cap.selEnd); } catch (_) {}
  }
}

// 模态弹窗渲染（旧入口，保留兼容）
function renderRemoteModal(opts = {}) {
  const scrim = document.getElementById('eaRemoteScrim');
  if (!scrim) return;
  const cap = captureRemoteFocus(scrim);
  const s = __eaRemoteStatus || {};
  scrim.innerHTML = `
    <div class="ea-remote-box">
      <div class="ea-remote-head">
        <div class="ea-remote-title">📱 手机端远程访问</div>
        <button class="ea-remote-x" data-rmt="close" aria-label="关闭">×</button>
      </div>
      <div class="ea-remote-sub">在手机浏览器打开下方地址（或扫码），即可远程查看 / 操作本机的 Codex、Claude Code 终端会话。</div>
      ${remoteBodyMarkup(s, opts)}
    </div>`;
  bindRemoteInputs(scrim);
  restoreRemoteFocus(scrim, cap);
}

// 独立页面渲染（左侧导航「远程」页）：顶栏已有标题，这里只放配置主体；
// 「已连接手机」进二级栏，避免三套标题 + 空中间栏。
function renderRemotePageFull(opts = {}) {
  const host = document.getElementById('eaRemotePage');
  if (!host) return;
  ensureRemoteStyles();
  const cap = captureRemoteFocus(host);
  const s = __eaRemoteStatus || {};
  host.innerHTML = `
    <div class="ea-remote-view">
      <div class="ea-remote-view-card">
        ${remoteBodyMarkup(s, opts)}
      </div>
    </div>`;
  syncRemoteSecondary(s);
  bindRemoteInputs(host);
  restoreRemoteFocus(host, cap);
}

// 左侧「已连接手机」列表：在线优先，显示 IP / 在线状态 / 最近活跃 / 设备类型。
function remoteClientsMarkup(s) {
  const esc = escapeHtml;
  const clients = Array.isArray(s?.clients) ? s.clients : [];
  const rel = (ms) => {
    if (!ms) return '';
    const d = Date.now() - Number(ms);
    if (d < 15000) return '刚刚';
    if (d < 60000) return `${Math.floor(d / 1000)} 秒前`;
    if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
    return `${Math.floor(d / 3600000)} 小时前`;
  };
  const uaShort = (ua) => {
    const u = String(ua || '');
    if (/Android/i.test(u)) return 'Android';
    if (/iPhone|iPad|iOS/i.test(u)) return 'iPhone';
    if (/Dart|Flutter/i.test(u)) return 'App';
    if (/Mac/i.test(u)) return 'Mac';
    if (/Windows/i.test(u)) return 'Windows';
    return u ? u.slice(0, 14) : '';
  };
  if (!clients.length) {
    return `
      <div class="ea-remote-clients-empty">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/></svg>
        <div>还没有手机连接</div>
        <span>扫码配对后会出现在这里</span>
      </div>`;
  }
  return clients.map((c) => `
    <div class="ea-remote-client ${c.online ? 'online' : 'offline'}">
      <span class="ea-remote-client-dot"></span>
      <div class="ea-remote-client-main">
        <div class="ea-remote-client-ip">${esc(c.ip || '')}</div>
        <div class="ea-remote-client-meta">${c.online ? '在线' : '离线'}${c.lastSeenMs ? ` · ${esc(rel(c.lastSeenMs))}` : ''}${uaShort(c.userAgent) ? ` · ${esc(uaShort(c.userAgent))}` : ''}</div>
      </div>
    </div>`).join('');
}

function syncRemoteSecondary(s) {
  const clients = Array.isArray(s?.clients) ? s.clients : [];
  const onlineCount = clients.filter((c) => c.online).length;
  const list = document.getElementById('eaRemoteSecList');
  const count = document.getElementById('eaRemoteSecCount');
  if (list) list.innerHTML = remoteClientsMarkup(s || {});
  if (count) {
    count.textContent = `${onlineCount} 在线`;
    count.classList.toggle('on', onlineCount > 0);
  }
}

// 分发：在「远程」页时渲染整页，否则渲染模态。
function renderRemotePanel(opts = {}) {
  if (getState()?.activePage === 'remote' && document.getElementById('eaRemotePage')) {
    renderRemotePageFull(opts);
  } else {
    renderRemoteModal(opts);
  }
}

// 会话列表实时轮询：拉 PTY 列表 + bridge 列表，合并手机新建会话并标快速/模拟。
let __eaTermSessionsTimer = 0;
async function refreshTermSessionsLive() {
  const tp = getState()?.terminalPage;
  if (!tp) return;
  if (getState()?.activePage !== 'terminal') return;
  try {
    const [ptyRes, brRes] = await Promise.all([
      api('/api/terminal/list'),
      api('/api/codex/list').catch(() => null),
    ]);
    const rows = ptyRes?.ok && Array.isArray(ptyRes.data?.rows) ? ptyRes.data.rows : [];
    const bridgeRows = brRes?.ok && Array.isArray(brRes.data?.sessions)
      ? brRes.data.sessions
      : [];
    let changed = false;
    const liveIds = new Set();
    for (const row of rows.map(normalizeSession)) {
      liveIds.add(row.id);
      const existing = tp.sessions.find((s) => s.id === row.id);
      if (existing) {
        if (existing.origin !== row.origin) { existing.origin = row.origin; changed = true; }
        if (existing.remoteActive !== row.remoteActive) { existing.remoteActive = row.remoteActive; changed = true; }
        if (row.displayName && existing.displayName !== row.displayName) { existing.displayName = row.displayName; changed = true; }
        if (existing.running !== row.running) { existing.running = row.running; changed = true; }
        if (existing.bridge) { existing.bridge = false; changed = true; }
        existing._ghost = false;
      } else {
        tp.sessions.push(row);
        changed = true;
      }
    }
    for (const raw of bridgeRows) {
      const row = normalizeSession(raw);
      if (!row.id) continue;
      liveIds.add(row.id);
      row.bridge = true;
      row.tool = row.tool || 'codex';
      const existing = tp.sessions.find((s) => s.id === row.id);
      if (existing) {
        if (!existing.bridge) { existing.bridge = true; changed = true; }
        if (existing.origin !== row.origin) { existing.origin = row.origin; changed = true; }
        if (existing.running !== row.running) { existing.running = row.running; changed = true; }
        if (row.title && existing.title !== row.title) { existing.title = row.title; changed = true; }
        existing._ghost = false;
      } else {
        tp.sessions.push(row);
        changed = true;
      }
    }
    // bridge 会话从列表消失 → 标退出
    for (const s of tp.sessions) {
      if (s.bridge && !liveIds.has(s.id) && s.running) {
        s.running = false;
        changed = true;
      }
    }
    if (changed) {
      renderTermSidebar();
      // 启动门闩横幅依赖 bootPhase；会话合并后刷主区状态
      try { renderTermStatus(); } catch (_) {}
    }
  } catch (_) {}
}
export function startTermSessionsPoller() {
  if (__eaTermSessionsTimer) return;
  __eaTermSessionsTimer = setInterval(() => {
    if (getState()?.activePage !== 'terminal') { clearInterval(__eaTermSessionsTimer); __eaTermSessionsTimer = 0; return; }
    refreshTermSessionsLive();
  }, 4000);
}
window.startTermSessionsPoller = startTermSessionsPoller;

// 由 app.js setPage('remote') 调用：进入远程页 → 拉状态 + 3s 自动刷新。
let __eaRemotePageTimer = 0;
export function renderRemotePage() {
  ensureRemoteStyles();
  loadRemotePrefs();
  __eaRemoteError = '';
  const host = document.getElementById('eaRemotePage');
  if (host && host.dataset.rmtBound !== '1') {
    host.dataset.rmtBound = '1';
    host.addEventListener('click', (e) => {
      const act = e.target instanceof Element ? e.target.closest('[data-rmt]') : null;
      if (act) handleRemoteAction(act.dataset.rmt, act);
    });
  }
  renderRemotePageFull({ loading: !__eaRemoteStatus });
  refreshRemoteStatus();
  if (__eaRemotePageTimer) { clearInterval(__eaRemotePageTimer); __eaRemotePageTimer = 0; }
  __eaRemotePageTimer = setInterval(() => {
    if (getState()?.activePage !== 'remote') { clearInterval(__eaRemotePageTimer); __eaRemotePageTimer = 0; return; }
    if (__eaRemoteBusy) return;
    refreshRemoteStatus({ silent: true });
  }, 3000);
}
window.renderRemotePage = renderRemotePage;

async function handleRemoteAction(action, el) {
  if (action === 'close') { closeRemotePanel(); return; }
  // Tab 切换：纯前端，不受 busy 限制
  if (action === 'tab-wifi') { __eaRemoteTab = 'wifi'; renderRemotePanel(); return; }
  if (action === 'tab-vps') { __eaRemoteTab = 'vps'; renderRemotePanel(); return; }
  if (action === 'download-apk') {
    const url = typeof window.androidApkDownloadUrl === 'function'
      ? window.androidApkDownloadUrl()
      : 'https://download.cursorxyz.it.com/EasyAIConfig_1.0.74.apk';
    if (typeof window.openExternalUrl === 'function') void window.openExternalUrl(url);
    else window.open(url, '_blank');
    flash('正在打开 APK 下载…', 'info');
    return;
  }
  if (__eaRemoteBusy && action !== 'refresh') return; // 有请求在飞，忽略重复点击
  if (action === 'refresh') { __eaRemoteError = ''; await refreshRemoteStatus(); return; }
  if (action === 'pick-ip' || action === 'manual-ip') {
    let ip = el?.dataset?.ip || '';
    if (action === 'manual-ip') {
      const cur = __eaRemoteStatus?.chosenIp || '';
      const input = window.prompt('输入电脑在 WiFi 里的地址（形如 192.168.10.15，留空清除）', cur);
      if (input == null) return;
      ip = input.trim();
    }
    __eaRemoteBusy = true; renderRemotePanel();
    try {
      const res = await api('/api/remote/set-ip', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }),
      });
      if (res?.ok) { __eaRemoteStatus = res.data; flash(ip ? `已切换地址为 ${ip}` : '已恢复自动选择', 'success'); }
      else flash(res?.error || '设置失败', 'error');
    } catch (err) { flash(`设置异常: ${err.message || err}`, 'error'); }
    finally { __eaRemoteBusy = false; renderRemotePanel(); }
    return;
  }
  if (action === 'copy') {
    const url = __eaRemoteStatus?.primaryUrl || '';
    if (url) navigator.clipboard?.writeText(url).then(() => flash('已复制链接', 'success')).catch(() => flash('复制失败', 'warning'));
    else flash('暂无可复制的链接', 'warning');
    return;
  }
  if (action === 'copy-token') {
    const token = __eaRemoteStatus?.token || '';
    if (token) navigator.clipboard?.writeText(token).then(() => flash('已复制 token', 'success')).catch(() => flash('复制失败', 'warning'));
    else flash('暂无 token', 'warning');
    return;
  }
  if (action === 'toggle-server') {
    const enabled = !!__eaRemoteStatus?.enabled;
    __eaRemoteBusy = true; renderRemotePanel();
    try {
      const body = {};
      if (!enabled) {
        const p = parseInt(String(window.__eaRemotePort || '').trim(), 10);
        if (Number.isFinite(p) && p > 0 && p <= 65535) body.port = p;
        saveRemotePrefs();
      }
      const res = await api(enabled ? '/api/remote/stop' : '/api/remote/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res?.ok) { __eaRemoteStatus = res.data; __eaRemoteError = ''; flash(enabled ? '已关闭远程服务' : '远程服务已开启', 'success'); }
      else flash(res?.error || '操作失败', 'error');
    } catch (err) { flash(`操作异常: ${err.message || err}`, 'error'); }
    finally { __eaRemoteBusy = false; renderRemotePanel(); }
    return;
  }
  if (action === 'toggle-autostart') {
    const next = !(__eaRemoteStatus?.autoStart);
    __eaRemoteBusy = true; renderRemotePanel();
    try {
      const res = await api('/api/remote/autostart', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (res?.ok) { __eaRemoteStatus = res.data; flash(next ? '已开启开机自启' : '已关闭开机自启', 'success'); }
      else flash(res?.error || '设置失败', 'error');
    } catch (err) { flash(`设置异常: ${err.message || err}`, 'error'); }
    finally { __eaRemoteBusy = false; renderRemotePanel(); }
    return;
  }
  if (action === 'tunnel-check') {
    const t = window.__eaRemoteTunnelForm || {};
    if (!t.host?.trim()) { flash('请先填写 VPS 地址', 'warning'); return; }
    saveRemotePrefs();
    __eaRemoteBusy = true; __eaRemoteCheckResult = null; renderRemotePanel();
    try {
      const res = await api('/api/remote/tunnel/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: t.host, sshUser: t.sshUser, sshPort: t.sshPort, identityFile: t.identityFile }),
      });
      __eaRemoteCheckResult = res?.ok
        ? res.data
        : { sshOk: false, gatewayPorts: 'unknown', hint: res?.error || '检查失败' };
    } catch (err) {
      __eaRemoteCheckResult = { sshOk: false, gatewayPorts: 'unknown', hint: `检查异常: ${err.message || err}` };
    } finally { __eaRemoteBusy = false; renderRemotePanel(); }
    return;
  }
  if (action === 'tunnel-start') {
    const t = window.__eaRemoteTunnelForm || {};
    if (!t.host?.trim()) { flash('请填写 VPS 地址', 'warning'); return; }
    saveRemotePrefs();
    __eaRemoteBusy = true; renderRemotePanel();
    try {
      const res = await api('/api/remote/tunnel/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: t.host, sshUser: t.sshUser, sshPort: t.sshPort, remotePort: t.remotePort, identityFile: t.identityFile }),
      });
      if (res?.ok) { __eaRemoteStatus = res.data; flash('VPS 隧道已建立', 'success'); }
      else flash(res?.error || '隧道建立失败', 'error');
    } catch (err) { flash(`隧道异常: ${err.message || err}`, 'error'); }
    finally { __eaRemoteBusy = false; renderRemotePanel(); }
    return;
  }
  if (action === 'tunnel-stop') {
    __eaRemoteBusy = true; renderRemotePanel();
    try {
      await api('/api/remote/tunnel/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      flash('已断开 VPS 隧道', 'info');
    } catch (err) { flash(`断开异常: ${err.message || err}`, 'error'); }
    finally { __eaRemoteBusy = false; await refreshRemoteStatus(); }
    return;
  }
}

// 暴露给 app.js setPage 调用
window.renderTerminalPage = renderTerminalPage;
window.initTerminalPageState = initTerminalPageState;
