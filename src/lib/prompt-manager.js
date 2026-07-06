import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseAssetImportInput } from './provider-catalog.js';

const PROMPT_SPECS = [
  {
    id: 'codex-agents',
    tool: 'codex',
    fileName: 'AGENTS.md',
    globalPath: () => path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'), 'AGENTS.md'),
  },
  {
    id: 'claude-code',
    tool: 'claudecode',
    fileName: 'CLAUDE.md',
    globalPath: () => path.join(os.homedir(), '.claude', 'CLAUDE.md'),
  },
  {
    id: 'gemini',
    tool: 'gemini',
    fileName: 'GEMINI.md',
    globalPath: () => path.join(os.homedir(), '.gemini', 'GEMINI.md'),
  },
  {
    id: 'qwen-code',
    tool: 'qwen-code',
    fileName: 'QWEN.md',
    globalPath: () => path.join(os.homedir(), '.qwen', 'QWEN.md'),
  },
  {
    id: 'codebuddy-code',
    tool: 'codebuddy-code',
    fileName: 'CODEBUDDY.md',
    globalPath: () => path.join(process.env.CODEBUDDY_CONFIG_DIR?.trim() || path.join(os.homedir(), '.codebuddy'), 'CODEBUDDY.md'),
  },
];

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function firstMarkdownTitle(text) {
  const line = String(text || '').split(/\r?\n/).find((item) => /^#\s+/.test(item.trim()));
  return line ? line.replace(/^#\s+/, '').trim() : '';
}

function compactPreview(text, maxLength = 240) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}...`;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeNewlines(value = '') {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizePromptContent(value = '') {
  const text = normalizeNewlines(value).trim();
  return text ? `${text}\n` : '';
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function normalizeTool(value = '') {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (key === 'claude' || key === 'claudecode' || key === 'claudedesktop') return 'claudecode';
  if (key === 'codex' || key === 'openaicodex') return 'codex';
  if (key === 'gemini' || key === 'geminicli') return 'gemini';
  if (['qwen', 'qwencode', 'qwencli', 'qwencodecli'].includes(key)) return 'qwen-code';
  if (['codebuddy', 'codebuddycode', 'codebuddycli', 'tencentcodebuddy'].includes(key)) return 'codebuddy-code';
  return key;
}

function normalizeScope(value = '') {
  const key = String(value || '').trim().toLowerCase();
  if (['global', 'home', 'user'].includes(key)) return 'global';
  if (['project', 'repo', 'repository', 'workspace', 'local'].includes(key)) return 'project';
  return '';
}

function promptSpecForItem(item = {}) {
  const candidates = [
    item.promptId,
    item.id,
    item.tool,
    item.targetTool,
    item.fileName,
    item.filename,
    item.path ? path.basename(String(item.path)) : '',
  ].map((value) => String(value || '').trim()).filter(Boolean);

  for (const value of candidates) {
    const lower = value.toLowerCase();
    const compact = lower.replace(/[^a-z0-9]+/g, '');
    if (lower === 'agents.md' || compact === 'agentsmd' || compact === 'codexagents' || compact === 'codex') {
      return PROMPT_SPECS.find((spec) => spec.id === 'codex-agents');
    }
    if (lower === 'claude.md' || compact === 'claudemd' || compact === 'claudecode' || compact === 'claude') {
      return PROMPT_SPECS.find((spec) => spec.id === 'claude-code');
    }
    if (lower === 'gemini.md' || compact === 'geminimd' || compact === 'gemini') {
      return PROMPT_SPECS.find((spec) => spec.id === 'gemini');
    }
    if (lower === 'qwen.md' || compact === 'qwenmd' || compact === 'qwencode' || compact === 'qwen') {
      return PROMPT_SPECS.find((spec) => spec.id === 'qwen-code');
    }
    if (lower === 'codebuddy.md' || compact === 'codebuddymd' || compact === 'codebuddycode' || compact === 'codebuddy') {
      return PROMPT_SPECS.find((spec) => spec.id === 'codebuddy-code');
    }
  }
  return null;
}

function promptEntriesFromPayload(payload = {}) {
  const assets = payload.assets && typeof payload.assets === 'object' ? payload.assets : payload;
  const prompts = Array.isArray(assets.prompts)
    ? assets.prompts
    : Array.isArray(payload.prompts)
      ? payload.prompts
      : assets.prompts && typeof assets.prompts === 'object'
        ? Object.entries(assets.prompts).map(([id, value]) => (
            value && typeof value === 'object' && !Array.isArray(value)
              ? { id, ...value }
              : { id, content: String(value ?? '') }
          ))
        : [];
  return prompts;
}

function normalizePromptImportItem(item, options = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { skipped: true, action: 'skipped', reason: 'invalid_prompt' };
  }
  const spec = promptSpecForItem(item);
  if (!spec) {
    return {
      skipped: true,
      action: 'skipped',
      reason: 'unknown_prompt_target',
      sourceId: firstString(item.id, item.promptId, item.fileName, item.tool),
    };
  }

  const targetTool = normalizeTool(options.targetTool);
  if (targetTool && targetTool !== 'all' && normalizeTool(spec.tool) !== targetTool) {
    return {
      skipped: true,
      action: 'skipped',
      reason: 'filtered_tool',
      promptId: spec.id,
      tool: spec.tool,
      sourceId: firstString(item.id, item.promptId, spec.id),
    };
  }

  const explicitTools = normalizeList(item.tools).map(normalizeTool).filter(Boolean);
  if (targetTool && targetTool !== 'all' && explicitTools.length && !explicitTools.includes(targetTool)) {
    return {
      skipped: true,
      action: 'skipped',
      reason: 'filtered_tool',
      promptId: spec.id,
      tool: spec.tool,
      sourceId: firstString(item.id, item.promptId, spec.id),
    };
  }

  const content = normalizePromptContent(firstString(
    item.content,
    item.markdown,
    item.text,
    item.body,
    item.prompt,
  ));
  if (!content) {
    return {
      skipped: true,
      action: 'skipped',
      reason: 'empty_content',
      promptId: spec.id,
      tool: spec.tool,
      sourceId: firstString(item.id, item.promptId, spec.id),
    };
  }

  const defaultScope = normalizeScope(options.scope) || normalizeScope(options.defaultScope) || 'project';
  const scope = normalizeScope(item.scope) || defaultScope;
  if (!scope) {
    return {
      skipped: true,
      action: 'skipped',
      reason: 'invalid_scope',
      promptId: spec.id,
      tool: spec.tool,
      sourceId: firstString(item.id, item.promptId, spec.id),
    };
  }

  return {
    promptId: spec.id,
    tool: spec.tool,
    fileName: spec.fileName,
    scope,
    content,
    mode: firstString(item.mode, options.mode).toLowerCase(),
    title: firstString(item.title, firstMarkdownTitle(content)),
    sourceId: firstString(item.id, item.promptId, spec.id),
    expectedSha256: firstString(
      item.expectedSha256,
      item.expectedCurrentSha256,
      item.currentSha256,
      item.baseSha256,
    ),
  };
}

export function extractPromptImportItems(input = {}, options = {}) {
  const payload = parseAssetImportInput(input);
  const rawPrompts = promptEntriesFromPayload(payload);
  const defaultScope = normalizeScope(options.scope)
    || normalizeScope(input?.scope)
    || (options.projectPath ? 'project' : 'global');
  const prompts = [];
  const skipped = [];
  for (const item of rawPrompts) {
    const normalized = normalizePromptImportItem(item, { ...options, defaultScope });
    if (normalized.skipped) {
      skipped.push(normalized);
    } else {
      prompts.push(normalized);
    }
  }
  return {
    schema: payload.schema || 'unknown',
    app: payload.app || payload.source || '',
    version: payload.version || '',
    totalPrompts: rawPrompts.length,
    prompts,
    skipped,
  };
}

function resolvePromptGlobalPath(spec, options = {}) {
  if (options.globalPaths?.[spec.id]) return path.resolve(String(options.globalPaths[spec.id]));
  if (spec.id === 'codex-agents' && options.codexHome) {
    return path.join(path.resolve(String(options.codexHome)), spec.fileName);
  }
  if (spec.id === 'qwen-code' && options.qwenHome) {
    return path.join(path.resolve(String(options.qwenHome)), spec.fileName);
  }
  if (spec.id === 'codebuddy-code' && options.codeBuddyHome) {
    return path.join(path.resolve(String(options.codeBuddyHome)), spec.fileName);
  }
  return spec.globalPath();
}

function resolvePromptTargetPath(item, options = {}) {
  const spec = PROMPT_SPECS.find((entry) => entry.id === item.promptId);
  if (!spec) throw new Error(`Unknown prompt target: ${item.promptId}`);
  if (item.scope === 'global') return resolvePromptGlobalPath(spec, options);
  if (item.scope === 'project') {
    const projectPath = options.projectPath ? path.resolve(String(options.projectPath)) : '';
    if (!projectPath) throw new Error('projectPath is required for project prompt import');
    return path.join(projectPath, spec.fileName);
  }
  throw new Error(`Invalid prompt scope: ${item.scope}`);
}

async function readTargetFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { exists: true, raw: '', invalid: true, reason: 'target_is_not_file' };
    return { exists: true, raw: await fs.readFile(filePath, 'utf8'), invalid: false, reason: '' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, raw: '', invalid: false, reason: '' };
    throw error;
  }
}

function expectedShaForItem(item, targetPath, currentSha256, options = {}) {
  const maps = [
    options.expectedSha256ByPath,
    options.expectedSha256ById,
    options.expectedSha256ByTarget,
  ].filter((value) => value && typeof value === 'object');
  const keys = [
    targetPath,
    item.promptId,
    `${item.promptId}:${item.scope}`,
    item.sourceId,
  ];
  for (const map of maps) {
    for (const key of keys) {
      if (typeof map[key] === 'string' && map[key].trim()) return map[key].trim();
    }
  }
  return item.expectedSha256 || options.expectedSha256 || (options.requireExpectedSha256 ? currentSha256 : '');
}

function appendPromptContent(currentRaw = '', incomingContent = '') {
  const base = normalizeNewlines(currentRaw).replace(/\s+$/g, '');
  const incoming = normalizePromptContent(incomingContent).trim();
  if (!base) return `${incoming}\n`;
  return `${base}\n\n${incoming}\n`;
}

function promptContentAlreadyIncluded(currentRaw = '', incomingContent = '') {
  const current = normalizeNewlines(currentRaw).trim();
  const incoming = normalizePromptContent(incomingContent).trim();
  return Boolean(current && incoming && current.includes(incoming));
}

function privateOperationToPublic(operation = {}) {
  const { nextContent: _nextContent, ...publicOperation } = operation;
  return publicOperation;
}

function summarizeOperations(operations = [], totalPrompts = 0, writableCount = 0, written = false) {
  const countAction = (action) => operations.filter((item) => item.action === action).length;
  return {
    totalPrompts,
    created: countAction('created'),
    updated: countAction('updated'),
    appended: countAction('appended'),
    unchanged: countAction('unchanged'),
    conflicts: countAction('conflict'),
    stale: countAction('stale'),
    skipped: countAction('skipped'),
    changed: writableCount > 0,
    written,
  };
}

async function buildPromptImportPlan(input = {}, options = {}) {
  const planOptions = {
    ...options,
    expectedSha256: options.expectedSha256 ?? input.expectedSha256,
    expectedSha256ByPath: options.expectedSha256ByPath ?? input.expectedSha256ByPath,
    expectedSha256ById: options.expectedSha256ById ?? input.expectedSha256ById,
    expectedSha256ByTarget: options.expectedSha256ByTarget ?? input.expectedSha256ByTarget,
    requireExpectedSha256: options.requireExpectedSha256 ?? input.requireExpectedSha256,
  };
  const extracted = extractPromptImportItems(input, planOptions);
  const overwrite = Boolean(options.overwrite ?? input.overwrite);
  const append = Boolean(options.append ?? input.append);
  const operations = extracted.skipped.map((item) => privateOperationToPublic(item));
  const seenTargets = new Set();

  for (const item of extracted.prompts) {
    let targetPath = '';
    try {
      targetPath = resolvePromptTargetPath(item, planOptions);
    } catch (error) {
      operations.push({
        action: 'skipped',
        reason: 'invalid_target',
        promptId: item.promptId,
        tool: item.tool,
        scope: item.scope,
        fileName: item.fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const targetKey = path.resolve(targetPath);
    if (seenTargets.has(targetKey)) {
      operations.push({
        action: 'skipped',
        reason: 'duplicate_target',
        promptId: item.promptId,
        tool: item.tool,
        scope: item.scope,
        targetPath,
      });
      continue;
    }
    seenTargets.add(targetKey);

    const target = await readTargetFile(targetPath);
    if (target.invalid) {
      operations.push({
        action: 'skipped',
        reason: target.reason,
        promptId: item.promptId,
        tool: item.tool,
        scope: item.scope,
        fileName: item.fileName,
        targetPath,
      });
      continue;
    }

    const currentSha256 = target.exists ? sha256(target.raw) : '';
    const incomingSha256 = sha256(item.content);
    const expectedSha256 = expectedShaForItem(item, targetPath, currentSha256, planOptions);
    const effectiveAppend = item.mode === 'append' || append;
    const effectiveOverwrite = item.mode === 'overwrite' || overwrite;
    const base = {
      promptId: item.promptId,
      tool: item.tool,
      scope: item.scope,
      fileName: item.fileName,
      title: item.title,
      sourceId: item.sourceId,
      targetPath,
      exists: target.exists,
      currentSha256,
      incomingSha256,
      expectedSha256,
      incomingPreview: compactPreview(item.content),
    };

    if (target.exists && currentSha256 === incomingSha256) {
      operations.push({ ...base, action: 'unchanged', reason: 'same_content' });
      continue;
    }

    if (target.exists && effectiveAppend && promptContentAlreadyIncluded(target.raw, item.content)) {
      operations.push({ ...base, action: 'unchanged', reason: 'already_contains_content' });
      continue;
    }

    if (target.exists && expectedSha256 && expectedSha256 !== currentSha256) {
      operations.push({ ...base, action: 'stale', reason: 'backfill_protection' });
      continue;
    }

    if (!target.exists) {
      operations.push({ ...base, action: 'created', reason: 'missing_target', nextContent: item.content });
      continue;
    }

    if (effectiveAppend) {
      operations.push({
        ...base,
        action: 'appended',
        reason: 'append_enabled',
        nextContent: appendPromptContent(target.raw, item.content),
      });
      continue;
    }

    if (effectiveOverwrite) {
      operations.push({ ...base, action: 'updated', reason: 'overwrite_enabled', nextContent: item.content });
      continue;
    }

    operations.push({ ...base, action: 'conflict', reason: 'target_exists' });
  }

  const writableCount = operations.filter((item) => ['created', 'updated', 'appended'].includes(item.action)).length;
  return {
    schema: 'easyaiconfig.prompt-import-plan.v1',
    generatedAt: new Date().toISOString(),
    overwrite,
    append,
    source: {
      schema: extracted.schema,
      app: extracted.app,
      version: extracted.version,
    },
    summary: summarizeOperations(operations, extracted.totalPrompts, writableCount, false),
    operations,
  };
}

function appHome() {
  return path.join(os.homedir(), '.codex-config-ui');
}

function promptBackupsRoot(options = {}) {
  if (options.backupsRoot) return path.resolve(String(options.backupsRoot));
  return path.join(appHome(), 'backups');
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeBackupName(value = '') {
  const safe = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'prompt';
}

async function createPromptBackup(operations = [], options = {}) {
  const dir = path.join(promptBackupsRoot(options), `prompts-${backupTimestamp()}-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    schema: 'easyaiconfig.prompt-backup.v1',
    generatedAt: new Date().toISOString(),
    files: [],
  };

  let index = 0;
  for (const operation of operations) {
    index += 1;
    const backupName = `${String(index).padStart(2, '0')}-${safeBackupName(operation.promptId)}-${operation.scope}-${operation.fileName}.bak`;
    const backupPath = path.join(dir, backupName);
    const entry = {
      promptId: operation.promptId,
      tool: operation.tool,
      scope: operation.scope,
      targetPath: operation.targetPath,
      existed: operation.exists,
      currentSha256: operation.currentSha256,
      backupPath: operation.exists ? backupPath : '',
    };
    if (operation.exists) {
      await fs.copyFile(operation.targetPath, backupPath);
    }
    manifest.files.push(entry);
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return dir;
}

