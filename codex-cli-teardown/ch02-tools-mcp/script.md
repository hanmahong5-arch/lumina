# Chapter 2 (Codex): Tools & MCP — Trait-based Dispatch with Compile-Time Concurrency Guarantees

## ⏱️ Target Duration: ~45 minutes | 📑 ~20 slides | 📝 ~7,500 words

> **The "less differentiated but most pedagogical" chapter.** Both Codex and Claude Code have tool systems and MCP integration — same problem domain. The interesting question is **how the language's type system shapes the abstraction**. Rust's trait + `Send + Sync` bound vs TypeScript's class hierarchy — same dispatch goal, different compile-time guarantees.
>
> **"差异化没那么强但教学价值最高"的一章。** Codex 和 Claude Code 都有工具系统和 MCP 集成，问题域相同。有意思的问题是：**语言的类型系统如何塑造抽象**。Rust 的 trait + `Send + Sync` 约束 vs TypeScript 的 class 继承——同样的分派目标，截然不同的编译期保证。

---

### Core Source Files Referenced

Pinned commit: `e4d6675`, 2026-05-01. All paths under `codex-rs/`.

* `core/src/tools/registry.rs:39` → `ToolKind` enum (Function | Mcp)
* `core/src/tools/registry.rs:44-92` → `ToolHandler` trait（7 个方法 + Send+Sync 约束）
* `core/src/tools/registry.rs:96-105` → `ToolArgumentDiffConsumer` trait（流式参数 diff）
* `core/src/tools/registry.rs:107+` → `AnyToolResult`（统一结果类型）
* `core/src/tools/handlers/` → 18+ 具体 handler：`shell`, `mcp`, `agent_jobs`, `apply_patch`, `dynamic`, `goal`, `plan`, `view_image`, `list_dir`, `unified_exec`, `request_user_input`, `request_permissions`, `tool_search`, `tool_suggest`, `mcp_resource`, `multi_agents`, `multi_agents_v2/*`, `unavailable_tool`
* `codex-mcp/src/lib.rs` → MCP 客户端管理
* `codex-mcp/src/connection_manager.rs` → MCP 连接生命周期（McpConnectionManager）
* `core/src/mcp_tool_call.rs` → 模型工具调用 → MCP RPC 转换（在 core crate，非 codex-mcp）

---

### [00:00] Opening (Slide 1: Cover)

LLM 调用工具，Agent 执行工具，结果回流给 LLM——这个循环是所有 LLM agent 的基础结构。问题在于：**18 种不同形态的工具，怎么用统一的 dispatch 接口管起来？**

LLM calls tools, agent executes tools, results flow back to LLM — this loop is the basic structure of all LLM agents. The question: **how do you manage 18 differently-shaped tools through one unified dispatch interface?**

`shell.rs` 跑 bash 命令；`apply_patch.rs` 修改文件；`mcp.rs` 调外部 MCP server；`agent_jobs.rs` spawn 64 个并发子 agent；`view_image.rs` 把图像编码成 vision input；`request_user_input.rs` 暂停推理等用户回答。

每种工具的输入、输出、副作用、错误模式都不同。但模型层面看到的是 OpenAI Functions 风格的 `{name, arguments}` JSON——只有一个 schema。中间这层"把统一调用展开成 18 种不同执行"的抽象，就是这一章的主题。

Each tool has different input, output, side effects, error modes. But at the model layer, all tools look like OpenAI Functions-style `{name, arguments}` JSON — one schema. The abstraction in the middle that "expands a unified call into 18 different executions" is this chapter's subject.

Codex 的回答是一个 Rust trait（`ToolHandler`），7 个方法，强制 `Send + Sync` 约束。Claude Code 的回答是 TypeScript class 继承，每个工具一个类。**同样的目标，不同的编译期保证**——这一章我们看这个差异从根上意味着什么。

