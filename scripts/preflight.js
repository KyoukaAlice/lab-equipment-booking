'use strict';

/**
 * 启动自检脚本（由 start.bat 调用，也可单独运行：node scripts/preflight.js）
 * ------------------------------------------------------------------
 * 目的：在启动 Web 服务之前，把「最容易导致启动失败」的四个原因一次性查清楚，
 * 并用中文给出可直接照做的解决办法，避免双击 bat 后窗口一闪而过、看不到原因。
 *
 * 检查项：
 *   1. Node.js 版本是否满足 node:sqlite 的要求（>= 22.5，实测 22.5 以下无此模块）
 *   2. 目标端口是否已被占用（占用时给出占用进程 PID 与三种解决办法）
 *   3. 依赖文件是否齐全（本系统零第三方依赖，缺少的只可能是自身文件被误删）
 *   4. 数据库文件是否可写（首次启动会自动建库）
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

let failed = 0;

function ok(label, extra = '') {
  console.log(`  [通过] ${label}${extra ? `  ${extra}` : ''}`);
}

function bad(label, advice) {
  failed += 1;
  console.log(`  [失败] ${label}`);
  if (advice) {
    for (const line of String(advice).split('\n')) console.log(`         ${line}`);
  }
}

function indent(text) {
  return String(text)
    .split('\n')
    .map((l) => `         ${l}`)
    .join('\n');
}

/** 检查 1：Node.js 版本 */
function checkNode() {
  const raw = process.versions.node;
  const [major, minor] = raw.split('.').map(Number);
  const supported = major > 22 || (major === 22 && minor >= 5);
  if (supported) {
    ok('Node.js 版本', `v${raw}`);
  } else {
    bad(
      `Node.js 版本过低：当前 v${raw}，需要 22.5 或更高`,
      [
        '本系统的数据库使用 Node 内置模块 node:sqlite，该模块在 22.5.0 才引入。',
        '低版本会出现：Cannot find module \'node:sqlite\'。',
        '解决办法：到 https://nodejs.org/ 下载安装 22 LTS 或 24 版本，安装后重新双击 start.bat。',
      ].join('\n'),
    );
  }
  return supported;
}

/** 检查 2：node:sqlite 是否真的可用 */
function checkSqlite() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(a INTEGER)');
    db.prepare('INSERT INTO t VALUES (1)').run();
    const row = db.prepare('SELECT COUNT(*) AS c FROM t').all()[0];
    db.close();
    if (Number(row.c) === 1) {
      ok('SQLite 内置模块可用', 'node:sqlite');
      return true;
    }
    bad('SQLite 内置模块行为异常', '请升级 Node.js 到 22 LTS 或 24 后重试。');
    return false;
  } catch (err) {
    bad(
      `无法加载 node:sqlite：${err.message}`,
      '请升级 Node.js 到 22.5 以上版本（推荐 22 LTS 或 24）。',
    );
    return false;
  }
}

/** 检查 3：端口占用 */
function checkPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        bad(
          `端口 ${PORT} 已被占用，服务无法启动`,
          [
            `占用端口 ${PORT} 的可能是上一次没关掉的本系统进程，也可能是其它软件。`,
            '解决办法（任选一种）：',
            `  1) 关掉占用端口的程序：在命令行执行  netstat -ano | findstr :${PORT}  记下最后一列 PID，`,
            '     再执行  taskkill /PID <该PID> /F',
            '  2) 换一个端口启动：先执行  set PORT=3001  再双击 start.bat（访问 http://127.0.0.1:3001）',
            '  3) 直接双击 scripts\\stop.bat 关闭本系统残留进程后重试',
          ].join('\n'),
        );
        resolve(false);
      } else {
        bad(`检测端口 ${PORT} 时出错：${err.message}`, '请尝试以管理员身份重新运行，或改用其它端口。');
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => {
        ok('端口可用', `${HOST}:${PORT}`);
        resolve(true);
      });
    });
    server.listen(PORT, HOST);
  });
}

/** 检查 4：关键文件是否齐全 */
function checkFiles() {
  const required = [
    'package.json',
    'src/server.js',
    'src/db/schema.sql',
    'src/core/interval.js',
    'src/core/conflict-rules.js',
    'src/services/booking.service.js',
    'src/seed/seed-data.js',
    'public/index.html',
    'public/js/app.js',
  ];
  const missing = required.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length === 0) {
    ok('项目文件完整', `${required.length} 个关键文件`);
    return true;
  }
  bad(
    `缺少 ${missing.length} 个关键文件：${missing.join('、')}`,
    '请确认没有把 src / public 目录中的文件移动或删除；必要时重新解压项目。',
  );
  return false;
}

/** 检查 5：数据目录可写 */
function checkDataDir() {
  const dataDir = path.join(ROOT, 'data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    const dbPath = process.env.LAB_DB_PATH || path.join(dataDir, 'lab.db');
    const exists = fs.existsSync(dbPath);
    ok('数据目录可写', exists ? `${path.basename(dbPath)} 已存在（直接复用）` : `${path.basename(dbPath)} 将在首次启动时创建`);
    return true;
  } catch (err) {
    bad(
      `数据目录不可写：${err.message}`,
      '请检查目录权限，或用环境变量指定其它位置：set LAB_DB_PATH=D:\\lab-data\\lab.db',
    );
    return false;
  }
}

async function main() {
  console.log('');
  console.log('  启动自检');
  console.log('  ------------------------------------------------------------');
  const nodeOk = checkNode();
  const sqliteOk = nodeOk ? checkSqlite() : false;
  const filesOk = checkFiles();
  const dataOk = checkDataDir();
  const portOk = await checkPort();
  console.log('  ------------------------------------------------------------');

  if (failed === 0) {
    console.log('  自检全部通过，正在启动服务…');
    console.log('  （启动后请用浏览器打开 http://127.0.0.1:' + PORT + ' ，演示账号 admin / student，口令 123456）');
    console.log('');
    process.exit(0);
  }

  console.log(`  自检未通过（${failed} 项失败），已停止启动，请按上面的提示处理后重试。`);
  console.log(`  Node.js：v${process.versions.node}   平台：${process.platform}   项目目录：${ROOT}`);
  console.log('');
  void sqliteOk;
  void filesOk;
  void dataOk;
  void portOk;
  process.exit(1);
}

main().catch((err) => {
  console.error('自检脚本异常：', err);
  process.exit(1);
});
