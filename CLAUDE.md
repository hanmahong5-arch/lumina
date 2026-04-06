# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a bilingual (EN+CN) presentation project that luminas into Claude Code's internal architecture. It produces PowerPoint decks covering 11 chapters (ch00-ch10) of Claude Code internals: core engine, multi-agent orchestration, permission system, token management, tools/MCP, resilience, memory, protocol, UI, and feature cost.

## Key Commands

```bash
# Build a single chapter's PPTX from HTML slides
node build-chapter.js <chapter-dir>
# e.g. node build-chapter.js ch01-core-engine

# Validate all HTML slides across chapters (no PPTX output)
node validate-all.js <chapter-dir1> <chapter-dir2> ...
# e.g. node validate-all.js ch01-core-engine ch02-multi-agent
```

Dependencies: `pptxgenjs`, `playwright`, `sharp` (installed via `npm install`). The build uses `html2pptx.js` from the bundled `pptx-skill` package at `pptx-skill/pptx/scripts/html2pptx.js`.

## Chapter Structure

Each chapter directory (e.g. `ch01-core-engine/`) contains:
- `slides/` — HTML files named `slide-chXX-NN-*.html`, sorted alphabetically to determine PPTX slide order
- `script.md` — bilingual presentation script with source file references and timing
- `diagrams/` — Excalidraw `.excalidraw` source files and rendered `.png` diagrams
- `<chapter-name>.pptx` — generated output (committed)

Total: 260+ slides across 11 chapters (ch00-ch10), 44 Excalidraw diagrams, comparison slides in every chapter, bilingual scripts. Build output: individual chapter PPTX files + merged `claude-code-lumina-complete.pptx`.

## HTML Slide Conventions

- Slides use the V2 "Agent Blueprint" dark theme design system (`design-system/base-style-v2.css`)
- Slide dimensions: 720pt x 405pt (16:9)
- **CRITICAL**: All text must be wrapped in `<p>` or `<li>` tags. Never use `<span>` as a direct `<div>` child — the `html2pptx.js` converter extracts `<div>` elements as empty shapes and ignores child `<span>` elements. This is the #1 cause of invisible diagrams in PPTX output.
- Use `class="fn"` span for inline code references
- Follow the compare-grid, card, pipeline, and metric classes from the design system

## Excalidraw Diagram Workflow

For complex diagrams that HTML/CSS cannot render reliably in PPTX:
1. Use the Excalidraw skill (`/excalidraw-diagram`) to generate `.excalidraw` JSON with the dark theme palette
2. Render to `.png` via the skill's render pipeline
3. Place both `.excalidraw` and `.png` in the chapter's `diagrams/` directory
4. Reference the `.png` in HTML slides via `<img>` tag

See `doc/diagram-workflow.md` for full workflow details.

## Rendering

- Excalidraw diagrams rendered via `render-excalidraw.js` with warm light theme, 2x scale, 3-retry CDN fallback
- `node render-excalidraw.js --batch <dir>` — batch render all diagrams in directory
- `node render-excalidraw.js <file> --dry-run` — preview dimensions without launching browser
- Render cache skips unchanged diagrams (PNG newer than source)

## Build Output

- `build-all.js` — parallel chapter builds with content-hash caching, merged PPTX output
- Individual chapter PPTX files in each `chXX-*/` directory
- `claude-code-lumina-complete.pptx` — merged deck with section dividers

## Dependencies

- `pptxgenjs` — PPTX generation
- `playwright` — headless browser for HTML rendering
- `sharp` — image processing (PNG handling)
- No TypeScript, no framework — plain JS with CommonJS modules
