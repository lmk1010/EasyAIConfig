# EasyAIConfig 对标并超越 cc-switch：长期工程报告

日期：2026-07-05

本文档是 EasyAIConfig 从“配置编辑器/切换器”升级成长期 AI Coding
Operations Console 的目标、证据、差距和实施清单。它不是一次性小需求；
目标完成的判定标准是：用户列出的每个能力都有真实代码、UI/桌面入口、
测试或运行证据，并且不会破坏现有配置。

## 1. 总目标

把 EasyAIConfig 做成完整对标并超越 cc-switch 的本地优先 AI Coding
Operations Console：

- 工具覆盖：Claude Code、Claude Desktop、Codex、Gemini CLI、OpenCode、
  OpenClaw、Hermes Agent。
- Provider：50+ provider presets，带协议、区域、模型、工具兼容、路由兼容元数据。
- Local Routing：热切换、协议转换、自动 failover、circuit breaker、
  health monitoring、request rectifier、request logs。
- MCP：统一管理、跨工具同步、冲突预览、双向同步、Deep Link 导入。
- Prompts：统一管理 `CLAUDE.md`、`AGENTS.md`、`GEMINI.md`，支持全局/项目作用域和回填保护。
- Skills：GitHub/ZIP/local 安装、自定义仓库、symlink/file copy、更新管理、移除和恢复。
- Sessions：跨来源浏览、搜索、恢复、删除、导出，并支持 provider -> project 两级分组。
- Usage：花费、请求、token、趋势图、请求日志、自定义价格。
- Sync：Dropbox、OneDrive、iCloud、NAS、WebDAV、本地加密 profile 导入导出。
- Sharing：`easyai://` / `easyaiconfig://` / `ccswitch://` Deep Link 导入 providers/MCP/prompts/skills。
- Desktop：自动更新、tray、主题、i18n、多平台包、桌面 smoke tests。

## 2. cc-switch 当前公开基准

公开资料核对日期：2026-07-05。网络上 raw.githubusercontent.com 在本机
curl 不通，因此本轮通过 GitHub API contents/release 接口读取同一仓库资料。

参考入口：

- README：<https://github.com/farion1231/cc-switch>
- 用户手册：<https://github.com/farion1231/cc-switch/tree/main/docs/user-manual/en>
- Deep Link 文档：<https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/5-faq/5.3-deeplink.md>
- 最新 release：<https://github.com/farion1231/cc-switch/releases/tag/v3.16.5>

已确认的 cc-switch 基准：

- README 把产品定位为覆盖 Claude Code、Claude Desktop、Codex、Gemini CLI、
  OpenCode、OpenClaw、Hermes Agent 的一体化管理器。
- 用户手册 v3.16.0（最后更新 2026-05-29）明确有 Provider Management、
  MCP Server Management、Prompts、Skills、Session Manager、Proxy &
  High Availability、Usage Statistics、Model Test、Deep Link Protocol。
- v3.16.5 release 发布于 2026-07-01，GitHub release assets 包含 Windows
  MSI/Portable、macOS dmg/zip/tar.gz、Linux AppImage/deb/rpm 以及签名/更新元数据。
- v3.16.5 release notes 显示其继续强化 Codex 原生 Responses 供应商、
  模型目录生成、`web_search` 黑名单、通用配置切换同步、Claude Sonnet 5
  定价、会话 provider -> project 两级分组、新 provider presets、Hermes
  Windows 配置目录、Linux Wayland 兼容和长列表 UI 等实际使用体验问题。
- 用户手册的 Failover 页面描述了 failover queue、auto failover、circuit
  breaker、健康状态、request logs；Usage 页面描述了 proxy request log +
  CLI session log、token/cost/trend/request log/custom pricing；Skills 页面描述了
  GitHub repository、自定义仓库、SHA-256 update detection、batch update、
  symlink/copy 相关分发策略；Deep Link 页面描述了 provider/MCP/prompt/skill 导入。

结论：cc-switch 的竞品基准已经不是“Provider 切换器”，而是“多工具 +
本地代理 + 配置资产 + 用量运营 + 桌面发布”的完整产品面。

## 3. EasyAIConfig 当前代码证据

本节只记录当前仓库能证明的事实，不用意图代替完成度。

### 3.1 已有代码入口

- Provider catalog：`src/lib/provider-catalog.js`
- MCP inventory/import/sync plan：`src/lib/mcp-manager.js`
- Prompt inventory/import/apply：`src/lib/prompt-manager.js`
- Skill inventory/import/apply：`src/lib/skill-manager.js`
- Session inventory/schema：`src/lib/session-manager.js`
- Usage inventory/custom price book：`src/lib/usage-manager.js`
- Sync target inventory/schema：`src/lib/sync-manager.js`
- Local Routing control plane：`src/lib/local-routing-manager.js`
- HTTP API 集成：`src/server.js`
- Tauri router runtime：`src-tauri/src/provider_router.rs`
- Unified Asset Import UI：`public/app.js` / `public/styles.css`

### 3.2 已证明的进展

- Provider catalog 当前返回 58 个 presets。
- Catalog summary 覆盖 Codex、OpenCode、OpenClaw、Claude Code、Gemini 等工具标签。
- Asset bundle / Deep Link 解析支持 `easyai://`、`easyaiconfig://`、`ccswitch://`
  的 payload 形态，并能 preview/apply providers、MCP、prompts、skills。
- Unified Asset Import UI 已有导入文本、Codex Home、project path、target tool、
  install mode、include catalog、overwrite、append prompts、confirm apply、preview/apply/clear 控件。
- Prompt import 支持 dry-run 默认、overwrite/append gate、写入前 backup、
  duplicate append protection、sha256 回填保护。
- Skill import 支持 inline/local source、copy/symlink install mode；但远程 GitHub/ZIP
  下载和批量更新还没有生产级实现。
- MCP manager 已能做跨工具 inventory、import preview/apply 和同步计划；真实双向写入仍需更强备份/冲突处理。
- Session manager 已有跨工具 schema、搜索/过滤字段、provider -> project 分组字段；恢复/删除/导出还未完成。
- Usage manager 已有 Codex/Claude/OpenCode usage inventory、token/cost/provider/model/day
  rollup、自定义价格文件；完整趋势图 UI 和 Tauri request log 串联仍需补。
- Sync manager 已有 iCloud、Dropbox、OneDrive、NAS/Volumes、WebDAV、自定义目录等 target
  inventory 和本地 target 存储；加密 profile、WebDAV push/pull、目录 sync apply 尚未完成。
- Local Routing Node control plane 已加入：
  - 7 个工具枚举：`claudecode`、`claude-desktop`、`codex`、`gemini`、`opencode`、`openclaw`、`hermes`
  - 策略：`auto`、`priority`、`round_robin`、`weighted`、`balance`
  - health-aware route plan、balance guard、circuit breaker preview、failover order
  - request rectifier preview：OpenAI Responses <-> Chat、Chat <-> Anthropic、Anthropic -> Responses
  - secret log redaction
  - capabilities schema
- Tauri router runtime 已有本地 HTTP proxy、provider selection、balance guard、
  retry/failover、SQLite request logs、usage token extraction、probe/status API 基础。
- Provider Router UI 和 Tauri runtime 已能识别并隔离 7 个工具：
  Codex、Claude Code、Claude Desktop、Gemini CLI、OpenCode、OpenClaw、Hermes Agent。
  Claude Code/Claude Desktop 使用 Anthropic endpoint/probe/auth，其他工具使用 OpenAI-compatible
  endpoint/probe/auth。客户端配置表已支持 7 个工具一键写入：Codex、Claude Code、OpenCode、
  OpenClaw 写入各自原生配置；Hermes Agent 写 `config.yaml` + `.env` 的 custom provider
  并保留 `easyaiconfig.router`；Claude Desktop、Gemini CLI 先写安全命名空间，避免伪造
  未确认的官方 provider 字段。Gemini CLI 已能读回该 safe profile 并刷新快速配置卡片。
- Tauri live proxy 已接入核心 request rectifier：按请求 path 推断 source protocol，
  按 provider `protocol/wireApi` 确定 target protocol，并在转发前转换
  OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 的 path/body；
  Gemini 目标已支持 GenerateContent 请求侧转换、非流式响应回译、streamGenerateContent
  SSE 事件格式映射、错误格式归一化、`/v1beta` 路径去重和 `x-goog-api-key`。
  当前低延迟逐块转发和 tool result 深度语义仍未完整覆盖。

## 4. 对标差距矩阵

状态定义：

- `已证明`：当前代码和测试能证明能力存在。
- `部分`：有模块/数据结构/预览，但没有完整 UI、桌面入口或真实运行闭环。
- `缺口`：尚未实现核心行为。

