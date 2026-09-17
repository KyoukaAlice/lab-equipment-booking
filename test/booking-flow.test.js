'use strict';

/**
 * 预约全流程集成测试
 * ------------------------------------------------------------------
 * 覆盖：提交 → 审批 → 签到 → 签退 → 取消 → 爽约判定 → 候补补位 → 并发唯一性
 * 通过在数据库中构造「相对当前时刻」的预约来覆盖签到时间窗等边界，无需篡改系统时钟。
 */

const { test, before, after, assert } = require('./runner');
const { db, config, startTestServer, login, request, findFreeWindow, insertBooking } = require('./helpers');
const bookingService = require('../src/services/booking.service');
const creditService = require('../src/services/credit.service');
const bkrules = require('../src/core/booking-rules');
const { MINUTE, HOUR, DAY, startOfDay } = require('../src/utils/time');

/**
 * 为测试账号清空「在途状态」的业务数据，使每个用例从确定性起点开始。
 * 说明：测试库是内存库且每个测试文件独立，但同一文件内的多个用例会相互影响
 * （在途预约上限、候补重复、时段占用）。在 before 中统一清理，保证用例顺序无关。
 */
function resetTestUserData(userIds) {
  const ph = userIds.map(() => '?').join(',');
  db.run(`DELETE FROM waitlist WHERE user_id IN (${ph})`, userIds);
  db.run(
    `DELETE FROM bookings WHERE user_id IN (${ph}) AND status IN ('pending','approved','checked_in')`,
    userIds,
  );
  db.run(
    `UPDATE users SET weekly_quota_min = 1440, credit_score = 100, status = 'active',
       frozen_reason = '', frozen_until = 0 WHERE id IN (${ph})`,
    userIds,
  );
}

/**
 * 在给定时刻之后的开放排班里挑一个「足够长、且设备上确实空闲」的窗口。
 * 目的：
 *   1) 不同设备的最短预约时长不同（30~180 分钟），候补补位要求交集不短于该下限；
 *   2) 演示数据里设备已有若干预约，直接占用排班第一个区间会与既有预约重叠，
 *      导致后续冲突校验失败、候补无法补位。
 */
function pickSchedulableWindow(device, probeTs, { need = null } = {}) {
  const conflictRules = require('../src/core/conflict-rules');
  const interval = require('../src/core/interval');
  const bkrules = require('../src/core/booking-rules');
  const tz = config.num('timezone_offset_minutes');
  const required = need || Math.max(Number(device.min_minutes), 60);
  const statuses = bkrules.occupyingStatuses();
  const ph = statuses.map(() => '?').join(',');
  for (let d = 0; d < 8; d += 1) {
    const dayStart = startOfDay(probeTs, tz) + d * DAY;
    const schedule = conflictRules.scheduleForRange(device, dayStart, dayStart + DAY, tz);
    const busy = conflictRules.collectBusyIntervals(device.id, device.lab_id, dayStart, dayStart + DAY);
    const free = interval.subtract(
      schedule,
      busy.bookings.map((b) => ({ start: b.start_at, end: b.end_at })),
    );
    for (const block of free) {
      if (block.end - block.start < required * MINUTE) continue;
      const start = block.start;
      const end = start + required * MINUTE;
      // 双重保险：直接查库确认该窗口没有任何在途预约
      const occupied = db.get(
        `SELECT id FROM bookings WHERE device_id = ? AND status IN (${ph}) AND start_at < ? AND end_at > ?`,
        [device.id, ...statuses, end, start],
      );
      if (occupied) continue;
      return { start, end, minutes: required };
    }
  }
  throw new Error(`设备「${device.name}」未来 8 天内没有长度 ≥ ${required} 分钟且空闲的开放时段`);
}

/**
 * 找一个「所有候选用户都能成功预约」的时段，并确保该时段在设备排班内。
 * 并发类用例必须基于这样的时段，否则失败原因会变成额度/自身冲突，
 * 而不是我们要验证的「同一时段只允许一条预约」。
 * @returns {Array<{start:number,end:number}>} 候选窗口（按时间升序）
 */
