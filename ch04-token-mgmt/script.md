# Chapter 4: Token Management & Context Compaction — Presentation Script

## ⏱️ Duration: ~60min | 📑 30 Slides | 精简+高密度版

### 🔍 Core Source Files
* `src/services/compact/autoCompact.ts` → `getAutoCompactThreshold()`, `shouldAutoCompact()`, `autoCompactIfNeeded()`: Auto-compaction trigger and orchestration
* `src/services/compact/compact.ts` → `compactConversation()`, `stripImagesFromMessages()`, `truncateHeadForPTLRetry()`: Core compaction logic
* `src/services/compact/prompt.ts` → `getCompactPrompt()`, 9-section template: Compaction prompt engineering
* `src/services/compact/microCompact.ts` → `COMPACTABLE_TOOLS`, time-based/cached microcompaction: Lightweight strategies
* `src/services/compact/postCompactCleanup.ts` → `runPostCompactCleanup()`: Post-compaction state reset

---

### [00:00] 👉 Opening

Context window 不是无限资源，是逐渐被填满的压力锅。

200 轮对话、50 个文件读取、100 条命令执行 → 不经管理 token 数超过 500K，而最大上下文窗口只有 200K。更关键的是：即使装得下，context 越长推理质量越差（"Lost in the Middle"问题），而且成本线性增长——200K 请求成本是 20K 的 10 倍。

Token 管理同时优化三个目标：**不超限**（硬约束）、**保质量**（软约束）、**省成本**（经济约束）。

今天 60 分钟，从源码级别看完整系统：四级渐进式压缩级联、每级的具体实现、微压缩策略、自动压缩触发、Prompt 工程、以及跨框架对比。

---

### [02:45] 👉 Slide 2 — Source Map

核心文件集中在 `src/services/compact/` 目录（约 2000 行）：

| 文件 | 职责 | 行数 |
|------|------|------|
| `autoCompact.ts` | 触发器 + 编排器 | ~350 |
| `compact.ts` | 完整压缩逻辑 | ~400 |
| `prompt.ts` | 压缩 Prompt (9 节模板) | ~200 |
| `microCompact.ts` | 轻量/微压缩策略 | ~200 |
| `postCompactCleanup.ts` | 压缩后清理 | ~80 |

调用链：`autoCompact.ts` 检测压力 → `compact.ts` 执行压缩 → `prompt.ts` 生成摘要 Prompt → `postCompactCleanup.ts` 重置状态。`microCompact.ts` 是独立路径，在完整压缩前做轻量级处理。

---

### [05:30] 👉 Slide 3 — Context Pressure

`autoCompact.ts:93-145` 中 `calculateTokenWarningState()` 定义了四个压力阈值：

```typescript
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
```

**举例**：200K 上下文窗口，20K 最大输出 → 有效窗口 = 180K

- 自动压缩阈值：180K - 13K = **167K** — 超过自动触发压缩
- 警告阈值：167K - 20K = 147K — UI 显示黄色警告
- 阻塞限制：180K - 3K = 177K — 阻止新输入

**为什么用绝对 token 数而非百分比？** 因为缓冲区的目的是预留模型完成当前轮输出的空间——无论窗口是 100K 还是 200K，单轮输出大小差不多，所以用绝对值更合理。`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 环境变量可 override 窗口大小——典型的可测试性设计。

---

### [08:15] 👉 Slide 4 — 4-Level Compression Cascade

四级压缩，从轻到重，逐级递进：

**Level 1: Micro-compact (Time-based)** — 最轻量的修剪。`microCompact.ts` 维护 `COMPACTABLE_TOOLS` 白名单（如 Read 工具的旧结果）。超过 N 分钟未引用的工具结果被修剪。**类比：清理桌面不用的纸张，保留手边的**

**Level 2: Micro-compact (Cache-based)** — 缓存的 context 内容（文件读取）未被 cache read 命中，修剪。这释放了被"预热但未使用"的上下文空间。

**Level 3: Snip** — 紧急截断。直接截取最近 N 条消息，丢弃最早的历史。`truncateHeadForPTLRetry()` 函数。损失因果上下文，但是最快的方法。**类比：压力锅泄压阀**

**Level 4: Auto-Compact** — 用 LLM 压缩。`compactConversation()` 调用 `prompt.ts` 的 9 节模板，让模型生成上下文摘要。保留关键决策和因果关系，丢弃冗余交互。

每级在独立条件下触发，不是顺序执行。Level 1/2 在日常运行中频繁触发；Level 3 是应急；Level 4 是最终手段。

---

### [11:00] 👉 Slide 5 — Micro-compact: Time-based

`microCompact.ts` 中的基于时间的微压缩：

**核心思想**：不是所有工具结果都需要永久保留。某些工具的结果只在短时间内有价值——比如读取文件列表、检查文件是否存在。

`COMPACTABLE_TOOLS` 白名单（约 15 个工具）——包括 Read、Glob、Grep、Bash 等 "只读" 操作。

实现逻辑（`microCompact.ts` 中 `compactOldToolResultsInConversation` 相关函数）：
```
遍历 conversation messages
→ 如果是工具结果消息
  → 且工具在 COMPACTABLE_TOOLS 白名单
  → 且时间戳超过 threshold (e.g., 15 分钟)
  → 替换为 "Tool X result (compact: timestamp)" — 保留工具名和时间戳，删除结果内容
