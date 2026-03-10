// ════════════════════════════════════════════════════════════════
// Config Recipes — preset configurations for quick setup
// ════════════════════════════════════════════════════════════════

export const OPENCLAW_RUNTIME_RECIPES = [
  // ── Agent ──
  {
    id: 'agent-fast', name: '快速响应模式', cat: 'Agent', desc: '最小推理 + 即时响应，适合简单问答', kw: '快速 fast 速度 minimal 推理 响应 agent 回复',
    apply: () => ({ agents: { defaults: { thinkingDefault: 'minimal', humanDelay: 'off', typingMode: 'never' } } })
  },
  {
    id: 'agent-deep', name: '深度思考模式', cat: 'Agent', desc: '高推理强度 + 详细输出', kw: '深度 deep thinking 推理 high 思考 agent 详细',
    apply: () => ({ agents: { defaults: { thinkingDefault: 'high', verboseDefault: 'on' } } })
  },
  {
    id: 'agent-concurrent', name: '多并发处理', cat: 'Agent', desc: '允许同时处理多个请求', kw: '并发 concurrent 多任务 parallel agent 同时',
    fields: [{ key: 'n', label: '最大并发数', placeholder: '3' }],
    apply: (v) => ({ agents: { defaults: { maxConcurrent: Number(v.n) || 3 } } })
  },
  {
    id: 'heartbeat', name: '开启心跳回复', cat: 'Agent', desc: '定期自动发送心跳消息', kw: '心跳 heartbeat 自动 定期 auto agent 定时',
    fields: [{ key: 'every', label: '心跳间隔', placeholder: '30m' }],
    apply: (v) => ({ agents: { defaults: { heartbeat: { every: v.every || '30m', target: 'last' } } } })
  },
  {
    id: 'system-prompt', name: '自定义系统提示词', cat: 'Agent', desc: '设置 AI 的角色和行为指令', kw: '系统 system prompt 提示词 角色 人设 指令 agent persona',
    fields: [{ key: 'prompt', label: '系统提示词', placeholder: '你是一个有帮助的助手...' }],
    apply: (v) => ({ agents: { defaults: { systemPrompt: v.prompt } } })
  },
  {
    id: 'max-tokens', name: '控制回复长度', cat: 'Agent', desc: '限制每次回复的最大 Token 数', kw: '长度 token 限制 max 回复 输出 agent 字数',
    fields: [{ key: 'n', label: '最大 Token 数', placeholder: '4096' }],
    apply: (v) => ({ agents: { defaults: { maxTokens: Number(v.n) || 4096 } } })
  },
  // ── Security ──
  {
    id: 'security-lock', name: '安全锁定模式', cat: '安全', desc: '禁用所有危险命令和提权', kw: '安全 security lock 锁定 禁用 命令 限制',
    apply: () => ({ commands: { bash: false, config: false }, tools: { elevated: { enabled: false }, exec: { security: 'deny' } } })
  },
  {
    id: 'security-open', name: '开发者完全开放', cat: '安全', desc: '允许所有命令和工具（仅限可信环境）', kw: '开放 open 开发 developer 全部 命令 bash 完全',
    apply: () => ({ commands: { bash: true, config: true, text: true }, tools: { elevated: { enabled: true }, exec: { security: 'full', host: 'gateway' } } })
  },
  {
    id: 'approvals', name: '启用审批转发', cat: '安全', desc: '将执行审批请求转发到聊天渠道', kw: '审批 approval 转发 确认 安全',
    apply: () => ({ approvals: { enabled: true } })
  },
  // ── Tools ──
  {
    id: 'tools-minimal', name: '最小工具集', cat: '工具', desc: '仅保留最基础的工具', kw: '工具 tools minimal 最小 精简 基础',
    apply: () => ({ tools: { profile: 'minimal' } })
  },
  {
    id: 'tools-coding', name: '编程工具集', cat: '工具', desc: '适合编程场景的工具配置', kw: '工具 tools coding 编程 开发 代码 程序',
    apply: () => ({ tools: { profile: 'coding' } })
  },
  {
    id: 'web-search', name: '启用 Web 搜索', cat: '工具', desc: '配置搜索引擎让 AI 能联网搜索', kw: '搜索 search web 联网 brave perplexity 工具 google 谷歌',
    fields: [{ key: 'provider', label: '搜索引擎', placeholder: 'brave / perplexity / grok' }, { key: 'key', label: 'API Key', placeholder: '搜索引擎 API Key', type: 'password' }],
    apply: (v) => ({ tools: { web: { search: { provider: v.provider, apiKey: v.key } } } })
  },
  // ── Session ──
  {
    id: 'session-global', name: '全局共享会话', cat: '会话', desc: '所有用户共享同一上下文', kw: '会话 session global 全局 共享 上下文',
    apply: () => ({ session: { scope: 'global' } })
  },
  {
    id: 'session-daily-reset', name: '每日自动重置', cat: '会话', desc: '每天自动清空会话历史', kw: '重置 reset daily 每日 清空 会话 自动',
    apply: () => ({ session: { reset: 'daily' } })
  },
  {
    id: 'session-per-user', name: '多用户会话隔离', cat: '会话', desc: '每个用户独立会话上下文', kw: '用户 user 隔离 独立 会话 session 多人 multi',
    apply: () => ({ session: { scope: 'user' } })
  },
  {
    id: 'auto-summary', name: '自动摘要压缩', cat: '会话', desc: '会话过长时自动生成摘要保留上下文', kw: '摘要 summary 压缩 自动 上下文 记忆 会话',
    apply: () => ({ session: { autoSummary: true } })
  },
];
