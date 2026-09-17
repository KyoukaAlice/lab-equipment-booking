'use strict';

/**
 * 信用分服务
 * ------------------------------------------------------------------
 * 规则：
 *   1. 初始分 100，违约按类型扣分（分值可在后台配置）；
 *   2. 每次变动写入 credit_records 台账，保证「台账累加 == 当前分数」可对账；
 *   3. 分数低于阈值（默认 60）自动冻结预约权限，冻结期默认 30 天，到期自动解冻；
 *   4. 被扣分的预约重新获批时可按配置恢复分数（激励改正）。
 */

const db = require('../db');
const config = require('../core/config');
const bkrules = require('../core/booking-rules');
const notification = require('./notification.service');

const MIN_SCORE = 0;
const MAX_SCORE = 100;
const DAY = 24 * 3600 * 1000;

/** 记录一次分数变动（唯一写入口，保证台账一致） */
function applyChange(userId, changePoints, reason, { refType = '', refId = 0, at = Date.now(), silent = false } = {}) {
  const user = db.get('SELECT id, credit_score, name FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  const delta = Math.round(Number(changePoints) || 0);
  const scoreAfter = Math.max(MIN_SCORE, Math.min(MAX_SCORE, Number(user.credit_score) + delta));
  const realDelta = scoreAfter - Number(user.credit_score);

  db.run('UPDATE users SET credit_score = ?, updated_at = ? WHERE id = ?', [scoreAfter, at, userId]);
  db.run(
    `INSERT INTO credit_records (user_id, change_points, score_after, reason, ref_type, ref_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, realDelta, scoreAfter, reason, refType, refId, at],
  );

  const threshold = config.num('credit_freeze_threshold');
  if (scoreAfter < threshold) {
    const until = at + config.num('credit_freeze_days') * DAY;
    db.run(
      `UPDATE users SET status = 'frozen', frozen_reason = ?, frozen_until = ?, updated_at = ?
       WHERE id = ? AND status = 'active'`,
      [`信用分低于 ${threshold}（当前 ${scoreAfter} 分）`, until, at, userId],
    );
    if (!silent) {
      notification.notify({
        userId,
        type: 'credit.frozen',
        title: '预约权限已被暂停',
        content: `您的信用分已降至 ${scoreAfter} 分（低于 ${threshold} 分），预约权限暂停至 ${new Date(until).toISOString().slice(0, 10)}。可联系实验室管理员申诉。`,
        link: '#/profile',
      });
    }
  }
  return { scoreAfter, delta: realDelta };
}

/**
 * 记一次违约：写 violations + 扣信用分
 * @param {Object} p
 * @param {number} p.userId
 * @param {number} [p.bookingId]
 * @param {string} p.type no_show / late_cancel / overtime / damage / rule_break
 * @param {number} [p.points] 不传则按类型取配置
 * @param {string} [p.detail]
 * @param {number} [p.createdBy] 手工登记时的操作人
 */
function recordViolation({ userId, bookingId = null, type, points, detail = '', createdBy = null, at = Date.now() }) {
  if (!bkrules.VIOLATION_TYPES[type]) throw new Error(`未知违约类型：${type}`);
  const finalPoints = points === undefined || points === null ? bkrules.violationPoints(type) : Math.abs(Number(points));
  const res = db.run(
    `INSERT INTO violations (user_id, booking_id, type, points, detail, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, bookingId, type, finalPoints, detail, createdBy, at],
  );
  const violationId = res.lastInsertRowid;
  const label = bkrules.VIOLATION_TYPES[type].label;
  const credit = applyChange(userId, -finalPoints, `${label}：${detail || '系统自动判定'}`, {
    refType: 'violation',
    refId: violationId,
    at,
  });
  const user = db.get('SELECT name FROM users WHERE id = ?', [userId]);
  notification.notify({
    userId,
    type: 'violation.created',
    title: `违约记录：${label}`,
    content: `${detail || '系统自动判定'}，扣 ${finalPoints} 分，当前信用分 ${credit ? credit.scoreAfter : '-'}。`,
    link: bookingId ? `#/bookings/${bookingId}` : '#/profile',
  });
  void user;
  return { violationId, points: finalPoints, scoreAfter: credit ? credit.scoreAfter : null };
}

/** 恢复分数（如爽约预约重新获批） */
function restore(userId, points, reason, { refType = '', refId = 0 } = {}) {
  if (!points) return null;
  return applyChange(userId, Math.abs(points), reason, { refType, refId });
}

/** 查询信用台账 */
function ledger(userId, { page = 1, pageSize = 20 } = {}) {
  const items = db.all(
    'SELECT * FROM credit_records WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    [userId, pageSize, (page - 1) * pageSize],
  );
  const total = db.scalar('SELECT COUNT(*) AS c FROM credit_records WHERE user_id = ?', [userId]);
  return { items, total, page, pageSize };
}

/** 违约记录列表 */
function violations(userId, { page = 1, pageSize = 20 } = {}) {
  const items = db.all(
    `SELECT v.*, b.code AS booking_code, d.name AS device_name
     FROM violations v
     LEFT JOIN bookings b ON b.id = v.booking_id
     LEFT JOIN devices d ON d.id = b.device_id
     WHERE v.user_id = ? ORDER BY v.created_at DESC, v.id DESC LIMIT ? OFFSET ?`,
    [userId, pageSize, (page - 1) * pageSize],
  );
  const total = db.scalar('SELECT COUNT(*) AS c FROM violations WHERE user_id = ?', [userId]);
  return { items, total, page, pageSize };
}

/** 信用概览：分数、等级、近 180 天违约次数、是否被冻结 */
function summary(userId) {
  const user = db.get('SELECT credit_score, status, frozen_reason, frozen_until FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  const since = Date.now() - 180 * DAY;
  const recent = Number(
    db.scalar('SELECT COUNT(*) AS c FROM violations WHERE user_id = ? AND created_at >= ?', [userId, since]) || 0,
  );
  const score = Number(user.credit_score);
  let level = '优秀';
  if (score < config.num('credit_freeze_threshold')) level = '受限';
  else if (score < 75) level = '一般';
  else if (score < 90) level = '良好';
  return {
    creditScore: score,
    level,
    recentViolations: recent,
    frozen: user.status === 'frozen',
    frozenReason: user.frozen_reason,
    frozenUntil: user.frozen_until,
    threshold: config.num('credit_freeze_threshold'),
  };
}

/** 解冻（管理员手动 / 定时任务自动） */
function unfreeze(userId, reason, actorId = null) {
  const now = Date.now();
  db.run(
    `UPDATE users SET status = 'active', frozen_reason = '', frozen_until = 0, updated_at = ?
     WHERE id = ? AND status = 'frozen'`,
    [now, userId],
  );
  notification.notify({
    userId,
    type: 'credit.unfrozen',
    title: '预约权限已恢复',
    content: reason || '您的预约权限已恢复，请遵守实验室使用规定。',
    link: '#/profile',
  });
  void actorId;
}

/** 自动解冻到期的冻结账号，返回解冻人数 */
function autoUnfreezeExpired() {
  const now = Date.now();
  const rows = db.all(
    `SELECT id, name FROM users WHERE status = 'frozen' AND frozen_until > 0 AND frozen_until <= ?`,
    [now],
  );
  for (const r of rows) {
    unfreeze(r.id, `冻结期已满，系统自动恢复预约权限（${r.name}）`);
  }
  return rows.length;
}

module.exports = {
  applyChange,
  recordViolation,
  restore,
  ledger,
  violations,
  summary,
  unfreeze,
  autoUnfreezeExpired,
};
