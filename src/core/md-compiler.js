const fs = require('fs');
const path = require('path');
const fm = require('front-matter');
const { marked } = require('marked');

// Configure marked to be strict but clean
marked.use({
  mangle: false,
  headerIds: false
});

/**
 * Compiles a Markdown file into multiple HTML slides.
 * Each slide is separated by `---` on its own line.
 * Frontmatter is supported for each slide.
 */
function compileMarkdownToHtml(chapterDir, mdFileName = 'slides.md') {
  const mdPath = path.join(chapterDir, mdFileName);
  if (!fs.existsSync(mdPath)) return false;

  console.log(`\n📄 [Lumina MDX Engine] Compiling ${mdFileName}...`);
  let mdContent = fs.readFileSync(mdPath, 'utf8');

  // Normalize line endings to avoid regex issues
  mdContent = mdContent.replace(/\r\n/g, '\n');

  // Use a proper regex to split by --- while handling potential frontmatter at the top
  // The first --- at the very start of the file belongs to the first slide's frontmatter.
  // We want to split on --- that ARE NOT at the start of the file if they are slide separators.
  
  // Actually, a simpler way:
  // If the file starts with ---, it's FM. 
  // We can prefix the file with a dummy delimiter if needed, or just be smart.
  
  // Use \n\n---\n\n as the slide delimiter to avoid confusion with internal frontmatter ---
  const rawBlocks = mdContent.split(/\n\n---\n\n/);
  
  // If the first block starts with ---, it means it's the very first slide's frontmatter
  // and my split missed it because it's at index 0.
  // Actually, if I split by \n---\n, the first slide might still have its leading ---.
  
  const slidesDir = path.join(chapterDir, 'slides');
  if (!fs.existsSync(slidesDir)) {
    fs.mkdirSync(slidesDir, { recursive: true });
  } else {
    // Clean old generated files
    fs.readdirSync(slidesDir).filter(f => f.endsWith('.html')).forEach(f => fs.unlinkSync(path.join(slidesDir, f)));
  }

  let slideCount = 0;
  let currentChapterTag = path.basename(chapterDir);

  for (let block of rawBlocks) {
    let blockToParse = block.trim();
    if (!blockToParse) continue;

    // If the block doesn't start with --- but the original file did for the first block,
    // front-matter.js expects the leading ---.
    if (slideCount === 0 && mdContent.startsWith('---') && !blockToParse.startsWith('---')) {
        blockToParse = '---\n' + blockToParse;
    } else if (!blockToParse.startsWith('---')) {
        // Most blocks won't start with --- after the split unless they have FM.
        // front-matter.js needs the delimiters.
        // We can just try to parse it. If it fails, it assumes no FM.
    }

    const { attributes, body } = fm(blockToParse);
    slideCount++;
    const slideNum = String(slideCount).padStart(2, '0');

    // Defaults
    const layout = attributes.layout || 'default';
    const bgPrimary = attributes.bg || 'var(--bg-primary)';
    const chapterTag = attributes.chapterTag || currentChapterTag;
    const title = attributes.title || `Slide ${slideNum}`;
    const footer = attributes.footer || 'Lumina Studio v3.0';

    const htmlBody = marked.parse(body.trim());
    const processedHtml = processLuminaTags(htmlBody);

    const finalHtml = wrapInLuminaTemplate({
      htmlContent: processedHtml,
      layout,
      bgPrimary,
      chapterTag,
      pageNum: `${slideNum} / {{TOTAL_SLIDES}}`, // Placeholder for second pass
      title,
      footer
    });

    const outPath = path.join(slidesDir, `slide-${currentChapterTag}-${slideNum}-${layout}.html`);
    fs.writeFileSync(outPath, finalHtml, 'utf8');
  }

  // Second pass: Update TOTAL_SLIDES placeholder
  const generatedFiles = fs.readdirSync(slidesDir).filter(f => f.includes(`slide-${currentChapterTag}-`));
  generatedFiles.forEach(f => {
    const p = path.join(slidesDir, f);
    let content = fs.readFileSync(p, 'utf8');
    content = content.replace(/{{TOTAL_SLIDES}}/g, slideCount);
    fs.writeFileSync(p, content, 'utf8');
  });

  console.log(`✅ [Lumina MDX Engine] Generated ${slideCount} HTML slides.`);
  return true;
}

function processLuminaTags(html) {
  let out = html.replace(
    /<Excalidraw\s+src="([^"]+)"\s*(?:height="([^"]+)")?\s*\/>/gi, 
    (match, src, height) => {
      const h = height || '310pt';
      const imgSrc = src.startsWith('..') ? src : `../diagrams/${src}`;
      return `<div style="display:flex; justify-content:center;"><img src="${imgSrc}" style="width:640pt; height:${h}; object-fit:contain;"></div>`;
    }
  );

  out = out.replace(
    /<Anim\s+order="(\d+)"\s+type="([^"]+)">([\s\S]*?)<\/Anim>/gi,
    (match, order, type, content) => {
      // Stripping potential <p> wrapper added by marked for custom tags
      const inner = content.trim().replace(/^<p>|<\/p>$/g, '');
      return `<div data-anim="${type || 'fade'}" data-anim-order="${order}">${inner}</div>`;
    }
  );

  return out;
}

function wrapInLuminaTemplate({ htmlContent, layout, bgPrimary, chapterTag, pageNum, title, footer }) {
  let contentClass = layout === 'cover' ? 'slide-cover' : (layout === 'compact' ? 'slide-content-compact' : 'slide-content');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<link rel="stylesheet" href="../../design-system/base-style-v2.css">
<style>
  /* Auto-fix for common Markdown to HTML issues in PPTX mapping */
  .slide-content * { margin-top: 0 !important; }
  .slide-content h2 { margin-bottom: 12pt !important; }
  .slide-content p, .slide-content li { margin-bottom: 8pt !important; }
</style>
</head><body style="background:${bgPrimary};">

${layout !== 'cover' ? `
<div class="header-bar">
  <p class="chapter-tag">${chapterTag}</p>
  <p class="page-num">${pageNum}</p>
</div>
` : ''}

<div class="${contentClass}">
  ${htmlContent}
</div>

${layout !== 'cover' ? `
<div class="slide-footer">
  <p>${footer}</p>
  <p>${title}</p>
</div>
` : ''}

</body></html>`;
}

module.exports = { compileMarkdownToHtml };