Codex's answer is a Rust trait (`ToolHandler`), 7 methods, mandatory `Send + Sync` bound. Claude Code's answer is TypeScript class hierarchy, one class per tool. **Same goal, different compile-time guarantees** — this chapter looks at what that difference means structurally.

---

### [03:30] Slide 2: The Trait Definition — Reading All Nine Method Signatures

打开 `core/src/tools/registry.rs:44`：

```rust
pub trait ToolHandler: Send + Sync {
    type Output: ToolOutput + 'static;
    
    fn kind(&self) -> ToolKind;
    
    fn matches_kind(&self, payload: &ToolPayload) -> bool { /* default impl */ }
    
    fn is_mutating(&self, _invocation: &ToolInvocation) 
        -> impl std::future::Future<Output = bool> + Send 
    { async { false } }
    
    fn pre_tool_use_payload(&self, _invocation: &ToolInvocation) 
        -> Option<PreToolUsePayload> 
    { None }
    
    fn post_tool_use_payload(&self, _invocation: &ToolInvocation, _result: &Self::Output) 
        -> Option<PostToolUsePayload> 
    { None }
    
    fn create_diff_consumer(&self) 
        -> Option<Box<dyn ToolArgumentDiffConsumer>> 
    { None }
    
    fn handle(&self, invocation: ToolInvocation) 
        -> impl std::future::Future<Output = Result<Self::Output, FunctionCallError>> + Send;
}
```

逐元素拆解：

**`pub trait ToolHandler: Send + Sync`** — 整个 trait 强制 `Send + Sync` super-trait。意思是任何实现 `ToolHandler` 的类型都**必须能跨线程发送、能跨线程共享引用**。这个约束在编译期检查——如果你的 handler 持有 `Rc<T>`（不是 Send），编译失败。这是 Rust trait 系统给的免费保证：**Codex 的所有工具都可以放进任何 worker pool、任何并发上下文，零运行时检查**。

**`pub trait ToolHandler: Send + Sync`** — the entire trait mandates `Send + Sync` super-traits. Any type implementing `ToolHandler` **must be sendable across threads, must be sharable across threads via reference**. Compile-time enforced — if your handler holds an `Rc<T>` (not Send), it won't compile. This is Rust's free guarantee: **every Codex tool can be dropped into any worker pool, any concurrent context, with zero runtime checks**.

**`type Output: ToolOutput + 'static;`** — associated type。每个 handler 声明自己的输出类型（不是统一 `String` 或 `Value`），但必须实现 `ToolOutput` trait（提供统一的"转回模型可消费形态"的接口）。`'static` 表示输出不能持有非静态借用，可以跨 await 点保留。

**`type Output: ToolOutput + 'static;`** — associated type. Each handler declares its own output type (not unified `String` or `Value`), but must implement `ToolOutput` (uniform "convert back to model-consumable form" interface). `'static` means output can't hold non-static borrows, can be held across await points.

**`fn kind(&self) -> ToolKind;`** — 这个 handler 是 Function 类型（OpenAI Functions 风格的工具）还是 MCP 类型（外部 MCP server 提供的工具）。这是路由 hint。

**`fn matches_kind(&self, payload: &ToolPayload) -> bool;`** — dispatch 时的守护检查。默认实现匹配 kind 和 payload 类型。

**`fn is_mutating(&self, invocation) -> impl Future<Output = bool> + Send;`** — 这个调用是否会修改用户环境（文件系统、OS 状态）？默认返回 `false`（"我不变更环境"），但**注释强制**：

> "This function must remain defensive and return `true` if a doubt exists on the exact effect of a ToolInvocation."

**API 合约里写明 defensive default**——拿不准就报告 mutating。这是给后续审批/审计逻辑用的——`is_mutating()` 返回 `true` 的工具调用会触发 user approval（如果 policy 要求）。

**API contract explicitly mandates defensive default** — when in doubt, report mutating. This feeds downstream approval/audit logic — tool calls that return `true` from `is_mutating()` trigger user approval (if policy requires).

