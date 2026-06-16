# Chapter 4 (Codex): Batch Jobs & Goals — The Autonomy Stack

## ⏱️ Target Duration: ~50 minutes | 📑 ~22 slides | 📝 ~9,500 words

> **The second Codex-unique chapter.** ch03 covered defensive-engineering investment (sandbox); ch04 covers offensive-engineering investment (autonomy). Two features here that Claude Code's architecture doesn't support: (1) CSV-driven map-reduce sub-agent spawning with up to 64 concurrent workers, (2) persistent thread goals with autonomous continuation when the agent goes idle.
>
> **Codex 独有的第二章。** ch03 看防御性工程投入（沙箱），ch04 看进攻性工程投入（自主性）。两个 Claude Code 完全没有的能力：(1) CSV 驱动的 map-reduce 子 agent，最多 64 个并发 worker；(2) 持久化的 thread goal，agent 闲置时自动 continue。

---

### Core Source Files Referenced

Pinned commit: `e4d6675`, 2026-05-01. All paths under `codex-rs/`.

**Batch jobs:**
* `core/src/tools/handlers/agent_jobs.rs:39` → `BatchJobHandler` struct
* `core/src/tools/handlers/agent_jobs.rs:41-44` → `DEFAULT_AGENT_JOB_CONCURRENCY = 16`, `MAX_AGENT_JOB_CONCURRENCY = 64`, `STATUS_POLL_INTERVAL = 250ms`, `DEFAULT_AGENT_JOB_ITEM_TIMEOUT = 30 min`
* `core/src/tools/handlers/agent_jobs.rs:46-56` → `SpawnAgentsOnCsvArgs` 输入合约
* `core/src/tools/handlers/multi_agents.rs` → v1 多 agent 系统
* `core/src/tools/handlers/multi_agents_v2/{spawn,wait,send_message,close_agent,list_agents}.rs` → v2 多 agent 系统（持久 inter-agent 通信）

**Goals:**
* `core/src/goals.rs` → 完整 goal 运行时
* `core/src/goals.rs:38-47` → `SetGoalRequest` / `CreateGoalRequest` 输入
* `core/src/goals.rs:49-63` → `CONTINUATION_PROMPT_TEMPLATE` / `BUDGET_LIMIT_PROMPT_TEMPLATE`（编译期 `include_str!` 进 binary 的提示词模板）
* `core/templates/goals/continuation.md` → 自动 continue 时注入的 steering prompt
* `core/templates/goals/budget_limit.md` → 预算超限时的 steering prompt
* `core/src/goals.rs:76+` → `GoalRuntimeEvent` 枚举
* `core/src/state/` → `StateDbHandle`、SQLite 持久化层
* `core/src/tools/handlers/goal.rs` → 暴露给 LLM 的 goal 操作工具

---

### [00:00] Opening (Slide 1: Cover)

把 Claude Code 和 Codex 在 "Agent 自主性" 维度上摆开比较：

| 自主性能力 | Claude Code | Codex |
|-----------|-------------|-------|
| 单次启动 N 个并行子 agent | ❌（Task 工具一次一个） | ✅（最多 64 个并发） |
| 子 agent 以结构化数据驱动 | ❌ | ✅（CSV map-reduce 一等公民） |
| 跨 turn 持久化目标 | ❌ | ✅（SQLite-backed） |
| Agent 闲置时自动 continue | ❌ | ✅（GoalRuntimeEvent 触发） |
| Token 预算硬限 | ⚠️（per-turn）| ✅（per-goal，超限有 steering） |
| Agent 间长期 messaging | ❌ | ✅（multi_agents_v2/send_message） |

**这一章拆解 Codex 怎么把 agent 从"对话伙伴"推向"自主完成长任务的执行体"**——以及为什么 Claude Code 的架构从根上不能这样推。

This chapter dissects how Codex pushes agents from "conversation partner" toward "autonomous executor of long tasks" — and why Claude Code's architecture fundamentally can't push the same direction.

带一个问题进章节：**当 agent 能在你睡觉时自己继续工作、能 fan-out 64 个 worker 同时跑，"agent" 这个概念还成立吗？还是它已经变成"自主进程"？**

Take this question into the chapter: **when an agent can keep working while you sleep, and fan-out 64 workers in parallel, does the concept of "agent" still hold? Or has it become an "autonomous process"?**

