const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const chokidar = require('chokidar');
const fs = require('fs');
const { compileMarkdownToHtml } = require('../core/md-compiler');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rootDir = path.resolve(__dirname, '../../');
const port = process.env.PORT || 3000;

// Middleware to serve static files from root
app.use(express.static(rootDir));

// Custom endpoint to list all chapters and their slides
app.get('/api/chapters', (req, res) => {
  const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('ch'))
    .map(dirent => dirent.name);
  res.json(dirs);
});

app.get('/api/slides/:chapter', (req, res) => {
  const chapter = req.params.chapter;
  const slidesDir = path.join(rootDir, chapter, 'slides');
  if (!fs.existsSync(slidesDir)) return res.json([]);
  
  const files = fs.readdirSync(slidesDir)
    .filter(f => f.endsWith('.html'))
    .sort();
  res.json(files);
});

// Main Studio UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Watcher setup
const watcher = chokidar.watch([
  path.join(rootDir, 'ch*/**/*.md'),
  path.join(rootDir, 'ch*/**/*.excalidraw'),
  path.join(rootDir, 'design-system/*.css')
], { ignoreInitial: true });

watcher.on('all', (event, filePath) => {
  console.log(`[Watcher] ${event}: ${path.basename(filePath)}`);
  
  if (filePath.endsWith('.md')) {
    const chapterDir = path.dirname(filePath);
    compileMarkdownToHtml(chapterDir, path.basename(filePath));
  }
  
  // Notify all connected clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event: 'reload', file: path.basename(filePath) }));
    }
  });
});

server.listen(port, () => {
  console.log(`
  Lumina Studio v3.0
  ------------------
  Live Preview: http://localhost:${port}
  Watching chapters for changes...
  `);
});
