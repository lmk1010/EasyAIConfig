// ════════════════════════════════════════════════════════════════
// Config Recipes — preset configurations for quick setup
// ════════════════════════════════════════════════════════════════

export const OPENCLAW_SYSTEM_RECIPES = [
  // ── Gateway ──
  {
    id: 'gw-lan', name: '局域网访问', cat: '网络', desc: '允许局域网内设备访问 Gateway', kw: '局域网 lan 网络 gateway 访问 绑定 内网',
    apply: () => ({ gateway: { bind: 'lan', auth: { mode: 'token' } } })
  },
  {
    id: 'gw-noauth', name: '关闭 Gateway 认证', cat: '网络', desc: '移除认证（仅限本地使用）', kw: '认证 auth none 关闭 gateway 无密码 网络',
    apply: () => ({ gateway: { auth: { mode: 'none' } } })
  },
  {
    id: 'gw-https', name: '启用 HTTPS', cat: '网络', desc: '配置 SSL 证书启用加密访问', kw: 'https ssl tls 证书 加密 安全 网络 gateway',
    fields: [{ key: 'cert', label: '证书路径', placeholder: '/path/to/cert.pem' }, { key: 'key', label: '私钥路径', placeholder: '/path/to/key.pem' }],
    apply: (v) => ({ gateway: { tls: { cert: v.cert, key: v.key } } })
  },
  {
    id: 'gw-reverse-proxy', name: '反向代理模式', cat: '网络', desc: '配置为反向代理后端（信任 X-Forwarded-For）', kw: '反向代理 reverse proxy nginx caddy 网络 gateway 部署',
    apply: () => ({ gateway: { trustProxy: true, bind: '0.0.0.0' } })
  },
  // ── Cron ──
  {
    id: 'cron-enable', name: '启用定时任务', cat: '定时', desc: '开启 Cron 定时任务功能', kw: '定时 cron 任务 计划 schedule 自动',
    apply: () => ({ cron: { enabled: true } })
  },
  {
    id: 'hooks-enable', name: '启用 Webhooks', cat: '钩子', desc: '开启 Webhook 接收功能', kw: 'webhook hook 钩子 回调 触发',
    apply: () => ({ hooks: { enabled: true } })
  },
  {
    id: 'hooks-secret', name: 'Webhook 签名验证', cat: '钩子', desc: '设置 Webhook Secret 验证请求签名', kw: 'webhook secret 签名 验证 安全 钩子',
    fields: [{ key: 'secret', label: 'Webhook Secret', placeholder: '自定义签名密钥', type: 'password' }],
    apply: (v) => ({ hooks: { enabled: true, secret: v.secret } })
  },
  // ── Logging ──
  {
    id: 'log-debug', name: '调试日志模式', cat: '日志', desc: '切换到 debug 级别查看详细日志', kw: '日志 log debug 调试 详细 排错',
    apply: () => ({ logging: { level: 'debug', consoleStyle: 'pretty' } })
  },
  {
    id: 'log-silent', name: '静默日志', cat: '日志', desc: '关闭所有日志输出', kw: '静默 silent 关闭 日志 log quiet 生产',
    apply: () => ({ logging: { level: 'silent' } })
  },
  {
    id: 'log-file', name: '日志输出到文件', cat: '日志', desc: '将日志写入文件方便排查问题', kw: '日志 log file 文件 输出 记录 保存',
    fields: [{ key: 'path', label: '日志文件路径', placeholder: './logs/openclaw.log' }],
    apply: (v) => ({ logging: { level: 'info', file: v.path || './logs/openclaw.log' } })
  },
  // ── Identity ──
  {
    id: 'identity-custom', name: '自定义助手身份', cat: '身份', desc: '设置助手名称和头像', kw: '身份 identity 名称 头像 avatar 名字 人设 助手',
    fields: [{ key: 'name', label: '助手名称', placeholder: '小助手' }, { key: 'avatar', label: '头像 URL（可选）', placeholder: 'https://...', optional: true }],
    apply: (v) => ({ identity: { name: v.name, avatar: v.avatar || undefined } })
  },
];
