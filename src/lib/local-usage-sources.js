import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_SOURCE_FILES = 1000;

export const LOCAL_USAGE_TOOL_IDS = [
  'gemini',
  'amp',
  'droid',
  'codebuff',
  'hermes',
  'pi-agent',
  'goose',
  'openclaw',
  'kilo-code',
  'kimi',
  'qwen-code',
  'copilot',
];

export const LOCAL_USAGE_TOOL_META = {
  gemini: {
    label: 'Gemini CLI local usage',
    provider: 'google',
    sourceType: 'gemini-json',
    sourceLabel: 'Gemini CLI chats',
  },
  amp: {
    label: 'Amp local usage',
    provider: 'sourcegraph-amp',
    sourceType: 'amp-thread-json',
    sourceLabel: 'Amp thread usage',
  },
  droid: {
    label: 'Droid local usage',
    provider: 'unknown',
    sourceType: 'droid-settings-json',
    sourceLabel: 'Droid settings usage',
  },
  codebuff: {
    label: 'Codebuff local usage',
    provider: 'codebuff',
    sourceType: 'codebuff-chat-json',
    sourceLabel: 'Codebuff chat messages',
  },
  hermes: {
    label: 'Hermes Agent local usage',
    provider: 'unknown',
    sourceType: 'sqlite',
    sourceLabel: 'Hermes state database',
  },
  'pi-agent': {
    label: 'pi-agent local usage',
    provider: 'pi-agent',
    sourceType: 'pi-jsonl',
    sourceLabel: 'pi-agent sessions',
  },
  goose: {
    label: 'Goose local usage',
    provider: 'goose',
    sourceType: 'sqlite',
    sourceLabel: 'Goose sessions database',
  },
  openclaw: {
    label: 'OpenClaw local usage',
    provider: 'unknown',
    sourceType: 'openclaw-jsonl',
    sourceLabel: 'OpenClaw session logs',
  },
  'kilo-code': {
    label: 'Kilo Code local usage',
    provider: 'extension',
    sourceType: 'sqlite',
    sourceLabel: 'Kilo message database',
  },
  kimi: {
    label: 'Kimi local usage',
    provider: 'moonshot',
    sourceType: 'kimi-wire-jsonl',
    sourceLabel: 'Kimi wire sessions',
  },
  'qwen-code': {
    label: 'Qwen Code local usage',
    provider: 'qwen',
    sourceType: 'qwen-jsonl',
    sourceLabel: 'Qwen chat logs',
  },
  copilot: {
    label: 'GitHub Copilot CLI local usage',
    provider: 'github-copilot',
    sourceType: 'otel-jsonl',
    sourceLabel: 'Copilot OpenTelemetry logs',
  },
};

function splitPathList(value = '') {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item.replace(/^~(?=$|[/\\])/, os.homedir())));
}

function pathListFromEnv(envKey, defaults = []) {
  const envValue = process.env[envKey]?.trim();
  const raw = envValue ? splitPathList(envValue) : defaults;
  const seen = new Set();
  return raw
    .map((item) => path.resolve(String(item)))
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function optionPathList(options = {}, keys = [], envKey = '', defaults = []) {
  for (const key of keys) {
    const value = options?.[key];
    if (Array.isArray(value) && value.length) {
      return value.map((item) => path.resolve(String(item).replace(/^~(?=$|[/\\])/, os.homedir())));
    }
    if (typeof value === 'string' && value.trim()) {
      return splitPathList(value);
    }
  }
  return pathListFromEnv(envKey, defaults);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function fileMtimeMs(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return Number(stat?.mtimeMs || 0);
}

async function walkFiles(rootDir, { extensions = ['.jsonl', '.json'], maxFiles = MAX_SOURCE_FILES, includeFile = null } = {}) {
  const files = [];
  async function walk(currentDir) {
    if (files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (!extensions.some((ext) => lower.endsWith(ext))) continue;
        if (includeFile && !includeFile(fullPath, entry.name)) continue;
        const mtimeMs = await fileMtimeMs(fullPath);
        files.push({ filePath: fullPath, mtimeMs });
      }
    }
  }
  await walk(rootDir);
  return files.sort((left, right) => Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0));
}

function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

function intValue(value) {
  return Math.trunc(numberValue(value));
}

function pickNumber(source, keys = []) {
  if (!source || typeof source !== 'object') return 0;
  for (const key of keys) {
    const value = intValue(source[key]);
    if (value > 0) return value;
  }
  return 0;
}

function pickString(source, keys = []) {
  if (!source || typeof source !== 'object') return '';
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function pickDecimal(source, keys = []) {
  if (!source || typeof source !== 'object') return 0;
  for (const key of keys) {
    const value = numberValue(source[key]);
    if (value > 0) return value;
  }
  return 0;
}

function pickNestedNumber(source, objectKey, keys = []) {
  const nested = source?.[objectKey];
  return nested && typeof nested === 'object' ? pickNumber(nested, keys) : 0;
}

function parseTimestampMs(value, fallback = 0) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return fallback;
    if (value > 100_000_000_000_000_000) return Math.floor(value / 1_000_000);
    if (value > 100_000_000_000_000) return Math.floor(value / 1_000);
    return value > 100_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^\d+(\.\d+)?$/.test(raw)) return parseTimestampMs(Number(raw), fallback);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? raw.replace(' ', 'T') + 'Z'
    : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function totalsFromParts({
  input = 0,
  output = 0,
  cacheRead = 0,
  cacheCreation = 0,
  reasoning = 0,
  total = 0,
  cost = 0,
  requests = 1,
} = {}) {
  const baseInput = intValue(input);
  let baseOutput = intValue(output);
  const baseCacheRead = intValue(cacheRead);
  const baseCacheCreation = intValue(cacheCreation);
  let baseReasoning = intValue(reasoning);
  const explicitTotal = intValue(total);
  const known = baseInput + baseOutput + baseCacheRead + baseCacheCreation + baseReasoning;
  if (explicitTotal > 0 && known === 0) {
    baseOutput = explicitTotal;
  } else if (explicitTotal > known) {
    baseReasoning += explicitTotal - known;
  }
  const computedTotal = baseInput + baseOutput + baseCacheRead + baseCacheCreation + baseReasoning;
  const finalCost = numberValue(cost);
  return {
    input: baseInput,
    cachedInput: baseCacheRead,
    output: baseOutput,
    reasoning: baseReasoning,
    cacheRead: baseCacheRead,
    cacheCreation: baseCacheCreation,
    total: Math.max(explicitTotal, computedTotal),
    cost: finalCost,
    officialCost: 0,
    requests: computedTotal || explicitTotal || finalCost ? Math.max(1, intValue(requests) || 1) : 0,
  };
}

