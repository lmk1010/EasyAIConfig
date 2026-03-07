# easyaiconfig

EasyAIConfig：一个轻量、极简的 Codex 配置工具。

## 能力

- 检测 Codex 安装、版本、路径
- 一键配置 Base URL + API Key
- 自动检测模型并推荐最新 GPT 模型
- 快速写入 `config.toml` 和 `${CODEX_HOME}/.env`
- 管理多个 provider，并切换当前配置
- 备份 / 恢复 Codex 配置
- 支持 Tauri 桌面客户端
- 支持 GitHub Releases 自动更新

## Web 模式

```bash
npm install -g easyaiconfig
easyaiconfig
```

会启动本地服务并自动打开浏览器。

## 桌面开发模式

```bash
npm install
npm run desktop:dev
```

## 桌面打包

```bash
npm install
npm run desktop:build
```

## 自动更新配置

桌面自动更新默认读取以下环境变量：

- `EASYAICONFIG_UPDATER_PUBLIC_KEY`
- `EASYAICONFIG_UPDATER_ENDPOINT`
- `EASYAICONFIG_GITHUB_REPOSITORY`

推荐直接使用 GitHub Releases：

- 更新清单地址默认形如 `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`
- Tauri 构建时会生成 updater artifacts
- 应用内会自动检查并支持一键安装后重启

## GitHub Actions Secrets

先生成 updater 签名密钥：

```bash
npm install
npm run tauri -- signer generate -w ~/.tauri/easyaiconfig.key
```

把生成结果分别放到仓库 Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `EASYAICONFIG_UPDATER_PUBLIC_KEY`

## 发布桌面安装包

推送 tag 即可触发：

```bash
git tag v0.1.0
git push origin v0.1.0
```

工作流文件：

- `.github/workflows/desktop-release.yml`
- `.github/workflows/publish.yml`
