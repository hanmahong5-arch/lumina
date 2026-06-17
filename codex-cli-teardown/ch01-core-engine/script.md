# Chapter 1 (Codex): Core Engine — Channel Pair vs AsyncGenerator

## ⏱️ Target Duration: ~50 minutes | 📑 12 slides | 📝 ~7,500 words

> **Validation chapter.** This is the first substantive chapter of the Codex teardown. If reading these source files at this depth feels productive, the entire Codex deep-dive direction is worth pursuing. If it feels like a forced repetition of the Claude Code teardown, stop and reconsider scope.
>
> **验证章节。** Codex 拆解的第一个实质章节。如果按这种深度读源码感觉有产出，整个 Codex 深度拆解方向就值得做下去；如果感觉是在硬复制 Claude Code 拆解的形状，立即停下来重新评估。

---

### Core Source Files Referenced / 核心源码文件

Pinned commit: `e4d66756328a616361a79eb792d86ad55f0bf5ae` (2026-05-01 snapshot).
All file:line references resolve against `codex-rs/`.

* `core/src/session/mod.rs` → `Codex` struct (line 369): the public queue-pair handle
  / 公开的 queue-pair 句柄
* `core/src/session/session.rs` → `Session` struct (line 11): inner per-conversation state
  / 内部会话状态
* `core/src/session/handlers.rs` → `submission_loop()` (line 962): the central dispatcher
  / 中央调度器
* `protocol/src/protocol.rs` → `Event`, `EventMsg`, `Submission`, `Op` (line ~1296): the wire protocol
  / 通信协议定义
* `core/src/client.rs` → `ModelClient::stream()` (line 1505): outbound LLM streaming
  / 出站 LLM 流式调用
* `core/src/compact.rs` → `run_inline_auto_compact_task()` (line 65): mid-turn compaction
  / 推理中压缩

---

### [00:00] Opening (Slide 1: Cover)

一个工业级编码 Agent 的核心引擎，长什么样？这个问题已经在 Claude Code 那里有过一个答案——TypeScript 的 AsyncGenerator、单线程事件循环、`queryLoop` 里 yield SDKMessage。今天我们看 OpenAI 给出的另一个答案：Codex 的核心引擎用 **Rust** 写，主控流是**双向 channel pair**，调度器是一个无限循环的 `submission_loop` 在等 MPSC receiver。

What does the core engine of a production-grade coding agent look like? We already have one answer from Claude Code — TypeScript AsyncGenerator, single-threaded event loop, `queryLoop` yielding SDKMessages. Today we look at OpenAI's alternative: Codex's core is in **Rust**, the main control flow is a **bidirectional channel pair**, and the dispatcher is an infinite loop awaiting an MPSC receiver.

抛出一个问题：当两个团队解决同一个问题——"如何让 LLM 安全、可中断、可观测地驱动一个本地工具执行 Agent"——为什么一个选了 AsyncGenerator，另一个选了 channel pair？这不是审美差异，这是两套不同的并发哲学在同一个问题上的具体投影。

The question to keep in mind: when two teams solve the same problem — "how do you let an LLM safely, interruptibly, observably drive a local tool-executing agent" — why does one team pick AsyncGenerator and the other pick channel pairs? This isn't an aesthetic difference. This is two different concurrency philosophies projected onto the same problem.

带着这个问题开始。

---

### [02:30] Slide 2: The Architectural Split (Rust core + JS wrapper)

打开 Codex 仓库根目录，第一眼就和 Claude Code 不一样：

```
codex-cli/      ← TypeScript/JS 外壳（CLI、TUI 渲染）
codex-rs/       ← Rust 核心（Agent 引擎、沙箱、协议、MCP）
```

第一眼信号已经很强：**核心引擎不在 TypeScript**。Codex 把 AI Agent 引擎的实现语言从主流脚本语言（TS/Python）切到了系统级语言（Rust）。Claude Code 全栈 TS。这个选择决定了一切下游：内存模型、并发模型、错误模型、扩展模型。

The first thing you see at the repo root, and it's already a strong signal: **the core engine is NOT in TypeScript**. Codex moved the agent engine implementation language from a mainstream scripting language (TS/Python) to a systems language (Rust). Claude Code is full-stack TS. This choice cascades into everything downstream: memory model, concurrency model, error model, extension model.

`codex-rs/` 内部按 cargo workspace 组织，约 25 个 crate，按职责分组：

| Crate | Role | Claude Code 对应 |
|-------|------|------------------|
| `codex-core` | Agent loop、Session、Tool dispatch | `src/QueryEngine.ts` + `src/query.ts` |
| `codex-protocol` | Submission/Event/Op enum 定义 | `src/types/sdk.ts` |
| `codex-mcp` | MCP client 和 tool 注册 | `src/services/mcp/*` |
| `codex-exec` | 子进程执行 + 沙箱包装 | `src/tools/Bash.ts` 内联 |
| `codex-linux-sandbox` | Landlock + Bubblewrap helper 二进制 | **无对应** |
| `windows-sandbox-rs` | Windows restricted token | **无对应** |
| `codex-cli` | TUI 入口（Rust，不是 codex-cli/ 那个 JS 目录） | `src/cli/index.ts` |
| `codex-app-server` | HTTP/WebSocket 协议服务 | `src/sdk/*` |
| `codex-thread-store` | 持久化对话历史 | 无（内存中） |
| `codex-realtime-webrtc` | WebRTC 语音通道 | **无对应** |

