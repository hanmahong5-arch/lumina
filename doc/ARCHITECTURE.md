# Architecture Document
**Project:** Claude Code Lumina Presentation Pipeline

## 1. System Overview
The pipeline is a Node.js-based toolchain that compiles structured directories (`chXX-name`) into a merged `.pptx` file.

## 2. Data Flow
1.  **Validation Phase:** Ensures all HTML slides lack illegal `margin` or layout tags that break the PPTX mapping engine.
2.  **Diagram Phase:** Playwright launches, loads Excalidraw's web interface locally (or via CDN), injects `.excalidraw` JSON, and screenshots the SVG output to a `.png`.
3.  **Compilation Phase:** `pptxgenjs` processes the HTML. A custom traversal engine (`html2pptx.js`) translates raw DOM nodes and inline CSS into native PowerPoint primitives.
4.  **Merge Phase:** Individual chapter `.pptx` builds are merged into `claude-code-lumina-complete.pptx`.

## 3. Directory Structure (Post-Evolution)
*   `src/cli/`: Entry points for user commands (Build, Watch, Render).
*   `src/core/`: Business logic.
    *   `compiler.js`: Orchestrates the `html2pptx` engine and cache checks.
    *   `renderer.js`: Headless Playwright orchestration for diagrams.
    *   `validator.js`: DOM syntax checker.
*   `src/utils/`: Configuration loaders and robust logging.
*   `doc/`: Context artifacts (this file, PRD).
*   `chXX-*/`: The presentation content payload.

## 4. Key Dependencies
*   `pptxgenjs`: Slide generation.
*   `playwright`: Headless rendering.
*   `commander` & `ora`: CLI orchestration and UX.
*   `chokidar`: Live watch rebuilding.
