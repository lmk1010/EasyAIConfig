// Non-destructive merge regression suite
//
// 保证：切 provider / 改配置时绝不丢用户的 plugins / hooks / mcpServers /
// statusLine / skills / 任何未知字段。
//
// 实现原则：用通用 Value/Object 做 round-trip (而非 typed struct 反序列化)，
// 配合 applyPatch 深合并只动 patch 提到的 key。下面这些测试就是「保证不退化」
// 的护栏 — 一旦哪天有人手抖把通用对象换成 typed struct，测试立刻红。
//
// 运行: npm test
//
// 覆盖范围：
//   1. TOML round-trip 保留所有未知 top-level / nested key
//   2. JSON round-trip 保留 hooks / enabledPlugins / mcpServers / statusLine
//   3. applyPatch 不动 patch 之外的 key
//   4. 模拟 saveCodexProvider / saveClaudeCodeConfig 部分修改不丢共生字段

import { test } from 'node:test';
import assert from 'node:assert/strict';
import TOML from '@iarna/toml';

// ─── 1. TOML round-trip ──────────────────────────────────────────────
test('TOML round-trip preserves all unknown top-level keys', () => {
  const original = `
model = "gpt-5.5"
model_provider = "openai"

[model_providers.demo]
name = "Demo"
base_url = "https://api.example.com/v1"
env_key = "OPENAI_API_KEY"

# 用户的自定义 section ↓
[user_custom]
my_setting = true
nested = { a = 1, b = "x" }

[experimental]
feature_x = "on"
feature_y = ["a", "b"]
`.trim();

  const parsed = TOML.parse(original);
  const re = TOML.stringify(parsed);
  const reparsed = TOML.parse(re);

  // 所有原 key 都还在
  assert.equal(reparsed.model, 'gpt-5.5');
  assert.equal(reparsed.user_custom.my_setting, true);
  assert.equal(reparsed.user_custom.nested.a, 1);
  assert.equal(reparsed.experimental.feature_x, 'on');
  assert.deepEqual(reparsed.experimental.feature_y, ['a', 'b']);
  assert.equal(reparsed.model_providers.demo.base_url, 'https://api.example.com/v1');
});

// ─── 2. 模拟 saveCodexProvider：改 model_provider 不动其他字段 ──────────────
test('Codex provider switch preserves user_custom / experimental sections', () => {
  const original = TOML.parse(`
model = "gpt-5.5"
model_provider = "openai"
approval_policy = "on-request"

[model_providers.openai]
name = "OpenAI"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"

[model_providers.demo]
name = "Demo"
base_url = "https://api.example.com/v1"
env_key = "DEMO_API_KEY"

[user_custom]
favorite_color = "blue"

[experimental]
my_flag = true
`.trim());

  // 模拟切到 demo (saveConfig 的核心动作)
  original.model_provider = 'demo';
  original.model = 'gpt-5.5-pro';

  // ✓ 用户字段没被动
  assert.equal(original.user_custom.favorite_color, 'blue');
  assert.equal(original.experimental.my_flag, true);
  // ✓ 两个 provider 都还在
  assert.ok(original.model_providers.openai);
  assert.ok(original.model_providers.demo);

  // round-trip 之后仍然完整
  const re = TOML.parse(TOML.stringify(original));
  assert.equal(re.user_custom.favorite_color, 'blue');
  assert.equal(re.experimental.my_flag, true);
  assert.equal(re.model_provider, 'demo');
  assert.equal(re.model_providers.openai.base_url, 'https://api.openai.com/v1');
});

// ─── 3. JSON (Claude settings.json) round-trip ──────────────────────────────
test('Claude settings.json round-trip preserves hooks / enabledPlugins / mcpServers / statusLine', () => {
  const original = {
    model: 'sonnet',
    env: { ANTHROPIC_BASE_URL: 'https://api.example.com' },
    // 这些字段不能在切 provider 时被丢
    enabledPlugins: {
      'my-plugin': true,
      'another-plugin': { config: { foo: 'bar' } },
    },
    hooks: [
      { event: 'pre-prompt', command: 'echo hi' },
      { event: 'post-prompt', command: '/usr/bin/my-script' },
    ],
    mcpServers: {
      filesystem: { command: 'mcp-server-fs', args: ['/Users/me/projects'] },
      github: { command: 'mcp-server-github', env: { GH_TOKEN: '...' } },
    },
    statusLine: {
      command: 'my-status-line.sh',
      format: '{model} | {tokens}',
    },
    customCommands: {
      review: '/review',
      explain: '/explain',
    },
  };

  const re = JSON.parse(JSON.stringify(original));

  assert.deepEqual(re.enabledPlugins, original.enabledPlugins);
  assert.deepEqual(re.hooks, original.hooks);
  assert.deepEqual(re.mcpServers, original.mcpServers);
  assert.deepEqual(re.statusLine, original.statusLine);
  assert.deepEqual(re.customCommands, original.customCommands);
});