**注意三个"无对应"行**：原生跨平台沙箱、持久化对话存储、WebRTC 语音——这是 Codex 真正独有的能力。后面 ch03/ch04 会展开。

**Note the three "no equivalent" rows**: native cross-platform sandbox, persistent conversation store, WebRTC voice channel. These are Codex's actual differentiators. ch03 and ch04 will expand on them.

---

### [06:00] Slide 3: The Core Question — What is "Codex" the type?

在 `codex-rs/core/src/session/mod.rs` 第 369 行，定义了整个系统的入口类型 `Codex`：

```rust
/// The high-level interface to the Codex system.
/// It operates as a queue pair where you send submissions and receive events.
pub struct Codex {
    pub(crate) tx_sub: Sender<Submission>,
    pub(crate) rx_event: Receiver<Event>,
    pub(crate) agent_status: watch::Receiver<AgentStatus>,
    pub(crate) session: Arc<Session>,
    pub(crate) session_loop_termination: SessionLoopTermination,
}
```

注意源码注释自己说的话：**"queue pair where you send submissions and receive events"**。这是作者主动给出的心智模型。

Note what the source comment says verbatim: **"queue pair where you send submissions and receive events."** This is the author's own mental model, given for free.

5 个字段：

1. **`tx_sub: Sender<Submission>`** — 入站通道。调用方（CLI/TUI/SDK）通过这个发送 `Submission { id, op }`。`Op` 是一个 enum，表示用户想做的事：发送消息、中断、开始 realtime 会话、刷新 MCP 配置等。

2. **`rx_event: Receiver<Event>`** — 出站通道。引擎产生的所有事件都从这里流出：`AgentMessage`、`AgentReasoning`、`TurnStarted`、`TurnComplete`、`ContextCompacted`、`TokenCount` 等约 40 种 EventMsg 变体。

3. **`agent_status: watch::Receiver<AgentStatus>`** — 状态广播通道。和 `rx_event` 不同，这是 **watch channel**——只关心"当前是什么状态"而不是"历史发生了什么"。订阅方拿到最新值即可，老状态会被覆盖。这是 TUI 用来渲染"running / idle / waiting for approval"指示灯的频道。

4. **`session: Arc<Session>`** — 共享的内部状态。`Arc` 让多个异步任务（subscribe、submit、background goal runner）都能持有引用。

5. **`session_loop_termination: SessionLoopTermination`** — 一个 `Shared<BoxFuture<'static, ()>>`。注释说"shared future for the background submission loop completion so multiple callers can wait for shutdown"。任何持有 `Codex` 的代码都能 `.await` 这个 future 等到 session loop 退出。

**和 Claude Code 的对照**：Claude Code 的 `QueryEngine` 类有 8 个私有字段（config、mutableMessages、abortController、permissionDenials、totalUsage、hasHandledOrphanedPermission、readFileState、discoveredSkillNames）。但调用方拿到的是一个 `submitMessage()` 方法，返回 `AsyncGenerator<SDKMessage>`。

**Compared to Claude Code**: Claude Code's `QueryEngine` class has 8 private fields. But what the caller holds is a `submitMessage()` method that returns an `AsyncGenerator<SDKMessage>`.

差别非常清楚：

| 维度 | Claude Code | Codex |
|------|-------------|-------|
| 引擎类型 | `class QueryEngine` | `struct Codex` |
| 调用接口 | `async *submitMessage(prompt) → SDKMessage` | `tx_sub.send(Submission), rx_event.recv() → Event` |
| 控制流原语 | AsyncGenerator (语言层面) | MPSC channel (库层面 `tokio::mpsc`) |
| 状态拓扑 | 直接持有字段 | `Arc<Mutex<...>>` 间接持有 |
| 并发预期 | 单线程 JS 事件循环 | 多线程 Tokio runtime |

为什么这个差别重要？接下来一张幻灯片回答。

---

### [11:00] Slide 4: AsyncGenerator vs Channel Pair — Same problem, two minds

两套设计都解决同一组需求：
1. 调用方能持续消费引擎产生的事件流
2. 调用方能在中途取消（Ctrl+C、SDK abort）
3. 调用方能向引擎注入额外输入（追加用户消息、批准权限请求）
4. 引擎能告知调用方它当前在做什么（streaming / waiting for tool / paused）

Both designs solve the same set of requirements:
1. The caller continuously consumes events the engine produces.
2. The caller can cancel mid-flight (Ctrl+C, SDK abort).
3. The caller can inject additional input (append user message, approve permission).
4. The engine can signal what it's currently doing (streaming / waiting for tool / paused).

