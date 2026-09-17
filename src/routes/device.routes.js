'use strict';

/**
 * 设备路由（浏览 + 可用性查询 + 多设备共同空闲时段）
 */

const db = require('../db');
const config = require('../core/config');
const availability = require('../services/availability.service');
const presenters = require('../services/presenters');
const { ok, requireLogin, intQuery, pageQuery } = require('../http/helpers');
const { notFound, badRequest } = require('../utils/errors');
const { startOfDay, formatDate, DAY } = require('../utils/time');

/** 设备查询 SQL：附带实验室与负责人信息 */
function deviceSelectSql() {
  return `SELECT d.*, l.name AS lab_name, l.status AS lab_status, l.building AS lab_building,
                 l.room AS lab_room, u.name AS owner_name
          FROM devices d JOIN labs l ON l.id = d.lab_id
          LEFT JOIN users u ON u.id = d.owner_id`;
}

function register(ctx) {
  /** 设备目录（支持实验室、类别、状态、关键字、可用时间筛选） */
  ctx.router.get('/api/devices', async (req) => {
    requireLogin(req);
    const conds = [];
    const params = [];
    if (req.query.labId) {
      conds.push('d.lab_id = ?');
      params.push(intQuery(req, 'labId'));
    }
    if (req.query.category) {
      conds.push('d.category = ?');
      params.push(String(req.query.category));
    }
    if (req.query.status) {
      conds.push('d.status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.keyword) {
      const kw = `%${String(req.query.keyword).trim()}%`;
      conds.push('(d.name LIKE ? OR d.model LIKE ? OR d.brand LIKE ? OR d.category LIKE ? OR d.serial_no LIKE ? OR l.name LIKE ?)');
      params.push(kw, kw, kw, kw, kw, kw);
    }
    if (req.query.bookable === 'true') {
      conds.push("d.status = 'available' AND l.status = 'active'");
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { page, pageSize } = pageQuery(req, 24);
    const total = Number(
      db.scalar(`SELECT COUNT(*) AS c FROM devices d JOIN labs l ON l.id = d.lab_id ${where}`, params) || 0,
    );

    const sortMap = {
      name: 'd.name ASC',
      price_desc: 'd.price_fen DESC',
      price_asc: 'd.price_fen ASC',
      category: 'd.category ASC, d.name ASC',
      newest: 'd.created_at DESC',
    };
    const order = sortMap[req.query.sort] || 'd.lab_id ASC, d.category ASC, d.name ASC';

    const rows = db.all(`${deviceSelectSql()} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [
      ...params,
      pageSize,
      (page - 1) * pageSize,
    ]);

    const items = rows.map((row) => {
      const labInfo = { name: row.lab_name, status: row.lab_status };
      const d = presenters.device(row, { withAvailability: req.query.withAvailability === 'true', labInfo });
      if (req.query.withAvailability !== 'true') {
        // 列表页默认只算今日与本周空闲概览，避免 N 次完整计算
        const summary = availability.deviceAvailabilitySummary(row, 7);
        d.todayFreeMinutes = summary.todayFreeMinutes;
        d.todayFreeCount = summary.todayFreeCount;
        d.todayFirstSelectable = summary.todayFirstSelectable;
        d.weekFreeMinutes = summary.weekFreeMinutes;
        d.utilization = summary.utilization;
      }
      d.labStatus = row.lab_status;
      d.busyNow = Number(
        db.scalar(
          `SELECT COUNT(*) AS c FROM bookings WHERE device_id = ? AND status IN ('approved','checked_in')
             AND start_at <= ? AND end_at >= ?`,
          [row.id, Date.now(), Date.now()],
        ) || 0,
      ) > 0;
      return d;
    });

    return ok({
      items,
      total,
      page,
      pageSize,
      filters: {
        labId: req.query.labId ? Number(req.query.labId) : null,
        category: req.query.category || '',
        keyword: req.query.keyword || '',
      },
    });
  });

  /** 单台设备详情 */
  ctx.router.get('/api/devices/:id', async (req) => {
    requireLogin(req);
    const row = db.get(`${deviceSelectSql()} WHERE d.id = ?`, [Number(req.params.id)]);
    if (!row) throw notFound('设备不存在');
    const d = presenters.device(row, { labInfo: { name: row.lab_name, status: row.lab_status } });
    d.ownerName = row.owner_name || '';
    d.lab = presenters.lab(db.get('SELECT * FROM labs WHERE id = ?', [row.lab_id]), { withStats: true });
    d.busyNow = Number(
      db.scalar(
        `SELECT COUNT(*) AS c FROM bookings WHERE device_id = ? AND status IN ('approved','checked_in')
           AND start_at <= ? AND end_at >= ?`,
        [row.id, Date.now(), Date.now()],
      ) || 0,
    ) > 0;
    // 使用统计
    const statuses = require('../core/booking-rules').occupyingStatuses();
    const ph = statuses.map(() => '?').join(',');
    d.stats = {
      totalBookings: Number(db.scalar('SELECT COUNT(*) AS c FROM bookings WHERE device_id = ?', [row.id]) || 0),
      completedBookings: Number(
        db.scalar("SELECT COUNT(*) AS c FROM bookings WHERE device_id = ? AND status = 'completed'", [row.id]) || 0,
      ),
      noShowBookings: Number(
        db.scalar("SELECT COUNT(*) AS c FROM bookings WHERE device_id = ? AND status = 'no_show'", [row.id]) || 0,
      ),
      upcomingBookings: Number(
        db.scalar(
          `SELECT COUNT(*) AS c FROM bookings WHERE device_id = ? AND status IN (${ph}) AND start_at > ?`,
          [row.id, ...statuses, Date.now()],
        ) || 0,
      ),
      totalUsedMinutes: Number(
        db.scalar('SELECT COALESCE(SUM(actual_minutes), 0) AS s FROM bookings WHERE device_id = ? AND status = ?', [
          row.id,
          'completed',
        ]) || 0,
      ),
      waitlistCount: Number(
        db.scalar("SELECT COUNT(*) AS c FROM waitlist WHERE device_id = ? AND status = 'waiting'", [row.id]) || 0,
      ),
    };
    d.weeklyPattern = presenters.weeklyPattern(row, row.lab_id);
    d.upcomingBlackouts = db
      .all(
        `SELECT b.*, d.name AS device_name, u.name AS creator_name FROM blackouts b
         LEFT JOIN devices d ON d.id = b.device_id LEFT JOIN users u ON u.id = b.created_by
         WHERE b.lab_id = ? AND (b.device_id = ? OR b.device_id IS NULL) AND b.end_at > ?
         ORDER BY b.start_at LIMIT 10`,
        [row.lab_id, row.id, Date.now()],
      )
      .map(presenters.blackout);
    return ok({ device: d });
  });

  /**
   * 设备可用时段查询（核心接口）
   * GET /api/devices/:id/availability?date=YYYY-MM-DD&days=7
   * 返回：每天的开放排班、占用区块（脱敏）与可直接预约的空闲块
   */
  ctx.router.get('/api/devices/:id/availability', async (req) => {
    const user = requireLogin(req);
    const deviceId = Number(req.params.id);
    const row = db.get(`${deviceSelectSql()} WHERE d.id = ?`, [deviceId]);
    if (!row) throw notFound('设备不存在');
    const tz = config.num('timezone_offset_minutes');
    const days = Math.min(31, Math.max(1, intQuery(req, 'days', 1)));
    const { parseDate } = require('../utils/time');
    const firstDay = req.query.date
      ? parseDate(String(req.query.date), tz)
      : startOfDay(Date.now(), tz);
    if (firstDay === null) throw badRequest('date 参数格式应为 YYYY-MM-DD');

    const device = presenters.device(row, { labInfo: { name: row.lab_name, status: row.lab_status } });
    const dayViews = [];
    for (let i = 0; i < days; i += 1) {
      dayViews.push(availability.deviceDayView(row, firstDay + i * DAY));
    }

    const days2 = dayViews.map((view) => ({
      date: view.date,
      weekday: view.weekday,
      closed: view.closed,
      schedule: view.schedule,
      free: view.free,
      occupancy: view.occupancy.map((o) => (o.kind === 'booking' ? maskOccupancy(o, user) : o)),
      freeMinutes: view.free.reduce((s, f) => s + f.minutes, 0),
    }));

    return ok({
      device,
      days: days2,
      rules: {
        minMinutes: row.min_minutes,
        maxMinutes: row.max_minutes,
        leadMinutes: row.lead_minutes,
        autoApprove: Number(row.auto_approve) === 1,
        checkinRequired: Number(row.checkin_required) === 1,
        bookingAdvanceDays: config.num('booking_advance_days'),
        bookingMinLeadMinutes: config.num('booking_min_lead_minutes'),
        timezoneOffset: tz,
      },
    });
  });

  /** 多台设备的共同空闲时段（团队协作场景） */
  ctx.router.get('/api/devices/common-availability', async (req) => {
    requireLogin(req);
    const ids = String(req.query.deviceIds || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length < 2) throw badRequest('请至少提供两台设备的 deviceIds（逗号分隔）');
    const days = Math.min(31, Math.max(1, intQuery(req, 'days', 7)));
    const minMinutes = Math.max(15, intQuery(req, 'minMinutes', 60));
    const tz = config.num('timezone_offset_minutes');
    const fromDate = req.query.date ? String(req.query.date) : formatDate(startOfDay(Date.now(), tz), tz);
    const results = availability.commonFreeSlots(ids, fromDate, days, minMinutes);
    return ok({ fromDate, days, minMinutes, results });
  });
}

function maskOccupancy(item, viewer) {
  const privileged = viewer && (viewer.role === 'admin' || viewer.role === 'teacher');
  if (item.mine || privileged) return item;
  return { ...item, owner: '', department: '', title: '已被预约', code: '' };
}

module.exports = { register };
