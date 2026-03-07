import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import TOML from '@iarna/toml';

const APP_HOME_DIRNAME = '.codex-config-ui';
const BACKUPS_DIRNAME = 'backups';
const OPENAI_CODEX_PACKAGE = '@openai/codex';

function defaultCodexHome() {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function appHome() {
  return path.join(os.homedir(), APP_HOME_DIRNAME);
}

function backupsRoot() {
  return path.join(appHome(), BACKUPS_DIRNAME);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function parseCodexVersion(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?/i);
  if (!match) return null;
  return {
    raw: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prereleaseTag: match[4] || '',
    prereleaseNum: Number(match[5] || 0),
  };
}

function compareCodexVersions(left, right) {
  const a = parseCodexVersion(left);
  const b = parseCodexVersion(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (!a.prereleaseTag && b.prereleaseTag) return 1;
  if (a.prereleaseTag && !b.prereleaseTag) return -1;
  if (a.prereleaseTag !== b.prereleaseTag) return a.prereleaseTag.localeCompare(b.prereleaseTag);
  return a.prereleaseNum - b.prereleaseNum;
}

function commandExists(command) {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(lookup, [command], { encoding: 'utf8' });
  return result.status === 0 ? (result.stdout || '').split(/\r?\n/).find(Boolean) || null : null;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function parseVersionString(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersionString(left) || [0, 0, 0];
  const b = parseVersionString(right) || [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function codexCandidates() {
  const paths = new Set();
  const whichResult = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['-a', 'codex'], { encoding: 'utf8' });
  if (whichResult.status === 0) {
    for (const line of (whichResult.stdout || '').split(/\r?\n/)) {
      if (line.trim()) paths.add(line.trim());
    }
  }
  const explicit = [
    '/Users/Open Source Contributor/.npm-global/bin/codex',
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ];
  for (const entry of explicit) {
    if (entry) paths.add(entry);
  }
  return [...paths];
}

function findCodexBinary() {
  const candidates = codexCandidates().map((candidatePath) => {
    const result = spawnSync(candidatePath, ['--version'], { encoding: 'utf8' });
    return {
      path: candidatePath,
      installed: result.status === 0,
      version: result.status === 0 ? (result.stdout || result.stderr || '').trim() : null,
    };
  }).filter((item) => item.installed);

  candidates.sort((left, right) => compareVersions(right.version, left.version));
  const selected = candidates[0];

  return {
    installed: Boolean(selected),
    version: selected?.version || null,
    path: selected?.path || commandExists('codex'),
    candidates,
    installCommand: `${npmCommand()} install -g ${OPENAI_CODEX_PACKAGE}`,
  };
}

function scopePaths({ scope, projectPath, codexHome }) {
  if (scope === 'project') {
    if (!projectPath || !projectPath.trim()) {
      throw new Error('Project path is required for project scope');
    }
    const normalizedProjectPath = path.resolve(projectPath.trim());
    return {
      scope,
      rootPath: normalizedProjectPath,
      configPath: path.join(normalizedProjectPath, '.codex', 'config.toml'),
      envPath: path.join(codexHome, '.env'),
    };
  }

  return {
    scope: 'global',
    rootPath: codexHome,
    configPath: path.join(codexHome, 'config.toml'),
    envPath: path.join(codexHome, '.env'),
  };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function writeText(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
}

function parseToml(content) {
  return content.trim() ? TOML.parse(content) : {};
}

function applyPatch(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null) {
      delete target[key];
      continue;
    }
    if (Array.isArray(value)) {
      target[key] = value;
      continue;
    }
    if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      applyPatch(target[key], value);
      if (!Object.keys(target[key]).length) {
        delete target[key];
      }
      continue;
    }
    target[key] = value;
  }
}

function parseEnv(content) {
  const entries = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    entries[key] = value.replace(/^['"]|['"]$/g, '');
  }
  return entries;
}

function stringifyEnv(entries) {
  const rows = Object.entries(entries)
    .filter(([key]) => key && !key.toUpperCase().startsWith('CODEX_'))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value ?? '')}`);
  return rows.length ? `${rows.join('\n')}\n` : '';
}

function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) {
    throw new Error('Base URL is required');
  }

  const withScheme = /^[a-z]+:\/\//i.test(raw)
    ? raw
    : (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(raw) ? `http://${raw}` : `https://${raw}`);

  const url = new URL(withScheme);
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/v1';
  } else if (!/\/v1$/i.test(url.pathname)) {
    url.pathname = `${url.pathname}/v1`;
  }
  return url.toString().replace(/\/+$/, '');
}