---

## Part A: Batch Jobs — Map-Reduce as a First-Class Tool (Slides 2–11)

### [03:30] Slide 2: The Claude Code Baseline — One Child at a Time

先确立基线。Claude Code 的 `Task` 工具是这样的：

```
LLM 决定要委派 → Task(prompt="...") → 启动子 agent → 等子 agent 完成 → 拿结果
                                                              │
                                                       (这一段是同步的)
```

主 agent 阻塞等子 agent。如果你要"对 100 个文件做同样的分析"，要么主 agent 自己循环 100 次（慢），要么用户手动并行起 100 个 Task 调用（不可能，因为 LLM 一次只能写一个 tool call）。

The main agent blocks waiting for the child. If you want to "do the same analysis on 100 files," either the main agent loops 100 times (slow), or the user manually parallelizes 100 Task calls (impossible — the LLM can only emit one tool call at a time).

**结果**：Claude Code 上 sub-agent 适合"我需要一个隔离上下文的搜索"或"我需要一个独立 context 做某个调研"——不适合"我需要批量处理 N 个相似项"。

**Result**: Claude Code's sub-agents are suited for "I need an isolated-context search" or "I need an independent context for some research" — not for "I need to batch-process N similar items."

---

### [07:00] Slide 3: Codex's Answer — `spawn_agents_on_csv`

打开 `core/src/tools/handlers/agent_jobs.rs:39`：

```rust
pub struct BatchJobHandler;

const DEFAULT_AGENT_JOB_CONCURRENCY: usize = 16;
const MAX_AGENT_JOB_CONCURRENCY: usize = 64;
const STATUS_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DEFAULT_AGENT_JOB_ITEM_TIMEOUT: Duration = Duration::from_secs(60 * 30);
```

四个常量已经把整个能力的形状勾出来：

- **DEFAULT_AGENT_JOB_CONCURRENCY = 16** — 默认同时跑 16 个 worker
- **MAX_AGENT_JOB_CONCURRENCY = 64** — 上限 64 个 worker
- **STATUS_POLL_INTERVAL = 250ms** — 每 250ms 查一次 worker 状态
- **DEFAULT_AGENT_JOB_ITEM_TIMEOUT = 30 minutes** — 单个 item 默认 30 分钟超时

工具的输入合约（`SpawnAgentsOnCsvArgs:46`）：

```rust
struct SpawnAgentsOnCsvArgs {
    csv_path: String,           // 输入 CSV 文件
    instruction: String,        // 每行执行的指令模板
    id_column: Option<String>,  // 哪一列作为 item id
    output_csv_path: Option<String>,
    output_schema: Option<Value>,
    max_concurrency: Option<usize>,
    max_workers: Option<usize>,
    max_runtime_seconds: Option<u64>,
}
```

**这是真实的 map-reduce 原语**——LLM 可以发起 `spawn_agents_on_csv(csv_path="files.csv", instruction="for each file in {{path}} column, summarize and write to {{output}} column")`，Codex 引擎就：

1. 读 CSV，每行作为一个任务
2. 启动一个 worker pool（≤max_concurrency）
3. 对每行 spawn 一个新的 sub-agent，sub-agent 在隔离的 thread 里跑 instruction
4. 收集每个 sub-agent 的结果
5. 写入 output CSV

**This is real map-reduce as a primitive** — the LLM can call `spawn_agents_on_csv(...)` and the Codex engine handles fanout, worker pool, result collection.

输出合约：

```rust
struct SpawnAgentsOnCsvResult {
    job_id: String,
    status: String,
    output_csv_path: String,
    total_items: usize,
    completed_items: usize,
    failed_items: usize,
    job_error: Option<String>,
    failed_item_errors: Option<Vec<AgentJobFailureSummary>>,
}
```

**注意 `total_items` / `completed_items` / `failed_items`**：这是工业级批处理的语义——partial failure 是预期的，单个 item 失败不能让整个 job 失败，结果里要显式带 failed item 列表给上层做后续决策。

**Note `total_items` / `completed_items` / `failed_items`**: this is industrial-grade batch semantics — partial failure is expected, single-item failure shouldn't fail the whole job, results explicitly carry the failed-item list for upstream decisions.

---

### [13:00] Slide 4: The Worker Pool — `FuturesUnordered`

`agent_jobs.rs:24-25` 引入：

