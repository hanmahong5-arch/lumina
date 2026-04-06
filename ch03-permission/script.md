# Chapter 3: Permission System Deep Dive — Presentation Script
## ⏱️ Duration: ~55min | 📑 24 Slides | 📝 ~8,500字

### 🔍 Core Source Files
* `src/utils/permissions/permissions.ts` → `getAllowRules()`, `getDenyRules()`, `toolMatchesRule()`: Permission rule matching pipeline
* `src/utils/permissions/yoloClassifier.ts` → `classifyYoloAction()`, `buildTranscriptEntries()`: Auto-mode AI classifier
* `src/utils/permissions/denialTracking.ts` → `DENIAL_LIMITS`, `shouldFallbackToPrompting()`: Denial tracking and fallback
* `src/utils/permissions/PermissionMode.ts` → `PERMISSION_MODE_CONFIG`: Permission mode definitions
* `src/tools/BashTool/bashPermissions.ts` → `bashToolHasPermission()`: Bash-specific permission logic
* `src/utils/permissions/permissionRuleParser.ts` → `permissionRuleValueFromString()`: Rule DSL parser

---

### [00:00] 🎤 Opening (Slide 1)

权限系统不是一个 if-else，而是一个三级分类管线。

它的核心问题很直接：当 LLM 代理的行为空间无限时，如何在尽可能少打扰用户的前提下做出正确的允许/拒绝决策？

源码分布在 `src/utils/permissions/` 和 `src/tools/BashTool/`，超过三千行。贯穿一切的原则是：**当系统不确定该怎么做时，它会选择拒绝而不是放行**。

我今天的路线：从上层的 Permission Mode 快速带过，重点讲三层决策管线的每一级实现细节、两条 fast path、规则 DSL 的设计，最后跨框架对比。开始。

---

### [02:45] 👉 Slide 2: Source Map

六张牌，先对齐地图。

`permissions.ts` —— 主入口，约 400 行。三件套：`getAllowRules()`、`getDenyRules()`、`getAskRules()`，加上核心匹配函数 `toolMatchesRule()`。所有权限判定最终流经这里。`createPermissionRequestMessage()` 负责在需要人工审批时生成人类可读消息。

`yoloClassifier.ts` —— 自动模式下的 AI 辅助分类器，350+ 行。入口 `classifyYoloAction()`，转录构建器 `buildTranscriptEntries()`。一句话理解：用一个 LLM 审查另一个 LLM 的操作是否安全。关键在于如何保护审查过程本身。

`denialTracking.ts` —— 全文件 45 行，解决一个真实的体验问题：分类器连错三次怎么办？`DENIAL_LIMITS`（连续上限 3、总上限 20）加 `shouldFallbackToPrompting()` 熔断。

`PermissionMode.ts` —— 五种模式，从严格到宽松形成信任光谱。每种模式都有 title、symbol、color 和外部映射名。

`bashPermissions.ts` —— 命令行专属检查流程。最危险的工具，独立一套 AST 解析、子命令拆分、路径约束、语义分析。

`permissionRuleParser.ts` —— 规则 DSL 解析器，把 `"Bash(prefix:git *)"` 变成结构化对象。

数据流自上而下：模式先过滤，规则再匹配，分类器兜底。每层职责清晰，不交叉。

---

### [05:30] 👉 Slide 3: Permission Modes

从 `PermissionMode.ts` 的 `PERMISSION_MODE_CONFIG` 看五种模式的行为语义。

**默认模式**：每次工具调用都需要用户审批。安全起点，`'default'` 映射。

**计划模式**：只读。所有写操作在模式层就被直接拒绝，甚至不进入后续管线。符号是暂停图标。适合代码审查流程——先看 AI 打算做什么，审查通过后再切换。

**接受编辑模式**：自动批准文件编辑，仍然询问命令行指令。符号是双快进。这个区分很精准：文件编辑（创建/修改代码）风险可控，命令行（安装依赖、网络操作）风险高。

**绕过权限模式**：最宽松。注意颜色是错误色——不禁止使用，但确保用户有充分的风险意识。

**不询问模式**：语义不同。不是"绕过"检查，而是"不再弹窗"。被分类器认定为危险的操作会被静默拒绝。适合非交互式场景，比如 CI 流水线。

