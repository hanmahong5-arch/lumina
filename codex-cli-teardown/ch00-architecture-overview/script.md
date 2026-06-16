# Chapter 0 (Codex): Architecture Overview — The Rust + JS Split

## ⏱️ Target Duration: ~30 minutes | 📑 ~12 slides | 📝 ~5,500 words

### Core Source Files Referenced

Pinned commit: `e4d6675`, 2026-05-01 snapshot. All paths relative to repo root.

* `codex-rs/Cargo.toml` → workspace declaration with **85+ member crates**
* `codex-cli/package.json` → JavaScript/TypeScript CLI surface (NPM-distributed)
* `codex-rs/app-server/` → IPC bridge between JS shell and Rust core
* `AGENTS.md` → architectural intent statement (root of repo)
* `codex-rs/core/src/lib.rs` → core crate's public surface area

---

### [00:00] Opening (Slide 1: Cover)

打开两个开源 AI 编码 Agent 的仓库根目录——Anthropic 的 Claude Code（参考实现）和 OpenAI 的 Codex CLI——你会立刻看到一个最显眼的、决定一切的差异：

```
claude-code/                    codex/
└── src/                        ├── codex-cli/        ← TypeScript
    ├── QueryEngine.ts          └── codex-rs/         ← Rust
    ├── query.ts                    └── (85+ crates)
    ├── tools/
    └── ...                     
    (TypeScript end-to-end)
```

**Codex 的核心引擎在 Rust 里写**。Claude Code 的核心引擎在 TypeScript 里写。同一个产品类别——本地编码 Agent，一个团队选了系统级语言，另一个团队选了脚本级语言。今天这一章我们回答这个问题：**这个语言选择不是品味，是一连串工程目标推出来的必然结果，它决定了下游所有架构特性的可能性边界**。

Open the repo roots of two open-source coding agents — Anthropic's Claude Code (reference implementation) and OpenAI's Codex CLI — and the most striking, everything-shaping difference jumps out immediately. **Codex's core engine is written in Rust.** Claude Code's core engine is written in TypeScript. Same product category, opposite language choice. This chapter answers: this isn't aesthetics — it's a cascade of engineering goals that constrains every downstream architectural possibility.

我们这一整章不写代码细节，写**框架性问题**：Codex 怎么把它的能力组装起来？它的边界在哪里？为什么这些边界是这样的？后面 4 章（ch01–ch04）才进入源码细节。

This chapter writes no code details — it writes the **framing questions**: how does Codex assemble its capabilities, where are the boundaries, why are they where they are? The next 4 chapters (ch01–ch04) drop into source.

---

### [03:00] Slide 2: The 85-Crate Workspace

打开 `codex-rs/Cargo.toml`，第一眼就让人怔一下——一个号称"CLI 工具"的项目，内部是一个 **85+ crate 的 cargo workspace**。把所有 crate 名字按职责粗分：

| 类别 | 数量 | 代表 crate |
|------|------|------------|
| Agent 核心 | ~5 | `core`, `protocol`, `tools`, `core-skills`, `core-plugins` |
| 工具与执行 | ~6 | `exec`, `exec-server`, `apply-patch`, `shell-command`, `shell-escalation`, `execpolicy` |
| **沙箱** | **6** | `sandboxing`, `linux-sandbox`, `windows-sandbox-rs`, `process-hardening`, `network-proxy`, `connectors` |
| MCP/协议 | ~4 | `codex-mcp`, `mcp-server`, `rmcp-client`, `app-server-protocol` |
| 客户端/UI | ~6 | `cli`, `tui`, `app-server`, `app-server-client`, `debug-client`, `app-server-test-client` |
| **持久化** | **6** | `state`, `thread-store`, `agent-graph-store`, `rollout`, `rollout-trace`, `memories/{read,write}` |
| 模型/认证 | ~7 | `model-provider`, `model-provider-info`, `models-manager`, `login`, `chatgpt`, `aws-auth`, `keyring-store` |
| **Realtime** | **2** | `realtime-webrtc`, `device-key` |
| 云能力 | ~4 | `cloud-tasks`, `cloud-tasks-client`, `cloud-tasks-mock-client`, `cloud-requirements` |
| 工具基础设施 | ~10 | `analytics`, `ansi-escape`, `async-utils`, `file-search`, `file-system`, `git-utils`, `otel`, `secrets`, `feedback`, `hooks` |
| 实用工具 | ~10 | `utils/*`, `arg0`, `config`, `features`, `install-context` |