function slugifyProviderKey(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) return 'custom';
  return /^\d/.test(slug) ? `provider-${slug}` : slug;
}

function inferProviderSeed(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, '');
    const parts = hostname.split('.').filter(Boolean);
    const ignored = new Set(['api', 'openai', 'codex', 'gateway', 'chat', 'www', 'dapi']);
    const picked = parts.find((part) => !ignored.has(part) && /[a-z]/.test(part));
    return picked || parts[0] || 'custom';
  } catch {
    return 'custom';
  }
}

function inferProviderLabel(baseUrl, providerKey) {
  const seed = inferProviderSeed(baseUrl) || providerKey || 'Custom';
  return seed
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferEnvKey(providerKey) {
  return slugifyProviderKey(providerKey)
    .replace(/-/g, '_')
    .toUpperCase() + '_API_KEY';
}

async function readAuthJson(codexHome) {
  const raw = await readText(path.join(codexHome, 'auth.json'));
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9]/g, '');
}

function scoreKeyCandidate(candidateKey, provider) {
  const candidate = normalizeToken(candidateKey)
    .replace(/apikey$/, '')
    .replace(/oaikey$/, '')
    .replace(/key$/, '')
    .replace(/token$/, '');
  const targets = [provider.key, provider.name, provider.baseUrl]
    .map(normalizeToken)
    .filter(Boolean);

  let score = 0;
  for (const target of targets) {
    if (!target || !candidate) continue;
    if (target === candidate) score += 120;
    if (target.includes(candidate)) score += 60;
    if (candidate.includes(target)) score += 30;
    const prefixLen = Math.min(target.length, candidate.length, 8);
    if (prefixLen >= 4 && target.slice(0, prefixLen) === candidate.slice(0, prefixLen)) score += prefixLen * 5;
  }

  if (candidate === 'openai' && !targets.some((target) => target.includes('openai'))) {
    score -= 60;
  }

  return score;
}

