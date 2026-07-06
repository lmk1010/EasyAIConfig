const CATALOG_REVISION = '2026-07-05';
const PROVIDER_CATALOG_TOOL_ORDER = ['codex', 'claudecode', 'claude-desktop', 'gemini', 'opencode', 'openclaw', 'hermes'];

const PROVIDER_PRESETS = [
  provider('openai', 'OpenAI', 'global', ['responses', 'chat'], ['https://api.openai.com/v1'], 'OPENAI_API_KEY', ['codex', 'opencode', 'openclaw']),
  provider('anthropic', 'Anthropic', 'global', ['anthropic'], ['https://api.anthropic.com'], 'ANTHROPIC_API_KEY', ['claudecode', 'opencode', 'openclaw']),
  provider('google-gemini', 'Google Gemini', 'global', ['gemini', 'openai-chat'], ['https://generativelanguage.googleapis.com/v1beta/openai'], 'GEMINI_API_KEY', ['gemini', 'codex', 'opencode']),
  provider('azure-openai', 'Azure OpenAI', 'global', ['responses', 'chat'], ['https://{resource}.openai.azure.com/openai/v1'], 'AZURE_OPENAI_API_KEY', ['codex', 'opencode', 'openclaw']),
  provider('azure-ai-foundry', 'Azure AI Foundry', 'global', ['openai-chat'], ['https://{resource}.services.ai.azure.com/models'], 'AZURE_AI_API_KEY', ['codex', 'opencode']),
  provider('aws-bedrock', 'AWS Bedrock', 'global', ['bedrock', 'anthropic', 'openai-chat'], ['https://bedrock-runtime.{region}.amazonaws.com'], 'AWS_ACCESS_KEY_ID', ['claudecode', 'opencode']),
  provider('vertex-ai', 'Google Vertex AI', 'global', ['vertex', 'gemini'], ['https://{region}-aiplatform.googleapis.com'], 'GOOGLE_APPLICATION_CREDENTIALS', ['gemini', 'opencode']),
  provider('openrouter', 'OpenRouter', 'global', ['openai-chat'], ['https://openrouter.ai/api/v1'], 'OPENROUTER_API_KEY', ['codex', 'opencode', 'openclaw']),
  provider('groq', 'Groq', 'global', ['openai-chat'], ['https://api.groq.com/openai/v1'], 'GROQ_API_KEY', ['codex', 'opencode']),
  provider('together', 'Together AI', 'global', ['openai-chat'], ['https://api.together.xyz/v1'], 'TOGETHER_API_KEY', ['codex', 'opencode']),
  provider('fireworks', 'Fireworks AI', 'global', ['openai-chat'], ['https://api.fireworks.ai/inference/v1'], 'FIREWORKS_API_KEY', ['codex', 'opencode']),
  provider('mistral', 'Mistral AI', 'global', ['openai-chat'], ['https://api.mistral.ai/v1'], 'MISTRAL_API_KEY', ['codex', 'opencode']),
  provider('cohere', 'Cohere', 'global', ['openai-chat'], ['https://api.cohere.com/compatibility/v1'], 'COHERE_API_KEY', ['codex', 'opencode']),
  provider('perplexity', 'Perplexity', 'global', ['openai-chat'], ['https://api.perplexity.ai'], 'PERPLEXITY_API_KEY', ['codex', 'opencode']),
  provider('xai', 'xAI', 'global', ['openai-chat'], ['https://api.x.ai/v1'], 'XAI_API_KEY', ['codex', 'opencode']),
  provider('deepseek', 'DeepSeek', 'cn', ['openai-chat'], ['https://api.deepseek.com/v1'], 'DEEPSEEK_API_KEY', ['codex', 'opencode', 'openclaw']),
  provider('siliconflow', 'SiliconFlow', 'cn', ['openai-chat'], ['https://api.siliconflow.cn/v1'], 'SILICONFLOW_API_KEY', ['codex', 'opencode', 'openclaw']),
  provider('zhipu', 'Zhipu GLM', 'cn', ['openai-chat'], ['https://open.bigmodel.cn/api/paas/v4'], 'ZHIPU_API_KEY', ['codex', 'opencode']),
  provider('moonshot', 'Moonshot Kimi', 'cn', ['openai-chat'], ['https://api.moonshot.cn/v1'], 'MOONSHOT_API_KEY', ['codex', 'opencode']),
  provider('volcengine-ark', 'Volcengine Ark', 'cn', ['openai-chat'], ['https://ark.cn-beijing.volces.com/api/v3'], 'ARK_API_KEY', ['codex', 'opencode']),
  provider('dashscope', 'Alibaba DashScope', 'cn', ['openai-chat'], ['https://dashscope.aliyuncs.com/compatible-mode/v1'], 'DASHSCOPE_API_KEY', ['codex', 'opencode']),
  provider('tencent-hunyuan', 'Tencent Hunyuan', 'cn', ['openai-chat'], ['https://api.hunyuan.cloud.tencent.com/v1'], 'HUNYUAN_API_KEY', ['codex', 'opencode']),
  provider('baidu-qianfan', 'Baidu Qianfan', 'cn', ['openai-chat'], ['https://qianfan.baidubce.com/v2'], 'QIANFAN_API_KEY', ['codex', 'opencode']),
  provider('baichuan', 'Baichuan', 'cn', ['openai-chat'], ['https://api.baichuan-ai.com/v1'], 'BAICHUAN_API_KEY', ['codex', 'opencode']),
  provider('yi', '01.AI Yi', 'cn', ['openai-chat'], ['https://api.lingyiwanwu.com/v1'], 'YI_API_KEY', ['codex', 'opencode']),
  provider('minimax', 'MiniMax', 'cn', ['openai-chat'], ['https://api.minimax.chat/v1'], 'MINIMAX_API_KEY', ['codex', 'opencode']),
  provider('stepfun', 'StepFun', 'cn', ['openai-chat'], ['https://api.stepfun.com/v1'], 'STEPFUN_API_KEY', ['codex', 'opencode']),
  provider('sensenova', 'SenseNova', 'cn', ['openai-chat'], ['https://api.sensenova.cn/compatible-mode/v1'], 'SENSENOVA_API_KEY', ['codex', 'opencode']),
  provider('modelscope', 'ModelScope', 'cn', ['openai-chat'], ['https://api-inference.modelscope.cn/v1'], 'MODELSCOPE_API_KEY', ['codex', 'opencode']),
  provider('infiniai', 'InfiniAI', 'cn', ['openai-chat'], ['https://cloud.infini-ai.com/maas/v1'], 'INFINIAI_API_KEY', ['codex', 'opencode']),
  provider('aihubbmix', 'AiHubMix', 'relay', ['openai-chat', 'anthropic'], ['https://aihubmix.com/v1'], 'AIHUBMIX_API_KEY', ['codex', 'claudecode', 'opencode']),
  provider('newapi', 'New API', 'relay', ['openai-chat', 'anthropic'], ['https://{host}/v1'], 'NEWAPI_API_KEY', ['codex', 'claudecode', 'opencode', 'openclaw']),
  provider('one-api', 'One API', 'relay', ['openai-chat'], ['https://{host}/v1'], 'ONE_API_KEY', ['codex', 'opencode', 'openclaw']),
  provider('litellm', 'LiteLLM Proxy', 'relay', ['openai-chat', 'anthropic', 'gemini'], ['https://{host}/v1'], 'LITELLM_API_KEY', ['codex', 'claudecode', 'gemini', 'opencode']),
  provider('portkey', 'Portkey', 'relay', ['openai-chat', 'anthropic'], ['https://api.portkey.ai/v1'], 'PORTKEY_API_KEY', ['codex', 'claudecode', 'opencode']),
  provider('helicone', 'Helicone AI Gateway', 'relay', ['openai-chat', 'anthropic'], ['https://oai.helicone.ai/v1'], 'HELICONE_API_KEY', ['codex', 'claudecode', 'opencode']),
  provider('requesty', 'Requesty', 'relay', ['openai-chat'], ['https://router.requesty.ai/v1'], 'REQUESTY_API_KEY', ['codex', 'opencode']),
  provider('novita', 'Novita AI', 'global', ['openai-chat'], ['https://api.novita.ai/v3/openai'], 'NOVITA_API_KEY', ['codex', 'opencode']),
  provider('lepton', 'Lepton AI', 'global', ['openai-chat'], ['https://{workspace}.lepton.run/api/v1'], 'LEPTON_API_KEY', ['codex', 'opencode']),
  provider('replicate', 'Replicate', 'global', ['openai-chat'], ['https://api.replicate.com/v1'], 'REPLICATE_API_TOKEN', ['opencode']),
  provider('huggingface', 'Hugging Face Inference', 'global', ['openai-chat'], ['https://router.huggingface.co/v1'], 'HF_TOKEN', ['codex', 'opencode']),
  provider('cerebras', 'Cerebras', 'global', ['openai-chat'], ['https://api.cerebras.ai/v1'], 'CEREBRAS_API_KEY', ['codex', 'opencode']),
  provider('sambanova', 'SambaNova Cloud', 'global', ['openai-chat'], ['https://api.sambanova.ai/v1'], 'SAMBANOVA_API_KEY', ['codex', 'opencode']),
  provider('nebius', 'Nebius AI Studio', 'global', ['openai-chat'], ['https://api.studio.nebius.ai/v1'], 'NEBIUS_API_KEY', ['codex', 'opencode']),
  provider('lambda', 'Lambda Cloud', 'global', ['openai-chat'], ['https://api.lambda.ai/v1'], 'LAMBDA_API_KEY', ['codex', 'opencode']),
  provider('nvidia-nim', 'NVIDIA NIM', 'global', ['openai-chat'], ['https://integrate.api.nvidia.com/v1'], 'NVIDIA_API_KEY', ['codex', 'opencode']),
  provider('friendli', 'FriendliAI', 'global', ['openai-chat'], ['https://api.friendli.ai/serverless/v1'], 'FRIENDLI_TOKEN', ['codex', 'opencode']),
  provider('deepinfra', 'DeepInfra', 'global', ['openai-chat'], ['https://api.deepinfra.com/v1/openai'], 'DEEPINFRA_API_TOKEN', ['codex', 'opencode']),
  provider('anyscale', 'Anyscale Endpoints', 'global', ['openai-chat'], ['https://api.endpoints.anyscale.com/v1'], 'ANYSCALE_API_KEY', ['codex', 'opencode']),
  provider('hyperbolic', 'Hyperbolic', 'global', ['openai-chat'], ['https://api.hyperbolic.xyz/v1'], 'HYPERBOLIC_API_KEY', ['codex', 'opencode']),
  provider('parasail', 'Parasail', 'global', ['openai-chat'], ['https://api.parasail.io/v1'], 'PARASAIL_API_KEY', ['codex', 'opencode']),
  provider('crusoe', 'Crusoe Cloud', 'global', ['openai-chat'], ['https://api.crusoe.ai/v1'], 'CRUSOE_API_KEY', ['codex', 'opencode']),
  provider('github-models', 'GitHub Models', 'global', ['openai-chat'], ['https://models.github.ai/inference'], 'GITHUB_TOKEN', ['codex', 'opencode']),
  provider('vercel-ai-gateway', 'Vercel AI Gateway', 'relay', ['openai-chat'], ['https://ai-gateway.vercel.sh/v1'], 'VERCEL_AI_GATEWAY_API_KEY', ['codex', 'opencode']),
  provider('cloudflare-workers-ai', 'Cloudflare Workers AI', 'global', ['openai-chat'], ['https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1'], 'CLOUDFLARE_API_TOKEN', ['codex', 'opencode']),
  provider('ibm-watsonx', 'IBM watsonx.ai', 'global', ['openai-chat'], ['https://{region}.ml.cloud.ibm.com/ml/v1/text/chat'], 'WATSONX_API_KEY', ['opencode']),
  provider('oci-generative-ai', 'Oracle OCI Generative AI', 'global', ['openai-chat'], ['https://inference.generativeai.{region}.oci.oraclecloud.com'], 'OCI_CONFIG_PROFILE', ['opencode']),
  provider('snowflake-cortex', 'Snowflake Cortex', 'global', ['openai-chat'], ['https://{account}.snowflakecomputing.com/api/v2/cortex/inference'], 'SNOWFLAKE_TOKEN', ['opencode']),
];

