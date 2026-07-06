import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getCodexUsageMetrics,
  getOpenCodeUsageMetrics,
  loadClaudeCodeState,
} from './config-store.js';
import { listSessionInventory } from './session-manager.js';

const DEFAULT_TOOLS = [
  'codex',
  'claudecode',
  'opencode',
  'gemini',
  'openclaw',
  'hermes',
  'qwen-code',
  'codebuddy-code',
  'cline',
  'roo-code',
  'kilo-code',
  'continue',
  'cursor',
  'windsurf',
  'zed',
  'trae',
  'qoder',
  'zcode',
  'lingma',
];
const SESSION_USAGE_TOOL_META = {
  gemini: { label: 'Gemini CLI session analytics', provider: 'google-gemini' },
  openclaw: { label: 'OpenClaw session analytics', provider: 'unknown' },
  hermes: { label: 'Hermes Agent session analytics', provider: 'unknown' },
  'qwen-code': { label: 'Qwen Code session analytics', provider: 'qwen' },
  'codebuddy-code': { label: 'CodeBuddy Code session analytics', provider: 'tencent-codebuddy' },
  cline: { label: 'Cline extension activity', provider: 'extension' },
  'roo-code': { label: 'Roo Code extension activity', provider: 'extension' },
  'kilo-code': { label: 'Kilo Code extension activity', provider: 'extension' },
  continue: { label: 'Continue extension activity', provider: 'extension' },
  cursor: { label: 'Cursor activity', provider: 'editor' },
  windsurf: { label: 'Windsurf activity', provider: 'editor' },
  zed: { label: 'Zed activity', provider: 'editor' },
  trae: { label: 'Trae activity', provider: 'editor' },
  qoder: { label: 'Qoder activity', provider: 'editor' },
  zcode: { label: 'ZCode activity', provider: 'editor' },
  lingma: { label: 'Tongyi Lingma activity', provider: 'editor' },
};

function normalizeTool(value = '') {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (key === 'claude' || key === 'claudecode') return 'claudecode';
  if (key === 'codex' || key === 'openaicodex') return 'codex';
  if (key === 'opencode') return 'opencode';
  if (key === 'gemini' || key === 'geminicli') return 'gemini';
  if (key === 'openclaw') return 'openclaw';
  if (key === 'hermes' || key === 'hermesagent') return 'hermes';
  if (['qwen', 'qwencode', 'qwencli', 'qwencodecli'].includes(key)) return 'qwen-code';
  if (['codebuddy', 'codebuddycode', 'codebuddycli', 'tencentcodebuddy'].includes(key)) return 'codebuddy-code';
  if (['roo', 'roocode', 'roocline'].includes(key)) return 'roo-code';
  if (['kilo', 'kilocode'].includes(key)) return 'kilo-code';
  if (['continue', 'continuedev'].includes(key)) return 'continue';
  if (['cursor', 'cursoreditor'].includes(key)) return 'cursor';
  if (['windsurf', 'codeiumwindsurf'].includes(key)) return 'windsurf';
  if (['zed', 'zededitor'].includes(key)) return 'zed';
  if (['trae', 'traeai'].includes(key)) return 'trae';
  if (['qoder', 'qoderide'].includes(key)) return 'qoder';
  if (['zcode', 'zai', 'zaiide'].includes(key)) return 'zcode';
  if (['lingma', 'tongyilingma', 'aliyunlingma', 'qodercn'].includes(key)) return 'lingma';
  if (['cline', 'clineextension'].includes(key)) return 'cline';
  return key;
}

function appHome() {
  return path.join(os.homedir(), '.codex-config-ui');
}

function defaultPriceBookPath() {
  return path.join(appHome(), 'custom-prices.json');
}

function clampDays(days) {
  return Math.max(1, Math.min(365, Number(days) || 30));
}

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function createTotals() {
  return {
    input: 0,
    cachedInput: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheCreation: 0,
    total: 0,
    cost: 0,
    officialCost: 0,
    requests: 0,
  };
}

function addTotals(target, patch = {}) {
  for (const key of Object.keys(target)) {
    target[key] += num(patch[key]);
  }
  return target;
}

