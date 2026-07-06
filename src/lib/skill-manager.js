import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseAssetImportInput } from './provider-catalog.js';

function defaultCodexHome() {
  return process.env.CODEX_HOME?.trim()
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function defaultCodeBuddyHome() {
  const configured = process.env.CODEBUDDY_CONFIG_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codebuddy');
}

function defaultSkillSources(options = {}) {
  return [
    { id: 'codex-user', tool: 'codex', label: 'Codex user skills', rootPath: path.join(defaultCodexHome(), 'skills') },
    { id: 'claude-user', tool: 'claudecode', label: 'Claude user skills', rootPath: path.join(os.homedir(), '.claude', 'skills') },
    { id: 'codebuddy-user', tool: 'codebuddy-code', label: 'CodeBuddy user skills', rootPath: options.codeBuddySkillsRoot ? path.resolve(String(options.codeBuddySkillsRoot)) : path.join(defaultCodeBuddyHome(), 'skills') },
    { id: 'easyai-user', tool: 'easyai', label: 'EasyAIConfig user skills', rootPath: path.join(os.homedir(), '.codex-config-ui', 'skills') },
  ];
}

const SKILL_TARGET_TOOLS = ['codex', 'claudecode', 'codebuddy-code', 'easyai'];

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTool(value = '') {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (key === 'claude' || key === 'claudecode') return 'claudecode';
  if (key === 'codex' || key === 'openaicodex') return 'codex';
  if (['codebuddy', 'codebuddycode', 'codebuddycli', 'tencentcodebuddy'].includes(key)) return 'codebuddy-code';
  if (key === 'easyai' || key === 'easyaiconfig') return 'easyai';
  return key;
}

function normalizeTargetTools(value = 'codex') {
  const raw = Array.isArray(value)
    ? value
    : String(value || 'codex').split(',');
  const normalized = raw.map(normalizeTool).filter(Boolean);
  if (!normalized.length) return ['codex'];
  if (normalized.includes('all')) return [...SKILL_TARGET_TOOLS];
  return Array.from(new Set(normalized.filter((tool) => SKILL_TARGET_TOOLS.includes(tool))));
}

function normalizeToolList(value) {
  if (Array.isArray(value)) return value.map(normalizeTool).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [normalizeTool(value)];
  return [];
}

function normalizeSkillName(value = '') {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalizeInstallMode(value = '') {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (['symlink', 'link'].includes(key)) return 'symlink';
  if (['copy', 'file-copy', 'file', 'files'].includes(key)) return 'copy';
  return 'copy';
}

function skillRootForTool(tool, options = {}) {
  if (tool === 'codex') {
    const codexHome = options.codexHome ? path.resolve(String(options.codexHome)) : defaultCodexHome();
    return options.codexSkillsRoot ? path.resolve(String(options.codexSkillsRoot)) : path.join(codexHome, 'skills');
  }
  if (tool === 'claudecode') {
    return options.claudeSkillsRoot
      ? path.resolve(String(options.claudeSkillsRoot))
      : path.join(os.homedir(), '.claude', 'skills');
  }
  if (tool === 'codebuddy-code') {
    return options.codeBuddySkillsRoot
      ? path.resolve(String(options.codeBuddySkillsRoot))
      : path.join(defaultCodeBuddyHome(), 'skills');
  }
  if (tool === 'easyai') {
    return options.easyaiSkillsRoot
      ? path.resolve(String(options.easyaiSkillsRoot))
      : path.join(os.homedir(), '.codex-config-ui', 'skills');
  }
  throw new Error(`Unsupported skill target tool: ${tool}`);
}

function allowedSourceRoots(options = {}) {
  const roots = [
    os.homedir(),
    process.cwd(),
    os.tmpdir(),
    '/tmp',
    '/var/tmp',
    ...(Array.isArray(options.allowedSourceRoots) ? options.allowedSourceRoots : []),
  ].filter(Boolean);
  return roots.map((root) => path.resolve(String(root)));
}

function isPathWithinRoots(filePath, roots = []) {
  const resolved = path.resolve(String(filePath || ''));
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function readDirEntries(rootPath) {
  try {
    return await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function firstTitle(markdown = '', fallback = '') {
  const line = String(markdown || '').split(/\r?\n/).find((item) => /^#\s+/.test(item.trim()));
  return line ? line.replace(/^#\s+/, '').trim() : fallback;
}

function firstParagraph(markdown = '') {
  const lines = String(markdown || '').split(/\r?\n/);
  const buffer = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) {
      if (buffer.length) break;
      continue;
    }
    buffer.push(trimmed);
    if (buffer.join(' ').length > 240) break;
  }
  const text = buffer.join(' ').trim();
  return text.length > 240 ? `${text.slice(0, 237).trim()}...` : text;
}

async function findSkillDoc(skillPath) {
  const candidates = ['SKILL.md', 'skill.md', 'README.md', 'readme.md'];
  for (const fileName of candidates) {
    const docPath = path.join(skillPath, fileName);
    const raw = await readText(docPath);
    if (raw) return { docPath, raw };
  }
  return { docPath: '', raw: '' };
}

async function readSkillEntry({ source, entry }) {
  const skillPath = path.join(source.rootPath, entry.name);
  const { docPath, raw } = await findSkillDoc(skillPath);
  return {
    id: `${source.id}:${entry.name}`,
    name: entry.name,
    tool: source.tool,
    sourceId: source.id,
    sourceLabel: source.label,
    rootPath: source.rootPath,
    skillPath,
    docPath,
    hasDoc: Boolean(raw),
    title: firstTitle(raw, entry.name),
    description: firstParagraph(raw),
    bytes: Buffer.byteLength(raw, 'utf8'),
    sha256: raw ? sha256(raw) : '',
  };
}

async function readSkillSource(source) {
  const entries = await readDirEntries(source.rootPath);
  const dirs = entries.filter((entry) => entry.isDirectory());
  const skills = [];
  for (const entry of dirs) {
    skills.push(await readSkillEntry({ source, entry }));
  }
  return {
    id: source.id,
    tool: source.tool,
    label: source.label,
    rootPath: source.rootPath,
    exists: entries.length > 0,
    count: skills.length,
    skills,
  };
}

export async function listSkillInventory(options = {}) {
  const sources = options.sources || defaultSkillSources(options);
  const normalizedSources = sources.map((source) => ({
    ...source,
    rootPath: path.resolve(String(source.rootPath || '')),
  }));
  const results = [];
  for (const source of normalizedSources) {
    results.push(await readSkillSource(source));
  }
  const skills = results.flatMap((source) => source.skills);
  return {
    schema: 'easyaiconfig.skill-inventory.v1',
    generatedAt: new Date().toISOString(),
    sources: results,
    skills,
    summary: {
      sources: results.length,
      existingSources: results.filter((source) => source.exists).length,
      skills: skills.length,
      documented: skills.filter((skill) => skill.hasDoc).length,
      tools: Object.fromEntries(results.map((source) => [source.tool, source.count])),
    },
  };
}

function skillEntriesFromPayload(payload = {}) {
  const assets = payload.assets && typeof payload.assets === 'object' ? payload.assets : payload;
  const skills = Array.isArray(assets.skills)
    ? assets.skills
    : Array.isArray(payload.skills)
      ? payload.skills
      : isPlainObject(assets.skills)
        ? Object.entries(assets.skills).map(([id, value]) => (
            isPlainObject(value) ? { id, ...value } : { id, content: String(value ?? '') }
          ))
        : [];
  return skills;
}

function normalizeRelativeSkillPath(value = '') {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || raw.includes('\0')) return '';
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') return '';
  return normalized;
}

function normalizeInlineFiles(item = {}) {
  const files = [];
  const addFile = (filePath, content) => {
    const normalizedPath = normalizeRelativeSkillPath(filePath);
    if (!normalizedPath) return;
    files.push({
      path: normalizedPath,
      content: String(content ?? ''),
    });
  };

  if (Array.isArray(item.files)) {
    for (const file of item.files) {
      if (isPlainObject(file)) addFile(file.path || file.fileName || file.name, file.content ?? file.text ?? '');
    }
  } else if (isPlainObject(item.files)) {
    for (const [filePath, content] of Object.entries(item.files)) addFile(filePath, content);
  }

  const skillMarkdown = item.skillMd ?? item.skillMD ?? item.markdown ?? item.content ?? item.text;
  if (typeof skillMarkdown === 'string' && skillMarkdown.trim() && !files.some((file) => /^skill\.md$/i.test(file.path))) {
    addFile('SKILL.md', skillMarkdown);
  }

  const seen = new Set();
  return files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

function normalizeSkillImportItem(item = {}, options = {}) {
  if (!isPlainObject(item)) {
    return { skipped: true, action: 'skipped', reason: 'invalid_skill' };
  }
  const targetTool = normalizeTool(options.targetTool);
  const explicitTools = normalizeToolList(item.tools || item.targetTools || item.tool);
  if (targetTool && targetTool !== 'all' && explicitTools.length && !explicitTools.includes(targetTool)) {
    return {
      skipped: true,
      action: 'skipped',
      reason: 'filtered_tool',
      skillName: normalizeSkillName(item.name || item.id),
    };
  }

  const name = normalizeSkillName(item.name || item.id || item.slug || item.title);
  if (!name) return { skipped: true, action: 'skipped', reason: 'missing_skill_name' };

  const files = normalizeInlineFiles(item);
  const sourcePath = item.sourcePath || item.localPath || item.path
    ? path.resolve(String(item.sourcePath || item.localPath || item.path))
    : '';
  const repoUrl = String(item.repositoryUrl || item.repoUrl || item.github || item.repository || '').trim();
  const zipUrl = String(item.zipUrl || item.archiveUrl || item.url || '').trim();
  const installMode = normalizeInstallMode(options.installMode || item.installMode || item.mode);

  if (!files.length && !sourcePath) {
    return {
      skipped: true,
      action: 'skipped',
      reason: repoUrl || zipUrl ? 'external_source_requires_installer' : 'empty_skill',
      skillName: name,
      sourceType: repoUrl ? 'github' : zipUrl ? 'zip' : 'unknown',
      sourceUrl: repoUrl || zipUrl,
    };
  }

  if (sourcePath && !isPathWithinRoots(sourcePath, allowedSourceRoots(options))) {
    return {
      skipped: true,
      action: 'skipped',
      reason: 'source_path_not_allowed',
      skillName: name,
      sourcePath,
    };
  }

  return {
    skillName: name,
    title: String(item.title || name).trim(),
    sourceId: String(item.id || item.name || name),
    tools: explicitTools,
    installMode,
    sourcePath,
    files,
    sourceType: sourcePath ? 'local' : 'inline',
  };
}

export function extractSkillImportItems(input = {}, options = {}) {
  const payload = parseAssetImportInput(input);
  const rawSkills = skillEntriesFromPayload(payload);
  const targetTool = options.targetTool || input.targetTool || 'all';
  const skills = [];
  const skipped = [];
  const seen = new Set();
  for (const item of rawSkills) {
    const normalized = normalizeSkillImportItem(item, { ...options, targetTool });
    if (normalized.skipped) {
      skipped.push(normalized);
      continue;
    }
    if (seen.has(normalized.skillName)) {
      skipped.push({
        action: 'skipped',
        reason: 'duplicate_skill_name',
        skillName: normalized.skillName,
      });
      continue;
    }
    seen.add(normalized.skillName);
    skills.push(normalized);
  }
  return {
    schema: payload.schema || 'unknown',
    app: payload.app || payload.source || '',
    version: payload.version || '',
    totalSkills: rawSkills.length,
    skills,
    skipped,
  };
}

async function pathEntryState(targetPath) {
  try {
    const stat = await fs.lstat(targetPath);
    return {
      exists: true,
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
      linkTarget: stat.isSymbolicLink() ? await fs.readlink(targetPath) : '',
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, isDirectory: false, isSymbolicLink: false, linkTarget: '' };
    }
    throw error;
  }
}

async function inlineFilesAlreadyMatch(targetPath, files = []) {
  for (const file of files) {
    const absolutePath = path.join(targetPath, file.path);
    const raw = await readText(absolutePath);
    if (raw !== file.content) return false;
  }
  return files.length > 0;
}

async function localSourceDocSha(sourcePath) {
  const { raw } = await findSkillDoc(sourcePath);
  return raw ? sha256(raw) : '';
}

async function targetDocSha(targetPath) {
  const { raw } = await findSkillDoc(targetPath);
  return raw ? sha256(raw) : '';
}

function publicSkillOperation(operation = {}) {
  const {
    files: _files,
    ...publicOperation
  } = operation;
  return publicOperation;
}

function summarizeSkillOperations(operations = [], totalSkills = 0, targetTools = [], written = false) {
  const countAction = (action) => operations.filter((item) => item.action === action).length;
  return {
    totalSkills,
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

function selectedSkillTargetTools(input = {}, options = {}) {
  return normalizeTargetTools(options.targetTool ?? input.targetTool ?? 'codex');
}

function publicSkillTarget(tool, rootPath) {
  return { tool, rootPath };
}

async function buildSkillImportPlan(input = {}, options = {}) {
  const targetTools = selectedSkillTargetTools(input, options);
  const extracted = extractSkillImportItems(input, {
    ...options,
    targetTool: targetTools.length === 1 ? targetTools[0] : 'all',
  });
  const overwrite = Boolean(options.overwrite ?? input.overwrite);
  const installMode = normalizeInstallMode(options.installMode || input.installMode || input.mode);
  const targets = targetTools.map((tool) => ({
    tool,
    rootPath: skillRootForTool(tool, options),
  }));

  const operations = extracted.skipped.map(publicSkillOperation);
  for (const target of targets) {
    for (const skill of extracted.skills) {
      if (skill.tools.length && !skill.tools.includes(target.tool)) {
        operations.push({
          action: 'skipped',
          reason: 'filtered_tool',
          skillName: skill.skillName,
          sourceId: skill.sourceId,
          targetTool: target.tool,
          targetRootPath: target.rootPath,
        });
        continue;
      }
      if (skill.sourcePath) {
        const sourceState = await pathEntryState(skill.sourcePath);
        if (!sourceState.exists || !sourceState.isDirectory) {
          operations.push({
            action: 'skipped',
            reason: sourceState.exists ? 'source_not_directory' : 'source_missing',
            skillName: skill.skillName,
            sourceId: skill.sourceId,
            sourcePath: skill.sourcePath,
            targetTool: target.tool,
            targetRootPath: target.rootPath,
          });
          continue;
        }
      }
      const targetPath = path.join(target.rootPath, skill.skillName);
      const state = await pathEntryState(targetPath);
      const effectiveMode = skill.installMode || installMode;
      const fileCount = skill.sourcePath ? 0 : skill.files.length;
      const base = {
        skillName: skill.skillName,
        title: skill.title,
        sourceId: skill.sourceId,
        sourceType: skill.sourceType,
        sourcePath: skill.sourcePath,
        targetTool: target.tool,
        targetRootPath: target.rootPath,
        targetPath,
        installMode: effectiveMode,
        exists: state.exists,
        fileCount,
        files: skill.files,
      };

      if (state.exists) {
        if (effectiveMode === 'symlink' && skill.sourcePath && state.isSymbolicLink && path.resolve(state.linkTarget) === path.resolve(skill.sourcePath)) {
          operations.push({ ...base, action: 'unchanged', reason: 'same_symlink' });
          continue;
        }
        if (!skill.sourcePath && await inlineFilesAlreadyMatch(targetPath, skill.files)) {
          operations.push({ ...base, action: 'unchanged', reason: 'same_files' });
          continue;
        }
        if (skill.sourcePath && effectiveMode === 'copy') {
          const [sourceSha, existingSha] = await Promise.all([
            localSourceDocSha(skill.sourcePath),
            targetDocSha(targetPath),
          ]);
          if (sourceSha && sourceSha === existingSha) {
            operations.push({ ...base, action: 'unchanged', reason: 'same_skill_doc' });
            continue;
          }
        }
        if (!overwrite) {
          operations.push({ ...base, action: 'conflict', reason: 'skill_exists' });
          continue;
        }
        operations.push({ ...base, action: 'updated', reason: 'overwrite_enabled' });
        continue;
      }

      operations.push({ ...base, action: 'created', reason: 'missing_skill' });
    }
  }

  return {
    schema: 'easyaiconfig.skill-import-plan.v1',
    generatedAt: new Date().toISOString(),
    overwrite,
    installMode,
    targetTools,
    source: {
      schema: extracted.schema,
      app: extracted.app,
      version: extracted.version,
    },
    targets,
    summary: summarizeSkillOperations(operations, extracted.totalSkills, targetTools, false),
    operations,
  };
}

function appHome() {
  return path.join(os.homedir(), '.codex-config-ui');
}

function skillBackupsRoot(options = {}) {
  if (options.backupsRoot) return path.resolve(String(options.backupsRoot));
  return path.join(appHome(), 'backups');
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeBackupName(value = '') {
  const safe = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'skill';
}

async function createSkillBackup(writeOperations = [], options = {}) {
  const dir = path.join(skillBackupsRoot(options), `skills-${backupTimestamp()}-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    schema: 'easyaiconfig.skill-backup.v1',
    generatedAt: new Date().toISOString(),
    skills: [],
  };
  let index = 0;
  for (const operation of writeOperations) {
    index += 1;
    const state = await pathEntryState(operation.targetPath);
    const backupPath = path.join(
      dir,
      `${String(index).padStart(2, '0')}-${safeBackupName(operation.targetTool)}-${safeBackupName(operation.skillName)}`,
    );
    const entry = {
      skillName: operation.skillName,
      targetTool: operation.targetTool,
      targetPath: operation.targetPath,
      existed: state.exists,
      backupPath: state.exists ? backupPath : '',
      symlinkTarget: state.linkTarget,
    };
    if (state.exists && state.isSymbolicLink) {
      await fs.writeFile(`${backupPath}.symlink.txt`, state.linkTarget, 'utf8');
      entry.backupPath = `${backupPath}.symlink.txt`;
    } else if (state.exists) {
      await fs.cp(operation.targetPath, backupPath, { recursive: true, force: true });
    }
    manifest.skills.push(entry);
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return dir;
}

async function writeInlineSkillFiles(targetPath, files = []) {
  for (const file of files) {
    const absolutePath = path.join(targetPath, file.path);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, file.content, 'utf8');
  }
}

async function writeSkillOperation(operation = {}) {
  await fs.mkdir(path.dirname(operation.targetPath), { recursive: true });
  if (operation.exists) await fs.rm(operation.targetPath, { recursive: true, force: true });
  if (operation.sourcePath && operation.installMode === 'symlink') {
    await fs.symlink(operation.sourcePath, operation.targetPath, 'dir');
    return;
  }
  if (operation.sourcePath) {
    await fs.cp(operation.sourcePath, operation.targetPath, { recursive: true, force: true });
    return;
  }
  await writeInlineSkillFiles(operation.targetPath, operation.files);
}

export async function previewSkillImport(input = {}, options = {}) {
  const plan = await buildSkillImportPlan(input, options);
  const { targets: _targets, ...publicPlan } = plan;
  return {
    ...publicPlan,
    schema: 'easyaiconfig.skill-import-preview.v1',
    dryRun: true,
    targets: plan.targets.map((target) => publicSkillTarget(target.tool, target.rootPath)),
    operations: plan.operations.map(publicSkillOperation),
  };
}

export async function applySkillImport(input = {}, options = {}) {
  const dryRun = options.dryRun ?? input.dryRun ?? true;
  const plan = await buildSkillImportPlan(input, options);
  const writeOperations = plan.operations.filter((item) => ['created', 'updated'].includes(item.action));
  const shouldWrite = dryRun === false && writeOperations.length > 0;
  const backupPath = shouldWrite ? await createSkillBackup(writeOperations, options) : null;
  if (shouldWrite) {
    for (const operation of writeOperations) {
      await writeSkillOperation(operation);
    }
  }

  const { targets: _targets, ...publicPlan } = plan;
  return {
    ...publicPlan,
    schema: 'easyaiconfig.skill-import-apply.v1',
    dryRun: dryRun !== false,
    backupPath,
    targets: plan.targets.map((target) => publicSkillTarget(target.tool, target.rootPath)),
    summary: summarizeSkillOperations(plan.operations, plan.summary.totalSkills, plan.targetTools, shouldWrite),
    operations: plan.operations.map(publicSkillOperation),
  };
}