function candidateEnvKeys(provider) {
  const seeds = [
    provider.key,
    provider.name,
    (() => {
      try {
        return new URL(provider.baseUrl || 'https://example.invalid').hostname;
      } catch {
        return '';
      }
    })(),
  ];

  const keys = new Set();
  for (const seed of seeds) {
    const normalized = String(seed || '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
    if (!normalized) {
      continue;
    }
    keys.add(`${normalized}_API_KEY`);
    keys.add(`${normalized}_OAI_KEY`);
    keys.add(`${normalized}_KEY`);
  }
  return [...keys];
}

function resolveProviderSecret(provider, envFile, authJson) {
  const runtimeEnv = process.env;
  const explicitKeys = provider.envKey ? [provider.envKey] : [];
  const discoveredKeys = [
    ...Object.keys(envFile || {}),
    ...Object.keys(runtimeEnv || {}),
    ...Object.keys(authJson || {}),
  ].filter((key) => /(?:key|token)$/i.test(key));
  const candidateKeys = [...new Set([...explicitKeys, ...candidateEnvKeys(provider), ...discoveredKeys])];
  const candidates = [];

  for (const key of candidateKeys) {
    const dynamicScore = scoreKeyCandidate(key, provider);
    if (envFile[key]) {
      candidates.push({ key, value: envFile[key], source: '.env', score: explicitKeys.includes(key) ? 1000 : dynamicScore + 100 });
    }
    if (runtimeEnv[key]) {
      candidates.push({ key, value: runtimeEnv[key], source: 'system-env', score: explicitKeys.includes(key) ? 950 : dynamicScore + 90 });
    }
    if (authJson[key]) {
      candidates.push({ key, value: authJson[key], source: 'auth.json', score: explicitKeys.includes(key) ? 900 : dynamicScore + 80 });
    }
  }

  if (provider.inlineBearerToken) {
    candidates.push({ key: null, value: provider.inlineBearerToken, source: 'config.toml', score: 850 });
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0] || { key: provider.envKey || candidateKeys[0] || null, value: '', source: null, score: 0 };
}

function summarizeProviders(config, envFile, authJson) {
  const providers = Object.entries(config.model_providers || {}).map(([key, provider]) => {
    const base = {
      key,
      name: provider?.name || key,
      baseUrl: provider?.base_url || '',
      envKey: provider?.env_key || provider?.temp_env_key || '',
      wireApi: provider?.wire_api || 'responses',
      inlineBearerToken: provider?.experimental_bearer_token || '',
      isActive: config.model_provider === key,
    };
    const secret = resolveProviderSecret(base, envFile, authJson);
    return {
      ...base,
      hasApiKey: Boolean(secret.value),
      keySource: secret.source,
      envValue: secret.value || '',
      resolvedKeyName: secret.key,
    };
  });

  providers.sort((left, right) => {
    if (left.isActive !== right.isActive) {
      return left.isActive ? -1 : 1;
    }
    return left.key.localeCompare(right.key);
  });

  return providers;
}

async function createBackup({ configPath, envPath, scope }) {
  const targetDir = path.join(backupsRoot(), `${timestamp()}-${scope}`);
  await ensureDir(targetDir);
  await fs.writeFile(path.join(targetDir, 'config.toml.bak'), await readText(configPath), 'utf8');
  await fs.writeFile(path.join(targetDir, '.env.bak'), await readText(envPath), 'utf8');
  return targetDir;
}

function launchTerminalCommand(cwd) {
  if (process.platform === 'darwin') {
    const appleScript = [
      'tell application "Terminal"',
      'activate',
      `do script "cd ${String(cwd).replace(/([\\"])/g, '\\$1')} && ${String(findCodexBinary().path || 'codex').replace(/([\\"])/g, '\\$1')}"`,
      'end tell',
    ].join('\n');
    const result = spawnSync('osascript', ['-e', appleScript], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'Failed to open Terminal').trim());
    }
    return 'Codex 已在 Terminal 中启动';
  }

  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', `cd /d "${cwd}" && "${findCodexBinary().path || 'codex'}"`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return 'Codex 已在新命令窗口中启动';
  }

  const terminals = [
    ['x-terminal-emulator', ['-e', `bash -lc "cd ${cwd} && ${findCodexBinary().path || 'codex'}"`]],
    ['gnome-terminal', ['--', 'bash', '-lc', `cd ${cwd} && ${findCodexBinary().path || 'codex'}`]],
    ['konsole', ['-e', 'bash', '-lc', `cd ${cwd} && ${findCodexBinary().path || 'codex'}`]],
  ];

  for (const [command, args] of terminals) {
    if (!commandExists(command)) {
      continue;
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return 'Codex 已在新终端中启动';
  }

  throw new Error('没有找到可用终端，请先手动运行 codex');
}

export async function checkSetupEnvironment({ codexHome = defaultCodexHome() } = {}) {
  const normalizedCodexHome = path.resolve(codexHome);

  // 1. Check Node.js
  const nodeResult = spawnSync('node', ['--version'], { encoding: 'utf8' });
  const nodeInstalled = nodeResult.status === 0;
  const nodeVersion = nodeInstalled ? (nodeResult.stdout || '').trim() : null;
  const nodeMajor = nodeVersion ? parseInt((nodeVersion.match(/v?(\d+)/) || [])[1] || '0', 10) : 0;

  // 2. Check npm
  const npmResult = spawnSync(npmCommand(), ['--version'], { encoding: 'utf8' });
  const npmInstalled = npmResult.status === 0;
  const npmVersion = npmInstalled ? (npmResult.stdout || '').trim() : null;

  // 3. Check codex binary
  const codexBinary = findCodexBinary();

  // 4. Check config files
  const globalConfigPath = path.join(normalizedCodexHome, 'config.toml');
  const globalEnvPath = path.join(normalizedCodexHome, '.env');
  const configContent = await readText(globalConfigPath);
  const envContent = await readText(globalEnvPath);
  const configExists = Boolean(configContent.trim());
  const envExists = Boolean(envContent.trim());

  // 5. Check if there are any providers configured
  let hasProviders = false;
  let hasActiveProvider = false;
  if (configExists) {
    try {
      const config = parseToml(configContent);
      hasProviders = Boolean(config.model_providers && Object.keys(config.model_providers).length > 0);
      hasActiveProvider = Boolean(config.model_provider);
    } catch { /* ignore parse errors */ }
  }

  // Determine overall readiness
  const needsSetup = !codexBinary.installed || !configExists || !hasProviders;

  return {
    node: {
      installed: nodeInstalled,
      version: nodeVersion,
      major: nodeMajor,
      sufficient: nodeMajor >= 18,
    },
    npm: {
      installed: npmInstalled,
      version: npmVersion,
    },
    codex: {
      installed: codexBinary.installed,
      version: codexBinary.version,
      path: codexBinary.path,
    },
    config: {
      exists: configExists,
      envExists,
      hasProviders,
      hasActiveProvider,
      configPath: globalConfigPath,
      envPath: globalEnvPath,
    },
    needsSetup,
    codexHome: normalizedCodexHome,
  };
}

