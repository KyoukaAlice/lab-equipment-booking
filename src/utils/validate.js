'use strict';

/**
 * 入参校验与通用工具
 */

const { badRequest } = require('./errors');

/** 必填非空字符串 */
function requireString(value, field, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string') throw badRequest(`参数 ${field} 必须为字符串`);
  const v = value.trim();
  if (v.length < min) throw badRequest(`参数 ${field} 不能为空`);
  if (v.length > max) throw badRequest(`参数 ${field} 长度不能超过 ${max} 个字符`);
  return v;
}

/** 可选字符串，带默认值 */
function optionalString(value, field, { max = 500, def = '' } = {}) {
  if (value === undefined || value === null || value === '') return def;
  if (typeof value !== 'string') throw badRequest(`参数 ${field} 必须为字符串`);
  const v = value.trim();
  if (v.length > max) throw badRequest(`参数 ${field} 长度不能超过 ${max} 个字符`);
  return v;
}

/** 整数，支持范围校验 */
function requireInt(value, field, { min = -Infinity, max = Infinity, def } = {}) {
  if ((value === undefined || value === null || value === '') && def !== undefined) return def;
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`参数 ${field} 必须为整数`);
  if (n < min) throw badRequest(`参数 ${field} 不能小于 ${min}`);
  if (n > max) throw badRequest(`参数 ${field} 不能大于 ${max}`);
  return n;
}

/** 枚举校验 */
function requireEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw badRequest(`参数 ${field} 取值非法，可选：${allowed.join(' / ')}`);
  }
  return value;
}

/** 布尔（支持 true/false、"1"/"0"、1/0） */
function toBool(value, def = false) {
  if (value === undefined || value === null || value === '') return def;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return def;
}

/** 分页参数标准化：返回 { page, pageSize, offset, limit } */
function pagination(query = {}, { defaultSize = 20, maxSize = 200 } = {}) {
  const page = Math.max(1, requireInt(query.page, 'page', { def: 1, min: 1, max: 100000 }));
  const pageSize = Math.min(
    maxSize,
    Math.max(1, requireInt(query.pageSize ?? query.size, 'pageSize', { def: defaultSize, min: 1, max: maxSize })),
  );
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

/** 6 位数字校验码格式 */
function isSixDigitCode(value) {
  return typeof value === 'string' && /^\d{6}$/.test(value.trim());
}

/** HTML 转义（用于服务端生成 CSV / 文本时的安全输出） */
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

/** 剔除对象中的 undefined，便于 WHERE 拼接 */
function omitUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

module.exports = {
  requireString,
  optionalString,
  requireInt,
  requireEnum,
  toBool,
  pagination,
  isSixDigitCode,
  escapeHtml,
  omitUndefined,
};
