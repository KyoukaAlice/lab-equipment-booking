'use strict';

/**
 * 可用时段计算服务（系统核心算法之三）
 * ------------------------------------------------------------------
 * 核心公式：
 *     可用时段 = (每周开放排班 ∩ 查询窗口) － (已占用预约 ∪ 停机计划)
 * 其中「已占用预约」按状态过滤（待审批是否占位由配置 pending_blocks_others 决定），
 * 再按最小可用时长过滤掉碎片，最终输出可直接渲染为日历的时段块。
 *
 * 区间运算全部使用左闭右开语义，见 core/interval.js。
 */

const db = require('../db');
const config = require('../core/config');
const interval = require('../core/interval');
const bkrules = require('../core/booking-rules');
const {
  MINUTE,
  DAY,
  formatDate,
  formatClock,
  formatDateTime,
  weekdayOfDayStart,
  startOfDay,
  addDays,
  humanDuration,
} = require('../utils/time');
const { scheduleForRange, collectBusyIntervals } = require('../core/conflict-rules');

/**
 * 单台设备、单日的完整时间视图
 * @param {object} device
 * @param {number} dayStart 该自然日 00:00 时间戳
 */
function deviceDayView(device, dayStart) {
  const tz = config.num('timezone_offset_minutes');
  const dayEnd = dayStart + DAY;
  const now = Date.now();
  const minMinutes = 15; // 小于 15 分钟的碎片不作为可预约时段展示

  const schedule = scheduleForRange(device, dayStart, dayEnd, tz);
  const busy = collectBusyIntervals(device.id, device.lab_id, dayStart, dayEnd);
  const occupancy = [
    ...busy.bookings.map((b) => ({
      kind: 'booking',
      id: b.id,
      code: b.code,
      start: b.start_at,
      end: b.end_at,
      status: b.status,
      statusLabel: bkrules.STATUS_LABELS[b.status] || b.status,
      owner: b.user_name,
      department: b.department,
      title: b.purpose,
      /** 是否对当前用户可见详情（本人或审批人），默认仅自己可见 */
      mine: false,
    })),
    ...busy.blackouts.map((b) => ({
      kind: 'blackout',
      id: b.id,
      start: b.start_at,
      end: b.end_at,
      status: 'blackout',
      statusLabel: '不可用',
      title: b.reason,
      blackoutKind: b.kind,
    })),
  ].sort((a, b) => a.start - b.start);

  const blockers = [
    ...busy.bookings.map((b) => ({ start: b.start_at, end: b.end_at })),
    ...busy.blackouts.map((b) => ({ start: b.start_at, end: b.end_at })),
  ];
  const rawFree = interval.subtract(schedule, blockers);
  const free = rawFree
    .filter((s) => s.end - s.start >= minMinutes * MINUTE)
    .map((s) => ({
      start: s.start,
      end: s.end,
      minutes: Math.round((s.end - s.start) / MINUTE),
      startClock: formatClock(s.start, tz),
      endClock: formatClock(s.end, tz),
      /** 已经过去或不足最小提前量的空闲块不可选 */
      selectable: s.start >= now + config.num('booking_min_lead_minutes') * MINUTE,
      maxBookableMinutes: Math.min(
        Number(device.max_minutes),
        Math.round((s.end - s.start) / MINUTE),
      ),
    }));

  return {
    date: formatDate(dayStart, tz),
    dayStart,
    weekday: weekdayOfDayStart(dayStart, tz),
    schedule: schedule.map((s) => ({
      start: s.start,
      end: s.end,
      startClock: formatClock(s.start, tz),
      endClock: formatClock(s.end, tz),
      minutes: Math.round((s.end - s.start) / MINUTE),
    })),
    occupancy,
    free,
    /** 当设备完全被停机/关闭占满时为 true，前端显示为深灰 */
    closed: schedule.length === 0,
  };
}

/**
 * 设备未来 N 天的可用性概览（用于周历视图）
 * @param {object} device
 * @param {string} fromDate "YYYY-MM-DD"
 * @param {number} days
 */
function deviceRangeView(device, fromDate, days = 7) {
  const tz = config.num('timezone_offset_minutes');
  const { parseDate } = require('../utils/time');
  let first = parseDate(fromDate, tz);
  if (first === null) {
    first = startOfDay(Date.now(), tz);
  }
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const view = deviceDayView(device, addDays(first, i));
    out.push({
      date: view.date,
      weekday: view.weekday,
      closed: view.closed,
      freeMinutes: view.free.reduce((sum, f) => sum + f.minutes, 0),
      freeCount: view.free.length,
      /** 当日首个可选空闲块，用于列表页快速引导 */
      firstSelectable: view.free.find((f) => f.selectable) || null,
      occupancyCount: view.occupancy.length,
    });
  }
  return out;
}