```rust
use futures::StreamExt;
use futures::stream::FuturesUnordered;
```

这是 Codex 选的并发原语：`FuturesUnordered`——一个能动态添加 future 并按完成顺序消费的集合。和 `Vec<JoinHandle>` + `select!` 比，`FuturesUnordered` 的优势是：

1. 不要求预先知道有多少 future
2. 完成顺序消费（不像 `join_all` 等所有完成）
3. Backpressure 友好——配合 `for_each_concurrent(N)` 限制并发上限

**Codex 的 worker pool 模式**（伪代码）：

```rust
let semaphore = Arc::new(Semaphore::new(max_concurrency));
let mut workers = FuturesUnordered::new();

for item in csv_rows {
    let permit = semaphore.clone().acquire_owned().await?;
    workers.push(async move {
        let result = spawn_sub_agent_for(item).await;
        drop(permit);  // 释放槽位
        (item.id, result)
    });
}

while let Some((id, result)) = workers.next().await {
    record_result(id, result);
}
```

Semaphore 限并发上限；FuturesUnordered 收集结果；`while let Some(...) = workers.next().await` 按完成顺序处理。

> **架构反思**：用 Tokio 标准并发原语（Semaphore + FuturesUnordered）实现 worker pool，没有自定义调度器，没有线程池配置——整个并发模型靠 Tokio runtime 自己的 scheduler。这是 Rust 异步生态的 idiomatic 写法，每个 Rust 程序员看到都立刻懂。
>
> **Architecture reflection**: building a worker pool with stock Tokio primitives (Semaphore + FuturesUnordered), no custom scheduler, no thread pool config — the entire concurrency model rides on Tokio's own scheduler. This is idiomatic async Rust; every Rust programmer recognizes the pattern immediately.

**对照 Claude Code**：JavaScript 的 `Promise.all(items.map(...))` 能做类似的并发，但有几个根本限制：(1) 没有 Tokio 那样的工作窃取调度器，重 CPU 任务会互相阻塞；(2) 没有 backpressure 控制，1000 个 promise 同时 pending 会爆内存；(3) 没有 `Send + Sync` trait 强制，跨 promise 共享状态的安全靠程序员小心。Codex 用 Rust 写这个 pool 不只是性能差异——是**结构性能力**差异。

**vs Claude Code**: JS's `Promise.all(items.map(...))` can do similar concurrency, but has fundamental limits: (1) no Tokio-style work-stealing scheduler, heavy CPU tasks block each other; (2) no backpressure control, 1000 pending promises blow memory; (3) no `Send + Sync` trait enforcement, cross-promise shared state safety relies on programmer caution. Codex using Rust here isn't just performance — it's a **structural capability** difference.

---

### [19:00] Slide 5: Sub-Agent Lifecycle — Fresh Thread Per Item

每个 worker 跑的是什么？看 `agent_jobs.rs:13`：

```rust
use crate::tools::handlers::multi_agents::build_agent_spawn_config;
```

每个 CSV row → 一个 fresh thread（`SessionSource::SubAgent`）→ 用户 instruction 模板填充该行的列值 → 子 agent 在隔离 context 里跑。

**继承的东西**：
- 父 agent 的 cwd、shell env
- 父 agent 的 sandbox policy（子 agent 不能比父 agent 更宽松）
- 父 agent 的 MCP server 连接
- 父 agent 的 model 选择

**不继承的东西**：
- 父 agent 的对话历史（每个子 agent 有自己的 thread）
- 父 agent 的 active tool state
- 父 agent 的 token usage（每个子 agent 有自己的 budget）

