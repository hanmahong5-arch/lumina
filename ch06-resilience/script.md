# Ch6 韧性工程 — 演讲稿 / Ch6 Resilience Engineering — Presentation Script

> 目标时长 60 分钟 · 25 张幻灯片 · ~11,000 字
> Target duration 60 min · 25 slides · ~11,000 characters

---

## 👉 Slide 1 — Cover

**[00:00]**

在生产环境中，API 过载（529 错误）几乎每天都会出现。这不是测试环境偶尔的网络抖动——当 Anthropic 的后端容量到达瓶颈时，所有客户端同时收到 529，如果没有精心设计的重试策略，结果就是每个客户端盲目重试，把已经过载的服务推向彻底的 cascade failure。

更不用说用户中途 Ctrl+C、OAuth token 被另一个终端窗口刷新、Keep-Alive 连接在代理后面悄悄死亡这些场景。一个没有韧性设计的 AI 编程助手，面对这些只能让用户手动重试、重启对话，或者更糟——丢失几个小时的中间结果。

这一章我们要看的不是"如何 catch 异常"，而是**如何从架构层面让系统在失败时优雅降级、在恢复时精确续接**。三层结构：重试层、恢复层、降级层，每层处理不同级别的"broken"。

---

## 👉 Slide 1b — Objectives

**[01:00]**

本章目标：理解一个 529 错误从发生到被处理的完整生命周期，以及整个系统如何从崩溃、中断、认证失败中恢复。

三个核心问题：
1. 当 Anthropic API 返回 529 时，系统做了什么？
2. 用户 Ctrl+C 打断对话后，如何精准续接？
3. 为什么选择 JSONL 而不是 SQLite 做持久化？

---

## 👉 Slide 2 — SourceMap

**[02:30]**

源码地图。韧性系统的核心实现在三个文件：

`src/services/api/withRetry.ts`（~800 行）——重试循环的心脏，AsyncGenerator 模式，type-specific 策略，Fast Mode 冷却管理，模型降级决策。这是本章重点。

`src/utils/sessionStorage.ts`（~2500 行）——JSONL 持久化层、链式遍历（`buildConversationChain`）、并行 tool result 恢复（`recoverOrphanedParallelToolResults`）。

`src/utils/conversationRecovery.ts`——恢复协调器、`detectTurnInterruption()` 三态判定（none / interrupted_turn / interrupted_prompt）。

辅助：`errors.ts` 的 `classifyAPIError()` 区分 20+ 种错误类型；`fastMode.ts` 管理冷却状态；`errorUtils.ts` 提取连接层细节。

---

## 👉 Slide 3 — 三层韧性概览

**[05:00]**

（指向 resilience-three-layers 图）

三层的分工：

**L1 重试层**：处理"请求发出去了，但没成功"。429、529、401、ECONNRESET——`withRetry()`。关键设计哲学：**不同错误类型需要不同策略**，不存在万能退避。

**L2 恢复层**：处理"进程没了，但数据还在"。JSONL 追加写入 + `parentUuid` 链 → `--resume` 重建对话。`sessionStorage` + `conversationRecovery`。

**L3 降级层**：处理"当前路径走不通，换备选方案"。3×529 → 模型降级（Opus→Sonnet）；Fast Mode 限流 → 退回标准速度。

为什么分三层，不用一个统一重试？因为"broken"的粒度完全不同——L1 处理 request-level 失败，L2 处理 process-level 失败，L3 处理 path-level 失败。十acity/backoff 这类库只覆盖 L1；LangGraph 的 checkpoint 覆盖 L2 但以节点为粒度，而这里是消息级。

---

## 👉 Slide 4 — withRetry AsyncGenerator

**[08:00]**

（指向 with-retry-loop 图）

签名（`withRetry.ts:170-178`）：

```typescript
export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (client, attempt, context) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T>
```

三个设计选择值得细说：

**为什么是 AsyncGenerator 而不是回调？** 回调只能做 side-effect（打日志），无法影响控制流。AsyncGenerator 让每次 yield 都携带 `SystemAPIErrorMessage`——UI 显示"重试中...还剩 25 秒"，调用者检查 `signal.aborted` 决定是否取消（`withRetry.ts:492-498`）。这不是 UI hack，而是架构级的透明重试。用回调的方案，调用者在 30 秒重试等待期间完全不知道发生了什么——用户看到的是一个冻结的光标。

