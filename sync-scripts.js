const fs = require('fs');
const path = require('path');

// Regex to extract page number from HTML: <p class="page-num">XX / YY</p>
const pageNumRegex = /<p class="page-num">(\d+)\s*\/\s*\d+<\/p>/;
// Regex to extract chapter tag/title from HTML: <p class="chapter-tag">...</p>
const chapterTagRegex = /<p class="chapter-tag">(?:.*?·\s*)?(.*?)<\/p>/;

function getHtmlSlidesInfo(chapterDir) {
  const slidesDir = path.join(chapterDir, 'slides');
  if (!fs.existsSync(slidesDir)) return [];

  const files = fs.readdirSync(slidesDir)
    .filter(f => f.endsWith('.html'))
    // Sort logically or alphabetically
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  const slidesInfo = files.map((file, index) => {
    const content = fs.readFileSync(path.join(slidesDir, file), 'utf8');
    let title = 'Untitled Slide';
    let pageNumStr = String(index + 1).padStart(2, '0');
    
    // Try to extract explicit page number from HTML if exists
    const pageNumMatch = content.match(pageNumRegex);
    if (pageNumMatch) {
      pageNumStr = pageNumMatch[1];
    }
    
    // Try to extract title from chapter tag
    const titleMatch = content.match(chapterTagRegex);
    if (titleMatch) {
      title = titleMatch[1].trim();
    } else {
      // Fallback to filename parsing
      // e.g. slide-ch00-01-codebase-coverage.html -> codebase-coverage
      const parts = file.split('-');
      if (parts.length >= 4) {
        title = parts.slice(3).join('-').replace('.html', '').replace(/-/g, ' ');
      } else {
        title = file.replace('.html', '');
      }
    }
    
    return {
      filename: file,
      pageNum: pageNumStr,
      title: title,
      index: index + 1
    };
  });

  return slidesInfo;
}

function syncScriptMd(chapterDir) {
  const scriptPath = path.join(chapterDir, 'script.md');
  if (!fs.existsSync(scriptPath)) {
    console.log(`[Skip] No script.md found in ${chapterDir}`);
    return;
  }

  const slidesInfo = getHtmlSlidesInfo(chapterDir);
  if (slidesInfo.length === 0) {
    console.log(`[Skip] No HTML slides found in ${chapterDir}`);
    return;
  }

  let content = fs.readFileSync(scriptPath, 'utf8');

  // Update total duration / slide count header
  // format: ## ⏱️ Total Duration: ~XX minutes | 📑 YY Slides | 📝 ~ZZZZ words
  content = content.replace(/📑 \d+ Slides/, `📑 ${slidesInfo.length} Slides`);

  // Replace slide headers dynamically.
  // Typical format in script.md:
  // [02:00] Slide 01: Codebase Coverage
  // or just `Slide 01:` or `### Slide 01:`
  
  // We need to build a map of old slide indices to new ones if possible, but that's hard if order changed completely.
  // Instead, let's just make sure we print a report or auto-patch the headers if they are sequential.
  // Actually, we can use regex to find all `Slide XX:` and map them.
  
  const slideHeaderRegex = /(?:\[\d+:\d+\]\s*)?(?:###\s*)?Slide (\d+[a-z]?):/g;
  
  // Let's do a dry run check
  const existingHeaders = [...content.matchAll(slideHeaderRegex)];
  
  if (existingHeaders.length !== slidesInfo.length) {
    console.warn(`[Warning] ${path.basename(chapterDir)}: script.md has ${existingHeaders.length} slide headers, but found ${slidesInfo.length} HTML slides. Manual sync required.`);
    
    // Auto-append missing headers as a skeleton at the bottom?
    // We'll just list the expected structure to help the user.
    let expectedStructure = `\n\n<!-- 
AUTO-GENERATED SLIDE SYNC REFERENCE
Please ensure your script.md contains the following headers:
${slidesInfo.map(s => `Slide ${s.pageNum}: ${s.title}`).join('\n')}
-->`;
    
    // Remove old auto-generated reference if exists
    content = content.replace(/<!--\s*AUTO-GENERATED SLIDE SYNC REFERENCE[\s\S]*?-->/, '').trim();
    content += expectedStructure;
  } else {
    // If counts match exactly, we assume they map 1:1 in order.
    // Let's rewrite the headers to perfectly match the HTML filenames/numbers
    let replaceIndex = 0;
    content = content.replace(/((\[\d+:\d+\]\s*)?(?:###\s*)?Slide )\d+[a-z]?:(.*?)(?=\n)/g, (match, prefix, time, oldTitle) => {
      if (replaceIndex < slidesInfo.length) {
        const info = slidesInfo[replaceIndex++];
        return `${prefix}${info.pageNum}: ${info.title}`;
      }
      return match;
    });
    console.log(`[Success] Synced ${slidesInfo.length} slides in ${path.basename(chapterDir)}/script.md`);
  }

  fs.writeFileSync(scriptPath, content);
}

// Process all chapters
const rootDir = process.cwd();
const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('ch'))
  .map(dirent => path.join(rootDir, dirent.name));

dirs.forEach(dir => {
  syncScriptMd(dir);
});

console.log('Script sync complete.');