function normalizeDate(value) {
  const parsed = Date.parse(String(value || ''));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function normalizeUpdatedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function sumEvents(items = []) {
  return items.reduce((sum, item) => sum + num(item?.events), 0);
}

function normalizeCodexTotals(totals = {}, requests = 0) {
  return {
    input: num(totals.input),
    cachedInput: num(totals.cachedInput),
    output: num(totals.output),
    reasoning: num(totals.reasoning),
    cacheRead: 0,
    cacheCreation: 0,
    total: num(totals.total),
    cost: 0,
    officialCost: 0,
    requests,
  };
}

function normalizeOpenCodeTotals(totals = {}, requests = 0) {
  return {
    input: num(totals.input),
    cachedInput: 0,
    output: num(totals.output),
    reasoning: num(totals.reasoning),
    cacheRead: num(totals.cacheRead),
    cacheCreation: num(totals.cacheCreation),
    total: num(totals.total),
    cost: num(totals.cost),
    officialCost: 0,
    requests,
  };
}

function normalizeClaudeTotals(totals = {}, requests = 0, officialCost = 0) {
  return {
    input: num(totals.input),
    cachedInput: 0,
    output: num(totals.output),
    reasoning: 0,
    cacheRead: num(totals.cacheRead),
    cacheCreation: num(totals.cacheCreation),
    total: num(totals.total),
    cost: num(totals.cost),
    officialCost: num(officialCost),
    requests,
  };
}

function normalizeDaily(tool, daily = []) {
  return (Array.isArray(daily) ? daily : [])
    .map((item) => ({
      tool,
      date: normalizeDate(item.date),
      totals: tool === 'opencode'
        ? normalizeOpenCodeTotals(item)
        : (tool === 'claudecode' ? normalizeClaudeTotals(item) : normalizeCodexTotals(item)),
    }))
    .filter((item) => item.date);
}

function normalizeSessionLog(tool, item = {}, index = 0) {
  const sessionId = String(item.sessionId || item.id || `session-${index + 1}`).trim();
  const provider = String(item.provider || (tool === 'claudecode' ? 'anthropic' : 'unknown')).trim() || 'unknown';
  const model = String(item.model || 'unknown').trim() || 'unknown';
  const totals = tool === 'opencode'
    ? normalizeOpenCodeTotals(item, 1)
    : (tool === 'claudecode' ? normalizeClaudeTotals(item, 1) : normalizeCodexTotals(item, 1));
  return {
    id: `${tool}:${sessionId}`,
    tool,
    sessionId,
    title: String(item.title || sessionId).trim(),
    provider,
    model,
    projectPath: String(item.cwd || item.directory || item.projectPath || '').trim(),
    updatedAt: normalizeUpdatedAt(item.updatedAt),
    totals,
    cost: totals.cost,
    sourceScope: String(item.scopeLabel || '').trim(),
  };
}

function normalizeDimension(tool, kind, entries = []) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const key = String(entry?.[kind] || entry?.name || 'unknown').trim() || 'unknown';
    const events = num(entry?.events);
    let totals;
    if (tool === 'opencode') totals = normalizeOpenCodeTotals(entry?.totals || entry, events);
    else if (tool === 'claudecode') totals = normalizeClaudeTotals(entry?.totals || entry, events);
    else totals = normalizeCodexTotals(entry?.totals || entry, events);
    return { tool, [kind]: key, totals, events };
  });
}

function normalizeCodexSource(metrics = {}) {
  const requests = sumEvents(metrics.providers) || (Array.isArray(metrics.sessions) ? metrics.sessions.length : 0);
  const sessions = (Array.isArray(metrics.sessions) ? metrics.sessions : []).map((item, index) => normalizeSessionLog('codex', item, index));
  return {
    tool: 'codex',
    label: 'Codex local usage',
    ok: metrics.ok !== false,
    source: String(metrics.source || '').trim(),
    sourceType: String(metrics.sourceType || '').trim(),
    generatedAt: metrics.generatedAt || '',
    totals: normalizeCodexTotals(metrics.totals, requests),
    daily: normalizeDaily('codex', metrics.daily),
    providers: normalizeDimension('codex', 'provider', metrics.providers),
    models: normalizeDimension('codex', 'model', metrics.models),
    requestLogs: sessions,
    warnings: [],
  };
}