**AsyncGenerator 的回答**：用 JavaScript 语言原生的协程语义。`yield` 暂停引擎；调用方 `next()` 推进；调用方 `return()` 取消（在 generator 内部触发 `try/finally`）；调用方 `throw()` 注入错误。引擎是被动的——它的执行节奏被消费者牵着走，这天然就是**背压**（backpressure）。Claude Code 团队选择这条路，是承认 JS 单线程事件循环的现实：你不需要为多线程并发设计，所以你可以借用语言已经给你的协程机制。

**The AsyncGenerator answer**: use JavaScript's native coroutine semantics. `yield` pauses the engine; the caller `next()` advances it; `return()` cancels (triggering `try/finally` inside the generator); `throw()` injects errors. The engine is passive — its pace is pulled by the consumer, which gives **backpressure** for free. Claude Code's choice is an acknowledgment of JS's single-threaded event loop: you're not designing for multi-thread concurrency, so you can lean on the language's coroutines.

**Channel pair 的回答**：把"产生事件"和"消费事件"完全解耦。引擎自己有自己的执行节奏（在 Tokio runtime 上跑 `submission_loop`），它把 Event 推到 `tx_event` 上，谁消费、消费多快、是不是丢弃，是消费者的问题。调用方也类似：要发 Submission，就 `tx_sub.send()`，发完就走，引擎什么时候处理是引擎的事。这是**生产者-消费者模型**，不是协程模型。

**The channel-pair answer**: decouple production and consumption completely. The engine runs at its own pace on a Tokio runtime, pushes Events into `tx_event`, and whoever wants to consume — and how fast, and whether they drop — is the consumer's problem. The caller is symmetric: `tx_sub.send()` to submit, then leaves. When the engine processes is the engine's business. This is the **producer-consumer pattern**, not the coroutine pattern.

代价和收益的差别：

| 性质 | AsyncGenerator | Channel pair |
|------|----------------|--------------|
| 背压 | 天然——消费者不 next 就不前进 | 需手动设计——`bounded(N)` channel 满了 send 阻塞 |
| 取消 | 调用方 `.return()` 即可 | 需要单独的 `Op::Interrupt` 信号 + `AbortHandle` |
| 多消费者 | 不行——AsyncGenerator 是单消费者 | 天然——多个 receiver 可以 fan-out（Codex 实际是 broadcast） |
| 后台任务 | 不能——generator 必须有人 `next` 才推进 | 天然——Tokio 任务自己跑 |
| 跨线程 | 不行——JS 没有线程 | 天然——Send/Sync trait |
| 类型安全 | TS 类型推断很好 | Rust 类型系统更强但更啰嗦 |

**关键洞察**：Codex 选 channel pair 不是因为它"更好"，而是因为它**为可能存在的后台任务和多消费者打开了门**。事实上 Codex 真的用了——`goal_runtime`（自动 continue）、`mailbox`（异步工具结果回流）、`agent_status`（独立的状态广播）、`RealtimeConversationManager`（语音协程）、批量 sub-agent 池——这些后台并发是 AsyncGenerator 模型从根上不支持的。

**The key insight**: Codex didn't pick channel pair because it's "better"—it picked it because **it leaves the door open for background tasks and multiple consumers**. And Codex actually walks through that door: `goal_runtime` for auto-continuation, `mailbox` for async tool result return-flow, `agent_status` as an independent status broadcast, `RealtimeConversationManager` for voice coroutines, batch sub-agent pools — these are all background-concurrent activities that the AsyncGenerator model fundamentally doesn't support.

反过来：Claude Code 不需要这些（至少现在不需要），所以付不起 channel pair 的复杂度税也合理。两个团队都做了对的选择，给定他们的需求边界。

---

### [14:30] Slide 4b: 类比——传送带与邮局信箱 / Analogy: Conveyor belt & mailroom

上一张幻灯片的对照表是分析性的；这一张用两个画面把它固化成直觉。

想象 Claude Code 是**工厂传送带**：生产者把零件放上去，`yield` 让带子停一格，取货人取走一个，带子才再动一格。这就是 AsyncGenerator 的节奏——"谁先谁后"完全焊死在调用栈里，背压天然，但只能单线、单消费者、同进程。

Imagine Claude Code as a **factory conveyor belt**: the producer places an item, `yield` halts the belt one notch, the consumer takes one item, and the belt advances again. That's AsyncGenerator's rhythm — ordering is baked into the call stack, backpressure is free, but you get only one lane and one consumer in the same process.

Codex 是**邮局信箱对**：有两排信箱，`tx_sub`/`rx_sub` 是收件侧，`rx_event`/`send_event` 是发件侧。发件人把信扔进信箱就走，收信人按自己的节奏取信，两边完全解耦。正因为解耦，引擎才能是独立二进制，被多个前端同时订阅——但背压要靠**有界 channel** 显式设计，否则队列就会积压。

