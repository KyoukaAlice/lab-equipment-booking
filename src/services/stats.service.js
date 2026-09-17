'use strict';

/**
 * 统计分析服务
 * ------------------------------------------------------------------
 * 说明：利用率 = 已占用时长 / 该设备在该时段的「排班开放总时长」，
 * 排班时长由 weekly_slots 真实推导（而不是简单按 24 小时估算），因此数值可信。
 */

const db = require('../db');
const config = require('../core/config');
const bkrules = require('../core/booking-rules');
const interval = require('../core/interval');
const { scheduleForRange } = require('../core/conflict-rules');
const presenters = require('./presenters');
const {
  MINUTE,
  DAY,
  HOUR,
  formatDate,
  formatDateTime,
  parseDate,
  parseDateTime,
  startOfDay,
  addDays,
  eachDayStart,
  humanDuration,
  WEEKDAY_NAMES,
} = require('../utils/time');

/** 解析时间范围，默认最近 30 天 */
function resolveRange(q = {}) {
  const tz = config.num('timezone_offset_minutes');
  const now = Date.now();
  let from = q.from ? parseDateTime(`${q.from} 00:00`, tz) : null;
  let to = q.to ? parseDateTime(`${q.to} 23:59`, tz) : null;
  if (from === null) from = startOfDay(now - 29 * DAY, tz);
  if (to === null) to = now;
  if (to <= from) to = from + DAY;
  return { from, to, fromDate: formatDate(from, tz), toDate: formatDate(to, tz), tz };
}

/** 全局概览指标 */
function overview(q = {}) {
  const { from, to, fromDate, toDate, tz } = resolveRange(q);
  const now = Date.now();
  const todayStart = startOfDay(now, tz);
  const todayEnd = todayStart + DAY;

  const totalUsers = Number(db.scalar('SELECT COUNT(*) AS c FROM users') || 0);
  const students = Number(db.scalar("SELECT COUNT(*) AS c FROM users WHERE role = 'student'") || 0);
  const teachers = Number(db.scalar("SELECT COUNT(*) AS c FROM users WHERE role = 'teacher'") || 0);
  const activeUsers = Number(db.scalar("SELECT COUNT(*) AS c FROM users WHERE status = 'active'") || 0);
  const frozenUsers = Number(db.scalar("SELECT COUNT(*) AS c FROM users WHERE status = 'frozen'") || 0);

  const totalDevices = Number(db.scalar('SELECT COUNT(*) AS c FROM devices') || 0);
  const availableDevices = Number(db.scalar("SELECT COUNT(*) AS c FROM devices WHERE status = 'available'") || 0);
  const maintenanceDevices = Number(db.scalar("SELECT COUNT(*) AS c FROM devices WHERE status = 'maintenance'") || 0);

  const totalBookings = Number(db.scalar('SELECT COUNT(*) AS c FROM bookings') || 0);
  const rangeBookings = Number(
    db.scalar('SELECT COUNT(*) AS c FROM bookings WHERE start_at >= ? AND start_at < ?', [from, to]) || 0,
  );
  const pendingCount = Number(db.scalar("SELECT COUNT(*) AS c FROM bookings WHERE status = 'pending'") || 0);
  const checkedInCount = Number(db.scalar("SELECT COUNT(*) AS c FROM bookings WHERE status = 'checked_in'") || 0);
  const todayBookings = Number(
    db.scalar('SELECT COUNT(*) AS c FROM bookings WHERE start_at >= ? AND start_at < ?', [todayStart, todayEnd]) || 0,
  );
  const weeklyWaitlist = Number(
    db.scalar("SELECT COUNT(*) AS c FROM waitlist WHERE status IN ('waiting','promoted')") || 0,
  );

  const statusRows = db.all(
    'SELECT status, COUNT(*) AS c FROM bookings GROUP BY status',
  );
  const statusDistribution = Object.keys(bkrules.STATUS_LABELS).map((s) => {
    const found = statusRows.find((r) => r.status === s);
    return { status: s, label: bkrules.STATUS_LABELS[s], count: found ? Number(found.c) : 0 };
  });

  const util = utilizationList({ from, to });

  return {
    range: { fromDate, toDate, from, to },
    users: { total: totalUsers, students, teachers, active: activeUsers, frozen: frozenUsers },
    devices: {
      total: totalDevices,
      available: availableDevices,
      maintenance: maintenanceDevices,
      busyNow: checkedInCount,
      /** 当前时刻正在使用中的设备数（含未签到的已通过预约） */
      inUseNow: Number(
        db.scalar(
          `SELECT COUNT(DISTINCT device_id) AS c FROM bookings
           WHERE status IN ('approved','checked_in') AND start_at <= ? AND end_at >= ?`,
          [now, now],
        ) || 0,
      ),
    },
    bookings: {
      total: totalBookings,
      inRange: rangeBookings,
      pending: pendingCount,
      today: todayBookings,
      statusDistribution,
    },
    waitlist: { active: weeklyWaitlist },
    labs: Number(db.scalar('SELECT COUNT(*) AS c FROM labs') || 0),
    avgUtilization: util.items.length
      ? Number((util.items.reduce((s, it) => s + it.utilization, 0) / util.items.length).toFixed(4))
      : 0,
  };
}