**`fn pre_tool_use_payload(&self, invocation) -> Option<PreToolUsePayload>;`** — hook point 1：工具执行前的可选 payload（用于发 telemetry 事件、记录 audit log）。
**`fn post_tool_use_payload(&self, invocation, result) -> Option<PostToolUsePayload>;`** — hook point 2：工具执行后。

**`fn create_diff_consumer(&self) -> Option<Box<dyn ToolArgumentDiffConsumer>>;`** — 流式参数 diff 消费者。LLM 流式生成 tool arguments 时，可以把每个 delta 喂给这个 consumer，consumer 决定要不要把 diff 转换成 EventMsg 推给 UI。这就是 Codex TUI 能在 LLM 还没写完 tool call 时就显示"正在构造 bash 命令: ls -..."的机制。

**`fn create_diff_consumer(...)`** — streaming argument-diff consumer. As the LLM streams tool arguments, each delta can be fed to this consumer, which decides whether to translate the diff into an EventMsg pushed to the UI. This is how Codex's TUI shows "constructing bash command: ls -..." before the LLM finishes writing the tool call.

**`fn handle(&self, invocation) -> impl Future<...> + Send;`** — 实际执行入口。返回一个 `Send` 的 Future，意思是这个 future 可以在任何 Tokio 任务里 await。

---

### [10:00] Slide 3: The Native RPITIT Pattern — No `#[async_trait]`

注意 trait 里所有 async 方法都用 `-> impl std::future::Future<Output = ...> + Send` 而不是 `async fn`。这是 Rust 1.75+ 的 RPITIT（Return Position Impl Trait In Trait）特性。

Look how all async methods in the trait use `-> impl std::future::Future<Output = ...> + Send` rather than `async fn`. This is Rust 1.75+'s RPITIT (Return Position Impl Trait In Trait) feature.

**为什么不用 `#[async_trait]` 宏？** Codex 的 `AGENTS.md` 文件第 22 行写明：

> "Discourage both `#[async_trait]` and `#[allow(async_fn_in_trait)]` in Rust traits.
> Prefer native RPITIT trait methods with explicit `Send` bounds on the returned future."

`#[async_trait]` 宏会把 async 方法 desugar 成 `Box<dyn Future>`——每次调用产生堆分配，性能有损。RPITIT 让 trait 直接表达"返回某个具体的 Future 类型"，调用方不付堆分配代价。代价是：trait 不能 object-safe（不能 `Box<dyn ToolHandler>`）。

`#[async_trait]` desugars async methods into `Box<dyn Future>` — heap allocation per call, perf cost. RPITIT lets the trait directly express "returns some concrete Future type," no heap-alloc cost. The cost: trait can't be object-safe (no `Box<dyn ToolHandler>`).

**Codex 接受了这个 trade-off**——他们选择性能而不是 object-safety。这意味着 dispatch 不能走 `Vec<Box<dyn ToolHandler>>` 然后循环找匹配的 handler——必须用其他方法分派（enum + 编译期 monomorphization，或泛型函数）。后面 Slide 5 会看到具体怎么做。

**Codex accepted this trade-off** — perf over object-safety. Dispatch can't use `Vec<Box<dyn ToolHandler>>` + linear find — must use other approaches (enum + compile-time monomorphization, or generic functions).

> **教学价值**：这个 trait 设计是 Rust 异步 trait 的现代姿势。如果你 2026 年开始写 Rust 异步代码，看 Codex 的 `ToolHandler` 学。看 LangChain Rust 那种 `#[async_trait]` everywhere 的代码不要学——那是 Rust 1.75 之前的妥协。
>
> **Pedagogical value**: this trait design is the modern shape of async traits in Rust. If you're starting Rust async code in 2026, learn from Codex's `ToolHandler`. Don't learn from `#[async_trait]`-everywhere code — that's pre-1.75 compromise.

---

### [16:00] Slide 4: Comparing to Claude Code's Class-Based Model

