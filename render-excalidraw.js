#!/usr/bin/env node
/**
 * Render Excalidraw JSON files to PNG using Playwright.
 *
 * Warm light theme, high contrast — for slide clarity.
 * Best practices:
 * - Light/warm background for maximum readability
 * - 2x scale factor for crisp text on slides
 * - Pinned ESM bundle version for reproducible rendering
 * - Retry logic for CDN loading failures of esm.sh bundle
 * - Bounding-box auto-fit with configurable max dimensions
 * - Overflow-safe rendering (screenshot the full <body>)
 * - Graceful error logging + skip mode for batch rendering
 * - Render cache: skip if .png is newer than .excalidraw
 * - Output validation: verify PNG is a valid image
 *
 * Usage:
 *   node render-excalidraw.js <path-to-file.excalidraw> [output.png]
 *   node render-excalidraw.js --batch <directory> [--dry-run] [--force]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/**
 * Render template — warm light theme with high contrast.
 * Background is pure white (#FFFFFF), text auto-adjusts to dark.
 */
// NOTE: EXCALIDRAW_VERSION is pinned below; change it deliberately and re-render all diagrams.
const TEMPLATE = (version) =>
`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/>
<style>
@font-face { font-family: 'Virgil'; src: url('https://excalidraw.com/Virgil.woff2') format('woff2'); }
@font-face { font-family: 'Cascadia'; src: url('https://excalidraw.com/Cascadia.woff2') format('woff2'); }
*{margin:0;padding:0;box-sizing:border-box}
body{background:#FFFFFF;overflow:visible}
#root{display:inline-block}
#root svg{display:block;overflow:visible}
#error{display:none;color:#FF6B6B;font-family:sans-serif;padding:40px;font-size:16px;text-align:center}
</style>
</head><body>
<div id="root"></div>
<div id="error"></div>
<script type="module">
import{exportToSvg}from"https://esm.sh/@excalidraw/excalidraw@${version}/?bundle";
window.renderDiagram=async function(d){
try{
const data=typeof d==="string"?JSON.parse(d):d;
const els=data.elements||[],appState=data.appState||{},files=data.files||{};

// Strip bindings to prevent Excalidraw from auto-routing arrows and messing up LLM coordinates
els.forEach(el => {
  // We MUST keep boundElements for text containers, otherwise text alignment breaks
  if (el.boundElements) {
    // Only remove arrows from boundElements to prevent routing, keep text
    el.boundElements = el.boundElements.filter(b => b.type !== 'arrow');
  }
  delete el.startBinding;
  delete el.endBinding;
});

// Wait for fonts to be ready
await document.fonts.ready;

const svg=await exportToSvg({
elements:els,
appState:{
...appState,
exportBackground:true,
exportWithDarkMode:false,
theme:'light',
viewBackgroundColor:"#FFFFFF"
},
files
});
const root=document.getElementById("root");root.innerHTML="";root.appendChild(svg);
window.__renderComplete=true;return{success:true};
}catch(err){
const errorDiv=document.getElementById("error");
errorDiv.style.display="block";
errorDiv.textContent="Render error: "+err.message;
window.__renderComplete=true;return{success:false,error:err.message};
}
};
window.__moduleReady=true;
</script></body></html>`;

// Retry config for esm.sh CDN instability
const MAX_RENDER_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Pinned Excalidraw version — prevents silent breakage when esm.sh bundle changes
// Update this deliberately and re-render all diagrams to verify output
const EXCALIDRAW_VERSION = '0.18.0';

/** Max dimensions for rendered PNG */
const MAX_OUTPUT_W = 1440;
const MAX_OUTPUT_H = 810;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Graceful shutdown: close any active browser on SIGINT/SIGTERM
let activeRenderBrowser = null;

function registerRenderCleanup(browser) {
  activeRenderBrowser = browser;
  const handler = async (signal) => {
    console.warn(`\nCaught ${signal}, cleaning up...`);
    if (activeRenderBrowser?.isConnected()) {
      try { await activeRenderBrowser.close(); } catch { /* ignore */ }
    }
    process.exit(130);
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

/**
 * Check if existing PNG is newer than the .excalidraw source (cache skip).
 * Returns true if the output is up-to-date and can be skipped.
 */
function isOutputFresh(inputPath, outputPath) {
  if (!fs.existsSync(outputPath)) return false;
  const srcStat = fs.statSync(inputPath);
  const outStat = fs.statSync(outputPath);
  return outStat.mtimeMs > srcStat.mtimeMs;
}

/**
 * Validate that an output PNG is a valid image (not a corrupted/truncated file).
 * Reads the PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A.
 * Also checks file size is reasonable (> 1 KB).
 */
function validatePng(outputPath) {
  const buf = fs.readFileSync(outputPath);
  if (buf.length < 1024) {
    return { valid: false, reason: `PNG too small (${buf.length} bytes), likely empty` };
  }
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== pngMagic[i]) return { valid: false, reason: 'Missing PNG magic bytes' };
  }
  return { valid: true, size: buf.length };
}

