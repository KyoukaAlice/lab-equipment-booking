'use strict';

/**
 * 冲突检测规则引擎单元测试：逐条覆盖 R01 ~ R12
 * 规则清单见 src/core/conflict-rules.js 顶部注释。
 */

const { test, assert } = require('./runner');

const { db, config } = require('./helpers');
const conflictRules = require('../src/core/conflict-rules');
const interval = require('../src/core/interval');
const { MINUTE, HOUR, DAY, startOfDay, addDays } = require('../src/utils/time');

/** 为参与校验的用户放开周额度，避免演示数据的历史预约干扰 R12 之外的用例 */
function relaxQuota(users) {
  for (const u of users) {
    db.run('UPDATE users SET weekly_quota_min = 10080 WHERE id = ?', [u.id]);
    u.weekly_quota_min = 10080;
  }
}

/** 测试上下文：取一台可预约设备、其所属实验室与三名活跃学生 */
function ctx() {
  const device = db.get("SELECT * FROM devices WHERE status = 'available' ORDER BY id LIMIT 1");
  const lab = db.get('SELECT * FROM labs WHERE id = ?', [device.lab_id]);
  const students = db.all("SELECT * FROM users WHERE role = 'student' AND status = 'active' ORDER BY id LIMIT 3");
  relaxQuota(students);
  return { device, lab, students };
}

/**
 * 找一个可用的未来时间窗：在排班内、无占用、时长足够。
 * 从 dayOffset 起逐日向后尝试（设备可能有设备级例外排班，某些星期不开放）。
 */
function freeWindow(device, dayOffset = 3, minutes = 60) {
  const tz = config.num('timezone_offset_minutes');
  const today = startOfDay(Date.now(), tz);
  for (let d = dayOffset; d < dayOffset + 10; d += 1) {
    const dayStart = addDays(today, d);
    const schedule = conflictRules.scheduleForRange(device, dayStart, dayStart + DAY, tz);
    if (!schedule.length) continue;
    const busy = conflictRules.collectBusyIntervals(device.id, device.lab_id, dayStart, dayStart + DAY);
    const blockers = [
      ...busy.bookings.map((b) => ({ start: b.start_at, end: b.end_at })),
      ...busy.blackouts.map((b) => ({ start: b.start_at, end: b.end_at })),
    ];
    const free = interval.subtract(schedule, blockers).filter((f) => f.end - f.start >= minutes * MINUTE);
    if (free.length) {
      return { start: free[0].start, end: free[0].start + minutes * MINUTE, schedule, dayStart };
    }
  }
  throw new Error(`未能在设备「${device.name}」(id=${device.id}) 的未来 10 天内找到长度 ≥ ${minutes} 分钟的空闲时段`);
}

/** 构造一个「未来但任意」的时间窗（仅用于校验顺序排在排班检查之前的规则） */
function anyFutureWindow(minutes = 60) {
  const now = Date.now();
  const start = now + 2 * DAY;
  return { start, end: start + minutes * MINUTE };
}

test('R01：设备状态不可预约时被拒绝', () => {
  const { students } = ctx();
  const broken = db.get("SELECT * FROM devices WHERE status = 'maintenance' LIMIT 1");
  assert.ok(broken, '测试前提：演示数据中应有维护中的设备');
  const w = anyFutureWindow();
  const r = conflictRules.validateBookingRequest({
    device: broken,
    lab: db.get('SELECT * FROM labs WHERE id = ?', [broken.lab_id]),
    user: students[0],
    startAt: w.start,
    endAt: w.end,
  });
  assert.equal(r.ok, false);
  assert.equal(r.rule, 'R01');
  assert.match(r.message, /maintenance/);
});

test('R02：所属实验室停用时被拒绝', () => {
  const { device, students } = ctx();
  const w = freeWindow(device);
  const r = conflictRules.validateBookingRequest({
    device,
    lab: { ...db.get('SELECT * FROM labs WHERE id = ?', [device.lab_id]), status: 'suspended' },
    user: students[0],
    startAt: w.start,
    endAt: w.end,
  });
  assert.equal(r.ok, false);
  assert.equal(r.rule, 'R02');
});

test('R03：起止时间非法被拒绝', () => {
  const { device, lab, students } = ctx();
  const w = freeWindow(device);
  const reversed = conflictRules.validateBookingRequest({
    device,
    lab,
    user: students[0],
    startAt: w.start,
    endAt: w.start - HOUR,
  });
  assert.equal(reversed.rule, 'R03');
  const same = conflictRules.validateBookingRequest({
    device,
    lab,
    user: students[0],
    startAt: w.start,
    endAt: w.start,
  });
  assert.equal(same.rule, 'R03');
});

