# Chapter 10: Feature Gate + Cost Architecture — 演讲逐字稿

> 时长：55 分钟 | 24 张幻灯片

## Core Source Files Referenced
* `src/constants/betas.ts` → Beta header 常量定义 (18+)、版本日期管理
* `src/utils/betas.ts` → Beta 合并逻辑 + 平台过滤 + GrowthBook 集成
* `src/utils/settings/types.ts` → Zod v4 设置 schema 定义
* `src/utils/settings/settings.ts` → 5 层设置加载与合并管线
* `src/setup.ts` → 10 步启动流程入口
* `src/constants/system.ts` → 系统级 feature flag 定义
* `src/utils/stats.ts` → GitHub-style heatmap + streaks 统计
* `src/utils/usage.ts` → API 用量追踪与成本计算
* `src/bridge/costTracker.ts` → Session-level 成本追踪器

---

## 👉 Slide 1 — Cover

**[00:00]**

Feature Gate 和 Cost Management 是同一个硬币的两面：一个决定**谁可以调什么 API**，一个决定**调了要花多少钱**。开源项目通常只实现前者——但 SaaS 产品中不控制成本 = 放任用户烧钱。

**[00:15]**

核心指标：962 处 `feature()` 调用、213+ 文件、18+ Beta Headers、12 档定价、5 层设置合并、4 层成本追踪。这些数字背后是一个完整的功能生命周期管理管线——从编译期裁剪到运行时灰度，再到用量审计。

**[00:35]**

55 分钟走过两条管线：功能可用性 → 用量追踪 → 成本计算 → 数据持久化 → 分析可视化。每条线都直接引用源码——不是文档，文档往往落后于代码。开始。

---

## 👉 Slide 2 — Source Map

**[02:30]**

核心源码地图，按依赖序排列：

`src/constants/betas.ts`（~120 行）——所有 beta header 的单一来源。日期后缀 `20250219` 这种格式确保每次 API 行为变化都有可追溯的版本锚点。

`src/utils/betas.ts`（~400 行）——Beta 合并、GrowthBook 初始化、5 层缓存。本章重点文件。

`src/utils/settings/settings.ts`（~600 行）——5 层设置合并、drop-in 目录支持、Zod v4 校验管线。

`src/utils/stats.ts`（~300 行）——本地统计、heatmap 计算、streak 管理。全离线，不走远程。

`src/utils/usage.ts`（~200 行）——API 调用用量解析、cost 计算、model 映射。

`src/setup.ts`（~500 行）——10 步启动流程，每步按依赖序排列。

依赖链：betas → settings → setup → stats/usage。功能门控先于设置加载，设置决定用户类型，用户类型影响 beta headers，beta headers 影响 feature() 返回值。

---

## 👉 Slide 3 — feature(): 编译时门控

**[05:00]**

`feature()` 是整个代码库中最高频使用的函数。962 次调用、213+ 文件。但它的实现对外部用户来说就是 `return false`。

**[05:20]**

```typescript
// src/constants/system.ts (external builds shim)
export function feature(name: string): boolean { return false }
// Internal builds: connects to GrowthBook
```

外部构建中，它是一个纯函数且返回值静态已知为 false。Bundler (esbuild/Bun) 做三件事：

1. **内联**：`feature('VOICE_MODE')` 被替换为字面量 `false`
2. **消除**：`if (false) { require('./heavy-module') }` 整个 require 分支消失
3. **剪枝**：被消除的 require 目标模块也不进入最终 bundle

**[06:00]**

**类比**：这就像 Rust 的 `#[cfg(feature = "...")]` 编译期条件编译——Rust 在语法层面支持，JS 靠 bundler 的静态分析。效果相同，路径不同。

**为什么不用 `process.env.X`？** 因为 `process.env` 是运行时对象属性查找，bundler 不一定能静态分析其值。`feature()` 是纯函数，返回值**编译期可确定性内联**。编译期确定性 > 运行时灵活性。

---

## 👉 Slide 4 — GrowthBook: 5 级缓存

**[07:30]**

（指向管线图）

5 级缓存，高优先级覆盖低优先级，延迟逐级递增：

| 级别 | 来源 | 延迟 | 刷新频率 |
|------|------|------|---------|
| 1 | 环境变量 | 0ms | 进程重启 |
| 2 | 配置文件 | <1ms | 文件变更 |
| 3 | 内存缓存 | <1ms | 每次 API 调用后 |
| 4 | 磁盘缓存 | ~5ms | 后台定期写入 |
| 5 | 远程 API | 100-500ms | 后台定期拉取 |

