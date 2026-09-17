'use strict';

/**
 * 预约路由：申请 / 审批 / 取消 / 签到 / 签退 / 候补 / 导出
 */

const bookingService = require('../services/booking.service');
const presenters = require('../services/presenters');
const { sendText } = require('../http/server');
const {
  ok,
  requireLogin,
  pageQuery,
  bodyStr,
  bodyInt,
  requireStaff,
} = require('../http/helpers');
const { forbidden, badRequest } = require('../utils/errors');
const { formatDate } = require('../utils/time');
const config = require('../core/config');

function register(ctx) {
  /** 提交预约申请 */
  ctx.router.post('/api/bookings', async (req) => {
    const user = requireLogin(req);
    const booking = await bookingService.create(user, {
      deviceId: bodyInt(req, 'deviceId', { required: true, min: 1 }),
      startAt: req.body.startAt,
      endAt: req.body.endAt,
      startText: req.body.startText,
      endText: req.body.endText,
      purpose: bodyStr(req, 'purpose', { required: true, max: 300 }),
      courseName: bodyStr(req, 'courseName', { max: 100 }),
      participants: bodyInt(req, 'participants', { def: 1, min: 1, max: 20 }),
    });
    return ok({ booking }, 201);
  });

  /** 预约列表（按角色自动限定可见范围，支持 scope=mine/todo/active/history） */
  ctx.router.get('/api/bookings', async (req) => {
    const user = requireLogin(req);
    const { page, pageSize } = pageQuery(req, 20);
    const result = bookingService.list(user, {
      scope: req.query.scope || 'auto',
      status: req.query.status,
      labId: req.query.labId,
      deviceId: req.query.deviceId,
      userId: req.query.userId,
      from: req.query.from,
      to: req.query.to,
      keyword: req.query.keyword,
      ongoing: req.query.ongoing,
      order: req.query.order,
      page,
      pageSize,
    });
    return ok(result);
  });

  /** 导出 CSV */
  ctx.router.get('/api/bookings/export', async (req, res) => {
    const user = requireLogin(req);
    const csv = bookingService.exportCsv(user, { ...req.query, page: 1, pageSize: 200 });
    sendText(res, 200, csv, 'text/csv; charset=utf-8', {
      'Content-Disposition': `attachment; filename="bookings-${formatDate(Date.now(), config.num('timezone_offset_minutes'))}.csv"`,
    });
    return null;
  });

  /** 预约详情 */
  ctx.router.get('/api/bookings/:id', async (req) => {
    const user = requireLogin(req);
    return ok({ booking: bookingService.detail(user, Number(req.params.id)) });
  });

  /** 审批通过 */
  ctx.router.post('/api/bookings/:id/approve', async (req) => {
    const user = requireStaff(req);
    const booking = await bookingService.approve(user, Number(req.params.id), bodyStr(req, 'note', { max: 300 }));
    return ok({ booking });
  });

  /** 审批驳回 */
  ctx.router.post('/api/bookings/:id/reject', async (req) => {
    const user = requireStaff(req);
    const booking = await bookingService.reject(user, Number(req.params.id), bodyStr(req, 'reason', { required: true, max: 300 }));
    return ok({ booking });
  });

  /** 批量审批（管理端效率功能） */
  ctx.router.post('/api/bookings/batch-review', async (req) => {
    const user = requireStaff(req);
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) throw badRequest('请提供需要审批的预约 ids 数组');
    const action = String(req.body.action || '');
    if (!['approve', 'reject'].includes(action)) throw badRequest('action 只能是 approve 或 reject');
    const note = bodyStr(req, 'note', { max: 300 });
    if (action === 'reject' && note.length < 2) throw badRequest('批量驳回必须填写原因');
    const results = [];
    for (const id of ids) {
      try {
        const booking =
          action === 'approve'
            ? await bookingService.approve(user, id, note)
            : await bookingService.reject(user, id, note);
        results.push({ id, ok: true, status: booking.status });
      } catch (err) {
        results.push({ id, ok: false, message: err.message, code: err.code || 'ERROR' });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    return ok({ results, succeeded, failed: results.length - succeeded });
  });

  /** 取消预约 */
  ctx.router.post('/api/bookings/:id/cancel', async (req) => {
    const user = requireLogin(req);
    const booking = await bookingService.cancel(user, Number(req.params.id), bodyStr(req, 'reason', { max: 300 }));
    return ok({ booking });
  });

  /** 签到 */
  ctx.router.post('/api/bookings/:id/checkin', async (req) => {
    const user = requireLogin(req);
    const code = bodyStr(req, 'code', { required: true, max: 10 });
    const booking = await bookingService.checkin(user, Number(req.params.id), code);
    return ok({ booking });
  });

  /** 签退 */
  ctx.router.post('/api/bookings/:id/checkout', async (req) => {
    const user = requireLogin(req);
    const booking = await bookingService.checkout(user, Number(req.params.id));
    return ok({ booking });
  });

  /** 我的待办（首页卡片）：进行中、即将开始、待签到 */
  ctx.router.get('/api/bookings/mine/summary', async (req) => {
    const user = requireLogin(req);
    const now = Date.now();
    const rows = require('../db').all(
      `SELECT b.*, d.name AS device_name, l.name AS lab_name, u.name AS user_name, u.department AS user_department,
              r.name AS reviewer_name
       FROM bookings b JOIN devices d ON d.id = b.device_id JOIN labs l ON l.id = b.lab_id
       JOIN users u ON u.id = b.user_id LEFT JOIN users r ON r.id = b.reviewed_by
       WHERE b.user_id = ? AND b.status IN ('pending','approved','checked_in')
       ORDER BY b.start_at ASC`,
      [user.id],
    );
    const items = rows.map((row) => presenters.booking(row, user, { canReview: false }));
    return ok({
      ongoing: items.filter((b) => b.isOngoing),
      upcoming: items.filter((b) => b.isFuture).slice(0, 5),
      pendingCount: items.filter((b) => b.status === 'pending').length,
      needCheckin: items.filter((b) => b.actions.canCheckin),
      now,
    });
  });

  /** 候补列表 */
  ctx.router.get('/api/waitlist', async (req) => {
    const user = requireLogin(req);
    const { page, pageSize } = pageQuery(req, 20);
    const result = bookingService.listWaitlist(user, {
      scope: req.query.scope,
      status: req.query.status,
      deviceId: req.query.deviceId,
      page,
      pageSize,
    });
    return ok(result);
  });

  /** 加入候补 */
  ctx.router.post('/api/waitlist', async (req) => {
    const user = requireLogin(req);
    const item = await bookingService.joinWaitlist(user, {
      deviceId: bodyInt(req, 'deviceId', { required: true, min: 1 }),
      startAt: req.body.startAt,
      endAt: req.body.endAt,
      startText: req.body.startText,
      endText: req.body.endText,
      purpose: bodyStr(req, 'purpose', { max: 300 }),
    });
    return ok({ waitlist: item }, 201);
  });

  /** 退出候补 */
  ctx.router.post('/api/waitlist/:id/leave', async (req) => {
    const user = requireLogin(req);
    const item = await bookingService.leaveWaitlist(user, Number(req.params.id));
    return ok({ waitlist: item });
  });

  /** 确认补位（转成正式预约） */
  ctx.router.post('/api/waitlist/:id/confirm', async (req) => {
    const user = requireLogin(req);
    const result = await bookingService.confirmWaitlist(user, Number(req.params.id));
    return ok(result, 201);
  });

  /** 手动触发后台作业（管理员排障用，避免只能等定时器） */
  ctx.router.post('/api/admin/jobs/run', async (req) => {
    const user = requireLogin(req);
    if (user.role !== 'admin') throw forbidden('仅管理员可手动执行后台作业');
    const scheduler = require('../services/scheduler.service');
    const result = await scheduler.runOnce('manual');
    return ok({ result, status: scheduler.status() });
  });
}

module.exports = { register };
