'use strict';

/**
 * 极简静态文件服务器（仅用于本地预览 GitHub Pages 站点）
 *   node scripts/preview-pages.js [port]
 * 默认端口 4000，站点根目录为仓库根（与 Pages「main 分支 / root」的布局一致）。
 * 注意：这不是业务服务，只服务静态文件（index.html / docs/ / 图片）。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PREVIEW_PORT || 4000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 Not Found: ${rel}`);
    return;
  }
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(data);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`静态预览已启动：http://127.0.0.1:${PORT}/`);
  console.log(`项目介绍页：http://127.0.0.1:${PORT}/docs/index.html`);
});
