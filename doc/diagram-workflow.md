# Diagram Workflow: Excalidraw for Presentation Slides
# 图表工作流：用 Excalidraw 生成演示文稿图表

## Problem Statement / 问题描述

The `html2pptx.js` converter only extracts these HTML elements:
- `<p>`, `<h1>`-`<h6>` → text
- `<div>` with background/border → empty shape (line 694: `text: ''`)
- `<ul>`, `<ol>` → lists
- `<img>` → images

`html2pptx.js` 转换器只能提取以上 HTML 元素。

**Any `<span>` as direct child of `<div>` is completely ignored.** This causes complex flow diagrams, sequence charts, and pipeline visualizations to appear as empty boxes in PPTX output.

**`<div>` 的直接子元素 `<span>` 会被完全忽略。** 导致复杂流程图、序列图、管线可视化在 PPTX 中显示为空框。

---

## Solution: Two-Track Approach / 解决方案：双轨方法

### Track A: Simple Fix (for minor span issues) / 简单修复

Wrap `<span>` content inside `<p>` tags within the `<div>`:

```html
<!-- BEFORE (broken in PPTX) -->
<div class="hseq-bar hl">
  <span class="step-box teal">onSubmit()</span>
  <span class="arr">→</span>
</div>

<!-- AFTER (works in PPTX) -->
<div class="hseq-bar hl">
  <p style="font-size:7.5pt; margin:0;">
    <span style="color:#00D4AA; font-weight:700;">onSubmit()</span>
    <span style="color:#718096;"> → </span>
  </p>
</div>
```

**Trade-off / 权衡**: Loses step-box borders/backgrounds, but text content preserved.
**Use when / 适用场景**: Simple horizontal text flows, inline badges, chip labels.

### Track B: Excalidraw Diagram (for complex visualizations) / Excalidraw 图表

Generate `.excalidraw` JSON → render to PNG → embed as `<img>` in HTML slide → PPTX converts it perfectly.

**Use when / 适用场景**: Flow charts, decision trees, fan-out/convergence patterns, loop structures, multi-tier pipelines, any diagram where visual structure carries meaning.

---

## Excalidraw Workflow / Excalidraw 工作流

### Prerequisites / 前置条件

```
.claude/skills/excalidraw-diagram/
├── SKILL.md                          # Skill definition
└── references/
    ├── color-palette.md              # Dark theme palette (customized)
    ├── element-templates.md          # JSON templates
    ├── json-schema.md                # Element type reference
    ├── render_excalidraw.py          # Playwright renderer
    ├── render_template.html          # Render HTML template
    └── pyproject.toml                # Python dependencies
```

Setup:
```bash
cd .claude/skills/excalidraw-diagram/references
uv sync
uv run playwright install chromium
```

### Step-by-Step Process / 分步流程

#### 1. Analyze the slide content / 分析幻灯片内容
- Read the HTML slide to understand what it shows
- Identify the visual pattern: flow, fan-out, convergence, timeline, tree, cycle, etc.
- Plan the diagram layout: top→bottom for sequences, left→right for pipelines, radial for hubs

#### 2. Design with the color palette / 使用配色设计
Read `references/color-palette.md` for semantic colors:
- Teal (#00D4AA): primary flow, normal operations
- Amber (#FFB84D): warnings, permission checks
- Coral (#FF6B6B): errors, denials
- Green (#48BB78): success, allow
- Purple (#9F7AEA): AI/classifier, special paths
- Indigo (#6C63FF): secondary, loop indicators
- Dark background: #0F0F1A (canvas), #16213E (card fill)

#### 3. Build JSON section by section / 分段构建 JSON
- Create the file with wrapper: `{ "type": "excalidraw", "version": 2, ... }`
- Add one section per edit (don't generate all at once)
- Use descriptive string IDs: `"step1_rect"`, `"arrow_1_2"`, `"tier1_text"`
- Namespace seeds by section: section 1 = 100xxx, section 2 = 200xxx

#### 4. Render & validate loop / 渲染验证循环
```bash
cd .claude/skills/excalidraw-diagram/references
uv run python render_excalidraw.py <path-to-file.excalidraw>
```
Then view the PNG with Read tool. Fix issues. Re-render. Repeat until clean.

#### 5. Embed in HTML slide / 嵌入 HTML 幻灯片
Replace the problematic `<div>` structure with an `<img>` tag:
```html
<img src="../diagrams/flow-a-bash.png"
     style="width:100%; max-height:320pt; object-fit:contain;">
```

#### 6. Rebuild PPTX / 重建 PPTX
```bash
node build-chapter.js ch00-overview-v2
```

---

## Shape Selection Guide / 图形选择指南

| Concept / 概念 | Shape / 图形 | Excalidraw type |
|---|---|---|
| Process step / 处理步骤 | Rectangle with rounded corners | `rectangle` + `roundness: {type: 3}` |
| Decision point / 决策点 | Diamond | `diamond` |
| Start/End / 起止点 | Ellipse | `ellipse` |
| Connection / 连接 | Arrow | `arrow` with `startBinding`/`endBinding` |
| Label / 标签 | Free-floating text (no container) | `text` with `containerId: null` |
| Loop indicator / 循环标记 | Dashed arrow returning to earlier node | `arrow` with `strokeStyle: "dashed"` |
| Inactive/optional step | Dashed border rectangle | `rectangle` with `strokeStyle: "dashed"` |

---

## File Organization / 文件组织

```
ch00-overview-v2/
├── slides/
│   └── slide-ch00-06-flow-bash.html    # HTML slide (references PNG)
├── diagrams/
│   ├── flow-a-bash.excalidraw          # Source (editable)
│   └── flow-a-bash.png                 # Rendered (for PPTX)
└── ch00-overview-v2.pptx               # Final output
```

---

## Affected Slides Inventory / 受影响幻灯片清单

Total: 40 out of 190 slides (21%)

| Chapter | Affected Count | Primary Pattern |
|---------|---------------|-----------------|
| ch00-overview / ch00-overview-v2 | 6+6 | hseq-bar, flow-card, fork |
| ch01-core-engine | 2 | pipeline, hseq-bar |
| ch02-multi-agent | 2 | timeline, workflow |
| ch03-permission | 6 | pipeline, classifier flow |
| ch04-token-mgmt | 4 | cascade, recovery flow |
| ch05-tools-mcp | 4 | assembly, filter flow |
| ch06-resilience | 2 | retry, recovery |
| ch09-ink-ui | 5 | bootstrap, streaming |
| ch10-feature-cost | 4 | feature flags, analytics |

---

## Quality Checklist / 质量检查清单

- [ ] Dark background (#0F0F1A) matches presentation theme
- [ ] Semantic colors from palette (not arbitrary)
- [ ] Diamond for decision nodes, rectangles for process steps
- [ ] Arrows have proper bindings (startBinding/endBinding)
- [ ] Free-floating labels for non-essential text (no boxes)
- [ ] Loop arrows are dashed with "loop" label
- [ ] Rendered PNG is clear at slide dimensions
- [ ] HTML slide embeds PNG with proper sizing
- [ ] PPTX build passes without errors
