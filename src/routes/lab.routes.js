'use strict';

/**
 * 实验室路由
 */

const db = require('../db');
const config = require('../core/config');
const presenters = require('../services/presenters');
const { ok, requireLogin, intQuery } = require('../http/helpers');
const { notFound } = require('../utils/errors');

function register(ctx) {
  /** 实验室列表（支持按状态/关键字过滤，含设备统计） */
  ctx.router.get('/api/labs', async (req, res) => {
    void res;
    requireLogin(req);
    const conds = [];
    const params = [];
    if (req.query.status) {
      conds.push('status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.keyword) {
      conds.push('(name LIKE ? OR code LIKE ? OR building LIKE ?)');
      const kw = `%${String(req.query.keyword).trim()}%`;
      params.push(kw, kw, kw);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db.all(`SELECT * FROM labs ${where} ORDER BY id`, params);
    return ok({ items: rows.map((r) => presenters.lab(r, { withStats: true })) });
  });

  /** 实验室详情 */
  ctx.router.get('/api/labs/:id', async (req) => {
    requireLogin(req);
    const row = db.get('SELECT * FROM labs WHERE id = ?', [Number(req.params.id)]);
    if (!row) throw notFound('实验室不存在');
    const lab = presenters.lab(row, { withStats: true });
    const deviceRows = db.all(
      `SELECT d.*, u.name AS owner_name,
              (SELECT COUNT(*) FROM bookings b
                WHERE b.device_id = d.id AND b.status IN ('approved','checked_in')
                  AND b.start_at <= ? AND b.end_at >= ?) AS busy_now
       FROM devices d LEFT JOIN users u ON u.id = d.owner_id
       WHERE d.lab_id = ? ORDER BY d.category, d.name`,
      [Date.now(), Date.now(), row.id],
    );
    lab.devices = deviceRows.map((d) => ({
      ...presenters.device(d),
      busyNow: Number(d.busy_now) > 0,
    }));
    lab.blackouts = db
      .all(
        `SELECT b.*, d.name AS device_name, u.name AS creator_name FROM blackouts b
         LEFT JOIN devices d ON d.id = b.device_id
         LEFT JOIN users u ON u.id = b.created_by
         WHERE b.lab_id = ? AND b.end_at > ? ORDER BY b.start_at LIMIT 20`,
        [row.id, Date.now()],
      )
      .map(presenters.blackout);
    lab.categories = [...new Set(deviceRows.map((d) => d.category))];
    lab.schedulePattern = presenters
      .weeklyPattern({ id: -1 }, row.id)
      .filter((w) => w.ranges.length);
    lab.timezoneOffset = config.num('timezone_offset_minutes');
    return ok({ lab });
  });

  /** 某个实验室当天的整体占用情况（用于首页/看板） */
  ctx.router.get('/api/labs/:id/today', async (req) => {
    requireLogin(req);
    const labId = Number(req.params.id);
    const labRow = db.get('SELECT * FROM labs WHERE id = ?', [labId]);
    if (!labRow) throw notFound('实验室不存在');
    const availability = require('../services/availability.service');
    const { startOfDay, formatDate } = require('../utils/time');
    const tz = config.num('timezone_offset_minutes');
    const dayStart = startOfDay(Date.now(), tz);
    const devices = db.all("SELECT * FROM devices WHERE lab_id = ? AND status = 'available' ORDER BY name", [labId]);
    const items = devices.map((d) => {
      const view = availability.deviceDayView(d, dayStart);
      return {
        deviceId: d.id,
        deviceName: d.name,
        category: d.category,
        date: formatDate(dayStart, tz),
        freeMinutes: view.free.reduce((s, f) => s + f.minutes, 0),
        freeCount: view.free.length,
        occupancyCount: view.occupancy.length,
        closed: view.closed,
        firstSelectable: view.free.find((f) => f.selectable) || null,
        occupancy: view.occupancy.map((o) => (o.kind === 'booking' ? maskOccupancy(o, req.user) : o)),
      };
    });
    return ok({ lab: presenters.lab(labRow, { withStats: true }), date: formatDate(dayStart, tz), items });
  });

  /** 全局设备分类列表（筛选器用） */
  ctx.router.get('/api/meta/categories', async (req) => {
    requireLogin(req);
    const rows = db.all('SELECT category, COUNT(*) AS c FROM devices GROUP BY category ORDER BY c DESC');
    return ok({ items: rows.map((r) => ({ category: r.category, count: Number(r.c) })) });
  });

  /** 与实验室相关的时间/规则元信息 */
  ctx.router.get('/api/meta/booking-rules', async (req) => {
    requireLogin(req);
    const rules = require('../core/booking-rules');
    return ok({
      statusLabels: rules.STATUS_LABELS,
      violationTypes: Object.entries(rules.VIOLATION_TYPES).map(([k, v]) => ({
        type: k,
        label: v.label,
        defaultPoints: rules.violationPoints(k),
      })),
      config: {
        bookingAdvanceDays: config.num('booking_advance_days'),
        bookingMinLeadMinutes: config.num('booking_min_lead_minutes'),
        cancelDeadlineHours: config.num('cancel_deadline_hours'),
        checkinGraceMinutes: config.num('checkin_grace_minutes'),
        checkinOpenBeforeMinutes: config.num('checkin_open_before_minutes'),
        overtimeGraceMinutes: config.num('overtime_grace_minutes'),
        waitlistHoldMinutes: config.num('waitlist_hold_minutes'),
        maxWeeklyMinutesDefault: config.num('max_weekly_minutes_default'),
        maxActiveBookingsPerUser: config.num('max_active_bookings_per_user'),
        creditFreezeThreshold: config.num('credit_freeze_threshold'),
        pendingBlocksOthers: config.bool('pending_blocks_others'),
      },
      ruleDoc: [
        { code: 'R01', text: '设备必须处于「可预约」状态' },
        { code: 'R02', text: '所属实验室必须处于开放状态' },
        { code: 'R03', text: '开始时间必须早于结束时间' },
        { code: 'R04', text: '不可预约已经过去的时间段' },
        { code: 'R05', text: '需满足最小提前预约分钟数' },
        { code: 'R06', text: '不可超过最大提前预约天数' },
        { code: 'R07', text: '单次时长需在设备允许区间内' },
        { code: 'R08', text: '所选时段必须完整落在设备开放排班内' },
        { code: 'R09', text: '不可落在设备维护/校准/封闭计划内' },
        { code: 'R10', text: '同一设备同一时段不可重复占用' },
        { code: 'R11', text: '不可与本人其它预约时间冲突' },
        { code: 'R12', text: '需满足在途数量、周额度与信用状态限制' },
      ],
    });
  });
}

/** 他人预约信息脱敏：仅保留占用时段，不暴露申请人身份与用途 */
function maskOccupancy(item, viewer) {
  const privileged = viewer && (viewer.role === 'admin' || viewer.role === 'teacher');
  if (item.mine || privileged) return item;
  return { ...item, owner: '', department: '', title: '已被预约', code: '' };
}

module.exports = { register };
