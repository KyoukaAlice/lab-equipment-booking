'use strict';
/**
 * HTTP 冒烟测试：对正在运行的服务做端到端验证（非单元测试，用于快速验证部署）
 * 用法：node scripts/smoke.js [baseUrl]
 */

const BASE = process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:3000';

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json, data: json && json.ok ? json.data : null };
}

/**
 * 挑一个「本周还有剩余额度、在途预约未达上限」的学生账号执行预约流程。
 * 这样冒烟测试可以反复运行，不会因为演示账号的周额度或在途数量耗尽而误报失败
 * （系统在额度不足时返回 R12 是正确的业务行为，不是缺陷）。
 */
async function pickApplicant(adminToken) {
  const candidates = ['student3', 'student6', 'student7', 'student9', 'student11', 'student2', 'student4', 'student8', 'student10'];
  for (const username of candidates) {
    const login = await call('POST', '/api/auth/login', { body: { username, password: '123456' } });
    if (login.status !== 200) continue;
    const token = login.data.token;
    const me = login.data.user;
    if (me.activeBookings >= me.activeBookingLimit) continue;
    // 周额度必须真的还有余量，否则提交时会被 R12 正确拒绝
    const quota = await call('GET', '/api/me/quota', { token });
    if (quota.status !== 200) continue;
    const { remainingMinutes, quotaMinutes } = quota.data;
    if (!quotaMinutes || remainingMinutes < 120) continue;
    const active = await call('GET', '/api/bookings?scope=active&pageSize=100', { token });
    const intervals = (active.data ? active.data.items : []).map((b) => ({ start: b.startAt, end: b.endAt }));
    return { username, token, me, intervals, remainingMinutes };
  }
  // 兜底：由管理员创建一个全新的测试学生账号（周额度充足、无历史占用）
  const suffix = String(Date.now()).slice(-6);
  const created = await call('POST', '/api/admin/users', {
    token: adminToken,
    body: {
      username: `smoke${suffix}`,
      name: `冒烟测试学生${suffix}`,
      role: 'student',
      password: '123456',
      department: '软件工程学院',
      weeklyQuotaMin: 1440,
    },
  });
  if (created.status !== 201) return null;
  const login = await call('POST', '/api/auth/login', { body: { username: `smoke${suffix}`, password: '123456' } });
  return {
    username: `smoke${suffix}`,
    token: login.data.token,
    me: login.data.user,
    intervals: [],
    remainingMinutes: 1440,
  };
}

/**
 * 找出当前处于签到窗口内的「已通过」预约（用于验证签到/签退闭环）。
 * 签到窗口 = [开始前 checkin_open_before_minutes, 开始后 checkin_grace_minutes]
 */
async function findOpenCheckinWindow(adminToken) {
  const res = await call('GET', '/api/bookings?status=approved&pageSize=200', { token: adminToken });
  if (res.status !== 200) return null;
  const now = Date.now();
  const cfg = await call('GET', '/api/auth/me', { token: adminToken });
  const open = (cfg.data && cfg.data.config.checkinOpenBeforeMinutes) || 30;
  const grace = (cfg.data && cfg.data.config.checkinGraceMinutes) || 15;
  const candidates = res.data.items.filter(
    (b) => now >= b.startAt - open * 60000 && now <= b.startAt + grace * 60000 && b.checkinCode && b.userUsername,
  );
  if (!candidates.length) return null;
  const target = candidates[0];
  return {
    id: target.id,
    code: target.code,
    username: target.userUsername,
    userName: target.userName,
    checkinCode: target.checkinCode,
  };
}

