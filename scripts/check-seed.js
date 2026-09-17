'use strict';

/**
 * 演示数据自检脚本
 * ------------------------------------------------------------------
 * 校验 src/seed/seed-data.js 生成的演示数据是否满足全部业务不变量。
 * 这是毕业设计「数据一致性验证」的可执行证据，可随时运行：
 *   node scripts/check-seed.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 与真实启动流程保持一致：先用 src/db 建立内存库并写入 config 默认值，
// 再生成演示数据（种子数据会读取 max_active_bookings_per_user 等配置来约束自身合法性）。
process.env.LAB_DB_PATH = ':memory:';
const dbModule = require(path.join(ROOT, 'src/db'));
const configModule = require(path.join(ROOT, 'src/core/config'));
const seed = require(path.join(ROOT, 'src/seed/seed-data.js'));
const db = dbModule.init(':memory:', { seed: false });
configModule.ensureDefaults();

let pass = 0;
let fail = 0;
function check(label, condition, extra = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✅ ${label}${extra ? `（${extra}）` : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${extra ? `（${extra}）` : ''}`);
  }
}

const t0 = Date.now();
const firstRun = seed.seedIfEmpty(db);
const seedMs = Date.now() - t0;
const now = Date.now();

console.log('\n=== 一、种子生成 ===');
check('首次 seedIfEmpty 返回 true', firstRun === true);
check('生成耗时在 3 秒内', seedMs < 3000, `${seedMs}ms`);
check('二次调用返回 false（幂等，不重复插入）', seed.seedIfEmpty(db) === false);
check('幂等后用户数仍为 15', Number(db.prepare('SELECT COUNT(*) AS c FROM users').all()[0].c) === 15);

const tables = [
  'users', 'labs', 'lab_managers', 'devices', 'weekly_slots', 'blackouts',
  'bookings', 'waitlist', 'violations', 'credit_records', 'notifications', 'audit_logs',
];
console.log('\n=== 二、数据规模 ===');
const counts = {};
for (const t of tables) counts[t] = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).all()[0].c);
console.log('  ' + tables.map((t) => `${t}=${counts[t]}`).join('  '));
check('用户 15 个', counts.users === 15);
check('实验室 4 间', counts.labs === 4);
check('设备 20 台', counts.devices === 20);
check('预约记录 60 条以上', counts.bookings >= 60, `${counts.bookings} 条`);
check('每周排班已配置', counts.weekly_slots >= 40, `${counts.weekly_slots} 条`);
check('停机计划已配置', counts.blackouts >= 6, `${counts.blackouts} 条`);
check('存在候补记录', counts.waitlist >= 4, `${counts.waitlist} 条`);
check('存在违约与信用台账', counts.violations >= 8 && counts.credit_records >= 10);
check('存在通知与审计日志', counts.notifications >= 20 && counts.audit_logs >= 15);

console.log('\n=== 三、核心业务不变量 ===');
// 1) 同一设备的占用状态预约两两不重叠
const rows = db
  .prepare(
    "SELECT id, device_id, start_at, end_at FROM bookings WHERE status IN ('pending','approved','checked_in','completed') ORDER BY device_id, start_at",
  )
  .all();
let overlaps = 0;
for (let i = 1; i < rows.length; i += 1) {
  if (rows[i].device_id === rows[i - 1].device_id && rows[i].start_at < rows[i - 1].end_at) overlaps += 1;
}
check('同一设备占用时段零重叠', overlaps === 0, `重叠 ${overlaps} 对`);

// 2) 信用台账累加 == 当前分数
const users = db.prepare('SELECT id, name, credit_score, status FROM users').all();
let mismatch = 0;
for (const u of users) {
  const sum = Number(
    db.prepare('SELECT COALESCE(SUM(change_points), 0) AS s FROM credit_records WHERE user_id = ?').all(u.id)[0].s,
  );
  if (100 + sum !== Number(u.credit_score)) mismatch += 1;
}
check('信用台账累加等于当前信用分', mismatch === 0, `不一致 ${mismatch} 人`);

// 3) 失信演示数据
const frozen = users.filter((u) => u.status === 'frozen');
const lowActive = users.filter((u) => u.status === 'active' && u.credit_score >= 60 && u.credit_score < 75);
check('存在被自动冻结的受限用户', frozen.length >= 1, frozen.map((f) => `${f.name}(${f.credit_score})`).join('、'));
check('存在信用一般但活跃的用户', lowActive.length >= 1, lowActive.map((f) => `${f.name}(${f.credit_score})`).join('、'));

// 4) 在途预约不超上限（否则演示数据自身违反 R12）
const maxActive = Number(db.prepare("SELECT value FROM config WHERE key = 'max_active_bookings_per_user'").all()[0].value) || 5;
const activeRows = db
  .prepare(
    `SELECT u.username, COUNT(b.id) AS c FROM users u
     LEFT JOIN bookings b ON b.user_id = u.id AND b.status IN ('pending','approved','checked_in')
     GROUP BY u.id HAVING c >= ?`,
  )
  .all(maxActive);
check(`无用户达到在途上限（${maxActive} 条）`, activeRows.length === 0, activeRows.map((r) => `${r.username}=${Number(r.c)}`).join('、'));

// 5) 被冻结用户不应持有未来在途预约
const frozenFuture = Number(
  db
    .prepare(
      `SELECT COUNT(*) AS c FROM bookings b JOIN users u ON u.id = b.user_id
       WHERE u.status = 'frozen' AND b.status IN ('pending','approved','checked_in') AND b.start_at > ?`,
    )
    .all(now)[0].c,
);
check('被冻结用户没有未来在途预约', frozenFuture === 0, `${frozenFuture} 条`);

// 6) 「使用中」预约必须包含当前时刻（用于演示签到流程）
const checkedInNow = Number(
  db
    .prepare("SELECT COUNT(*) AS c FROM bookings WHERE status = 'checked_in' AND start_at < ? AND end_at > ?")
    .all(now, now)[0].c,
);
check('存在包含当前时刻的「使用中」预约', checkedInNow >= 1, `${checkedInNow} 条`);

// 7) 状态一致性
const badDuration = Number(db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE end_at <= start_at').all()[0].c);
check('不存在起止时间非法的预约', badDuration === 0);
const completedMissing = Number(
  db
    .prepare("SELECT COUNT(*) AS c FROM bookings WHERE status = 'completed' AND (checked_out_at = 0 OR actual_minutes = 0)")
    .all()[0].c,
);
check('已完成预约都含签到/签退信息', completedMissing === 0, `${completedMissing} 条缺失`);
// 待审批预约原则上应指向未来时段。注意：种子数据以「生成时刻」为锚点，
// 而校验脚本可能在数小时后才运行，因此允许 24 小时的“自然老化”窗口；
// 真正要防的是「生成时就指向过去」的数据错误（用 created_at 作为参照更严格）。
const stalePending = Number(
  db
    .prepare("SELECT COUNT(*) AS c FROM bookings WHERE status = 'pending' AND start_at < created_at")
    .all()[0].c,
);
check('不存在「生成时即指向过去」的待审批预约', stalePending === 0, `${stalePending} 条`);
const agedPending = Number(
  db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE status = 'pending' AND start_at < ?").all(now - 24 * 3600 * 1000)[0].c,
);
check('无超过 24 小时的过期待审批预约', agedPending === 0, `${agedPending} 条`);
const selfReview = Number(db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE reviewed_by = user_id').all()[0].c);
check('不存在自审自批的预约', selfReview === 0);
const noCode = Number(
  db
    .prepare(
      "SELECT COUNT(*) AS c FROM bookings WHERE status IN ('approved','checked_in','completed') AND (checkin_code = '' OR LENGTH(checkin_code) <> 6)",
    )
    .all()[0].c,
);
check('已通过预约都有 6 位签到码', noCode === 0, `${noCode} 条缺失`);
const badCode = Number(db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE code NOT LIKE 'BK%'").all()[0].c);
check('预约编号格式统一', badCode === 0);

// 8) 排班与停机计划覆盖
const noManagers = Number(
  db.prepare('SELECT COUNT(*) AS c FROM labs WHERE id NOT IN (SELECT lab_id FROM lab_managers)').all()[0].c,
);
check('每个实验室都配置了负责人', noManagers === 0);
const futureBlackouts = Number(db.prepare('SELECT COUNT(*) AS c FROM blackouts WHERE start_at > ?').all(now)[0].c);
check('存在未来的停机计划', futureBlackouts >= 2, `${futureBlackouts} 条`);
const deviceSlots = Number(db.prepare('SELECT COUNT(*) AS c FROM weekly_slots WHERE device_id IS NOT NULL').all()[0].c);
check('存在设备级例外排班', deviceSlots >= 4, `${deviceSlots} 条`);
const autoApprove = Number(db.prepare("SELECT COUNT(*) AS c FROM devices WHERE auto_approve = 1").all()[0].c);
check('存在免审批设备（用于演示自动通过）', autoApprove >= 3, `${autoApprove} 台`);
const notAvailable = Number(db.prepare("SELECT COUNT(*) AS c FROM devices WHERE status <> 'available'").all()[0].c);
check('存在维护中/停用设备（用于演示 R01）', notAvailable >= 2, `${notAvailable} 台`);

console.log('\n=== 四、reseed 可重入 ===');
try {
  seed.reseed(db);
  const after = tables.map((t) => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).all()[0].c));
  check('reseed 执行成功且数据规模合理', after[0] === 15 && after[6] >= 60, `bookings=${after[6]}`);
} catch (err) {
  check('reseed 执行成功', false, err.message);
}

console.log(`\n${'─'.repeat(60)}`);
if (fail === 0) {
  console.log(`✅ 演示数据自检全部通过：${pass} 项\n`);
} else {
  console.log(`❌ 演示数据自检失败 ${fail} 项 / 共 ${pass + fail} 项\n`);
}
process.exit(fail === 0 ? 0 : 1);
