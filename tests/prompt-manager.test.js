import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAssetImportDeepLink } from '../src/lib/provider-catalog.js';
import {
  applyPromptImport,
  extractPromptImportItems,
  listPromptInventory,
  previewPromptImport,
} from '../src/lib/prompt-manager.js';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyaiconfig-prompts-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('listPromptInventory reads global and project prompt files', async () => {
  await withTempDir(async (dir) => {
    const projectPath = path.join(dir, 'project');
    const globalCodex = path.join(dir, 'global-codex', 'AGENTS.md');
    const globalClaude = path.join(dir, 'global-claude', 'CLAUDE.md');
    const globalGemini = path.join(dir, 'global-gemini', 'GEMINI.md');
    const globalQwen = path.join(dir, 'global-qwen', 'QWEN.md');
    const globalCodeBuddy = path.join(dir, 'global-codebuddy', 'CODEBUDDY.md');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(path.dirname(globalCodex), { recursive: true });
    await fs.mkdir(path.dirname(globalClaude), { recursive: true });
    await fs.mkdir(path.dirname(globalGemini), { recursive: true });
    await fs.mkdir(path.dirname(globalQwen), { recursive: true });
    await fs.mkdir(path.dirname(globalCodeBuddy), { recursive: true });

    await fs.writeFile(globalCodex, '# Global Agents\n\nUse safe edits.');
    await fs.writeFile(globalClaude, '# Claude Rules\n\nPrefer concise answers.');
    await fs.writeFile(globalGemini, '');
    await fs.writeFile(globalQwen, '# Qwen Rules\n\nUse Qwen context.');
    await fs.writeFile(path.join(projectPath, 'AGENTS.md'), '# Project Agents\n\nProject-specific rules.');
    await fs.writeFile(path.join(projectPath, 'GEMINI.md'), '# Gemini Project\n\nGemini rules.');
    await fs.writeFile(path.join(projectPath, 'CODEBUDDY.md'), '# CodeBuddy Project\n\nCodeBuddy rules.');

    const inventory = await listPromptInventory({
      projectPath,
      globalPaths: {
        'codex-agents': globalCodex,
        'claude-code': globalClaude,
        gemini: globalGemini,
        'qwen-code': globalQwen,
        'codebuddy-code': globalCodeBuddy,
      },
    });

    assert.equal(inventory.schema, 'easyaiconfig.prompt-inventory.v1');
    assert.equal(inventory.summary.files, 10);
    assert.equal(inventory.summary.existing, 6);
    assert.equal(inventory.summary.globalFiles, 3);
    assert.equal(inventory.summary.projectFiles, 3);
    assert.equal(inventory.summary.tools.codex, 2);
    assert.equal(inventory.summary.tools.claudecode, 1);
    assert.equal(inventory.summary.tools.gemini, 1);
    assert.equal(inventory.summary.tools['qwen-code'], 1);
    assert.equal(inventory.summary.tools['codebuddy-code'], 1);

    const projectAgents = inventory.files.find((file) => file.id === 'codex-agents:project');
    assert.equal(projectAgents.title, 'Project Agents');
    assert.match(projectAgents.preview, /Project-specific rules/);
    assert.equal(projectAgents.sha256.length, 64);

    const missingProjectClaude = inventory.files.find((file) => file.id === 'claude-code:project');
    assert.equal(missingProjectClaude.exists, false);
  });
});

test('listPromptInventory can run without a project path', async () => {
  await withTempDir(async (dir) => {
    const globalCodex = path.join(dir, 'AGENTS.md');
    await fs.writeFile(globalCodex, '# Only Global');
    const inventory = await listPromptInventory({
      globalPaths: {
        'codex-agents': globalCodex,
        'claude-code': path.join(dir, 'missing-claude.md'),
        gemini: path.join(dir, 'missing-gemini.md'),
        'qwen-code': path.join(dir, 'missing-qwen.md'),
        'codebuddy-code': path.join(dir, 'missing-codebuddy.md'),
      },
    });

    assert.equal(inventory.summary.files, 5);
    assert.equal(inventory.summary.existing, 1);
    assert.equal(inventory.projectPath, '');
  });
});

test('prompt import preview accepts asset bundles and protects existing prompt files by default', async () => {
  await withTempDir(async (dir) => {
    const projectPath = path.join(dir, 'project');
    const globalClaude = path.join(dir, 'global-claude', 'CLAUDE.md');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(path.dirname(globalClaude), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'AGENTS.md'), '# Existing Agents\n\nKeep this.');

    const payload = {
      schema: 'easyaiconfig.asset-bundle.v1',
      app: 'EasyAIConfig',
      assets: {
        prompts: [
          { id: 'codex-agents', scope: 'project', content: '# Project Agents\n\nUse safe edits.' },
          { tool: 'gemini', scope: 'project', content: '# Gemini Project\n\nUse repo context.' },
          { fileName: 'CLAUDE.md', scope: 'global', content: '# Claude Rules\n\nPrefer short answers.' },
        ],
      },
    };

    const extracted = extractPromptImportItems({ payload }, { projectPath });
    assert.equal(extracted.totalPrompts, 3);
    assert.deepEqual(extracted.prompts.map((item) => `${item.promptId}:${item.scope}`), [
      'codex-agents:project',
      'gemini:project',
      'claude-code:global',
    ]);

    const link = buildAssetImportDeepLink(payload);
    const preview = await previewPromptImport({ url: link }, {
      projectPath,
      globalPaths: {
        'claude-code': globalClaude,
      },
    });

    assert.equal(preview.schema, 'easyaiconfig.prompt-import-preview.v1');
    assert.equal(preview.summary.totalPrompts, 3);
    assert.equal(preview.summary.conflicts, 1);
    assert.equal(preview.summary.created, 2);
    assert.equal(preview.summary.written, false);
    assert.equal(preview.operations.find((item) => item.promptId === 'codex-agents').action, 'conflict');
    assert.ok(preview.operations.every((item) => !Object.hasOwn(item, 'nextContent')));
  });
});