Codex is a **mailroom pair**: two banks of pigeonholes — `tx_sub`/`rx_sub` on the inbound side, `rx_event`/`send_event` on the outbound. The sender drops a letter and walks away; the receiver picks it up on its own schedule. Full decoupling lets the engine be a standalone binary consumed by multiple frontends simultaneously — at the cost of explicit backpressure design via bounded channels.

**一句话固化**：传送带把顺序焊死在调用栈里（简单、同进程）；信箱把它摊成可序列化的消息（灵活、可跨界）。这两句话是上一页那张对照表背后的物理直觉。

**One line to remember**: the conveyor belt welds ordering into the call stack (simple, same-process); the mailroom flattens it into serializable messages (flexible, cross-boundary). That is the physical intuition behind the comparison table on the previous slide.

---

### [17:00] Slide 5: The Inner Session — 17 fields of "what's actually running"

`Codex` 是公开门面。真正持有运行时状态的是 `Session`，定义在 `core/src/session/session.rs:11`：

```rust
pub(crate) struct Session {
    pub(crate) conversation_id: ThreadId,
    pub(super) tx_event: Sender<Event>,
    pub(super) agent_status: watch::Sender<AgentStatus>,
    pub(super) out_of_band_elicitation_paused: watch::Sender<bool>,
    pub(super) state: Mutex<SessionState>,
    pub(super) managed_network_proxy_refresh_lock: Semaphore,
    pub(super) features: ManagedFeatures,
    pub(super) pending_mcp_server_refresh_config: Mutex<Option<McpServerRefreshConfig>>,
    pub(crate) conversation: Arc<RealtimeConversationManager>,
    pub(crate) active_turn: Mutex<Option<ActiveTurn>>,
    pub(super) mailbox: Mailbox,
    pub(super) mailbox_rx: Mutex<MailboxReceiver>,
    pub(super) idle_pending_input: Mutex<Vec<ResponseInputItem>>,
    pub(crate) goal_runtime: GoalRuntimeState,
    pub(crate) guardian_review_session: GuardianReviewSessionManager,
    pub(crate) services: SessionServices,
    pub(super) next_internal_sub_id: AtomicU64,
}
```

17 个字段，按职责分 4 组讲解。

**Group 1 — 通道方向（4 fields）**

`tx_event` 是 `rx_event` 的另一头：调用方持有 `rx_event.recv()` 端，引擎内部所有发事件的代码都通过 `Session::send_event_raw()` 走 `tx_event.send()`。同样 `agent_status: watch::Sender` 是状态广播的发布端。`out_of_band_elicitation_paused: watch::Sender<bool>` 是给 MCP 工具的 elicitation（要求用户输入额外信息）流程使用的暂停信号——MCP 服务器问用户问题时，主推理循环要让出控制权。

**Group 1 — Channel ends (4 fields).** `tx_event` is the producer end of `rx_event`; everything that emits an event goes through `Session::send_event_raw()`. `agent_status` similarly is the publisher end of the status watch channel. `out_of_band_elicitation_paused: watch::Sender<bool>` is the pause signal for MCP elicitation flow — when an MCP server prompts the user for additional input, the main reasoning loop has to yield control.

> **对比 Claude Code**：Claude Code 没有"agent_status"独立通道——状态隐含在 SDKMessage 流里。也没有"elicitation pause"概念——所有交互都顺序在主 generator 上做。Codex 的并发架构强迫它把状态、用户消息、out-of-band 通信分成不同通道。
>
> **vs Claude Code**: Claude Code has no separate "agent_status" channel — status is implicit in the SDKMessage stream. No "elicitation pause" concept either; all interaction is sequential on the main generator. Codex's concurrent architecture forces it to split state, user messages, and out-of-band communication into different channels.

**Group 2 — 互斥保护的状态（5 fields, 全部带锁）**

- `state: Mutex<SessionState>` — 模型选择、权限策略、cwd、人格化设置等。改它要拿锁。
- `managed_network_proxy_refresh_lock: Semaphore` — 网络代理刷新串行化锁。注释说"serializes rebuild/apply cycles for the running proxy"。Codex 在沙箱模式下会启动一个本地代理来过滤网络，这个代理需要在权限策略变化时重建。
- `pending_mcp_server_refresh_config: Mutex<Option<...>>` — 暂存等待应用的 MCP 服务器配置变更。
- `active_turn: Mutex<Option<ActiveTurn>>` — 当前正在跑的 turn 的句柄。注释说"A session has at most 1 running task at a time, and can be interrupted by user input." 这一句话很重要——尽管 Codex 是多线程异步，但每个 session **同一时刻最多一个 active turn**。
- `mailbox_rx: Mutex<MailboxReceiver>` — 工具结果接收端（保证只有一个消费者从 mailbox 拿）。