function candidateWindows(device, users, { minutes = 60, days = 10 } = {}) {
  const conflictRules = require('../src/core/conflict-rules');
  const tz = config.num('timezone_offset_minutes');
  const interval = require('../src/core/interval');
  const bkrules = require('../src/core/booking-rules');
  const statuses = bkrules.occupyingStatuses();
  const ph = statuses.map(() => '?').join(',');
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const dayStart = startOfDay(Date.now(), tz) + d * DAY;
    const schedule = conflictRules.scheduleForRange(device, dayStart, dayStart + DAY, tz);
    const busy = conflictRules.collectBusyIntervals(device.id, device.lab_id, dayStart, dayStart + DAY);
    const blockers = busy.bookings.map((b) => ({ start: b.start_at, end: b.end_at }));
    const free = interval.subtract(schedule, blockers);
    for (const block of free) {
      if (block.end - block.start < minutes * MINUTE) continue;
      const start = block.start;
      const end = start + minutes * MINUTE;
      const conflict = users.find((u) =>
        db.get(
          `SELECT id FROM bookings WHERE user_id = ? AND status IN (${ph}) AND start_at < ? AND end_at > ?`,
          [u.id, ...statuses, end, start],
        ),
      );
      if (conflict) continue;
      out.push({ start, end });
      break; // 每天最多取一个窗口，保证时间分布分散
    }
  }
  return out;
}

let server;
let admin;
let teacher;
let studentA;
let studentB;
let device;

before(async () => {
  server = await startTestServer();
  admin = await login(server.base, 'admin');
  teacher = await login(server.base, 'teacher');
  studentA = await login(server.base, 'student3');
  studentB = await login(server.base, 'student6');
  device = db.get("SELECT * FROM devices WHERE status = 'available' AND auto_approve = 0 ORDER BY id LIMIT 1");

  // 测试起点：清空测试账号的在途预约、候补与信用异常，并放开周额度
  resetTestUserData([studentA.user.id, studentB.user.id]);
});

after(async () => {
  if (server) await server.close();
});

test('提交预约：待审批状态、编号格式、通知与审计落库', async () => {
  const window = findFreeWindow(device, studentA.user.id, { minutes: 60 });
  assert.ok(window, '应能找到空闲时段');
  const res = await request(server.base, 'POST', '/api/bookings', {
    token: studentA.token,
    body: {
      deviceId: device.id,
      startAt: window.start,
      endAt: window.end,
      purpose: '集成测试：验证提交预约的基本流程',
      participants: 2,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const booking = res.data.booking;
  assert.equal(booking.status, 'pending');
  assert.match(booking.code, /^BK\d{8}-\d{4}$/);
  assert.equal(booking.deviceId, device.id);
  assert.equal(booking.mine, true);
  assert.equal(booking.checkinCode, '', '待审批阶段不应有签到码');

  const notify = db.get(
    "SELECT * FROM notifications WHERE user_id = ? AND type = 'booking.submitted' ORDER BY id DESC LIMIT 1",
    [studentA.user.id],
  );
  assert.ok(notify, '提交后应给申请人发送通知');
  const audit = db.get(
    "SELECT * FROM audit_logs WHERE action = 'booking.create' AND target_id = ?",
    [booking.id],
  );
  assert.ok(audit, '提交后应写入审计日志');
});

test('审批流程：非负责人不能审批、自审自批被禁止', async () => {
  const window = findFreeWindow(device, studentB.user.id, { minutes: 60, skip: 1 });
  const created = await bookingService.create(
    db.get('SELECT * FROM users WHERE id = ?', [studentB.user.id]),
    { deviceId: device.id, startAt: window.start, endAt: window.end, purpose: '集成测试：审批权限校验' },
  );
  // 学生无权审批
  await assert.rejects(
    () => bookingService.approve(db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]), created.id, ''),
    (err) => err.status === 403,
  );
  // 申请人本人即使是负责人也不能自审自批
  const labManagers = db.all('SELECT user_id FROM lab_managers WHERE lab_id = ?', [device.lab_id]);
  if (labManagers.length) {
    const manager = db.get('SELECT * FROM users WHERE id = ?', [labManagers[0].user_id]);
    const third = db.get("SELECT * FROM users WHERE role = 'admin' LIMIT 1");
    const own = await bookingService.create(manager, {
      deviceId: device.id,
      startAt: window.start + 90 * MINUTE,
      endAt: window.end + 90 * MINUTE,
      purpose: '集成测试：负责人自己的预约',
    }).catch(() => null);
    if (own) {
      await assert.rejects(
        () => bookingService.approve(manager, own.id, ''),
        (err) => err.status === 403,
        '不得审批自己的预约',
      );
      await bookingService.cancel(third, own.id, '测试清理');
    }
  }
  await bookingService.cancel(db.get("SELECT * FROM users WHERE role='admin' LIMIT 1"), created.id, '测试清理');
});

test('审批通过：生成签到码、状态迁移、额度恢复、通知申请人', async () => {
  const window = findFreeWindow(device, studentA.user.id, { minutes: 60, skip: 2 });
  const booking = await bookingService.create(
    db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]),
    { deviceId: device.id, startAt: window.start, endAt: window.end, purpose: '集成测试：审批通过链路' },
  );
  const approved = await bookingService.approve(
    db.get('SELECT * FROM users WHERE id = ?', [teacher.user.id]),
    booking.id,
    '同意使用，请注意安全',
  );
  assert.equal(approved.status, 'approved');
  assert.match(approved.checkinCode, /^\d{6}$/);
  assert.equal(approved.reviewNote, '同意使用，请注意安全');
  assert.ok(approved.reviewedAt > 0);
  assert.equal(approved.reviewerName, teacher.user.name);

  const notify = db.get(
    "SELECT * FROM notifications WHERE user_id = ? AND type = 'booking.approved' ORDER BY id DESC LIMIT 1",
    [studentA.user.id],
  );
  assert.ok(notify && notify.content.includes(approved.checkinCode), '审批通过通知应包含签到码');
});

