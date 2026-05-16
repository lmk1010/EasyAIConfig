# EasyAIConfig 测试场景清单 — 对标 Cursor / Claude Code / Codex App

> 分析日期: 2026-05-11
> 对标: Cursor IDE, Claude Code Desktop, Codex App (Desktop), OpenCode

---

## 当前已有页面/功能盘点

| 页面 | 说明 | 状态 |
|------|------|------|
| Quick Setup | 一键配置 Provider / API Key | ✅ |
| Config Editor | 表单 + 原始 TOML/JSON 编辑 | ✅ |
| Console | 运行控制台 + 嵌入式终端 (xterm.js + PTY) | ✅ |
| Dashboard | Token 用量/费用/模型分布 | ✅ |
| Tools | 工具安装/更新/卸载 | ✅ |
| Tasks | 安装任务管理 | ✅ |
| System Settings | 存储/缓存/清理 | ✅ |
| Session 管理 | Codex 会话列表/恢复/分叉/导出 | ✅ |
| OAuth Profiles | Codex + Claude Code 多账号切换 | ✅ |
| Shell Integration | shell-env.sh 注入 CLAUDE_CONFIG_DIR | ✅ |
| Network | IP/延迟/连通性检测 | ✅ |
| 嵌入式终端 | portable-pty + xterm.js 双向交互 | ✅ |

---

## 需要测试的场景（分优先级）

### P0 — 核心链路，必须 100% 通过

#### 1. 工具安装全链路 (Install → Detect → Launch)

**对标**: Cursor 一键安装 CLI, Codex App 自带 runtime

| # | 测试点 | 操作 | 预期结果 |
|---|--------|------|----------|
| 1.1 | Codex CLI 全新安装 | Tools → Codex → 安装 | npm install -g 成功，版本显示正确 |
| 1.2 | Claude Code 全新安装 | Tools → Claude Code → 安装 | npm install 成功 |
| 1.3 | OpenCode 多方式安装 | auto/npm/homebrew/script | 各路径都能走通，进度条有效 |
| 1.4 | OpenClaw 安装 + Onboard | 安装 → onboard → Gateway 启动 | 全流程贯通 |
| 1.5 | 安装失败回退 | 断网/无 npm 时安装 | 错误信息明确，不卡死 |
| 1.6 | 版本检测与更新 | 已安装 → 检测新版 → 更新 | 版本号刷新 |
| 1.7 | 卸载 | Tools → 卸载 → 重装 | 干净卸载，重装后 state 正确 |

#### 2. Provider 配置 → 验证 → 启动 (Quick Setup 黄金路径)

**对标**: Claude Code `claude login`, Codex `codex login`

| # | 测试点 | 操作 | 预期结果 |
|---|--------|------|----------|
| 2.1 | API Key 模式配置 | 输入 Base URL + Key → 检测 → 保存 | config.toml + .env 正确写入 |
| 2.2 | OAuth 官方登录 (Codex) | 官方登录 → 设为默认 Provider | 浏览器跳转，token 写入 |
| 2.3 | OAuth 官方登录 (Claude Code) | 同上 | CLAUDE_CONFIG_DIR 正确 |
| 2.4 | 模型自动发现 | 配 Provider 后 → 检测模型 | 返回可用模型列表 |
| 2.5 | Provider 健康检查 | 保存后 → Console 状态 | 显示"通过"或明确错误 |
| 2.6 | 多 Provider 切换 | 保存 A → 切换 B → 切回 A | 各自配置独立无污染 |
| 2.7 | 中转 API Key 兼容 | newapi/oneapi 等 Base URL | 模型检测正常 |
| 2.8 | 配置文件已存在时的合并 | 用户手动改过 config.toml → UI 再保存 | 只改 Provider 部分，不覆盖其他字段 |

#### 3. 嵌入式终端 (Console 页)

**对标**: Cursor 内置终端, Claude Code TUI 直接运行

| # | 测试点 | 操作 | 预期结果 |
|---|--------|------|----------|
| 3.1 | 启动 Codex | Console → 启动 Codex CLI | 终端出现交互界面 |
| 3.2 | 启动 Claude Code | Console → 启动 Claude Code | 终端可交互 |
| 3.3 | 终端输入输出 | 键盘输入 → 回显 | xterm 双向通信正常，无乱码 |
| 3.4 | 终端 resize | 窗口拖大/小 | PTY 重新 resize，不断行 |
| 3.5 | 多终端会话 | 同时启动 Codex + Claude Code | 各自独立，切换正常 |
| 3.6 | 终端异常退出 | 杀进程 / ctrl-c | UI 状态更新为"已结束" |
| 3.7 | ANSI 颜色/进度条 | npm install 进度条/彩色输出 | xterm 正确渲染 |