**Group 2 — Lock-protected state (5 fields, all with locks).** The interesting one is `active_turn: Mutex<Option<ActiveTurn>>`, with the comment "A session has at most 1 running task at a time, and can be interrupted by user input." This is critical — even though Codex is multi-threaded async, each session has **at most one active turn at a time**. So Codex pays the explicit-locking cost but ends up with the same single-active-turn semantics that Claude Code gets for free from JS's single-threaded model.

> **关键洞察**：Codex 用 Mutex/Semaphore/Atomic 做的事，Claude Code 通过"语言只有一根线程"免费得到。两边最终落在**同一个不变量**——一次只有一个 turn 在跑——但走的路径完全不同。Codex 显式付出并发控制的代价，换来的是把背景任务（goal、mailbox 消费、proxy 刷新）真正并行跑的可能性。
>
> **Key insight**: What Codex achieves with Mutex/Semaphore/Atomic, Claude Code gets for free from "the language only has one thread." Both end up at the **same invariant** — one turn at a time — via completely different paths. Codex pays explicit concurrency cost for the option of truly parallel background work (goals, mailbox consumption, proxy refresh).

**Group 3 — 邮箱与挂起输入（3 fields）**

- `mailbox: Mailbox` — 工具执行的异步结果回收队列。工具执行完后把 `ResponseInputItem` 推进来。
- `idle_pending_input: Mutex<Vec<ResponseInputItem>>` — 用户在引擎 idle 时发的输入要先攒起来。注释里有句吐槽："TODO (jif) merge with mailbox!" 说明作者自己也觉得这块设计还在演化。
- `next_internal_sub_id: AtomicU64` — 自增的内部 submission id。原子整数，因为可能被多个并发任务调用 `fetch_add(1)`。

**Group 3 — Mailbox & pending input (3 fields).** `mailbox` is the async return queue for tool execution results. `idle_pending_input` buffers user input that arrives while the engine is idle. The `next_internal_sub_id: AtomicU64` is a giveaway — atomic integers exist precisely because Rust expects multiple concurrent tasks might call `fetch_add(1)`. JS doesn't need this. The author's own TODO ("merge with mailbox!") signals this part of the design is still evolving.

**Group 4 — 子系统句柄（5 fields）**

- `features: ManagedFeatures` — 启用的特性集合（feature flag），session 生命周期内不变。
- `conversation: Arc<RealtimeConversationManager>` — WebRTC 实时语音会话管理器。**Claude Code 完全没有的东西**。
- `goal_runtime: GoalRuntimeState` — 持久化"目标"系统。Agent 可以在多个 turn 之间持续追踪一个高层级目标，闲置时自动 continue。**Claude Code 完全没有的东西**。
- `guardian_review_session: GuardianReviewSessionManager` — 自动审批审查器。配合 LLM 来判断工具调用是否需要升级到用户审批。
- `services: SessionServices` — 一个 bag of references：agent_control、exec、mcp_manager、auth、environment 等。等价于 Claude Code 的 `QueryEngineConfig` 注入的依赖。

**Group 4 — Subsystem handles (5 fields).** Two of these — `conversation` (realtime voice) and `goal_runtime` (autonomous continuation) — are **things Claude Code does not have at all**. These will get full chapters later (ch04 covers goals; voice is out-of-scope for this teardown but worth flagging).

---

### [27:00] Slide 6: `submission_loop` — The dispatcher

到现在为止我们看的是数据；这张幻灯片看代码——引擎是怎么"跑"起来的。

打开 `core/src/session/handlers.rs:962`：

```rust
pub(super) async fn submission_loop(
    sess: Arc<Session>,
    config: Arc<Config>,
    rx_sub: Receiver<Submission>,
) {
    while let Ok(sub) = rx_sub.recv().await {
        let dispatch_span = submission_dispatch_span(&sub);
        let should_exit = async {
            match sub.op.clone() {
                Op::Interrupt => { interrupt(&sess).await; false }
                Op::CleanBackgroundTerminals => { ... }
                Op::RealtimeConversationStart(params) => { ... }
                // ... 多达 20 余种 Op
                Op::Shutdown => { ... ; true }
                ...
            }
        }.instrument(dispatch_span).await;
        if should_exit { break; }
    }
}
```

骨架很简单：

1. 一个 `tokio::select`-free 的纯顺序循环。
2. 从 `rx_sub` 拉一个 `Submission`。
3. 根据 `sub.op` 的 enum variant 分派到对应的处理函数。
4. 每个 dispatch 单独 instrument 一个 tracing span（可观测性内置）。
5. 收到 `Op::Shutdown` 退出循环。

**和 Claude Code `queryLoop` 的对照**：

| 维度 | `queryLoop` (Claude Code) | `submission_loop` (Codex) |
|------|---------------------------|----------------------------|
| 触发输入 | `submitMessage(prompt)` 直接调用 | 从 `rx_sub` channel 收 `Submission` |
| 输出 | `yield` SDKMessage | `tx_event.send(Event)` |
| 操作类型 | 一种：用户消息进来跑推理 | ~20 种 Op：UserInput、UserTurn、Interrupt、Shutdown、RealtimeConversationStart、OverridePermissionProfile … |
| 中断处理 | 通过 `AbortController` | 显式 `Op::Interrupt` 经过 channel |
| 关闭 | generator 结束自然结束 | 显式 `Op::Shutdown` |

