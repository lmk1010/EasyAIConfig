import { SPECIAL_GUIDES } from './config-store-guides.js';

const TOOL_DEFAULT_PROMPTS = {
  codex: ['切到 GPT-5.4 并开启高推理', '给我一个安全的只读模式', '把上下文窗口调大', '设置成务实风格'],
  openclaw: ['接入 Telegram Bot', '让 Discord 只在被 @ 时回复', '开启局域网访问 Gateway', '启用 QMD 记忆'],
  claudecode: ['设置为 Sonnet', '打开更高推理', '切换到更安全模式'],
};

const GLOBAL_SYNONYMS = {
  tg: ['telegram', '电报', 'telegram bot', 'tg'],
  dc: ['discord', 'discord bot', '服务器机器人'],
  wa: ['whatsapp', 'whats app', 'whatsapp bot', '手机聊天'],
  gc: ['google chat', '谷歌聊天', 'googlechat'],
  teams: ['msteams', 'microsoft teams', 'teams', '微软团队'],
  slack: ['slack', 'slack bot'],
  signal: ['signal', 'signal-cli'],
  irc: ['irc', '聊天室'],
  imessage: ['imessage', '苹果短信', '苹果信息'],
  gateway: ['gateway', '网关', '面板', 'dashboard', '控制台'],
  lan: ['局域网', '内网', '同一网络', '手机访问', '局域网访问'],
  https: ['https', 'ssl', 'tls', '证书', '加密访问'],
  reverse_proxy: ['反向代理', 'reverse proxy', 'nginx', 'caddy', 'traefik'],
  memory: ['记忆', 'memory', 'qmd', '知识库', '检索'],
  browser: ['浏览器', 'browser', 'cdp', '网页操作'],
  plugin: ['插件', 'plugin', 'plugins'],
  skill: ['技能', 'skill', 'skills'],
  safe: ['安全', '只读', 'readonly', '保守', '建议审批'],
  mention_only: ['只在被提及时回复', '@才回复', '需要提及', 'mention only'],
  whitelist: ['白名单', 'allowlist', '只允许指定用户'],
  webhook: ['webhook', '回调', '签名验证'],
  cron: ['定时', 'cron', '计划任务'],
};

const INTENT_RULES = [
  { id: 'connect_channel', patterns: [/接入|连接|配置.*(telegram|discord|slack|whatsapp|signal|teams|google chat|irc|imessage)/i, /(telegram|discord|slack|whatsapp|signal|teams|google chat|irc|imessage).*(bot|渠道|接入)/i] },
  { id: 'provider_setup', patterns: [/openai|anthropic|claude|gemini|deepseek|ollama|azure|groq/i] },
  { id: 'gateway_access', patterns: [/局域网|内网|手机访问|gateway|dashboard|面板|控制台/i] },
  { id: 'secure_gateway', patterns: [/https|ssl|tls|证书|反向代理|trusted proxy/i] },
  { id: 'memory_setup', patterns: [/记忆|memory|qmd|知识库|检索/i] },
  { id: 'plugin_setup', patterns: [/插件|plugin|skills|技能|browser|浏览器/i] },
  { id: 'restrict_access', patterns: [/白名单|allowlist|只允许|仅允许|安全/i] },
  { id: 'mention_only', patterns: [/提及|mention|@才|只在被 @ 时/i] },
  { id: 'logging_debug', patterns: [/日志|debug|调试|排错/i] },
];

