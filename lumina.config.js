/**
 * Lumina Pipeline Configuration — the single source of truth.
 *
 * This file is consumed by build-all.js, build-chapter.js, render-excalidraw.js,
 * validate-all.js, and the `lumina` CLI. Editing it actually changes pipeline
 * behavior (chapter order, output names, concurrency, diagram scale, etc.).
 *
 * A "project" is one teardown content tree: an ordered list of chapter dirs
 * under `root`, merged into a single `output` deck. Add a project here to make
 * the whole pipeline build it — no script edits required.
 */
module.exports = {
  // Global build settings (per-project overrides win where applicable)
  build: {
    concurrency: 3,                 // Max concurrent chapter builds
  },

  // Render settings for diagrams
  render: {
    slideDimensions: 'LAYOUT_16x9',
    batchConcurrency: 5,            // Parallel Excalidraw renders in --batch mode
    excalidraw: {
      scale: 2,                     // deviceScaleFactor for crisp slide text
      theme: 'light',               // warm-light diagrams (see render-excalidraw.js)
      maxRetries: 3,                // esm.sh CDN retry attempts
    },
  },

  // Which project `build`/`validate`/`render` target when --project is omitted
  defaultProject: 'claude-code',

  projects: {
    // ---- Project 1: the original Claude Code teardown (repo root) ----
    'claude-code': {
      title: 'Claude Code Lumina',
      root: '.',                                    // chapters are top-level chXX-* dirs
      output: 'claude-code-lumina-complete.pptx',
      cacheFile: '.build-cache.json',               // preserves the existing cache
      dividerSubtitle: 'Claude Code Lumina',
      chapters: [
        { id: 'ch00-overview-v2',  title: 'Chapter 0 — Overview' },
        { id: 'ch01-core-engine',  title: 'Chapter 1 — Core Engine' },
        { id: 'ch02-multi-agent',  title: 'Chapter 2 — Multi-Agent Orchestration' },
        { id: 'ch03-permission',   title: 'Chapter 3 — Permission System' },
        { id: 'ch04-token-mgmt',   title: 'Chapter 4 — Token Management' },
        { id: 'ch05-tools-mcp',    title: 'Chapter 5 — Tools & MCP' },
        { id: 'ch06-resilience',   title: 'Chapter 6 — Resilience & Self-Healing' },
        { id: 'ch07-memory',       title: 'Chapter 7 — Memory & Context' },
        { id: 'ch08-protocol',     title: 'Chapter 8 — Protocol Layer' },
        { id: 'ch09-ink-ui',       title: 'Chapter 9 — Ink UI' },
        { id: 'ch10-feature-cost', title: 'Chapter 10 — Feature Cost' },
      ],
    },

    // ---- Project 2: the OpenAI Codex CLI teardown (sibling content tree) ----
    // Content is script-only for now; chapters with no slides are skipped
    // gracefully by the build until their slides/ are authored.
    'codex': {
      title: 'Codex CLI Teardown',
      root: 'codex-cli-teardown',
      output: 'codex-cli-teardown-complete.pptx',
      cacheFile: '.build-cache.codex.json',
      dividerSubtitle: 'Lumina · Codex Teardown',
      // Upstream source for citation verification (`node check-citations.js`).
      // openai/codex is public + pinned, so its file:line refs are checkable.
      // The Claude Code project deliberately has NO source block: its "source"
      // is reverse-engineered and has no canonical tree to resolve against.
      source: {
        tree: '../codex-source',                       // sibling clone (not committed)
        commitFile: 'codex-cli-teardown/SOURCE_COMMIT.txt',
        cloneUrl: 'https://github.com/openai/codex.git',
        // Paths under these prefixes are comparisons to the OTHER teardown
        // (Claude Code uses `src/…`); reported as cross-refs, never failed.
        crossRefPrefixes: ['src/'],
      },
      chapters: [
        { id: 'ch00-architecture-overview', title: 'Chapter 0 — Architecture Overview (Rust + JS Split)' },
        { id: 'ch01-core-engine',           title: 'Chapter 1 — Core Engine (submission_loop)' },
        { id: 'ch02-tools-mcp',             title: 'Chapter 2 — Tools & MCP' },
        { id: 'ch03-sandbox-native',        title: 'Chapter 3 — Native Sandboxing' },
        { id: 'ch04-batch-and-goals',       title: 'Chapter 4 — Batch Jobs & Goals' },
      ],
    },
  },
};
