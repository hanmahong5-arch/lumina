# Chapter 7: Memory — 演讲逐字稿

> 时长：55 分钟 | 20 张幻灯片 | 面向资深开发者技术沙龙

---

## 👉 Slide 1 — Cover

**[00:00]**

大多数 LLM 应用把"记忆"等同于向量数据库。Claude Code 的做法完全不同——**纯文件系统、分类学驱动、LLM 做语义选择**。这一章 55 分钟，从源码级别拆解这背后的工程理由。

---

## 👉 Slide 2 — SourceMap

**[00:40]**

核心文件：

- `src/memdir/memdir.ts` — MEMORY.md 常量定义、截断逻辑、prompt 构建
- `src/memdir/findRelevantMemories.ts` — Sonnet sideQuery，选择 ≤5 个最相关记忆文件
- `src/services/extractMemories/extractMemories.ts` — 自动提取管线：Fork Agent、沙箱、增量游标
- `src/services/teamMemorySync/teamMemSecretGuard.ts` — 团队记忆秘密过滤
- `src/memdir/memoryTypes.ts` — 四类分类定义

架构上横跨 `memdir/`（文件层）和 `services/`（业务层）：读取是 prompt 的一部分，写入是 agent 行为。

---

## 👉 Slide 3 — Architecture（两层）

**[01:20]**

两层架构，索引/内容分离：

**索引层（MEMORY.md）** — 始终加载进 system prompt。每行一个指针：`- [Title](file.md) — one-line hook`。上限 200 行 / 25KB。类比：**MEMORY.md 不是数据库，是目录页——像书的 index，不是全文搜索引擎**。

```typescript
// src/memdir/memdir.ts
export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
export const MAX_ENTRYPOINT_BYTES = 25_000
```

**[02:05]**

**内容层（独立 .md 文件）** — 每条记忆一个独立文件，带 frontmatter（name, description, type）。按需通过 Sonnet sideQuery 加载，每次最多 5 个文件。

为什么两层？如果把 200 条记忆全部塞进 system prompt，50K+ token 会挤占代码上下文。两层设计让索引开销固定（≤25KB ≈ ~6K token），内容开销按需触发（≤5 文件 ≈ ~5K-15K token）。

---

## 👉 Slide 4 — Types（四类）

**[03:05]**

封闭四类分类法（closed taxonomy）：

1. **user** — 身份、偏好、角色。例："偏好 bun 而非 npm"
2. **feedback** — 对 agent 行为的纠正。例："不要自动 summarize diff"
3. **project** — 代码不可推导的项目信息。例："deadline 下周五"、"Linear 项目板在 XXX"
4. **reference** — 外部系统文档。例："MCP server 配置格式"

源码中 `memoryTypes.ts` 的 `TYPES_SECTION_INDIVIDUAL` 数组精确划定边界。

为什么四类而不是自由标签？封闭分类把模型决策空间从无限压缩到 4，消除标签歧义（"architecture"、"code-style" 都是 project 的子集）。同时 sideQuery 只学 4 个类别的语义，不需要开放词汇表。

---

## 👉 Slide 5 — Constraints（不可推导）

**[04:10]**

核心约束：**只保存不可从当前项目状态推导的信息**。

```typescript
// src/memdir/memdir.ts, buildMemoryLines()
// content that is derivable from the current project state
// (code patterns, architecture, git history) is explicitly excluded.
```

**不记**："项目用 TypeScript"（看 .ts 文件就知道）、"用 monorepo"（看目录结构就知道）、"ESLint 配置"（看配置文件就知道）。

**记**："用户是后端工程师，负责支付系统"（不可从代码推导）、"上次 code review 说 error handling 太啰嗦"（反馈）、"Q3 milestone 是重构数据库层"（业务决策）。

**[04:50]**

工程价值在**去重**。可推导的信息存进记忆 = 浪费 token + 增加矛盾风险（项目迁移后记忆过时）+ 降低信噪比。

对比 LangChain ConversationBufferMemory/SummaryMemory 不做这个区分，保存所有对话摘要；Mem0 的 "fact extraction" 会提取 `"user is working on a Python project"` 这类可推导事实。

---

## 👉 Slide 6 — Truncation

**[05:40]**

截断逻辑在 `truncateEntrypointContent()`：

```typescript
// src/memdir/memdir.ts
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  // Line-truncates first (natural boundary),
  // then byte-truncates at the last newline before the cap
  // so we don't cut mid-line.
}
```

