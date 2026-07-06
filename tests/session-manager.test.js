import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  archiveSession,
  listSessionInventory,
  listSessionTrash,
  restoreSession,
} from '../src/lib/session-manager.js';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyaiconfig-sessions-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('listSessionInventory reads verified Codex and Claude Code sessions with provider project groups', async () => {
  await withTempDir(async (dir) => {
    const codexHome = path.join(dir, 'codex');
    const claudeHome = path.join(dir, 'claude');
    const projectAlpha = path.join(dir, 'project-alpha');

    await fs.mkdir(path.join(codexHome, 'sessions', '2026', '07'), { recursive: true });
    await fs.mkdir(path.join(claudeHome, 'projects', 'project-alpha'), { recursive: true });

    await fs.writeFile(path.join(codexHome, 'sessions', '2026', '07', 'session-codex.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-alpha', cwd: projectAlpha, model_provider: 'openai', model: 'gpt-5' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Build alpha feature' } }),
    ].join('\n'));

    await fs.writeFile(path.join(claudeHome, 'projects', 'project-alpha', 'claude-alpha.jsonl'), [
      JSON.stringify({ timestamp: '2026-07-04T10:00:00.000Z', cwd: projectAlpha, message: { role: 'user', content: 'Fix alpha regression' } }),
      JSON.stringify({ timestamp: '2026-07-04T10:01:00.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-20250514', content: 'done' } }),
    ].join('\n'));

    const inventory = await listSessionInventory({
      codexHome,
      claudeHome,
      includeTools: ['codex', 'claudecode'],
      limit: 10,
    });

    assert.equal(inventory.schema, 'easyaiconfig.session-inventory.v1');
    assert.equal(inventory.summary.sources, 2);
    assert.equal(inventory.summary.existingSources, 2);
    assert.equal(inventory.summary.sessions, 2);
    assert.equal(inventory.summary.tools.codex, 1);
    assert.equal(inventory.summary.tools.claudecode, 1);

    const providers = new Set(inventory.groups.map((group) => group.provider));
    assert.ok(providers.has('openai'));
    assert.ok(providers.has('anthropic'));

    const codex = inventory.items.find((item) => item.tool === 'codex');
    assert.equal(codex.actions.resume, true);
    assert.equal(codex.projectPath, projectAlpha);
  });
});

test('listSessionInventory filters sessions by search query', async () => {
  await withTempDir(async (dir) => {
    const codexHome = path.join(dir, 'codex');
    await fs.mkdir(path.join(codexHome, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(codexHome, 'sessions', 'alpha.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'alpha', cwd: dir, model_provider: 'openai', model: 'gpt-5' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Alpha only task' } }),
    ].join('\n'));
    await fs.writeFile(path.join(codexHome, 'sessions', 'beta.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'beta', cwd: dir, model_provider: 'openai', model: 'gpt-5' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Beta only task' } }),
    ].join('\n'));

    const inventory = await listSessionInventory({
      codexHome,
      includeTools: ['codex'],
      query: 'alpha',
    });

    assert.equal(inventory.summary.sessions, 1);
    assert.equal(inventory.items[0].sessionId, 'alpha');
  });
});

test('listSessionInventory exposes verified local usage sources as read-only sessions', async () => {
  await withTempDir(async (dir) => {
    const droidDir = path.join(dir, 'factory-sessions');
    await fs.mkdir(droidDir, { recursive: true });
    await fs.writeFile(path.join(droidDir, 'droid-alpha.settings.json'), JSON.stringify({
      providerLock: 'anthropic',
      providerLockTimestamp: '2026-07-04T12:00:00.000Z',
      model: 'custom:claude-sonnet-4-20250514[anthropic]-1',
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 40,
        cacheCreationTokens: 10,
        cacheReadTokens: 20,
        thinkingTokens: 5,
        totalTokens: 175,
      },
    }));

    const inventory = await listSessionInventory({
      includeTools: ['droid'],
      droidSessionsDir: droidDir,
      limit: 10,
    });

    assert.equal(inventory.summary.sources, 1);
    assert.equal(inventory.summary.existingSources, 1);
    assert.equal(inventory.summary.sessions, 1);
    assert.equal(inventory.summary.tools.droid, 1);
    assert.equal(inventory.items[0].tool, 'droid');
    assert.equal(inventory.items[0].totals.total, 175);
    assert.equal(inventory.items[0].actions.delete, false);
    assert.equal(inventory.items[0].actions.resume, false);
  });
});

test('archiveSession moves file sessions to restorable trash and restoreSession copies them back', async () => {
  await withTempDir(async (dir) => {
    const claudeHome = path.join(dir, 'claude');
    const trashRoot = path.join(dir, 'trash');
    const sessionDir = path.join(claudeHome, 'projects', 'project-alpha');
    const sessionPath = path.join(sessionDir, 'claude-restore.jsonl');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(sessionPath, [
      JSON.stringify({ timestamp: '2026-07-05T12:00:00.000Z', cwd: dir, message: { role: 'user', content: 'Restore this' } }),
    ].join('\n'));

    const inventory = await listSessionInventory({
      claudeHome,
      includeTools: ['claudecode'],
      limit: 10,
    });
    assert.equal(inventory.items[0].actions.delete, true);

    const preview = await archiveSession({
      tool: 'claudecode',
      sourcePath: sessionPath,
      sessionId: 'claude-restore',
    }, { claudeHome, trashRoot });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.summary.previewed, 1);
    assert.ok(await fs.access(sessionPath).then(() => true, () => false));

    const archived = await archiveSession({
      tool: 'claudecode',
      sourcePath: sessionPath,
      sessionId: 'claude-restore',
      dryRun: false,
    }, { claudeHome, trashRoot });
    assert.equal(archived.changed, true);
    assert.equal(archived.summary.archived, 1);
    assert.equal(await fs.access(sessionPath).then(() => true, () => false), false);
    assert.ok(await fs.access(archived.entry.archivePath).then(() => true, () => false));
    assert.ok(!JSON.stringify(archived).includes('Restore this'));

    const trash = await listSessionTrash({ trashRoot });
    assert.equal(trash.schema, 'easyaiconfig.session-trash.v1');
    assert.equal(trash.summary.restorable, 1);
    assert.equal(trash.entries[0].id, archived.entry.id);

    const restorePreview = await restoreSession({
      archiveId: archived.entry.id,
    }, { claudeHome, trashRoot });
    assert.equal(restorePreview.dryRun, true);
    assert.equal(restorePreview.summary.previewed, 1);
    assert.equal(await fs.access(sessionPath).then(() => true, () => false), false);

    const restored = await restoreSession({
      archiveId: archived.entry.id,
      dryRun: false,
    }, { claudeHome, trashRoot });
    assert.equal(restored.changed, true);
    assert.equal(restored.summary.restored, 1);
    assert.ok(await fs.access(sessionPath).then(() => true, () => false));

    const trashAfterRestore = await listSessionTrash({ trashRoot });
    assert.equal(trashAfterRestore.summary.restored, 1);
  });
});

test('archiveSession refuses files outside known session roots', async () => {
  await withTempDir(async (dir) => {
    const claudeHome = path.join(dir, 'claude');
    const outside = path.join(dir, 'outside.jsonl');
    await fs.mkdir(path.join(claudeHome, 'projects'), { recursive: true });
    await fs.writeFile(outside, '{}\n');

    await assert.rejects(
      archiveSession({
        tool: 'claudecode',
        sourcePath: outside,
        dryRun: false,
      }, { claudeHome, trashRoot: path.join(dir, 'trash') }),
      /outside known session roots/,
    );
  });
});