function provider(id, name, region, protocols, baseUrls, envKey, tools, extra = {}) {
  const expandedTools = expandProviderTools(protocols, tools);
  return {
    id,
    name,
    region,
    protocols,
    baseUrls,
    envKey,
    tools: expandedTools,
    tags: Array.from(new Set([region, ...protocols, ...expandedTools, ...(extra.tags || [])])),
    docsUrl: extra.docsUrl || '',
    notes: extra.notes || '',
    capabilities: {
      streaming: extra.streaming !== false,
      toolCalls: Boolean(extra.toolCalls),
      nativeResponses: protocols.includes('responses'),
      openAiCompatible: protocols.some((item) => item.includes('openai') || item === 'chat' || item === 'responses'),
      anthropicCompatible: protocols.includes('anthropic'),
      geminiCompatible: protocols.includes('gemini'),
    },
  };
}

function expandProviderTools(protocols = [], tools = []) {
  const set = new Set((tools || []).map((item) => String(item || '').trim()).filter(Boolean));
  const normalizedProtocols = new Set((protocols || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
  const openAiCompatible = [...normalizedProtocols].some((item) => item.includes('openai') || item === 'chat' || item === 'responses');
  const anthropicCompatible = normalizedProtocols.has('anthropic');
  const geminiCompatible = normalizedProtocols.has('gemini') || normalizedProtocols.has('vertex');
  if (openAiCompatible) {
    ['codex', 'gemini', 'opencode', 'openclaw', 'hermes'].forEach((tool) => set.add(tool));
  }
  if (anthropicCompatible) {
    ['claudecode', 'claude-desktop', 'opencode', 'openclaw', 'hermes'].forEach((tool) => set.add(tool));
  }
  if (geminiCompatible) {
    ['gemini', 'codex', 'opencode', 'openclaw', 'hermes'].forEach((tool) => set.add(tool));
  }
  return PROVIDER_CATALOG_TOOL_ORDER.filter((tool) => set.has(tool)).concat(
    [...set].filter((tool) => !PROVIDER_CATALOG_TOOL_ORDER.includes(tool)).sort(),
  );
}

function publicPreset(preset) {
  return {
    id: preset.id,
    name: preset.name,
    region: preset.region,
    protocols: [...preset.protocols],
    baseUrls: [...preset.baseUrls],
    envKey: preset.envKey,
    tools: [...preset.tools],
    tags: [...preset.tags],
    docsUrl: preset.docsUrl,
    notes: preset.notes,
    capabilities: { ...preset.capabilities },
  };
}

function normalizeFilter(value) {
  return String(value || '').trim().toLowerCase();
}

export function listProviderPresets(filters = {}) {
  const query = normalizeFilter(filters.query);
  const tool = normalizeFilter(filters.tool);
  const region = normalizeFilter(filters.region);
  const protocol = normalizeFilter(filters.protocol);
  const tag = normalizeFilter(filters.tag);
  return PROVIDER_PRESETS
    .filter((preset) => {
      if (tool && !preset.tools.some((item) => item.toLowerCase() === tool)) return false;
      if (region && preset.region.toLowerCase() !== region) return false;
      if (protocol && !preset.protocols.some((item) => item.toLowerCase() === protocol)) return false;
      if (tag && !preset.tags.some((item) => item.toLowerCase() === tag)) return false;
      if (!query) return true;
      const haystack = [
        preset.id,
        preset.name,
        preset.region,
        preset.envKey,
        ...preset.protocols,
        ...preset.baseUrls,
        ...preset.tools,
        ...preset.tags,
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    })
    .map(publicPreset);
}

export function getProviderPreset(id) {
  const target = normalizeFilter(id);
  const preset = PROVIDER_PRESETS.find((item) => item.id.toLowerCase() === target);
  return preset ? publicPreset(preset) : null;
}

export function providerCatalogSummary() {
  const regions = new Map();
  const protocols = new Map();
  const tools = new Map();
  for (const preset of PROVIDER_PRESETS) {
    regions.set(preset.region, (regions.get(preset.region) || 0) + 1);
    preset.protocols.forEach((item) => protocols.set(item, (protocols.get(item) || 0) + 1));
    preset.tools.forEach((item) => tools.set(item, (tools.get(item) || 0) + 1));
  }
  return {
    revision: CATALOG_REVISION,
    count: PROVIDER_PRESETS.length,
    regions: Object.fromEntries(regions),
    protocols: Object.fromEntries(protocols),
    tools: Object.fromEntries(tools),
  };
}

export function exportProviderCatalog(filters = {}) {
  return {
    schema: 'easyaiconfig.provider-catalog.v1',
    exportedAt: new Date().toISOString(),
    summary: providerCatalogSummary(),
    presets: listProviderPresets(filters),
  };
}

function base64UrlEncodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function base64UrlDecodeJson(value) {
  const text = Buffer.from(String(value || ''), 'base64url').toString('utf8');
  return JSON.parse(text);
}

export function buildAssetImportDeepLink(payload = {}) {
  return `easyai://import?payload=${base64UrlEncodeJson(payload)}`;
}

function firstParam(params, names = []) {
  for (const name of names) {
    const value = params.get(name);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseJsonParam(params, names = []) {
  const raw = firstParam(params, names);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parseStringList(parsed);
    if (typeof parsed === 'string') return parseStringList(parsed);
  } catch {
    // Query params often use compact comma-separated lists instead of JSON arrays.
  }
  const splitter = raw.includes(',') || raw.includes('\n') ? /[,\n]/ : /\s+/;
  return raw.split(splitter).map((item) => item.trim()).filter(Boolean);
}

function parseQueryObject(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to KEY=value parsing for small Deep Link query payloads.
  }
  const entries = raw
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) return null;
      return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    })
    .filter((entry) => entry && entry[0]);
  return entries.length ? Object.fromEntries(entries) : null;
}