注意一个微妙的设计差别：Codex 的 dispatcher 是**消息驱动**，Claude Code 的是**调用驱动**。消息驱动的好处是 Op 类型可以无限扩展（加一种新 Op 不影响其他），坏处是失去类型化的"调用→返回值"对应——你 send 完一个 Submission，结果会以零个或多个 Event 异步流回，结果和提交的关联只能靠 `id` 字段做匹配。

A subtle design difference: Codex's dispatcher is **message-driven**, Claude Code's is **call-driven**. Message-driven's upside is unbounded Op extensibility — adding a new Op doesn't touch other handlers. The downside is losing the typed "call → return value" correspondence: after you `send()` a Submission, results come back as zero-or-more async Events, and the only correlation is the `id` field.

这就是为什么 `Event { id: String, msg: EventMsg }` 必须带 `id`——它对应触发它的 `Submission.id`。Claude Code 的 `SDKMessage` 不需要，因为它和 `submitMessage()` 调用是 1:N 同步对应。

This is exactly why `Event { id: String, msg: EventMsg }` must carry `id` — it correlates to the triggering `Submission.id`. Claude Code's `SDKMessage` doesn't need this because it has 1:N synchronous correspondence with the `submitMessage()` call.

---

### [33:00] Slide 7: The Op enum and what users can ask for

`Op` 在 `protocol/src/protocol.rs` 里，是**用户能让引擎做的所有事**的枚举。前 3 个最重要：

- **`Op::UserInput { items }`** — 普通对话。把 `items` 追加到当前 thread 上，触发推理。
- **`Op::UserTurn { items, model, effort, summary, cwd, approval_policy, sandbox_policy, ... }`** — "完整 turn 配置"版本的 UserInput，可以一次性指定模型、推理强度、cwd 等覆盖。SDK 集成场景常用。
- **`Op::Interrupt`** — 中断当前 turn。设计成单独 Op 而不是 `tx_sub.cancel()` 是关键——它走和 UserInput 同一个 dispatch 通道，所以中断信号有"位置感"：它会被排在它后面发送的其他 Op 之前处理（取决于 channel 类型）。

接下来覆盖另外 17 种 Op：`Op::Shutdown`、`Op::OverridePermissionProfile`、`Op::OverrideTurnContext`、`Op::CompactNow`、`Op::EditPreviousMessage`、`Op::RealtimeConversationStart`/`Stop`/`Sdp`、`Op::ToolApprovalDecision`、`Op::Subscribe`、`Op::ListMcpTools`、`Op::CleanBackgroundTerminals` 等。