---

### P1 — 差异化功能，对标竞品需要覆盖

#### 4. 会话管理（Session 恢复/分叉/导出）

**对标**: Codex App 会话历史, Claude Code `/resume`

| # | 测试点 | 操作 | 预期结果 |
|---|--------|------|----------|
| 4.1 | 会话列表加载 | Console → 本地会话 | 读取 ~/.codex/sessions/ 正确 |
| 4.2 | 会话恢复（resume） | 选中会话 → 继续 | 在嵌入式终端里 codex --resume |
| 4.3 | 会话分叉（fork） | 选中 → 分叉 | 新终端起 codex --fork |
| 4.4 | 会话导出 | 导出 JSONL/TXT | 文件内容完整可读 |
| 4.5 | 会话详情 | 点击查看 | 展示 token 统计/模型/时间 |

#### 5. 多账号管理 (OAuth Profiles)

**对标**: Claude Code 多 organization 切换, Cursor 多 account

| # | 测试点 | 操作 | 预期结果 |
|---|--------|------|----------|
| 5.1 | 创建新 Profile | OAuth Profiles → 新建 | 独立目录创建成功 |
| 5.2 | 切换 Profile | 选中另一个 → 切换 | 配置立即切换，Console 反映 |
| 5.3 | 重命名 Profile | 编辑名称 | 持久化，不影响配置 |
| 5.4 | 删除 Profile | 删除 → 确认 | 目录清理，不影响其他 Profile |
| 5.5 | Shell Integration 联动 | 开启 Shell 集成 → 新终端 | CLAUDE_CONFIG_DIR 自动跟随活跃 Profile |

#### 6. Dashboard 数据看板

**对标**: Cursor 用量面板, Claude Code usage API

| # | 测试点 | 操作 | 预期结果 |
|---|--------|------|----------|
| 6.1 | Codex 用量统计 | Dashboard → Codex | 趋势图 + 模型分布正确 |
| 6.2 | Claude Code 本地用量 | Dashboard → Claude | 读取本地日志统计 |
| 6.3 | 自动刷新 | 设 5min/30min 自动刷新 | 定时器生效 |
| 6.4 | 费用估算 | 查看费用列 | 计算合理 |
| 6.5 | 空数据状态 | 新安装/无使用记录 | 优雅空态，不报错 |

#### 7. 配置编辑器 (Config Editor)

**对标**: Codex 的 config.toml 手动编辑场景

| # | 测试点 | 操作 | 预期结果 |
|---|--------|------|----------|
| 7.1 | 表单模式编辑 | 修改字段 → 保存 | TOML/JSON 正确更新 |
| 7.2 | 原始模式编辑 | 直接改 TOML 文本 → 保存 | 解析验证 → 写入 |
| 7.3 | 预设方案（Recipes） | 搜索 → 应用 recipe | 字段正确填入 |
| 7.4 | 备份与恢复 | 保存 → 查看备份 → 恢复 | 回到之前状态 |
| 7.5 | 跨工具配置 | Codex ↔ Claude Code ↔ OpenCode 切换 | 各自文件独立 |
| 7.6 | MCP 配置 (OpenClaw) | JSON fragment 输入 | 合并到目标配置正确 |

---

### P2 — 稳定性/边界场景，影响用户信任

#### 8. 网络诊断

| # | 测试点 | 操作 | 预期结果 |
|---|--------|------|----------|
| 8.1 | Google 可达性检测 | Network → 刷新 | 正确判断直连/代理 |
| 8.2 | 延迟测量 | 目标 URL 延迟 | 数值合理 |
| 8.3 | IP 历史 | 多次检测 | 历史记录列表正确 |
| 8.4 | 代理场景 | socks5/http 代理下 | 检测走代理通道 |

#### 9. 系统存储与清理

| # | 测试点 | 操作 | 预期结果 |
|---|--------|------|----------|
| 9.1 | 存储占用展示 | System → 查看 | 各目录大小正确 |
| 9.2 | 缓存清理 | 选择目标 → 清理 | 释放空间，不误删 |
| 9.3 | 完全卸载 | 卸载 → 确认 | 工具+配置全清 |

#### 10. 自动更新（Tauri Updater）