注意我加粗的三组——**沙箱（6 crate）、持久化（6 crate）、Realtime（2 crate）**。这是 Claude Code 完全没有或极简的领域。Codex 在这三个方向上的投入，从 crate 数量就能看出**不是顺手做一下，是当成核心能力做的**。

Note the three bolded groups — **sandbox (6 crates), persistence (6 crates), realtime (2 crates)**. These are areas Claude Code either doesn't have or has minimally. The crate count alone tells you: Codex isn't doing these casually — they're investing as if they're core capabilities.

**对比**：Claude Code 的 `src/` 是单一 TypeScript 包，约 200 个文件，没有"crate 边界"的概念。所有代码住在一个 npm 包里。这不是说 Claude Code 没有模块化——它有 `src/tools/`、`src/services/`、`src/utils/`——但模块边界是社会约定，不是构建系统强制。Codex 的 85 个 crate 是构建系统强制的边界，编译期就检查依赖关系。

**Comparison**: Claude Code's `src/` is a single TypeScript package, about 200 files, no concept of "crate boundaries." All code lives in one npm package. That's not to say Claude Code lacks modularity — it has `src/tools/`, `src/services/`, `src/utils/` — but boundaries are social convention, not build-system enforced. Codex's 85 crates are compile-time enforced boundaries with explicit dependency declarations.

---

### [07:00] Slide 3: Why Rust? Three Concrete Answers

为什么 Codex 的核心要用 Rust 写？三个具体答案，每个都和它的能力清单直接对应。

**答案 1：原生跨平台沙箱**

Linux Landlock LSM、macOS Seatbelt、Windows Restricted Token——这三个机制都是**操作系统级原语**，要从 C 系统调用、POSIX 接口、Windows API 直接驱动。在 Node.js 里做，要么写 native addon（脆弱、跨平台噩梦），要么放弃。Rust 可以直接 FFI 进 libc/syscall，零开销绑定。`codex-rs/sandboxing/src/seatbelt.rs` 第 30 行硬编码 `MACOS_PATH_TO_SEATBELT_EXECUTABLE: &str = "/usr/bin/sandbox-exec"`——这种贴近系统的代码用 Rust 写自然，用 TypeScript 写要绕一大圈。

**Answer 1: Native cross-platform sandboxing.** Linux Landlock LSM, macOS Seatbelt, Windows Restricted Token — these are **OS-level primitives** driven directly through C syscalls, POSIX interfaces, Windows APIs. From Node.js you'd write native addons (fragile, cross-platform nightmare) or give up. Rust binds straight to libc/syscalls with zero overhead. ch03 covers this in depth.

**答案 2：单一二进制分发**

Codex 最终用户拿到的是一个独立可执行文件（macOS 上是 `codex` 二进制；Linux 上是 `codex` + `codex-linux-sandbox` helper）。没有 Node 运行时依赖，没有 npm install，没有 shebang 脚本。把整个 agent + sandbox + network proxy + WebRTC 客户端编译进 ~30MB 的 native binary 是 Rust 的舒适区。Claude Code 是 npm 包（`@anthropic-ai/claude-code`），用户必须先有 Node。两种分发模型都对，但 Codex 的目标包括"装到 CI 容器、装到企业受限环境"，在那些场景里 native binary 几乎必需。

**Answer 2: Single-binary distribution.** End users get a standalone executable (`codex` on macOS; `codex` + `codex-linux-sandbox` helper on Linux). No Node runtime dependency, no npm install, no shebang scripts. Compiling the entire agent + sandbox + network proxy + WebRTC client into a ~30 MB native binary is Rust's comfort zone. Claude Code distributes as `@anthropic-ai/claude-code` npm package — users must have Node installed first. Both distribution models are valid, but Codex's target audience includes "CI containers, locked-down enterprise environments" where native binary is nearly mandatory.

**答案 3：可被多种前端消费的引擎**

Codex 的核心引擎不仅服务 TUI，也通过 `codex-rs/app-server/` crate 暴露成 HTTP/WebSocket 协议——这意味着 VSCode 扩展、Web 客户端、移动端、第三方 IDE 都能消费同一个引擎。这要求引擎和前端**进程级隔离**，所有交互走可序列化协议。Rust 的 serde + tokio 让这种"引擎是可执行文件，前端是协议消费者"的拓扑天然舒服。Claude Code 是嵌入式引擎——`QueryEngine` 必须和调用方在同一个 Node 进程里，因为它返回 AsyncGenerator（语言原生协程不能跨进程）。

