/**
 * renumber-pages.js — normalize the "NN / TOTAL" page numbers in a chapter's slides
 * after inserting or removing slides. Alphabetical filename order = slide order.
 * Cover slides (no .page-num / .slide-footer) are counted in TOTAL but carry no
 * number to write, so they are skipped automatically.
 *
 * Usage:
 *   node renumber-pages.js <chapter-dir> [<chapter-dir> ...]
 *   e.g. node renumber-pages.js codex-cli-teardown/ch01-core-engine
 */
'use strict';
const fs = require('fs');
const path = require('path');

const pad = (n) => String(n).padStart(2, '0');

function renumber(dir) {
  const slidesDir = path.join(dir, 'slides');
  if (!fs.existsSync(slidesDir)) { console.error(`  skip (no slides/): ${dir}`); return; }
  const files = fs.readdirSync(slidesDir).filter((f) => f.endsWith('.html')).sort();
  const tt = pad(files.length);
  let changed = 0;
  files.forEach((f, i) => {
    const pos = pad(i + 1);
    const p = path.join(slidesDir, f);
    const before = fs.readFileSync(p, 'utf8');
    const after = before
      // header bar: <p class="page-num">NN / TT</p>
      .replace(/(<p class="page-num">)\s*\d+\s*\/\s*\d+\s*(<\/p>)/g, `$1${pos} / ${tt}$2`)
      // footer: <div class="slide-footer"><p>brand</p><p>NN / TT</p>...
      .replace(/(<div class="slide-footer"><p>[^<]*<\/p><p>)\s*\d+\s*\/\s*\d+\s*(<\/p>)/g, `$1${pos} / ${tt}$2`);
    if (after !== before) { fs.writeFileSync(p, after); changed++; }
  });
  console.log(`${path.basename(dir)}: ${files.length} slides, ${changed} page-numbered`);
}

const dirs = process.argv.slice(2);
if (!dirs.length) { console.error('Usage: node renumber-pages.js <chapter-dir> ...'); process.exit(1); }
dirs.forEach(renumber);