**Inherited**: cwd, shell env, sandbox policy (sub-agent can't be more permissive than parent), MCP connections, model choice.

**Not inherited**: parent's conversation history (each sub-agent has its own thread), parent's active tool state, parent's token usage (each sub-agent gets its own budget).

> **设计选择**：每个 sub-agent 独立 thread 意味着 sub-agent 的 LLM context 是干净的——只有 instruction + 该 row 的数据，没有父 agent 的上下文污染。代价是没法让 sub-agent "知道父 agent 在做什么"。这是个**有意识的隔离设计**，不是缺陷。
>
> **Design choice**: independent thread per sub-agent means sub-agent's LLM context is clean — only instruction + that row's data, no parent context pollution. The cost: sub-agent has no way to "know what the parent is doing." This is **intentional isolation**, not a defect.

---

### [24:00] Slide 6: The v2 Multi-Agent System — Persistent Inter-Agent Messaging

`spawn_agents_on_csv` 是 fire-and-forget 的 batch 模式。Codex 还有一个**更高级的 v2 多 agent 系统**，在 `core/src/tools/handlers/multi_agents_v2/` 下：

```
multi_agents_v2/
├── spawn.rs           - 启动一个长期存活的 sub-agent
├── wait.rs            - 等某个 sub-agent 到达某状态
├── send_message.rs    - 给某个 sub-agent 发消息
├── close_agent.rs     - 关闭一个 sub-agent
├── list_agents.rs     - 列出当前活跃的 sub-agent
├── followup_task.rs   - 给 sub-agent 派生任务
└── message_tool.rs    - 通用消息原语
```

这是**长期 inter-agent 通信架构**——sub-agent 不是一次性 worker，而是 "另一个对话伙伴"，主 agent 可以反复给它发消息、等它回复、给它派生任务、最后关闭它。

This is **long-running inter-agent communication architecture** — sub-agents aren't one-shot workers, they're "another conversation partner" the main agent can repeatedly message, wait on, dispatch tasks to, and eventually close.

**对应的隐喻**：
- v1 batch jobs ≈ shell 的 `xargs -P 16` 或 GNU `parallel`——批处理
- v2 multi-agents ≈ 操作系统的进程模型——长期存在的实体，通过 message passing 协作

**Metaphors**:
- v1 batch jobs ≈ shell's `xargs -P 16` or GNU `parallel` — batch processing
- v2 multi-agents ≈ OS process model — long-lived entities collaborating via message passing

Codex 同时支持两种模式说明：作者对 "agent 之间该怎么协作" 这个问题没有一个答案，他们让 LLM 自己根据任务选模式。

That Codex supports both modes simultaneously says: the authors have no single answer to "how should agents collaborate" — they let the LLM choose the mode by task.

> **未解之谜**：v1 和 v2 是平行存在还是 v2 要替代 v1？源码里 v1 和 v2 都活跃维护（看 commit log），暗示是平行——不同任务用不同模式。这本身是有意思的产品决策。
>
> **Open question**: are v1 and v2 parallel or is v2 meant to replace v1? Both are actively maintained per git log — suggesting parallel by design, different modes for different tasks. The product decision itself is interesting.

---

## Part B: Goals — Persistent Objectives & Autonomous Continuation (Slides 7–18)

### [29:00] Slide 7: The Goal Concept

打开 `core/src/goals.rs:1`：

```rust
//! Core support for persisted thread goals.
//!
//! This module bridges core sessions and the state-db goal table. It validates
//! goal mutations, converts between state and protocol shapes, emits goal-update
//! events, and owns helper hooks used by goal lifecycle behavior.
```

模块文档说得很清楚：goal 是**持久化在 state-db 里的 thread 级目标**。"thread" 是一次会话；"goal" 是这个会话的高层级目标，跨 turn 存在，跨进程重启依然存在（因为存在 SQLite）。

The module doc is explicit: a goal is a **thread-level objective persisted in state-db**. "thread" is a session; "goal" is the session's high-level objective, persisting across turns, surviving process restarts (because it's in SQLite).

**Goal 的输入合约** (`goals.rs:38`)：

```rust
pub(crate) struct CreateGoalRequest {
    pub(crate) objective: String,
    pub(crate) token_budget: Option<i64>,
}
```

两个字段：
- `objective: String` — 目标的自然语言描述
- `token_budget: Option<i64>` — 这个目标允许烧的最大 token 数（None 表示无限）

That's it. 两个字段就建模了 "agent 自主完成一个长任务" 的全部 metadata。

That's it. Two fields model all the metadata for "agent autonomously completes a long task."

---

### [33:00] Slide 8: The Continuation Mechanism — Templates Baked at Compile Time

`goals.rs:49`：

```rust
static CONTINUATION_PROMPT_TEMPLATE: LazyLock<Template> =
    LazyLock::new(
        || match Template::parse(include_str!("../templates/goals/continuation.md")) {
            Ok(template) => template,
            Err(err) => panic!("embedded goals/continuation.md template is invalid: {err}"),
        },
    );

static BUDGET_LIMIT_PROMPT_TEMPLATE: LazyLock<Template> =
    LazyLock::new(
        || match Template::parse(include_str!("../templates/goals/budget_limit.md")) {
            ...
        },
    );
```

