// Tiny static file server for local dev: `npm run dev` -> http://localhost:5199
// (On Vercel the `public/` folder is served directly; this file is not used.)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'public');
const PORT = process.env.PORT || 5199;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
};

http
  .createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch {
      res.writeHead(400);
      return res.end('Bad request');
    }
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.join(ROOT, path.normalize(urlPath));
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Video & Voice Editor: http://localhost:${PORT}`));
