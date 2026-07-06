import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { buildAssetImportDeepLink } from '../src/lib/provider-catalog.js';
import {
  applyMcpImport,
  extractMcpImportItems,
  listMcpInventory,
  planMcpSync,
  previewMcpImport,
} from '../src/lib/mcp-manager.js';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyaiconfig-mcp-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('listMcpInventory reads Codex, Claude, Gemini, Qwen, CodeBuddy, and OpenCode MCP servers', async () => {
  await withTempDir(async (dir) => {
    const codexHome = path.join(dir, 'codex');
    const claudeSettingsPath = path.join(dir, 'claude', 'settings.json');
    const claudeDesktopConfigPath = path.join(dir, 'Claude', 'claude_desktop_config.json');
    const openCodeConfigPath = path.join(dir, 'opencode', 'opencode.json');
    const geminiSettingsPath = path.join(dir, 'gemini', 'settings.json');
    const qwenSettingsPath = path.join(dir, 'qwen', 'settings.json');
    const codeBuddyMcpPath = path.join(dir, 'codebuddy', '.mcp.json');

    await fs.mkdir(codexHome, { recursive: true });
    await fs.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
    await fs.mkdir(path.dirname(claudeDesktopConfigPath), { recursive: true });
    await fs.mkdir(path.dirname(openCodeConfigPath), { recursive: true });
    await fs.mkdir(path.dirname(geminiSettingsPath), { recursive: true });
    await fs.mkdir(path.dirname(qwenSettingsPath), { recursive: true });
    await fs.mkdir(path.dirname(codeBuddyMcpPath), { recursive: true });

    await fs.writeFile(path.join(codexHome, 'config.toml'), `
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

[mcp_servers.github]
command = "node"

[mcp_servers.github.env]
GITHUB_TOKEN = "secret"
`);
    await fs.writeFile(claudeSettingsPath, JSON.stringify({
      mcpServers: {
        browser: { command: 'npx', args: ['@playwright/mcp'] },
      },
    }, null, 2));
    await fs.writeFile(claudeDesktopConfigPath, JSON.stringify({
      mcpServers: {
        memory: { command: 'memory-server', disabled: true },
      },
    }, null, 2));
    await fs.writeFile(openCodeConfigPath, `{
      // JSONC comments are allowed here.
      "mcp": {
        "docs": { "command": "mcp-docs", "args": ["serve"] }
      }
    }`);
    await fs.writeFile(geminiSettingsPath, JSON.stringify({
      mcpServers: {
        search: { url: 'https://example.com/mcp' },
      },
    }, null, 2));
    await fs.writeFile(qwenSettingsPath, JSON.stringify({
      mcpServers: {
        qwenfs: { command: 'qwen-mcp', args: ['serve'] },
      },
    }, null, 2));
    await fs.writeFile(codeBuddyMcpPath, JSON.stringify({
      mcpServers: {
        buddy: { command: 'codebuddy-mcp' },
      },
    }, null, 2));

    const inventory = await listMcpInventory({
      codexHome,
      claudeSettingsPath,
      claudeDesktopConfigPath,
      openCodeConfigPath,
      geminiSettingsPath,
      qwenSettingsPath,
      codeBuddyMcpPath,
    });

    assert.equal(inventory.schema, 'easyaiconfig.mcp-inventory.v1');
    assert.equal(inventory.summary.sources, 7);
    assert.equal(inventory.summary.existingSources, 7);
    assert.equal(inventory.summary.parseErrors, 0);
    assert.equal(inventory.summary.servers, 8);
    assert.equal(inventory.summary.tools.codex, 2);
    assert.equal(inventory.summary.tools.claudecode, 1);
    assert.equal(inventory.summary.tools.claudedesktop, 1);
    assert.equal(inventory.summary.tools.opencode, 1);
    assert.equal(inventory.summary.tools.gemini, 1);
    assert.equal(inventory.summary.tools['qwen-code'], 1);
    assert.equal(inventory.summary.tools['codebuddy-code'], 1);

    const github = inventory.servers.find((server) => server.id === 'github');
    assert.equal(github.command, 'node');
    assert.deepEqual(github.envKeys, ['GITHUB_TOKEN']);

    const memory = inventory.servers.find((server) => server.id === 'memory');
    assert.equal(memory.disabled, true);
    const search = inventory.servers.find((server) => server.id === 'search');
    assert.equal(search.transport, 'http');
  });
});