test('审批驳回：必须填写原因、释放时段、通知申请人', async () => {
  const window = findFreeWindow(device, studentA.user.id, { minutes: 60, skip: 3 });
  const booking = await bookingService.create(
    db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]),
    { deviceId: device.id, startAt: window.start, endAt: window.end, purpose: '集成测试：驳回链路' },
  );
  await assert.rejects(
    () => bookingService.reject(db.get('SELECT * FROM users WHERE id = ?', [teacher.user.id]), booking.id, ''),
    (err) => err.status === 400,
  );
  const rejected = await bookingService.reject(
    db.get('SELECT * FROM users WHERE id = ?', [teacher.user.id]),
    booking.id,
    '该时段设备需用于教学实验',
  );
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectReason, '该时段设备需用于教学实验');
  // 驳回后该时段应重新可用
  const conflict = require('../src/core/conflict-rules').validateBookingRequest({
    device,
    lab: db.get('SELECT * FROM labs WHERE id = ?', [device.lab_id]),
    user: db.get('SELECT * FROM users WHERE id = ?', [studentB.user.id]),
    startAt: window.start,
    endAt: window.end,
  });
  assert.equal(conflict.ok, true, '驳回后时段应被释放');
});

test('签到：时间窗校验、签到码校验、成功后状态为使用中', async () => {
  const user = db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]);
  const now = Date.now();
  const openBefore = config.num('checkin_open_before_minutes') * MINUTE;

  // 找到该设备上一段占用的结束时刻，把「签到窗口内」的新预约紧接其后创建；
  // 这样既保证与既有占用不重叠，又保证开始时间只比当前晚一点点（仍在签到窗口内）。
  const lastEnd = Number(
    db.get(
      `SELECT MAX(end_at) AS mx FROM bookings WHERE device_id = ? AND status IN ('pending','approved','checked_in')`,
      [device.id],
    ).mx || 0,
  );
  let startAt = now + 5 * MINUTE;
  if (lastEnd > startAt) startAt = lastEnd;
  if (startAt - now > openBefore) startAt = now + openBefore - 5 * MINUTE;
  const id = insertBooking({
    deviceId: device.id,
    userId: user.id,
    startAt,
    endAt: startAt + HOUR,
    status: 'approved',
    checkinCode: '654321',
  });

  await assert.rejects(
    () => bookingService.checkin(user, id, '000000'),
    (err) => err.code === 'BAD_CHECKIN_CODE',
    '错误签到码必须被拒绝',
  );
  const checked = await bookingService.checkin(user, id, '654321');
  assert.equal(checked.status, 'checked_in');
  assert.ok(checked.checkedInAt > 0);
  assert.equal(db.get('SELECT checkin_checked FROM bookings WHERE id = ?', [id]).checkin_checked, 1);
});

test('签到：未到开放时间与超过宽限期都被拒绝', async () => {
  const user = db.get('SELECT * FROM users WHERE id = ?', [studentB.user.id]);
  const now = Date.now();
  const occupied = db.get(
    `SELECT MAX(end_at) AS mx FROM bookings WHERE device_id = ?`,
    [device.id],
  );
  const base = Math.max(now + 4 * HOUR, Number(occupied.mx || 0) + 2 * HOUR);

  const tooEarlyId = insertBooking({
    deviceId: device.id,
    userId: user.id,
    startAt: base + 3 * HOUR,
    endAt: base + 4 * HOUR,
    status: 'approved',
    checkinCode: '111111',
  });
  await assert.rejects(
    () => bookingService.checkin(user, tooEarlyId, '111111'),
    (err) => err.code === 'CHECKIN_TOO_EARLY',
  );

  const tooLateId = insertBooking({
    deviceId: device.id,
    userId: user.id,
    startAt: now - 60 * MINUTE,
    endAt: now - 10 * MINUTE,
    status: 'approved',
    checkinCode: '222222',
  });
  await assert.rejects(
    () => bookingService.checkin(user, tooLateId, '222222'),
    (err) => err.code === 'CHECKIN_TOO_LATE',
  );
});