```

**类比**：像操作系统的 page replacement LRU 算法。最近被访问的工具结果保留在上下文中；长时间未被引用的结果被交换出去——但保留页表项（工具名+时间戳），以便模型知道曾经执行过该操作。

---

### [13:45] 👉 Slide 6 — Micro-compact: Cache-based

基于缓存的微压缩处理一个更微妙的问题：**context caching 与 token 压力的矛盾**。

当 Claude Code 使用 context caching 时（prompt caching），之前读取过的文件内容可以被快速复用。但问题在于：

1. 文件 A 在 Turn 1 中被读取，内容放入 prompt 上下文
2. 在后续 Turns 中，如果文件 A 的缓存命中，prompt 中的文件内容仍然占据空间
3. 但这些内容实际不再需要——API 会读取缓存

`microCompact.ts` 的 cache-based 微压缩：**如果缓存命中且内容未被 API 使用，则从 prompt 中移除该段内容**

```typescript
// 逻辑流程
if (cacheHit && !apiUsedCachedContent) {
  // 从 messages 中移除对应内容
  // 保留工具调用的 metadata（工具名、文件路径、参数）
  // 删除工具结果的具体 body
}
```

**设计理由**：cache_write 比 cache_read 贵——cache_write 的成本是 cache_read 的 10 倍。所以一旦内容被写入缓存，prompt 中就不应重复携带它。这直接节省了 token 和成本。

**类比**：像 CPU cache 的 MESI 协议——一旦数据被同步到 L2/L3，L1 中的拷贝就不需要了。

---

### [16:30] 👉 Slide 7 — Snip (Emergency Cut)

Snip 是**紧急截断**——最快的减压手段，但也丢失最多因果上下文。

`compact.ts` 的 `truncateHeadForPTLRetry()` 函数：
- 截取最近 N 条消息（保留最新的对话）
- 丢弃最早的历史（从头部截断）
- 用于 PTL (Prompt Too Long) 重试——当 prompt 本身超长需要快速修复时

**什么时候触发**：
1. 消息数超过绝对限制（`MAX_CONVERSATION_TURNS`）
2. 在 PTL 重试场景中——当 `compactConversation` 也失败时
3. 手动截断——用户要求缩短对话

**设计权衡**：Snip 是最后手段之前的一步——它快，但不智能。模型会丢失对早期决策的上下文，可能导致重复工作或矛盾决策。但在紧急情况下（API 拒绝过长 prompt），这是唯一的快速出路。

**关键常量**：`MANUAL_COMPACT_BUFFER_TOKENS = 3_000` — 手动压缩的保留空间。用户主动触发压缩时保留 3K 缓冲。

---

### [19:15] 👉 Slide 8 — AutoCompact: The Full LLM Compression

AutoCompact 是最智能、最完整的压缩。它用另一个 LLM 调用来压缩当前上下文。

`compact.ts` 的 `compactConversation()` 是核心函数。完整流程：

1. **检测上下文压力** — 当前消息数 vs 有效窗口大小
2. **确定截断点** — 选择保留多少轮次（保留最近的用户交互）
3. **构建压缩 Prompt** — 从 `prompt.ts` 获取 9 节模板
4. **调用压缩 LLM** — 通常使用 Sonnet（成本较低）
5. **处理压缩结果** — 接收摘要，替换被压缩的消息
6. **重建消息数组** — 摘要 + 保留的消息 → 新的对话状态
7. **后处理清理** — `postCompactCleanup()` 重置缓存、更新 token 计数

**类比**：AutoCompact 不是截断，是压缩——就像 git 的 `gc` 把多个 commit 对象压缩成 packfile，保留所有信息但节省空间。

---

### [22:00] 👉 Slide 9 — AutoCompact: Threshold & Trigger

`autoCompact.ts:350-687` 中的 `autoCompactIfNeeded()` 是自动化管线的核心触发器：

```typescript
// 简化逻辑
async function autoCompactIfNeeded(
  threshold,           // 触发阈值
  maxRetries = 3,      // 最大重试次数
  keepToolCallResults  // 是否保留工具结果
): Promise<CompactResult>
```

**触发条件**：
1. `shouldAutoCompact()` — 当前 token 用量是否超过阈值
2. `getAutoCompactThreshold()` — 动态计算当前阈值
3. `getEffectiveContextWindowSize()` — 动态计算有效窗口大小

**关键设计**：AutoCompact 不是"一旦超限立即压缩"。它有 retry 逻辑（默认 3 次）——因为压缩 LLM 本身也可能失败。它还支持 `keepToolCallResults` 标志，允许在压缩时保留工具结果而非丢弃。

**代码引用**：`autoCompact.ts:156-348`，`compact.ts:1-200`

**类比**：像操作系统的内存 compaction——当碎片过多或空间不足时，系统触发整理，移动数据块释放连续空间。不同之处是 LLM 压缩保留了语义关系——不是简单移动数据，而是摘要和重述。

---

### [24:45] 👉 Slide 10 — Compaction Prompt: 9-Section Template

压缩 Prompt 是 `prompt.ts` 中的 9 节模板。每节指导模型如何生成摘要。

**9 个部分**（从 `prompt.ts` 读取）：

1. **系统角色** — 你是 Claude Code 的对话摘要生成器
2. **目标** — 生成简洁但完整的对话摘要，保留关键决策和因果关系
3. **格式约束** — 使用结构化格式：目标、行动、结果
4. **保留规则** — 用户的目标和意图必须保留
5. **文件引用** — 涉及的文件路径和关键代码变更必须记录
6. **决策点** — 为什么选择方案 A 而不是 B？原因必须保留
7. **错误/修复** — 遇到的错误和解决方法必须保留
8. **待处理** — 未完成的任务和后续步骤必须记录
9. **丢弃规则** — 冗余交互、寒暄、重复尝试可以丢弃

**设计理由 #2**：Prompt 模板的 9 个部分覆盖了"信息保留"与"大小缩减"的权衡。保留因果关系（决策、错误、修复）而非表面细节（反复尝试的过程、寒暄）。这是有损压缩但保留语义——像 JPEG 压缩：丢弃人眼不易察觉的高频信息，保留低频结构。

```typescript
// prompt.ts 中的部分模板结构
function getCompactPrompt(conversation): string {
  return `
1. System Role: 你是对话摘要压缩引擎
2. Goal: 保留决策意图和因果关系，丢弃冗余交互
3. Format: 结构化摘要，包含目标、文件变更、关键决策
4-9. ... [sections 4-9]
  `
}
```

---

### [27:30] 👉 Slide 11 — Post-Compact Rebuild

压缩完成后，必须重建对话状态。`compact.ts:670-750`: `buildPostCompactMessages()` 函数：

```typescript
// 结果处理
const compactedMessages = [
  createSyntheticSystem消息(
    compactResult.summary,   // LLM 生成的摘要
    'compact_summary'
  ),
  ...remainingRecentMessages   // 最近未压缩的消息
]
```

**三个关键步骤**：

1. 创建 "系统摘要消息" — 包含 LLM 生成的摘要，作为一个特殊的系统消息
2. 拼接剩余消息 — 压缩后保留的最近交互（通常最近 5-10 轮）
3. 更新 token 计数 — 重新计算压缩后的总 token 用量

```
[旧的历史消息] → [摘要] → [最近 5-10 轮完整上下文]
       ↓            ↓                ↓
    被压缩       合成系统消息       保留原样
