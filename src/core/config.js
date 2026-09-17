'use strict';

/**
 * 系统配置模块
 * ------------------------------------------------------------------
 * 业务规则（预约窗口、信用阈值、违约扣分、签到宽限…）全部落库为 config 表，
 * 管理后台可在线调整，避免硬编码。读取走内存缓存，写入后自动失效。
 */

const db = require('../db');

/** 默认配置：首次启动写入数据库 */
const DEFAULTS = {
  site_name: { value: '高校实验室设备预约与共享管理系统', description: '系统名称' },
  timezone_offset_minutes: { value: '480', description: '时区偏移（分钟），480 = UTC+8' },
  booking_advance_days: { value: '14', description: '最多可提前预约的自然日数' },
  booking_min_lead_minutes: { value: '30', description: '至少提前多少分钟提交（0 = 不限制）' },
  cancel_deadline_hours: { value: '12', description: '少于该小时数取消视为「临时取消」并扣分' },
  checkin_grace_minutes: { value: '15', description: '开始后多少分钟内未签到判定为爽约' },
  checkin_open_before_minutes: { value: '30', description: '开始前多少分钟开放签到' },
  reminder_minutes: { value: '30', description: '开始前多少分钟发送提醒' },
  overtime_grace_minutes: { value: '10', description: '签退超过该分钟数判定超时占用' },
  max_weekly_minutes_default: { value: '240', description: '新用户每周默认预约额度（分钟）' },
  max_active_bookings_per_user: { value: '5', description: '同时在途（待审批+已通过）预约上限' },
  default_points_no_show: { value: '10', description: '爽约扣分' },
  default_points_late_cancel: { value: '5', description: '临时取消扣分' },
  default_points_overtime: { value: '5', description: '超时占用扣分' },
  credit_freeze_threshold: { value: '60', description: '信用分低于该值自动冻结预约权限' },
  credit_freeze_days: { value: '30', description: '自动冻结的解除天数' },
  credit_restore_on_approve: { value: '1', description: '被扣分的预约重新获批时是否恢复分数（1/0）' },
  pending_blocks_others: { value: '1', description: '待审批预约是否占用时段（1 = 占用，避免同一时段重复申请）' },
  waitlist_hold_minutes: { value: '60', description: '候补补位后保留确认的分钟数' },
  max_participants_per_booking: { value: '20', description: '单次预约最大参与人数' },
  announcement: { value: '', description: '首页公告' },
};

let cache = null;

function loadAll() {
  const rows = db.all('SELECT key, value FROM config');
  const map = {};
  for (const [k, v] of Object.entries(DEFAULTS)) map[k] = v.value;
  for (const r of rows) map[r.key] = r.value;
  return map;
}

function ensureDefaults() {
  const now = Date.now();
  for (const [key, item] of Object.entries(DEFAULTS)) {
    db.run(
      `INSERT INTO config (key, value, description) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET description = excluded.description`,
      [key, item.value, item.description],
    );
  }
  void now;
}

function all() {
  if (!cache) {
    ensureDefaults();
    cache = loadAll();
  }
  return cache;
}

function invalidate() {
  cache = null;
}

/** 读取数字型配置 */
function num(key) {
  const cfg = all();
  const raw = cfg[key];
  if (raw === undefined) return Number(DEFAULTS[key]?.value ?? 0);
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number(DEFAULTS[key]?.value ?? 0);
}

/** 读取字符串型配置 */
function str(key) {
  const cfg = all();
  return cfg[key] !== undefined ? String(cfg[key]) : String(DEFAULTS[key]?.value ?? '');
}

/** 读取布尔型配置 */
function bool(key) {
  return num(key) === 1 || str(key) === 'true';
}

/**
 * 批量更新配置（管理后台）
 * @param {Record<string, string|number>} patch
 * @param {number} actorId
 */
function update(patch, actorId = null) {
  const now = Date.now();
  const changed = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
    const next = String(value);
    const current = db.get('SELECT value FROM config WHERE key = ?', [key]);
    if (!current || current.value !== next) {
      db.run(
        `INSERT INTO config (key, value, description) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, next, DEFAULTS[key].description],
      );
      changed.push({ key, from: current ? current.value : null, to: next });
    }
  }
  invalidate();
  if (changed.length) {
    db.run(
      `INSERT INTO audit_logs (user_id, actor_name, action, target_type, target_id, detail, ip, created_at)
       VALUES (?, ?, 'config.update', 'config', 0, ?, '', ?)`,
      [actorId, 'system', JSON.stringify(changed), now],
    );
  }
  return changed;
}

module.exports = {
  DEFAULTS,
  all,
  num,
  str,
  bool,
  update,
  invalidate,
  ensureDefaults,
};
