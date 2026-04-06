# Chapter 1: Core Engine Layer - Presentation Script (逐字稿)
## ⏱️ Total Duration: ~60 minutes | 📑 26 Slides | 📝 ~9,000 words

### Core Source Files Referenced
* `src/QueryEngine.ts` → `QueryEngine` class: Session lifecycle and conversation state management
* `src/query.ts` → `query()` / `queryLoop()`: Main inference loop with streaming, tool execution, and recovery
* `src/query/stopHooks.ts` → `handleStopHooks()`: Post-sampling hook orchestration
* `src/query/tokenBudget.ts` → `createBudgetTracker()` / `checkTokenBudget()`: Token budget management
* `src/services/compact/autoCompact.ts` → `isAutoCompactEnabled()` / `calculateTokenWarningState()`: Auto-compaction triggers
* `src/utils/messages.ts` → Message creation utilities and synthetic message constants

---

### [00:00] Opening (Slide 1: Cover)

一个工业级AI编程助手，如何在60轮对话里保持工具调用不失控、Token预算不超支、上下文不爆炸？答案不在框架里，而在核心引擎的实现细节里。

今天我们要拆解的是一套在全球数十万开发者工作流中跑了无数轮的生产级推理引擎。它不是学术Demo，不是LangChain那样的通用框架，也不是OpenAI Assistants的托管API——它是一个完全本地执行、具备完整状态管理和分层恢复能力的专用引擎。

目标很明确：60分钟，从源码层面理解它的设计哲学。走过8个核心字段、7步主循环管线、9种终止条件、以及6层系统提示词架构。所有内容直接来自TypeScript源码——不是文档，文档往往落后于代码。

先抛出一个问题：为什么这个系统选择 **AsyncGenerator** 作为核心控制流原语，而不是LangChain的回调链或OpenAI Assistants的轮询模型？AsyncGenerator 像传送带——调用方消费的速度决定引擎生产的速度；回调链像流水线工人传纸条——每个工人完成后把结果喊给下一个人。两种模型都能跑，但传送带天然支持背压和优雅取消。带着这个问题开始。

---

### [03:00] Slide 2: Source Map - 4 Core Files

几百个文件的项目里，核心引擎层只涉及四个关键文件。它们的关系就是整个引擎的骨架。

**`src/QueryEngine.ts`** — 状态机的外壳。`QueryEngine` 类管理整个对话生命周期，持有所有跨Turn状态（消息历史、文件缓存、Token用量），通过 `submitMessage()` 暴露 AsyncGenerator 接口。QueryEngine 是发动机的外壳。

**`src/query.ts`** — 里面的气缸。`query()` 和内部的 `queryLoop()` 实现推理→工具执行→继续的迭代循环。处理API调用、流式事件、工具并发、错误恢复、自动压缩等所有运行时逻辑。

**`src/query/stopHooks.ts`** — `handleStopHooks()`。模型停止输出后，引擎不是直接返回结果——它执行一系列stop hooks：提取记忆、触发自动梦境分析、检查是否有未完成任务。

**`src/query/tokenBudget.ts`** — 完整的预算跟踪系统。不是简单的计数，而是支持 auto-continue 和预算超支告警。

调用链：QueryEngine 调用 `query()` → `queryLoop()` 循环推理 → 停止时调用 `handleStopHooks()` → 每轮迭代通过 `BudgetTracker` 检查预算。四者通过 AsyncGenerator 的 yield/next 协议通信，形成流式管线。

`QueryEngineConfig` 类型有22个配置字段，涵盖从工具定义、模型选择、权限模式到预算限制的一切。下面展开。

---

### [05:30] Slide 3: QueryEngine Class - 8 Fields + 1 Method

打开 `src/QueryEngine.ts` 第184行。8个私有字段，1个核心公开方法。

**8个字段：**

1. `private config: QueryEngineConfig` — 构造时注入，不可变引用。包含tools、commands、mcpClients、agents、canUseTool等外部依赖。QueryEngine 只读不改。

2. `private mutableMessages: Message[]` — 对话消息历史。"mutable" 前缀有意义——引擎中少数允许原地修改的状态之一。随对话增长，compact 操作时截断替换。

3. `private abortController: AbortController` — 用户中断处理。Ctrl+C 或 SDK 取消信号触发后，正在进行的 API 调用和工具执行被优雅终止。

4. `private permissionDenials: SDKPermissionDenial[]` — 权限拒绝累积列表。工具请求被拒绝时的记录，通过 SDK 事件传递给调用方。

5. `private totalUsage: NonNullableUsage` — 累计 API 用量（input/output tokens、cache creation/read tokens）。每次 API 调用后通过 `accumulateUsage()` 更新。

6. `private hasHandledOrphanedPermission` — 一次性标志。第一次 Turn 中处理上一次会话中断遗留的权限请求，处理完后设 true，避免重复。

7. `private readFileState: FileStateCache` — 文件状态缓存。跟踪文件修改时间和哈希值，检测工具执行期间文件是否被外部修改，保证文件编辑的原子性。

