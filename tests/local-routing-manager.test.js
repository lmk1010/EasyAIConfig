import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLocalRoutingPlan,
  localRoutingCapabilities,
  previewRequestRectifier,
  previewResponseRectifier,
  redactLocalRoutingLogEntry,
} from '../src/lib/local-routing-manager.js';

test('local routing plan orders healthy providers and skips open circuits and low balance', () => {
  const plan = buildLocalRoutingPlan({
    tool: 'codex',
    routeStrategy: 'auto',
    nowMs: 100000,
    balanceMinPercent: 10,
    failureThreshold: 3,
    providerTargets: [
      { providerKey: 'primary', name: 'Primary', weight: 10, balancePercent: 80, balanceStatus: 'ok' },
      { providerKey: 'low-balance', name: 'Low', weight: 100, balancePercent: 2, balanceStatus: 'ok' },
      { providerKey: 'broken', name: 'Broken', weight: 100, balancePercent: 90, balanceStatus: 'ok' },
      { providerKey: 'backup', name: 'Backup', weight: 1, balancePercent: 50, balanceStatus: 'ok' },
    ],
    providerStats: {
      'codex:primary': { lastOk: true, health: 'healthy' },
      'codex:backup': { lastOk: true, health: 'healthy' },
      'codex:broken': { failures: 3, requests: 3, failureStreak: 3, lastStatus: 503 },
    },
  });

  assert.equal(plan.schema, 'easyaiconfig.local-routing-plan.v1');
  assert.equal(plan.summary.totalProviders, 4);
  assert.equal(plan.summary.primaryRouteKey, 'codex:primary');
  assert.deepEqual(plan.routeOrder.map((item) => item.routeKey), ['codex:primary', 'codex:backup']);
  assert.equal(plan.summary.failoverProviders, 1);
  assert.equal(plan.skipped.find((item) => item.routeKey === 'codex:low-balance').skipReason, 'balance guard');
  assert.equal(plan.skipped.find((item) => item.routeKey === 'codex:broken').skipReason, 'circuit open');
});

test('local routing plan supports deterministic weighted and round-robin order', () => {
  const targets = [
    { providerKey: 'a', weight: 1 },
    { providerKey: 'b', weight: 3 },
    { providerKey: 'c', weight: 1 },
  ];

  const weighted = buildLocalRoutingPlan({
    tool: 'codex',
    routeStrategy: 'weighted',
    cursor: 2,
    providerTargets: targets,
  });
  assert.deepEqual(weighted.routeOrder.map((item) => item.providerKey), ['b', 'c', 'a']);

  const rr = buildLocalRoutingPlan({
    tool: 'codex',
    routeStrategy: 'round_robin',
    cursor: 1,
    providerTargets: targets,
  });
  assert.deepEqual(rr.routeOrder.map((item) => item.providerKey), ['b', 'c', 'a']);
});

test('request rectifier previews OpenAI Responses to Chat Completions conversion', () => {
  const preview = previewRequestRectifier({
    sourceProtocol: 'openai-responses',
    targetProtocol: 'openai-chat',
    request: {
      path: '/v1/responses',
      body: {
        model: 'gpt-5',
        instructions: 'Be concise.',
        input: 'Ping',
        max_output_tokens: 16,
        stream: false,
      },
    },
  });

  assert.equal(preview.changed, true);
  assert.equal(preview.request.body.model, 'gpt-5');
  assert.equal(preview.request.body.max_tokens, 16);
  assert.equal(preview.request.body.max_output_tokens, undefined);
  assert.deepEqual(preview.request.body.messages, [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Ping' },
  ]);
});

test('request rectifier previews Anthropic to Responses conversion', () => {
  const preview = previewRequestRectifier({
    sourceProtocol: 'anthropic',
    targetProtocol: 'openai-responses',
    body: {
      model: 'claude-sonnet-4-20250514',
      system: 'Use JSON.',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 32,
    },
  });

  assert.equal(preview.changed, true);
  assert.equal(preview.request.body.instructions, 'Use JSON.');
  assert.equal(preview.request.body.max_output_tokens, 32);
  assert.deepEqual(preview.request.body.input, [{ role: 'user', content: 'Hello' }]);
});

test('request rectifier previews Chat Completions to Gemini GenerateContent conversion', () => {
  const preview = previewRequestRectifier({
    sourceProtocol: 'openai-chat',
    targetProtocol: 'gemini',
    request: {
      path: '/v1/chat/completions?trace=1',
      body: {
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'Use JSON.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
        ],
        max_tokens: 24,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Lookup data',
              parameters: { type: 'object', properties: { id: { type: 'string' } } },
            },
          },
        ],
      },
    },
  });

  assert.equal(preview.changed, true);
  assert.equal(preview.request.path, '/v1beta/models/gemini-2.5-flash:generateContent?trace=1');
  assert.equal(preview.request.body.model, undefined);
  assert.equal(preview.request.body.messages, undefined);
  assert.deepEqual(preview.request.body.systemInstruction, { parts: [{ text: 'Use JSON.' }] });
  assert.deepEqual(preview.request.body.contents, [
    { role: 'user', parts: [{ text: 'Hello' }] },
    { role: 'model', parts: [{ text: 'Hi' }] },
  ]);
  assert.equal(preview.request.body.generationConfig.maxOutputTokens, 24);
  assert.equal(preview.request.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(preview.request.body.tools[0].functionDeclarations[0].name, 'lookup');
});

