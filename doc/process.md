# Development Progress / 开发进度

## 2026-04-03: PPTX Diagram Rendering Fix / PPTX 图表渲染修复

### User Requirement / 用户需求
PPTX presentation files have invisible diagrams — complex HTML CSS layouts (spans inside divs) are lost during html2pptx conversion. Need intuitive, visually compelling diagrams that work in PPTX.

### Method / 方法
1. Diagnosed root cause: `html2pptx.js` line 694 extracts `<div>` as empty shape, ignores `<span>` children
2. Evaluated 3 approaches: HTML p-wrapper fix, Excalidraw skill, MCP server
3. Selected `coleam00/excalidraw-diagram-skill` (1.7k stars) — generates `.excalidraw` JSON → renders PNG
4. Installed skill, customized dark theme palette, verified render pipeline

### Changes / 修改内容
- **NEW** `.claude/skills/excalidraw-diagram/` — Excalidraw skill with dark theme palette
- **NEW** `doc/diagram-workflow.md` — Reusable workflow documentation (bilingual)
- **MODIFIED** `ch00-overview-v2/slides/slide-ch00-06-flow-bash.html` — p-wrapper fix (Track A demo)
- **NEW** `ch00-overview-v2/diagrams/flow-a-bash.excalidraw` — Excalidraw source for Flow A
- **NEW** `ch00-overview-v2/diagrams/flow-a-bash.png` — Rendered Flow A diagram

### Result / 结果
- Excalidraw Flow A diagram renders correctly: vertical flow with diamond decision node, 3-tier fan-out, loop arrow
- Dark theme matches presentation design system
- Workflow documented and saved to memory for future reuse
- 40 slides identified for remediation across 11 chapters

### Completed Excalidraw Diagrams (13 total) / 已完成的 Excalidraw 图表
| # | Chapter | Diagram | Pattern |
|---|---------|---------|---------|
| 1 | ch00 | flow-a-bash | Vertical flow + diamond decision + fan-out |
| 2 | ch00 | flows-overview | Hub-and-spoke (4 flows) |
| 3 | ch00 | flow-b-read-edit | Two-phase sequence |
| 4 | ch00 | flow-c-multiagent | Fork-join pattern |
| 5 | ch00 | flow-d-context-overflow | 4-phase waterfall |
| 6 | ch00 | architecture-map | Layered architecture + dependency matrix |
| 7 | ch01 | mainloop-pipeline | 7-step horizontal pipeline + while(true) loop |
| 8 | ch02 | coordinator-workflow | 4-phase horizontal pipeline |
| 9 | ch03 | permission-pipeline | 3-tier vertical flow (Deny→Allow→Ask) |
| 10 | ch03 | bash-speculative | Parallel fork + decision diamond |
| 11 | ch04 | context-collapse | 3-layer projection view |
| 12 | ch04 | post-compact-rebuild | Token budget allocation bar |
| 13 | ch04 | fork-cache-sharing | Parallel message sequence + cache boundary |

### PPTX Rebuilt / 已重建 PPTX
- ch00-overview-v2: 12/12 slides, 2.54 MB ✅
- ch01-core-engine: 22/22 slides, 0.83 MB ✅
- ch02-multi-agent: 22/22 slides, 1.10 MB ✅
- ch03-permission: 20/20 slides, 1.21 MB ✅
- ch04-token-mgmt: 22/22 slides, 1.36 MB ✅

### Bugfix / 修复
- html2pptx.js: Fixed Windows file:// URL path handling (file:///C:/path → /C:/path → C:/path)

### ch05-ch10 Scan Result / ch05-ch10 扫描结果
Deep scan confirmed: ch05-ch10 slides have NO span-in-div issues. All spans are correctly wrapped in `<p>` or `<li>` tags. Initial scan overestimated affected count.

### All PPTX Rebuilt / 全部 PPTX 已重建
| Chapter | Slides | Size | Status |
|---------|--------|------|--------|
| ch00-overview-v2 | 12/12 | 2.54 MB | ✅ 6 Excalidraw diagrams |
| ch01-core-engine | 22/22 | 0.83 MB | ✅ 1 Excalidraw diagram |
| ch02-multi-agent | 22/22 | 1.10 MB | ✅ 1 Excalidraw diagram |
| ch03-permission | 20/20 | 1.21 MB | ✅ 2 Excalidraw diagrams |
| ch04-token-mgmt | 22/22 | 1.36 MB | ✅ 3 Excalidraw diagrams |
| ch05-tools-mcp | 20/20 | 0.65 MB | ✅ No fixes needed |
| ch06-resilience | 20/20 | 0.62 MB | ✅ No fixes needed |
| ch07-memory | 20/20 | 0.69 MB | ✅ No fixes needed |
| ch08-protocol | 22/22 | 0.77 MB | ✅ No fixes needed |
| ch09-ink-ui | 20/20 | 0.68 MB | ✅ No fixes needed |
| ch10-feature-cost | 20/20 | 0.77 MB | ✅ No fixes needed |