**[08:15]**

**类比**：就像 CPU 的 L1→L2→L3→RAM→Disk 缓存层次。CLI 启动时间极度敏感——如果每次启动都等 API 返回，加 100-500ms 延迟对命令行工具不可接受。磁盘缓存保证离线可用。

**[08:40]**

关键实现（`betas.ts`）：

```typescript
// 5s init timeout — never block startup
await Promise.race([
  gb.loadFeatures(),
  new Promise(r => setTimeout(r, 5000))
]);
// On timeout → use disk cache → fallback to defaults
```

5 秒超时是工程取舍：宁可接受旧数据也不阻塞用户输入 `claude` 后的首屏体验。

---

## 👉 Slide 5 — Gates List: 12+ Feature Flags

**[11:00]**

（指向 gates 列表）

`REPL.tsx` 中有 56 处 `feature()` 调用——UI 中枢需要根据 feature 组合呈现不同界面。

**[11:15]**

几个关键 flag 的工程含义：

**VOICE_MODE** — 条件性 `require('../hooks/useVoiceIntegration.js')`。如果 flag 为 false，整个语音模块不在 bundle 中。这不是懒加载——是彻底不存在。

**COORDINATOR_MODE** — 多 agent 协调器的编译期开关。外部构建完全不含协调器代码。

**KAIROS** — Brief 模式的 gate。影响 Spinner、StatusLine 等多个组件。

**COMPUTER_USE** — 计算机使用能力的 gate。涉及 tool 注册和 wrapper。

**AGENT_SWARMS** — Agent 群组的 gate。影响权限系统的行为。

**[12:00]**

每个 flag 在 REPL 中不是孤立的——一个用户可能同时触发 VOICE_MODE + KAIROS + COMPUTER_USE 三个 flag，导致 UI 呈现完全不同的功能面貌。这比单一的 "beta 版本" 设计更灵活，但也增加了测试矩阵的复杂度。

---

## 👉 Slide 6 — RuntimeGates: 两阶段门控

**[13:45]**

```typescript
// compile-time filter → runtime check
const briefEnvEnabled = feature('KAIROS') || feature('KAIROS_BRIEF')
  ? useMemo(() => isEnvTruthy(process.env.CLAUDE_CODE_BRIEF), [])
  : false;
```

**[14:05]**

两个阶段，两个职责：

**编译期**：`feature()` — 粗粒度 DCE，控制 bundle size。如果编译期 flag 为 false，整个运行时检查代码都不存在。

**运行时**：`isEnvTruthy()` / `getFeatureValue_CACHED_MAY_BE_STALE()` — 细粒度用户控制。即使代码存在于 bundle 中，用户也可以通过环境变量覆盖默认行为。

**类比**：像 Android 的 `BuildConfig.DEBUG` + `SharedPreferences`。前者决定哪些代码在 APK 中，后者决定运行时行为。两个层面解决不同维度的问题。

**[14:40]**

为什么需要两阶段？因为有些功能需要编译期和运行时双重控制：编译期决定功能是否存在（减少无关代码），运行期决定功能是否启用（用户自由选择）。

---

## 👉 Slide 7 — UserType: Internal vs External

**[16:30]**

```typescript
export const CLI_INTERNAL_BETA_HEADER =
  process.env.USER_TYPE === 'ant' ? 'cli-internal-2026-02-09' : ''
```

**[16:50]**

`USER_TYPE` 是**运行时值**（同一二进制可被不同用户类型使用），`feature()` 是**编译时值**（构建确定）。两者的分界必须清晰：beta header 需要在运行时根据 actual user 决定，所以用环境变量；feature() 在编译期决定哪些代码存在。

**[17:15]**

一个实际例子：

```typescript
// "external" === 'ant' → 永远 false → 整个 require 被 DCE
const useFrustrationDetection = "external" === 'ant'
  ? require('...').useFrustrationDetection
  : () => ({ state: 'closed' });
```

当 `"external" === 'ant'` 比较永远为 false 时（外部构建），bundler 消除 `require`，整个 frustration detection hook 不在输出中。替代它的只是一个返回空状态的函数——零运行时开销。

---

## 👉 Slide 8 — Betas: API Versioning via Headers

**[19:15]**

18+ 个 beta headers，命名模式 `功能名-日期`，随每次 API 调用发送：

```
claude-code-20250219, interleaved-thinking-2025-05-14,
context-1m-2025-08-07, structured-outputs-2025-12-15,
fast-mode-2026-02-01, token-efficient-tools-2026-03-28
```

