// ════════════════════════════════════════════════════════════════
// Config Recipes — preset configurations for quick setup
// ════════════════════════════════════════════════════════════════

export const OPENCLAW_CHANNEL_RECIPES = [
  // ── Channels ──
  {
    id: 'tg-basic', name: '接入 Telegram Bot', cat: '渠道', desc: '配置 Telegram Bot Token，开启私聊 + 群组', kw: 'telegram tg bot 电报 机器人 聊天 channel 渠道 接入',
    fields: [{ key: 'token', label: 'Bot Token', placeholder: '123456:ABCDEF...', type: 'password', help: '到 BotFather 执行 /newbot 后拿到；通常形如 123456:ABCDEF...' }],
    apply: (v) => ({ channels: { telegram: { botToken: v.token, dmPolicy: 'open', groupPolicy: 'open' } } }),
    panel: 'ocCfgTelegramToken'
  },
  {
    id: 'tg-private', name: 'Telegram 仅私聊', cat: '渠道', desc: '仅允许私聊，关闭群组响应', kw: 'telegram tg 私聊 private dm 电报 channel 渠道',
    fields: [{ key: 'token', label: 'Bot Token', placeholder: '123456:ABCDEF...', type: 'password', help: '和 Telegram BotFather 里创建的机器人 Token 保持一致。' }],
    apply: (v) => ({ channels: { telegram: { botToken: v.token, dmPolicy: 'open', groupPolicy: 'disabled' } } }),
    panel: 'ocCfgTelegramToken'
  },
  {
    id: 'tg-whitelist', name: 'Telegram 白名单', cat: '渠道', desc: '仅允许指定用户 ID 发消息', kw: 'telegram tg 白名单 allowlist whitelist 电报 安全 channel 渠道',
    fields: [{ key: 'token', label: 'Bot Token', placeholder: '123456:ABCDEF...', type: 'password', help: '先从 BotFather 获取机器人 Token。' }, { key: 'users', label: '允许的用户 ID（逗号分隔）', placeholder: '12345, 67890', help: '填 Telegram 数字用户 ID，多个用英文逗号分隔。' }],
    apply: (v) => ({ channels: { telegram: { botToken: v.token, dmPolicy: 'allowlist', allowFrom: v.users.split(',').map(s => s.trim()).filter(Boolean) } } }),
    panel: 'ocCfgTelegramToken'
  },
  {
    id: 'dc-basic', name: '接入 Discord Bot', cat: '渠道', desc: '配置 Discord Bot Token 接入服务器', kw: 'discord dc bot 机器人 聊天 channel 渠道 接入 服务器',
    fields: [{ key: 'token', label: 'Bot Token', placeholder: 'Discord Bot Token', type: 'password', help: '到 Discord Developer Portal → Bot 页面复制；通常以较长随机串形式出现。' }],
    apply: (v) => ({ channels: { discord: { token: v.token } } }),
    panel: 'ocCfgDiscordToken'
  },
  {
    id: 'slack-basic', name: '接入 Slack Bot', cat: '渠道', desc: '配置 Slack Bot + App Token 接入工作空间', kw: 'slack 工作空间 workspace bot channel 渠道 接入 企业',
    fields: [{ key: 'bot', label: 'Bot Token', placeholder: 'xoxb-...', type: 'password', help: 'Slack App 的 OAuth & Permissions 页面里生成，通常以 xoxb- 开头。' }, { key: 'app', label: 'App Token', placeholder: 'xapp-...', type: 'password', help: 'Socket Mode 页面生成，通常以 xapp- 开头。' }],
    apply: (v) => ({ channels: { slack: { botToken: v.bot, appToken: v.app } } }),
    panel: 'ocCfgSlackBotToken'
  },
  {
    id: 'wechat-mp', name: '接入微信公众号', cat: '渠道', desc: '配置微信公众号 AppID 和 Token 接入', kw: '微信 wechat 公众号 mp 聊天 channel 渠道 接入 weixin',
    fields: [{ key: 'appId', label: 'AppID', placeholder: 'wx...', help: '在微信公众平台 → 设置与开发 / 开发接口管理里查看，通常以 wx 开头。' }, { key: 'token', label: '验证 Token', placeholder: '公众号后台设置的 Token', help: '这是你在公众号后台自己填写的一段校验字符串，这里必须与后台完全一致。' }, { key: 'aesKey', label: 'EncodingAESKey', placeholder: '消息加解密密钥', optional: true, help: '如果公众号启用了安全模式，就填写 43 位 EncodingAESKey；明文模式可留空。' }],
    apply: (v) => ({ channels: { wechat: { appId: v.appId, token: v.token, encodingAESKey: v.aesKey || undefined } } })
  },
  {
    id: 'wechat-work', name: '接入企业微信', cat: '渠道', desc: '配置企业微信应用接入', kw: '企业微信 wechat work wecom 公司 channel 渠道 接入 weixin',
    fields: [{ key: 'corpId', label: 'CorpID', placeholder: '企业 ID', help: '企业微信管理后台 → 我的企业 页面可直接复制。' }, { key: 'agentId', label: 'AgentID', placeholder: '应用 ID', help: '在自建应用详情页查看，纯数字。' }, { key: 'secret', label: 'Secret', placeholder: '应用密钥', type: 'password', help: '企业微信自建应用详情页里的 Secret，点击查看或重置。' }],
    apply: (v) => ({ channels: { wechatWork: { corpId: v.corpId, agentId: Number(v.agentId), secret: v.secret } } })
  },
  {
    id: 'line-basic', name: '接入 LINE Bot', cat: '渠道', desc: '配置 LINE Messaging API 接入', kw: 'line bot 聊天 channel 渠道 接入 日本 messaging',
    fields: [{ key: 'secret', label: 'Channel Secret', placeholder: 'Channel Secret', type: 'password' }, { key: 'token', label: 'Access Token', placeholder: 'Long-lived access token', type: 'password' }],
    apply: (v) => ({ channels: { line: { channelSecret: v.secret, accessToken: v.token } } })
  },
  {
    id: 'whatsapp-basic', name: '接入 WhatsApp', cat: '渠道', desc: '通过 WhatsApp Business API 接入', kw: 'whatsapp wa 聊天 channel 渠道 接入 facebook meta business',
    fields: [{ key: 'token', label: 'Access Token', placeholder: 'WhatsApp Business API Token', type: 'password' }, { key: 'phoneId', label: 'Phone Number ID', placeholder: '电话号码 ID' }],
    apply: (v) => ({ channels: { whatsapp: { accessToken: v.token, phoneNumberId: v.phoneId } } })
  },
  {
    id: 'matrix-basic', name: '接入 Matrix', cat: '渠道', desc: '连接 Matrix/Element 聊天网络', kw: 'matrix element 聊天 channel 渠道 接入 开源 federated',
    fields: [{ key: 'homeserver', label: 'Homeserver URL', placeholder: 'https://matrix.org' }, { key: 'token', label: 'Access Token', placeholder: 'syt_...', type: 'password' }],
    apply: (v) => ({ channels: { matrix: { homeserver: v.homeserver, accessToken: v.token } } })
  },
  {
    id: 'webhook-channel', name: '自定义 Webhook 渠道', cat: '渠道', desc: '通过 HTTP Webhook 接收消息', kw: 'webhook http 自定义 custom channel 渠道 接入 api 回调',
    fields: [{ key: 'path', label: 'Webhook 路径', placeholder: '/webhook/my-channel' }],
    apply: (v) => ({ channels: { webhook: { enabled: true, path: v.path || '/webhook' } } })
  },
];
