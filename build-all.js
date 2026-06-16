/**
 * Build all chapters in one go.
 * Usage: node build-all.js
 *
 * Phase 1: Build all 11 chapters individually — with parallel execution and caching
 * Phase 2: Merge all HTML slides into a single combined PPTX with section dividers
 *   Output: claude-code-lumina-complete.pptx
 *
 * Features:
 *   - Parallel chapter builds with controlled concurrency (default: 3)
 *   - Build cache: skips chapters whose source HTML files haven't changed
 *   - Atomic writes: output PPTX written to .tmp then renamed on success
 *   - Graceful shutdown: SIGINT/SIGTERM closes all browsers cleanly
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pptxgen = require('pptxgenjs');
const { chromium } = require('playwright');

// Prevent memory leak warnings during highly concurrent browser launches
process.setMaxListeners(30);

const html2pptx = require(
  path.resolve(__dirname, 'pptx-skill', 'pptx', 'scripts', 'html2pptx.js')
);

const { buildChapter } = require(path.resolve(__dirname, 'build-chapter.js'));

// --- Project resolution (driven by lumina.config.js) ---

const config = require(path.resolve(__dirname, 'lumina.config.js'));

// Resolve --project (defaults to config.defaultProject). Parsed at module load
// so the derived constants below stay module-level, as the rest of the file expects.
function parseProjectArg() {
  const args = process.argv.slice(2);
  const eq = args.find(a => a.startsWith('--project='));
  if (eq) return eq.split('=')[1];
  const idx = args.indexOf('--project');
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return config.defaultProject;
}

const projectName = parseProjectArg();
const project = config.projects && config.projects[projectName];
if (!project) {
  console.error(`ERROR: Unknown project "${projectName}". Available: ${Object.keys(config.projects || {}).join(', ')}`);
  process.exit(1);
}

const projectRoot = path.resolve(__dirname, project.root || '.');
const chapterOrder = project.chapters.map(c => c.id);
const chapterTitles = Object.fromEntries(project.chapters.map(c => [c.id, c.title]));
const DIVIDER_SUBTITLE = project.dividerSubtitle || project.title;
const DECK_TITLE = project.title;
const OUTPUT_FILE = path.resolve(__dirname, project.output);

// Resolve a chapter's directory within the active project's root.
const resolveChapterDir = (id) => path.resolve(projectRoot, id);

// --- Build cache utilities ---

const CACHE_FILE = path.resolve(__dirname, project.cacheFile || '.build-cache.json');
const MAX_PARALLEL = Math.max(1, Math.min(config.build?.concurrency ?? 3, chapterOrder.length || 1));

function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

/**
 * Compute a hash of all relevant files in a chapter (slides, diagrams, scripts).
 * Returns null if the chapter has no slides directory.
 */
function computeChapterFingerprint(chapterName) {
  const chapterDir = resolveChapterDir(chapterName);
  const slidesDir = path.join(chapterDir, 'slides');
  const diagramsDir = path.join(chapterDir, 'diagrams');
  
  if (!fs.existsSync(slidesDir)) return null;

  const hash = crypto.createHash('md5');

  // Helper to add files to hash
  const addFilesToHash = (dir, extensionFilter = null) => {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).sort();
    for (const f of files) {
      if (extensionFilter && !f.endsWith(extensionFilter)) continue;
      const fullPath = path.join(dir, f);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        hash.update(f);
        hash.update(String(stat.mtimeMs));
        hash.update(String(stat.size));
      }
    }
  };

  // Hash all HTML slides
  addFilesToHash(slidesDir, '.html');
  
  // Hash all PNG diagrams (they are injected into slides)
  addFilesToHash(diagramsDir, '.png');
  
  // Hash script.md just in case it influences any future build steps
  const scriptPath = path.join(chapterDir, 'script.md');
  if (fs.existsSync(scriptPath)) {
    const stat = fs.statSync(scriptPath);
    hash.update('script.md');
    hash.update(String(stat.mtimeMs));
    hash.update(String(stat.size));
  }

  return hash.digest('hex');
}

/**
 * Check if a chapter's output PPTX should be rebuilt.
 * Returns false and caches the result if up-to-date.
 */
