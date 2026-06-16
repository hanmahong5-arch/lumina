/**
 * build-web.js — generate a self-contained interactive web player for a project's deck.
 *
 * Reuses the existing slide HTML (the same files html2pptx renders to PowerPoint)
 * and bundles them into ONE portable `index.html`: every slide is inlined and
 * rendered in a scaled <iframe srcdoc>, so the bundle opens straight from the
 * filesystem (file://) with no server and no network — fully offline.
 *
 * Interaction: smooth fade/slide transitions, per-slide entrance animation
 * (compare-grid columns duel in from the sides, cards stagger up), keyboard /
 * click / touch / fullscreen navigation, a progress bar, a chapter+page HUD,
 * and an overview thumbnail grid (press O).
 *
 * Usage:
 *   node build-web.js [--project=<name>] [--serve] [--port=5173]
 *   lumina web --project codex [--serve]
 *
 * Output: <project-output-basename>-web/index.html  (e.g. codex-cli-teardown-web/)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const config = require(path.resolve(__dirname, 'lumina.config.js'));

// ---------------------------------------------------------------------------
// args + project resolution (same convention as build-all.js / check-citations.js)
// ---------------------------------------------------------------------------
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k) => {
    const eq = a.find((x) => x.startsWith('--' + k + '='));
    if (eq) return eq.split('=').slice(1).join('=');
    const i = a.indexOf('--' + k);
    if (i >= 0 && a[i + 1] && !a[i + 1].startsWith('--')) return a[i + 1];
    return a.includes('--' + k) ? true : undefined;
  };
  return {
    project: get('project') || config.defaultProject,
    serve: !!get('serve'),
    port: parseInt(get('port'), 10) || 5173,
  };
}

// Entrance-animation runtime injected into EVERY slide's srcdoc. Plain string
// (not a template literal) so its braces/timers are untouched by this script.
const ANIM = [
  '<style>',
  '.lz{opacity:0;transform:translateY(12px);transition:opacity .55s cubic-bezier(.22,1,.36,1),transform .55s cubic-bezier(.22,1,.36,1);will-change:opacity,transform}',
  '.lz.lz-in{opacity:1;transform:none}',
  '.compare-grid>div:first-child.lz{transform:translateX(-30px)}',
  '.compare-grid>div:nth-child(2).lz{transform:translateX(30px)}',
  '.compare-grid>div.lz-in{transform:none}',
  '</style>',
  '<script>',
  '(function(){',
  '  var SEL=".chapter-cover>*,.slide-content>h2,.slide-content>p,.compare-grid>div,.three-col>div,.metric-row>div,.pipeline>div,.cols>div,.grow>div,.ro-row,.callout,.closer,.diagram,.split-row";',
  '  function run(){',
  '    var els=[].slice.call(document.querySelectorAll(SEL));',
  '    els.forEach(function(el){el.classList.add("lz")});',
  '    var i=0;(function step(){ if(i>=els.length)return; els[i].classList.add("lz-in"); i++; setTimeout(step,85); })();',
  '  }',
  '  function reset(){ [].slice.call(document.querySelectorAll(".lz")).forEach(function(el){el.classList.remove("lz-in")}); }',
  '  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run);else run();',
  '  window.addEventListener("message",function(e){ if(e&&e.data==="lumina:replay"){reset();setTimeout(run,40);} });',
  '})();',
  '<\/script>',
].join('\n');

function injectAnim(html) {
  if (html.indexOf('</body>') !== -1) return html.replace('</body>', ANIM + '\n</body>');
  return html + ANIM;
}

// ---------------------------------------------------------------------------
// collect slides for the project (config-driven, in chapter order)
// ---------------------------------------------------------------------------
function collectSlides(project, projectRoot) {
  const slides = [];
  for (const ch of project.chapters) {
    const dir = path.resolve(projectRoot, ch.id, 'slides');
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
    for (const f of files) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      slides.push({ ch: ch.title, chId: ch.id, file: f, html: injectAnim(raw) });
    }
  }
  return slides;
}

// ---------------------------------------------------------------------------
// player shell. NOTE: this template literal must contain NO backticks and NO
// `${` — the player's own JS therefore uses string concatenation throughout.
// Data is injected by replacing the /*__DATA__*/ token.
// ---------------------------------------------------------------------------
const PLAYER = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__ · Lumina</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#07070D;font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;color:#E6EAF2;overflow:hidden}
#app{position:fixed;inset:0;display:flex;flex-direction:column}
#progress{height:3px;background:rgba(255,255,255,.06);flex:0 0 auto}
#bar{height:100%;width:0;background:linear-gradient(90deg,#6C63FF,#00D4AA);transition:width .35s ease}
#stage{flex:1;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;background:radial-gradient(circle at 50% 38%,#15152A 0%,#07070D 72%)}
#frame{width:960px;height:540px;border:0;border-radius:6px;background:#0F0F1A;box-shadow:0 24px 80px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.05);transition:opacity .32s ease,transform .42s cubic-bezier(.22,1,.36,1)}
#stage.swap #frame{opacity:0}
.edge{position:absolute;top:0;bottom:0;width:14%;z-index:5;cursor:pointer}
.edge.l{left:0}.edge.r{right:0}
#hud{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:7px 16px;background:rgba(12,12,22,.86);border-top:1px solid rgba(255,255,255,.06);font-size:12px}
#hud .seg{display:flex;align-items:center;gap:10px}
#chapter{color:#9AA6BF;font-weight:700;letter-spacing:.4px;max-width:46vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#counter{color:#C7D0E0;font-variant-numeric:tabular-nums;min-width:64px;text-align:center}
button.nav{background:rgba(255,255,255,.07);color:#E6EAF2;border:1px solid rgba(255,255,255,.10);border-radius:7px;width:30px;height:30px;font-size:15px;cursor:pointer;line-height:1;transition:background .15s,transform .1s}
button.nav:hover{background:rgba(108,99,255,.35)}
button.nav:active{transform:scale(.92)}
#hint{position:absolute;bottom:54px;left:50%;transform:translateX(-50%);font-size:11px;color:#6B7385;background:rgba(12,12,22,.7);padding:5px 12px;border-radius:20px;transition:opacity .6s ease;pointer-events:none}
#overview{position:fixed;inset:0;z-index:20;background:rgba(7,7,13,.97);overflow:auto;padding:26px;display:none}
#overview.on{display:block}
#ovhead{display:flex;justify-content:space-between;align-items:center;margin:0 4px 16px;color:#9AA6BF;font-size:13px}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(244px,1fr));gap:16px}
.thumb{position:relative;border-radius:6px;overflow:hidden;cursor:pointer;background:#0F0F1A;box-shadow:0 0 0 1px rgba(255,255,255,.06);transition:transform .14s,box-shadow .14s}
.thumb:hover{transform:translateY(-3px);box-shadow:0 10px 30px rgba(0,0,0,.5),0 0 0 1.5px #6C63FF}
.thumb.cur{box-shadow:0 0 0 2px #00D4AA}
.thumb .wrap{width:100%;height:137px;overflow:hidden;position:relative}
.thumb iframe{width:960px;height:540px;border:0;transform:scale(.254);transform-origin:top left;pointer-events:none}
.thumb .cap{display:flex;justify-content:space-between;padding:5px 9px;font-size:10px;color:#9AA6BF;background:rgba(0,0,0,.3)}
.thumb .cap b{color:#C7D0E0;font-weight:700}
.hide{opacity:0!important}
</style>
</head>
<body>
<div id="app">
  <div id="progress"><div id="bar"></div></div>
  <div id="stage">
    <div class="edge l" data-act="prev"></div>
    <iframe id="frame" scrolling="no" referrerpolicy="no-referrer"></iframe>
    <div class="edge r" data-act="next"></div>
    <div id="hint">← → 翻页 · O 总览 · F 全屏</div>
  </div>
  <div id="hud">
    <div class="seg"><span id="chapter"></span></div>
    <div class="seg"><button class="nav" data-act="prev">‹</button><span id="counter"></span><button class="nav" data-act="next">›</button></div>
    <div class="seg"><button class="nav" data-act="overview" title="总览 (O)">▦</button><button class="nav" data-act="fs" title="全屏 (F)">⛶</button></div>
  </div>
</div>
<div id="overview">
  <div id="ovhead"><span>总览 · 点击跳转</span><span>Esc 关闭</span></div>
  <div id="grid"></div>
</div>
<script>
/*__DATA__*/
var frame=document.getElementById("frame");
var stage=document.getElementById("stage");
var bar=document.getElementById("bar");
var counter=document.getElementById("counter");
var chapter=document.getElementById("chapter");
var hint=document.getElementById("hint");
var overview=document.getElementById("overview");
var grid=document.getElementById("grid");
var cur=0, ovBuilt=false;

function fit(){
  var r=stage.getBoundingClientRect();
  var s=Math.min((r.width-48)/960,(r.height-40)/540);
  if(s<0.1)s=0.1;
  frame.style.transform="scale("+s+")";
}
function render(){
  var sl=SLIDES[cur];
  frame.srcdoc=sl.html;
  counter.textContent=(cur+1)+" / "+SLIDES.length;
  chapter.textContent=sl.ch;
  bar.style.width=(SLIDES.length<2?100:(cur/(SLIDES.length-1))*100)+"%";
  fit();
  markCur();
}
function go(n,dir){
  var t=Math.max(0,Math.min(SLIDES.length-1,n));
  if(t===cur){return;}
  cur=t;
  stage.classList.add("swap");
  frame.style.transform=frame.style.transform+" translateX("+((dir||0)*40)+"px)";
  setTimeout(function(){ render(); stage.classList.remove("swap"); },180);
}
function next(){go(cur+1,1);}
function prev(){go(cur-1,-1);}

frame.addEventListener("load",function(){ try{frame.contentWindow.postMessage("lumina:replay","*");}catch(e){} });

document.addEventListener("keydown",function(e){
  if(e.key==="ArrowRight"||e.key===" "||e.key==="PageDown"){e.preventDefault();next();}
  else if(e.key==="ArrowLeft"||e.key==="PageUp"){e.preventDefault();prev();}
  else if(e.key==="Home"){go(0,-1);}
  else if(e.key==="End"){go(SLIDES.length-1,1);}
  else if(e.key==="o"||e.key==="O"){toggleOverview();}
  else if(e.key==="f"||e.key==="F"){toggleFs();}
  else if(e.key==="Escape"){ if(overview.classList.contains("on"))toggleOverview(); }
});
document.addEventListener("click",function(e){
  var act=e.target&&e.target.getAttribute&&e.target.getAttribute("data-act");
  if(act==="next")next();
  else if(act==="prev")prev();
  else if(act==="overview")toggleOverview();
  else if(act==="fs")toggleFs();
});
var tx=null;
stage.addEventListener("touchstart",function(e){tx=e.changedTouches[0].clientX;},{passive:true});
stage.addEventListener("touchend",function(e){ if(tx===null)return; var dx=e.changedTouches[0].clientX-tx; if(Math.abs(dx)>45){dx<0?next():prev();} tx=null; },{passive:true});
window.addEventListener("resize",fit);
setTimeout(function(){hint.classList.add("hide");},4200);

function toggleFs(){ try{ if(!document.fullscreenElement){ document.documentElement.requestFullscreen(); } else { document.exitFullscreen(); } }catch(e){} }

function buildOverview(){
  if(ovBuilt)return; ovBuilt=true;
  var html="";
  for(var i=0;i<SLIDES.length;i++){
    html+='<div class="thumb" data-i="'+i+'"><div class="wrap"><iframe scrolling="no" srcdoc="'+escAttr(SLIDES[i].html)+'"></iframe></div><div class="cap"><b>'+(i+1)+'</b><span>'+escHtml(SLIDES[i].ch)+'</span></div></div>';
  }
  grid.innerHTML=html;
  grid.addEventListener("click",function(e){
    var t=e.target; while(t&&t!==grid&&!t.classList.contains("thumb"))t=t.parentNode;
    if(t&&t.classList.contains("thumb")){ go(parseInt(t.getAttribute("data-i"),10), 0); toggleOverview(); }
  });
}
function toggleOverview(){
  if(overview.classList.contains("on")){ overview.classList.remove("on"); }
  else { buildOverview(); markCur(); overview.classList.add("on"); }
}
function markCur(){
  var ts=grid.querySelectorAll(".thumb");
  for(var i=0;i<ts.length;i++){ ts[i].classList.toggle("cur", i===cur); }
}
function escAttr(s){ return s.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function escHtml(s){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

render();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs();
  const project = config.projects && config.projects[args.project];
  if (!project) {
    console.error('Unknown project "' + args.project + '". Available: ' + Object.keys(config.projects || {}).join(', '));
    process.exit(1);
  }
  const projectRoot = path.resolve(__dirname, project.root || '.');
  const slides = collectSlides(project, projectRoot);
  if (slides.length === 0) {
    console.error('No slides found for project "' + args.project + '". Author slides first (lumina build --project ' + args.project + ' --list).');
    process.exit(1);
  }

  // Escape every '<' as the JS unicode escape so the inlined slide HTML can never
  // break out of the <script> tag (handles </script>, <!--, <![CDATA[ alike).
  const dataJson = JSON.stringify(slides).replace(/</g, '\\u003c');
  const dataScript = 'var SLIDES=' + dataJson + ';';
  const out = PLAYER
    .replace('/*__DATA__*/', dataScript)
    .replace(/__TITLE__/g, (project.title || args.project).replace(/[<>]/g, ''));

  const baseName = (project.output || (args.project + '.pptx')).replace(/-complete\.pptx$/, '').replace(/\.pptx$/, '');
  const outDir = path.resolve(__dirname, baseName + '-web');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'index.html');
  fs.writeFileSync(outFile, out, 'utf8');

  const chapters = [...new Set(slides.map((s) => s.chId))];
  console.log('Lumina web player built:');
  console.log('  project : ' + args.project + ' (' + project.title + ')');
  console.log('  slides  : ' + slides.length + ' across ' + chapters.length + ' chapter(s)');
  console.log('  output  : ' + outFile + ' (' + (fs.statSync(outFile).size / 1024).toFixed(0) + ' KB, self-contained)');
  console.log('  open    : file:///' + outFile.replace(/\\/g, '/'));

  if (args.serve) serve(outDir, args.port);
}

function serve(dir, port) {
  let express;
  try { express = require('express'); } catch (e) {
    console.error('--serve needs express (already a dependency). Run `npm install`.');
    process.exit(1);
  }
  const app = express();
  app.use(express.static(dir));
  app.listen(port, () => {
    console.log('\n  serving at http://localhost:' + port + '/  (Ctrl+C to stop)');
  });
}

main();