双重上限：200 行 + 25,000 字节。先行截断（自然边界），再字节截断（在 last newline 处切割，不切断行中间）。

为什么需要字节上限？p100 观察到 197KB、不到 200 行——仅靠行数控制不了 token 开销。25KB 是 p97 处的安全网。

超限后追加 WARNING，模型下次写入时会看到并自动精简：

```
> WARNING: MEMORY.md is 250 lines (limit: 200). Only part of it was loaded.
> Keep index entries to one line under ~200 chars; move detail into topic files.
```

---

## 👉 Slide 7 — Loading（三模式）

**[06:40]**

`loadMemoryPrompt()` 分派三种模式：

**Auto Only** — 仅个人记忆：`~/.claude/projects/<slug>/memory/`。默认模式。

**Auto + Team** — 个人 + 团队共享记忆（`memory/team/` 子目录）。`isTeamMemoryEnabled()` 门控。

**KAIROS Daily Log** — 长期 assistant 模式。append-only 到 `logs/YYYY/MM/YYYY-MM-DD.md`，nightly `/dream` 技能整理，不写 MEMORY.md。

```typescript
// src/memdir/memdir.ts
if (feature('KAIROS') && autoEnabled && getKairosActive()) {
  return buildAssistantDailyLogPrompt(skipIndex)
}
```

共性：**MEMORY.md 始终只读加载**。KAIROS 不用 MEMORY.md 因为 assistant 持续数天/周，频繁更新索引开销过大。

---

## 👉 Slide 8 — Semantic（sideQuery）

**[07:25]**

检索不用向量，用 **Sonnet 做语义选择**：

```typescript
// src/memdir/findRelevantMemories.ts
const result = await sideQuery({
  model: getDefaultSonnetModel(),
  system: SELECT_MEMORIES_SYSTEM_PROMPT,
  messages: [{ role: 'user', content: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}` }],
  max_tokens: 256,
  output_format: { type: 'json_schema', ... },
  signal,
  querySource: 'memdir_relevance',
})
```

流程：`scanMemoryFiles()` 读 frontmatter → `formatMemoryManifest()` 组清单 → Sonnet 在清单上选 ≤5 个 → 返回 `selected_memories: ["file1.md", ...]` → 注入内容。

System prompt 有一条细腻指令：

```
If a list of recently-used tools is provided, do not select memories that are
usage reference or API documentation for those tools — active use is exactly
when those matter. DO still select memories containing warnings, gotchas, or
known issues about those tools.
```

Agent 已经在用某个工具 → "用法参考"冗余，但"已知陷阱"仍有价值。

---

## 👉 Slide 9 — Selection（Sonnet）

**[08:15]**

选 Sonnet 而非 Haiku 或 Opus：sideQuery max_tokens 仅 256，输入是 frontmatter 清单——短上下文分类任务，Sonnet 准确率远高于 Haiku，Opus overkill。

关键参数：
- **≤5 文件** — 硬编码。增量 ~5K-15K token
- **alreadySurfaced 过滤** — 已展示过的文件从候选移除，不重复浪费名额
- **validFilenames 校验** — 返回的文件名必须在扫描结果中，防幻觉

```typescript
// src/memdir/findRelevantMemories.ts
const parsed: { selected_memories: string[] } = jsonParse(textBlock.text)
return parsed.selected_memories.filter(f => validFilenames.has(f))
```

对比 OpenAI Assistants file_search（底层向量嵌入 + 余弦相似度）：在几十到几百个文件的体量下，线性扫描 frontmatter + LLM 判断的准确率更高。

---

## 👉 Slide 10 — NoVector（为什么不用向量数据库）

**[09:00]**

四个理由。

**规模不匹配**：向量 DB 解决百万级文档的 ANN 检索。记忆系统几十到几百个文件，embedding 生成 + 索引维护 + 向量存储的前期成本远高于线性扫描 frontmatter。

**[09:30]**

**语义鸿沟**：向量嵌入捕获词汇/句法相似度，记忆检索需要的是**任务相关性**。用户问 "修复支付接口 bug"——向量可能命中 "支付重构 race condition"（词法相似），但会漏掉 "用户讨厌 verbose error handling"（词法无关但任务相关）。LLM 两者都能捕捉。

**[10:00]**

**运维零**：纯文件系统，无数据库进程、无索引、无嵌入模型依赖。`~/.claude/projects/<slug>/memory/` 下几个 .md 文件——文本编辑器可看可改，git 可版本控制，grep 可搜索。类比：**不需要装 MongoDB 才能读一本笔记本**。

**[10:30]**

**可解释性**："因为 Sonnet 选了 `feedback_testing.md`"——用户打开文件就能验证。向量检索的 "余弦相似度 0.87" 对用户没有意义。

对比 Mem0：核心卖点是 Qdrant/Chroma，处理大规模对话检索更快，但抽取的是短句片段（"user prefers Python"），不是结构化分类记忆。解决的不是同一个层次的问题。

---

## 👉 Slide 11 — Extraction（pipeline）

**[11:15]**

自动提取管线是最复杂的部分。每个完整 query loop 结束时触发（模型产出最终响应，无 tool call），由 `handleStopHooks` 驱动：

```
用户提问 → 模型回答 → stopHooks 触发 → extractMemories 启动
  → 计算新消息数 → 检查手动写入 → 构建 prompt → Fork Agent 执行
  → sandbox canUseTool 限制 → 最多 5 轮 → 写入记忆文件