两个**编译期 baked-in 的 prompt template**：
- `continuation.md` — agent 闲置时自动 continue 用的 steering prompt
- `budget_limit.md` — 超 token budget 时的 steering prompt

`include_str!` 在编译期把模板内容嵌入二进制，这和 ch03 里 Seatbelt 的 `.sbpl` 文件用同样的策略：**关键提示词不能在运行时被外部文件污染**。

`include_str!` embeds template contents at compile time, same strategy as ch03's Seatbelt `.sbpl` files: **critical prompts must not be poisonable by external runtime files**.

`LazyLock` 让模板只在第一次访问时解析（避免 binary load 时的额外开销，但只解析一次）。`panic!("embedded ... is invalid")` 是兜底——如果开发者手贱改坏了模板，`cargo test` 第一次访问就 panic，CI 立刻挂。

`LazyLock` ensures the template parses only on first access (no binary-load overhead, but parsed once). The `panic!` is a safety net — if a developer breaks the template, `cargo test` panics on first access and CI fails immediately.

> **设计反思**：编译期固化 prompt 是 LLM-driven 系统的合规姿势——一个公司想 audit "你们 agent 自动 continue 时给 LLM 的指令是什么"，从 binary disasm 就能找到，不能动态改。这种"prompt 是代码的一部分"的姿态，和 LangChain 那种"prompt 在 runtime config 里"的姿态正好相反。
>
> **Design reflection**: compile-time-frozen prompts are the compliance-friendly posture for LLM-driven systems — a company auditing "what instructions do you give the LLM during autonomous continuation" can disasm the binary and find it; it can't be runtime-modified. The "prompts are part of the code" stance is exactly opposite to LangChain's "prompts are runtime config."

---

### [38:00] Slide 9: GoalRuntimeEvent — How Goals React to Session Lifecycle

`goals.rs:76`：

```rust
pub(crate) enum GoalRuntimeEvent<'a> {
    TurnStarted {
        turn_context: &'a TurnContext,
        token_usage: TokenUsage,
    },
    TurnComplete { ... },
    TurnAborted { ... },
    MaybeContinueIfIdle { ... },
    // ... 更多
}
```

注释（`goals.rs:71`）：

> "Runtime lifecycle events that can affect goal accounting, scheduling, or model-visible steering. **Callers report the session event they observed; this module owns the policy for how that event changes goal runtime state.**"

这个分离很关键：**session 模块只负责报告"发生了什么"（turn started / completed / aborted），goals 模块负责决定"这个事件对 goal 状态意味着什么"**。这是 Domain-Driven Design 风格的责任划分——goal 的业务逻辑集中在 goal 模块，session 模块不被 goal 概念污染。

This separation is critical: **session module only reports "what happened" (turn started/completed/aborted), goals module owns the policy for "what does this event mean for goal state."** This is Domain-Driven Design-style separation — goal business logic centralized in the goals module, session module not polluted by goal concepts.

**`MaybeContinueIfIdle` 是关键 variant**——session 闲置时 emit 这个事件给 goals 模块，goals 模块判断：
1. 当前 thread 是否有未完成 goal？
2. 如果有，token budget 还剩多少？
3. 如果还有 budget 且 goal 未完成，注入 `CONTINUATION_PROMPT_TEMPLATE` 触发 LLM 继续推理

**`MaybeContinueIfIdle` is the key variant** — when session goes idle, emit this event to goals module, which judges: (1) does current thread have unfinished goal? (2) if yes, how much token budget remains? (3) if budget remains and goal unfinished, inject `CONTINUATION_PROMPT_TEMPLATE` to trigger LLM continuation.

**autonomy 的循环就在这里**：
```
Turn 完成 → Session idle → MaybeContinueIfIdle → goals 判断未完成 → 注入 continuation prompt
                                                                       │
                                                                       ▼
                                                              LLM 继续推理 → 新 turn → ...
```

直到：(a) goal 被 LLM 标记为完成（写状态回 state-db），(b) token budget 耗尽（注入 budget_limit prompt 让 LLM 体面收尾），或 (c) 用户介入。

