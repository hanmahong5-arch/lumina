---
name: pptx-skill
description: Convert HTML slides to PowerPoint (.pptx) presentations with accurate positioning, CSS support, and image extraction. Use when the user wants to generate or modify PPTX files based on HTML layouts.
---

# HTML to PPTX Generator

Generate PowerPoint (.pptx) files from HTML slides using Playwright and PptxGenJS.

## Features
- **Accurate Positioning**: Extracts precise `x`, `y`, `width`, and `height` from the DOM.
- **CSS Support**: Parses colors, fonts, backgrounds, borders, and shadows (on `<div>` containers).
- **Inline Formatting**: Handles `<b>`, `<i>`, `<u>`, `<span>`, `<strong>`, `<em>` inside text tags.
- **Lists**: Correctly parses `<ul>` and `<ol>` into native PowerPoint bullets.
- **Shapes & Images**: Extracts `<div>` with backgrounds/borders as shapes and `<img>` tags as images.
- **Placeholders**: Extracts elements with `.placeholder` class for advanced charts integration.
- **PPTX Animations (New!)**: Supports native PowerPoint animations via `data-anim` attributes.

## Usage

This skill relies on the core script `pptx/scripts/html2pptx.js`, which exports an async function taking the HTML file path and a PPTX instance.

### Example Generation Script
To build a chapter, you can use the `build-chapter.js` script in the root, or invoke the script directly:

```javascript
const pptxgen = require('pptxgenjs');
const html2pptx = require('./pptx/scripts/html2pptx.js');

async function build() {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';

  // Process a slide
  await html2pptx('path/to/slide.html', pptx);

  // Write the file
  await pptx.writeFile({ fileName: 'output.pptx' });
}

build();
```

## CSS Mapping Rules

When modifying HTML slides, adhere to these limitations, as PowerPoint does not support all CSS properties natively:

1. **Text Wrappers**: Text must be wrapped in block-level tags like `<p>`, `<h1>` to `<h6>`, or list tags. 
2. **Span Restrictions**: `<span>` is supported for inline formatting, but it should not be used as a standalone block element directly under a `<div>` for text unless there's no other choice. It's now correctly processed by `html2pptx.js` but block tags are preferred.
3. **Margin / Padding**: 
   - `padding` on text elements maps to PowerPoint's internal margins.
   - `margin` on text elements maps to spacing before/after paragraphs.
4. **Borders / Backgrounds**: 
   - Supported ONLY on block-level `<div>` elements, not on `<p>` or inline tags.
   - If a text box needs a background, use a `<div>` wrapping the `<p>`.
5. **Single Line Text Width**: `html2pptx.js` automatically expands single-line text widths by 5% to prevent PowerPoint from accidentally wrapping text that appears as a single line in the browser.
6. **Images**: Prefer local paths (relative) or `file://` URIs for `<img src="...">`.

## Animation Mapping Rules (Dynamic Pacing)

To support progressive visual storytelling (e.g., revealing bullet points or diagrams one by one matching a script), use the following HTML data attributes. These map directly to PptxGenJS native animations:

- `data-anim="fade"` (or `fly`, `wipe`, `zoom`): Sets the animation type on the element.
- `data-anim-order="1"`: Controls the sequence index of the animation. Items with the same order appear together.
- `data-anim-delay="0.5"`: Adds a delay (in seconds) before the animation triggers.

Example of a staggered bullet list:
```html
<ul>
  <li data-anim="fade" data-anim-order="1">Point 1 (Appears on first click)</li>
  <li data-anim="fade" data-anim-order="2">Point 2 (Appears on second click)</li>
</ul>
```

## Troubleshooting

- **"File not found" errors on Windows**: The path logic automatically resolves `.tmp.pptx` handling natively.
- **Truncated text**: Increase the bounding box width or reduce the font size in the HTML.
- **Missing content**: Ensure the content is not wrapped inside a CSS `display: none` or positioned outside the `16:9` canvas (720pt x 405pt).
