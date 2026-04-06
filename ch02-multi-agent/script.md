# Chapter 2: Multi-Agent System - Presentation Script (逐字稿)
## ⏱️ Total Duration: ~60 minutes | 📑 26 Slides | 📝 ~9,200 words

### Core Source Files Referenced
* `src/tools/AgentTool/runAgent.ts` → `initializeAgentMcpServers()`: Agent-specific MCP server initialization and lifecycle
* `src/tools/AgentTool/forkSubagent.ts` → `isForkSubagentEnabled()` / `buildForkedMessages()`: Fork agent feature gate and message construction
* `src/tools/AgentTool/builtInAgents.ts` → `getBuiltInAgents()`: Built-in agent registry and feature-gated loading
* `src/tools/AgentTool/agentToolUtils.ts` → `filterToolsForAgent()` / `resolveAgentTools()`: Tool isolation and filtering logic
* `src/tools/AgentTool/loadAgentsDir.ts` → `AgentDefinition` type: Agent definition schema and loading
* `src/coordinator/coordinatorMode.ts` → `isCoordinatorMode()` / `getCoordinatorUserContext()`: Coordinator orchestration mode
* `src/constants/tools.ts` → `ALL_AGENT_DISALLOWED_TOOLS` / `ASYNC_AGENT_ALLOWED_TOOLS`: Tool access control lists
* `src/tools/SendMessageTool/SendMessageTool.ts` → SendMessage routing and inter-agent communication

---

### [00:00] Opening & Core Insight (Slide 1: Cover)

这个系统的多Agent架构，核心观点只有一句：**Agent即工具（AgentTool）——不是独立框架，而是引擎上的工具抽象**。模型调用AgentTool就像调用ReadTool、BashTool一样，AgentTool内部复用同一个`query()`引擎运行子Agent推理循环。子Agent共享引擎，隔离上下文。

三种Agent模式对应三种并发模型：
- **Sync Agent** → 线程内同步调用，父阻塞等子返回
- **Async Agent** → 后台任务，父继续运行，通过task ID轮询结果
- **Coordinator模式** → 星形编排，主节点只做分解和分发

今天60分钟覆盖4种Agent类型、5个内置Agent、权限/工具/上下文三重隔离、Coordinator编排、Fork消息构建和prompt cache优化。

---

### [03:00] Slide 2: Source Map

源码分布在4个位置：

**核心目录 `src/tools/AgentTool/`**：
- `runAgent.ts`——500+行，完整生命周期管理
- `forkSubagent.ts`——Fork feature gate、消息构建、递归防护
- `builtInAgents.ts`——内置Agent注册表，feature flag控制
- `agentToolUtils.ts`——`filterToolsForAgent()` / `resolveAgentTools()`，工具隔离核心
- `loadAgentsDir.ts`——`AgentDefinition` schema，支持Markdown frontmatter和JSON

**`src/coordinator/coordinatorMode.ts`**——Coordinator编排层，可选启用

**`src/constants/tools.ts`**——三个Set：`ALL_AGENT_DISALLOWED_TOOLS`、`ASYNC_AGENT_ALLOWED_TOOLS`、`IN_PROCESS_TEAMMATE_ALLOWED_TOOLS`

**`src/tools/SendMessageTool/SendMessageTool.ts`**——Agent间通信通道

调用链：外部触发AgentTool → `runAgent.ts`初始化 → Sync/Async/Fork路由 → `agentToolUtils.ts`过滤工具 → `query()`运行推理循环 → `SendMessageTool`通信 → 清理资源。

---

### [05:30] Slide 3: Architecture Overview

三层架构：

**定义层（AgentDefinition）**——静态配置。类型定义在`loadAgentsDir.ts`，包含`agentType`、`tools`、`permissionMode`、`model`、`maxTurns`、`mcpServers`、`hooks`、`memory`、`isolation`。来源：内置（`builtInAgents.ts`）、用户定义（`.claude/agents/`）、插件（plugin loader）。

