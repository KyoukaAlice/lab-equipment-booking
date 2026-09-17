'use strict';

/**
 * 预约业务服务（系统核心）
 * ------------------------------------------------------------------
 * 关键设计：
 *  1. 并发唯一性：写操作统一走 db.writeTx（进程内互斥 + BEGIN IMMEDIATE），
 *     并且在事务内「重新执行完整冲突校验后再插入」，因此并发抢同一时段时
 *     只有第一个事务能成功，其余返回 409/R10 冲突，不会产生双重预约。
 *  2. 状态机：所有状态迁移都经 booking-rules.assertTransition 校验。
 *  3. 候补补位：预约释放（取消/驳回/提前签退）后自动为候补队列首位尝试补位，
 *     并给予限时确认窗口；到期未确认自动顺延给下一位。
 */

const db = require('../db');
const config = require('../core/config');
const bkrules = require('../core/booking-rules');
const conflictRules = require('../core/conflict-rules');
const interval = require('../core/interval');
const availability = require('./availability.service');
const notification = require('./notification.service');
const credit = require('./credit.service');
const audit = require('./audit.service');
const presenters = require('./presenters');
const { AppError, badRequest, forbidden, notFound, conflict } = require('../utils/errors');
const { generateCheckinCode } = require('../core/password');
const {
  MINUTE,
  DAY,
  formatDate,
  formatDateTime,
  humanDuration,
  parseDateTime,
} = require('../utils/time');

const ACTIVE = ['pending', 'approved', 'checked_in'];

/**
 * 候补补位诊断钩子：默认不输出，设置环境变量 LAB_DEBUG_PROMOTION=1 时打印跳过原因，
 * 便于排查「候补为什么没有补位」这类问题（不影响生产行为）。
 */
function promotionDiag(cand, reason, extra = {}) {
  if (process.env.LAB_DEBUG_PROMOTION !== '1') return;
  console.log(`[promotion] waitlist#${cand.id} user#${cand.user_id} -> ${reason}`, JSON.stringify(extra));
}

/* ------------------------------ 通用查询 ------------------------------ */

function bookingSelectSql() {
  return `SELECT b.*, d.name AS device_name, d.category AS device_category, d.checkin_required,
                 d.min_minutes, d.max_minutes, d.auto_approve,
                 l.name AS lab_name, l.building AS lab_building, l.room AS lab_room,
                 u.name AS user_name, u.username AS user_username, u.department AS user_department,
                 u.role AS user_role,
                 r.name AS reviewer_name,
                 (SELECT COUNT(*) FROM violations v WHERE v.booking_id = b.id) AS violation_count
          FROM bookings b
          JOIN devices d ON d.id = b.device_id
          JOIN labs l ON l.id = b.lab_id
          JOIN users u ON u.id = b.user_id
          LEFT JOIN users r ON r.id = b.reviewed_by`;
}

function getRow(id) {
  return db.get(`${bookingSelectSql()} WHERE b.id = ?`, [id]);
}

function findByCode(code) {
  return db.get(`${bookingSelectSql()} WHERE b.code = ?`, [code]);
}

/** 查询某用户可审批的实验室 ID 列表 */
function reviewerLabIds(user) {
  if (!user) return [];
  if (user.role === 'admin') return db.all('SELECT id FROM labs').map((r) => r.id);
  return db.all('SELECT lab_id FROM lab_managers WHERE user_id = ?', [user.id]).map((r) => r.lab_id);
}

/** 是否有审批权（针对某条预约） */
function canReviewBooking(user, row) {
  if (!user || !row) return false;
  if (row.user_id === user.id) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'teacher') return false;
  const isManager = Boolean(db.get('SELECT id FROM lab_managers WHERE user_id = ? AND lab_id = ?', [user.id, row.lab_id]));
  if (isManager) return true;
  const device = db.get('SELECT owner_id FROM devices WHERE id = ?', [row.device_id]);
  return Boolean(device && device.owner_id === user.id);
}

/** 数据可见范围：学生仅本人；教师本人 + 所辖实验室；管理员全部 */
function visibleScope(user) {
  if (!user) return { sql: '1 = 0', params: [] };
  if (user.role === 'admin') return { sql: '1 = 1', params: [] };
  if (user.role === 'teacher') {
    const labs = reviewerLabIds(user);
    if (!labs.length) return { sql: 'b.user_id = ?', params: [user.id] };
    const ph = labs.map(() => '?').join(',');
    return { sql: `(b.user_id = ? OR b.lab_id IN (${ph}))`, params: [user.id, ...labs] };
  }
  return { sql: 'b.user_id = ?', params: [user.id] };
}

/**
 * 预约列表查询
 * @param {object} viewer 当前用户
 * @param {object} q 查询条件 { scope, status, labId, deviceId, userId, from, to, keyword, page, pageSize, order }
 */
