'use strict';

/**
 * 冲突检测规则引擎（系统核心算法之二）
 * ------------------------------------------------------------------
 * 预约能否成立的判定被拆解为「12 条独立规则」，逐条校验并给出
 * 结构化失败原因（规则码 + 中文说明 + 明细），既便于前端提示，
 * 也便于答辩时逐条演示。
 *
 * 规则清单：
 *   R01 设备存在且状态可预约
 *   R02 实验室未被停用
 *   R03 时间参数合法（起点 < 终点）
 *   R04 起点不早于当前时间
 *   R05 提前量满足最小提前分钟数
 *   R06 不超过最大提前天数
 *   R07 时长在设备允许区间内
 *   R08 落在每周开放排班内（不越过排班边界）
 *   R09 不落在停机/封闭计划内
 *   R10 设备时段无冲突（区间重叠检测）
 *   R11 用户自身时间无冲突
 *   R12 用户额度与信用校验（在途数量 / 周额度 / 暂停状态）
 */

const db = require('../db');
const config = require('./config');
const interval = require('./interval');
const { MINUTE, DAY, humanDuration, formatDateTime } = require('../utils/time');
const { AppError } = require('../utils/errors');

/** 取某设备在某天的开放排班（保留分钟级精度），返回 [{start,end}] */
function scheduleForRange(device, from, to, tz) {
  const rows = db.all(
    `SELECT weekday, start_min, end_min FROM weekly_slots
     WHERE lab_id = ? AND (device_id = ? OR device_id IS NULL) AND enabled = 1
       AND (device_id = ? OR NOT EXISTS (
             SELECT 1 FROM weekly_slots d
             WHERE d.device_id = ? AND d.enabled = 1))
     ORDER BY weekday, start_min`,
    [device.lab_id, device.id, device.id, device.id],
  );
  const byWeekday = new Map();
  for (const r of rows) {
    if (!byWeekday.has(r.weekday)) byWeekday.set(r.weekday, []);
    byWeekday.get(r.weekday).push({ start_min: r.start_min, end_min: r.end_min });
  }
  const out = [];
  for (const dayStart of eachDayInRange(from, to, tz)) {
    const weekday = weekdayOfDayStart(dayStart, tz);
    for (const s of byWeekday.get(weekday) || []) {
      out.push({ start: dayStart + s.start_min * MINUTE, end: dayStart + s.end_min * MINUTE });
    }
  }
  return interval.merge(out);
}

/** 遍历 [from,to) 覆盖到的自然日 00:00（内部实现，避免循环依赖） */
function eachDayInRange(from, to, tz) {
  const dayMs = DAY;
  const first = Math.floor((from + tz * MINUTE) / dayMs) * dayMs - tz * MINUTE;
  const out = [];
  for (let cur = first, i = 0; cur < to && i < 400; cur += dayMs, i += 1) {
    if (cur + dayMs > from) out.push(cur);
  }
  return out;
}

function weekdayOfDayStart(dayStart, tz) {
  return new Date(dayStart + tz * MINUTE).getUTCDay();
}

/**
 * 收集影响某设备某时段的「占用区间」
 * @param {number} deviceId
 * @param {number} labId
 * @param {number} from
 * @param {number} to
 * @param {object} [opts]
 * @param {number[]} [opts.statuses] 视为占用的预约状态
 * @param {number} [opts.excludeBookingId] 排除某条预约（改期/重新审批时用）
 */
function collectBusyIntervals(deviceId, labId, from, to, opts = {}) {
  const statuses = opts.statuses || require('./booking-rules').occupyingStatuses();
  const placeholders = statuses.map(() => '?').join(',');
  const params = [deviceId, to, from, ...statuses];
  let exclude = '';
  if (opts.excludeBookingId) {
    exclude = 'AND b.id <> ?';
    params.push(opts.excludeBookingId);
  }
  const bookings = db.all(
    `SELECT b.id, b.code, b.user_id, b.start_at, b.end_at, b.status, b.purpose, u.name AS user_name, u.department
     FROM bookings b JOIN users u ON u.id = b.user_id
     WHERE b.device_id = ? AND b.start_at < ? AND b.end_at > ? AND b.status IN (${placeholders})
       ${exclude}
     ORDER BY b.start_at`,
    params,
  );
  const blackouts = db.all(
    `SELECT id, start_at, end_at, reason, kind FROM blackouts
     WHERE (device_id = ? OR (device_id IS NULL AND lab_id = ?))
       AND start_at < ? AND end_at > ?
     ORDER BY start_at`,
    [deviceId, labId, to, from],
  );
  return {
    bookings: bookings.map((b) => ({ ...b, kind: 'booking' })),
    blackouts: blackouts.map((b) => ({ ...b, kind: 'blackout' })),
  };
}