test('R04：预约过去的时间段被拒绝', () => {
  const { device, lab, students } = ctx();
  const now = Date.now();
  const r = conflictRules.validateBookingRequest({
    device,
    lab,
    user: students[0],
    startAt: now - 2 * HOUR,
    endAt: now - HOUR,
    now,
  });
  assert.equal(r.rule, 'R04');
  assert.match(r.message, /已经过去/);
});

test('R05：不满足最小提前分钟数被拒绝', () => {
  const { device, lab, students } = ctx();
  const lead = config.num('booking_min_lead_minutes');
  assert.ok(lead > 0, '测试前提：默认配置要求最小提前量');
  const now = Date.now();
  const start = now + Math.max(1, lead - 5) * MINUTE;
  const r = conflictRules.validateBookingRequest({
    device,
    lab,
    user: students[0],
    startAt: start,
    endAt: start + HOUR,
    now,
  });
  assert.equal(r.rule, 'R05', `应触发 R05（最小提前 ${lead} 分钟）`);
});

test('R06：超过最大提前天数被拒绝', () => {
  const { device, lab, students } = ctx();
  const advance = config.num('booking_advance_days');
  const now = Date.now();
  const start = now + (advance + 2) * DAY;
  const r = conflictRules.validateBookingRequest({
    device,
    lab,
    user: students[0],
    startAt: start,
    endAt: start + HOUR,
    now,
  });
  assert.equal(r.rule, 'R06');
  assert.match(r.message, new RegExp(String(advance)));
});

test('R07：时长超出设备允许区间被拒绝（过短与过长）', () => {
  const { device, lab, students } = ctx();
  const w = freeWindow(device, 3, 240);
  const tooShort = conflictRules.validateBookingRequest({
    device,
    lab,
    user: students[0],
    startAt: w.start,
    endAt: w.start + Math.max(5, Number(device.min_minutes) - 10) * MINUTE,
  });
  assert.equal(tooShort.rule, 'R07', '时长过短应触发 R07');
  assert.match(tooShort.message, /不得短于/);

  const tooLong = conflictRules.validateBookingRequest({
    device,
    lab,
    user: students[0],
    startAt: w.start,
    endAt: w.start + (Number(device.max_minutes) + 60) * MINUTE,
  });
  assert.equal(tooLong.rule, 'R07', '时长过长应触发 R07');
  assert.match(tooLong.message, /不得超过/);
});

test('R08：不在开放排班内被拒绝（跨越结束边界 / 排班开始前 / 凌晨时段）', () => {
  const { device, lab, students } = ctx();
  const tz = config.num('timezone_offset_minutes');
  const w = freeWindow(device, 3);
  const dayStart = startOfDay(w.start, tz);
  const schedule = conflictRules.scheduleForRange(device, dayStart, dayStart + DAY, tz);
  const last = schedule[schedule.length - 1];

  const crossBoundary = conflictRules.validateBookingRequest({
    device,
    lab,
    user: students[0],
    startAt: last.end - 20 * MINUTE,
    endAt: last.end + 40 * MINUTE,
  });
  assert.equal(crossBoundary.rule, 'R08', '越过排班结束边界应触发 R08');

  const beforeOpen = conflictRules.validateBookingRequest({
    device,
    lab,
    user: students[0],
    startAt: schedule[0].start - 2 * HOUR,
    endAt: schedule[0].start - HOUR,
  });
  assert.equal(beforeOpen.rule, 'R08', '排班开始前的时段应触发 R08');

  const night = dayStart + 3 * HOUR;
  const nightResult = conflictRules.validateBookingRequest({
    device,
    lab,
    user: students[0],
    startAt: night,
    endAt: night + HOUR,
  });
  assert.equal(nightResult.rule, 'R08', '凌晨时段应触发 R08');
  assert.match(nightResult.message, /开放时间/);
});

test('R09：落在停机计划内被拒绝，并返回停机原因与类型', () => {
  const { device, lab, students } = ctx();
  const w = freeWindow(device, 3);
  const blackoutId = Number(
    db.run(
      `INSERT INTO blackouts (lab_id, device_id, start_at, end_at, reason, kind, created_by, created_at)
       VALUES (?, ?, ?, ?, '测试用停机：设备校准', 'calibration', NULL, ?)`,
      [device.lab_id, device.id, w.start, w.end, Date.now()],
    ).lastInsertRowid,
  );
  try {
    const r = conflictRules.validateBookingRequest({
      device,
      lab,
      user: students[0],
      startAt: w.start,
      endAt: w.end,
    });
    assert.equal(r.ok, false);
    assert.equal(r.rule, 'R09');
    assert.match(r.message, /设备校准/);
    assert.equal(r.detail.blackout.id, blackoutId);
    assert.equal(r.detail.blackout.kind, 'calibration');
  } finally {
    db.run('DELETE FROM blackouts WHERE id = ?', [blackoutId]);
  }
});