function parseBooleanParam(params, names = []) {
  const raw = firstParam(params, names).toLowerCase();
  if (!raw) return undefined;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) return false;
  return undefined;
}

function parseObjectParam(params, names = []) {
  const parsed = parseJsonParam(params, names);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  return null;
}

function normalizeCcswitchV1Resource(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (['provider', 'providers', 'model-provider', 'model-providers'].includes(normalized)) return 'provider';
  if (['mcp', 'mcp-server', 'mcp-servers', 'server', 'servers'].includes(normalized)) return 'mcp';
  if (['prompt', 'prompts', 'instruction', 'instructions'].includes(normalized)) return 'prompt';
  if (['skill', 'skills'].includes(normalized)) return 'skill';
  return normalized;
}

function isCcswitchV1ImportUrl(url) {
  if (url.protocol !== 'ccswitch:') return false;
  const hasResource = Boolean(firstParam(url.searchParams, ['resource', 'type', 'kind']));
  if (!hasResource) return false;
  const host = String(url.hostname || '').toLowerCase();
  const path = String(url.pathname || '').replace(/^\/+|\/+$/g, '').toLowerCase();
  return (host === 'v1' && path === 'import')
    || host === 'import'
    || path === 'v1/import';
}

function mergeQueryFields(base = {}, fields = {}) {
  const next = { ...base };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length) next[key] = value;
      continue;
    }
    if (value && typeof value === 'object') {
      if (Object.keys(value).length) next[key] = value;
      continue;
    }
    if (typeof value === 'string' && value.trim()) next[key] = value.trim();
    if (typeof value === 'boolean') next[key] = value;
  }
  return next;
}