8. `private discoveredSkillNames: Set<string>` — 技能发现追踪。每个 Turn 开始时清空，记录本轮发现的技能，作为分析事件发送。

**核心方法：`submitMessage()`** — AsyncGenerator 函数，签名 `async *submitMessage(prompt, options)`。接受用户输入（字符串或 ContentBlockParam 数组），yield SDKMessage 事件序列。

选择 AsyncGenerator 而非 EventEmitter 的原因：调用方可通过 next() 推进、return() 取消、throw() 注入错误——类型安全的双向通道。回调链做不到这种优雅。

---

### [08:00] Slide 4: QueryEngineConfig - 22 Configuration Fields

`QueryEngineConfig` 定义在第130行，引擎的"控制面板"。按5组讲解。

**第一组：基础设施配置** — `cwd: string`（工作目录根路径），`tools: Tools`（Tool 对象列表，含名称、描述、参数 schema、执行函数），`commands: Command[]`（斜杠命令），`mcpClients: MCPServerConnection[]`（MCP 服务器连接），`agents: AgentDefinition[]`（可用 Agent 定义）。

**第二组：权限与安全** — `canUseTool: CanUseToolFn`（每次工具调用前的权限检查函数），`handleElicitation`（MCP 工具的 URL elicitation 处理器）。权限检查通过依赖注入由外部提供——交互式、非交互式、SDK 模式有不同的权限策略，引擎对权限策略本身无感知。

**第三组：模型与推理配置** — `userSpecifiedModel?: string`，`fallbackModel?: string`，`thinkingConfig?: ThinkingConfig`，`jsonSchema?: Record<string, unknown>`，`verbose?: boolean`。

**第四组：资源与预算** — `maxTurns?: number`（最大轮次），`maxBudgetUsd?: number`（最大美元花费），`taskBudget?: { total: number }`（API 层面任务预算）。三层防护网——任何一层触发即终止循环。

**第五组：状态与持久化** — `getAppState` / `setAppState`（应用状态读写函数），`initialMessages?: Message[]`（初始消息历史，用于会话恢复），`readFileCache: FileStateCache`，`replayUserMessages?: boolean`（是否重放用户消息），`snipReplay`（Snip 压缩的重放处理器）。

特别注意 `snipReplay`。注释写道："SDK-only: the REPL keeps full history for UI scrollback and projects on demand via projectSnippedView; QueryEngine truncates here to bound memory in long headless sessions"。SDK 模式和 REPL 模式对历史消息的内存管理策略完全不同。

与 LangChain 的配置对比：LangChain 通过 chain composition 分散配置；这里通过扁平配置对象集中管理。扁平配置的优势是可发现性好，开发者一眼看到所有可配置项。

---

### [10:30] Slide 5: Dual-Layer State Model - Session vs Turn

**Session 层**（会话层）由 QueryEngine 持有，整个对话生命周期持续存在：`mutableMessages`、`totalUsage`、`readFileState`、`permissionDenials`。生命周期 = QueryEngine 实例的生命周期。

**Turn 层**（轮次层）在每次 `submitMessage()` 调用时创建，结束后销毁：`startTime`、`wrappedCanUseTool`、`discoveredSkillNames`。临时状态，用完即弃。

为什么分层？一个 QueryEngine 实例在 SDK 模式下可能处理数百条用户消息。全 Session 级——状态管理复杂，每次 Turn 结束要手动清理。全 Turn 级——失去跨 Turn 持续性，消息历史必须每次外部注入。分层同时解决两个问题。

第三个好处：**可测试性**。Turn 层状态可通过 mock 控制，Session 层状态可通过构造函数注入初始值。比全局状态或单例干净得多。

`submitMessage()` 中的分层体现：

```
this.discoveredSkillNames.clear()  // Clear turn-scoped state
setCwd(cwd)                         // Set session-level cwd
const persistSession = !isSessionPersistenceDisabled()
const startTime = Date.now()        // Turn-scoped
```

类比：React 组件的 state 跨 render 持续存在（Session），hook 中的局部变量每次 render 重建（Turn）。

对比 OpenAI Assistants API——完全没有 Turn 概念，每个 Run 独立，状态通过 Thread 在服务端持久化。简单场景好用，但需要精细控制（自定义工具执行、本地文件缓存）时就力不从心了。

---

### [13:00] Slide 6: State Type - 10 Fields

query.ts 内部的 State 类型，定义在第204行，代表推理循环的完整运行时上下文。10个字段：

1. `messages: Message[]` — 当前位置的 Turn 消息列表。直接引用 QueryEngine 的 `mutableMessages`，修改会反映回去。

2. `toolUseContext: ToolUseContext` — 工具使用上下文。含 AbortController 引用、文件状态缓存、Agent 信息、系统提示词。工具执行时从中获取一切所需。

3. `autoCompactTracking: AutoCompactTrackingState | undefined` — 自动压缩跟踪。对话变长时自动触发压缩，将旧消息摘要化释放 Token 空间。