**运行层（runAgent.ts）**——动态执行。核心设计：**共享引擎、隔离上下文**——子Agent用相同`query()`函数，但独立的消息历史、工具集、权限配置。

**编排层（Coordinator）**——可选抽象。`CLAUDE_CODE_COORDINATOR_MODE`环境变量开启时，主Agent变Coordinator，不执行任务只做分发，系统提示词通过`getCoordinatorUserContext()`注入。

三层通过依赖注入和feature gate解耦。与CrewAI对比：CrewAI三层强制绑定（必须创建Crew才能运行）；这里三层可选组合——单Agent、Async、Coordinator自由切换，"渐进式复杂度"。

---

### [08:00] Slide 4: Sync Agent

**Sync Agent：父阻塞等子返回，结果汇总为工具调用返回值。**

`runAgent.ts`执行链路：
1. 解析AgentDefinition → tools/permissionMode/model
2. `initializeAgentMcpServers()` → 初始化Agent专属MCP服务器
3. 创建子Agent ToolUseContext（独立AbortController、文件缓存、系统提示词）
4. 调用`query()`运行推理循环
5. `startAgentSummarization()` → 独立API调用生成压缩摘要
6. 清理：关闭MCP连接、清理追踪信息

关键设计是**结果摘要**。子Agent产生大量输出（文本、工具调用、文件修改），但返回给父Agent的只是一个压缩摘要。通过独立API调用生成，避免摘要本身消耗子Agent的推理轮次。

适用场景：线性任务、明确输入输出、父Agent需要基于子结果继续推理。

局限：阻塞父Agent。子Agent跑5分钟，父Agent就显示"思考中"5分钟。引出Async Agent。

---

### [08:00] Slide 5: Async Agent

**Async Agent：后台运行，父不阻塞，通过task ID关联。**

`background: true`触发。子Agent作为Local Agent Task运行，父收到task ID可轮询进度。

工具访问控制有根本不同——白名单而非黑名单。`src/constants/tools.ts`：

```typescript
// Asynchronous agent tool whitelist
// Async agents operate without direct user supervision, so restrict to safe tools.
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  SKILL_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
])
```

排除的关键工具：`ASK_USER_QUESTION_TOOL_NAME`（不能提问用户不在线）、`AGENT_TOOL_NAME`（防止Agent爆炸式嵌套）、`ENTER_PLAN_MODE_TOOL_NAME` / `EXIT_PLAN_MODE_V2_TOOL_NAME`（不能进入计划模式）。

`agentToolUtils.ts`过滤逻辑：
```typescript
if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
  return false
}
```

进度追踪通过`ProgressTracker`：`createProgressTracker()`创建、`updateProgressFromMessage()`更新、`getProgressUpdate()`读取，显示在UI后台任务面板。

完成/失败分别通过`completeAsyncAgent()` / `failAsyncAgent()`通知，`enqueueAgentNotification()`推送用户通知。

`createActivityDescriptionResolver()`分析子Agent当前行为（读文件？执行命令？编辑代码？），生成简短描述显示在UI——"Triple isolation"第二道：工具隔离精确划定能力边界，类似iptables白名单规则。

---

### [13:00] Slide 6: Fork Agent

**Fork Agent：上下文完整继承，类似Unix fork()但不共享文件描述符。**

启用条件（`forkSubagent.ts`第32行）：
1. `feature('FORK_SUBAGENT')`为true
2. `isCoordinatorMode()`返回false
3. `getIsNonInteractiveSession()`返回false

`FORK_AGENT`常量（第60行）：
- `tools: ['*']`——继承父Agent全部工具
- `model: 'inherit'`——继承父Agent模型
- `permissionMode: 'bubble'`——权限请求冒泡到父终端
- `maxTurns: 200`
- `source: 'built-in'`
- `getSystemPrompt: () => ''`——返回空字符串