export async function previewPromptImport(input = {}, options = {}) {
  const plan = await buildPromptImportPlan(input, options);
  return {
    ...plan,
    schema: 'easyaiconfig.prompt-import-preview.v1',
    dryRun: true,
    operations: plan.operations.map(privateOperationToPublic),
  };
}

export async function applyPromptImport(input = {}, options = {}) {
  const dryRun = options.dryRun ?? input.dryRun ?? true;
  const plan = await buildPromptImportPlan(input, options);
  const writeOperations = plan.operations.filter((item) => ['created', 'updated', 'appended'].includes(item.action));
  const shouldWrite = dryRun === false && writeOperations.length > 0;
  const backupPath = shouldWrite ? await createPromptBackup(writeOperations, options) : null;
  if (shouldWrite) {
    for (const operation of writeOperations) {
      await fs.mkdir(path.dirname(operation.targetPath), { recursive: true });
      await fs.writeFile(operation.targetPath, operation.nextContent, 'utf8');
    }
  }
  return {
    ...plan,
    schema: 'easyaiconfig.prompt-import-apply.v1',
    dryRun: dryRun !== false,
    backupPath,
    summary: summarizeOperations(
      plan.operations,
      plan.summary.totalPrompts,
      writeOperations.length,
      shouldWrite,
    ),
    operations: plan.operations.map(privateOperationToPublic),
  };
}