**Total: 220 slides across 11 chapters, all building cleanly. 13 Excalidraw diagrams created.**

### Status: COMPLETE / 状态：已完成

---

## 2026-04-03: Learning Objectives Slides / 学习目标幻灯片

### User Requirement / 用户需求
Create 11 "Learning Objectives" HTML slides (one per chapter, ch00-ch10), positioned right after each chapter's cover slide (slide-chXX-01b-objectives.html). Each slide must contain 3-5 specific, measurable objectives extracted from the chapter's script.md, bilingual (EN+CN), with prerequisites referencing earlier chapters.

### Method / 方法
1. Read all 11 script.md files (ch00 derived from existing slides since no script.md exists)
2. Extracted 3-5 concrete, measurable learning objectives per chapter from script content
3. Identified prerequisites by tracing cross-chapter dependencies
4. Applied provided HTML template with bilingual format, prerequisites box, and footer metadata

### Changes / 修改内容
- **NEW** `ch00-overview-v2/slides/slide-ch00-01b-objectives.html` — 4 objectives: LOC coverage mapping, cross-cutting concerns, 4 data flows, top-10 files
- **NEW** `ch01-core-engine/slides/slide-ch01-01b-objectives.html` — 5 objectives: 7-step pipeline, 8 fields + dual-layer state, 7 Continue + 9 Terminal, withhold-recover, AsyncGenerator justification
- **NEW** `ch02-multi-agent/slides/slide-ch02-01b-objectives.html` — 5 objectives: 4 agent types, runAgent() lifecycle, triple isolation, fork cache optimization, Coordinator workflow
- **NEW** `ch03-permission/slides/slide-ch03-01b-objectives.html` — 5 objectives: 3-tier pipeline routing, 5 permission modes, YOLO classifier 2-stage, denial tracking calculation, rule DSL parsing
- **NEW** `ch04-token-mgmt/slides/slide-ch04-01b-objectives.html` — 5 objectives: 4 pressure thresholds, 4-level cascade, 9-section template, micro-compact types, post-compact cleanup chain
- **NEW** `ch05-tools-mcp/slides/slide-ch05-01b-objectives.html` — 5 objectives: 40+ tool catalog + DCE, assembleToolPool sort, 6-stage execution pipeline, MCP 5-layer config, ToolSearch deferred loading
- **NEW** `ch06-resilience/slides/slide-ch06-01b-objectives.html` — 5 objectives: withRetry AsyncGenerator, getRetryDelay formula, model fallback trigger chain, JSONL chain walk, interrupt detection + 4-layer filter
- **NEW** `ch07-memory/slides/slide-ch07-01b-objectives.html` — 5 objectives: 2-layer architecture, 4-type taxonomy + non-derivability, sideQuery pipeline, Fork Agent extraction, LLM-as-retriever argument
- **NEW** `ch08-protocol/slides/slide-ch08-01b-objectives.html` — 5 objectives: v1 vs v2 comparison, v2 session lifecycle, 3-layer dedup, backoff matrix, epoch-based rotation
- **NEW** `ch09-ink-ui/slides/slide-ch09-01b-objectives.html` — 5 objectives: responseLengthRef bypass, streaming data flow, REPL.tsx 5 zones, 4 PromptInput modes, Ink framework comparison
- **NEW** `ch10-feature-cost/slides/slide-ch10-01b-objectives.html` — 5 objectives: feature() DCE demo, GrowthBook 5-level cache, 5-layer settings merge, cost calculation across tiers, 18+ beta headers

### Result / 结果
- 11 learning objectives slides created, one per chapter (ch00-ch10)
- Total of 53 specific, measurable learning objectives across all chapters
- All objectives are bilingual (English + Chinese on same line)
- Prerequisites reference earlier chapters where applicable
- Duration and slide count match each chapter's script header
- All text properly wrapped in `<p>` tags, no `<span>` as direct div children

### Status: COMPLETE / 状态：已完成

---

## 2026-04-03: Glossary Official Definitions Update / 术语表官方定义更新

### User Requirement / 用户需求
Update the glossary with official definitions sourced directly from each framework's own documentation, not generic explanations. Cover terms from Anthropic/Claude docs, LangChain docs, MCP spec, OpenAI docs, and general AI/ML sources.