**设计理由 #1**：五模式不是功能膨胀，而是让用户自己选择风险偏好。安全系统设计里，"尊重选择但确保知情同意"比"强制一种策略"更成熟。

代码层面，`permissionModeTitle()` 映射到可见名称。检查入口先模式判断再进管线，比如计划模式下写操作直接退出，零额外开销。

---

### [08:15] 👉 Slide 4: 3-Tier Pipeline

核心架构：三层决策管线。请求进来，依次过三级——每级要么做出决定，要么放行到下一级。责任链模式。

**第零层**（模式级快筛）：计划模式下写操作直接拒绝；绕过模式直接允许。在三层之前，`permissions.ts` 入口函数先做这一刀。

**第一层：静态规则匹配**。从 `PERMISSION_RULE_SOURCES` 加载规则（设置系统多层配置、命令行参数、运行时命令、会话级别）。匹配由 `toolMatchesRule()` 完成。微秒级，纯内存操作。约 80% 的请求在这层就定论了。

**第二层：AI 分类器**。仅自动模式激活，`feature('TRANSCRIPT_CLASSIFIER')` 门控。关键点——同样是 `rm` 命令，用户说"清理临时文件"和模型自作主张删除源码，分类器能区分，静态规则不能。它在"当前上下文中"判断安全性。

**第三层：用户交互**。`createPermissionRequestMessage()` 生成人类可读的权限请求。最后的安全网。

**设计理由 #2**：三层叠加的逻辑：纯规则覆盖不了无限的命令组合；纯 AI 有判率且依赖网络；纯人工审批效率太低。三层各做自己擅长的事，大部分请求在最快层级解决。

---

### [11:00] 👉 Slide 5: Tier 1 Detail

第一层实现。

`getAllowRules()`（`permissions.ts` 122-132 行）：遍历 `PERMISSION_RULE_SOURCES`，从 `context.alwaysAllowRules[source]` 取字符串数组，`permissionRuleValueFromString()` 延迟解析为结构化对象。`getDenyRules()` 和 `getAskRules()` 结构相同。启动时不解析，只在匹配时解析，省启动开销。

`toolMatchesRule()`（238-269 行）有两个关键设计：

**工具级 vs 内容级分**：规则有内容（如 `Bash(prefix:git *)`）时 `toolMatchesRule()` 返回 false，交给 `getRuleByContentsForTool()` 处理。职责分离。

**MCP 工具三段式命名**：`mcp__服务器名__工具名`。规则写 `mcp__server1` 就能匹配该服务器所有工具（258-268 行）。实用——信任一个服务器，一条规则放行全部，不用逐个配。

**边缘情况 #1**：跳过前缀模式下，MCP 工具显示名 `"Write"` 可能和内建工具冲突。`getToolNameForPermissionCheck()` 确保始终用完整三段式，防止内建工具规则意外放行不受信的 MCP 工具。不做这一步可能有安全漏洞。

**优化**：`filterDeniedAgents()`（325-343 行）把拒绝规则收集到 Set 中做 O(1) 查找，从 O(代理数 * 规则数) 降到 O(代理数 + 规则数)。注释明确标注了这个优化的动机。

---

### [13:45] 👉 Slide 6: Tier 2 Detail

第二层入口 `classifyYoloAction()`（`yoloClassifier.ts`）。

分类器架构：当前对话转录 + 待执行操作 → 独立模型实例 → 判断是否阻止。关键是"独立模型实例"——不是主对话循环的模型，而是一个侧查询，确保判断不被主上下文中的恶意内容污染。

`buildTranscriptEntries()`（302 行起）构建输入时做了一个关键过滤：**只提取工具使用记录，排除助手文本**。注释明说了原因——助手文本是模型生成的，可能被精心设计来影响分类器。

展开这个攻击向量：代码文件里嵌入伪装成注释的恶意指令 → 主模型读取后受其影响 → 如果分类器能看到主模型文本，就间接接触了恶意内容。只传结构化的工具调用（名称+参数），切断这条路径。猜测式执行就像门卫认识常客——熟悉的动作直接放行，可疑的才拦下盘问。

