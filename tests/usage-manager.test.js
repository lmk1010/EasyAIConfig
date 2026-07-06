import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

test('listUsageInventory defaults to session-backed analytics for Gemini, OpenClaw, and Hermes', async () => {
  await withTempDir(async (dir) => {
    const geminiHome = path.join(dir, 'gemini');
    const openClawHome = path.join(dir, 'openclaw');
    const hermesHome = path.join(dir, 'hermes');
    await fs.mkdir(path.join(geminiHome, 'sessions'), { recursive: true });
    await fs.mkdir(path.join(openClawHome, 'sessions'), { recursive: true });
    await fs.mkdir(path.join(hermesHome, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(geminiHome, 'sessions', 'g1.json'), JSON.stringify({
      sessionId: 'g1',
      model: 'gemini-2.5-pro',
      cwd: dir,
      updatedAt: '2026-07-05T01:00:00.000Z',
      content: 'Gemini session',
    }));
    await fs.writeFile(path.join(openClawHome, 'sessions', 'o1.json'), JSON.stringify({
      sessionId: 'o1',
      model: 'gpt-5',
      cwd: dir,
      updatedAt: '2026-07-05T02:00:00.000Z',
      content: 'OpenClaw session',
    }));
    await fs.writeFile(path.join(hermesHome, 'sessions', 'h1.json'), JSON.stringify({
      sessionId: 'h1',
      model: 'claude-sonnet-4-20250514',
      cwd: dir,
      updatedAt: '2026-07-05T03:00:00.000Z',
      content: 'Hermes session',
    }));

    const inventory = await listUsageInventory({
      includeCustomPrices: false,
      geminiHome,
      openClawHome,
      hermesHome,
      loaders: {
        codex: async () => ({ ok: true, totals: {}, daily: [], providers: [], models: [], sessions: [] }),
        claudecode: async () => ({ usage: { source: 'empty', totals: {}, daily: [], models: [], sessions: [] } }),
        opencode: async () => ({ ok: true, totals: {}, daily: [], providers: [], models: [], sessions: [] }),
      },
    });

    const tools = inventory.sources.map((source) => source.tool);
    assert.deepEqual(tools, [
      'codex',
      'claudecode',
      'opencode',
      'gemini',
      'openclaw',
      'hermes',
      'qwen-code',
      'codebuddy-code',
      'cline',
      'roo-code',
      'kilo-code',
      'continue',
      'cursor',
      'windsurf',
      'zed',
      'trae',
      'qoder',
      'zcode',
      'lingma',
    ]);
    assert.equal(inventory.summary.tools.gemini.requests, 1);
    assert.equal(inventory.summary.tools.openclaw.requests, 1);
    assert.equal(inventory.summary.tools.hermes.requests, 1);
    assert.equal(inventory.summary.readErrors, 0);
    assert.ok(inventory.requestLogs.some((item) => item.tool === 'gemini' && item.provider === 'google-gemini'));
    assert.ok(inventory.models.some((item) => item.model === 'claude-sonnet-4-20250514'));
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