```

入口在 `src/services/extractMemories/extractMemories.ts`：

```typescript
export function initExtractMemories(): void {
  // Closure-scoped mutable state:
  // - lastMemoryMessageUuid: cursor, tracks last processed message
  // - inProgress: overlap guard
  // - pendingContext: trailing run stash
  // - turnsSinceLastExtraction: throttle counter
}
```

**[11:55]**

状态用闭包作用域而非模块级变量——与 `confidenceRating.ts` 同一模式。测试在 `beforeEach` 中调 `initExtractMemories()` 即获得干净闭包，不需要 mock 模块状态。

---

## 👉 Slide 12 — ForkExtract（cache 60%）

**[12:40]**

自动提取使用 **Fork Agent**——主对话的 perfect fork，共享 prompt cache：

```typescript
// src/services/extractMemories/extractMemories.ts
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: userPrompt })],
  cacheSafeParams,
  canUseTool,
  querySource: 'extract_memories',
  forkLabel: 'extract_memories',
  skipTranscript: true,
  maxTurns: 5,
})
```

`cacheSafeParams` 提取 system prompt、tools、model 等参数，确保 Fork Agent 的 API 请求前缀与主对话完全一致——主对话的 prompt cache 直接复用。

**[13:20]**

60%+ cache hit rate：

```typescript
const hitPct = totalInput > 0
  ? ((result.totalUsage.cache_read_input_tokens / totalInput) * 100).toFixed(1)
  : '0'