/**
 * 设备未来可用性统计：用于设备列表页显示「今日可约 / 本周可约」
 */
function deviceAvailabilitySummary(device, days = 7) {
  const tz = config.num('timezone_offset_minutes');
  const today = startOfDay(Date.now(), tz);
  const range = deviceRangeView(device, formatDate(today, tz), days);
  const todayView = range[0];
  const totalFree = range.reduce((sum, d) => sum + d.freeMinutes, 0);
  const scheduleMinutes = range.reduce(
    (sum, d, idx) => sum + deviceDayView(device, addDays(today, idx)).schedule.reduce((s, x) => s + x.minutes, 0),
    0,
  );
  return {
    todayFreeMinutes: todayView ? todayView.freeMinutes : 0,
    todayFreeCount: todayView ? todayView.freeCount : 0,
    todayFirstSelectable: todayView ? todayView.firstSelectable : null,
    weekFreeMinutes: totalFree,
    weekScheduleMinutes: scheduleMinutes,
    /** 未来 7 天剩余可预约率（1 - 已占用率） */
    utilization: scheduleMinutes > 0 ? Number((1 - totalFree / scheduleMinutes).toFixed(4)) : 0,
    busyDays: range.filter((d) => d.freeCount === 0).map((d) => d.date),
  };
}

/**
 * 在多设备之间寻找「共同空闲时段」——团队协作预约场景
 * @param {number[]} deviceIds
 * @param {string} fromDate
 * @param {number} days
 * @param {number} minMinutes
 */
function commonFreeSlots(deviceIds, fromDate, days = 7, minMinutes = 60) {
  const tz = config.num('timezone_offset_minutes');
  const { parseDate } = require('../utils/time');
  const devices = deviceIds
    .map((id) => db.get('SELECT * FROM devices WHERE id = ?', [id]))
    .filter(Boolean);
  if (devices.length < 2) return [];
  let first = parseDate(fromDate, tz);
  if (first === null) first = startOfDay(Date.now(), tz);

  const results = [];
  for (let i = 0; i < days; i += 1) {
    const dayStart = addDays(first, i);
    const dayEnd = dayStart + DAY;
    const perDevice = devices.map((d) => {
      const schedule = scheduleForRange(d, dayStart, dayEnd, tz);
      const busy = collectBusyIntervals(d.id, d.lab_id, dayStart, dayEnd);
      const blockers = [
        ...busy.bookings.map((b) => ({ start: b.start_at, end: b.end_at })),
        ...busy.blackouts.map((b) => ({ start: b.start_at, end: b.end_at })),
      ];
      return interval.subtract(schedule, blockers);
    });
    // 依次求交集
    let acc = perDevice[0] || [];
    for (let k = 1; k < perDevice.length; k += 1) {
      const next = [];
      for (const a of acc) {
        for (const b of perDevice[k]) {
          const s = Math.max(a.start, b.start);
          const e = Math.min(a.end, b.end);
          if (e - s >= minMinutes * MINUTE) next.push({ start: s, end: e });
        }
      }
      acc = interval.merge(next);
    }
    if (acc.length) {
      results.push({
        date: formatDate(dayStart, tz),
        slots: acc.map((s) => ({
          start: s.start,
          end: s.end,
          text: `${formatDateTime(s.start, tz)} ~ ${formatClock(s.end, tz)}`,
          minutes: Math.round((s.end - s.start) / MINUTE),
          durationText: humanDuration(Math.round((s.end - s.start) / MINUTE)),
        })),
      });
    }
  }
  return results;
}

/**
 * 候补命中判断：当某条预约被取消/驳回时，找出候补时间窗与之重叠且仍在等待的记录
 * （返回按申请时间升序排列，保证先到先得）
 */
function findWaitlistHits(deviceId, startAt, endAt) {
  return db.all(
    `SELECT w.*, u.name AS user_name, u.credit_score, u.status AS user_status
     FROM waitlist w JOIN users u ON u.id = w.user_id
     WHERE w.device_id = ? AND w.status = 'waiting' AND w.start_at < ? AND w.end_at > ?
     ORDER BY w.created_at ASC, w.id ASC`,
    [deviceId, endAt, startAt],
  );
}

module.exports = {
  deviceDayView,
  deviceRangeView,
  deviceAvailabilitySummary,
  commonFreeSlots,
  findWaitlistHits,
};