输出通过 `YOLO_CLASSIFIER_TOOL_NAME`（`'classify_result'`）工具调用返回。响应体 `yoloClassifierResponseSchema`（252-258 行）三个字段：`thinking` 推理过程、`shouldBlock` 布尔决定、`reason` 原因。

**设计理由 #3**：为什么用工具调用而非纯文本？工具调用有强制结构化约束，确定性可解析。纯文本要正则匹配，格式一变就解析失败——安全系统中这不可接受。

系统提示模板分内外两套，`isUsingExternalPermissions()`（71 行）决定。`AutoModeRules` 允许自定义允许/软拒绝规则和环境描述。`getDefaultExternalAutoModeRules()` 用 `extractTaggedBullets()` 从模板提取默认值，干净合并。

---

### [16:30] 👉 Slide 7: Tier 3 Detail

第三层：`createPermissionRequestMessage()`（`permissions.ts` 137 行）。工具名称 + 决策原因（区分联合类型）→ 人类可读消息。

每种原因有定制化格式：
- **Classifier**：展示哪个分类器对哪个工具的哪个命令需要审批，附带分类器原因。
- **Hook**：外部钩子阻止。有原因展示原因，没有就说需要审批。
- **Rule**：匹配到询问规则。用 `permissionRuleValueToString()` 转字符串 + `permissionRuleSourceDisplayString()` 展示来源。
- **SubCommandResult**：复合命令中部分子命令需审批（170-177 行）。用 `extractOutputRedirections()` 去掉重定向部分才展示——重定向可能泄露敏感文件路径，且不是命令核心意图。
- **SandboxOverride**：用户试图在沙箱外运行。
- **Mode**：显示模式标题和对该工具的审批要求。
- **AsyncAgent**：异步场景，无法直接展示 UI。

**设计理由 #4**：信息密度直接影响决策质量。只显示"是否允许执行命令行"→ 审批疲劳，用户不假思索点允许。显示具体规则内容和来源→ 知情同意。安全领域核心 UX 原则。

---

### [19:15] 👉 Slide 8: YOLO Overview

分类器是一个"用 AI 审查 AI"的系统。哲学问题：谁审查审查者？

答案：分类器目标不是 100% 准确率，而是**在默认拒绝前提下最大化通过率**。误拒降低效率，漏放降低安全性。选择宁可误拒不可忽视，再用拒绝追踪管理误拒带来的体验问题。

分类器分两个阶段——灵感来自认知心理学双过程理论：快速直觉判断 vs 慢速理性分析。大部分调用要么明显安全要么明显危险，只需要第一阶段。只有模糊情况才进第二阶段。

输入三部分：系统提示（`BASE_PROMPT` + 权限模板）、对话转录（`buildTranscriptEntries()`）、当前操作（`formatActionForClassifier()`）。

输出三字段：`thinking` 强制先想再做，类似 Chain-of-Thought，研究显示减少 30%+ 判断错误；`shouldBlock` 布尔值；`reason`。

---

### [22:00] 👉 Slide 9: Stage 1 Fast

第一阶段快速判定。

思路直观：明显安全或明显危险的操作不需要深度分析。用轻量级模型调用，上下文比第二阶段少（最近几条消息 + 当前操作）。

三结果：允许、阻止、不确定（交给第二阶段）。

`formatActionForClassifier()` 格式化：命令行包含完整命令文本，文件操作包含路径和操作类型。目标——提供足够判断信息，同时不包含无关噪声。

可靠性：`CLASSIFIER_FAIL_CLOSED_REFRESH_MS = 30min`（`permissions.ts` 107 行）。分类器连续出错 30 分钟后刷新状态。这 30 分钟内所有操作回退到人工审批。30 分钟覆盖大部分临时故障恢复周期，又不会太频繁重试已出问题的服务。

**边缘情况 #2**：分类器网络调用失败时，默认拒绝。`buildClassifierUnavailableMessage()` 通知用户。组件故障不应扩大攻击面——安全系统铁律。

---

### [24:45] 👉 Slide 10: Stage 2 Thinking

第二阶段深度思考，专门处理第一阶段不确定的情况。

关键区别：使用完整对话转录。这让分类器能理解操作的上下文——用户的原始意图、助手之前的行为、当前操作是否一致。