test('R10：设备时段被占用时返回冲突明细（含占用者，便于协调）', () => {
  const { device, lab, students } = ctx();
  const w = freeWindow(device, 3);
  const other = students[1];
  const bookingId = Number(
    db.run(
      `INSERT INTO bookings (code, device_id, lab_id, user_id, start_at, end_at, purpose, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '他人已占用的用途', 'approved', ?, ?)`,
      [`TST${Date.now()}`, device.id, device.lab_id, other.id, w.start, w.end, Date.now(), Date.now()],
    ).lastInsertRowid,
  );
  try {
    const r = conflictRules.validateBookingRequest({
      device,
      lab,
      user: students[0],
      startAt: w.start,
      endAt: w.end,
    });
    assert.equal(r.ok, false);
    assert.equal(r.rule, 'R10');
    assert.equal(r.detail.conflict.bookingId, bookingId);
    assert.equal(r.detail.conflict.occupant, other.name);
    assert.match(r.message, /已被占用/);
  } finally {
    db.run('DELETE FROM bookings WHERE id = ?', [bookingId]);
  }
});

test('R10：相邻时段可以衔接预约（[T,T+1h) 与 [T+1h,T+2h) 不冲突）', () => {
  const { device, lab, students } = ctx();
  const w = freeWindow(device, 3, 120);
  const first = Number(
    db.run(
      `INSERT INTO bookings (code, device_id, lab_id, user_id, start_at, end_at, purpose, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '前一小时', 'approved', ?, ?)`,
      [
        `TST${Date.now()}A`,
        device.id,
        device.lab_id,
        students[0].id,
        w.start,
        w.start + HOUR,
        Date.now(),
        Date.now(),
      ],
    ).lastInsertRowid,
  );
  try {
    const r = conflictRules.validateBookingRequest({
      device,
      lab,
      user: students[1],
      startAt: w.start + HOUR,
      endAt: w.start + 2 * HOUR,
    });
    assert.equal(r.ok, true, `相邻衔接应允许：${r.message || ''}`);
  } finally {
    db.run('DELETE FROM bookings WHERE id = ?', [first]);
  }
});

test('R11：与本人其它预约时间冲突被拒绝，并指出冲突设备', () => {
  const { device, lab, students } = ctx();
  const w = freeWindow(device, 3);
  const user = students[0];
  const otherDevice = db.get("SELECT * FROM devices WHERE status = 'available' AND id <> ? LIMIT 1", [device.id]);
  const bookingId = Number(
    db.run(
      `INSERT INTO bookings (code, device_id, lab_id, user_id, start_at, end_at, purpose, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '本人在另一台设备上的预约', 'approved', ?, ?)`,
      [`TST${Date.now()}S`, otherDevice.id, otherDevice.lab_id, user.id, w.start, w.end, Date.now(), Date.now()],
    ).lastInsertRowid,
  );
  try {
    const r = conflictRules.validateBookingRequest({ device, lab, user, startAt: w.start, endAt: w.end });
    assert.equal(r.ok, false);
    assert.equal(r.rule, 'R11');
    assert.equal(r.detail.conflict.bookingId, bookingId);
    assert.equal(r.detail.conflict.deviceName, otherDevice.name);
  } finally {
    db.run('DELETE FROM bookings WHERE id = ?', [bookingId]);
  }
});

test('R12：冻结用户无法预约，并提示暂停原因与解除时间', () => {
  const { device, lab } = ctx();
  const w = freeWindow(device, 3);
  const frozen = db.get("SELECT * FROM users WHERE status = 'frozen' LIMIT 1");
  assert.ok(frozen, '测试前提：演示数据应包含一名信用受限被冻结的学生');
  const r = conflictRules.validateBookingRequest({
    device,
    lab,
    user: frozen,
    startAt: w.start,
    endAt: w.end,
  });
  assert.equal(r.ok, false);
  assert.equal(r.rule, 'R12');
  assert.match(r.message, /预约权限已被暂停/);
});

