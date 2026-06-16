# Claude Code Lumina Presentation Pipeline 🚀

This repository contains the source code and automation pipeline to generate the **Claude Code Lumina** technical presentation. It converts semantic HTML layouts, Excalidraw diagrams, and Markdown scripts into a beautifully formatted, natively animated, and cross-platform compatible `.pptx` PowerPoint file.

**[NEW]** The project has been fully evolved into a modern Node.js CLI tool based on the BMAD (Breakthrough Method for Agile AI-Driven Development) methodology, featuring central configuration, rich terminal output, and a Live Watch mode!

## 📖 Complete Documentation

Please refer to the comprehensive artifacts in the `/doc` directory:
- 📘 **[USAGE Guide (使用手册)](./doc/USAGE.md)** - Detailed instructions on commands, watch mode, and animations.
- 🏗️ **[ARCHITECTURE](./doc/ARCHITECTURE.md)** - System design and data flow.
- 📝 **[PRD](./doc/PRD.md)** - Product requirements and personas.

## ⚡ Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Build the complete Master Deck (compiles all chapters)
npm run build

# 3. 👁️ Start Watch Mode (Live preview while editing)
npm run build:watch
```

## 🛠️ Global Configuration

All core settings (concurrency, diagram scale, theme, chapter order) are centralized in **`lumina.config.js`**. You no longer need to dig into the source scripts to tweak the pipeline behavior.

## 📚 Multiple Projects

`lumina.config.js` defines a `projects` map — each is a teardown content tree (its own `root`, chapter list, output deck, and build cache). Build any of them with `--project`:

```bash
lumina build --project claude-code     # default
lumina build --project codex           # the Codex CLI teardown
lumina build --list                    # print the resolved build plan, build nothing
```

To add a new teardown, add a `projects` entry — no script changes required. Chapters that don't have authored slides yet are skipped gracefully.

## 🔎 Citation Freshness

A teardown is only as trustworthy as its source citations. `lumina cite` checks every `file:line` reference in a project's `script.md` files against the **pinned upstream commit**, and fails on drift (a cited file renamed/moved, or a line number now out of range):

```bash
lumina cite                    # check every project that pins a source
lumina cite --project codex    # just one
npm run cite                   # same, via npm
```

A project opts in with a `source` block in `lumina.config.js` (`tree`, `commitFile`, `cloneUrl`). The upstream source is **not** vendored — clone it to the sibling path the block names (the Codex commit lives in `codex-cli-teardown/SOURCE_COMMIT.txt`). Projects with no `source` block (e.g. the Claude Code teardown, whose source is reverse-engineered with no canonical public tree) are reported as *unverified* rather than failed. CI runs the same check via `.github/workflows/citations.yml`.

## 🎬 Interactive Web Player

Beyond the static `.pptx`, `lumina web` bundles a project's slides into **one self-contained, offline `index.html`** — a polished interactive deck you can open straight from disk (no server, no network):

```bash
lumina web --project codex          # → codex-cli-teardown-web/index.html
lumina web --project codex --serve  # also serve it at http://localhost:5173
npm run web                         # same, default project
```

Each slide is the *same* HTML the PowerPoint pipeline renders, inlined into a scaled `<iframe>`. Interaction: smooth fade/slide transitions, a per-slide entrance animation (comparison columns duel in from the sides, cards stagger up), keyboard / click / touch / fullscreen navigation (`← → · O overview · F fullscreen`), a progress bar, and a thumbnail overview grid. The bundle is fully portable — share the single `index.html` and it just works.

## Core Features

- **Modern CLI UX:** Built with `commander`, `ora`, and `chalk` for a robust, developer-friendly experience.
- **HTML to PPTX Engine:** Utilizes a highly customized PptxGenJS wrapper to faithfully map HTML `<divs>`, text nodes, background colors, and precise CSS layouts to native PowerPoint shapes.
- **Progressive Disclosure Animations:** Supports "Flipbook-style" native slide animations via HTML `data-anim-order` properties.
- **Headless Diagram Rendering:** Automatically converts `.excalidraw` schema files into high-resolution PNGs using Playwright.
- **Resilient Build (EBUSY Safe):** The compiler will safely fall back to saving a timestamped `.pptx` file if you currently have the presentation open in PowerPoint.

---
*Built for the Claude Code Lumina Series*