例子：`rm -rf /tmp/build-output`，没有上下文是危险删除；上下文显示用户五分钟前说"清理构建产物"，就完全合理。

`buildTranscriptEntries()`（302 行）的过滤逻辑：
- 用户消息：提取所有文本块和附件提示文本。
- 助手消息：只提取工具使用块，**不提取文本块**。原因已在前面的幻灯片讲过。技术细节补充：工具块参数格式确定性；文本块可能包含任意自然语言中的间接注入指令。

`maybeDumpAutoMode()`（153 行）：设环境变量后把请求/响应转储到临时目录，按时间戳命名。强大调试工具。

`dumpErrorTokens()`：出错时记录主循环 token 数、分类器字符数、分类器估计 token 数、转录条目数等。差值大的时候通常意味着分类器上下文投影算法偏差。

---

### [27:30] 👉 Slide 11: 3 Fast Paths

三层管线之外，三条快速路径可直接做出决定。

**快速路径一：沙箱模式**。`shouldUseSandbox()` 检测沙箱环境。沙箱内的操作再危险也只影响沙箱内部。学习和实验场景中价值巨大——放心测试激进操作。

**快速路径二：受保护命名空间**。`isInProtectedNamespace()` 检测系统关键目录、密钥存储位置等。硬编码安全边界，无论规则怎么配一律特殊处理。"宁可过度保护"。

**快速路径三：权限钩子**。`executePermissionRequestHooks()` 允许外部钩子注入自定义逻辑，返回允许/拒绝/放行。企业级扩展点——金融公司内部安全审查系统可以作为钩子挂载。

三条路径优先级高于普通管线，检查成本极低（布尔判断或字符串匹配），但覆盖大量常见场景。

**设计理由 #5**：快速路径是权限系统的 TTB（Translation Lookaside Buffer）——常见情况走缓存（快速路径），未命中才走完整页表查询（三层管线）。经典"常见情况快速处理"模式。

---

### [30:15] 👉 Slide 12: Denial Tracking

`denialTracking.ts`，45 行代码，解决真实的体验问题。

`DenialTrackingState`：两个字段，连续拒绝计数和总拒绝计数。

`DENIAL_LIMITS`：连续上限 3 次，总上限 20 次。

`recordDenial()` 同时递增两个计数器。`recordSuccess()` 只重置连续计数器——32 行有个微优化：连续计数已经是 0 时直接返回，避免创建新对象。高频场景减少 GC 压力。

`shouldFallbackToPrompting()`：连续 3 次或总计 20 次 → 从自动分类降级到人工审批。

为什么需要？场景：助手尝试执行操作 → 分类器误判拒绝 → 助手换方式再试 → 又被拒绝 → 循环无限。有了拒绝追踪，连续 3 次后自动降级弹出审批窗口，用户看到具体内容后可以选择允许，打破循环。

数学特性：连续上限 3 意味着分类器连续犯错 3 次就触发熔断——说明存在系统性偏差，继续判断是浪费时间。总上限 20 意味着一个会话中误拒预算约 20 次（对应 5-10% 误拒率），超过就整体降级。

---

### [33:00] 👉 Slide 13: Rule DSL

权限规则语法：`工具名(内容)`，由 `permissionRuleValueFromString()` 解析。

常见写法：
- `"Bash"` —— 匹配工具所有操作。
- `"Bash(prefix:git *)"` —— 前缀匹配。
- `"mcp__server1"` —— MCP 服务器级匹配，放行该服务器全部工具。
- `"mcp__server1__*"` —— 显式通配符，效果同上。
- `"Agent(Explore)"` —— 匹配特定代理类型。

解析结果 `PermissionRuleValue`：工具名 + 可选规则内容。

`PERMISSION_RULE_SOURCES`（`permissions.ts` 109-114 行）多来源：设置系统多层配置、命令行参数、运行时命令、会话级。高层覆盖低层。

**优先级：拒绝覆盖允许**。同时匹配允许和拒绝规则时拒绝胜出。经典安全原则。实践意义：先设宽松允许规则，再用具体拒绝规则排除特定危险操作。

Bash 前缀匹配：`parsePermissionRule()` + `sharedMatchWildcardPattern()` 实现通配符匹配。比精确匹配灵活，比正则安全（无灾难性回溯）。