### Method / 方法
1. Fetched official documentation pages from each source (Anthropic platform.claude.com, LangChain docs.langchain.com, modelcontextprotocol.io, platform.openai.com, arxiv.org, reactive-streams.org, OWASP genai.owasp.org, microservices.io)
2. Extracted verbatim or near-verbatim definitions from each source
3. Added source URLs as clickable references for every updated term
4. Preserved existing bilingual format and analogies, enhancing where appropriate

### Changes / 修改内容
- **MODIFIED** `doc/glossary.md` -- Updated 20+ terms with official definitions and source URLs:
  - Anthropic (9 terms): tool_use, stop_reason, streaming, context window, prompt caching, system prompt, extended thinking, max_tokens, token counting
  - LangChain (6 terms): Agent, Tool, Chain/LCEL, AgentExecutor, Human-in-the-Loop, Middleware/Callbacks
  - MCP (4 terms): MCP, MCP Server, MCP Tool, Resource
  - OpenAI (3 terms): Function calling, Structured outputs, Assistants API
  - General (3 terms): Chain-of-Thought (CoT), Prompt injection (OWASP), Circuit breaker, Fan-out/Fan-in, Backpressure

### Result / 结果
- 48 terms across 7 categories, all with authoritative source citations
- Every updated term links to its official documentation page
- Discovered: Anthropic docs migrated from docs.anthropic.com to platform.claude.com (301 redirects)
- Discovered: OpenAI Assistants API deprecated (sunset Aug 26, 2026), replaced by Responses API
- Discovered: LangChain docs migrated from python.langchain.com to docs.langchain.com
- Discovered: stop_reason has 6 values (not 3 as previously listed): end_turn, tool_use, max_tokens, stop_sequence, pause_turn, refusal, model_context_window_exceeded

### Status: COMPLETE / 状态：已完成

---

## 2026-04-03: Industry Comparison Slides / 行业横向对比幻灯片

### User Requirement / 用户需求
Create 4 industry comparison HTML slides for chapters missing them (ch04, ch06, ch07, ch09). Each slide compares Claude Code's approach with competing frameworks using the compare-grid table layout.

### Method / 方法
1. Read existing comparison slide (ch01 slide-ch01-16-vs-langchain.html) as HTML template reference
2. Read all 4 chapter script.md files to extract comparison data and framework details
3. Created slides matching the exact HTML structure: header-bar, table with highlight column, footer with sources
4. Extracted dimensions and data points from script content (e.g., "4-level cascade" from ch04, "AsyncGenerator yield" from ch06)

### Changes / 修改内容
- **NEW** `ch04-token-mgmt/slides/slide-ch04-18c-vs-memgpt.html` — Claude Code vs MemGPT vs LangChain on token/context management (6 dimensions: compression levels, context strategy, cache optimization, recovery, circuit breaker, sub-agent safety)
- **NEW** `ch06-resilience/slides/slide-ch06-17c-vs-langgraph.html` — Claude Code vs LangGraph vs Raw OpenAI SDK on resilience (6 dimensions: retry strategy, circuit breaker, model fallback, session recovery, persistent mode, error classification)
- **NEW** `ch07-memory/slides/slide-ch07-17c-vs-mem0.html` — Claude Code vs Mem0 vs LangChain Memory on memory systems (6 dimensions: memory types, semantic retrieval, isolation, persistence, extraction pipeline, scalability)
- **NEW** `ch09-ink-ui/slides/slide-ch09-17c-vs-terminal-ui.html` — Ink vs Blessed vs Bubbletea vs readline on terminal UI (6 dimensions: rendering model, component system, state management, streaming perf, ecosystem, cross-platform)

### Result / 结果
- 4 comparison slides created, all following the ch01 reference HTML structure exactly
- All text wrapped in `<p>` tags, no `<span>` as direct div children
- Bilingual dimension labels (Chinese + English) in the first column
- Claude Code column highlighted with accent-indigo color
- Each slide has 6 comparison rows with concise 1-2 line descriptions per cell
- Code references use `<span class="fn">` for monospace formatting
- Footer includes source file references

### Status: COMPLETE / 状态：已完成

---

## 2026-04-03: Glossary Slides for All Chapters / 全章节术语幻灯片

### User Requirement / 用户需求
Extract technical terms, add official definitions from Anthropic/LangChain/MCP/OpenAI docs, present as glossary slides to enhance information density, approachability, and explainability.

### Changes / 修改内容
- **NEW** `doc/glossary.md` — 60 core terms, official definitions, source URLs, Chinese analogies
- **NEW** 11 glossary HTML slides across all chapters (compact 2-line card design)
- **REBUILT** all 12 PPTX files (243 total slides, up from 232)

### Status: COMPLETE / 状态：已完成