**为什么是工厂函数而不是实例？** OAuth 401 后需要创建新的 client（`withRetry.ts:232-251`）。如果 `withRetry` 接收的是 client 实例，就无法"在循环中间换掉它"。工厂函数让每次重试都调用 `getClient()` 获取最新的 client——401 刷新后返回的就是带新 token 的 client。

**为什么 type-specific 策略？** `classifyAPIError()` 区分 20+ 种错误场景。每种场景的退避不同：429 指数退避、529 分区延迟（更长，且只有前台请求重试）、401 OAuth 刷新后重试、ECONNRESET 立即重试（连接抖动，不是真正的错误）、400/403 直接 abort（不可重试）。不是所有的 "失败" 都是一个东西。

---

## 👉 Slide 5 — 529 分区

**[11:00]**

不是所有请求都应该重试 529。`withRetry.ts:57-82`：

```typescript
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread', 'sdk', 'agent:custom', 'agent:default', 'compact', ...
])
```

代码注释直接说了：*"during a capacity cascade each retry is 3-10x gateway amplification"*。当 API 已经过载时，每一个重试都在给着火的水桶里倒水。

只有**用户正在等待的前台请求**才重试 529。后台任务（summary、title suggestion、classifier）遇到 529 直接放弃——用户根本不会注意到。这是一种责任意识：你不只关心自己的请求成功率，还要考虑整个服务的健康度。

注意 `auto_mode`（安全分类器）也在白名单里——因为它的结果直接影响自动模式的正确性，必须完成。而 `bash_classifier` 被 feature gate 控制，只在内部构建中存在。

---

## 👉 Slide 6 — 退避算法

**[13:30]**

`getRetryDelay()`（`withRetry.ts:530-548`）——四层优先级：

1. **Retry-After header**：服务器明确说"X 秒后再来"。HTTP 协议级别的契约，忽略它就是不尊重服务端的流控意图。
2. **指数退避**：`BASE_DELAY_MS (500ms) * 2^(attempt-1)`，上限 `MAX_BACKOFF (32s)`。
3. **25% 随机抖动**：`Math.random() * 0.25 * baseDelay`。足够避免惊群效应，又不让延迟波动太大。对比 AWS SDK 的 full jitter `random(0, delay)`——理论分散更好，但 API 过载场景下你不想有重试几乎立即发生。
4. **529 分区延迟**：比 429 更长。原因——529 意味着服务端已经过载了，你需要给它更多时间恢复。

BASE_DELAY 为什么是 500ms 而不是 1s？因为第一次重试通常是瞬时抖动，500ms 足够等它恢复但又不让用户等太久。

---

## 👉 Slide 6b — Code: getRetryDelay 实战

**[15:00]**

（指向代码幻灯片，`withRetry.ts:530-548`）

```typescript
function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string,
  maxDelayMs = 32000,
): number {
  // Priority 1: Server's Retry-After
  if (retryAfterHeader) {
    return parseInt(retryAfterHeader) * 1000
  }

  // Priority 2: Exponential backoff
  const base = Math.min(
    500 * Math.pow(2, attempt - 1),
    maxDelayMs
  )

  // Priority 3: Add jitter (0-25%)
  return base + Math.random() * 0.25 * base
}
```

**三层优先级一目了然**。这段代码是韧性工程的核心——每次请求失败后的退避都由它计算。

执行序列：500ms → 1s → 2s → 4s → 8s → 16s → 32s。第 7 次重试就达到上限。加上抖动，实际延迟可能到 40 秒。

---

## 👉 Slide 7 — 持久模式

**[16:00]**

`CLAUDE_CODE_UNATTENDED_RETRY` 开启后，行为截然不同（`withRetry.ts:96-98`）：

```typescript
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000    // 5 min
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000 // 6 hours
const HEARTBEAT_INTERVAL_MS = 30_000                // 30 seconds
```

三个关键差异：

**无限重试 429/529**。`attempt` 被钳位在 `maxRetries`，永远不会触发退出条件。CI/CD 流水线中，放弃意味着几个小时的工作白费。

**退避上限提到 5 分钟**，6 小时绝对安全阀。

