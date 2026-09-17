-- ===================================================================
--  高校实验室设备预约与共享管理系统 —— 数据库结构
--  数据库：SQLite（WAL 模式，支持并发读 + 串行写）
--  时间：所有 *_at 字段统一存储毫秒时间戳（INTEGER）
--  金额：所有 *_fen 字段存储「分」，避免浮点误差
-- ===================================================================

PRAGMA foreign_keys = ON;

-- -------------------------------------------------------------------
-- 系统配置（键值对，可在管理后台动态修改）
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config (
  key         TEXT PRIMARY KEY,
  value       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT ''
);

-- -------------------------------------------------------------------
-- 组织与用户
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS labs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  code        TEXT    NOT NULL UNIQUE,
  building    TEXT    NOT NULL DEFAULT '',
  room        TEXT    NOT NULL DEFAULT '',
  capacity    INTEGER NOT NULL DEFAULT 0,
  open_hours  TEXT    NOT NULL DEFAULT '',
  rules       TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT    NOT NULL UNIQUE,
  password_hash     TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  role              TEXT    NOT NULL CHECK (role IN ('admin', 'teacher', 'student')),
  email             TEXT    NOT NULL DEFAULT '',
  phone             TEXT    NOT NULL DEFAULT '',
  department        TEXT    NOT NULL DEFAULT '',
  student_no        TEXT    NOT NULL DEFAULT '',
  credit_score      INTEGER NOT NULL DEFAULT 100,
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'disabled')),
  frozen_reason     TEXT    NOT NULL DEFAULT '',
  frozen_until      INTEGER NOT NULL DEFAULT 0,
  weekly_quota_min  INTEGER NOT NULL DEFAULT 240,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- 实验室负责人：一个实验室可配多名负责人，均可审批该实验室下设备的预约
CREATE TABLE IF NOT EXISTS lab_managers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_id     INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (lab_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);

-- -------------------------------------------------------------------
-- 设备资产
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_id           INTEGER NOT NULL REFERENCES labs(id) ON DELETE RESTRICT,
  name             TEXT    NOT NULL,
  category         TEXT    NOT NULL DEFAULT '其他',
  model            TEXT    NOT NULL DEFAULT '',
  brand            TEXT    NOT NULL DEFAULT '',
  serial_no        TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'available'
                     CHECK (status IN ('available', 'maintenance', 'offline', 'scrapped')),
  price_fen        INTEGER NOT NULL DEFAULT 0,
  purchase_date    TEXT    NOT NULL DEFAULT '',
  location         TEXT    NOT NULL DEFAULT '',
  owner_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  auto_approve     INTEGER NOT NULL DEFAULT 0 CHECK (auto_approve IN (0, 1)),
  checkin_required INTEGER NOT NULL DEFAULT 1 CHECK (checkin_required IN (0, 1)),
  min_minutes      INTEGER NOT NULL DEFAULT 30,
  max_minutes      INTEGER NOT NULL DEFAULT 240,
  lead_minutes     INTEGER NOT NULL DEFAULT 0,
  description      TEXT    NOT NULL DEFAULT '',
  images           TEXT    NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_lab    ON devices (lab_id);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices (status);

-- 设备/实验室的每周固定开放时段（按星期几重复）
CREATE TABLE IF NOT EXISTS weekly_slots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_id      INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  device_id   INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min   INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min     INTEGER NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at  INTEGER NOT NULL,
  CHECK (start_min < end_min)
);

CREATE INDEX IF NOT EXISTS idx_weekly_slots_lab_device ON weekly_slots (lab_id, device_id, weekday);

-- 停机计划：设备维修 / 实验室封闭 / 校准等，参与冲突检测
CREATE TABLE IF NOT EXISTS blackouts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_id     INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  device_id  INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  start_at   INTEGER NOT NULL,
  end_at     INTEGER NOT NULL,
  reason     TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'maintenance'
               CHECK (kind IN ('maintenance', 'calibration', 'holiday', 'event', 'other')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK (start_at < end_at)
);

CREATE INDEX IF NOT EXISTS idx_blackouts_scope ON blackouts (lab_id, device_id, start_at, end_at);

-- -------------------------------------------------------------------
-- 预约主表（状态机见 src/core/booking-rules.js）
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT    NOT NULL UNIQUE,
  device_id        INTEGER NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  lab_id           INTEGER NOT NULL REFERENCES labs(id) ON DELETE RESTRICT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  start_at         INTEGER NOT NULL,
  end_at           INTEGER NOT NULL,
  purpose          TEXT    NOT NULL,
  course_name      TEXT    NOT NULL DEFAULT '',
  participants     INTEGER NOT NULL DEFAULT 1,
  status           TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'waitlist',
                                       'checked_in', 'completed', 'cancelled', 'no_show')),
  checkin_code     TEXT    NOT NULL DEFAULT '',
  checkin_checked  INTEGER NOT NULL DEFAULT 0 CHECK (checkin_checked IN (0, 1)),
  review_note      TEXT    NOT NULL DEFAULT '',
  reject_reason    TEXT    NOT NULL DEFAULT '',
  cancel_reason    TEXT    NOT NULL DEFAULT '',
  reviewed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      INTEGER NOT NULL DEFAULT 0,
  checked_in_at    INTEGER NOT NULL DEFAULT 0,
  checked_out_at   INTEGER NOT NULL DEFAULT 0,
  actual_minutes   INTEGER NOT NULL DEFAULT 0,
  waitlist_id      INTEGER,
  reminder_sent    INTEGER NOT NULL DEFAULT 0 CHECK (reminder_sent IN (0, 1)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (start_at < end_at)
);

CREATE INDEX IF NOT EXISTS idx_bookings_device_time ON bookings (device_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_bookings_user        ON bookings (user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status      ON bookings (status, start_at);
CREATE INDEX IF NOT EXISTS idx_bookings_lab         ON bookings (lab_id, start_at);

-- -------------------------------------------------------------------
-- 候补队列：时段被占满时排队，释放后由系统自动补位
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS waitlist (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at      INTEGER NOT NULL,
  end_at        INTEGER NOT NULL,
  purpose       TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting', 'promoted', 'expired', 'cancelled', 'converted')),
  promoted_at   INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL DEFAULT 0,
  booking_id    INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (start_at < end_at)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_device ON waitlist (device_id, start_at, status);

-- -------------------------------------------------------------------
-- 违约记录与信用分台账
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS violations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  type       TEXT    NOT NULL
               CHECK (type IN ('no_show', 'late_cancel', 'overtime', 'damage', 'rule_break')),
  points     INTEGER NOT NULL,
  detail     TEXT    NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_violations_user ON violations (user_id, created_at);

CREATE TABLE IF NOT EXISTS credit_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  change_points INTEGER NOT NULL,
  score_after   INTEGER NOT NULL,
  reason        TEXT    NOT NULL,
  ref_type      TEXT    NOT NULL DEFAULT '',
  ref_id        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_user ON credit_records (user_id, created_at);

-- -------------------------------------------------------------------
-- 通知中心
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  content    TEXT    NOT NULL DEFAULT '',
  link       TEXT    NOT NULL DEFAULT '',
  is_read    INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, is_read, created_at);

-- -------------------------------------------------------------------
-- 审计日志：谁在什么时间对什么对象做了什么
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name  TEXT    NOT NULL DEFAULT '',
  action      TEXT    NOT NULL,
  target_type TEXT    NOT NULL DEFAULT '',
  target_id   INTEGER NOT NULL DEFAULT 0,
  detail      TEXT    NOT NULL DEFAULT '',
  ip          TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at);