function ccswitchProviderFromParams(params) {
  const item = parseObjectParam(params, ['provider', 'item', 'asset', 'config']) || {};
  const protocols = parseStringList(firstParam(params, ['protocols', 'protocolList']));
  const tools = parseStringList(firstParam(params, ['tools', 'tool', 'targetTools', 'targets', 'clients']));
  const models = parseStringList(firstParam(params, ['models']));
  const config = parseQueryObject(firstParam(params, ['config']));
  return mergeQueryFields(item, {
    id: firstParam(params, ['id', 'key', 'providerKey', 'name']),
    key: firstParam(params, ['key', 'providerKey']),
    name: firstParam(params, ['name', 'label', 'title']),
    baseUrl: firstParam(params, ['baseUrl', 'base_url', 'baseURL', 'url', 'endpoint']),
    endpoint: firstParam(params, ['endpoint']),
    envKey: firstParam(params, ['envKey', 'env_key', 'apiKeyEnv', 'api_key_env']),
    apiKeyEnv: firstParam(params, ['apiKeyEnv', 'api_key_env', 'envKey', 'env_key']),
    apiKey: firstParam(params, ['apiKey', 'api_key']),
    wireApi: firstParam(params, ['wireApi', 'wire_api', 'api', 'protocol']),
    protocols: protocols.length ? protocols : parseStringList(item.protocols || item.protocolList),
    homepage: firstParam(params, ['homepage', 'homePage', 'docsUrl', 'docs_url']),
    model: firstParam(params, ['model', 'defaultModel', 'default_model']),
    models: models.length ? models : parseStringList(item.models),
    config: config || (item.config && typeof item.config === 'object' && !Array.isArray(item.config) ? item.config : null),
    configFormat: firstParam(params, ['configFormat', 'config_format']),
    configUrl: firstParam(params, ['configUrl', 'config_url']),
    usageScript: firstParam(params, ['usageScript', 'usage_script']),
    tools: tools.length ? tools : parseStringList(item.tools || item.targetTools || item.tool),
  });
}