```

200K token 对话中，Fork Agent 只付 ~80K 新 token 成本，120K 来自缓存。边际成本约 40%。

`maxTurns: 5` 硬上限。正常提取 2-4 轮完成。5 轮防止验证死循环（verification rabbit-holes）。

---

## 👉 Slide 13 — Sandbox（权限）

**[14:10]**

Fork Agent 运行在严格沙箱中：

```typescript
// src/services/extractMemories/extractMemories.ts
export function createAutoMemCanUseTool(memoryDir: string): CanUseToolFn {
  return async (tool: Tool, input: Record<string, unknown>) => {
    // Allow: Read, Grep, Glob (unrestricted, read-only)
    // Allow: Bash (only if isReadOnly)
    // Allow: Edit/Write (only if path is within memoryDir)
    // Deny: everything else
  }
}
```

允许：Read/Grep/Glob（只读）、Bash（只读命令：ls/find/grep/cat/stat/wc/head/tail）、Edit/Write（仅 `isAutoMemPath(filePath)` 路径）、REPL（ant-default 模式下原始工具被隐藏，模型通过 REPL 调用，VM 内重新走 `canUseTool` 检查，安全边界不被绕过）。

拒绝：其他所有工具。

最小权限原则——只读对话、写记忆，不需要执行代码、改项目文件、发网络请求、调 MCP。同时缩减 system prompt 大小。

---

## 👉 Slide 14 — Trailing（增量）

**[15:20]**

增量提取靠 **cursor + trailing run**。

`lastMemoryMessageUuid` 游标，指向上次处理到的最后一条消息。每次只处理游标之后的新消息：

```typescript
const newMessageCount = countModelVisibleMessagesSince(
  messages,
  lastMemoryMessageUuid,
)
```

**互斥**：主 agent 手动写入了记忆 → Fork Agent 跳过 + 推进游标，防重复：

```typescript
if (hasMemoryWritesSince(messages, lastMemoryMessageUuid)) {
  // Skip: main agent already wrote. Advance cursor.
  lastMemoryMessageUuid = lastMessage.uuid
  return
}
```

**Trailing Run**：提取正在进行时新 stopHook 触发 → 上下文暂存 `pendingContext` → 当前提取完成后自动运行 trailing extraction。

**[16:30]**

频率控制：`turnsSinceLastExtraction` + GrowthBook flag `tengu_bramble_lintel`（默认 1）控制节流。Trailing run 跳过节流——处理已积累的上下文，不应被限。

游标丢失恢复：`lastMemoryMessageUuid` 因 context compaction 被移除 → `countModelVisibleMessagesSince` fallback 到计算所有 visible 消息，而非返回 0 永久禁用提取。

---

## 👉 Slide 15 — Team（同步）

**[17:15]**

团队记忆——`feature('TEAMMEM')` 且 `isTeamMemoryEnabled()` 时同时管理两个目录：

- 个人：`~/.claude/projects/<slug>/memory/`
- 团队：`~/.claude/projects/<slug>/memory/team/`

同步在 `src/services/teamMemorySync/watcher.ts`，文件 watcher + 同步协议推送给所有仓库协作者。

```typescript
// src/memdir/memdir.ts
if (feature('TEAMMEM')) {
  if (teamMemPaths!.isTeamMemoryEnabled()) {
    const autoDir = getAutoMemPath()
    const teamDir = teamMemPaths!.getTeamMemPath()
    await ensureMemoryDirExists(teamDir) // recursive mkdir, creates auto dir too
    return teamMemPrompts!.buildCombinedMemoryPrompt(extraGuidelines, skipIndex)
  }
}
```

精巧细节：`getTeamMemPath()` 返回 `join(getAutoMemPath(), 'team')`——团队目录是个人目录子目录，所以 `ensureMemoryDirExists(teamDir)` 递归 mkdir 同时创建父目录。代码注释标注：如果未来团队目录移出个人目录下方，需额外 `ensureMemoryDirExists(autoDir)`。

KAIROS 与 TEAMMEM 互斥——append-only log 与 shared MEMORY.md 读写模式不兼容。

---

## 👉 Slide 16 — Secret（过滤）

**[18:20]**

团队记忆安全层：

```typescript
// src/services/teamMemorySync/teamMemSecretGuard.ts
export function checkTeamMemSecrets(filePath: string, content: string): string | null {
  // Only checks files in team memory path
  // Scans for sensitive prefixes (API keys, tokens, etc.)
  // Returns error message if secrets detected, null if safe
}
```

被 FileWriteTool/FileEditTool 的 `validateInput` 调用。`scanForSecrets()` 运行时组装敏感前缀列表做模式匹配。检测到秘密时：

```
Content contains potential secrets (API Key) and cannot be written to team memory.
Team memory is shared with all repository collaborators.
Remove the sensitive content and try again.
```

理由：团队记忆同步给所有协作者。如果 API key 被写入团队目录 → 泄露给所有人。这是最后一道防线。

`checkTeamMemSecrets` 可无条件调用——内部 `feature('TEAMMEM')` 门控在非 TEAMMEM 构建中返回 null，安全无副作用。

---

## 👉 Slide 17 — Compare（LangChain / Mem0 / OpenAI）

**[19:20]**

三方对比：

| 维度 | 本系统 | LangChain Memory | Mem0 | OpenAI Assistants |
|------|--------|-------------------|------|-------------------|
| 存储 | 纯文件系统 (.md) | 内存/Redis/向量DB | Qdrant/Chroma | 服务端 Vector Store |
| 检索 | LLM sideQuery | 向量相似度 / 关键词 | 向量嵌入 + LLM | 向量嵌入 |
| 分类 | 封闭四类 | 无分类 | 自由标签 | 无分类 |
| 提取 | Fork Agent (共享cache) | 手动或 Chain | 自动 (fact extraction) | N/A (仅文件上传) |
| 团队协作 | 内建 (team dir + sync) | 无 | 无 | 无 |
| 秘密防护 | secretGuard 扫描 | 无 | 无 | 服务端隔离 |
| 可观测性 | 纯文本文件, 用户可编辑 | 取决于存储后端 | Dashboard | API only |

三个差异点：

**检索精度 vs 规模**：本系统 n<1000 下精度更高（LLM 理解任务语境），但线性增长不可扩展。向量方案大规模友好但语义理解弱。

**提取策略**：Fork Agent 共享 cache → 边际成本 ~40% 新 token。Mem0 独立 LLM 调用无 cache 共享。LangChain 通常手动 Chain。

**用户可控**：.md 文件可直接编辑/git 管理。Mem0 需要 API/Dashboard。OpenAI 完全黑盒。

---

## 👉 Slide 18 — Constants

**[21:15]**

```typescript
// memdir.ts
ENTRYPOINT_NAME        = 'MEMORY.md'
MAX_ENTRYPOINT_LINES   = 200
MAX_ENTRYPOINT_BYTES   = 25_000   // ~25KB, catches long-line abuse at p97

