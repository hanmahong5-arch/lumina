# 📖 Lumina CLI 使用手册 (Usage Guide)

欢迎使用 **Claude Code Lumina** 演示文稿自动化构建工具！本项目现已全面升级为现代化的 Node.js CLI 应用，基于 BMAD 方法论构建，为您提供流畅、可靠的从 HTML/Excalidraw 到原生 PPTX 的编译体验。

---

## 🚀 快速开始

在项目根目录下，您可以通过 `npm run` 来调用预设的快捷命令：

```bash
# 安装所有依赖
npm install

# 一键编译所有章节，并合并为完整的 PPTX
npm run build

# 启动监听模式（推荐工作流：边改代码边看 PPTX 变化）
npm run build:watch
```

---

## 🛠️ 核心 CLI 命令详解

如果您希望直接使用 CLI 核心入口进行更精细的控制，您可以直接调用：
`node src/cli/index.js [command] [options]` 
或者直接使用快捷脚本：`npm run cli -- [command] [options]`

### 1. `build` (构建演示文稿)
将 HTML 幻灯片布局和 Excalidraw 图纸编译为 `.pptx` 文件。

*   **构建全部并合并 (默认)**
    ```bash
    npm run cli -- build --all
    # 或直接使用 npm run build
    ```
    *流程：* 并发构建所有在 `lumina.config.js` 中定义的章节，随后在尾部追加章节分隔页，最终合并为 `claude-code-lumina-complete.pptx`。具有内容哈希缓存机制，未修改的章节将瞬间跳过。

*   **构建指定章节**
    ```bash
    npm run cli -- build -c ch01-core-engine
    # 或直接使用 npm run build:ch01
    ```
    *用途：* 当您只专注于编写某一个章节时，指定构建可以大幅节省时间，并在几秒钟内输出单章 `.pptx`。

*   **强制重构 (无视缓存)**
    ```bash
    npm run cli -- build --force
    ```

*   **👀 监听模式 (Watch Mode)**
    ```bash
    npm run cli -- build --watch
    # 或直接使用 npm run build:watch
    ```
    *极其强大的边改边看功能！* 
    启动后，CLI 会监听所有 `ch*/**/*.html` 和 `ch*/**/*.excalidraw` 文件的变化。
    1. 若检测到 HTML 修改，会自动节流并在 1 秒后触发针对该章节的重构。
    2. 若检测到 Excalidraw 修改，会在后台隐式调用 Playwright 重新渲染为高分 PNG，然后再触发所在章节的 PPTX 重构。

### 2. `render` (渲染 Excalidraw 图纸)
强制将指定目录下的 `.excalidraw` JSON 架构文件，通过无头浏览器完美渲染并裁剪为同名的 `.png` 文件。

```bash
npm run cli -- render ch03-permission/diagrams
```
*   **强制覆盖缓存：** `-f` 或 `--force` 参数将无视图片的时间戳，强制重新渲染。
```bash
npm run cli -- render ch03-permission/diagrams --force
```

### 3. `validate` (验证 HTML 语法)
PPTX 映射引擎对 HTML 结构有严格要求（例如：绝不能使用外边距 `margin` 定位，不能有未闭合的标签）。在构建前验证，防患于未然。

```bash
npm run cli -- validate
# 或直接使用 npm run validate
```

---

## ⚙️ 配置文件 (lumina.config.js)

项目的全局表现均由根目录的 `lumina.config.js` 控制。您无需再深入源码修改：

```javascript
module.exports = {
  build: {
    concurrency: 3,           // 最大并行构建的浏览器/章节数量
    cacheFile: '.build-cache.json',
  },
  render: {
    slideDimensions: 'LAYOUT_16x9', // 16:9 标准宽屏
    excalidraw: {
      scale: 2,       // PNG 渲染的视网膜缩放倍率
      theme: 'light', // "暖光"亮色主题
      maxRetries: 3   // 失败重试次数
    }
  },
  chapters: [
    // 决定合并顺序与分割页名称
    { id: 'ch00-overview-v2', title: 'Chapter 0 — Overview' },
    // ...
  ]
};
```

---

## 💡 进阶：如何为幻灯片添加动画？

本项目不使用 PowerPoint 原生那套脆弱且难以控制的动画系统，而是独创了 **“翻页画册式” (Slide Cloning / Flipbook)** 动画策略。

您只需在 HTML 元素上添加 `data-anim` 和 `data-anim-order` 属性即可：

```html
<ul>
  <!-- 第 1 次点击时浮现 -->
  <li data-anim="fade" data-anim-order="1">First point</li>
  <!-- 第 2 次点击时浮现 -->
  <li data-anim="fade" data-anim-order="2">Second point</li>
</ul>

<!-- 第 3 次点击时，这个盒子出现 -->
<div data-anim="fade" data-anim-order="3">
  Summary Box
</div>
```

构建引擎在编译时，会自动将这一页幻灯片克隆为 4 页：
1. 基础页（隐藏所有带 `data-anim` 的元素）
2. 克隆页 1（显示 `order="1"` 的元素）
3. 克隆页 2（显示 `order="1", "2"` 的元素）
4. 克隆页 3（显示所有元素）

在播放 PPT 时，切换幻灯片就实现了完美的、零卡顿的“淡入”动画效果！

---

## 🛡️ 异常处理与文件锁 (EBUSY)

当您在 PowerPoint 中**打开着** `claude-code-lumina-complete.pptx` 时，Windows 系统会锁定该文件，阻止其他程序覆盖。

**本 CLI 已实现智能的 Resilience (容错恢复) 机制：**
即使目标 PPTX 被锁定，CLI 也会完成编译，并将新的演示文稿保存为 `claude-code-lumina-complete-<时间戳>.pptx` 备用路径，同时发出明显的黄色警告，**绝不会崩溃**退出。您可以安全地保持 PPTX 开启状态进行预览。