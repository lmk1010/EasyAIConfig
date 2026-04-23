<p align="center">
  <img src="assets/logo.png" width="96" height="96" alt="EasyAIConfig" />
</p>

<h1 align="center">EasyAIConfig</h1>

<p align="center">
  <strong>Codex 配置助手 — 让 AI 编程工具的配置简单到一键搞定</strong>
</p>

<p align="center">
  <strong>当前版本 Windows 暂不支持，整体更适合 macOS 用户使用。</strong>
</p>

<p align="center">
  <a href="https://github.com/lmk1010/EasyAIConfig/releases/latest"><img src="https://img.shields.io/github/v/release/lmk1010/EasyAIConfig?style=flat-square&color=8b5cf6" alt="Release" /></a>
  <a href="https://github.com/lmk1010/EasyAIConfig/blob/main/LICENSE"><img src="https://img.shields.io/github/license/lmk1010/EasyAIConfig?style=flat-square&color=3b82f6" alt="License" /></a>
  <a href="https://github.com/lmk1010/EasyAIConfig/actions"><img src="https://img.shields.io/github/actions/workflow/status/lmk1010/EasyAIConfig/release.yml?style=flat-square&label=build" alt="Build" /></a>
</p>

---

## [Core] 已支持功能（当前版本）

### [What's New] v1.0.41

- 新增：Codex 官方登录（OAuth）与 API Key 双路径快速配置
- 新增：官方登录场景支持一键设为默认 `OpenAI Provider`
- 优化：`官方 + 中转 API Key` 共存时，Provider 切换更顺滑
- 新增：Codex 会话恢复能力（最近会话浏览 / 一键恢复 / 导出）
- 新增：独立 Codex App 的一键安装与打开入口

### 核心能力

| 状态 | 功能 | 说明 |
|------|------|------|
| 已支持 | **Provider 管理** | 一键配置 Base URL + API Key，自动写入配置文件 |
| 已支持 | **官方登录模式** | 自动识别 Codex/ChatGPT OAuth 登录态，可直接设为默认 OpenAI Provider |
| 已支持 | **模型检测** | 自动发现可用模型并推荐可用版本 |
| 已支持 | **多 Provider 切换** | 支持保存多套 Provider 并快速切换 |
| 已支持 | **配置编辑器** | 可视化编辑 + 原始配置编辑（TOML / JSON） |
| 已支持 | **备份与恢复** | 保存前自动备份，支持一键回滚 |
| 已支持 | **数据看板** | Codex / Claude 用量与费用估算，OpenClaw 运行状态监控 |
| 已支持 | **桌面客户端** | Web + Tauri 桌面端当前更适合 macOS 用户，Windows 暂不支持 |
| 已支持 | **自动更新（桌面版）** | Tauri 桌面端支持 GitHub Releases 自动检查与安装更新 |

### 工具支持矩阵

| 工具 | 安装/更新/卸载 | 启动 | 登录/初始化 | 配置管理 | 运行状态 |
|------|----------------|------|-------------|----------|----------|
| **Codex CLI** | 已支持 | 已支持 | 已支持 (`codex login`) | 已支持 (`~/.codex/config.toml` + `.env`) | 已支持 |
| **Claude Code** | 已支持 | 已支持 | 已支持 (OAuth 登录) | 已支持 (`~/.claude/settings.json`) | 已支持 |
| **OpenClaw** | 已支持（一键 / WSL / 脚本） | 已支持（Gateway 启动） | 已支持 (`onboard`) | 已支持 (`~/.openclaw/openclaw.json`) | 已支持 |
| **OpenCode** | 已支持（官方脚本 / Homebrew / npm / Scoop / Chocolatey） | 已支持 | 规划中 | 规划中 | 规划中 |

## [Todo] 未来功能待办（Roadmap）

> 以下为计划项，按优先级逐步推进。

| 优先级 | 待办项 | 状态 |
|--------|--------|------|
| P1 | 启动失败一键诊断（自动收集环境与命令日志） | 规划中 |
| P1 | 配置导入/导出（跨机器迁移） | 规划中 |
| P1 | Provider 可用性定时巡检与告警提示 | 规划中 |
| P2 | Dashboard 自定义统计维度与时间范围 | 规划中 |
| P2 | 多语言界面（中文 / English） | 规划中 |
| P3 | 配方（Recipes）模板扩展与社区分享 | 规划中 |

