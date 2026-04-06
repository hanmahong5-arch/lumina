/**
 * Deep Dive Pipeline Configuration
 * Centralized settings for the presentation generator.
 */
module.exports = {
  // Global build settings
  build: {
    concurrency: 3,           // Max concurrent Playwright/Chapter builds
    cacheFile: '.build-cache.json',
  },
  
  // Render settings for slides & diagrams
  render: {
    slideDimensions: 'LAYOUT_16x9',
    excalidraw: {
      scale: 2,
      theme: 'light',         // We use "warm light" for diagrams as per README
      maxRetries: 3
    }
  },

  // Ordered list of chapters to build and their display titles for dividers
  chapters: [
    { id: 'ch00-overview-v2', title: 'Chapter 0 \u2014 Overview' },
    { id: 'ch01-core-engine', title: 'Chapter 1 \u2014 Core Engine' },
    { id: 'ch02-multi-agent', title: 'Chapter 2 \u2014 Multi-Agent Orchestration' },
    { id: 'ch03-permission',  title: 'Chapter 3 \u2014 Permission System' },
    { id: 'ch04-token-mgmt',  title: 'Chapter 4 \u2014 Token Management' },
    { id: 'ch05-tools-mcp',   title: 'Chapter 5 \u2014 Tools & MCP' },
    { id: 'ch06-resilience',  title: 'Chapter 6 \u2014 Resilience & Self-Healing' },
    { id: 'ch07-memory',      title: 'Chapter 7 \u2014 Memory & Context' },
    { id: 'ch08-protocol',    title: 'Chapter 8 \u2014 Protocol Layer' },
    { id: 'ch09-ink-ui',      title: 'Chapter 9 \u2014 Ink UI' },
    { id: 'ch10-feature-cost',title: 'Chapter 10 \u2014 Feature Cost' },
  ]
};