async function promptFileSummary({ id, tool, scope, sourcePath }) {
  const raw = await readText(sourcePath);
  const exists = Boolean(raw);
  return {
    id: `${id}:${scope}`,
    promptId: id,
    tool,
    scope,
    sourcePath,
    exists,
    bytes: Buffer.byteLength(raw, 'utf8'),
    lineCount: raw ? raw.split(/\r?\n/).length : 0,
    sha256: raw ? sha256(raw) : '',
    title: firstMarkdownTitle(raw),
    preview: compactPreview(raw),
  };
}

export async function listPromptInventory(options = {}) {
  const projectPath = options.projectPath ? path.resolve(String(options.projectPath)) : '';
  const specs = options.specs || PROMPT_SPECS;
  const files = [];
  for (const spec of specs) {
    const globalPath = resolvePromptGlobalPath(spec, options);
    files.push(await promptFileSummary({
      id: spec.id,
      tool: spec.tool,
      scope: 'global',
      sourcePath: globalPath,
    }));
    if (projectPath) {
      files.push(await promptFileSummary({
        id: spec.id,
        tool: spec.tool,
        scope: 'project',
        sourcePath: path.join(projectPath, spec.fileName),
      }));
    }
  }
  const existing = files.filter((file) => file.exists);
  return {
    schema: 'easyaiconfig.prompt-inventory.v1',
    generatedAt: new Date().toISOString(),
    projectPath,
    files,
    summary: {
      files: files.length,
      existing: existing.length,
      projectFiles: existing.filter((file) => file.scope === 'project').length,
      globalFiles: existing.filter((file) => file.scope === 'global').length,
      tools: Object.fromEntries(PROMPT_SPECS.map((spec) => [
        spec.tool,
        existing.filter((file) => file.tool === spec.tool).length,
      ])),
    },
  };
}