test('签退：记录实际使用时长；超时占用自动记违约并扣分', async () => {
  const user = db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]);
  creditService.applyChange(user.id, 0, '测试基线', {});
  const before = db.get('SELECT credit_score FROM users WHERE id = ?', [user.id]).credit_score;

  // 场景一：正常签退（时间窗未超）
  const okId = insertBooking({
    deviceId: device.id,
    userId: user.id,
    startAt: Date.now() - 50 * MINUTE,
    endAt: Date.now() + 30 * MINUTE,
    status: 'checked_in',
    checkedInAt: Date.now() - 50 * MINUTE,
    checkinCode: '333333',
  });
  const done = await bookingService.checkout(db.get('SELECT * FROM users WHERE id = ?', [user.id]), okId);
  assert.equal(done.status, 'completed');
  assert.ok(done.actualMinutes >= 49 && done.actualMinutes <= 51, `实际时长应约为 50 分钟，实际 ${done.actualMinutes}`);

  // 场景二：超时占用（超过结束时间 + 宽限期）
  const lateId = insertBooking({
    deviceId: device.id,
    userId: user.id,
    startAt: Date.now() - 3 * HOUR,
    endAt: Date.now() - 40 * MINUTE,
    status: 'checked_in',
    checkedInAt: Date.now() - 3 * HOUR,
    checkinCode: '444444',
  });
  const late = await bookingService.checkout(db.get('SELECT * FROM users WHERE id = ?', [user.id]), lateId);
  assert.equal(late.status, 'completed');
  const violation = db.get("SELECT * FROM violations WHERE booking_id = ? AND type = 'overtime'", [lateId]);
  assert.ok(violation, '超时应生成 overtime 违约记录');
  const after = db.get('SELECT credit_score FROM users WHERE id = ?', [user.id]).credit_score;
  assert.equal(after, before - violation.points, '信用分应扣减对应分值');
});

test('取消：临近开始取消会记「临时取消」违约，提前取消不扣分', async () => {
  const user = db.get('SELECT * FROM users WHERE id = ?', [studentB.user.id]);
  const now = Date.now();
  const maxEnd = Number(db.get(`SELECT MAX(end_at) AS mx FROM bookings WHERE device_id = ?`, [device.id]).mx || 0);

  // 提前很久取消：不扣分
  const earlyId = insertBooking({
    deviceId: device.id,
    userId: user.id,
    startAt: now + 20 * DAY,
    endAt: now + 20 * DAY + HOUR,
    status: 'approved',
    checkinCode: '555555',
  });
  const before = db.get('SELECT credit_score FROM users WHERE id = ?', [user.id]).credit_score;
  await bookingService.cancel(user, earlyId, '提前取消，不扣分');
  assert.equal(
    db.get('SELECT credit_score FROM users WHERE id = ?', [user.id]).credit_score,
    before,
    '远距离提前取消不应扣分',
  );

  // 临近开始取消：扣分 + 违约记录
  const lateStart = Math.max(now + 30 * MINUTE, 0) + 0;
  const lateId = insertBooking({
    deviceId: device.id,
    userId: user.id,
    startAt: lateStart,
    endAt: lateStart + HOUR,
    status: 'approved',
    checkinCode: '666666',
  });
  const scoreBefore = db.get('SELECT credit_score FROM users WHERE id = ?', [user.id]).credit_score;
  const cancelled = await bookingService.cancel(user, lateId, '临时取消，应扣分');
  assert.equal(cancelled.status, 'cancelled');
  const violation = db.get("SELECT * FROM violations WHERE booking_id = ? AND type = 'late_cancel'", [lateId]);
  assert.ok(violation, '临近开始取消应生成 late_cancel 违约');
  assert.equal(
    db.get('SELECT credit_score FROM users WHERE id = ?', [user.id]).credit_score,
    scoreBefore - violation.points,
  );
  void maxEnd;
});

