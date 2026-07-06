const SUPPORTED_TOOLS = [
  'claudecode',
  'claude-desktop',
  'codex',
  'gemini',
  'opencode',
  'openclaw',
  'hermes',
];

const SUPPORTED_PROTOCOLS = [
  'openai-responses',
  'openai-chat',
  'anthropic',
  'gemini',
];

const ROUTE_STRATEGIES = [
  'auto',
  'priority',
  'round_robin',
  'weighted',
  'balance',
];

const RETRY_STATUSES = [408, 409, 425, 429, 500, 502, 503, 504];
const SECRET_HEADER_NAMES = new Set([
  'authorization',
  'api-key',
  'x-api-key',
  'proxy-authorization',
]);

function nowIso() {
  return new Date().toISOString();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampNumber(value, min, max, fallback = min) {
  const number = finiteNumber(value, fallback);
  return Math.max(min, Math.min(max, number));
}

function cleanString(value) {
  return String(value ?? '').trim();
}

export function normalizeRoutingTool(value = 'codex') {
  const raw = cleanString(value).toLowerCase().replace(/_/g, '-');
  if (['claude', 'claude-code', 'claudecode'].includes(raw)) return 'claudecode';
  if (['claude-desktop', 'claudedesktop'].includes(raw)) return 'claude-desktop';
  if (['gemini-cli', 'google-gemini', 'gemini'].includes(raw)) return 'gemini';
  if (['open-code', 'opencode'].includes(raw)) return 'opencode';
  if (['open-claw', 'openclaw'].includes(raw)) return 'openclaw';
  if (['hermes-agent', 'hermes'].includes(raw)) return 'hermes';
  return SUPPORTED_TOOLS.includes(raw) ? raw : 'codex';
}

export function normalizeRoutingProtocol(value = 'openai-chat') {
  const raw = cleanString(value).toLowerCase().replace(/_/g, '-');
  if (['responses', 'openai-responses', 'response'].includes(raw)) return 'openai-responses';
  if (['chat', 'openai-chat', 'chat-completions', 'chat-completion'].includes(raw)) return 'openai-chat';
  if (['anthropic', 'anthropic-messages', 'messages'].includes(raw)) return 'anthropic';
  if (['gemini', 'google-gemini'].includes(raw)) return 'gemini';
  return 'openai-chat';
}

export function normalizeRouteStrategy(value = 'auto', { roundRobin = false } = {}) {
  const raw = cleanString(value).toLowerCase().replace(/-/g, '_');
  if (['priority', 'primary', 'fixed'].includes(raw)) return 'priority';
  if (['round_robin', 'roundrobin', 'rr'].includes(raw)) return 'round_robin';
  if (['weighted', 'weight', 'weighted_round_robin'].includes(raw)) return 'weighted';
  if (['balance', 'balance_first', 'balance_aware'].includes(raw)) return 'balance';
  if (!raw || raw === 'auto' || raw === 'smart') return roundRobin ? 'round_robin' : 'auto';
  return 'auto';
}

export function buildProviderRouteKey(target = {}, defaultTool = 'codex') {
  const tool = normalizeRoutingTool(target.tool || defaultTool);
  const key = cleanString(target.providerKey || target.key || target.id || target.routeKey);
  if (!key) return '';
  if (key.includes(':')) return key.toLowerCase();
  return `${tool}:${key}`;
}

function providerBalancePercent(target = {}) {
  const explicit = target.balancePercent ?? target.balance_percent;
  if (explicit !== undefined && explicit !== null && cleanString(explicit) !== '') {
    return clampNumber(explicit, 0, 100, 0);
  }
  const remaining = finiteNumber(target.balanceRemaining ?? target.balance_remaining, NaN);
  const total = finiteNumber(target.balanceTotal ?? target.balance_total, NaN);
  if (Number.isFinite(remaining) && Number.isFinite(total) && total > 0) {
    return clampNumber((remaining / total) * 100, 0, 100, 0);
  }
  return null;
}

function providerBalanceScore(target = {}) {
  const percent = providerBalancePercent(target);
  if (percent !== null) return percent;
  const remaining = finiteNumber(target.balanceRemaining ?? target.balance_remaining, NaN);
  if (Number.isFinite(remaining)) return remaining;
  const status = cleanString(target.balanceStatus || target.balance_status).toLowerCase();
  return status === 'ok' ? -0.5 : -1;
}

function providerBalanceKnown(target = {}) {
  const status = cleanString(target.balanceStatus || target.balance_status).toLowerCase();
  return status === 'ok' && (providerBalancePercent(target) !== null || Number.isFinite(finiteNumber(target.balanceRemaining ?? target.balance_remaining, NaN)));
}

function providerLowBalance(options, target = {}) {
  if (!options.balanceGuardEnabled) return false;
  const percent = providerBalancePercent(target);
  if (options.balanceMinPercent > 0 && percent !== null && percent < options.balanceMinPercent) {
    return true;
  }
  const remaining = finiteNumber(target.balanceRemaining ?? target.balance_remaining, NaN);
  if (options.balanceMinAmount > 0 && Number.isFinite(remaining) && remaining < options.balanceMinAmount) {
    return true;
  }
  return false;
}

function normalizeProviderTarget(item = {}, index = 0, defaultTool = 'codex') {
  const tool = normalizeRoutingTool(item.tool || defaultTool);
  const providerKey = cleanString(item.providerKey || item.key || item.id);
  const routeKey = buildProviderRouteKey({ ...item, providerKey }, tool);
  return {
    index,
    tool,
    providerKey,
    routeKey,
    name: cleanString(item.name) || providerKey,
    baseUrl: cleanString(item.baseUrl || item.base_url),
    protocol: normalizeRoutingProtocol(item.protocol || item.wireApi || item.wire_api || item.api || 'openai-chat'),
    weight: clampNumber(item.weight ?? 1, 1, 100, 1),
    enabled: item.enabled !== false && item.disabled !== true,
    balanceRemaining: item.balanceRemaining ?? item.balance_remaining ?? null,
    balanceTotal: item.balanceTotal ?? item.balance_total ?? null,
    balancePercent: providerBalancePercent(item),
    balanceStatus: cleanString(item.balanceStatus || item.balance_status || 'unknown').toLowerCase(),
    tags: Array.isArray(item.tags) ? item.tags.map(cleanString).filter(Boolean) : [],
  };
}

function normalizeTargets(input = {}) {
  const defaultTool = normalizeRoutingTool(input.tool || 'codex');
  const rawTargets = Array.isArray(input.providerTargets)
    ? input.providerTargets
    : Array.isArray(input.providers)
      ? input.providers
      : Array.isArray(input.providerKeys)
        ? input.providerKeys.map((key) => ({ providerKey: key }))
        : [];
  const seen = new Set();
  return rawTargets
    .map((item, index) => typeof item === 'string' ? { providerKey: item, index } : { ...item, index })
    .map((item, index) => normalizeProviderTarget(item, index, defaultTool))
    .filter((item) => {
      if (!item.providerKey || !item.routeKey || seen.has(item.routeKey)) return false;
      seen.add(item.routeKey);
      return true;
    });
}

function normalizeStatsMap(input = {}) {
  const map = new Map();
  const raw = input.providerStats || input.health || input.stats?.providers || [];
  const items = Array.isArray(raw)
    ? raw
    : Object.entries(raw || {}).map(([routeKey, value]) => ({ routeKey, ...(value || {}) }));
  for (const item of items) {
    const routeKey = cleanString(item.routeKey || item.providerKey || item.key).toLowerCase();
    if (!routeKey) continue;
    map.set(routeKey, {
      requests: Math.max(0, finiteNumber(item.requests, 0)),
      successes: Math.max(0, finiteNumber(item.successes ?? item.success, 0)),
      failures: Math.max(0, finiteNumber(item.failures ?? item.failure, 0)),
      failureStreak: Math.max(0, finiteNumber(item.failureStreak ?? item.consecutiveFailures, 0)),
      lastStatus: Math.max(0, finiteNumber(item.lastStatus ?? item.status, 0)),
      lastError: cleanString(item.lastError || item.error),
      lastOk: item.lastOk ?? item.ok ?? null,
      health: cleanString(item.health || item.statusText || item.state).toLowerCase(),
      circuitState: cleanString(item.circuitState || item.circuit?.state).toLowerCase(),
      circuitOpenUntilMs: finiteNumber(item.circuitOpenUntilMs ?? item.openUntilMs ?? item.circuit?.openUntilMs, 0),
      lastAtMs: finiteNumber(item.lastAtMs ?? item.atMs ?? item.updatedAtMs, 0),
    });
  }
  const logs = Array.isArray(input.requestLogs) ? input.requestLogs.slice() : [];
  logs.sort((a, b) => finiteNumber(a.atMs, 0) - finiteNumber(b.atMs, 0));
  for (const log of logs) {
    const routeKey = cleanString(log.routeKey || log.providerKey || log.key).toLowerCase();
    if (!routeKey) continue;
    const item = map.get(routeKey) || {
      requests: 0,
      successes: 0,
      failures: 0,
      failureStreak: 0,
      lastStatus: 0,
      lastError: '',
      lastOk: null,
      health: '',
      circuitState: '',
      circuitOpenUntilMs: 0,
      lastAtMs: 0,
    };
    const status = Math.max(0, finiteNumber(log.status ?? log.statusCode, 0));
    const success = log.success === true || (status >= 200 && status < 400);
    item.requests += 1;
    item.lastStatus = status;
    item.lastError = cleanString(log.error);
    item.lastAtMs = finiteNumber(log.atMs, item.lastAtMs);
    item.lastOk = success;
    if (success) {
      item.successes += 1;
      item.failureStreak = 0;
    } else {
      item.failures += 1;
      item.failureStreak += 1;
    }
    map.set(routeKey, item);
  }
  return map;
}

function retryableStatus(status) {
  return status >= 500 || RETRY_STATUSES.includes(status);
}

function computeCircuitState(target, stats, options) {
  if (!options.circuitBreakerEnabled) {
    return { state: 'closed', failureStreak: stats.failureStreak || 0, reason: 'disabled' };
  }
  if (!target.enabled) {
    return { state: 'open', failureStreak: stats.failureStreak || 0, reason: 'provider disabled' };
  }
  if (stats.circuitState === 'open' && stats.circuitOpenUntilMs > options.nowMs) {
    return {
      state: 'open',
      failureStreak: stats.failureStreak || 0,
      openUntilMs: stats.circuitOpenUntilMs,
      reason: 'cooldown active',
    };
  }
  if (stats.circuitState === 'half-open') {
    return { state: 'half-open', failureStreak: stats.failureStreak || 0, reason: 'explicit half-open' };
  }
  if (stats.failureStreak >= options.failureThreshold) {
    return {
      state: 'open',
      failureStreak: stats.failureStreak,
      openUntilMs: options.nowMs + options.cooldownMs,
      reason: `failure streak ${stats.failureStreak} >= ${options.failureThreshold}`,
    };
  }
  if (
    stats.requests >= options.failureThreshold
    && stats.failures >= options.failureThreshold
    && stats.failures / Math.max(stats.requests, 1) >= options.failureRateThreshold
    && retryableStatus(stats.lastStatus)
  ) {
    return {
      state: 'open',
      failureStreak: stats.failureStreak || 0,
      openUntilMs: options.nowMs + options.cooldownMs,
      reason: `failure rate ${(stats.failures / stats.requests).toFixed(2)}`,
    };
  }
  return { state: 'closed', failureStreak: stats.failureStreak || 0, reason: '' };
}

function classifyHealth(target, stats, circuit) {
  if (!target.enabled) return 'disabled';
  if (circuit.state === 'open') return 'circuit-open';
  if (['healthy', 'ok', 'up'].includes(stats.health)) return 'healthy';
  if (['degraded', 'slow', 'warning'].includes(stats.health)) return 'degraded';
  if (['unhealthy', 'down', 'error', 'failed'].includes(stats.health)) return 'unhealthy';
  if (stats.lastOk === true) return 'healthy';
  if (retryableStatus(stats.lastStatus)) return 'unhealthy';
  if (stats.lastStatus >= 400) return 'degraded';
  return 'unknown';
}

function healthRank(value) {
  return {
    healthy: 0,
    degraded: 1,
    unknown: 2,
    unhealthy: 3,
    'circuit-open': 4,
    disabled: 5,
  }[value] ?? 2;
}

function rotate(items, start) {
  if (items.length <= 1) return items.slice();
  return items.map((_, offset) => items[(start + offset) % items.length]);
}

function priorityOrder(items) {
  return items.slice();
}

function roundRobinOrder(items, cursor) {
  return rotate(items, items.length ? cursor % items.length : 0);
}

function weightedOrder(items, cursor) {
  if (items.length <= 1) return items.slice();
  const totalWeight = Math.max(items.length, items.reduce((total, item) => total + item.weight, 0));
  const ticket = cursor % totalWeight;
  let running = 0;
  let start = 0;
  for (let index = 0; index < items.length; index += 1) {
    running += items[index].weight;
    if (ticket < running) {
      start = index;
      break;
    }
  }
  return rotate(items, start);
}

function balanceOrder(items, cursor) {
  const start = items.length ? cursor % items.length : 0;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const knownA = providerBalanceKnown(a.item);
      const knownB = providerBalanceKnown(b.item);
      if (knownA !== knownB) return knownA ? -1 : 1;
      const scoreDelta = providerBalanceScore(b.item) - providerBalanceScore(a.item);
      if (scoreDelta !== 0) return scoreDelta;
      return ((a.index + items.length - start) % items.length) - ((b.index + items.length - start) % items.length);
    })
    .map(({ item }) => item);
}

