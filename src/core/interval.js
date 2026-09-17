'use strict';

/**
 * 区间算法模块（系统核心算法之一）
 * ------------------------------------------------------------------
 * 全部区间采用「左闭右开」语义 [start, end)，这与排课/排期的真实语义一致：
 *   09:00-10:00 与 10:00-11:00 不算冲突（可以直接衔接排期）。
 *
 * 提供三类基础算子：
 *   1. overlaps     —— 冲突判定（时间重叠检测的原子操作）
 *   2. merge        —— 区间合并（把重叠/相邻的占位合并成连续忙区间）
 *   3. subtract     —— 区间差集（从可用排班里挖掉已占用/停机时段）
 */

const { MINUTE } = require('../utils/time');

/** 区间是否有效：起止为数字且 start < end */
function isValid(interval) {
  return (
    interval &&
    Number.isFinite(interval.start) &&
    Number.isFinite(interval.end) &&
    interval.start < interval.end
  );
}

/**
 * 判断两个区间是否重叠（左闭右开）
 * 数学表达：aStart < bEnd && bStart < aEnd
 */
function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * 判断区间 a 是否完全包含区间 b
 */
function contains(a, b) {
  return a.start <= b.start && a.end >= b.end;
}

/** 把区间数组按 start 升序排序（返回新数组，不修改入参） */
function sortIntervals(intervals) {
  return intervals.filter(isValid).slice().sort((x, y) => x.start - y.start || x.end - y.end);
}

/**
 * 合并重叠或相邻的区间。
 * 相邻（前一个 end === 后一个 start）也合并，便于做「连续可用时长」判断。
 */
function merge(intervals) {
  const sorted = sortIntervals(intervals);
  const out = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

/**
 * 求交集：intervals ∩ range
 */
function clip(intervals, range) {
  return sortIntervals(intervals)
    .filter((iv) => overlaps(iv, range))
    .map((iv) => ({ start: Math.max(iv.start, range.start), end: Math.min(iv.end, range.end) }));
}

/**
 * 区间差集：base \ cuts
 * @param {Array<{start:number,end:number}>} base  基准区间（内部会先合并）
 * @param {Array<{start:number,end:number}>} cuts  需要挖除的区间
 * @param {number} minDuration 结果中短于该毫秒数的碎片会被丢弃（默认 0）
 */
function subtract(base, cuts, minDuration = 0) {
  const bases = merge(base);
  const cutList = sortIntervals(cuts);
  const out = [];
  for (const b of bases) {
    let cursor = b.start;
    for (const c of cutList) {
      if (c.end <= cursor) continue; // 已经完全在游标左侧
      if (c.start >= b.end) break; // 已经完全越过当前基准区间
      if (c.start > cursor) out.push({ start: cursor, end: Math.min(c.start, b.end) });
      cursor = Math.max(cursor, c.end);
      if (cursor >= b.end) break;
    }
    if (cursor < b.end) out.push({ start: cursor, end: b.end });
  }
  return out.filter((iv) => iv.end - iv.start > minDuration);
}

/**
 * 从区间集合中找出所有空闲片段。
 * @param {Object} opts
 * @param {Array} opts.schedule   开放排班区间（可预约的总时间池）
 * @param {Array} opts.busy       已占用区间（已通过/待审批的预约、维护停机等）
 * @param {number} opts.from      查询窗口起点
 * @param {number} opts.to        查询窗口终点
 * @param {number} opts.minMinutes 可接受的最短空闲时长（分钟）
 * @returns {Array<{start:number,end:number}>}
 */
function findFreeSlots({ schedule, busy, from, to, minMinutes = 1 }) {
  const window = { start: from, end: to };
  const pool = clip(schedule, window);
  const blockers = clip(busy, window);
  return subtract(pool, blockers, Math.max(1, Number(minMinutes) || 1) * MINUTE - 1);
}

/**
 * 命中统计：返回 targets 中与 range 重叠的区间（用于「该时段已被谁占用」）
 */
function hits(targets, range) {
  return sortIntervals(targets).filter((iv) => overlaps(iv, range));
}

/**
 * 计算区间总时长（毫秒）
 */
function totalDuration(intervals) {
  return merge(intervals).reduce((sum, iv) => sum + (iv.end - iv.start), 0);
}

module.exports = {
  isValid,
  overlaps,
  contains,
  sortIntervals,
  merge,
  clip,
  subtract,
  findFreeSlots,
  hits,
  totalDuration,
};