test('prompt import apply defaults to dry-run and writes with backups when explicitly applied', async () => {
  await withTempDir(async (dir) => {
    const projectPath = path.join(dir, 'project');
    const backupsRoot = path.join(dir, 'backups');
    await fs.mkdir(projectPath, { recursive: true });
    const geminiPath = path.join(projectPath, 'GEMINI.md');
    const payload = {
      schema: 'easyaiconfig.asset-bundle.v1',
      assets: {
        prompts: [
          { id: 'gemini', scope: 'project', content: '# Gemini Project\n\nUse repo context.' },
        ],
      },
    };

    const dryRun = await applyPromptImport({ payload }, { projectPath, backupsRoot });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.summary.created, 1);
    assert.equal(dryRun.summary.written, false);
    await assert.rejects(() => fs.readFile(geminiPath, 'utf8'), /ENOENT/);

    const applied = await applyPromptImport({ payload, dryRun: false }, { projectPath, backupsRoot });
    assert.equal(applied.dryRun, false);
    assert.equal(applied.summary.created, 1);
    assert.equal(applied.summary.written, true);
    assert.ok(applied.backupPath);
    assert.match(await fs.readFile(geminiPath, 'utf8'), /Use repo context/);
    const manifest = JSON.parse(await fs.readFile(path.join(applied.backupPath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schema, 'easyaiconfig.prompt-backup.v1');
    assert.equal(manifest.files[0].existed, false);
  });
});

test('prompt import supports overwrite, append, and sha256 backfill protection', async () => {
  await withTempDir(async (dir) => {
    const projectPath = path.join(dir, 'project');
    const backupsRoot = path.join(dir, 'backups');
    const agentsPath = path.join(projectPath, 'AGENTS.md');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(agentsPath, '# Old Agents\n\nKeep original.');

    const overwritePayload = {
      schema: 'easyaiconfig.asset-bundle.v1',
      assets: {
        prompts: [
          { id: 'codex-agents', scope: 'project', content: '# New Agents\n\nUse safe edits.' },
        ],
      },
    };

    const protectedResult = await applyPromptImport(
      { payload: overwritePayload, dryRun: false },
      { projectPath, backupsRoot },
    );
    assert.equal(protectedResult.summary.conflicts, 1);
    assert.equal(protectedResult.summary.written, false);
    assert.match(await fs.readFile(agentsPath, 'utf8'), /Keep original/);

    const overwritten = await applyPromptImport(
      { payload: overwritePayload, dryRun: false },
      { projectPath, backupsRoot, overwrite: true },
    );
    assert.equal(overwritten.summary.updated, 1);
    assert.equal(overwritten.summary.written, true);
    const backupManifest = JSON.parse(await fs.readFile(path.join(overwritten.backupPath, 'manifest.json'), 'utf8'));
    const backupCopy = backupManifest.files[0].backupPath;
    assert.match(await fs.readFile(backupCopy, 'utf8'), /Old Agents/);
    assert.match(await fs.readFile(agentsPath, 'utf8'), /New Agents/);

    const appendPayload = {
      schema: 'easyaiconfig.asset-bundle.v1',
      assets: {
        prompts: [
          { id: 'codex-agents', scope: 'project', content: '# Extra Rules\n\nNever overwrite silently.' },
        ],
      },
    };
    const appended = await applyPromptImport(
      { payload: appendPayload, dryRun: false },
      { projectPath, backupsRoot, append: true },
    );
    assert.equal(appended.summary.appended, 1);
    assert.match(await fs.readFile(agentsPath, 'utf8'), /Extra Rules/);

    const duplicateAppend = await applyPromptImport(
      { payload: appendPayload, dryRun: false },
      { projectPath, backupsRoot, append: true },
    );
    assert.equal(duplicateAppend.summary.unchanged, 1);
    assert.equal(duplicateAppend.summary.written, false);

    const preview = await previewPromptImport({ payload: overwritePayload }, { projectPath, overwrite: true });
    const currentSha = preview.operations[0].currentSha256;
    await fs.writeFile(agentsPath, '# User Changed\n\nDo not clobber.');
    const stale = await applyPromptImport(
      {
        payload: overwritePayload,
        dryRun: false,
        expectedSha256ByPath: { [agentsPath]: currentSha },
      },
      { projectPath, backupsRoot, overwrite: true },
    );
    assert.equal(stale.summary.stale, 1);
    assert.equal(stale.summary.written, false);
    assert.match(await fs.readFile(agentsPath, 'utf8'), /User Changed/);
  });
});