> **设计反思**：把所有用户操作都建模成 `Op` 枚举，是 [Erlang 邮箱模型](https://www.erlang.org/doc/system/messageboxes.html) 在 Rust 里的现代化版本。优点是协议可序列化（实际上 Codex 的 `app-server` 就把 Submission/Event 走 JSON over WebSocket 暴露给 IDE 客户端），缺点是 API 表面比 method-based 更分散。
>
> **Design reflection**: modeling every user action as an `Op` variant is the [Erlang mailbox model](https://www.erlang.org/doc/system/messageboxes.html) modernized for Rust. The advantage: the protocol is serializable (Codex's `app-server` actually exposes Submission/Event as JSON over WebSocket to IDE clients). The disadvantage: API surface is more scattered than method-based.

---

### [35:00] Slide 7b: Worked example — Ctrl+C 之后发生了什么 / What happens after Ctrl+C

理解 `Op::Interrupt` 最快的方式是跟着一次真实的 Ctrl+C 走一遍。

**Step 1**：用户在 IDE 里按下 Ctrl+C。

**Step 2**：前端封装出 `Submission { op: Op::Interrupt }`，经 `tx_sub` 投入提交队列。注意：它和普通用户输入走**同一条队列**，不是带外信号。

**Step 3**：`submission_loop` 在 `handlers.rs:962` 顺序 `rx_sub.recv()` 取到这条提交。

**Step 4（关键）**：匹配到 `Op::Interrupt => { interrupt(&sess).await; false }`（`handlers.rs:973`），触发中止当前 turn 的逻辑。

**Step 5**：引擎回发 `EventMsg::TurnAborted`，前端据此收尾。

**Step 1**: The user presses Ctrl+C in the IDE.

**Step 2**: The frontend wraps it as `Submission { op: Op::Interrupt }` and sends it via `tx_sub` into the submission queue — the **same queue** as ordinary user input. It is not an OS-level out-of-band signal.

**Step 3**: `submission_loop` picks it up with `rx_sub.recv()` at `handlers.rs:962`.

**Step 4 (the key moment)**: It matches `Op::Interrupt => { interrupt(&sess).await; false }` at `handlers.rs:973`, triggering the abort of the active turn.

**Step 5**: The engine emits `EventMsg::TurnAborted`; the frontend winds down.

为什么不用 OS 信号直接打断引擎？因为 `Op::Interrupt` 是排进同一信箱的一等公民，有确定的"位置感"：它不会踩到正在写入的数据结构，不会在两个原子操作之间插入，行为可预测、可序列化、能跨进程。代价是它得等队列轮到它——但对编码 Agent 来说，这个延迟完全可接受，且换来了安全保证。

Why not interrupt the engine with an OS signal? Because `Op::Interrupt` queued in the same mailbox as all other ops has a determinate position: it cannot tear through in-progress data structure writes or land between two atomic operations. The behavior is predictable, serializable, and transport-agnostic. The trade-off is latency — it waits its turn in the queue — but for a coding agent that's entirely acceptable, and the determinism guarantee is worth it.

---

### [38:00] Slide 8: The Event enum (~40 variants) — what flows out

打开 `protocol/src/protocol.rs:1296`。`Event` 结构两个字段：`id: String`（关联回 Submission）和 `msg: EventMsg`。`EventMsg` 是一个 serde-tagged enum，目前 ~40 个 variant，按职责分 6 组：

**生命周期事件**：`TurnStarted`（v2 别名 `task_started`）、`TurnComplete`、`SessionConfigured`、`Error`、`Warning`、`GuardianWarning`。

**模型输出事件**：`AgentMessage`（assistant 文本）、`AgentReasoning`（thinking 内容）、`AgentMessageDelta`（流式增量）、`AgentReasoningDelta`、`AgentReasoningRawContent`。

**工具事件**：`ExecCommandBegin`/`End`、`PatchApplyBegin`/`End`、`McpToolCallBegin`/`End`、`WebSearchBegin`/`End`。

**审批事件**：`ApprovalRequested`、`ApprovalResolved`。

**状态事件**：`TokenCount`（每 turn 累计 token 用量）、`ContextCompacted`、`ThreadRolledBack`、`ModelReroute`（fallback 模型路由）、`ModelVerification`。

**Realtime 事件**：`RealtimeConversationStarted`、`RealtimeConversationRealtime`、`RealtimeConversationClosed`、`RealtimeConversationSdp`。

**和 Claude Code SDKMessage 对照**：Claude Code 的 SDKMessage 类型也很多（system_init、user、assistant、result、stream_event 等），数量约 12 种。Codex 的 EventMsg 多得多，主要因为：

| 增量来源 | 多出的事件 |
|---------|------------|
| 显式工具进度 | ExecCommandBegin/End, PatchApplyBegin/End, McpToolCallBegin/End, WebSearchBegin/End |
| 审批分离 | ApprovalRequested, ApprovalResolved |
| 状态独立 | ModelReroute, ModelVerification, ThreadRolledBack |
| Realtime 通道 | 4 种 RealtimeConversation* |

Codex 把 Claude Code 内联在工具结果里的进度信息**拆成了独立事件**——这对 IDE/TUI 客户端非常友好（可以精确定位"现在正在跑 bash 命令"），代价是协议表面更大。

Codex breaks out as separate events what Claude Code inlines into tool results — much friendlier to IDE/TUI clients (precise "currently running bash command" tracking), at the cost of larger protocol surface.

---

### [41:30] Slide 8b: 一次完整 Turn 的端到端追踪 / End-to-end turn timeline

现在把这章所有的零件组装成一次端到端走读。从你敲下 prompt 到答案返回，数据如何穿过各个 actor。

**T0 · 前端（Client）**：`tx_sub.send(Submission { Op::UserTurn })` — 你的 prompt 入提交队列。

**T1 · 调度（submission_loop）**：`rx_sub.recv()` 取出提交，派发一个新 turn（`handlers.rs:962`）。

**T2 · Turn（tokio task）**：`client_session.stream(prompt, …)` 向模型发起流式请求（`turn.rs:1835`）。

**T3 · Turn**：每个 token 到达，向事件通道推送 `EventMsg::AgentMessageContentDelta`（`turn.rs:1554`），前端实时收到增量。

**T4 · Turn**：模型请求执行命令，引擎发出 `EventMsg::ExecCommandBegin`。

**T5 · 子进程（subprocess）**：`codex-linux-sandbox` 在沙箱内执行该命令（独立 helper 二进制）。

**T6 · Turn**：命令完成，发出 `EventMsg::ExecCommandEnd`，结果回灌模型，继续流式生成。

**T7 · Turn**：终答 `AgentMessage` 发出，接着 `EventMsg::TurnComplete`，前端 `rx_event` 收尾。

**T0 · Client**: `tx_sub.send(Submission { Op::UserTurn })` — your prompt enters the submission queue.

**T1 · submission_loop**: `rx_sub.recv()` dequeues it and dispatches a new turn (`handlers.rs:962`).

**T2 · Turn (tokio task)**: `client_session.stream(prompt, …)` opens a streaming request to the model (`turn.rs:1835`).

**T3 · Turn**: each arriving token is forwarded as `EventMsg::AgentMessageContentDelta` (`turn.rs:1554`) — the frontend receives deltas in real time.

**T4 · Turn**: the model requests command execution; the engine emits `EventMsg::ExecCommandBegin`.

**T5 · Subprocess**: `codex-linux-sandbox` runs the command inside the sandbox as an independent helper binary.

**T6 · Turn**: on completion, `EventMsg::ExecCommandEnd` is emitted; the result is fed back into the model to continue streaming.

**T7 · Turn**: the final `AgentMessage` is sent, followed by `EventMsg::TurnComplete`; the frontend drains `rx_event` and closes out.

关键设计结论：前端自始至终只通过 `rx_event` **观察**，从不直接驱动引擎或触碰工具结果。把控制流压成两条可序列化队列，才让"引擎是独立二进制、前端是协议消费者"这个架构目标真正成立。

The architectural takeaway: the frontend is a pure **observer** throughout, receiving events via `rx_event` and never reaching into the engine or tool results directly. Compressing the entire control flow into two serializable queues is what makes the goal — "engine is a standalone binary, frontend is a protocol consumer" — genuinely achievable.

---

### [44:00] Slide 9: Synthesis — Why both designs are correct

把这一章压缩成一句话：**Claude Code 选了"借助语言隐含约束的极简模型"，Codex 选了"显式建模并发关注点的可扩展模型"。**

两边都没错，给定它们的目标：

- Claude Code 的目标是：**在 Anthropic SDK 内部工作良好，作为一个嵌入式引擎**。SDK 调用方拿到 AsyncGenerator 直接用，不需要管多线程、多消费者、协议序列化。JS 单线程是助力。
- Codex 的目标是：**作为一个独立可执行的、可被多种前端（CLI/TUI/VSCode 扩展/Web）通过协议消费的引擎**。所以它必须把所有用户意图建模成可序列化 Op，把所有引擎输出建模成可序列化 Event。channel pair 是 Op/Event 协议的天然容器。Rust 多线程是必要工具——为了能跑后台 goal、async tool result、realtime audio 同时存在。

A one-line summary: **Claude Code chose "the minimal model that leans on language-implicit constraints," Codex chose "the extensible model that explicitly captures concurrency concerns."**

Both are correct given their goals:

- **Claude Code's goal**: work well **inside the Anthropic SDK as an embedded engine**. SDK callers consume an AsyncGenerator directly; no multi-thread, multi-consumer, or serialization concerns. JS's single-threaded model is an asset.
- **Codex's goal**: be a **standalone executable engine consumed by multiple frontends (CLI/TUI/VSCode/Web) via protocol**. So all user intent must be modeled as serializable Op, all engine output as serializable Event. Channel pair is a natural carrier. Rust multi-threading is necessary — to run background goals, async tool results, and realtime audio concurrently.

**结论**：Codex 的核心引擎不是 Claude Code 的"翻译版"，是"另一种工程目标驱动出来的另一套设计"。它们解决同一个问题，但优化的成本函数不同。这就是横向对比的真正价值——你不是在判断谁好，是在理解**目标驱动设计**这件事本身。

**Conclusion**: Codex's core engine isn't a "translation" of Claude Code's — it's "a different design driven by different engineering goals." They solve the same problem with different cost functions optimized. This is the actual value of horizontal comparison — you're not judging which is better, you're understanding **goal-driven design** as a phenomenon.

---

### Closing / 收尾

下一章 ch02 我们看 Codex 的工具系统：`ToolHandler` trait 怎么把 shell 执行、文件 patch、MCP 调用、批量子 agent spawn、动态用户工具统一到一个 dispatch 模型里——和 Claude Code 在 `src/tools/*` 的类继承体系正好相反。

Next chapter (ch02) covers Codex's tool system: how the `ToolHandler` trait unifies shell exec, file patching, MCP calls, batch sub-agent spawning, and user-dynamic tools under one dispatch model — the inverse of Claude Code's class-inheritance hierarchy in `src/tools/*`.

---

## Status / 状态

**Draft v0.1** — 2026-05-01

- [x] 9 sections drafted (~7,800 words bilingual)
- [ ] HTML slides not yet authored
- [ ] Diagrams not yet rendered
- [ ] Cross-reference verification: spot-checked Codex struct (mod.rs:369), submission_loop (handlers.rs:962), Session struct (session.rs:11), Event/EventMsg (protocol.rs:1296). Still TODO: full audit of every file:line reference.
- [ ] Peer review needed before recording

**Open questions**:
- Is the time budget realistic? 9 sections × ~5 min = 45 min, on target.
- Should slide 4 (the AsyncGenerator vs Channel comparison table) be its own dedicated mini-chapter? It carries a lot of weight.
- The phrase "valitation chapter" framing: keep, or move to README?
