'use strict';

/**
 * 测试辅助模块
 * ------------------------------------------------------------------
 * 每个测试文件运行在独立的进程里，因此可以安全地使用内存数据库，
 * 通过环境变量 LAB_DB_PATH=':memory:' 让 src/db/index.js 初始化内存库并自动注入演示数据。
 */

process.env.LAB_DB_PATH = process.env.LAB_DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';

const db = require('../src/db');
const config = require('../src/core/config');
const bookingService = require('../src/services/booking.service');
const creditService = require('../src/services/credit.service');

let bootstrapped = false;

/** 初始化数据库（内存库 + 演示数据），幂等 */
function bootstrap() {
  if (!bootstrapped) {
    db.init(':memory:');
    config.ensureDefaults();
    bootstrapped = true;
  }
  return db;
}

/** 启动一个独立的 HTTP 服务实例（随机端口），返回 { base, close, ctx } */
async function startTestServer() {
  bootstrap();
  const { start } = require('../src/http/server');
  const app = await start({ port: 0, host: '127.0.0.1' });
  return {
    base: `http://127.0.0.1:${app.port}`,
    close: app.close,
    ctx: app.ctx,
    port: app.port,
  };
}

/** 登录并返回 token */
async function login(base, username, password = '123456') {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`登录失败：${json.message}`);
  return { token: json.data.token, user: json.data.user };
}

/** 带 token 的请求封装 */
async function request(base, method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json, data: json && json.ok ? json.data : null };
}

/**
 * 取一个真正空闲的未来时段（避开指定用户自身的预约、设备既有占用以及停机计划）。
 * 从第 3 天开始找起，避免与「今天/明天」的演示数据纠缠。
 * @param {object} device
 * @param {number} userId
 * @param {{days?:number, minutes?:number, now?:number, skip?:number}} [opts]
 * @returns {{start:number,end:number,date:string}|null}
 */
function findFreeWindow(device, userId, { days = 13, minutes = 60, now = Date.now(), skip = 0 } = {}) {
  const availability = require('../src/services/availability.service');
  const { startOfDay, DAY, addDays, formatDate } = require('../src/utils/time');
  const config = require('../src/core/config');
  const statuses = require('../src/core/booking-rules').occupyingStatuses();
  const ph = statuses.map(() => '?').join(',');
  const tz = config.num('timezone_offset_minutes');
  const first = startOfDay(now, tz);
  let found = 0;
  for (let d = 3; d <= days; d += 1) {
    const dayStart = addDays(first, d);
    const view = availability.deviceDayView(device, dayStart);
    for (const free of view.free) {
      if (!free.selectable || free.minutes < minutes) continue;
      const start = free.start;
      const end = start + minutes * 60000;
      const selfBusy = db.get(
        `SELECT id FROM bookings WHERE user_id = ? AND status IN (${ph}) AND start_at < ? AND end_at > ?`,
        [userId, ...statuses, end, start],
      );
      if (selfBusy) continue;
      if (found < skip) {
        found += 1;
        continue;
      }
      return { start, end, date: formatDate(dayStart, tz) };
    }
  }
  return null;
}

/** 直接插入一条预约（用于构造历史/边界场景），返回预约 id */
function insertBooking({
  deviceId,
  userId,
  startAt,
  endAt,
  status = 'approved',
  purpose = '测试用预约',
  checkinCode = '123456',
  labId = null,
  checkedInAt = 0,
  code = null,
}) {
  const device = db.get('SELECT * FROM devices WHERE id = ?', [deviceId]);
  const now = Date.now();
  const res = db.run(
    `INSERT INTO bookings (code, device_id, lab_id, user_id, start_at, end_at, purpose, course_name,
         participants, status, checkin_code, checkin_checked, reviewed_at, checked_in_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      code || `TST${now.toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`,
      deviceId,
      labId || device.lab_id,
      userId,
      startAt,
      endAt,
      purpose,
      status,
      checkinCode,
      checkedInAt ? 1 : 0,
      now,
      checkedInAt,
      now,
      now,
    ],
  );
  return Number(res.lastInsertRowid);
}

/** 重置某用户的信用分为 100 并清空其台账（测试隔离用） */
function resetCredit(userId) {
  db.run('DELETE FROM credit_records WHERE user_id = ?', [userId]);
  db.run('DELETE FROM violations WHERE user_id = ?', [userId]);
  db.run("UPDATE users SET credit_score = 100, status = 'active', frozen_reason = '', frozen_until = 0 WHERE id = ?", [userId]);
}

module.exports = {
  db,
  config,
  bootstrap,
  startTestServer,
  login,
  request,
  findFreeWindow,
  insertBooking,
  resetCredit,
  bookingService,
  creditService,
};