const CATEGORY_GUIDES = {
  '模型': { prep: ['确认你要使用的模型名称。'], tutorial: ['选择适合你的模型。', '保存后可立即在右侧原始配置里看到变更。'], verify: ['打开当前配置，确认模型字段已生效。'] },
  '推理': { prep: ['确认你更看重速度还是质量。'], tutorial: ['选择推理强度。', '复杂任务用高推理，简单任务用 minimal。'], verify: ['再次打开配置编辑器确认推理强度。'] },
  '上下文': { prep: ['确认你的模型和机器能承受更大上下文。'], tutorial: ['提升窗口后同步调整自动压缩阈值。'], verify: ['检查上下文窗口和阈值是否同时变化。'] },
  '安全': { prep: ['确认是否真的需要更高权限。'], tutorial: ['优先使用最小权限。', '仅在明确需要时开启更高访问。'], verify: ['应用后再次检查沙箱/审批相关字段。'] },
  '服务': { prep: ['确认你更需要速度还是成本平衡。'], tutorial: ['选择服务层。'], verify: ['查看 service_tier 是否写入。'] },
  '个性': { prep: ['想清楚助手应该更友好还是更务实。'], tutorial: ['设置后立即影响回复风格。'], verify: ['从配置编辑器确认 personality 字段。'] },
  '工作流': { prep: ['确认这是你希望长期使用的默认工作流。'], tutorial: ['一键应用后可再微调细节。'], verify: ['对照变更预览检查相关字段。'] },
  '渠道': { prep: ['准备好对应渠道的 token/账号信息。'], tutorial: ['按向导填写最少字段。', '应用后先做一次连通测试。'], verify: ['保存后在渠道 badge 上应显示已配置。'] },
  'Agent': { prep: ['确认你希望更快还是更稳。'], tutorial: ['先改默认行为，再逐项测试。'], verify: ['检查 agents.defaults 相关字段。'] },
  '工具': { prep: ['确认默认工具策略。'], tutorial: ['先从保守配置开始。'], verify: ['查看 tools 配置是否生效。'] },
  '会话': { prep: ['想清楚会话是全局共享还是隔离。'], tutorial: ['修改会话策略时注意重置方式。'], verify: ['检查 session 配置块。'] },
  '网络': { prep: ['确认是否暴露给局域网或公网。'], tutorial: ['局域网访问先从 bind/认证入手。', '公网访问建议配 HTTPS / reverse proxy。'], verify: ['保存后测试 Dashboard 可达性。'] },
  '定时': { prep: ['确认定时任务是否需要长期运行。'], tutorial: ['先启用，再补并发和保留策略。'], verify: ['检查 cron 是否已启用。'] },
  '钩子': { prep: ['准备好 webhook 路径和 secret。'], tutorial: ['开启前先确定谁会调用它。'], verify: ['保存后检查 hooks 配置。'] },
  '日志': { prep: ['确认你想看更多日志还是减少噪声。'], tutorial: ['排错用 debug，稳定运行可降级。'], verify: ['检查 logging 字段。'] },
  '身份': { prep: ['准备助手名称、头像或品牌色。'], tutorial: ['改完后 UI 和消息前缀会更一致。'], verify: ['查看 ui.assistant 配置。'] },
};

function uniq(items) {
  return [...new Set(items.filter(Boolean))];
}

