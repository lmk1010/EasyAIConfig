import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  listUsageInventory,
  readCustomPriceBook,
  saveCustomPriceBook,
} from '../src/lib/usage-manager.js';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyaiconfig-usage-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function sqliteAvailable() {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? ['sqlite3'] : ['-v', 'sqlite3'], {
    encoding: 'utf8',
    shell: process.platform !== 'win32',
    windowsHide: true,
  });
  return result.status === 0;
}

function sqliteExec(dbPath, sql) {
  const result = spawnSync('sqlite3', [dbPath, sql], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('listUsageInventory merges Codex, Claude Code, and OpenCode usage', async () => {
  const inventory = await listUsageInventory({
    includeCustomPrices: false,
    includeTools: ['codex', 'claudecode', 'opencode'],
    loaders: {
      codex: async () => ({
        ok: true,
        source: 'codex-sessions',
        sourceType: 'sessions',
        generatedAt: '2026-07-04T00:00:00.000Z',
        totals: { input: 100, cachedInput: 10, output: 50, reasoning: 5, total: 165 },
        daily: [{ date: '2026-07-04', input: 100, cachedInput: 10, output: 50, reasoning: 5, total: 165 }],
        providers: [{ provider: 'openai', totals: { input: 100, cachedInput: 10, output: 50, reasoning: 5, total: 165 }, events: 2 }],
        models: [{ model: 'gpt-5', totals: { input: 100, cachedInput: 10, output: 50, reasoning: 5, total: 165 }, events: 2 }],
        sessions: [{ sessionId: 'codex-1', provider: 'openai', model: 'gpt-5', cwd: '/tmp/a', updatedAt: 1783123200000, input: 100, cachedInput: 10, output: 50, reasoning: 5, total: 165 }],
      }),
      claudecode: async () => ({
        usage: {
          source: 'claude-projects',
          generatedAt: '2026-07-04T00:00:00.000Z',
          totals: { input: 200, output: 90, cacheRead: 20, cacheCreation: 10, total: 320, cost: 0.01 },
          officialCost: 0.02,
          daily: [{ date: '2026-07-04', input: 200, output: 90, cacheRead: 20, cacheCreation: 10, total: 320, cost: 0.01 }],
          models: [{ model: 'claude-sonnet-4-20250514', totals: { input: 200, output: 90, cacheRead: 20, cacheCreation: 10, total: 320 } }],
          sessions: [{ sessionId: 'claude-1', model: 'claude-sonnet-4-20250514', updatedAt: '2026-07-04T01:00:00.000Z', input: 200, output: 90, cacheRead: 20, cacheCreation: 10, total: 320, cost: 0.01 }],
        },
      }),
      opencode: async () => ({
        ok: true,
        source: 'opencode.db',
        sourceType: 'sqlite',
        generatedAt: '2026-07-04T00:00:00.000Z',
        totals: { input: 30, output: 40, reasoning: 0, cacheRead: 5, cacheCreation: 0, total: 75, cost: 0.03 },
        daily: [{ date: '2026-07-05', input: 30, output: 40, reasoning: 0, cacheRead: 5, cacheCreation: 0, total: 75, cost: 0.03 }],
        providers: [{ provider: 'anthropic', totals: { input: 30, output: 40, reasoning: 0, cacheRead: 5, cacheCreation: 0, total: 75, cost: 0.03 }, events: 1 }],
        models: [{ model: 'claude-haiku', totals: { input: 30, output: 40, reasoning: 0, cacheRead: 5, cacheCreation: 0, total: 75, cost: 0.03 }, events: 1 }],
        sessions: [{ sessionId: 'open-1', provider: 'anthropic', model: 'claude-haiku', cwd: '/tmp/b', updatedAt: '2026-07-05T01:00:00.000Z', input: 30, output: 40, cacheRead: 5, total: 75, cost: 0.03 }],
      }),
    },
  });

  assert.equal(inventory.schema, 'easyaiconfig.usage-inventory.v1');
  assert.equal(inventory.summary.totalTokens, 560);
  assert.equal(inventory.summary.cost, 0.04);
  assert.equal(inventory.summary.officialCost, 0.02);
  assert.equal(inventory.summary.requests, 4);
  assert.equal(inventory.daily.length, 2);
  assert.equal(inventory.requestLogs.length, 3);
  assert.ok(inventory.providers.some((provider) => provider.provider === 'openai'));
  assert.ok(inventory.models.some((model) => model.model === 'gpt-5'));
});

test('listUsageInventory parses verified local usage sources and keeps unsupported tools explicit', async () => {
  await withTempDir(async (dir) => {
    const droidDir = path.join(dir, 'factory-sessions');
    const geminiTmp = path.join(dir, 'gemini', 'tmp');
    const ampThreads = path.join(dir, 'amp', 'threads');
    const codebuffHome = path.join(dir, 'codebuff');
    const piAgentDir = path.join(dir, 'pi', 'agent', 'sessions');
    const openClawHome = path.join(dir, 'openclaw');
    const copilotOtelDir = path.join(dir, 'copilot', 'otel');
    const qwenHome = path.join(dir, 'qwen');
    const kimiHome = path.join(dir, 'kimi');
    await fs.mkdir(droidDir, { recursive: true });
    await fs.mkdir(geminiTmp, { recursive: true });
    await fs.mkdir(ampThreads, { recursive: true });
    await fs.mkdir(path.join(codebuffHome, 'projects', 'project-alpha', 'chats', 'chat-alpha'), { recursive: true });
    await fs.mkdir(path.join(piAgentDir, 'project-alpha'), { recursive: true });
    await fs.mkdir(path.join(openClawHome, 'sessions'), { recursive: true });
    await fs.mkdir(copilotOtelDir, { recursive: true });
    await fs.mkdir(path.join(qwenHome, 'projects', 'project-alpha', 'chats'), { recursive: true });
    await fs.mkdir(path.join(kimiHome, 'sessions', 'kimi-alpha'), { recursive: true });

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

    await fs.writeFile(path.join(geminiTmp, 'gemini-alpha.jsonl'), [
      JSON.stringify({
        type: 'gemini',
        sessionId: 'gemini-alpha',
        model: 'gemini-2.5-pro',
        timestamp: '2026-07-04T12:10:00.000Z',
        tokens: {
          input: 10,
          output: 20,
          cached: 5,
          total: 35,
        },
      }),
    ].join('\n'));

    await fs.writeFile(path.join(ampThreads, 'amp-alpha.json'), JSON.stringify({
      id: 'amp-alpha',
      usageLedger: {
        events: [{
          id: 'amp-usage-1',
          model: 'claude-sonnet-4-20250514',
          timestamp: '2026-07-04T12:20:00.000Z',
          tokens: {
            input: 11,
            output: 22,
            total: 33,
          },
        }],
      },
    }));

    await fs.writeFile(path.join(codebuffHome, 'projects', 'project-alpha', 'chats', 'chat-alpha', 'chat-messages.json'), JSON.stringify([{
      id: 'codebuff-msg-1',
      variant: 'assistant',
      timestamp: '2026-07-04T12:30:00.000Z',
      metadata: {
        model: 'gpt-5',
        usage: {
          inputTokens: 12,
          outputTokens: 23,
          totalTokens: 35,
        },
      },
    }]));

    await fs.writeFile(path.join(piAgentDir, 'project-alpha', 'prefix_pi-alpha.jsonl'), [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-07-04T12:40:00.000Z',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          usage: {
            input: 13,
            output: 24,
            totalTokens: 37,
          },
        },
      }),
    ].join('\n'));

    await fs.writeFile(path.join(openClawHome, 'sessions', 'openclaw-alpha.jsonl'), [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-07-04T12:50:00.000Z',
        message: {
          role: 'assistant',
          model: 'qwen3-coder-plus',
          provider: 'qwen',
          usage: {
            input: 14,
            output: 25,
            totalTokens: 39,
          },
        },
      }),
    ].join('\n'));

    await fs.writeFile(path.join(copilotOtelDir, 'copilot-alpha.jsonl'), [
      JSON.stringify({
        timestamp: '2026-07-04T12:55:00.000Z',
        attributes: {
          'gen_ai.conversation.id': 'copilot-alpha',
          'gen_ai.response.model': 'gpt-4.1',
          'gen_ai.usage.input_tokens': 20,
          'gen_ai.usage.cache_read.input_tokens': 5,
          'gen_ai.usage.output_tokens': 30,
          'gen_ai.usage.total_tokens': 50,
        },
      }),
    ].join('\n'));

    await fs.writeFile(path.join(qwenHome, 'projects', 'project-alpha', 'chats', 'qwen-alpha.jsonl'), [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'qwen-alpha',
        model: 'qwen3-coder-plus',
        timestamp: '2026-07-04T13:00:00.000Z',
        usageMetadata: {
          promptTokenCount: 60,
          candidatesTokenCount: 30,
          thoughtsTokenCount: 3,
          cachedContentTokenCount: 7,
          totalTokenCount: 100,
        },
      }),
    ].join('\n'));

    await fs.writeFile(path.join(kimiHome, 'sessions', 'kimi-alpha', 'wire.jsonl'), [
      JSON.stringify({
        timestamp: 1783180800,
        message: {
          type: 'StatusUpdate',
          payload: {
            message_id: 'kimi-msg-1',
            token_usage: {
              input_other: 80,
              output: 45,
              input_cache_creation: 12,
              input_cache_read: 8,
              total: 145,
            },
          },
        },
      }),
    ].join('\n'));

    const inventory = await listUsageInventory({
      includeCustomPrices: false,
      includeTools: ['droid', 'gemini', 'amp', 'codebuff', 'pi-agent', 'openclaw', 'copilot', 'qwen-code', 'kimi', 'cursor'],
      droidSessionsDir: droidDir,
      geminiDataDir: geminiTmp,
      ampDataDir: ampThreads,
      codebuffDataDir: codebuffHome,
      piAgentDir,
      openClawHome,
      copilotOtelDir,
      qwenDataDir: qwenHome,
      kimiDataDir: kimiHome,
      limit: 20,
    });

    assert.deepEqual(inventory.sources.map((source) => source.tool), ['droid', 'gemini', 'amp', 'codebuff', 'pi-agent', 'openclaw', 'copilot', 'qwen-code', 'kimi', 'cursor']);
    assert.equal(inventory.summary.totalTokens, 649);
    assert.equal(inventory.summary.requests, 9);
    assert.equal(inventory.requestLogs.length, 9);

    const droid = inventory.sources.find((item) => item.tool === 'droid');
    assert.equal(droid.usageStatus, 'exact');
    assert.equal(droid.totals.total, 175);
    assert.equal(droid.requestLogs[0].model, 'claude-sonnet-4-20250514');

    const qwen = inventory.sources.find((item) => item.tool === 'qwen-code');
    assert.equal(qwen.usageStatus, 'exact');
    assert.equal(qwen.totals.total, 100);
    assert.equal(qwen.providers[0].provider, 'qwen');

    for (const [tool, total] of [
      ['gemini', 35],
      ['amp', 33],
      ['codebuff', 35],
      ['pi-agent', 37],
      ['openclaw', 39],
      ['copilot', 50],
    ]) {
      const source = inventory.sources.find((item) => item.tool === tool);
      assert.equal(source.usageStatus, 'exact');
      assert.equal(source.totals.total, total);
      assert.equal(source.requestLogs.length, 1);
    }

    const kimi = inventory.sources.find((item) => item.tool === 'kimi');
    assert.equal(kimi.usageStatus, 'exact');
    assert.equal(kimi.totals.total, 145);

    const cursor = inventory.sources.find((item) => item.tool === 'cursor');
    assert.equal(cursor.unsupported, true);
    assert.equal(cursor.usageStatus, 'unsupported');
    assert.equal(cursor.sourceType, 'unsupported');
    assert.equal(inventory.summary.tools.cursor.requests, 0);
  });
});