export async function loadState({ scope = 'global', projectPath = '', codexHome = defaultCodexHome() } = {}) {
  const normalizedCodexHome = path.resolve(codexHome);
  const paths = scopePaths({ scope, projectPath, codexHome: normalizedCodexHome });
  await ensureDir(normalizedCodexHome);

  const [configContent, envContent, authJson] = await Promise.all([
    readText(paths.configPath),
    readText(paths.envPath),
    readAuthJson(normalizedCodexHome),
  ]);

  const config = parseToml(configContent);
  const env = parseEnv(envContent);
  const providers = summarizeProviders(config, env, authJson);
  const activeProvider = providers.find((provider) => provider.isActive) || null;
  const codexBinary = findCodexBinary();

  return {
    appHome: appHome(),
    codexHome: normalizedCodexHome,
    codexBinary,
    scope: paths.scope,
    rootPath: paths.rootPath,
    projectPath: scope === 'project' ? paths.rootPath : '',
    configPath: paths.configPath,
    envPath: paths.envPath,
    configExists: Boolean(configContent.trim()),
    envExists: Boolean(envContent.trim()),
    authJson,
    configToml: configContent,
    config,
    env,
    providers,
    activeProvider,
    summary: {
      model: config.model || '',
      modelProvider: config.model_provider || '',
      providerBaseUrl: activeProvider?.baseUrl || '',
      envKey: activeProvider?.resolvedKeyName || activeProvider?.envKey || '',
      approvalPolicy: config.approval_policy || '',
      sandboxMode: config.sandbox_mode || '',
      reasoningEffort: config.model_reasoning_effort || '',
      providerCount: providers.length,
    },
    launch: {
      cwd: scope === 'project' ? paths.rootPath : process.cwd(),
      ready: codexBinary.installed,
    },
  }
}

export async function saveConfig(payload) {
  const codexHome = path.resolve(payload.codexHome || defaultCodexHome());
  const paths = scopePaths({
    scope: payload.scope || 'global',
    projectPath: payload.projectPath || '',
    codexHome,
  });

  const [configContent, envContent] = await Promise.all([
    readText(paths.configPath),
    readText(paths.envPath),
  ]);

  const config = parseToml(configContent);
  const env = parseEnv(envContent);
  const baseUrl = normalizeBaseUrl(payload.baseUrl);
  const apiKey = String(payload.apiKey || '').trim();
  const providerKey = slugifyProviderKey(payload.providerKey || inferProviderSeed(baseUrl));
  const currentProvider = config.model_providers?.[providerKey] || {};
  const providerLabel = String(payload.providerLabel || currentProvider.name || inferProviderLabel(baseUrl, providerKey)).trim() || providerKey;
  const envKey = String(payload.envKey || currentProvider.env_key || inferEnvKey(providerKey)).trim();
  const model = String(payload.model || '').trim();
  const approvalPolicy = String(payload.approvalPolicy || '').trim();
  const sandboxMode = String(payload.sandboxMode || '').trim();
  const reasoningEffort = String(payload.reasoningEffort || '').trim();

  config.model_provider = providerKey;
  if (model) config.model = model;
  if (approvalPolicy) config.approval_policy = approvalPolicy;
  if (sandboxMode) config.sandbox_mode = sandboxMode;
  if (reasoningEffort) config.model_reasoning_effort = reasoningEffort;
  if (!config.model_providers || typeof config.model_providers !== 'object') {
    config.model_providers = {};
  }

  config.model_providers[providerKey] = {
    ...currentProvider,
    name: providerLabel,
    base_url: baseUrl,
    env_key: envKey,
    wire_api: 'responses',
  };

  if (apiKey && envKey) {
    env[envKey] = apiKey;
  }

  const backupPath = await createBackup(paths);
  await writeText(paths.configPath, TOML.stringify(config));
  await writeText(paths.envPath, stringifyEnv(env));

  return {
    saved: true,
    backupPath,
    paths,
    activeProvider: providerKey,
  };
}