function ccswitchMcpFromParams(params) {
  const item = parseObjectParam(params, ['server', 'mcp', 'item', 'asset', 'config']) || {};
  const args = parseStringList(firstParam(params, ['args', 'arguments', 'argv']));
  const env = parseQueryObject(firstParam(params, ['env', 'environment']));
  const config = parseQueryObject(firstParam(params, ['config']));
  const apps = parseStringList(firstParam(params, ['apps', 'app', 'clients']));
  const tools = parseStringList(firstParam(params, ['tools', 'tool', 'targetTools', 'targets', 'clients']));
  return mergeQueryFields(item, {
    id: firstParam(params, ['id', 'serverId', 'server_id', 'name']),
    name: firstParam(params, ['name', 'label']),
    command: firstParam(params, ['command', 'cmd']),
    args: args.length ? args : parseStringList(item.args),
    env: env || (item.env && typeof item.env === 'object' && !Array.isArray(item.env) ? item.env : null),
    transport: firstParam(params, ['transport', 'type']),
    url: firstParam(params, ['url', 'endpoint']),
    apps: apps.length ? apps : parseStringList(item.apps || item.app),
    config: config || (item.config && typeof item.config === 'object' && !Array.isArray(item.config) ? item.config : null),
    enabled: parseBooleanParam(params, ['enabled']),
    tools: tools.length ? tools : parseStringList(item.tools || item.targetTools || item.tool),
  });
}