为什么systemPrompt返回空？因为Fork不走这个方法获取提示词。源码注释："the fork path passes override.systemPrompt with the parent's already-rendered system prompt bytes, threaded via toolUseContext.renderedSystemPrompt"。直接传递父Agent已渲染的system prompt bytes，避免重新渲染导致的差异（GrowthBook feature flag冷热启动值可能不同）。

`buildForkedMessages()`（第107行）构建消息列表：
1. 保留完整父Assistant消息（所有thinking/text/tool_use块）
2. 每个tool_use块创建占位tool_result（`FORK_PLACEHOLDER_RESULT`）
3. 最后追加包含fork指令的text块

核心优化：**prompt cache最大化命中**。所有Fork子Agent共享相同消息前缀——差异只在最后一个text块。`FORK_PLACEHOLDER_RESULT`固定文本确保tool_result块完全一致，API cache可命中共享前缀。

`isInForkChild()`检查消息历史中`FORK_BOILERPLATE_TAG`标记防止递归Fork。递归会导致上下文指数级增长，且用例几乎不存在——需要递归分解应使用Coordinator模式。

---

### [15:30] Slide 7: Remote + Worktree Isolation

**Worktree隔离**：`isolation: 'worktree'`，子Agent在独立Git worktree中运行，修改不影响主工作区，完成后通过Git合并回主分支。解决多个Async Agent并发修改同一文件的冲突。

`loadAgentsDir.ts`中`AgentJsonSchema`的`isolation`字段：
```typescript
isolation: (process.env.USER_TYPE === 'ant'
  ? z.enum(['worktree', 'remote'])
  : z.enum(['worktree'])
).optional()
```

`remote`仅对内部用户开放——子Agent在远端机器运行，通过网络与父Agent通信。适用大规模并行：10台机器各跑1个Agent。

MCP服务器初始化（`initializeAgentMcpServers()`，`runAgent.ts`第95行），两种模式：
1. **引用模式**：`typeof spec === 'string'`——引用已有服务器名，`getMcpConfigByName()`查找，共享连接（memoized `connectToServer()`）
2. **内联模式**：`{ [name]: config }`——Agent专属，完成时清理

清理原则："Only clean up newly created clients (inline definitions), not shared/referenced ones." 典型"谁创建谁负责"设计。

安全边界：`strictPluginOnlyCustomization`策略启用时，用户定义Agent的MCP服务器被跳过（`isRestrictedToPluginOnly('mcp')` check），内置Agent和插件Agent不受影响。

---

### [18:00] Slide 8: runAgent() Lifecycle

四阶段RAII模式：

**Phase 1: 初始化**
- 解析AgentDefinition → agentType/tools/model/permissionMode
- `resolveAgentTools()` → 支持`['*']`通配符或显式列表
- `initializeAgentMcpServers()` → 初始化MCP服务器
- `createSubagentContext()` → 独立AbortController/文件缓存/transcript目录
- `executeSubagentStartHooks()` → 启动钩子
- `registerFrontmatterHooks()` → 自定义钩子
- `setAgentTranscriptSubdir()` → transcript存储目录
- 可选：`registerPerfettoAgent()` → Perfetto追踪

**Phase 2: 推理循环**
- `enhanceSystemPromptWithEnvDetails()` → 系统提示词注入环境信息
- 构建初始消息（Agent prompt + memory + attachment）
- 调用`query()`启动推理循环
- 流式事件处理 → 转发进度、更新ProgressTracker

**Phase 3: 结果处理**
- 收集所有AssistantMessage
- `startAgentSummarization()` → 生成摘要
- `recordSidechainTranscript()` → 记录完整对话
- `writeAgentMetadata()` → 保存元数据

**Phase 4: 清理（finally块保证执行）**
- MCP cleanup → 关闭Agent专属MCP服务器
- `clearSessionHooks()` → 清除钩子
- `clearInvokedSkillsForAgent()` → 清除技能调用记录
- `cleanupAgentTracking()` → 清理API追踪
- `clearAgentTranscriptSubdir()` → 清理transcript目录
- `unregisterPerfettoAgent()` → 注销Perfetto
- `killShellTasksForAgent()` → 终止所有Shell任务
- `clearDumpState()` → 清理prompt dump