(async () => {
  console.log(`\n=== 冒烟测试目标：${BASE} ===\n`);

  console.log('[1] 公共信息与登录');
  const info = await call('GET', '/api/public/info');
  check('GET /api/public/info 返回站点信息', info.status === 200 && info.data.siteName);
  const badLogin = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong-password' } });
  check('错误口令被拒绝（401）', badLogin.status === 401);

  const adminLogin = await call('POST', '/api/auth/login', { body: { username: 'admin', password: '123456' } });
  check('管理员登录成功并返回 token', adminLogin.status === 200 && adminLogin.data.token);
  const adminToken = adminLogin.data.token;

  const studentLogin = await call('POST', '/api/auth/login', { body: { username: 'student3', password: '123456' } });
  check('学生登录成功', studentLogin.status === 200 && studentLogin.data.token);
  let studentToken = studentLogin.data.token;

  const teacherLogin = await call('POST', '/api/auth/login', { body: { username: 'teacher', password: '123456' } });
  check('教师登录成功', teacherLogin.status === 200 && teacherLogin.data.token);
  const teacherToken = teacherLogin.data.token;

  console.log('\n[2] 鉴权与权限边界');
  const noAuth = await call('GET', '/api/bookings');
  check('未登录访问受保护接口返回 401', noAuth.status === 401);
  const studentAdmin = await call('GET', '/api/admin/users', { token: studentToken });
  check('学生访问管理接口返回 403', studentAdmin.status === 403);
  const studentStats = await call('GET', '/api/stats/utilization', { token: studentToken });
  check('学生访问统计接口返回 403', studentStats.status === 403);
  const teacherAdmin = await call('GET', '/api/admin/config', { token: teacherToken });
  check('教师访问系统配置返回 403', teacherAdmin.status === 403);

  console.log('\n[3] 设备目录与可用时段');
  const devices = await call('GET', '/api/devices?pageSize=20&bookable=true', { token: studentToken });
  check('设备列表返回数据', devices.status === 200 && devices.data.items.length > 0);
  const device = devices.data.items.find((d) => d.bookable) || devices.data.items[0];
  const availability = await call('GET', `/api/devices/${device.id}/availability?days=14`, { token: studentToken });
  check('可用时段接口返回 14 天视图', availability.status === 200 && availability.data.days.length === 14);

  /**
   * 选择一个「申请人自身在途未满额、且与自己其它预约不冲突」的未来空闲时段，
   * 使冒烟测试可重复执行而不受演示数据影响（对应规则 R11 / R12）。
   */
  const applicant = await pickApplicant(adminToken);
  check(
    '选出可用的测试申请人账号（有剩余周额度）',
    Boolean(applicant),
    applicant ? `${applicant.username}，本周剩余 ${applicant.remainingMinutes} 分钟` : '所有演示学生额度/在途已满',
  );
  const conflictsSelf = (start, end) =>
    applicant && applicant.intervals.some((iv) => iv.start < end && start < iv.end);
  let slot = null;
  for (const day of availability.data.days) {
    for (const free of day.free) {
      if (!free.selectable || free.minutes < 60) continue;
      const start = free.start;
      const end = Math.min(free.end, start + 60 * 60000);
      if (!conflictsSelf(start, end)) {
        slot = { day, free, start, end };
        break;
      }
    }
    if (slot) break;
  }
  check('找到申请人可用的空闲时段（避开自身冲突）', Boolean(slot));
  studentToken = applicant ? applicant.token : studentToken;

  console.log('\n[4] 预约全流程：提交 → 冲突拒绝 → 审批 → 签到 → 签退');
  let booking = null;
  if (slot) {
    const start = slot.start;
    const end = slot.end;
    const created = await call('POST', '/api/bookings', {
      token: studentToken,
      body: {
        deviceId: device.id,
        startAt: start,
        endAt: end,
        purpose: '冒烟测试：验证预约流程是否可用',
        participants: 2,
      },
    });
    check('提交预约成功', created.status === 201, JSON.stringify(created.body).slice(0, 200));
    booking = created.data ? created.data.booking : null;
    check('预约状态为待审批或已通过', booking && ['pending', 'approved'].includes(booking.status));

    const conflict = await call('POST', '/api/bookings', {
      token: studentToken,
      body: { deviceId: device.id, startAt: start, endAt: end, purpose: '冒烟测试：重复占用同一时段' },
    });
    check('同一时段重复预约被拒绝（409）', conflict.status === 409 && (conflict.body.code === 'R10' || conflict.body.code === 'R11'), `code=${conflict.body.code}`);

    const past = await call('POST', '/api/bookings', {
      token: studentToken,
      body: { deviceId: device.id, startAt: Date.now() - 3600000, endAt: Date.now() - 1800000, purpose: '冒烟测试：预约过去时段' },
    });
    check('预约过去时段被拒绝（R04）', past.status === 409 && past.body.code === 'R04', `code=${past.body.code}`);

    const shortDuration = await call('POST', '/api/bookings', {
      token: studentToken,
      body: { deviceId: device.id, startAt: start, endAt: start + 5 * 60000, purpose: '冒烟测试：时长过短应被拒绝' },
    });
    check('时长不足被拒绝（R07）', shortDuration.status === 409 && shortDuration.body.code === 'R07', `code=${shortDuration.body.code}`);
  }

  if (booking) {
    const detail = await call('GET', `/api/bookings/${booking.id}`, { token: studentToken });
    check('预约详情可查询且含生命周期时间线', detail.status === 200 && detail.data.booking.timeline.length >= 1);

    if (booking.status === 'pending') {
      const approve = await call('POST', `/api/bookings/${booking.id}/approve`, { token: teacherToken, body: { note: '冒烟测试审批通过' } });
      check('教师审批通过成功', approve.status === 200 && approve.data.booking.status === 'approved', JSON.stringify(approve.body).slice(0, 200));
      const code = approve.data ? approve.data.booking.checkinCode : '';
      check('审批后生成 6 位签到码（审批人可见）', /^\d{6}$/.test(code));

      const wrongCode = await call('POST', `/api/bookings/${booking.id}/checkin`, { token: studentToken, body: { code: '000000' } });
      check('错误签到码被拒绝', wrongCode.status === 400 && wrongCode.body.code === 'BAD_CHECKIN_CODE');

      const tooEarly = await call('POST', `/api/bookings/${booking.id}/checkin`, { token: studentToken, body: { code } });
      check('未到签到时间窗口被拒绝', tooEarly.status === 409 && tooEarly.body.code === 'CHECKIN_TOO_EARLY', `code=${tooEarly.body.code}`);

      const cancel = await call('POST', `/api/bookings/${booking.id}/cancel`, { token: studentToken, body: { reason: '冒烟测试结束后清理数据' } });
      check('取消预约成功', cancel.status === 200 && cancel.data.booking.status === 'cancelled');
    }
  }

  console.log('\n[4b] 签到 → 签退闭环（需存在当前处于签到窗口内的预约）');
  const openCheckin = await findOpenCheckinWindow(adminToken);
  if (!openCheckin) {
    console.log('  ⚠️  当前时刻附近没有处于签到窗口（开始前 30 分钟 ~ 开始后 15 分钟）的已通过预约，');
    console.log('      该闭环由自动化测试 test/booking-flow.test.js 通过注入时间的方式完整覆盖。');
  } else {
    const ownerToken = (await call('POST', '/api/auth/login', { body: { username: openCheckin.username, password: '123456' } })).data.token;
    const ok = await call('POST', `/api/bookings/${openCheckin.id}/checkin`, { token: ownerToken, body: { code: openCheckin.checkinCode } });
    check('使用正确签到码完成现场签到', ok.status === 200 && ok.data.booking.status === 'checked_in', JSON.stringify(ok.body).slice(0, 200));
    if (ok.status === 200) {
      const out = await call('POST', `/api/bookings/${openCheckin.id}/checkout`, { token: ownerToken, body: {} });
      check('签退成功并记录实际使用时长', out.status === 200 && out.data.booking.status === 'completed' && out.data.booking.actualMinutes > 0);
    }
  }

  console.log('\n[5] 候补队列');
  const waitlist = await call('GET', '/api/waitlist?scope=mine', { token: studentToken });
  check('候补列表可查询', waitlist.status === 200 && Array.isArray(waitlist.data.items));
  const occupied = await call('GET', `/api/devices/${device.id}/availability?days=14`, { token: studentToken });
  let wlTarget = null;
  for (const day of occupied.data.days) {
    for (const occ of day.occupancy) {
      if (occ.kind === 'booking' && occ.start > Date.now() + 3600000) {
        wlTarget = occ;
        break;
      }
    }
    if (wlTarget) break;
  }
  if (wlTarget) {
    const joined = await call('POST', '/api/waitlist', {
      token: studentToken,
      body: { deviceId: device.id, startAt: wlTarget.start, endAt: wlTarget.end, purpose: '冒烟测试：希望有人取消后补位' },
    });
    const alreadyQueued = joined.status === 409 && /已在候补/.test(joined.body.message || '');
    check(
      '加入候补成功（重复排队被正确拦截也算通过）',
      joined.status === 201 || alreadyQueued,
      JSON.stringify(joined.body).slice(0, 200),
    );
  } else {
    check('找到可用于候补的已占用时段', false, '（跳过候补测试）');
  }

  console.log('\n[6] 统计与报表');
  const overview = await call('GET', '/api/stats/overview', { token: adminToken });
  check('概览统计可用', overview.status === 200 && overview.data.devices.total > 0);
  const dashboard = await call('GET', '/api/stats/dashboard', { token: adminToken });
  check('仪表盘返回利用率、热力图、趋势', dashboard.status === 200 && dashboard.data.utilization.length > 0 && dashboard.data.heatmap.grid.length === 7);
  const util = await call('GET', '/api/stats/utilization?limit=5', { token: adminToken });
  check('利用率排行可用', util.status === 200 && util.data.items.length > 0);
  const csv = await fetch(`${BASE}/api/stats/export/utilization`, { headers: { Authorization: `Bearer ${adminToken}` } });
  const csvBuf = Buffer.from(await csv.arrayBuffer());
  const hasBom = csvBuf.length > 3 && csvBuf[0] === 0xef && csvBuf[1] === 0xbb && csvBuf[2] === 0xbf;
  check('利用率 CSV 导出可用（含 UTF-8 BOM，Excel 可直接打开）', csv.status === 200 && hasBom, `status=${csv.status} bytes=${csvBuf.length}`);

  console.log('\n[7] 管理端 CRUD 与后台作业');
  const createLab = await call('POST', '/api/admin/labs', {
    token: adminToken,
    body: { name: `冒烟测试实验室 ${Date.now()}`, code: `SMOKE-${Date.now().toString().slice(-6)}`, building: '测试楼', room: '101', capacity: 10 },
  });
  check('创建实验室成功', createLab.status === 201);
  const labId = createLab.data ? createLab.data.lab.id : null;

  const createDevice = await call('POST', '/api/admin/devices', {
    token: adminToken,
    body: { labId, name: '冒烟测试设备', category: '测量仪器', minMinutes: 30, maxMinutes: 120 },
  });
  check('创建设备成功', createDevice.status === 201, JSON.stringify(createDevice.body).slice(0, 200));
  const deviceId = createDevice.data ? createDevice.data.device.id : null;

  const createSlot = await call('POST', '/api/admin/slots', {
    token: adminToken,
    body: { labId, weekday: 1, start: '08:00', end: '12:00' },
  });
  check('创建排班成功', createSlot.status === 201, JSON.stringify(createSlot.body).slice(0, 200));

  const createBlackout = await call('POST', '/api/admin/blackouts', {
    token: adminToken,
    body: { labId, deviceId, kind: 'maintenance', startAt: '2030-01-01 08:00', endAt: '2030-01-01 12:00', reason: '冒烟测试停机' },
  });
  check('创建停机计划成功', createBlackout.status === 201);

  const configRes = await call('GET', '/api/admin/config', { token: adminToken });
  check('读取系统配置成功', configRes.status === 200 && configRes.data.items.length > 10);
  const patchConfig = await call('PATCH', '/api/admin/config', { token: adminToken, body: { checkin_grace_minutes: 15 } });
  check('修改配置成功', patchConfig.status === 200);

  const jobs = await call('POST', '/api/admin/jobs/run', { token: adminToken });
  check('手动执行后台作业成功', jobs.status === 200 && jobs.data.result && typeof jobs.data.result.noShow === 'number');

  const system = await call('GET', '/api/admin/system', { token: adminToken });
  check('系统状态接口返回数据规模', system.status === 200 && system.data.counts.bookings > 0 && system.data.db.journalMode === 'wal');
  const audit = await call('GET', '/api/admin/audit?pageSize=5', { token: adminToken });
  check('审计日志可查询', audit.status === 200 && audit.data.items.length > 0);

  // 清理冒烟测试数据
  const delBlackout = await call('DELETE', `/api/admin/blackouts/${createBlackout.data.blackout.id}`, { token: adminToken });
  check('删除停机计划成功', delBlackout.status === 200);
  const delSlot = await call('DELETE', `/api/admin/slots/${createSlot.data.id}`, { token: adminToken });
  check('删除排班成功', delSlot.status === 200);
  const delDevice = await call('DELETE', `/api/admin/devices/${deviceId}`, { token: adminToken });
  check('删除设备成功', delDevice.status === 200);
  const delLab = await call('DELETE', `/api/admin/labs/${labId}`, { token: adminToken });
  check('删除实验室成功', delLab.status === 200);

  console.log('\n[8] 静态资源');
  const html = await fetch(`${BASE}/`);
  const htmlText = await html.text();
  check('首页 HTML 可访问', html.status === 200 && htmlText.includes('实验室设备预约'));
  const js = await fetch(`${BASE}/js/app.js`);
  check('前端 app.js 可访问', js.status === 200);
  const spa = await fetch(`${BASE}/some/spa/route`);
  check('SPA 路由回退到 index.html', spa.status === 200);

  console.log(`\n=== 冒烟测试结果：通过 ${pass} 项，失败 ${fail} 项 ===\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('冒烟测试异常：', err);
  process.exit(1);
});