| 能力 | cc-switch 基准 | EasyAIConfig 当前状态 | 当前结论 |
| --- | --- | --- | --- |
| 7 个工具覆盖 | README/手册覆盖 7 个工具 | Node catalog/routing、Provider Router UI、Tauri router runtime 已列 7 个；Router 客户端 7 工具均可写入；Hermes 已有原生 custom provider 写入，Claude Desktop/Gemini 仍是安全 profile | 部分偏强 |
| 50+ provider presets | 文档和 release 持续新增 presets | 58 个 presets 已证明；catalog tools 自动扩展到 7 工具；还缺完整 UI surfacing、模型拉取和跨工具原生写入闭环 | 部分偏强 |
| Provider 切换 | 主 UI/tray/app takeover | EasyAIConfig 有配置编辑和部分代理接管；tray/应用级 takeover 未完整验证 | 部分 |
| Local Routing runtime | Proxy、routing、failover、circuit breaker、health、logs | Tauri runtime 有 proxy/retry/log/probe、核心 live rectifier 和真实 circuit breaker 状态机；Node 有 plan/rectifier/redaction；health scheduler 和两层统一仍不足 | 部分偏强 |
| Request rectifier | Codex Chat/Responses 等真实代理转换 | Node preview 已有多协议转换；Tauri live proxy 已覆盖 Responses/Chat/Anthropic path/body 转换，并新增 OpenAI/Anthropic -> Gemini GenerateContent 请求转换、Gemini 非流式 response 回译、Gemini SSE 事件格式映射和 Gemini upstream error 归一化；低延迟逐块转发、tool result 深度语义仍未完成 | 部分偏强 |
| Circuit breaker | 状态机、half-open、恢复阈值 | Tauri runtime 已实现 closed/open/half-open、连续失败阈值、恢复等待、成功恢复阈值、错误率阈值，并参与 live 选路；还缺主动 health probe 驱动和 UI 阈值控制 | 已证明/仍需打磨 |
| MCP | 管理、同步、Deep Link | inventory/import/sync plan 已有；真实双向 apply 和 UI 完整面板不足 | 部分 |
| Prompts | CLAUDE/AGENTS/GEMINI 管理、回填保护 | import/apply/backups/sha 保护已实现；预设管理 UI 和跨项目体验仍不足 | 部分偏强 |
| Skills | GitHub/仓库/更新/批量更新/copy/symlink | local/inline/copy/symlink 已有；GitHub/ZIP downloader、registry、SHA update、backup restore 不完整 | 部分 |
| Sessions | 浏览/搜索/恢复/删除/分组 | inventory/schema/grouping 字段已有；文件型 session 已有可恢复归档/恢复 API、Asset Center 归档入口和 Trash/Restore UI；OpenCode SQLite、批量/export 仍缺 | 部分 |
| Usage | proxy log + CLI session log + trends + pricing | usage inventory 和 Tauri request log 基础已有；完整图表、过滤、日志详情和 pricing UI 未闭环 | 部分 |
| Cloud Sync | iCloud/Dropbox/OneDrive/NAS/WebDAV | target inventory 已有；目录型目标已支持 snapshot push/list/pull dry-run/apply UI 和 API；WebDAV、加密 profile、冲突合并仍缺 | 部分 |
| Deep Link | `ccswitch://` provider/MCP/prompt/skill | payload 兼容和 cc-switch V1 query provider/MCP/prompt/skill 预览已支持，扩展字段已进入 payload；Tauri 已配置 `easyai/easyaiconfig/ccswitch` schemes 并转发到 Asset Center preview，真实安装包外部唤起仍待逐平台验收 | 部分偏强 |
| Desktop maturity | updater/tray/themes/i18n/multiplatform packages | Tauri 项目和 build scripts 存在；自动更新/tray/i18n/多平台包 smoke 未完成 | 缺口 |
| UI 使用体验 | 大量面板和细节修复 | Asset Center 已按 CLI/Desktop/Gateway 分组重排，Sessions 行级归档和 Trash/Restore 入口已补；Local Routing/MCP/Skills/Sessions/Usage 的完整运营面板仍不足 | 部分 |

## 5. 本轮新增工程进展

### 5.1 Local Routing control plane

新增 `src/lib/local-routing-manager.js`，把 Local Routing 从“只有运行时代理”补成可被 UI/API
消费的控制面模型：

- 标准化工具、协议、策略和 provider route key。
- 根据 providerTargets、health/request logs/providerStats 生成 route plan。
- 支持低余额跳过、circuit open 跳过、weighted/round_robin/balance 排序。
- 输出 primary route、failover providers、skipped providers、policy summary。
- 对请求做非破坏性 preview rectifier，不直接写 live request。
- 对 authorization/api-key/x-api-key/proxy-authorization 以及嵌套 request headers 做脱敏。

新增 API：

- `GET /api/local-routing/capabilities`
- `POST /api/local-routing/plan`
- `POST /api/local-routing/rectifier/preview`
- `POST /api/local-routing/log/redact`

### 5.2 检查脚本升级

`npm run check` 已从手写旧文件列表改成自动检查：

- `src/server.js`
- `src/lib/*.js`
- `public/*.js`

这会把新增的 provider/MCP/prompt/skill/session/usage/sync/local-routing 模块纳入静态语法检查。

### 5.3 Provider Router 7 工具运行时覆盖

本轮把“支持 7 个工具”从文档/catalog 推进到真实运行层：

- `src-tauri/src/provider_router.rs` 的 tool normalize 覆盖
  `codex`、`claudecode`、`claude-desktop`、`gemini`、`opencode`、`openclaw`、`hermes`。
- Router route key 不再把 Gemini/OpenCode/OpenClaw/Hermes 折叠成 Codex，日志、状态、self-target
  判断都按工具隔离。
- Probe payload 按协议选择：Claude Code/Claude Desktop 走 `/v1/messages`，OpenAI-compatible
  工具走 `/v1/responses`。
- Forward auth 按协议选择：Claude 家族支持 `x-api-key` / bearer auth token，OpenAI-compatible
  工具走 bearer API key。
- Provider Router UI 改成 `PROVIDER_ROUTER_TOOL_DEFS` 单一工具定义源，tabs、客户端配置、日志过滤、
  endpoint copy 都从同一份定义生成。
- Claude Desktop 复用 Claude Provider source 和 Anthropic 协议；Gemini/OpenCode/OpenClaw/Hermes
  先复用 OpenAI-compatible provider source。
- 非 Codex/Claude Code 不展示一键写入，先明确提示只能复制接入配置，专属配置写入器进入下一阶段。
- 新增 Rust 单测和前端静态回归，防止未来退回只支持 Codex/Claude Code。

### 5.4 Tauri live request rectifier

本轮把 request rectifier 从 Node preview 推进到 Tauri live proxy：

- `RouterProviderConfig` 增加 `protocol` 字段，前端启动 Router 时会从 Codex `wireApi`、
  row/ref `protocol/wireApi/wire_api/api` 或工具默认协议推断后传给 Tauri。
- Runtime 会从请求 path 推断 source protocol：`/v1/responses`、`/v1/chat/completions`、
  `/v1/messages`。
- 转发前会把 request target 和 JSON body 转换到目标 provider 协议：
  - OpenAI Responses -> OpenAI Chat Completions
  - OpenAI Chat Completions -> OpenAI Responses
  - OpenAI Chat Completions -> Anthropic Messages
  - Anthropic Messages -> OpenAI Chat Completions
  - OpenAI Responses -> Anthropic Messages
  - Anthropic Messages -> OpenAI Responses
- 无法解析 JSON、协议不受支持、Gemini 目标协议等场景保持原请求，不做破坏性转换。
- 新增 Rust 单测覆盖 live 转换入口：
  `live_rectifier_converts_responses_to_chat_request`、
  `live_rectifier_converts_chat_to_anthropic_request`、
  `live_rectifier_converts_anthropic_to_responses_request`、
  `live_rectifier_leaves_unsupported_or_invalid_requests_unchanged`。

### 5.5 Tauri circuit breaker runtime

本轮把 Provider Router 从“retry/failover 计数”推进到真实熔断状态机：

- `RouterConfig` 增加 circuit breaker 参数：
  `circuitBreakerEnabled`、`circuitFailureThreshold`、`circuitRecoveryWaitMs`、
  `circuitSuccessThreshold`、`circuitErrorRateThreshold`、`circuitMinRequests`。
- `ProviderStats` 记录每个 route key 的 `closed/open/half-open`、open until、
  连续失败、连续成功、最近窗口请求数和错误率。
- `select_provider_order` 已接入 `circuit_guarded_provider_pool`，open 状态 provider
  不再进入 live 候选池；恢复窗口到期后自动进入 half-open 试探。
- 每次 upstream 响应或网络错误都会调用 `update_provider_circuit_after_attempt`：
  连续失败或错误率达到阈值会 open，half-open 成功达到阈值会 close，失败会重新 open。
- `/api/provider-router/status` 会把内存中的 circuit 状态合并进 SQLite 日志汇总，UI 的运行统计能看到
  Circuit breaker 汇总和每个 Provider 的 open/half-open/closed 状态。
- 新增 Rust 单测：
  `circuit_breaker_opens_skips_half_opens_and_closes`、
  `circuit_breaker_opens_on_error_rate_threshold`。

### 5.6 截图问题修复：Asset Center 路由和 7 工具入口

本轮针对桌面截图暴露的两个阻断点完成阶段性修复：

- 桌面 `GET /api/assets/index` 报 `Unsupported request`：Tauri fallback route
  已补齐 Asset Center 相关入口，包括 assets index/export/deep-link/import、
  MCP sync plan、sync targets。桌面端至少不会因为缺路由红屏。
- Quick Setup / 初始化向导仍只展示 4 个工具：`public/index.html` 已恢复到
  7 个工具入口，左侧工具列表、顶部 tool tab、Setup Wizard tool picker
  都包含 Codex、Claude Code、Claude Desktop、Gemini CLI、OpenCode、OpenClaw、
  Hermes Agent。