Phase 1获取的资源，Phase 4对应释放——典型RAII，即使Phase 2/3抛异常也在finally中执行。

---

### [20:30] Slide 9: 5 Built-in Agents

`getBuiltInAgents()`注册，定义在`src/tools/AgentTool/built-in/`：

1. **GENERAL_PURPOSE_AGENT**——默认Agent，广泛工具权限，无特殊约束
2. **STATUSLINE_SETUP_AGENT**——窄用途：配置状态栏
3. **EXPLORE_AGENT**——代码探索，`BUILTIN_EXPLORE_PLAN_AGENTS` gate + A/B测试`tengu_amber_stoat`评估效果
4. **PLAN_AGENT**——任务规划，同Explore Agent共享feature gate，"理解"和"规划"与"执行"分离
5. **VERIFICATION_AGENT**——代码验证，`VERIFICATION_AGENT` gate + A/B测试`tengu_hive_evidence`

`CLAUDE_CODE_GUIDE_AGENT`仅在非SDK入口点（REPL/CLI）中可用。

SDK逃生舱设计：
```typescript
if (isEnvTruthy(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS) && getIsNonInteractiveSession()) {
  return []
}
```
设置`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`禁用全部内置Agent，获得白板环境注册自定义Agent。

Coordinator模式下`getCoordinatorAgents()`替换所有默认内置Agent——"全有或全无"切换。

---

### [23:00] Slide 10: Custom Agent Loading

**加载路径**：`.claude/agents/`，两种格式：
1. **Markdown**——frontmatter定义元信息，body作系统提示词
2. **JSON**——`AgentJsonSchema`校验，支持hooks/mcpServers

`AgentJsonSchema`完整字段（`loadAgentsDir.ts`第73行）：`description`、`tools`、`disallowedTools`、`prompt`、`model`（支持`'inherit'`）、`effort`、`permissionMode`、`mcpServers`、`hooks`、`maxTurns`、`skills`、`initialPrompt`、`memory`（user/project/local）、`background`、`isolation`。

**插件Agent**第三来源，视为"admin-trusted"——即使`strictPluginOnlyCustomization`策略下MCP服务器也不被阻止。

`AgentMcpServerSpec`双模式：`string`引用已有服务器 或 `{ [name]: string]: McpServerConfig }`内联定义。

`AgentMemoryScope`三级记忆范围——`user`/`project`/`local`，通过`loadAgentMemoryPrompt()`加载注入系统提示词，Agent可跨会话积累知识。

---

### [25:30] Slide 11: Permission Isolation

第一重隔离——权限隔离。四种mode：

**default**——继承父Agent权限设置
**bypassPermissions**——跳过检查自动批准，仅内置/admin-trusted Agent
**plan**——只读不可写不可执行，Explore/Plan Agent使用
**bubble**——权限请求冒泡到父终端，Fork Agent使用

`filterToolsForAgent()`实现（接受`isBuiltIn`/`isAsync`/`permissionMode`）：
```typescript
if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
  return false
}
if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
  return false
}
```

`ALL_AGENT_DISALLOWED_TOOLS`条件项：
```typescript
...(process.env.USER_TYPE === 'ant' ? [] : [AGENT_TOOL_NAME])
```
内部用户允许Agent嵌套，外部用户禁止——防止嵌套Agent资源爆炸。

边界情况：`ExitPlanMode`工具在plan mode Agent中被允许（即使在`ALL_AGENT_DISALLOWED_TOOLS`中），因为plan mode Agent需要能退出计划模式。

**YOLO分类器**（`classifyYoloAction`）——自动批准模式的最后防线。即使Agent有bypassPermissions权限，分类器判定操作危险仍会被阻止或降级。

---

### [28:00] Slide 12: Tool Isolation

第二重隔离——精确控制每个Agent可用工具。