function list(viewer, q = {}) {
  const tz = config.num('timezone_offset_minutes');
  const conds = [];
  const params = [];

  const scopeSql = visibleScope(viewer);
  conds.push(scopeSql.sql);
  params.push(...scopeSql.params);

  const scope = q.scope || 'auto';
  if (scope === 'mine') {
    conds.push('b.user_id = ?');
    params.push(viewer.id);
  } else if (scope === 'todo') {
    // 待我处理：待审批的申请 + 正在使用中的设备使用情况
    const nowTs = Date.now();
    if (viewer.role === 'admin') {
      conds.push("(b.status = 'pending' OR (b.status = 'checked_in' AND b.start_at <= ?))");
      params.push(nowTs);
    } else {
      const labs = reviewerLabIds(viewer);
      if (!labs.length) {
        conds.push('1 = 0');
      } else {
        const ph = labs.map(() => '?').join(',');
        conds.push(
          `((b.status = 'pending' OR (b.status = 'checked_in' AND b.start_at <= ?)) AND b.lab_id IN (${ph}) AND b.user_id <> ?)`,
        );
        params.push(nowTs, ...labs, viewer.id);
      }
    }
  } else if (scope === 'active') {
    conds.push(`b.status IN ('pending','approved','checked_in')`);
  } else if (scope === 'history') {
    conds.push(`b.status IN ('completed','cancelled','rejected','no_show')`);
  }

  if (q.status) {
    const statuses = String(q.status).split(',').filter((s) => bkrules.STATUS_LABELS[s]);
    if (statuses.length) {
      conds.push(`b.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  if (q.deviceId) {
    conds.push('b.device_id = ?');
    params.push(Number(q.deviceId));
  }
  if (q.labId) {
    conds.push('b.lab_id = ?');
    params.push(Number(q.labId));
  }
  if (q.userId && viewer.role !== 'student') {
    conds.push('b.user_id = ?');
    params.push(Number(q.userId));
  }
  if (q.from) {
    const ts = parseDateTime(`${q.from} 00:00`, tz);
    if (ts !== null) {
      conds.push('b.end_at >= ?');
      params.push(ts);
    }
  }
  if (q.to) {
    const ts = parseDateTime(`${q.to} 23:59`, tz);
    if (ts !== null) {
      conds.push('b.start_at <= ?');
      params.push(ts);
    }
  }
  if (q.keyword) {
    const kw = `%${String(q.keyword).trim()}%`;
    conds.push('(b.code LIKE ? OR b.purpose LIKE ? OR d.name LIKE ? OR u.name LIKE ?)');
    params.push(kw, kw, kw, kw);
  }
  if (q.ongoing === 'true' || q.ongoing === true) {
    const now = Date.now();
    conds.push('b.start_at <= ? AND b.end_at >= ?');
    params.push(now, now);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = Number(db.scalar(`SELECT COUNT(*) AS c FROM bookings b JOIN devices d ON d.id = b.device_id JOIN users u ON u.id = b.user_id ${where}`, params) || 0);

  const orderMap = {
    start_desc: 'b.start_at DESC',
    start_asc: 'b.start_at ASC',
    created_desc: 'b.created_at DESC',
    created_asc: 'b.created_at ASC',
  };
  const order = orderMap[q.order] || 'b.start_at DESC';
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20));

  const rows = db.all(
    `${bookingSelectSql()} ${where} ORDER BY ${order}, b.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );

  const items = rows.map((row) =>
    presenters.booking(row, viewer, { canReview: canReviewBooking(viewer, row) }),
  );

  // 分状态计数，便于前端 Tab 徽标
  const counts = {};
  for (const s of Object.keys(bkrules.STATUS_LABELS)) counts[s] = 0;
  const countRows = db.all(
    `SELECT b.status, COUNT(*) AS c FROM bookings b JOIN devices d ON d.id = b.device_id JOIN users u ON u.id = b.user_id ${where} GROUP BY b.status`,
    params,
  );
  for (const r of countRows) counts[r.status] = Number(r.c);

  return { items, total, page, pageSize, counts, scope };
}

/** 预约详情（含操作日志） */
function detail(viewer, id) {
  const row = getRow(id);
  if (!row) throw notFound('预约不存在');
  const isOwner = row.user_id === viewer.id;
  const canReview = canReviewBooking(viewer, row);
  if (!isOwner && !canReview && viewer.role !== 'admin') {
    throw forbidden('无权查看该预约详情');
  }
  const out = presenters.booking(row, viewer, { canReview });
  out.timeline = buildTimeline(row);
  out.device = presenters.device(
    db.get(`SELECT d.*, u.name AS owner_name FROM devices d LEFT JOIN users u ON u.id = d.owner_id WHERE d.id = ?`, [row.device_id]),
  );
  out.cancelDeadlineHours = config.num('cancel_deadline_hours');
  out.checkinGraceMinutes = config.num('checkin_grace_minutes');
  return out;
}

/** 构建预约生命周期时间线（用于详情页可视化） */
function buildTimeline(row) {
  const tz = config.num('timezone_offset_minutes');
  const nodes = [
    { key: 'created', label: '提交申请', at: row.created_at, by: row.user_name || '', note: row.purpose },
  ];
  if (row.reviewed_at) {
    nodes.push({
      key: row.status === 'rejected' ? 'rejected' : 'reviewed',
      label: row.status === 'rejected' ? '审批驳回' : '审批通过',
      at: row.reviewed_at,
      by: row.reviewer_name || '审批人',
      note: row.status === 'rejected' ? row.reject_reason : row.review_note,
    });
  }
  if (row.checked_in_at) nodes.push({ key: 'checkin', label: '现场签到', at: row.checked_in_at, by: row.user_name || '', note: '' });
  if (row.checked_out_at) {
    nodes.push({
      key: 'checkout',
      label: '签退完成',
      at: row.checked_out_at,
      by: row.user_name || '',
      note: row.actual_minutes ? `实际使用 ${humanDuration(row.actual_minutes)}` : '',
    });
  }
  if (row.status === 'cancelled') nodes.push({ key: 'cancelled', label: '取消预约', at: row.updated_at, by: '', note: row.cancel_reason });
  if (row.status === 'no_show') nodes.push({ key: 'no_show', label: '判定爽约', at: row.updated_at, by: 'system', note: '超过签到宽限期未签到' });
  return nodes
    .sort((a, b) => a.at - b.at)
    .map((n) => ({ ...n, timeText: formatDateTime(n.at, tz) }));
}

/* ------------------------------ 创建预约 ------------------------------ */

function loadBookingContext(deviceId, userId) {
  const device = db.get('SELECT * FROM devices WHERE id = ?', [Number(deviceId)]);
  if (!device) throw notFound('设备不存在');
  const lab = db.get('SELECT * FROM labs WHERE id = ?', [device.lab_id]);
  const user = db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw notFound('用户不存在');
  return { device, lab, user };
}

/**
 * 创建预约（并发安全）
 * @param {object} user 申请人
 * @param {object} payload { deviceId, startAt|startText, endAt|endText, purpose, courseName, participants }
 */
async function create(user, payload) {
  const tz = config.num('timezone_offset_minutes');
  const startAt = normalizeTime(payload.startAt ?? payload.startText, tz, 'startAt');
  const endAt = normalizeTime(payload.endAt ?? payload.endText, tz, 'endAt');
  const purpose = String(payload.purpose || '').trim();
  if (purpose.length < 4) throw badRequest('请填写至少 4 个字的预约用途');
  if (purpose.length > 300) throw badRequest('预约用途过长（最多 300 字）');
  const courseName = String(payload.courseName || '').trim().slice(0, 100);
  const participants = Math.max(1, Math.min(config.num('max_participants_per_booking'), Number(payload.participants) || 1));

  return db.writeTx(async (conn) => {
    const { device, lab, user: fresh } = loadBookingContext(payload.deviceId, user.id);
    // 事务内重新校验：这是并发唯一性的关键
    const check = conflictRules.validateBookingRequest({
      device,
      lab,
      user: fresh,
      startAt,
      endAt,
      now: Date.now(),
    });
    if (!check.ok) {
      throw new AppError(409, check.rule, check.message, { rule: check.rule, detail: check.detail });
    }

    const initialStatus = Number(device.auto_approve) === 1 && fresh.role === 'student' ? 'approved' : 'pending';
    const now = Date.now();
    const insert = conn
      .prepare(
        `INSERT INTO bookings (code, device_id, lab_id, user_id, start_at, end_at, purpose, course_name,
             participants, status, checkin_code, review_note, reviewed_by, reviewed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'TMP',
        device.id,
        device.lab_id,
        fresh.id,
        startAt,
        endAt,
        purpose,
        courseName,
        participants,
        initialStatus,
        '',
        '',
        null,
        0,
        now,
        now,
      );
    const bookingId = Number(insert.lastInsertRowid);
    const code = buildCode(startAt);
    conn.prepare('UPDATE bookings SET code = ? WHERE id = ?').run(code, bookingId);

    if (initialStatus === 'approved') {
      const checkinCode = generateCheckinCode();
      conn
        .prepare('UPDATE bookings SET checkin_code = ?, reviewed_at = ?, review_note = ? WHERE id = ?')
        .run(checkinCode, now, '设备免审批，系统自动通过', bookingId);
      notification.notify({
        userId: fresh.id,
        type: 'booking.approved',
        title: '预约已自动通过',
        content: `${device.name}（${code}）${formatDateTime(startAt, tz)} ~ ${formatDateTime(endAt, tz)} 已通过，签到码 ${checkinCode}，请按时到场签到。`,
        link: `#/bookings/${bookingId}`,
      });
    } else {
      notification.notify({
        userId: fresh.id,
        type: 'booking.submitted',
        title: '预约申请已提交',
        content: `${device.name}（${code}）${formatDateTime(startAt, tz)} ~ ${formatDateTime(endAt, tz)}，等待实验室负责人审批。`,
        link: `#/bookings/${bookingId}`,
      });
      notifyReviewers(device, lab, {
        type: 'booking.pending_review',
        title: '有新的预约申请待审批',
        content: `${fresh.name} 申请 ${device.name}：${formatDateTime(startAt, tz)} ~ ${formatDateTime(endAt, tz)}（${purpose}）。`,
        link: '#/review',
      });
    }

    audit.log({
      userId: fresh.id,
      actorName: fresh.name,
      action: 'booking.create',
      targetType: 'booking',
      targetId: bookingId,
      detail: { code, deviceId: device.id, startAt, endAt, status: initialStatus },
    });
    return presenters.booking(getRow(bookingId), user, { canReview: false });
  });
}