**Answer 3: An engine consumable by many frontends.** Codex's core serves not only the TUI but also exposes itself via `codex-rs/app-server/` as HTTP/WebSocket — meaning VSCode extensions, Web clients, mobile, third-party IDEs all consume the same engine. This requires **process-level isolation** between engine and frontend, all interaction over serializable protocol. Rust's serde + tokio makes "engine as executable, frontends as protocol consumers" topology natural. Claude Code is an embedded engine — `QueryEngine` must live in the same Node process as the caller, because it returns AsyncGenerator (language-native coroutines can't cross processes).

> **关键洞察**：这三个答案合起来说明，Codex 团队从一开始押的不是"内部工具"，而是"基础设施"。基础设施需要原生 OS 集成、可分发性、协议化外部 API——Rust 是这三个的同时最优解。Claude Code 押的是"和 SDK 紧密耦合的内嵌引擎"，所以 TS 是它的同时最优解。
>
> **Key insight**: These three answers together show Codex's team bet on "infrastructure," not "internal tool." Infrastructure needs native OS integration, distributability, protocol-ized external APIs — Rust is jointly optimal for all three. Claude Code bet on "tightly SDK-coupled embedded engine," so TS is jointly optimal for it.

---

### [12:00] Slide 4: Why JS for the CLI Layer?

如果 Rust 这么强，为什么 `codex-cli/` 还存在，而且还是 TypeScript？

Two crates exist at `codex-rs/cli/` (Rust TUI) AND `codex-rs/tui/` (the actual TUI logic) — Codex actually has a Rust TUI. So what is `codex-cli/` (the JS one) for?

打开 `codex-cli/package.json`：它是一个**薄壳**，作用是 npm 分发。`npm install -g @openai/codex` 能用是因为这个包存在。它的实际工作是：检测平台、下载对应的预编译 Rust 二进制、启动它。是分发层，不是 agent 逻辑层。

Open `codex-cli/package.json`: it's a **thin shell** whose job is npm distribution. `npm install -g @openai/codex` works because this package exists. What it actually does: detect the platform, download the matching prebuilt Rust binary, launch it. It's a distribution layer, not an agent logic layer.

**为什么不一开始就只做 Rust binary？** 因为 npm 是开发者实际用来装 CLI 工具的渠道。即使 Rust binary 自分发能做（GitHub Releases、Homebrew、winget），用户的肌肉记忆是 `npm install -g`。强迫他们改习惯是无谓的摩擦。

**Why not just ship the Rust binary directly?** Because npm is what developers actually use to install CLI tools. Even if Rust binary self-distribution works (GitHub Releases, Homebrew, winget), users' muscle memory is `npm install -g`. Forcing them to change habit is gratuitous friction.

> **设计反思**：`codex-cli/` 是分发包装器，不是技术债。它解决的是"让 Rust 引擎用 npm 工作流装出来"这个非技术问题。这个 pattern 在系统编程领域很普遍——Cypress、esbuild、SWC 都用类似的"npm 壳 + native binary"模式。
>
> **Design reflection**: `codex-cli/` is a distribution wrapper, not technical debt. It solves "make the Rust engine installable via npm workflow," which is a non-technical problem. This pattern is widespread in systems programming — Cypress, esbuild, SWC all use similar "npm shell + native binary" approaches.

**Claude Code 不需要这个层**，因为它本来就是 Node 程序。这是 Claude Code 的简化：分发即代码，没有跨语言绑定的复杂度。代价是放弃 native 沙箱能力。

**Claude Code doesn't need this layer**, since it's a Node program to begin with. That's Claude Code's simplification: distribution-equals-code, no cross-language binding complexity. The cost: giving up native sandboxing capability.

---

### [15:30] Slide 5: The IPC Boundary — What Crosses

`codex-rs/app-server/` crate 是 Codex 引擎面向外部消费者的协议入口。不只 JS CLI 用它——任何想 control Codex 的客户端都通过它。

`codex-rs/app-server/` is Codex engine's protocol entry point for external consumers. Not only does the JS CLI use it — any client wanting to control Codex goes through it.

**协议的两端**：

```
┌─────────────────┐         ┌──────────────────────┐
│   Frontend      │  JSON   │   Codex Engine       │
│   (CLI/TUI/IDE) │ ◄─────► │   (Rust app-server)  │
└─────────────────┘ WebSock └──────────────────────┘
       │                              │
       │  Submission { id, op }       │
       │  ────────────────────────►   │
       │                              │
       │   Event { id, msg }          │
       │  ◄────────────────────────   │
```

**穿越边界的两种消息**：

1. **`Submission { id: String, op: Op }`** — 客户端 → 引擎。`Op` 是有 ~20 个 variant 的枚举（UserInput、Interrupt、Shutdown、RealtimeConversationStart 等）。
2. **`Event { id: String, msg: EventMsg }`** — 引擎 → 客户端。`EventMsg` 是有 ~40 个 variant 的枚举（AgentMessage、TurnStarted、TokenCount、ContextCompacted 等）。

两个都是 serde-tagged enum，序列化为带 `type` 字段的 JSON。`id` 字段把对应的 Submission 和 Event 关联起来——一个 Submission 可能产生多个 Event，所有这些 Event 共享同一个 `id`。

**不穿越边界的东西**（关键）：
- 工具执行的实际结果（在引擎内部消化，只把 begin/end 事件外发）
- LLM API 的原始响应（在 `codex-rs/core/src/client.rs` 里被解析、转换成 EventMsg）
- 沙箱状态、文件系统状态、进程状态（引擎独占）
- 模型 API key（引擎在 `codex-login` 里管理）

**Things that don't cross** (critical): tool execution actual results (digested inside the engine, only begin/end events emitted), raw LLM API responses (parsed in `client.rs` into EventMsg), sandbox/filesystem/process state (engine-exclusive), model API keys (managed in `codex-login`).

> **架构含义**：这条 IPC 边界是 Codex 安全模型的关键——前端永远拿不到原始模型响应，永远不能直接驱动工具执行，永远看不到 sandbox 内部状态。这意味着即使前端是恶意的（受感染的 IDE 扩展），它也只能发 Submission，引擎决定信不信。前端是不可信的。

---

### [19:30] Slide 6: Codex's Persistence Stack — Six Crates

注意之前那张幻灯片的"持久化（6 crate）"分组：

- `state` — `StateDbHandle`，SQLite-backed 的目标/任务/记忆表
- `thread-store` — 持久化对话历史，本地或云端
- `agent-graph-store` — Agent 之间的关系图（sub-agent 派生关系）
- `rollout` / `rollout-trace` — 推理 rollout 调试跟踪
- `memories/read` + `memories/write` — 记忆系统的读写分离

这是**长期记忆基础设施**。Codex 把"agent 跨会话/跨进程的记忆"当成一等公民，每种持久化关注点一个独立 crate，读写分离（`memories/read` 和 `memories/write` 分开是有意为之——读路径要轻量、写路径要严谨）。

**This is long-term memory infrastructure.** Codex treats "agent's cross-session, cross-process memory" as a first-class concern — each persistence concern a separate crate, with read/write split (`memories/read` vs `memories/write` is intentional — read path stays lightweight, write path is rigorous).

**Claude Code 的对应**：在 `src/services/memory/` 里大约 5 个 TypeScript 文件，存到 `~/.claude/memory/` 下的 markdown 文件。无 SQLite，无 rollout 跟踪，无 agent graph。Claude Code 的记忆模型是"开发者编辑的 CLAUDE.md + 简单 KV 文件"，简单到能直接 cat 出来读。

**Claude Code's analog**: about 5 TypeScript files in `src/services/memory/`, stored as markdown files under `~/.claude/memory/`. No SQLite, no rollout tracing, no agent graph. Claude Code's memory model is "developer-edited CLAUDE.md + simple KV files" — simple enough to `cat` and read.

**两个模型背后的不同假设**：
- Codex 假设 agent 会**长期、自主、跨会话**地工作，所以记忆基础设施要工业化
- Claude Code 假设 agent 是**当前会话**为主的工具，跨会话状态由人来维护（手动写 CLAUDE.md）

**Different underlying assumptions**:
- Codex assumes the agent works **long-term, autonomously, across sessions** — so memory infrastructure must be industrialized
- Claude Code assumes the agent is primarily a **current-session** tool — cross-session state is human-maintained (you write CLAUDE.md by hand)

ch04 会展开 Codex 的 goal_runtime + state-db 怎么和这些 persistence crate 配合实现"agent 闲置时自动 continue 一个目标"。

---

### [23:00] Slide 7: The Five Chapters and What They Cover

这一系列拆解分 5 章。这一章（ch00）建立框架；ch01–ch04 进入源码：

| Chapter | Focus | 为什么单独成章 |
|---------|-------|----------------|
| ch01 | Core Engine — `submission_loop` + Channel pair vs AsyncGenerator | 核心控制流——和 Claude Code 最直接的对比点 |
| ch02 | Tools & MCP — `ToolHandler` trait | 工具系统抽象——Rust trait vs TS class 的工程含义 |
| ch03 | **Native Sandboxing** — Landlock + Bubblewrap + Seatbelt + Restricted Token + MITM Proxy | **Codex 独有**——Claude Code 完全没有 OS 级沙箱 |
| ch04 | **Batch Jobs & Goals** — map-reduce sub-agents + autonomous continuation | **Codex 独有**——Claude Code 没有这两个原语 |

ch03 和 ch04 加粗：这两章是**这一整套拆解最有差异化价值的内容**。如果你只听一章，听 ch03。如果你只读一段源码，读 `codex-rs/sandboxing/`。

ch03 and ch04 are bolded: these are the **most differentiated chapters of the entire teardown**. If you only listen to one, listen to ch03. If you only read one source folder, read `codex-rs/sandboxing/`.

---

### [26:00] Slide 8: What This Teardown Is Not

**它不是"Codex vs Claude Code 哪个更好"的评测**。两个产品有重叠的目标但有不同的优化函数。把它们排出 ranking 是无意义的——你应该问"我的场景对应哪个的优化方向"。

It is **not a "Codex vs Claude Code which is better" benchmark**. The two products have overlapping goals but different optimization functions. Ranking them is meaningless — the right question is "which one's optimization direction matches my scenario."

**它不是 Codex 的入门文档**。如果你没用过 Codex，去看官方 README；这一系列假设你已经知道它是什么、能做什么，要的是源码层面的"它是怎么做到的"。

It is **not a Codex onboarding doc**. If you've never used Codex, go to the official README; this series assumes you know what it is and what it does, and you want source-level "how does it do that."

**它不是逐文件代码走读**。85 个 crate 完整走读不可能在 5 小时讲完，也不该尝试。我们挑**架构选择最有教学价值的部分**讲。每一章后面都列了"Source files referenced"，要深入的人可以按图索骥。

It is **not a file-by-file code walkthrough**. Walking through 85 crates exhaustively can't fit in 5 hours and shouldn't be attempted. We pick the **architecturally most pedagogical parts**. Each chapter lists "Source files referenced" — readers who want deeper dives can use it as a roadmap.

---

### [28:00] Slide 9: The Recommended Reading Order

如果你是带着特定问题来的，这是不同问题的入口：

| 你的问题 | 从这章开始 |
|----------|------------|
| "怎么写一个 LLM agent 的核心循环？" | ch01 |
| "我的 agent 工具系统该怎么设计？" | ch02 |
| "我担心 agent 执行恶意代码怎么办？" | **ch03** |
| "我想让 agent 自主跑长时间任务" | **ch04** |
| "我从架构层面想理解 Codex 整体" | ch00 → ch01 顺序读 |

For most readers: ch00 → ch01 → ch03 是最高浓度的 90 分钟。ch02 和 ch04 是延伸阅读。

For most readers: ch00 → ch01 → ch03 is the highest-density 90 minutes. ch02 and ch04 are extended reading.

---

### [30:00] Closing

这一章是**框架章**，没有具体源码细节。下一章 ch01 直接进 `codex-rs/core/src/session/` 三个文件——`mod.rs`、`session.rs`、`handlers.rs`——拆开 Codex 的核心引擎。我们会看到 `Codex` struct 的 5 个字段、`Session` struct 的 17 个字段，以及 `submission_loop()` 这个调度器是怎么和 Claude Code 的 `queryLoop()` AsyncGenerator 形成镜像对比的。

This chapter is **framing only**, no source detail. ch01 drops directly into `codex-rs/core/src/session/` — three files (`mod.rs`, `session.rs`, `handlers.rs`) — to dissect Codex's core engine.

带着一个问题进 ch01：**如果同一个问题，有两个团队给出截然不同的设计，是因为什么？**

Take this question into ch01: **when the same problem yields radically different designs from two teams, what's the underlying reason?**

---

## Status / 状态

**Draft v0.1** — 2026-05-01

- [x] 9 sections drafted (~5,500 words bilingual)
- [x] 85-crate workspace data verified against `codex-rs/Cargo.toml`
- [x] Persistence crate count and split (6 crates) verified
- [x] Sandbox crate count (6 crates including codex-network-proxy) verified
- [ ] HTML slides not yet authored
- [ ] Diagrams not yet rendered (ch00 needs at least: 85-crate workspace map, IPC boundary diagram, the 5-chapter roadmap)
- [ ] Cross-reference: I claim "~30MB native binary" — verify by `du -sh` after a release build
- [ ] Cross-reference: I claim Codex's app-server uses "JSON over WebSocket" — verify in `codex-rs/app-server/`

**Open questions**:
- Should slide 6 (persistence stack) be its own mini-chapter? It's denser than the others.
- The "Reading Order" table (slide 9) is a strong opinionated framing — keep it as the closing artifact, or move to README?