/**
 * 设备利用率排行
 * @param {object} p { from, to, labId, limit }
 */
function utilizationList({ from, to, labId = null, limit = 0 } = {}) {
  const params = [];
  let labCond = '';
  if (labId) {
    labCond = 'AND d.lab_id = ?';
    params.push(Number(labId));
  }
  const devices = db.all(
    `SELECT d.*, l.name AS lab_name FROM devices d JOIN labs l ON l.id = d.lab_id
     WHERE 1 = 1 ${labCond} ORDER BY d.lab_id, d.id`,
    params,
  );
  const statuses = bkrules.occupyingStatuses();
  const ph = statuses.map(() => '?').join(',');
  const now = Date.now();
  const dayCount = Math.max(1, Math.ceil((to - from) / DAY));
  /**
   * 利用率的统计窗口右端：不超过「当前时刻」。
   * 设计原因：若查询区间延伸到未来（默认区间就是「最近 30 天 ~ 现在」，而切换
   * 「未来 7 天」视图时区间会落到未来），把尚未到来的排班时长也计入分母，会把
   * 利用率严重稀释（例如过去已用满是 60%，但因未来 14 天的空排班被算入而显示 0.5%）。
   * 因此分母只统计「已经历过的开放时长」，与分子（已发生的占用时长）时间口径一致。
   */
  const windowEnd = Math.min(to, now);

  const items = devices.map((device) => {
    const schedule = scheduleForRange(device, from, windowEnd, config.num('timezone_offset_minutes'));
    const scheduleMinutes = Math.round(interval.totalDuration(schedule) / MINUTE);
    const rows = db.all(
      `SELECT start_at, end_at, status FROM bookings
       WHERE device_id = ? AND status IN (${ph}) AND start_at < ? AND end_at > ?`,
      [device.id, ...statuses, windowEnd, from],
    );
    // 裁剪到查询窗口后再累加，避免把窗口外时长算进来
    const clipped = rows
      .map((r) => ({ start: Math.max(r.start_at, from), end: Math.min(r.end_at, windowEnd) }))
      .filter((r) => r.end > r.start);
    const bookedMinutes = Math.round(interval.totalDuration(clipped) / MINUTE);
    const approvedMinutes = Math.round(
      interval.totalDuration(
        rows
          .filter((r) => ['approved', 'checked_in', 'completed'].includes(r.status))
          .map((r) => ({ start: Math.max(r.start_at, from), end: Math.min(r.end_at, windowEnd) }))
          .filter((r) => r.end > r.start),
      ) / MINUTE,
    );
    const bookingCount = rows.length;
    const completed = rows.filter((r) => r.status === 'completed').length;
    const noShow = Number(
      db.scalar(
        `SELECT COUNT(*) AS c FROM bookings WHERE device_id = ? AND status = 'no_show' AND start_at >= ? AND start_at < ?`,
        [device.id, from, to],
      ) || 0,
    );
    return {
      deviceId: device.id,
      deviceName: device.name,
      category: device.category,
      labId: device.lab_id,
      labName: device.lab_name,
      status: device.status,
      statusLabel: presenters.device(device).statusLabel,
      scheduleMinutes,
      scheduleText: humanDuration(scheduleMinutes),
      bookedMinutes,
      bookedText: humanDuration(bookedMinutes),
      approvedMinutes,
      bookingCount,
      completedCount: completed,
      noShowCount: noShow,
      /** 利用率：占用时长 / 排班开放时长 */
      utilization: scheduleMinutes > 0 ? Number((bookedMinutes / scheduleMinutes).toFixed(4)) : 0,
      /** 日均使用时长（分钟） */
      avgMinutesPerDay: Math.round(bookedMinutes / dayCount),
      /** 未来 7 天是否还有空档 */
      hasUpcomingFree: now < to,
      priceFen: device.price_fen,
      /** 设备价值产出比：每分钟使用对应的设备价值（演示用衍生指标） */
      valueEfficiency:
        bookedMinutes > 0 ? Number(((device.price_fen / 100) / bookedMinutes).toFixed(2)) : 0,
    };
  });

  items.sort((a, b) => b.utilization - a.utilization || b.bookedMinutes - a.bookedMinutes);
  if (limit > 0) return { items: items.slice(0, limit), total: items.length, range: { from, to } };
  return { items, total: items.length, range: { from, to } };
}