4. `maxOutputTokensRecoveryCount: number` — max_output_tokens 恢复计数。API 返回 max_output_tokens 错误时尝试恢复，不超过 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`（3次）。

5. `hasAttemptedReactiveCompact: boolean` — 是否尝试过响应式压缩。上下文过长导致 prompt_too_long 时尝试一次压缩，一次性标志——压缩后仍然过长就不再重试。

6. `maxOutputTokensOverride: number | undefined` — 输出 Token 上限覆盖值。恢复场景中临时提高到 `ESCALATED_MAX_TOKENS`，给模型更多空间完成输出。

7. `pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined` — 待处理的工具使用摘要。异步生成，工具执行完成后设置，下次循环迭代时 await。

8. `stopHookActive: boolean | undefined` — stop hook 互斥标志，防止重入调用。

9. `turnCount: number` — 当前轮次计数，与 `maxTurns` 比较实现轮次限制。

10. `transition: Continue | undefined` — 上一次迭代的转换原因。记录"为什么上次选择继续"，值包括 tool_use、max_output_tokens_recovery、budget_continuation 等。测试可精确断言恢复路径是否被触发，不需要检查消息内容。

设计原则：**状态的语义化命名**。每个字段名精确描述用途，不是泛化的 "data" 或 "context"。自文档性高。

---

### [15:30] Slide 7: Main Loop Pipeline - 7 Steps

`queryLoop()` 是引擎的心脏。AsyncGenerator 函数，内部 while(true) 循环。每次迭代执行7步。

**Step 1: 消息队列处理** — `getCommandsByMaxPriority()` 获取优先级最高的命令，插入消息列表。处理用户等待响应期间提交的新指令。

**Step 2: Token 预算检查** — `checkTokenBudget()` 前置守卫。在发起昂贵的 API 调用之前先检查是否还有预算，耗尽则返回 Terminal。

**Step 3: API 调用与流式接收** — 调用 API 进行推理，流式接收。每个 StreamEvent yield 出去，调用方实时处理。最耗时的步骤——网络延迟 + 模型推理。

**Step 4: 错误处理与恢复** — 判断错误类型：prompt_too_long → 响应式压缩；max_output_tokens → withhold-recover；网络错误 → 指数退避重试。

**Step 5: 工具执行** — `runTools()` 执行 tool_use 块。支持并发（独立工具同时运行）和串行（依赖关系按序执行）。

**Step 6: Stop Hooks** — `stop_reason` 为 end_turn 时，执行 `handleStopHooks()`：记忆提取、任务完成通知、idle hooks。若 hook 产生了新消息，循环继续。

**Step 7: 终止判断** — 综合所有条件：模型是否自行停止、工具是否还有待执行、轮次是否达限、预算是否耗尽，决定继续或返回 Terminal。

七步形成完整的状态机。对比 LangChain AgentExecutor 的推理-行动-观察三步，这里多了流式支持、错误恢复、Token预算等生产级特性。

每一步都通过 yield 与外部通信——调用方可在任何步骤获得实时反馈：API 调用中、工具执行中、压缩进行中。透明性对用户体验至关重要。

---

### [18:00] Slide 8: Streaming - StreamEvent Types

`src/types/message.ts` 定义 StreamEvent 联合类型。

`RequestStartEvent` — API 请求开始时触发，携带模型名称、缓存使用等元信息。调用方用来显示"正在思考..."。

`AssistantMessage` — 模型输出，含文本内容和可能的 tool_use 块。注意 `apiError` 字段：API 错误时不抛出异常，而是创建带 apiError 的 AssistantMessage，让错误处理在消息流中统一进行，不跳出流式管线。

`UserMessage` — 用户消息或工具执行结果。`SystemCompactBoundaryMessage` — 压缩边界。`TombstoneMessage` — 被删除的消息。`ToolUseSummaryMessage` — 工具使用摘要。

`isWithheldMaxOutputTokens()`（query.ts 第175行）实现**消息扣留**模式：检测到 max_output_tokens 错误时不立即 yield。因为引擎可能通过恢复循环继续生成——过早暴露错误消息，SDK 调用方可能终止会话，而实际上引擎还在运行。"先扣留，后决定"确保调用方看到的是最终结果，而非中间状态。

**背压控制**：AsyncGenerator 天然支持——调用方消费速度决定引擎 yield 速度。调用方处理慢，引擎自然暂停。对比 WebSocket 需要手动实现流控；SSE 是单向的，不支持背压。

类型设计遵循判别联合（Discriminated Union）——每个事件有 type 字段作为判别器。TypeScript 类型收窄可基于 type 精确推断具体类型，事件处理代码同时具备类型安全和可读性。

---

### [20:30] Slide 9: Tool Execution - Concurrent vs Sequential

`runTools()` 定义在 `src/services/tools/toolOrchestration.ts`。并发和串行两种模式。

并发模式：多个独立工具同时执行——同时读取三个不同文件，可并行，大幅减少等待时间。串行模式：有依赖关系的工具按序执行——先创建文件再编辑它。

引擎通过 `StreamingToolExecutor` 分析 tool_use 块的依赖关系，自动决定并发度。大多数情况下，模型一次响应返回的多个 tool_use 块通常是独立的——模型已通过自身推理能力确保独立性。所以**并发执行是默认行为**。

每次工具执行前经过权限检查：`canUseTool()` 被调用，传入工具名称、输入参数、工具使用上下文。权限检查可能阻塞（等待用户确认）或拒绝（返回错误消息给模型）。

结果通过 `ToolResultBlockParam` 封装，含 `tool_use_id`、`content`、`is_error`。组装成 UserMessage 注入消息历史，下次循环迭代中作为上下文提供给模型。

两个重要边界情况：

**工具执行超时** — Bash 命令运行过长，引擎需要取消。通过 AbortController 实现——每个工具绑定到当前 Turn 的 AbortController，Ctrl+C 触发 abort 信号，工具执行器捕获后返回中断消息。

**部分工具失败** — 三个工具调用中一个失败，引擎不中止整个轮次——将失败信息作为错误结果返回给模型，让模型自行决定。"容错继续"比"全部失败"更健壮。

`applyToolResultBudget()` 处理工具结果的大小限制。工具返回极长输出（如 10MB 日志文件），函数会截断或压缩，避免耗尽上下文窗口。生产环境中的高频问题。

---

### [23:00] Slide 10: Continue 1-3 - Context Management

Continue 类型定义在 `src/query/transitions.ts`。前三种与上下文管理相关。

**Continue 1: tool_use** — 最常见。模型返回 tool_use 块 → 执行工具 → 收集结果 → 继续推理。Agent 循环的基本驱动力。

**Continue 2: reactive_compact** — API 返回 prompt_too_long（通过 `isPromptTooLongMessage()` 检测）→ 响应式压缩。`buildPostCompactMessages()` 将旧消息摘要化，保留最近消息和系统提示词。`hasAttemptedReactiveCompact` 标志确保每轮只允许一次压缩。

**Continue 3: auto_compact** — 预防性机制。`calculateTokenWarningState()` 检查 Token 使用量是否接近上下文窗口限制，接近则 `isAutoCompactEnabled()` 返回 true，在下一次迭代前自动压缩。

三种 Continue 的层次：工具调用 = 正常流 → 模型请求信息，引擎提供；响应式压缩 = 应急处理 → 上下文已满，必须压缩；自动压缩 = 预防措施 → 上下文满之前主动压缩。

对比 LangChain ConversationBufferWindowMemory：LangChain 用简单窗口截断——保留最近 N 条，丢弃更早的。简单粗暴，丢失重要历史。此引擎的压缩策略更智能——通过 API 生成摘要保留关键信息，代价是一次额外的 API 调用，但在长对话场景下完全值得。

消息规范化通过 `normalizeMessagesForAPI()` 实现——每次 API 调用前将内部格式转换为 API 格式：剥离内部元数据、处理 thinking 块生命周期规则（query.ts 中那段关于"thinking rules"的注释），处理压缩边界标记。

---

### [25:30] Slide 11: Continue 4-5 - Token Management

**Continue 4: max_output_tokens_recovery** — withhold-recover 模式核心。模型输出被截断时不报错，尝试恢复：将截断输出保留在消息历史中 + 创建提示"你的输出被截断了，请继续" + 使用 `ESCALATED_MAX_TOKENS` 重新请求 + 模型从截断处接续。`maxOutputTokensRecoveryCount` 计数器确保不超过 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`（3次）。