```

**设计理由 #3**：用合成的 "系统摘要" 消息代替被截断的历史。这样后续压缩轮可以引用之前压缩的摘要。如果没有这一步，每次压缩都会丢失前压缩的信息——像反复 JPEG 压缩的"代数损失"问题。保留历史摘要链防止了信息丢失累积。

**类比**：像 git rebase 的 squash——将多个 commit 合并成一个有描述性的 commit message，同时保留最近的 commit 作为详细的延续。后续的 squash 可以参考之前的 squash message。

---

### [30:15] 👉 Slide 12 — Fork Subagent & Context Sharing

Fork Agent 的上下文处理是一个特殊情况。当创建子 Agent 时：

```typescript
// forkSubagent.ts — 消息克隆
const forkedMessages = structuredClone(parentMessages.slice(0, forkPoint))
```

**关键约束**：Fork Agent 使用 `structuredClone()` 而不是引用复制——它有自己独立的消息拷贝。但 prompt cache 优化使它能够复用父 Agent 的缓存 prefix——**fork 点前相同的消息序列会被 API 识别为缓存命中**。

这意味着：Fork Agent 的 prompt 虽然是一个新的 API 请求，但由于它与父 Agent 共享前缀，前缀部分会被 cache_read 而不是 cache_write——**节省 90% 的 prompt token 成本**（cache_read 比 cache_write 便宜 10 倍）。

**代码引用**：`src/tools/AgentTool/forkSubagent.ts:64-73`

---

### [33:00] 👉 Slide 13 — Context Collapse

当所有压缩策略都已用完，但仍然超限——"Context Collapse"。

**什么导致 Collapse**：
1. 压缩 LLM 本身产生输出 + token 压力
2. 多轮压缩后，摘要仍然太大
3. Fork Agent 的上下文加上父 Agent 的总量超限

**系统如何响应**：
1. 首先尝试 Snip（紧急截断）— `truncateHeadForPTLRetry()`
2. 如果 Snip 不够，抛出 "context too large" 错误给用户
3. 用户可以选择手动截断对话或重新开始

**设计理由 #4**：没有"无限压缩"——压缩后的摘要仍然占据空间。当连摘要都装不下时，唯一的出路是人工干预。这是系统的硬边界。

**代码引用**：`compact.ts:270-360`

---

### [35:45] 👉 Slide 14 — Cross-Framework Comparison

与其他框架的对比：

| 特性 | Claude Code | LangChain | MemGPT |
|------|-------------|-----------|--------|
| 压缩策略 | 四级级联 | sliding window | 记忆分页 |
| Cache 集成 | Prompt caching (API级) | 无 | 无 |
| 自动触发 | 基于绝对阈值 | 手动/基于计数 | 基于消息数 |
| Prompt 模板 | 9 节定制摘要 | 无内置 | 核心/感知分离 |
| Fork 优化 | Cache 复用 | N/A | N/A |

---

### [38:00] 👉 Slide 15 — Constants Summary

| 常量 | 值 | 用途 |
|------|-----|------|
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | 自动压缩余量 |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | UI 警告 |
| `ERROR_THRESHOLD_BUFFER_TOKENS` | 20,000 | UI 错误 |
| `MANUAL_COMPACT_BUFFER_TOKENS` | 3,000 | 手动压缩余量 |
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 | 摘要输出限制 |

---

### [40:00] 👉 Slide 16 — Summary

**核心洞察**：Token 管理不是"限制"，是"优化"。四个层级从轻到重：
1. **Micro-compact**: 修剪过期/未使用的结果 — 类似 LRU 缓存回收
2. **Cache-aware**: 识别缓存命中并消除冗余 — 类似 CPU cache MESI
3. **Snip**: 紧急截断 — 类似压力锅泄压阀
4. **AutoCompact**: LLM 生成摘要 — 类似 JPEG 有损但语义保留

**为什么不是单一压缩？** 因为不同级别的压力需要不同的工具。用 LLM 压缩 5% 的超限是浪费——Micro-compact 处理就够了。但当压力超过 50%，简单的修剪不够了，需要 LLM 压缩。四级级联确保用最便宜的方法处理当前级别人力。

---

### [38:00] 👉 Slide 15 — Constants Summary

| 常量 | 值 | 用途 |
|------|-----|------|
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | 自动压缩余量 |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | UI 警告 |
| `ERROR_THRESHOLD_BUFFER_TOKENS` | 20,000 | UI 错误 |
| `MANUAL_COMPACT_BUFFER_TOKENS` | 3,000 | 手动压缩余量 |
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 | 摘要输出限制 |

这些数字不是凭空而来的——每个都经过生产场景反复调整。

---

### [40:00] 👉 Slide 16 — Summary

**核心洞察**：Token 管理不是"限制"，是"优化"。四个层级从轻到重：
1. **Micro-compact**: 修剪过期/未使用的结果 — 类似 LRU 缓存回收
2. **Cache-aware**: 识别缓存命中并消除冗余 — 类似 CPU cache MESI
3. **Snip**: 紧急截断 — 类似压力锅泄压阀
4. **AutoCompact**: LLM 生成摘要 — 类似 JPEG 有损但语义保留

**为什么不是单一压缩？** 因为不同级别的压力需要不同的工具。用 LLM 压缩 5% 的超限是浪费——Micro-compact 处理就够了。但当压力超过 50%，简单的修剪不够了，需要 LLM 压缩。四级级联确保用最便宜的方法处理当前级别人力。

---

### [42:00] 👉 Slide 16b — Rationale: 为什么不是单一压缩？

**[42:00]**

如果只有一次压缩策略（比如每次都调 LLM 摘要），问题显而易见：

1. **性能浪费** — 每次 LLM 调用至少 2-5 秒。对于只有 5% 超限的场景，调 LLM 压缩的代价可能超过超限本身。
2. **语义损失** — LLM 压缩是有损压缩，信息永远丢失。如果只是修剪几个旧文件读取的结果，语义损失为零。
3. **成本叠加** — 压缩本身消耗 token（输入 + 输出），在 token 预算紧张时反而加速超限。

四级级联确保用**刚好够**的方法：

```
压力 < 10% → Micro-compact (零成本)
压力 10-30% → Cache-aware (零成本)
压力 30-60% → Snip (零成本但有损)
压力 > 60% → AutoCompact (有成本但语义保留)
```

**类比**：这就像内存管理——GC 先做标记清除，标记-压缩，最后才做 Full GC。不是每次 GC 都需要停世界 Full GC。

---

### [44:00] 👉 Slide 18 — QA

**关键讨论点**：
1. **AutoCompact 的 Prompt 模板能否针对特定领域定制？** 比如代码项目 vs 数据分析项目需要不同的摘要策略。当前模板是通用的，但 `getCompactPrompt()` 的设计允许未来按项目类型切换模板。
2. **Cache-aware micro-compact 在 prompt cache 未启用时退化为纯时间策略？** 是的——`evaluateCacheAwareTrigger()` 检查 API 响应中的 `cache_creation_input_tokens` 和 `cache_read_input_tokens`，如果都是零，说明 cache 未启用，退化为时间衰减策略。
3. **多级压缩是否可能导致"压缩后的压缩"信息损失？** 每次压缩后重新计算 token 用量，只有当压力继续增加时才触发下一级。但多次压缩确实会导致信息层层丢失——这是一个已知的权衡。
4. **Fork Agent 的缓存优化在多 Fork 场景下效果如何？** Fork Agent 的缓存优化在单个 fork 场景下效果最佳。多 fork 场景下，每个 fork 可能产生独立的 cache，总体缓存命中率下降。

---

### [46:00] 👉 Slide 18c — Cross-Framework 详细对比

**与 LangChain 的对比**：

LangChain 的 sliding window 策略是固定窗口：保留最近 N 条消息，丢弃更早的。简单但粗暴——最近 N 条消息中包含重要信息，而更早的消息中可能有关键的架构决策记录。

Claude Code 的四级级联是渐进式：先尝试无损修剪（Micro-compact），再尝试冗余消除（Cache-aware），最后才考虑有损压缩。每一步都保留最大语义内容。

**与 MemGPT 的对比**：

MemGPT 的核心/感知分离是一个好主意——把长期记忆和短期交互分开。但它需要应用层显式管理记忆，开发成本高。Claude Code 的方式对用户和开发者都更透明。

**[50:00] — END**

---

*本章演讲总时长约 60 分钟。*

<!-- 
AUTO-GENERATED SLIDE SYNC REFERENCE
Please ensure your script.md contains the following headers:
Slide 01: cover
Slide 02: Learning Objectives
Slide 02: Ch.04 Token Management
Slide 03: Ch.04 Token Management
Slide 05: Ch.04 Token Management
Slide 06: Code Walkthrough
Slide 07: Ch.04 Token Management
Slide 04: Ch.04 Token Management
Slide 05: Ch.04 Token Management
Slide 06: Ch.04 Token Management
Slide 07: Ch.04 Token Management
Slide 08: Ch.04 Token Management
Slide 09: Context Collapse
Slide 10: Ch.04 Token Management
Slide 11: Ch.04 Token Management
Slide 16: Code Walkthrough
Slide 12: Ch.04 Token Management
Slide 13: Post-Compact Rebuild
Slide 14: Ch.04 Token Management
Slide 15: Ch.04 Token Management
Slide 16: Ch.04 Token Management
Slide 17: Fork Cache Sharing
Slide 18: Ch.04 Token Management
Slide 24: CHAPTER 04 | TOKEN MANAGEMENT
Slide 19: Ch.04 Token Management
Slide 20: Ch.04 Token Management
Slide 27: Key Terms
Slide 21: Ch.04 Token Management
Slide 29: See Also
Slide 30: qa
-->