function normalizeOpenCodeSource(metrics = {}) {
  const requests = sumEvents(metrics.providers) || (Array.isArray(metrics.sessions) ? metrics.sessions.length : 0);
  const sessions = (Array.isArray(metrics.sessions) ? metrics.sessions : []).map((item, index) => normalizeSessionLog('opencode', item, index));
  return {
    tool: 'opencode',
    label: 'OpenCode local usage',
    ok: metrics.ok !== false,
    source: String(metrics.source || '').trim(),
    sourceType: String(metrics.sourceType || '').trim(),
    generatedAt: metrics.generatedAt || '',
    totals: normalizeOpenCodeTotals(metrics.totals, requests),
    daily: normalizeDaily('opencode', metrics.daily),
    providers: normalizeDimension('opencode', 'provider', metrics.providers),
    models: normalizeDimension('opencode', 'model', metrics.models),
    requestLogs: sessions,
    warnings: [],
  };
}

function normalizeClaudeSource(input = {}) {
  const usage = input.usage && typeof input.usage === 'object' ? input.usage : input;
  const sessions = (Array.isArray(usage.sessions) ? usage.sessions : []).map((item, index) => normalizeSessionLog('claudecode', item, index));
  const requests = num(usage.messagesInWindow) || sessions.length;
  const models = normalizeDimension('claudecode', 'model', usage.models);
  const providerTotals = normalizeClaudeTotals(usage.totals, requests, usage.officialCost);
  return {
    tool: 'claudecode',
    label: 'Claude Code local usage',
    ok: !usage.cacheMiss,
    source: String(usage.source || '').trim(),
    sourceType: usage.aggregated ? 'multi-scope-jsonl' : 'jsonl',
    generatedAt: usage.generatedAt || '',
    scopeLabel: usage.scopeLabel || '',
    totals: providerTotals,
    daily: normalizeDaily('claudecode', usage.daily),
    providers: [{ tool: 'claudecode', provider: 'anthropic', totals: providerTotals, events: requests }],
    models,
    requestLogs: sessions,
    warnings: usage.cacheMiss ? ['cache miss'] : [],
  };
}

function sessionIdFromItem(tool, item = {}, index = 0) {
  const explicit = String(item.sessionId || '').trim();
  if (explicit) return explicit;
  const id = String(item.id || '').trim();
  if (id.startsWith(`${tool}:`)) return id.slice(tool.length + 1) || `session-${index + 1}`;
  return id || `session-${index + 1}`;
}

function sourcePathsFromInventory(inventory = {}) {
  return (Array.isArray(inventory.sources) ? inventory.sources : [])
    .map((source) => source.sourcePath || source.path || source.label || source.tool || '')
    .filter(Boolean);
}

function normalizeSessionUsageTotals(logs = []) {
  return logs.reduce((totals, item) => addTotals(totals, item.totals), createTotals());
}