为什么限制 3 次？连续 3 次都输出到上限，说明可能陷入重复模式——继续恢复只会浪费 Token。3 次是实践验证的平衡点。

**Continue 5: budget_continuation** — Token 预算续接。`createBudgetTracker()` / `checkTokenBudget()` 实现。模型一个 Turn 中使用大量 Token 后检查是否还有剩余预算，有则通过 `incrementBudgetContinuationCount()` 追踪续接次数。

`getCurrentTurnTokenBudget()` 和 `getTurnOutputTokens()` 是关键函数——前者返回当前 Turn 的 Token 预算（可能是全局预算减已使用量），后者返回当前 Turn 已使用的输出 Token 数。

三层预算，任何一层触发即停止：
1. `maxBudgetUsd` — 金额预算，通过 `getTotalCost()` 计算
2. `maxTurns` — 轮次预算，简单计数
3. `taskBudget.total` — API 层面的 Task 预算，通过 API 参数传递

对比 OpenAI Assistants API：只提供 max_prompt_tokens 和 max_completion_tokens，没有金额和轮次预算。在复杂 Agent 场景下，Token 数量很难精确预估——工具调用可能返回几百 Token 或几万 Token。金额预算是更直观、更安全的控制维度。

---

### [28:00] Slide 12: Continue 6-7 - Hooks & Budget