function isChapterCacheHit(chapterName) {
  const fingerprint = computeChapterFingerprint(chapterName);
  if (!fingerprint) return false; // no slides dir — skip

  const outputFile = path.join(resolveChapterDir(chapterName), `${chapterName}.pptx`);
  if (!fs.existsSync(outputFile)) return false;

  const cache = loadCache();
  const entry = cache[chapterName];
  if (!entry || entry.fingerprint !== fingerprint) return false;

  return true;
}

/**
 * Record a successful chapter build in the cache.
 */
function recordChapterCache(chapterName) {
  const fingerprint = computeChapterFingerprint(chapterName);
  if (!fingerprint) return;

  const cache = loadCache();
  cache[chapterName] = {
    fingerprint,
    timestamp: new Date().toISOString(),
  };
  saveCache(cache);
}

/**
 * A chapter is buildable if it has authored HTML slides or a slides.md the
 * MDX engine can compile. Chapters that have neither (e.g. a scaffolded but
 * not-yet-authored project) are skipped instead of crashing build-chapter.js.
 */
function isChapterBuildable(chapterName) {
  const dir = resolveChapterDir(chapterName);
  const slidesDir = path.join(dir, 'slides');
  const hasHtml = fs.existsSync(slidesDir) &&
    fs.readdirSync(slidesDir).some(f => f.endsWith('.html'));
  const hasMd = fs.existsSync(path.join(dir, 'slides.md'));
  return hasHtml || hasMd;
}

/**
 * Build a result record for a chapter that wasn't (re)built this run.
 * kind: 'cached' (up-to-date) | 'noSlides' (nothing to build yet).
 */
function makeStaticResult(chapterName, kind) {
  const outputFile = path.join(resolveChapterDir(chapterName), `${chapterName}.pptx`);
  const stats = fs.existsSync(outputFile) ? fs.statSync(outputFile) : null;
  const slidesDir = path.join(resolveChapterDir(chapterName), 'slides');
  const slideCount = fs.existsSync(slidesDir)
    ? fs.readdirSync(slidesDir).filter(f => f.endsWith('.html')).length
    : 0;
  return {
    chapter: chapterName,
    ok: true,
    slideCount,
    sizeMB: stats ? (stats.size / (1024 * 1024)).toFixed(2) : 'N/A',
    cached: kind === 'cached',
    noSlides: kind === 'noSlides',
    errors: [],
  };
}

/**
 * Run tasks in parallel with controlled concurrency.
 * tasks: array of functions that return promises
 * concurrency: max number of tasks running simultaneously
 * returns: array of results (preserving order)
 */
async function runInParallel(tasks, concurrency) {
  const results = new Array(tasks.length);
  let index = 0;

  async function runNext() {
    let i;
    while ((i = index++) < tasks.length) {
      results[i] = await tasks[i]();
    }
  }

  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(runNext());
  }
  await Promise.all(workers);

  return results;
}

// Graceful shutdown for the Phase 2 browser
let phase2Browser = null;

function registerShutdown(browserRef) {
  phase2Browser = browserRef;
  const cleanup = async (signal) => {
    if (phase2Browser && phase2Browser.isConnected()) {
      console.warn(`\nCaught ${signal}, closing browser...`);
      try {
        await phase2Browser.close();
      } catch { /* ignore */ }
    }
    process.exit(130);
  };

  process.once('SIGINT', () => cleanup('SIGINT'));
  process.once('SIGTERM', () => cleanup('SIGTERM'));
}

/**
 * Phase 1 — build each chapter individually (delegates to build-chapter.js).
 * Now runs in parallel with cache-based skip logic.
 */