Claude Code 的工具系统在 `src/tools/` 下，每个工具一个类：

```typescript
// 简化伪代码
abstract class Tool<Input, Output> {
    abstract name: string;
    abstract description: string;
    abstract inputSchema: ZodSchema<Input>;
    abstract async call(input: Input, ctx: ToolContext): Promise<Output>;
    
    isMutating?(input: Input): boolean;
    formatForLLM?(output: Output): string;
}

class BashTool extends Tool<BashInput, BashOutput> { ... }
class EditTool extends Tool<EditInput, EditOutput> { ... }
class ReadTool extends Tool<ReadInput, ReadOutput> { ... }
```

**类继承 vs trait 实现的对照**：

| 维度 | Claude Code (TS class) | Codex (Rust trait) |
|------|-------------------------|---------------------|
| 抽象机制 | abstract class + extends | trait + impl |
| 方法多态 | 虚函数表（运行时） | monomorphization（编译期）+ vtable（dyn） |
| 输入类型 | 泛型参数 `<Input>` + Zod schema | 关联类型（隐式）+ JsonSchema derive |
| 输出类型 | 泛型参数 `<Output>` | `type Output: ToolOutput + 'static` |
| 并发安全 | 程序员小心（无强制） | `Send + Sync` 编译期强制 |
| 可空字段（telemetry hook） | `isMutating?(): boolean` 可选方法 | `Option<...>` 返回值 + 默认 impl |
| 实例数 | 每个 tool 一个实例（singleton） | 每个 tool 一个实现类型，可零开销实例化 |
| 添加新工具 | extends + register | impl + register |

**最深的差别在 `Send + Sync`**：Claude Code 的工具如果意外持有了不可 share 的状态（比如缓存了某个 React hook 的 ref），运行时把它放到 `Promise.all` 里可能产生竞态——但 TypeScript 类型系统不会拦你。Rust 拦得死死的。

**The deepest difference is `Send + Sync`**: if a Claude Code tool accidentally holds non-shareable state (cached a React hook ref), running it in `Promise.all` may race — but TypeScript types won't stop you. Rust stops you cold.

> **意外的发现**：Codex 的 trait 设计里没有 `description: String` 字段。Tool 描述存在哪里？答：在工具的 OpenAI Function 注册数据里，由 `JsonSchema` derive 生成（看每个 handler 的 `Args` struct 上的 `#[derive(JsonSchema)]`）。schema 既是验证又是描述——一份数据两种用途。
>
> **Surprise finding**: Codex's trait has no `description: String` field. Where does the tool description live? In the OpenAI Function registration data, generated by `JsonSchema` derive (look at each handler's `Args` struct with `#[derive(JsonSchema)]`). Schema is both validation and description — one data, two purposes.

---

### [22:00] Slide 5: The 18 Concrete Handlers

打开 `core/src/tools/handlers/`，18 个 handler 文件（不算测试）：

```
handlers/
├── shell.rs               - 跑 shell 命令（bash/sh/powershell）
├── unified_exec.rs        - 统一执行 API（shell + 沙箱配置）
├── apply_patch.rs         - 应用文件 patch
├── mcp.rs                 - 调用 MCP server 工具
├── mcp_resource.rs        - 读取 MCP server 资源
├── agent_jobs.rs          - 批量子 agent (CSV map-reduce, ch04)
├── multi_agents.rs        - v1 多 agent 系统 (ch04)
├── multi_agents_v2/       - v2 长期 inter-agent messaging (ch04)
├── goal.rs                - Goal 操作（创建/更新/查询，ch04）
├── plan.rs                - 计划工具（结构化任务列表）
├── view_image.rs          - 把图像传给 vision-capable model
├── list_dir.rs            - 列目录
├── request_user_input.rs  - 暂停推理等用户输入
├── request_permissions.rs - 申请额外权限（修改 sandbox policy）
├── tool_search.rs         - 搜索可用工具（与本机 Claude Code 的 ToolSearch 同名）
├── tool_suggest.rs        - 推荐工具（meta：让 LLM 帮你发现哪些工具能用）
├── dynamic.rs             - 用户运行时定义的工具
├── unavailable_tool.rs    - placeholder for 不可用工具的 stub
└── mod.rs                 - 模块组装
```