test('爽约判定：超过签到宽限期未签到 → no_show + 扣分 + 释放时段 + 顺延候补', async () => {
  const user = db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]);
  const now = Date.now();
  const grace = config.num('checkin_grace_minutes');
  const id = insertBooking({
    deviceId: device.id,
    userId: user.id,
    startAt: now - (grace + 30) * MINUTE,
    endAt: now - (grace + 5) * MINUTE,
    status: 'approved',
    checkinCode: '777777',
  });
  const scoreBefore = db.get('SELECT credit_score FROM users WHERE id = ?', [user.id]).credit_score;
  const processed = bookingService.processNoShows(Date.now());
  assert.ok(processed >= 1, '应至少处理一条爽约');
  const row = db.get('SELECT * FROM bookings WHERE id = ?', [id]);
  assert.equal(row.status, 'no_show');
  const violation = db.get("SELECT * FROM violations WHERE booking_id = ? AND type = 'no_show'", [id]);
  assert.ok(violation, '应生成爽约违约记录');
  assert.equal(
    db.get('SELECT credit_score FROM users WHERE id = ?', [user.id]).credit_score,
    scoreBefore - violation.points,
  );
  const notify = db.get(
    "SELECT * FROM notifications WHERE user_id = ? AND type = 'violation.created' ORDER BY id DESC LIMIT 1",
    [user.id],
  );
  assert.ok(notify, '违约后应通知本人');
});

test('信用阈值：分数跌破阈值自动冻结，冻结到期自动解冻', async () => {
  const user = db.get("SELECT * FROM users WHERE role = 'student' AND status = 'active' ORDER BY id DESC LIMIT 1");
  const score = db.get('SELECT credit_score FROM users WHERE id = ?', [user.id]).credit_score;
  const threshold = config.num('credit_freeze_threshold');
  // 一次性扣到阈值以下
  creditService.applyChange(user.id, -(score - (threshold - 5)), '测试：模拟多次违规累计扣分', {});
  const frozen = db.get('SELECT * FROM users WHERE id = ?', [user.id]);
  assert.equal(frozen.status, 'frozen', '低于阈值应自动冻结');
  assert.ok(frozen.frozen_until > Date.now(), '应写入解冻时间');
  assert.match(frozen.frozen_reason, /信用分低于/);

  // 模拟冻结期已到，运行自动解冻
  db.run('UPDATE users SET frozen_until = ? WHERE id = ?', [Date.now() - 1000, user.id]);
  const unfrozen = creditService.autoUnfreezeExpired();
  assert.ok(unfrozen >= 1);
  assert.equal(db.get('SELECT status FROM users WHERE id = ?', [user.id]).status, 'active');

  // 手工解冻接口
  creditService.applyChange(user.id, -50, '测试：再次扣分触发冻结', {});
  creditService.unfreeze(user.id, '测试手动解冻');
  assert.equal(db.get('SELECT status FROM users WHERE id = ?', [user.id]).status, 'active');
});