function autoOrder(items, cursor) {
  const start = items.length ? cursor % items.length : 0;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const healthDelta = healthRank(a.item.health) - healthRank(b.item.health);
      if (healthDelta !== 0) return healthDelta;
      const knownA = providerBalanceKnown(a.item);
      const knownB = providerBalanceKnown(b.item);
      if (knownA !== knownB) return knownA ? -1 : 1;
      const balanceDelta = providerBalanceScore(b.item) - providerBalanceScore(a.item);
      if (balanceDelta !== 0) return balanceDelta;
      const weightDelta = b.item.weight - a.item.weight;
      if (weightDelta !== 0) return weightDelta;
      return ((a.index + items.length - start) % items.length) - ((b.index + items.length - start) % items.length);
    })
    .map(({ item }) => item);
}

function orderTargets(items, strategy, cursor) {
  if (strategy === 'priority') return priorityOrder(items);
  if (strategy === 'round_robin') return roundRobinOrder(items, cursor);
  if (strategy === 'weighted') return weightedOrder(items, cursor);
  if (strategy === 'balance') return balanceOrder(items, cursor);
  return autoOrder(items, cursor);
}

function publicTarget(target) {
  return {
    tool: target.tool,
    providerKey: target.providerKey,
    routeKey: target.routeKey,
    name: target.name,
    baseUrl: target.baseUrl,
    protocol: target.protocol,
    weight: target.weight,
    enabled: target.enabled,
    health: target.health,
    circuit: target.circuit,
    balancePercent: target.balancePercent,
    balanceRemaining: target.balanceRemaining,
    balanceTotal: target.balanceTotal,
    balanceStatus: target.balanceStatus,
    skipReason: target.skipReason || '',
  };
}

