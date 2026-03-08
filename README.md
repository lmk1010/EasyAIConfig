<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="EasyAIConfig" />
</p>

<h1 align="center">EasyAIConfig</h1>

<p align="center">
  <strong>Codex 配置助手 — 让 AI 编程工具的配置简单到一键搞定</strong>
</p>

<p align="center">
  <a href="https://github.com/lmk1010/EasyAIConfig/releases/latest"><img src="https://img.shields.io/github/v/release/lmk1010/EasyAIConfig?style=flat-square&color=8b5cf6" alt="Release" /></a>
  <a href="https://github.com/lmk1010/EasyAIConfig/blob/main/LICENSE"><img src="https://img.shields.io/github/license/lmk1010/EasyAIConfig?style=flat-square&color=3b82f6" alt="License" /></a>
  <a href="https://github.com/lmk1010/EasyAIConfig/actions"><img src="https://img.shields.io/github/actions/workflow/status/lmk1010/EasyAIConfig/release.yml?style=flat-square&label=build" alt="Build" /></a>
</p>

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🔌 **Provider 管理** | 一键配置 Base URL + API Key，自动写入 `config.toml` 和 `.env` |
| 🤖 **模型检测** | 自动发现可用模型并推荐最新版本 |
| 🔄 **多 Provider 切换** | 保存多个 Provider 配置，随时切换 |
| 📝 **配置编辑器** | 可视化表单编辑 `config.toml`，支持原始 TOML 编辑 |
| 💾 **备份与恢复** | 每次保存前自动备份，支持一键回滚 |
| 🖥️ **桌面客户端** | 基于 Tauri 的原生桌面应用（macOS / Windows / Linux） |
| 🔄 **自动更新** | 支持 GitHub Releases 自动检查与安装更新 |
| 🌗 **主题切换** | 深色 / 浅色主题自由切换 |

## 📦 安装

### 桌面版（推荐）

前往 [Releases](https://github.com/lmk1010/EasyAIConfig/releases/latest) 下载对应平台的安装包：

- **macOS**: `.dmg`
- **Windows**: `.msi` / `.exe`
- **Linux**: `.AppImage` / `.deb`

### Web 模式

```bash
npm install -g easyaiconfig
easyaiconfig
```

启动本地服务后自动打开浏览器。

## 🚀 快速开始

1. **输入 Base URL** — 支持 OpenAI / 第三方 OpenAI 兼容 API
2. **填写 API Key** — 自动识别 Provider 并生成环境变量名
3. **检测模型** — 一键发现所有可用模型
4. **保存配置** — 写入 `~/.codex/config.toml` + `.env`
5. **启动 Codex** — 在终端中运行配置好的 Codex

## 🛠️ 开发

### 前置要求

- **Node.js** ≥ 18
- **Rust** ≥ 1.77（桌面开发）
- **npm** ≥ 8

### Web 开发模式

```bash
npm install
npm start
```

### 桌面开发模式

```bash
npm install
npm run desktop:dev
```

### 桌面打包

```bash
npm run desktop:build
```

## 📁 项目结构

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

## 🔐 发布配置

### 生成签名密钥

```bash
npx tauri signer generate -w ~/.tauri/easyaiconfig.key
```

### GitHub Secrets

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

### 发布新版本

推送 tag 即可触发自动构建与发布：

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 📄 License

[MIT](LICENSE)