test('候补队列：占用时才能候补 → 释放后自动补位 → 限时确认转正式预约', async () => {
  resetTestUserData([studentA.user.id, studentB.user.id]);
  const lab = db.get('SELECT * FROM labs WHERE id = ?', [device.lab_id]);
  const userA = db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]);
  const userB = db.get('SELECT * FROM users WHERE id = ?', [studentB.user.id]);
  const now = Date.now();
  const maxEnd = Number(db.get(`SELECT MAX(end_at) AS mx FROM bookings WHERE device_id = ?`, [device.id]).mx || 0);
  // 必须落在「最大提前预约天数」之内，否则补位时会命中 R06 而无法提升
  const startAt = Math.min(
    Math.max(now + 26 * HOUR, maxEnd + 2 * HOUR),
    now + (config.num('booking_advance_days') - 2) * DAY,
  );

  // 先让 A 占用该时段（直接插入，确保时段落在排班内、不短于设备最短时长，且未被其它预约占用）
  const window = pickSchedulableWindow(device, startAt);
  const occupiedId = insertBooking({
    deviceId: device.id,
    userId: userA.id,
    startAt: window.start,
    endAt: window.end,
    status: 'approved',
    checkinCode: '888888',
  });

  // 空闲时段不允许候补
  const future = findFreeWindow(device, userB.id, { minutes: window.minutes });
  await assert.rejects(
    () => bookingService.joinWaitlist(userB, { deviceId: device.id, startAt: future.start, endAt: future.end, purpose: '空闲时段不该允许候补' }),
    (err) => err.code === 'CONFLICT',
  );

  // 加入候补
  const wl = await bookingService.joinWaitlist(userB, {
    deviceId: device.id,
    startAt: window.start,
    endAt: window.end,
    purpose: '集成测试：候补补位',
  }).catch((err) => {
    throw new Error(
      `加入候补失败：${err.message}｜窗口=${new Date(window.start).toISOString()}~${new Date(window.end).toISOString()}｜` +
        `占用预约=${JSON.stringify(db.get('SELECT id,status FROM bookings WHERE id = ?', [occupiedId]))}｜` +
        `窗口内占用=${JSON.stringify(db.all('SELECT id,status,user_id FROM bookings WHERE device_id = ? AND start_at < ? AND end_at > ?', [device.id, window.end, window.start]))}`,
    );
  });
  assert.equal(wl.status, 'waiting');
  assert.equal(wl.queuePosition, 1);

  // 重复候补被拒绝
  await assert.rejects(
    () => bookingService.joinWaitlist(userB, { deviceId: device.id, startAt: window.start, endAt: window.end, purpose: '重复候补' }),
    (err) => err.code === 'CONFLICT',
  );

  // A 取消 → 自动补位给 B
  await bookingService.cancel(userA, occupiedId, '集成测试：释放时段触发补位').catch((err) => {
    throw new Error(`取消失败：${err.message}（occupiedId=${occupiedId}）`);
  });
  const promoted = db.get('SELECT * FROM waitlist WHERE id = ?', [wl.id]);
  assert.equal(promoted.status, 'promoted', '取消后候补应被提升为待确认');
  assert.ok(promoted.expires_at > Date.now(), '应写入确认时限');
  assert.ok(promoted.booking_id > 0, '应生成占位预约');
  const notify = db.get(
    "SELECT * FROM notifications WHERE user_id = ? AND type = 'waitlist.promoted' ORDER BY id DESC LIMIT 1",
    [userB.id],
  );
  assert.ok(notify, '补位后应通知候补用户');

  // 确认补位 → 转为正式预约
  const confirmed = await bookingService.confirmWaitlist(userB, wl.id);
  assert.equal(confirmed.booking.status === 'pending' || confirmed.booking.status === 'approved', true);
  assert.equal(db.get('SELECT status FROM waitlist WHERE id = ?', [wl.id]).status, 'converted');
  assert.ok(confirmed.booking.id > 0);

  // 清理：取消由候补产生的预约与占位预约
  await bookingService.cancel(userB, confirmed.booking.id, '测试清理');
  void lab;
});

test('候补确认超时：自动失效并顺延给下一位候补', async () => {
  resetTestUserData([studentA.user.id, studentB.user.id]);
  const userA = db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]);
  const userB = db.get('SELECT * FROM users WHERE id = ?', [studentB.user.id]);
  const userC = db.get("SELECT * FROM users WHERE username = 'student7'");
  resetTestUserData([userC.id]);

  const maxEnd = Number(db.get(`SELECT MAX(end_at) AS mx FROM bookings WHERE device_id = ?`, [device.id]).mx || 0);
  const now = Date.now();
  const advanceLimit = now + (config.num('booking_advance_days') - 2) * DAY;
  const probe = Math.min(Math.max(now + 50 * HOUR, maxEnd + 3 * HOUR), advanceLimit);
  const window = pickSchedulableWindow(device, probe);

  const occupiedId = insertBooking({
    deviceId: device.id,
    userId: userA.id,
    startAt: window.start,
    endAt: window.end,
    status: 'approved',
    checkinCode: '999999',
  });
  const wlFirst = await bookingService.joinWaitlist(userB, { deviceId: device.id, startAt: window.start, endAt: window.end, purpose: '第一位候补' });
  const wlSecond = await bookingService.joinWaitlist(userC, { deviceId: device.id, startAt: window.start, endAt: window.end, purpose: '第二位候补' });
  assert.equal(wlSecond.queuePosition, 2, '排队位次应按申请时间递增');

  await bookingService.cancel(userA, occupiedId, '释放时段给候补');
  assert.equal(db.get('SELECT status FROM waitlist WHERE id = ?', [wlFirst.id]).status, 'promoted');

  // 把第一位候补的确认时限改到过去，触发超时顺延
  db.run('UPDATE waitlist SET expires_at = ? WHERE id = ?', [Date.now() - 1000, wlFirst.id]);
  const expired = await bookingService.expireWaitlistHolds(Date.now());
  assert.ok(expired >= 1, '应处理超时的候补确认');
  assert.equal(db.get('SELECT status FROM waitlist WHERE id = ?', [wlFirst.id]).status, 'expired');
  assert.equal(
    db.get('SELECT status FROM waitlist WHERE id = ?', [wlSecond.id]).status,
    'promoted',
    '超时后应顺延给下一位候补',
  );

  // 清理
  const leftover = db.get('SELECT booking_id FROM waitlist WHERE id = ?', [wlSecond.id]).booking_id;
  if (leftover) await bookingService.cancel(db.get("SELECT * FROM users WHERE role='admin' LIMIT 1"), leftover, '测试清理').catch(() => {});
});