`resolveAgentTools()`处理逻辑：
1. **通配符`['*']`**——继承父Agent全部工具（经`filterToolsForAgent()`过滤），Fork Agent使用确保prompt cache命中
2. **显式列表**——仅包含指定工具，需与注册工具名匹配
3. **disallowedTools黑名单**——从最终列表中移除
4. **MCP工具**——`mcp__`前缀工具始终允许，不受Agent类型限制

`ResolvedAgentTools`类型：
```typescript
type ResolvedAgentTools = {
  hasWildcard: boolean
  validTools: string[]
  invalidTools: string[]
  resolvedTools: Tools
  allowedAgentTypes?: string[]
}
```

`invalidTools`——"宽容解析"策略，定义中不存在工具名仅警告不报错，Agent定义前向兼容。

Async Agent白名单（`ASYNC_AGENT_ALLOWED_TOOLS`）vs 同步Agent黑名单（`ALL_AGENT_DISALLOWED_TOOLS`）：白名单默认拒绝未知工具更安全，但新工具需显式添加。

In-process Teammate额外工具：`IN_PROCESS_TEAMMATE_ALLOWED_TOOLS`包含`TASK_CREATE`、`TASK_GET`、`TASK_LIST`、`TASK_UPDATE`等任务管理工具。

---

### [30:30] Slide 13: Context Isolation

第三重隔离——上下文隔离。

**消息历史**：Sync/Async Agent获得全新消息列表（初始prompt + attachment），看不到父Agent对话。三重隔离就像Docker的namespace隔离，但不用进程边界——在应用层完成。

Fork例外：继承完整消息历史，但所有tool_use结果替换为`FORK_PLACEHOLDER_RESULT`占位文本。

**系统提示词**：每Agent独立system prompt。内置通过`getSystemPrompt()`获取，自定义通过`prompt`字段获取，通过`enhanceSystemPromptWithEnvDetails()`增强。Fork例外：用父Agent已渲染system prompt bytes（`toolUseContext.renderedSystemPrompt`）避免重新渲染差异，为prompt cache服务。

**文件状态缓存**：`cloneFileStateCache()`或`createFileStateCacheWithSizeLimit()`为每子Agent创建独立缓存，`READ_FILE_STATE_CACHE_SIZE`控制大小，子Agent文件读取不与父Agent缓存混淆。

**Transcript**：`setAgentTranscriptSubdir()`设置独立存储目录（Agent ID命名子目录），`recordSidechainTranscript()`记录。

**AbortController**：每子Agent独立`AbortController`，可独立取消某子Agent不影响父或其他子。`killAsyncAgent()`利用此特性终止特定后台Agent。

**CacheSafeParams**（来自`src/utils/forkedAgent.ts`）：Fork场景下保存足够上下文信息以重建子Agent状态，但不泄露不该共享信息——"安全共享"与"有效隔离"的平衡。

---

### [33:00] Slide 14: Coordinator Mode

