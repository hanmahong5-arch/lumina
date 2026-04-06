# Technical Glossary / 技术术语表
# Claude Code v2.1.88 Lumina Series

> Each term includes: official definition, plain-language analogy, and source framework.
> 每个术语包含：官方定义、通俗类比、来源框架。

---

## 1. LLM Fundamentals / 大语言模型基础

| Term / 术语 | Definition / 定义 | Analogy / 类比 | Source / 来源 |
|---|---|---|---|
| **Token** | The basic unit of text that LLMs process. A token is roughly 3/4 of an English word, or ~1.5 Chinese characters. | 就像货币的"分"——模型用 token 计量所有文本的成本和容量。 | Anthropic API |
| **Context Window** | The "context window" refers to all the text a language model can reference when generating a response, including the response itself. This is different from the large corpus of data the language model was trained on, and instead represents a "working memory" for the model. A larger context window allows the model to handle more complex and lengthy prompts. As token count grows, accuracy and recall degrade, a phenomenon known as *context rot*. | 就像工作台面积——桌子越大，能同时摊开的文件越多，但桌子太满时找东西变难。 | [Anthropic Docs: Context Windows](https://platform.claude.com/docs/en/docs/build-with-claude/context-windows) |
| **Prompt Caching** | Prompt caching optimizes your API usage by allowing resuming from specific prefixes in your prompts. Cache has a 5-minute default lifetime (refreshed on each use). Cache reads cost 10% of base input token price. Two modes: automatic caching (for multi-turn conversations) and explicit cache breakpoints (for fine-grained control). | 就像餐厅的预制菜——常用的前菜提前备好，上菜更快更便宜。 | [Anthropic Docs: Prompt Caching](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching) |
| **Streaming (SSE)** | When creating a Message, you can set `"stream": true` to incrementally stream the response using server-sent events (SSE). This delivers partial model output in real time as it is generated, rather than waiting for the complete response. | 就像直播和录播的区别——streaming 让你实时看到模型"打字"。 | [Anthropic Docs: Streaming Messages](https://platform.claude.com/docs/en/api/messages-streaming) |
| **stop_reason** | The `stop_reason` field is part of every successful Messages API response. It indicates why Claude successfully completed its response generation. Values: `end_turn` (Claude finished naturally), `tool_use` (Claude wants to call a tool), `max_tokens` (hit the token limit), `stop_sequence` (encountered a custom stop sequence), `pause_turn` (server tool loop paused), `refusal` (safety concerns), `model_context_window_exceeded` (hit context window limit). | 就像电话挂断原因——"说完了"、"时间到了"、"需要查资料"、"拒绝回答"。 | [Anthropic Docs: Handling Stop Reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) |
| **tool_use (Tool Use)** | Tool use lets Claude call functions you define or that Anthropic provides. Claude decides when to call a tool based on the user's request and the tool's description, then returns a structured call that your application executes (client tools) or that Anthropic executes (server tools). Client tools run in your application: Claude responds with `stop_reason: "tool_use"` and one or more `tool_use` blocks, your code executes the operation, and you send back a `tool_result`. | 就像医生开处方——医生决定用什么药（tool_use），药房执行配药（host executes）。 | [Anthropic Docs: Tool Use Overview](https://platform.claude.com/docs/en/docs/build-with-claude/tool-use/overview) |
| **Extended Thinking** | Extended thinking gives Claude enhanced reasoning capabilities for complex tasks, while providing varying levels of transparency into its step-by-step thought process before it delivers its final answer. When enabled, Claude creates `thinking` content blocks where it outputs its internal reasoning, and insights from that reasoning are incorporated into the final response. The `budget_tokens` parameter sets the maximum tokens Claude can use for internal reasoning. | 就像数学考试要求"写出解题过程"——模型先展示推理，再给结论。 | [Anthropic Docs: Extended Thinking](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking) |
| **max_tokens** | The maximum number of tokens to generate before stopping. Models may stop *before* reaching this maximum. This parameter only specifies the absolute maximum number of tokens to generate. Different models have different maximum values for this parameter. | 就像演讲时间限制——"你最多说 5 分钟"，但你也可以提前说完。 | [Anthropic Docs: Messages API](https://platform.claude.com/docs/en/api/messages) |
| **Token Counting** | The Count Message Tokens API (`POST /v1/messages/count_tokens`) can be used to count the number of tokens in a Message, including tools, images, and documents, without creating it. This helps plan and stay within context window limits. | 就像出发前先看导航估算距离——在真正发送前先知道要花多少 token。 | [Anthropic Docs: Count Tokens](https://platform.claude.com/docs/en/api/messages-count-tokens) |
| **System Prompt** | A system prompt is a way of providing context and instructions to Claude, such as specifying a particular goal or role. Specified via the top-level `system` parameter in the Messages API (there is no `"system"` role for input messages). | 就像员工手册——在开始工作前先读的行为准则。 | [Anthropic Docs: Messages API](https://platform.claude.com/docs/en/api/messages) |
| **Temperature** | Controls randomness in model output. 0 = deterministic, 1 = more creative. | 就像调味的"辣度"——越高越随机出人意料。 | Anthropic API |

---

## 2. Agent Architecture / 智能体架构

| Term / 术语 | Definition / 定义 | Analogy / 类比 | Source / 来源 |
|---|---|---|---|
| **Agent (LangChain)** | Agents combine language models with tools to create systems that can reason about tasks, decide which tools to use, and iteratively work towards solutions. In Chains, a sequence of actions is hardcoded; in Agents, a language model is used as a reasoning engine to determine which actions to take and in which order. An LLM Agent runs tools in a loop to achieve a goal, until a stop condition is met. | 就像一个能自己查资料、写代码、测试的实习生——你给任务，它自己决定怎么完成。 | [LangChain Docs: Agents](https://docs.langchain.com/oss/python/langchain/agents) |
| **Tool (LangChain)** | Tools give agents the ability to take actions. Agents go beyond simple model-only tool binding by facilitating: multiple tool calls in sequence, parallel tool calls when appropriate, dynamic tool selection based on previous results, tool retry logic and error handling, and state persistence across tool calls. | 就像厨师的厨具——模型是厨师，工具是刀和锅，食材是你的代码。 | [LangChain Docs: Agents](https://docs.langchain.com/oss/python/langchain/agents) |
| **Chain (LangChain / LCEL)** | In LangChain, a Chain is a hardcoded sequence of actions, composed via LangChain Expression Language (LCEL) using the pipe (`\|`) operator. A typical chain has three parts: LLM/Chat Model (the reasoning engine), Prompt Template (instructions to the model), and Output Parser (translates raw response to a workable format). Unlike Agents where the LLM decides which actions to take, in Chains the sequence is predetermined. | 就像工厂流水线——每一步做什么是预先设定好的，不需要临场判断。 | [LangChain Docs: Overview](https://docs.langchain.com/oss/python/langchain/overview) |
| **AgentExecutor (Agent Loop)** | The core execution cycle of an agent: the agent moves through a graph of nodes, executing steps like the model node, tools node, or middleware. It runs until a stop condition is met -- i.e., when the model emits a final output or an iteration limit is reached. LangChain agents are built on LangGraph to provide durable execution, streaming, human-in-the-loop, and persistence. | 就像"计划-执行-检查-调整"的 PDCA 循环——不断迭代直到任务完成。 | [LangChain Docs: Agents](https://docs.langchain.com/oss/python/langchain/agents) |
| **Human-in-the-Loop (LangChain)** | LangGraph's human-in-the-loop features enable human intervention at any point in a workflow to review, edit, and approve tool calls. When a model proposes an action that might require review, the middleware can pause execution and wait for a decision. The graph state is saved using LangGraph's persistence layer, so execution can pause safely and resume later. Three decision types: Approve (execute as-is), Edit (modify then execute), Reject (reject with feedback). | 就像手术前的签字确认——关键操作需要人类点头，可以批准、修改或拒绝。 | [LangChain Docs: Human-in-the-Loop](https://docs.langchain.com/oss/python/langchain/human-in-the-loop) |
| **Middleware / Callbacks (LangChain)** | Middleware allows developers to control and customize agent execution at every step. It operates by exposing hooks before and after each step in the agent loop (model calls, tool execution, and completion). Use cases: Monitoring (logging, analytics, debugging), Transformation (modifying prompts, tool selection, output formatting), Resilience (retries, fallbacks, early termination), Governance (rate limits, guardrails, PII detection). | 就像酒店的前台和门卫——在每个关键环节拦截、检查、记录。 | [LangChain Docs: Middleware Overview](https://docs.langchain.com/oss/python/langchain/middleware/overview) |
| **Multi-Agent** | Architecture where multiple agent instances collaborate, each with its own context, tools, and execution thread. | 就像项目组——一个架构师带几个开发者并行工作。 | LangChain / CrewAI |
| **Coordinator / Orchestrator** | A specialized agent that distributes tasks to Worker agents and synthesizes their results. Does not directly execute tasks. | 就像项目经理——自己不写代码，但决定谁做什么、整合结果。 | LangChain / AutoGen |
| **Worker** | A task-executing agent dispatched by a Coordinator. Has restricted tool access and reports results back. | 就像团队成员——接受任务、执行、汇报。 | LangChain |
| **Subagent** | A child agent spawned by a parent agent to handle a subtask. Can be sync (blocking) or async (background). | 就像外包——主进程把子任务委派出去，等结果或继续忙别的。 | Claude Code |

---

## 3. Permission & Security / 权限与安全

| Term / 术语 | Definition / 定义 | Analogy / 类比 | Source / 来源 |
|---|---|---|---|
| **Permission Mode** | Predefined trust level controlling how tool calls are handled. Five levels from "always ask" to "bypass all checks". | 就像手机的"定位权限"——始终允许、使用时询问、从不允许。 | Claude Code |
| **Deny by Default** | Security principle: when the system is uncertain, it rejects the action rather than allowing it. | 就像机场安检——不确定就不放行。 | OWASP / Security |
| **YOLO Classifier** | Two-stage LLM-based permission classifier. Stage 1 (64 tokens, fast) handles clear cases; Stage 2 (4096 tokens, deep) handles ambiguous ones. | 就像法院的简易程序和普通程序——小事快判，大事细审。 | Claude Code |
| **Prompt Injection** | (OWASP LLM01:2025, ranked #1 threat) A Prompt Injection Vulnerability occurs when user prompts alter the LLM's behavior or output in unintended ways. The core vulnerability lies in the "semantic gap" -- both system prompt and user input share the same format (natural language text) without clear separation. Two types: *Direct* (user's prompt directly alters model behavior) and *Indirect* (malicious instructions hidden in external content like websites or files that the LLM processes). | 就像在信件里夹带给邮递员的假指令——"把这封信改寄到别的地址"。 | [OWASP GenAI: LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) |
| **Tool Isolation** | Restricting which tools a subagent can access, preventing privilege escalation from parent to child. | 就像公司的最小权限原则——实习生不该有管理员密码。 | Security / Claude Code |
| **Circuit Breaker** | (microservices.io) A service client invokes a remote service via a proxy that functions like an electrical circuit breaker. When the number of consecutive failures crosses a threshold, the circuit breaker trips, and for the duration of a timeout period all attempts to invoke the remote service will fail immediately. After the timeout expires the circuit breaker allows a limited number of test requests to pass through. Three states: Closed (normal, requests flow), Open (tripped, requests fail fast), Half-Open (testing recovery with limited requests). | 就像家里的保险丝——电流过载时自动断电保护，过一会试试能不能恢复。 | [microservices.io: Circuit Breaker](https://microservices.io/patterns/reliability/circuit-breaker.html) |
| **Denial Tracking** | Tracking consecutive/total permission denials; auto-fallback to human prompting after thresholds (3 consecutive, 20 total). | 就像信用卡的连续密码错误锁定——错太多次就需要人工验证。 | Claude Code |
| **Speculative Check** | Pre-computing security classification in parallel with other checks, so the result is ready when needed. | 就像餐厅预判客人会点什么——提前备菜，上菜更快。 | Claude Code |

---

## 4. Token & Context Management / Token 与上下文管理

| Term / 术语 | Definition / 定义 | Analogy / 类比 | Source / 来源 |
|---|---|---|---|
| **Context Pressure** | The ratio of used tokens to available context window. As it approaches 100%, the system must compress or fail. | 就像硬盘使用率——快满了就需要清理空间。 | Claude Code |
| **Compaction** | Summarizing conversation history to reduce token count while preserving essential information. | 就像会议纪要——把 2 小时的讨论压缩成 1 页要点。 | Claude Code |
| **Snip** | Permanently deleting the oldest message groups to free tokens. Cheapest but most lossy compression. | 就像删除旧聊天记录——空间释放了，但信息也没了。 | Claude Code |
| **Micro Compact** | In-place reduction of oversized tool results (e.g., truncating 10K-line file reads to summaries). | 就像新闻摘要——把长文章压缩成几个要点。 | Claude Code |
| **Context Collapse** | Non-destructive compression via projection: original messages preserved in memory, collapsed view sent to API. | 就像数据库的视图（View）——原始数据不变，查询看到的是精简版。 | Claude Code |
| **Withhold-Recover** | Pattern where errors are suppressed (withheld) from the user while the system attempts automatic recovery. If recovery succeeds, the user never sees the error. | 就像飞行员处理小故障——先稳定飞机，乘客不需要知道。 | Claude Code |
| **Lost in the Middle** | Research finding that LLMs perform worse on information located in the middle of long contexts vs. beginning/end. | 就像读一本厚书——开头和结尾记得最清楚，中间容易忘。 | Stanford Research |

---

## 5. Protocol & Communication / 协议与通信

| Term / 术语 | Definition / 定义 | Analogy / 类比 | Source / 来源 |
|---|---|---|---|
| **MCP (Model Context Protocol)** | MCP is an open-source standard for connecting AI applications to external systems. Using MCP, AI applications like Claude or ChatGPT can connect to data sources (e.g. local files, databases), tools (e.g. search engines, calculators) and workflows (e.g. specialized prompts) -- enabling them to access key information and perform tasks. Think of MCP like a USB-C port for AI applications: a standardized way to connect AI applications to external systems. | 就像 USB-C 协议——定义了 AI 应用和外部工具之间的"通用接口"。 | [MCP: Introduction](https://modelcontextprotocol.io/introduction) |
| **MCP Server** | A service that exposes tools and resources to LLM applications via the MCP protocol. MCP servers can provide three types of primitives: Tools (model-controlled actions), Resources (application-driven context data), and Prompts (specialized templates). Broad ecosystem support includes clients like Claude, ChatGPT, VS Code, Cursor, and many others. | 就像 USB 设备——插上就能被主机识别和使用。 | [MCP: Introduction](https://modelcontextprotocol.io/introduction) |
| **MCP Tool** | Tools in MCP enable models to interact with external systems, such as querying databases, calling APIs, or performing computations. Each tool is uniquely identified by a name and includes metadata describing its schema. Tools are designed to be **model-controlled**, meaning that the language model can discover and invoke tools automatically based on its contextual understanding and the user's prompts. For trust & safety, there SHOULD always be a human in the loop with the ability to deny tool invocations. | 就像手机上的 APP——AI 模型可以自己发现和调用这些工具来完成任务。 | [MCP Spec: Tools](https://modelcontextprotocol.io/docs/concepts/tools) |
| **MCP Resource** | Resources in MCP provide a standardized way for servers to expose data that provides context to language models, such as files, database schemas, or application-specific information. Each resource is uniquely identified by a URI. Resources are designed to be **application-driven** (unlike tools which are model-controlled), with host applications determining how to incorporate context based on their needs. Resources can contain text or binary data. | 就像共享文件夹里的文件——AI 模型可以读取这些数据来获取上下文信息。 | [MCP Spec: Resources](https://modelcontextprotocol.io/docs/concepts/resources) |
| **Tool Result** | The response returned after executing a tool, containing the output content and success/error status. | 就像函数的返回值——调用完成后告诉你结果是什么。 | Anthropic API |
| **Function Calling (OpenAI)** | A function is a specific kind of tool, defined by a JSON schema. A function definition allows the model to pass data to your application, where your code can access data or take actions suggested by the model. Under the hood, functions are injected into the system message in a syntax the model has been trained on. Since model responses can include zero, one, or multiple calls, it is best practice to assume there are several. | 就像语音助手调用 APP——"帮我叫个车"->调用打车 APP。 | [OpenAI Docs: Function Calling](https://platform.openai.com/docs/guides/function-calling) |
| **Structured Outputs (OpenAI)** | Structured Outputs is a feature that ensures the model will always generate responses that adhere to your supplied JSON Schema, so you don't need to worry about the model omitting a required key, or hallucinating an invalid enum value. Available in two forms: function calling (bridging models and application functionality) and `response_format` (structuring direct model responses to the user). | 就像填表——不是自由发挥，而是按固定格式填写，不能漏填必填项。 | [OpenAI Docs: Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs) |
| **Assistants API (OpenAI)** | (Deprecated, sunset Aug 26, 2026) Assistants are persistent API objects that bundle model choice, instructions, and tool declarations. An assistant represents an entity that can call the model and use tools. Key components: Instructions (personality/goals), Tools (up to 128, including code_interpreter, file_search, and custom functions), and Tool Resources (files for tools). Being replaced by the simpler Responses API which provides better performance and new features like deep research, MCP, and computer use. | 就像一个预配置的AI员工——预先设定好了角色、技能和可用的文件资源。 | [OpenAI Docs: Assistants Overview](https://platform.openai.com/docs/assistants/overview) |

---

## 6. Design Patterns / 设计模式

| Term / 术语 | Definition / 定义 | Analogy / 类比 | Source / 来源 |
|---|---|---|---|
| **Chain-of-Thought (CoT)** | (Wei et al. 2022, NeurIPS) A chain of thought is defined as "a series of intermediate natural language reasoning steps that lead to the final output." The authors showed that generating a chain of thought -- a series of intermediate reasoning steps -- significantly improves the ability of large language models to perform complex reasoning. This is an emergent behavior of model scale, with performance gains occurring in models ~100B+ parameters. Zero-Shot CoT variant: simply adding "Let's think step by step" to the prompt. | 就像"请展示你的解题步骤"——强制模型先想清楚再回答。 | [arXiv:2201.11903](https://arxiv.org/abs/2201.11903) |
| **Fan-Out / Fan-In** | The Fan-Out/Fan-In design pattern divides a task into multiple sub-tasks that can be processed in parallel (fan-out) and then combines the results into a single outcome (fan-in). Fan-out: a single source sends messages to multiple destinations simultaneously, commonly implemented in pub/sub systems and parallel task queues. Fan-in: the aggregation of multiple inputs, waiting for all sub-tasks to complete before proceeding. Analogous to MapReduce (distribute tasks = map, aggregate results = reduce). | 就像分组讨论再汇报——先分头调研，再合并结论。 | [Wikipedia: Fan-out (software)](https://en.wikipedia.org/wiki/Fan-out_(software)) |
| **Backpressure** | (Reactive Streams Specification) The main goal is to govern the exchange of stream data across an asynchronous boundary while ensuring that the receiving side is not forced to buffer arbitrary amounts of data. Backpressure is an integral part of this model to allow queues which mediate between threads to be bounded. The mechanism is demand-driven: a Subscriber signals demand via `Subscription.request(long n)` to control how many elements it is able and willing to receive. | 就像高速公路的匝道信号灯——车太多了就减慢进入速度，防止堵车。 | [Reactive Streams Specification](https://www.reactive-streams.org/) |
| **Exponential Backoff** | Retry strategy where wait time doubles after each failure (500ms -> 1s -> 2s -> 4s...), reducing load on failing services. | 就像"等一会再试"——每次等更久，给服务器喘息时间。 | Cloud Computing |
| **Feature Gate** | Runtime conditional enabling/disabling features without code deployment. Supports A/B testing and gradual rollout. | 就像开关灯——不用拆电线，按开关就能控制功能开启。 | DevOps / LaunchDarkly |
| **Partitioned Sort** | Sorting subsets independently then concatenating, preserving relative order within each partition for cache stability. | 就像分桌排座——先按部门分组，组内再按名字排，保证同部门的人坐一起。 | Claude Code |
| **Lazy Loading** | Deferring resource loading until actually needed, reducing initial load time and memory usage. | 就像网页的懒加载图片——滚到才加载，不滚不浪费。 | Web Development |

---

## 7. Persistence & Memory / 持久化与记忆

| Term / 术语 | Definition / 定义 | Analogy / 类比 | Source / 来源 |
|---|---|---|---|
| **Session Storage** | Append-only JSONL log of all messages, enabling conversation reconstruction after restart. | 就像自动保存的文档——随时可以从上次断开的地方继续。 | Claude Code |
| **Conversation Recovery** | Reconstructing conversation state from stored messages via parentUuid chain traversal. | 就像拼图——根据每块的编号重新拼出完整画面。 | Claude Code |
| **Memory System** | File-based persistent knowledge organized by type (user, feedback, project, reference). Survives across conversations. | 就像笔记本——记住用户偏好和项目状态，下次对话直接用。 | Claude Code |
| **Semantic Retrieval** | Using an LLM to select the most relevant memories for the current task, rather than keyword or vector matching. | 就像问秘书"这个项目相关的笔记有哪些"——秘书理解语义后筛选。 | Claude Code |
| **Team Memory** | Shared memory directory accessible by all team members, with secret filtering to prevent credential leakage. | 就像团队的共享文档——大家都能读写，但密码会被自动隐去。 | Claude Code |

---

*Total: 48 core terms across 7 categories with official source citations.*
*Updated 2026-04-03 with official definitions from framework documentation.*