/**
 * Compute bounding box of all active elements in an Excalidraw file.
 * Returns { minX, minY, maxX, maxY, activeCount } without launching a browser.
 */
function computeBounds(data) {
  const activeElements = data.elements.filter(el => !el.isDeleted);
  if (activeElements.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of activeElements) {
    const x = el.x || 0, y = el.y || 0;
    const w = Math.abs(el.width || 0), h = Math.abs(el.height || 0);
    if (el.type === 'arrow' || el.type === 'line') {
      const pts = el.points || [];
      for (const px of pts) {
        // points can be 2-element arrays; handle [[x,y],...] shape
        if (Array.isArray(px)) {
          minX = Math.min(minX, x + px[0]);
          minY = Math.min(minY, y + px[1]);
          maxX = Math.max(maxX, x + px[0]);
          maxY = Math.max(maxY, y + px[1]);
        }
      }
    } else {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY, activeCount: activeElements.length };
}

async function renderExcalidraw(inputPath, outputPath, opts = {}) {
  const {
    maxRetries = MAX_RENDER_RETRIES,
    skipOnError = false,
    force = false,
    dryRun = false,
  } = opts;

  const input = path.resolve(inputPath);
  if (!fs.existsSync(input)) {
    console.error(`  SKIP: File not found: ${input}`);
    return { success: false, reason: 'file-not-found' };
  }
  if (!outputPath) {
    outputPath = input.replace(/\.excalidraw$/, '.png');
  } else {
    outputPath = path.resolve(outputPath);
  }

  const jsonData = fs.readFileSync(input, 'utf-8');
  let data;
  try {
    data = JSON.parse(jsonData);
  } catch (e) {
    console.error(`  SKIP: Invalid JSON: ${path.basename(input)}`);
    return { success: false, reason: 'invalid-json' };
  }

  if (data.type !== 'excalidraw' || !data.elements || data.elements.length === 0) {
    console.error(`  SKIP: Invalid Excalidraw (no elements): ${path.basename(input)}`);
    return { success: false, reason: 'invalid-excalidraw' };
  }

  // --- Dry-run mode: compute bounds without launching browser ---
  if (dryRun) {
    const bounds = computeBounds(data);
    if (!bounds) {
      console.error(`  DRY-RUN: No valid bounds: ${path.basename(input)}`);
      return { success: false, reason: 'no-bounds' };
    }
    const padding = 80;
    const diagramW = bounds.maxX - bounds.minX + padding * 2;
    const diagramH = bounds.maxY - bounds.minY + padding * 2;
    const vpWidth = Math.max(Math.ceil(diagramW), 1920);
    const vpHeight = Math.max(Math.ceil(diagramH), 600);
    const scale = 2; // deviceScaleFactor
    const outW = Math.ceil(diagramW * scale);
    const outH = Math.max(Math.ceil(diagramH * scale), 600);
    console.log(`DRY-RUN: ${path.basename(input)}`);
    console.log(`  Elements: ${bounds.activeCount}`);
    console.log(`  Bounds: (${bounds.minX},${bounds.minY})-(${bounds.maxX},${bounds.maxY})`);
    console.log(`  Viewport: ${vpWidth}x${vpHeight}`);
    console.log(`  Estimated PNG: ${outW}x${outH} @2x`);
    console.log(`  Within max output (${MAX_OUTPUT_W}x${MAX_OUTPUT_H})? ${outW <= MAX_OUTPUT_W && outH <= MAX_OUTPUT_H ? 'yes' : 'NO - will exceed'}`);
    if (fs.existsSync(outputPath)) {
      const stale = isOutputFresh(input, outputPath);
      console.log(`  Cached PNG exists: ${stale ? 'FRESH (would skip)' : 'STALE (would re-render)'}`);
    } else {
      console.log(`  Cached PNG: none (would render)`);
    }
    return { success: true, dryRun: true, bounds, outputPath };
  }

  // --- Cache check: skip if PNG is newer than source ---
  if (!force && isOutputFresh(input, outputPath)) {
    const info = validatePng(outputPath);
    if (info.valid) {
      console.log(`  CACHE HIT: ${path.basename(outputPath)} is up-to-date (${info.size} bytes)`);
      return { success: true, outputPath, cached: true };
    }
    // PNG is corrupt, fall through to re-render
    console.log(`  CACHE MISS: ${path.basename(outputPath)} is corrupt (${info.reason}), re-rendering...`);
  }

  const activeElements = data.elements.filter(el => !el.isDeleted);
  if (activeElements.length === 0) {
    console.error(`  SKIP: All elements deleted: ${path.basename(input)}`);
    return { success: false, reason: 'all-deleted' };
  }

  // Compute bounding box of all active elements
  const bounds = computeBounds(data);
  if (!bounds) {
    console.error(`  SKIP: No valid element bounds: ${path.basename(input)}`);
    return { success: false, reason: 'no-bounds' };
  }

  const { minX, minY, maxX, maxY } = bounds;
  const padding = 80;
  const diagramW = maxX - minX + padding * 2;
  const diagramH = maxY - minY + padding * 2;
  const vpWidth = Math.max(Math.ceil(diagramW), 1920);
  const vpHeight = Math.max(Math.ceil(diagramH), 600);

  console.log(`Rendering: ${path.basename(input)}`);
  console.log(`  Elements: ${activeElements.length}, Viewport: ${vpWidth}x${vpHeight}, Bounds: (${minX},${minY})-(${maxX},${maxY})`);

  const template = TEMPLATE(EXCALIDRAW_VERSION);

  // Launch browser once, reuse across retries
  let browser = null;
  let page = null;
  let lastError = null;
  const tmpDir = path.dirname(outputPath);
  const tmpHtml = path.join(tmpDir, '_render_temp.html');
  let tmpHtmlCreated = false;
  let outputWritten = false;


  try {
    // Atomic write: write PNG to .tmp, rename on success
    const tmpPng = outputPath + '.tmp';
    try { fs.unlinkSync(tmpPng); } catch { /* no stale file */ }

    browser = await chromium.launch({ headless: true });
    activeRenderBrowser = browser;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (attempt > 1) {
        console.log(`  Retry ${attempt}/${maxRetries}...`);
        await sleep(RETRY_DELAY_MS);
      }

      try {
        page = await browser.newPage({
          viewport: { width: vpWidth, height: vpHeight },
          deviceScaleFactor: 2,
        });

        fs.writeFileSync(tmpHtml, template, 'utf-8');
        tmpHtmlCreated = true;

        const templateUrl = 'file://' + tmpHtml.replace(/\\/g, '/');
        await page.goto(templateUrl);

        // Wait for the ES module to load
        await page.waitForFunction('window.__moduleReady === true', { timeout: 30000 });

        // Render diagram
        const result = await page.evaluate((json) => {
          return window.renderDiagram(json);
        }, jsonData);

        if (!result || !result.success) {
          throw new Error(result?.error || 'Unknown render error');
        }

        // Wait for render complete
        await page.waitForFunction('window.__renderComplete === true', { timeout: 15000 });

        // Screenshot to temp file, then atomic rename
        await page.locator('#root > svg').screenshot({ path: tmpPng, type: 'png' });
        outputWritten = true;

        // Validate output is a well-formed PNG
        const info = validatePng(tmpPng);
        if (!info.valid) {
          throw new Error(`Output validation failed: ${info.reason}`);
        }

        // Atomic rename
        fs.renameSync(tmpPng, outputPath);

        console.log(`  Output: ${path.basename(outputPath)} (${info.size} bytes)`);
        return { success: true, outputPath };
      } catch (e) {
        lastError = e;
        console.error(`  Attempt ${attempt} failed: ${e.message}`);
      } finally {
        if (page) {
          await page.close().catch(() => {});
          page = null;
        }
      }
    }
  } finally {
    // Always clean up temp files
    if (tmpHtmlCreated) {
      try { fs.unlinkSync(tmpHtml); } catch { /* already gone */ }
    }
    // Clean up temp PNG if written but not renamed (failure case)
    if (outputWritten) {
      const tmpPng = outputPath + '.tmp';
      try { fs.unlinkSync(tmpPng); } catch { /* already renamed or gone */ }
    }
    if (browser?.isConnected()) {
      await browser.close().catch(() => {});
    }
  }

  // All retries exhausted
  if (skipOnError) {
    console.error(`  FAILED after ${maxRetries} attempts, skipping: ${path.basename(input)} (${lastError?.message})`);
    return { success: false, reason: 'render-failed', error: lastError?.message };
  }
  console.error(`  FATAL: All ${maxRetries} render attempts failed`);
  process.exit(1);
}