**边缘情况 #3**：MCP 工具名称冲突，`getToolNameForPermissionCheck()` 用完整限定名消除歧义。

`getRuleByContentsForTool()`（349 行）把特定工具的所有规则预组织成内容 → 映射表。常数时间查找，企业场景显著优化。

---

### [35:45] 👉 Slide 14: Bash Speculative

命令行工具独特机制：推测性检查。

通过 `clearSpeculativeChecks()` 暴露。核心思路：执行前预先检查所有子命令权限状态。

解决的问题：`git add . && git commit -m "fix" && git push`——三个子命令。如果只执行到 push 才发现需要审批，add 和 commit 已执行完了。用户拒绝 push 后处于尴尬状态。

实现：AST 解析器 `parseForSecurityFromAst` + 语义检查器 `checkSemantics` + 路径约束 `checkPathConstraints` + sed 约束 `checkSedConstraints`。

**CC-643**（96-100 行注释）：复合命令的拆分函数在极端情况下可能产生指数级子命令数组，前端冻结。硬上限 50 个子命令。正常使用很少超过 10 个。

部分子命令需审批时，精确列出哪些子需要审批，而非一刀切整个命令。用户看到"五个子操作，第三和第五需要批准"，信息透明且决策质量更高。

---

### [38:30] 👉 Slide 15: Safety Immunity

安全免疫——某些检查即使用户选了最宽松模式也生效。

`type: 'safetyCheck'` 决策原因（`permissions.ts` 196 行），消息直接使用原始原因文本，不加修饰。安全警告应该最直接。

核心理念：**安全不是可以配置关闭的特性，而是不可协商的基线**。绕过模式下仍触发：系统关键文件修改、不可逆数据丢失命令、外发可能含敏感信息的数据。

`bashPermissions.ts` 中 `checkSemantics` AST 级语义检查不受权限模式影响——分析命令实际上做什么，而不只是看字面文本。通过管道/重定向间接发送数据的操作，字面是本地文件操作，语义分析能识别。

`SandboxManager` 的角色：操作系统级别物理隔离。即使所有软件层权限绕过，沙箱仍限制影响范围。深度防御经典——不依赖单一机制。

`AUTO_REJECT_MESSAGE` 和 `DONT_ASK_REJECT_MESSAGE`（`messages.ts` 导入）：自动拒绝和不询问模式下的静默消息。被安全拦截的操作仍有清晰日志记录。

---

### [41:15] 👉 Slide 16: vs LangChain / OpenAI

**权限粒度**：本系统支持工具级 + 内容级 + 服务器级。某些框架只有工具级（要么全放行要么全拒绝）。某些平台连工具级都没有，自动执行。

**自动化程度**：本系统三层（静态规则 + AI 分类器 + 人工审批）。纯人工框架每个操作都需确认，实际中用户会因烦躁关掉。

**失败模式**：本系统默认拒绝 + 拒绝追踪降级。分类器不可用 → 回退到人工审批。某些框架出错时行为取决于配置，可能安全也可能不安全。某些平台跳过权限检查继续执行——最不安全。

**代码编辑器扩展模型**：工作区信任 + 能力声明，类似模式 + 规则设计。但没有动态分类器——信任是"全有或全无"。

本系统独特之处：多层缓存保证效率，默认拒绝保证安全，AI 分类器在两者之间建桥梁。

---

### [44:00] 👉 Slide 17: 5 Patterns

**模式一：分层决策管线**。静态规则 → AI 判断 → 人工审批。适用于任何"既快又安全"的审查，如内容审核：关键词过滤 → ML 分类器 → 人工审核员。

**模式二：拒绝追踪 + 自动降级**。计数器检测系统性问题，自动补救。接口限流可降级缓存、服务发现可切备用节点、特性开关可自动关闭新特性。

**模式三：转录过滤防注入**。只传确定性结构化输入给审查者，排除可能被操纵的自由文本。任何"AI 审查 AI"场景都适用。

**模式四：规则 DSL + 多源优先级**。类似 CSS 优先级：全局 → 项目 → 运行时。拒绝规则始终有最终话语权。

**模式五：快速路径 + 完整路径**。低成本检查覆盖高频场景。从 CPU 分支预测到数据库查询优化器，思想一致。

---