`isCoordinatorMode()`（`coordinatorMode.ts`第36行）：
```typescript
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

需双条件同时满足：feature gate + 环境变量。

核心理念：**角色分离**——Coordinator不执行任务，只做分解/分发/汇总。微服务编排者模式（Orchestrator Pattern）的工程实践。

启用时`getBuiltInAgents()`行为完全改变——不返回默认5个内置Agent，改为`getCoordinatorAgents()`返回Worker Agent定义。

`getCoordinatorUserContext()`注入额外上下文：
```typescript
let content = `Workers spawned via the ${AGENT_TOOL_NAME} tool have access to these tools: ${workerTools}`
```
告诉Coordinator Worker可用工具列表，用于合理分配任务。

`INTERNAL_WORKER_TOOLS`——Coordinator内部工具：`TEAM_CREATE_TOOL_NAME`、`TEAM_DELETE_TOOL_NAME`、`SEND_MESSAGE_TOOL_NAME`、`SYNTHETIC_OUTPUT_TOOL_NAME`。对Coordinator可见但对普通用户不可见——编排层"内部API"。

Scratchpad启用时（`isScratchpadGateEnabled()`），Coordinator上下文还包含Scratchpad目录信息——共享工作区，Coordinator/Worker通过文件系统交换中间结果，比消息传递更适合大块数据传输。

**会话模式匹配**（`matchSessionMode()`）：恢复会话时若上次是Coordinator模式但当前环境未启用，自动切换模式匹配恢复的会话。

与LangGraph对比：LangGraph通过图结构定义Agent交互（条件边/循环），Coordinator更简单——星形拓扑（中心+周围Worker），Worker之间无直接通信。星形易懂但表达力有限。

---

### [35:30] Slide 15: Coordinator Workflow

7步走完全流程：

**Step 1: 用户输入** → "重构认证系统，包括前端登录页和后端API"

**Step 2: Coordinator分解** → "前端改造"、"后端API重构"、"数据库schema更新"

**Step 3: Worker创建** → 每个Worker不同配置（前端需浏览器工具、后端需数据库工具），异步运行

**Step 4: 独立执行** → `query()`推理循环，各自权限范围内工作

**Step 5: 进度监控** → ProgressTracker轮询，SendMessage工具额外指导

**Step 6: 结果汇总** → 所有Worker完成/超时后，Coordinator汇总返回用户

**Step 7: 冲突解决** → 多Worker修改同文件（非Worktree模式），Coordinator协调——仍为开放问题

核心优势：**并行化**。30分钟串行任务 → 3 Worker并行 → ~12分钟。代价：协调开销、复杂错误处理、更高Token消耗。

---

### [38:00] Slide 16: SendMessage Routing

`SendMessageTool.ts`，`to`字段四种寻址：
1. **点对点**——指定teammate名称
2. **广播**——`"*"`发送给所有teammate
3. **UDS对等**——`"uds:<socket-path>"` 通过Unix Domain Socket
4. **Bridge对等**——`"bridge:<session-id>"`通过Remote Control Bridge

结构化消息类型：
```typescript
z.discriminatedUnion('type', [
  z.object({ type: z.literal('shutdown_request'), reason: z.string().optional() }),
  z.object({ type: z.literal('shutdown_response'), request_id: z.string(), approve: semanticBoolean(), reason: z.string().optional() }),
  z.object({ type: z.literal('plan_approval_response'), request_id: z.string(), approve: semanticBoolean(), feedback: z.string().optional() }),
])
```

**Shutdown协商协议**：Team Lead发`shutdown_request` → Worker返回`shutdown_response`批准/拒绝 → 全部批准才关闭。防止"Worker还在工作被强制关闭"。

**Plan审批**：Worker发送计划请求 → Team Lead批复 → "Worker提案，Lead审批"工作流。

消息路由：
- 本地Agent任务 → `queuePendingMessage()`放入目标待处理队列
- 主会话任务 → `writeToMailbox()`写入信箱
- 远程对等 → 网络发送
- Bridge对等 → REPL Bridge发送

`summary`字段：5-10字预览显示在UI，用户不必查看完整消息。

`TEAM_LEAD_NAME`——特殊角色，权限：创建/销毁Team成员、广播消息。

---

### [40:30] Slide 17: Fork Implementation Details

`buildForkedMessages()`目标：**最大化prompt cache命中率**。

输出格式：`[...history, assistant(all_tool_uses), user(placeholder_results..., directive)]`

只有最后一个text块（directive）在不同Fork子Agent间不同。其余完全一致 → API prompt cache命中共享前缀，差异仅最后几十个Token。

`FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'`——为什么不全空字符串？因为空字符串可能被API特殊处理（忽略/报错）。有意义占位文本更安全且对模型提供语义——"工具调用已在后台处理"。

`buildChildMessage()`将directive包装为child message格式。directive前缀`FORK_DIRECTIVE_PREFIX`（`src/constants/xml.ts`），XML标签标记模型可区分"fork指令"和"普通对话"。

