# Chapter 5: Tools & MCP Architecture — Presentation Script
## ⏱️ Duration: ~55min | 📑 25 Slides

### 🔍 Core Source Files
* `src/tools.ts` → `getAllBaseTools()`, `getTools()`, `assembleToolPool()`, `filterToolsByDenyRules()`: Tool registration and assembly (~390 LOC)
* `src/utils/toolPool.ts` → `mergeAndFilterTools()`, `applyCoordinatorToolFilter()`: Tool pool merge and coordinator filtering (~80 LOC)
* `src/constants/tools.ts` → `ALL_AGENT_DISALLOWED_TOOLS`, `ASYNC_AGENT_ALLOWED_TOOLS`: Tool access control constants (~100 LOC)
* `src/services/tools/toolExecution.ts` → Tool execution pipeline (~500 LOC, 6-stage pipeline)
* `src/services/mcp/client.ts` → MCP client, transport layer (Stdio/SSE/StreamableHTTP)
* `src/services/mcp/config.ts` → 5-layer MCP configuration resolution
* `src/tools/BashTool/bashPermissions.ts` → Bash permission system, AST analysis, speculative classifier
* `src/tools/SkillTool/SkillTool.ts` → Skill tool dynamic loading
* `src/tools/ToolSearchTool/ToolSearchTool.ts` → Deferred tool search mechanism

---

### [00:00] 👉 Slide 1: Core Question

15,000+ 行 TypeScript 代码分布在 40+ 工具目录中——只是为了让一个 LLM 调用外部函数？

大多数框架（LangChain、OpenAI function calling）用装饰器或注册表管理十几个工具。Claude Code 的代码量是一个数量级的差距。

差距来自五个设计维度，每个维度都是其他框架不需要的：

1. **DCE（死代码消除）**：编译期裁剪工具集，不是运行时开关。`tools.ts` 前 135 行全是条件 `require`，每个工具用 `process.env.USER_TYPE` 或 `feature()` flag 控制。15+ 工具用这种模式，打包器根据条件静态删除分支。
2. **Schema token 预算**：专用工具 schema 比通用 exec 更精确 → 模型选择更准确。FileEdit 的 old_string/new_string vs sed 命令的模糊性。
3. **MCP 动态发现**：外部服务器随时上下线，schema 按需加载（ToolSearch），不能像 LangChain 假设工具集固定。
4. **Prompt 缓存稳定性**：`assembleToolPool()` 分区排序（内置工具作为连续前缀，MCP 工具作为连续后缀），保证服务端 cache breakpoint 不因 MCP 工具变化而全部失效。
5. **Speculative 安全优化**：Bash 命令分类在等待权限时预运行，节省 200-500ms p50 延迟。

今天从工具注册管线开始，走到 MCP 架构，最后做模式提炼。

---

### [04:00] 👉 Slide 2: Source Map

核心文件只有三个：

`src/tools.ts`（~390 LOC）是工具注册的**唯一真理来源**。`getAllBaseTools()` 返回完整工具清单，`getTools()` 做模式过滤，`assembleToolPool()` 做最终组装。整个注册管线在这个文件里完成。

`src/utils/toolPool.ts`（~80 LOC）是辅助管线。`mergeAndFilterTools()` 在 REPL 和 headless 两条路径上保持工具池一致；`applyCoordinatorToolFilter()` 在协调器模式下进一步裁剪工具集。

`src/constants/tools.ts`（~100 LOC）定义三组访问控制常量。`Set` 数据结构用于 O(1) 查找。

数据流：`tools.ts` 注册 → `toolPool.ts` 组装 → `constants/tools.ts` 过滤规则 → `toolExecution.ts` 执行。MCP 侧通过 `client.ts` 发现工具，在 `assembleToolPool()` 中与内置工具合并。

---

### [06:00] 👉 Slide 3: Tool Registration Pipeline (Diagram 1)

<!-- diagram: diagrams/tool-registration-pipeline.excalidraw → PNG -->

注册管线是 left-to-right 的数据流：