### [46:45] 👉 Slide 18: Constants

`CLASSIFIER_FAIL_CLOSED_REFRESH_MS = 30min`（`permissions.ts` 107 行）。30 分钟覆盖临时故障恢复，又不会频繁重试。

`DENIAL_LIMITS.maxConsecutive = 3`（`denialTracking.ts` 13 行）。1 太敏感，5 等太久，3 是平衡点——快速检测系统性问题，容忍偶发误判。

`DENIAL_LIMITS.maxTotal = 20`（`denialTracking.ts` 14 行）。会话生命周期误拒预算。约 5-10% 误拒率，超过就降级。

`PERMISSION_RULE_SOURCES` 数组（`permissions.ts` 109 行）。顺序隐含优先级。

`YOLO_CLASSIFIER_TOOL_NAME = 'classify_result'`（`yoloClassifier.ts` 260 行）。命名暗示角色定位：产出分类结果，不直接做权限决定。决定权在调用者手中——可以选择尊重或覆盖。

每个常量背后都有工程分析。修改任何数字都需要理解完整影响链路。

---

### [49:30] 👉 Slide 19: Summary

**架构**：三层决策管线 + 三条快速路径。默认拒绝。

**分类器**：两阶段（快速 + 深度思考）。输入安全过滤（排除助手文本防空注入），输出工具调用结构化约束。推理过程字段利用思维链提升质量。

**可靠性**：拒绝追踪（连续 3 次 + 总计 20 次）精确自动降级。故障 30 分钟刷新。任何组件故障不扩大攻击面。

**扩展性**：DSL 支持工具级/内容级/服务器级。多源配置，拒绝覆盖允许。钩子机制用于企业扩展。

**对比**：自动化程度和安全粒度显著领先。既不像纯人工低效，也不像全自动不安全。

一句话总结：**这个系统用多层冗余和默认拒绝，把"不可信代理的权限控制"问题转化成了"可管理的误拒率优化"问题**。不追求零误拒，接受误拒存在，用拒绝追踪管理影响。高安全性 + 合理自动化。

---

### [52:15] 👉 Slide 20: Q&A

好的，第三章到此。进入问答。

几个值得讨论的方向：

**方向一**：分类器精确率/召回率的量化分析。精确率低 = 频繁误拒影响体验；召回率低 = 安全漏洞。

**方向二**：多代理场景权限传播。子代理应该继承父代理权限吗？`filterDeniedAgents()` 处理了部分场景，更复杂语义值得探讨。

**方向三**：规则 DSL 表达能力边界。当前是"工具名+内容"格式。如果需要条件逻辑（"允许写临时目录但不允许删除其中的文件"）可能需要引入逻辑运算符。

**方向四**：分布式部署的集中式安全策略管理。企业几百人使用时如何统一管理？钩子提供扩展点，但策略分发、版本控制、审计日志都需要考虑。

大家有什么问题请提出。大约三分钟讨论时间。

---

*End of Chapter 3 Script*

<!-- 
AUTO-GENERATED SLIDE SYNC REFERENCE
Please ensure your script.md contains the following headers:
Slide 01: cover
Slide 02: Learning Objectives
Slide 02: Ch.03 Permission &amp; Security
Slide 03: Ch.03 Permission &amp; Security
Slide 04: Permission Pipeline
Slide 05: Ch.03 Permission &amp; Security
Slide 06: Ch.03 Permission &amp; Security
Slide 07: Ch.03 Permission &amp; Security
Slide 08: Ch.03 Permission &amp; Security
Slide 09: Ch.03 Permission &amp; Security
Slide 10: Ch.03 Permission &amp; Security
Slide 11: Ch.03 Permission &amp; Security
Slide 12: Ch.03 Permission &amp; Security
Slide 13: Ch.03 Permission &amp; Security
Slide 15: Ch.03 Permission & Security
Slide 14: Bash Speculative Classification
Slide 15: Ch.03 Permission &amp; Security
Slide 16: Ch.03 Permission &amp; Security
Slide 17: Ch.03 Permission &amp; Security
Slide 18: Ch.03 Permission &amp; Security
Slide 21: Key Terms
Slide 19: Ch.03 Permission &amp; Security
Slide 23: See Also
Slide 24: qa
-->