**Continue 6: stop_hook_continuation** — 模型停止时 `handleStopHooks()` 被调用。Stop hooks 可能产生新消息：记忆提取发现需要保存的知识，任务完成发现还有子任务未完成。若 hook 产生新消息（`blockingErrors` 不为空），循环继续，让模型处理。

`executeStopHooks()` 定义在 `src/utils/hooks.ts`，按优先级执行所有注册的 stop hooks。每个 hook 返回消息列表和 `preventContinuation` 标志。任何 hook 设置 `preventContinuation = true`，循环立即终止。

设计决策：stop hooks 在循环内部执行，而非外部。这样 hook 的结果直接注入消息历史，模型在下次迭代中可见。若在循环外部执行，需要额外的"消息注入"机制，增加复杂度。

**Continue 7: command_queue** — 用户驱动的继续原因。用户可在模型思考期间排队多个命令（斜杠命令）。循环每次迭代开头检查命令队列。队列中有命令时，即使模型已选择停止，循环也继续。

`getCommandsByMaxPriority()` 返回最高优先级命令，`removeFromQueue()` 消费后移除，`notifyCommandLifecycle()` 通知生命周期状态变化（started、completed）。

七种 Continue 的优先级：命令队列（用户主动） > 工具调用（模型请求） > 恢复（错误处理） > hook 续接（系统驱动） > 预算续接（资源管理）。

设计原则：**Continue 类型是穷尽的**。没有命中任何 Continue 原因就返回 Terminal——封闭世界假设，确保不会因遗漏条件而死循环。TypeScript 的穷尽检查在编译时确保这一点。

---

### [30:30] Slide 13: Termination Conditions - 9 Return Reasons

Terminal 类型定义所有终止原因。

1. **end_turn** — 模型自行决定停止。最正常的终止。

2. **max_turns** — `turnCount >= maxTurns` 时触发。默认值通常很大（~200），SDK 用户可设置更小值限制 Agent 运行深度。

3. **budget_exceeded** — Token 预算耗尽，BudgetTracker 检测。

4. **cost_exceeded** — 金额预算耗尽，`getTotalCost()` 与 `maxBudgetUsd` 比较。

5. **abort** — 用户中断，AbortController 触发，抛出 `AbortError`。

6. **prompt_too_long_unrecoverable** — 上下文过长且无法通过压缩恢复。已尝试 reactiveCompact 仍失败。

7. **max_output_tokens_unrecoverable** — 输出截断且恢复次数用尽。`maxOutputTokensRecoveryCount >= MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`。

8. **api_error** — API 返回不可重试错误，`categorizeRetryableAPIError()` 分类判断。

9. **fallback_triggered** — 主模型失败切换到备选模型，通过 `FallbackTriggeredError` 捕获。

9 种终止形成完整的终止条件矩阵。优先级：abort > 不可恢复错误（prompt_too_long、max_output_tokens） > 预算限制（budget、cost、turns） > 正常停止（end_turn）。

可观测性：每种终止原因通过 `logEvent()` 记录为分析事件。开发团队可统计分布——如大量会话因 prompt_too_long 终止，说明自动压缩的触发阈值需要调低。

对比 Erlang 的"let it crash"哲学：Erlang 允许进程崩溃依赖 supervisor 重启；此引擎倾向尽可能恢复，只有确定无法恢复时才终止。更适合 AI Agent 场景——用户不希望长时间运行的编程任务因临时错误完全终止。

---

### [33:00] Slide 14: Withhold-Recover - Seamless Recovery

withhold-recover 是引擎最精妙的恢复机制之一。

问题场景：模型生成长代码，突然达到 max_output_tokens 限制被截断。直接返回不完整代码是糟糕体验。

`isWithheldMaxOutputTokens()`（query.ts 第175行）检测 `apiError === 'max_output_tokens'`。命中则消息"扣留"，不 yield 给调用方。

扣留后检查 `maxOutputTokensRecoveryCount`，未达限制则进入恢复循环：
1. 截断输出保留在消息历史中（模型需看到之前说了什么）
2. 创建新系统消息："你的输出被截断了，请继续"
3. 使用 `ESCALATED_MAX_TOKENS` 重新发起请求
4. 模型从截断处接续

对调用方**完全透明**——只看到最终完整输出，不感知中间发生了恢复。这就是"无感恢复"。

注释中的关键考量："Yielding early leaks an intermediate error to SDK callers (e.g. cowork/desktop) that terminate the session on any error field"。桌面客户端可能弹出错误对话框终止会话，而实际上引擎在正常恢复中。

与 reactiveCompact 模块中 `isWithheldPromptTooLong` 对比——两者遵循同一"扣留-判断-恢复/释放"模式，处理不同类型错误。模式可复用，未来新可恢复错误类型可用同样方式处理。

恢复上限 3 次：每次恢复至少消耗一次完整的 API 调用（包括所有上下文的重新计费），3 次 = 最多 4 倍正常成本。成本与体验的平衡。实践中大多数截断在 1-2 次内完成。

---

