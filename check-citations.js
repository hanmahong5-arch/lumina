/**
 * check-citations.js — verify that the source-code citations in chapter scripts
 * still resolve against the pinned upstream source tree.
 *
 * A teardown's credibility rests on its `file:line` references being accurate.
 * Upstream code drifts; this is the freshness gate that catches it.
 *
 * For each project in lumina.config.js that declares a `source` block, every
 * citation found in its chapters' script.md is checked against the local clone
 * of the upstream repo at the pinned commit:
 *   - the source tree exists and sits at the pinned commit (else: actionable error)
 *   - each cited file resolves (exact path, or unique basename match)
 *   - each cited line / range falls inside the file
 *
 * Projects WITHOUT a `source` block (e.g. the Claude Code teardown, whose
 * "source" is reverse-engineered and has no canonical public tree) are reported
 * as UNVERIFIED and skipped — never silently passed, never falsely failed.
 *
 * Citation grammar understood (all may be wrapped in backticks):
 *   path/to/file.ts                 (file only — existence checked, no line check)
 *   path/to/file.ts:184             (single line)
 *   withRetry.ts:170-178            (range; bare filename → unique-basename search)
 *   protocol.rs:~1296               (~ = approximate; range-checked, flagged ~)
 *   `src/QueryEngine.ts` 第184行     (Chinese line ref: 第N行 / 第N-M行)
 *
 * Usage:
 *   node check-citations.js                 # all projects that declare a source
 *   node check-citations.js --project=codex # one project
 *   node check-citations.js --all           # explicit all (same as default)
 *
 * Exit 0 if every configured project verifies (or has no source tree to verify
 * against); exit 1 on any hard failure: missing source tree, commit drift,
 * file-not-found, or line-out-of-range. Soft signals (ambiguous basename,
 * approximate line, path-only) are warnings and do not fail the run.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const config = require(path.resolve(__dirname, 'lumina.config.js'));

// File extensions we treat as source-code citations. Anything ending in one of
// these (optionally followed by :line) is extracted; prose dir refs like
// `src/multi-agent/` have no extension and are correctly ignored.
const SOURCE_EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'py', 'go', 'rb', 'json', 'toml'];

// Directories never worth walking when indexing a source tree.
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.next', 'out', 'coverage']);

const sym = { ok: '✓', bad: '✗', warn: '⚠', info: 'ℹ', approx: '~' };

// ---------------------------------------------------------------------------
// Citation extraction
// ---------------------------------------------------------------------------

function buildCitationRegex() {
  // Longest extension first so `js` can't pre-empt `json`/`jsx`; the trailing
  // lookahead is the real guard (rejects `package.js` carved out of `package.json`).
  const exts = SOURCE_EXTS.slice().sort((a, b) => b.length - a.length).join('|');
  // 1: path   2: '~' or ''   3: first line   4: end line (range)
  return new RegExp(
    '([A-Za-z0-9_@][\\w./-]*\\.(?:' + exts + '))(?![A-Za-z0-9_])' +
    '(?::(~?)(\\d+)(?:\\s*[-\\u2013]\\s*(\\d+))?)?',
    'g'
  );
}

function extractCitations(text) {
  const re = buildCitationRegex();
  const cites = [];
  // Per-line so we can tell when a citation sits on a markdown blockquote — a
  // `>` line is quoting external material (e.g. the upstream AGENTS.md), which
  // must not be held to this teardown's own freshness standard.
  for (const line of text.split(/\r\n|\r|\n/)) {
    const quoted = /^\s*>/.test(line);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      const p = m[1];
      const approx = m[2] === '~';
      let lineStart = m[3] ? parseInt(m[3], 10) : null;
      let lineEnd = m[4] ? parseInt(m[4], 10) : null;

      if (lineStart === null) {
        // No colon form — look for a trailing Chinese line ref: `path` 第184行.
        const tail = line.slice(m.index + p.length, m.index + p.length + 20);
        const cn = tail.match(/^`?\s*第\s*(\d+)\s*(?:[-–]\s*(\d+)\s*)?行/);
        if (cn) {
          lineStart = parseInt(cn[1], 10);
          lineEnd = cn[2] ? parseInt(cn[2], 10) : null;
        }
      }
      cites.push({ path: p, lineStart, lineEnd, approx, quoted });
    }
  }
  return cites;
}

// ---------------------------------------------------------------------------
// Source tree indexing & resolution
// ---------------------------------------------------------------------------

function walkTree(root) {
  // Returns { basenames: Map<name, relpath[]>, fileCount }
  const basenames = new Map();
  let fileCount = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        fileCount++;
        const rel = path.relative(root, full).replace(/\\/g, '/');
        const arr = basenames.get(e.name);
        if (arr) arr.push(rel); else basenames.set(e.name, [rel]);
      }
    }
  }
  return { basenames, fileCount };
}

const lineCountCache = new Map();
function countLines(absFile) {
  if (lineCountCache.has(absFile)) return lineCountCache.get(absFile);
  let n = 0;
  try {
    const content = fs.readFileSync(absFile, 'utf8');
    n = content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length;
  } catch {
    n = -1;
  }
  lineCountCache.set(absFile, n);
  return n;
}

function resolveCitation(cite, treeAbs, index) {
  // Suffix match: a cited path resolves to any source file whose relpath equals
  // it or ends with `/<cited path>`. This handles arbitrary left-truncation
  // (`tools/registry.rs` → `codex-rs/core/src/tools/registry.rs`) and bare
  // filenames uniformly. The basename index narrows the search first.
  const base = cite.path.split('/').pop();
  const norm = cite.path.replace(/^\.\//, '');
  const cands = index.basenames.get(base) || [];
  const matches = cands.filter((rel) => rel === norm || rel.endsWith('/' + norm));

  if (matches.length === 0) return { status: 'missing', cite };

  const lcOf = (rel) => countLines(path.join(treeAbs, rel));

  if (cite.lineStart == null) {
    if (matches.length === 1) return { status: 'ok-pathonly', cite, file: matches[0] };
    return { status: 'ambiguous', cite, files: matches };
  }

  // Has line(s). Prefer candidates where the cited line actually fits — this
  // also disambiguates a bare `goals.rs:120` down to the one file long enough.
  const maxCited = cite.lineEnd || cite.lineStart;
  const inRange = matches.filter((rel) => cite.lineStart >= 1 && maxCited <= lcOf(rel));

  if (matches.length === 1) {
    return inRange.length === 1
      ? { status: cite.approx ? 'ok-approx' : 'ok', cite, file: matches[0], lineCount: lcOf(matches[0]) }
      : { status: 'oob', cite, file: matches[0], lineCount: lcOf(matches[0]) };
  }
  if (inRange.length === 1) {
    return { status: cite.approx ? 'ok-approx' : 'ok', cite, file: inRange[0], lineCount: lcOf(inRange[0]), disambig: true };
  }
  if (inRange.length === 0) return { status: 'oob', cite, files: matches };
  return { status: 'ambiguous', cite, files: matches };
}

// ---------------------------------------------------------------------------
// Per-project verification
// ---------------------------------------------------------------------------

function pinnedCommit(source, repoRoot) {
  if (source.commit) return source.commit.trim();
  if (source.commitFile) {
    try {
      const txt = fs.readFileSync(path.resolve(repoRoot, source.commitFile), 'utf8');
      const m = txt.match(/\b([0-9a-f]{7,40})\b/i);
      if (m) return m[1];
    } catch { /* fall through */ }
  }
  return null;
}

