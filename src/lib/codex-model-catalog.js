import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';

const DEFAULT_REASONING_LEVELS = ['low', 'medium', 'high'].map((effort) => ({ effort, description: effort }));

function normalizedModelId(value) {
  return String(value || '').trim().toLowerCase();
}

function safeProviderName(value) {
  return String(value || 'provider')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'provider';
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function defaultModelEntry(slug) {
  return {
    slug,
    display_name: slug,
    description: `${slug} model`,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: DEFAULT_REASONING_LEVELS,
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 0,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: 'You are Codex, an AI coding assistant.',
    supports_reasoning_summaries: false,
    default_reasoning_summary: 'auto',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 10000 },
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    context_window: 272000,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    supports_search_tool: false,
    use_responses_lite: false,
  };
}

function selectTemplate(models, slug) {
  const normalized = normalizedModelId(slug);
  const preferred = normalized.startsWith('gpt-5.6')
    ? ['gpt-5.5', 'gpt-5.4', 'gpt-5']
    : normalized.startsWith('gpt-') ? ['gpt-5.5', 'gpt-5.4', 'gpt-5'] : [];
  for (const prefix of preferred) {
    const match = models.find((item) => normalizedModelId(item?.slug).startsWith(prefix));
    if (match) return match;
  }
  return models.find((item) => item && typeof item === 'object' && item.slug) || null;
}

function cloneModelEntry(models, slug) {
  const template = selectTemplate(models, slug);
  const entry = template ? structuredClone(template) : defaultModelEntry(slug);
  entry.slug = slug;
  entry.display_name = slug;
  entry.description = `${slug} model`;
  entry.visibility = 'list';
  entry.supported_in_api = true;
  entry.availability_nux = null;
  entry.upgrade = null;
  return entry;
}

async function readJson(filePath) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveCatalogPath(codexHome, configuredPath) {
  const raw = String(configuredPath || '').trim();
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(codexHome, raw);
}

function updateModelCatalogSetting(configText, catalogPath) {
  const line = `model_catalog_json = ${JSON.stringify(catalogPath)}`;
  const cleaned = configText
    .split(/\r?\n/)
    .filter((configLine) => !/^\s*model_catalog_json\s*=/.test(configLine))
    .join('\n')
    .replace(/^\n+/, '');
  const tableIndex = cleaned.search(/^\s*\[/m);
  if (tableIndex >= 0) {
    const prefix = cleaned.slice(0, tableIndex).replace(/\s*$/, '\n');
    return `${prefix}${line}\n\n${cleaned.slice(tableIndex)}`;
  }
  const suffix = cleaned && !cleaned.endsWith('\n') ? '\n' : '';
  return `${cleaned}${suffix}${line}\n`;
}

async function copyIfPresent(source, destination) {
  if (!(await exists(source))) return false;
  await fs.copyFile(source, destination);
  return true;
}

export async function syncCodexModelCatalog({ codexHome, providerKey, models } = {}) {
  const resolvedHome = path.resolve(String(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')).trim());
  const homeRoot = path.resolve(os.homedir());
  if (resolvedHome !== homeRoot && !resolvedHome.startsWith(homeRoot + path.sep)) {
    throw new Error('codexHome 必须位于当前用户目录中');
  }
  const requestedById = new Map();
  for (const item of Array.isArray(models) ? models : []) {
    const model = String(item || '').trim();
    const key = normalizedModelId(model);
    if (key && !requestedById.has(key)) requestedById.set(key, model);
  }
  const requestedModels = [...requestedById.values()];
  if (!requestedModels.length) throw new Error('没有可同步的模型');

  await fs.mkdir(resolvedHome, { recursive: true });
  const configPath = path.join(resolvedHome, 'config.toml');
  let configText = '';
  try { configText = await fs.readFile(configPath, 'utf8'); } catch {}
  let configuredCatalog = '';
  try { configuredCatalog = TOML.parse(configText).model_catalog_json || ''; } catch {}
  const existingCatalogPath = resolveCatalogPath(resolvedHome, configuredCatalog);
  const cachePath = path.join(resolvedHome, 'models_cache.json');
  const existingCatalog = existingCatalogPath ? await readJson(existingCatalogPath) : null;
  const cacheCatalog = await readJson(cachePath);
  const baseCatalog = existingCatalog || cacheCatalog || { models: [] };
  const catalog = structuredClone(baseCatalog);
  catalog.models = Array.isArray(catalog.models) ? catalog.models.filter((item) => item && typeof item === 'object') : [];

  const seen = new Set();
  catalog.models = catalog.models.filter((item) => {
    const key = normalizedModelId(item.slug);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let addedCount = 0;
  for (const model of requestedModels) {
    const key = normalizedModelId(model);
    if (seen.has(key)) continue;
    catalog.models.push(cloneModelEntry(catalog.models, model));
    seen.add(key);
    addedCount += 1;
  }

  const catalogDir = path.join(resolvedHome, 'model-catalogs');
  await fs.mkdir(catalogDir, { recursive: true });
  const targetPath = path.join(catalogDir, `model-catalog.${safeProviderName(providerKey)}.json`);
  const backupDir = path.join(os.homedir(), '.codex-config-ui', 'backups', `model-catalog-${timestamp()}`);
  await fs.mkdir(backupDir, { recursive: true });
  await copyIfPresent(configPath, path.join(backupDir, 'config.toml'));
  await copyIfPresent(targetPath, path.join(backupDir, path.basename(targetPath)));

  await fs.writeFile(targetPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  await fs.writeFile(configPath, updateModelCatalogSetting(configText, targetPath), 'utf8');

  return {
    catalogPath: targetPath,
    configPath,
    backupPath: backupDir,
    addedCount,
    totalCount: catalog.models.length,
    syncedModels: requestedModels,
    restartRequired: true,
  };
}
