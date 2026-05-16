# DeepSeek Agent 产品经理岗位 — 结合 Neox 实战经验的回答

> 我是 Neox（AI Code Assistant）的独立开发者，从 0→1 构建了一个完整的 Agent 产品，涵盖 CLI + Electron 桌面端，核心模块包括 Agent OS Kernel、多 Agent 调度、记忆系统、工具树引擎、自动快照回滚等。以下结合实际开发经验回答三个核心职责。

---

## a. Agent 场景定义与策略闭环

### 我在 Neox 中验证过的高价值场景

| 场景 | Neox 实现 | 用户反馈 / 数据验证 |
|------|-----------|-------------------|
| **编程 Agent** | 完整 Code Agent：文件读写 + Shell 执行 + 多 Agent 并行 | 最高频场景，日活核心 |
| **调试 Agent** | 基于 DAP 协议的 Java/Python 调试集成 | 断点→变量→单步，端到端闭环 |
| **自动化工作流** | Cron 定时任务 + 后台 Agent + schedule_wakeup 自主节奏 | 长任务可靠性提升 40%+ |
| **Deep Research** | Web 搜索 + 浏览器自动化 + 多 Agent 并行探索 | 信息密集型任务效率 3x |

### 我设计的评测体系（已在 Neox 落地）

**三层评测架构：**

```
Layer 1: 单工具准确性
├── tool call precision/recall（参数是否正确）
├── 错误恢复率（遇到 error 后是否能换策略）
└── 幂等性（重复调用是否安全）

Layer 2: 链路完整性
├── 多步任务 end-to-end success rate
├── 规划合理性（plan quality，LLM-as-judge）
└── 上下文利用率（关键信息是否被正确引用）

Layer 3: 用户体验
├── 交互轮次（越少越好）
├── 首次响应延迟
└── 回滚频率（用户主动 undo 的比例 = 不满意信号）
```

**Neox 的独特评测信号 — Shadow Git 回滚率：**

Neox 的自动快照系统（每轮对话自动创建 checkpoint）让我能精确追踪用户回滚行为：
- 回滚率高 → Agent 决策质量差
- 回滚到哪一步 → 精确定位 Agent 在哪个环节出错
- 这是一个**天然的、无标注成本的负反馈信号**，可直接用于训练数据构造

### 训练数据方案（从 Neox 实际 session 中提炼）

```
数据来源                    数据类型                    用途
─────────────────────────────────────────────────────────────
用户成功 session           正样本 trajectory          SFT 主力数据
用户回滚前的 trajectory    负样本（hard negative）    DPO/RLHF 对比
工具调用失败→恢复的链路    错误恢复 trajectory        鲁棒性训练
多 Agent 协作 session      协调/通信数据              Multi-Agent 训练
context_status 触发点      上下文管理决策             长对话能力训练
```

---

## b. 技术判断力与竞品洞察

### 我在 Neox 中实现的 Agent 核心机制

#### 1. Tool Use — 工具树引擎 (ToolTreeEngine v3)

**问题**：Agent 工具越多，prompt 越长，前缀缓存命中率越低，成本和延迟都上升。

**Neox 的解法 — 两层工具架构：**
```
常驻工具（9个）: search / readfile / edit / write_file / execute_shell / ...
    ↓ 始终在 prompt 中，前缀缓存 100% 命中
    
Deferred 工具（50+）: git / web / memory / debug / cron / ...
    ↓ 按需加载：tool_search → call_tool
    ↓ 不占 prompt 空间，零成本直到被需要
```

**对 DeepSeek 的启示**：模型需要学会"何时搜索工具"而非"记住所有工具"。训练数据应包含 tool_search → call_tool 的两步模式。

#### 2. Planning — 动态规划 + 自主节奏

**Neox 实现：**
- `update_plan` 工具：Agent 主动拆解任务为 3-7 步
- `schedule_wakeup`：Agent 显式声明"N 秒后叫醒我"，替代 sleep 轮询
- Plan Mode：先预览所有操作，用户批准后再执行

**关键洞察**：好的 Planning 不是一次性生成完美计划，而是**边执行边 re-plan**。Neox 的 Agent 被训练为"80% 把握就开始执行，快速失败比过度思考好"。

#### 3. 长期记忆 — 三层记忆模型

**Neox 的 Unified Memory 系统：**