export function buildLocalRoutingPlan(input = {}) {
  const tool = normalizeRoutingTool(input.tool || 'codex');
  const strategy = normalizeRouteStrategy(input.routeStrategy || input.strategy || 'auto', {
    roundRobin: Boolean(input.roundRobin),
  });
  const options = {
    balanceGuardEnabled: input.balanceGuardEnabled !== false,
    balanceMinPercent: clampNumber(input.balanceMinPercent ?? 5, 0, 100, 5),
    balanceMinAmount: Math.max(0, finiteNumber(input.balanceMinAmount, 0)),
    circuitBreakerEnabled: input.circuitBreakerEnabled !== false,
    failureThreshold: Math.max(1, Math.floor(finiteNumber(input.failureThreshold ?? 3, 3))),
    failureRateThreshold: clampNumber(input.failureRateThreshold ?? 0.5, 0.01, 1, 0.5),
    cooldownMs: Math.max(1000, finiteNumber(input.cooldownMs ?? 60000, 60000)),
    nowMs: Math.max(0, finiteNumber(input.nowMs ?? Date.now(), Date.now())),
  };
  const cursor = Math.max(0, Math.floor(finiteNumber(input.cursor ?? input.nextIndex, 0)));
  const statsMap = normalizeStatsMap(input);
  let targets = normalizeTargets({ ...input, tool }).map((target) => {
    const stats = statsMap.get(target.routeKey.toLowerCase())
      || statsMap.get(target.providerKey.toLowerCase())
      || {};
    const circuit = computeCircuitState(target, stats, options);
    const health = classifyHealth(target, stats, circuit);
    return {
      ...target,
      stats,
      circuit,
      health,
      lowBalance: providerLowBalance(options, target),
      skipReason: '',
    };
  });

  const enabledTargets = targets.filter((target) => target.enabled);
  const balanceFiltered = enabledTargets.filter((target) => !target.lowBalance);
  const balanceFallbackUsed = enabledTargets.length > 0 && balanceFiltered.length === 0;
  const balancePool = balanceFiltered.length > 0 ? balanceFiltered : enabledTargets;

  const circuitFiltered = balancePool.filter((target) => target.circuit.state !== 'open');
  const circuitFallbackUsed = balancePool.length > 0 && circuitFiltered.length === 0;
  const routablePool = circuitFiltered.length > 0 ? circuitFiltered : balancePool;

  const routableKeys = new Set(routablePool.map((target) => target.routeKey));
  targets = targets.map((target) => {
    if (!target.enabled) return { ...target, skipReason: 'disabled' };
    if (!routableKeys.has(target.routeKey)) {
      if (target.lowBalance && !balanceFallbackUsed) return { ...target, skipReason: 'balance guard' };
      if (target.circuit.state === 'open' && !circuitFallbackUsed) return { ...target, skipReason: 'circuit open' };
      return { ...target, skipReason: 'not selected' };
    }
    return target;
  });

  const routeOrder = orderTargets(
    targets.filter((target) => routableKeys.has(target.routeKey)),
    strategy,
    cursor,
  );
  const primary = routeOrder[0] || null;
  const skipped = targets.filter((target) => target.skipReason);
  const healthCounts = targets.reduce((acc, target) => {
    acc[target.health] = (acc[target.health] || 0) + 1;
    return acc;
  }, {});

  return {
    schema: 'easyaiconfig.local-routing-plan.v1',
    generatedAt: nowIso(),
    tool,
    strategy,
    supportedTools: SUPPORTED_TOOLS,
    supportedProtocols: SUPPORTED_PROTOCOLS,
    retryStatuses: RETRY_STATUSES,
    options: {
      balanceGuardEnabled: options.balanceGuardEnabled,
      balanceMinPercent: options.balanceMinPercent,
      balanceMinAmount: options.balanceMinAmount,
      circuitBreakerEnabled: options.circuitBreakerEnabled,
      failureThreshold: options.failureThreshold,
      failureRateThreshold: options.failureRateThreshold,
      cooldownMs: options.cooldownMs,
      cursor,
    },
    summary: {
      totalProviders: targets.length,
      routableProviders: routeOrder.length,
      skippedProviders: skipped.length,
      failoverProviders: Math.max(0, routeOrder.length - 1),
      primaryProviderKey: primary?.providerKey || '',
      primaryRouteKey: primary?.routeKey || '',
      circuitOpen: targets.filter((target) => target.circuit.state === 'open').length,
      lowBalance: targets.filter((target) => target.lowBalance).length,
      health: healthCounts,
    },
    guardrails: {
      balanceFallbackUsed,
      circuitFallbackUsed,
      noRoutableProvider: routeOrder.length === 0,
    },
    providerTargets: targets.map(publicTarget),
    routeOrder: routeOrder.map(publicTarget),
    failoverOrder: routeOrder.slice(1).map(publicTarget),
    skipped: skipped.map(publicTarget),
  };
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function textFromContent(content, warnings) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (item && typeof item === 'object' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (item && typeof item === 'object' && item.type && !String(item.type).includes('text')) {
        warnings.push(`Dropped non-text content part: ${item.type}`);
      }
    }
    return parts.join('\n');
  }
  if (content == null) return '';
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

