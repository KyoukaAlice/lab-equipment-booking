'use strict';

/**
 * 极简 HTTP 内核
 * ------------------------------------------------------------------
 * 为避免引入第三方框架，这里实现一个带路径参数的路由器 + 中间件链：
 *   - 路径参数：'/api/devices/:id' -> req.params.id
 *   - 中间件：签名 (req, res, ctx) => boolean|void|Promise；返回 false 表示已终止
 *   - 处理器统一返回 { status, body, headers } 或直接抛 AppError
 */

const { AppError } = require('../utils/errors');

/** 路径模板 -> 正则 + 参数名 */
function compilePattern(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

class Router {
  constructor() {
    /** @type {Array<{method:string, pattern:string, regex:RegExp, keys:string[], handler:Function}>} */
    this.routes = [];
    this.middlewares = [];
  }

  /** 注册全局中间件 */
  use(fn) {
    this.middlewares.push(fn);
    return this;
  }

  add(method, pattern, handler) {
    const { regex, keys } = compilePattern(pattern);
    this.routes.push({ method, pattern, regex, keys, handler });
    return this;
  }

  get(p, h) {
    return this.add('GET', p, h);
  }

  post(p, h) {
    return this.add('POST', p, h);
  }

  put(p, h) {
    return this.add('PUT', p, h);
  }

  patch(p, h) {
    return this.add('PATCH', p, h);
  }

  del(p, h) {
    return this.add('DELETE', p, h);
  }

  /** 匹配路由：优先返回路径+方法都命中的路由；仅当无同方法路由时才报 405 */
  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

module.exports = { Router, compilePattern, AppError };