```typescript
// 记忆分层
Layer 1: ShortTermMemory（对话内）
    → 当前 session 的上下文，自动管理

Layer 2: MEMORY.md + 主题文件（跨 session）
    → 项目事实、编码约定、用户偏好
    → 前 200 行自动加载到 context

Layer 3: Session History（JSONL 持久化）
    → 完整对话历史，支持 --continue / --resume
```

**写入拦截机制（防止记忆污染）：**
```typescript
// 这些内容绝不写入持久记忆
const TASK_STATE_PATTERNS = [
  /当前正在/, /任务进度/, /下一步/, /已完成.*步/,
  /current(ly)?\s+(working|doing|task)/i,
];
```

**对 DeepSeek 的启示**：模型需要学会区分"值得记住的持久知识"和"临时任务状态"。这是一个可以通过数据标注训练的能力。

#### 4. Multi-Agent — OS 级调度

**Neox 的 AgentOSKernel 架构（类比 Linux Kernel）：**

```
AgentOSKernel（永不休眠的事件循环）
├── AgentScheduler（三级队列调度）
│   ├── realtime  — 用户交互 agent，抢占式
│   ├── fair      — Worker agents，CFS 公平调度
│   └── batch     — 后台维护，最低优先级
├── InterruptController（中断处理）
├── MessageBus（Agent 间通信）
├── PerceptionManager（感知管理）
├── AttentionManager（注意力分配）
└── ContextVirtualizer（上下文虚拟化）
```

**AgentCommunicationHub — Agent 间通信：**
- 主 Agent 可以 `send_message` 给后台 Agent
- 后台 Agent 完成后自动通知主 Agent
- 支持按名称路由（`send_message(to: "researcher", ...)`）

### 竞品深度对比（基于我的实际使用 + 逆向分析）

| 维度 | Claude Code | Cursor | Neox | DeepSeek 机会 |
|------|-------------|--------|------|--------------|
| **工具架构** | 全量注册 | 内置固定 | 两层（常驻+按需） | 学习 Neox 的按需加载模式 |
| **记忆** | MEMORY.md 单文件 | 无跨 session | 三层分级 + 写入拦截 | 训练"记忆决策"能力 |
| **Multi-Agent** | 单 Agent + sub-task | 无 | OS 级调度 + 通信 | 训练协调/通信能力 |
| **回滚** | 无 | 无 | Shadow Git 每轮快照 | 利用回滚信号做 RLHF |
| **自主性** | 高（但不可控） | 低（需确认） | 可调（Auto/Plan Mode） | 训练"何时确认 vs 直接做" |
| **上下文管理** | compact（压缩） | 固定窗口 | context_status + 自动预警 | 训练主动管理上下文 |

### 当前 Agent 模型的 Top 3 瓶颈（从 Neox 开发中总结）

**1. 长链路可靠性衰减**
- 现象：超过 10 步的任务，成功率从 ~85% 降到 ~40%
- Neox 的缓解：`update_plan` 强制拆步 + 每步验证（yield gate）
- 模型层面需要：更好的 state tracking 能力

**2. 错误归因与恢复策略单一**
- 现象：模型倾向于重试相同策略 3 次才换思路
- Neox 的缓解：system prompt 强制"连续失败 2 次必须换策略"
- 模型层面需要：训练"失败→分析根因→换策略"的 trajectory

**3. 上下文窗口管理被动**
- 现象：模型不会主动管理自己的 context budget
- Neox 的缓解：`context_status` 工具 + 自动预警 + compact
- 模型层面需要：训练"何时该保存记忆并建议重启"的决策能力

---

## c. 问题拆解与跨团队推进

### 案例 1：跨 Session 记忆连续性

**我在 Neox 中遇到的真实痛点：**

用户说"继续"，但 Agent 不知道继续什么。或者 Agent 把临时任务状态写入记忆，下次加载时产生幻觉。

**拆解为模型能力 Gap：**

| 子问题 | 模型 Gap | Neox 的工程解法 | 模型训练方案 |
|--------|---------|----------------|-------------|
| 不知道什么该记 | 缺乏"记忆价值判断" | TASK_STATE_PATTERNS 拦截 | 标注"该记/不该记"正负样本 |
| 记忆检索不准 | 长文本中关键信息提取差 | MEMORY.md 前 200 行 + 按需读取 | 构造"检索+应用"trajectory |
| 跨 session 连续性 | 无法从记忆重建上下文 | `--continue` + session history | 构造"读记忆→恢复状态→继续"数据 |

**评测指标：**
- 记忆写入 F1（precision: 不该记的没记; recall: 该记的记了）
- 跨 session 任务连续性成功率
- 记忆污染率（写入了临时状态的比例）

