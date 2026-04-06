# Ch00 Course Overview - Presentation Script (逐字稿)
## ⏱️ Total Duration: ~30 minutes | 📑 16 Slides | 📝 ~5,000 words

### Core Source Files Referenced
* The entire `src/` codebase — 512,694 LOC across 3,776 files
* All 10 chapters (Ch01-Ch10) are mapped to their corresponding source directories
* Cross-cutting concerns span multiple chapters: feature flags, permissions, prompt caching, streaming

---

### [00:00] Opening (Slide 01: Codebase Coverage)

欢迎来到 Claude Code 源码深度拆解系列课程。

这个项目的源码总规模是 512,694 行 TypeScript/TSX 代码，分布在 3,776 个文件中。10 个章节覆盖了其中 76,364 行核心代码，约占 14.9%。

每一章对应一个架构区域，每个区域有明确的边界。Ch1 Core Engine 是最薄但被引用最广的区域——3,536 行代码，15 个直接 import。Ch9 Ink UI 是最大的区域——14,444 行代码，292 个组件文件，但架构上相对孤立。

接下来的 60 分钟，我们从架构地图出发，逐层拆解每一个区域。

---

### [02:00] Slide 02: 学习目标

学完本课程后你需要做到：

1. 将 10 个章节映射到对应源码目录，并量化每章在 51.2 万行中的 LOC 覆盖比
2. 识别 6 个主要横切关注点——特性门控、权限模式、prompt 缓存、流式处理、DCE、JSONL 持久化——并在架构图中定位
3. 追踪 4 条端到端数据流——Bash 执行、Read/Edit、多 Agent fork、上下文溢出恢复
4. 列出 LOC 排名前 10 的文件并解释各自的架构意义

前置知识：基本的 TypeScript 和 CLI 工具使用经验。无需提前了解代码库。

---

### [04:00] Slide 03: 章节依赖关系图

这张图展示了每个章节的核心模块如何相互引用。

Ch1 Core Engine 是整个系统的中枢——`queryLoop()` 驱动推理循环，`QueryEngine` 管理会话状态。几乎所有其他章节都间接依赖它。

Ch2 Multi-Agent 的 `runAgent()` 和 `forkSubagent()` 构建了子 Agent 执行框架。Ch3 Permission 的 `hasPermissionsToUseTool()` 被 43 个模块引用，是全系统最大的安全表面积。

Ch5 Tools+MCP 和 Ch8 Protocol 是两大独立子系统，各有自己的依赖链。Ch9 Ink UI 是 UI 层，架构上相对独立。

---

### [06:00] Slide 04: 章节权重矩阵

多维度加权评分矩阵，综合权重 = LOC(25%) + 文件数(15%) + 架构中心度(25%) + 跨章被引用(20%) + 复杂度密度(15%)。

关键发现：

**最高架构中心度** — Ch1 Core Engine：LOC 最小（3,536）但被 15 个模块直接 import，`query.ts` 的 17 种 transition reason 驱动整个系统。

**最大安全表面积** — Ch3 Permission：43 处被引用（全系统最高），`bashPermissions.ts` 单文件 2,621 行，`TRANSCRIPT_CLASSIFIER` feature gate 出现 107 次。

**最大 LOC vs 最低权重** — Ch9 Ink UI：14,444 LOC + 292 文件（最多），但架构孤立——仅被 Ch1/Ch8 引用，不影响核心 Agent 逻辑。

最高 feature gate 调用次数在 Ch10（960 次）和 Ch3（107+45）。

---

### [09:00] Slide 05: 架构地图

4 层架构图：

**基础层（Foundation）** — 工具函数、配置、常量。`src/utils/` 59,037 行，`src/constants/` 2,648 行。最稳定的层。

**核心引擎层（Core Engine）** — `QueryEngine.ts`、`query.ts`、`stopHooks.ts`、`tokenBudget.ts`。整个系统的决策中枢。

**工具编排层（Tool Orchestration）** — 40+ 内置工具 + MCP 服务器连接。`src/tools/` 50,835 行。

**传输层+UI（Transport + UI）** — Bridge 协议（V1 REST / V2 SSE）+ REPL 终端界面。`src/bridge/` 12,613 行 + `src/components/REPL.tsx` 5,005 行。

---

### [11:00] Slide 06: LOC 比例树状图

面积 proportional 树状图直观展示每章的代码量占比。

最大的章节是 Ch9 Ink UI（14,444 LOC），最小的是 Ch7 Memory（1,848 LOC）。平均每章 7,636 LOC。