/** 收集某用户在指定时段的自身占用 */
function collectUserBusy(userId, from, to, excludeBookingId = 0) {
  const statuses = require('./booking-rules').occupyingStatuses();
  const placeholders = statuses.map(() => '?').join(',');
  const params = [userId, to, from, ...statuses];
  let exclude = '';
  if (excludeBookingId) {
    exclude = 'AND b.id <> ?';
    params.push(excludeBookingId);
  }
  return db.all(
    `SELECT b.id, b.code, b.device_id, b.start_at, b.end_at, b.status, d.name AS device_name
     FROM bookings b JOIN devices d ON d.id = b.device_id
     WHERE b.user_id = ? AND b.start_at < ? AND b.end_at > ? AND b.status IN (${placeholders})
       ${exclude}
     ORDER BY b.start_at`,
    params,
  );
}

function fail(rule, message, detail = {}) {
  return { ok: false, rule, message, detail };
}

/**
 * 校验一条预约请求（新增或改期）
 * @param {Object} p
 * @param {object} p.device    设备行（须已确认存在）
 * @param {object} p.lab       实验室行
 * @param {object} p.user      申请人
 * @param {number} p.startAt
 * @param {number} p.endAt
 * @param {number} [p.excludeBookingId] 改期时排除自身
 * @param {number} [p.now]     便于测试注入的当前时间
 * @returns {{ok:true}|{ok:false,rule:string,message:string,detail:object}}
 */