/** 生成可读预约编号：BK + 日期 + 当日序号 */
function buildCode(startAt) {
  const tz = config.num('timezone_offset_minutes');
  const datePart = formatDate(startAt, tz).replace(/-/g, '');
  const count = Number(
    db.scalar(
      `SELECT COUNT(*) AS c FROM bookings WHERE code LIKE ?`,
      [`BK${datePart}-%`],
    ) || 0,
  );
  let seq = count + 1;
  // 极端并发下避免编号重复
  for (let i = 0; i < 200; i += 1) {
    const code = `BK${datePart}-${String(seq).padStart(4, '0')}`;
    if (!db.get('SELECT id FROM bookings WHERE code = ?', [code])) return code;
    seq += 1;
  }
  return `BK${datePart}-${Date.now().toString(36).toUpperCase()}`;
}

function normalizeTime(value, tz, field) {
  if (value === undefined || value === null || value === '') {
    throw badRequest(`缺少参数 ${field}`);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const ts = parseDateTime(String(value), tz);
  if (ts === null) throw badRequest(`参数 ${field} 时间格式应为 YYYY-MM-DD HH:mm`);
  return ts;
}

/** 通知该实验室的负责人（管理员兜底） */
function notifyReviewers(device, lab, payload) {
  const managers = db
    .all('SELECT user_id FROM lab_managers WHERE lab_id = ?', [device.lab_id])
    .map((r) => r.user_id);
  if (device.owner_id) managers.push(device.owner_id);
  if (!managers.length) {
    db.all("SELECT id FROM users WHERE role = 'admin'").forEach((r) => managers.push(r.id));
  }
  notification.notifyMany(managers, payload);
  void lab;
}

/* ------------------------------ 审批 ------------------------------ */

async function approve(reviewer, bookingId, note = '') {
  return db.writeTx(async (conn) => {
    const row = getRow(bookingId);
    if (!row) throw notFound('预约不存在');
    if (!canReviewBooking(reviewer, row)) throw forbidden('您不是该实验室的负责人，无权审批');
    bkrules.assertTransition(row.status, 'approved', '审批通过');

    const now = Date.now();
    // 过期未开始的预约不允许通过（避免批准历史时间）
    if (row.end_at < now) {
      throw new AppError(409, 'R04', '该预约时段已过期，无法审批通过，请驳回并让申请人重新提交');
    }
    const checkinCode = generateCheckinCode();
    conn
      .prepare(
        `UPDATE bookings SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ?,
             checkin_code = ?, updated_at = ? WHERE id = ?`,
      )
      .run(String(note || '').slice(0, 300), reviewer.id, now, checkinCode, now, bookingId);

    notification.notify({
      userId: row.user_id,
      type: 'booking.approved',
      title: '预约已通过审批',
      content: `${row.device_name}（${row.code}）${formatDateTime(row.start_at, config.num('timezone_offset_minutes'))} ~ ${formatDateTime(row.end_at, config.num('timezone_offset_minutes'))} 已通过。签到码：${checkinCode}${note ? `；审批意见：${note}` : ''}`,
      link: `#/bookings/${bookingId}`,
    });

    // 若此前因爽约被扣分，重新获批时按配置恢复
    if (config.bool('credit_restore_on_approve')) {
      const v = db.get(
        "SELECT id, points FROM violations WHERE booking_id = ? AND type IN ('no_show','late_cancel') ORDER BY id DESC LIMIT 1",
        [bookingId],
      );
      if (v) {
        credit.restore(row.user_id, v.points, `预约 ${row.code} 重新获批，撤销原扣分`, {
          refType: 'booking',
          refId: bookingId,
        });
      }
    }

    audit.log({
      userId: reviewer.id,
      actorName: reviewer.name,
      action: 'booking.approve',
      targetType: 'booking',
      targetId: bookingId,
      detail: { code: row.code, note },
    });
    return presenters.booking(getRow(bookingId), reviewer, { canReview: true });
  });
}

async function reject(reviewer, bookingId, reason) {
  const text = String(reason || '').trim();
  if (text.length < 2) throw badRequest('请填写驳回原因');
  return db.writeTx(async (conn) => {
    const row = getRow(bookingId);
    if (!row) throw notFound('预约不存在');
    if (!canReviewBooking(reviewer, row)) throw forbidden('您不是该实验室的负责人，无权审批');
    bkrules.assertTransition(row.status, 'rejected', '驳回');
    const now = Date.now();
    conn
      .prepare(
        `UPDATE bookings SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(text.slice(0, 300), reviewer.id, now, now, bookingId);
    notification.notify({
      userId: row.user_id,
      type: 'booking.rejected',
      title: '预约申请被驳回',
      content: `${row.device_name}（${row.code}）的申请被驳回：${text}`,
      link: `#/bookings/${bookingId}`,
    });
    audit.log({
      userId: reviewer.id,
      actorName: reviewer.name,
      action: 'booking.reject',
      targetType: 'booking',
      targetId: bookingId,
      detail: { code: row.code, reason: text },
    });
    // 释放时段，触发候补补位
    await promoteWaitlistForBooking(conn, row, `预约 ${row.code} 被驳回，时段已释放`);
    return presenters.booking(getRow(bookingId), reviewer, { canReview: true });
  });
}