剩余 436,330 行主要是基础设施代码——生成代码、类型定义、node_modules 类型、测试脚手架等。

---

### [13:00] Slide 07: 调用流程总览

接下来 4 张幻灯片 (Slide 08-11)追踪 4 条典型的用户请求路径。

每条路径从用户输入开始，经过 QueryEngine 的 `submitMessage()`、`query()` 的推理循环、工具执行、最后返回结果。

4 条路径覆盖了 90% 以上的日常使用场景：
1. Bash 命令行执行
2. Read/Edit 文件读写
3. 多 Agent 任务分发
4. 上下文溢出恢复

---

### [15:00] Slide 08: Bash 执行流程

用户输入 `git status` 或 `npm install`：

1. **QueryEngine.submitMessage()** — 用户 prompt 被包装为 `SDKMessage` 进入推理循环
2. **queryLoop()** — 模型采样，决定调用 `bash` 工具
3. **hasPermissionsToUseTool()** — 权限检查。如果权限模式是 `autoApprove`，直接执行；如果是 `interactive`，等待用户确认
4. **runToolUse()** — Bash 工具执行。`BashTool` 创建子进程，设置超时
5. **Stream output** — 标准输出/错误通过 `SubprocessOutput` 流式返回
6. **handleStopHooks()** — Bash 执行完成后，stop hooks 提取记忆、检查未完成任务

全程涉及 `src/query.ts` 的流式推理 + `src/tools/bashTool.ts` 的权限检查 + `src/utils/subprocess.ts` 的进程管理。

---

### [17:00] Slide 09: Read/Edit 流程

用户要求「修复 src/utils.ts 中的 bug」：

1. **queryLoop()** — 模型决定调用 `Read` 工具
2. **Read** — 读取文件内容到上下文
3. **queryLoop()** — 模型决定调用 `Edit` 工具
4. **applyEdit()** — 通过 `fs.writeFile()` + `diff` 计算写入位置
5. **readFileState cache** — 文件状态缓存检测外部修改
6. **继续 queryLoop()** — 模型确认修改完成，继续对话

`Search` 工具通过 `ripgrep` 实现，用于文件内容检索。Edit 的原子性由 `FileStateCache` 保证——写入前后检测文件修改时间和哈希值。

---

### [19:00] Slide 10: 多 Agent 流程

用户输入「帮我分析这个项目的性能瓶颈」：

1. **QueryEngine.submitMessage()** — 解析用户请求
2. **runAgent()** — 主 Agent 决定创建子 Agent
3. **forkSubagent()** — 构建 fork 后的消息历史（`buildForkedMessages()`），子 Agent 获得独立上下文
4. **buildAndPushState()** — 子 Agent 将分析结果 push 回主 Agent（`PushStateEvent`）
5. **主 Agent 合并** — 主 Agent 接收结果，继续推理
6. **return 结果** — 最终返回用户

子 Agent 之间互不干扰，各自有独立的 `QueryEngine` 实例、工具池和消息历史。`src/multi-agent/` 目录下 19 个文件实现整个隔离框架。

---

### [21:00] Slide 11: 上下文溢出恢复

对话累积到 token 预算上限时触发：

1. **checkTokenBudget()** — 每轮迭代检查当前 token 用量
2. **compactConversation()** — 触发压缩。`src/services/compact/autoCompact.ts` 负责
3. **microCompact()** — 增量压缩部分对话（适用于超长工具调用场景）
4. **post-compact rebuild** — 压缩后重建消息历史
5. **继续 queryLoop()** — 压缩后的历史注入回循环

压缩策略不是简单的"删除旧消息"——它通过 LLM 本身生成摘要，保留关键工具调用信息和决策点。`src/services/compact/` 目录下 7 个文件、5,528 行代码实现整个压缩系统。

4 种压缩模式 + 多个阈值常量（`MAX_TOKENS_WARNING_THRESHOLD`、`COMPACT_TARGET_PERCENT` 等）。

---

### [23:00] Slide 12: 前 10 大文件

按 LOC 排名的前 10 大文件及其架构意义：