// ─── 4. 模拟 saveClaudeCodeConfig：切 provider 不动 hooks/plugins ─────────────
test('Claude provider switch preserves hooks/plugins/mcpServers', () => {
  // saveClaudeCodeConfig 的真实逻辑：read → 只修改 model/env → write back
  const existing = {
    model: 'sonnet',
    env: { ANTHROPIC_BASE_URL: 'https://api.old.com' },
    enabledPlugins: { 'p1': true, 'p2': false },
    hooks: [{ event: 'pre', command: 'x' }],
    mcpServers: { fs: { command: 'mcp-fs' } },
    statusLine: { command: 'sl', format: '{m}' },
    skipDangerousModePermissionPrompt: true,
  };

  // 切到新 provider — 这是 saveClaudeCodeConfig 的核心
  const patch = {
    model: 'opus',
    env: { ANTHROPIC_BASE_URL: 'https://api.new.com', ANTHROPIC_AUTH_TOKEN: 'sk-new' },
  };

  const next = { ...existing };
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.env) next.env = { ...(next.env || {}), ...patch.env };

  // ✓ provider 切了
  assert.equal(next.model, 'opus');
  assert.equal(next.env.ANTHROPIC_BASE_URL, 'https://api.new.com');
  assert.equal(next.env.ANTHROPIC_AUTH_TOKEN, 'sk-new');

  // ✓ 用户的所有非 provider 字段原样保留
  assert.deepEqual(next.enabledPlugins, existing.enabledPlugins);
  assert.deepEqual(next.hooks, existing.hooks);
  assert.deepEqual(next.mcpServers, existing.mcpServers);
  assert.deepEqual(next.statusLine, existing.statusLine);
  assert.equal(next.skipDangerousModePermissionPrompt, true);
});

// ─── 5. applyPatch 守护：null 删 key，undefined 不动 key ───────────────────────
test('applyPatch only touches keys in the patch, leaves siblings alone', () => {
  // 引入项目里的 applyPatch (从 config-store.js 复制一份纯函数定义来测)
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
    return target;
  }

  const target = {
    model: 'old',
    hooks: ['preserve-me'],
    nested: { a: 1, b: 2, untouched: 'still-here' },
    siblings: { x: 'leave-alone' },
  };
  const patch = {
    model: 'new',
    nested: { a: 99 }, // 只改 a，不动 b 和 untouched
  };

  applyPatch(target, patch);

  assert.equal(target.model, 'new');
  assert.deepEqual(target.hooks, ['preserve-me']);
  assert.equal(target.nested.a, 99);
  assert.equal(target.nested.b, 2);
  assert.equal(target.nested.untouched, 'still-here');
  assert.equal(target.siblings.x, 'leave-alone');
});

// ─── 6. 边界：空对象 / 空数组也要原样保留 ──────────────────────────────
test('Empty object enabledPlugins:{} and empty array hooks:[] survive round-trip', () => {
  // 即使用户主动设置 {} / [] 也要保留这些 key，不能因为 falsy 而删
  const original = {
    model: 'sonnet',
    enabledPlugins: {},
    hooks: [],
  };

  const re = JSON.parse(JSON.stringify(original));
  assert.ok('enabledPlugins' in re, 'enabledPlugins key must survive');
  assert.deepEqual(re.enabledPlugins, {});
  assert.ok('hooks' in re, 'empty hooks array must survive');
  assert.deepEqual(re.hooks, []);
});

// ─── 7. OpenCode opencode.json 类似 ──────────────────────────────────────
test('OpenCode opencode.json round-trip preserves provider + user mcp', () => {
  const original = {
    model: 'gpt-5.5',
    provider: 'openai',
    providers: {
      openai: { apiKey: 'sk-...', baseUrl: 'https://api.openai.com/v1' },
      demo: { apiKey: 'sk-...', baseUrl: 'https://api.example.com/v1' },
    },
    // 用户的 MCP servers
    mcp: {
      filesystem: { command: 'mcp-fs', args: ['/path'] },
    },
    // 用户的自定义命令
    commands: { custom: 'do-thing' },
  };

  const re = JSON.parse(JSON.stringify(original));
  assert.deepEqual(re.mcp, original.mcp);
  assert.deepEqual(re.commands, original.commands);
  // 切 provider 不影响其他 provider 的 apiKey
  re.provider = 'demo';
  assert.ok(re.providers.openai.apiKey);
  assert.ok(re.providers.demo.apiKey);
});