- Asset Center 页面骨架已恢复：主导航有 `data-page-target="assets"`，
  page stack 有 `data-page="assets"` 和 `id="assetCenterPage"`，与
  `public/app.js` 的 `renderAssetCenterPage()` 接上。
- 运行中 Node 服务验证：
  - `GET /api/assets/index?includeCatalog=1` 返回 `ok:true`、
    schema `easyaiconfig.asset-index.v1`，provider catalog 为 58 个。
  - `GET /api/tools` 返回 7 个工具：
    `codex`、`claudecode`、`claude-desktop`、`opencode`、`openclaw`、
    `gemini`、`hermes`。
  - 页面 HTML 中 `data-tool`、`data-sec-tool`、`data-wizard-tool` 均为 7 个，
    并包含 Asset Center 导航和页面容器。

截至 5.9 的当前回归验证结果：

- `npm run check` 通过。
- `node --test tests/config-editor-save-behavior.test.js` 通过，34/34。
- `npm test` 通过，128/128。
- `cargo test` 通过，32/32。

边界说明：这次修复解决的是“入口缺失/路由缺失”的阻断问题，不等于完整 parity
完成。Hermes Agent 已有基础原生 provider writer，但 reader、桌面 smoke、完整资产写入
和 Deep Link 真实写入仍列入下一阶段；Claude Desktop/Gemini CLI 仍需官方字段确认后再升级。

### 5.7 Tauri Asset Center 真实只读盘点

本轮继续把 Tauri fallback 从“路由不报错但返回空结构”推进到真实桌面只读盘点：