function ccswitchPromptFromParams(params) {
  const item = parseObjectParam(params, ['promptAsset', 'item', 'asset', 'config']) || {};
  const tools = parseStringList(firstParam(params, ['tools', 'tool', 'targetTools', 'targets', 'clients']));
  return mergeQueryFields(item, {
    id: firstParam(params, ['id', 'promptId', 'prompt_id', 'tool', 'fileName', 'filename', 'name']),
    promptId: firstParam(params, ['promptId', 'prompt_id']),
    tool: firstParam(params, ['tool', 'targetTool']),
    fileName: firstParam(params, ['fileName', 'filename', 'path']),
    scope: firstParam(params, ['scope']),
    title: firstParam(params, ['title', 'name']),
    description: firstParam(params, ['description', 'desc']),
    content: firstParam(params, ['content', 'text', 'body', 'prompt', 'markdown']),
    enabled: parseBooleanParam(params, ['enabled']),
    tools: tools.length ? tools : parseStringList(item.tools || item.targetTools),
  });
}

function ccswitchSkillFromParams(params) {
  const item = parseObjectParam(params, ['skillAsset', 'item', 'asset', 'config']) || {};
  const tools = parseStringList(firstParam(params, ['tools', 'tool', 'targetTools', 'targets', 'clients']));
  return mergeQueryFields(item, {
    id: firstParam(params, ['id', 'slug', 'name', 'title']),
    name: firstParam(params, ['name', 'slug', 'id']),
    title: firstParam(params, ['title', 'name']),
    content: firstParam(params, ['content', 'text', 'markdown', 'skillMd', 'skillMD']),
    skillMd: firstParam(params, ['skillMd', 'skillMD']),
    installMode: firstParam(params, ['installMode', 'install_mode', 'mode']),
    repositoryUrl: firstParam(params, ['repositoryUrl', 'repoUrl', 'repo', 'github', 'repository']),
    repoUrl: firstParam(params, ['repoUrl', 'repo', 'repositoryUrl']),
    repository: firstParam(params, ['repository', 'repo', 'repositoryUrl']),
    directory: firstParam(params, ['directory', 'dir', 'subdirectory', 'subdir']),
    branch: firstParam(params, ['branch', 'ref']),
    zipUrl: firstParam(params, ['zipUrl', 'archiveUrl']),
    url: firstParam(params, ['url']),
    tools: tools.length ? tools : parseStringList(item.tools || item.targetTools || item.tool),
  });
}