function messagesFromResponsesInput(body, warnings) {
  const messages = [];
  if (body.instructions) {
    messages.push({ role: 'system', content: textFromContent(body.instructions, warnings) });
  }
  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (item && typeof item === 'object') {
        const role = cleanString(item.role || 'user') || 'user';
        const content = item.content ?? item.text ?? item.input ?? '';
        messages.push({ role, content: textFromContent(content, warnings) });
      }
    }
  }
  return messages;
}

function responsesToChat(body, changes, warnings) {
  const out = cloneJson(body) || {};
  const messages = messagesFromResponsesInput(out, warnings);
  if (messages.length > 0) {
    out.messages = messages;
    changes.push('Converted Responses input/instructions to Chat Completions messages.');
  }
  if (out.max_output_tokens !== undefined && out.max_tokens === undefined) {
    out.max_tokens = out.max_output_tokens;
    changes.push('Renamed max_output_tokens to max_tokens.');
  }
  delete out.input;
  delete out.instructions;
  delete out.max_output_tokens;
  if (out.reasoning) warnings.push('Reasoning controls may not be supported by the target Chat Completions provider.');
  return out;
}

function chatToResponses(body, changes, warnings) {
  const out = cloneJson(body) || {};
  const messages = Array.isArray(out.messages) ? out.messages : [];
  const system = [];
  const input = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = cleanString(message.role || 'user') || 'user';
    const content = textFromContent(message.content, warnings);
    if (role === 'system') system.push(content);
    else input.push({ role, content });
  }
  if (system.length > 0) out.instructions = system.join('\n\n');
  if (input.length > 0) out.input = input;
  if (out.max_tokens !== undefined && out.max_output_tokens === undefined) {
    out.max_output_tokens = out.max_tokens;
    changes.push('Renamed max_tokens to max_output_tokens.');
  }
  delete out.messages;
  delete out.max_tokens;
  changes.push('Converted Chat Completions messages to Responses input.');
  return out;
}

function chatToAnthropic(body, changes, warnings) {
  const out = cloneJson(body) || {};
  const messages = Array.isArray(out.messages) ? out.messages : [];
  const system = [];
  const anthropicMessages = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = cleanString(message.role || 'user') || 'user';
    const content = textFromContent(message.content, warnings);
    if (role === 'system') system.push(content);
    else anthropicMessages.push({ role: role === 'assistant' ? 'assistant' : 'user', content });
  }
  out.messages = anthropicMessages;
  if (system.length > 0) out.system = system.join('\n\n');
  if (out.max_output_tokens !== undefined && out.max_tokens === undefined) out.max_tokens = out.max_output_tokens;
  if (out.max_completion_tokens !== undefined && out.max_tokens === undefined) out.max_tokens = out.max_completion_tokens;
  if (out.stop !== undefined && out.stop_sequences === undefined) out.stop_sequences = out.stop;
  delete out.max_output_tokens;
  delete out.max_completion_tokens;
  delete out.stop;
  if (!out.max_tokens) warnings.push('Anthropic Messages requires max_tokens; target may reject the request without it.');
  if (Array.isArray(out.tools) && out.tools.length > 0) warnings.push('Tool schema may need provider-specific Anthropic conversion.');
  changes.push('Converted Chat Completions messages to Anthropic Messages.');
  return out;
}

function anthropicToChat(body, changes, warnings) {
  const out = cloneJson(body) || {};
  const messages = [];
  if (out.system) messages.push({ role: 'system', content: textFromContent(out.system, warnings) });
  if (Array.isArray(out.messages)) {
    for (const message of out.messages) {
      if (!message || typeof message !== 'object') continue;
      messages.push({
        role: cleanString(message.role || 'user') === 'assistant' ? 'assistant' : 'user',
        content: textFromContent(message.content, warnings),
      });
    }
  }
  out.messages = messages;
  if (out.stop_sequences !== undefined && out.stop === undefined) out.stop = out.stop_sequences;
  delete out.system;
  delete out.stop_sequences;
  changes.push('Converted Anthropic Messages to Chat Completions messages.');
  return out;
}

