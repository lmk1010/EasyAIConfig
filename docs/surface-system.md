# Neox Surface 系统

Surface 是 Neox 的右侧画布面板，用于实时展示 AI 产出的可视化内容。

## 支持的类型

| Kind | 用途 | 示例 |
|------|------|------|
| `doc` | Markdown 文档 | 设计文档、README |
| `diagram` | Mermaid 图表 | 架构图、流程图、时序图 |
| `image` | 图片查看 | 截图、生成的图片 |
| `html` | HTML 页面 | 设计稿、交互原型 |
| `svg` | 矢量图形 | 图标、图表 |
| `web` | 嵌入式浏览器 | Dev server 预览 |

## 数据源

每个 Surface 通过 `source` 指定内容来源：

- **file** — 关联磁盘文件，文件变更时自动刷新
- **inline** — 直接传入内容（适合 mermaid 源码等）
- **url** — 指向一个 URL（适合 dev server）

## 核心 API

```
open_surface({ kind, source, title?, pinned? })  → 打开新面板
update_surface({ surface_id, patch })            → 更新已有面板
close_surface({ surface_id })                    → 关闭面板
```

## 使用原则

- AI 产出可视化内容时**主动推送**，不等用户要求
- 源码、配置、测试等非可视文件**不推送**
- 同类产出已打开时用 `update_surface` 替换，避免重复开
- `source.type = "file"` 时文件修改会自动刷新，无需手动 update
- `pinned: true` 可固定面板，新面板不会替换它

## 典型场景

1. 写完 README → `open_surface({ kind: "doc", source: { type: "file", path: "README.md" } })`
2. 画架构图 → `open_surface({ kind: "diagram", source: { type: "inline", content: "graph TD; ..." } })`
3. 启动 dev server → 确认 ready 后 `open_surface({ kind: "web", source: { type: "url", url: "http://localhost:3000" } })`
