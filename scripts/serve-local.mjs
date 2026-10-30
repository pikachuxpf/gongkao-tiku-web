import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openSqliteStore } from '../server/sqlite-store.mjs';

const root = process.cwd();
const distRoot = path.join(root, 'dist');
const dataRoot = path.join(root, 'public', 'data');
const port = Number(process.env.PORT || 5173);
const dbPath = process.env.MOJUAN_DB || path.join(root, 'storage', 'mojuan.sqlite');
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function safePath(base, relative) {
  const target = path.resolve(base, relative);
  return target.startsWith(`${base}${path.sep}`) ? target : null;
}

function sendFile(response, filePath) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    response.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
}

const store = await openSqliteStore(dbPath);
const server = http.createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  if (pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, { ok: true, storage: 'sqlite' });
    return;
  }
  if (pathname === '/api/state' && request.method === 'GET') {
    sendJson(response, 200, { ok: true, state: store.read() });
    return;
  }
  if (pathname === '/api/state' && request.method === 'PUT') {
    try {
      const body = JSON.parse(await readBody(request));
      sendJson(response, 200, { ok: true, state: store.write(body) });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message || 'Invalid state payload' });
    }
    return;
  }
  if (pathname.startsWith('/data/')) {
    const filePath = safePath(dataRoot, pathname.slice('/data/'.length));
    if (!filePath) {
      response.statusCode = 403;
      response.end('Forbidden');
      return;
    }
    sendFile(response, filePath);
    return;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = safePath(distRoot, relative) || path.join(distRoot, 'index.html');
  sendFile(response, filePath);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Local server: http://127.0.0.1:${port}/ (SQLite: ${dbPath})`);
});

process.on('SIGINT', () => {
  store.close();
  server.close(() => process.exit(0));
});