test('listMcpInventory reports parse errors per source without failing inventory', async () => {
  await withTempDir(async (dir) => {
    const codexHome = path.join(dir, 'codex');
    const claudeSettingsPath = path.join(dir, 'settings.json');
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, 'config.toml'), '');
    await fs.writeFile(claudeSettingsPath, '{ bad json');

    const inventory = await listMcpInventory({
      codexHome,
      claudeSettingsPath,
      claudeDesktopConfigPath: path.join(dir, 'missing-desktop.json'),
      openCodeConfigPath: path.join(dir, 'missing-opencode.json'),
      geminiSettingsPath: path.join(dir, 'missing-gemini.json'),
      qwenSettingsPath: path.join(dir, 'missing-qwen.json'),
      codeBuddyMcpPath: path.join(dir, 'missing-codebuddy.json'),
    });

    assert.equal(inventory.summary.parseErrors, 1);
    assert.equal(inventory.summary.servers, 0);
    assert.match(inventory.sources.find((source) => source.tool === 'claudecode').parseError, /parse failed/);
  });
});

test('planMcpSync proposes preview-only copy operations and detects conflicts', async () => {
  await withTempDir(async (dir) => {
    const codexHome = path.join(dir, 'codex');
    const claudeSettingsPath = path.join(dir, 'claude', 'settings.json');
    const claudeDesktopConfigPath = path.join(dir, 'Claude', 'claude_desktop_config.json');
    const openCodeConfigPath = path.join(dir, 'opencode', 'opencode.json');

    await fs.mkdir(codexHome, { recursive: true });
    await fs.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
    await fs.mkdir(path.dirname(claudeDesktopConfigPath), { recursive: true });
    await fs.mkdir(path.dirname(openCodeConfigPath), { recursive: true });

    await fs.writeFile(path.join(codexHome, 'config.toml'), `
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

[mcp_servers.conflict]
command = "node"
`);
    await fs.writeFile(claudeSettingsPath, JSON.stringify({
      mcpServers: {
        conflict: { command: 'python' },
      },
    }, null, 2));
    await fs.writeFile(claudeDesktopConfigPath, JSON.stringify({ mcpServers: {} }, null, 2));
    await fs.writeFile(openCodeConfigPath, JSON.stringify({ mcp: {} }, null, 2));

    const plan = await planMcpSync({
      codexHome,
      claudeSettingsPath,
      claudeDesktopConfigPath,
      openCodeConfigPath,
      geminiSettingsPath: path.join(dir, 'missing-gemini.json'),
      qwenSettingsPath: path.join(dir, 'missing-qwen.json'),
      codeBuddyMcpPath: path.join(dir, 'missing-codebuddy.json'),
    });

    assert.equal(plan.schema, 'easyaiconfig.mcp-sync-plan.v1');
    assert.ok(plan.operations.some((operation) => (
      operation.type === 'copy-mcp-server' &&
      operation.serverId === 'filesystem' &&
      operation.to.tool === 'claudecode' &&
      operation.previewOnly === true
    )));
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].serverId, 'conflict');
  });
});

test('MCP import preview accepts asset bundles and protects existing servers by default', async () => {
  await withTempDir(async (dir) => {
    const claudeSettingsPath = path.join(dir, 'claude', 'settings.json');
    await fs.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
    await fs.writeFile(claudeSettingsPath, JSON.stringify({
      hooks: { Stop: [] },
      mcpServers: {
        filesystem: { command: 'old-fs', args: ['/old'] },
      },
    }, null, 2));

    const payload = {
      schema: 'easyaiconfig.asset-bundle.v1',
      app: 'EasyAIConfig',
      assets: {
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            env: { FILESYSTEM_TOKEN: 'secret-value' },
            tools: ['claudecode'],
          },
          browser: {
            command: 'npx',
            args: ['@playwright/mcp'],
            tools: ['claudecode'],
          },
        },
      },
    };

    const extracted = extractMcpImportItems({ payload }, { targetTool: 'claudecode' });
    assert.equal(extracted.totalServers, 2);
    assert.deepEqual(extracted.servers.map((server) => server.serverId), ['filesystem', 'browser']);

    const preview = await previewMcpImport({ url: buildAssetImportDeepLink(payload) }, {
      targetTool: 'claudecode',
      claudeSettingsPath,
    });

    assert.equal(preview.schema, 'easyaiconfig.mcp-import-preview.v1');
    assert.equal(preview.summary.totalServers, 2);
    assert.equal(preview.summary.created, 1);
    assert.equal(preview.summary.conflicts, 1);
    assert.equal(preview.summary.written, false);
    assert.equal(preview.operations.find((operation) => operation.serverId === 'filesystem').action, 'conflict');
    assert.deepEqual(
      preview.operations.find((operation) => operation.serverId === 'filesystem').server.envKeys,
      ['FILESYSTEM_TOKEN'],
    );
    assert.equal(JSON.stringify(preview).includes('secret-value'), false);
  });
});

