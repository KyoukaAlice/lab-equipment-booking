'use strict';

/**
 * 认证与个人中心路由
 */

const db = require('../db');
const config = require('../core/config');
const { hashPassword, verifyPassword } = require('../core/password');
const presenters = require('../services/presenters');
const creditService = require('../services/credit.service');
const audit = require('../services/audit.service');
const notification = require('../services/notification.service');
const {
  ok,
  requireLogin,
  pageQuery,
  bodyStr,
} = require('../http/helpers');
const { badRequest, unauthorized, conflict } = require('../utils/errors');

function register(ctx) {
  /** 登录 */
  ctx.router.post('/api/auth/login', async (req, res) => {
    const username = bodyStr(req, 'username', { required: true, max: 50 });
    const password = String((req.body && req.body.password) || '');
    if (!password) throw badRequest('请输入密码');
    const user = db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      audit.log({
        userId: user ? user.id : null,
        actorName: username,
        action: 'user.login_failed',
        targetType: 'user',
        targetId: user ? user.id : 0,
        detail: '口令错误',
        ip: ctx.clientIp(req),
      });
      throw unauthorized('用户名或密码错误');
    }
    if (user.status === 'disabled') throw unauthorized('账号已被停用，请联系管理员');
    const session = ctx.createSession(user, req);
    db.run('UPDATE users SET updated_at = ? WHERE id = ? AND updated_at = 0', [Date.now(), user.id]);
    audit.log({
      userId: user.id,
      actorName: user.name,
      action: 'user.login',
      targetType: 'user',
      targetId: user.id,
      detail: `角色：${user.role}`,
      ip: ctx.clientIp(req),
    });
    return ok({
      token: session.token,
      expiresAt: session.expiresAt,
      user: presenters.me(user),
      siteName: config.str('site_name'),
      announcement: config.str('announcement'),
    });
  });

  /** 退出登录 */
  ctx.router.post('/api/auth/logout', async (req, res, ctx2) => {
    const user = requireLogin(req);
    ctx2.destroySession(req.token);
    audit.log({
      userId: user.id,
      actorName: user.name,
      action: 'user.logout',
      targetType: 'user',
      targetId: user.id,
      detail: '',
      ip: ctx2.clientIp(req),
    });
    return ok({ message: '已退出登录' });
  });

  /** 当前登录用户 */
  ctx.router.get('/api/auth/me', async (req) => {
    const user = requireLogin(req);
    return ok({
      user: presenters.me(user),
      siteName: config.str('site_name'),
      announcement: config.str('announcement'),
      serverTime: Date.now(),
      config: {
        bookingAdvanceDays: config.num('booking_advance_days'),
        bookingMinLeadMinutes: config.num('booking_min_lead_minutes'),
        cancelDeadlineHours: config.num('cancel_deadline_hours'),
        checkinGraceMinutes: config.num('checkin_grace_minutes'),
        checkinOpenBeforeMinutes: config.num('checkin_open_before_minutes'),
        maxParticipantsPerBooking: config.num('max_participants_per_booking'),
        creditFreezeThreshold: config.num('credit_freeze_threshold'),
      },
    });
  });

  /** 注册（学生自助注册，教师/管理员账号由管理员创建） */
  ctx.router.post('/api/auth/register', async (req) => {
    const username = bodyStr(req, 'username', { required: true, max: 30 });
    if (!/^[A-Za-z][A-Za-z0-9_]{2,29}$/.test(username)) {
      throw badRequest('用户名需以字母开头，可包含字母、数字、下划线，长度 3-30');
    }
    const password = String((req.body && req.body.password) || '');
    if (password.length < 6) throw badRequest('密码长度至少 6 位');
    const name = bodyStr(req, 'name', { required: true, max: 30 });
    const department = bodyStr(req, 'department', { max: 50 });
    const studentNo = bodyStr(req, 'studentNo', { max: 30 });
    const email = bodyStr(req, 'email', { max: 80 });
    const phone = bodyStr(req, 'phone', { max: 20 });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('邮箱格式不正确');

    return db.writeTx(async () => {
      if (db.get('SELECT id FROM users WHERE username = ?', [username])) {
        throw conflict('该用户名已被注册');
      }
      const now = Date.now();
      const res2 = db.run(
        `INSERT INTO users (username, password_hash, name, role, email, phone, department, student_no,
             credit_score, status, weekly_quota_min, created_at, updated_at)
         VALUES (?, ?, ?, 'student', ?, ?, ?, ?, 100, 'active', ?, ?, ?)`,
        [
          username,
          hashPassword(password),
          name,
          email,
          phone,
          department,
          studentNo,
          config.num('max_weekly_minutes_default'),
          now,
          now,
        ],
      );
      const userId = res2.lastInsertRowid;
      notification.notify({
        userId,
        type: 'welcome',
        title: '欢迎使用实验室设备预约系统',
        content: `${name} 同学你好，你的账号已创建成功，初始信用分 100 分。请在「设备目录」中选择设备并提交预约申请。`,
        link: '#/devices',
      });
      audit.log({
        userId,
        actorName: name,
        action: 'user.register',
        targetType: 'user',
        targetId: userId,
        detail: { username, department, studentNo },
        ip: ctx.clientIp(req),
      });
      const user = db.get('SELECT * FROM users WHERE id = ?', [userId]);
      const session = ctx.createSession(user, req);
      return ok({ token: session.token, user: presenters.me(user) }, 201);
    });
  });

  /** 个人资料 */
  ctx.router.get('/api/me', async (req) => {
    const user = requireLogin(req);
    return ok({ user: presenters.me(user) });
  });

  /** 修改资料 */
  ctx.router.patch('/api/me', async (req) => {
    const user = requireLogin(req);
    const name = bodyStr(req, 'name', { def: user.name, max: 30, required: true });
    const department = bodyStr(req, 'department', { def: user.department, max: 50 });
    const email = bodyStr(req, 'email', { def: user.email, max: 80 });
    const phone = bodyStr(req, 'phone', { def: user.phone, max: 20 });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('邮箱格式不正确');
    db.run('UPDATE users SET name = ?, department = ?, email = ?, phone = ?, updated_at = ? WHERE id = ?', [
      name,
      department,
      email,
      phone,
      Date.now(),
      user.id,
    ]);
    audit.log({
      userId: user.id,
      actorName: user.name,
      action: 'user.update_profile',
      targetType: 'user',
      targetId: user.id,
      detail: { name, department, email, phone },
      ip: ctx.clientIp(req),
    });
    return ok({ user: presenters.me(db.get('SELECT * FROM users WHERE id = ?', [user.id])) });
  });

  /** 修改密码 */
  ctx.router.post('/api/me/password', async (req) => {
    const user = requireLogin(req);
    const oldPassword = String((req.body && req.body.oldPassword) || '');
    const newPassword = String((req.body && req.body.newPassword) || '');
    if (!verifyPassword(oldPassword, user.password_hash)) throw badRequest('原密码不正确');
    if (newPassword.length < 6) throw badRequest('新密码长度至少 6 位');
    if (newPassword === oldPassword) throw badRequest('新密码不能与原密码相同');
    db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      hashPassword(newPassword),
      Date.now(),
      user.id,
    ]);
    // 安全策略：改密后注销其它会话
    db.run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', [user.id, req.token]);
    audit.log({
      userId: user.id,
      actorName: user.name,
      action: 'user.change_password',
      targetType: 'user',
      targetId: user.id,
      detail: '修改登录密码，其它会话已失效',
      ip: ctx.clientIp(req),
    });
    return ok({ message: '密码修改成功，其它设备上的登录已失效' });
  });

  /** 我的信用台账 */
  ctx.router.get('/api/me/credit', async (req) => {
    const user = requireLogin(req);
    const { page: p, pageSize } = pageQuery(req, 20);
    const ledger = creditService.ledger(user.id, { page: p, pageSize });
    return ok({
      summary: creditService.summary(user.id),
      items: ledger.items.map(presenters.creditRecord),
      total: ledger.total,
      page: ledger.page,
      pageSize: ledger.pageSize,
    });
  });

  /** 我的违约记录 */
  ctx.router.get('/api/me/violations', async (req) => {
    const user = requireLogin(req);
    const { page: p, pageSize } = pageQuery(req, 20);
    const result = creditService.violations(user.id, { page: p, pageSize });
    return ok({
      items: result.items.map(presenters.violation),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      summary: creditService.summary(user.id),
    });
  });

  /** 系统公开信息（登录页使用，无需鉴权） */
  ctx.router.get('/api/public/info', async () => {
    const labs = db.all("SELECT COUNT(*) AS c FROM labs WHERE status = 'active'");
    const devices = db.all("SELECT COUNT(*) AS c FROM devices WHERE status = 'available'");
    const bookings = db.all('SELECT COUNT(*) AS c FROM bookings');
    return ok({
      siteName: config.str('site_name'),
      announcement: config.str('announcement'),
      stats: {
        labs: Number(labs[0].c),
        devices: Number(devices[0].c),
        bookings: Number(bookings[0].c),
      },
      demoAccounts: [
        { username: 'admin', role: '管理员', description: '系统全部权限，可管理实验室、设备、用户与配置' },
        { username: 'teacher', role: '教师', description: '负责电子技术基础/嵌入式实验室，可审批预约' },
        { username: 'teacher2', role: '教师', description: '负责机械加工与 3D 打印中心' },
        { username: 'student', role: '学生', description: '普通学生账号，可预约设备、候补、签到' },
        { username: 'student10', role: '受限学生', description: '信用分偏低，用于演示失信限制' },
      ],
      demoPassword: '123456',
    });
  });

  /** 当前用户本周额度使用情况 */
  ctx.router.get('/api/me/quota', async (req) => {
    const user = requireLogin(req);
    const startOfWeek = require('../core/conflict-rules').startOfWeek;
    const tz = config.num('timezone_offset_minutes');
    const weekStart = startOfWeek(Date.now(), tz);
    const weekEnd = weekStart + 7 * 24 * 3600 * 1000;
    const used = Number(
      db.scalar(
        `SELECT COALESCE(SUM(end_at - start_at), 0) AS s FROM bookings
         WHERE user_id = ? AND status IN ('pending','approved','checked_in','completed')
           AND start_at >= ? AND start_at < ?`,
        [user.id, weekStart, weekEnd],
      ) || 0,
    ) / 60000;
    const quota = user.weekly_quota_min || config.num('max_weekly_minutes_default');
    return ok({
      quotaMinutes: quota,
      usedMinutes: Math.round(used),
      remainingMinutes: Math.max(0, Math.round(quota - used)),
      weekStart,
      weekEnd,
    });
  });
}

module.exports = { register };