// findRelevantMemories.ts
max selected memories  = 5         // hardcoded in system prompt
sideQuery max_tokens   = 256       // minimal output for selection
sideQuery model        = getDefaultSonnetModel()

// extractMemories.ts
maxTurns               = 5         // Fork Agent hard cap
skipTranscript         = true      // no race conditions with main thread
querySource            = 'extract_memories'

// createAutoMemCanUseTool
allowed tools          = [Read, Grep, Glob, Bash(readOnly), Edit/Write(memDir only), REPL]

// teamMemSecretGuard.ts
detection              = pattern-based prefix matching (API keys, tokens)
scope                  = team memory path only
```

关键数字：
- **200 行 / 25KB** — 索引上限
- **5 文件** — 语义选择上限，增量 ≤15K token
- **5 轮** — Fork Agent 硬上限，正常 2-4 轮
- **60%+** — cache hit rate

---

## 👉 Slide 19 — Summary

**[22:10]**

五个核心洞察：

**索引/内容分离是 LLM 记忆的最优结构**。MEMORY.md 作为固定开销目录，内容文件按需加载。比全量加载或向量检索更适合上下文窗口约束。

**封闭分类 + 不可推导约束 = 信噪比保障**。四类消除分类歧义，不可推导排除冗余。

**LLM-as-retriever 在 n<1000 下优于向量**。Sonnet sideQuery 的语义理解 > 余弦相似度。代价 O(n)，可接受。

**Fork Agent + cache sharing 让后台任务几乎免费**。60%+ cache hit rate → "每轮都尝试提取"可行。

**纯文件系统是最佳 DX**。零运维记忆系统——无数据库、无嵌入模型、无嵌入存储。

---

## 👉 Slide 20 — QA

**[23:40]**

预设问题：

**Q1：记忆文件增长到几千个时怎么办？**

~1000 文件时 Sonnet sideQuery 的清单超过 10K token，成本显著上升。演进方向：分层索引（先 type 预过滤再 sideQuery）或 MEMORY.md 增加 category tag。目前绝大多数用户记忆文件数在几十个量级。

**Q2：为什么不用 embedding 第一轮过滤 + LLM 第二轮精选？**

增加 embedding model + 向量存储的依赖。当前纯 LLM 方案在目标规模下已足够，增加 embedding 层的 ROI 不明确。但记忆规模膨胀后这是自然的演进路径。

**Q3：Fork Agent 5 轮上限怎么定出来的？**

源码注释："well-behaved extractions complete in 2-4 turns"。5 = 4 + 1 安全边际。超过 4 轮通常是 agent 在做不必要的验证（读刚写入的文件检查是否正确），应该截断而不是鼓励。

**[25:00]**

**[55:00]**

下一章——协议层，Remote Control 的 Bridge 系统。

<!-- 
AUTO-GENERATED SLIDE SYNC REFERENCE
Please ensure your script.md contains the following headers:
Slide 01: 01-cover
Slide 2: Ch 07 Memory
Slide 3: Ch 07 Memory
Slide 4: Ch 07 Memory
Slide 5: Ch 07 Memory
Slide 6: Ch 07 Memory
Slide 7: Ch 07 Memory
Slide 8: Ch 07 Memory
Slide 9: Ch 07 Memory
Slide 10: Ch 07 Memory
Slide 11: Ch 07 Memory
Slide 12: Ch 07 Memory
Slide 13: Ch 07 Memory
Slide 14: Ch 07 Memory
Slide 15: Ch 07 Memory
Slide 16: Ch 07 Memory
Slide 17: Ch 07 Memory
Slide 18: Ch 07 Memory
Slide 19: Ch 07 Memory
Slide 20: 20-qa
Slide 21: Learning Objectives
Slide 22: Code Walkthrough
Slide 23: CHAPTER 07 | MEMORY SYSTEM
Slide 18: CHAPTER 07 | MEMORY
Slide 25: Key Terms
Slide 19: CHAPTER 07 | MEMORY
Slide 27: See Also
-->