'use strict';

/**
 * 审计日志服务：记录关键写操作，便于追责与答辩演示
 */

const db = require('../db');

/**
 * @param {Object} opts
 * @param {number|null} opts.userId
 * @param {string} opts.actorName
 * @param {string} opts.action      形如 device.create / booking.approve
 * @param {string} [opts.targetType]
 * @param {number} [opts.targetId]
 * @param {any} [opts.detail]       对象或字符串
 * @param {string} [opts.ip]
 */
function log({ userId = null, actorName = '', action, targetType = '', targetId = 0, detail = '', ip = '' }) {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  db.run(
    `INSERT INTO audit_logs (user_id, actor_name, action, target_type, target_id, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, actorName, action, targetType, targetId, text, ip, Date.now()],
  );
}

function list({ page = 1, pageSize = 30, action = '', userId = null } = {}) {
  const conds = [];
  const params = [];
  if (action) {
    conds.push('action LIKE ?');
    params.push(`${action}%`);
  }
  if (userId) {
    conds.push('user_id = ?');
    params.push(userId);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const items = db.all(
    `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  const total = db.scalar(`SELECT COUNT(*) AS c FROM audit_logs ${where}`, params);
  return { items, total, page, pageSize };
}

module.exports = { log, list };