### [35:30] Slide 15: System Prompt - 6-Layer Priority

系统提示词不是简单字符串——6层不同优先级组合。

**第1层：基础系统提示词** — 引擎内置默认提示词，定义基本身份、能力和行为约束。`fetchSystemPromptParts()` 在 QueryEngine 中获取。

**第2层：自定义系统提示词**（`customSystemPrompt`） — 通过 QueryEngineConfig 注入，语义是**替换**基础提示词。

**第3层：追加系统提示词**（`appendSystemPrompt`） — 同样通过 config 注入，语义是**追加**到基础提示词之后。最常用的自定义方式。

**第4层：用户上下文**（`userContext`） — `prependUserContext()` 注入。包含工作目录、环境变量、用户偏好。Coordinator 模式下含 Worker 工具列表和 Scratchpad 路径（`getCoordinatorUserContext()`）。

**第5层：系统上下文**（`systemContext`） — `appendSystemContext()` 注入。运行时信息：当前时间、平台信息等。

**第6层：记忆上下文** — `loadMemoryPrompt()` 加载。CLAUDE.md 内容、项目级记忆、自动提取的记忆。

`asSystemPrompt()` 将所有层合并成最终 SystemPrompt 对象。高优先级层覆盖低优先级层。

对比 OpenAI system message：OpenAI 只支持一个 system message，所有自定义内容手动拼接。没有优先级、没有自动注入层。6 层架构的优势：每层关注点分离，每层可独立更新。

实际例子：用户设置了 `customSystemPrompt` 但忘记包含工具使用指令——第 4 层和第 5 层自动补充必要上下文。这种"默认智能"减少用户出错。

---

### [38:00] Slide 16: vs LangChain - 5 Dimensions

**维度1：控制流原语** — LangChain 用 Callbacks 和 LCEL（LangChain Expression Language）声明式管道 DSL。此引擎用 AsyncGenerator。LCEL 适合简单线性管道，需要条件分支/循环/错误恢复时，命令式 AsyncGenerator 更灵活。

**维度2：状态管理** — LangChain 通过 Memory 类（ConversationBufferMemory / ConversationSummaryMemory）管理状态，状态与执行逻辑分离。此引擎将状态内嵌在 QueryEngine 类和 State 类型中，紧耦合。LangChain 更灵活，此引擎性能更好（减少序列化/反序列化），类型更安全。

**维度3：工具执行** — LangChain 完全同步，一次一个工具。此引擎支持并发工具执行。大量文件读取场景中，并发可将延迟减少 50% 以上。

**维度4：错误恢复** — LangChain 默认抛出异常，调用方自己实现重试。此引擎内置分层恢复（withhold-recover、reactive compact、fallback model）。框架提供扩展点，产品提供完整解决方案。

**维度5：流式支持** — LangChain 通过 Callback 实现流式，触发时机和顺序难精确控制。此引擎通过 AsyncGenerator 提供结构化流式事件，每个事件有明确类型和语义。SDK 场景下后者的优势是决定性的。

总结：LangChain 是通用框架，适合快速原型和简单 Agent；此引擎是专用产品引擎，为编程辅助场景深度优化。

---

### [40:30] Slide 17: vs OpenAI Assistants API - 5 Dimensions

**维度1：执行位置** — OpenAI Assistants 服务端执行工具（Code Interpreter / File Search），本地工具通过 Function Calling 回调。此引擎完全本地执行——所有工具（Bash、文件操作、MCP）在用户机器上运行。本地执行：零延迟、完全控制。

**维度2：会话模型** — OpenAI 用 Thread+Run 模型，Thread 持久化在服务端，每个 Run 独立。此引擎用 QueryEngine 实例作为会话容器，状态进程内管理。OpenAI 适合无状态服务端应用，此引擎适合有状态本地 CLI。

**维度3：上下文管理** — OpenAI 的 truncation_strategy 有 simple 和 auto。此引擎：自动压缩（带摘要生成）、响应式压缩、Token 预算续接、Snip 压缩。层次更多，控制更精细。

**维度4：工具定义** — OpenAI 通过 JSON Schema。此引擎也用 JSON Schema（Zod），但额外支持 MCP 工具（动态发现）和 Agent 工具（嵌套 Agent）。可组合性更强。

**维度5：可观测性** — OpenAI 通过 Run Steps API，粒度较粗（每个 Step 是一个工具调用）。此引擎通过 StreamEvent ——每个 Token 生成、每个工具执行状态、每个恢复操作。调试复杂 Agent 行为时，细粒度至关重要。

哲学差异：OpenAI "托管优先"——最少基础设施管理。此引擎"本地优先"——最大控制权。专业开发者通常偏爱后者——需要调试、定制和集成到工作流。

---

### [43:00] Slide 18: Design Rationale - 3 Whys

三个核心设计决策。

