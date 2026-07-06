import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { parseAssetImportInput } from './provider-catalog.js';

function defaultCodexHome() {
  return process.env.CODEX_HOME?.trim()
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function defaultClaudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function defaultClaudeDesktopConfigPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'Claude', 'claude_desktop_config.json');
}

function defaultOpenCodeConfigPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming'), 'opencode', 'opencode.json');
  }
  return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), 'opencode', 'opencode.json');
}

function defaultGeminiSettingsPath() {
  return path.join(os.homedir(), '.gemini', 'settings.json');
}

function defaultQwenSettingsPath() {
  return path.join(os.homedir(), '.qwen', 'settings.json');
}

function defaultCodeBuddyHome() {
  const configured = process.env.CODEBUDDY_CONFIG_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codebuddy');
}

function defaultCodeBuddyMcpPath() {
  return path.join(defaultCodeBuddyHome(), '.mcp.json');
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function stripJsonComments(input = '') {
  const text = String(input || '');
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonLike(raw, sourceLabel) {
  if (!String(raw || '').trim()) return {};
  try {
    return JSON.parse(stripJsonComments(raw));
  } catch (error) {
    throw new Error(`${sourceLabel} parse failed: ${error.message}`);
  }
}

function parseToml(raw, sourceLabel) {
  if (!String(raw || '').trim()) return {};
  try {
    return TOML.parse(raw);
  } catch (error) {
    throw new Error(`${sourceLabel} parse failed: ${error.message}`);
  }
}

function normalizeArgs(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function normalizeEnvKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

function normalizeMcpServers(value, { tool, field }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).map(([id, raw]) => {
    const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      id,
      tool,
      field,
      command: String(entry.command || entry.cmd || ''),
      args: normalizeArgs(entry.args),
      envKeys: normalizeEnvKeys(entry.env),
      transport: String(entry.transport || entry.type || (entry.url ? 'http' : 'stdio')),
      url: String(entry.url || ''),
      disabled: Boolean(entry.disabled),
      raw: entry,
    };
  });
}

function sourceResult({ tool, label, sourcePath, exists, parseError = '', servers = [] }) {
  return {
    tool,
    label,
    sourcePath,
    exists,
    parseError,
    count: servers.length,
    servers,
  };
}

const TARGET_FIELDS = {
  codex: 'mcp_servers',
  claudecode: 'mcpServers',
  claudedesktop: 'mcpServers',
  opencode: 'mcp',
  gemini: 'mcpServers',
  'qwen-code': 'mcpServers',
  'codebuddy-code': 'mcpServers',
};

const MCP_TARGET_TOOLS = ['codex', 'claudecode', 'claudedesktop', 'opencode', 'gemini', 'qwen-code', 'codebuddy-code'];

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function serverFingerprint(server = {}) {
  return stableStringify({
    command: server.command || '',
    args: server.args || [],
    envKeys: server.envKeys || [],
    transport: server.transport || '',
    url: server.url || '',
    disabled: Boolean(server.disabled),
  });
}

function publicServerForPlan(server = {}) {
  return {
    id: server.id,
    tool: server.tool,
    field: server.field,
    sourcePath: server.sourcePath,
    sourceLabel: server.sourceLabel,
    command: server.command,
    args: server.args,
    envKeys: server.envKeys,
    transport: server.transport,
    url: server.url,
    disabled: server.disabled,
  };
}

function normalizeTool(value = '') {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (key === 'claude' || key === 'claudecode') return 'claudecode';
  if (key === 'claudedesktop' || key === 'claudeapp') return 'claudedesktop';
  if (key === 'codex' || key === 'openaicodex') return 'codex';
  if (key === 'opencode') return 'opencode';
  if (key === 'gemini' || key === 'geminicli') return 'gemini';
  if (['qwen', 'qwencode', 'qwencli', 'qwencodecli'].includes(key)) return 'qwen-code';
  if (['codebuddy', 'codebuddycode', 'codebuddycli', 'tencentcodebuddy'].includes(key)) return 'codebuddy-code';
  return key;
}

function normalizeTargetTools(value = 'codex') {
  const raw = Array.isArray(value)
    ? value
    : String(value || 'codex').split(',');
  const normalized = raw.map(normalizeTool).filter(Boolean);
  if (!normalized.length) return ['codex'];
  if (normalized.includes('all')) return [...MCP_TARGET_TOOLS];
  return Array.from(new Set(normalized.filter((tool) => MCP_TARGET_TOOLS.includes(tool))));
}

function normalizeToolList(value) {
  if (Array.isArray(value)) return value.map(normalizeTool).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [normalizeTool(value)];
  return [];
}

function normalizeServerId(value = '') {
  const id = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || '';
}

function mcpSourceForTool(tool, options = {}) {
  const codexHome = options.codexHome ? path.resolve(String(options.codexHome)) : defaultCodexHome();
  if (tool === 'codex') {
    return {
      tool,
      label: 'Codex config.toml',
      sourcePath: options.codexConfigPath || path.join(codexHome, 'config.toml'),
      format: 'toml',
      defaultField: 'mcp_servers',
    };
  }
  if (tool === 'claudecode') {
    return {
      tool,
      label: 'Claude Code settings.json',
      sourcePath: options.claudeSettingsPath || defaultClaudeSettingsPath(),
      format: 'json',
      defaultField: 'mcpServers',
    };
  }
  if (tool === 'claudedesktop') {
    return {
      tool,
      label: 'Claude Desktop config',
      sourcePath: options.claudeDesktopConfigPath || defaultClaudeDesktopConfigPath(),
      format: 'json',
      defaultField: 'mcpServers',
    };
  }
  if (tool === 'opencode') {
    return {
      tool,
      label: 'OpenCode opencode.json',
      sourcePath: options.openCodeConfigPath || defaultOpenCodeConfigPath(),
      format: 'json',
      defaultField: 'mcp',
    };
  }
  if (tool === 'gemini') {
    return {
      tool,
      label: 'Gemini CLI settings.json',
      sourcePath: options.geminiSettingsPath || defaultGeminiSettingsPath(),
      format: 'json',
      defaultField: 'mcpServers',
    };
  }
  if (tool === 'qwen-code') {
    return {
      tool,
      label: 'Qwen Code settings.json',
      sourcePath: options.qwenSettingsPath || defaultQwenSettingsPath(),
      format: 'json',
      defaultField: 'mcpServers',
    };
  }
  if (tool === 'codebuddy-code') {
    return {
      tool,
      label: 'CodeBuddy .mcp.json',
      sourcePath: options.codeBuddyMcpPath || defaultCodeBuddyMcpPath(),
      format: 'json',
      defaultField: 'mcpServers',
    };
  }
  throw new Error(`Unsupported MCP target tool: ${tool}`);
}

function mcpEntriesFromPayload(payload = {}) {
  const assets = payload.assets && typeof payload.assets === 'object' ? payload.assets : payload;
  const candidates = [
    assets.mcpServers,
    payload.mcpServers,
    assets.mcp,
    payload.mcp,
  ];
  const source = candidates.find((item) => Array.isArray(item) || isPlainObject(item));
  if (Array.isArray(source)) return source;
  if (isPlainObject(source)) {
    return Object.entries(source).map(([id, value]) => (
      isPlainObject(value) ? { id, ...value } : { id, command: String(value ?? '') }
    ));
  }
  return [];
}

function publicMcpServerBlock(server = {}) {
  const env = isPlainObject(server.env) ? server.env : {};
  return {
    command: String(server.command || server.cmd || ''),
    args: normalizeArgs(server.args),
    envKeys: Object.keys(env).sort(),
    transport: String(server.transport || server.type || (server.url ? 'http' : 'stdio')),
    url: String(server.url || ''),
    disabled: Boolean(server.disabled),
  };
}

function normalizeMcpImportItem(item = {}, options = {}) {
  if (!isPlainObject(item)) {
    return { skipped: true, action: 'skipped', reason: 'invalid_mcp_server' };
  }
  const targetTool = normalizeTool(options.targetTool);
  const explicitTools = normalizeToolList(item.tools || item.targetTools || item.tool);
  if (targetTool && targetTool !== 'all' && explicitTools.length && !explicitTools.includes(targetTool)) {
    return {
      skipped: true,
      action: 'skipped',
      reason: 'filtered_tool',
      serverId: normalizeServerId(item.id || item.name || item.serverId),
    };
  }

  const id = normalizeServerId(item.id || item.serverId || item.name || item.label);
  if (!id) {
    return { skipped: true, action: 'skipped', reason: 'missing_server_id' };
  }

  const metadataKeys = new Set([
    'id',
    'serverId',
    'name',
    'label',
    'tool',
    'tools',
    'targetTool',
    'targetTools',
    'sourceId',
    'sourceLabel',
    'sourcePath',
    'field',
    'envKeys',
  ]);
  const rawServer = {};
  const base = isPlainObject(item.raw) ? { ...item.raw } : { ...item };
  for (const [key, value] of Object.entries(base)) {
    if (metadataKeys.has(key) || value === undefined) continue;
    rawServer[key] = value;
  }
  if (typeof item.cmd === 'string' && !rawServer.command) rawServer.command = item.cmd;
  if (typeof item.command === 'string') rawServer.command = item.command;
  if (Array.isArray(item.args)) rawServer.args = item.args.map((arg) => String(arg));
  if (isPlainObject(item.env)) rawServer.env = { ...item.env };
  if (typeof item.transport === 'string') rawServer.transport = item.transport;
  if (typeof item.type === 'string' && !rawServer.transport) rawServer.type = item.type;
  if (typeof item.url === 'string') rawServer.url = item.url;
  if (typeof item.disabled === 'boolean') rawServer.disabled = item.disabled;

  const command = String(rawServer.command || rawServer.cmd || '').trim();
  const url = String(rawServer.url || '').trim();
  if (!command && !url) {
    return { skipped: true, action: 'skipped', reason: 'missing_command_or_url', serverId: id };
  }
  if (rawServer.args && !Array.isArray(rawServer.args)) rawServer.args = normalizeArgs(rawServer.args);
  return {
    serverId: id,
    sourceId: String(item.sourceId || item.id || id),
    tools: explicitTools,
    rawServer,
    publicServer: publicMcpServerBlock(rawServer),
  };
}

export function extractMcpImportItems(input = {}, options = {}) {
  const payload = parseAssetImportInput(input);
  const rawServers = mcpEntriesFromPayload(payload);
  const targetTool = options.targetTool || input.targetTool || 'all';
  const servers = [];
  const skipped = [];
  const seen = new Set();
  for (const item of rawServers) {
    const normalized = normalizeMcpImportItem(item, { ...options, targetTool });
    if (normalized.skipped) {
      skipped.push(normalized);
      continue;
    }
    if (seen.has(normalized.serverId)) {
      skipped.push({
        action: 'skipped',
        reason: 'duplicate_server_id',
        serverId: normalized.serverId,
      });
      continue;
    }
    seen.add(normalized.serverId);
    servers.push(normalized);
  }
  return {
    schema: payload.schema || 'unknown',
    app: payload.app || payload.source || '',
    version: payload.version || '',
    totalServers: rawServers.length,
    servers,
    skipped,
  };
}

async function readJsonMcpSource({ tool, label, sourcePath, field }) {
  const raw = await readText(sourcePath);
  const exists = Boolean(raw.trim());
  if (!exists) return sourceResult({ tool, label, sourcePath, exists: false });
  try {
    const parsed = parseJsonLike(raw, label);
    return sourceResult({
      tool,
      label,
      sourcePath,
      exists: true,
      servers: normalizeMcpServers(parsed?.[field], { tool, field }),
    });
  } catch (error) {
    return sourceResult({
      tool,
      label,
      sourcePath,
      exists: true,
      parseError: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readCodexMcpSource(codexHome) {
  const sourcePath = path.join(codexHome || defaultCodexHome(), 'config.toml');
  const raw = await readText(sourcePath);
  const exists = Boolean(raw.trim());
  if (!exists) return sourceResult({ tool: 'codex', label: 'Codex config.toml', sourcePath, exists: false });
  try {
    const parsed = parseToml(raw, 'Codex config.toml');
    const servers = normalizeMcpServers(parsed?.mcp_servers || parsed?.mcpServers, {
      tool: 'codex',
      field: parsed?.mcp_servers ? 'mcp_servers' : 'mcpServers',
    });
    return sourceResult({
      tool: 'codex',
      label: 'Codex config.toml',
      sourcePath,
      exists: true,
      servers,
    });
  } catch (error) {
    return sourceResult({
      tool: 'codex',
      label: 'Codex config.toml',
      sourcePath,
      exists: true,
      parseError: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function listMcpInventory(options = {}) {
  const codexHome = options.codexHome ? path.resolve(String(options.codexHome)) : defaultCodexHome();
  const sources = await Promise.all([
    readCodexMcpSource(codexHome),
    readJsonMcpSource({
      tool: 'claudecode',
      label: 'Claude Code settings.json',
      sourcePath: options.claudeSettingsPath || defaultClaudeSettingsPath(),
      field: 'mcpServers',
    }),
    readJsonMcpSource({
      tool: 'claudedesktop',
      label: 'Claude Desktop config',
      sourcePath: options.claudeDesktopConfigPath || defaultClaudeDesktopConfigPath(),
      field: 'mcpServers',
    }),
    readJsonMcpSource({
      tool: 'opencode',
      label: 'OpenCode opencode.json',
      sourcePath: options.openCodeConfigPath || defaultOpenCodeConfigPath(),
      field: 'mcp',
    }),
    readJsonMcpSource({
      tool: 'gemini',
      label: 'Gemini CLI settings.json',
      sourcePath: options.geminiSettingsPath || defaultGeminiSettingsPath(),
      field: 'mcpServers',
    }),
    readJsonMcpSource({
      tool: 'qwen-code',
      label: 'Qwen Code settings.json',
      sourcePath: options.qwenSettingsPath || defaultQwenSettingsPath(),
      field: 'mcpServers',
    }),
    readJsonMcpSource({
      tool: 'codebuddy-code',
      label: 'CodeBuddy .mcp.json',
      sourcePath: options.codeBuddyMcpPath || defaultCodeBuddyMcpPath(),
      field: 'mcpServers',
    }),
  ]);
  const servers = sources.flatMap((source) => source.servers.map((server) => ({
    ...server,
    sourcePath: source.sourcePath,
    sourceLabel: source.label,
  })));
  return {
    schema: 'easyaiconfig.mcp-inventory.v1',
    generatedAt: new Date().toISOString(),
    sources,
    servers,
    summary: {
      sources: sources.length,
      existingSources: sources.filter((source) => source.exists).length,
      parseErrors: sources.filter((source) => source.parseError).length,
      servers: servers.length,
      tools: Object.fromEntries(sources.map((source) => [source.tool, source.count])),
    },
  };
}

export async function planMcpSync(options = {}) {
  const inventory = await listMcpInventory(options);
  const targetSources = inventory.sources.filter((source) => !source.parseError);
  const byId = new Map();
  for (const server of inventory.servers) {
    if (!byId.has(server.id)) byId.set(server.id, []);
    byId.get(server.id).push(server);
  }

  const operations = [];
  const conflicts = [];
  for (const [serverId, servers] of byId.entries()) {
    const fingerprints = new Map();
    for (const server of servers) {
      const fp = serverFingerprint(server);
      if (!fingerprints.has(fp)) fingerprints.set(fp, []);
      fingerprints.get(fp).push(server);
    }
    if (fingerprints.size > 1) {
      conflicts.push({
        serverId,
        variants: [...fingerprints.values()].map((variantServers) => ({
          fingerprint: serverFingerprint(variantServers[0]),
          sources: variantServers.map(publicServerForPlan),
        })),
      });
      continue;
    }

    const sourceServer = servers[0];
    const presentTools = new Set(servers.map((server) => server.tool));
    for (const target of targetSources) {
      if (presentTools.has(target.tool)) continue;
      operations.push({
        type: 'copy-mcp-server',
        serverId,
        from: publicServerForPlan(sourceServer),
        to: {
          tool: target.tool,
          field: TARGET_FIELDS[target.tool] || 'mcpServers',
          sourcePath: target.sourcePath,
          sourceLabel: target.label,
          exists: target.exists,
          requiresCreate: !target.exists,
        },
        previewOnly: true,
      });
    }
  }

  return {
    schema: 'easyaiconfig.mcp-sync-plan.v1',
    generatedAt: new Date().toISOString(),
    inventory,
    operations,
    conflicts,
    summary: {
      servers: byId.size,
      operations: operations.length,
      conflicts: conflicts.length,
      targets: targetSources.length,
      skippedSources: inventory.sources.filter((source) => source.parseError).length,
    },
  };
}

function publicMcpOperation(operation = {}) {
  const {
    rawServer: _rawServer,
    targetConfig: _targetConfig,
    ...publicOperation
  } = operation;
  return publicOperation;
}

function summarizeMcpOperations(operations = [], totalServers = 0, targetTools = [], written = false) {
  const countAction = (action) => operations.filter((item) => item.action === action).length;
  return {
    totalServers,
    targetTools: targetTools.length,
    created: countAction('created'),
    updated: countAction('updated'),
    unchanged: countAction('unchanged'),
    conflicts: countAction('conflict'),
    skipped: countAction('skipped'),
    changed: operations.some((item) => ['created', 'updated'].includes(item.action)),
    written,
  };
}

function selectedMcpTargetTools(input = {}, options = {}) {
  return normalizeTargetTools(options.targetTool ?? input.targetTool ?? 'codex');
}

async function readMcpWriteSource(tool, options = {}) {
  const source = mcpSourceForTool(tool, options);
  const raw = await readText(source.sourcePath);
  const exists = Boolean(raw.trim());
  if (!exists) {
    return {
      ...source,
      exists: false,
      parseError: '',
      parsed: {},
      field: source.defaultField,
      currentServers: {},
    };
  }
  try {
    const parsed = source.format === 'toml'
      ? parseToml(raw, source.label)
      : parseJsonLike(raw, source.label);
    const field = source.format === 'toml'
      ? (parsed?.mcp_servers ? 'mcp_servers' : parsed?.mcpServers ? 'mcpServers' : source.defaultField)
      : source.defaultField;
    const currentServers = isPlainObject(parsed?.[field]) ? parsed[field] : {};
    return {
      ...source,
      exists: true,
      parseError: '',
      parsed,
      field,
      currentServers,
    };
  } catch (error) {
    return {
      ...source,
      exists: true,
      parseError: error instanceof Error ? error.message : String(error),
      parsed: {},
      field: source.defaultField,
      currentServers: {},
    };
  }
}

function normalizedServerForCompare(server = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(server || {})) {
    if (value === undefined) continue;
    normalized[key] = value;
  }
  return normalized;
}

function sameMcpServerBlock(left = {}, right = {}) {
  return stableStringify(normalizedServerForCompare(left)) === stableStringify(normalizedServerForCompare(right));
}

function publicTargetSummary(target = {}) {
  return {
    tool: target.tool,
    label: target.label,
    sourcePath: target.sourcePath,
    exists: target.exists,
    field: target.field,
    format: target.format,
    parseError: target.parseError,
  };
}

async function buildMcpImportPlan(input = {}, options = {}) {
  const targetTools = selectedMcpTargetTools(input, options);
  const extracted = extractMcpImportItems(input, {
    ...options,
    targetTool: targetTools.length === 1 ? targetTools[0] : 'all',
  });
  const overwrite = Boolean(options.overwrite ?? input.overwrite);
  const targets = [];
  for (const tool of targetTools) {
    targets.push(await readMcpWriteSource(tool, options));
  }

  const operations = extracted.skipped.map(publicMcpOperation);
  for (const target of targets) {
    if (target.parseError) {
      for (const server of extracted.servers) {
        operations.push({
          action: 'skipped',
          reason: 'target_parse_error',
          serverId: server.serverId,
          target: publicTargetSummary(target),
          error: target.parseError,
        });
      }
      continue;
    }

    for (const server of extracted.servers) {
      if (server.tools.length && !server.tools.includes(target.tool)) {
        operations.push({
          action: 'skipped',
          reason: 'filtered_tool',
          serverId: server.serverId,
          sourceId: server.sourceId,
          targetTool: target.tool,
          targetField: target.field,
          targetPath: target.sourcePath,
        });
        continue;
      }
      const existing = target.currentServers?.[server.serverId];
      const base = {
        serverId: server.serverId,
        sourceId: server.sourceId,
        targetTool: target.tool,
        targetField: target.field,
        targetPath: target.sourcePath,
        exists: Boolean(existing),
        server: server.publicServer,
        rawServer: server.rawServer,
      };
      if (existing && sameMcpServerBlock(existing, server.rawServer)) {
        operations.push({ ...base, action: 'unchanged', reason: 'same_server' });
        continue;
      }
      if (existing && !overwrite) {
        operations.push({ ...base, action: 'conflict', reason: 'server_exists' });
        continue;
      }
      operations.push({
        ...base,
        action: existing ? 'updated' : 'created',
        reason: existing ? 'overwrite_enabled' : 'missing_server',
      });
    }
  }

  return {
    schema: 'easyaiconfig.mcp-import-plan.v1',
    generatedAt: new Date().toISOString(),
    overwrite,
    targetTools,
    source: {
      schema: extracted.schema,
      app: extracted.app,
      version: extracted.version,
    },
    targets,
    summary: summarizeMcpOperations(operations, extracted.totalServers, targetTools, false),
    operations,
  };
}

function appHome() {
  return path.join(os.homedir(), '.codex-config-ui');
}

function mcpBackupsRoot(options = {}) {
  if (options.backupsRoot) return path.resolve(String(options.backupsRoot));
  return path.join(appHome(), 'backups');
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeBackupName(value = '') {
  const safe = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'mcp';
}

async function createMcpBackup(writeOperations = [], targets = [], options = {}) {
  const dir = path.join(mcpBackupsRoot(options), `mcp-${backupTimestamp()}-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    schema: 'easyaiconfig.mcp-backup.v1',
    generatedAt: new Date().toISOString(),
    files: [],
  };
  const targetByPath = new Map(targets.map((target) => [target.sourcePath, target]));
  const sourcePaths = Array.from(new Set(writeOperations.map((operation) => operation.targetPath)));
  let index = 0;
  for (const sourcePath of sourcePaths) {
    index += 1;
    const target = targetByPath.get(sourcePath) || {};
    const backupName = `${String(index).padStart(2, '0')}-${safeBackupName(target.tool)}-${path.basename(sourcePath)}.bak`;
    const backupPath = path.join(dir, backupName);
    const existed = Boolean(target.exists);
    if (existed) {
      await fs.copyFile(sourcePath, backupPath);
    }
    manifest.files.push({
      tool: target.tool,
      sourcePath,
      existed,
      backupPath: existed ? backupPath : '',
    });
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return dir;
}

function stringifyMcpConfig(target = {}) {
  if (target.format === 'toml') return TOML.stringify(target.parsed);
  return `${JSON.stringify(target.parsed, null, 2)}\n`;
}

export async function previewMcpImport(input = {}, options = {}) {
  const plan = await buildMcpImportPlan(input, options);
  const { targets: _targets, ...publicPlan } = plan;
  return {
    ...publicPlan,
    schema: 'easyaiconfig.mcp-import-preview.v1',
    dryRun: true,
    targets: plan.targets.map(publicTargetSummary),
    operations: plan.operations.map(publicMcpOperation),
  };
}

export async function applyMcpImport(input = {}, options = {}) {
  const dryRun = options.dryRun ?? input.dryRun ?? true;
  const plan = await buildMcpImportPlan(input, options);
  const writeOperations = plan.operations.filter((item) => ['created', 'updated'].includes(item.action));
  const shouldWrite = dryRun === false && writeOperations.length > 0;
  const backupPath = shouldWrite ? await createMcpBackup(writeOperations, plan.targets, options) : null;

  if (shouldWrite) {
    const targetByPath = new Map(plan.targets.map((target) => [target.sourcePath, target]));
    for (const operation of writeOperations) {
      const target = targetByPath.get(operation.targetPath);
      if (!target) continue;
      if (!isPlainObject(target.parsed[target.field])) target.parsed[target.field] = {};
      target.parsed[target.field][operation.serverId] = operation.rawServer;
    }
    const writtenPaths = new Set();
    for (const operation of writeOperations) {
      if (writtenPaths.has(operation.targetPath)) continue;
      writtenPaths.add(operation.targetPath);
      const target = targetByPath.get(operation.targetPath);
      if (!target) continue;
      await fs.mkdir(path.dirname(target.sourcePath), { recursive: true });
      await fs.writeFile(target.sourcePath, stringifyMcpConfig(target), 'utf8');
    }
  }

  const { targets: _targets, ...publicPlan } = plan;
  return {
    ...publicPlan,
    schema: 'easyaiconfig.mcp-import-apply.v1',
    dryRun: dryRun !== false,
    backupPath,
    targets: plan.targets.map(publicTargetSummary),
    summary: summarizeMcpOperations(plan.operations, plan.summary.totalServers, plan.targetTools, shouldWrite),
    operations: plan.operations.map(publicMcpOperation),
  };
}