function geminiModelIdFromBody(body = {}) {
  const raw = cleanString(body.model || 'gemini-2.5-flash');
  const parts = raw.split('/').map((item) => item.trim()).filter(Boolean);
  const tail = parts.length > 1 ? parts.slice(1).join('/') : raw;
  return cleanString(tail.replace(/^models\//, '')) || 'gemini-2.5-flash';
}

function geminiPathForBody(path = '', body = {}) {
  const model = geminiModelIdFromBody(body);
  const stream = body.stream === true;
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  let out = `/v1beta/models/${model}:${action}`;
  const query = String(path || '').split('?')[1] || '';
  let queryItems = query.trim();
  if (stream && !queryItems.split('&').includes('alt=sse')) {
    queryItems = queryItems ? `${queryItems}&alt=sse` : 'alt=sse';
  }
  if (queryItems) out += `?${queryItems}`;
  return out;
}

function openAiToolsToGeminiTools(tools = []) {
  if (!Array.isArray(tools)) return null;
  const functionDeclarations = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || tool.type !== 'function') continue;
    const fn = tool.function && typeof tool.function === 'object' ? tool.function : {};
    const name = cleanString(fn.name);
    if (!name) continue;
    const declaration = { name };
    if (cleanString(fn.description)) declaration.description = cleanString(fn.description);
    if (fn.parameters !== undefined) declaration.parameters = cloneJson(fn.parameters);
    functionDeclarations.push(declaration);
  }
  return functionDeclarations.length > 0 ? [{ functionDeclarations }] : null;
}

function applyGeminiGenerationConfig(out) {
  const generationConfig = {
    ...(out.generation_config && typeof out.generation_config === 'object' ? out.generation_config : {}),
    ...(out.generationConfig && typeof out.generationConfig === 'object' ? out.generationConfig : {}),
  };
  const map = [
    ['max_tokens', 'maxOutputTokens'],
    ['max_completion_tokens', 'maxOutputTokens'],
    ['max_output_tokens', 'maxOutputTokens'],
    ['temperature', 'temperature'],
    ['top_p', 'topP'],
    ['top_k', 'topK'],
  ];
  for (const [source, target] of map) {
    if (generationConfig[target] === undefined && out[source] !== undefined) {
      generationConfig[target] = cloneJson(out[source]);
    }
  }
  if (generationConfig.stopSequences === undefined) {
    if (out.stop !== undefined) generationConfig.stopSequences = cloneJson(out.stop);
    else if (out.stop_sequences !== undefined) generationConfig.stopSequences = cloneJson(out.stop_sequences);
  }
  if (
    generationConfig.responseMimeType === undefined &&
    out.response_format &&
    typeof out.response_format === 'object' &&
    out.response_format.type === 'json_object'
  ) {
    generationConfig.responseMimeType = 'application/json';
  }
  if (Object.keys(generationConfig).length > 0) out.generationConfig = generationConfig;
}

function chatToGemini(body, changes, warnings) {
  const out = cloneJson(body) || {};
  const messages = Array.isArray(out.messages) ? out.messages : [];
  const systemParts = [];
  const contents = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = cleanString(message.role || 'user') || 'user';
    const text = textFromContent(message.content, warnings);
    if (!text.trim()) continue;
    if (role === 'system') {
      systemParts.push({ text });
    } else {
      contents.push({
        role: role === 'assistant' || role === 'model' ? 'model' : 'user',
        parts: [{ text }],
      });
    }
  }
  if (contents.length > 0) out.contents = contents;
  if (systemParts.length > 0) out.systemInstruction = { parts: systemParts };
  const geminiTools = openAiToolsToGeminiTools(out.tools);
  if (geminiTools) out.tools = geminiTools;
  else if (Array.isArray(out.tools) && out.tools.length > 0) warnings.push('Tool schema could not be converted to Gemini functionDeclarations.');
  applyGeminiGenerationConfig(out);
  for (const key of [
    'messages',
    'model',
    'max_tokens',
    'max_completion_tokens',
    'max_output_tokens',
    'temperature',
    'top_p',
    'top_k',
    'stop',
    'stop_sequences',
    'response_format',
    'stream',
    'tool_choice',
  ]) {
    delete out[key];
  }
  changes.push('Converted Chat Completions messages to Gemini GenerateContent contents.');
  return out;
}

function geminiModelIdFromPath(path = '') {
  const text = cleanString(path);
  const match = text.match(/\/models\/([^:?/]+(?:\/[^:?/]+)*)/);
  return cleanString(match?.[1]) || 'gemini';
}

function geminiCandidateParts(candidate = {}) {
  return Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
}

function geminiTextFromParts(parts = []) {
  return parts
    .map((part) => cleanString(part?.text))
    .filter(Boolean)
    .join('\n');
}

function geminiFunctionCallsFromParts(parts = []) {
  return parts
    .map((part) => part?.functionCall)
    .filter((call) => call && typeof call === 'object' && cleanString(call.name))
    .map((call) => ({
      name: cleanString(call.name),
      args: cloneJson(call.args && typeof call.args === 'object' ? call.args : {}),
    }));
}

function geminiFinishReasonForOpenAi(reason = '') {
  const normalized = cleanString(reason).toUpperCase();
  if (normalized === 'MAX_TOKENS') return 'length';
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(normalized)) return 'content_filter';
  return 'stop';
}

function geminiFinishReasonForAnthropic(reason = '') {
  return cleanString(reason).toUpperCase() === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
}

function geminiUsageForOpenAi(body = {}, responsesApi = false) {
  const usage = body.usageMetadata && typeof body.usageMetadata === 'object' ? body.usageMetadata : null;
  if (!usage) return undefined;
  const inputTokens = Number(usage.promptTokenCount || 0);
  const outputTokens = Number(usage.candidatesTokenCount || 0);
  const totalTokens = Number(usage.totalTokenCount || inputTokens + outputTokens);
  const cachedTokens = Number(usage.cachedContentTokenCount || 0);
  if (responsesApi) {
    const out = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens };
    if (cachedTokens > 0) out.input_tokens_details = { cached_tokens: cachedTokens };
    return out;
  }
  const out = { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens };
  if (cachedTokens > 0) out.prompt_tokens_details = { cached_tokens: cachedTokens };
  return out;
}