test('listUsageInventory parses verified SQLite local usage sources', { skip: !sqliteAvailable() }, async () => {
  await withTempDir(async (dir) => {
    const hermesHome = path.join(dir, 'hermes');
    const gooseRoot = path.join(dir, 'goose');
    const kiloRoot = path.join(dir, 'kilo');
    await fs.mkdir(hermesHome, { recursive: true });
    await fs.mkdir(path.join(gooseRoot, 'sessions'), { recursive: true });
    await fs.mkdir(kiloRoot, { recursive: true });

    const hermesDb = path.join(hermesHome, 'state.db');
    sqliteExec(hermesDb, `
      CREATE TABLE sessions (
        id TEXT, model TEXT, billing_provider TEXT, started_at TEXT, message_count INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL
      );
      INSERT INTO sessions VALUES (
        'hermes-alpha', 'claude-sonnet-4-20250514', 'anthropic', '2026-07-04T14:00:00.000Z', 3,
        100, 40, 20, 10, 5, 0.01, 0.02
      );
    `);

    const gooseDb = path.join(gooseRoot, 'sessions', 'sessions.db');
    sqliteExec(gooseDb, `
      CREATE TABLE sessions (
        id TEXT, model_config_json TEXT, provider_name TEXT, created_at TEXT,
        total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER
      );
      INSERT INTO sessions VALUES (
        'goose-alpha', '{"model_name":"gpt-5"}', 'openai', '2026-07-04T14:10:00.000Z',
        70, 30, 40, 70, 30, 40
      );
    `);

    const kiloDb = path.join(kiloRoot, 'kilo.db');
    sqliteExec(kiloDb, `
      CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);
      INSERT INTO message VALUES (
        'kilo-msg-1',
        'kilo-alpha',
        '{"id":"kilo-msg-1","session_id":"kilo-alpha","role":"assistant","modelID":"qwen3-coder-plus","providerID":"qwen","time":{"created":"2026-07-04T14:20:00.000Z"},"tokens":{"input":12,"output":23,"reasoning":3,"cache":{"read":5,"write":2},"total":45},"cost":0.01}'
      );
    `);

    const inventory = await listUsageInventory({
      includeCustomPrices: false,
      includeTools: ['hermes', 'goose', 'kilo-code'],
      hermesHome,
      goosePathRoot: gooseRoot,
      kiloDataDir: kiloRoot,
      limit: 10,
    });

    assert.equal(inventory.summary.totalTokens, 290);
    assert.equal(inventory.summary.cost, 0.03);
    assert.equal(inventory.summary.requests, 5);
    for (const [tool, total] of [
      ['hermes', 175],
      ['goose', 70],
      ['kilo-code', 45],
    ]) {
      const source = inventory.sources.find((item) => item.tool === tool);
      assert.equal(source.usageStatus, 'exact');
      assert.equal(source.totals.total, total);
      assert.equal(source.requestLogs.length, 1);
    }
  });
});

test('custom price book can be saved and read', async () => {
  await withTempDir(async (dir) => {
    const priceBookPath = path.join(dir, 'prices.json');
    await saveCustomPriceBook({
      models: [{
        provider: 'openai',
        model: 'gpt-5',
        inputPerMTok: 1.25,
        outputPerMTok: 10,
      }],
    }, { priceBookPath });

    const book = await readCustomPriceBook({ priceBookPath });
    assert.equal(book.schema, 'easyaiconfig.custom-prices.v1');
    assert.equal(book.models.length, 1);
    assert.equal(book.models[0].model, 'gpt-5');
    assert.equal(book.models[0].outputPerMTok, 10);
  });
});