test('并发唯一性：20 个请求同时抢同一时段，只有 1 个成功', async () => {
  resetTestUserData([studentA.user.id, studentB.user.id]);
  const [windowA, windowB] = candidateWindows(device, [studentA.user, studentB.user], { minutes: 60 });
  assert.ok(windowA && windowB, '应能找到所有候选用户都可用的时段');

  // 为了排除「同一用户在途上限」的干扰，直接用服务层并发调用（同一时段、同一用户）
  const user = db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]);
  const attempts = 20;
  const results = await Promise.allSettled(
    Array.from({ length: attempts }, (_v, i) =>
      bookingService.create(user, {
        deviceId: device.id,
        startAt: windowA.start,
        endAt: windowA.end,
        purpose: `并发抢单测试 ${i + 1}`,
      }),
    ),
  );
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, `并发下单应只有 1 个成功，实际成功 ${fulfilled.length} 个`);
  assert.equal(rejected.length, attempts - 1, '其余请求都应被拒绝');
  for (const r of rejected) {
    assert.ok(
      ['R10', 'R11', 'R12'].includes(r.reason.code),
      `拒绝原因应为冲突类规则，实际 ${r.reason.code}：${r.reason.message}`,
    );
  }

  const rows = db.all(
    `SELECT * FROM bookings WHERE device_id = ? AND status IN ('pending','approved') AND start_at = ? AND end_at = ?`,
    [device.id, windowA.start, windowA.end],
  );
  assert.equal(rows.length, 1, '数据库中该时段只应存在一条有效预约');

  // HTTP 层的并发同样只允许一条成功
  const window2 = windowB;
  const httpResults = await Promise.all(
    Array.from({ length: 8 }, (_v, i) =>
      request(server.base, 'POST', '/api/bookings', {
        token: studentB.token,
        body: {
          deviceId: device.id,
          startAt: window2.start,
          endAt: window2.end,
          purpose: `HTTP 并发抢单测试 ${i + 1}`,
        },
      }),
    ),
  );
  const okCount = httpResults.filter((r) => r.status === 201).length;
  assert.equal(okCount, 1, `HTTP 并发应只有 1 个 201 成功，实际 ${okCount} 个`);
  const httpConflict = db.all(
    `SELECT * FROM bookings WHERE device_id = ? AND status IN ('pending','approved') AND start_at = ? AND end_at = ?`,
    [device.id, window2.start, window2.end],
  );
  assert.equal(httpConflict.length, 1, 'HTTP 并发后该时段也只应存在一条预约');
});

test('并发唯一性：不同用户同时抢同一时段，也不会产生双重预约', async () => {
  const users = db.all("SELECT * FROM users WHERE role = 'student' AND status = 'active' ORDER BY id LIMIT 6");
  // 清空这些用户的在途预约，保证并发结果只由「时段唯一性」决定，而不是被在途上限干扰
  resetTestUserData(users.map((u) => u.id));
  const freshUsers = db.all("SELECT * FROM users WHERE role = 'student' AND status = 'active' ORDER BY id LIMIT 6");

  const windows = candidateWindows(device, freshUsers, { minutes: 60 });
  assert.ok(windows.length > 0, '应能找到所有候选用户都可用的时段');
  const window = windows[0];

  const results = await Promise.allSettled(
    freshUsers.map((u, i) =>
      bookingService.create(u, {
        deviceId: device.id,
        startAt: window.start,
        endAt: window.end,
        purpose: `多用户并发抢单测试 ${i + 1}`,
      }),
    ),
  );
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, `多用户并发时也只应 1 个成功，实际 ${fulfilled.length}`);
  const rows = db.all(
    `SELECT * FROM bookings WHERE device_id = ? AND status IN ('pending','approved') AND start_at = ? AND end_at = ?`,
    [device.id, window.start, window.end],
  );
  assert.equal(rows.length, 1);
});