**为什么选 AsyncGenerator 而非 EventEmitter？**
`async *submitMessage(...): AsyncGenerator<SDKMessage, void, unknown>` 提供三个 EventEmitter 不具备的特性：1）类型安全的 yield 类型——TypeScript 编译时检查每个 yield 值是否符合 SDKMessage；2）自然的背压控制——消费者处理速度控制生产者 yield 速度；3）Generator 的 return() 和 throw() 提供优雅取消和错误注入。EventEmitter 需要额外模式和约定才能实现这三个。

**为什么 mutableMessages 是共享引用而非拷贝？**
State 的 `messages` 直接引用 QueryEngine 的 `mutableMessages`，query() 的修改立即反映回去。在 60 轮对话中消息列表可能包含数千个对象，每次修改都创建新数组会产生大量 GC 压力。共享引用是性能优化——代价是需小心管理并发，但查询循环是单线程的（JS 事件循环保证），并发风险不存在。

**为什么权限检查通过依赖注入而非硬编码？**
`canUseTool: CanUseToolFn` 是函数参数。源码中 `wrappedCanUseTool` 进一步封装，添加权限拒绝追踪。权限策略在不同模式完全不同：交互式需弹出确认框，非交互式 SDK 按权限规则自动决策，Coordinator 下 Worker Agent 的权限由 Coordinator 配置。硬编码需要大量 if-else——依赖注入让引擎对权限策略完全无感，只需"调用 canUseTool()，等待结果"。依赖倒置原则的经典应用。

共同主题：**在性能、灵活性和类型安全之间寻找最佳平衡**。不是教科书式设计——是基于实际场景的 pragmatic 决策。

两个附加关注点：`feature()` 做功能门控支持 tree-shaking——flag 为 false 时相关代码构建时完全移除。工具摘要是异步的（`pendingToolUseSummary: Promise<...>`）——摘要生成需 API 调用，异步化避免阻塞主循环。

---

### [46:00] Slide 19: Edge Cases - 3 Extreme Scenarios

生产环境的真实问题。

**场景1：Thinking Block 生命周期规则。** query.ts 第152-163 行以"年轻的巫师"口吻写成的注释定义三条规则：1）含 thinking 块的消息必须属于 max_thinking_length > 0 的查询；2）thinking 块不能是消息最后一个块；3）thinking 块必须在整个 assistant trajectory 期间被保留。违反任一规则 → API 报错。

在压缩操作中旧消息被移除或替换。如不小心移除含 thinking 块的消息但保留后续 tool_result，违反规则3。引擎在压缩时特别处理 thinking 块——要么完整保留含 thinking 块的 trajectory，要么完整移除。`stripSignatureBlocks()` 处理这种情况。

**场景2：Orphaned Permission（孤儿权限请求）。** 会话在权限确认对话框弹出时被中断（进程崩溃），权限请求变成"孤儿"——既没批准也没拒绝。恢复时 `handleOrphanedPermission()` 处理遗留请求。`hasHandledOrphanedPermission` 标志确保只执行一次。

微妙之处：恢复时的上下文可能与中断时不同（文件可能已被修改）。引擎不能简单"重放"权限请求——需重新评估上下文，决定是否仍需要这个权限。

**场景3：消息缺失的 tool_result 块。** `yieldMissingToolResultBlocks()`（query.ts 第123行）处理：API 调用被中断时，可能已 yield 了含 tool_use 块的 AssistantMessage，但还没执行工具。API 要求每个 tool_use 块必须有对应 tool_result——否则后续调用报错。该函数为每个"悬空"的 tool_use 块生成错误 tool_result，保持消息历史一致性。

共同点：**状态一致性**。AI 引擎有复杂状态依赖——消息历史必须符合 API 格式、权限状态必须与 UI 同步、thinking 块必须遵循生命周期规则。任一不一致导致后续失败。引擎处理这些边界情况保证各种异常情况下的状态一致性。

---

### [49:00] Slide 20: Constants Quick Reference - 7 Key Values

7 个关键常量，调试和配置时常用。

1. `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` — query.ts 第164行。max_output_tokens 恢复最大尝试次数。

2. `ESCALATED_MAX_TOKENS` — 恢复时使用的提升后输出上限。从 `src/utils/context.ts` 导入，通常是默认值的 2-4 倍。

3. `EMPTY_USAGE` — 空用量对象，从 `src/services/api/logging.ts` 导入。初始化 `totalUsage` 字段，避免 null 检查。

4. `PROMPT_TOO_LONG_ERROR_MESSAGE` — 上下文过长错误消息，从 `src/services/api/errors.ts` 导入。用于匹配 API 返回的错误类型。

5. `SYNTHETIC_OUTPUT_TOOL_NAME` — 合成输出工具名。将结构化输出包装成工具调用形式，符合 API 消息格式要求。

6. `LOCAL_COMMAND_STDOUT_TAG` / `LOCAL_COMMAND_STDERR_TAG` — 本地命令输出的 XML 标签，区分 stdout 和 stderr。从 `src/constants/xml.ts` 导入。

7. `READ_FILE_STATE_CACHE_SIZE` — 文件状态缓存大小，从 `src/utils/fileStateCache.ts` 导入。控制同时缓存多少文件的状态信息。

