/**
 * Build script: Compile HTML slides into a PowerPoint (.pptx) file for a given chapter.
 *
 * Usage:
 *   node build-chapter.js <chapter-dir-name> [options]
 *   e.g. node build-chapter.js ch01-core-engine
 *        node build-chapter.js ch01-core-engine --strict
 *
 * Options:
 *   --strict    Fail immediately on the first slide error (original behavior)
 *   --tolerant  Continue past errors and collect them (default)
 *
 * Requirements:
 *   - pptxgenjs, playwright, sharp (globally installed)
 *   - html2pptx.js library
 */

const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');
const { chromium } = require('playwright');

// Path to the html2pptx library
const html2pptx = require(
  path.resolve(__dirname, 'pptx-skill', 'pptx', 'scripts', 'html2pptx.js')
);
const { compileMarkdownToHtml } = require('./src/core/md-compiler.js');

// Graceful shutdown: close browser on SIGINT/SIGTERM
let activeBrowser = null;

function registerCleanup(browser) {
  activeBrowser = browser;
  const cleanup = async (signal) => {
    if (activeBrowser?.isConnected()) {
      console.warn(`\nCaught ${signal}, closing browser...`);
      try { await activeBrowser.close(); } catch { /* ignore */ }
    }
    process.exit(130);
  };
  process.once('SIGINT', () => cleanup('SIGINT'));
  process.once('SIGTERM', () => cleanup('SIGTERM'));
}

