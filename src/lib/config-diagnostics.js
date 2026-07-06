import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_CONFIG_ROOT_FILES = new Set([
  'CLAUDE.md',
  'claude.json',
  '.clauderc',
  'settings.json',
  'settings.local.json',
  'mcp_servers.json',
]);

const CLAUDE_CONFIG_DIRS = new Set([
  'agents',
  'commands',
  'hooks',
  'plugins',
  'skills',
]);

const CLAUDE_EXCLUDED_DIRS = new Set([
  '.git',
  'cache',
  'caches',
  'logs',
  'node_modules',
  'projects',
  'shell-snapshots',
  'statsig',
  'temp',
  'tmp',
]);

const CONFIG_EXTENSIONS = new Set([
  '.json',
  '.jsonc',
  '.md',
  '.mjs',
  '.js',
  '.sh',
  '.toml',
  '.txt',
  '.yaml',
  '.yml',
]);

function defaultClaudeHome() {
  return path.join(os.homedir(), '.claude');
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function estimatedTokens(bytes = 0) {
  return Math.round(Math.max(0, Number(bytes) || 0) / 4);
}

function configKind(relativePath = '') {
  const parts = String(relativePath || '').split(/[\\/]/).filter(Boolean);
  if (!parts.length) return 'config';
  if (parts.length === 1) return 'root';
  const first = parts[0].toLowerCase();
  if (first === 'commands') return 'command';
  if (first === 'agents') return 'agent';
  if (first === 'hooks') return 'hook';
  if (first === 'skills') return 'skill';
  if (first === 'plugins') return 'plugin';
  return 'config';
}

function shouldIncludeClaudeConfigFile(rootDir, filePath) {
  const relativePath = path.relative(rootDir, filePath);
  if (!relativePath || relativePath.startsWith('..')) return false;
  const parts = relativePath.split(path.sep).filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((part) => CLAUDE_EXCLUDED_DIRS.has(part.toLowerCase()))) return false;

  const fileName = parts[parts.length - 1];
  const ext = path.extname(fileName).toLowerCase();
  if (parts.length === 1) {
    return CLAUDE_CONFIG_ROOT_FILES.has(fileName) || CONFIG_EXTENSIONS.has(ext);
  }

  return CLAUDE_CONFIG_DIRS.has(parts[0].toLowerCase()) && CONFIG_EXTENSIONS.has(ext);
}

async function collectClaudeConfigFiles(rootDir, { maxFiles = 600 } = {}) {
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
        if (!CLAUDE_EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
          await walk(fullPath);
        }
        continue;
      }
      if (!entry.isFile() || !shouldIncludeClaudeConfigFile(rootDir, fullPath)) continue;
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat?.isFile()) continue;
      const relativePath = path.relative(rootDir, fullPath);
      files.push({
        path: fullPath,
        relativePath,
        kind: configKind(relativePath),
        bytes: Number(stat.size || 0),
        estimatedTokens: estimatedTokens(stat.size),
        modifiedAt: stat.mtime ? stat.mtime.toISOString() : '',
      });
    }
  }

  await walk(rootDir);
  return files.sort((left, right) => Number(right.bytes || 0) - Number(left.bytes || 0));
}

function buildWarnings({ fileCount = 0, totalBytes = 0, largestFile = null } = {}) {
  const warnings = [];
  const tokens = estimatedTokens(totalBytes);
  if (tokens > 10000) {
    warnings.push('配置上下文估算超过 10k tokens，建议拆分项目配置或清理大文件。');
  }
  if (largestFile?.bytes > 50000) {
    warnings.push(`最大配置文件 ${largestFile.relativePath} 超过 50 KB，建议拆分或移出 Claude 配置目录。`);
  }
  if (fileCount > 100) {
    warnings.push(`配置文件数量 ${fileCount} 个，建议按项目或角色分组管理。`);
  }
  return warnings;
}

export async function listConfigDiagnostics(options = {}) {
  const claudeHome = path.resolve(String(options.claudeHome || defaultClaudeHome()));
  const exists = await pathExists(claudeHome);
  let files = [];
  let readError = '';

  if (exists) {
    try {
      files = await collectClaudeConfigFiles(claudeHome, {
        maxFiles: Math.max(50, Math.min(1000, Number(options.maxFiles || 600))),
      });
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
  }

  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  const largestFile = files[0] || null;
  const warnings = buildWarnings({ fileCount: files.length, totalBytes, largestFile });
  if (readError) warnings.unshift(readError);

  const claude = {
    tool: 'claudecode',
    label: 'Claude Code config estimate',
    sourcePath: claudeHome,
    exists,
    ok: exists && !readError,
    method: 'size-estimate',
    scope: 'configuration-files',
    actualUsage: false,
    fileCount: files.length,
    totalBytes,
    estimatedTokens: estimatedTokens(totalBytes),
    largestFile,
    files: files.slice(0, Math.max(1, Math.min(50, Number(options.limit || 20)))),
    warnings,
    excludedDirs: [...CLAUDE_EXCLUDED_DIRS],
    note: '来自本地 Claude 配置文件大小估算；不是请求日志、账单或真实用量。',
  };

  return {
    schema: 'easyaiconfig.config-diagnostics.v1',
    generatedAt: new Date().toISOString(),
    tools: [claude],
    summary: {
      tools: 1,
      readyTools: exists && files.length ? 1 : 0,
      files: files.length,
      totalBytes,
      estimatedTokens: claude.estimatedTokens,
      warnings: warnings.length,
    },
  };
}
