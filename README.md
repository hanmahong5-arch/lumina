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

All core settings (concurrency, diagram scale, theme, chapter order) are now centralized in **`lumina.config.js`**. You no longer need to dig into the source scripts to tweak the pipeline behavior.

## Core Features

- **Modern CLI UX:** Built with `commander`, `ora`, and `chalk` for a robust, developer-friendly experience.
- **HTML to PPTX Engine:** Utilizes a highly customized PptxGenJS wrapper to faithfully map HTML `<divs>`, text nodes, background colors, and precise CSS layouts to native PowerPoint shapes.
- **Progressive Disclosure Animations:** Supports "Flipbook-style" native slide animations via HTML `data-anim-order` properties.
- **Headless Diagram Rendering:** Automatically converts `.excalidraw` schema files into high-resolution PNGs using Playwright.
- **Resilient Build (EBUSY Safe):** The compiler will safely fall back to saving a timestamped `.pptx` file if you currently have the presentation open in PowerPoint.

---
*Built for the Claude Code Lumina Series*