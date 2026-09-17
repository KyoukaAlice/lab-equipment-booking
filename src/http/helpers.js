'use strict';

/**
 * 路由辅助函数：统一响应体、鉴权守卫、分页解析
 */

const { AppError, unauthorized, forbidden, badRequest } = require('../utils/errors');

/** 成功响应 */
function ok(body = {}, status = 200) {
  return { status, body: { ok: true, data: body } };
}

/** 页面式列表响应 */
function page(result) {
  return ok({
    items: result.items,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    counts: result.counts,
  });
}

/** 要求已登录 */
function requireLogin(req) {
  if (!req.user) throw unauthorized('请先登录后再操作');
  if (req.user.status === 'disabled') throw forbidden('账号已被停用，请联系管理员');
  return req.user;
}

/** 要求指定角色 */
function requireRole(req, ...roles) {
  const user = requireLogin(req);
  if (!roles.includes(user.role)) {
    throw forbidden(`该操作仅限${roles.map((r) => ({ admin: '管理员', teacher: '教师', student: '学生' }[r] || r)).join('/')}使用`);
  }
  return user;
}

const requireAdmin = (req) => requireRole(req, 'admin');
const requireStaff = (req) => requireRole(req, 'admin', 'teacher');

/** 读取整数查询参数 */
function intQuery(req, key, def = 0) {
  const raw = req.query[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw badRequest(`参数 ${key} 必须为整数`);
  return n;
}

/** 读取分页参数 */
function pageQuery(req, defSize = 20, maxSize = 200) {
  const page = Math.max(1, intQuery(req, 'page', 1));
  const pageSize = Math.min(maxSize, Math.max(1, intQuery(req, 'pageSize', defSize)));
  return { page, pageSize };
}

/** 读取必填 body 字段 */
function body(req, key, def) {
  const v = req.body ? req.body[key] : undefined;
  if (v === undefined || v === null || v === '') {
    if (def !== undefined) return def;
    throw badRequest(`缺少参数 ${key}`);
  }
  return v;
}

function bodyStr(req, key, { def = '', max = 500, required = false } = {}) {
  const raw = req.body ? req.body[key] : undefined;
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw badRequest(`缺少参数 ${key}`);
    return def;
  }
  const v = String(raw).trim();
  if (v.length > max) throw badRequest(`参数 ${key} 长度不能超过 ${max} 个字符`);
  return v;
}

function bodyInt(req, key, { def, min = -Infinity, max = Infinity, required = false } = {}) {
  const raw = req.body ? req.body[key] : undefined;
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw badRequest(`缺少参数 ${key}`);
    return def;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) throw badRequest(`参数 ${key} 必须为整数`);
  if (n < min) throw badRequest(`参数 ${key} 不能小于 ${min}`);
  if (n > max) throw badRequest(`参数 ${key} 不能大于 ${max}`);
  return n;
}

/** 统一包装异步处理器，保证异常被 server 层捕获 */
function wrap(handler) {
  return async (req, res, ctx) => handler(req, res, ctx);
}

module.exports = {
  ok,
  page,
  requireLogin,
  requireRole,
  requireAdmin,
  requireStaff,
  intQuery,
  pageQuery,
  body,
  bodyStr,
  bodyInt,
  wrap,
  AppError,
};
