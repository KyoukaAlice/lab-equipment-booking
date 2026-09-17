'use strict';

/**
 * HTTP 服务器实现
 * ------------------------------------------------------------------
 * 职责：请求解析（URL / query / body / cookie）→ 中间件链（鉴权）→ 路由分发
 *      → 统一错误处理（AppError → JSON，未知异常 → 500 且不泄露堆栈）
 * 同时负责静态资源（前端 SPA）的托管。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { Router } = require('./router');
const db = require('../db');
const config = require('../core/config');
const notification = require('../services/notification.service');
const { AppError } = require('../utils/errors');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MAX_BODY_BYTES = 1024 * 1024; // 1MB，足够本系统全部表单
const SESSION_DAYS = 7;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

/* ----------------------------- 请求解析辅助 ----------------------------- */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType = '') {
  if (!raw) return {};
  const type = contentType.split(';')[0].trim();
  if (type === 'application/json' || raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new AppError(400, 'BAD_JSON', '请求体不是合法的 JSON');
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(raw);
    const out = {};
    for (const [k, v] of params.entries()) out[k] = v;
    return out;
  }
  return {};
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', headers = {}) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    ...headers,
  });
  res.end(buf);
}

/* ------------------------------ 应用上下文 ------------------------------ */

/**
 * 创建应用上下文：所有路由共享的服务集合
 */
function createContext() {
  const router = new Router();

  const ctx = {
    router,
    startedAt: Date.now(),
    db,
    config,
    notification,
    /** 路由处理器：由 src/routes/* 注册到 ctx.route 上 */
    routes: {},
    now: () => Date.now(),
    tz: () => config.num('timezone_offset_minutes'),
    /** 客户端 IP（兼容反向代理） */
    clientIp(req) {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
      return (req.socket && req.socket.remoteAddress) || '';
    },

    /**
     * 会话解析：从 Authorization: Bearer 或 Cookie 中取 token
     * @returns {{user:object, token:string}|null}
     */
    resolveSession(req) {
      let token = '';
      const auth = req.headers.authorization;
      if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
        token = auth.slice(7).trim();
      }
      if (!token && req.cookies && req.cookies.lab_token) token = req.cookies.lab_token;
      if (!token) return null;
      const row = db.get(
        `SELECT s.token, s.expires_at, u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`,
        [token],
      );
      if (!row || row.expires_at < Date.now()) return null;
      return { user: row, token };
    },

    /** 登录成功后建立会话 */
    createSession(user, req) {
      const now = Date.now();
      const { generateToken } = require('../core/password');
      const token = generateToken();
      const expiresAt = now + SESSION_DAYS * 24 * 3600 * 1000;
      db.run(
        'INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
        [token, user.id, now, expiresAt, String(req.headers['user-agent'] || '').slice(0, 200)],
      );
      return { token, expiresAt };
    },

    destroySession(token) {
      if (token) db.run('DELETE FROM sessions WHERE token = ?', [token]);
    },

    /** 查询某用户负责的实验室 ID 列表 */
    managedLabIds(userId) {
      return db
        .all('SELECT lab_id FROM lab_managers WHERE user_id = ?', [userId])
        .map((r) => r.lab_id);
    },

    /** 判断用户是否为某实验室负责人 */
    isLabManager(userId, labId) {
      const row = db.get('SELECT id FROM lab_managers WHERE user_id = ? AND lab_id = ?', [userId, labId]);
      return Boolean(row);
    },
  };

  // 加载路由模块（每个模块导出 register(ctx)）
  const routeModules = [
    require('../routes/auth.routes'),
    require('../routes/lab.routes'),
    require('../routes/device.routes'),
    require('../routes/booking.routes'),
    require('../routes/notification.routes'),
    require('../routes/stats.routes'),
    require('../routes/admin.routes'),
  ];
  for (const mod of routeModules) mod.register(ctx);

  return ctx;
}

/* ------------------------------- 静态资源 ------------------------------- */

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safeRel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safeRel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return true;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
    return true;
  }
  // SPA 前端路由回退：非 /api 路径统一返回 index.html
  if (!pathname.startsWith('/api/')) {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      const data = fs.readFileSync(indexPath);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
      res.end(data);
      return true;
    }
  }
  return false;
}

/* -------------------------------- 主流程 -------------------------------- */

function createServer(ctx) {
  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    req.cookies = parseCookies(req.headers.cookie);
    req.query = Object.fromEntries(url.searchParams.entries());
    req.pathname = pathname;
    req.ip = ctx.clientIp(req);

    // 统一在此设置安全响应头
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');

    try {
      if (pathname.startsWith('/api/')) {
        const raw = await readBody(req);
        req.body = parseBody(raw, req.headers['content-type'] || '');
        const session = ctx.resolveSession(req);
        req.user = session ? session.user : null;
        req.token = session ? session.token : '';
        req.ctx = ctx;

        const matched = ctx.router.match(req.method, pathname);
        if (!matched) {
          sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `接口不存在：${req.method} ${pathname}` });
          return;
        }
        if (matched.methodNotAllowed) {
          sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: `方法不允许：${req.method}` });
          return;
        }
        req.params = matched.params;
        const result = await matched.route.handler(req, res, ctx);
        if (res.writableEnded) return;
        if (result === undefined || result === null) {
          sendJson(res, 204, {});
          return;
        }
        const status = result.status || 200;
        sendJson(res, status, result.body === undefined ? result : result.body, result.headers || {});
        return;
      }

      // 非 API：静态资源
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method Not Allowed');
        return;
      }
      const served = serveStatic(req, res, pathname);
      if (!served) sendText(res, 404, 'Not Found');
    } catch (err) {
      const isApp = err instanceof AppError;
      const status = isApp ? err.status : 500;
      if (!isApp) {
        // 服务端错误记录完整堆栈，响应体不暴露内部细节
        console.error(`[${new Date().toISOString()}] 未处理异常 ${req.method} ${pathname}:`, err);
      }
      if (!res.writableEnded) {
        sendJson(res, status, {
          ok: false,
          code: isApp ? err.code : 'INTERNAL_ERROR',
          message: isApp ? err.message : '服务器内部错误，请稍后重试',
          detail: isApp ? err.extra : undefined,
          requestId: `${startedAt.toString(36)}`,
        });
      }
    }
  });
}

/**
 * 启动服务
 * @param {{ port?: number, host?: string }} [opts]
 * @returns {Promise<{ server: import('node:http').Server, port: number, ctx: object, close: Function }>}
 */
async function start(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? 3000);
  const host = opts.host || process.env.HOST || '0.0.0.0';
  db.init();
  config.ensureDefaults();
  const ctx = createContext();
  const server = createServer(ctx);

  // 清理过期会话，避免 sessions 表无限增长
  db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);

  const scheduler = require('../services/scheduler.service');
  scheduler.start(ctx);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    ctx,
    close: async () => {
      scheduler.stop();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

module.exports = { createServer, createContext, start, sendJson, sendText, parseCookies, parseBody };