Until: (a) LLM marks goal as complete (writes state back to state-db), (b) token budget exhausted (inject budget_limit prompt for LLM to finish gracefully), or (c) user intervenes.

---

### [44:00] Slide 10: state-db — SQLite as the Persistence Layer

goal 数据存在哪里？`goals.rs:7`：

```rust
use crate::StateDbHandle;
```

`StateDbHandle` 是对 SQLite 数据库的封装，定义在 `codex-rs/state/` crate 里。Codex 用 SQLite 存：

- thread metadata（thread id、创建时间、所属用户）
- goals（goal id、objective、token_budget、status、所属 thread）
- agent jobs（job id、CSV 输入、output 进度、failed items）
- memories（每个 user/agent 的长期记忆，对应 ch00 提到的 `memories/{read,write}` crate）
- rollouts（推理历史的回放/调试数据，对应 `rollout` crate）

SQLite as the persistence layer covers: thread metadata, goals, agent jobs, memories, rollouts.

**为什么 SQLite 而不是 Postgres、Redis、自定义 file format？**
1. **本地 agent，本地 state**——没有 server 的概念，状态就在用户机器上
2. SQLite 在 Rust 生态成熟（`rusqlite`、`sqlx::sqlite`）
3. 单文件，便于备份/迁移/inspect
4. 强 schema + ACID，在 agent 频繁中断/重启场景下数据完整性强
5. 支持 SQL，调试时用户可以 `sqlite3 ~/.codex/state.db` 直接查

**Why SQLite over Postgres, Redis, custom file format?**
1. **Local agent, local state** — no server concept, state lives on user's machine
2. Mature in Rust ecosystem (`rusqlite`, `sqlx::sqlite`)
3. Single file, easy backup/migration/inspection
4. Strong schema + ACID, robust against agent interrupt/restart
5. SQL support — users can `sqlite3 ~/.codex/state.db` to debug

**Claude Code 对照**：Claude Code 把 memory 存为 markdown 文件在 `~/.claude/memory/` 下，没有数据库层。优势是文件化简单（用户能 cat 能 grep 能 git track），劣势是不支持复杂查询（"找出所有未完成的 goal" 在 markdown 模型下要遍历所有文件）。

**Claude Code contrast**: Claude Code stores memory as markdown files under `~/.claude/memory/`, no database layer. Pro: file-simple (user can cat, grep, git track). Con: no complex queries ("find all unfinished goals" in the markdown model requires scanning all files).

---

### [49:00] Slide 11: The Token Budget Mechanism

`goals.rs:38` 的 `SetGoalRequest` 有 `token_budget: Option<Option<i64>>` 这个奇怪的双 Option。

外层 `Option` = "是否要修改 budget"（None 表示这次请求不动 budget）
内层 `Option` = "新的 budget 值是多少"（None 表示设为无限，Some(n) 表示设为 n）

这是 PATCH 语义和值语义的组合。"Either don't touch this field, or set it to (no-limit | specific-limit)."

This is a combination of PATCH semantics and value semantics. "Either don't touch this field, or set it to (no-limit | specific-limit)."

**Budget 怎么消费**？每次 turn 完成，goal 模块更新当前 goal 的累计 token 用量。当累计接近 budget：

1. 还有 buffer → 正常 continue
2. 超过 80% → maybe inject "you have X% budget left" 提示
3. 超过 100% → 注入 `BUDGET_LIMIT_PROMPT_TEMPLATE`，让 LLM "summarize what you've done, leave clear handoff notes, and stop"

`BudgetLimitSteering` enum (`goals.rs:65`)：

```rust
enum BudgetLimitSteering {
    Allowed,    // 允许超 budget 后继续 steering（LLM 看到"超 budget"后自己决定）
    Suppressed, // 不再 steering（硬停）
}
```

两种 budget 超限处理模式：软停（让 LLM 自己优雅收尾）vs 硬停（拒绝继续）。这是**给用户/admin 的 policy 旋钮**——企业部署可能要硬停（合规、成本控制），个人使用可能要软停（让 agent 至少把笔记留下）。

Two budget-overrun modes: soft-stop (let LLM gracefully wind down) vs hard-stop (refuse to continue). This is a **policy knob for users/admins** — enterprise deployments may want hard-stop (compliance, cost control), individual use may want soft-stop (at least let the agent leave notes).