**[19:40]**

**类比**：就像浏览器的 Feature Policy headers——客户端声明支持的能力，服务端启用对应功能。但方向相反：浏览器是服务端下发策略，beta headers 是客户端声明能力。

**为什么用 Header 而不是 Query Param？** Header 是 HTTP 语义的一部分——元数据，不影响资源标识。Query Param 会影响缓存 key。API 响应不应因 beta 版本不同而返回不同内容（那是 feature flag 的事情），但请求头需要告知服务端当前客户端的能力集。

**日期后缀的意义**：服务端可以根据日期判断客户端 SDK 的构建时间。如果某个 API endpoint 只支持 2025-08-07 之后的行为，但客户端发的是 2025-02-19 的 header，服务端可以选择优雅降级或返回兼容响应。

---

## 👉 Slide 9 — BetaMerge: 平台适配

**[21:00]**

不同 API provider 对 beta headers 处理不同：

```typescript
// Bedrock: 仅 3 个 headers 允许，部分需 extraBodyParams
BEDROCK_EXTRA_PARAMS_HEADERS = Set{interleaved, context-1m, tool-search-3p}
// Vertex: countTokens 仅接受白名单的 betas
VERTEX_COUNT_TOKENS_ALLOWED_BETAS = Set{claude-code, interleaved, context-mgmt}
```

**[21:30]**

**三层差异化**：

1. **Bedrock 限制 header 数量**——只有 3 个 beta 可以透传，其余需要通过 HTTP request body 中的 `extraBodyParams` 传递。AWS 的 API Gateway 有自己的 header 白名单。

2. **Vertex countTokens 需要白名单**——Google 的 `countTokens` API 不接受任意 beta headers，必须在白名单内的才发送。

3. **部分 beta 受 feature flag 条件控制**——空字符串 = 禁用，不发 header。

**类比**：就像写跨平台代码——iOS、Android、Web 各自的 quirks 需要独立处理。这里跨的是 Anthropic 自家的不同 API provider（Direct API vs AWS Bedrock vs GCP Vertex），每一个都有自己的"脾气"。

---

## 👉 Slide 10 — Settings: 5 层合并

**[24:45]**

| 层级 | 来源 | 修改者 | 生命周期 |
|------|------|--------|---------|
| 1 | Default values | 开发者 | 编译期 |
| 2 | Managed (MDM) | IT 管理员 | 部署时 |
| 3 | Global (~/.claude) | 用户 | 持久化 |
| 4 | Project (.claude/) | 项目维护者 | 随 repo |
| 5 | Flag/Inline | 当次会话 | 临时 |

**[25:30]**

Managed Settings 支持 **drop-in 目录**（类似 systemd `.d/`）——多团队独立提交策略片段，按字母排序，后写覆盖先写。这是一个企业级设计：大公司可以通过 MDM 推送统一配置，项目级配置在此基础上叠加个性化设置。

合并用 `lodash.mergeWith`——深度合并，数组替换不拼接。这意味着 `{tools: ['a']}` 和 `{tools: ['b']}` 合并后是 `{tools: ['b']}`（高优层覆盖低优层），不是 `{tools: ['a','b']}`。

**类比**：CSS cascade。多层样式表，高优先级覆盖低优先级。但设置合并只有一层——没有 `!important`，只有层级顺序。

---

## 👉 Slide 11 — SettingsType: Zod v4 Schema

**[27:30]**

```typescript
export const PermissionsSchema = lazySchema(() =>
  z.object({
    defaultMode: z.enum(
      feature('TRANSCRIPT_CLASSIFIER') ? PERMISSION_MODES : EXTERNAL_PERMISSION_MODES
    ).optional(),
    ...(feature('TRANSCRIPT_CLASSIFIER') ? { disableAutoMode: z.enum(['disable']).optional() } : {}),
  }).passthrough()
)
```

**[28:00]**

三个工程细节值得细说：

1. **`lazySchema()` 避免循环依赖**——Schema 定义可能引用自身或其他 schema，惰性初始化打破循环。

2. **`feature()` 在 schema 中**——schema 本身随构建目标变化。内部构建有 5 种权限模式，外部构建只有 3 种。

3. **`.passthrough()` 允许未知字段**——向前兼容。如果 `.claude/settings.json` 包含当前版本不认识的字段，验证仍然通过（忽略未知字段而非报错）。这是版本演进的基本实践。

---

## 👉 Slide 12 — Setup: 10 步启动

**[30:15]**