这些常量定义在与其功能最相关的模块中——`PROMPT_TOO_LONG_ERROR_MESSAGE` 在 errors 模块而非 query 模块，因为它描述的是错误，不是查询逻辑。

调试时这些常量是"锚点"。会话在 3 次恢复后终止 → 搜索 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` 定位代码。Token 用量为 0 → 检查是否被初始化为 `EMPTY_USAGE`。常量是导航大型代码库的路标。

`SLEEP_TOOL_NAME` —— 特殊工具，模型可调用它"等待"（如监控场景定期检查状态）。循环中有特殊处理——不算作"工具调用"轮次，避免误触发 maxTurns 限制。

---

### [52:00] Slide 21: Summary - 5 Takeaways

5 个关键 takeaway。

**Takeaway 1：AsyncGenerator 是核心控制流原语。** 传送带模式——消费速度决定生产速度，天然支持背压和优雅取消。不仅是技术选择，更定义了整个引擎的通信模型。

**Takeaway 2：双层状态模型（Session vs Turn）是架构基石。** Session 层持长期状态（消息历史、累计用量），Turn 层管临时状态（恢复计数器、stop hook 标志）。分层避免状态泄漏和生命周期混乱。

**Takeaway 3：分层恢复是生产级引擎标配。** withhold-recover 处理输出截断，reactive compact 处理上下文过长，fallback model 处理主模型不可用。每层恢复有明确的触发条件、执行策略和上限控制。

**Takeaway 4：7步管线 + 9种终止条件 = 完备的推理循环。** 不是简单的 while(true)——是精密的状态机，每步有明确的进入和退出条件。穷举式的 Continue/Terminal 类型确保编译时完备性检查。

**Takeaway 5：依赖注入是处理多模式运行的最佳策略。** 权限检查、工具定义、MCP 连接、Agent 定义——所有外部依赖通过 QueryEngineConfig 注入。同一引擎在交互式 CLI、非交互式 SDK、Coordinator 模式下无缝运行。

一句话概括设计哲学：**在复杂性不可避免的场景中，通过类型系统和结构化分层来驯服复杂性。** 不是消除复杂性——AI Agent 本身是复杂的——而是让复杂性变得可管理、可测试、可观测。

---

### [55:00] Slide 22: Q&A

最后 5 分钟 Q&A。先抛三个值得深入讨论的方向。

**方向1：feature flag 的 tree-shaking 策略。** 源码中大量使用 `feature('XXX')`。flag 为 false 时 `require()` 不执行，模块不加载。构建时优化——Bun bundler 可识别此模式并完全剪除死代码。比运行时 if-else 高效，但也容易出 bug——忘记在某处加 feature gate 就会在某些构建配置下出现运行时错误。

**方向2：Snip Compact 的设计。** 与普通压缩不同——不在消息历史中摘要化旧消息，而是在历史中插入"截断标记"，每次 API 调用时只发送标记后的消息。更轻量级的上下文管理，特别适合长时间运行的 SDK 会话。

**方向3：QueryEngine 能否完全替代 REPL 中的 ask() 函数。** 源码注释提到 "in a future phase"——目前 QueryEngine 主要服务 SDK 路径，REPL 仍用自己的循环。完全统一是长期目标。REPL 需要处理大量 UI 逻辑（进度条、语法高亮、快捷键），在 QueryEngine 的抽象层中难优雅表达。

好，开放提问。

<!-- 
AUTO-GENERATED SLIDE SYNC REFERENCE
Please ensure your script.md contains the following headers:
Slide 01: cover
Slide 02: Learning Objectives
Slide 2: CHAPTER 01 | CORE ENGINE
Slide 3: CHAPTER 01 | CORE ENGINE
Slide 05: Code Walkthrough
Slide 4: CHAPTER 01 | CORE ENGINE
Slide 5: CHAPTER 01 | CORE ENGINE
Slide 6: CHAPTER 01 | CORE ENGINE
Slide 07: Main Loop Pipeline
Slide 8: CHAPTER 01 | CORE ENGINE
Slide 9: CHAPTER 01 | CORE ENGINE
Slide 10: CHAPTER 01 | CORE ENGINE
Slide 11: CHAPTER 01 | CORE ENGINE
Slide 12: CHAPTER 01 | CORE ENGINE
Slide 13: CHAPTER 01 | CORE ENGINE
Slide 14: CHAPTER 01 | CORE ENGINE
Slide 15: CHAPTER 01 | CORE ENGINE
Slide 16: CHAPTER 01 | CORE ENGINE
Slide 17: CHAPTER 01 | CORE ENGINE
Slide 18: CHAPTER 01 | CORE ENGINE
Slide 19: CHAPTER 01 | CORE ENGINE
Slide 20: CHAPTER 01 | CORE ENGINE
Slide 23: Key Terms
Slide 21: CHAPTER 01 | CORE ENGINE
Slide 25: See Also
Slide 26: qa
-->