> **关键洞察**：token budget 不只是 cost control——它是**自主性的安全阀**。如果 agent 能无限 continue，它会变成失控的 LLM 调用循环。budget + continuation 配合让"自主性"成为有边界的能力。
>
> **Key insight**: token budget isn't just cost control — it's the **safety valve of autonomy**. If the agent could continue indefinitely, it'd become a runaway LLM-call loop. Budget + continuation together make "autonomy" a bounded capability.

---

## Part C: Synthesis (Slides 12–13)

### [54:00] Slide 12: The Autonomy Spectrum

把 ch04 提到的所有自主性能力放到一个谱系上：

```
低自主                                                              高自主
─────────────────────────────────────────────────────────────────────────►

REPL                Tool-using            Multi-tool         Sub-agent          Persistent
模式                 agent                 batch               messaging         goals + auto-continue
                    (Claude Code)          (Codex CSV jobs)    (Codex v2)        (Codex goals)

每次回复需             模型决策每个             模型一次发         agent 之间能           agent 在用户
人类输入               单步骤                 N 步并行          反复对话             不察觉时持续工作
```

Claude Code 站在"Tool-using agent"档位：模型能决定用工具，但每个 turn 结束后系统等待用户。Codex 一脚跨过 batch，一脚跨过 multi-agent messaging，到了 "persistent goals + auto-continue"——光谱最右端。

Claude Code sits at "Tool-using agent": model decides to use tools, but every turn end waits for user. Codex straddles batch, multi-agent messaging, and "persistent goals + auto-continue" — the rightmost end.

**这不是简单的 "Codex 比 Claude Code 高级" 论断**——是两个团队对"agent 应该多自主"的不同押注：

- Claude Code 押 "agent 是助手，人类是主驾驶"
- Codex 押 "agent 是合作者，能在某些场景里独立工作"

This isn't simply "Codex is more advanced" — it's two teams' different bets on "how autonomous should agents be":
- Claude Code bets "agent is assistant, human is primary driver"
- Codex bets "agent is collaborator, can work independently in some scenarios"

两个押注都未被证伪。下一代 LLM coding agent 会被这两种文化拉扯多年。

Both bets remain unfalsified. The next generation of LLM coding agents will be pulled between these two cultures for years.

---

### [58:00] Slide 13: The Risks of Autonomy

不能不谈代价。Codex 的自主性栈带来的真实风险：

1. **失控成本**：goal 系统让 agent 能在用户不察觉下消耗大量 token——bug 或 prompt-injection 导致的 runaway 是真威胁。budget 是软兜底，不是硬保证（除非配 `BudgetLimitSteering::Suppressed`）。
2. **可追溯性**：64 个并发 sub-agent 同时跑，每个有自己的 thread + tool 调用 + 状态变更——观测、debug、问责都困难。这就是为什么 `rollout` + `rollout-trace` crate 存在。
3. **意外破坏**：autonomous continue 在没有人审批的情况下持续执行 mutating 操作。即使有 sandbox 兜底（ch03），sandbox 内部的破坏（删 cwd 子树的文件）依然真实。
4. **prompt injection 放大**：autonomy 越强，prompt injection 一次成功的 blast radius 越大。Claude Code 一次注入最多影响一个 turn；Codex 注入可能影响一个 12 小时的 goal。
5. **用户预期不匹配**：用户委派 goal 后离开，回来发现 agent 做了"语义上正确但行为上意外"的事——这是 UX 层最难解决的问题。

Real risks of Codex's autonomy stack:
1. **Runaway cost** — goals let the agent consume tokens unnoticed; bugs or prompt-injection driven runaway is a real threat. Budget is a soft floor, not a hard guarantee (unless you configure hard-stop).
2. **Traceability** — 64 concurrent sub-agents with separate threads and tools make observation, debugging, accountability all hard. That's why `rollout` + `rollout-trace` crates exist.
3. **Unintended destruction** — autonomous continue keeps doing mutating operations without per-action approval. Even with sandbox (ch03), in-sandbox destruction (deleting files in the cwd subtree) is real.
4. **Prompt injection amplification** — more autonomy means larger blast radius per injection. Claude Code: max one turn affected. Codex: could affect a 12-hour goal.
5. **User expectation mismatch** — user delegates goal, leaves, returns to find agent did "semantically correct but behaviorally unexpected" things — the hardest UX problem.

