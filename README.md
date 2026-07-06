<p align="center">
  <img src="assets/logo.png" width="96" height="96" alt="EasyAIConfig" />
</p>

<h1 align="center">EasyAIConfig</h1>

<p align="center">
  <strong>一个本地优先的 AI 编程工具配置中心。</strong>
</p>

<p align="center">
  管理 Provider、模型、OAuth / API Key、用量、终端启动、反代网关和常用工具安装。
</p>

<p align="center">
  <a href="https://github.com/lmk1010/EasyAIConfig/releases/latest"><img src="https://img.shields.io/github/v/release/lmk1010/EasyAIConfig?style=flat-square&color=111827" alt="Release" /></a>
  <a href="https://github.com/lmk1010/EasyAIConfig/blob/main/LICENSE"><img src="https://img.shields.io/github/license/lmk1010/EasyAIConfig?style=flat-square&color=64748b" alt="License" /></a>
  <a href="https://github.com/lmk1010/EasyAIConfig/actions"><img src="https://img.shields.io/github/actions/workflow/status/lmk1010/EasyAIConfig/release.yml?style=flat-square&label=build&color=64748b" alt="Build" /></a>
</p>

---

## 是什么

EasyAIConfig 用来把 Codex、Claude Code、OpenCode、OpenClaw、Gemini CLI、Hermes Agent、Claude Desktop 等工具的配置集中到一个本地桌面应用里。

它解决的核心问题很简单：

- 不手写散落在各处的配置文件
- 不反复复制 Base URL、API Key、模型名
- 不靠记忆切换不同 Provider / OAuth 账号
- 不打开一堆终端手动启动工具
- 不到处翻日志和本地文件看用量

## 核心能力

| 能力 | 说明 |
|------|------|
| Provider 管理 | 保存、切换、检测 API Key Provider，支持本地 Router |
| OAuth / API Key | 支持官方登录和中转 API Key 两种路径 |
| 模型管理 | 自动拉取 `/v1/models`，也支持手动维护可用模型 |
| 用量看板 | 读取本地日志 / JSONL / SQLite，汇总用量、费用和模型分布 |
| 启动工具 | 支持应用内终端、系统终端、Termius、Warp、iTerm 等启动方式 |
| 反代网关 | 本地统一入口，支持请求日志、搜索、分页、清理和保留策略 |
| 工具安装 | 管理 Codex、Claude Code、OpenCode、OpenClaw、IDE 插件和桌面应用 |
| 资产中心 | 查看配置、MCP、Skill、会话、提示词等本地资产 |

## 截图

<img src="assets/screenshot-quick-setup.png" alt="一键配置与 Provider 管理" width="100%" />

<img src="assets/screenshot-dashboard.png" alt="数据看板" width="100%" />

<img src="assets/screenshot-router.png" alt="自动路由网关" width="100%" />

<img src="assets/screenshot-tools.png" alt="工具安装与管理" width="100%" />

## 安装

### 桌面版

推荐直接下载桌面版：

[https://github.com/lmk1010/EasyAIConfig/releases/latest](https://github.com/lmk1010/EasyAIConfig/releases/latest)

| 平台 | 安装包 |
|------|--------|
| macOS Apple Silicon | `.dmg` / `aarch64` |
| macOS Intel | `.dmg` / `x64` |
| Windows | `.msi` / `.exe` |
| Linux | `.AppImage` / `.deb` |

### Web 模式

```bash
npm install -g easyaiconfig
easyaiconfig
```

Web 模式会启动本地服务并打开浏览器。Windows 下推荐优先使用桌面版。

## 快速开始

1. 打开 EasyAIConfig
2. 选择工具，例如 Codex
3. 选择官方 OAuth 或 API Key 模式
4. 填写 Base URL、API Key、模型
5. 点击保存
6. 点击启动，选择应用内终端或外部终端

## 本地文件

常见配置位置：

| 工具 | 配置 |
|------|------|
| Codex | `~/.codex/config.toml`、`~/.codex/auth.json` |
| Claude Code | `~/.claude/settings.json` |
| OpenCode | `~/.config/opencode` / `opencode.json` |
| OpenClaw | `~/.openclaw` |
| Gemini CLI | `~/.gemini` |

EasyAIConfig 默认在本机读写这些文件，不需要把密钥上传到远端服务。

## 开发

```bash
npm install
npm start
```

桌面开发：

```bash
npm run desktop:dev
```

构建桌面版：

```bash
npm run desktop:build
```

## 发布

推送 tag 触发 GitHub Actions 构建：

```bash
git tag v1.0.63
git push origin v1.0.63
```

## License

MIT