## [UI] 截图预览

<p align="center">
  <img src="assets/dashboard-codex.png" width="100%" alt="Codex Dashboard — Token 用量趋势、费用估算、模型分布" />
</p>
<p align="center"><em>Codex 数据看板 — 实时 Token 趋势、费用估算与模型分布</em></p>

<p align="center">
  <img src="assets/dashboard-claude-code.png" width="100%" alt="Claude Code Dashboard — 模型分布、Token 分布与消耗明细" />
</p>
<p align="center"><em>Claude Code 数据看板 — 多模型统计、Token 分布与消耗分析</em></p>

## [Install] 安装

### [Desktop] 桌面版（推荐）

最新版本下载统一在 Releases：
[https://github.com/lmk1010/EasyAIConfig/releases/latest](https://github.com/lmk1010/EasyAIConfig/releases/latest)

> 当前版本 Windows 暂不支持，推荐 macOS 用户优先使用桌面版。

| 平台 | 推荐安装包 | 下载链接 |
|------|------------|----------|
| macOS (Apple Silicon) | `.dmg`（`aarch64`） | [下载 macOS 版本](https://github.com/lmk1010/EasyAIConfig/releases/latest) |
| macOS (Intel) | `.dmg`（`x64`） | [下载 macOS 版本](https://github.com/lmk1010/EasyAIConfig/releases/latest) |
| Linux | `.AppImage` / `.deb` | [下载 Linux 版本](https://github.com/lmk1010/EasyAIConfig/releases/latest) |

下载后请按文件名中的架构选择：
- `aarch64` / `arm64`：Apple Silicon
- `x64` / `x86_64`：Intel / AMD 64 位

### [Web] Web 模式

```bash
npm install -g easyaiconfig
easyaiconfig
```

启动本地服务后自动打开浏览器。

## [QuickStart] 快速开始

1. **选择认证方式** — 可直接用 `官方登录`（OAuth）或切换 `API Key` 模式
2. **官方登录路径** — 点击「设为默认 OpenAI Provider」后直接保存并启动
3. **API Key 路径** — 输入 Base URL + API Key，自动识别 Provider 和环境变量
4. **检测模型** — 一键发现可用模型并推荐默认项
5. **保存并启动** — 写入 `~/.codex/config.toml` + `.env`，并直接启动 Codex

## [Dev] 开发

### [Prerequisites] 前置要求

- **Node.js** ≥ 18
- **Rust** ≥ 1.77（桌面开发）
- **npm** ≥ 8

### [Web Dev] Web 开发模式

```bash
npm install
npm start
```

### [Desktop Dev] 桌面开发模式

```bash
npm install
npm run desktop:dev
```

### [Build] 桌面打包

```bash
npm run desktop:build
```

## [Tree] 项目结构

```
├── public/            # 前端静态文件（HTML / CSS / JS）
│   ├── index.html     # 主页面
│   ├── styles.css     # 样式
│   └── app.js         # 前端逻辑
├── src/
│   ├── server.js      # Express 后端（Web 模式）
│   └── lib/
│       ├── config-store.js   # 配置读写核心
│       └── provider-check.js # Provider 连通性检测
├── src-tauri/         # Tauri 桌面端
│   ├── src/
│   │   ├── lib.rs     # Tauri 入口
│   │   ├── config.rs  # 配置管理
│   │   ├── provider.rs # Provider 逻辑
│   │   └── routes.rs  # API 路由
│   └── icons/         # 应用图标
└── .github/workflows/ # CI/CD
```

## [Release] 发布配置

### [Signing] 生成签名密钥

```bash
npx tauri signer generate -w ~/.tauri/easyaiconfig.key
```

### [Secrets] GitHub Secrets

在仓库 Settings → Secrets 中配置：

| Secret | 说明 |
|--------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | 签名私钥（完整文件内容） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码 |

> **提示**：推荐使用 GitHub CLI 写入密钥以避免换行损坏：
> ```bash
> gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/easyaiconfig.key
> gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
> ```

### [Tag] 发布新版本

推送 tag 即可触发自动构建与发布：

```bash
git tag v1.0.0
git push origin v1.0.0
```

## License

[MIT](LICENSE)