| # | 测试点 | 操作 | 预期结果 |
|---|--------|------|----------|
| 10.1 | 检查更新 | About → 检查 | 有/无新版正确提示 |
| 10.2 | 下载安装 | 确认更新 → 下载进度 → 安装 | 热重启成功 |
| 10.3 | 更新失败 | 网络中断/签名不匹配 | 友好错误提示 |

---

### P3 — 对标竞品特色功能（当前缺失，可作后续 Roadmap 验证）

#### 11. 你目前 **缺少** 但竞品有的场景

| # | 场景 | 谁有 | 你的现状 | 建议 |
|---|------|------|----------|------|
| 11.1 | **Agent 对话内嵌** — 在 App 里直接和 AI 对话 | Cursor (Chat), Codex App, Claude Desktop | ❌ 只有终端模式 | P1: 至少支持 Codex/CC 的 stdin/stdout 流式渲染成聊天界面 |
| 11.2 | **文件变更预览 (Diff View)** — 查看 Agent 改了什么 | Cursor (inline diff), Codex App, Claude Code | ❌ 无 | P2: 读取 git diff 在 UI 展示 |
| 11.3 | **上下文管理 UI** — 手动添加文件/链接到 context | Cursor (@file/@folder), Codex (context attach) | ❌ 无 | P2: config-editor 里加 context sources |
| 11.4 | **MCP Server 管理** — 安装/启用/禁用 MCP 服务器 | Claude Code (settings.json mcp), Cursor (mcpServers) | ⚠️ OpenClaw 有 MCP fragment | P1: 独立 MCP 管理面板 |
| 11.5 | **AGENTS.md / Rules 管理** — 查看/编辑项目规则 | Codex (AGENTS.md), Claude Code (CLAUDE.md), Cursor (.cursorrules) | ❌ 无 | P2: 提供可视化编辑器 |
| 11.6 | **费用限额告警** — 接近额度时通知 | Cursor (usage limits), Claude Code (quota) | ⚠️ Dashboard 有数据但无告警 | P1: 加阈值通知 |
| 11.7 | **跨机器配置同步** — 云端备份/恢复 | Cursor Settings Sync | ❌ 只有本地备份 | P3: 可选 GitHub Gist / 文件同步 |
| 11.8 | **多项目/Workspace 切换** — 项目级配置 | Cursor (project settings), Codex (per-repo AGENTS.md) | ⚠️ 有 scope 但不突出 | P2: 项目选择器 |
| 11.9 | **进程资源监控** — CPU/Memory 实时图表 | Cursor (activity monitor) | ⚠️ processes.rs 有 ps 数据 | P2: 加 sparkline |
| 11.10 | **Keyboard shortcuts / 快捷操作** | Cursor (Cmd+K 等) | ❌ 无全局快捷键 | P3: 常用操作热键 |

---

## 测试执行建议

### 快速冒烟（5 分钟内跑完）

```bash
# 1. 确认构建通过
cd /Users/liumingkang/AI/MK/codex-config-ui
npm run check

# 2. Web 模式启动
npm start
# 检查: Quick → Console → Dashboard → Tools 各页面无白屏

# 3. Desktop 模式启动 (如果 Rust 环境就绪)
npm run desktop:dev
# 检查: 窗口打开 → 标题栏 → traffic light 位置
```

### 重点回归项（每次发版前）

1. **Quick Setup 黄金路径** (2.1 → 2.2 → 2.5 → 3.1)
2. **安装链路** (1.1 或 1.3)
3. **嵌入式终端** (3.1 + 3.3 + 3.4)
4. **会话恢复** (4.1 + 4.2)
5. **多 Profile 切换** (5.1 + 5.2 + 5.5)

### 对标竞品的优先补齐

**立即可做（复用现有能力）：**
- **11.1 Agent 对话内嵌** — 你已有 xterm.js + PTY 终端，可以把 stdout 做一层聊天 bubble 的 render（CC 和 Codex CLI 都是 TUI，输出的 markdown 可以在前端 parse 成聊天气泡）
- **11.4 MCP Server 管理** — 你已有 config editor 的表单能力，加一个专门的 MCP servers 表单（读 `~/.claude/settings.json` → mcpServers）
- **11.6 费用限额告警** — Dashboard 已有数据，加阈值 + localStorage 比对即可

**中期（1-2 周）：**
- **11.2 Diff View** — Tauri 里 `git diff` + 简单高亮即可，不需要完整 Monaco
- **11.5 AGENTS.md 编辑** — 读/写文件 + markdown 编辑器