**Codex 的押注是这些风险可以被工程化兜底**（sandbox 防破坏、rollout 提供 audit trail、budget 限制 cost、`Suppressed` 模式提供硬刹）。如果他们对，这套架构就是下一代 agent 的范式。如果他们错，市场会重新拥抱"少自主、多人类介入"的模式。

**Codex bets these risks can be engineered around** (sandbox prevents destruction, rollout provides audit trail, budget caps cost, `Suppressed` mode provides hard-brake). If they're right, this architecture becomes the next-gen agent paradigm. If wrong, the market reverts to "less autonomy, more human-in-the-loop."

---

### Closing / 收尾

四章合起来：

**ch01** 看核心引擎——同一个问题，AsyncGenerator vs Channel pair 两种并发哲学。
**ch02** 会看工具系统——同一个问题，TS class 继承 vs Rust trait 两种抽象。
**ch03** 看安全模型——permission prompt vs 内核级强制隔离两种威胁假设。
**ch04** 看自主性栈——助手模式 vs 自主合作者两种产品愿景。

The four chapters together: ch01 core engine (concurrency philosophy), ch02 tools (abstraction style), ch03 safety (threat model), ch04 autonomy (product vision). Four axes of divergence between Codex and Claude Code, each a different but coherent answer to "how do you build a coding agent."

整个 Codex 拆解的一句话总结：**Codex 不是 Claude Code 的 Rust 重写，是一个被不同工程目标和不同产品愿景驱动出来的、形状完全不同的系统——并且它的每个差异都不是任意的，都来自可识别的设计取舍**。

One-line summary of the whole Codex teardown: **Codex isn't a Rust rewrite of Claude Code — it's a fundamentally different-shaped system driven by different engineering goals and different product vision — and each divergence is non-arbitrary, traceable to identifiable design tradeoffs**.

横向对比的真正价值不是评判，是**让你看到设计空间的形状**。下一代 coding agent 团队会从这两个数据点出发，在中间无数个未探索的位置画自己的设计。如果你是那个团队的一员，希望这套拆解给了你判断"我应该靠近哪一边"的工具。

The real value of horizontal comparison isn't judgment — it's **showing you the shape of the design space**. The next generation of coding-agent teams will start from these two data points and paint their own designs in the countless unexplored positions in between. If you're on such a team, hopefully this teardown gave you the tools to judge "which side should I lean toward."

---

## Status / 状态

**Draft v0.1** — 2026-05-01

- [x] 13 sections drafted (~9,800 words bilingual)
- [x] Verified `agent_jobs.rs:39` BatchJobHandler struct
- [x] Verified concurrency constants (16 default, 64 max, 250ms poll, 30min timeout)
- [x] Verified `SpawnAgentsOnCsvArgs` exact fields at `agent_jobs.rs:46-56`
- [x] Verified `multi_agents_v2/` directory contains spawn/wait/send_message/close_agent/list_agents/followup_task/message_tool
- [x] Verified `goals.rs:1` doc comment "Core support for persisted thread goals"
- [x] Verified `CONTINUATION_PROMPT_TEMPLATE` and `BUDGET_LIMIT_PROMPT_TEMPLATE` at `goals.rs:49-63` use `include_str!`
- [x] Verified `BudgetLimitSteering` enum at `goals.rs:65`
- [x] Verified `GoalRuntimeEvent` enum at `goals.rs:76`
- [x] Verified `StateDbHandle` import at `goals.rs:7`
- [ ] HTML slides not authored
- [ ] Need diagrams: (1) batch job worker pool topology, (2) v1 vs v2 multi-agent comparison, (3) goal continuation loop, (4) autonomy spectrum visualization
- [ ] `templates/goals/continuation.md` and `budget_limit.md` actual content not yet read — would strengthen Slide 8 with real prompt text excerpt
- [ ] Risk analysis (slide 13) is opinionated framing — verify with author intent before final

**Open questions**:
- Slide 6 (v1 vs v2 multi-agent) is partly speculative ("which is meant to win?"). Pull commit history to ground the claim before final.
- Slide 11 (token budget) describes the *intent* of `BudgetLimitSteering` — verify by reading the actual application code in `goals.rs` to make sure I described the behavior correctly.
- Slide 12 (autonomy spectrum) is the most opinionated framing in the chapter — keep or soften?