function validateBookingRequest({
  device,
  lab,
  user,
  startAt,
  endAt,
  excludeBookingId = 0,
  now = Date.now(),
}) {
  const tz = config.num('timezone_offset_minutes');

  if (!device) return fail('R01', '设备不存在');
  if (device.status !== 'available') {
    return fail('R01', `设备当前状态为「${device.status}」，暂不可预约`);
  }
  if (lab && lab.status !== 'active') {
    return fail('R02', '所属实验室已停用，暂不可预约');
  }
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) {
    return fail('R03', '预约起止时间格式不正确');
  }
  if (startAt >= endAt) {
    return fail('R03', '预约开始时间必须早于结束时间');
  }
  if (startAt < now) {
    return fail('R04', '不能预约已经过去的时间段', { startAt, now });
  }
  const lead = config.num('booking_min_lead_minutes');
  if (lead > 0 && startAt - now < lead * MINUTE) {
    return fail('R05', `需至少提前 ${lead} 分钟预约`, { leadMinutes: lead });
  }
  const advanceDays = config.num('booking_advance_days');
  if (advanceDays > 0 && startAt - now > advanceDays * DAY) {
    return fail('R06', `最多只能提前 ${advanceDays} 天预约`, { advanceDays });
  }
  const durationMin = Math.round((endAt - startAt) / MINUTE);
  if (durationMin < Number(device.min_minutes)) {
    return fail('R07', `单次预约不得短于 ${humanDuration(device.min_minutes)}`, {
      minMinutes: device.min_minutes,
    });
  }
  if (durationMin > Number(device.max_minutes)) {
    return fail('R07', `单次预约不得超过 ${humanDuration(device.max_minutes)}`, {
      maxMinutes: device.max_minutes,
    });
  }

  // R08 落在开放排班内：请求区间必须被排班区间完整覆盖
  const schedule = scheduleForRange(device, startAt, endAt, tz);
  const covered = schedule.some((s) => s.start <= startAt && s.end >= endAt);
  if (!covered) {
    return fail('R08', '所选时段不在该设备的开放时间内', {
      schedule: schedule.map((s) => ({
        start: s.start,
        end: s.end,
        text: `${formatDateTime(s.start, tz)} ~ ${formatDateTime(s.end, tz)}`,
      })),
    });
  }

  const grace = config.num('overtime_grace_minutes') * MINUTE;
  const busy = collectBusyIntervals(device.id, device.lab_id, startAt - grace, endAt + grace, {
    excludeBookingId,
  });

  // R09 停机计划
  const blackoutHit = busy.blackouts.find((b) =>
    interval.overlaps({ start: b.start_at, end: b.end_at }, { start: startAt, end: endAt }),
  );
  if (blackoutHit) {
    return fail('R09', `该时段设备处于不可用计划中：${blackoutHit.reason}`, {
      blackout: {
        id: blackoutHit.id,
        reason: blackoutHit.reason,
        // 注意：collectBusyIntervals 用 kind 标记记录类型（值为 'blackout'），
        // 因此停机类型需要从 blackouts 表重新读取，避免语义冲突。
        kind: (db.get('SELECT kind FROM blackouts WHERE id = ?', [blackoutHit.id]) || {}).kind || 'other',
        start: blackoutHit.start_at,
        end: blackoutHit.end_at,
      },
    });
  }

  // R10 设备时段冲突
  const bookingHit = busy.bookings.find((b) =>
    interval.overlaps({ start: b.start_at, end: b.end_at }, { start: startAt, end: endAt }),
  );
  if (bookingHit) {
    return fail('R10', '该时段已被占用，请另选时间或加入候补', {
      conflict: {
        bookingId: bookingHit.id,
        code: bookingHit.code,
        status: bookingHit.status,
        start: bookingHit.start_at,
        end: bookingHit.end_at,
        durationMinutes: Math.round((bookingHit.end_at - bookingHit.start_at) / MINUTE),
        occupant: bookingHit.user_name,
        department: bookingHit.department,
      },
    });
  }

  // R11 用户自身时间冲突
  const selfHit = collectUserBusy(user.id, startAt, endAt, excludeBookingId).find((b) =>
    interval.overlaps({ start: b.start_at, end: b.end_at }, { start: startAt, end: endAt }),
  );
  if (selfHit) {
    return fail('R11', `与您自己的另一条预约时间冲突（${selfHit.device_name}）`, {
      conflict: {
        bookingId: selfHit.id,
        code: selfHit.code,
        deviceName: selfHit.device_name,
        start: selfHit.start_at,
        end: selfHit.end_at,
      },
    });
  }

  // R12 额度与信用
  if (user.status === 'frozen') {
    const until = user.frozen_until ? formatDateTime(user.frozen_until, tz) : '管理员解冻前';
    return fail('R12', `账号预约权限已被暂停（${user.frozen_reason || '信用分不足'}），解除时间：${until}`);
  }
  if (user.status === 'disabled') {
    return fail('R12', '账号已被停用，无法预约');
  }
  const maxActive = config.num('max_active_bookings_per_user');
  const activeCount = Number(
    db.scalar(
      `SELECT COUNT(*) AS c FROM bookings
       WHERE user_id = ? AND status IN ('pending','approved','checked_in')`,
      [user.id],
    ) || 0,
  );
  if (activeCount >= maxActive) {
    return fail('R12', `同时在途预约已达上限（${maxActive} 条），请先完成或取消部分预约`, {
      activeCount,
      maxActive,
    });
  }
  // user.weekly_quota_min 可能是 0（表示不允许预约），此时不能回退到默认额度
  const quota = Number.isFinite(Number(user.weekly_quota_min))
    ? Number(user.weekly_quota_min)
    : config.num('max_weekly_minutes_default');
  const weekStart = startOfWeek(startAt, tz);
  const weekEnd = weekStart + 7 * DAY;
  const usedMin = Number(
    db.scalar(
      `SELECT COALESCE(SUM(end_at - start_at), 0) AS s FROM bookings
       WHERE user_id = ? AND status IN ('pending','approved','checked_in','completed')
         AND start_at >= ? AND start_at < ? AND id <> ?`,
      [user.id, weekStart, weekEnd, excludeBookingId],
    ) || 0,
  ) / MINUTE;
  if (usedMin + durationMin > quota) {
    return fail('R12', `本周预约额度不足：已用 ${humanDuration(usedMin)}，额度 ${humanDuration(quota)}`, {
      usedMinutes: usedMin,
      quotaMinutes: quota,
      requestedMinutes: durationMin,
    });
  }

  return { ok: true };
}

/** 该时刻所在自然周的周一 00:00 */
function startOfWeek(ts, tz) {
  const dayStart = Math.floor((ts + tz * MINUTE) / DAY) * DAY - tz * MINUTE;
  const weekday = new Date(dayStart + tz * MINUTE).getUTCDay(); // 0=周日
  const offset = weekday === 0 ? 6 : weekday - 1; // 以周一为一周起点
  return dayStart - offset * DAY;
}

/** 校验失败时抛出统一的 409 冲突异常（携带 rule 便于测试断言） */
function assertBookingRequest(payload) {
  const result = validateBookingRequest(payload);
  if (!result.ok) {
    throw new AppError(409, result.rule, result.message, {
      rule: result.rule,
      detail: result.detail,
    });
  }
  return result;
}

module.exports = {
  scheduleForRange,
  collectBusyIntervals,
  collectUserBusy,
  validateBookingRequest,
  assertBookingRequest,
  startOfWeek,
};
