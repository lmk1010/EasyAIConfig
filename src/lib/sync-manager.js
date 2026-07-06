import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

function appHome() {
  return path.join(os.homedir(), '.codex-config-ui');
}

function syncTargetsPath() {
  return path.join(appHome(), 'sync-targets.json');
}

function syncManifestPath(root) {
  return path.join(root, 'manifest.json');
}

function syncSnapshotsRoot(root) {
  return path.join(root, 'snapshots');
}

function emptySyncManifest() {
  return {
    schema: 'easyaiconfig.sync-manifest.v1',
    updatedAt: '',
    latestSnapshotId: '',
    snapshots: [],
  };
}

function nowStamp(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function sha256Text(text = '') {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function safeSnapshotId(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function parseWebDavUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return { url: '', username: '', password: '' };
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('WebDAV URL must use http or https');
  }
  const username = parsed.username ? decodeURIComponent(parsed.username) : '';
  const password = parsed.password ? decodeURIComponent(parsed.password) : '';
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  return {
    url: parsed.toString().replace(/\/$/, ''),
    username,
    password,
  };
}

function normalizeHeaderObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, headerValue]) => key && headerValue != null)
      .map(([key, headerValue]) => [String(key), String(headerValue)]),
  );
}

function webDavBaseUrl(target = {}) {
  const parsed = parseWebDavUrl(target.url || '');
  return parsed.url.replace(/\/?$/, '/');
}

function webDavUrl(target = {}, ...segments) {
  const base = webDavBaseUrl(target).replace(/\/$/, '');
  const suffix = segments
    .filter((segment) => String(segment || '').trim())
    .map((segment) => encodeURIComponent(String(segment)))
    .join('/');
  return suffix ? `${base}/${suffix}` : base;
}

function webDavAuthHeaders(target = {}) {
  const headers = { ...normalizeHeaderObject(target.headers) };
  const hasAuthHeader = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
  if (!hasAuthHeader && target.token) {
    headers.Authorization = `Bearer ${target.token}`;
  } else if (!hasAuthHeader && (target.username || target.password)) {
    headers.Authorization = `Basic ${Buffer.from(`${target.username || ''}:${target.password || ''}`, 'utf8').toString('base64')}`;
  }
  return headers;
}

async function webDavRequest(target, url, {
  method = 'GET',
  body,
  headers = {},
  okStatuses = [],
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...webDavAuthHeaders(target),
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok && !okStatuses.includes(response.status)) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        detail = '';
      }
      throw new Error(`WebDAV ${method} failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 160)}` : ''}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureWebDavCollection(target, segments = []) {
  await webDavRequest(target, webDavUrl(target, ...segments), {
    method: 'MKCOL',
    okStatuses: [200, 201, 204, 405],
  });
}

function webDavSnapshotUrlInsideRoot(target, url) {
  const root = webDavBaseUrl(target);
  const resolved = new URL(url, root).toString();
  return resolved === root || resolved.startsWith(root);
}

function defaultSnapshotId(bundle = {}) {
  const basis = [
    bundle.schema || '',
    bundle.exportedAt || '',
    JSON.stringify(bundle.assets || {}),
    crypto.randomUUID(),
  ].join('|');
  return `${nowStamp()}-${sha256Text(basis).slice(0, 12)}`;
}

function bundleSummary(bundle = {}) {
  const assets = bundle.assets || {};
  const providerCatalog = assets.providerCatalog || {};
  const mcpInventory = assets.mcpInventory || {};
  const promptInventory = assets.promptInventory || {};
  const skillInventory = assets.skillInventory || {};
  const sessionInventory = assets.sessionInventory || {};
  return {
    providerPresets: Array.isArray(providerCatalog.presets) ? providerCatalog.presets.length : 0,
    mcpServers: Number(mcpInventory.summary?.servers || 0),
    prompts: Number(promptInventory.summary?.files || promptInventory.summary?.existing || 0),
    skills: Number(skillInventory.summary?.skills || 0),
    sessions: Number(sessionInventory.summary?.sessions || 0),
  };
}

