# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A bilingual (EN+CN) pipeline that turns semantic HTML slides, Excalidraw diagrams, and Markdown scripts into PowerPoint (`.pptx`) decks for source-level "teardowns" of coding agents. There are now **two content trees**:

- **Claude Code teardown** — 11 chapters `ch00`–`ch10` (core engine, multi-agent, permission, token mgmt, tools/MCP, resilience, memory, protocol, Ink UI, feature cost). This is the deck the build pipeline produces.
- **`codex-cli-teardown/`** — a second teardown of OpenAI's Codex CLI, comparing its choices against Claude Code's. Currently **scripts-only** (`script.md` drafts; chapters have no authored slides yet). The pipeline is **multi-project** (see `lumina.config.js` → `projects`): `lumina build --project codex` builds it, and chapters with no slides are skipped gracefully until authored.

## Key Commands

The `lumina` CLI (`src/cli/index.js`, exposed via npm scripts) is the entry point. It is a thin shim — every subcommand shells out to a root-level script that does the real work.

```bash
npm install                 # pptxgenjs, playwright, sharp, express, ws, etc.

npm run build               # build ALL chapters + merged deck   → build-all.js
npm run build:ch01          # build one chapter (ch00..ch10)      → build-chapter.js
npm run build:watch         # watch ch*/**.{html,excalidraw}, rebuild on change
npm run validate            # validate every chapter's HTML       → validate-all.js
npm run cite                # verify script.md citations resolve   → check-citations.js
npm run render -- <dir>     # render .excalidraw → .png           → render-excalidraw.js
npm run studio              # live web preview on :3000           → src/studio/server.js
npm run web                 # build self-contained interactive deck → build-web.js

# Multi-project: every command takes --project <name> (default: config.defaultProject)
lumina build --project codex          # build a different project's deck
lumina build --list                   # dry-run: print the resolved build plan, build nothing
lumina validate --project codex
lumina web --project codex --serve    # interactive web player (self-contained, offline)

# Equivalent direct invocations (what the CLI runs under the hood):
node build-chapter.js ch01-core-engine [--root=<dir>]   # single chapter; --strict = fail-fast
node build-all.js [--project=<name>] [--list] [--force] [--no-parallel] [--concurrency=N]
node validate-all.js [--project=<name>] [ch01-core-engine ...]   # no args = auto-detect ch* dirs
node check-citations.js [--project=<name>]   # verify file:line citations vs pinned source; exit 1 on drift
node build-web.js [--project=<name>] [--serve] [--port=N]   # self-contained interactive web player
node render-excalidraw.js --batch <dir> [--force]   # or: <file> --dry-run
```

Note: `lumina build -c <ch>` does **not** forward `--force`; only the all-chapters path is cache-aware. Single-chapter builds always rebuild.

## Architecture

**HTML → PPTX conversion** is done by `pptx-skill/pptx/scripts/html2pptx.js` (a bundled, customized PptxGenJS wrapper). Every build/validate path `require`s this same file. It maps `<div>`/text nodes/CSS to native PowerPoint shapes — see the slide conventions below, which exist because of how it parses the DOM.

**Build pipeline:**
- `build-chapter.js` (`buildChapter()`) — renders one chapter's `slides/*.html` (sorted alphabetically = slide order) into `<chapter>/<chapter>.pptx`. Tolerant by default (collects per-slide errors); `--strict` fails on first error. Accepts a shared Playwright browser. Has Windows EBUSY-safe save (see gotchas).
- `build-all.js` — orchestrates one project's chapters with a worker pool (default 3), content-fingerprint caching, then a second pass that merges every chapter into the project's `output` deck with dark section-divider slides between chapters. The chapter list/order, output name, cache file, and concurrency all come from the selected project in `lumina.config.js` (default project's output is **`claude-code-lumina-complete.pptx`**). `--list` prints the resolved plan without building.

**Config — single source of truth** (`lumina.config.js`): a `projects` map where each project has `{ root, output, cacheFile, chapters: [{id, title}] }`, plus shared `build`/`render` settings (concurrency, Excalidraw scale/theme/retries). Every pipeline script reads it (build, render, validate, and the citation gate). **To add a teardown, add a project entry — no script edits.** `root` is the content tree (`.` for Claude Code, `codex-cli-teardown` for Codex); each project gets its own cache file so caches don't collide. A project may also declare an optional `source` block (see below).

**Citation freshness gate** (`check-citations.js`, `lumina cite`): extracts every `file:line` reference from a project's `script.md` files and resolves it against the pinned upstream source clone (file exists + line in range), exiting non-zero on drift. A project opts in via a `source` block in `lumina.config.js` (`tree`, `commitFile`, `cloneUrl`, optional `crossRefPrefixes`). The upstream source is **not vendored** — clone it to the sibling path named (Codex → `../codex-source` at the SHA in `codex-cli-teardown/SOURCE_COMMIT.txt`); if absent, the gate prints the exact re-clone command. The **Claude Code teardown has no `source` block** — its source is reverse-engineered with no canonical public tree — so its citations are reported *unverified*, never failed. The gate classifies cross-refs (Codex citing Claude Code's `src/…` for contrast), quoted refs (markdown `>` lines quoting upstream docs like `AGENTS.md`), and bare-name informal mentions separately from hard failures. CI runs it via `.github/workflows/citations.yml` (no `npm install` — the gate uses only Node built-ins).