async function phase1BuildIndividual(options = {}) {
  const { parallel = true, concurrency = MAX_PARALLEL, force = false } = options;

  console.log('\n' + '='.repeat(60));
  console.log('PHASE 1: Building individual chapter PPTX files');
  if (parallel) {
    console.log(`  Concurrency: ${concurrency}`);
  }
  console.log('='.repeat(60));

  // Scan: classify each chapter as buildable-and-stale, cached, or has-no-slides
  const toBuild = [];
  const skipped = [];
  const noSlides = [];

  for (const ch of chapterOrder) {
    if (!isChapterBuildable(ch)) {
      noSlides.push(ch);
    } else if (!force && isChapterCacheHit(ch)) {
      skipped.push(ch);
    } else {
      toBuild.push(ch);
    }
  }

  if (skipped.length > 0) {
    console.log(`\n  Cached (skipped): ${skipped.length} chapter(s): ${skipped.join(', ')}`);
  }
  if (noSlides.length > 0) {
    console.log(`\n  No slides yet (skipped): ${noSlides.length} chapter(s): ${noSlides.join(', ')}`);
  }

  if (toBuild.length === 0) {
    console.log('\n  Nothing to build — all buildable chapters are up-to-date. Use --force to rebuild.');
    return chapterOrder.map(ch =>
      makeStaticResult(ch, noSlides.includes(ch) ? 'noSlides' : 'cached'));
  }

  console.log(`\n  Building: ${toBuild.length} chapter(s): ${toBuild.join(', ')}`);

  const resultsMap = {};

  const buildTask = (ch) => async () => {
    try {
      const result = await buildChapter(ch, { strict: false, root: project.root });
      recordChapterCache(ch);
      return { chapter: ch, ...result, ok: true };
    } catch (err) {
      return { chapter: ch, error: err.message, ok: false, errors: [{ file: '', error: err.message }] };
    }
  };

  let builtResults;
  if (parallel && toBuild.length > 1) {
    console.log(`\n  Running ${toBuild.length} builds in parallel (concurrency: ${concurrency})...\n`);
    builtResults = await runInParallel(toBuild.map(ch => buildTask(ch)), concurrency);
  } else {
    builtResults = [];
    for (const ch of toBuild) {
      builtResults.push(await buildTask(ch)());
    }
  }

  // Merge cached and built results preserving chapterOrder
  for (const r of builtResults) {
    resultsMap[r.chapter] = r;
  }

  const results = chapterOrder.map(ch => {
    if (noSlides.includes(ch)) return makeStaticResult(ch, 'noSlides');
    if (skipped.includes(ch)) return makeStaticResult(ch, 'cached');
    return resultsMap[ch];
  });

  // Summary
  let okCount = 0;
  let failCount = 0;
  let totalSlides = 0;
  let totalSize = 0;
  for (const r of results) {
    if (r.ok) {
      const tag = r.noSlides ? ' (no slides yet)' : (r.cached ? ' (cached)' : '');
      console.log(`  \u2705 ${r.chapter}: ${r.slideCount} slides (${r.sizeMB} MB)${tag}`);
      okCount++;
      totalSlides += r.slideCount === '?' ? 0 : r.slideCount;
      totalSize += parseFloat(r.sizeMB) || 0;
    } else {
      console.log(`  \u274c ${r.chapter}: ${r.error.split('\n')[0]}`);
      failCount++;
    }
  }
  console.log('-'.repeat(60));
  console.log(`  Total: ${okCount} succeeded, ${failCount} failed`);
  console.log(`  Slides: ${totalSlides}  |  Size: ${totalSize.toFixed(2)} MB`);
  console.log('='.repeat(60));

  if (failCount > 0) {
    console.log('\nWARNING: Some chapters failed — Phase 2 may be incomplete.\n');
  }

  return results;
}

/**
 * Create a divider slide (dark background, centered chapter label)
 */
function addDividerSlide(pptx, chapterKey) {
  const slide = pptx.addSlide();
  slide.background = { fill: '0D0D0D' };

  subtitleLabel({
    slide,
    text: chapterTitles[chapterKey] || chapterKey,
    x: 0.5, y: 1.2, w: 6.0, h: 1.0,
    fontSize: 28,
  });

  subtitleLabel({
    slide,
    text: DIVIDER_SUBTITLE,
    x: 0.5, y: 2.2, w: 6.0, h: 0.6,
    fontSize: 16,
    color: '666666',
  });
}

function subtitleLabel({ slide, text, x, y, w, h, fontSize, color = 'EAEAEA' }) {
  slide.addText(text, {
    x, y, w, h, fontSize, color,
    fontFace: 'Segoe UI, Helvetica, sans-serif',
    align: 'center',
    valign: 'middle',
    bold: true,
    lineSpacingMultiple: 1.0,
  });
}

/**
 * Phase 2 — merge all HTML slides across chapters into a single PPTX
 */