/* ------------------------------ 取消 ------------------------------ */

/**
 * 取消预约：本人或审批人/管理员
 * 若距离开始时间不足 cancel_deadline_hours，记一次「临时取消」违约并扣分
 */
async function cancel(actor, bookingId, reason = '') {
  const text = String(reason || '').trim() || '用户主动取消';
  return db.writeTx(async (conn) => {
    const row = getRow(bookingId);
    if (!row) throw notFound('预约不存在');
    const isOwner = row.user_id === actor.id;
    const canReview = canReviewBooking(actor, row);
    if (!isOwner && !canReview && actor.role !== 'admin') throw forbidden('无权取消该预约');
    bkrules.assertTransition(row.status, 'cancelled', '取消');

    const now = Date.now();
    conn
      .prepare(`UPDATE bookings SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?`)
      .run(text.slice(0, 300), now, bookingId);

    // 临时取消违约判定（仅针对本人取消，且预约尚未开始）
    const deadlineHours = config.num('cancel_deadline_hours');
    let violated = false;
    if (isOwner && row.start_at > now && row.start_at - now < deadlineHours * 3600 * 1000) {
      credit.recordViolation({
        userId: row.user_id,
        bookingId,
        type: 'late_cancel',
        detail: `预约 ${row.code} 在开始前 ${humanDuration(Math.max(1, Math.round((row.start_at - now) / MINUTE)))} 取消（规定需提前 ${deadlineHours} 小时）`,
        at: now,
      });
      violated = true;
    }

    notification.notify({
      userId: row.user_id,
      type: 'booking.cancelled',
      title: '预约已取消',
      content: `${row.device_name}（${row.code}）已取消：${text}${violated ? '。注意：本次属于临近开始取消，已记一次违约并扣减信用分。' : ''}`,
      link: `#/bookings/${bookingId}`,
    });
    if (!isOwner) {
      notification.notify({
        userId: row.user_id,
        type: 'booking.cancelled_by_admin',
        title: '预约被管理员取消',
        content: `${row.device_name}（${row.code}）已由 ${actor.name} 取消：${text}`,
        link: `#/bookings/${bookingId}`,
      });
    }
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'booking.cancel',
      targetType: 'booking',
      targetId: bookingId,
      detail: { code: row.code, reason: text, byOwner: isOwner, violated },
    });
    await promoteWaitlistForBooking(conn, row, `预约 ${row.code} 已取消，时段释放`);
    return presenters.booking(getRow(bookingId), actor, { canReview });
  });
}

/* ------------------------------ 签到 / 签退 ------------------------------ */

/**
 * 现场签到：需校验签到码 + 时间窗口（开始前 N 分钟 ~ 开始后宽限期）
 */
async function checkin(user, bookingId, code) {
  return db.writeTx(async (conn) => {
    const row = getRow(bookingId);
    if (!row) throw notFound('预约不存在');
    if (row.user_id !== user.id) throw forbidden('只能为本人预约签到');
    bkrules.assertTransition(row.status, 'checked_in', '签到');
    if (!row.checkin_code) throw conflict('该预约尚未生成签到码，请等待审批通过');
    if (String(code || '').trim() !== row.checkin_code) {
      throw new AppError(400, 'BAD_CHECKIN_CODE', '签到码不正确，请核对设备现场张贴/审批通知中的 6 位数字');
    }
    const now = Date.now();
    const openBefore = config.num('checkin_open_before_minutes') * MINUTE;
    const grace = config.num('checkin_grace_minutes') * MINUTE;
    if (now < row.start_at - openBefore) {
      throw new AppError(
        409,
        'CHECKIN_TOO_EARLY',
        `尚未到签到时间，最早可在预约开始前 ${config.num('checkin_open_before_minutes')} 分钟签到（${formatDateTime(row.start_at - openBefore, config.num('timezone_offset_minutes'))}）`,
      );
    }
    if (now > row.start_at + grace) {
      throw new AppError(409, 'CHECKIN_TOO_LATE', '已超过签到宽限期，该预约将被判定为爽约，请联系实验室管理员');
    }
    conn
      .prepare('UPDATE bookings SET status = ?, checkin_checked = 1, checked_in_at = ?, updated_at = ? WHERE id = ?')
      .run('checked_in', now, now, bookingId);
    notification.notify({
      userId: row.user_id,
      type: 'booking.checkin',
      title: '签到成功',
      content: `${row.device_name}（${row.code}）已于 ${formatDateTime(now, config.num('timezone_offset_minutes'))} 签到，请按规范使用设备，结束前记得签退。`,
      link: `#/bookings/${bookingId}`,
    });
    audit.log({
      userId: user.id,
      actorName: user.name,
      action: 'booking.checkin',
      targetType: 'booking',
      targetId: bookingId,
      detail: { code: row.code },
    });
    return presenters.booking(getRow(bookingId), user, { canReview: false });
  });
}