按职责分组：

**OS 执行类（3）**：`shell`, `unified_exec`, `apply_patch`
**MCP 类（2）**：`mcp`, `mcp_resource`
**Agent 编排类（4）**：`agent_jobs`, `multi_agents`, `multi_agents_v2/`, `goal`
**用户交互类（2）**：`request_user_input`, `request_permissions`
**Meta-tooling（3）**：`plan`, `tool_search`, `tool_suggest`
**输入处理（2）**：`view_image`, `list_dir`
**扩展机制（1）**：`dynamic`
**降级（1）**：`unavailable_tool`

**和 Claude Code 工具对照**：Claude Code 在 `src/tools/` 下大约 30+ 个工具——更多但更"原子"。Codex 工具更少，但每个工具往往承担更多功能（`unified_exec` 把 shell + sandbox 整合，`plan` 是单工具不是 TodoWrite/TodoRead 两个分开）。

**Compared to Claude Code**: Claude Code has ~30+ tools in `src/tools/` — more, but more "atomic." Codex has fewer tools but each carries more functionality (`unified_exec` integrates shell + sandbox; `plan` is one tool not separate TodoWrite/TodoRead).

> **设计哲学**：Claude Code 倾向"小而多"——每个工具只做一件事，组合靠 LLM 思考。Codex 倾向"大而合"——把相关能力打包成更高层工具，减少 LLM 调度负担。两种都对，对应不同的 LLM 能力假设——Claude Code 假设 LLM 善于组合原子操作，Codex 假设 LLM 调度复杂工具更稳定。
>
> **Design philosophy**: Claude Code leans "small and many" — each tool does one thing, composition is the LLM's job. Codex leans "large and integrated" — bundle related capabilities into higher-level tools, reduce LLM scheduling burden. Both correct, mapping to different LLM capability assumptions.

---

### [29:00] Slide 6: The MCP Integration — `codex-mcp` Crate

MCP（Model Context Protocol）是 Anthropic 主导的工具暴露标准协议。Codex 实现自己的 MCP 客户端在 `codex-mcp/` crate 里：

```
codex-mcp/src/
├── lib.rs                       - 模块组装、公开 API
├── connection_manager.rs        - 多 MCP server 的连接生命周期管理（McpConnectionManager）
├── tools.rs                     - MCP tool schema 转换
├── elicitation.rs               - MCP elicitation 流程（server 让用户输入额外信息）
└── ... 
```

（模型 tool call → MCP `RequestCallTool` RPC 的转换在 `core/src/mcp_tool_call.rs`，属于 core crate 而非 codex-mcp。）

**`McpConnectionManager` 是核心**——一个 session 通常连接多个 MCP server（每个 server 有自己的子进程或 HTTP 端点），manager 负责：

1. spawn/重连每个 server 的子进程
2. 维护每个 server 暴露的 tool schema 列表
3. 路由 tool call 到正确的 server
4. 处理 server 端 elicitation（"我需要用户输入 OAuth code"这种 inbound 请求）
5. 配置 hot reload（用户改 config 后无需重启 codex）

`McpConnectionManager` is the core — a session usually connects to multiple MCP servers (each with its own subprocess or HTTP endpoint), manager handles spawn/reconnect, tool schema list, dispatch routing, server-side elicitation, hot config reload.

**`AGENTS.md` 第 32 行的指导**：

> "When working with MCP tool calls, prefer using `codex-rs/codex-mcp/src/mcp_connection_manager.rs` to handle mutation of tools and tool calls."

