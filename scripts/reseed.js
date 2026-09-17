'use strict';

/**
 * 重置演示数据库：清空并重新生成全部演示数据。
 * 用法：node scripts/reseed.js
 * 注意：会删除 data/lab.db 中的全部业务数据（结构保留）。
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const dbPath = process.env.LAB_DB_PATH || path.join(ROOT, 'data', 'lab.db');

const dbModule = require(path.join(ROOT, 'src/db'));
const config = require(path.join(ROOT, 'src/core/config'));
const seed = require(path.join(ROOT, 'src/seed/seed-data.js'));

async function sha() {
  if (!fs.existsSync(dbPath)) {
    console.log(`数据库文件不存在（${dbPath}），将新建。`);
    return;
  }
  const { createHash } = require('node:crypto');
  const buf = fs.readFileSync(dbPath);
  console.log(`已有数据库：${dbPath}（${(buf.length / 1024).toFixed(1)} KB，sha256=${createHash('sha256').update(buf).digest('hex').slice(0, 12)}）`);
}

(async () => {
  await sha();
  const db = dbModule.init(dbPath, { seed: false });
  config.ensureDefaults();
  const before = {
    users: Number(dbModule.scalar('SELECT COUNT(*) AS c FROM users') || 0),
    bookings: Number(dbModule.scalar('SELECT COUNT(*) AS c FROM bookings') || 0),
  };
  console.log(`重置前：用户 ${before.users} 个，预约 ${before.bookings} 条`);

  seed.reseed(db);

  const after = {
    users: Number(dbModule.scalar('SELECT COUNT(*) AS c FROM users') || 0),
    labs: Number(dbModule.scalar('SELECT COUNT(*) AS c FROM labs') || 0),
    devices: Number(dbModule.scalar('SELECT COUNT(*) AS c FROM devices') || 0),
    bookings: Number(dbModule.scalar('SELECT COUNT(*) AS c FROM bookings') || 0),
    waitlist: Number(dbModule.scalar('SELECT COUNT(*) AS c FROM waitlist') || 0),
    violations: Number(dbModule.scalar('SELECT COUNT(*) AS c FROM violations') || 0),
    notifications: Number(dbModule.scalar('SELECT COUNT(*) AS c FROM notifications') || 0),
  };
  console.log(
    `重置完成：用户 ${after.users} 个，实验室 ${after.labs} 间，设备 ${after.devices} 台，` +
      `预约 ${after.bookings} 条，候补 ${after.waitlist} 条，违约 ${after.violations} 条，通知 ${after.notifications} 条`,
  );
  console.log('演示账号口令统一为 123456：admin / teacher / teacher2 / teacher3 / student ~ student11');
  dbModule.close();
  process.exit(0);
})().catch((err) => {
  console.error('重置失败：', err);
  process.exit(1);
});