**30 秒心跳**。这是解决一个实际运维问题：宿主环境（CI runner）会把长时间无输出的进程标记为"空闲"并杀掉。每 30 秒 yield 一条系统消息确保 stdout 始终有活动。代码注释也承认这是 stopgap，未来有专门的 keep-alive 通道。

429 特殊处理：持久模式会解析 `anthropic-ratelimit-unified-reset` header，直接等到限流窗口重置，而不是每 5 分钟发一个注定失败的请求。

---

## 👉 Slide 8 — FastMode 冷却

**[18:30]**

Prompt cache 是按 model name 绑定的。如果 Fast Mode 遇到限流时切换模型，之前缓存的 prompt 全部失效——长上下文场景下代价极高。

所以 `withRetry.ts:267-304` 的二分策略：

**短延迟 <20s**：保持 Fast Mode，等待后重试。保缓存。

**长延迟 >=20s 或未知**：`triggerFastModeCooldown()` 切换到标准速度。冷却时间 `max(retryAfter, 默认 30min)`，最低 10 分钟。10 分钟的底线防止 flip-flopping——冷却太短会导致系统来回切换，每次切换都丢缓存，反而比一直用标准模式更慢。

API 明确告知超额不可用时（`anthropic-ratelimit-unified-overage-disabled-reason`）：**永久禁用**，不是冷却，是直接关闭。

---

## 👉 Slide 9 — 模型降级

**[21:00]**

连续 529 计数器 `consecutive529Errors`，达到 3 次时触发 `FallbackTriggeredError`（`withRetry.ts:327-365`）。

为什么是 3 次？1 次太敏感——正常的偶发过载就触发降级。5 次意味着用户要等 5 轮指数退避（可能超过 2 分钟）才开始降级。3 次是"失败足够明确，但等待还不算太久"的平衡点。

`FallbackTriggeredError` 不是普通错误——它是**信号**，告诉上层"请用备选模型重新开始整个请求"。上层捕获后设置 tombstone 标记原模型不可用，再用 fallbackModel 重试。

`initialConsecutive529Errors` 参数值得注意：流式请求中途遇到 529 后降级为非流式重试时，之前的 529 次数会传递过来，确保阈值在两种模式间一致。

---

## 👉 Slide 10 — OAuth 401 & 连接层

**[23:30]**

Client 重建覆盖五种认证失败（`withRetry.ts:232-251`）：

- OAuth 401 → `handleOAuth401Error()` 刷新 → `getClient()` 获取新 client
- OAuth 403 "revoked" → 另一个进程刷新了 token → 同样走刷新
- AWS Bedrock 403 → `clearAwsCredentialsCache()` → 重建
- GCP Vertex 401 → 清除 GCP 凭证缓存 → 重建
- ECONNRESET/EPIPE → `disableKeepAlive()` 禁用连接池后重连

ECONNRESET 是 TCP 层面的信号——远端关了连接，本地连接池还在复用死 socket。检测到后动态禁用 keep-alive（全局操作），牺牲连接复用性能换取可靠性。在代理环境下（公司内网常见），这种权衡通常是值得的。

`classifyAPIError()` 区分 20+ 种错误（`errors.ts:965-1161`）。每种对应不同的用户提示和遥测标签。"org has been disabled"如果被误分类成"invalid API key"，用户会被引导去做错误的修复操作。

---

## 👉 Slide 11 — JSONL 持久化

**[26:00]**

为什么 JSONL 而不是 SQLite？这个场景下写入是纯追加，读取是全量读取 + 链式遍历。SQLite 的优势（随机查询、事务、并发写入）都不需要。JSONL 的优势正好匹配需求：追加写入原子操作、崩溃恢复只需丢弃最后一行不完整内容、人类可读可调试。

为什么不是单一 JSON 文件？每次追加都要重写整个文件（读取→解析→修改→序列化→写入），长对话中 O(n)。JSONL 追加是 O(1)。

关键参数（`sessionStorage.ts:567-568`）：

- **100ms 批量刷写**：`enqueueWrite()` 入队 → `scheduleDrain()` 100ms 定时器批量写入。工具密集型操作中 100ms 内可能产生十几条消息，批量写入一次比十几次快得多。
- **100MB 自动分块**：超大对话防止单次写入内存分配溢出。
- **0o600 权限**：JSONL 包含代码片段、文件路径、操作日志，只有文件所有者可读写。

---