export function normalizeStoreText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u3000\t\n\r]+/g, ' ')
    .replace(/[，。、“”‘’【】（）()、:：;；!！?？/\\|\-+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function charBigrams(text = '') {
  const raw = normalizeStoreText(text).replace(/\s+/g, '');
  const grams = [];
  for (let i = 0; i < raw.length - 1; i += 1) grams.push(raw.slice(i, i + 2));
  return grams;
}

function overlapScore(left = '', right = '') {
  const a = charBigrams(left);
  const b = new Set(charBigrams(right));
  if (!a.length || !b.size) return 0;
  let hit = 0;
  for (const item of a) if (b.has(item)) hit += 1;
  return hit / Math.max(a.length, 1);
}

function detectIntents(query = '') {
  return uniq(INTENT_RULES.flatMap((rule) => rule.patterns.some((pattern) => pattern.test(query)) ? [rule.id] : []));
}

function expandEntities(query = '') {
  const normalized = normalizeStoreText(query);
  const entities = [];
  for (const [entity, aliases] of Object.entries(GLOBAL_SYNONYMS)) {
    if (aliases.some((alias) => normalized.includes(normalizeStoreText(alias)))) entities.push(entity);
  }
  return uniq(entities);
}

function expandQueryTerms(query = '') {
  const normalized = normalizeStoreText(query);
  const terms = normalized.split(/\s+/).filter(Boolean);
  const expanded = [...terms];
  for (const aliases of Object.values(GLOBAL_SYNONYMS)) {
    const normalizedAliases = aliases.map((alias) => normalizeStoreText(alias));
    if (normalizedAliases.some((alias) => normalized.includes(alias))) expanded.push(...normalizedAliases);
  }
  return uniq(expanded);
}

function categoryGuide(recipe) {
  return CATEGORY_GUIDES[recipe.cat] || {
    prep: ['确认你知道这个方案会改哪些配置。'],
    tutorial: ['阅读说明。', '按向导填写必要字段。', '预览配置后再应用。'],
    verify: ['应用后回到配置编辑器确认字段已写入。'],
  };
}

function ensureGuideSentence(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return '';
  return /[。！？.!?]$/.test(raw) ? raw : `${raw}。`;
}

function buildFieldHelp(recipe, field, tool) {
  if (field.help) return ensureGuideSentence(field.help);
  const label = String(field.label || '').toLowerCase();
  const key = String(field.key || '').toLowerCase();
  const target = `${label} ${key}`;
  const example = field.placeholder ? `例如 ${field.placeholder}` : '';

  if (target.includes('token')) return ensureGuideSentence(`去对应平台后台复制 ${field.label}${example ? `，${example}` : ''}`);
  if (target.includes('secret')) return ensureGuideSentence(`去对应平台或应用详情页复制 ${field.label}${example ? `，${example}` : ''}`);
  if (target.includes('appid')) return ensureGuideSentence(`在对应平台开发设置页查看 ${field.label}${example ? `，${example}` : ''}`);
  if (target.includes('corpid')) return ensureGuideSentence('在企业管理后台“我的企业”页面复制 CorpID');
  if (target.includes('agentid')) return ensureGuideSentence('在应用详情页查看 AgentID，通常是纯数字');
  if (target.includes('私钥')) return ensureGuideSentence(`填写私钥文件路径${example ? `，${example}` : ''}`);
  if (target.includes('api key') || target.includes('apikey') || label.includes('api')) return ensureGuideSentence(`去对应平台控制台创建并复制 ${field.label}${example ? `，${example}` : ''}`);
  if (target.includes('url') || target.includes('base url') || target.includes('endpoint') || target.includes('homeserver')) return ensureGuideSentence(`填写完整服务地址${example ? `，${example}` : ''}`);
  if (target.includes('path') || target.includes('路径')) return ensureGuideSentence(`填写你希望暴露的路径，建议以 / 开头${example ? `，${example}` : ''}`);
  if (target.includes('port') || target.includes('端口')) return ensureGuideSentence(`填写监听端口${example ? `，${example}` : ''}`);
  if (target.includes('model') || target.includes('模型')) return ensureGuideSentence(`填写模型名称${example ? `，${example}` : ''}`);
  if (target.includes('cert') || target.includes('证书')) return ensureGuideSentence(`填写证书文件路径${example ? `，${example}` : ''}`);
  if (target.includes('prompt') || target.includes('提示词')) return ensureGuideSentence('直接填写你希望助手长期遵循的系统提示词');
  if (target.includes('name') || target.includes('名称')) return ensureGuideSentence(`填写你想展示给用户的名称${example ? `，${example}` : ''}`);
  return ensureGuideSentence(example || `按实际值填写 ${field.label}`);
}

function buildDefaultAccess(recipe, tool) {
  const items = [];
  if (tool === 'openclaw') items.push('本地 Dashboard：{{gatewayUrl}}');
  if (recipe.cat === '网络') items.push('局域网访问示例：{{lanDashboardUrl}}');

  const recipeSpecific = {
    'claude-direct': ['Anthropic Console：https://console.anthropic.com/'],
    'gemini-direct': ['Google AI Studio：https://aistudio.google.com/'],
    'deepseek-direct': ['DeepSeek 平台：https://platform.deepseek.com/'],
    'ollama-local': ['Ollama 默认地址：http://127.0.0.1:11434/'],
    'openai-proxy': ['代理 Base URL 示例：https://your-proxy.com/v1'],
    'web-search': ['搜索 provider 示例：brave / perplexity / grok'],
    'gw-https': ['公网 HTTPS 示例：{{publicBaseUrl}}/'],
    'gw-reverse-proxy': ['反向代理后地址示例：{{publicBaseUrl}}/'],
    'hooks-secret': ['Webhook URL 示例：{{publicWebhookUrl}}'],
    'log-file': ['日志路径示例：`./logs/openclaw.log`'],
  };
  return uniq([...(recipeSpecific[recipe.id] || []), ...items].map(ensureGuideSentence));
}

function buildDefaultPrep(recipe, tool, catGuide, fieldQuestions) {
  const items = [...(catGuide.prep || [])];
  const required = fieldQuestions.filter((field) => field.required).map((field) => `\`${field.label}\``);
  if (tool === 'openclaw' && recipe.cat !== '模型') items.unshift('先确认 OpenClaw 本地 Dashboard 可以打开：{{gatewayUrl}}。');
  if (required.length) items.push(`这个方案至少要准备：${required.join('、')}。`);
  if (tool === 'openclaw' && ['渠道', '网络', '钩子'].includes(recipe.cat)) {
    items.push('如果外部平台需要主动回调到你的服务，优先准备公网 HTTPS 域名。');
  }
  return uniq(items.map(ensureGuideSentence));
}

function buildDefaultTutorial(recipe, tool, catGuide, fieldQuestions) {
  const steps = [...(catGuide.tutorial || [])];
  if (fieldQuestions.length) {
    fieldQuestions.forEach((field) => {
      steps.push(`右侧填写 \`${field.label}\`：${buildFieldHelp(recipe, field, tool)}`);
    });
  } else {
    steps.push('右侧无需额外填写，确认变更预览没问题后直接点击“应用配置”。');
  }

  if (tool === 'openclaw') {
    const tailByCategory = {
      '渠道': '应用后先在对应聊天平台发一条真实消息，验证收发链路。',
      'Provider': '应用后回到 Provider / 模型区域做一次连通测试。',
      'Agent': '应用后发一条简单消息，观察响应速度和行为是否符合预期。',
      '工具': '应用后重新进入目标工具或新会话，确认新策略已经生效。',
      '会话': '应用后新建一个会话，验证共享 / 隔离 / 重置策略。',
      '网络': '应用后立即用浏览器访问本地或局域网地址，先确认服务可达。',
      '定时': '应用后补充你的任务定义，再观察是否按计划执行。',
      '钩子': '应用后用 curl 或 Postman 发送一次请求，确认入口可用。',
      '日志': '应用后观察控制台或日志文件，确认级别和输出位置变化。',
      '身份': '应用后刷新 Dashboard 或对话界面，确认名称或头像已变更。',
      '安全': '应用前确认环境可信；应用后立刻验证权限和审批行为是否符合预期。',
    };
    if (tailByCategory[recipe.cat]) steps.push(tailByCategory[recipe.cat]);
  }

  return uniq(steps.map(ensureGuideSentence));
}

function buildDefaultVerify(recipe, tool, catGuide, fieldQuestions) {
  const items = [...(catGuide.verify || [])];
  if (fieldQuestions.length) items.push('同时对照右侧“变更预览”，确认写入字段和你的预期一致。');
  if (tool === 'openclaw') {
    const extraByCategory = {
      '渠道': '检查对应渠道 badge 是否已变成“已配置”。',
      'Provider': '检查模型请求是否不再报认证或地址错误。',
      '网络': '检查本地、局域网或公网地址是否可达。',
      '钩子': '检查外部回调请求是否能真正到达 OpenClaw。',
      '日志': '检查日志级别、日志文件或控制台输出是否符合预期。',
      '身份': '检查 UI 或消息前缀是否显示新的身份信息。',
      '会话': '检查新会话和旧会话是否按你设置的策略工作。',
    };
    if (extraByCategory[recipe.cat]) items.push(extraByCategory[recipe.cat]);
  }
  return uniq(items.map(ensureGuideSentence));
}

function buildDefaultGuide(recipe, tool) {
  const catGuide = categoryGuide(recipe);
  const fieldQuestions = (recipe.fields || []).map((field) => ({
    key: field.key,
    label: field.label,
    placeholder: field.placeholder || '',
    required: !field.optional,
    type: field.type || 'text',
    help: buildFieldHelp(recipe, field, tool),
  }));
  return {
    scenario: recipe.name,
    overview: recipe.desc,
    aliases: uniq([recipe.name, ...(recipe.kw || '').split(/\s+/)]),
    intents: [],
    entities: [],
    examples: [],
    access: buildDefaultAccess(recipe, tool),
    prep: buildDefaultPrep(recipe, tool, catGuide, fieldQuestions),
    tutorial: buildDefaultTutorial(recipe, tool, catGuide, fieldQuestions),
    verify: buildDefaultVerify(recipe, tool, catGuide, fieldQuestions),
    questions: fieldQuestions,
    related: [],
    actionLabel: fieldQuestions.length ? '按引导配置' : '一键应用',
    tool,
  };
}
function mergeGuide(recipe, tool) {
  const base = buildDefaultGuide(recipe, tool);
  const extra = SPECIAL_GUIDES[recipe.id] || {};
  return {
    ...base,
    ...extra,
    aliases: uniq([...(base.aliases || []), ...(extra.aliases || [])]),
    intents: uniq([...(base.intents || []), ...(extra.intents || [])]),
    entities: uniq([...(base.entities || []), ...(extra.entities || [])]),
    examples: uniq([...(base.examples || []), ...(extra.examples || []), ...(tool === 'openclaw' ? TOOL_DEFAULT_PROMPTS.openclaw : TOOL_DEFAULT_PROMPTS.codex)]),
    access: uniq([...(base.access || []), ...(extra.access || [])]),
    prep: uniq([...(base.prep || []), ...(extra.prep || [])]),
    tutorial: uniq([...(base.tutorial || []), ...(extra.tutorial || [])]),
    verify: uniq([...(base.verify || []), ...(extra.verify || [])]),
  };
}

export function enrichConfigStoreRecipes(recipes = [], tool = 'codex') {
  return recipes.map((recipe) => {
    const guide = mergeGuide(recipe, tool);
    const searchText = normalizeStoreText([
      recipe.name,
      recipe.desc,
      recipe.kw,
      recipe.cat,
      ...(guide.aliases || []),
      ...(guide.examples || []),
      ...(guide.intents || []),
      ...(guide.entities || []),
      ...(guide.prep || []),
      ...(guide.tutorial || []),
    ].join(' '));
    return {
      ...recipe,
      guide,
      searchText,
      intentTags: guide.intents || [],
      entityTags: guide.entities || [],
    };
  });
}

export function searchConfigStoreRecipes(recipes = [], query = '', tool = 'codex') {
  const enriched = enrichConfigStoreRecipes(recipes, tool);
  const normalized = normalizeStoreText(query);
  if (!normalized) return enriched;
  const tokens = expandQueryTerms(normalized);
  const intents = detectIntents(normalized);
  const entities = expandEntities(normalized);

  return enriched
    .map((recipe) => {
      let score = 0;
      const reasons = [];
      const name = normalizeStoreText(recipe.name);
      const desc = normalizeStoreText(recipe.desc);
      const cat = normalizeStoreText(recipe.cat);
      const aliases = (recipe.guide.aliases || []).map((item) => normalizeStoreText(item));

      if (name.includes(normalized)) { score += 40; reasons.push('名称高度匹配'); }
      if (desc.includes(normalized)) { score += 16; reasons.push('描述匹配'); }
      if (aliases.some((alias) => alias.includes(normalized))) { score += 28; reasons.push('场景别名匹配'); }

      for (const token of tokens) {
        if (!token) continue;
        if (name.includes(token)) score += 12;
        if (aliases.some((alias) => alias.includes(token))) score += 10;
        if (recipe.searchText.includes(token)) score += 4;
        if (cat.includes(token)) score += 6;
      }

      for (const intent of intents) {
        if (recipe.intentTags.includes(intent)) {
          score += 26;
          reasons.push(`意图：${intent}`);
        }
      }
      for (const entity of entities) {
        if (recipe.entityTags.includes(entity) || recipe.searchText.includes(entity)) {
          score += 14;
          reasons.push(`实体：${entity}`);
        }
      }

      const fuzzy = overlapScore(normalized, recipe.searchText);
      score += Math.round(fuzzy * 24);
      return {
        ...recipe,
        _score: score,
        _reason: uniq(reasons).slice(0, 3),
      };
    })
    .filter((recipe) => recipe._score > 0)
    .sort((a, b) => b._score - a._score || a.name.localeCompare(b.name, 'zh-CN'));
}

function extractSlots(query = '') {
  const text = String(query || '').trim();
  const slots = {};
  const url = text.match(/https?:\/\/[^\s]+/i)?.[0];
  if (url) slots.baseUrl = url;
  const port = text.match(/(?:端口|port)\s*(\d{2,5})/i)?.[1];
  if (port) slots.port = port;
  const model = text.match(/((?:gpt|claude|gemini|deepseek|o\d|anthropic|openai|google|ollama)[\w./:-]+)/i)?.[1];
  if (model) slots.model = model;
  const token = text.match(/(?:token|密钥|key|apikey|api key)\s*[:：=]?\s*([\w-]{8,})/i)?.[1];
  if (token) slots.token = token;
  return slots;
}

function coerceAssistantFieldValue(field, query, slots) {
  if (slots[field.key]) return slots[field.key];
  if (field.key.toLowerCase().includes('token') && slots.token) return slots.token;
  if ((field.key.toLowerCase().includes('url') || field.key === 'baseUrl') && slots.baseUrl) return slots.baseUrl;
  if (field.key.toLowerCase().includes('port') && slots.port) return slots.port;
  if (field.key.toLowerCase().includes('model') && slots.model) return slots.model;
  return '';
}

export function runConfigStoreAssistant(recipes = [], query = '', tool = 'codex', existingState = null) {
  const normalized = normalizeStoreText(query);
  const catalog = enrichConfigStoreRecipes(recipes, tool);
  const ranked = searchConfigStoreRecipes(catalog, query, tool);
  const top = ranked[0] || null;
  const slots = extractSlots(query);

  if (!top) {
    return {
      mode: 'no_match',
      normalized,
      suggestions: TOOL_DEFAULT_PROMPTS[tool] || TOOL_DEFAULT_PROMPTS.codex,
      message: '我还没识别到明确场景，你可以试试“接 Telegram Bot”或“启用局域网访问 Gateway”这类说法。',
    };
  }

  const questions = top.guide.questions || [];
  const values = { ...(existingState?.values || {}) };
  for (const field of questions) {
    if (!values[field.key]) values[field.key] = coerceAssistantFieldValue(field, query, slots);
  }
  const missing = questions.filter((field) => field.required && !String(values[field.key] || '').trim());
  return {
    mode: 'matched',
    normalized,
    recipe: top,
    values,
    missing,
    nextQuestion: missing[0] ? `请填写「${missing[0].label}」` : '信息已齐，可以直接预览并应用。',
    reason: top._reason || [],
    alternatives: ranked.slice(1, 4),
    suggestions: uniq([...(top.guide.examples || []), ...(TOOL_DEFAULT_PROMPTS[tool] || [])]).slice(0, 6),
  };
}

export function getConfigStoreSuggestionChips(recipes = [], tool = 'codex', query = '') {
  const normalized = normalizeStoreText(query);
  if (!normalized) return uniq((TOOL_DEFAULT_PROMPTS[tool] || TOOL_DEFAULT_PROMPTS.codex)).slice(0, 6);
  const matches = searchConfigStoreRecipes(recipes, query, tool).slice(0, 6);
  return uniq(matches.flatMap((recipe) => recipe.guide.examples || [recipe.name])).slice(0, 6);
}