/**
 * 签退：计算实际使用时长，超出预约结束时间 + 宽限期则记「超时占用」违约
 */
async function checkout(user, bookingId) {
  return db.writeTx(async (conn) => {
    const row = getRow(bookingId);
    if (!row) throw notFound('预约不存在');
    const canReview = canReviewBooking(user, row);
    if (row.user_id !== user.id && !canReview && user.role !== 'admin') throw forbidden('无权操作该预约');
    bkrules.assertTransition(row.status, 'completed', '签退');

    const now = Date.now();
    const plannedEnd = row.end_at;
    const graceMs = config.num('overtime_grace_minutes') * MINUTE;
    const actualEnd = Math.min(now, plannedEnd);
    const actualMinutes = Math.max(
      1,
      Math.round((actualEnd - (row.checked_in_at || row.start_at)) / MINUTE),
    );
    const overtimeMinutes = now > plannedEnd + graceMs ? Math.round((now - plannedEnd) / MINUTE) : 0;

    conn
      .prepare(
        `UPDATE bookings SET status = 'completed', checked_out_at = ?, actual_minutes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, actualMinutes, now, bookingId);

    let violation = null;
    if (overtimeMinutes > 0) {
      violation = credit.recordViolation({
        userId: row.user_id,
        bookingId,
        type: 'overtime',
        detail: `预约 ${row.code} 超时占用 ${humanDuration(overtimeMinutes)}`,
        at: now,
      });
    }
    notification.notify({
      userId: row.user_id,
      type: 'booking.completed',
      title: '签退成功',
      content: `${row.device_name}（${row.code}）已签退，实际使用 ${humanDuration(actualMinutes)}。${violation ? `超时 ${humanDuration(overtimeMinutes)}，已扣 ${violation.points} 分。` : '感谢规范使用设备。'}`,
      link: `#/bookings/${bookingId}`,
    });
    audit.log({
      userId: user.id,
      actorName: user.name,
      action: 'booking.checkout',
      targetType: 'booking',
      targetId: bookingId,
      detail: { code: row.code, actualMinutes, overtimeMinutes },
    });

    // 提前释放的时段可以给候补用户
    if (now < plannedEnd) {
      await promoteWaitlistForBooking(conn, row, `预约 ${row.code} 提前结束，时段释放`, row.checked_in_at || now);
    }
    return presenters.booking(getRow(bookingId), user, { canReview });
  });
}

/** 爽约判定（由定时任务调用）：返回处理条数 */
function processNoShows(now = Date.now()) {
  const grace = config.num('checkin_grace_minutes') * MINUTE;
  const rows = db.all(
    `SELECT b.*, d.name AS device_name FROM bookings b JOIN devices d ON d.id = b.device_id
     WHERE b.status IN ('pending','approved') AND b.start_at + ? < ?
       AND b.checkin_checked = 0 AND d.checkin_required = 1`,
    [grace, now],
  );
  let count = 0;
  for (const row of rows) {
    db.writeTxSync((conn) => {
      conn
        .prepare(`UPDATE bookings SET status = 'no_show', updated_at = ? WHERE id = ? AND status IN ('pending','approved')`)
        .run(now, row.id);
      credit.recordViolation({
        userId: row.user_id,
        bookingId: row.id,
        type: 'no_show',
        detail: `预约 ${row.code}（${row.device_name}）超过签到宽限期未签到`,
        at: now,
      });
      audit.log({
        userId: null,
        actorName: 'system',
        action: 'booking.no_show',
        targetType: 'booking',
        targetId: row.id,
        detail: { code: row.code },
      });
    });
    promoteWaitlistSync(row, `预约 ${row.code} 爽约，时段释放`, now);
    count += 1;
  }
  return count;
}

/** 发送开始前提醒（由定时任务调用） */
function processReminders(now = Date.now()) {
  const window = config.num('reminder_minutes') * MINUTE;
  const rows = db.all(
    `SELECT b.*, d.name AS device_name FROM bookings b JOIN devices d ON d.id = b.device_id
     WHERE b.status = 'approved' AND b.reminder_sent = 0 AND b.start_at > ? AND b.start_at <= ?`,
    [now, now + window],
  );
  for (const row of rows) {
    db.run('UPDATE bookings SET reminder_sent = 1 WHERE id = ?', [row.id]);
    notification.notify({
      userId: row.user_id,
      type: 'booking.reminder',
      title: '预约即将开始',
      content: `${row.device_name}（${row.code}）将于 ${formatDateTime(row.start_at, config.num('timezone_offset_minutes'))} 开始，请提前到场并在 ${config.num('checkin_grace_minutes')} 分钟内签到（签到码 ${row.checkin_code}）。`,
      link: `#/bookings/${row.id}`,
    });
  }
  return rows.length;
}

/* ------------------------------ 候补队列 ------------------------------ */