/** 实验室维度汇总 */
function labSummary({ from, to } = {}) {
  const utilization = utilizationList({ from, to });
  const labs = db.all('SELECT * FROM labs ORDER BY id');
  return labs.map((lab) => {
    const rows = utilization.items.filter((it) => it.labId === lab.id);
    const scheduleMinutes = rows.reduce((s, r) => s + r.scheduleMinutes, 0);
    const bookedMinutes = rows.reduce((s, r) => s + r.bookedMinutes, 0);
    const count = Number(
      db.scalar('SELECT COUNT(*) AS c FROM bookings WHERE lab_id = ? AND start_at >= ? AND start_at < ?', [
        lab.id,
        from,
        to,
      ]) || 0,
    );
    const noShow = Number(
      db.scalar(
        `SELECT COUNT(*) AS c FROM bookings b WHERE b.lab_id = ? AND b.status = 'no_show' AND b.start_at >= ? AND b.start_at < ?`,
        [lab.id, from, to],
      ) || 0,
    );
    return {
      labId: lab.id,
      labName: lab.name,
      code: lab.code,
      deviceCount: rows.length,
      scheduleMinutes,
      scheduleText: humanDuration(scheduleMinutes),
      bookedMinutes,
      bookedText: humanDuration(bookedMinutes),
      bookingCount: count,
      noShowCount: noShow,
      utilization: scheduleMinutes > 0 ? Number((bookedMinutes / scheduleMinutes).toFixed(4)) : 0,
      /** 设备利用率差异，反映资源分配是否均衡 */
      deviceUtilizationSpread: rows.length
        ? Number(
            (
              Math.max(...rows.map((r) => r.utilization)) - Math.min(...rows.map((r) => r.utilization))
            ).toFixed(4),
          )
        : 0,
      topDevice: rows.length ? rows[0].deviceName : '',
    };
  });
}

