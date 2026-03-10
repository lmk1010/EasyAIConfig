// ════════════════════════════════════════════════════════════════
// Config Recipes — preset configurations for quick setup
// ════════════════════════════════════════════════════════════════

export const OPENCLAW_PROVIDER_RECIPES = [
  // ── Provider ──
  {
    id: 'openai-proxy', name: 'OpenAI 代理 / 中转', cat: 'Provider', desc: '设置 OpenAI 兼容 API 代理地址', kw: 'openai proxy 代理 中转 api url base 转发 one-api 模型 provider',
    fields: [{ key: 'url', label: '代理 Base URL', placeholder: 'https://your-proxy.com/v1' }, { key: 'key', label: 'API Key', placeholder: 'sk-...', type: 'password' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { openai: { baseUrl: v.url, api: 'openai-completions', apiKey: `$OPENAI_API_KEY` } } }, env: { OPENAI_API_KEY: v.key } }),
    panel: 'ocCfgProviderBaseUrl'
  },
  {
    id: 'claude-direct', name: 'Claude / Anthropic 直连', cat: 'Provider', desc: '直接使用 Anthropic API', kw: 'claude anthropic 直连 api 模型 provider sonnet opus haiku',
    fields: [{ key: 'key', label: 'Anthropic API Key', placeholder: 'sk-ant-...', type: 'password' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { anthropic: { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', apiKey: '$ANTHROPIC_API_KEY' } } }, env: { ANTHROPIC_API_KEY: v.key } }),
    panel: 'ocCfgProviderApiKey'
  },
  {
    id: 'gemini-direct', name: 'Google Gemini 直连', cat: 'Provider', desc: '使用 Google AI Studio / Gemini API', kw: 'gemini google ai studio 谷歌 模型 provider',
    fields: [{ key: 'key', label: 'Gemini API Key', placeholder: 'AIza...', type: 'password' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { google: { baseUrl: 'https://generativelanguage.googleapis.com', api: 'google-gemini', apiKey: '$GOOGLE_API_KEY' } } }, env: { GOOGLE_API_KEY: v.key } })
  },
  {
    id: 'deepseek-direct', name: 'DeepSeek 直连', cat: 'Provider', desc: '使用 DeepSeek API（V3/R1）', kw: 'deepseek 深度求索 模型 provider v3 r1 coder chat',
    fields: [{ key: 'key', label: 'DeepSeek API Key', placeholder: 'sk-...', type: 'password' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { deepseek: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', apiKey: '$DEEPSEEK_API_KEY' } } }, env: { DEEPSEEK_API_KEY: v.key } })
  },
  {
    id: 'ollama-local', name: 'Ollama 本地模型', cat: 'Provider', desc: '连接本地 Ollama 服务运行开源模型', kw: 'ollama 本地 local 开源 llama qwen mistral 模型 provider 免费',
    fields: [{ key: 'url', label: 'Ollama URL', placeholder: 'http://localhost:11434' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { ollama: { baseUrl: v.url || 'http://localhost:11434', api: 'openai-completions' } } } })
  },
  {
    id: 'azure-openai', name: 'Azure OpenAI', cat: 'Provider', desc: '通过 Azure 部署的 OpenAI 模型', kw: 'azure openai 微软 microsoft 云 模型 provider 企业',
    fields: [{ key: 'url', label: 'Azure Endpoint', placeholder: 'https://xxx.openai.azure.com' }, { key: 'key', label: 'API Key', placeholder: 'Azure API Key', type: 'password' }, { key: 'deploy', label: '部署名称', placeholder: 'gpt-4o' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { azure: { baseUrl: v.url, api: 'openai-completions', apiKey: '$AZURE_API_KEY', deployment: v.deploy } } }, env: { AZURE_API_KEY: v.key } })
  },
  {
    id: 'groq-direct', name: 'Groq 极速推理', cat: 'Provider', desc: '使用 Groq LPU 获得超快推理速度', kw: 'groq 极速 fast 快 推理 模型 provider lpu',
    fields: [{ key: 'key', label: 'Groq API Key', placeholder: 'gsk_...', type: 'password' }],
    apply: (v) => ({ models: { mode: 'merge', providers: { groq: { baseUrl: 'https://api.groq.com/openai', api: 'openai-completions', apiKey: '$GROQ_API_KEY' } } }, env: { GROQ_API_KEY: v.key } })
  },
];
