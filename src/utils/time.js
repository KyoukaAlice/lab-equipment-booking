'use strict';

/**
 * 时间工具模块
 * ------------------------------------------------------------------
 * 系统内部统一使用「毫秒时间戳（Number）」表示绝对时刻，避免时区歧义；
 * 仅在「按自然日切分 / 展示」时才结合 timezoneOffset 做本地时间换算。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 一周七天的中文名，索引与 Date#getUTCDay 对齐（0 = 周日） */
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 分钟数 -> "HH:mm" */
function minutesToClock(minutes) {
  const m = ((Number(minutes) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** "HH:mm" / "H:mm" -> 分钟数；非法返回 null */
function clockToMinutes(clock) {
  if (typeof clock !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 时间戳 -> "YYYY-MM-DD"（按给定时区偏移） */
function formatDate(ts, timezoneOffsetMinutes = 480) {
  return new Date(Number(ts) + timezoneOffsetMinutes * MINUTE).toISOString().slice(0, 10);
}

/** 时间戳 -> "YYYY-MM-DD HH:mm"（按给定时区偏移） */
function formatDateTime(ts, timezoneOffsetMinutes = 480) {
  if (ts === null || ts === undefined) return '';
  const iso = new Date(Number(ts) + timezoneOffsetMinutes * MINUTE).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** 时间戳 -> "HH:mm" */
function formatClock(ts, timezoneOffsetMinutes = 480) {
  const iso = new Date(Number(ts) + timezoneOffsetMinutes * MINUTE).toISOString();
  return iso.slice(11, 16);
}

/** "YYYY-MM-DD" -> 该日 00:00 的时间戳（按给定时区偏移） */
function parseDate(dateStr, timezoneOffsetMinutes = 480) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(asUtc);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return null; // 例如 2026-02-30
  }
  return asUtc - timezoneOffsetMinutes * MINUTE;
}

/** "YYYY-MM-DD HH:mm" 或 "YYYY-MM-DDTHH:mm" -> 时间戳 */
function parseDateTime(input, timezoneOffsetMinutes = 480) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(input || '').trim());
  if (!m) return null;
  const dayStart = parseDate(m[1], timezoneOffsetMinutes);
  if (dayStart === null) return null;
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (h > 23 || mi > 59) return null;
  return dayStart + h * HOUR + mi * MINUTE;
}

/** 该时刻所在自然日的 00:00 时间戳 */
function startOfDay(ts, timezoneOffsetMinutes = 480) {
  return parseDate(formatDate(ts, timezoneOffsetMinutes), timezoneOffsetMinutes);
}

/** 该时刻所在自然日的 24:00（次日 00:00） */
function endOfDay(ts, timezoneOffsetMinutes = 480) {
  return startOfDay(ts, timezoneOffsetMinutes) + DAY;
}

/** 自然日对应的星期（0=周日） */
function weekdayOfDayStart(dayStart, timezoneOffsetMinutes = 480) {
  return new Date(dayStart + timezoneOffsetMinutes * MINUTE).getUTCDay();
}

/** n 天后的时间戳 */
function addDays(ts, n) {
  return Number(ts) + n * DAY;
}

/** 生成 [from, to) 之间的自然日 00:00 列表 */
function eachDayStart(fromTs, toTs, timezoneOffsetMinutes = 480) {
  const out = [];
  let cur = startOfDay(fromTs, timezoneOffsetMinutes);
  const guard = 400; // 防止异常入参造成死循环
  for (let i = 0; cur < toTs && i < guard; i += 1) {
    out.push(cur);
    cur += DAY;
  }
  return out;
}

/** 时长的中文描述 */
function humanDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h && rest) return `${h} 小时 ${rest} 分钟`;
  if (h) return `${h} 小时`;
  return `${rest} 分钟`;
}

module.exports = {
  MINUTE,
  HOUR,
  DAY,
  WEEKDAY_NAMES,
  minutesToClock,
  clockToMinutes,
  formatDate,
  formatDateTime,
  formatClock,
  parseDate,
  parseDateTime,
  startOfDay,
  endOfDay,
  weekdayOfDayStart,
  addDays,
  eachDayStart,
  humanDuration,
};