async function phase2MergeAll(browser) {
  console.log('\n' + '='.repeat(60));
  console.log('PHASE 2: Merging all chapters into one combined PPTX');
  console.log('='.repeat(60));

  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = `${DECK_TITLE} — Complete`;

  let totalSlides = 0;
  const chapterSummary = [];

  for (const chapterKey of chapterOrder) {
    const slidesDir = path.join(resolveChapterDir(chapterKey), 'slides');

    if (!fs.existsSync(slidesDir)) {
      console.log(`  \u26a0 Skipping ${chapterKey} — no slides directory`);
      continue;
    }

    const slideFiles = fs.readdirSync(slidesDir)
      .filter(f => f.endsWith('.html'))
      .sort();

    if (slideFiles.length === 0) {
      console.log(`  \u26a0 Skipping ${chapterKey} — no HTML slides`);
      continue;
    }

    // Add a section divider slide before each chapter
    addDividerSlide(pptx, chapterKey);
    totalSlides++; // count the divider

    console.log(`\n  [${chapterKey}] ${slideFiles.length} slides`);

    for (let i = 0; i < slideFiles.length; i++) {
      const slideFile = slideFiles[i];
      const slidePath = path.join(slidesDir, slideFile);
      const slideNum = i + 1;

      try {
        await html2pptx(slidePath, pptx, { browser });
        totalSlides++;
      } catch (err) {
        console.log(`    \u274c [${slideNum}/${slideFiles.length}] ${slideFile}: ${err.message.split('\n')[0]}`);
      }

      process.stdout.write(`    \r  [\u2705 ${slideNum}/${slideFiles.length}] ${slideFile}\r`);
    }
    // newline after the last overwrite
    console.log(`    \r  Done: ${slideFiles.length} slides added for ${chapterKey}   `);

    chapterSummary.push({
      chapter: chapterKey,
      slides: slideFiles.length,
      totalIncludingDivider: slideFiles.length + 1,
    });
  }

  // Nothing to merge (e.g. a project whose chapters have no slides yet) —
  // don't write an empty deck, just report.
  if (totalSlides === 0) {
    console.log('\n  No slides found across this project — skipping merged deck.');
    console.log('='.repeat(60));
    return { totalSlides: 0, empty: true };
  }

  // Write merged file to temp path — rename to final happens in main()
  const finalPath = OUTPUT_FILE;
  const tmpPath = finalPath.replace('.pptx', '-tmp.pptx');
  // Clean up stale temp file from previous failed build
  try {
    fs.unlinkSync(tmpPath);
  } catch { /* no stale file */ }
  try {
    fs.unlinkSync(tmpPath + '.pptx');
  } catch { /* no stale file */ }

  await pptx.writeFile({ fileName: tmpPath });

  // Print merged summary (will be finalized in main() after rename)
  console.log('\n' + '─'.repeat(60));
  console.log('MERGED PPTX SUMMARY');
  console.log('─'.repeat(60));
  for (const cs of chapterSummary) {
    console.log(`  ${cs.chapter}: ${cs.slides} slides (+ 1 divider)`);
  }
  console.log('─'.repeat(60));
  console.log(`  Total slides (incl. dividers): ${totalSlides}`);
  console.log('='.repeat(60));

  return { totalSlides };
}

/**
 * Write a PPTX file atomically: write to .tmp, then rename on success.
 * If the write crashes, the .tmp file is left behind but the original is intact.
 * On next call, the .tmp file is deleted.
 */
async function writePptxAtomic(pptx, finalPath) {
  const tmpPath = finalPath + '.tmp';
  // Clean up stale temp file from previous failed build
  try {
    fs.unlinkSync(tmpPath);
  } catch { /* no stale file */ }

  await pptx.writeFile({ fileName: tmpPath });
  fs.renameSync(tmpPath, finalPath);
}

/**
 * Print the resolved build plan without building (--list / dry run).
 */