async function buildChapter(chapterName, options = {}) {
  const { strict = false, browser: sharedBrowser = null } = options;

  const chapterDir = path.resolve(__dirname, chapterName);
  const slidesDir = path.join(chapterDir, 'slides');
  const outputFile = path.join(chapterDir, `${chapterName}.pptx`);

  // Run Lumina MDX Engine if a slides.md file is present
  compileMarkdownToHtml(chapterDir, 'slides.md');

  // Verify the slides directory exists
  if (!fs.existsSync(slidesDir)) {
    console.error(`ERROR: Slides directory not found: ${slidesDir}`);
    process.exit(1);
  }

  // List all *.html files, sorted alphabetically (supports NN-name.html naming convention)
  const slideFiles = fs.readdirSync(slidesDir)
    .filter(f => f.endsWith('.html'))
    .sort();

  if (slideFiles.length === 0) {
    console.error(`ERROR: No *.html files found in ${slidesDir}`);
    process.exit(1);
  }

  console.log(`\n=== Building ${chapterName} ===`);
  console.log(`Found ${slideFiles.length} slides`);

  // Create PptxGenJS presentation with 16:9 layout
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = chapterName;

  // Use shared browser if provided (e.g. by build-all.js), otherwise launch our own
  let browser;
  let ownedBrowser = null;
  if (sharedBrowser) {
    browser = sharedBrowser;
  } else {
    const launchOptions = { env: { TMPDIR: process.env.TMPDIR || (process.platform === 'win32' ? process.env.TEMP || 'C:\\Windows\\Temp' : '/tmp') } };
    if (process.platform === 'darwin') launchOptions.channel = 'chrome';
    ownedBrowser = await chromium.launch(launchOptions);
    browser = ownedBrowser;
    registerCleanup(browser);
  }

  const errors = [];
  let successCount = 0;

  try {
    // Process each slide
    for (let i = 0; i < slideFiles.length; i++) {
      const slideFile = slideFiles[i];
      const slidePath = path.join(slidesDir, slideFile);
      const slideNum = i + 1;

      console.log(`  [${slideNum}/${slideFiles.length}] ${slideFile}`);

      try {
        // Pass the shared browser so html2pptx doesn't launch/close its own
        await html2pptx(slidePath, pptx, { browser });
        successCount++;
      } catch (err) {
        const msg = err.message;
        console.error(`    ERROR: ${msg}`);
        if (strict) {
          throw err; // Fail immediately in strict mode
        }
        errors.push({ file: slideFile, error: msg });
      }
    }
  } finally {
    if (ownedBrowser) {
      await ownedBrowser.close();
    }
    // If using a shared browser, the caller is responsible for closing it
  }

  // Save the presentation: pptxgenjs v4 adds .pptx automatically if missing,
  // so we specify the base name and it will append the extension.
  // Actually, let's just write to the final path directly to simplify,
  // or use a name that doesn't conflict.
  const baseTmpName = chapterName + '-tmp';
  const tmpFile = path.join(chapterDir, baseTmpName + '.pptx');
  
  try {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  } catch { /* ignore */ }

  await pptx.writeFile({ fileName: tmpFile });
  
  // Since we provided a .pptx extension, it might still append another one or use it as is.
  // Based on test, if we provide 'test.pptx.tmp', it becomes 'test.pptx.tmp.pptx'.
  // If we provide 'test.pptx', it stays 'test.pptx' (usually).
  
  // Helper to safely rename with retries for Windows EBUSY locks
  const safeRename = async (source, target) => {
    let safeTarget = target;
    let success = false;
    for (let i = 0; i < 3; i++) {
      try {
        if (fs.existsSync(safeTarget)) fs.unlinkSync(safeTarget);
        fs.renameSync(source, safeTarget);
        success = true;
        break;
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
          if (i === 0) {
            const timestamp = new Date().getTime();
            safeTarget = target.replace('.pptx', `-${timestamp}.pptx`);
            console.warn(`\n[WARNING] Target file is locked. Saving to alternate path: ${path.basename(safeTarget)}\n`);
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          throw err;
        }
      }
    }
    if (!success) throw new Error(`Failed to rename file to ${safeTarget} due to persistent locking.`);
    return safeTarget;
  };

  let finalOutputFile = outputFile;

  if (fs.existsSync(tmpFile)) {
    if (tmpFile !== outputFile) {
      finalOutputFile = await safeRename(tmpFile, outputFile);
    }
  } else {
    // If it appended .pptx anyway
    const appendedFile = tmpFile + '.pptx';
    if (fs.existsSync(appendedFile)) {
      finalOutputFile = await safeRename(appendedFile, outputFile);
    } else {
      throw new Error(`Failed to create PPTX file at ${tmpFile}`);
    }
  }

  // Report file size
  const stats = fs.statSync(finalOutputFile);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  console.log(`\n  Output: ${finalOutputFile}`);
  console.log(`  Slides: ${successCount}/${slideFiles.length}`);
  console.log(`  Size:   ${sizeMB} MB`);

  // Report any errors that were tolerated
  if (errors.length > 0) {
    console.log(`\n  Warnings: ${errors.length} slide(s) failed (skipped):`);
    for (const e of errors) {
      console.log(`    - ${e.file}: ${e.error.split('\n')[0]}`);
    }
  }

  return { outputFile: finalOutputFile, slideCount: successCount, sizeMB, errors };
}

// Export for build-all.js
module.exports = { buildChapter };

// Main entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const chapterName = args.find(a => !a.startsWith('--'));

  if (!chapterName) {
    console.error('Usage: node build-chapter.js <chapter-dir-name> [--strict]');
    console.error('  e.g. node build-chapter.js ch01-core-engine');
    console.error('       node build-chapter.js ch01-core-engine --strict');
    process.exit(1);
  }

  const strict = args.includes('--strict');
  if (strict) {
    console.log('  Mode: strict (fail-fast)');
  }

  buildChapter(chapterName, { strict })
    .then(result => {
      if (result.errors.length > 0) {
        console.log(`\nBuild completed with ${result.errors.length} error(s). Check output above.`);
        process.exit(1);
      } else {
        console.log(`\nDone! Created ${result.outputFile}`);
      }
    })
    .catch(err => {
      console.error(`\nBuild failed: ${err.message}`);
      process.exit(1);
    });
}