**MDX engine** (`src/core/md-compiler.js`, `compileMarkdownToHtml`): if a chapter dir contains `slides.md`, it is split on `\n\n---\n\n` (per-slide front-matter supported) and compiled into `slides/*.html` via `marked`. Custom tags: `<Excalidraw src="..." height="..."/>` → centered `<img>`, and `<Anim order="N" type="...">…</Anim>` → `data-anim-order` for progressive-disclosure animations. `build-chapter.js` calls this unconditionally before rendering. **Currently only `ch00-new-era/` uses `slides.md`** — the 11 production chapters are hand-authored HTML.

**Studio** (`src/studio/server.js`): Express + `ws` live-preview server. Watches `ch*/**.md`, `.excalidraw`, and `design-system/*.css`; recompiles MDX and pushes a WebSocket reload to the browser UI (`src/studio/index.html`).

**Interactive web player** (`build-web.js`, `lumina web`): bundles a project's slide HTML into ONE self-contained, offline `index.html` under `<output-basename>-web/`. Each slide is inlined and rendered in a scaled `<iframe srcdoc>` (so it opens from `file://` with no server, no network), with fade/slide transitions, an injected per-slide entrance animation (compare-grid columns duel in from the sides; cards/lists stagger up), keyboard/click/touch/fullscreen nav, a progress bar, and an overview thumbnail grid (`O`). `--serve` serves it via Express. Reads the same `lumina.config.js` projects map as the build pipeline, so it reuses the exact slide HTML that `html2pptx` renders to PowerPoint.

**Other root scripts:** `sync-scripts.js` rewrites `Slide NN:` headers in each `script.md` to match the actual HTML slide count/titles. `fix-slides.js` is a one-off ch00 renumbering migration (not part of the pipeline).

## Chapter Structure

Each `chXX-*/` directory contains:
- `slides/` — HTML named `slide-chXX-NN-*.html`, alphabetically sorted to set slide order (`ch07-memory` instead uses bare `NN-*.html` — see gotchas)
- `script.md` — bilingual narration with source-file references and timing
- `diagrams/` — `.excalidraw` sources + rendered `.png`
- `<chapter-name>.pptx` — generated, committed output

Design docs live in `doc/` (`ARCHITECTURE.md`, `USAGE.md`, `PRD.md`, `glossary.md`, `diagram-workflow.md`).

## HTML Slide Conventions

- Dark "Agent Blueprint" theme: `design-system/base-style-v2.css`. Slide canvas is 720pt × 405pt (16:9).
- **CRITICAL**: all text must be inside `<p>` or `<li>`. Never put a `<span>` as a direct child of a `<div>` — `html2pptx.js` extracts `<div>`s as shapes and ignores child `<span>`s, producing empty/invisible elements. This is the #1 cause of missing content in the PPTX.
- Use `class="fn"` spans for inline code references; reuse the `compare-grid`, `card`, `pipeline`, and `metric` classes from the design system.

## Excalidraw Diagram Workflow

For diagrams HTML/CSS can't render reliably:
1. Generate `.excalidraw` JSON with the `/excalidraw-diagram` skill.
2. Render to `.png` via `render-excalidraw.js` (warm-light theme, 2× scale, pinned Excalidraw 0.18.0, 3-retry CDN fallback; skips PNGs newer than their source).
3. Keep both files in the chapter's `diagrams/`, reference the `.png` from HTML via `<img>`.

See `doc/diagram-workflow.md` for details.

## Gotchas (non-obvious, will bite you)

- **A `slides.md` overwrites hand-authored HTML.** The MDX engine *deletes and regenerates* the chapter's `slides/*.html`. Never add `slides.md` to a hand-authored chapter unless you intend to migrate it to MDX.
- **Slide naming is inconsistent across chapters.** Most use `slide-chXX-NN-*.html`; `ch07-memory` uses bare `NN-*.html`. Build and validate now both match any `*.html`, but any *new* tooling must not assume the `slide-` prefix (that assumption previously made `validate-all.js` silently skip ch07).
- **Build cache:** `.build-cache.json` keys off content fingerprints of `slides/*.html`, `diagrams/*.png`, and `script.md`. If a build seems stale, use `--force` (or `build:watch`).
- **Windows file locks:** if the target `.pptx` is open in PowerPoint, the build retries then falls back to a timestamped filename (`<name>-<ts>.pptx`) rather than failing. Close the deck for a clean overwrite.
- **Citation source lives outside the repo.** `lumina cite` resolves Codex citations against `../codex-source` — a sibling clone that is **not committed** and can vanish; if it's missing the gate fails and prints the exact `git fetch` to restore it at the pinned SHA. After pulling a newer upstream, re-pin `codex-cli-teardown/SOURCE_COMMIT.txt` and re-run `lumina cite` to catch line-number drift.

No TypeScript, no framework — plain CommonJS Node.