// ----------------------------------------------------------------
// Batch mode: render all .excalidraw files in a directory
// ----------------------------------------------------------------
async function batchRender(dir, opts = {}) {
  const { dryRun = false } = opts;
  dir = path.resolve(dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`ERROR: Not a directory: ${dir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.excalidraw'))
    .sort();

  if (files.length === 0) {
    console.log(`No .excalidraw files found in ${dir}`);
    return;
  }

  console.log(`Batch mode: ${files.length} file(s) in ${dir}`);
  console.log('='.repeat(50));

  const results = [];
  // Launch browser once for the whole batch
  let browser = null;
  try {
    if (!dryRun) {
      browser = await chromium.launch({ headless: true });
    }
    
    // Use dynamic import since p-limit is an ES module
    const { default: pLimit } = await import('p-limit');
    const limit = pLimit(5); // Concurrency limit
    
    const tasks = files.map(file => limit(async () => {
      const inputPath = path.join(dir, file);
      try {
        const result = await renderSingle(browser, inputPath, opts);
        return result;
      } catch (e) {
        console.error(`  UNEXPECTED ERROR for ${file}: ${e.message}`);
        return { success: false, reason: 'unexpected', error: e.message };
      }
    }));
    
    const completed = await Promise.all(tasks);
    results.push(...completed);
    
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const ok = results.filter(r => r.success).length;
  const cached = results.filter(r => r.cached).length;
  const skip = results.filter(r => !r.success).length;
  console.log('='.repeat(50));
  console.log(`Done: ${ok} rendered, ${cached} cached, ${skip} skipped/failed`);
  return results;
}

/**
 * Render a single file within the batch context (reuses browser).
 */
async function renderSingle(browser, inputPath, opts = {}) {
  const {
    maxRetries = MAX_RENDER_RETRIES,
    skipOnError = false,
    force = false,
    dryRun = false,
  } = opts;

  if (!fs.existsSync(inputPath)) {
    console.error(`  SKIP: File not found: ${inputPath}`);
    return { success: false, reason: 'file-not-found' };
  }
  const outputPath = inputPath.replace(/\.excalidraw$/, '.png');

  const jsonData = fs.readFileSync(inputPath, 'utf-8');
  let data;
  try {
    data = JSON.parse(jsonData);
  } catch (e) {
    console.error(`  SKIP: Invalid JSON: ${path.basename(inputPath)}`);
    return { success: false, reason: 'invalid-json' };
  }

  if (data.type !== 'excalidraw' || !data.elements || data.elements.length === 0) {
    console.error(`  SKIP: Invalid Excalidraw (no elements): ${path.basename(inputPath)}`);
    return { success: false, reason: 'invalid-excalidraw' };
  }

  // Dry-run
  if (dryRun) {
    const bounds = computeBounds(data);
    if (!bounds) return { success: false, reason: 'no-bounds' };
    const padding = 80;
    const diagramW = bounds.maxX - bounds.minX + padding * 2;
    const diagramH = bounds.maxY - bounds.minY + padding * 2;
    const vpWidth = Math.max(Math.ceil(diagramW), 1920);
    const vpHeight = Math.max(Math.ceil(diagramH), 600);
    const outW = Math.ceil(diagramW * 2);
    const outH = Math.max(Math.ceil(diagramH * 2), 600);
    console.log(`DRY-RUN: ${path.basename(inputPath)}`);
    console.log(`  Elements: ${bounds.activeCount}, Viewport: ${vpWidth}x${vpHeight}, PNG: ${outW}x${outH}`);
    if (fs.existsSync(outputPath)) {
      const stale = isOutputFresh(inputPath, outputPath);
      console.log(`  Cached PNG: ${stale ? 'FRESH (skip)' : 'STALE (re-render)'}`);
    } else {
      console.log(`  Cached PNG: none (would render)`);
    }
    return { success: true, dryRun: true, bounds, outputPath };
  }

  // Cache check
  if (!force && isOutputFresh(inputPath, outputPath)) {
    const info = validatePng(outputPath);
    if (info.valid) {
      console.log(`  CACHE HIT: ${path.basename(outputPath)} (${info.size} bytes)`);
      return { success: true, outputPath, cached: true };
    }
    console.log(`  CACHE MISS: ${path.basename(outputPath)} corrupt (${info.reason})`);
  }

  const bounds = computeBounds(data);
  if (!bounds) return { success: false, reason: 'no-bounds' };

  const activeElements = data.elements.filter(el => !el.isDeleted);
  const { minX, minY, maxX, maxY } = bounds;
  const padding = 80;
  const diagramW = maxX - minX + padding * 2;
  const diagramH = maxY - minY + padding * 2;
  const vpWidth = Math.max(Math.ceil(diagramW), 1920);
  const vpHeight = Math.max(Math.ceil(diagramH), 600);

  console.log(`Rendering: ${path.basename(inputPath)}`);
  console.log(`  Elements: ${activeElements.length}, Viewport: ${vpWidth}x${vpHeight}`);

  const template = TEMPLATE(EXCALIDRAW_VERSION);

  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) {
      console.log(`  Retry ${attempt}/${maxRetries}...`);
      await sleep(RETRY_DELAY_MS);
    }

    let page;
    const tmpDir = path.dirname(outputPath);
    const uniqueId = Math.random().toString(36).substring(2, 10);
    const tmpHtml = path.join(tmpDir, `_render_temp_${uniqueId}.html`);
    try {
      page = await browser.newPage({
        viewport: { width: vpWidth, height: vpHeight },
        deviceScaleFactor: 2,
      });

      try {
        fs.writeFileSync(tmpHtml, template, 'utf-8');
        const templateUrl = 'file://' + tmpHtml.replace(/\\/g, '/');
        await page.goto(templateUrl);

        await page.waitForFunction('window.__moduleReady === true', { timeout: 30000 });

        const result = await page.evaluate((json) => {
          return window.renderDiagram(json);
        }, jsonData);

        if (!result || !result.success) {
          throw new Error(result?.error || 'Unknown render error');
        }

        await page.waitForFunction('window.__renderComplete === true', { timeout: 15000 });

        await page.locator('#root > svg').screenshot({ path: outputPath, type: 'png' });

        const info = validatePng(outputPath);
        if (!info.valid) {
          throw new Error(`Output validation failed: ${info.reason}`);
        }

        console.log(`  Output: ${path.basename(outputPath)} (${info.size} bytes)`);
        await page.close();
        fs.unlinkSync(tmpHtml);
        return { success: true, outputPath };
      } catch (e) {
        lastError = e;
        try { fs.unlinkSync(tmpHtml); } catch (_) {}
        await page.close().catch(() => {});
        console.error(`  Attempt ${attempt} failed: ${e.message}`);
      }
    } catch (e) {
      lastError = e;
      if (page) await page.close().catch(() => {});
      console.error(`  Attempt ${attempt} failed: ${e.message}`);
    }
  }

  if (skipOnError) {
    console.error(`  FAILED after ${maxRetries} attempts, skipping: ${path.basename(inputPath)}`);
    return { success: false, reason: 'render-failed', error: lastError?.message };
  }
  console.error(`  FATAL: All ${maxRetries} render attempts failed for ${path.basename(inputPath)}`);
  process.exit(1);
}

// ----------------------------------------------------------------
// CLI entrypoint
// ----------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  // Detect --batch mode
  if (args.includes('--batch')) {
    const idx = args.indexOf('--batch');
    const batchDir = args[idx + 1];
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');

    if (!batchDir || batchDir.startsWith('--')) {
      console.log('Usage: node render-excalidraw.js --batch <directory> [--dry-run] [--force]');
      process.exit(1);
    }
    await batchRender(batchDir, { dryRun, force });
    return;
  }

  // Single file mode
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const flags = args.filter(a => a.startsWith('--'));
  const positional = args.filter(a => !a.startsWith('--'));
  const inputPath = positional[0];
  const outputPath = positional[1] || undefined;

  if (!inputPath) {
    console.log('Usage:');
    console.log('  Single file:  node render-excalidraw.js <path.excalidraw> [output.png] [--dry-run] [--force]');
    console.log('  Batch mode:   node render-excalidraw.js --batch <directory> [--dry-run] [--force]');
    process.exit(1);
  }

  await renderExcalidraw(inputPath, outputPath, { dryRun, force });
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
