'use strict';

/**
 * 通知中心服务
 */

const db = require('../db');

/**
 * 创建一条站内通知
 * @param {Object} opts
 * @param {number} opts.userId
 * @param {string} opts.type   业务类型（booking.submitted / booking.approved / ...）
 * @param {string} opts.title
 * @param {string} [opts.content]
 * @param {string} [opts.link] 前端路由，例如 #/bookings/12
 */
function notify({ userId, type, title, content = '', link = '' }) {
  const now = Date.now();
  db.run(
    `INSERT INTO notifications (user_id, type, title, content, link, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    [userId, type, title, content, link, now],
  );
}

/** 批量通知 */
function notifyMany(userIds, payload) {
  const unique = [...new Set(userIds.filter(Boolean))];
  for (const uid of unique) notify({ ...payload, userId: uid });
}

/** 查询通知列表 */
function list(userId, { onlyUnread = false, page = 1, pageSize = 20 } = {}) {
  const offset = (page - 1) * pageSize;
  const where = onlyUnread ? 'AND is_read = 0' : '';
  const items = db.all(
    `SELECT * FROM notifications WHERE user_id = ? ${where}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [userId, pageSize, offset],
  );
  const total = db.scalar(
    `SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? ${where}`,
    [userId],
  );
  const unread = db.scalar('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', [userId]);
  return { items, total, unread, page, pageSize };
}

function markRead(userId, id) {
  const res = db.run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, userId]);
  return res.changes > 0;
}

function markAllRead(userId) {
  const res = db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [userId]);
  return res.changes;
}

function unreadCount(userId) {
  return Number(db.scalar('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0', [userId]) || 0);
}

module.exports = { notify, notifyMany, list, markRead, markAllRead, unreadCount };