## 👉 Slide 11b — Connection Level Resilience & Recovery Overview

**[25:00]**

`ECONNRESET` 和 `EPIPE` 是 TCP 层面的信号——远端主动关闭连接，本地连接池还在复用死 socket。

处理流程（`errorUtils.ts`）：

1. 检测到 ECONNRESET → `classifyAPIError()` 标记为 `connection_reset`
2. `disableKeepAlive()` 全局禁用 keep-alive
3. 重新建立连接（不通过连接池）

`disableKeepAlive()` 是全局操作——一旦检测到连接重置，整个进程的 keep-alive 被禁用。牺牲连接复用性能换取可靠性。在公司代理、VPN 或云服务器环境下，这种权衡是工程上的务实选择。

**类比**：就像 HTTP 代理检测到后端连接断开后，会临时关闭 keep-alive 一段时间——宁可多建几个新连接，也不要往死连接里写数据。

（指向 recovery-overview 图）

恢复管线的五步流程：

Write → JSONL append → Link → parentUuid chain → Detect → Interruption type → Clean → 4-stage filter → Resume

每步都是幂等的，重复执行不会破坏状态。JSONL 的 append-only 特性天然保证了写入的幂等性——即使 crash 后重试同一条 write，也只会被写入一次（因为 JSONL 追加不是覆盖）。

---

## 👉 Slide 12 — Chain Walk

**[28:00]**

（指向 jsonl-chain-recovery 图）

`buildConversationChain()`（`sessionStorage.ts:2069-2094`）的实现：从叶子节点沿 `parentUuid` 逆向遍历到根，reverse 得到时间序。这和 **Git commit chain** 几乎一样——每个 commit 有 parent，从 HEAD 走到 initial commit。

`recoverOrphanedParallelToolResults()` 处理并发场景：多个并行的 tool_use 产生多个 assistant 消息（相同 `message.id`，不同 `uuid`），单链遍历只走一条路径，会丢失兄弟分支。这个后处理函数通过 `message.id` 匹配恢复。

---

## 👉 Slide 13 — 中断检测 & 四层过滤

**[32:00]**

`detectTurnInterruption()`（`conversationRecovery.ts:272-333`）三种判定：

- 最后是 assistant → `none`，正常完成
- 最后是 user tool_result → `interrupted_turn`，注入 "Continue from where you left off."
- 最后是 user 纯文本 → `interrupted_prompt`，直接作为待处理 prompt

精细细节：`isTerminalToolResult()` 检查 Brief 模式下的 `SendUserMessage`——它是轮次最后一条消息，如果没有这个检查，每次恢复 Brief 模式都会错误注入多余 "Continue"。API 错误消息（`isApiErrorMessage`）会被跳过，让 auto-resume 能在重试耗尽后触发。

恢复后四层过滤：

1. **`filterUnresolvedToolUses()`**：删除没有对应 tool_result 的 tool_use。API 要求严格配对，否则 400。
2. **`filterOrphanedThinkingOnlyMessages()`**：删除只有 thinking block 的 assistant 消息。流式传输中每个 `content_block_stop` 都持久化一条消息，thinking/text 分别独立。
3. **`filterWhitespaceOnlyAssistantMessages()`**：模型有时在 thinking 前输出空行，此时用户取消留下的空白消息。
4. **权限模式校验**：旧版本 `permissionMode` 值在当前构建不认识时清除（beta 版 → 稳定版降级场景）。

每一层都对应一个真实生产 bug（代码注释引用了内部 issue 编号）。

---

## 👉 Slide 14 — 对比 LangGraph

**[36:30]**

系统性对比：

| | Claude Code | LangGraph |
|---|---|---|
| 重试粒度 | 单次 API 调用 | 节点（node-level） |
| 持久化粒度 | 消息级（每条消息 JSONL 追加） | Checkpoint（节点完成后快照） |
| 状态恢复 | parentUuid chain walk + 四层过滤 | 加载最近 checkpoint |
| 降级策略 | `FallbackTriggeredError` → tombstone → 切模型 | 无内建支持 |

关键差异在于**消息级 vs 节点级**。LangGraph 的 checkpoint 在节点完成后保存——如果一个 tool_use 执行了 10 分钟还没"完成"节点，所有中间状态都在内存中，崩溃就丢。Claude Code 每条消息产生时就追加写入，10 分钟工具执行的中间结果不会丢失。

