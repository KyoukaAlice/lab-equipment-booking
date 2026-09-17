'use strict';

/**
 * 管理员路由：实验室 / 设备 / 排班 / 停机 / 用户 / 违约 / 配置 / 审计
 * 所有写操作均记录审计日志；关键删除操作做了关联数据保护。
 */

const db = require('../db');
const config = require('../core/config');
const bkrules = require('../core/booking-rules');
const presenters = require('../services/presenters');
const creditService = require('../services/credit.service');
const audit = require('../services/audit.service');
const notification = require('../services/notification.service');
const scheduler = require('../services/scheduler.service');
const { hashPassword } = require('../core/password');
const {
  ok,
  requireAdmin,
  pageQuery,
  intQuery,
  bodyStr,
  bodyInt,
} = require('../http/helpers');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { parseDateTime, clockToMinutes, parseDate, startOfDay, formatDate, DAY, MINUTE } = require('../utils/time');

function register(ctx) {
  /* ============================== 实验室 ============================== */

  ctx.router.post('/api/admin/labs', async (req) => {
    const actor = requireAdmin(req);
    const name = bodyStr(req, 'name', { required: true, max: 60 });
    const code = bodyStr(req, 'code', { required: true, max: 30 });
    if (db.get('SELECT id FROM labs WHERE code = ?', [code])) throw conflict('实验室编号已存在');
    if (db.get('SELECT id FROM labs WHERE name = ?', [name])) throw conflict('实验室名称已存在');
    const now = Date.now();
    const res = db.run(
      `INSERT INTO labs (name, code, building, room, capacity, open_hours, rules, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        code,
        bodyStr(req, 'building', { max: 60 }),
        bodyStr(req, 'room', { max: 60 }),
        bodyInt(req, 'capacity', { def: 0, min: 0, max: 500 }),
        bodyStr(req, 'openHours', { max: 200 }),
        bodyStr(req, 'rules', { max: 2000 }),
        bodyStr(req, 'status', { def: 'active', max: 20 }),
        now,
        now,
      ],
    );
    const labId = res.lastInsertRowid;
    const managerIds = Array.isArray(req.body.managerIds) ? req.body.managerIds.map(Number).filter(Boolean) : [];
    for (const uid of managerIds) {
      db.run('INSERT OR IGNORE INTO lab_managers (lab_id, user_id, created_at) VALUES (?, ?, ?)', [labId, uid, now]);
    }
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'lab.create',
      targetType: 'lab',
      targetId: labId,
      detail: { name, code, managerIds },
      ip: ctx.clientIp(req),
    });
    return ok({ lab: presenters.lab(db.get('SELECT * FROM labs WHERE id = ?', [labId]), { withStats: true }) }, 201);
  });

  ctx.router.patch('/api/admin/labs/:id', async (req) => {
    const actor = requireAdmin(req);
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM labs WHERE id = ?', [id]);
    if (!row) throw notFound('实验室不存在');
    const name = bodyStr(req, 'name', { def: row.name, max: 60 });
    const code = bodyStr(req, 'code', { def: row.code, max: 30 });
    const dupCode = db.get('SELECT id FROM labs WHERE code = ? AND id <> ?', [code, id]);
    if (dupCode) throw conflict('实验室编号已被其它实验室使用');
    db.run(
      `UPDATE labs SET name = ?, code = ?, building = ?, room = ?, capacity = ?, open_hours = ?, rules = ?,
           status = ?, updated_at = ? WHERE id = ?`,
      [
        name,
        code,
        bodyStr(req, 'building', { def: row.building, max: 60 }),
        bodyStr(req, 'room', { def: row.room, max: 60 }),
        bodyInt(req, 'capacity', { def: row.capacity, min: 0, max: 500 }),
        bodyStr(req, 'openHours', { def: row.open_hours, max: 200 }),
        bodyStr(req, 'rules', { def: row.rules, max: 2000 }),
        bodyStr(req, 'status', { def: row.status, max: 20 }),
        Date.now(),
        id,
      ],
    );
    if (Array.isArray(req.body.managerIds)) {
      const ids = req.body.managerIds.map(Number).filter(Boolean);
      db.writeTxSync((conn) => {
        conn.prepare('DELETE FROM lab_managers WHERE lab_id = ?').run(id);
        for (const uid of ids) {
          conn.prepare('INSERT OR IGNORE INTO lab_managers (lab_id, user_id, created_at) VALUES (?, ?, ?)').run(id, uid, Date.now());
        }
      });
    }
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'lab.update',
      targetType: 'lab',
      targetId: id,
      detail: { name, code },
      ip: ctx.clientIp(req),
    });
    return ok({ lab: presenters.lab(db.get('SELECT * FROM labs WHERE id = ?', [id]), { withStats: true }) });
  });

  ctx.router.del('/api/admin/labs/:id', async (req) => {
    const actor = requireAdmin(req);
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM labs WHERE id = ?', [id]);
    if (!row) throw notFound('实验室不存在');
    const deviceCount = Number(db.scalar('SELECT COUNT(*) AS c FROM devices WHERE lab_id = ?', [id]) || 0);
    if (deviceCount > 0) throw conflict(`该实验室下仍有 ${deviceCount} 台设备，请先移除或转移设备`);
    db.run('DELETE FROM labs WHERE id = ?', [id]);
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'lab.delete',
      targetType: 'lab',
      targetId: id,
      detail: { name: row.name },
      ip: ctx.clientIp(req),
    });
    return ok({ message: `实验室「${row.name}」已删除` });
  });

  /* ============================== 设备 ============================== */

  ctx.router.post('/api/admin/devices', async (req) => {
    const actor = requireAdmin(req);
    const labId = bodyInt(req, 'labId', { required: true, min: 1 });
    const lab = db.get('SELECT * FROM labs WHERE id = ?', [labId]);
    if (!lab) throw notFound('实验室不存在');
    const name = bodyStr(req, 'name', { required: true, max: 80 });
    const serialNo = bodyStr(req, 'serialNo', { max: 60 });
    if (serialNo && db.get('SELECT id FROM devices WHERE serial_no = ?', [serialNo])) {
      throw conflict('设备序列号已存在');
    }
    const minMinutes = bodyInt(req, 'minMinutes', { def: 30, min: 15, max: 1440 });
    const maxMinutes = bodyInt(req, 'maxMinutes', { def: 240, min: minMinutes, max: 1440 });
    const now = Date.now();
    const res = db.run(
      `INSERT INTO devices (lab_id, name, category, model, brand, serial_no, status, price_fen, purchase_date,
           location, owner_id, auto_approve, checkin_required, min_minutes, max_minutes, lead_minutes,
           description, images, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      [
        labId,
        name,
        bodyStr(req, 'category', { def: '其他', max: 40 }),
        bodyStr(req, 'model', { max: 60 }),
        bodyStr(req, 'brand', { max: 60 }),
        serialNo || `SN-${lab.code}-${String(Date.now()).slice(-6)}`,
        bodyStr(req, 'status', { def: 'available', max: 20 }),
        bodyInt(req, 'priceFen', { def: 0, min: 0, max: 1000000000 }),
        bodyStr(req, 'purchaseDate', { max: 20 }),
        bodyStr(req, 'location', { max: 80 }),
        bodyInt(req, 'ownerId', { def: null, min: 1, max: 1000000 }),
        bodyInt(req, 'autoApprove', { def: 0, min: 0, max: 1 }),
        bodyInt(req, 'checkinRequired', { def: 1, min: 0, max: 1 }),
        minMinutes,
        maxMinutes,
        bodyInt(req, 'leadMinutes', { def: 0, min: 0, max: 10080 }),
        bodyStr(req, 'description', { max: 1000 }),
        now,
        now,
      ],
    );
    const deviceId = res.lastInsertRowid;
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'device.create',
      targetType: 'device',
      targetId: deviceId,
      detail: { name, labId, serialNo },
      ip: ctx.clientIp(req),
    });
    return ok({ device: presenters.device(db.get('SELECT * FROM devices WHERE id = ?', [deviceId])) }, 201);
  });

  ctx.router.patch('/api/admin/devices/:id', async (req) => {
    const actor = requireAdmin(req);
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM devices WHERE id = ?', [id]);
    if (!row) throw notFound('设备不存在');
    const name = bodyStr(req, 'name', { def: row.name, max: 80 });
    const status = bodyStr(req, 'status', { def: row.status, max: 20 });
    if (!['available', 'maintenance', 'offline', 'scrapped'].includes(status)) {
      throw badRequest('设备状态取值非法');
    }
    const minMinutes = bodyInt(req, 'minMinutes', { def: row.min_minutes, min: 15, max: 1440 });
    const maxMinutes = bodyInt(req, 'maxMinutes', { def: row.max_minutes, min: minMinutes, max: 1440 });
    const labId = bodyInt(req, 'labId', { def: row.lab_id, min: 1 });
    if (!db.get('SELECT id FROM labs WHERE id = ?', [labId])) throw notFound('目标实验室不存在');
    const serialNo = bodyStr(req, 'serialNo', { def: row.serial_no, max: 60 });
    const dupSerial = db.get('SELECT id FROM devices WHERE serial_no = ? AND id <> ?', [serialNo, id]);
    if (dupSerial) throw conflict('设备序列号已被其它设备使用');

    // 状态改为不可用时，若有未来预约需要提醒
    let affected = 0;
    if (status !== 'available' && row.status === 'available') {
      affected = Number(
        db.scalar(
          `SELECT COUNT(*) AS c FROM bookings WHERE device_id = ? AND status IN ('pending','approved') AND end_at > ?`,
          [id, Date.now()],
        ) || 0,
      );
    }
    db.run(
      `UPDATE devices SET lab_id = ?, name = ?, category = ?, model = ?, brand = ?, serial_no = ?, status = ?,
           price_fen = ?, purchase_date = ?, location = ?, owner_id = ?, auto_approve = ?, checkin_required = ?,
           min_minutes = ?, max_minutes = ?, lead_minutes = ?, description = ?, updated_at = ? WHERE id = ?`,
      [
        labId,
        name,
        bodyStr(req, 'category', { def: row.category, max: 40 }),
        bodyStr(req, 'model', { def: row.model, max: 60 }),
        bodyStr(req, 'brand', { def: row.brand, max: 60 }),
        serialNo,
        status,
        bodyInt(req, 'priceFen', { def: row.price_fen, min: 0, max: 1000000000 }),
        bodyStr(req, 'purchaseDate', { def: row.purchase_date, max: 20 }),
        bodyStr(req, 'location', { def: row.location, max: 80 }),
        bodyInt(req, 'ownerId', { def: row.owner_id, min: 1, max: 1000000, required: false }),
        bodyInt(req, 'autoApprove', { def: row.auto_approve, min: 0, max: 1 }),
        bodyInt(req, 'checkinRequired', { def: row.checkin_required, min: 0, max: 1 }),
        minMinutes,
        maxMinutes,
        bodyInt(req, 'leadMinutes', { def: row.lead_minutes, min: 0, max: 10080 }),
        bodyStr(req, 'description', { def: row.description, max: 1000 }),
        Date.now(),
        id,
      ],
    );
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'device.update',
      targetType: 'device',
      targetId: id,
      detail: { name, status, affectedBookings: affected },
      ip: ctx.clientIp(req),
    });
    return ok({
      device: presenters.device(db.get('SELECT * FROM devices WHERE id = ?', [id])),
      affectedBookings: affected,
      warning: affected ? `该设备状态已变更为「${status}」，有 ${affected} 条未来预约受影响，请及时通知申请人` : '',
    });
  });

  ctx.router.del('/api/admin/devices/:id', async (req) => {
    const actor = requireAdmin(req);
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM devices WHERE id = ?', [id]);
    if (!row) throw notFound('设备不存在');
    const active = Number(
      db.scalar(
        `SELECT COUNT(*) AS c FROM bookings WHERE device_id = ? AND status IN ('pending','approved','checked_in')`,
        [id],
      ) || 0,
    );
    if (active > 0) throw conflict(`该设备还有 ${active} 条在途预约，请先处理后再删除`);
    const history = Number(db.scalar('SELECT COUNT(*) AS c FROM bookings WHERE device_id = ?', [id]) || 0);
    if (history > 0) {
      // 有历史记录时不允许物理删除（保护统计口径），改为标记报废
      db.run("UPDATE devices SET status = 'scrapped', updated_at = ? WHERE id = ?", [Date.now(), id]);
    } else {
      db.run('DELETE FROM devices WHERE id = ?', [id]);
    }
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: history > 0 ? 'device.scrap' : 'device.delete',
      targetType: 'device',
      targetId: id,
      detail: { name: row.name, historyBookings: history },
      ip: ctx.clientIp(req),
    });
    return ok({
      message: history > 0 ? `设备有 ${history} 条历史预约，已标记为「已报废」以保留统计记录` : '设备已删除',
      scrapped: history > 0,
    });
  });

  /* ============================== 排班 ============================== */

  ctx.router.get('/api/admin/slots', async (req) => {
    requireAdmin(req);
    const labId = intQuery(req, 'labId', 0);
    const conds = [];
    const params = [];
    if (labId) {
      conds.push('s.lab_id = ?');
      params.push(labId);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db.all(
      `SELECT s.*, l.name AS lab_name, d.name AS device_name FROM weekly_slots s
       JOIN labs l ON l.id = s.lab_id LEFT JOIN devices d ON d.id = s.device_id
       ${where} ORDER BY s.lab_id, s.device_id IS NULL DESC, s.device_id, s.weekday, s.start_min`,
      params,
    );
    const WEEKDAY_NAMES = require('../utils/time').WEEKDAY_NAMES;
    return ok({
      items: rows.map((r) => ({
        id: r.id,
        labId: r.lab_id,
        labName: r.lab_name,
        deviceId: r.device_id,
        deviceName: r.device_name || '（全实验室默认）',
        scope: r.device_id ? 'device' : 'lab',
        weekday: r.weekday,
        weekdayLabel: WEEKDAY_NAMES[r.weekday],
        startMin: r.start_min,
        endMin: r.end_min,
        startClock: `${String(Math.floor(r.start_min / 60)).padStart(2, '0')}:${String(r.start_min % 60).padStart(2, '0')}`,
        endClock: `${String(Math.floor(r.end_min / 60)).padStart(2, '0')}:${String(r.end_min % 60).padStart(2, '0')}`,
        enabled: Number(r.enabled) === 1,
      })),
    });
  });

  ctx.router.post('/api/admin/slots', async (req) => {
    const actor = requireAdmin(req);
    const labId = bodyInt(req, 'labId', { required: true, min: 1 });
    if (!db.get('SELECT id FROM labs WHERE id = ?', [labId])) throw notFound('实验室不存在');
    const deviceId = bodyInt(req, 'deviceId', { def: null, min: 1 });
    if (deviceId) {
      const dev = db.get('SELECT id, lab_id FROM devices WHERE id = ?', [deviceId]);
      if (!dev) throw notFound('设备不存在');
      if (dev.lab_id !== labId) throw badRequest('设备不属于该实验室');
    }
    const weekday = bodyInt(req, 'weekday', { required: true, min: 0, max: 6 });
    const startClock = bodyStr(req, 'start', { required: true, max: 5 });
    const endClock = bodyStr(req, 'end', { required: true, max: 5 });
    const startMin = clockToMinutes(startClock);
    const endMin = clockToMinutes(endClock);
    if (startMin === null || endMin === null) throw badRequest('时间格式应为 HH:mm');
    if (startMin >= endMin) throw badRequest('开始时间必须早于结束时间');
    const dup = db.get(
      `SELECT id FROM weekly_slots WHERE lab_id = ? AND weekday = ? AND start_min < ? AND end_min > ?
         AND ((device_id IS NULL AND ? IS NULL) OR device_id = ?)`,
      [labId, weekday, endMin, startMin, deviceId, deviceId],
    );
    if (dup) throw conflict('该时段与已有排班重叠');
    const res = db.run(
      `INSERT INTO weekly_slots (lab_id, device_id, weekday, start_min, end_min, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [labId, deviceId, weekday, startMin, endMin, Date.now()],
    );
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'slot.create',
      targetType: 'slot',
      targetId: res.lastInsertRowid,
      detail: { labId, deviceId, weekday, startMin, endMin },
      ip: ctx.clientIp(req),
    });
    return ok({ id: res.lastInsertRowid }, 201);
  });

  ctx.router.patch('/api/admin/slots/:id', async (req) => {
    const actor = requireAdmin(req);
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM weekly_slots WHERE id = ?', [id]);
    if (!row) throw notFound('排班不存在');
    const enabled = bodyInt(req, 'enabled', { def: row.enabled, min: 0, max: 1 });
    const startClock = bodyStr(req, 'start', { def: null, max: 5 });
    const endClock = bodyStr(req, 'end', { def: null, max: 5 });
    const startMin = startClock ? clockToMinutes(startClock) : row.start_min;
    const endMin = endClock ? clockToMinutes(endClock) : row.end_min;
    if (startMin === null || endMin === null) throw badRequest('时间格式应为 HH:mm');
    if (startMin >= endMin) throw badRequest('开始时间必须早于结束时间');
    db.run('UPDATE weekly_slots SET start_min = ?, end_min = ?, enabled = ? WHERE id = ?', [
      startMin,
      endMin,
      enabled,
      id,
    ]);
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'slot.update',
      targetType: 'slot',
      targetId: id,
      detail: { startMin, endMin, enabled },
      ip: ctx.clientIp(req),
    });
    return ok({ id, startMin, endMin, enabled: enabled === 1 });
  });

  ctx.router.del('/api/admin/slots/:id', async (req) => {
    const actor = requireAdmin(req);
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM weekly_slots WHERE id = ?', [id]);
    if (!row) throw notFound('排班不存在');
    db.run('DELETE FROM weekly_slots WHERE id = ?', [id]);
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'slot.delete',
      targetType: 'slot',
      targetId: id,
      detail: { labId: row.lab_id, deviceId: row.device_id, weekday: row.weekday },
      ip: ctx.clientIp(req),
    });
    return ok({ message: '排班已删除' });
  });

  /* ============================== 停机计划 ============================== */

  ctx.router.get('/api/admin/blackouts', async (req) => {
    requireAdmin(req);
    const { page, pageSize } = pageQuery(req, 30);
    const conds = [];
    const params = [];
    if (req.query.labId) {
      conds.push('b.lab_id = ?');
      params.push(Number(req.query.labId));
    }
    if (req.query.deviceId) {
      conds.push('b.device_id = ?');
      params.push(Number(req.query.deviceId));
    }
    if (req.query.upcoming === 'true') {
      conds.push('b.end_at >= ?');
      params.push(Date.now());
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db.all(
      `SELECT b.*, l.name AS lab_name, d.name AS device_name, u.name AS creator_name FROM blackouts b
       JOIN labs l ON l.id = b.lab_id LEFT JOIN devices d ON d.id = b.device_id
       LEFT JOIN users u ON u.id = b.created_by
       ${where} ORDER BY b.start_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    const total = Number(db.scalar(`SELECT COUNT(*) AS c FROM blackouts b ${where}`, params) || 0);
    return ok({ items: rows.map(presenters.blackout), total, page, pageSize });
  });

  ctx.router.post('/api/admin/blackouts', async (req) => {
    const actor = requireAdmin(req);
    const tz = config.num('timezone_offset_minutes');
    const labId = bodyInt(req, 'labId', { required: true, min: 1 });
    if (!db.get('SELECT id FROM labs WHERE id = ?', [labId])) throw notFound('实验室不存在');
    const deviceId = bodyInt(req, 'deviceId', { def: null, min: 1 });
    if (deviceId && !db.get('SELECT id FROM devices WHERE id = ? AND lab_id = ?', [deviceId, labId])) {
      throw badRequest('设备不存在或不属于该实验室');
    }
    const startAt = parseDateTime(String(req.body.startAt || ''), tz);
    const endAt = parseDateTime(String(req.body.endAt || ''), tz);
    if (startAt === null || endAt === null) throw badRequest('停机起止时间格式应为 YYYY-MM-DD HH:mm');
    if (startAt >= endAt) throw badRequest('停机开始时间必须早于结束时间');
    const kind = bodyStr(req, 'kind', { def: 'maintenance', max: 20 });
    if (!['maintenance', 'calibration', 'holiday', 'event', 'other'].includes(kind)) {
      throw badRequest('停机类型非法');
    }
    const reason = bodyStr(req, 'reason', { required: true, max: 200 });

    // 计算受影响的在途预约数量，便于管理员决策
    const affected = Number(
      db.scalar(
        `SELECT COUNT(*) AS c FROM bookings WHERE lab_id = ? AND status IN ('pending','approved')
           AND start_at < ? AND end_at > ? ${deviceId ? 'AND device_id = ?' : ''}`,
        deviceId ? [labId, endAt, startAt, deviceId] : [labId, endAt, startAt],
      ) || 0,
    );
    const now = Date.now();
    const res = db.run(
      `INSERT INTO blackouts (lab_id, device_id, start_at, end_at, reason, kind, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [labId, deviceId, startAt, endAt, reason, kind, actor.id, now],
    );
    const blackoutId = res.lastInsertRowid;

    // 通知受影响的申请人
    if (affected > 0) {
      const rows = db.all(
        `SELECT id, user_id, code FROM bookings WHERE lab_id = ? AND status IN ('pending','approved')
           AND start_at < ? AND end_at > ? ${deviceId ? 'AND device_id = ?' : ''}`,
        deviceId ? [labId, endAt, startAt, deviceId] : [labId, endAt, startAt],
      );
      for (const b of rows) {
        notification.notify({
          userId: b.user_id,
          type: 'blackout.created',
          title: '注意：您有预约受到停机计划影响',
          content: `预约 ${b.code} 与新的不可用计划（${reason}，${String(req.body.startAt)} ~ ${String(req.body.endAt)}）冲突，请联系实验室管理员调整时间。`,
          link: `#/bookings/${b.id}`,
        });
      }
    }
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'blackout.create',
      targetType: 'blackout',
      targetId: blackoutId,
      detail: { labId, deviceId, startAt, endAt, reason, kind, affected },
      ip: ctx.clientIp(req),
    });
    return ok({
      blackout: presenters.blackout(
        db.get(
          `SELECT b.*, l.name AS lab_name, d.name AS device_name, u.name AS creator_name FROM blackouts b
           JOIN labs l ON l.id = b.lab_id LEFT JOIN devices d ON d.id = b.device_id
           LEFT JOIN users u ON u.id = b.created_by WHERE b.id = ?`,
          [blackoutId],
        ),
      ),
      affectedBookings: affected,
    }, 201);
  });

  ctx.router.del('/api/admin/blackouts/:id', async (req) => {
    const actor = requireAdmin(req);
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM blackouts WHERE id = ?', [id]);
    if (!row) throw notFound('停机计划不存在');
    db.run('DELETE FROM blackouts WHERE id = ?', [id]);
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'blackout.delete',
      targetType: 'blackout',
      targetId: id,
      detail: { reason: row.reason },
      ip: ctx.clientIp(req),
    });
    return ok({ message: '停机计划已删除' });
  });

  /* ============================== 用户管理 ============================== */

  ctx.router.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    const conds = [];
    const params = [];
    if (req.query.role) {
      conds.push('role = ?');
      params.push(String(req.query.role));
    }
    if (req.query.status) {
      conds.push('status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.keyword) {
      const kw = `%${String(req.query.keyword).trim()}%`;
      conds.push('(username LIKE ? OR name LIKE ? OR department LIKE ? OR student_no LIKE ?)');
      params.push(kw, kw, kw, kw);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { page, pageSize } = pageQuery(req, 20);
    const total = Number(db.scalar(`SELECT COUNT(*) AS c FROM users ${where}`, params) || 0);
    const rows = db.all(
      `SELECT u.*,
              (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id) AS booking_count,
              (SELECT COUNT(*) FROM violations v WHERE v.user_id = u.id) AS violation_count,
              (SELECT COUNT(*) FROM lab_managers m WHERE m.user_id = u.id) AS managed_lab_count
       FROM users u ${where} ORDER BY u.role, u.id LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    return ok({
      items: rows.map((r) => ({
        ...presenters.userBrief(r),
        bookingCount: Number(r.booking_count),
        violationCount: Number(r.violation_count),
        managedLabCount: Number(r.managed_lab_count),
        credit: creditService.summary(r.id),
      })),
      total,
      page,
      pageSize,
    });
  });

  ctx.router.post('/api/admin/users', async (req) => {
    const actor = requireAdmin(req);
    const username = bodyStr(req, 'username', { required: true, max: 30 });
    if (!/^[A-Za-z][A-Za-z0-9_]{2,29}$/.test(username)) throw badRequest('用户名格式不正确');
    if (db.get('SELECT id FROM users WHERE username = ?', [username])) throw conflict('用户名已存在');
    const password = String(req.body.password || '');
    if (password.length < 6) throw badRequest('初始密码长度至少 6 位');
    const role = bodyStr(req, 'role', { def: 'student', max: 10 });
    if (!['admin', 'teacher', 'student'].includes(role)) throw badRequest('角色非法');
    const now = Date.now();
    const res = db.run(
      `INSERT INTO users (username, password_hash, name, role, email, phone, department, student_no,
           credit_score, status, weekly_quota_min, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      [
        username,
        hashPassword(password),
        bodyStr(req, 'name', { required: true, max: 30 }),
        role,
        bodyStr(req, 'email', { max: 80 }),
        bodyStr(req, 'phone', { max: 20 }),
        bodyStr(req, 'department', { max: 50 }),
        bodyStr(req, 'studentNo', { max: 30 }),
        bodyInt(req, 'creditScore', { def: 100, min: 0, max: 100 }),
        bodyInt(req, 'weeklyQuotaMin', { def: config.num('max_weekly_minutes_default'), min: 0, max: 10080 }),
        now,
        now,
      ],
    );
    const userId = res.lastInsertRowid;
    const managedLabIds = Array.isArray(req.body.managedLabIds) ? req.body.managedLabIds.map(Number).filter(Boolean) : [];
    for (const labId of managedLabIds) {
      db.run('INSERT OR IGNORE INTO lab_managers (lab_id, user_id, created_at) VALUES (?, ?, ?)', [labId, userId, now]);
    }
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'user.create',
      targetType: 'user',
      targetId: userId,
      detail: { username, role, managedLabIds },
      ip: ctx.clientIp(req),
    });
    return ok({ user: presenters.userBrief(db.get('SELECT * FROM users WHERE id = ?', [userId])) }, 201);
  });

  ctx.router.patch('/api/admin/users/:id', async (req) => {
    const actor = requireAdmin(req);
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!row) throw notFound('用户不存在');
    const role = bodyStr(req, 'role', { def: row.role, max: 10 });
    if (!['admin', 'teacher', 'student'].includes(role)) throw badRequest('角色非法');
    if (row.role === 'admin' && role !== 'admin') {
      const adminCount = Number(db.scalar("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status <> 'disabled'") || 0);
      if (adminCount <= 1) throw conflict('系统至少需要保留一名管理员');
    }
    const quota = bodyInt(req, 'weeklyQuotaMin', {
      def: row.weekly_quota_min,
      min: 0,
      max: 10080,
    });
    db.run(
      `UPDATE users SET name = ?, role = ?, email = ?, phone = ?, department = ?, student_no = ?,
           weekly_quota_min = ?, updated_at = ? WHERE id = ?`,
      [
        bodyStr(req, 'name', { def: row.name, max: 30 }),
        role,
        bodyStr(req, 'email', { def: row.email, max: 80 }),
        bodyStr(req, 'phone', { def: row.phone, max: 20 }),
        bodyStr(req, 'department', { def: row.department, max: 50 }),
        bodyStr(req, 'studentNo', { def: row.student_no, max: 30 }),
        quota,
        Date.now(),
        id,
      ],
    );
    if (Array.isArray(req.body.managedLabIds)) {
      const ids = req.body.managedLabIds.map(Number).filter(Boolean);
      db.writeTxSync((conn) => {
        conn.prepare('DELETE FROM lab_managers WHERE user_id = ?').run(id);
        for (const labId of ids) {
          conn.prepare('INSERT OR IGNORE INTO lab_managers (lab_id, user_id, created_at) VALUES (?, ?, ?)').run(labId, id, Date.now());
        }
      });
    }
    if (req.body.password) {
      const pwd = String(req.body.password);
      if (pwd.length < 6) throw badRequest('新密码长度至少 6 位');
      db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(pwd), Date.now(), id]);
      db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    }
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'user.update',
      targetType: 'user',
      targetId: id,
      detail: { role, quota, passwordReset: Boolean(req.body.password) },
      ip: ctx.clientIp(req),
    });
    return ok({ user: presenters.userBrief(db.get('SELECT * FROM users WHERE id = ?', [id])) });
  });

  /** 冻结 / 解冻 */
  ctx.router.post('/api/admin/users/:id/freeze', async (req) => {
    const actor = requireAdmin(req);
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!row) throw notFound('用户不存在');
    const action = bodyStr(req, 'action', { def: 'freeze', max: 10 });
    if (action === 'unfreeze') {
      creditService.unfreeze(id, bodyStr(req, 'reason', { def: '管理员已解除限制', max: 200 }), actor.id);
      audit.log({
        userId: actor.id,
        actorName: actor.name,
        action: 'user.unfreeze',
        targetType: 'user',
        targetId: id,
        detail: bodyStr(req, 'reason', { def: '', max: 200 }),
        ip: ctx.clientIp(req),
      });
      return ok({ user: presenters.userBrief(db.get('SELECT * FROM users WHERE id = ?', [id])) });
    }
    const days = bodyInt(req, 'days', { def: 30, min: 1, max: 365 });
    const reason = bodyStr(req, 'reason', { required: true, max: 200 });
    db.run(`UPDATE users SET status = 'frozen', frozen_reason = ?, frozen_until = ?, updated_at = ? WHERE id = ?`, [
      reason,
      Date.now() + days * DAY,
      Date.now(),
      id,
    ]);
    notification.notify({
      userId: id,
      type: 'credit.frozen',
      title: '预约权限已被暂停',
      content: `${reason}，暂停期 ${days} 天。如有异议可联系实验室管理员。`,
      link: '#/profile',
    });
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'user.freeze',
      targetType: 'user',
      targetId: id,
      detail: { reason, days },
      ip: ctx.clientIp(req),
    });
    return ok({ user: presenters.userBrief(db.get('SELECT * FROM users WHERE id = ?', [id])) });
  });

  ctx.router.post('/api/admin/users/:id/disable', async (req) => {
    const actor = requireAdmin(req);
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!row) throw notFound('用户不存在');
    if (row.id === actor.id) throw conflict('不能停用当前登录的管理员账号');
    if (row.role === 'admin') {
      const adminCount = Number(db.scalar("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status <> 'disabled'") || 0);
      if (adminCount <= 1) throw conflict('系统至少需要保留一名可用管理员');
    }
    const status = row.status === 'disabled' ? 'active' : 'disabled';
    db.run("UPDATE users SET status = ?, frozen_reason = '', updated_at = ? WHERE id = ?", [status, Date.now(), id]);
    if (status === 'disabled') db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: status === 'disabled' ? 'user.disable' : 'user.enable',
      targetType: 'user',
      targetId: id,
      detail: row.username,
      ip: ctx.clientIp(req),
    });
    return ok({ user: presenters.userBrief(db.get('SELECT * FROM users WHERE id = ?', [id])) });
  });

  /** 重置任一用户密码 */
  ctx.router.post('/api/admin/users/:id/reset-password', async (req) => {
    const actor = requireAdmin(req);
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!row) throw notFound('用户不存在');
    const pwd = String(req.body.password || '');
    if (pwd.length < 6) throw badRequest('新密码长度至少 6 位');
    db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(pwd), Date.now(), id]);
    db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'user.reset_password',
      targetType: 'user',
      targetId: id,
      detail: row.username,
      ip: ctx.clientIp(req),
    });
    return ok({ message: `已重置 ${row.name} 的密码，该用户需重新登录` });
  });

  /* ============================== 违约与信用 ============================== */

  ctx.router.get('/api/admin/violations', async (req) => {
    requireAdmin(req);
    const { page, pageSize } = pageQuery(req, 30);
    const conds = [];
    const params = [];
    if (req.query.type) {
      conds.push('v.type = ?');
      params.push(String(req.query.type));
    }
    if (req.query.userId) {
      conds.push('v.user_id = ?');
      params.push(Number(req.query.userId));
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db.all(
      `SELECT v.*, u.name AS user_name, b.code AS booking_code, d.name AS device_name, c.name AS creator_name
       FROM violations v JOIN users u ON u.id = v.user_id
       LEFT JOIN bookings b ON b.id = v.booking_id LEFT JOIN devices d ON d.id = b.device_id
       LEFT JOIN users c ON c.id = v.created_by
       ${where} ORDER BY v.created_at DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    );
    const total = Number(db.scalar(`SELECT COUNT(*) AS c FROM violations v ${where}`, params) || 0);
    const stats = db.all('SELECT type, COUNT(*) AS c, SUM(points) AS p FROM violations GROUP BY type');
    return ok({
      items: rows.map(presenters.violation),
      total,
      page,
      pageSize,
      stats: stats.map((s) => ({
        type: s.type,
        label: bkrules.VIOLATION_TYPES[s.type] ? bkrules.VIOLATION_TYPES[s.type].label : s.type,
        count: Number(s.c),
        points: Number(s.p || 0),
      })),
    });
  });

  /** 手工登记违约（设备损坏、违规使用等） */
  ctx.router.post('/api/admin/violations', async (req) => {
    const actor = requireAdmin(req);
    const userId = bodyInt(req, 'userId', { required: true, min: 1 });
    if (!db.get('SELECT id FROM users WHERE id = ?', [userId])) throw notFound('用户不存在');
    const type = bodyStr(req, 'type', { required: true, max: 20 });
    if (!bkrules.VIOLATION_TYPES[type]) throw badRequest('违约类型非法');
    const bookingId = bodyInt(req, 'bookingId', { def: null, min: 1 });
    if (bookingId && !db.get('SELECT id FROM bookings WHERE id = ?', [bookingId])) throw notFound('预约不存在');
    const detail = bodyStr(req, 'detail', { required: true, max: 300 });
    const points = bodyInt(req, 'points', { def: bkrules.violationPoints(type), min: 1, max: 100 });
    return db.writeTx(async () => {
      const result = creditService.recordViolation({
        userId,
        bookingId: bookingId || null,
        type,
        points,
        detail,
        createdBy: actor.id,
      });
      audit.log({
        userId: actor.id,
        actorName: actor.name,
        action: 'violation.create',
        targetType: 'violation',
        targetId: result.violationId,
        detail: { userId, type, points, detail },
        ip: ctx.clientIp(req),
      });
      return ok({ violationId: result.violationId, points, creditScore: result.scoreAfter }, 201);
    });
  });

  /** 撤销违约记录（误判纠正）：同时把分数加回 */
  ctx.router.del('/api/admin/violations/:id', async (req) => {
    const actor = requireAdmin(req);
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM violations WHERE id = ?', [id]);
    if (!row) throw notFound('违约记录不存在');
    const reason = bodyStr(req, 'reason', { def: '管理员撤销违约记录', max: 200 });
    return db.writeTx(async () => {
      db.run('DELETE FROM violations WHERE id = ?', [id]);
      creditService.applyChange(row.user_id, row.points, `撤销违约记录：${reason}`, {
        refType: 'violation_revoke',
        refId: id,
      });
      audit.log({
        userId: actor.id,
        actorName: actor.name,
        action: 'violation.revoke',
        targetType: 'violation',
        targetId: id,
        detail: { userId: row.user_id, points: row.points, reason },
        ip: ctx.clientIp(req),
      });
      return ok({ message: `已撤销违约记录并返还 ${row.points} 分` });
    });
  });

  /* ============================== 配置与审计 ============================== */

  ctx.router.get('/api/admin/config', async (req) => {
    requireAdmin(req);
    const rows = db.all('SELECT key, value, description FROM config ORDER BY key');
    const defaults = config.DEFAULTS;
    return ok({
      items: rows.map((r) => ({
        key: r.key,
        value: r.value,
        description: r.description,
        defaultValue: defaults[r.key] ? defaults[r.key].value : null,
        type: /^\d+$/.test(r.value) ? 'number' : 'text',
      })),
    });
  });

  ctx.router.patch('/api/admin/config', async (req) => {
    const actor = requireAdmin(req);
    const patch = req.body && typeof req.body === 'object' ? req.body : {};
    const unknown = Object.keys(patch).filter((k) => !Object.prototype.hasOwnProperty.call(config.DEFAULTS, k));
    if (unknown.length) throw badRequest(`未知配置项：${unknown.join(', ')}`);
    const numericKeys = Object.keys(config.DEFAULTS).filter((k) => /^\d+$/.test(config.DEFAULTS[k].value));
    for (const key of Object.keys(patch)) {
      if (numericKeys.includes(key)) {
        const n = Number(patch[key]);
        if (!Number.isFinite(n) || n < 0) throw badRequest(`配置项 ${key} 必须为非负数字`);
      }
    }
    const changed = config.update(patch, actor.id);
    audit.log({
      userId: actor.id,
      actorName: actor.name,
      action: 'config.update',
      targetType: 'config',
      targetId: 0,
      detail: changed,
      ip: ctx.clientIp(req),
    });
    return ok({ changed, items: db.all('SELECT key, value, description FROM config ORDER BY key') });
  });

  ctx.router.get('/api/admin/audit', async (req) => {
    requireAdmin(req);
    const { page, pageSize } = pageQuery(req, 30);
    const result = audit.list({
      page,
      pageSize,
      action: req.query.action || '',
      userId: req.query.userId ? Number(req.query.userId) : null,
    });
    return ok({
      items: result.items.map(presenters.auditLog),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  /** 系统运行状态（答辩演示：后台作业执行情况、数据库规模） */
  ctx.router.get('/api/admin/system', async (req) => {
    requireAdmin(req);
    const tables = [
      'users',
      'labs',
      'devices',
      'weekly_slots',
      'blackouts',
      'bookings',
      'waitlist',
      'violations',
      'credit_records',
      'notifications',
      'audit_logs',
      'sessions',
    ];
    const counts = {};
    for (const t of tables) {
      counts[t] = Number(db.scalar(`SELECT COUNT(*) AS c FROM ${t}`) || 0);
    }
    const dbPath = process.env.LAB_DB_PATH || require('node:path').join(__dirname, '..', '..', 'data', 'lab.db');
    let dbSizeKb = 0;
    try {
      dbSizeKb = Math.round(require('node:fs').statSync(dbPath).size / 1024);
    } catch {
      dbSizeKb = 0;
    }
    const journalMode = db.scalar('PRAGMA journal_mode');
    return ok({
      counts,
      db: { path: dbPath, sizeKb: dbSizeKb, journalMode },
      scheduler: scheduler.status(),
      runtime: {
        node: process.version,
        platform: process.platform,
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        now: Date.now(),
      },
      timezone: config.num('timezone_offset_minutes'),
    });
  });

  /** 每个实验室未来 n 天的空闲容量（管理员调度决策用） */
  ctx.router.get('/api/admin/capacity', async (req) => {
    requireAdmin(req);
    const days = Math.min(14, Math.max(1, intQuery(req, 'days', 7)));
    const tz = config.num('timezone_offset_minutes');
    const availability = require('../services/availability.service');
    const labs = db.all('SELECT * FROM labs ORDER BY id');
    const items = labs.map((lab) => {
      const devices = db.all("SELECT * FROM devices WHERE lab_id = ? AND status = 'available'", [lab.id]);
      const perDay = [];
      for (let i = 0; i < days; i += 1) {
        const dayStart = startOfDay(Date.now(), tz) + i * DAY;
        let free = 0;
        let total = 0;
        for (const d of devices) {
          const view = availability.deviceDayView(d, dayStart);
          free += view.free.reduce((s, f) => s + f.minutes, 0);
          total += view.schedule.reduce((s, f) => s + f.minutes, 0);
        }
        perDay.push({
          date: formatDate(dayStart, tz),
          freeMinutes: free,
          scheduleMinutes: total,
          utilization: total > 0 ? Number((1 - free / total).toFixed(4)) : 0,
        });
      }
      return { labId: lab.id, labName: lab.name, deviceCount: devices.length, days: perDay };
    });
    return ok({ items, days });
  });

  void MINUTE;
}

module.exports = { register };