**Source** → `getAllBaseTools()` 返回 40+ 工具定义，按功能分组（文件、Shell、Web、Agent、Plan、MCP、辅助）。

**DCE Filter** → 编译期裁剪（不是运行时过滤）：
- `USER_TYPE === 'ant'` → REPLTool, OverflowTestTool 等 ant-only 工具
- `feature('PROACTIVE') || feature('KAIROS')` → SleepTool
- `feature('AGENT_TRIGGERS')` → CronCreateTool, CronDeleteTool, CronListTool
- `hasEmbeddedSearchTools()` → 条件排除 Glob/Grep（嵌入版本用 Bash alias）
- `feature('MONITOR_TOOL')` → MonitorTool

`feature()` 函数在 Bun 打包时返回常量布尔值，tree-shaking 可以直接删除 false 分支。源码有注释：`// Dead code elimination: conditional import for ant-only tools`。

**MCP Merge** → 运行时发现外部 MCP 服务器，每个工具包装为 `MCPTool` 实例，继承内置工具的 `Tool` 接口。对执行管线来说透明。

**Assemble** → `assembleToolPool()` 分别排序、拼接、去重。内置工具连续前缀 = cache breakpoint 稳定。

**Registry** → 按访问权限分成三组：ALL、agent-disallowed 子集、async-agent 白名单。

> **关键类比**：DCE 就像编译时裁剪，不是运行时开关。LangChain 的方式是"所有人都带着刀，用时再选"；Claude Code 的方式是"只有带刀的人才能进房间"。

**Edge case**：循环依赖打破用 lazy require 模式（第 63-72 行）：
```typescript
const getTeamCreateTool = () =>
  require('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
```
函数只在调用时才执行 `require`。注释明确写着 `Lazy require to break circular dependency`。

---

### [11:00] 👉 Slide 4: Inventory — 40+ Tools

`getAllBaseTools()` 返回的 `Tools` 数组按功能分组：

**文件操作**（6 个）：`FileReadTool`、`FileEditTool`、`FileWriteTool`、`GlobTool`、`GrepTool`、`NotebookEditTool`

**Shell**（2-3 个）：`BashTool`、`PowerShellTool`（Windows）、`REPLTool`（ant-only）

**Web**（2-3 个）：`WebFetchTool`、`WebSearchTool`、`WebBrowserTool`（feature flag）

**Agent**（8+ 个）：`AgentTool`、`TaskCreate/Get/Update/List/Stop/OutputTool`、`SendMessageTool`

**Plan**（2 个）：`EnterPlanModeTool`、`ExitPlanModeV2Tool`

**MCP**（2 个）：`ListMcpResourcesTool`、`ReadMcpResourceTool`

**辅助**（8 个）：`SkillTool`、`ToolSearchTool`、`ConfigTool`、`TodoWriteTool`、`BriefTool`、`TungstenTool`、`WorkflowTool`、`SnipTool`

为什么是 40+ 工具而不是一个通用 exec？因为每个工具的 schema 直接进入 prompt。专用 schema 越精确，模型选择越准确。FileEdit 只接受 old_string/new_string——比让模型用 sed/grep/awk 组合做同样事情可靠得多。

---

### [14:00] 👉 Slide 5: Assembly — Cache-Stable Sort

`assembleToolPool()`（第 345-367 行）是整个管线的设计核心：