当然 LangGraph 是通用 agent 编排框架，这个是针对特定产品深度优化的。通用性和专用性的权衡在工程中永远存在。

---

## 👉 Slide 15 — 常量速查

**[39:00]**

快速过一遍 10 个关键常量：

- `DEFAULT_MAX_RETRIES = 10`（`withRetry.ts:52`）
- `BASE_DELAY = 500ms`（`withRetry.ts:55`）
- `MAX_BACKOFF = 32s`（`withRetry.ts:533`）
- `JITTER_FACTOR = 25%`（`withRetry.ts:546`）
- `MAX_529_CONSECUTIVE = 3`（`withRetry.ts:54`）
- `HEARTBEAT_INTERVAL = 30s`（`withRetry.ts:98`）
- `PERSISTENT_MAX_BACKOFF = 5min`（`withRetry.ts:96`）
- `PERSISTENT_TOTAL_LIMIT = 6h`（`withRetry.ts:97`）
- `FAST_MODE_COOLDOWN = 10min min / 30min default`（`withRetry.ts:801`）
- `BATCH_FLUSH_INTERVAL = 100ms`（`sessionStorage.ts:567`）

每个数字背后都有具体的工程权衡。

---

## 👉 Slide 16 — Summary

**[42:00]**

五个核心论点：

**韧性是分层的**。L1 重试、L2 恢复、L3 降级各司其职，独立演进。

**透明性优于黑盒**。AsyncGenerator 让重试过程对调用者可见——用户看到"正在重试..."不是冻结光标。

**区分不同失败模式**。20+ 错误分类、前台/后台 529 分区、长短延迟 Fast Mode 策略——不同问题需要不同解法。

**持久化粒度决定恢复能力**。消息级 JSONL + parentUuid chain 提供比 checkpoint 更细粒度的恢复。

**生产环境是最好的老师**。Brief mode terminal tool result、并行 tool_use orphan 恢复、OAuth token 竞争条件——每个边缘情况都来自真实 bug。韧性设计是随着故障场景积累不断进化的。

（指向 fast-mode-flip 图）Fast Mode 的冷却机制本质上是一个 circuit breaker——快速路径拥塞时，安静地退回到标准路径，不让用户感知到"失败"。这才是韧性工程该有的样子：不是让错误消失，而是让错误变得**对用户不可见**。

---

## 👉 Slide 17 — Q&A

**[45:00]**

思考题：

1. **持久模式 6 小时安全阀是否应该可配置？** 大规模代码迁移可能需要更久。但配置为无限就失去了安全阀意义。
2. **JSONL vs WAL + compaction**。当前 JSONL 本质上是 WAL，但没有 compaction。随着对话变长，文件无限增长。需要 LSM-tree 式的合并策略？
3. **529 前台/后台分区是静态白名单**。新增 QuerySource 默认行为是"不重试"——安全但保守。是否有更好的方式标注查询的用户可见度？
4. **Keep-alive 全局操作**。当 `disableKeepAlive()` 被调用后，整个进程的 HTTP 连接都被影响，而不只是失败的那个请求。

**[50:00] — END**

<!-- 
AUTO-GENERATED SLIDE SYNC REFERENCE
Please ensure your script.md contains the following headers:
Slide 01: cover
Slide 02: Learning Objectives
Slide 2: Ch 06 Resilience
Slide 03: Resilience Three-Layer Overview
Slide 04: withRetry Loop
Slide 5: Ch 06 Resilience
Slide 6: Ch 06 Resilience
Slide 08: Code Walkthrough
Slide 7: Ch 06 Resilience
Slide 08: Fast Mode Flip
Slide 9: Ch 06 Resilience
Slide 10: Ch 06 Resilience
Slide 11: Ch 06 Resilience
Slide 12: Ch 06 Resilience
Slide 13: JSONL Chain Recovery
Slide 14: Ch 06 Resilience
Slide 15: Ch 06 Resilience
Slide 16: Ch 06 Resilience
Slide 17: Ch 06 Resilience
Slide 20: CHAPTER 06 | RESILIENCE ENGINEERING
Slide 18: Ch 06 Resilience
Slide 22: Key Terms
Slide 19: Ch 06 Resilience
Slide 24: See Also
Slide 25: qa
-->