- `GET /api/assets/index` 在 Tauri runtime 下会读取真实本地资产：
  - MCP：Codex `config.toml`、Claude Code `settings.json`、Claude Desktop
    `claude_desktop_config.json`、OpenCode `opencode.json`。
  - Prompts：全局/项目 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`，返回标题、摘要、行数、sha256。
  - Skills：Codex、Claude、EasyAIConfig skills 目录，读取 `SKILL.md`/`README.md`
    metadata 和 sha256。
  - Sessions：Codex、Claude Code、OpenCode、Gemini CLI、OpenClaw、Hermes Agent
    session/history JSON/JSONL，并生成 provider -> project 两级分组。
  - Usage：Tauri provider router request logs + custom price book metadata，作为桌面 usage fallback。
- MCP 读取只暴露 env key 名，不暴露 env value，避免把 token/secret 带进 Asset Center。
- MCP source 错误拆成 `parseError` 和 `readError`，同步计划会跳过解析/读取失败的源；
  不存在的目标源仍可作为 preview-only create target。
- `GET /api/mcp/sync-plan` 使用真实 MCP inventory 生成只读复制预览和冲突列表。
- `GET /api/sync/targets` 会发现 iCloud、Dropbox、OneDrive、macOS `/Volumes` NAS、
  `EASYAICONFIG_SYNC_DIR` 和用户保存的 custom targets。
- `POST /api/sync/targets` 会保存到 `~/.codex-config-ui/sync-targets.json`。
- 桌面 import apply 仍保持 no-write：Tauri fallback 只 preview，不会悄悄改本地配置。

新增验证：

- Rust 单测：
  - `tauri_asset_mcp_inventory_reads_codex_toml_without_env_values`
  - `tauri_asset_inventory_reads_prompts_skills_and_sessions`
- 前端静态回归确认 Tauri routes 不再有 `empty_*_inventory`，并且 Asset Center
  使用真实 `mcp_inventory`、`prompt_inventory`、`skill_inventory`、`session_inventory`、
  `usage_inventory`。
- 一次性 Node 运行态 smoke：
  - `GET /api/assets/index?includeCatalog=1&usage=true` 返回 `ok:true`，
    schema `easyaiconfig.asset-index.v1`，provider catalog 为 58，且 MCP/Prompts/Skills/Sessions/Usage
    schema 均可用。
  - `GET /api/tools` 返回 7 个工具。
  - `GET /api/mcp/sync-plan` 返回 `ok:true`，有 target/operation/conflict summary。

剩余缺口：Claude Desktop、Gemini CLI 的完整原生 writer、Hermes 原生 reader/smoke、Sessions
专用全页管理、OpenCode SQLite session 变更、Usage CLI session 级完整合并，
Cloud Sync WebDAV/加密 profile/冲突合并，Deep Link 桌面协议注册和真实写入仍未完成。

### 5.8 Sessions 可恢复归档/恢复

本轮把 Sessions 从“跨来源只读盘点”推进到“文件型 session 可安全移除且可恢复”：

- Node backend 新增 `archiveSession`、`restoreSession`、`listSessionTrash`：
  - 默认 `dryRun:true`，真实执行必须显式传 `dryRun:false`。
  - 只允许 `.json`/`.jsonl` session 文件，且 source path 必须落在对应工具的已知 session root 内。
  - 归档会把原始 session 复制到 `~/.codex-config-ui/session-trash`，写入 index manifest，
    再删除原文件；恢复会从 trash 副本复制回原始路径。
  - 返回结构只包含 metadata、sha256、路径和状态，不把 session 原文带回 API/UI。
  - 目前支持 Codex、Claude Code、Gemini CLI、OpenClaw、Hermes Agent 这类文件型来源；
    OpenCode SQLite session 仍保持只读。
- Express API 新增：
  - `GET /api/sessions/trash`
  - `POST /api/sessions/archive`
  - `POST /api/sessions/restore`
  并复用既有 path validation，避免前端任意路径写删。
- Tauri fallback 同步新增同等能力：
  - `GET /api/sessions/inventory`
  - `GET /api/sessions/trash`
  - `POST /api/sessions/archive`
  - `POST /api/sessions/restore`
  桌面离线模式不再只有 Node 侧能处理 session 归档。
- Asset Center 的 Sessions 表格新增行级“归档”按钮和 Trash/Restore 区块：
  - 只有 inventory 标记 `actions.delete` 且存在 `sourcePath` 的 session 才可点击。
  - 点击后先调用 dry-run preview，再走现有确认弹窗，确认后才执行真实归档。
  - Trash 区块读取 `/api/sessions/trash`，只对 `exists && !restoredAt` 的归档项显示可用恢复入口。
  - 恢复同样先 dry-run；如果目标路径已存在，必须再次确认覆盖恢复。
  - 成功后刷新 Asset Center，避免 UI 继续展示已移走或已恢复的 session。
- 归档/恢复 schema：
  - `easyaiconfig.session-trash.v1`
  - `easyaiconfig.session-archive.v1`
  - `easyaiconfig.session-restore.v1`

新增验证：

- `node --test tests/session-manager.test.js`：
  - 文件型 Gemini session 可归档到 trash，并可恢复回原路径。
  - session root 外部路径会被拒绝。
- `tests/config-editor-save-behavior.test.js` 静态覆盖：
  - server 暴露 archive/restore/trash API。
  - frontend 包含 `data-asset-session-archive`、`data-asset-session-restore`、
    `archiveAssetSession` 和 `restoreAssetSession`。
- Rust 单测：
  - `tauri_session_archive_moves_to_trash_and_restores`。

当前边界：这不是完整 cc-switch Sessions parity。还缺专用 Sessions 全页管理、跨来源 resume 动作、
OpenCode SQLite 写操作、批量归档/恢复/删除、session export 和跨设备同步恢复策略。

### 5.9 Cloud Sync 目录型 snapshot push/pull

本轮把 Sync 从“发现 iCloud/Dropbox/OneDrive/NAS/WebDAV target”推进到本地目录 + WebDAV 同步闭环：

- Node backend 新增：
  - `listSyncSnapshots`
  - `pushSyncSnapshot`
  - `readSyncSnapshot`
  目录型 target 和 WebDAV target 都维护 `manifest.json` 和 `snapshots/*.json`。
  WebDAV 支持 Basic/Bearer/custom headers，API 返回会脱敏 password/token/header 值。
- Express API 新增：
  - `GET /api/sync/snapshots`
  - `POST /api/sync/push`
  - `POST /api/sync/pull`
- Snapshot schema：
  - manifest：`easyaiconfig.sync-manifest.v1`
  - list：`easyaiconfig.sync-snapshots.v1`
  - push：`easyaiconfig.sync-push.v1`
  - pull/read：`easyaiconfig.sync-pull.v1`
  - pull+apply：`easyaiconfig.sync-pull-apply.v1`
- Push 行为：
  - 默认 `dryRun:true`。
  - 真实推送会写入 `snapshots/<snapshotId>.json`，更新 `manifest.json`。
  - snapshot 保存 asset bundle、bytes、sha256、counts 和 pushedAt。
  - 适用于 iCloud、Dropbox、OneDrive、NAS、custom directory 这类本地同步目录，也适用于 WebDAV URL。
- Pull 行为：
  - 读取 manifest 的 latest snapshot 或指定 `snapshotId`。
  - 校验本地 snapshot 路径或 WebDAV snapshot URL 必须在 target root 内。
  - 校验 sha256，防止同步包损坏后继续导入。
  - Node 路径会复用统一资产导入器，默认 dry-run，显式 `dryRun:false` 才写入。
  - 同步 pull 默认按完整快照恢复 provider catalog presets；普通 Deep Link 导入仍保留显式勾选，避免误把 50+ 预设全部写入本机。
- Tauri fallback：
  - 补齐 `/api/sync/snapshots`、`/api/sync/push`、`/api/sync/pull`，避免桌面 Unsupported request。
  - Tauri push 可真实写入本地同步目录和 WebDAV target。
  - Tauri pull 复用当前桌面 asset import no-write plan，因此仍是安全预览，不伪装成已经改配置。
- Asset Center UI：
  - Sync Targets 面板新增 latest snapshot 列。
  - 每个目录型/WebDAV target 提供“推送”和“拉取”按钮。
  - 推送和拉取都先 dry-run，再弹确认；拉取默认不覆盖冲突项。

新增验证：

- `node --test tests/sync-manager.test.js`：
  - target discovery/save 仍可用。
  - snapshot dry-run 不落盘。
  - snapshot apply 写 manifest/snapshot。
  - list/read 会返回 latest snapshot 并校验 bundle。
  - WebDAV fake server 覆盖 Basic Auth、MKCOL/PUT/GET、manifest/snapshot、target auth 脱敏。
- `tests/config-editor-save-behavior.test.js` 静态覆盖：
  - server 暴露 snapshots/push/pull API。
  - Tauri dispatch 暴露 snapshots/push/pull route。
  - frontend 包含 `data-asset-sync-push`、`data-asset-sync-pull`、
    `pushAssetSyncTarget` 和 `pullAssetSyncTarget`。
- Rust 单测：
  - `tauri_sync_snapshot_push_list_and_pull_preview`。
- API 回归：
  - `tests/sync-api.test.js` 覆盖 `/api/sync/push` -> `/api/sync/pull`，确认不显式传
    `includeCatalogPresets` 时 provider catalog 也会进入 dry-run apply summary。

当前边界：这不是完整 cc-switch Sync parity。跨设备冲突合并、加密 profile export/import、
敏感信息选择性同步、snapshot restore 历史 UI、同步删除策略和真实第三方 WebDAV 兼容性矩阵仍未完成。

### 5.10 Provider Router 7 工具客户端写入和截图报错修复

本轮修复用户截图暴露的两个问题：一是保存 `Claude Desktop / Gemini CLI /
Hermes Agent` 时前端仍按旧逻辑直接报错；二是网关核心已支持 7 个工具，但
Config Editor / Dashboard / Provider Catalog / Router 客户端表没有完整暴露，导致使用体验上像“没有支持”。

完成项：

- `saveConfigOnly()` 不再对 `claude-desktop`、`gemini`、`hermes` 弹
  “未写入本机配置”错误，而是复用 `actionProviderRouterApplyClient()` 写入 Router 客户端配置。
- `actionProviderRouterApplyClient()` 统一调用 `/api/provider-router/apply-client`，
  并返回 `true/false`，供保存按钮和配置页按钮复用。
- Provider Router 客户端表的“一键配置”放开到 7 个工具：
  `codex`、`claudecode`、`claude-desktop`、`gemini`、`opencode`、`openclaw`、`hermes`。
- Config Editor 新增的三类工具面板按钮已绑定：
  - `data-cfg-router-apply`：直接写入 Router profile。
  - `data-cfg-router-open`：跳到 Provider Router，并切到 `clients` tab。
- Dashboard 左侧 7 工具入口点击后不再把 `Claude Desktop / Gemini CLI /
  Hermes Agent` 回落成 Codex 用量看板，而是显示对应 Router Profile 看板，并提供写入/打开 Router 动作。
- Provider Catalog 的 tools 元数据自动扩展到 7 个工具：
  OpenAI-compatible presets 覆盖 Codex/Gemini/OpenCode/OpenClaw/Hermes；
  Anthropic presets 覆盖 Claude Code/Claude Desktop/OpenCode/OpenClaw/Hermes；
  Gemini/Vertex presets 覆盖 Gemini/Codex/OpenCode/OpenClaw/Hermes。
- Node backend 新增 `applyProviderRouterClientConfig()`：
  - Codex：复用 `saveConfig()` 写入并激活 `easyai-router` provider。
  - Claude Code：写 `~/.claude/settings.json` env 和 `easyaiconfig.providers.easyai-router`。
  - OpenCode：写 `provider.easyai-router.options.baseURL/apiKey` 和 `model`。
  - OpenClaw：写 env、default model provider 和 `easyaiconfig.router`。
  - Claude Desktop / Gemini CLI：写各自 JSON 配置里的 `easyaiconfig.router`，
    不覆盖 MCP 或未知原生字段。
  - Hermes Agent：写 `~/.hermes/config.yaml` 的顶层 `model` custom provider、
    `~/.hermes/.env` 的 Router key/base/no_proxy，并保留 `~/.hermes/config.json`
    的 `easyaiconfig.router` 资产索引。
- Tauri fallback 同步新增 `/api/provider-router/apply-client`，桌面模式不再只有 Node 侧能写入。
- Hermes Agent 新增读回闭环：
  - Node `/api/hermes/state` 和 Tauri fallback `/api/hermes/state` 会读取 `config.yaml`
    顶层 `model` 块、`.env` Router/OpenAI 兼容变量、`config.json` 的 `easyaiconfig.router`。
  - 前端新增 `state.hermesState` / `loadHermesQuickState()`，Router 一键写入后自动刷新 Hermes
    当前配置卡片，展示 native provider、模型、Base URL、Key readiness 和配置路径。

当前边界：

- Claude Desktop、Gemini CLI 现在是安全 namespaced Router profile，不伪造未知官方字段。
  Hermes Agent 已有 custom provider writer + reader + 基础启动器，但还要补 session resume 深度恢复和真实 CLI smoke tests。
- OpenCode/OpenClaw 已有较深原生写入，但还需要真实端到端启动验证。
- Router 网关支持不等于“每个工具全功能支持”；使用体验要继续补 Dashboard/Console/Sessions/Usage 的专属深层视图。

本轮验证：

- `node --check src/lib/config-store.js` 通过。
- `node --check src/server.js` 通过。
- `node --check public/app.js` 通过。
- `node --test tests/config-editor-save-behavior.test.js tests/hermes-state.test.js tests/session-manager.test.js` 通过，42/42。
- `cd src-tauri && cargo check` 通过。
- `npm run check` 通过。
- `npm test` 通过，133/133。
- `cd src-tauri && cargo test` 通过，32/32。
- `cargo test` 通过，32/32。

### 5.11 Hermes Agent 启动闭环

在 5.10 已完成 Hermes native writer/reader 后，本轮继续补“能启动”的使用体验闭环：

- Node backend 新增 `launchHermes()` 和 `POST /api/hermes/launch`。
- 前端新增 `launchHermesOnly()`；`launchActiveTool()` 对 `hermes` 不再显示“原生启动器继续接入中”，而是实际调用启动 API。
- 启动前检测 `hermes` binary；未安装时给出明确安装提示。
- 启动时读取 `~/.hermes/.env`，只注入白名单变量：
  `EASYAI_ROUTER_API_KEY`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`NO_PROXY`、`no_proxy`。
  这样即使 Hermes CLI 不主动加载 `.env`，从 EasyAIConfig 启动也能拿到 Router 凭证和 Base URL。
- Tauri fallback 同步新增 `launch_hermes()` 和 `/api/hermes/launch`，桌面模式不再缺这条链。
- `tests/config-editor-save-behavior.test.js` 新增防回归覆盖：保存配置不得误启动 Hermes，Hermes 启动必须贯通
  Web、Node、Tauri 和 Router env 注入。

### 5.12 Gemini CLI 启动和 active-tool Sessions 面板

继续修复“网关支持了，但入口体验像没支持”的问题：

- Node backend 新增 `launchGemini()` 和 `POST /api/gemini/launch`。
- Tauri fallback 新增 `launch_gemini()` 和 `/api/gemini/launch`。
- 前端新增 `isGeminiInstalled()` / `launchGeminiOnly()`；
  `launchActiveTool()` 对 `gemini` 不再走占位提示，而是实际启动 Gemini CLI。
- 会话恢复面板从 Codex-only 改为 active-tool aware：
  - Codex 仍走原 `/api/codex/sessions`、`/api/codex/resume`、`/api/codex/fork`，保留精确继续/分叉。
  - Claude Code、Gemini CLI、OpenCode、OpenClaw、Hermes Agent 走 `/api/sessions/inventory`
    浏览本地 sessions/history。
  - 非 Codex 工具不猜私有 resume 语法，先提供“打开项目”：把启动目录切到 session 记录的 cwd，
    再调用对应工具启动器。
  - 支持复制打开命令和 session 文件路径。
- 新增防回归覆盖：
  - 保存配置不得误启动 Gemini/Hermes。
  - Gemini 启动必须贯通 Web、Node、Tauri。
  - Sessions 面板非 Codex 时必须读取 `/api/sessions/inventory`，并显示 generic session 操作。

### 5.13 Claude Desktop 打开闭环

针对“网关支持了但 UI 没有支持”的截图反馈，本轮补上 Claude Desktop 的桌面入口：

- Node backend 新增 `launchClaudeDesktop()` 和 `POST /api/claude-desktop/launch`。
  - macOS 使用 `open -a Claude` 打开 `.app`，不依赖 `which Claude`。
  - Windows 优先使用检测到的 `Claude` binary，再 fallback 到常见 `Claude.exe` 安装路径。
  - Linux 仅在检测到 `claude-desktop` 命令时启动，否则返回明确错误。
- Tauri fallback 新增 `launch_claude_desktop()` 和同名 API route，桌面打包后不依赖 Node server 也能打开 Claude Desktop。
- 前端新增 `launchClaudeDesktopOnly()`；`launchActiveTool()` 对 `claude-desktop` 不再提示“原生启动器继续接入中”，而是实际调用 `/api/claude-desktop/launch`。
- 快速配置提示已更新为：Claude Desktop 已接入 Router profile、MCP/资产管理与桌面打开；改动后重启 Claude Desktop 生效。
- 新增防回归覆盖：
  - 保存配置不得误触发 Claude Desktop 启动。
  - Claude Desktop 启动必须贯通 Web、Node、Tauri。

边界：Claude Desktop 当前仍是安全 namespaced Router profile，不伪造未确认的官方 provider 字段；下一步需要确认 Anthropic 官方桌面端 provider/schema 后再升级为原生 writer。

### 5.14 Gemini CLI safe profile 读回和测试隔离修复

继续处理“网关支持了但 UI/体验没有支持”的截图反馈，本轮补齐 Gemini CLI 在保存后的读回闭环：

- Node backend 新增 `loadGeminiState()` 和 `GET /api/gemini/state`。
- Tauri fallback 新增 `load_gemini_state()` 和 `/api/gemini/state` route。
- 前端新增 `state.geminiState`、`loadGeminiQuickState()` 和 `renderGeminiModelOptions()`：
  - 切到 Gemini tab 时读取 `~/.gemini/settings.json`。
  - Router 一键写入后自动刷新 Gemini 当前配置摘要。
  - 当前配置卡片展示 Gemini CLI 是否安装、safe profile 是否已读取、Key 是否就绪、Base URL 和模型。
  - 表单会从 `easyaiconfig.router` 回填模型和 Base URL，API Key 只展示 masked placeholder。
- `saveConfigOnly()` / `actionProviderRouterApplyClient()` 对 Gemini 的保存链已形成：
  保存按钮 -> `/api/provider-router/apply-client` -> 写入 `easyaiconfig.router` -> `/api/gemini/state` 读回 -> UI 刷新。
- 新增 `tests/gemini-state.test.js`，验证 Gemini Router safe profile 写入后：
  - 不覆盖已有 `theme`、原始 `model` 等 Gemini 设置。
  - `easyaiconfig.router` 能保存 providerKey、model、baseUrl、apiKey。
  - `loadGeminiState()` 能返回 masked Key、activeProviderKey、model 和 safe profile。
- 修复测试隔离：Gemini/Hermes state tests 不再通过修改进程全局 `HOME` 隔离配置目录，
  改为显式传入 `configHome`，避免并发测试互相污染；该 override 默认不在生产路径启用，
  只有 `NODE_ENV=test` 或显式设置 `EASYAICONFIG_ALLOW_CONFIG_HOME_OVERRIDE=1` 时才生效。
- `tests/config-editor-save-behavior.test.js` 增加防回归覆盖：
  - Router apply 后必须刷新 `loadGeminiQuickState()`。
  - Web/Node/Tauri 必须同时暴露 `/api/gemini/state`。
  - Gemini 当前配置卡片必须显示 safe profile 读回文案，并明确“不伪造 Gemini CLI 未确认的原生 provider 字段”。

边界：Gemini CLI 当前仍是安全 namespaced Router profile + state reader + launcher，
不是官方原生 provider schema writer。下一步需要基于 Gemini CLI 官方可验证 schema
再决定是否写入原生 provider 字段。

本轮验证：

- `node --test tests/config-editor-save-behavior.test.js tests/gemini-state.test.js tests/hermes-state.test.js` 通过，40/40。
- `npm run check` 通过。
- `npm test` 通过，134/134。
- `cd src-tauri && cargo check` 通过。
- `cd src-tauri && cargo test` 通过，32/32。

### 5.15 Local Routing Gemini live request rectifier

继续处理“网关倒是支持了，但具体工具体验没支持”的问题，这轮把 Gemini 从 UI/profile
读写推进到 Local Routing live proxy 的请求侧真实转换：

- Tauri `provider_router.rs` 不再把 Gemini 默认折叠成 OpenAI-compatible target，
  `default_router_protocol_for_tool("gemini")` 返回 `gemini`。
- live proxy 新增 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages
  -> Gemini GenerateContent 请求体转换：
  - `messages` / Responses input / Anthropic content 转为 Gemini `contents`。
  - `system` 转为 Gemini `systemInstruction`。
  - `max_tokens`、`max_completion_tokens`、`max_output_tokens` 转为
    `generationConfig.maxOutputTokens`。
  - `temperature`、`top_p`、`top_k`、`stop`、JSON response format 转入
    Gemini `generationConfig`。
  - OpenAI function tools 转为 Gemini `functionDeclarations`。
- live proxy 新增 Gemini upstream path 生成：
  - 非流式：`/v1beta/models/{model}:generateContent`。
  - 流式：`/v1beta/models/{model}:streamGenerateContent?alt=sse`。
  - 当 provider base URL 已带 `/v1beta`、`/v1alpha` 或 `/v1` 时自动去重，避免拼出
    `/v1beta/v1beta/...`。
- Gemini upstream 鉴权改为 `x-goog-api-key`，不再错误使用 Bearer token。
- Node `local-routing-manager.js` 的 preview rectifier 与 Tauri live runtime 对齐，
  UI/API preview 看到的 Gemini path/body 与真实代理转发一致。
- 新增防回归测试覆盖：
  - Rust live rectifier 能把 Chat Completions 转为 Gemini GenerateContent。
  - Rust URL builder 能对 Gemini version prefix 去重。
  - Node preview 能输出 Gemini GenerateContent path 和 converted body。
  - 静态 wiring 检查确保 `chat_to_gemini_body`、`functionDeclarations`、
    `x-goog-api-key` 和 Rust Gemini rectifier test 不被删掉。

边界：这轮完成的是 Gemini 请求侧转换闭环，不等同于完整 Gemini 协议适配。
仍需要继续补 Gemini -> OpenAI/Anthropic 响应转换、SSE chunk 语义映射、
tool call/result 往返语义、错误格式归一化，以及 UI request log 中的协议转换标记。

本轮验证：

- `npm run check` 通过。
- `npm test` 通过，135/135。
- `cd src-tauri && cargo check` 通过。
- `cd src-tauri && cargo test` 通过，34/34。
- `git diff --check` 通过。

### 5.16 Local Routing Gemini non-stream response rectifier

这轮继续把 Gemini live proxy 从“能把请求发出去”推进到“调用方能按原协议读回来”：

- Tauri live proxy 新增 Gemini GenerateContent 非流式 response 回译：
  - Gemini -> OpenAI Chat Completions：生成 `chat.completion`、`choices[].message`、
    `finish_reason` 和 OpenAI usage。
  - Gemini -> OpenAI Responses：生成 `response`、`output[]`、`output_text`
    和 Responses usage。
  - Gemini -> Anthropic Messages：生成 `message`、`content[]`、`stop_reason`
    和 Anthropic usage。
- Gemini `functionCall` response 已做基础映射：
  - Chat Completions：映射到 `message.tool_calls[].function`。
  - Responses：映射到 `output[]` 的 `function_call` item。
  - Anthropic：映射到 `content[]` 的 `tool_use` block。
- Gemini `usageMetadata` 已纳入统一 token 统计：
  - `promptTokenCount` -> input/prompt tokens。
  - `candidatesTokenCount` -> output/completion tokens。
  - `totalTokenCount` -> total tokens。
  - `cachedContentTokenCount` -> cached input tokens。
- Node `local-routing-manager.js` 新增 `previewResponseRectifier()`，让控制面可预览
  Gemini response 回译结果；capabilities 标记 `responseRectifierPreview: true`。
- 新增防回归测试覆盖：
  - Node response preview 能把 Gemini text/functionCall/usage 转为 Chat Completions。
  - Rust live response rectifier 能把 Gemini 转为 Chat Completions、Responses、Anthropic。
  - 静态 wiring 检查锁住 `rectify_router_response_body`、`usageMetadata`、
    `promptTokenCount` 和 response rectifier tests。

边界：这轮只处理非流式 JSON response。Gemini SSE `streamGenerateContent` chunk
到 OpenAI/Anthropic stream event 的语义映射、Gemini error -> OpenAI/Anthropic error
归一化，以及 function result 往返仍是下一步。

本轮验证：

- `node --check src/lib/local-routing-manager.js` 通过。
- `node --test tests/local-routing-manager.test.js tests/config-editor-save-behavior.test.js`
  通过，45/45。
- `cd src-tauri && cargo check` 通过。
- `cd src-tauri && cargo test provider_router::tests::` 通过，13/13。
- `npm run check` 通过。
- `npm test` 通过，136/136。
- `cd src-tauri && cargo test` 通过，36/36。
- `git diff --check` 通过。

### 5.17 Local Routing Gemini stream SSE rectifier

继续推进 Local Routing live proxy 的协议完整性，这轮补齐 Gemini `streamGenerateContent`
返回的 SSE 事件格式映射：

- Tauri live proxy 新增 SSE parser，识别 Gemini `data: {...}` chunk，并在 target protocol
  是 `gemini`、source protocol 是调用方协议时进行 stream response 回译。
- Gemini stream -> OpenAI Chat Completions SSE：
  - 输出 `chat.completion.chunk`。
  - `parts[].text` 映射到 `choices[].delta.content`。
  - `functionCall` 映射到 `choices[].delta.tool_calls`。
  - `finishReason` 映射到 OpenAI `finish_reason`。
  - `usageMetadata` 映射到 stream chunk 的 OpenAI usage。
  - 末尾输出 `data: [DONE]`。
- Gemini stream -> OpenAI Responses SSE：
  - 文本 chunk 输出 `response.output_text.delta`。
  - function call 输出 `response.output_item.done`。
  - 结束时输出 `response.completed`，并带聚合后的 response/usage。
- Gemini stream -> Anthropic Messages SSE：
  - 输出 `message_start`、`content_block_start`、`content_block_delta`、
    `content_block_stop`、`message_delta`、`message_stop`。
  - 文本 chunk 映射为 `text_delta`。
  - function call 以 `tool_use` + `input_json_delta` 基础映射。
  - usage 保持 Anthropic 风格的 `input_tokens` / `output_tokens`。
- Node `previewResponseRectifier()` 支持字符串 SSE body，控制面可预览 Gemini stream
  -> Chat Completions SSE 的转换结果。
- 新增防回归测试覆盖：
  - Rust live runtime：Gemini stream -> Chat SSE。
  - Rust live runtime：Gemini stream -> Responses SSE 和 Anthropic SSE。
  - Node preview：Gemini stream -> Chat SSE。
  - 静态 wiring：`rectify_router_stream_response_body`、`parse_sse_json_payloads`、
    `streamGenerateContent`。

边界：当前 runtime 仍使用 `reqwest.bytes()` 先读完整 upstream body 再写回客户端；
这轮完成的是 SSE 事件格式映射，不是低延迟逐块转发。下一步仍需补真正 streaming pipe、
以及 tool result 往返深度语义。

本轮验证：

- `node --check src/lib/local-routing-manager.js` 通过。
- `node --test tests/local-routing-manager.test.js tests/config-editor-save-behavior.test.js`
  通过，46/46。
- `cd src-tauri && cargo check` 通过。
- `cd src-tauri && cargo test provider_router::tests::` 通过，15/15。
- `npm run check` 通过。
- `npm test` 通过，137/137。
- `cd src-tauri && cargo test` 通过，38/38。
- `git diff --check` 通过。

### 5.18 Local Routing Gemini upstream error normalization

本轮继续处理“网关能转发，但调用方看到的错误格式不对”的问题，把 Gemini upstream
错误响应纳入 caller protocol 归一化：

- Tauri live proxy 在 upstream 返回 `4xx/5xx` 且目标 provider 是 Gemini 时，
  会根据调用方原始协议转换错误 body：
  - OpenAI Chat Completions / OpenAI Responses 调用方收到 OpenAI 风格
    `{"error": {"message", "type", "param", "code"}}`。
  - Anthropic Messages 调用方收到 Anthropic 风格
    `{"type":"error","error":{"type","message"}}`。
  - HTTP status 保持 upstream 原值，不影响 retry、failover 和 circuit breaker
    按真实状态码判断。
- 错误类型会按 Gemini `error.status` 和 HTTP status 做基础映射：
  rate limit、auth、not found、server error 等会落到对应 OpenAI/Anthropic error type。
- Node `previewResponseRectifier()` 同步支持带 `status` 的错误响应预览，
  控制面里能提前看到 Gemini error 会如何转换给 Codex/Claude/OpenAI/Anthropic 调用方。
- 新增防回归测试覆盖：
  - Rust live runtime：Gemini upstream error -> caller protocol error。
  - Node preview：Gemini error -> OpenAI / Anthropic error body。
  - 静态 wiring：`rectify_gemini_error_body` 和默认错误文案。

边界：这轮解决的是 upstream error body 归一化，不等于完整 tool result
往返语义，也不等于低延迟 streaming pipe。Gemini 复杂 function call/result
多轮语义仍需要继续做专门适配。

本轮验证：

- `node --check src/lib/local-routing-manager.js` 通过。
- `node --test tests/local-routing-manager.test.js tests/config-editor-save-behavior.test.js`
  通过，47/47。
- `cd src-tauri && cargo check` 通过。
- `cd src-tauri && cargo test provider_router::tests::` 通过，16/16。
- `npm run check` 通过。
- `npm test` 通过，138/138。
- `cd src-tauri && cargo test` 通过，39/39。
- `git diff --check` 通过。

### 5.19 Local Routing response rectifier control-plane API

继续处理“网关能力已经有，但使用体验没有暴露”的问题，本轮把 response rectifier
从内部 preview 函数接到 Node HTTP API：

- Express 新增 `POST /api/local-routing/response-rectifier/preview`。
- API 复用 `previewResponseRectifier()`，可预览：
  - Gemini GenerateContent JSON response -> OpenAI Chat / Responses / Anthropic response。
  - Gemini streamGenerateContent SSE -> OpenAI Chat / Responses / Anthropic stream event。
  - Gemini upstream error -> OpenAI / Anthropic caller protocol error body。
- API 继续走本地 `x-local-token` 保护；浏览器通过 `/api/bootstrap` 获取一次性 token 后调用。
- 静态回归已锁住 server import 和 endpoint path，防止后续只保留内部函数。

边界：这轮是控制面 API 暴露，不是完整 Local Routing UI 可视化面板。
下一步需要把 response preview、error mapping、stream mapping 和 request log 的转换标记
接到 Provider Router/Local Routing 页面上。

本轮验证：

- `node --check src/server.js` 通过。
- `node --test tests/local-routing-manager.test.js tests/config-editor-save-behavior.test.js`
  通过，47/47。
- `npm run check` 通过。
- `npm test` 通过，138/138。
- `git diff --check` 通过。

### 5.20 Provider Router response rectifier UI + Tauri fallback

继续处理用户截图暴露的两类问题：

- Web 网关已经有 response rectifier API，但 Provider Router 页面没有入口，用户看不到也无法验证。
- 桌面 `backend_request` 未分派 `/api/local-routing/response-rectifier/preview`，会落到
  `Unsupported request: POST /api/local-routing/response-rectifier/preview`。

本轮补齐：

- Provider Router 新增 `转换预览` tab，和 `负载池 / 客户端配置 / 运行统计` 同级。
- UI 支持选择 caller protocol、upstream protocol、HTTP status、upstream path 和 response body。
- UI 内置 3 类样例：
  - Gemini upstream error -> OpenAI/Anthropic caller error body。
  - Gemini GenerateContent JSON -> OpenAI Chat response。
  - Gemini streamGenerateContent SSE -> OpenAI Chat SSE。
- `public/app.js` 调用 `POST /api/local-routing/response-rectifier/preview`，
  输出转换后的 response body，并显示 changed / changes / warnings。
- Tauri `routes.rs` 新增同一路由 fallback。
- Rust `provider_router.rs` 新增 `preview_router_response_rectifier()`，
  复用 live runtime 的 Gemini error、JSON response、SSE response rectifier。
- 静态测试锁住前端 tab、控件、Tauri route 和 Rust wrapper；Rust 单测锁住 Gemini error preview。

边界：这轮是“可见、可点、桌面可调”的控制面体验，不等于低延迟逐块 streaming pipe，
也不等于 Gemini tool result 多轮语义深度适配。每次请求是否发生转换在 5.21 已补到 request log。

本轮验证：

- `node --check public/app.js` 通过。
- `node --check src/server.js` 通过。
- `node --test tests/config-editor-save-behavior.test.js tests/local-routing-manager.test.js`
  通过，47/47。
- `cd src-tauri && cargo fmt --check` 通过。
- `cd src-tauri && cargo check` 通过。
- `cd src-tauri && cargo test provider_router::tests::` 通过，17/17。
- `npm run check` 通过。
- `npm test` 通过，138/138。
- `cd src-tauri && cargo test` 通过，40/40。
- `git diff --check` 通过。

### 5.21 Provider Router request log 转换证据

继续处理“网关支持了，但使用体验看不到”的问题，本轮把 live proxy 每次请求的
request/response/error rectifier 证据写入 Provider Router 历史日志。

本轮补齐：

- Tauri `RouterLogEntry` 新增协议与转换字段：
  `sourceProtocol`、`targetProtocol`、`requestConverted`、`responseConverted`、
  `errorNormalized`，并提供嵌套 `rectified` 对象给前端兼容读取。
- `provider_router_logs.db` 自动迁移旧库，补齐 `source_protocol`、`target_protocol`、
  `request_converted`、`response_converted`、`error_normalized` 列，不要求用户清缓存。
- `forward_once()` 返回 `ForwardOutcome`，把原始 request/upstream response 与 rectified 后结果
  做实际差异判断，再写入历史日志。
- Provider Router `运行统计 -> 历史请求日志` 现在会显示
  `openai-chat -> gemini · request converted · response converted · error normalized`
  这类转换证据。
- 日志搜索纳入协议和转换标签，可直接搜 `gemini`、`converted`、`normalized` 定位发生转换的请求。
- Rust 单测锁住 request 转换、Gemini upstream error 归一化和日志 JSON 字段；静态测试锁住前端日志展示入口。

边界：这轮解决的是“转换证据可见、可搜索、可持久化”。仍不等于完整低延迟逐块 streaming pipe，
也不等于所有 provider 专属错误码都已经做了深度语义归一化。

### 5.22 Asset Center 七工具 UI 重构 + Provider Router 工具选择可见性

继续处理截图反馈里的“页面很丑、看不出七工具支持”的体验问题，本轮把已经存在的底层能力
推到用户能直接感知的运营台界面。

本轮补齐：

- Asset Center 从“概览指标 + 大导入表单 + 表格堆叠”调整为七工具资产运营台。
- 新增 `assetToolSnapshot()`，把 Providers、MCP、Prompts、Skills、Sessions、Usage
  按 Codex、Claude Code、Claude Desktop、Gemini CLI、OpenCode、OpenClaw、Hermes Agent
  生成统一快照。
- Asset Center 第一屏新增七工具 lanes：每个工具独立显示资产类型、请求数、tokens 和 ready/empty 状态；
  原有 `asset-tool-row` 明细表保留为紧凑 ledger，避免只剩视觉卡片没有数据密度。
- 导入区域改为“导入 / 导出工作台”，textarea 与目标工具/写入策略并列显示，减少大表单压垮第一屏。
- Provider Router 负载池工具选择改成稳定的七工具 grid，按钮显示工具名、协议
  OpenAI-compatible/Anthropic、可路由 Provider 数量，并在 summary 中明确 7 个客户端入口已接入。
- 前端静态回归更新，锁住 `asset-tool-lane`、`asset-tool-summary`、`asset-import-workbench-grid`、
  `pd-router-tool-tab span strong` 和 7/4/2/1 响应式工具 grid。

边界：这轮解决的是 UI 信息架构和“支持 7 工具”的可见性，不代表所有工具专属 native
字段写入、smoke 或官方协议细节已经完全结束。

### 5.6 2026-07-05 Provider Router / Asset Center UI 修补

本轮按用户截图反馈处理“网关已支持，但页面看起来没支持”和资产中心视觉质量问题：

- Provider Router 工具 tab 不再固定 7 列硬塞，改成自适应网格；宽屏尽量一行展示 7 个客户端入口，
  中窄屏自然换行，避免 Claude Desktop / Hermes Agent 等长标签挤压。
- Provider Detail 的模型验真移除旧文案：
  “当前支持 Codex / Claude Code Provider”和“OpenCode / OpenClaw 后续单独接入”不再出现。
- 模型验真统一按七工具入口识别，但实际运行仍要求可读取明文 API Key Provider 元数据；
  只有掩码凭证或外部登录态的 Provider 会明确提示走 Provider Router 健康检查/协议转换，
  不再误导用户点击一个必然失败的模型验真。
- 系统设置“一键卸载全部”文案改成“可自动管理的 CLI 工具”，明确只覆盖
  Codex / Claude Code / OpenCode / OpenClaw；Claude Desktop / Gemini CLI / Hermes Agent
  属于手动或外部包管理安装，不在此处假装自动卸载。
- Asset Center 继续保留 7 工具资产矩阵，但把 7 列硬塞布局改成自适应工具分区：
  Codex、Claude Code、Claude Desktop、Gemini CLI、OpenCode、OpenClaw、Hermes Agent
  都作为一级资产 lane 展示 Providers/MCP/Prompts/Skills/Sessions/Usage。
- 前端静态回归补充了旧文案负断言、七工具标签断言和自适应布局断言。

边界：这轮主要解决用户可见的支持范围、页面丑和旧文案冲突。OpenCode OAuth 明文凭证读取、
Gemini/Hermes 非 Router profile 原生 provider 验真、OpenClaw 原生 provider 抽象仍需要后续后端专属适配。

### 5.8 2026-07-05 Router / Asset Center 运营台增强

本轮继续按用户截图反馈处理两个问题：页面看起来不像支持七工具、Asset Center 视觉和信息架构不够成熟。

完成项：

- Provider Router 首屏新增 `CLIENT COVERAGE` 总览：
  Claude Code、Claude Desktop、Codex、Gemini CLI、OpenCode、OpenClaw、Hermes Agent
  全部显示为客户端入口，并展示协议、写入目标、Provider source、Base URL 和可路由 provider 数。
- Router 工具定义补齐 `surface`、`writeTarget`、`routingMode` 元信息；
  页面文案明确本地网关覆盖 hot switch、format rectifier、auto failover、circuit breaker、
  health probe、request logs、one-click client write。
- Asset Center 首屏从单纯列表改成运营工作台：
  `MIGRATION`、`SYNC`、`IMPORT / EXPORT` 三个目标区块分别展示可迁移资产、同步目标、Deep Link/JSON bundle 状态。
- Asset Center 工具 lanes 继续按七工具拆分，并增加 CLI/Desktop/Gateway/Agent 运行面标签和主要资产锚点，
  避免用户误以为只有 Codex / Claude Code。
- 样式按 `shell-v2` 密集控制台风格补齐 dark/light/responsive；
  中屏和移动端避免七列硬塞、长工具名挤压、按钮/标签溢出。
- 测试新增 Router 七客户端总览、能力标签、写入目标、Asset Center 工作台和响应式样式断言。

验证：

- `node --check public/app.js`
- `node --check tests/config-editor-save-behavior.test.js`
- `npm run check`
- `node --test tests/config-editor-save-behavior.test.js`：38/38 通过
- `npm test`：138/138 通过
- `git diff --check -- public/app.js public/styles.css tests/config-editor-save-behavior.test.js docs/ccswitch-parity-goal.md`

仍未完成：

- 这轮提升的是可见控制面和工作台组织，不代表七工具所有原生 provider 字段、OAuth 明文凭证读取、
  独立 smoke 和桌面包验收已经全部完成。
- 下一步仍要补真实浏览器截图 QA、Claude Desktop/Gemini 原生字段映射、
  OpenCode/OpenClaw/Hermes 专属后端 smoke，以及 Asset Center 中 Sync/Import 的批量操作体验。

### 5.23 2026-07-05 Asset Center 首屏渐进渲染与分项容错

继续处理截图里的 Asset Center 使用体验问题：页面结构已经改成七工具运营台后，实际运行时仍会因为
`/api/assets/index`、MCP sync plan、sync targets、snapshots、session trash 任一接口慢或超时而长时间停在 loading。

完成项：

- `renderAssetCenterPage()` 不再在首次 loading 时直接返回单个 loading 框；即使资产扫描尚未完成，也先展示
  Asset Center 标题、三块运营工作台、七工具 lanes、导入/导出工作台和各数据面板。
- 新增 `asset-loading-strip`，用轻量状态条说明“先展示工作台结构，扫描完成后自动回填”，避免首屏空白。
- `loadAssetCenter()` 从整体 `Promise.all` 改成分项 `Promise.allSettled`：
  - 每个接口独立读取、独立回填、独立记录错误。
  - 一个接口失败不再阻塞其它成功数据写入 UI。
  - 刷新时保留已有数据，失败只显示对应错误，不把整个资产中心清空。
  - 用 `loadRequestId` 防止强制刷新时旧请求晚返回覆盖新请求。
- 静态回归锁住 `softLoading`、`asset-loading-strip`、`Promise.allSettled`、
  `recordFailure` 和 `loadRequestId`，防止后续又改回整页阻塞。

验证：

- `node --check public/app.js` 通过。
- `node --check tests/config-editor-save-behavior.test.js` 通过。
- `npm run check` 通过。
- `node --test tests/config-editor-save-behavior.test.js` 通过，38/38。
- `npm test` 通过，138/138。
- `git diff --check -- public/app.js public/styles.css tests/config-editor-save-behavior.test.js docs/ccswitch-parity-goal.md` 通过。
- Chrome Headless DOM QA：
  - Provider Router：`coverage: 7`、`toolTabs: 7`、`rectifierTabs: 1`、无错误。
  - Asset Center 进入 0.5 秒内：`commands: 3`、`lanes: 7`、`blockingLoaders: 0`。
  - Asset Center 最终回填：`Providers: 58`、`7 tools`、`Sessions: 43`、`Usage: 21.29B tokens`，
    loading 条消失且刷新按钮恢复。
  - 截图保存在 `/tmp/easyaiconfig-provider-router-qa.png`、
    `/tmp/easyaiconfig-asset-center-early-qa.png`、
    `/tmp/easyaiconfig-asset-center-later-qa.png`。

### 5.24 2026-07-05 Deep Link V1 query 兼容

继续补齐传播能力：之前 Asset Center 能生成/预览 `payload` 型 Deep Link，但对 cc-switch V1
query 参数分享格式还会报 `Deep Link is missing payload`，导致 provider/MCP/prompt/skill 分享链接无法进入导入预览。

完成项：

- Node 侧 `parseAssetImportText()` 新增 `ccswitch://v1/import?resource=...` 兼容分支。
- 支持把以下资源统一转换成 `easyaiconfig.asset-bundle.v1`，复用现有 `/api/assets/import/preview`
  和 `/api/assets/import/apply` 链路：
  - `resource=provider`：识别 `id/key/name/baseUrl/base_url/url/endpoint/envKey/env_key/apiKeyEnv/apiKey/wireApi/wire_api/protocol/protocols/homepage/model/models/config/configFormat/configUrl/usageScript/tools`。
  - `resource=mcp`：识别 `id/serverId/name/command/cmd/args/env/transport/type/url/apps/config/enabled/tools`。
  - `resource=prompt`：识别 `id/promptId/tool/fileName/scope/title/description/content/text/body/prompt/markdown/enabled/tools`。
  - `resource=skill`：识别 `id/name/slug/title/content/text/markdown/skillMd/installMode/repositoryUrl/repoUrl/repo/repository/directory/branch/zipUrl/tools`。
- 保留旧兼容：`ccswitch://import?payload=...` 仍按 payload Deep Link 解析，不会被 V1 query 分支误拦截。
- Tauri fallback 的 `/api/assets/import/preview` 同步支持 V1 query，桌面端不再只接受 `payload/data`。
- 所有 Deep Link 仍默认 preview，不在解析阶段直接 apply；桌面 fallback apply 仍是 no-write plan。
- 新增 Node 单测覆盖 provider/MCP/prompt/skill 四类 V1 query 链接、扩展字段透传，并验证 provider 能进入现有导入规范化。
- 新增 Tauri 单测覆盖桌面 preview counts、转换后的 payload source 和关键扩展字段。

验证：

- `node --check src/lib/provider-catalog.js` 通过。
- `node --check tests/provider-catalog.test.js` 通过。
- `node --check tests/config-editor-save-behavior.test.js` 通过。
- `node --test tests/provider-catalog.test.js` 通过，9/9。
- `node --test tests/config-editor-save-behavior.test.js` 通过，38/38。
- `cargo test tauri_asset_import_preview_accepts_ccswitch_v1_query_links --lib` 通过。
- `npm run check` 通过。
- `npm test` 通过，139/139。
- `cargo check` 通过。
- `cargo test --lib` 通过，42/42。
- `git diff --check -- src/lib/provider-catalog.js src-tauri/src/routes.rs tests/provider-catalog.test.js tests/config-editor-save-behavior.test.js docs/ccswitch-parity-goal.md` 通过。

仍未完成：

- OS 级 protocol registration、桌面 app 被外部 `ccswitch://...` 唤起后的端到端流程还没验收。
- 扩展字段目前已进入 preview payload；UI diff、字段级冲突展示、direct `apiKey` 安全写入策略、
  GitHub/ZIP/仓库 installer 和真实 write-back 仍需继续补。

### 5.25 2026-07-05 Asset Center 工作台重排 + 桌面 Deep Link 入口

继续处理用户截图反馈：“资产中心”页面视觉不符合主题、七工具支持不够直观，以及 Deep Link
已有解析但缺桌面外部唤起入口。

完成项：

- Asset Center 首屏从“统计条 + 三张卡 + 七工具散卡片”重排为左右工作台：
  - 左侧是七工具资产地图，按 `CLI Workspaces`、`Desktop MCP`、`Gateway / Agents` 三组展示。
  - 右侧是 Migration / Sync / Import 状态和 Protocol Intake 状态。
  - 顶部去掉“集中查看可迁移资产...”这类临时说明文案，改成短状态标签。
- 七工具仍全部是一级资产对象：Codex、Claude Code、Claude Desktop、Gemini CLI、OpenCode、
  OpenClaw、Hermes Agent，分别显示 Providers/MCP/Prompts/Skills/Sessions/Usage、tokens 和 requests。
- 新增 Protocol Intake 面板，直接展示 `easyai://`、`easyaiconfig://`、`ccswitch://`
  三类 scheme，以及最近一次收到的 Deep Link。
- 前端新增 `installAssetDeepLinkListener()` 和 `handleAssetDeepLinkOpened()`：
  - 监听 Rust 转发的 `asset-deep-link-opened`。
  - 兼容 Tauri 插件原始 `deep-link://new-url` 事件。
  - 收到链接后自动切到 Asset Center、填入导入框并运行 `/api/assets/import/preview` + dry-run。
  - 仍不绕过“确认写入本机配置”的勾选保护。
- Tauri 桌面新增 `tauri-plugin-deep-link = "2.4.9"`。
- `tauri.conf.json` 新增 desktop schemes：`easyai`、`easyaiconfig`、`ccswitch`。
- `src-tauri/src/lib.rs` 安装 `tauri_plugin_deep_link::init()`，并处理：
  - 冷启动 `get_current()` URL。
  - 运行中 `on_open_url()` URL。
  - Windows/Linux `register_all()` 辅助注册。
- 静态回归锁住新 UI 分组、Protocol Intake、前端 listener、Tauri scheme 配置和 Rust event 发射。

边界：

- 本轮完成代码层面的桌面 Deep Link 入口和 cargo 级验证；macOS/Windows/Linux 的真实外部协议唤起
  仍需要安装包或 dev 注册环境逐平台手工验收。
- 桌面 fallback apply 仍保持 no-write plan；真实 write-back、字段级 UI diff 和 installer/update 管理继续列入后续。

## 6. 下一阶段工程优先级

### P0：把 Local Routing 做成真实闭环

目标：不是只 preview，而是 live request 真的走统一策略。

- 将 Node `buildLocalRoutingPlan` 的策略输出接入 Tauri `provider_router.rs`。
- Tauri router 已完成 7 个工具枚举、route key、probe/auth 协议分支；Router 客户端已支持 7 工具写入。
  下一步是给 Claude Desktop/Gemini 补官方原生字段映射，并给 OpenCode/OpenClaw/Hermes 补真实 smoke。
- live proxy 已接入 Responses <-> Chat、Chat <-> Anthropic、Anthropic <-> Responses，
  并新增 OpenAI/Anthropic -> Gemini GenerateContent 请求侧转换、Gemini 非流式响应回译
  Gemini SSE 事件格式映射和 Gemini upstream error 归一化；下一步补低延迟逐块转发、
  tool result 深度转换和 request log 转换标记。
- Circuit breaker runtime 已完成基础闭环；下一步补 UI 阈值控制、主动 health probe 驱动、
  持久化/恢复策略和更细错误分类。
- health monitoring 独立调度：主动 probe、延迟、错误分类、provider status cache。
- request logs 统一脱敏，避免 token/key 写入 SQLite 或 UI。

### P1：补齐统一运营 UI

目标：让用户能在一个工作台里完成配置、诊断、导入和恢复。

- Provider Catalog 页面：58+ presets 搜索、按 tool/protocol/region/tag 筛选，一键生成安全 draft。
- Local Routing 页面：route plan、health、circuit、failover queue、request/response rectifier preview、
  request logs、balance guard。
- MCP 页面：跨工具 inventory、冲突 diff、双向 sync preview/apply。
- Prompts 页面：全局/项目 scope、CLAUDE/AGENTS/GEMINI 文件状态、回填保护、备份恢复。
- Skills 页面：GitHub/ZIP/custom repository、copy/symlink、update、remove、restore。
- Sessions 页面：provider -> project 分组、搜索、恢复、删除、导出、批量操作。
- Usage 页面：request log、session log、趋势图、provider/model rollup、自定义价格。

### P2：把资产导入从 bundle 扩展到 cc-switch V1 协议

目标：真正吃下 cc-switch 的分享链接和迁移材料。

- 已支持 `ccswitch://v1/import?resource=provider|mcp|prompt|skill...` 基础参数格式、扩展字段 preview payload 和 Tauri 桌面事件转发；下一步做逐平台外部唤起验收。
- provider 已支持 endpoint/apiKey/homepage/model/config/configFormat/configUrl/usageScript 等字段进入 preview payload；下一步补字段级 UI diff 和安全写入策略。
- MCP 已支持 apps/config/enabled 进入 preview payload；下一步补跨 app diff 和真实双向 apply。
- Prompt 已支持 content/description/enabled 进入 preview payload；下一步补启用状态 UI 和回填策略。
- Skill 已支持 repo/directory/branch 进入 preview payload；下一步补 GitHub/ZIP/custom repository installer。
- 所有 Deep Link 默认只 preview，不直接 apply。

### P3：生产级 Skills 和 Sync

目标：解决长期使用和多机器迁移。

- GitHub repository scanner：branch/subdirectory、hash manifest、update detection。
- ZIP downloader：下载、解压、路径穿越防护、hash。
- batch update、backup restore、remove with backup。
- local encrypted profile export/import：密钥派生、版本 schema、敏感信息选择性包含。
- directory sync 增强：snapshot 历史 UI、冲突合并、删除同步、敏感信息选择性同步。
- WebDAV push/pull：认证、冲突检测、dry-run、备份。

### P4：桌面成熟度和发布质量

目标：不只是网页能跑，而是桌面产品可信。

- Tauri updater 配置、签名、latest.json 校验。
- tray：按 app/provider 分组、当前 provider 标识、快速切换。
- theme/i18n：中文/英文最小闭环，新增 UI 不出现裸 key。
- 多平台包 smoke：macOS、Windows、Linux 基础启动、协议注册、权限路径、代理端口。
- Browser/UI 自动化：Asset Import、Local Routing、Provider Catalog、Usage 的关键路径截图和交互检查。

## 7. 完成判定

这个长期目标目前不能标记完成。完成必须逐条满足：

- 7 个工具都有 discovery/state reader/write/smoke。
- 50+ provider 不仅在 catalog 中存在，还能进入 UI draft 并写入目标工具配置。
- Local Routing live proxy 覆盖协议转换、failover、circuit breaker、health、logs。
- MCP/Prompts/Skills/Sessions/Usage/Sync/Deep Link 都有 UI、API、测试和备份策略。
- 桌面 updater/tray/i18n/package smoke 通过。
- 导入/同步/删除类危险操作都有 preview、confirm、backup、rollback 或恢复路径。

当前真实结论：EasyAIConfig 已经从基础配置工具推进到“资产层 + 控制面 + 部分运行时”的阶段，
但距离完整 cc-switch parity 仍有明显工程缺口。下一步应优先把 Local Routing live 闭环和统一运营 UI 做完，
因为这两项决定用户是否真的感知到“超越配置编辑器”的产品能力。
