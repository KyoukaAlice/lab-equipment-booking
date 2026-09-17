'use strict';

/**
 * 程序入口
 */

const { start } = require('./http/server');
const config = require('./core/config');
const db = require('./db');

async function main() {
  const app = await start({ port: Number(process.env.PORT || 3000) });
  const users = db.scalar('SELECT COUNT(*) AS c FROM users');
  const bookings = db.scalar('SELECT COUNT(*) AS c FROM bookings');
  console.log('');
  console.log(`  ${config.str('site_name')}`);
  console.log('  ------------------------------------------------------------');
  console.log(`  服务地址   : http://127.0.0.1:${app.port}`);
  console.log(`  数据库     : ${process.env.LAB_DB_PATH || 'data/lab.db'}（SQLite / WAL）`);
  console.log(`  演示账号   : admin / teacher / student   口令统一为 123456`);
  console.log(`  当前数据   : ${users} 个用户，${bookings} 条预约记录`);
  console.log('  ------------------------------------------------------------');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');

  const shutdown = async () => {
    console.log('\n正在关闭服务…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