async function pathState(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  if (!resolved) return { path: '', exists: false, writable: false };
  let exists = false;
  let writable = false;
  try {
    await fs.access(resolved, constants.F_OK);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    try {
      await fs.access(resolved, constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
  }
  return { path: resolved, exists, writable };
}

async function parentPathState(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  const parent = path.dirname(resolved);
  return pathState(parent);
}

async function readConfiguredTargets(configPath = syncTargetsPath()) {
  let raw = '';
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Sync targets parse failed: ${error.message}`);
  }
  return Array.isArray(parsed.targets) ? parsed.targets : [];
}

function normalizeConfiguredTarget(target = {}, index = 0) {
  const parsedWebDavUrl = target.url ? parseWebDavUrl(target.url) : { url: '', username: '', password: '' };
  return {
    id: String(target.id || `custom-${index + 1}`).trim(),
    type: String(target.type || 'directory').trim(),
    label: String(target.label || target.id || `Custom ${index + 1}`).trim(),
    path: String(target.path || '').trim(),
    url: parsedWebDavUrl.url,
    username: String(target.username || parsedWebDavUrl.username || '').trim(),
    password: String(target.password || parsedWebDavUrl.password || ''),
    token: String(target.token || target.accessToken || target.bearerToken || '').trim(),
    headers: normalizeHeaderObject(target.headers),
    enabled: target.enabled !== false,
    mode: String(target.mode || 'bundle-export').trim(),
  };
}

async function discoverOneDriveTargets() {
  const home = os.homedir();
  let entries = [];
  try {
    entries = await fs.readdir(home, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && /^OneDrive/i.test(entry.name))
    .map((entry, index) => ({
      id: index === 0 ? 'onedrive' : `onedrive-${index + 1}`,
      type: 'onedrive',
      label: entry.name,
      path: path.join(home, entry.name, 'EasyAIConfig'),
      url: '',
      enabled: true,
      mode: 'bundle-export',
      detected: true,
    }));
}

async function discoverNasTargets() {
  if (process.platform !== 'darwin') return [];
  let entries = [];
  try {
    entries = await fs.readdir('/Volumes', { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !['Macintosh HD', 'Preboot', 'Recovery'].includes(entry.name))
    .map((entry, index) => ({
      id: index === 0 ? 'nas-volume' : `nas-volume-${index + 1}`,
      type: 'nas',
      label: `NAS / Volume: ${entry.name}`,
      path: path.join('/Volumes', entry.name, 'EasyAIConfig'),
      url: '',
      enabled: true,
      mode: 'bundle-export',
      detected: true,
    }));
}

function builtInTargets() {
  const home = os.homedir();
  const targets = [
    {
      id: 'icloud',
      type: 'icloud',
      label: 'iCloud Drive',
      path: path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'EasyAIConfig'),
      url: '',
      enabled: process.platform === 'darwin',
      mode: 'bundle-export',
      detected: true,
    },
    {
      id: 'dropbox',
      type: 'dropbox',
      label: 'Dropbox',
      path: path.join(home, 'Dropbox', 'EasyAIConfig'),
      url: '',
      enabled: true,
      mode: 'bundle-export',
      detected: true,
    },
  ];
  const envSyncDir = process.env.EASYAICONFIG_SYNC_DIR?.trim();
  if (envSyncDir) {
    targets.push({
      id: 'env-sync-dir',
      type: 'directory',
      label: 'EASYAICONFIG_SYNC_DIR',
      path: envSyncDir,
      url: '',
      enabled: true,
      mode: 'bundle-export',
      detected: true,
    });
  }
  return targets;
}

function publicSyncTarget(target = {}) {
  const { password, token, headers, ...publicTarget } = target;
  const hasCustomAuthHeader = Object.keys(headers || {}).some((key) => key.toLowerCase() === 'authorization');
  publicTarget.auth = {
    type: token ? 'bearer' : (target.username || password ? 'basic' : (hasCustomAuthHeader ? 'custom' : 'none')),
    username: target.username || '',
    hasPassword: Boolean(password),
    hasToken: Boolean(token),
    headerCount: Object.keys(headers || {}).length,
  };
  return publicTarget;
}

async function materializeTarget(target, { includeSecrets = false } = {}) {
  const state = target.path ? await pathState(target.path) : { path: '', exists: false, writable: false };
  const configured = !target.detected;
  const webdav = target.type === 'webdav';
  const materialized = {
    id: target.id,
    type: target.type,
    label: target.label,
    path: state.path,
    url: target.url,
    username: target.username || '',
    password: target.password || '',
    token: target.token || '',
    headers: normalizeHeaderObject(target.headers),
    enabled: Boolean(target.enabled),
    configured,
    detected: Boolean(target.detected),
    mode: target.mode || 'bundle-export',
    exists: webdav ? Boolean(target.url) : state.exists,
    writable: webdav ? Boolean(target.url) : state.writable,
    ready: Boolean(target.enabled) && (webdav ? Boolean(target.url) : state.exists && state.writable),
  };
  return includeSecrets ? materialized : publicSyncTarget(materialized);
}

async function resolveSyncTarget(input = {}, options = {}) {
  const directPath = String(input.targetPath || input.path || '').trim();
  if (directPath) {
    const state = await pathState(directPath);
    return {
      id: String(input.targetId || input.id || 'direct-directory').trim(),
      type: String(input.type || 'directory').trim(),
      label: String(input.label || input.targetId || 'Direct Directory').trim(),
      path: state.path,
      url: '',
      enabled: true,
      configured: false,
      detected: false,
      mode: 'bundle-export',
      exists: state.exists,
      writable: state.writable,
      ready: state.exists && state.writable,
    };
  }

  const directUrl = String(input.targetUrl || input.url || '').trim();
  if (directUrl) {
    return materializeTarget(normalizeConfiguredTarget({
      ...input,
      id: input.targetId || input.id || 'direct-webdav',
      type: input.type || 'webdav',
      url: directUrl,
    }), { includeSecrets: true });
  }

  const targetId = String(input.targetId || input.id || '').trim();
  if (!targetId) throw new Error('targetId or targetPath is required');
  const inventory = await listSyncTargets({ ...options, includeSecrets: true });
  const target = inventory.targets.find((item) => item.id === targetId);
  if (!target) throw new Error(`Sync target not found: ${targetId}`);
  return target;
}

function assertDirectorySyncTarget(target = {}) {
  if (!target.enabled) throw new Error('Sync target is disabled');
  if (!target.path) throw new Error('Sync target path is required');
}

function assertWebDavSyncTarget(target = {}) {
  if (!target.enabled) throw new Error('Sync target is disabled');
  if (!target.url) throw new Error('WebDAV target URL is required');
}

function assertSyncTarget(target = {}) {
  if (target.type === 'webdav') return assertWebDavSyncTarget(target);
  return assertDirectorySyncTarget(target);
}

async function readSyncManifestAt(root) {
  const manifestPath = syncManifestPath(root);
  let raw = '';
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return emptySyncManifest();
    }
    throw error;
  }
  if (!raw.trim()) {
    return emptySyncManifest();
  }
  const parsed = JSON.parse(raw);
  return {
    schema: parsed.schema || 'easyaiconfig.sync-manifest.v1',
    updatedAt: parsed.updatedAt || '',
    latestSnapshotId: parsed.latestSnapshotId || '',
    snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
  };
}

async function readWebDavManifestAt(target = {}) {
  assertWebDavSyncTarget(target);
  const response = await webDavRequest(target, webDavUrl(target, 'manifest.json'), {
    method: 'GET',
    okStatuses: [404],
  });
  if (response.status === 404) return emptySyncManifest();
  const raw = await response.text();
  if (!raw.trim()) return emptySyncManifest();
  const parsed = JSON.parse(raw);
  return {
    schema: parsed.schema || 'easyaiconfig.sync-manifest.v1',
    updatedAt: parsed.updatedAt || '',
    latestSnapshotId: parsed.latestSnapshotId || '',
    snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
  };
}

async function writeWebDavManifestAt(target = {}, manifest = {}) {
  const payload = {
    schema: 'easyaiconfig.sync-manifest.v1',
    updatedAt: new Date().toISOString(),
    latestSnapshotId: manifest.latestSnapshotId || '',
    snapshots: Array.isArray(manifest.snapshots) ? manifest.snapshots : [],
  };
  await ensureWebDavCollection(target, []);
  await webDavRequest(target, webDavUrl(target, 'manifest.json'), {
    method: 'PUT',
    body: `${JSON.stringify(payload, null, 2)}\n`,
    headers: { 'Content-Type': 'application/json' },
    okStatuses: [200, 201, 204],
  });
  return payload;
}

async function writeSyncManifestAt(root, manifest) {
  const payload = {
    schema: 'easyaiconfig.sync-manifest.v1',
    updatedAt: new Date().toISOString(),
    latestSnapshotId: manifest.latestSnapshotId || '',
    snapshots: Array.isArray(manifest.snapshots) ? manifest.snapshots : [],
  };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(syncManifestPath(root), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export async function listSyncTargets(options = {}) {
  const configPath = path.resolve(String(options.configPath || syncTargetsPath()));
  const configuredTargets = (await readConfiguredTargets(configPath)).map(normalizeConfiguredTarget);
  const detectedTargets = [
    ...builtInTargets(),
    ...await discoverOneDriveTargets(),
    ...await discoverNasTargets(),
  ];
  const byId = new Map();
  for (const target of detectedTargets) byId.set(target.id, target);
  for (const target of configuredTargets) byId.set(target.id, target);
  const targets = [];
  for (const target of byId.values()) {
    targets.push(await materializeTarget(target, { includeSecrets: Boolean(options.includeSecrets) }));
  }
  return {
    schema: 'easyaiconfig.sync-targets.v1',
    generatedAt: new Date().toISOString(),
    configPath,
    targets,
    summary: {
      targets: targets.length,
      ready: targets.filter((target) => target.ready).length,
      configured: targets.filter((target) => target.configured).length,
      detected: targets.filter((target) => target.detected).length,
      byType: targets.reduce((acc, target) => {
        acc[target.type] = (acc[target.type] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

export async function listSyncSnapshots(input = {}, options = {}) {
  const targetId = String(input.targetId || input.id || '').trim();
  if (!targetId && !input.targetPath && !input.path) {
    const inventory = await listSyncTargets(options);
    const targets = [];
    for (const target of inventory.targets) {
      if (target.type === 'webdav') {
        let manifest = null;
        let readError = '';
        try {
          manifest = await readWebDavManifestAt(target);
        } catch (error) {
          readError = error instanceof Error ? error.message : String(error);
        }
        targets.push({
          target: publicSyncTarget(target),
          manifest,
          readError,
          summary: {
            snapshots: manifest?.snapshots?.length || 0,
            latestSnapshotId: manifest?.latestSnapshotId || '',
            latestPushedAt: manifest?.snapshots?.[0]?.pushedAt || '',
          },
        });
        continue;
      }
      if (!target.path) {
        targets.push({
          target: publicSyncTarget(target),
          manifest: null,
          readError: '',
          summary: { snapshots: 0, latestSnapshotId: '', latestPushedAt: '' },
        });
        continue;
      }
      let manifest = null;
      let readError = '';
      try {
        manifest = await readSyncManifestAt(target.path);
      } catch (error) {
        readError = error instanceof Error ? error.message : String(error);
      }
      targets.push({
        target: publicSyncTarget(target),
        manifest,
        readError,
        summary: {
          snapshots: manifest?.snapshots?.length || 0,
          latestSnapshotId: manifest?.latestSnapshotId || '',
          latestPushedAt: manifest?.snapshots?.[0]?.pushedAt || '',
        },
      });
    }
    return {
      schema: 'easyaiconfig.sync-snapshots.v1',
      generatedAt: new Date().toISOString(),
      targets,
      summary: {
        targets: targets.length,
        snapshots: targets.reduce((sum, item) => sum + Number(item.summary.snapshots || 0), 0),
        readable: targets.filter((item) => item.manifest && !item.readError).length,
      },
    };
  }

  const target = await resolveSyncTarget(input, options);
  assertSyncTarget(target);
  const manifest = target.type === 'webdav'
    ? await readWebDavManifestAt(target)
    : await readSyncManifestAt(target.path);
  return {
    schema: 'easyaiconfig.sync-snapshots.v1',
    generatedAt: new Date().toISOString(),
    target: publicSyncTarget(target),
    manifest,
    snapshots: manifest.snapshots,
    summary: {
      snapshots: manifest.snapshots.length,
      latestSnapshotId: manifest.latestSnapshotId || '',
      latestPushedAt: manifest.snapshots[0]?.pushedAt || '',
    },
  };
}

export async function pushSyncSnapshot(input = {}, options = {}) {
  const dryRun = input.dryRun !== false;
  const bundle = input.bundle && typeof input.bundle === 'object' ? input.bundle : null;
  if (!bundle) throw new Error('bundle is required');
  if (bundle.schema !== 'easyaiconfig.asset-bundle.v1') {
    throw new Error('Only easyaiconfig.asset-bundle.v1 can be synced');
  }
  const target = await resolveSyncTarget(input, options);
  assertSyncTarget(target);

  const snapshotId = safeSnapshotId(input.snapshotId) || defaultSnapshotId(bundle);
  const fileName = `${snapshotId}.json`;
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  if (target.type === 'webdav') {
    const snapshotUrl = webDavUrl(target, 'snapshots', fileName);
    const manifestUrl = webDavUrl(target, 'manifest.json');
    const entry = {
      id: snapshotId,
      fileName,
      url: snapshotUrl,
      label: String(input.label || '').trim(),
      pushedAt: new Date().toISOString(),
      bundleSchema: bundle.schema,
      app: bundle.app || 'EasyAIConfig',
      version: bundle.version || 1,
      exportedAt: bundle.exportedAt || '',
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: sha256Text(text),
      counts: bundleSummary(bundle),
    };
    if (!dryRun) {
      await ensureWebDavCollection(target, []);
      await ensureWebDavCollection(target, ['snapshots']);
      await webDavRequest(target, snapshotUrl, {
        method: 'PUT',
        body: text,
        headers: { 'Content-Type': 'application/json' },
        okStatuses: [200, 201, 204],
      });
      const manifest = await readWebDavManifestAt(target);
      const nextSnapshots = [entry, ...manifest.snapshots.filter((item) => item.id !== snapshotId)].slice(0, 50);
      await writeWebDavManifestAt(target, {
        latestSnapshotId: snapshotId,
        snapshots: nextSnapshots,
      });
    }
    return {
      schema: 'easyaiconfig.sync-push.v1',
      dryRun,
      changed: !dryRun,
      target: publicSyncTarget(target),
      entry,
      operations: [{
        action: 'push-sync-snapshot',
        dryRun,
        targetUrl: target.url,
        snapshotUrl,
        manifestUrl,
        willCreateTargetDirectory: false,
      }],
      summary: {
        pushed: dryRun ? 0 : 1,
        previewed: dryRun ? 1 : 0,
        bytes: entry.bytes,
      },
    };
  }

  const parentState = await parentPathState(target.path);
  if (!target.exists && !parentState.exists) {
    throw new Error('Sync target parent directory does not exist');
  }
  if (target.exists && !target.writable) {
    throw new Error('Sync target is not writable');
  }
  if (!target.exists && !parentState.writable) {
    throw new Error('Sync target parent directory is not writable');
  }

  const snapshotPath = path.join(syncSnapshotsRoot(target.path), fileName);
  const entry = {
    id: snapshotId,
    fileName,
    path: snapshotPath,
    label: String(input.label || '').trim(),
    pushedAt: new Date().toISOString(),
    bundleSchema: bundle.schema,
    app: bundle.app || 'EasyAIConfig',
    version: bundle.version || 1,
    exportedAt: bundle.exportedAt || '',
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: sha256Text(text),
    counts: bundleSummary(bundle),
  };
  if (!dryRun) {
    await fs.mkdir(syncSnapshotsRoot(target.path), { recursive: true });
    await fs.writeFile(snapshotPath, text, 'utf8');
    const manifest = await readSyncManifestAt(target.path);
    const nextSnapshots = [entry, ...manifest.snapshots.filter((item) => item.id !== snapshotId)].slice(0, 50);
    await writeSyncManifestAt(target.path, {
      latestSnapshotId: snapshotId,
      snapshots: nextSnapshots,
    });
  }
  return {
    schema: 'easyaiconfig.sync-push.v1',
    dryRun,
    changed: !dryRun,
    target: publicSyncTarget(target),
    entry,
    operations: [{
      action: 'push-sync-snapshot',
      dryRun,
      targetPath: target.path,
      snapshotPath,
      manifestPath: syncManifestPath(target.path),
      willCreateTargetDirectory: !target.exists,
    }],
    summary: {
      pushed: dryRun ? 0 : 1,
      previewed: dryRun ? 1 : 0,
      bytes: entry.bytes,
    },
  };
}

export async function readSyncSnapshot(input = {}, options = {}) {
  const target = await resolveSyncTarget(input, options);
  assertSyncTarget(target);
  const manifest = target.type === 'webdav'
    ? await readWebDavManifestAt(target)
    : await readSyncManifestAt(target.path);
  const requestedId = String(input.snapshotId || input.id || manifest.latestSnapshotId || '').trim();
  if (!requestedId) throw new Error('snapshotId is required');
  const entry = manifest.snapshots.find((item) => item.id === requestedId);
  if (!entry) throw new Error(`Sync snapshot not found: ${requestedId}`);
  if (target.type === 'webdav') {
    const snapshotUrl = entry.url || webDavUrl(target, 'snapshots', entry.fileName || `${requestedId}.json`);
    if (!webDavSnapshotUrlInsideRoot(target, snapshotUrl)) {
      throw new Error('Sync snapshot URL is outside target root');
    }
    const response = await webDavRequest(target, snapshotUrl, { method: 'GET' });
    const raw = await response.text();
    const sha256 = sha256Text(raw);
    if (entry.sha256 && entry.sha256 !== sha256) {
      throw new Error('Sync snapshot checksum mismatch');
    }
    const bundle = JSON.parse(raw);
    return {
      schema: 'easyaiconfig.sync-pull.v1',
      generatedAt: new Date().toISOString(),
      target: publicSyncTarget(target),
      entry: {
        ...entry,
        url: snapshotUrl,
        exists: true,
        sha256,
        bytes: Buffer.byteLength(raw, 'utf8'),
      },
      bundle,
      summary: {
        bytes: Buffer.byteLength(raw, 'utf8'),
        counts: bundleSummary(bundle),
      },
    };
  }

  const snapshotPath = path.resolve(String(entry.path || path.join(syncSnapshotsRoot(target.path), entry.fileName || `${requestedId}.json`)));
  const root = path.resolve(target.path);
  if (!(snapshotPath === root || snapshotPath.startsWith(root + path.sep))) {
    throw new Error('Sync snapshot path is outside target root');
  }
  const raw = await fs.readFile(snapshotPath, 'utf8');
  const sha256 = sha256Text(raw);
  if (entry.sha256 && entry.sha256 !== sha256) {
    throw new Error('Sync snapshot checksum mismatch');
  }
  const bundle = JSON.parse(raw);
  return {
    schema: 'easyaiconfig.sync-pull.v1',
    generatedAt: new Date().toISOString(),
    target: publicSyncTarget(target),
    entry: {
      ...entry,
      exists: true,
      sha256,
      bytes: Buffer.byteLength(raw, 'utf8'),
    },
    bundle,
    summary: {
      bytes: Buffer.byteLength(raw, 'utf8'),
      counts: bundleSummary(bundle),
    },
  };
}

export async function saveSyncTargets(payload = {}, options = {}) {
  const configPath = path.resolve(String(options.configPath || syncTargetsPath()));
  const targets = (Array.isArray(payload.targets) ? payload.targets : [])
    .map(normalizeConfiguredTarget)
    .filter((target) => target.id && (target.path || target.url));
  const next = {
    schema: 'easyaiconfig.sync-targets.v1',
    updatedAt: new Date().toISOString(),
    targets,
  };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return {
    ...next,
    configPath,
    targets: targets.map(publicSyncTarget),
  };
}