```typescript
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

三件事：取内置工具、过滤 MCP、分别排序后拼接。

**关键细节在注释里**（第 355-359 行）：服务端 `claude_code_system_cache_policy` 在最后一个内置工具后放了 cache breakpoint。**分别排序保证内置工具位置稳定**。如果扁平混排，每次 MCP 工具变化都会让所有下游缓存键失效。

`uniqBy` 的去重策略是"内置工具优先"——内置在前、MCP 在后，lodash 的 uniqBy 保留第一个。这是安全考量：防止 MCP 服务器注册同名工具覆盖内置行为。

另一个细节：注释写着 `Avoid Array.toSorted (Node 20+) — we support Node 18`。兼容性考虑到位。

---

### [17:00] 👉 Slide 6: Filter — Deny Rules + Mode Filter

两层过滤：

**第一层：blanket deny**。`filterToolsByDenyRules()`（第 262-269 行）检查每个工具是否被完全禁用（没有 ruleContent 的 deny rule）。MCP 工具支持前缀匹配：`mcp__server` 匹配该服务器所有工具。

**第二层：模式过滤**。`getTools()`（第 271-327 行）根据环境变量裁剪：
- `CLAUDE_CODE_SIMPLE` → 只返回 BashTool + FileReadTool + FileEditTool
- REPL 模式 → `REPL_ONLY_TOOLS` 从直接暴露列表中移除

**Edge case**：如果 deny rule 完全禁用了 BashTool，CLAUDE_CODE_SIMPLE 模式下只剩两个文件工具——agent 能编辑文件但不能执行命令。deny rules 的约束力体现在这里。

---

### [19:30] 👉 Slide 7: Deferred Tools — ToolSearch

当 MCP 服务器提供大量工具时，全量 schema 会吃掉 context window。`ToolSearchTool` 解决这个 O(N) 问题：

```typescript
...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),  // 第 249 行
```

两阶段策略：
1. **Prompt 阶段**：只发核心工具 + ToolSearchTool schema
2. **Runtime 阶段**：模型需要 deferred tool 时调用 ToolSearch 查询，系统返回完整 schema

> **类比**：ToolSearch 是 tool schema 的 LRU cache——热工具常驻 prompt，冷工具按需加载。

对比 OpenAI function calling：所有 function schema 必须全量传入。200 个 function = 40K token。Claude Code 可以把开销降到 1.3K（ToolSearch 自身 300 + 查询结果 5 个 × 200）。

注册时用乐观检查 `isToolSearchEnabledOptimistic()`——注册时只包含 ToolSearch，实际 defer 决策在请求时 `claude.ts` 中延迟执行。这避免了注册时做昂贵的 MCP 工具计数。

---

### [22:00] 👉 Slide 8: Execution Pipeline — 6 Stages

`toolExecute()` 是 6 阶段管线：

| Stage | 名称 | 职责 | 并行？ |
|-------|------|------|--------|
| 1 | Route | 按名称匹配工具，支持 `mcp__server__tool` 格式 | - |
| 2 | Permission | 权限系统检查，Bash 工具触发 speculative classifer | Speculative |
| 3 | Validate | `tool.validateInput()` 验证参数 | - |
| 4 | Execute | `tool.call()` 执行，通过 `ToolProgress` 回调报告进度 | - |
| 5 | Result | 构建 `tool_result` block，大输出持久化到文件 | - |
| 6 | Analytics | 遥测：工具名、执行时间、文件扩展名 | - |

**并行优化**：Stage 2 的 speculative classifier 和 Stage 1 的 route 可以并行启动。不是严格的顺序执行。

**Edge case**：用户 cancel（abort signal）时，`toolExecution.ts` 在多个检查点检测。但已启动的 shell 命令不能立即终止——SIGTERM → 超时 → SIGKILL。

---

### [25:00] 👉 Slide 9: Speculative Classifier (Diagram 4)

<!-- diagram: diagrams/tool-execution-patterns.excalidraw → PNG -->

Speculative classifier 是执行管线中的性能优化（`bashPermissions.ts` → `startSpeculativeClassifierCheck()`）。

原理：收到 Bash tool_use 时，**在等待权限确认的同时**预先启动安全分类器。用户点击"允许"时分类结果已就绪，不需要再等。

```typescript
import { startSpeculativeClassifierCheck } from '../../tools/BashTool/bashPermissions.js'
// 第 39 行导入
```

时机：收到 `tool_use` block 后，进入权限检查流程前。返回 `PendingClassifierCheck` Promise——后续权限检查 await 这个 Promise，已完成立即拿结果，没完成就等。

**为什么是 speculative？** 乐观预计算。用户拒绝时分类结果浪费。但用户大部分时间允许执行，p50 场景节省 200-500ms。

> **类比**：就像餐厅在你犹豫菜单时提前备料——你最终不要，餐厅损失一点成本；但你点了，上菜时间减半。

**只针对 Bash**：Bash 命令安全分类成本最高（AST 解析 + 文件路径检查 + 危险性评估），其他工具只需要查 deny rules。

---

### [27:30] 👉 Slide 10: Concurrency — Agent Isolation

`constants/tools.ts` 定义了精确的工具访问控制：

```typescript
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,        // 防止子 agent 直接输出
  EXIT_PLAN_MODE_V2_TOOL_NAME,  // Plan 是主线程抽象
  ENTER_PLAN_MODE_TOOL_NAME,
  ...(process.env.USER_TYPE === 'ant' ? [] : [AGENT_TOOL_NAME]),  // ant 允许嵌套
  ASK_USER_QUESTION_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
])
```

子 agent 被禁止的工具各有理由：TaskOutputTool（不能直接输出到主线程）、Plan 模式工具（主线程抽象）、AskUserQuestionTool（子 agent 不应向用户提问）、TaskStopTool（需要主线程任务状态）。

`ASYNC_AGENT_ALLOWED_TOOLS` 是白名单——18 个工具，包含文件操作、搜索、Web、Skill、ToolSearch。不包含 AgentTool（防递归）和 MCPTool（标注为 TBD）。

`IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` 额外开放 Task 管理和 SendMessageTool，以及 AGENT_TRIGGERS 下的 Cron 工具。

协调器模式（`toolPool.ts` → `applyCoordinatorToolFilter()`）进一步过滤为 `COORDINATOR_MODE_ALLOWED_TOOLS`——只需要 agent 派发和任务管理工具。

**Edge case**：内部用户（`USER_TYPE === 'ant'`）子 agent 可用 AgentTool → 嵌套 agent。外部用户禁止，防止资源耗尽。

---

### [30:30] 👉 Slide 11: MCP Config — 5-Layer Hierarchy (Diagram 2)

<!-- diagram: diagrams/mcp-config-layers.excalidraw → PNG -->

`config.ts` 实现五层配置解析，外层到内层优先级递增：

| 层 | 来源 | 路径/函数 | 可控性 |
|----|------|-----------|--------|
| L1 | Enterprise | `getEnterpriseMcpFilePath()` | 管理员 MDM，用户不可改 |
| L2 | Global | `~/.claude/mcp_servers.json` | 用户级设置 |
| L3 | Project | `.claude/mcp_servers.json` | 项目级，团队共享 |
| L4 | Plugin | `getPluginMcpServers()` | 插件提供 |
| L5 | Remote | `fetchClaudeAIMcpConfigsIfEligible()` | Claude.ai 远程，订阅用户 |

`addScopeToServers()`（第 69-80 行）为每层服务器添加 `scope` 标记——后续安全检查和 UI 展示用。

优先级规则：越内层越优先。Enterprise 可以覆盖任何用户配置；项目级 `.claude/` 配置可以覆盖全局配置。

> **关键洞察**：项目级配置可以定义自定义 MCP 服务器覆盖用户全局配置——这是"团队工具链"的设计基础。每个成员进入项目自动获得统一工具集。

---

### [34:00] 👉 Slide 12: MCP Transport — Three Protocols (Diagram 3)

<!-- diagram: diagrams/mcp-transport-modes.excalidraw → PNG -->

`client.ts` 导入三种传输协议：

```typescript
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
```

| | Stdio | SSE (v1) | StreamableHTTP (v2) |
|-|-------|---------|---------------------|
| 机制 | stdin/stdout pipe | Server-Sent Events | 全 HTTP + streaming |
| 场景 | 本地 CLI 工具 | HTTP 远程服务 | 现代云 MCP 服务器 |
| 优点 | 简单、无网络开销 | 防火墙友好 | 双向、可恢复 |
| 缺点 | 无远程支持、生命周期绑定 | 单向（需 POST 补充） | 连接管理复杂 |

传输选择：`McpClientTransport.create()` 从 URL scheme 判断——无 URL = stdio，http(s) = StreamableHTTP（优先于 SSE）。

---

### [37:00] 👉 Slide 13: MCP Resilience

健壮性处理：

**Transport 层**：Stdio 子进程可能崩溃、卡死、输出非法 JSON。客户端处理 `ECONNRESET`、`EPIPE`、子进程退出。

**Error handling**：`McpError` 类型（SDK）定义标准错误码。`ErrorCode` 枚举：`InvalidRequest`、`MethodNotFound`、`InternalError`——不同错误码对应不同恢复策略。

**Timeout**：MCP 工具调用有超时机制。超时后取消请求返回错误，防止慢速服务器阻塞全局。

**Reconnection**：SSE 和 StreamableHTTP 可自动重连。Stdio 需要重启子进程。

设计哲学：**优雅降级**——一个 MCP 服务器挂了，不影其他服务器和内置工具。独立连接管理 + 错误隔离。

连接池用 `p-map` 做并发控制——避免同时启动太多子进程。

---

### [40:00] 👉 Slide 14: Bash Deep Dive — AST Analysis

Bash 权限系统不是字符串匹配，是 AST 分析：

1. **Rule matching** → `PermissionRule` 匹配命令前缀
2. **AST analysis** → `parseForSecurityFromAst()` 解析命令 AST，检查管道/重定向/子命令
3. **Classifier** → 规则无法判断时调 LLM classifier 做语义分析
4. **User prompt** → 终极兜底

每层输出 `allow` / `deny` / `ask`。只有明确 `allow` 才跳过后续层；`deny` 立即拒绝；`ask` 继续下一层。

> **为什么 AST？** Shell 命令可以用引号、转义、变量展开绕过字符串规则。`r"m" -rf /` 在字符串层面不包含 `rm`，但 AST 可以识别。

bashPermissions.ts 前 60 行导入列表暴露了这个系统的复杂度——AST 解析、输出重定向提取、命令前缀获取、shell 引号解析、安全分类器、三级描述系统（prompt/allow/deny）。

---

### [43:30] 👉 Slide 15: SkillTool — Meta-Tool

SkillTool 不直接执行操作——它加载和执行预定义的"技能"。

每个 skill 是一个目录，包含 prompt 文件和可选工具定义。`SkillTool` 接受 skill 名称，加载对应 prompt，注入对话上下文。

> **类比**：Skill 是动态 system prompt 注入。不改变工具集，改变模型行为指导。

`SkillTool` 在 `ASYNC_AGENT_ALLOWED_TOOLS` 中（第 66 行）——子 agent 也可以使用技能。发现机制支持多层来源：内置、用户自定义、MCP 提供。

多层来源 + 统一接口——和 MCP 配置同一个设计思路。

---

### [46:00] 👉 Slide 16: Design Patterns

从这套系统中提炼 5 个可复用模式：

**Pattern 1: Partitioned Sort for Cache Stability**
内置和外部工具分区分别排序 → 保证 prompt cache breakpoint 稳定。适用于任何需要在可变集合上维持缓存稳定性的场景。

**Pattern 2: DCE-driven Feature Gating**
`feature()` + 条件 `require` 实现编译期功能切换。比运行时 if/else 更高效——代码不进 bundle，零运行时开销。需要打包器支持（Bun tree-shaking）。

**Pattern 3: Speculative Precomputation**
等待用户输入时预计算可能结果。成本 = 偶尔白算；收益 = 高批准率场景下延迟减半。适用于"计算成本中等、用户批准概率高"场景。

**Pattern 4: Deny-by-Default with Layered Allow**
默认拒绝，多层规则逐步开放。每层 allow/deny/ask。比简单 ACL 灵活——可以处理"工具允许但特定参数组合禁止"。

**Pattern 5: Lazy Tool Discovery**
ToolSearch 按需加载 → pull 优于 push。工具数量小 push 简单；工具数量大 pull 高效。

---

### [50:00] 👉 Slide 17: Constants Deep Dive

`constants/tools.ts` 每组常量都有安全理由：

```typescript
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,        // Prevent output to main thread
  EXIT_PLAN_MODE_V2_TOOL_NAME,  // Plan mode is main-thread only
  ENTER_PLAN_MODE_TOOL_NAME,    // Same
  ASK_USER_QUESTION_TOOL_NAME,  // Sub-agents don't prompt user
  TASK_STOP_TOOL_NAME,          // Requires main-thread task state
])
```

`ASYNC_AGENT_ALLOWED_TOOLS` — 18 个工具，覆盖文件操作、搜索、Web、Skill、ToolSearch。

`IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` — 额外 Task 管理 + SendMessageTool + AGENT_TRIGGERS Cron 工具。

**设计原则**：最小权限。每种 agent 类型只获得完成任务的最小工具集。

注释中明确标记了 "BLOCKED FOR ASYNC AGENTS" 和 "ENABLE LATER (NEED WORK)" 的工具——技术债的透明声明。

---

### [52:30] 👉 Slide 18: Summary

**注册**：40+ 工具，DCE 编译期裁剪，三种导入模式（静态/条件 require/延迟函数）

**组装**：分区排序 + 去重（内置优先），保证 prompt cache 稳定

**执行**：6 阶段管线，Bash speculative 预分类，其他工具 Promise.all 并发

**MCP**：5 层配置，3 种传输协议，优雅降级

**安全**：3 组白/黑名单，AST 权限分析，最小权限原则

**5 个核心设计理念**：
1. 专用工具 > 通用 exec（模型选择准确度）
2. DCE 编译期裁剪 > 运行时开关（零开销）
3. ToolSearch 按需 > 全量 schema（token 节省 97%）
4. Speculative 预计算 > 同步等待（延迟减半）
5. AST 分析 > 字符串匹配（绕过防护不可行）

核心设计哲学：**精确控制、优雅扩展**。

---

### [54:30] 👉 Slide 19: Q&A

常见问题：

**Q: 两个 MCP 服务器注册同名工具？**
A: `mcp__server__tool` 命名格式天然防冲突。同一服务器在不同层配置重复时，高优先级层胜出。

**Q: ToolSearch 节省多少 token？**
A: 200 个工具全量 40K token → ToolSearch 1.3K。节省 ~97%。

**Q: Speculative classifier 改变分类结果吗？**
A: 不改变。只是提前开始计算。唯一浪费是用户拒绝时白算了一次。

---

*[END OF SCRIPT]*

<!-- 
AUTO-GENERATED SLIDE SYNC REFERENCE
Please ensure your script.md contains the following headers:
Slide 01: cover
Slide 02: Learning Objectives
Slide 2: Ch 05 Tools &amp; MCP
Slide 3: Ch 05 Tools &amp; MCP
Slide 04: Tool Registration Pipeline
Slide 5: Ch 05 Tools &amp; MCP
Slide 6: Ch 05 Tools &amp; MCP
Slide 7: Ch 05 Tools &amp; MCP
Slide 08: Tool Execution Patterns
Slide 10: Code Walkthrough
Slide 9: Ch 05 Tools &amp; MCP
Slide 10: Ch 05 Tools &amp; MCP
Slide 11: MCP Config Layers
Slide 12: MCP Transport Modes
Slide 13: Ch 05 Tools &amp; MCP
Slide 14: Ch 05 Tools &amp; MCP
Slide 15: Ch 05 Tools &amp; MCP
Slide 16: Ch 05 Tools &amp; MCP
Slide 17: Ch 05 Tools &amp; MCP
Slide 17: Ch 05 Tools &amp; MCP
Slide 18: Ch 05 Tools &amp; MCP
Slide 22: Key Terms
Slide 19: Ch 05 Tools &amp; MCP
Slide 24: See Also
Slide 25: qa
-->