async function joinWaitlist(user, payload) {
  const tz = config.num('timezone_offset_minutes');
  const startAt = normalizeTime(payload.startAt ?? payload.startText, tz, 'startAt');
  const endAt = normalizeTime(payload.endAt ?? payload.endText, tz, 'endAt');
  if (startAt >= endAt) throw badRequest('候补开始时间必须早于结束时间');
  if (startAt < Date.now()) throw badRequest('不能候补已经过去的时间段');
  const purpose = String(payload.purpose || '').trim().slice(0, 300);

  return db.writeTx(async () => {
    const { device, lab, user: fresh } = loadBookingContext(payload.deviceId, user.id);
    if (fresh.status !== 'active') throw conflict('账号状态异常，无法加入候补队列');
    if (device.status !== 'available' || (lab && lab.status !== 'active')) {
      throw conflict('该设备当前不可预约，无需候补');
    }
    // 候补的前提是「确实被占用」，否则应直接预约
    const busy = conflictRules.collectBusyIntervals(device.id, device.lab_id, startAt, endAt);
    const blocked = busy.bookings.some((b) =>
      interval.overlaps({ start: b.start_at, end: b.end_at }, { start: startAt, end: endAt }),
    );
    if (!blocked) {
      throw conflict('该时段当前空闲，请直接提交预约申请', { hint: 'DIRECT_BOOKING' });
    }
    const dup = db.get(
      `SELECT id FROM waitlist WHERE device_id = ? AND user_id = ? AND status IN ('waiting','promoted')
         AND start_at < ? AND end_at > ?`,
      [device.id, fresh.id, endAt, startAt],
    );
    if (dup) throw conflict('您已在候补该时段，请勿重复排队');
    const now = Date.now();
    const res = db.run(
      `INSERT INTO waitlist (device_id, user_id, start_at, end_at, purpose, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`,
      [device.id, fresh.id, startAt, endAt, purpose, now, now],
    );
    const id = res.lastInsertRowid;
    // 排队位次：同一毫秒内可能有多条记录（并发排队），因此用自增 id 作为次序的兜底比较键
    const pos = Number(
      db.scalar(
        `SELECT COUNT(*) AS c FROM waitlist
         WHERE device_id = ? AND status = 'waiting' AND start_at < ? AND end_at > ?
           AND (created_at < ? OR (created_at = ? AND id < ?))`,
        [device.id, endAt, startAt, now, now, id],
      ) || 0,
    ) + 1;
    notification.notify({
      userId: fresh.id,
      type: 'waitlist.joined',
      title: '已加入候补队列',
      content: `${device.name} ${formatDateTime(startAt, tz)} ~ ${formatDateTime(endAt, tz)} 已加入候补，当前排在第 ${pos} 位。一旦有人取消，系统会自动为您补位并通知您确认。`,
      link: '#/waitlist',
    });
    audit.log({
      userId: fresh.id,
      actorName: fresh.name,
      action: 'waitlist.join',
      targetType: 'waitlist',
      targetId: id,
      detail: { deviceId: device.id, startAt, endAt },
    });
    return waitlistRow(id, user);
  });
}

function waitlistRow(id, viewer) {
  const row = db.get(
    `SELECT w.*, d.name AS device_name, l.name AS lab_name, u.name AS user_name
     FROM waitlist w JOIN devices d ON d.id = w.device_id JOIN labs l ON l.id = d.lab_id
     JOIN users u ON u.id = w.user_id WHERE w.id = ?`,
    [id],
  );
  return presenters.waitlist(row, viewer);
}

function listWaitlist(viewer, q = {}) {
  const conds = [];
  const params = [];
  if (viewer.role === 'admin') {
    conds.push('1 = 1');
  } else if (viewer.role === 'teacher') {
    const labs = reviewerLabIds(viewer);
    if (labs.length) {
      conds.push(`(w.user_id = ? OR d.lab_id IN (${labs.map(() => '?').join(',')}))`);
      params.push(viewer.id, ...labs);
    } else {
      conds.push('w.user_id = ?');
      params.push(viewer.id);
    }
  } else {
    conds.push('w.user_id = ?');
    params.push(viewer.id);
  }
  if (q.scope === 'mine') {
    conds.push('w.user_id = ?');
    params.push(viewer.id);
  }
  if (q.status) {
    conds.push('w.status = ?');
    params.push(q.status);
  } else if (q.scope !== 'all') {
    conds.push("w.status IN ('waiting','promoted')");
  }
  if (q.deviceId) {
    conds.push('w.device_id = ?');
    params.push(Number(q.deviceId));
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const total = Number(
    db.scalar(
      `SELECT COUNT(*) AS c FROM waitlist w JOIN devices d ON d.id = w.device_id ${where}`,
      params,
    ) || 0,
  );
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
  const rows = db.all(
    `SELECT w.*, d.name AS device_name, l.name AS lab_name, u.name AS user_name
     FROM waitlist w JOIN devices d ON d.id = w.device_id JOIN labs l ON l.id = d.lab_id
     JOIN users u ON u.id = w.user_id
     ${where}
     ORDER BY CASE w.status WHEN 'promoted' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, w.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { items: rows.map((r) => presenters.waitlist(r, viewer)), total, page, pageSize };
}

async function leaveWaitlist(user, id) {
  return db.writeTx(async (conn) => {
    const row = db.get('SELECT * FROM waitlist WHERE id = ?', [id]);
    if (!row) throw notFound('候补记录不存在');
    if (row.user_id !== user.id && user.role !== 'admin') throw forbidden('只能退出自己的候补');
    if (!['waiting', 'promoted'].includes(row.status)) throw conflict('该候补记录已结束，无需退出');
    conn.prepare(`UPDATE waitlist SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(Date.now(), id);
    // 若原本是"待确认"状态，顺延给下一位候补
    if (row.status === 'promoted') {
      await promoteWaitlistForWindow(conn, row.device_id, row.start_at, row.end_at, '前一位候补已放弃，顺延补位');
    }
    return waitlistRow(id, user);
  });
}

/**
 * 确认候补补位：把 promoted 的候补转成正式预约
 * 采用「重新走一遍完整冲突校验」的策略，保证不会挤掉后来者
 */
/**
 * 确认候补补位
 * ------------------------------------------------------------------
 * 补位时系统已经为该候补创建了一条「占位预约」（pending），因此确认操作
 * 只需把这条占位预约正式登记下来，而**不是**再创建一条新预约 ——
 * 否则占位预约本身就构成时段冲突（R10），会把用户自己挡在门外。
 * 同时会重新执行一次冲突校验，避免出现「占位期间被管理员另批了别的预约」的情况。
 */
