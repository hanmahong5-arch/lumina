const fs = require('fs');
const path = require('path');

const slidesDir = path.join(__dirname, 'ch00-overview-v2', 'slides');
const scriptPath = path.join(__dirname, 'ch00-overview-v2', 'script.md');

const mapping = [
  { old: 'slide-ch00-01-codebase-coverage.html', new: 'slide-ch00-01-codebase-coverage.html', title: '01: Codebase Coverage' },
  { old: 'slide-ch00-01b-objectives.html', new: 'slide-ch00-02-objectives.html', title: '02: 学习目标' },
  { old: 'slide-ch00-01b-dep-flow.html', new: 'slide-ch00-03-dep-flow.html', title: '03: 章节依赖关系图' },
  { old: 'slide-ch00-02-weight-matrix.html', new: 'slide-ch00-04-weight-matrix.html', title: '04: 章节权重矩阵' },
  { old: 'slide-ch00-03-architecture-map.html', new: 'slide-ch00-05-architecture-map.html', title: '05: 架构地图' },
  { old: 'slide-ch00-04-loc-breakdown.html', new: 'slide-ch00-06-loc-breakdown.html', title: '06: LOC 比例树状图' },
  { old: 'slide-ch00-05-flows-overview.html', new: 'slide-ch00-07-flows-overview.html', title: '07: 调用流程总览' },
  { old: 'slide-ch00-06-flow-bash.html', new: 'slide-ch00-08-flow-bash.html', title: '08: Bash 执行流程' },
  { old: 'slide-ch00-07-flow-read-edit.html', new: 'slide-ch00-09-flow-read-edit.html', title: '09: Read/Edit 流程' },
  { old: 'slide-ch00-08-flow-multiagent.html', new: 'slide-ch00-10-flow-multiagent.html', title: '10: 多 Agent 流程' },
  { old: 'slide-ch00-09-flow-context-overflow.html', new: 'slide-ch00-11-flow-context-overflow.html', title: '11: 上下文溢出恢复' },
  { old: 'slide-ch00-10-top-files.html', new: 'slide-ch00-12-top-files.html', title: '12: 前 10 大文件' },
  { old: 'slide-ch00-11-constants-reference.html', new: 'slide-ch00-13-constants-reference.html', title: '13: 常量与参考' },
  { old: 'slide-ch00-11b-glossary.html', new: 'slide-ch00-14-glossary.html', title: '14: 术语表' },
  { old: 'slide-ch00-11c-seealso.html', new: 'slide-ch00-15-seealso.html', title: '15: 延伸阅读' },
  { old: 'slide-ch00-12-cross-cutting.html', new: 'slide-ch00-16-cross-cutting.html', title: '16: 横切关注点' },
];

// 1. Rename files and update page numbers
mapping.forEach((item, index) => {
  const pageNum = String(index + 1).padStart(2, '0');
  const oldPath = path.join(slidesDir, item.old);
  const newPath = path.join(slidesDir, item.new);
  
  if (fs.existsSync(oldPath)) {
    let content = fs.readFileSync(oldPath, 'utf8');
    // Replace <p class="page-num">XX / YY</p>
    content = content.replace(/<p class="page-num">.*?<\/p>/, `<p class="page-num">${pageNum} / 16</p>`);
    
    // Rename and write
    if (oldPath !== newPath) {
      fs.unlinkSync(oldPath);
    }
    fs.writeFileSync(newPath, content);
    console.log(`Renamed ${item.old} -> ${item.new}`);
  } else if (fs.existsSync(newPath)) {
    let content = fs.readFileSync(newPath, 'utf8');
    content = content.replace(/<p class="page-num">.*?<\/p>/, `<p class="page-num">${pageNum} / 16</p>`);
    fs.writeFileSync(newPath, content);
    console.log(`Updated ${item.new}`);
  }
});

// 2. Update script.md
if (fs.existsSync(scriptPath)) {
  let scriptContent = fs.readFileSync(scriptPath, 'utf8');
  
  // Update header
  scriptContent = scriptContent.replace(/📑 12 Slides/, '📑 16 Slides');
  
  // Replace section headers
  scriptContent = scriptContent.replace(/Slide 01: Codebase Coverage/, 'Slide 01: Codebase Coverage');
  scriptContent = scriptContent.replace(/Slide 01b: 学习目标/, 'Slide 02: 学习目标');
  scriptContent = scriptContent.replace(/Slide 01b: 章节依赖关系图/, 'Slide 03: 章节依赖关系图');
  scriptContent = scriptContent.replace(/Slide 02: 章节权重矩阵/, 'Slide 04: 章节权重矩阵');
  scriptContent = scriptContent.replace(/Slide 03: 架构地图/, 'Slide 05: 架构地图');
  scriptContent = scriptContent.replace(/Slide 04: LOC 比例树状图/, 'Slide 06: LOC 比例树状图');
  scriptContent = scriptContent.replace(/Slide 05: 调用流程总览/, 'Slide 07: 调用流程总览');
  scriptContent = scriptContent.replace(/Slide 06: Bash 执行流程/, 'Slide 08: Bash 执行流程');
  scriptContent = scriptContent.replace(/Slide 07: Read\/Edit 流程/, 'Slide 09: Read/Edit 流程');
  scriptContent = scriptContent.replace(/Slide 08: 多 Agent 流程/, 'Slide 10: 多 Agent 流程');
  scriptContent = scriptContent.replace(/Slide 09: 上下文溢出恢复/, 'Slide 11: 上下文溢出恢复');
  scriptContent = scriptContent.replace(/Slide 10: 前 10 大文件/, 'Slide 12: 前 10 大文件');
  scriptContent = scriptContent.replace(/Slide 11: 常量与参考/, 'Slide 13: 常量与参考');
  scriptContent = scriptContent.replace(/Slide 11b: 术语表 & 延伸阅读/, 'Slide 14 & 15: 术语表 & 延伸阅读');
  scriptContent = scriptContent.replace(/Slide 12: 横切关注点/, 'Slide 16: 横切关注点');
  
  // Also fix internal text references
  scriptContent = scriptContent.replace(/Slide 11b/g, 'Slide 14');
  scriptContent = scriptContent.replace(/Slide 11c/g, 'Slide 15');
  scriptContent = scriptContent.replace(/4 张幻灯片/g, '4 张幻灯片 (Slide 08-11)');
  
  fs.writeFileSync(scriptPath, scriptContent);
  console.log('Updated script.md');
}