function totalsFromGenericUsage(source = {}) {
  return totalsFromParts({
    input: pickNumber(source, ['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'prompt']),
    output: pickNumber(source, ['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'completion', 'candidates', 'candidatesTokens']),
    cacheRead: pickNumber(source, ['cacheRead', 'cacheReadTokens', 'cache_read_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens', 'cachedInputTokens', 'cached_input_tokens'])
      || pickNestedNumber(source, 'promptTokensDetails', ['cachedTokens'])
      || pickNestedNumber(source, 'prompt_tokens_details', ['cached_tokens']),
    cacheCreation: pickNumber(source, ['cacheCreation', 'cacheCreationTokens', 'cache_creation_tokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens', 'cachedTokensCreated', 'cached_tokens_created']),
    reasoning: pickNumber(source, ['reasoning', 'reasoningTokens', 'reasoning_tokens', 'thinkingTokens', 'thoughtsTokenCount']),
    total: pickNumber(source, ['total', 'totalTokens', 'total_tokens']),
    cost: pickDecimal(source, ['cost', 'totalCost', 'total_cost', 'usd', 'totalUsd', 'total_usd']),
  });
}

function hasUsage(totals = {}) {
  return Number(totals.total || 0) > 0 || Number(totals.cost || 0) > 0 || Number(totals.officialCost || 0) > 0;
}

function inferProvider(model = '', fallback = 'unknown') {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('claude') || normalized.startsWith('anthropic/')) return 'anthropic';
  if (normalized.includes('gemini') || normalized.startsWith('google/')) return 'google';
  if (normalized.includes('qwen')) return 'qwen';
  if (normalized.includes('kimi') || normalized.includes('moonshot')) return 'moonshot';
  if (normalized.includes('gpt') || /^o\d/.test(normalized) || normalized.startsWith('openai/')) return 'openai';
  if (normalized.includes('grok') || normalized.startsWith('xai/')) return 'xai';
  if (normalized.startsWith('openrouter/')) return 'openrouter';
  return fallback;
}

function compactPreview(value = '', fallback = 'Untitled session') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 96 ? `${text.slice(0, 95)}...` : text;
}

function makeUsageItem({
  tool,
  sessionId,
  title,
  provider,
  model = 'unknown',
  projectPath = '',
  updatedAtMs = 0,
  sourcePath = '',
  sourceLabel = '',
  totals,
  ordinal = '',
} = {}) {
  if (!hasUsage(totals)) return null;
  const safeSessionId = String(sessionId || path.basename(String(sourcePath || 'session'), path.extname(String(sourcePath || 'session')))).trim() || 'session';
  const safeModel = String(model || 'unknown').trim() || 'unknown';
  const safeProvider = String(provider || inferProvider(safeModel)).trim() || 'unknown';
  const itemId = [tool, safeSessionId, ordinal].filter(Boolean).join(':');
  return {
    id: itemId,
    sessionId: safeSessionId,
    tool,
    title: compactPreview(title || safeSessionId, safeSessionId),
    provider: safeProvider,
    model: safeModel,
    projectPath: String(projectPath || '').trim(),
    projectKey: String(projectPath ? path.basename(projectPath) : '').trim() || tool,
    cwd: String(projectPath || '').trim(),
    updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : '',
    updatedAtMs: Number(updatedAtMs || 0),
    sourcePath,
    sourceLabel,
    totals,
    actions: { resume: false, fork: false, delete: false },
  };
}

function sourceResult({ tool, label, sourcePath, sourceType = 'filesystem', exists = false, readError = '', items = [], capabilities = {} }) {
  return {
    tool,
    label,
    sourcePath,
    sourceType,
    exists,
    readError,
    count: items.length,
    capabilities: {
      browse: true,
      search: true,
      resume: false,
      fork: false,
      delete: false,
      ...capabilities,
    },
    items,
  };
}

async function readJson(filePath) {
  const raw = await readText(filePath);
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

async function readJsonLines(filePath) {
  const raw = await readText(filePath);
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      // Ignore malformed log lines.
    }
  }
  return records;
}

function sourcePathJoin(paths = []) {
  return paths.map((item) => path.resolve(String(item))).join(path.delimiter);
}

async function readFileBasedSource({ tool, roots, label, sourceType, collectFiles, parseFile, options = {} }) {
  const items = [];
  const existingRoots = [];
  const readErrors = [];
  const sourceLimit = Math.max(20, Math.min(MAX_SOURCE_FILES, Number(options.sourceLimit || options.limit || 300)));
  for (const root of roots) {
    if (!await pathExists(root)) continue;
    existingRoots.push(root);
    let files = [];
    try {
      files = collectFiles
        ? await collectFiles(root, sourceLimit)
        : await walkFiles(root, { maxFiles: sourceLimit });
    } catch (error) {
      readErrors.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const file of files) {
      try {
        const parsed = await parseFile(file.filePath || file, { root, tool, sourceLabel: label });
        if (Array.isArray(parsed)) items.push(...parsed.filter(Boolean));
        else if (parsed) items.push(parsed);
      } catch (error) {
        readErrors.push(`${file.filePath || file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (items.length >= sourceLimit) break;
    }
  }
  items.sort((left, right) => Number(right.updatedAtMs || 0) - Number(left.updatedAtMs || 0));
  return sourceResult({
    tool,
    label,
    sourcePath: sourcePathJoin(roots),
    sourceType,
    exists: existingRoots.length > 0,
    readError: readErrors.slice(0, 5).join('; '),
    items: items.slice(0, sourceLimit),
  });
}

function sqliteAvailable() {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? ['sqlite3'] : ['-v', 'sqlite3'], {
    encoding: 'utf8',
    shell: process.platform !== 'win32',
    windowsHide: true,
  });
  return result.status === 0;
}

function sqliteJson(dbPath, sql) {
  const result = spawnSync('sqlite3', ['-json', dbPath, sql.replace(/\s+/g, ' ').trim()], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 25 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'sqlite3 query failed').trim());
  }
  return JSON.parse(String(result.stdout || '[]'));
}

function normalizeDroidModel(model = '') {
  const raw = String(model || '').replace(/^custom:/, '');
  return raw.replace(/\[[^\]]*]/g, '').replace(/-\d+$/, '').trim() || 'unknown';
}

async function parseDroidSettings(filePath) {
  const parsed = await readJson(filePath);
  if (!parsed || typeof parsed !== 'object') return null;
  const usage = parsed.tokenUsage && typeof parsed.tokenUsage === 'object' ? parsed.tokenUsage : null;
  if (!usage) return null;
  const totals = totalsFromParts({
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheCreation: usage.cacheCreationTokens,
    cacheRead: usage.cacheReadTokens,
    reasoning: usage.thinkingTokens,
    total: usage.totalTokens,
  });
  const mtime = await fileMtimeMs(filePath);
  const model = normalizeDroidModel(parsed.model || '');
  const sessionId = path.basename(filePath).replace(/\.settings\.json$/i, '');
  return makeUsageItem({
    tool: 'droid',
    sessionId,
    title: sessionId,
    provider: String(parsed.providerLock || inferProvider(model)).trim() || inferProvider(model),
    model,
    updatedAtMs: parseTimestampMs(parsed.providerLockTimestamp, mtime),
    sourcePath: filePath,
    sourceLabel: LOCAL_USAGE_TOOL_META.droid.sourceLabel,
    totals,
  });
}

function geminiTokensToTotals(tokens = {}, { subtractCachedOverlap = false } = {}) {
  const inputRaw = pickNumber(tokens, ['input', 'prompt', 'input_tokens', 'prompt_tokens']);
  const toolTokens = pickNumber(tokens, ['tool', 'tool_tokens']);
  const output = pickNumber(tokens, ['output', 'candidates', 'output_tokens', 'candidates_tokens']);
  const cached = pickNumber(tokens, ['cached', 'cached_tokens']);
  const reasoning = pickNumber(tokens, ['thoughts', 'reasoning', 'thoughts_tokens', 'reasoning_tokens']);
  const total = pickNumber(tokens, ['total', 'total_tokens']);
  const input = subtractCachedOverlap ? Math.max(0, inputRaw - Math.min(inputRaw, cached)) : inputRaw;
  return totalsFromParts({
    input: input + toolTokens,
    output,
    cacheRead: cached,
    reasoning,
    total,
  });
}

function geminiRecordEvents(record, filePath, fallbackMs, state = {}) {
  const events = [];
  const sessionId = pickString(record, ['sessionId', 'session_id']) || state.sessionId || path.basename(filePath, path.extname(filePath));
  const modelHint = pickString(record, ['model']) || state.model || 'unknown';
  const timestamp = parseTimestampMs(record.timestamp || record.created_at || record.startTime || record.lastUpdated, fallbackMs);
  if (Array.isArray(record.messages)) {
    record.messages.forEach((message, index) => {
      if (!message || typeof message !== 'object' || message.type !== 'gemini') return;
      const model = pickString(message, ['model']) || modelHint;
      const totals = geminiTokensToTotals(message.tokens || {});
      const item = makeUsageItem({
        tool: 'gemini',
        sessionId,
        title: sessionId,
        provider: 'google',
        model,
        updatedAtMs: parseTimestampMs(message.timestamp || message.created_at, timestamp),
        sourcePath: filePath,
        sourceLabel: LOCAL_USAGE_TOOL_META.gemini.sourceLabel,
        totals,
        ordinal: message.id || index,
      });
      if (item) events.push(item);
    });
    return events;
  }
  if (record.type === 'gemini') {
    const totals = geminiTokensToTotals(record.tokens || {});
    const item = makeUsageItem({
      tool: 'gemini',
      sessionId,
      title: sessionId,
      provider: 'google',
      model: modelHint,
      updatedAtMs: timestamp,
      sourcePath: filePath,
      sourceLabel: LOCAL_USAGE_TOOL_META.gemini.sourceLabel,
      totals,
      ordinal: record.id || events.length,
    });
    if (item) events.push(item);
  }
  const stats = record.stats || record.result?.stats;
  if (stats && typeof stats === 'object') {
    if (stats.models && typeof stats.models === 'object') {
      Object.entries(stats.models).forEach(([model, data], index) => {
        const totals = geminiTokensToTotals(data?.tokens || {}, { subtractCachedOverlap: true });
        const item = makeUsageItem({
          tool: 'gemini',
          sessionId,
          title: sessionId,
          provider: 'google',
          model,
          updatedAtMs: timestamp,
          sourcePath: filePath,
          sourceLabel: LOCAL_USAGE_TOOL_META.gemini.sourceLabel,
          totals,
          ordinal: `stats-${index}`,
        });
        if (item) events.push(item);
      });
    } else {
      const totals = geminiTokensToTotals(stats, { subtractCachedOverlap: true });
      const item = makeUsageItem({
        tool: 'gemini',
        sessionId,
        title: sessionId,
        provider: 'google',
        model: modelHint,
        updatedAtMs: timestamp,
        sourcePath: filePath,
        sourceLabel: LOCAL_USAGE_TOOL_META.gemini.sourceLabel,
        totals,
        ordinal: 'stats',
      });
      if (item) events.push(item);
    }
  }
  return events;
}

async function parseGeminiFile(filePath) {
  const fallbackMs = await fileMtimeMs(filePath);
  if (filePath.toLowerCase().endsWith('.jsonl')) {
    const records = await readJsonLines(filePath);
    const state = { sessionId: path.basename(filePath, path.extname(filePath)), model: '' };
    return records.flatMap((record) => {
      state.sessionId = pickString(record, ['sessionId', 'session_id']) || state.sessionId;
      state.model = pickString(record, ['model']) || state.model;
      return geminiRecordEvents(record, filePath, fallbackMs, state);
    });
  }
  const record = await readJson(filePath);
  return record && typeof record === 'object' ? geminiRecordEvents(record, filePath, fallbackMs) : [];
}

async function parseQwenFile(filePath) {
  const fallbackMs = await fileMtimeMs(filePath);
  const project = projectFromQwenFile(filePath) || 'qwen';
  const records = await readJsonLines(filePath);
  const items = [];
  records.forEach((record, index) => {
    if (record?.type !== 'assistant') return;
    const usage = record.usageMetadata;
    if (!usage || typeof usage !== 'object') return;
    const totals = totalsFromParts({
      input: usage.promptTokenCount,
      output: usage.candidatesTokenCount,
      reasoning: usage.thoughtsTokenCount,
      cacheRead: usage.cachedContentTokenCount,
      total: usage.totalTokenCount,
    });
    const sessionId = record.sessionId || `${project}-${path.basename(filePath, path.extname(filePath))}`;
    const item = makeUsageItem({
      tool: 'qwen-code',
      sessionId,
      title: sessionId,
      provider: 'qwen',
      model: record.model || 'unknown',
      projectPath: project,
      updatedAtMs: parseTimestampMs(record.timestamp, fallbackMs),
      sourcePath: filePath,
      sourceLabel: LOCAL_USAGE_TOOL_META['qwen-code'].sourceLabel,
      totals,
      ordinal: index,
    });
    if (item) items.push(item);
  });
  return items;
}

function projectFromQwenFile(filePath) {
  const parts = filePath.split(path.sep);
  for (let index = parts.length - 4; index >= 0; index -= 1) {
    if (parts[index] === 'projects' && parts[index + 2] === 'chats') return parts[index + 1];
  }
  return '';
}

async function parseKimiWireFile(filePath) {
  const fallbackMs = await fileMtimeMs(filePath);
  const root = path.dirname(path.dirname(path.dirname(path.dirname(filePath))));
  let model = 'kimi-for-coding';
  try {
    const config = JSON.parse(await readText(path.join(root, 'config.json')));
    if (typeof config?.model === 'string' && config.model.trim()) model = config.model.trim();
  } catch {
    // Optional Kimi config.
  }
  const sessionId = path.basename(path.dirname(filePath)) || 'unknown';
  const records = await readJsonLines(filePath);
  const items = [];
  records.forEach((record, index) => {
    if (record?.type === 'metadata') return;
    if (record?.message?.type !== 'StatusUpdate') return;
    const usage = record.message?.payload?.token_usage;
    if (!usage || typeof usage !== 'object') return;
    const totals = totalsFromParts({
      input: usage.input_other,
      output: usage.output,
      cacheCreation: usage.input_cache_creation,
      cacheRead: usage.input_cache_read,
      total: usage.total,
    });
    const item = makeUsageItem({
      tool: 'kimi',
      sessionId,
      title: sessionId,
      provider: 'moonshot',
      model,
      updatedAtMs: parseTimestampMs(Number(record.timestamp || 0), fallbackMs),
      sourcePath: filePath,
      sourceLabel: LOCAL_USAGE_TOOL_META.kimi.sourceLabel,
      totals,
      ordinal: record.message?.payload?.message_id || index,
    });
    if (item) items.push(item);
  });
  return items;
}

async function parseAmpThread(filePath) {
  const thread = await readJson(filePath);
  if (!thread || typeof thread !== 'object') return [];
  const threadId = String(thread.id || path.basename(filePath, path.extname(filePath))).trim();
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const cacheByMessageId = new Map();
  messages.forEach((message) => {
    const id = message?.messageId ?? message?.message_id;
    if (id == null || message?.role !== 'assistant') return;
    const usage = message.usage || {};
    cacheByMessageId.set(String(id), {
      creation: intValue(usage.cacheCreationInputTokens),
      read: intValue(usage.cacheReadInputTokens),
    });
  });
  const events = Array.isArray(thread.usageLedger?.events) ? thread.usageLedger.events : [];
  const sourceEvents = events.length ? events : messages.filter((message) => message?.role === 'assistant' && message.usage);
  const fallbackMs = await fileMtimeMs(filePath);
  const items = [];
  sourceEvents.forEach((event, index) => {
    const ledgerTokens = event.tokens && typeof event.tokens === 'object' ? event.tokens : null;
    const usage = ledgerTokens || event.usage || {};
    const cache = ledgerTokens ? cacheByMessageId.get(String(event.toMessageId ?? event.to_message_id ?? '')) || {} : {};
    const totals = ledgerTokens
      ? totalsFromParts({
        input: usage.input,
        output: usage.output,
        cacheCreation: cache.creation,
        cacheRead: cache.read,
        total: usage.total,
        cost: event.cost?.total,
      })
      : totalsFromParts({
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheCreation: usage.cacheCreationInputTokens,
        cacheRead: usage.cacheReadInputTokens,
        total: usage.totalTokens,
        cost: usage.cost?.total,
      });
    const model = ledgerTokens ? event.model : (usage.model || event.model);
    const timestamp = ledgerTokens ? event.timestamp : (usage.timestamp || event.timestamp);
    const item = makeUsageItem({
      tool: 'amp',
      sessionId: threadId,
      title: threadId,
      provider: inferProvider(model, 'sourcegraph-amp'),
      model: model || 'unknown',
      updatedAtMs: parseTimestampMs(timestamp, fallbackMs),
      sourcePath: filePath,
      sourceLabel: LOCAL_USAGE_TOOL_META.amp.sourceLabel,
      totals,
      ordinal: event.id || event.messageId || index,
    });
    if (item) items.push(item);
  });
  return items;
}

function codebuffUsageFromObject(value) {
  if (!value || typeof value !== 'object') return {};
  const totals = totalsFromGenericUsage(value);
  return {
    totals,
    model: pickString(value, ['model']),
    credits: numberValue(value.credits),
  };
}

function mergeUsageFallback(target, fallback) {
  if (!target.model && fallback.model) target.model = fallback.model;
  if (!hasUsage(target.totals) && hasUsage(fallback.totals)) target.totals = fallback.totals;
  if (!target.credits && fallback.credits) target.credits = fallback.credits;
  return target;
}

function extractCodebuffMessageUsage(message = {}) {
  const result = { totals: totalsFromParts(), model: '', credits: numberValue(message.credits) };
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
  if (metadata) {
    result.model = pickString(metadata, ['model']) || result.model;
    mergeUsageFallback(result, codebuffUsageFromObject(metadata.usage));
    mergeUsageFallback(result, codebuffUsageFromObject(metadata.codebuff?.usage));
    const history = metadata.runState?.sessionState?.mainAgentState?.messageHistory;
    if (Array.isArray(history)) {
      for (const entry of [...history].reverse()) {
        if (entry?.role !== 'assistant') continue;
        mergeUsageFallback(result, codebuffUsageFromObject(entry.providerOptions?.usage));
        mergeUsageFallback(result, {
          ...codebuffUsageFromObject(entry.providerOptions?.codebuff?.usage),
          model: entry.providerOptions?.codebuff?.model || '',
        });
        if (hasUsage(result.totals)) break;
      }
    }
  }
  return result;
}

async function parseCodebuffChat(filePath) {
  const messages = await readJson(filePath);
  if (!Array.isArray(messages)) return [];
  const fallbackMs = await fileMtimeMs(filePath);
  const chatId = path.basename(path.dirname(filePath));
  const project = path.basename(path.dirname(path.dirname(path.dirname(filePath)))) || 'codebuff';
  const sessionId = `${project}/${chatId}`;
  const chatTimestamp = parseTimestampMs(chatId.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}).*$/, '$1T$2:$3:$4Z'), 0);
  const items = [];
  messages.forEach((message, index) => {
    const role = String(message?.variant || message?.role || '').toLowerCase();
    if (!['ai', 'agent', 'assistant'].includes(role)) return;
    const usage = extractCodebuffMessageUsage(message);
    if (!hasUsage(usage.totals) && !usage.credits) return;
    const model = usage.model || 'codebuff-unknown';
    const timestamp = parseTimestampMs(message.timestamp || message.createdAt || message.metadata?.timestamp, chatTimestamp || fallbackMs);
    const item = makeUsageItem({
      tool: 'codebuff',
      sessionId,
      title: sessionId,
      provider: inferProvider(model, 'unknown'),
      model,
      projectPath: project,
      updatedAtMs: timestamp,
      sourcePath: filePath,
      sourceLabel: LOCAL_USAGE_TOOL_META.codebuff.sourceLabel,
      totals: usage.totals,
      ordinal: message.id || index,
    });
    if (item) items.push(item);
  });
  return items;
}

async function parsePiFile(filePath) {
  const records = await readJsonLines(filePath);
  const project = projectFromPiFile(filePath);
  const sessionId = path.basename(filePath, path.extname(filePath)).replace(/^[^_]+_/, '');
  const items = [];
  records.forEach((record, index) => {
    if (record?.type && record.type !== 'message') return;
    if (record?.message?.role !== 'assistant' || !record.message?.usage) return;
    const usage = record.message.usage;
    const totals = totalsFromParts({
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheCreation: usage.cacheWrite,
      total: usage.totalTokens,
      cost: usage.cost?.total,
    });
    const model = record.message.model ? `[pi] ${record.message.model}` : 'unknown';
    const item = makeUsageItem({
      tool: 'pi-agent',
      sessionId,
      title: sessionId,
      provider: inferProvider(model, 'pi-agent'),
      model,
      projectPath: project,
      updatedAtMs: parseTimestampMs(record.timestamp, 0),
      sourcePath: filePath,
      sourceLabel: LOCAL_USAGE_TOOL_META['pi-agent'].sourceLabel,
      totals,
      ordinal: index,
    });
    if (item) items.push(item);
  });
  return items;
}

function projectFromPiFile(filePath) {
  const parts = filePath.split(path.sep);
  const index = parts.lastIndexOf('sessions');
  return index >= 0 && parts[index + 1] ? parts[index + 1] : 'unknown';
}

async function parseOpenClawFile(filePath) {
  const fallbackMs = await fileMtimeMs(filePath);
  const records = await readJsonLines(filePath);
  const sessionId = path.basename(filePath).split('.jsonl')[0] || path.basename(filePath, path.extname(filePath));
  const items = [];
  let currentModel = '';
  let currentProvider = '';
  records.forEach((record, index) => {
    if (record?.type === 'model_change' || (record?.type === 'custom' && record?.customType === 'model-snapshot')) {
      const source = record.data && typeof record.data === 'object' ? record.data : record;
      currentModel = source.modelId || source.model || currentModel;
      currentProvider = source.provider || currentProvider;
      return;
    }
    if (record?.type !== 'message' || record?.message?.role !== 'assistant') return;
    const usage = record.message.usage;
    if (!usage || typeof usage !== 'object') return;
    const totals = totalsFromParts({
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheCreation: usage.cacheWrite,
      total: usage.totalTokens,
      cost: usage.cost?.total,
    });
    const model = `[openclaw] ${record.message.modelId || record.message.model || currentModel || 'unknown'}`;
    const provider = record.message.provider || currentProvider || inferProvider(model);
    const item = makeUsageItem({
      tool: 'openclaw',
      sessionId,
      title: sessionId,
      provider,
      model,
      updatedAtMs: parseTimestampMs(record.message.timestamp || record.timestamp, fallbackMs),
      sourcePath: filePath,
      sourceLabel: LOCAL_USAGE_TOOL_META.openclaw.sourceLabel,
      totals,
      ordinal: index,
    });
    if (item) items.push(item);
  });
  return items;
}

function copilotAttrNumber(attributes = {}, keys = []) {
  for (const key of keys) {
    const value = intValue(attributes[key]);
    if (value > 0) return value;
  }
  return 0;
}

function copilotTimestamp(record = {}, fallbackMs = 0) {
  const tupleKeys = ['endTime', 'startTime', 'hrTime', '_hrTime', 'time'];
  for (const key of tupleKeys) {
    if (Array.isArray(record[key]) && record[key].length >= 2) {
      const seconds = intValue(record[key][0]);
      const nanos = intValue(record[key][1]);
      if (seconds > 0) return seconds * 1000 + Math.floor(nanos / 1_000_000);
    }
  }
  return parseTimestampMs(record.timestamp || record.observedTimestamp || record.timeUnixNano, fallbackMs);
}

async function parseCopilotOtel(filePath) {
  const fallbackMs = await fileMtimeMs(filePath);
  const records = await readJsonLines(filePath);
  const items = [];
  records.forEach((record, index) => {
    const attributes = record?.attributes;
    if (!attributes || typeof attributes !== 'object') return;
    const totals = totalsFromParts({
      input: Math.max(0, copilotAttrNumber(attributes, ['gen_ai.usage.input_tokens']) - copilotAttrNumber(attributes, ['gen_ai.usage.cache_read.input_tokens'])),
      output: copilotAttrNumber(attributes, ['gen_ai.usage.output_tokens']),
      cacheRead: copilotAttrNumber(attributes, ['gen_ai.usage.cache_read.input_tokens']),
      cacheCreation: copilotAttrNumber(attributes, ['gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.cache_creation.input_tokens']),
      reasoning: copilotAttrNumber(attributes, ['gen_ai.usage.reasoning.output_tokens', 'gen_ai.usage.reasoning_tokens']),
      total: copilotAttrNumber(attributes, ['gen_ai.usage.total_tokens', 'gen_ai.usage.total.token_count']),
    });
    if (!hasUsage(totals)) return;
    const model = pickString(attributes, ['gen_ai.response.model', 'gen_ai.request.model']) || 'unknown';
    const sessionId = pickString(attributes, [
      'gen_ai.conversation.id',
      'copilot_chat.session_id',
      'copilot_chat.chat_session_id',
      'session.id',
      'github.copilot.interaction_id',
      'gen_ai.response.id',
    ]) || record.traceId || record.spanContext?.traceId || 'unknown-session';
    const item = makeUsageItem({
      tool: 'copilot',
      sessionId,
      title: sessionId,
      provider: 'github-copilot',
      model,
      updatedAtMs: copilotTimestamp(record, fallbackMs),
      sourcePath: filePath,
      sourceLabel: LOCAL_USAGE_TOOL_META.copilot.sourceLabel,
      totals,
      ordinal: record.spanId || record.spanContext?.spanId || index,
    });
    if (item) items.push(item);
  });
  return items;
}

async function readHermesSqlite(options = {}) {
  const homes = optionPathList(options, ['hermesHome', 'hermesDataDir'], 'HERMES_HOME', [path.join(os.homedir(), '.hermes')]);
  const dbPaths = homes.map((home) => path.join(home, 'state.db'));
  const existing = dbPaths.filter((dbPath) => existsSync(dbPath));
  if (!existing.length) return sourceResult({ tool: 'hermes', label: LOCAL_USAGE_TOOL_META.hermes.label, sourcePath: sourcePathJoin(dbPaths), sourceType: 'sqlite', exists: false });
  if (!sqliteAvailable()) return sourceResult({ tool: 'hermes', label: LOCAL_USAGE_TOOL_META.hermes.label, sourcePath: sourcePathJoin(dbPaths), sourceType: 'sqlite', exists: true, readError: 'sqlite3 unavailable' });
  const items = [];
  const readErrors = [];
  const limit = Math.max(20, Math.min(500, Number(options.limit || 100)));
  for (const dbPath of existing) {
    try {
      const rows = sqliteJson(dbPath, `
        SELECT id, model, billing_provider, started_at, message_count,
               input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
               estimated_cost_usd, actual_cost_usd
        FROM sessions
        WHERE model IS NOT NULL AND TRIM(model) != ''
        ORDER BY started_at DESC
        LIMIT ${limit}
      `);
      for (const row of rows) {
        const totals = totalsFromParts({
          input: row.input_tokens,
          output: row.output_tokens,
          cacheRead: row.cache_read_tokens,
          cacheCreation: row.cache_write_tokens,
          reasoning: row.reasoning_tokens,
          cost: row.actual_cost_usd || row.estimated_cost_usd,
          requests: row.message_count || 1,
        });
        const item = makeUsageItem({
          tool: 'hermes',
          sessionId: row.id,
          title: row.id,
          provider: row.billing_provider || inferProvider(row.model),
          model: row.model,
          updatedAtMs: parseTimestampMs(row.started_at, 0),
          sourcePath: dbPath,
          sourceLabel: LOCAL_USAGE_TOOL_META.hermes.sourceLabel,
          totals,
        });
        if (item) items.push(item);
      }
    } catch (error) {
      readErrors.push(`${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sourceResult({ tool: 'hermes', label: LOCAL_USAGE_TOOL_META.hermes.label, sourcePath: sourcePathJoin(dbPaths), sourceType: 'sqlite', exists: true, readError: readErrors.join('; '), items });
}

async function readGooseSqlite(options = {}) {
  const roots = optionPathList(options, ['goosePathRoot', 'gooseHome', 'gooseDataDir'], 'GOOSE_PATH_ROOT', [
      path.join(os.homedir(), '.local', 'share', 'goose'),
      path.join(os.homedir(), 'Library', 'Application Support', 'goose'),
      path.join(os.homedir(), '.local', 'share', 'Block', 'goose'),
    ]);
  const dbPaths = roots.map((root) => path.join(root, 'sessions', 'sessions.db'));
  const existing = dbPaths.filter((dbPath) => existsSync(dbPath));
  if (!existing.length) return sourceResult({ tool: 'goose', label: LOCAL_USAGE_TOOL_META.goose.label, sourcePath: sourcePathJoin(dbPaths), sourceType: 'sqlite', exists: false });
  if (!sqliteAvailable()) return sourceResult({ tool: 'goose', label: LOCAL_USAGE_TOOL_META.goose.label, sourcePath: sourcePathJoin(dbPaths), sourceType: 'sqlite', exists: true, readError: 'sqlite3 unavailable' });
  const items = [];
  const readErrors = [];
  const limit = Math.max(20, Math.min(500, Number(options.limit || 100)));
  for (const dbPath of existing) {
    try {
      const rows = sqliteJson(dbPath, `
        SELECT id, model_config_json, provider_name, created_at, total_tokens, input_tokens, output_tokens,
               accumulated_total_tokens, accumulated_input_tokens, accumulated_output_tokens
        FROM sessions
        WHERE model_config_json IS NOT NULL AND TRIM(model_config_json) != ''
        ORDER BY created_at DESC
        LIMIT ${limit}
      `);
      for (const row of rows) {
        let model = '';
        try { model = JSON.parse(row.model_config_json || '{}')?.model_name || ''; } catch { model = ''; }
        if (!model) continue;
        const input = intValue(row.accumulated_input_tokens) || intValue(row.input_tokens);
        const output = intValue(row.accumulated_output_tokens) || intValue(row.output_tokens);
        const total = intValue(row.accumulated_total_tokens) || intValue(row.total_tokens) || input + output;
        const totals = totalsFromParts({ input, output, total });
        const item = makeUsageItem({
          tool: 'goose',
          sessionId: row.id,
          title: row.id,
          provider: String(row.provider_name || inferProvider(model, 'goose')).replace(/-/g, '_'),
          model,
          updatedAtMs: parseTimestampMs(row.created_at, 0),
          sourcePath: dbPath,
          sourceLabel: LOCAL_USAGE_TOOL_META.goose.sourceLabel,
          totals,
        });
        if (item) items.push(item);
      }
    } catch (error) {
      readErrors.push(`${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sourceResult({ tool: 'goose', label: LOCAL_USAGE_TOOL_META.goose.label, sourcePath: sourcePathJoin(dbPaths), sourceType: 'sqlite', exists: true, readError: readErrors.join('; '), items });
}

async function readKiloSqlite(options = {}) {
  const roots = optionPathList(options, ['kiloDataDir', 'kiloHome'], 'KILO_DATA_DIR', [path.join(os.homedir(), '.local', 'share', 'kilo')]);
  const dbPaths = roots.map((root) => path.join(root, 'kilo.db'));
  const existing = dbPaths.filter((dbPath) => existsSync(dbPath));
  if (!existing.length) return sourceResult({ tool: 'kilo-code', label: LOCAL_USAGE_TOOL_META['kilo-code'].label, sourcePath: sourcePathJoin(dbPaths), sourceType: 'sqlite', exists: false });
  if (!sqliteAvailable()) return sourceResult({ tool: 'kilo-code', label: LOCAL_USAGE_TOOL_META['kilo-code'].label, sourcePath: sourcePathJoin(dbPaths), sourceType: 'sqlite', exists: true, readError: 'sqlite3 unavailable' });
  const items = [];
  const readErrors = [];
  const limit = Math.max(20, Math.min(500, Number(options.limit || 100)));
  for (const dbPath of existing) {
    try {
      const rows = sqliteJson(dbPath, `SELECT id, session_id, data FROM message LIMIT ${limit}`);
      for (const row of rows) {
        let data = null;
        try { data = JSON.parse(row.data || '{}'); } catch { data = null; }
        if (!data || data.role !== 'assistant' || !data.tokens) continue;
        const totals = totalsFromParts({
          input: data.tokens.input,
          output: data.tokens.output,
          cacheRead: data.tokens.cache?.read,
          cacheCreation: data.tokens.cache?.write,
          reasoning: data.tokens.reasoning,
          total: data.tokens.total,
          cost: data.cost,
        });
        const model = data.modelID || 'unknown';
        const item = makeUsageItem({
          tool: 'kilo-code',
          sessionId: data.session_id || row.session_id,
          title: data.session_id || row.session_id || row.id,
          provider: data.providerID || inferProvider(model, 'extension'),
          model,
          updatedAtMs: parseTimestampMs(data.time?.created, 0),
          sourcePath: dbPath,
          sourceLabel: LOCAL_USAGE_TOOL_META['kilo-code'].sourceLabel,
          totals,
          ordinal: data.id || row.id,
        });
        if (item) items.push(item);
      }
    } catch (error) {
      readErrors.push(`${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sourceResult({ tool: 'kilo-code', label: LOCAL_USAGE_TOOL_META['kilo-code'].label, sourcePath: sourcePathJoin(dbPaths), sourceType: 'sqlite', exists: true, readError: readErrors.join('; '), items });
}

function droidRoots(options = {}) {
  return optionPathList(options, ['droidSessionsDir', 'droidHome'], 'DROID_SESSIONS_DIR', [path.join(os.homedir(), '.factory', 'sessions')]);
}

function codebuffRoots(options = {}) {
  return optionPathList(options, ['codebuffDataDir', 'codebuffHome'], 'CODEBUFF_DATA_DIR', [
    path.join(os.homedir(), '.config', 'manicode'),
    path.join(os.homedir(), '.config', 'manicode-dev'),
    path.join(os.homedir(), '.config', 'manicode-staging'),
  ]).map((root) => path.basename(root) === 'projects' ? root : path.join(root, 'projects'));
}

function openClawRoots(options = {}) {
  return optionPathList(options, ['openClawHome', 'openClawDir'], 'OPENCLAW_DIR', [
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), '.clawdbot'),
    path.join(os.homedir(), '.moltbot'),
    path.join(os.homedir(), '.moldbot'),
  ]);
}

function copilotFilesRoot(options = {}) {
  const roots = optionPathList(options, ['copilotOtelDir', 'copilotHome'], 'COPILOT_DATA_DIR', [path.join(os.homedir(), '.copilot')])
    .map((root) => path.basename(root) === 'otel' ? root : path.join(root, 'otel'));
  const exporter = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH?.trim();
  return { roots, exporter: exporter ? path.resolve(exporter) : '' };
}

export async function readLocalUsageSource(tool, options = {}) {
  if (tool === 'droid') {
    return readFileBasedSource({
      tool,
      roots: droidRoots(options),
      label: LOCAL_USAGE_TOOL_META.droid.label,
      sourceType: LOCAL_USAGE_TOOL_META.droid.sourceType,
      collectFiles: (root, maxFiles) => walkFiles(root, {
        extensions: ['.json'],
        maxFiles,
        includeFile: (_filePath, name) => name.endsWith('.settings.json'),
      }),
      parseFile: parseDroidSettings,
      options,
    });
  }
  if (tool === 'gemini') {
    return readFileBasedSource({
      tool,
      roots: optionPathList(options, ['geminiDataDir', 'geminiHome'], 'GEMINI_DATA_DIR', [path.join(os.homedir(), '.gemini', 'tmp')])
        .map((root) => path.basename(root) === 'tmp' ? root : path.join(root, 'tmp')),
      label: LOCAL_USAGE_TOOL_META.gemini.label,
      sourceType: LOCAL_USAGE_TOOL_META.gemini.sourceType,
      parseFile: parseGeminiFile,
      options,
    });
  }
  if (tool === 'qwen-code') {
    return readFileBasedSource({
      tool,
      roots: optionPathList(options, ['qwenDataDir', 'qwenHome'], 'QWEN_DATA_DIR', [path.join(os.homedir(), '.qwen')]),
      label: LOCAL_USAGE_TOOL_META['qwen-code'].label,
      sourceType: LOCAL_USAGE_TOOL_META['qwen-code'].sourceType,
      collectFiles: (root, maxFiles) => walkFiles(path.join(root, 'projects'), {
        extensions: ['.jsonl'],
        maxFiles,
        includeFile: (filePath) => projectFromQwenFile(filePath) !== '',
      }),
      parseFile: parseQwenFile,
      options,
    });
  }
  if (tool === 'kimi') {
    return readFileBasedSource({
      tool,
      roots: optionPathList(options, ['kimiDataDir', 'kimiHome'], 'KIMI_DATA_DIR', [path.join(os.homedir(), '.kimi')]),
      label: LOCAL_USAGE_TOOL_META.kimi.label,
      sourceType: LOCAL_USAGE_TOOL_META.kimi.sourceType,
      collectFiles: (root, maxFiles) => walkFiles(path.join(root, 'sessions'), {
        extensions: ['.jsonl'],
        maxFiles,
        includeFile: (_filePath, name) => name === 'wire.jsonl',
      }),
      parseFile: parseKimiWireFile,
      options,
    });
  }
  if (tool === 'amp') {
    return readFileBasedSource({
      tool,
      roots: optionPathList(options, ['ampDataDir', 'ampHome'], 'AMP_DATA_DIR', [path.join(os.homedir(), '.local', 'share', 'amp')])
        .map((root) => path.basename(root) === 'threads' ? root : path.join(root, 'threads')),
      label: LOCAL_USAGE_TOOL_META.amp.label,
      sourceType: LOCAL_USAGE_TOOL_META.amp.sourceType,
      collectFiles: (root, maxFiles) => walkFiles(root, { extensions: ['.json'], maxFiles }),
      parseFile: parseAmpThread,
      options,
    });
  }
  if (tool === 'codebuff') {
    return readFileBasedSource({
      tool,
      roots: codebuffRoots(options),
      label: LOCAL_USAGE_TOOL_META.codebuff.label,
      sourceType: LOCAL_USAGE_TOOL_META.codebuff.sourceType,
      collectFiles: (root, maxFiles) => walkFiles(root, {
        extensions: ['.json'],
        maxFiles,
        includeFile: (_filePath, name) => name === 'chat-messages.json',
      }),
      parseFile: parseCodebuffChat,
      options,
    });
  }
  if (tool === 'pi-agent') {
    return readFileBasedSource({
      tool,
      roots: optionPathList(options, ['piAgentDir', 'piPath'], 'PI_AGENT_DIR', [path.join(os.homedir(), '.pi', 'agent', 'sessions')]),
      label: LOCAL_USAGE_TOOL_META['pi-agent'].label,
      sourceType: LOCAL_USAGE_TOOL_META['pi-agent'].sourceType,
      collectFiles: (root, maxFiles) => walkFiles(root, { extensions: ['.jsonl'], maxFiles }),
      parseFile: parsePiFile,
      options,
    });
  }
  if (tool === 'openclaw') {
    return readFileBasedSource({
      tool,
      roots: openClawRoots(options),
      label: LOCAL_USAGE_TOOL_META.openclaw.label,
      sourceType: LOCAL_USAGE_TOOL_META.openclaw.sourceType,
      collectFiles: (root, maxFiles) => walkFiles(root, {
        extensions: ['.jsonl'],
        maxFiles,
        includeFile: (_filePath, name) => name.includes('.jsonl'),
      }),
      parseFile: parseOpenClawFile,
      options,
    });
  }
  if (tool === 'copilot') {
    const { roots, exporter } = copilotFilesRoot(options);
    const result = await readFileBasedSource({
      tool,
      roots,
      label: LOCAL_USAGE_TOOL_META.copilot.label,
      sourceType: LOCAL_USAGE_TOOL_META.copilot.sourceType,
      collectFiles: async (root, maxFiles) => {
        const files = await walkFiles(root, { extensions: ['.jsonl'], maxFiles });
        if (exporter && existsSync(exporter)) files.push({ filePath: exporter, mtimeMs: await fileMtimeMs(exporter) });
        return files;
      },
      parseFile: parseCopilotOtel,
      options,
    });
    if (exporter && !result.sourcePath.includes(exporter)) result.sourcePath = `${result.sourcePath}${path.delimiter}${exporter}`;
    result.exists = result.exists || Boolean(exporter && existsSync(exporter));
    return result;
  }
  if (tool === 'hermes') return readHermesSqlite(options);
  if (tool === 'goose') return readGooseSqlite(options);
  if (tool === 'kilo-code') return readKiloSqlite(options);
  throw new Error(`Unsupported local usage source: ${tool}`);
}
