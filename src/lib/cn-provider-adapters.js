// 国产 / 第三方 API 兼容性适配层（P1 #5）
//
// 痛点：cc-switch [#1489][#1638] 42 条评论无人理。中文 Provider（智谱 / 硅基
// 流动 / Kimi / 豆包 / DeepSeek / 阶跃 / MiniMax 等）虽然标称 OpenAI 兼容，但
// 实际有差异：
//   - 多数只支持 Chat Completions，不支持 Responses API
//   - 一些不支持 reasoning_effort / sandbox_mode 等 Codex 私有字段
//   - 部分需要额外 query_params / headers
//   - 模型命名规则各异
//
// 我们的做法：按 host 域名匹配，给出已知必需的 config 片段。saveConfig 在写
// provider 时如果检测到匹配的 adapter，自动把 wire_api / query_params 等写进
// model_providers[<key>]。用户保持原生 codex 体验，但配置自动正确。
//
// 我们不做：本地反代、字段实时转换、模型名魔法映射。那是 cc-switch / cc-router
// 的路子，会让 codex 升级时频繁踩坑。我们只在「写配置」这个点上做一次校准。

const ADAPTERS = [
  {
    slug: 'deepseek',
    name: 'DeepSeek',
    hostPatterns: [/(?:^|\.)deepseek\.com$/i, /(?:^|\.)deepseek\.ai$/i],
    wireApi: 'chat',
    defaultModel: 'deepseek-v4-flash',
    envKey: 'DEEPSEEK_API_KEY',
    hint: 'DeepSeek 官方直连，使用 OpenAI Chat Completions 协议。当前官方模型为 deepseek-v4-flash / deepseek-v4-pro，deepseek-chat / deepseek-reasoner 仅为兼容别名。',
    knownModels: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  },
  {
    slug: 'siliconflow',
    name: '硅基流动',
    hostPatterns: [/(?:^|\.)siliconflow\.cn$/i, /(?:^|\.)siliconflow\.com$/i],
    wireApi: 'chat',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    envKey: 'SILICONFLOW_API_KEY',
    hint: '硅基流动聚合多家模型，统一 Chat 协议。模型名含 vendor 前缀如 `deepseek-ai/DeepSeek-V3`。',
    knownModels: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-V2.5',
      'Qwen/Qwen2.5-72B-Instruct',
      'meta-llama/Meta-Llama-3.1-405B-Instruct',
    ],
  },
  {
    slug: 'zhipu',
    name: '智谱 GLM',
    hostPatterns: [/(?:^|\.)bigmodel\.cn$/i],
    wireApi: 'chat',
    defaultModel: 'glm-4.5',
    envKey: 'ZHIPU_API_KEY',
    hint: '智谱 GLM 用 OpenAI 兼容协议，path 必须含 `/api/paas/v4`。',
    knownModels: ['glm-4.5', 'glm-4-plus', 'glm-4-air', 'glm-4-flash'],
  },
  {
    slug: 'moonshot',
    name: 'Kimi / Moonshot',
    hostPatterns: [/(?:^|\.)moonshot\.cn$/i, /(?:^|\.)moonshot\.ai$/i],
    wireApi: 'chat',
    defaultModel: 'moonshot-v1-128k',
    envKey: 'MOONSHOT_API_KEY',
    hint: 'Moonshot Kimi 用 OpenAI Chat 协议，注意配额按 token 收费而非 request。',
    knownModels: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-128k'],
  },
  {
    slug: 'volcengine',
    name: '火山方舟 / 豆包',
    hostPatterns: [/(?:^|\.)volces\.com$/i, /(?:^|\.)bytedance\.com$/i, /(?:^|\.)byteplus\.com$/i],
    wireApi: 'chat',
    defaultModel: 'doubao-seed-1-6-thinking-250715',
    envKey: 'ARK_API_KEY',
    hint: '火山方舟模型名含日期戳（如 -250715），切版本要改 model。',
    knownModels: [
      'doubao-seed-1-6-thinking-250715',
      'doubao-pro-32k',
      'doubao-pro-128k',
      'doubao-lite-32k',
    ],
  },
  {
    slug: 'stepfun',
    name: '阶跃星辰',
    hostPatterns: [/(?:^|\.)stepfun\.com$/i],
    wireApi: 'chat',
    defaultModel: 'step-2-16k',
    envKey: 'STEPFUN_API_KEY',
    hint: '阶跃星辰 step 系列，OpenAI Chat 兼容。',
    knownModels: ['step-1-8k', 'step-1-32k', 'step-2-16k'],
  },
  {
    slug: 'minimax',
    name: 'MiniMax',
    hostPatterns: [/(?:^|\.)minimaxi\.com$/i, /(?:^|\.)minimax\.chat$/i],
    wireApi: 'chat',
    defaultModel: 'abab6.5s-chat',
    envKey: 'MINIMAX_API_KEY',
    hint: 'MiniMax abab/M1 系列，OpenAI Chat 兼容。',
    knownModels: ['abab6.5-chat', 'abab6.5s-chat', 'MiniMax-Text-01'],
  },
  {
    slug: 'qwen',
    name: '通义千问 (DashScope)',
    hostPatterns: [/(?:^|\.)dashscope\.aliyuncs\.com$/i, /(?:^|\.)aliyun\.com$/i],
    wireApi: 'chat',
    defaultModel: 'qwen-max',
    envKey: 'DASHSCOPE_API_KEY',
    hint: 'DashScope 通义千问需用 `/compatible-mode/v1` 路径才能 OpenAI 兼容。',
    knownModels: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen2.5-72b-instruct'],
  },
  {
    slug: 'baichuan',
    name: '百川',
    hostPatterns: [/(?:^|\.)baichuan-ai\.com$/i],
    wireApi: 'chat',
    defaultModel: 'Baichuan4',
    envKey: 'BAICHUAN_API_KEY',
    hint: '百川 Chat API，base_url 通常为 https://api.baichuan-ai.com/v1。',
    knownModels: ['Baichuan4', 'Baichuan3-Turbo', 'Baichuan2-Turbo'],
  },
  {
    slug: 'yi',
    name: '零一万物 Yi',
    hostPatterns: [/(?:^|\.)01\.ai$/i, /(?:^|\.)lingyiwanwu\.com$/i],
    wireApi: 'chat',
    defaultModel: 'yi-lightning',
    envKey: 'YI_API_KEY',
    hint: '零一万物 Yi 系列，OpenAI 兼容。',
    knownModels: ['yi-lightning', 'yi-large', 'yi-medium'],
  },
];

function parseHost(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch { return ''; }
}

export function getAdapterForBaseUrl(baseUrl) {
  const host = parseHost(baseUrl);
  if (!host) return null;
  for (const adapter of ADAPTERS) {
    if (adapter.hostPatterns.some((re) => re.test(host))) return adapter;
  }
  return null;
}

export function listAdapters() {
  return ADAPTERS.map((a) => ({
    slug: a.slug,
    name: a.name,
    wireApi: a.wireApi,
    defaultModel: a.defaultModel,
    envKey: a.envKey,
    hint: a.hint,
    knownModels: [...a.knownModels],
    hostPatternsDisplay: a.hostPatterns.map((re) => re.source),
  }));
}

// saveConfig 调用：把 adapter 推荐字段合进 provider TOML 块。
// 原则：只在 provider 缺这些字段时设；用户已显式写过就不动（applyPatch 语义）。
export function applyAdapterToProvider(providerBlock, baseUrl) {
  const adapter = getAdapterForBaseUrl(baseUrl);
  if (!adapter) return { applied: false, adapter: null };
  const next = { ...providerBlock };
  let touched = false;
  if (!next.wire_api) { next.wire_api = adapter.wireApi; touched = true; }
  return { applied: touched, adapter, providerBlock: next };
}