function geminiUsageForAnthropic(body = {}) {
  const usage = body.usageMetadata && typeof body.usageMetadata === 'object' ? body.usageMetadata : null;
  if (!usage) return undefined;
  const out = {
    input_tokens: Number(usage.promptTokenCount || 0),
    output_tokens: Number(usage.candidatesTokenCount || 0),
  };
  if (Number(usage.cachedContentTokenCount || 0) > 0) {
    out.cache_read_input_tokens = Number(usage.cachedContentTokenCount || 0);
  }
  return out;
}

function geminiResponseToChat(body = {}, path = '') {
  const model = geminiModelIdFromPath(path);
  const choices = (Array.isArray(body.candidates) ? body.candidates : []).map((candidate, index) => {
    const parts = geminiCandidateParts(candidate);
    const text = geminiTextFromParts(parts);
    const calls = geminiFunctionCallsFromParts(parts);
    const message = {
      role: 'assistant',
      content: text || (calls.length > 0 ? null : ''),
    };
    if (calls.length > 0) {
      message.tool_calls = calls.map((call, callIndex) => ({
        id: `call_${callIndex}`,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.args || {}),
        },
      }));
    }
    return {
      index,
      message,
      finish_reason: geminiFinishReasonForOpenAi(candidate?.finishReason),
    };
  });
  const out = {
    id: 'chatcmpl-easyaiconfig-preview',
    object: 'chat.completion',
    created: 0,
    model,
    choices,
  };
  const usage = geminiUsageForOpenAi(body, false);
  if (usage) out.usage = usage;
  return out;
}

function geminiResponseToResponses(body = {}, path = '') {
  const model = geminiModelIdFromPath(path);
  const output = [];
  const outputText = [];
  for (const [index, candidate] of (Array.isArray(body.candidates) ? body.candidates : []).entries()) {
    const parts = geminiCandidateParts(candidate);
    const text = geminiTextFromParts(parts);
    if (text) {
      outputText.push(text);
      output.push({
        id: `msg_${index}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
    }
    for (const [callIndex, call] of geminiFunctionCallsFromParts(parts).entries()) {
      output.push({
        id: `fc_${index}_${callIndex}`,
        type: 'function_call',
        call_id: `call_${index}_${callIndex}`,
        name: call.name,
        arguments: JSON.stringify(call.args || {}),
        status: 'completed',
      });
    }
  }
  const out = {
    id: 'resp_easyaiconfig_preview',
    object: 'response',
    created_at: 0,
    status: 'completed',
    model,
    output,
    output_text: outputText.join('\n'),
  };
  const usage = geminiUsageForOpenAi(body, true);
  if (usage) out.usage = usage;
  return out;
}

function geminiResponseToAnthropic(body = {}, path = '') {
  const model = geminiModelIdFromPath(path);
  const candidate = Array.isArray(body.candidates) ? body.candidates[0] || {} : {};
  const parts = geminiCandidateParts(candidate);
  const text = geminiTextFromParts(parts);
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const [index, call] of geminiFunctionCallsFromParts(parts).entries()) {
    content.push({
      type: 'tool_use',
      id: `toolu_${index}`,
      name: call.name,
      input: call.args || {},
    });
  }
  const out = {
    id: 'msg_easyaiconfig_preview',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: geminiFinishReasonForAnthropic(candidate?.finishReason),
    stop_sequence: null,
  };
  const usage = geminiUsageForAnthropic(body);
  if (usage) out.usage = usage;
  return out;
}

function geminiErrorMessage(body = {}) {
  if (cleanString(body?.error?.message)) return cleanString(body.error.message);
  if (cleanString(body?.message)) return cleanString(body.message);
  if (typeof body?.error === 'string' && cleanString(body.error)) return cleanString(body.error);
  return 'Gemini upstream request failed';
}

function geminiErrorCode(body = {}, status = 0) {
  if (cleanString(body?.error?.status)) return cleanString(body.error.status).toLowerCase();
  if (body?.error?.code !== undefined && body.error.code !== null) return String(body.error.code);
  return String(Number(status || 0) || 'upstream_error');
}

function openAiErrorType(status = 0) {
  const code = Number(status || 0);
  if (code === 401) return 'authentication_error';
  if (code === 403) return 'permission_error';
  if (code === 404) return 'not_found_error';
  if ([408, 409, 425, 429].includes(code)) return 'rate_limit_error';
  if (code >= 500) return 'server_error';
  return 'invalid_request_error';
}

function anthropicErrorType(status = 0) {
  const code = Number(status || 0);
  if (code === 401) return 'authentication_error';
  if (code === 403) return 'permission_error';
  if (code === 404) return 'not_found_error';
  if ([408, 409, 425, 429].includes(code)) return 'rate_limit_error';
  if (code === 529) return 'overloaded_error';
  if (code >= 500) return 'api_error';
  return 'invalid_request_error';
}

function rectifyGeminiErrorBody(body = {}, sourceProtocol = 'openai-chat', status = 0) {
  const message = geminiErrorMessage(body);
  if (sourceProtocol === 'anthropic') {
    return {
      type: 'error',
      error: {
        type: anthropicErrorType(status),
        message,
      },
    };
  }
  if (sourceProtocol === 'openai-chat' || sourceProtocol === 'openai-responses') {
    return {
      error: {
        message,
        type: openAiErrorType(status),
        param: null,
        code: geminiErrorCode(body, status),
      },
    };
  }
  return cloneJson(body);
}

function parseSseJsonPayloads(body = '') {
  const events = [];
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n').trim();
    dataLines = [];
    if (!payload || payload === '[DONE]') return;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // Preview keeps malformed events out instead of failing the whole rectifier.
    }
  };
  for (const line of String(body || '').split(/\n/)) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.trim()) {
      flush();
      continue;
    }
    if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).trimStart());
  }
  flush();
  return events;
}

function sseData(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function namedSseEvent(event, value) {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

function geminiStreamAggregate(events = []) {
  const parts = [];
  let finishReason = '';
  let usageMetadata = null;
  for (const event of events) {
    if (event?.usageMetadata) usageMetadata = cloneJson(event.usageMetadata);
    for (const candidate of Array.isArray(event?.candidates) ? event.candidates : []) {
      if (cleanString(candidate.finishReason)) finishReason = cleanString(candidate.finishReason);
      parts.push(...geminiCandidateParts(candidate));
    }
  }
  const candidate = { content: { parts } };
  if (finishReason) candidate.finishReason = finishReason;
  const out = { candidates: [candidate] };
  if (usageMetadata) out.usageMetadata = usageMetadata;
  return out;
}

function geminiStreamToChatSse(events = [], path = '') {
  const model = geminiModelIdFromPath(path);
  let sentRole = false;
  let out = '';
  for (const event of events) {
    const usage = geminiUsageForOpenAi(event, false);
    const candidates = Array.isArray(event?.candidates) ? event.candidates : [];
    if (candidates.length === 0 && usage) {
      out += sseData({
        id: 'chatcmpl-easyaiconfig-preview',
        object: 'chat.completion.chunk',
        created: 0,
        model,
        choices: [],
        usage,
      });
      continue;
    }
    for (const [index, candidate] of candidates.entries()) {
      const parts = geminiCandidateParts(candidate);
      const text = geminiTextFromParts(parts);
      const calls = geminiFunctionCallsFromParts(parts);
      const delta = {};
      if (!sentRole) {
        delta.role = 'assistant';
        sentRole = true;
      }
      if (text) delta.content = text;
      if (calls.length > 0) {
        delta.tool_calls = calls.map((call, callIndex) => ({
          index: callIndex,
          id: `call_${callIndex}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
        }));
      }
      out += sseData({
        id: 'chatcmpl-easyaiconfig-preview',
        object: 'chat.completion.chunk',
        created: 0,
        model,
        choices: [{
          index,
          delta,
          finish_reason: candidate.finishReason ? geminiFinishReasonForOpenAi(candidate.finishReason) : null,
        }],
        ...(usage ? { usage } : {}),
      });
    }
  }
  return `${out}data: [DONE]\n\n`;
}

