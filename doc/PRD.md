# Product Requirements Document (PRD)
**Project Name:** Claude Code Lumina Presentation Pipeline
**Target Audience:** Technical Presenters, AI Engineers, Software Architects

## 1. Goal
To provide an automated, highly reliable pipeline that converts semantic HTML layouts, CSS, and Excalidraw diagrams into a perfectly formatted, natively animated `.pptx` file. 

## 2. Core Personas
*   **The Content Author:** Writes `script.md` and standard HTML. Relies on the pipeline to sync script page numbers and automatically apply a consistent dark-theme design system.
*   **The Presentation Engine (BMAD Agent):** Relies on deterministic file naming (`slide-chXX-NN.html`), predictable layout tags (`<div class="card">`), and headless rendering to produce the final asset.

## 3. Core Features
*   **HTML to PPTX:** Map HTML DOM trees to native PPTX text boxes and shapes using `pptxgenjs`.
*   **Headless Rendering:** Convert `.excalidraw` sources into cropped PNGs via Playwright.
*   **Progressive Disclosure:** Translate HTML `data-anim-order` into native PowerPoint slide-cloning (flipbook animation) to avoid native PPTX animation flakiness.
*   **Auto-Syncing:** Keep the speaker notes (`script.md`) aligned with the generated presentation page numbering.
*   **Resilient Builds:** Withstand Windows file locks (`EBUSY`) when the target `.pptx` is open in PowerPoint.

## 4. Non-Functional Requirements
*   **Performance:** A full 300+ slide rebuild must complete in under 30 seconds via content-hash caching and multi-browser concurrency.
*   **Maintainability:** All core build logic should be separated into a `src/` directory following modern ES Module/CommonJS CLI patterns.