async function confirmWaitlist(user, id) {
  return db.writeTx(async (conn) => {
    const row = getWaitlistRow(id);
    if (!row) throw notFound('候补记录不存在');
    if (row.user_id !== user.id) throw forbidden('只能确认自己的候补');
    if (row.status !== 'promoted') throw conflict('该候补当前不是待确认状态');
    if (row.expires_at && row.expires_at < Date.now()) throw conflict('确认时限已过，该候补已失效');
    if (!row.booking_id) throw conflict('该候补尚未生成占位预约，请重新加入候补队列');

    const bookingRow = getRow(row.booking_id);
    if (!bookingRow) throw notFound('占位预约不存在，请联系管理员');
    if (bookingRow.status !== 'pending') {
      throw conflict(`占位预约当前状态为「${bkrules.STATUS_LABELS[bookingRow.status] || bookingRow.status}」，无法确认`);
    }

    const device = db.get('SELECT * FROM devices WHERE id = ?', [bookingRow.device_id]);
    const lab = db.get('SELECT * FROM labs WHERE id = ?', [bookingRow.lab_id]);
    // 排除占位预约自身后再校验一次，确保补位时段确实可用
    const check = conflictRules.validateBookingRequest({
      device,
      lab,
      user,
      startAt: bookingRow.start_at,
      endAt: bookingRow.end_at,
      excludeBookingId: bookingRow.id,
      now: Date.now(),
    });
    if (!check.ok) {
      throw new AppError(409, check.rule, `该时段已被占用，无法确认补位：${check.message}`, {
        rule: check.rule,
        detail: check.detail,
      });
    }

    const now = Date.now();
    conn
      .prepare(
        `UPDATE bookings SET status = 'pending', waitlist_id = COALESCE(waitlist_id, ?), updated_at = ?
         WHERE id = ?`,
      )
      .run(id, now, bookingRow.id);
    conn.prepare('UPDATE waitlist SET status = ?, updated_at = ? WHERE id = ?').run('converted', now, id);

    notification.notify({
      userId: user.id,
      type: 'waitlist.confirmed',
      title: '补位成功，预约已生成',
      content: `${device.name}（${bookingRow.code}）已由候补补位，${bookingRow.status === 'approved' ? '预约已生效' : '请等待实验室负责人审批'}。`,
      link: `#/bookings/${bookingRow.id}`,
    });
    audit.log({
      userId: user.id,
      actorName: user.name,
      action: 'waitlist.convert',
      targetType: 'waitlist',
      targetId: id,
      detail: { bookingId: bookingRow.id, code: bookingRow.code },
    });
    return {
      waitlist: waitlistRow(id, user),
      booking: presenters.booking(getRow(bookingRow.id), user, { canReview: false }),
    };
  });
}

/** 读取候补原始行（带设备与用户信息） */
function getWaitlistRow(id) {
  return db.get(
    `SELECT w.*, d.name AS device_name, l.name AS lab_name, u.name AS user_name
     FROM waitlist w JOIN devices d ON d.id = w.device_id JOIN labs l ON l.id = d.lab_id
     JOIN users u ON u.id = w.user_id WHERE w.id = ?`,
    [id],
  );
}

/**
 * 预约释放后触发候补补位（异步版本，需在写事务内调用）
 */
async function promoteWaitlistForBooking(conn, bookingRow, reason, releaseFrom = null) {
  return promoteWaitlistForWindow(conn, bookingRow.device_id, releaseFrom || bookingRow.start_at, bookingRow.end_at, reason);
}

/**
 * 在指定时间窗内尝试为候补队列补位：
 * 依「申请时间先后」依次尝试，每个候补需要满足完整冲突校验才会被提升
 */
async function promoteWaitlistForWindow(conn, deviceId, from, to, reason) {
  const candidates = db.all(
    `SELECT w.*, u.name AS user_name, u.status AS user_status, u.credit_score
     FROM waitlist w JOIN users u ON u.id = w.user_id
     WHERE w.device_id = ? AND w.status = 'waiting' AND w.start_at < ? AND w.end_at > ?
     ORDER BY w.created_at ASC, w.id ASC`,
    [deviceId, to, from],
  );
  if (process.env.LAB_DEBUG_PROMOTION === '1') {
    console.log(
      `[promotion] window device=${deviceId} ${new Date(from).toISOString()}~${new Date(to).toISOString()} 候选 ${candidates.length} 条`,
    );
  }
  if (!candidates.length) return null;

  const device = db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
  const lab = db.get('SELECT * FROM labs WHERE id = ?', [device.lab_id]);
  const now = Date.now();
  const holdMs = config.num('waitlist_hold_minutes') * MINUTE;

  for (const cand of candidates) {
    const user = db.get('SELECT * FROM users WHERE id = ?', [cand.user_id]);
    // 候补窗口与释放时段求交集
    const startAt = Math.max(cand.start_at, from);
    const endAt = Math.min(cand.end_at, to);
    const minLen = Math.max(15, Number(device.min_minutes)) * MINUTE;
    if (endAt - startAt < minLen) {
      promotionDiag(cand, 'SKIP_TOO_SHORT', { minutes: (endAt - startAt) / MINUTE, need: minLen / MINUTE });
      continue;
    }
    if (startAt < now) {
      promotionDiag(cand, 'SKIP_IN_PAST', { startAt });
      continue;
    }
    const check = conflictRules.validateBookingRequest({
      device,
      lab,
      user,
      startAt,
      endAt,
      now,
    });
    if (!check.ok) {
      promotionDiag(cand, `SKIP_${check.rule}`, { message: check.message, detail: check.detail });
      continue;
    }

    const insert = conn
      .prepare(
        `INSERT INTO bookings (code, device_id, lab_id, user_id, start_at, end_at, purpose, course_name,
             participants, status, checkin_code, review_note, reviewed_by, reviewed_at, waitlist_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', 1, 'pending', '', ?, NULL, 0, ?, ?, ?)`,
      )
      .run(
        'TMP',
        device.id,
        device.lab_id,
        user.id,
        startAt,
        endAt,
        cand.purpose || '候补补位预约',
        `候补自动补位：${reason}`,
        cand.id,
        now,
        now,
      );
    const bookingId = Number(insert.lastInsertRowid);
    const code = buildCode(startAt);
    conn.prepare('UPDATE bookings SET code = ? WHERE id = ?').run(code, bookingId);
    conn
      .prepare(`UPDATE waitlist SET status = 'promoted', promoted_at = ?, expires_at = ?, booking_id = ?, updated_at = ? WHERE id = ?`)
      .run(now, now + holdMs, bookingId, now, cand.id);

    notification.notify({
      userId: user.id,
      type: 'waitlist.promoted',
      title: '候补成功，请尽快确认',
      content: `${device.name} ${formatDateTime(startAt, config.num('timezone_offset_minutes'))} ~ ${formatDateTime(endAt, config.num('timezone_offset_minutes'))} 已为您保留，请在 ${config.num('waitlist_hold_minutes')} 分钟内确认，逾期将顺延给下一位。原因：${reason}`,
      link: '#/waitlist',
    });
    audit.log({
      userId: null,
      actorName: 'system',
      action: 'waitlist.promote',
      targetType: 'waitlist',
      targetId: cand.id,
      detail: { bookingId, code, reason },
    });
    return { waitlistId: cand.id, bookingId, code };
  }
  return null;
}

