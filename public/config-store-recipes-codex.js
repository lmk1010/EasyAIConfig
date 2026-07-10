// ════════════════════════════════════════════════════════════════
// Config Recipes — preset configurations for quick setup
// ════════════════════════════════════════════════════════════════

export const CODEX_CONFIG_RECIPES = [
  // ── Model Presets ──
  {
    id: 'cx-model-gpt56-sol', name: '使用 GPT-5.6 Sol', cat: '模型', desc: '切换默认模型为 GPT-5.6 Sol 旗舰模型', kw: 'gpt-5.6 sol model 模型 openai 推荐 latest 旗舰', tool: 'codex',
    apply: () => ({ model: 'gpt-5.6-sol' })
  },
  {
    id: 'cx-model-gpt56-terra', name: '使用 GPT-5.6 Terra', cat: '模型', desc: '切换默认模型为 GPT-5.6 Terra', kw: 'gpt-5.6 terra model 模型 openai', tool: 'codex',
    apply: () => ({ model: 'gpt-5.6-terra' })
  },
  {
    id: 'cx-model-gpt56-luna', name: '使用 GPT-5.6 Luna', cat: '模型', desc: '切换默认模型为 GPT-5.6 Luna', kw: 'gpt-5.6 luna model 模型 openai', tool: 'codex',
    apply: () => ({ model: 'gpt-5.6-luna' })
  },
  {
    id: 'cx-model-gpt54-mini', name: '使用 GPT-5.4 mini', cat: '模型', desc: '切换到更快、更低成本的 GPT-5.4 mini', kw: 'gpt-5.4-mini model 模型 openai fast 快速 低成本', tool: 'codex',
    apply: () => ({ model: 'gpt-5.4-mini' })
  },
  {
    id: 'cx-model-spark', name: '使用 Codex Spark', cat: '模型', desc: '切换到 GPT-5.3 Codex Spark 预览模型', kw: 'gpt-5.3-codex-spark model 模型 openai preview spark 快速', tool: 'codex',
    apply: () => ({ model: 'gpt-5.3-codex-spark' })
  },
  {
    id: 'cx-model-custom', name: '自定义模型', cat: '模型', desc: '设置自定义模型名称', kw: 'model 模型 自定义 custom', tool: 'codex',
    fields: [{ key: 'model', label: '模型名称', placeholder: '如: gpt-5.6-sol, deepseek-v4-flash' }],
    apply: (v) => ({ model: v.model })
  },
  // ── Reasoning ──
  {
    id: 'cx-reasoning-high', name: '高推理模式', cat: '推理', desc: '将推理强度设为 high，适合复杂任务', kw: '推理 reasoning high 高 复杂', tool: 'codex',
    apply: () => ({ model_reasoning_effort: 'high', plan_mode_reasoning_effort: 'high' })
  },
  {
    id: 'cx-reasoning-minimal', name: '快速推理模式', cat: '推理', desc: '最小推理适合简单任务，响应更快', kw: '推理 reasoning minimal 快速 最小 fast', tool: 'codex',
    apply: () => ({ model_reasoning_effort: 'minimal', plan_mode_reasoning_effort: 'minimal' })
  },
  {
    id: 'cx-reasoning-xhigh', name: '极致推理模式', cat: '推理', desc: '最高推理强度，适合最复杂的编程任务', kw: '推理 reasoning xhigh 极致 最高 最强', tool: 'codex',
    apply: () => ({ model_reasoning_effort: 'xhigh', plan_mode_reasoning_effort: 'xhigh' })
  },
  {
    id: 'cx-reasoning-max', name: 'GPT-5.6 Max 推理', cat: '推理', desc: 'GPT-5.6 最大推理深度，适合最困难任务', kw: '推理 reasoning max gpt-5.6 最大', tool: 'codex',
    apply: () => ({ model_reasoning_effort: 'max', plan_mode_reasoning_effort: 'max' })
  },
  {
    id: 'cx-reasoning-ultra', name: 'GPT-5.6 Ultra 推理', cat: '推理', desc: 'GPT-5.6 Sol/Terra 的自动任务委派推理模式', kw: '推理 reasoning ultra gpt-5.6 sol terra 委派', tool: 'codex',
    apply: () => ({ model_reasoning_effort: 'ultra', plan_mode_reasoning_effort: 'ultra' })
  },
  // ── Context Window ──
  {
    id: 'cx-ctx-1m', name: '1M Token 上下文', cat: '上下文', desc: '将上下文窗口扩展到 1048576 tokens', kw: '上下文 context window 1m token 大 扩展', tool: 'codex',
    apply: () => ({ model_context_window: 1048576, model_auto_compact_token_limit: Math.round(1048576 * 0.9) })
  },
  {
    id: 'cx-ctx-512k', name: '512K Token 上下文', cat: '上下文', desc: '中等大小的上下文窗口', kw: '上下文 context window 512k token', tool: 'codex',
    apply: () => ({ model_context_window: 512000, model_auto_compact_token_limit: Math.round(512000 * 0.9) })
  },
  {
    id: 'cx-ctx-default', name: '默认上下文', cat: '上下文', desc: '恢复默认 272K 上下文窗口', kw: '上下文 context window 默认 default', tool: 'codex',
    apply: () => ({ model_context_window: 272000, model_auto_compact_token_limit: Math.round(272000 * 0.9) })
  },
  // ── Sandbox / Approval ──
  {
    id: 'cx-sandbox-full', name: '完全访问模式', cat: '安全', desc: '关闭沙箱限制，允许完全文件系统访问', kw: '沙箱 sandbox full access 完全 访问 danger', tool: 'codex',
    apply: () => ({ sandbox_mode: 'danger-full-access', approval_policy: 'never' })
  },
  {
    id: 'cx-sandbox-safe', name: '安全模式', cat: '安全', desc: '只读沙箱 + untrusted 审批策略', kw: '安全 sandbox safe 只读 readonly untrusted', tool: 'codex',
    apply: () => ({ sandbox_mode: 'read-only', approval_policy: 'untrusted' })
  },
  {
    id: 'cx-workspace-write', name: '工作区写入模式', cat: '安全', desc: '允许向工作区写入文件', kw: '工作区 workspace write 写入', tool: 'codex',
    apply: () => ({ sandbox_mode: 'workspace-write' })
  },
  // ── Service ──
  {
    id: 'cx-service-fast', name: '快速服务层', cat: '服务', desc: '使用 Fast 服务层优先响应速度', kw: '服务 service fast 快速', tool: 'codex',
    apply: () => ({ service_tier: 'fast' })
  },
  {
    id: 'cx-service-flex', name: 'Flex 服务层', cat: '服务', desc: '使用 Flex 服务层平衡性价比', kw: '服务 service flex 灵活 便宜', tool: 'codex',
    apply: () => ({ service_tier: 'flex' })
  },
  // ── Personality ──
  {
    id: 'cx-persona-friendly', name: '友好助手风格', cat: '个性', desc: '设置为友好风格', kw: '个性 personality friendly 友好', tool: 'codex',
    apply: () => ({ personality: 'friendly' })
  },
  {
    id: 'cx-persona-pragmatic', name: '务实风格', cat: '个性', desc: '设置为务实风格，简洁高效', kw: '个性 personality pragmatic 务实 简洁', tool: 'codex',
    apply: () => ({ personality: 'pragmatic' })
  },
  // ── Workflow ──
  {
    id: 'cx-max-perf', name: '最大性能模式', cat: '工作流', desc: 'high 推理 + 1M Token + Fast 服务', kw: '最大 max performance 性能 高性能', tool: 'codex',
    apply: () => ({ model_reasoning_effort: 'high', plan_mode_reasoning_effort: 'high', model_context_window: 1048576, model_auto_compact_token_limit: Math.round(1048576 * 0.9), service_tier: 'fast' })
  },
  {
    id: 'cx-minimal', name: '极简模式', cat: '工作流', desc: '最小推理 + 默认上下文 + 紧凑提示', kw: '极简 minimal 精简 快速', tool: 'codex',
    apply: () => ({ model_reasoning_effort: 'minimal', plan_mode_reasoning_effort: 'minimal', compact_prompt: true })
  },
  {
    id: 'cx-debug-mode', name: '调试模式', cat: '工作流', desc: '显示原始推理过程，方便调试', kw: '调试 debug 推理 原始 reasoning raw', tool: 'codex',
    apply: () => ({ show_raw_agent_reasoning: true, hide_agent_reasoning: false })
  },
  {
    id: 'cx-reset-defaults', name: '恢复默认', cat: '工作流', desc: '将所有设置重置为 Codex 默认值', kw: '默认 reset 恢复 重置 default', tool: 'codex',
    apply: () => ({
      model: null,
      model_reasoning_effort: null,
      plan_mode_reasoning_effort: null,
      model_reasoning_summary: null,
      model_verbosity: null,
      model_context_window: null,
      model_auto_compact_token_limit: null,
      service_tier: null,
      sandbox_mode: null,
      approval_policy: null,
      approvals_reviewer: null,
      personality: null,
      web_search: null,
      allow_login_shell: null,
      default_permissions: null,
      compact_prompt: false,
    })
  },
];