test('response rectifier previews Gemini GenerateContent to Chat Completions conversion', () => {
  const preview = previewResponseRectifier({
    sourceProtocol: 'openai-chat',
    targetProtocol: 'gemini',
    response: {
      path: '/v1beta/models/gemini-2.5-flash:generateContent',
      body: {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Hello from Gemini' },
                { functionCall: { name: 'lookup', args: { id: '42' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 5,
          totalTokenCount: 12,
          cachedContentTokenCount: 2,
        },
      },
    },
  });

  assert.equal(preview.changed, true);
  assert.equal(preview.response.body.object, 'chat.completion');
  assert.equal(preview.response.body.model, 'gemini-2.5-flash');
  assert.equal(preview.response.body.choices[0].message.content, 'Hello from Gemini');
  assert.equal(preview.response.body.choices[0].message.tool_calls[0].function.name, 'lookup');
  assert.equal(preview.response.body.choices[0].message.tool_calls[0].function.arguments, '{"id":"42"}');
  assert.equal(preview.response.body.usage.prompt_tokens, 7);
  assert.equal(preview.response.body.usage.completion_tokens, 5);
  assert.equal(preview.response.body.usage.prompt_tokens_details.cached_tokens, 2);
});

test('response rectifier previews Gemini streamGenerateContent to Chat Completions SSE', () => {
  const preview = previewResponseRectifier({
    sourceProtocol: 'openai-chat',
    targetProtocol: 'gemini',
    response: {
      path: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      body: [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}',
        '',
        'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}',
        '',
      ].join('\n'),
    },
  });

  assert.equal(preview.changed, true);
  assert.match(preview.response.body, /chat\.completion\.chunk/);
  assert.match(preview.response.body, /"content":"Hel"/);
  assert.match(preview.response.body, /"content":"lo"/);
  assert.match(preview.response.body, /"total_tokens":5/);
  assert.match(preview.response.body, /data: \[DONE\]/);
});

test('response rectifier previews Gemini errors to caller protocol format', () => {
  const openai = previewResponseRectifier({
    sourceProtocol: 'openai-chat',
    targetProtocol: 'gemini',
    response: {
      status: 400,
      path: '/v1beta/models/gemini-2.5-flash:generateContent',
      body: {
        error: {
          code: 400,
          message: 'Invalid Gemini request',
          status: 'INVALID_ARGUMENT',
        },
      },
    },
  });

  assert.equal(openai.changed, true);
  assert.equal(openai.response.body.error.message, 'Invalid Gemini request');
  assert.equal(openai.response.body.error.type, 'invalid_request_error');
  assert.equal(openai.response.body.error.code, 'invalid_argument');

  const anthropic = previewResponseRectifier({
    sourceProtocol: 'anthropic',
    targetProtocol: 'gemini',
    response: {
      status: 429,
      body: {
        error: {
          code: 429,
          message: 'Gemini quota exceeded',
          status: 'RESOURCE_EXHAUSTED',
        },
      },
    },
  });

  assert.equal(anthropic.changed, true);
  assert.equal(anthropic.response.body.type, 'error');
  assert.equal(anthropic.response.body.error.type, 'rate_limit_error');
  assert.equal(anthropic.response.body.error.message, 'Gemini quota exceeded');
});

test('local routing capabilities and log redaction expose control-plane guarantees', () => {
  const capabilities = localRoutingCapabilities();
  assert.ok(capabilities.supportedTools.includes('claude-desktop'));
  assert.ok(capabilities.supportedTools.includes('hermes'));
  assert.equal(capabilities.controlPlane.circuitBreaker, true);
  assert.equal(capabilities.controlPlane.responseRectifierPreview, true);
  assert.equal(capabilities.runtime.tauriProviderRouter, true);

  const redacted = redactLocalRoutingLogEntry({
    providerKey: 'openai',
    apiKey: 'sk-secret',
    headers: {
      Authorization: 'Bearer sk-secret',
      'content-type': 'application/json',
    },
    request: {
      headers: {
        'x-api-key': 'another-secret',
      },
    },
  });
  assert.equal(redacted.apiKey, '[redacted]');
  assert.equal(redacted.headers.Authorization, '[redacted]');
  assert.equal(redacted.headers['content-type'], 'application/json');
  assert.equal(redacted.request.headers['x-api-key'], '[redacted]');
});