/** 时段分布：星期 × 小时 热力图 + 高峰时段 Top N */
function hourlyHeatmap({ from, to, labId = null } = {}) {
  const tz = config.num('timezone_offset_minutes');
  const params = [from, to];
  let labCond = '';
  if (labId) {
    labCond = 'AND b.lab_id = ?';
    params.push(Number(labId));
  }
  const rows = db.all(
    `SELECT b.start_at, b.end_at FROM bookings b
     WHERE b.status IN ('approved','checked_in','completed') AND b.start_at < ? AND b.end_at > ? ${labCond}`,
    [to, from, ...params.slice(2)],
  );
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of rows) {
    const start = Math.max(r.start_at, from);
    const end = Math.min(r.end_at, to);
    let cursor = start;
    while (cursor < end) {
      const local = new Date(cursor + tz * MINUTE);
      const weekday = local.getUTCDay();
      const hour = local.getUTCHours();
      const nextHour = cursor + (60 - local.getUTCMinutes()) * MINUTE;
      const sliceEnd = Math.min(end, nextHour);
      grid[weekday][hour] += Math.round((sliceEnd - cursor) / MINUTE);
      cursor = sliceEnd;
    }
  }
  const cells = [];
  for (let wd = 0; wd < 7; wd += 1) {
    for (let h = 0; h < 24; h += 1) {
      if (grid[wd][h] > 0) cells.push({ weekday: wd, weekdayLabel: WEEKDAY_NAMES[wd], hour: h, minutes: grid[wd][h] });
    }
  }
  cells.sort((a, b) => b.minutes - a.minutes);
  const maxMinutes = cells.length ? cells[0].minutes : 0;
  return {
    grid,
    weekdayLabels: WEEKDAY_NAMES,
    cells,
    maxMinutes,
    peakHours: cells.slice(0, 5).map((c) => ({
      label: `${c.weekdayLabel} ${String(c.hour).padStart(2, '0')}:00-${String((c.hour + 1) % 24).padStart(2, '0')}:00`,
      minutes: c.minutes,
      text: humanDuration(c.minutes),
      bookings: 0,
    })),
  };
}

/** 用户使用排行与失信统计 */
function userStats({ from, to, limit = 10 } = {}) {
  const rows = db.all(
    `SELECT u.id, u.name, u.role, u.department, u.credit_score, u.status,
            COUNT(b.id) AS total,
            SUM(CASE WHEN b.status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN b.status = 'no_show' THEN 1 ELSE 0 END) AS no_show,
            SUM(CASE WHEN b.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            COALESCE(SUM(CASE WHEN b.status IN ('completed','checked_in','approved') THEN b.end_at - b.start_at ELSE 0 END), 0) AS minutes
     FROM users u LEFT JOIN bookings b ON b.user_id = u.id AND b.start_at >= ? AND b.start_at < ?
     GROUP BY u.id ORDER BY total DESC, minutes DESC LIMIT ?`,
    [from, to, limit],
  );
  const items = rows.map((r) => {
    const total = Number(r.total) || 0;
    const noShow = Number(r.no_show) || 0;
    const cancelled = Number(r.cancelled) || 0;
    return {
      userId: r.id,
      name: r.name,
      role: r.role,
      roleLabel: { admin: '管理员', teacher: '教师', student: '学生' }[r.role] || r.role,
      department: r.department,
      creditScore: r.credit_score,
      userStatus: r.status,
      totalBookings: total,
      completedCount: Number(r.completed) || 0,
      noShowCount: noShow,
      cancelledCount: cancelled,
      minutes: Math.round(Number(r.minutes) / MINUTE),
      minutesText: humanDuration(Math.round(Number(r.minutes) / MINUTE)),
      /** 履约率 = (完成) / (完成 + 爽约) */
      fulfillmentRate:
        Number(r.completed) + noShow > 0
          ? Number((Number(r.completed) / (Number(r.completed) + noShow)).toFixed(4))
          : 1,
    };
  });
  const blacklist = items
    .filter((i) => i.noShowCount > 0 || i.creditScore < config.num('credit_freeze_threshold'))
    .sort((a, b) => a.creditScore - b.creditScore)
    .slice(0, 5);
  return { items, blacklist };
}