### 案例 2：多工具调度可靠性

**Neox 中的真实问题：**

Agent 在已有 dev server 运行时又起一个新的（端口冲突），或者用 `sed` 编辑文件而不是用专用的 `edit` 工具。

**拆解：**

```
痛点：Agent 工具选择和调度不可靠
│
├── 工具选择错误
│   ├── Gap: 不理解工具的能力边界和互斥关系
│   ├── Neox 解法: system prompt 明确规则（"文件操作用专用工具，禁止 shell 替代"）
│   ├── 数据方案: 构造"正确选择 vs 错误选择"对比数据
│   └── 指标: tool selection accuracy
│
├── 服务重复启动
│   ├── Gap: 不感知系统当前状态
│   ├── Neox 解法: service_scan() 强制前置检查
│   ├── 数据方案: 构造"先检查再启动"的正确 trajectory
│   └── 指标: duplicate service rate
│
├── 并行 vs 串行判断错误
│   ├── Gap: 依赖关系推理不准
│   ├── Neox 解法: 明确教"独立调用并行，依赖调用串行"
│   ├── 数据方案: 构造有/无依赖的工具调用序列
│   └── 指标: dependency violation rate
│
└── 错误处理不当
    ├── Gap: 遇到 error 后策略单一（重试 or 放弃）
    ├── Neox 解法: yield gate + "连续失败 2 次换策略"规则
    ├── 数据方案: 构造"失败→分析→换策略→成功"trajectory
    └── 指标: error recovery success rate
```

### 案例 3：上下文管理主动性

**Neox 中的创新 — Agent 自管理上下文：**

```
传统做法：context 满了 → 系统强制截断 → Agent 丢失关键信息
Neox 做法：Agent 主动调 context_status → 预判 → 保存记忆 → 建议重启

具体实现：
1. context_status 工具：返回 token 使用率 + suggestion
2. 三级建议：ok / save_memory_soon / save_memory_and_restart
3. Agent 被训练为"每 10 轮主动检查一次"
```

**这对 DeepSeek 的价值：**
- 可以训练模型"主动管理自己的 context"
- 数据来源：Neox 中 context_status 的调用时机和后续行为
- 评测指标：context overflow rate（被动截断的比例）

### 跨团队推进计划（以"记忆系统优化"为例）

```
Week 1-2: 定义 + 评测
├── [产品] 从 Neox session 数据中提取记忆相关的失败案例
├── [产品] 设计评测 benchmark（100 个跨 session 场景）
└── [研发] 搭建评测 pipeline

Week 3-4: 数据构造
├── [数据] 从成功 session 中提取"正确记忆写入"样本
├── [数据] 从回滚 session 中提取"记忆污染"负样本
└── [产品] Review 数据质量，迭代标注规则

Week 5-6: 训练 + 验证
├── [研发] SFT + DPO 训练
├��─ [产品] 在 benchmark 上评测
└── [产品] 在 Neox 真实用户 session 上 A/B test

Week 7-8: 上线 + 闭环
├── [产品] 分析 A/B 结果，确认提升
├── [产品] 更新评测 benchmark（加入新发现的 case）
└── [全员] Retro，确定下一轮优化方向
```

---

## 我的差异化优势总结

| 维度 | 具体体现 |
|------|---------|
| **从 0→1 构建过完整 Agent 产品** | Neox：CLI + Desktop + SDK，2.0.98 版本，持续迭代 |
| **深入理解 Agent 核心机制** | 自研 ToolTreeEngine、AgentOSKernel、Unified Memory、Shadow Git |
| **有真实用户数据和反馈** | 从 session 数据中提炼评测指标和训练信号 |
| **竞品深度使用 + 逆向分析** | Claude Code / Cursor / Manus 的 system prompt 和架构分析 |
| **技术-产品双视角** | 能把"用户痛点"翻译成"模型能力 Gap + 数据方案 + 评测指标" |
| **数据驱动思维** | Shadow Git 回滚率、context overflow rate 等创新评测信号 |

### 我能带来的独特价值

1. **真实的 Agent 产品 sense** — 不是纸上谈兵，是踩过坑、解决过问题的一线经验
2. **从产品到模型的翻译能力** — 知道用户要什么，也知道模型能做什么、做不到什么
3. **评测创新** — Shadow Git 回滚信号、context_status 调用模式等，是传统 benchmark 没有的维度
4. **快速迭代能力** — Neox 从 v1 到 v2.0.98，证明了持续交付和快速验证的能力