test('R12：超过同时在途预约上限被拒绝', () => {
  const { device, lab, students } = ctx();
  const w = freeWindow(device, 3);
  const user = students[0];
  const tz = config.num('timezone_offset_minutes');
  const max = config.num('max_active_bookings_per_user');
  const created = [];
  const base = startOfDay(Date.now(), tz) + 6 * DAY;
  try {
    for (let i = 0; i < max; i += 1) {
      created.push(
        db.run(
          `INSERT INTO bookings (code, device_id, lab_id, user_id, start_at, end_at, purpose, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '占满在途名额', 'approved', ?, ?)`,
          [
            `TST${Date.now()}M${i}`,
            device.id,
            device.lab_id,
            user.id,
            base + i * 3 * HOUR,
            base + i * 3 * HOUR + HOUR,
            Date.now(),
            Date.now(),
          ],
        ).lastInsertRowid,
      );
    }
    const fresh = db.get('SELECT * FROM users WHERE id = ?', [user.id]);
    const r = conflictRules.validateBookingRequest({
      device,
      lab,
      user: fresh,
      startAt: w.start,
      endAt: w.end,
    });
    assert.equal(r.ok, false);
    assert.equal(r.rule, 'R12');
    assert.match(r.message, /上限/);
  } finally {
    for (const id of created) db.run('DELETE FROM bookings WHERE id = ?', [id]);
  }
});

test('R12：本周额度不足被拒绝', () => {
  const { device, lab, students } = ctx();
  const user = students[2];
  const originalQuota = user.weekly_quota_min;
  let attempts = 0;
  try {
    // 把该用户周额度压到 0：此时任何时长的预约都必然超额度。
    // 逐个候选时段尝试，确保命中的是 R12 而不是被其它用例占用的 R10。
    db.run('UPDATE users SET weekly_quota_min = 0 WHERE id = ?', [user.id]);
    const fresh = db.get('SELECT * FROM users WHERE id = ?', [user.id]);

    let hit = null;
    for (let offset = 5; offset < 15 && !hit; offset += 1) {
      let base = null;
      try {
        base = freeWindow(device, offset, 60);
      } catch {
        continue;
      }
      const probe = conflictRules.validateBookingRequest({
        device,
        lab,
        user: fresh,
        startAt: base.start,
        endAt: base.end,
      });
      attempts += 1;
      if (!probe.ok) hit = probe;
    }
    assert.ok(hit, `未能构造出可验证额度规则的场景（尝试了 ${attempts} 个候选时段）`);
    assert.equal(hit.rule, 'R12', `应命中额度规则，实际命中 ${hit.rule}：${hit.message}`);
    assert.match(hit.message, /额度不足/);
    assert.equal(hit.detail.usedMinutes + hit.detail.requestedMinutes > hit.detail.quotaMinutes, true);
  } finally {
    db.run('UPDATE users SET weekly_quota_min = ? WHERE id = ?', [originalQuota, user.id]);
  }
});

test('合法请求通过全部规则校验', () => {
  const { device, lab, students } = ctx();
  const w = freeWindow(device, 4);
  const r = conflictRules.validateBookingRequest({
    device,
    lab,
    user: students[0],
    startAt: w.start,
    endAt: w.end,
  });
  assert.equal(r.ok, true, r.message || '');
});

test('scheduleForRange：设备级排班优先于实验室级排班', () => {
  const tz = config.num('timezone_offset_minutes');
  const withOwnSlot = db.get('SELECT DISTINCT device_id FROM weekly_slots WHERE device_id IS NOT NULL LIMIT 1');
  assert.ok(withOwnSlot, '测试前提：演示数据应包含设备级排班');
  const device = db.get('SELECT * FROM devices WHERE id = ?', [withOwnSlot.device_id]);
  const ownRows = db.all('SELECT * FROM weekly_slots WHERE device_id = ? AND enabled = 1', [device.id]);
  const labRows = db.all('SELECT * FROM weekly_slots WHERE lab_id = ? AND device_id IS NULL AND enabled = 1', [
    device.lab_id,
  ]);
  assert.ok(ownRows.length > 0 && labRows.length > 0, '测试前提：该设备同时存在设备级与实验室级排班');

  const dayStart = addDays(startOfDay(Date.now(), tz), 3);
  const weekday = new Date(dayStart + tz * MINUTE).getUTCDay();
  const expected = ownRows
    .filter((r) => r.weekday === weekday)
    .map((r) => ({ start: dayStart + r.start_min * MINUTE, end: dayStart + r.end_min * MINUTE }))
    .sort((a, b) => a.start - b.start);
  const actual = conflictRules
    .scheduleForRange(device, dayStart, dayStart + DAY, tz)
    .map((x) => ({ start: x.start, end: x.end }));

  if (!expected.length) {
    assert.equal(actual.length, 0, '该星期设备级排班为空时不应回退到实验室级排班');
  } else {
    assert.deepEqual(actual, expected, '结果必须完全由设备级排班推导');
  }
});
