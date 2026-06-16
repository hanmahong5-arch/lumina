/**
 * Validate all HTML slides across chapters using the full html2pptx pipeline.
 *
 * Usage:
 *   node validate-all.js <ch1> <ch2> ...
 *   e.g. node validate-all.js ch01-core-engine ch02-multi-agent
 *
 * Exits with code 0 if all slides valid, 1 if any errors found.
 * Shares a single Playwright browser across all chapters for performance.
 */
const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');
const { chromium } = require('playwright');
const html2pptx = require(
  path.resolve(__dirname, 'pptx-skill', 'pptx', 'scripts', 'html2pptx.js')
);

async function validateChapter(chapterName, browser, root = '.') {
  const slidesDir = path.resolve(__dirname, root, chapterName, 'slides');
  if (!fs.existsSync(slidesDir)) {
    console.log(`  WARN: Slides directory not found: ${slidesDir}`);
    return [];
  }

  // Match every *.html slide. (Previously required a `slide-` prefix, which
  // silently skipped chapters like ch07-memory that use bare NN-*.html names.)
  const slideFiles = fs.readdirSync(slidesDir)
    .filter(f => f.endsWith('.html'))
    .sort();

  const errors = [];
  for (const slideFile of slideFiles) {
    const slidePath = path.join(slidesDir, slideFile);
    const pptx = new pptxgen();
    pptx.layout = 'LAYOUT_16x9';
    try {
      await html2pptx(slidePath, pptx, { browser });
    } catch (err) {
      errors.push({ file: slideFile, error: err.message });
    }
  }
  return errors;
}

(async () => {
  const args = process.argv.slice(2);

  // --project=<name> selects a content tree from lumina.config.js;
  // --root=<dir> overrides the scan root directly. Positional args = chapter dirs.
  let root = '.';
  const pjEq = args.find(a => a.startsWith('--project='));
  const rootEq = args.find(a => a.startsWith('--root='));
  if (rootEq) root = rootEq.split('=')[1];

  let chapters = args.filter(a => !a.startsWith('--'));

  if (pjEq) {
    const projectName = pjEq.split('=')[1];
    const config = require(path.resolve(__dirname, 'lumina.config.js'));
    const project = config.projects && config.projects[projectName];
    if (!project) {
      console.error(`Unknown project "${projectName}". Available: ${Object.keys(config.projects || {}).join(', ')}`);
      process.exit(1);
    }
    root = project.root || '.';
    if (chapters.length === 0) chapters = project.chapters.map(c => c.id);
  }

  if (chapters.length === 0) {
    // Auto-detect all chapter directories starting with 'ch' under the root
    const scanDir = path.resolve(__dirname, root);
    chapters = fs.readdirSync(scanDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('ch'))
      .map(dirent => dirent.name)
      .sort();

    if (chapters.length === 0) {
      console.error('No chapter directories found.');
      process.exit(1);
    }
    console.log(`Auto-detected ${chapters.length} chapters to validate.`);
  }

  // Launch a single browser shared across all chapters (performance)
  const launchOptions = {
    env: { TMPDIR: process.env.TMPDIR || (process.platform === 'win32' ? process.env.TEMP || 'C:\\Windows\\Temp' : '/tmp') }
  };
  if (process.platform === 'darwin') launchOptions.channel = 'chrome';

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (err) {
    console.error(`ERROR: Failed to launch browser: ${err.message}`);
    process.exit(1);
  }

  let totalErrors = 0;
  let totalSlides = 0;

  try {
    for (const ch of chapters) {
      console.log(`\n=== ${ch} ===`);
      const errors = await validateChapter(ch, browser, root);
      if (errors.length === 0) {
        console.log('  All slides valid!');
      } else {
        for (const e of errors) {
          console.log(`\n  FILE: ${e.file}`);
          console.log(`  ${e.error}`);
        }
        totalErrors += errors.length;
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\nSummary: ${totalErrors} error(s) found`);
  process.exit(totalErrors > 0 ? 1 : 0);
})();