test('MCP import apply defaults to dry-run and writes Codex TOML with backups when explicit', async () => {
  await withTempDir(async (dir) => {
    const codexHome = path.join(dir, 'codex');
    const backupsRoot = path.join(dir, 'backups');
    await fs.mkdir(codexHome, { recursive: true });
    const configPath = path.join(codexHome, 'config.toml');
    const payload = {
      schema: 'easyaiconfig.asset-bundle.v1',
      assets: {
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
      },
    };

    const dryRun = await applyMcpImport({ payload }, { codexHome, backupsRoot, targetTool: 'codex' });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.summary.created, 1);
    assert.equal(dryRun.summary.written, false);
    await assert.rejects(() => fs.readFile(configPath, 'utf8'), /ENOENT/);

    const applied = await applyMcpImport(
      { payload, dryRun: false },
      { codexHome, backupsRoot, targetTool: 'codex' },
    );
    assert.equal(applied.dryRun, false);
    assert.equal(applied.summary.created, 1);
    assert.equal(applied.summary.written, true);
    assert.ok(applied.backupPath);

    const config = TOML.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(config.mcp_servers.filesystem.command, 'npx');
    assert.deepEqual(config.mcp_servers.filesystem.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
    const manifest = JSON.parse(await fs.readFile(path.join(applied.backupPath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schema, 'easyaiconfig.mcp-backup.v1');
    assert.equal(manifest.files[0].existed, false);
  });
});

test('MCP import supports overwrite while preserving unknown JSON config fields', async () => {
  await withTempDir(async (dir) => {
    const claudeSettingsPath = path.join(dir, 'claude', 'settings.json');
    const backupsRoot = path.join(dir, 'backups');
    await fs.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
    await fs.writeFile(claudeSettingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '*', hooks: [] }] },
      statusLine: { type: 'command', command: 'echo ok' },
      mcpServers: {
        filesystem: { command: 'old-fs', args: ['/old'] },
      },
    }, null, 2));

    const payload = {
      schema: 'easyaiconfig.asset-bundle.v1',
      assets: {
        mcpServers: {
          filesystem: { command: 'new-fs', args: ['/new'] },
          memory: { command: 'memory-server' },
        },
      },
    };

    const protectedResult = await applyMcpImport(
      { payload, dryRun: false },
      { claudeSettingsPath, backupsRoot, targetTool: 'claudecode' },
    );
    assert.equal(protectedResult.summary.conflicts, 1);
    assert.equal(protectedResult.summary.created, 1);
    assert.equal(protectedResult.summary.written, true);
    let settings = JSON.parse(await fs.readFile(claudeSettingsPath, 'utf8'));
    assert.equal(settings.mcpServers.filesystem.command, 'old-fs');
    assert.equal(settings.mcpServers.memory.command, 'memory-server');
    assert.deepEqual(settings.hooks, { PreToolUse: [{ matcher: '*', hooks: [] }] });
    assert.equal(settings.statusLine.command, 'echo ok');

    const overwritten = await applyMcpImport(
      { payload, dryRun: false },
      { claudeSettingsPath, backupsRoot, targetTool: 'claudecode', overwrite: true },
    );
    assert.equal(overwritten.summary.updated, 1);
    assert.equal(overwritten.summary.unchanged, 1);
    settings = JSON.parse(await fs.readFile(claudeSettingsPath, 'utf8'));
    assert.equal(settings.mcpServers.filesystem.command, 'new-fs');
    assert.equal(settings.statusLine.command, 'echo ok');
    const manifest = JSON.parse(await fs.readFile(path.join(overwritten.backupPath, 'manifest.json'), 'utf8'));
    const backupCopy = manifest.files[0].backupPath;
    assert.match(await fs.readFile(backupCopy, 'utf8'), /old-fs/);
  });
});