function gitHead(treeAbs) {
  try {
    return execFileSync('git', ['-C', treeAbs, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function commitsMatch(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

function recloneHint(source, treeAbs, pinned) {
  const dir = path.basename(treeAbs);
  const url = source.cloneUrl || '<upstream-repo-url>';
  const sha = pinned || '<pinned-commit>';
  return [
    `    cd ${path.dirname(treeAbs)}`,
    `    git init ${dir} && cd ${dir}`,
    `    git remote add origin ${url}`,
    `    git fetch --depth 1 origin ${sha}`,
    `    git checkout FETCH_HEAD`,
  ].join('\n');
}

function fmtCite(c) {
  if (c.lineStart == null) return c.path;
  const range = c.lineEnd ? `${c.lineStart}-${c.lineEnd}` : `${c.lineStart}`;
  return `${c.path}:${c.approx ? '~' : ''}${range}`;
}

function verifyProject(name, project, repoRoot) {
  const source = project.source;
  console.log(`\n=== ${name} — ${project.title} ===`);

  // Gather citations from every chapter's script.md first (works with or
  // without a source tree, so the "unverified" report still has real counts).
  const root = path.resolve(repoRoot, project.root || '.');
  let allCites = [];
  let scannedScripts = 0;
  for (const ch of project.chapters) {
    const scriptPath = path.join(root, ch.id, 'script.md');
    if (!fs.existsSync(scriptPath)) continue;
    scannedScripts++;
    const text = fs.readFileSync(scriptPath, 'utf8');
    for (const c of extractCitations(text)) allCites.push({ ...c, chapter: ch.id });
  }
  // De-dupe identical (chapter, path, line) citations.
  const seen = new Set();
  allCites = allCites.filter((c) => {
    const k = `${c.chapter}|${c.path}|${c.lineStart}|${c.lineEnd}|${c.approx}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  console.log(`  scanned ${scannedScripts} script.md  ·  ${allCites.length} citation(s) found`);

  if (!source) {
    console.log(`  ${sym.info} no pinned source configured — citations NOT mechanically verifiable.`);
    console.log(`     (add a "source" block in lumina.config.js to enable checking.)`);
    return { name, status: 'unverified', total: allCites.length };
  }

  const treeAbs = path.resolve(repoRoot, source.tree);
  const pinned = pinnedCommit(source, repoRoot);

  // Hard precondition: the source tree must exist.
  if (!fs.existsSync(treeAbs)) {
    console.log(`  ${sym.bad} source tree MISSING: ${treeAbs}`);
    console.log(`     pinned commit: ${pinned || '(unknown)'}`);
    console.log(`     restore it with:`);
    console.log(recloneHint(source, treeAbs, pinned));
    return { name, status: 'no-tree', total: allCites.length, hardFail: allCites.length || 1 };
  }

  // Commit drift check (warn, don't fail — re-pinning may be intentional, but
  // a silent mismatch would invalidate every line number).
  const head = gitHead(treeAbs);
  let driftFail = 0;
  if (pinned) {
    if (head && commitsMatch(head, pinned)) {
      console.log(`  ${sym.ok} source @ pinned commit ${pinned.slice(0, 10)}`);
    } else if (head) {
      console.log(`  ${sym.bad} COMMIT DRIFT: tree is at ${head.slice(0, 10)} but scripts pin ${pinned.slice(0, 10)}`);
      console.log(`     line numbers below were verified against the WRONG revision.`);
      console.log(`     re-pin (update SOURCE_COMMIT.txt) or checkout the pinned commit:`);
      console.log(`       git -C ${treeAbs} checkout ${pinned}`);
      driftFail = 1;
    } else {
      console.log(`  ${sym.warn} tree is not a git repo — cannot confirm it is at ${pinned.slice(0, 10)}`);
    }
  }

  const crossRefPrefixes = source.crossRefPrefixes || [];
  const index = walkTree(treeAbs);

  const tally = { ok: 0, approx: 0, pathonly: 0, ambiguous: 0, missing: 0, oob: 0, crossref: 0, informal: 0, quoted: 0, context: 0 };
  const problems = [];

  // Within one chapter, a bare basename the author ALSO cites with a full
  // dir-qualified path is legitimate shorthand (establish once, abbreviate
  // after) — resolve it to that path instead of calling it ambiguous. Skip
  // cross-ref paths so a foreign `src/…` can't become a local target.
  const established = new Map(); // chapter -> Map(basename -> Set(resolved relpath))
  for (const c of allCites) {
    if (!c.path.includes('/')) continue;
    if (crossRefPrefixes.some((p) => c.path.startsWith(p))) continue;
    // Resolve to the actual tree file so different-depth writings of the same
    // file (`core/src/tools/registry.rs` vs `tools/registry.rs`) dedupe to one.
    const rr = resolveCitation({ path: c.path, lineStart: null, lineEnd: null }, treeAbs, index);
    if (rr.status !== 'ok-pathonly') continue; // only a uniquely-resolved path anchors context
    const base = c.path.split('/').pop();
    if (!established.has(c.chapter)) established.set(c.chapter, new Map());
    const m = established.get(c.chapter);
    if (!m.has(base)) m.set(base, new Set());
    m.get(base).add(rr.file);
  }

  for (const c of allCites) {
    // Citation inside a markdown blockquote = quoting an external doc verbatim;
    // not this teardown's own claim, so it is reported but never failed.
    if (c.quoted) { tally.quoted++; continue; }
    // Foreign comparison reference (e.g. Codex scripts citing Claude Code's
    // `src/…` for contrast): real and intentional, not resolvable here.
    if (crossRefPrefixes.some((p) => c.path.startsWith(p))) { tally.crossref++; continue; }
    // Bare basename, no line ("see query.ts"): too weak to verify. Counted,
    // not checked, never failed — surfaced honestly rather than silently dropped.
    if (c.lineStart == null && !c.path.includes('/')) { tally.informal++; continue; }

    // Resolve chapter-local shorthand to the full path the author established.
    let cc = c;
    let viaContext = false;
    if (!c.path.includes('/')) {
      const set = established.get(c.chapter) && established.get(c.chapter).get(c.path);
      if (set && set.size === 1) { cc = { ...c, path: [...set][0] }; viaContext = true; }
    }

    const r = resolveCitation(cc, treeAbs, index);
    switch (r.status) {
      case 'ok': case 'ok-approx':
        if (viaContext) tally.context++;
        else if (r.status === 'ok-approx') tally.approx++;
        else tally.ok++;
        break;
      case 'ok-pathonly': tally.pathonly++; break;
      case 'ambiguous': tally.ambiguous++; problems.push({ c, r }); break;
      case 'missing': tally.missing++; problems.push({ c, r }); break;
      case 'oob': tally.oob++; problems.push({ c, r }); break;
    }
  }

  console.log(`  ${sym.ok} ${tally.ok} resolved` +
    (tally.context ? `  ${sym.ok} ${tally.context} via chapter context` : '') +
    (tally.approx ? `  ${sym.approx} ${tally.approx} approx` : '') +
    (tally.pathonly ? `  ${sym.info} ${tally.pathonly} path-only` : '') +
    (tally.crossref ? `  ${sym.info} ${tally.crossref} cross-ref` : '') +
    (tally.quoted ? `  ${sym.info} ${tally.quoted} quoted` : '') +
    (tally.informal ? `  ${sym.info} ${tally.informal} informal` : '') +
    (tally.ambiguous ? `  ${sym.warn} ${tally.ambiguous} ambiguous` : '') +
    `  ${sym.bad} ${tally.missing} missing  ${sym.bad} ${tally.oob} out-of-range`);

  // De-dupe ambiguous display by (chapter,path) — the same name is often cited many times.
  const shownAmbig = new Set();
  for (const { c, r } of problems) {
    const where = c.chapter;
    if (r.status === 'missing') {
      const elsewhere = (index.basenames.get(c.path.split('/').pop()) || []).slice(0, 3);
      const hint = elsewhere.length ? `  → did you mean: ${elsewhere.join(', ')}` : '';
      console.log(`    ${sym.bad} [${where}] ${fmtCite(c)} — not found in source tree${hint}`);
    } else if (r.status === 'oob') {
      const f = r.file || (r.files && r.files[0]) || c.path;
      const lc = r.lineCount != null ? `${r.lineCount} lines` : 'too short';
      console.log(`    ${sym.bad} [${where}] ${fmtCite(c)} — line out of range (${f} has ${lc})`);
    } else if (r.status === 'ambiguous') {
      const key = where + '|' + c.path;
      if (shownAmbig.has(key)) continue;
      shownAmbig.add(key);
      console.log(`    ${sym.warn} [${where}] ${c.path}${c.lineStart ? ':' + c.lineStart : ''} — ${r.files.length} files share this name (${r.files.slice(0, 3).join(', ')}${r.files.length > 3 ? ', …' : ''}); write a fuller path`);
    }
  }

  const hardFail = tally.missing + tally.oob + driftFail;
  return { name, status: hardFail ? 'fail' : 'ok', total: allCites.length, tally, hardFail };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const repoRoot = __dirname;
  const projects = config.projects || {};

  // Accept both --project=<name> and --project <name> (matches the other scripts).
  let pjName = null;
  const pjEq = args.find((a) => a.startsWith('--project='));
  if (pjEq) {
    pjName = pjEq.split('=')[1];
  } else {
    const i = args.indexOf('--project');
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) pjName = args[i + 1];
  }
  let targets;
  if (pjName) {
    const nm = pjName;
    if (!projects[nm]) {
      console.error(`Unknown project "${nm}". Available: ${Object.keys(projects).join(', ')}`);
      process.exit(2);
    }
    targets = [nm];
  } else {
    // default / --all: every project (those without source self-report as unverified)
    targets = Object.keys(projects);
  }

  console.log(`Citation freshness check — ${targets.length} project(s)`);
  console.log('(scanning script.md only; slide HTML is not scanned)');

  const results = targets.map((nm) => verifyProject(nm, projects[nm], repoRoot));

  // Summary
  let totalHardFail = 0;
  console.log('\n--- Summary ---');
  for (const r of results) {
    totalHardFail += r.hardFail || 0;
    const line = r.status === 'unverified'
      ? `${sym.info} ${r.name}: ${r.total} citation(s), not verifiable (no pinned source)`
      : r.status === 'no-tree'
        ? `${sym.bad} ${r.name}: source tree missing — ${r.total} citation(s) unverifiable`
        : r.status === 'fail'
          ? `${sym.bad} ${r.name}: ${r.hardFail} hard failure(s) of ${r.total} citation(s)`
          : `${sym.ok} ${r.name}: all ${r.total} citation(s) resolve`;
    console.log('  ' + line);
  }

  process.exit(totalHardFail > 0 ? 1 : 0);
}

main();