function assetBundleFromCcswitchV1Url(url) {
  const params = url.searchParams;
  const resource = normalizeCcswitchV1Resource(firstParam(params, ['resource', 'type', 'kind']));
  const assets = {};
  if (resource === 'provider') {
    assets.providers = [ccswitchProviderFromParams(params)];
  } else if (resource === 'mcp') {
    assets.mcpServers = [ccswitchMcpFromParams(params)];
  } else if (resource === 'prompt') {
    assets.prompts = [ccswitchPromptFromParams(params)];
  } else if (resource === 'skill') {
    assets.skills = [ccswitchSkillFromParams(params)];
  } else {
    throw new Error('Unsupported cc-switch V1 Deep Link resource');
  }
  return {
    schema: 'easyaiconfig.asset-bundle.v1',
    app: 'cc-switch',
    source: 'ccswitch-deeplink-v1',
    version: 1,
    importedAt: new Date().toISOString(),
    assets,
  };
}

export function parseAssetImportInput(input = {}) {
  if (typeof input === 'string') return parseAssetImportText(input);
  if (input && typeof input === 'object') {
    if (typeof input.url === 'string' && input.url.trim()) return parseAssetImportText(input.url);
    if (typeof input.text === 'string' && input.text.trim()) return parseAssetImportText(input.text);
    if (input.payload && typeof input.payload === 'object') return input.payload;
  }
  throw new Error('Import payload is required');
}

function parseAssetImportText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Import payload is required');
  if (raw.startsWith('easyai://') || raw.startsWith('easyaiconfig://') || raw.startsWith('ccswitch://')) {
    const url = new URL(raw);
    if (isCcswitchV1ImportUrl(url)) return assetBundleFromCcswitchV1Url(url);
    const encoded = url.searchParams.get('payload');
    const data = url.searchParams.get('data');
    if (encoded) return base64UrlDecodeJson(encoded);
    if (data) return JSON.parse(decodeURIComponent(data));
    throw new Error('Deep Link is missing payload');
  }
  return JSON.parse(raw);
}

function arrayCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

function objectCount(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstArrayString(value) {
  if (!Array.isArray(value)) return '';
  return firstString(...value);
}

function normalizeProviderImportKey(value = '') {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!key) return '';
  return /^\d/.test(key) ? `provider-${key}` : key;
}

function normalizeProviderImportProtocols(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
}

function normalizeProviderImportTools(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
}

function wireApiFromProviderImport(item = {}) {
  const explicit = firstString(item.wireApi, item.wire_api, item.api, item.protocol);
  if (explicit) {
    const normalized = explicit.toLowerCase();
    if (normalized.includes('response')) return 'responses';
    if (normalized.includes('anthropic')) return 'anthropic';
    if (normalized.includes('chat') || normalized.includes('completion')) return 'chat';
    return normalized;
  }
  const protocols = normalizeProviderImportProtocols(item.protocols);
  if (protocols.includes('responses')) return 'responses';
  if (protocols.some((protocol) => protocol.includes('chat') || protocol.includes('completion'))) return 'chat';
  if (protocols.includes('anthropic')) return 'anthropic';
  return 'responses';
}

