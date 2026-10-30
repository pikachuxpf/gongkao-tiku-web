import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { openSqliteStore } from '../server/sqlite-store.mjs';

const root = process.cwd();
const config = loadConfig();
const distRoot = path.join(root, 'dist');
const dataRoot = path.join(root, 'public', 'data');
const mimeTypes = { '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const store = await openSqliteStore(config.dbPath, { admin: config.admin, sessionTtlMs: config.sessionTtlMs });
const loginAttempts = new Map();

function safePath(base, relative) {
  const target = path.resolve(base, relative);
  return target === base || target.startsWith(`${base}${path.sep}`) ? target : null;
}

function sendFile(response, filePath) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) { response.statusCode = 404; response.end('Not found'); return; }
    response.statusCode = 200;
    response.setHeader('Content-Type', mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    response.setHeader('Cache-Control', path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600');
    fs.createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) { reject(new Error('Request body too large')); request.destroy(); return; }
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

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(Boolean));
}

function setSessionCookie(response, token) {
  const parts = [`mojuan_session=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`];
  if (config.cookieSecure) parts.push('Secure');
  response.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', 'mojuan_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function currentUser(request) {
  return store.getUserBySession(parseCookies(request).mojuan_session);
}

function requireUser(request, response) {
  const user = currentUser(request);
  if (!user) { sendJson(response, 401, { ok: false, error: '请先登录' }); return null; }
  return user;
}

function requireAdmin(request, response) {
  const user = requireUser(request, response);
  if (!user) return null;
  if (user.role !== 'admin') { sendJson(response, 403, { ok: false, error: '需要管理员权限' }); return null; }
  return user;
}

function verifySameOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.host !== request.headers.host || !['http:', 'https:'].includes(url.protocol)) throw new Error('origin');
    return true;
  } catch { sendJson(response, 403, { ok: false, error: '请求来源不合法' }); return false; }
}

function checkLoginRateLimit(request, response) {
  const address = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const item = loginAttempts.get(address) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (item.resetAt <= now) { item.count = 0; item.resetAt = now + 15 * 60 * 1000; }
  if (item.count >= 10) { sendJson(response, 429, { ok: false, error: '登录尝试过于频繁，请稍后再试' }); return false; }
  item.count += 1;
  loginAttempts.set(address, item);
  return true;
}

async function jsonBody(request) {
  const value = JSON.parse(await readBody(request) || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求参数格式不正确');
  return value;
}

async function proxyAi(request, response) {
  const user = requireUser(request, response);
  if (!user) return;
  if (!config.ai.apiKey) { sendJson(response, 503, { ok: false, error: '管理员尚未配置统一大模型 API Key' }); return; }
  const body = await jsonBody(request);
  body.model = config.ai.model;
  const upstream = await fetch(`${config.ai.endpoint}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.apiKey}` }, body: JSON.stringify(body) });
  response.statusCode = upstream.status;
  response.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
  response.setHeader('Referrer-Policy', 'same-origin');
  let url;
  try { url = new URL(request.url, `http://${request.headers.host || 'localhost'}`); } catch { sendJson(response, 400, { ok: false, error: '无效 URL' }); return; }
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !verifySameOrigin(request, response)) return;
    if (pathname === '/api/health' && request.method === 'GET') { sendJson(response, 200, { ok: true, storage: 'sqlite', multiUser: true }); return; }
    if (pathname === '/api/config' && request.method === 'GET') { sendJson(response, 200, { ok: true, registration: config.allowRegistration, ai: { configured: Boolean(config.ai.apiKey), model: config.ai.model } }); return; }
    if (pathname === '/api/me' && request.method === 'GET') { const user = currentUser(request); sendJson(response, 200, user ? { ok: true, user } : { ok: false, user: null }); return; }
    if (pathname === '/api/auth/login' && request.method === 'POST') {
      if (!checkLoginRateLimit(request, response)) return;
      const body = await jsonBody(request);
      const user = store.authenticate(body.username, body.password);
      if (!user) { sendJson(response, 401, { ok: false, error: '用户名或密码错误' }); return; }
      setSessionCookie(response, store.createSession(user.id));
      sendJson(response, 200, { ok: true, user });
      return;
    }
    if (pathname === '/api/auth/register' && request.method === 'POST') {
      if (!config.allowRegistration) { sendJson(response, 403, { ok: false, error: '当前服务未开放注册' }); return; }
      const body = await jsonBody(request);
      const user = store.createUser({ username: body.username, password: body.password, displayName: body.displayName });
      setSessionCookie(response, store.createSession(user.id));
      sendJson(response, 201, { ok: true, user });
      return;
    }
    if (pathname === '/api/auth/logout' && request.method === 'POST') { store.deleteSession(parseCookies(request).mojuan_session); clearSessionCookie(response); sendJson(response, 200, { ok: true }); return; }
    if (pathname === '/api/state' && request.method === 'GET') { const user = requireUser(request, response); if (user) sendJson(response, 200, { ok: true, state: store.read(user.id) }); return; }
    if (pathname === '/api/state' && request.method === 'PUT') { const user = requireUser(request, response); if (!user) return; sendJson(response, 200, { ok: true, state: store.write(user.id, await jsonBody(request)) }); return; }
    if (pathname === '/api/ai/chat/completions' && request.method === 'POST') { await proxyAi(request, response); return; }
    if (pathname.startsWith('/api/admin/')) {
      const admin = requireAdmin(request, response);
      if (!admin) return;
      if (pathname === '/api/admin/users' && request.method === 'GET') { sendJson(response, 200, { ok: true, users: store.listUsers() }); return; }
      if (pathname === '/api/admin/users' && request.method === 'POST') { const body = await jsonBody(request); sendJson(response, 201, { ok: true, user: store.createUser({ username: body.username, password: body.password, displayName: body.displayName, role: body.role }) }); return; }
      if (pathname === '/api/admin/stats' && request.method === 'GET') { sendJson(response, 200, { ok: true, stats: store.stats() }); return; }
      const activeMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/active$/);
      if (activeMatch && request.method === 'PATCH') { const body = await jsonBody(request); sendJson(response, 200, { ok: true, user: store.setUserActive(Number(activeMatch[1]), Boolean(body.active)) }); return; }
      const passwordMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/password$/);
      if (passwordMatch && request.method === 'POST') { const body = await jsonBody(request); store.resetPassword(Number(passwordMatch[1]), body.password); sendJson(response, 200, { ok: true }); return; }
      sendJson(response, 404, { ok: false, error: '管理员接口不存在' });
      return;
    }
    if (pathname.startsWith('/data/')) {
      const filePath = safePath(dataRoot, pathname.slice('/data/'.length));
      if (!filePath) { response.statusCode = 403; response.end('Forbidden'); return; }
      sendFile(response, filePath); return;
    }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    sendFile(response, safePath(distRoot, relative) || path.join(distRoot, 'index.html'));
  } catch (error) {
    const status = /用户名|密码|用户不存在|角色|参数|管理员/.test(error.message) ? 400 : 500;
    sendJson(response, status, { ok: false, error: error.message || '服务器错误' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Mojuan server: http://${config.host}:${config.port}/ (SQLite: ${config.dbPath})`);
  console.log(`Registration: ${config.allowRegistration ? 'enabled' : 'disabled'}; unified AI: ${config.ai.apiKey ? 'configured' : 'not configured'}`);
});

const cleanup = () => { store.cleanExpiredSessions(); store.close(); server.close(() => process.exit(0)); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
