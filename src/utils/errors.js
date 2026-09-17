'use strict';

/**
 * 统一业务异常：携带 HTTP 状态码 + 机器可读错误码
 */
class AppError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} code   机器可读错误码（前端据此做差异化提示）
   * @param {string} message 面向用户的中文提示
   * @param {object} [extra] 附加信息（例如冲突明细 conflict）
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const badRequest = (msg, extra) => new AppError(400, 'BAD_REQUEST', msg, extra);
const unauthorized = (msg = '请先登录') => new AppError(401, 'UNAUTHORIZED', msg);
const forbidden = (msg = '没有操作权限') => new AppError(403, 'FORBIDDEN', msg);
const notFound = (msg = '资源不存在') => new AppError(404, 'NOT_FOUND', msg);
const conflict = (msg, extra) => new AppError(409, 'CONFLICT', msg, extra);
const unprocessable = (msg, extra) => new AppError(422, 'UNPROCESSABLE', msg, extra);

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
};