/** 同步版补位（供定时任务使用） */
function promoteWaitlistSync(bookingRow, reason, now = Date.now()) {
  // 定时任务在同步上下文中运行，这里用同步事务完成「决策 + 写入」
  let result = null;
  const deviceId = bookingRow.device_id;
  const from = bookingRow.start_at;
  const to = bookingRow.end_at;
  const candidates = db.all(
    `SELECT w.* FROM waitlist w JOIN users u ON u.id = w.user_id
     WHERE w.device_id = ? AND w.status = 'waiting' AND w.start_at < ? AND w.end_at > ? AND u.status = 'active'
     ORDER BY w.created_at ASC, w.id ASC`,
    [deviceId, to, from],
  );
  const device = db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
  const lab = db.get('SELECT * FROM labs WHERE id = ?', [device.lab_id]);
  const holdMs = config.num('waitlist_hold_minutes') * MINUTE;
  for (const cand of candidates) {
    const user = db.get('SELECT * FROM users WHERE id = ?', [cand.user_id]);
    const startAt = Math.max(cand.start_at, from);
    const endAt = Math.min(cand.end_at, to);
    if (endAt - startAt < Math.max(15, Number(device.min_minutes)) * MINUTE) continue;
    if (startAt < now) continue;
    const check = conflictRules.validateBookingRequest({ device, lab, user, startAt, endAt, now });
    if (!check.ok) continue;
    result = db.writeTxSync((conn) => {
      const insert = conn
        .prepare(
          `INSERT INTO bookings (code, device_id, lab_id, user_id, start_at, end_at, purpose, course_name,
               participants, status, checkin_code, review_note, reviewed_by, reviewed_at, waitlist_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '', 1, 'pending', '', ?, NULL, 0, ?, ?, ?)`,
        )
        .run('TMP', device.id, device.lab_id, user.id, startAt, endAt, cand.purpose || '候补补位预约', `候补自动补位：${reason}`, cand.id, now, now);
      const bookingId = Number(insert.lastInsertRowid);
      conn.prepare('UPDATE bookings SET code = ? WHERE id = ?').run(buildCode(startAt), bookingId);
      conn
        .prepare(`UPDATE waitlist SET status = 'promoted', promoted_at = ?, expires_at = ?, booking_id = ?, updated_at = ? WHERE id = ?`)
        .run(now, now + holdMs, bookingId, now, cand.id);
      return { waitlistId: cand.id, bookingId, code: buildCode(startAt) };
    });
    notification.notify({
      userId: user.id,
      type: 'waitlist.promoted',
      title: '候补成功，请尽快确认',
      content: `${device.name} ${formatDateTime(startAt, config.num('timezone_offset_minutes'))} ~ ${formatDateTime(endAt, config.num('timezone_offset_minutes'))} 已为您保留，请在 ${config.num('waitlist_hold_minutes')} 分钟内确认。原因：${reason}`,
      link: '#/waitlist',
    });
    break;
  }
  return result;
}

/** 处理候补确认超时：顺延给下一位 */
async function expireWaitlistHolds(now = Date.now()) {
  const rows = db.all(
    `SELECT * FROM waitlist WHERE status = 'promoted' AND expires_at > 0 AND expires_at <= ?`,
    [now],
  );
  for (const row of rows) {
    await db.writeTx(async (conn) => {
      conn.prepare(`UPDATE waitlist SET status = 'expired', updated_at = ? WHERE id = ?`).run(now, row.id);
      if (row.booking_id) {
        conn
          .prepare(`UPDATE bookings SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
          .run('候补确认超时，系统自动释放', now, row.booking_id);
      }
      notification.notify({
        userId: row.user_id,
        type: 'waitlist.expired',
        title: '候补确认超时',
        content: '您在规定时间内未确认补位，该时段已顺延给下一位候补用户。',
        link: '#/waitlist',
      });
      await promoteWaitlistForWindow(conn, row.device_id, row.start_at, row.end_at, '前一位候补确认超时，顺延补位');
    });
  }
  return rows.length;
}

/* ------------------------------ 导出 ------------------------------ */

/** 导出预约记录为 CSV（带 BOM，Excel 可直接打开） */
function exportCsv(viewer, q = {}) {
  const { items } = list(viewer, { ...q, page: 1, pageSize: 200 });
  const header = [
    '预约编号',
    '设备',
    '实验室',
    '申请人',
    '所属单位',
    '日期',
    '时段',
    '时长(分钟)',
    '用途',
    '课程',
    '参与人数',
    '状态',
    '审批人',
    '审批时间',
    '签到时间',
    '签退时间',
    '实际使用(分钟)',
  ];
  const lines = [header.join(',')];
  for (const b of items) {
    lines.push(
      [
        b.code,
        b.deviceName,
        b.labName,
        b.userName,
        b.userDepartment,
        b.dateText,
        b.timeText,
        b.durationMinutes,
        b.purpose,
        b.courseName,
        b.participants,
        b.statusLabel,
        b.reviewerName,
        b.reviewedText,
        b.checkedInText,
        b.checkedOutText,
        b.actualMinutes,
      ]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

module.exports = {
  list,
  detail,
  create,
  approve,
  reject,
  cancel,
  checkin,
  checkout,
  processNoShows,
  processReminders,
  joinWaitlist,
  listWaitlist,
  leaveWaitlist,
  confirmWaitlist,
  expireWaitlistHolds,
  promoteWaitlistForWindow,
  promoteWaitlistForBooking,
  canReviewBooking,
  reviewerLabIds,
  exportCsv,
  getRow,
  findByCode,
  buildCode,
  ACTIVE,
};