function normalizeProviderImportItem(item = {}, { targetTool = 'codex' } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const baseUrl = firstString(
    item.baseUrl,
    item.base_url,
    item.url,
    item.endpoint,
    firstArrayString(item.baseUrls),
    firstArrayString(item.base_urls),
  );
  const key = normalizeProviderImportKey(firstString(item.id, item.key, item.providerKey, item.name, baseUrl));
  const tools = normalizeProviderImportTools(item.tools);
  const target = String(targetTool || '').trim().toLowerCase();
  if (target && target !== 'all' && tools.length && !tools.includes(target)) return null;
  if (!key || !baseUrl) return null;
  const protocols = normalizeProviderImportProtocols(item.protocols);
  return {
    key,
    name: firstString(item.name, item.label, key),
    baseUrl,
    envKey: firstString(item.envKey, item.env_key, item.apiKeyEnv, item.api_key_env),
    wireApi: wireApiFromProviderImport({ ...item, protocols }),
    protocols,
    tools,
    sourceId: firstString(item.id, item.key, key),
  };
}

export function extractProviderImportItems(input = {}, options = {}) {
  const payload = parseAssetImportInput(input);
  const assets = payload.assets && typeof payload.assets === 'object' ? payload.assets : payload;
  const explicitProviders = Array.isArray(assets.providers)
    ? assets.providers
    : Array.isArray(payload.providers)
      ? payload.providers
      : [];
  const catalogPresets = options.includeCatalogPresets
    ? (Array.isArray(assets.providerCatalog?.presets)
        ? assets.providerCatalog.presets
        : Array.isArray(payload.providerCatalog?.presets)
          ? payload.providerCatalog.presets
          : [])
    : [];
  const seen = new Set();
  const items = [];
  for (const providerItem of [...explicitProviders, ...catalogPresets]) {
    const normalized = normalizeProviderImportItem(providerItem, options);
    if (!normalized || seen.has(normalized.key)) continue;
    seen.add(normalized.key);
    items.push(normalized);
  }
  return {
    schema: payload.schema || 'unknown',
    app: payload.app || payload.source || '',
    version: payload.version || '',
    providers: items,
  };
}

export function previewAssetImport(input = {}) {
  const payload = parseAssetImportInput(input);
  const assets = payload.assets && typeof payload.assets === 'object' ? payload.assets : payload;
  const providerCatalog = assets.providerCatalog || payload.providerCatalog || null;
  const providers = assets.providers || payload.providers || providerCatalog?.presets || [];
  const mcpServers = assets.mcpServers || payload.mcpServers || {};
  const prompts = assets.prompts || payload.prompts || [];
  const skills = assets.skills || payload.skills || [];
  const sessions = assets.sessions || payload.sessions || [];
  const warnings = [];
  if (!Array.isArray(providers) && !providers?.presets) warnings.push('providers is not an array');
  return {
    schema: payload.schema || 'unknown',
    app: payload.app || payload.source || '',
    version: payload.version || '',
    counts: {
      providers: arrayCount(Array.isArray(providers) ? providers : providers?.presets),
      mcpServers: Array.isArray(mcpServers) ? mcpServers.length : objectCount(mcpServers),
      prompts: arrayCount(prompts),
      skills: arrayCount(skills),
      sessions: arrayCount(sessions),
    },
    warnings,
    payload,
  };
}

export function exportAssetBundle(options = {}) {
  const includeProviderCatalog = options.includeProviderCatalog !== false;
  const assets = {};
  if (includeProviderCatalog) assets.providerCatalog = exportProviderCatalog(options.providerFilters || {});
  return {
    schema: 'easyaiconfig.asset-bundle.v1',
    app: 'EasyAIConfig',
    version: 1,
    exportedAt: new Date().toISOString(),
    assets,
  };
}
