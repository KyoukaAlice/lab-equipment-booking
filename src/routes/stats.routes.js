'use strict';

/**
 * 统计报表路由
 */

const statsService = require('../services/stats.service');
const presenters = require('../services/presenters');
const { sendText } = require('../http/server');
const { ok, requireLogin, requireStaff, intQuery } = require('../http/helpers');
const config = require('../core/config');
const { formatDate } = require('../utils/time');
const bookingService = require('../services/booking.service');

function register(ctx) {
  /** 管理员仪表盘：一次返回概览、利用率、实验室汇总、热力图、趋势、用户排行 */
  ctx.router.get('/api/stats/dashboard', async (req) => {
    const user = requireLogin(req);
    if (user.role === 'admin') {
      return ok(statsService.dashboard({ from: req.query.from, to: req.query.to, labId: req.query.labId }));
    }
    // 教师：只能看自己负责的实验室
    const labs = bookingService.reviewerLabIds(user);
    if (user.role === 'teacher' && labs.length) {
      const labId = req.query.labId ? Number(req.query.labId) : labs[0];
      if (!labs.includes(labId)) {
        return ok({ error: '无权查看该实验室统计' });
      }
      const range = statsService.resolveRange({ from: req.query.from, to: req.query.to });
      return ok({
        overview: statsService.overview({ from: req.query.from, to: req.query.to }),
        range: { fromDate: range.fromDate, toDate: range.toDate },
        utilization: statsService.utilizationList({ from: range.from, to: range.to, labId }).items,
        labs: statsService.labSummary({ from: range.from, to: range.to }).filter((l) => labs.includes(l.labId)),
        heatmap: statsService.hourlyHeatmap({ from: range.from, to: range.to, labId }),
        users: statsService.userStats({ from: range.from, to: range.to, limit: 10 }),
        composition: statsService.timeComposition({ from: range.from, to: range.to, labId }),
        trend: statsService.trend({ from: range.from, to: range.to, labId }),
      });
    }
    return ok({ overview: statsService.overview({ from: req.query.from, to: req.query.to }) });
  });

  /** 概览指标 */
  ctx.router.get('/api/stats/overview', async (req) => {
    requireLogin(req);
    return ok(statsService.overview({ from: req.query.from, to: req.query.to }));
  });

  /** 设备利用率排行 */
  ctx.router.get('/api/stats/utilization', async (req) => {
    requireStaff(req);
    const range = statsService.resolveRange({ from: req.query.from, to: req.query.to });
    const result = statsService.utilizationList({
      from: range.from,
      to: range.to,
      labId: req.query.labId ? Number(req.query.labId) : null,
      limit: intQuery(req, 'limit', 0),
    });
    return ok({
      items: result.items,
      total: result.total,
      range: { fromDate: range.fromDate, toDate: range.toDate },
    });
  });

  /** 实验室汇总 */
  ctx.router.get('/api/stats/labs', async (req) => {
    requireStaff(req);
    const range = statsService.resolveRange({ from: req.query.from, to: req.query.to });
    return ok({ items: statsService.labSummary({ from: range.from, to: range.to }), range: { fromDate: range.fromDate, toDate: range.toDate } });
  });

  /** 时段热力图 */
  ctx.router.get('/api/stats/heatmap', async (req) => {
    requireStaff(req);
    const range = statsService.resolveRange({ from: req.query.from, to: req.query.to });
    const data = statsService.hourlyHeatmap({
      from: range.from,
      to: range.to,
      labId: req.query.labId ? Number(req.query.labId) : null,
    });
    // 补充每个高峰时段的预约条数
    for (const peak of data.peakHours) {
      const [weekdayLabel, hourText] = peak.label.split(' ');
      const hour = Number(hourText.slice(0, 2));
      const weekday = data.weekdayLabels.indexOf(weekdayLabel);
      peak.bookings = Number(
        require('../db').scalar(
          `SELECT COUNT(*) AS c FROM bookings
           WHERE status IN ('approved','checked_in','completed')
             AND start_at < ? AND end_at > ?
             AND CAST(strftime('%w', (start_at + ?) / 1000, 'unixepoch') AS INTEGER) = ?
             AND CAST(strftime('%H', (start_at + ?) / 1000, 'unixepoch') AS INTEGER) = ?`,
          [range.to, range.from, config.num('timezone_offset_minutes') * 60000, weekday, config.num('timezone_offset_minutes') * 60000, hour],
        ) || 0,
      );
    }
    return ok(data);
  });

  /** 用户使用与履约统计 */
  ctx.router.get('/api/stats/users', async (req) => {
    requireStaff(req);
    const range = statsService.resolveRange({ from: req.query.from, to: req.query.to });
    return ok({
      ...statsService.userStats({ from: range.from, to: range.to, limit: intQuery(req, 'limit', 20) }),
      range: { fromDate: range.fromDate, toDate: range.toDate },
    });
  });

  /** 时间构成（已占用 / 空闲 / 停机） */
  ctx.router.get('/api/stats/composition', async (req) => {
    requireStaff(req);
    const range = statsService.resolveRange({ from: req.query.from, to: req.query.to });
    return ok(
      statsService.timeComposition({
        from: range.from,
        to: range.to,
        labId: req.query.labId ? Number(req.query.labId) : null,
      }),
    );
  });

  /** 预约趋势 */
  ctx.router.get('/api/stats/trend', async (req) => {
    requireStaff(req);
    const range = statsService.resolveRange({ from: req.query.from, to: req.query.to });
    return ok(
      statsService.trend({
        from: range.from,
        to: range.to,
        labId: req.query.labId ? Number(req.query.labId) : null,
      }),
    );
  });

  /** 导出设备利用率报表 */
  ctx.router.get('/api/stats/export/utilization', async (req, res) => {
    requireStaff(req);
    const range = statsService.resolveRange({ from: req.query.from, to: req.query.to });
    const csv = statsService.exportUtilizationCsv({
      from: range.from,
      to: range.to,
      labId: req.query.labId ? Number(req.query.labId) : null,
    });
    sendText(res, 200, csv, 'text/csv; charset=utf-8', {
      'Content-Disposition': `attachment; filename="utilization-${formatDate(Date.now(), config.num('timezone_offset_minutes'))}.csv"`,
    });
    return null;
  });
}

void presenters;
module.exports = { register };