**递归防护**：`isInForkChild()`检查`FORK_BOILERPLATE_TAG`标签，存在即拒绝再次Fork。

**Fork与Coordinator互斥**：`isForkSubagentEnabled()`中`if (isCoordinatorMode()) return false`——原因："coordinator already owns the orchestration role and has its own delegation model"。Coordinator显式任务分配 vs Fork隐式上下文继承，共存导致控制流混乱。

Fork的`useExactTools`属性——工具列表不走`filterToolsForAgent()`过滤，子Agent获得父Agent完全相同工具集。这不仅为功能完整性，更为了prompt cache——工具定义是API请求一部分，工具列表不同cache无法命中。

---

### [43:00] Slide 18: vs CrewAI

**Agent定义**：CrewAI用Python类（role/goal/backstory，人格化）；这里用`AgentDefinition`类型（tools/permissionMode，功能化）。

**任务分配**：CrewAI通过Task类绑定Agent（sequential/hierarchical模式，结构化）；这里通过Agent工具调用参数动态分配（prompt参数，灵活）。

**Agent通信**：CrewAI通过Task context间接通信（上游输出→下游输入）；这里通过SendMessage直接通信（随时发消息，灵活但需路由+协商协议）。

**工具管理**：CrewAI无工具隔离——Agent可使用任何LangChain Tool；这里有`ALL_AGENT_DISALLOWED_TOOLS`、`ASYNC_AGENT_ALLOWED_TOOLS`、`CUSTOM_AGENT_DISALLOWED_TOOLS`三个Set精确控制。

**错误恢复**：CrewAI基本重试；这里全面——task级重试、context压缩（prompt_too_long）、输出截断恢复（withhold-recover）、模型降级（fallback）。

总结：CrewAI是"工作流编排"框架——预定义结构化工件流；这里是"动态协作"平台——运行时由AI决定Agent创建和协作。固定工作流选CrewAI，动态决策选这里。

---

### [46:00] Slide 19: vs AutoGPT

**自主性**：AutoGPT追求"完全自主"——自主设定目标/计划/执行；这里在人机交互和自主性之间谨慎平衡——Sync Agent需监督，Async Agent可自主但权限系统确保危险操作需确认。

**记忆架构**：AutoGPT用向量数据库（Pinecone/ChromaDB），语义检索；这里用文件系统（CLAUDE.md/项目记忆文件），`AgentMemoryScope`三级（user/project/local），用户可直接编辑更透明。

**执行隔离**：AutoGPT在Docker容器中运行——OS级别沙箱，性能开销高；这里进程中运行通过工具过滤和权限检查——应用级别隔离，Worktree提供文件系统隔离。AutoGPT更强但更重。

**Prompt Cache**：AutoGPT无跨Agent cache优化——每Agent API调用完全独立；这里通过Fork消息构建策略实现共享——相同前缀复用cache，大规模并行节省50%+ Token。

**扩展性**：AutoGPT专有插件系统（Protocol Plugins）；这里用MCP标准协议——跨框架工具共享，互操作性。

**哲学差异**：AutoGPT = "Human out of the Loop"；这里 = "Human in the Loop when needed"。`permissionMode`机制就是这种哲学的具体体现。企业环境更容易接受——IT部门可通过权限策略精确控制AI Agent行为边界。

---

### [49:00] Slide 20: Constants Quick Reference

1. **`AGENT_TOOL_NAME`**（`src/tools/AgentTool/constants.ts`）——Agent工具名，还有`LEGACY_AGENT_TOOL_NAME`向后兼容

2. **`ALL_AGENT_DISALLOWED_TOOLS`**——`TASK_OUTPUT_TOOL_NAME`、`EXIT_PLAN_MODE_V2_TOOL_NAME`、`ENTER_PLAN_MODE_TOOL_NAME`、`ASK_USER_QUESTION_TOOL_NAME`、`TASK_STOP_TOOL_NAME`；外部用户还含`AGENT_TOOL_NAME`