function normalizeSessionUsageDaily(tool, logs = []) {
  const byDate = new Map();
  for (const log of logs) {
    const date = normalizeDate(log.updatedAt);
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, { tool, date, totals: createTotals() });
    addTotals(byDate.get(date).totals, log.totals);
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function normalizeSessionUsageDimension(tool, logs = [], kind) {
  const byKey = new Map();
  for (const log of logs) {
    const key = String(log[kind] || 'unknown').trim() || 'unknown';
    if (!byKey.has(key)) byKey.set(key, { tool, [kind]: key, totals: createTotals(), events: 0 });
    const target = byKey.get(key);
    addTotals(target.totals, log.totals);
    target.events += num(log.totals?.requests || 1);
  }
  return [...byKey.values()].sort((left, right) => num(right.events) - num(left.events));
}

function normalizeSessionBackedUsageSource(tool, inventory = {}) {
  const meta = SESSION_USAGE_TOOL_META[tool] || { label: `${tool} session analytics`, provider: 'unknown' };
  const items = Array.isArray(inventory.items) ? inventory.items : [];
  const requestLogs = items.map((item, index) => normalizeSessionLog(tool, {
    ...item,
    ...(item.totals && typeof item.totals === 'object' ? item.totals : {}),
    sessionId: sessionIdFromItem(tool, item, index),
    provider: item.provider || meta.provider,
    cwd: item.cwd || item.projectPath || item.directory || '',
    updatedAt: item.updatedAt || item.updatedAtMs || item.createdAt || '',
  }, index));
  const sources = Array.isArray(inventory.sources) ? inventory.sources : [];
  const warnings = sources
    .filter((source) => source.parseError || source.readError)
    .map((source) => `${source.label || source.tool || tool}: ${source.parseError || source.readError}`);
  const sourcePaths = sourcePathsFromInventory(inventory);
  return {
    tool,
    label: meta.label,
    ok: warnings.length === 0,
    source: sourcePaths.join(' | '),
    sourceType: 'session-backed',
    generatedAt: inventory.generatedAt || new Date().toISOString(),
    totals: normalizeSessionUsageTotals(requestLogs),
    daily: normalizeSessionUsageDaily(tool, requestLogs),
    providers: normalizeSessionUsageDimension(tool, requestLogs, 'provider'),
    models: normalizeSessionUsageDimension(tool, requestLogs, 'model'),
    requestLogs,
    warnings,
  };
}

function errorSource(tool, error) {
  return {
    tool,
    label: `${tool} usage`,
    ok: false,
    source: '',
    sourceType: 'error',
    generatedAt: new Date().toISOString(),
    totals: createTotals(),
    daily: [],
    providers: [],
    models: [],
    requestLogs: [],
    warnings: [error instanceof Error ? error.message : String(error)],
  };
}

function mergeDaily(sources = []) {
  const byDate = new Map();
  for (const source of sources) {
    for (const item of source.daily || []) {
      if (!item.date) continue;
      if (!byDate.has(item.date)) byDate.set(item.date, { date: item.date, totals: createTotals(), tools: {} });
      const target = byDate.get(item.date);
      addTotals(target.totals, item.totals);
      target.tools[source.tool] = item.totals;
    }
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function mergeDimension(sources = [], kind) {
  const map = new Map();
  for (const source of sources) {
    for (const item of source[`${kind}s`] || []) {
      const key = String(item[kind] || 'unknown').trim() || 'unknown';
      if (!map.has(key)) map.set(key, { [kind]: key, totals: createTotals(), events: 0, tools: {} });
      const target = map.get(key);
      addTotals(target.totals, item.totals);
      target.events += num(item.events || item.totals?.requests);
      target.tools[source.tool] = (target.tools[source.tool] || 0) + num(item.events || item.totals?.requests);
    }
  }
  return [...map.values()].sort((left, right) => num(right.totals.total) - num(left.totals.total));
}

async function loadSource(tool, options) {
  const loaders = options.loaders || {};
  if (tool === 'codex') {
    const metrics = loaders.codex
      ? await loaders.codex(options)
      : await getCodexUsageMetrics({
        codexHome: options.codexHome,
        days: options.days,
        force: Boolean(options.force),
        cacheOnly: Boolean(options.cacheOnly),
      });
    return normalizeCodexSource(metrics);
  }
  if (tool === 'opencode') {
    const metrics = loaders.opencode
      ? await loaders.opencode(options)
      : await getOpenCodeUsageMetrics({ days: options.days });
    return normalizeOpenCodeSource(metrics);
  }
  if (tool === 'claudecode') {
    const state = loaders.claudecode
      ? await loaders.claudecode(options)
      : await loadClaudeCodeState({
        cacheOnly: Boolean(options.cacheOnly),
        usageScope: options.claudeUsageScope || options.usageScope || 'active',
      });
    return normalizeClaudeSource(state);
  }
  if (SESSION_USAGE_TOOL_META[tool]) {
    const inventory = loaders[tool]
      ? await loaders[tool](options)
      : await listSessionInventory({ ...options, includeTools: [tool] });
    return normalizeSessionBackedUsageSource(tool, inventory);
  }
  return errorSource(tool, 'usage source is not implemented');
}

export async function readCustomPriceBook(options = {}) {
  const priceBookPath = path.resolve(String(options.priceBookPath || defaultPriceBookPath()));
  let raw = '';
  try {
    raw = await fs.readFile(priceBookPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!raw.trim()) {
    return {
      schema: 'easyaiconfig.custom-prices.v1',
      priceBookPath,
      models: [],
      updatedAt: '',
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Custom price book parse failed: ${error.message}`);
  }
  const models = Array.isArray(parsed.models) ? parsed.models : [];
  return {
    schema: parsed.schema || 'easyaiconfig.custom-prices.v1',
    priceBookPath,
    models: models.map((item) => ({
      model: String(item.model || '').trim(),
      provider: String(item.provider || '').trim(),
      currency: String(item.currency || 'USD').trim() || 'USD',
      inputPerMTok: num(item.inputPerMTok),
      outputPerMTok: num(item.outputPerMTok),
      cacheReadPerMTok: num(item.cacheReadPerMTok),
      cacheCreatePerMTok: num(item.cacheCreatePerMTok),
      reasoningPerMTok: num(item.reasoningPerMTok),
    })).filter((item) => item.model),
    updatedAt: parsed.updatedAt || '',
  };
}

export async function saveCustomPriceBook(payload = {}, options = {}) {
  const priceBookPath = path.resolve(String(options.priceBookPath || defaultPriceBookPath()));
  const models = Array.isArray(payload.models) ? payload.models : [];
  const next = {
    schema: 'easyaiconfig.custom-prices.v1',
    updatedAt: new Date().toISOString(),
    models: models.map((item) => ({
      model: String(item.model || '').trim(),
      provider: String(item.provider || '').trim(),
      currency: String(item.currency || 'USD').trim() || 'USD',
      inputPerMTok: num(item.inputPerMTok),
      outputPerMTok: num(item.outputPerMTok),
      cacheReadPerMTok: num(item.cacheReadPerMTok),
      cacheCreatePerMTok: num(item.cacheCreatePerMTok),
      reasoningPerMTok: num(item.reasoningPerMTok),
    })).filter((item) => item.model),
  };
  await fs.mkdir(path.dirname(priceBookPath), { recursive: true });
  await fs.writeFile(priceBookPath, `${JSON.stringify(next, null, 2)}\n`);
  return { ...next, priceBookPath };
}

export async function listUsageInventory(options = {}) {
  const includeTools = Array.isArray(options.includeTools) && options.includeTools.length
    ? options.includeTools.map(normalizeTool).filter(Boolean)
    : DEFAULT_TOOLS;
  const normalizedOptions = { ...options, days: clampDays(options.days) };
  const sources = [];
  for (const tool of includeTools) {
    try {
      sources.push(await loadSource(tool, normalizedOptions));
    } catch (error) {
      sources.push(errorSource(tool, error));
    }
  }

  const totals = createTotals();
  for (const source of sources) addTotals(totals, source.totals);
  const requestLogs = sources
    .flatMap((source) => source.requestLogs || [])
    .sort((left, right) => Number(Date.parse(right.updatedAt || '') || 0) - Number(Date.parse(left.updatedAt || '') || 0))
    .slice(0, Math.max(1, Math.min(500, Number(options.limit || 100))));
  const customPrices = options.includeCustomPrices === false ? null : await readCustomPriceBook(options);

  return {
    schema: 'easyaiconfig.usage-inventory.v1',
    generatedAt: new Date().toISOString(),
    days: normalizedOptions.days,
    sources,
    totals,
    daily: mergeDaily(sources),
    providers: mergeDimension(sources, 'provider'),
    models: mergeDimension(sources, 'model'),
    requestLogs,
    customPrices: customPrices ? {
      schema: customPrices.schema,
      priceBookPath: customPrices.priceBookPath,
      models: customPrices.models.length,
      updatedAt: customPrices.updatedAt,
    } : null,
    summary: {
      tools: Object.fromEntries(sources.map((source) => [source.tool, {
        ok: source.ok,
        total: source.totals.total,
        cost: source.totals.cost,
        requests: source.totals.requests,
      }])),
      totalTokens: totals.total,
      cost: totals.cost,
      officialCost: totals.officialCost,
      requests: totals.requests,
      requestLogs: requestLogs.length,
      customPrices: customPrices?.models?.length || 0,
      readErrors: sources.filter((source) => !source.ok).length,
    },
  };
}