export async function saveSettings(payload) {
  const codexHome = path.resolve(payload.codexHome || defaultCodexHome());
  const paths = scopePaths({
    scope: payload.scope || 'global',
    projectPath: payload.projectPath || '',
    codexHome,
  });

  const configContent = await readText(paths.configPath);
  const config = parseToml(configContent);
  applyPatch(config, payload.settings || {});

  const backupPath = await createBackup(paths);
  await writeText(paths.configPath, TOML.stringify(config));

  return {
    saved: true,
    backupPath,
    paths,
  };
}

export async function saveRawConfig(payload) {
  const codexHome = path.resolve(payload.codexHome || defaultCodexHome());
  const paths = scopePaths({
    scope: payload.scope || 'global',
    projectPath: payload.projectPath || '',
    codexHome,
  });

  const configToml = String(payload.configToml || '').trim();
  if (!configToml) {
    throw new Error('config.toml 内容不能为空');
  }

  let parsed;
  try {
    parsed = TOML.parse(configToml);
  } catch (error) {
    throw new Error(`TOML 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const backupPath = await createBackup(paths);
  await writeText(paths.configPath, TOML.stringify(parsed));

  return {
    saved: true,
    backupPath,
    paths,
  };
}

export async function listBackups() {
  await ensureDir(backupsRoot());
  const entries = await fs.readdir(backupsRoot(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(backupsRoot(), entry.name),
    }))
    .sort((left, right) => right.name.localeCompare(left.name));
}

export async function restoreBackup({ backupName, scope = 'global', projectPath = '', codexHome = defaultCodexHome() }) {
  if (!backupName) {
    throw new Error('Backup name is required');
  }

  const normalizedCodexHome = path.resolve(codexHome);
  const paths = scopePaths({ scope, projectPath, codexHome: normalizedCodexHome });
  const backupDir = path.join(backupsRoot(), backupName);
  const [configContent, envContent] = await Promise.all([
    readText(path.join(backupDir, 'config.toml.bak')),
    readText(path.join(backupDir, '.env.bak')),
  ]);

  await writeText(paths.configPath, configContent);
  await writeText(paths.envPath, envContent);
  return { restored: true, paths };
}

async function codexNpmAction(args) {
  const result = await runCommand(npmCommand(), args);
  return {
    ...result,
    command: `${npmCommand()} ${args.join(' ')}`,
  };
}

export async function getCodexReleaseInfo() {
  const result = await runCommand(npmCommand(), ['view', OPENAI_CODEX_PACKAGE, 'dist-tags', '--json']);
  if (!result.ok) {
    throw new Error((result.stderr || result.stdout || '获取版本信息失败').trim());
  }

  let tags = {};
  try {
    tags = JSON.parse(result.stdout || '{}');
  } catch {
    tags = {};
  }

  const current = findCodexBinary().version || '';
  const currentVersion = (current.match(/\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?/i) || [null])[0];
  const latestStable = tags.latest || null;
  const latestAlpha = tags.alpha || null;

  return {
    currentVersion,
    latestStable,
    latestAlpha,
    hasStableUpdate: Boolean(currentVersion && latestStable && compareCodexVersions(latestStable, currentVersion) > 0),
    hasAlphaUpdate: Boolean(currentVersion && latestAlpha && compareCodexVersions(latestAlpha, currentVersion) > 0),
    isInstalled: findCodexBinary().installed,
  };
}

export async function installCodex() {
  return codexNpmAction(['install', '-g', OPENAI_CODEX_PACKAGE]);
}

export async function reinstallCodex() {
  return codexNpmAction(['install', '-g', OPENAI_CODEX_PACKAGE, '--force']);
}

export async function updateCodex() {
  return codexNpmAction(['install', '-g', `${OPENAI_CODEX_PACKAGE}@latest`]);
}

export async function uninstallCodex() {
  return codexNpmAction(['uninstall', '-g', OPENAI_CODEX_PACKAGE]);
}

export async function launchCodex({ cwd } = {}) {
  const targetCwd = path.resolve(cwd || process.cwd());
  const codexBinary = findCodexBinary();
  if (!codexBinary.installed) {
    throw new Error('Codex 尚未安装，请先点击安装');
  }

  const message = launchTerminalCommand(targetCwd);
  return { ok: true, cwd: targetCwd, message };
}