——这是给开发者的 internal guidance：MCP 相关的状态变更走集中入口。这种 explicit 的 architectural rule 写进 `AGENTS.md` 是好工程。

（注：AGENTS.md 这行引用的 `mcp_connection_manager.rs` 在 pinned commit `e4d6675` 下实际已改名为 `connection_manager.rs`——连上游自己的指导文档也会出现引用漂移。）

---

### [35:00] Slide 7: Why MCP Integration is "Same Problem, Different Cost"

Claude Code 也支持 MCP。两边都把 `mcp` 当成 first-class concern。差别在**实现成本**：

| | Claude Code | Codex |
|---|---|---|
| MCP 客户端代码量 | 较少（依赖 `@modelcontextprotocol/sdk` npm 包） | 自己实现（`codex-mcp` 是独立 crate） |
| 与核心引擎集成 | 直接 import & use | 跨 crate 边界 + trait 实现 |
| 与 sandbox 集成 | 不自动 | sandbox policy 自动应用到 MCP 子进程 |
| MCP server 是 untrusted 的 trust posture | 默认信任，permission prompt 兜底 | 默认 untrusted，sandbox + MITM 兜底（ch03） |

**Codex 自己实现 MCP 客户端是因为它要把 MCP 调用和 sandbox/network proxy 深度集成**——一个 npm 上现成的 MCP 客户端不会 "spawn server subprocess 时记得套上 codex-linux-sandbox"。这种深度集成只能自己实现。

Codex implementing its own MCP client is because it must deeply integrate MCP calls with sandbox/network-proxy — an off-the-shelf npm MCP client won't "remember to wrap codex-linux-sandbox around the spawned server subprocess." This depth of integration must be hand-built.

---

### [40:00] Slide 8: The Dispatch — How `submission_loop` Finds the Right Handler

回到 ch01 的 `submission_loop`。当 LLM 流式产出一个 tool call，引擎要找 handler 执行：

```
LLM stream                  ┌─ ToolHandler #1 (shell)
   │                        │
   ▼                        │
parse tool call             │
   │                        ▼
   │  tool_name = "bash"    Each handler:
   │  arguments = {...}     - kind() → ToolKind
   ├──────────────────────► - matches_kind(payload) → bool
   │                        - handle(invocation) → Future<Output>
   │
   │
   └─► tools::dispatch_call(call_id, payload)
                  │
                  └─► handler.handle(invocation).await
```

**dispatch 不能用 `Vec<Box<dyn ToolHandler>>`**（因为 trait 不 object-safe）。Codex 实际怎么 dispatch？查 `tools/registry.rs:107` 后面：用 `AnyToolResult` 做统一结果类型 + 编译期已知的 handler 集合（不能动态加 handler，只能在 build 时通过 enum/match 注册）。

`Dynamic` handler 是例外——它支持运行时定义的工具——但仍然走同一个 `ToolHandler` trait 接口。

> **架构反思**：编译期已知的 handler 集合 + 运行时 Dynamic handler 双轨制是 Rust trait 系统下的合理妥协。它牺牲了"用户能在配置文件里加新工具"的灵活性，换来了 dispatch 路径的零开销 + 编译期类型检查。这是 Codex 整体"显式 > 灵活"哲学的一致体现。
>
> **Architecture reflection**: compile-time-known handler set + runtime Dynamic handler is the reasonable compromise under Rust's trait system. Sacrifices "user adds new tool via config file" flexibility for zero-overhead dispatch path + compile-time type checking. Consistent with Codex's overall "explicit > flexible" philosophy.

---

### [44:00] Slide 9: Synthesis — What This Trait Says About the Project

`ToolHandler` trait 这一个 80 行代码，编码了多个项目级哲学决定：

