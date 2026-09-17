'use strict';

/**
 * 数据库访问层
 * ------------------------------------------------------------------
 * 基于 Node 内置 node:sqlite（Node >= 22.5），无需任何第三方依赖或本地编译。
 *
 * 并发策略（本项目重点设计之一）：
 *   1. 开启 WAL 模式 —— 读操作与写操作互不阻塞；
 *   2. 所有写事务通过进程内互斥锁（RW 锁）串行化，并在事务开始前
 *      执行 BEGIN IMMEDIATE，从而在「判冲突 → 写入」之间不会出现竞态窗口，
 *      保证同一设备的同一时段在并发下单时只会有一条预约成功。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'lab.db');

let db = null;

/** 写锁（简单互斥锁 + 等待队列），保证写事务串行执行 */
const writeLock = {
  locked: false,
  queue: [],
};

function acquireWriteLock() {
  return new Promise((resolve) => {
    if (!writeLock.locked) {
      writeLock.locked = true;
      resolve();
    } else {
      writeLock.queue.push(resolve);
    }
  });
}

function releaseWriteLock() {
  const next = writeLock.queue.shift();
  if (next) {
    next();
  } else {
    writeLock.locked = false;
  }
}

/**
 * 初始化数据库连接（如文件不存在则创建并建表）
 * @param {string} dbPath 数据库文件路径，':memory:' 表示内存库（测试用）
 * @param {{ seed?: boolean }} [opts]
 */
function init(dbPath = process.env.LAB_DB_PATH || DEFAULT_DB_PATH, opts = {}) {
  if (db) return db;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  if (opts.seed !== false) {
    // 延迟 require，避免循环依赖
    const { seedIfEmpty } = require('../seed/seed-data');
    seedIfEmpty(db);
  }
  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

function close() {
  if (db) {
    try {
      db.close();
    } catch {
      /* 忽略重复关闭 */
    }
    db = null;
  }
}

/* ------------------------------ 查询封装 ------------------------------ */

function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

function get(sql, params = []) {
  const rows = getDb().prepare(sql).all(...params);
  return rows.length ? rows[0] : null;
}

/** 执行写语句，返回 { changes, lastInsertRowid } */
function run(sql, params = []) {
  const res = getDb().prepare(sql).run(...params);
  return {
    changes: Number(res.changes),
    lastInsertRowid: Number(res.lastInsertRowid),
  };
}

/** 查询单个标量值 */
function scalar(sql, params = []) {
  const row = get(sql, params);
  if (!row) return null;
  return row[Object.keys(row)[0]];
}

/** 只读事务（可嵌套调用，SQLite 不支持嵌套事务时退化为顺序执行） */
function readTx(fn) {
  return fn();
}

/**
 * 写事务：自动加进程内写锁 + BEGIN IMMEDIATE / COMMIT / ROLLBACK
 * @param {(db:DatabaseSync)=>any} fn 事务体，返回值原样返回
 */
async function writeTx(fn) {
  await acquireWriteLock();
  const conn = getDb();
  try {
    conn.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(conn);
      conn.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        conn.exec('ROLLBACK');
      } catch {
        /* 事务可能已被自动回滚 */
      }
      throw err;
    }
  } finally {
    releaseWriteLock();
  }
}

/** 同步版写事务（仅用于启动期种子数据等无并发场景） */
function writeTxSync(fn) {
  const conn = getDb();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(conn);
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* 忽略 */
    }
    throw err;
  }
}

module.exports = {
  init,
  getDb,
  close,
  all,
  get,
  run,
  scalar,
  readTx,
  writeTx,
  writeTxSync,
};