function geminiStreamToResponsesSse(events = [], path = '') {
  let out = '';
  for (const event of events) {
    for (const [index, candidate] of (Array.isArray(event?.candidates) ? event.candidates : []).entries()) {
      const parts = geminiCandidateParts(candidate);
      const text = geminiTextFromParts(parts);
      if (text) {
        out += namedSseEvent('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: `msg_${index}`,
          output_index: index,
          content_index: 0,
          delta: text,
        });
      }
      for (const [callIndex, call] of geminiFunctionCallsFromParts(parts).entries()) {
        out += namedSseEvent('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: index,
          item: {
            id: `fc_${index}_${callIndex}`,
            type: 'function_call',
            call_id: `call_${index}_${callIndex}`,
            name: call.name,
            arguments: JSON.stringify(call.args || {}),
            status: 'completed',
          },
        });
      }
    }
  }
  out += namedSseEvent('response.completed', {
    type: 'response.completed',
    response: geminiResponseToResponses(geminiStreamAggregate(events), path),
  });
  return out;
}

function geminiStreamToAnthropicSse(events = [], path = '') {
  const model = geminiModelIdFromPath(path);
  const aggregate = geminiStreamAggregate(events);
  const usage = geminiUsageForAnthropic(aggregate) || {};
  let out = namedSseEvent('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_easyaiconfig_preview',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  let textStarted = false;
  let textIndex = 0;
  let nextBlockIndex = 0;
  for (const event of events) {
    for (const candidate of (Array.isArray(event?.candidates) ? event.candidates : [])) {
      const parts = geminiCandidateParts(candidate);
      const text = geminiTextFromParts(parts);
      if (text) {
        if (!textStarted) {
          textStarted = true;
          textIndex = nextBlockIndex++;
          out += namedSseEvent('content_block_start', {
            type: 'content_block_start',
            index: textIndex,
            content_block: { type: 'text', text: '' },
          });
        }
        out += namedSseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text },
        });
      }
      for (const call of geminiFunctionCallsFromParts(parts)) {
        const index = nextBlockIndex++;
        out += namedSseEvent('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: `toolu_${index}`, name: call.name, input: {} },
        });
        out += namedSseEvent('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args || {}) },
        });
        out += namedSseEvent('content_block_stop', { type: 'content_block_stop', index });
      }
    }
  }
  if (textStarted) out += namedSseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex });
  const finishReason = cleanString(aggregate?.candidates?.[0]?.finishReason);
  out += namedSseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: geminiFinishReasonForAnthropic(finishReason), stop_sequence: null },
    usage,
  });
  out += namedSseEvent('message_stop', { type: 'message_stop' });
  return out;
}

function rectifyResponseBody(body, sourceProtocol, targetProtocol, path, status, changes, warnings) {
  if (sourceProtocol === targetProtocol) return cloneJson(body);
  const statusCode = Number(status || 0);
  if (targetProtocol === 'gemini' && body && typeof body === 'object' && !Array.isArray(body) && body.error && statusCode >= 400) {
    changes.push('Converted Gemini error response to caller protocol error format.');
    return rectifyGeminiErrorBody(body, sourceProtocol, statusCode);
  }
  if (typeof body === 'string' && targetProtocol === 'gemini') {
    const events = parseSseJsonPayloads(body);
    if (events.length > 0 && sourceProtocol === 'openai-chat') {
      changes.push('Converted Gemini streamGenerateContent SSE to Chat Completions SSE.');
      return geminiStreamToChatSse(events, path);
    }
    if (events.length > 0 && sourceProtocol === 'openai-responses') {
      changes.push('Converted Gemini streamGenerateContent SSE to OpenAI Responses SSE.');
      return geminiStreamToResponsesSse(events, path);
    }
    if (events.length > 0 && sourceProtocol === 'anthropic') {
      changes.push('Converted Gemini streamGenerateContent SSE to Anthropic Messages SSE.');
      return geminiStreamToAnthropicSse(events, path);
    }
  }
  if (targetProtocol === 'gemini' && sourceProtocol === 'openai-chat') {
    changes.push('Converted Gemini GenerateContent response to Chat Completions response.');
    return geminiResponseToChat(body, path);
  }
  if (targetProtocol === 'gemini' && sourceProtocol === 'openai-responses') {
    changes.push('Converted Gemini GenerateContent response to OpenAI Responses response.');
    return geminiResponseToResponses(body, path);
  }
  if (targetProtocol === 'gemini' && sourceProtocol === 'anthropic') {
    changes.push('Converted Gemini GenerateContent response to Anthropic Messages response.');
    return geminiResponseToAnthropic(body, path);
  }
  warnings.push(`No automatic response rectifier exists for ${targetProtocol} -> ${sourceProtocol}; response body left unchanged.`);
  return cloneJson(body);
}

