'use strict';

/**
 * 定时任务服务
 * ------------------------------------------------------------------
 * 每 60 秒执行一轮后台作业：
 *   1. 爽约判定（超过签到宽限期仍未签到 → no_show + 扣分 + 释放时段）
 *   2. 开始前提醒（预约开始前 N 分钟推送通知）
 *   3. 候补确认超时顺延
 *   4. 冻结到期自动解冻
 * 另外启动时立即跑一轮，保证重启后状态一致。
 */

const bookingService = require('./booking.service');
const creditService = require('./credit.service');

let timer = null;
let running = false;
let lastRun = null;
const stats = { rounds: 0, noShow: 0, reminders: 0, waitlistExpired: 0, unfrozen: 0 };

async function runOnce(reason = 'manual') {
  if (running) return null;
  running = true;
  const startedAt = Date.now();
  const result = {
    reason,
    at: startedAt,
    noShow: 0,
    reminders: 0,
    waitlistExpired: 0,
    unfrozen: 0,
    durationMs: 0,
  };
  try {
    result.noShow = bookingService.processNoShows(startedAt);
    result.reminders = bookingService.processReminders(startedAt);
    result.waitlistExpired = await bookingService.expireWaitlistHolds(startedAt);
    result.unfrozen = creditService.autoUnfreezeExpired();
    stats.rounds += 1;
    stats.noShow += result.noShow;
    stats.reminders += result.reminders;
    stats.waitlistExpired += result.waitlistExpired;
    stats.unfrozen += result.unfrozen;
  } catch (err) {
    console.error('[scheduler] 后台作业执行失败：', err);
  } finally {
    result.durationMs = Date.now() - startedAt;
    lastRun = result;
    running = false;
  }
  return result;
}

const tickAsync = runOnce;

function start(ctx, intervalMs = 60 * 1000) {
  if (timer) return;
  // 启动立刻执行一轮，随后按固定间隔轮询
  tickAsync('startup');
  timer = setInterval(() => tickAsync('timer'), intervalMs);
  if (timer.unref) timer.unref();
  void ctx;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function status() {
  return { running: Boolean(timer), lastRun, counters: { ...stats } };
}

module.exports = { start, stop, runOnce, tickAsync, status };