| 步骤 | 操作 | 关键依赖 |
|------|------|---------|
| 1-2 | Node 版本 + CWD | `setOriginalCwd()` |
| 3-5 | Session + Git root + Project root | 权限依赖项目路径 |
| 6 | Permissions init | `permissionMode` processing |
| 7-8 | Worktree + Hooks 快照 | session 隔离 |
| 9-10 | File watcher + Background tasks | `checkForReleaseNotes()` |

**[31:00]**

**步骤严格有序**——Git root 必须在 project root 前检测（因为 `.git` 是项目根的标志），project root 必须在权限初始化前设置（因为 `.claude/` 目录在项目根下）。任何一步失败，CLI 立即退出——fail fast 优于 graceful degradation。

**类比**：飞机起飞检查单。顺序不可颠倒，每步完成后才能继续下一步。`setup()` 就像飞行员在跑道上逐项检查。

**为什么不在后台异步加载配置？** 因为配置是后续所有步骤的基础依赖——没有配置，权限初始化、worktree 检测、hooks 快照都无法正确执行。同步加载确保确定性。

---

## 👉 Slide 13 — CostCalc: 12 档定价

**[33:00]**

| 模型 | 输入 ($/MTok) | 输出 ($/MTok) |
|------|---------------|---------------|
| Haiku 3.5 | $0.80 | $4.00 |
| Sonnet 4 | $3.00 | $15.00 |
| Opus 4 | $15.00 | $75.00 |
| Opus 4 Fast | $30.00 | $150.00 |
| Haiku (cached) | **$0.08** | $4.00 |

**[33:30]**

**Prompt Caching 90% 折扣是经济学原因**——为什么系统积极使用 cache。cache_read 比 cache_creation 便宜 10 倍，这直接影响了 compaction 策略：保留更多 cache 友好的上下文比重新压缩更省钱。

Fast 模式是 2 倍溢价——同样的 Opus 4 模型，更快的响应速度意味着更高的资源占用。这不是性能差异，是资源隔离成本。

**类比**：出租车 vs 专车。同样的目的地，不同的价格——因为你买的不是距离，是服务质量保证。

---

## 👉 Slide 14 — CostState: 6 维度追踪

**[35:45]**

成本状态包含 6 维度：
`totalInputTokens`, `totalOutputTokens`, `totalAPIDuration`, `totalDuration`, `linesAdded/Removed`, `totalCost`

**[36:00]**

直接从内存累加器读取，不走 React 状态——避免高频 API 调用下的过多 re-render。每次 API 调用后 `accumulateUsage()` 更新总用量（`usage.ts`），UI 轮询读取当前值。

CostThresholdDialog 是安全阀——累计成本达阈值时弹出确认对话框。不是所有用户都知道 Opus 4 的输出价格是 Haiku 的 37.5 倍。

---

## 👉 Slide 15 — CostSubagent: 递归成本归因

**[38:30]**

多 agent 场景下，所有子 agent 成本**递归累加到 session 总额**。

**[38:50]**

`TASK_BUDGETS` (beta: `task-budgets-2026-03-13`) 提供可选的细粒度控制——给子任务设 token 预算上限，超预算则终止子 agent。

**类比**：session-level 归属 = AWS 按 "项目" tag 汇总成本，task-budgets = 给每个 "服务" 设预算告警。前者看花了多少，后者控制不超花。

---

## 👉 Slide 16 — CostPersist: 持久化 & 阈值

**[41:15]**

`saveCurrentSessionCosts()` → disk JSON，`getStoredSessionCosts()` → `--resume` 恢复。

**[41:30]**

跨会话持久化的意义：`--resume` 时恢复之前的成本计数器，用户可以看到历史总成本。`CostThresholdDialog` 是安全阀——累计成本达阈值时弹出确认，防止用户在不知不觉中烧钱。

**类比**：circuit breaker 保护的是错误，CostThresholdDialog 保护的是钱包。

---

## 👉 Slide 17 — Stats: 本地 Gamification

**[44:00]**

```typescript
type ClaudeCodeStats = {
  streaks: StreakInfo,              // 连续使用天数
  dailyActivity: DailyActivity[],   // GitHub-style heatmap
  modelUsage: {[model]: ModelUsage}, // 按模型拆分用量
}
```

**[44:20]**

基于 JSONL transcript 文件本地统计，不走远程 DB。`statsCache` 增量计算——文件级锁 `withStatsCacheLock` 防多实例写冲突。

**类比**：GitHub contribution graph——但追踪的是代码交互而非代码提交。Streak 机制利用行为心理学（loss aversion：用户不想断掉连续记录）。