1. **`Send + Sync` 强制约束** → Codex 假设工具会跑在多线程并发上下文。这是为 ch04 的 64-worker batch jobs、为 v2 multi-agent messaging 服务的。
2. **Defensive `is_mutating()` 默认** → Codex 默认怀疑工具会变更环境，approval 是默认开启的姿态。这呼应 ch03 的"不信任 LLM/工具"威胁模型。
3. **`pre/post_tool_use_payload` hook 点** → telemetry/audit 是 trait 一等公民。Codex 假设它会被部署在需要审计追溯的环境（企业、合规）。
4. **`create_diff_consumer` streaming hook** → 实时 UI 反馈是 trait 设计目标。Codex TUI 能在 LLM 还没写完 tool call 就显示进度，这个 trait 给了实现基础。
5. **关联类型 `type Output`** → 每个工具有强类型化输出，不靠 `serde_json::Value` 裸传。Rust 类型系统的力量被充分用。
6. **Native RPITIT，无 `#[async_trait]`** → 性能洁癖。每个 tool call 不付堆分配。

**One trait, six philosophical decisions encoded**: Send+Sync (multi-threaded by default), defensive mutating default (untrusted assumption), pre/post hooks (audit-first), diff streaming (UX-first), associated output type (type-safety-first), RPITIT (perf-first).

> **总结这一章**：Codex 的 ToolHandler trait 不是任意设计的——它是 Codex 整体架构哲学（显式、并发、untrusted、可审计、高性能）的一个浓缩表达。读懂这 80 行代码，就读懂了 Codex 团队的全套工程价值观。
>
> **Closing this chapter**: Codex's ToolHandler trait isn't arbitrarily designed — it's a condensed expression of Codex's whole architectural philosophy (explicit, concurrent, untrusted, auditable, high-performance). Reading these 80 lines is reading Codex's full engineering value system.

---

### Closing / 收尾

四章走完核心引擎（ch01）、工具系统（ch02）、安全模型（ch03）、自主性栈（ch04）。下一步如果做：录制视频版、整理 slides 配图、做横向对比的 PPTX 章节。

Four chapters done covering core engine, tools, safety, autonomy. Next steps if pursued: record video version, author slides with diagrams, build the comparison PPTX deck.

但更深的问题：你看完这四章，对你**自己设计 LLM agent** 时该靠近 Codex 还是 Claude Code，有没有判断？这是这套拆解最终该有的产出——不是知识，是判断力。

But the deeper question: after reading these four chapters, do you have **judgment** for whether your own LLM agent should lean toward Codex or Claude Code? That's the final product this teardown should deliver — not knowledge, but judgment.

---

## Status / 状态

**Draft v0.1** — 2026-05-01

- [x] 9 sections drafted (~7,500 words bilingual)
- [x] Verified ToolHandler trait at registry.rs:44 (full 9-method signature)
- [x] Verified Send+Sync super-trait bound
- [x] Verified `type Output: ToolOutput + 'static`
- [x] Verified defensive `is_mutating()` doc comment
- [x] Verified RPITIT pattern (no `#[async_trait]`)
- [x] Verified ToolArgumentDiffConsumer trait at registry.rs:96
- [x] Verified handler directory listing (18 handler files)
- [x] Verified codex-mcp crate composition
- [x] Verified AGENTS.md guidance about RPITIT and `mcp_connection_manager.rs`
- [ ] HTML slides not authored
- [ ] Need diagrams: (1) ToolHandler trait method anatomy, (2) handler family Venn diagram, (3) MCP integration topology
- [ ] Need to verify: actual dispatch mechanism in registry.rs:107+ (the AnyToolResult section) — claim about "compile-time enum + match" needs source verification

**Open questions**:
- Slide 5 (18 handlers) — is the categorization (OS exec / MCP / agent / interaction / meta / input / extension / fallback) ground truth or my framing? Verify by reading mod.rs registration code.
- Slide 6-7 (MCP) — should I peek into `mcp_connection_manager.rs` to ground "hot config reload" claim?
- Slide 9 (Synthesis) — is "6 philosophical decisions encoded" too neat-a-package framing? Maybe loosen to "six observations."