3. **`ASYNC_AGENT_ALLOWED_TOOLS`**——文件读写/搜索/Shell/Notebook，异步Agent能力边界

4. **`IN_PROCESS_TEAMMATE_ALLOWED_TOOLS`**——`TASK_CREATE`/`TASK_GET`/`TASK_LIST`/`TASK_UPDATE`、SendMessage

5. **`FORK_SUBAGENT_TYPE = 'fork'`**——分析事件中区分Fork/普通Agent

6. **`FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'`**——固定占位文本确保prompt cache命中

7. **`FORK_BOILERPLATE_TAG` / `FORK_DIRECTIVE_PREFIX`**（`src/constants/xml.ts`）——递归检测/fork指令标记

8. **`READ_FILE_STATE_CACHE_SIZE`**——每Agent独立缓存大小

9. **`DEFAULT_AGENT_PROMPT`**（`src/constants/prompts.ts`）——默认提示词

10. **`SEND_MESSAGE_TOOL_NAME` / `TEAM_LEAD_NAME`**——通信协议基本要素

---

### [52:00] Slide 21: 5 Takeaways

**Takeaway 1: Agent即工具是核心模式**。子Agent不是独立运行时——是父Agent调用的一个工具。`AgentTool`与`ReadTool`/`BashTool`在架构上平等——都是Tool接口实现。

**Takeaway 2: 三重隔离确保安全**。权限隔离（`permissionMode` + `canUseTool`）+ 工具隔离（三个Set + `filterToolsForAgent()` + 上下文隔离（独立消息/系统提示词/文件缓存）。三重隔离就像Docker的namespace隔离，但不用进程边界。以单Agent引擎和基础，用工具抽象实现Agent编排，用三重隔离保证安全，用prompt cache优化控制成本。

---

### [55:00] Slide 22: Q&A

**冲突解决**：多个Async Agent同时修改同文件时，后写入覆盖先写入——无内置自动冲突解决。Worktree是最佳实践，但非Worktree场景仍是开放问题。

**可观测性**：5-10个Worker并行场景的追踪，当前通过ProgressTracker + Perfetto，粒度可能不够。潜在方向：OpenTelemetry集成，用分布式追踪方式追踪Agent系统。

**自定义Agent测试**：无内置测试框架。潜在方案："Agent playground"沙箱环境，安全测试工具调用/权限请求/结果生成。

**隐式知识共享**：当前Agent通信是显式的（SendMessage）。潜在方向：共享记忆层——Agent A学到的代码库知识自动对Agent B可见。`AgentMemoryScope`是起点，但是私有的。

<!-- 
AUTO-GENERATED SLIDE SYNC REFERENCE
Please ensure your script.md contains the following headers:
Slide 01: cover
Slide 02: Learning Objectives
Slide 2: Chapter 02 - Multi-Agent System
Slide 3: Chapter 02 - Multi-Agent System
Slide 4: Chapter 02 - Multi-Agent System
Slide 5: Chapter 02 - Multi-Agent System
Slide 6: Chapter 02 - Multi-Agent System
Slide 7: Chapter 02 - Multi-Agent System
Slide 8: Chapter 02 - Multi-Agent System
Slide 9: Chapter 02 - Multi-Agent System
Slide 10: Chapter 02 - Multi-Agent System
Slide 11: Chapter 02 - Multi-Agent System
Slide 13: Chapter 02 - Multi-Agent System
Slide 12: Chapter 02 - Multi-Agent System
Slide 13: Chapter 02 - Multi-Agent System
Slide 14: Chapter 02 - Multi-Agent System
Slide 15: Coordinator Workflow
Slide 16: Chapter 02 - Multi-Agent System
Slide 17: Chapter 02 - Multi-Agent System
Slide 18: Chapter 02 - Multi-Agent System
Slide 19: Chapter 02 - Multi-Agent System
Slide 20: Chapter 02 - Multi-Agent System
Slide 23: Key Terms
Slide 21: Chapter 02 - Multi-Agent System
Slide 25: See Also
Slide 26: qa
-->