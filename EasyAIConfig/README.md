# Easy AI Config (手机端)

用手机远程查看 / 操作电脑上运行的 **Codex** 和 **Claude Code** 终端会话。
配合桌面版 EasyAIConfig 的「远程访问」服务使用。

- 同一 WiFi：直连电脑内网地址
- 跨网 / 4G：电脑端用 VPS 反向隧道中转
- 实时查看 agent 输出，随手回复 `y/n`、`Enter`、`Esc`、`Ctrl-C` 等（专为审批 codex/claude 交互设计）
- 可在手机上直接新建 codex / claude 会话

## 工作原理

桌面端开启远程服务后，会在本机监听一个带 token 鉴权的 HTTP 服务，把终端 API
（`/api/terminal/list · read · write · resize · create`）暴露出来。手机 App 用
[xterm](https://pub.dev/packages/xterm) 渲染 PTY 输出，轮询增量读取、把输入回传，
从而远程接管会话。所有请求都必须携带配对 token。

```
手机 App ──HTTP(+token)──▶ 桌面远程服务 ──▶ 复用 dispatch() ──▶ portable-pty (codex/claude)
        ◀──PTY 输出(轮询增量)──
```

## 使用步骤

1. 电脑端打开 EasyAIConfig → 内置终端页 → 右上角「📱 远程」→ **开启本机服务**。
2. 手机 App 点「扫码配对」，扫电脑上显示的二维码（或手动粘贴 `http://内网IP:端口` + token）。
3. 进入会话列表，点任意会话即可远程查看 / 输入。
4. 跨网访问：电脑端「远程」面板里填 VPS 信息建立反向隧道，手机改用 VPS 地址配对即可。

> 安全：服务凭 token 授权、仅放行终端相关接口；不用时在电脑端一键关闭。

## 开发 / 构建

```bash
flutter pub get
flutter run                 # 连真机调试
flutter build apk --release # 产物：build/app/outputs/flutter-apk/app-release.apk
```

- 最低 Android SDK：Flutter 默认（21+）
- 已在 `AndroidManifest.xml` 开启 `INTERNET`、`CAMERA`（扫码）、`usesCleartextTraffic`（局域网 http 必需）

## 代码结构

| 文件 | 作用 |
|------|------|
| `lib/api.dart` | 远程 API 客户端（token 鉴权，终端 list/read/write/resize/create） |
| `lib/store.dart` | 配对信息持久化 + 二维码/链接解析 |
| `lib/screens/pair_screen.dart` | 配对页（扫码 / 手动） |
| `lib/screens/scan_screen.dart` | 二维码扫描 |
| `lib/screens/sessions_screen.dart` | 会话列表 + 新建会话 |
| `lib/screens/terminal_screen.dart` | xterm 终端 + 手机快捷键条 |
