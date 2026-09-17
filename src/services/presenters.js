'use strict';

/**
 * 数据展示层（Presenter）
 * ------------------------------------------------------------------
 * 把数据库原始行转换为「前端直接可用」的结构：补充中文标签、格式化时间、
 * 派生的操作权限标记等。所有对外接口的响应都经过这里，避免前端重复拼装。
 */

const db = require('../db');
const config = require('../core/config');
const bkrules = require('../core/booking-rules');
const {
  formatDate,
  formatDateTime,
  formatClock,
  humanDuration,
  WEEKDAY_NAMES,
} = require('../utils/time');

const MINUTE = 60 * 1000;

/** 金额（分）转显示字符串 */
function money(fen) {
  const n = Number(fen) || 0;
  if (n === 0) return '—';
  return `¥${(n / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function tz() {
  return config.num('timezone_offset_minutes');
}

function userBrief(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    roleLabel: { admin: '管理员', teacher: '教师', student: '学生' }[user.role] || user.role,
    department: user.department || '',
    email: user.email || '',
    phone: user.phone || '',
    studentNo: user.student_no || '',
    creditScore: user.credit_score,
    status: user.status,
    statusLabel: { active: '正常', frozen: '已冻结', disabled: '已停用' }[user.status] || user.status,
    frozenReason: user.frozen_reason || '',
    frozenUntil: user.frozen_until || 0,
    weeklyQuotaMinutes: user.weekly_quota_min,
    weeklyQuotaText: humanDuration(user.weekly_quota_min),
    createdAt: user.created_at,
  };
}

/** 当前登录用户的完整信息（含权限标记与信用概览） */
function me(user) {
  const credit = require('../services/credit.service').summary(user.id);
  const managed = db
    .all(
      `SELECT l.id, l.name, l.code FROM lab_managers m JOIN labs l ON l.id = m.lab_id
       WHERE m.user_id = ? ORDER BY l.id`,
      [user.id],
    )
    .map((r) => ({ id: r.id, name: r.name, code: r.code }));
  const unread = require('../services/notification.service').unreadCount(user.id);
  const active = Number(
    db.scalar(
      `SELECT COUNT(*) AS c FROM bookings WHERE user_id = ? AND status IN ('pending','approved','checked_in')`,
      [user.id],
    ) || 0,
  );
  return {
    ...userBrief(user),
    managedLabs: managed,
    canReview: user.role === 'admin' || (user.role === 'teacher' && managed.length > 0),
    credit,
    unreadNotifications: unread,
    activeBookings: active,
    activeBookingLimit: config.num('max_active_bookings_per_user'),
  };
}

function lab(labRow, { withStats = false } = {}) {
  if (!labRow) return null;
  const out = {
    id: labRow.id,
    name: labRow.name,
    code: labRow.code,
    building: labRow.building,
    room: labRow.room,
    location: [labRow.building, labRow.room].filter(Boolean).join(' '),
    capacity: labRow.capacity,
    openHours: labRow.open_hours,
    rules: labRow.rules,
    status: labRow.status,
    statusLabel: labRow.status === 'active' ? '开放中' : '已停用',
    createdAt: labRow.created_at,
    updatedAt: labRow.updated_at,
  };
  out.managers = db
    .all(
      `SELECT u.id, u.name, u.role, u.department, u.email, u.phone FROM lab_managers m
       JOIN users u ON u.id = m.user_id WHERE m.lab_id = ? ORDER BY u.id`,
      [labRow.id],
    )
    .map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      roleLabel: u.role === 'teacher' ? '教师' : u.role === 'admin' ? '管理员' : '学生',
      department: u.department,
      email: u.email,
      phone: u.phone,
    }));
  if (withStats) {
    out.deviceCount = Number(db.scalar('SELECT COUNT(*) AS c FROM devices WHERE lab_id = ?', [labRow.id]) || 0);
    out.availableDeviceCount = Number(
      db.scalar("SELECT COUNT(*) AS c FROM devices WHERE lab_id = ? AND status = 'available'", [labRow.id]) || 0,
    );
  }
  return out;
}

/** 设备周排班（不依赖具体日期，按 weekday 聚合，用于设备详情页展示） */
function weeklyPattern(device, labId) {
  const rows = db.all(
    `SELECT weekday, start_min, end_min FROM weekly_slots
     WHERE lab_id = ? AND (device_id = ? OR device_id IS NULL) AND enabled = 1
       AND (device_id = ? OR NOT EXISTS (
             SELECT 1 FROM weekly_slots d WHERE d.device_id = ? AND d.enabled = 1))
     ORDER BY weekday, start_min`,
    [labId, device.id, device.id, device.id],
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.weekday)) map.set(r.weekday, []);
    map.get(r.weekday).push(`${String(Math.floor(r.start_min / 60)).padStart(2, '0')}:${String(r.start_min % 60).padStart(2, '0')}-${String(Math.floor(r.end_min / 60)).padStart(2, '0')}:${String(r.end_min % 60).padStart(2, '0')}`);
  }
  return [1, 2, 3, 4, 5, 6, 0].map((wd) => ({
    weekday: wd,
    weekdayLabel: WEEKDAY_NAMES[wd],
    ranges: map.get(wd) || [],
  }));
}

function device(row, { withAvailability = false, labInfo = null } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    labId: row.lab_id,
    labName: labInfo ? labInfo.name : row.lab_name || '',
    name: row.name,
    category: row.category,
    model: row.model,
    brand: row.brand,
    serialNo: row.serial_no,
    status: row.status,
    statusLabel: {
      available: '可预约',
      maintenance: '维护中',
      offline: '已停用',
      scrapped: '已报废',
    }[row.status] || row.status,
    bookable: row.status === 'available' && (!labInfo || labInfo.status === 'active'),
    priceFen: row.price_fen,
    priceText: money(row.price_fen),
    purchaseDate: row.purchase_date,
    location: row.location,
    ownerId: row.owner_id,
    ownerName: row.owner_name || '',
    autoApprove: Number(row.auto_approve) === 1,
    checkinRequired: Number(row.checkin_required) === 1,
    minMinutes: row.min_minutes,
    maxMinutes: row.max_minutes,
    minDurationText: humanDuration(row.min_minutes),
    maxDurationText: humanDuration(row.max_minutes),
    leadMinutes: row.lead_minutes,
    description: row.description,
    images: (() => {
      try {
        return JSON.parse(row.images || '[]');
      } catch {
        return [];
      }
    })(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (withAvailability) {
    const availability = require('./availability.service');
    Object.assign(out, availability.deviceAvailabilitySummary(row, 7));
    out.weeklyPattern = weeklyPattern(row, row.lab_id);
    // 未来 7 天正在进行的停机计划
    const now = Date.now();
    out.upcomingBlackouts = db
      .all(
        `SELECT id, start_at, end_at, reason, kind FROM blackouts
         WHERE lab_id = ? AND (device_id = ? OR device_id IS NULL) AND end_at > ?
         ORDER BY start_at LIMIT 5`,
        [row.lab_id, row.id, now],
      )
      .map(blackout);
  }
  return out;
}

function blackout(row) {
  if (!row) return null;
  const t = tz();
  return {
    id: row.id,
    labId: row.lab_id,
    deviceId: row.device_id,
    deviceName: row.device_name || (row.device_id ? '' : '全部设备'),
    scopeLabel: row.device_id ? '指定设备' : '整个实验室',
    startAt: row.start_at,
    endAt: row.end_at,
    startText: formatDateTime(row.start_at, t),
    endText: formatDateTime(row.end_at, t),
    dateText: `${formatDate(row.start_at, t)} ~ ${formatDate(row.end_at, t)}`,
    minutes: Math.round((row.end_at - row.start_at) / MINUTE),
    durationText: humanDuration(Math.round((row.end_at - row.start_at) / MINUTE)),
    reason: row.reason,
    kind: row.kind,
    kindLabel: {
      maintenance: '设备维护',
      calibration: '计量校准',
      holiday: '假期封闭',
      event: '活动占用',
      other: '其他',
    }[row.kind] || row.kind,
    createdBy: row.created_by,
    creatorName: row.creator_name || '',
    createdAt: row.created_at,
  };
}

/**
 * 预约记录转换
 * @param {object} row bookings 行（需 JOIN devices/users）
 * @param {object} [viewer] 当前访问者；非本人且非审批人时隐藏用途与申请人身份
 * @param {{canReview?:boolean, canOperate?:boolean}} [perm]
 */
function booking(row, viewer = null, perm = {}) {
  if (!row) return null;
  const t = tz();
  const durationMinutes = Math.round((row.end_at - row.start_at) / MINUTE);
  const isOwner = viewer ? row.user_id === viewer.id : false;
  const privileged = Boolean(perm.canReview) || (viewer && viewer.role === 'admin');
  const mask = !isOwner && !privileged;

  const now = Date.now();
  const out = {
    id: row.id,
    code: row.code,
    deviceId: row.device_id,
    deviceName: row.device_name || '',
    deviceCategory: row.device_category || '',
    labId: row.lab_id,
    labName: row.lab_name || '',
    labLocation: [row.lab_building, row.lab_room].filter(Boolean).join(' '),
    userId: row.user_id,
    userName: row.user_name || '',
    userUsername: row.user_username || '',
    userDepartment: row.user_department || '',
    userRole: row.user_role || '',
    startAt: row.start_at,
    endAt: row.end_at,
    dateText: formatDate(row.start_at, t),
    timeText: `${formatClock(row.start_at, t)} - ${formatClock(row.end_at, t)}`,
    startText: formatDateTime(row.start_at, t),
    endText: formatDateTime(row.end_at, t),
    durationMinutes,
    durationText: humanDuration(durationMinutes),
    purpose: mask ? '（他人已占用）' : row.purpose,
    courseName: mask ? '' : row.course_name || '',
    participants: row.participants,
    status: row.status,
    statusLabel: bkrules.STATUS_LABELS[row.status] || row.status,
    reviewNote: row.review_note || '',
    rejectReason: row.reject_reason || '',
    cancelReason: row.cancel_reason || '',
    reviewedBy: row.reviewed_by,
    reviewerName: row.reviewer_name || '',
    reviewedAt: row.reviewed_at,
    reviewedText: row.reviewed_at ? formatDateTime(row.reviewed_at, t) : '',
    checkedInAt: row.checked_in_at,
    checkedInText: row.checked_in_at ? formatDateTime(row.checked_in_at, t) : '',
    checkedOutAt: row.checked_out_at,
    checkedOutText: row.checked_out_at ? formatDateTime(row.checked_out_at, t) : '',
    actualMinutes: row.actual_minutes,
    actualText: row.actual_minutes ? humanDuration(row.actual_minutes) : '',
    createdAt: row.created_at,
    createdText: formatDateTime(row.created_at, t),
    /** 是否本人预约 */
    mine: isOwner,
    /** 签到码：本人、审批人（便于现场协助）与管理员可见 */
    checkinCode:
      isOwner || privileged || Boolean(perm.canReview) ? row.checkin_code || '' : '',
    /** 派生时间标记 */
    isFuture: row.start_at > now,
    isOngoing: row.start_at <= now && row.end_at >= now,
    isPast: row.end_at < now,
    /** 可执行操作（前端据此显示按钮，真正的权限仍由后端二次校验） */
    actions: {
      canReview: Boolean(perm.canReview) && row.status === 'pending',
      canCancel:
        (isOwner || Boolean(perm.canReview) || (viewer && viewer.role === 'admin')) &&
        ['pending', 'approved'].includes(row.status),
      canCheckin:
        isOwner &&
        row.status === 'approved' &&
        Number(row.checkin_required ?? 1) === 1 &&
        now >= row.start_at - config.num('checkin_open_before_minutes') * MINUTE &&
        now <= row.start_at + config.num('checkin_grace_minutes') * MINUTE,
      canCheckout: isOwner && row.status === 'checked_in',
      canEdit:
        isOwner &&
        ['pending', 'approved'].includes(row.status) &&
        row.start_at - now > config.num('booking_min_lead_minutes') * MINUTE,
    },
    /** 违约明细（若有） */
    violations: db
      .all('SELECT id, type, points, detail, created_at FROM violations WHERE booking_id = ? ORDER BY created_at', [
        row.id,
      ])
      .map((v) => ({
        id: v.id,
        type: v.type,
        typeLabel: bkrules.VIOLATION_TYPES[v.type] ? bkrules.VIOLATION_TYPES[v.type].label : v.type,
        points: v.points,
        detail: v.detail,
        createdAt: v.created_at,
      })),
    waitlistCount: Number(db.scalar("SELECT COUNT(*) AS c FROM waitlist WHERE device_id = ? AND status = 'waiting'", [row.device_id]) || 0),
  };
  return out;
}

/** 候补记录转换 */
function waitlist(row, viewer = null) {
  const t = tz();
  const isOwner = viewer ? row.user_id === viewer.id : false;
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name || '',
    labName: row.lab_name || '',
    userId: row.user_id,
    userName: row.user_name || '',
    startAt: row.start_at,
    endAt: row.end_at,
    dateText: formatDate(row.start_at, t),
    timeText: `${formatClock(row.start_at, t)} - ${formatClock(row.end_at, t)}`,
    startText: formatDateTime(row.start_at, t),
    durationMinutes: Math.round((row.end_at - row.start_at) / MINUTE),
    purpose: isOwner || !row.user_name ? row.purpose : '（他人候补）',
    status: row.status,
    statusLabel: {
      waiting: '排队中',
      promoted: '待确认',
      expired: '已失效',
      cancelled: '已退出',
      converted: '已转为预约',
    }[row.status] || row.status,
    mine: isOwner,
    promotedAt: row.promoted_at,
    promotedText: row.promoted_at ? formatDateTime(row.promoted_at, t) : '',
    expiresAt: row.expires_at,
    expiresText: row.expires_at ? formatDateTime(row.expires_at, t) : '',
    bookingId: row.booking_id,
    createdAt: row.created_at,
    createdText: formatDateTime(row.created_at, t),
    /** 排队位次（仅本人的 waiting 记录有意义）；同一毫秒用 id 兜底排序 */
    queuePosition:
      row.status === 'waiting'
        ? Number(
            db.scalar(
              `SELECT COUNT(*) AS c FROM waitlist
               WHERE device_id = ? AND status = 'waiting' AND start_at < ? AND end_at > ?
                 AND (created_at < ? OR (created_at = ? AND id < ?))`,
              [row.device_id, row.end_at, row.start_at, row.created_at, row.created_at, row.id],
            ) || 0,
          ) + 1
        : 0,
  };
}

/** 通知转换 */
function notification(row) {
  const t = tz();
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    link: row.link,
    isRead: Number(row.is_read) === 1,
    createdAt: row.created_at,
    createdText: formatDateTime(row.created_at, t),
  };
}

function violation(row) {
  const t = tz();
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name || '',
    bookingId: row.booking_id,
    bookingCode: row.booking_code || '',
    deviceName: row.device_name || '',
    type: row.type,
    typeLabel: bkrules.VIOLATION_TYPES[row.type] ? bkrules.VIOLATION_TYPES[row.type].label : row.type,
    points: row.points,
    detail: row.detail,
    createdBy: row.created_by,
    creatorName: row.creator_name || '',
    createdAt: row.created_at,
    createdText: formatDateTime(row.created_at, t),
  };
}

function creditRecord(row) {
  const t = tz();
  return {
    id: row.id,
    changePoints: row.change_points,
    scoreAfter: row.score_after,
    reason: row.reason,
    refType: row.ref_type,
    refId: row.ref_id,
    createdAt: row.created_at,
    createdText: formatDateTime(row.created_at, t),
  };
}

function auditLog(row) {
  const t = tz();
  return {
    id: row.id,
    userId: row.user_id,
    actorName: row.actor_name,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: row.detail,
    ip: row.ip,
    createdAt: row.created_at,
    createdText: formatDateTime(row.created_at, t),
  };
}

module.exports = {
  money,
  userBrief,
  me,
  lab,
  device,
  booking,
  waitlist,
  notification,
  violation,
  creditRecord,
  auditLog,
  blackout,
  weeklyPattern,
};