---

## 👉 Slide 18 — Analytics: OTEL Tracing

**[46:45]**

每用户交互 = 一个 Span（持续时间 + Token 用量 + 工具链 + 错误信息）。

**[47:00]**

选择 tracing 而非 metrics——保留因果关系（A 导致了 B），而 metrics 只保留统计量。Perfetto 格式可导出为 Chrome Tracing，用 `chrome://tracing` 可视化完整的用户交互时间线。

**类比**：metrics 是"本月用了多少电"，tracing 是"每个电器开了多久"——前者告诉你总量，后者告诉你原因。

---

## 👉 Slide 19 — 常量速查

**[49:30]**

快速过关键常量：

- `DEFAULT_MAX_RETRIES` — 最大重试次数
- `FAST_MODE_COOLDOWN = 10min min / 30min default` — Fast Mode 冷却
- `BATCH_FLUSH_INTERVAL = 100ms` — 统计批量刷写
- `GROWTHBOOK_INIT_TIMEOUT = 5000ms` — GrowthBook 初始化超时

每个数字背后都有具体的工程权衡。

---

## 👉 Slide 20 — 总结

**[51:00]**

| 子系统 | 核心模式 | 数字 |
|--------|---------|------|
| Feature Gate | Compile DCE + Runtime GrowthBook | 962 calls, 5 layers |
| Beta Headers | API versioning by client declaration | 18+ headers |
| Settings | Progressive override (5 layers) | drop-in .d/ |
| Cost | Session-level counter + recursive attribution | 12 tiers |
| Stats | Local JSONL + incremental cache | heatmap + streaks |

**[52:00]**

五个核心论点：

**Feature Gate 分层**——编译期管 bundle size，运行期管灰度发布。`feature()` 不是简单的 if-else，是编译期确定性 + 运行时灵活性的双层设计。

**Beta Headers 声明式**——客户端声明能力，服务端按需启用。方向与浏览器 Feature Policy 相反，但理念相同：让服务端知道客户端能做什么。

**Settings 渐进覆盖**——个人用户只需 1 层，企业可用 5 层。Managed + Global + Project + Inline 四层叠加，每层解决不同规模的部署问题。

**Cost 实时计数**——不是事后审计，嵌入每个 API 调用。子 agent 成本递归归因，`--resume` 恢复历史计数器。

**Stats 本地优先**——全部基于 JSONL transcript 离线计算，零网络依赖。OTEL tracing 保留完整的因果链，不只是统计量。

**[54:00]**

这一章的核心信息是：**功能管理和成本控制是同一条管线上的两个阶段**。前者决定"能不能做"，后者决定"做了花多少"。开源项目往往只做前者——因为成本是 SaaS 的问题。但 Claude Code 作为一个有内部和外部双构建目标的产品，需要同时解决两个问题。

---

## 👉 Q&A

**[55:00]**

开放提问。

---

*本章演讲总时长约 55 分钟。*

<!-- 
AUTO-GENERATED SLIDE SYNC REFERENCE
Please ensure your script.md contains the following headers:
Slide 01: cover
Slide 02: Learning Objectives
Slide 2: CHAPTER 10 | FEATURE GATE + COST
Slide 3: CHAPTER 10 | FEATURE GATE + COST
Slide 4: CHAPTER 10 | FEATURE GATE + COST
Slide 5: CHAPTER 10 | FEATURE GATE + COST
Slide 06: Feature Gate Runtime
Slide 7: CHAPTER 10 | FEATURE GATE + COST
Slide 8: CHAPTER 10 | FEATURE GATE + COST
Slide 9: CHAPTER 10 | FEATURE GATE + COST
Slide 10: CHAPTER 10 | FEATURE GATE + COST
Slide 11: CHAPTER 10 | FEATURE GATE + COST
Slide 12: CHAPTER 10 | FEATURE GATE + COST
Slide 13: Cost Calculation Pipeline
Slide 14: CHAPTER 10 | FEATURE GATE + COST
Slide 15: CHAPTER 10 | FEATURE GATE + COST
Slide 16: CHAPTER 10 | FEATURE GATE + COST
Slide 17: CHAPTER 10 | FEATURE GATE + COST
Slide 19: Code Walkthrough
Slide 20: CHAPTER 10 | FEATURE GATES & COST
Slide 18: CHAPTER 10 | FEATURE GATE + COST
Slide 22: Key Terms
Slide 19: CHAPTER 10 | FEATURE GATE + COST
Slide 24: See Also
Slide 25: qa
-->