function rectifyBody(body, sourceProtocol, targetProtocol, changes, warnings) {
  if (sourceProtocol === targetProtocol) return cloneJson(body);
  if (sourceProtocol === 'openai-responses' && targetProtocol === 'openai-chat') {
    return responsesToChat(body, changes, warnings);
  }
  if (sourceProtocol === 'openai-chat' && targetProtocol === 'openai-responses') {
    return chatToResponses(body, changes, warnings);
  }
  if (sourceProtocol === 'openai-chat' && targetProtocol === 'anthropic') {
    return chatToAnthropic(body, changes, warnings);
  }
  if (sourceProtocol === 'anthropic' && targetProtocol === 'openai-chat') {
    return anthropicToChat(body, changes, warnings);
  }
  if (sourceProtocol === 'openai-responses' && targetProtocol === 'anthropic') {
    return chatToAnthropic(responsesToChat(body, changes, warnings), changes, warnings);
  }
  if (sourceProtocol === 'anthropic' && targetProtocol === 'openai-responses') {
    return chatToResponses(anthropicToChat(body, changes, warnings), changes, warnings);
  }
  if (sourceProtocol === 'openai-chat' && targetProtocol === 'gemini') {
    return chatToGemini(body, changes, warnings);
  }
  if (sourceProtocol === 'openai-responses' && targetProtocol === 'gemini') {
    return chatToGemini(responsesToChat(body, changes, warnings), changes, warnings);
  }
  if (sourceProtocol === 'anthropic' && targetProtocol === 'gemini') {
    return chatToGemini(anthropicToChat(body, changes, warnings), changes, warnings);
  }
  warnings.push(`No automatic rectifier exists for ${sourceProtocol} -> ${targetProtocol}; request body left unchanged.`);
  return cloneJson(body);
}

export function previewRequestRectifier(input = {}) {
  const sourceProtocol = normalizeRoutingProtocol(input.sourceProtocol || input.from || input.protocol || 'openai-chat');
  const targetProtocol = normalizeRoutingProtocol(input.targetProtocol || input.to || input.target || 'openai-chat');
  const request = input.request && typeof input.request === 'object' ? input.request : input;
  const body = request.body && typeof request.body === 'object' ? request.body : request;
  const changes = [];
  const warnings = [];
  const rectifiedBody = rectifyBody(body, sourceProtocol, targetProtocol, changes, warnings);
  const originalPath = cleanString(request.path || request.url || '');
  const rectifiedPath = sourceProtocol !== targetProtocol && targetProtocol === 'gemini'
    ? geminiPathForBody(originalPath, body)
    : originalPath;
  const changed = JSON.stringify(rectifiedBody) !== JSON.stringify(body) || rectifiedPath !== originalPath;
  return {
    schema: 'easyaiconfig.request-rectifier-preview.v1',
    sourceProtocol,
    targetProtocol,
    changed,
    changes,
    warnings,
    request: {
      method: cleanString(request.method || 'POST').toUpperCase() || 'POST',
      path: rectifiedPath,
      body: rectifiedBody,
    },
  };
}

export function previewResponseRectifier(input = {}) {
  const sourceProtocol = normalizeRoutingProtocol(input.sourceProtocol || input.from || input.clientProtocol || 'openai-chat');
  const targetProtocol = normalizeRoutingProtocol(input.targetProtocol || input.to || input.upstreamProtocol || 'openai-chat');
  const response = input.response && typeof input.response === 'object' ? input.response : input;
  const body = Object.prototype.hasOwnProperty.call(response, 'body') ? response.body : response;
  const changes = [];
  const warnings = [];
  const originalPath = cleanString(response.path || response.url || input.path || '');
  const status = Number(response.status || response.statusCode || 200);
  const rectifiedBody = rectifyResponseBody(body, sourceProtocol, targetProtocol, originalPath, status, changes, warnings);
  const changed = JSON.stringify(rectifiedBody) !== JSON.stringify(body);
  return {
    schema: 'easyaiconfig.response-rectifier-preview.v1',
    sourceProtocol,
    targetProtocol,
    changed,
    changes,
    warnings,
    response: {
      status,
      body: rectifiedBody,
    },
  };
}

export function redactLocalRoutingLogEntry(entry = {}) {
  const out = cloneJson(entry) || {};
  for (const key of ['apiKey', 'api_key', 'authToken', 'accessToken', 'refreshToken']) {
    if (out[key]) out[key] = '[redacted]';
  }
  if (out.headers && typeof out.headers === 'object') {
    for (const key of Object.keys(out.headers)) {
      if (SECRET_HEADER_NAMES.has(key.toLowerCase())) {
        out.headers[key] = '[redacted]';
      }
    }
  }
  if (out.request?.headers && typeof out.request.headers === 'object') {
    for (const key of Object.keys(out.request.headers)) {
      if (SECRET_HEADER_NAMES.has(key.toLowerCase())) {
        out.request.headers[key] = '[redacted]';
      }
    }
  }
  return out;
}

export function localRoutingCapabilities() {
  return {
    schema: 'easyaiconfig.local-routing-capabilities.v1',
    supportedTools: SUPPORTED_TOOLS,
    supportedProtocols: SUPPORTED_PROTOCOLS,
    routeStrategies: ROUTE_STRATEGIES,
    retryStatuses: RETRY_STATUSES,
    controlPlane: {
      routingPlan: true,
      balanceGuard: true,
      circuitBreaker: true,
      healthAwareOrdering: true,
      requestRectifierPreview: true,
      responseRectifierPreview: true,
      secretRedaction: true,
    },
    runtime: {
      tauriProviderRouter: true,
      nodeProxyRuntime: false,
    },
  };
}