1. **`REPL.tsx`** (5,005L) — 终端主界面组件，5000 行的单体组件管理输入、输出、动画、状态。React 组件的最大实例。
2. **`sessionStorage.ts`** (5,105L) — 会话持久化层，JSONL 格式存储所有消息历史。`src/session/sessionStorage.ts`。
3. **`cli/print.ts`** (5,594L) — CLI 输出格式化，最大单一文件。
4. **`bashPermissions.ts`** (2,621L) — Bash 工具权限检查器。
5. **`bridgeMain.ts`** (2,999L) — Bridge 协议主入口。
6. **`config.ts`** (1,817L) — Feature gate 配置中心。
7. **`compact.ts`** (1,705L) — 自动压缩引擎。
8. **`query.ts`** (1,729L) — 推理循环核心。
9. **`toolExecution.ts`** (1,745L) — 工具执行管线。
10. **`AgentTool.tsx`** (1,397L) — 子 Agent 创建工具。

---

### [26:00] Slide 13: 常量与参考

代码库中 89 个唯一 feature gate 标识符，960 处 `feature()` 调用。

核心常量分布在：
- `src/constants/` — 2,648 行，26 个文件
- 各模块内部常量 — 如 retry 常量、token 阈值、压缩配置等

关键常量：
- `MAX_TOKENS_WARNING_THRESHOLD` — Token 告警阈值
- `COMPACT_TARGET_PERCENT` — 压缩目标比例
- `SAFE_YOLO` — 安全自动批准列表，25+ 条目
- `SPAWN_TIMEOUT = 32` — Bridge 进程超时
- `MAX_LINES = 200` — 记忆提取最大行数

术语表见 Slide 14，延伸阅读见 Slide 15。

---

### [27:00] Slide 14 & 15: 术语表 & 延伸阅读

关键术语：
- **QueryEngine** — 会话生命周期管理器
- **queryLoop** — 推理→工具→继续的迭代循环
- **AsyncGenerator** — 核心控制流原语
- **Feature Gate** — 运行时特性开关（`feature()` 函数调用）
- **JSONL** — JSON Lines，会话持久化格式
- **DCE** — Dead Code Elimination
- **BoundedUUIDSet** — 有限 UUID 集合，用于协议层去重

延伸阅读：
- Ch01: 核心引擎实现细节（`src/QueryEngine.ts`、`src/query.ts`）
- Ch03: 权限系统（`src/utils/permissions.ts`）
- Ch06: 弹性与恢复（`src/utils/retry.ts`）
- Ch08: Bridge 协议（`src/bridge/bridgeMain.ts`）

---

### [28:00] Slide 16: 横切关注点

6 个横贯所有章节的关注点（Cross-Cutting Concerns）：

**1. Feature Gates** — 运行时特性门控。`feature()` 函数在整个代码库中出现 960 次，89 个唯一标识符。Ch10（Feature+Cost）章节专门覆盖了这一机制的实现细节和成本计量。

**2. 权限模式** — `interactive`、`autoApprove`、`yolo` 三种模式。`hasPermissionsToUseTool()` 是核心入口。Ch3 Permission 章节覆盖。

**3. Prompt Caching** — API 层面的 prompt 缓存。`CacheControlBlock` 在系统提示词中配置缓存断点。影响 Ch4 Token Mgmt 的成本模型。

**4. 流式处理** — 全系统采用事件流而非一次性响应。从 Bridge V2 SSE 到 REPL token-by-token 渲染，流是唯一的异步模型。Ch6 Resilience 章节覆盖。

**5. DCE（Dead Code Elimination）** — 系统提示词和工具定义的剪枝。减少无效 token 消耗。Ch4 Token Mgmt 章节覆盖。

**6. JSONL 持久化** — 会话历史通过 JSON Lines 格式持久化到文件系统。`sessionStorage.ts` 5,105 行实现完整的读-写-恢复管线。Ch6 Resilience 章节覆盖。

这 6 个关注点在每章都有涉及，但各有一个"主场"章节负责主要实现。掌握它们等于掌握了跨模块的通用语言。

<!-- 
AUTO-GENERATED SLIDE SYNC REFERENCE
Please ensure your script.md contains the following headers:
Slide 01: Source Code Coverage Analysis
Slide 02: Learning Objectives
Slide 03: Chapter Dependencies
Slide 04: Chapter Weight Matrix
Slide 05: Architecture Map + Dependencies
Slide 06: LOC Proportional Treemap
Slide 07: Typical Task Call Flows
Slide 08: Bash Command Execution
Slide 09: File Read + Edit (Two-Turn)
Slide 10: Multi-Agent Fork Pattern
Slide 11: Context Overflow + 4-Stage Recovery
Slide 12: Top 10 Largest Source Files
Slide 13: Critical Constants Reference Card
Slide 14: Key Terms
Slide 15: See Also
Slide 16: Cross-Cutting Patterns + Engineering Insights
-->