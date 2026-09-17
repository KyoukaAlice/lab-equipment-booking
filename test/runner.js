'use strict';

/**
 * 零依赖测试框架（注册 + 调度 + 报告）
 * ------------------------------------------------------------------
 * 为什么不用 node:test：Node 内置测试运行器会为每个测试文件 fork 子进程并通过管道
 * 捕获输出，在受限沙箱 / 部分企业环境下会因 EPERM 直接失败。本框架在同一进程内
 * 顺序加载并串行执行各测试文件，行为可预测、无子进程、无第三方依赖。
 *
 * 用法（见 test/run.js）：
 *   const { test, before, after, assert } = require('./runner');
 */

const nodeAssert = require('node:assert/strict');

/* ============================== 断言封装 ============================== */

const assert = Object.create(nodeAssert);
assert.equal = (actual, expected, message) => nodeAssert.equal(actual, expected, message);
assert.deepEqual = (actual, expected, message) => nodeAssert.deepEqual(actual, expected, message);
assert.ok = (value, message) => nodeAssert.ok(value, message);
assert.match = (value, regex, message) => nodeAssert.match(value, regex, message);

/** 期望抛出异常；matcher 可为校验函数（返回 true 通过）/正则/字符串 */
assert.rejects = async (fn, matcher) => {
  let thrown = null;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  if (!thrown) {
    throw new nodeAssert.AssertionError({ message: '期望函数抛出异常，但它正常返回了' });
  }
  if (matcher === undefined) return thrown;
  if (typeof matcher === 'function') {
    if (!matcher(thrown)) {
      throw new nodeAssert.AssertionError({
        message: `异常校验未通过：${thrown && thrown.message ? thrown.message : thrown}`,
      });
    }
    return thrown;
  }
  if (matcher instanceof RegExp) {
    nodeAssert.match(String(thrown.message || thrown), matcher);
    return thrown;
  }
  nodeAssert.equal(thrown.message, matcher);
  return thrown;
};

assert.throws = (fn, matcher) => {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  if (!thrown) {
    throw new nodeAssert.AssertionError({ message: '期望函数抛出异常，但它正常返回了' });
  }
  if (typeof matcher === 'function' && !matcher(thrown)) {
    throw new nodeAssert.AssertionError({ message: `异常校验未通过：${thrown.message}` });
  }
  return thrown;
};

/* ============================== 注册 API ============================== */

const queue = [];
const beforeHooks = [];
const afterHooks = [];
let currentFile = '(unknown)';

/** 注册一个测试用例 */
function test(name, fn) {
  const stack = (new Error().stack || '').split('\n')[2] || '';
  const m = /:(\d+):\d+/.exec(stack);
  queue.push({ name, fn, file: currentFile, line: m ? Number(m[1]) : 0 });
}

/** 注册文件级前置钩子（在文件名下的所有用例之前执行） */
function before(fn) {
  beforeHooks.push(fn);
}

/** 注册文件级后置钩子 */
function after(fn) {
  afterHooks.push(fn);
}

function setCurrentFile(name) {
  currentFile = name;
}

/** 取出并清空当前累积的用例（供运行器逐文件调度） */
function takeCases() {
  return queue.splice(0, queue.length);
}

function takeHooks() {
  return {
    before: beforeHooks.splice(0, beforeHooks.length),
    after: afterHooks.splice(0, afterHooks.length),
  };
}

module.exports = { test, before, after, assert, setCurrentFile, takeCases, takeHooks };