/** 占用状态构成（用于饼图：自由 / 已预约 / 维护停机） */
function timeComposition({ from, to, labId = null } = {}) {
  const utilization = utilizationList({ from, to, labId });
  const scheduleMinutes = utilization.items.reduce((s, r) => s + r.scheduleMinutes, 0);
  const bookedMinutes = utilization.items.reduce((s, r) => s + r.bookedMinutes, 0);
  const blackoutRows = db.all(
    `SELECT start_at, end_at FROM blackouts WHERE start_at < ? AND end_at > ? ${labId ? 'AND lab_id = ?' : ''}`,
    labId ? [to, from, Number(labId)] : [to, from],
  );
  const blackoutMinutes = Math.round(
    interval.totalDuration(
      blackoutRows
        .map((r) => ({ start: Math.max(r.start_at, from), end: Math.min(r.end_at, to) }))
        .filter((r) => r.end > r.start),
    ) / MINUTE,
  );
  const free = Math.max(0, scheduleMinutes - bookedMinutes);
  return {
    scheduleMinutes,
    bookedMinutes,
    blackoutMinutes,
    freeMinutes: free,
    distribution: [
      { key: 'booked', label: '已预约占用', minutes: bookedMinutes, percent: scheduleMinutes ? Number(((bookedMinutes / scheduleMinutes) * 100).toFixed(2)) : 0 },
      { key: 'free', label: '空闲可用', minutes: free, percent: scheduleMinutes ? Number(((free / scheduleMinutes) * 100).toFixed(2)) : 0 },
      { key: 'blackout', label: '维护/停机', minutes: blackoutMinutes, percent: scheduleMinutes ? Number(((blackoutMinutes / scheduleMinutes) * 100).toFixed(2)) : 0 },
    ],
    utilization: scheduleMinutes > 0 ? Number((bookedMinutes / scheduleMinutes).toFixed(4)) : 0,
  };
}

/** 近 N 天的预约趋势（用于折线图） */
function trend({ from, to, labId = null } = {}) {
  const tz = config.num('timezone_offset_minutes');
  const params = [from, to];
  let labCond = '';
  if (labId) {
    labCond = 'AND lab_id = ?';
    params.push(Number(labId));
  }
  const rows = db.all(
    `SELECT start_at, status, end_at FROM bookings WHERE start_at >= ? AND start_at < ? ${labCond}`,
    params,
  );
  const days = eachDayStart(from, to, tz);
  const map = new Map();
  for (const d of days) {
    map.set(formatDate(d, tz), { date: formatDate(d, tz), total: 0, completed: 0, cancelled: 0, noShow: 0, pending: 0, minutes: 0 });
  }
  for (const r of rows) {
    const key = formatDate(r.start_at, tz);
    const bucket = map.get(key);
    if (!bucket) continue;
    bucket.total += 1;
    bucket.minutes += Math.round((r.end_at - r.start_at) / MINUTE);
    if (r.status === 'completed') bucket.completed += 1;
    else if (r.status === 'cancelled') bucket.cancelled += 1;
    else if (r.status === 'no_show') bucket.noShow += 1;
    else if (r.status === 'pending') bucket.pending += 1;
  }
  return { items: [...map.values()], fromDate: formatDate(from, tz), toDate: formatDate(to, tz) };
}

/** 管理端仪表盘所需的全部数据（一次请求返回，减少往返） */
function dashboard(q = {}) {
  const range = resolveRange(q);
  const { from, to, fromDate, toDate } = range;
  const labId = q.labId ? Number(q.labId) : null;
  return {
    overview: overview(q),
    range: { fromDate, toDate },
    labId,
    utilization: utilizationList({ from, to, labId }).items.slice(0, 12),
    utilizationBottom: utilizationList({ from, to, labId }).items.slice(-5).reverse(),
    labs: labSummary({ from, to }),
    heatmap: hourlyHeatmap({ from, to, labId }),
    users: userStats({ from, to, limit: 10 }),
    composition: timeComposition({ from, to, labId }),
    trend: trend({ from, to, labId }),
  };
}

/** 导出统计报表为 CSV */
function exportUtilizationCsv({ from, to, labId = null } = {}) {
  const { items } = utilizationList({ from, to, labId });
  const header = ['设备编号', '设备名称', '类别', '实验室', '状态', '排班开放(分钟)', '已占用(分钟)', '利用率', '预约次数', '爽约次数', '日均使用(分钟)'];
  const lines = [header.join(',')];
  for (const it of items) {
    lines.push(
      [
        it.deviceId,
        it.deviceName,
        it.category,
        it.labName,
        it.statusLabel,
        it.scheduleMinutes,
        it.bookedMinutes,
        `${(it.utilization * 100).toFixed(2)}%`,
        it.bookingCount,
        it.noShowCount,
        it.avgMinutesPerDay,
      ]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

module.exports = {
  resolveRange,
  overview,
  utilizationList,
  labSummary,
  hourlyHeatmap,
  userStats,
  timeComposition,
  trend,
  dashboard,
  exportUtilizationCsv,
};