function printPlan() {
  console.log('\nBuild plan (dry run — nothing is built):\n');
  for (const ch of chapterOrder) {
    const slidesDir = path.join(resolveChapterDir(ch), 'slides');
    const htmlCount = fs.existsSync(slidesDir)
      ? fs.readdirSync(slidesDir).filter(f => f.endsWith('.html')).length : 0;
    let status;
    if (!isChapterBuildable(ch)) status = 'no slides yet';
    else if (isChapterCacheHit(ch)) status = 'cached (up-to-date)';
    else status = 'will build';
    console.log(`  ${ch.padEnd(30)} ${String(htmlCount).padStart(3)} slides   ${status}`);
  }
  console.log(`\n  → merged output: ${path.basename(OUTPUT_FILE)}\n`);
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const noParallel = args.includes('--no-parallel');
  const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || String(MAX_PARALLEL), 10);

  console.log('\n' + '='.repeat(60));
  console.log(`PROJECT: ${projectName}  —  ${DECK_TITLE}`);
  console.log(`  Root:     ${path.relative(__dirname, projectRoot) || '.'}`);
  console.log(`  Output:   ${path.basename(OUTPUT_FILE)}`);
  console.log(`  Cache:    ${path.basename(CACHE_FILE)}`);
  console.log(`  Chapters: ${chapterOrder.length}`);
  console.log('='.repeat(60));

  if (args.includes('--list')) {
    printPlan();
    return;
  }

  // Phase 1
  const individualResults = await phase1BuildIndividual({
    parallel: !noParallel,
    concurrency,
    force,
  });

  // Phase 2 — launch ONE browser, reuse across all slides
  console.log('\nLaunching browser for Phase 2 merge ...');
  const launchOptions = {
    env: {
      TMPDIR: process.env.TMPDIR || (
        process.platform === 'win32'
          ? (process.env.TEMP || 'C:\\Windows\\Temp')
          : '/tmp'
      ),
    },
  };
  if (process.platform === 'darwin') launchOptions.channel = 'chrome';

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
    registerShutdown(browser);
  } catch (err) {
    console.error(`ERROR: Failed to launch browser: ${err.message}`);
    process.exit(1);
  }

  let mergeResult;
  try {
    mergeResult = await phase2MergeAll(browser);

    if (mergeResult.empty) {
      // No slides were merged — nothing to rename.
      return;
    }

    // Atomic write: rename from tmp to final on success
    const finalPath = OUTPUT_FILE;
    const tmpPath = finalPath.replace('.pptx', '-tmp.pptx');

    const actualTmpPath = fs.existsSync(tmpPath) ? tmpPath : (tmpPath + '.pptx');
    if (!fs.existsSync(actualTmpPath)) {
      throw new Error(`Failed to find generated PPTX at ${tmpPath}`);
    }

    const stats = fs.statSync(actualTmpPath);
    
    // Attempt to unlink final path, handle EBUSY gracefully
    let safeFinalPath = finalPath;
    let renameSuccess = false;
    
    // On Windows, the file handle might take a few milliseconds to be fully released by pptxgenjs
    for (let i = 0; i < 3; i++) {
      try {
        if (fs.existsSync(safeFinalPath)) fs.unlinkSync(safeFinalPath);
        fs.renameSync(actualTmpPath, safeFinalPath);
        renameSuccess = true;
        break;
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
          if (i === 0) {
             const timestamp = new Date().getTime();
             safeFinalPath = finalPath.replace('.pptx', `-${timestamp}.pptx`);
             console.warn(`\n[WARNING] Target file is locked by another program (e.g. PowerPoint).`);
             console.warn(`Saving to alternate path: ${path.basename(safeFinalPath)}\n`);
          }
          // Wait 500ms before retrying the rename (in case the lock was from writing tmpPath)
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          throw err;
        }
      }
    }
    
    if (!renameSuccess) {
      throw new Error(`Failed to rename file to ${safeFinalPath} after retries due to persistent locking.`);
    }

    // Update mergeResult with the correct file path
    mergeResult.outputFile = safeFinalPath;
    mergeResult.sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  } finally {
    if (browser && browser.isConnected()) {
      await browser.close();
    }
  }

  // Final combined summary
  console.log('\n' + '='.repeat(60));
  console.log('OVERALL BUILD COMPLETE');
  console.log('='.repeat(60));

  const successCount = individualResults.filter(r => r.ok).length;
  const failCount = individualResults.filter(r => !r.ok).length;
  console.log(`  Phase 1 (individual): ${successCount} succeeded, ${failCount} failed`);

  if (mergeResult) {
    console.log(`  Phase 2 (merged):     ${mergeResult.totalSlides} slides, ${mergeResult.sizeMB} MB`);
    console.log(`  Merged file:          ${mergeResult.outputFile}`);
  }
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Build-all failed:', err.message);
  process.exit(1);
});