test('状态机：非法状态迁移被拒绝（已取消不可再审批、已驳回不可签到）', async () => {
  const user = db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]);
  const now = Date.now();
  const cancelledId = insertBooking({
    deviceId: device.id,
    userId: user.id,
    startAt: now + 8 * DAY,
    endAt: now + 8 * DAY + HOUR,
    status: 'cancelled',
    checkinCode: '121212',
  });
  await assert.rejects(
    () => bookingService.approve(db.get('SELECT * FROM users WHERE id = ?', [teacher.user.id]), cancelledId, ''),
    (err) => err.code === 'ILLEGAL_TRANSITION',
  );
  const rejectedId = insertBooking({
    deviceId: device.id,
    userId: user.id,
    startAt: now + 9 * DAY,
    endAt: now + 9 * DAY + HOUR,
    status: 'rejected',
    checkinCode: '131313',
  });
  await assert.rejects(
    () => bookingService.checkin(db.get('SELECT * FROM users WHERE id = ?', [user.id]), rejectedId, '131313'),
    (err) => err.code === 'ILLEGAL_TRANSITION',
  );
  assert.equal(bkrules.canTransition('completed', 'pending'), false);
  assert.equal(bkrules.canTransition('pending', 'approved'), true);
  assert.equal(bkrules.canTransition('approved', 'checked_in'), true);
});

test('预约详情：他人无权查看，本人与审批人可查看', async () => {
  resetTestUserData([studentA.user.id, studentB.user.id]);
  const window = findFreeWindow(device, studentA.user.id, { minutes: 60 });
  const booking = await bookingService.create(
    db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]),
    { deviceId: device.id, startAt: window.start, endAt: window.end, purpose: '集成测试：详情权限' },
  );
  const owner = db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]);
  const other = db.get('SELECT * FROM users WHERE id = ?', [studentB.user.id]);
  const manager = db.get('SELECT * FROM users WHERE id = ?', [teacher.user.id]);
  assert.ok(bookingService.detail(owner, booking.id).code);
  assert.ok(bookingService.detail(manager, booking.id).code, '实验室负责人应可查看');
  assert.throws(() => bookingService.detail(other, booking.id), (err) => err.status === 403);
});

test('列表可见范围：学生只能看到自己的预约，管理员可见全部', async () => {
  const studentList = bookingService.list(db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]), { pageSize: 100 });
  assert.ok(studentList.items.length > 0);
  assert.equal(studentList.items.every((b) => b.userId === studentA.user.id), true, '学生列表不应包含他人预约');

  const adminList = bookingService.list(db.get('SELECT * FROM users WHERE role = ?', ['admin']), { pageSize: 100 });
  const owners = new Set(adminList.items.map((b) => b.userId));
  assert.ok(owners.size > 1, '管理员应能看到多个用户的预约');
});

test('导出：CSV 含表头与 UTF-8 BOM，并遵循可见范围', async () => {
  const csv = bookingService.exportCsv(db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]), { pageSize: 10 });
  assert.ok(csv.startsWith('\uFEFF'), 'CSV 应带 BOM 以便 Excel 正确识别中文');
  assert.match(csv.split('\r\n')[0], /预约编号/);
  assert.ok(csv.split('\r\n').length > 1, '应包含数据行');
});

test('后台作业：开始前提醒只发送一次', async () => {
  const user = db.get('SELECT * FROM users WHERE id = ?', [studentA.user.id]);
  const reminderWindow = config.num('reminder_minutes');
  const now = Date.now();
  const startAt = now + Math.max(5, Math.floor(reminderWindow / 2)) * MINUTE;
  const id = insertBooking({
    deviceId: device.id,
    userId: user.id,
    startAt,
    endAt: startAt + 30 * MINUTE,
    status: 'approved',
    checkinCode: '141414',
  });
  db.run('UPDATE bookings SET reminder_sent = 0 WHERE id = ?', [id]);
  const first = bookingService.processReminders(Date.now());
  assert.ok(first >= 1, '应至少发送一条提醒');
  const second = bookingService.processReminders(Date.now());
  assert.equal(second, 0, '提醒不应重复发送');
  assert.equal(db.get('SELECT reminder_sent FROM bookings WHERE id = ?', [id]).reminder_sent, 1);
});

test('审计与后台作业状态接口可用', async () => {
  const res = await request(server.base, 'GET', '/api/admin/audit?pageSize=5', { token: admin.token });
  assert.equal(res.status, 200);
  assert.ok(res.data.items.length > 0);
  const jobs = await request(server.base, 'POST', '/api/admin/jobs/run', { token: admin.token });
  assert.equal(jobs.status, 200);
  assert.ok(typeof jobs.data.result.noShow === 'number');
});
