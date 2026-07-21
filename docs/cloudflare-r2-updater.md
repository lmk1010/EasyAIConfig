# Cloudflare R2 自动更新接入

项目现在支持在 GitHub Release 之后，自动把 Tauri 更新文件同步到 Cloudflare R2。

## 你需要准备

在 Cloudflare 后台创建并提供：

- `CF_R2_ACCOUNT_ID`
- `CF_R2_ACCESS_KEY_ID`
- `CF_R2_SECRET_ACCESS_KEY`
- `CF_R2_BUCKET`
- `CF_R2_PUBLIC_BASE_URL`

其中：

- `CF_R2_BUCKET`：R2 bucket 名称
- `CF_R2_PUBLIC_BASE_URL`：公开下载地址，不带结尾 `/`
  - 例：`https://download.cursorxyz.it.com`

## GitHub Secrets

到仓库 `Settings -> Secrets and variables -> Actions`，新增：

- `CF_R2_ACCOUNT_ID`
- `CF_R2_ACCESS_KEY_ID`
- `CF_R2_SECRET_ACCESS_KEY`
- `CF_R2_BUCKET`
- `CF_R2_PUBLIC_BASE_URL`
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

## 自动流程

打 tag 后，`release.yml` 会：

1. 创建 GitHub draft release
2. 构建 Tauri 安装包和 updater 产物
3. 下载 release assets
4. 重写 `latest.json` 里的下载地址到 R2 域名
5. 上传所有产物到 R2
6. 发布正式 release

## 同步到 R2 的文件

- `latest.json`
- Windows 安装包
- macOS 安装包
- Linux 安装包
- 所有签名文件

## 验证

发布后检查：

- `https://download.cursorxyz.it.com/latest.json`
- `latest.json` 里的 `platforms.*.url` 是否都是该域名
- `platforms.android-arm64`（APK）是否存在
- 应用内更新 / 手机设置页「检查更新」是否命中 R2

## GitHub Release 策略

打 `v*` tag 后，Release 流水线会：

1. 构建桌面端（不上传安装包到 GitHub，避免占空间）
2. 构建 Android APK
3. 全部同步到 R2，并写 `latest.json`
4. GitHub Release 只保留说明 + R2 下载链接

请将 Secret `CF_R2_PUBLIC_BASE_URL` 设为：

`https://download.cursorxyz.it.com`

## 本地开发也要走 R2

```bash
cp src-tauri/r2-public-base.url.example src-tauri/r2-public-base.url
# 内容：https://download.cursorxyz.it.com
```

或运行时：

```bash
echo 'https://download.cursorxyz.it.com' > ~/.codex-config-ui/updater-endpoint
```
