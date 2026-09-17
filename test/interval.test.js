'use strict';

/**
 * 核心区间算法单元测试（左闭右开语义 / 冲突判定 / 合并 / 差集）
 */

const { test, assert } = require('./runner');

const interval = require('../src/core/interval');

const MIN = 60 * 1000;
/** 把 "HH:mm" 转成「当天分钟数」便于书写用例 */
const m = (clock) => {
  const [h, mi] = clock.split(':').map(Number);
  return h * 60 + mi;
};
const iv = (startClock, endClock) => ({ start: m(startClock) * MIN, end: m(endClock) * MIN });

test('overlaps：左闭右开语义下相邻时段不冲突', () => {
  assert.equal(interval.overlaps(iv('09:00', '10:00'), iv('10:00', '11:00')), false, '09:00-10:00 与 10:00-11:00 可衔接');
  assert.equal(interval.overlaps(iv('09:00', '10:00'), iv('09:30', '10:30')), true, '部分重叠应判定为冲突');
  assert.equal(interval.overlaps(iv('09:00', '11:00'), iv('09:30', '10:00')), true, '完全包含应判定为冲突');
  assert.equal(interval.overlaps(iv('09:00', '10:00'), iv('08:00', '09:00')), false, '相接但不重叠');
  assert.equal(interval.overlaps(iv('09:00', '10:00'), iv('11:00', '12:00')), false, '完全分离');
  assert.equal(interval.overlaps(iv('09:00', '09:01'), iv('09:00', '09:01')), true, '完全相同区间冲突');
});

test('contains：完全覆盖判定（用于 R08 排班边界校验）', () => {
  assert.equal(interval.contains(iv('08:00', '12:00'), iv('09:00', '11:00')), true);
  assert.equal(interval.contains(iv('08:00', '12:00'), iv('08:00', '12:00')), true, '边界相等也算覆盖');
  assert.equal(interval.contains(iv('09:00', '12:00'), iv('08:00', '11:00')), false);
});

test('merge：重叠与相邻区间合并，乱序输入也能正确归并', () => {
  const merged = interval.merge([iv('13:30', '17:00'), iv('08:00', '12:00'), iv('11:00', '13:00'), iv('20:00', '21:00')]);
  assert.deepEqual(merged, [iv('08:00', '13:00'), iv('13:30', '17:00'), iv('20:00', '21:00')].map((x) => ({ start: x.start, end: x.end })));
});

test('subtract：从排班中挖掉占用区间', () => {
  const schedule = [iv('08:00', '12:00'), iv('13:30', '17:00')];
  const busy = [iv('09:00', '10:30'), iv('14:00', '15:00')];
  const free = interval.subtract(schedule, busy);
  assert.deepEqual(free, [
    iv('08:00', '09:00'),
    iv('10:30', '12:00'),
    iv('13:30', '14:00'),
    iv('15:00', '17:00'),
  ].map((x) => ({ start: x.start, end: x.end })));
});

test('subtract：占用完全覆盖排班时无空闲', () => {
  const free = interval.subtract([iv('09:00', '10:00')], [iv('08:00', '11:00')]);
  assert.equal(free.length, 0);
});

test('subtract：minDuration 会过滤掉过短的碎片', () => {
  const schedule = [iv('08:00', '09:00')];
  const busy = [iv('08:30', '09:00')];
  assert.equal(interval.subtract(schedule, busy, 0).length, 1, '不过滤时应保留 30 分钟碎片');
  assert.equal(interval.subtract(schedule, busy, 45 * MIN).length, 0, '最小 45 分钟时应丢弃该碎片');
  assert.equal(interval.subtract(schedule, busy, 29 * MIN).length, 1, '最小 29 分钟时应保留');
});

test('findFreeSlots：排班 － 占用 的完整链路', () => {
  const from = m('00:00') * MIN;
  const to = m('23:59') * MIN;
  const free = interval.findFreeSlots({
    schedule: [iv('08:00', '12:00'), iv('13:30', '17:00')],
    busy: [iv('10:00', '11:00')],
    from,
    to,
    minMinutes: 30,
  });
  assert.deepEqual(free, [
    iv('08:00', '10:00'),
    iv('11:00', '12:00'),
    iv('13:30', '17:00'),
  ].map((x) => ({ start: x.start, end: x.end })));
});

test('clip / totalDuration：窗口裁剪与总时长统计', () => {
  const clipped = interval.clip([iv('08:00', '18:00')], iv('10:00', '12:00'));
  assert.deepEqual(clipped, [iv('10:00', '12:00')]);
  assert.equal(interval.totalDuration([iv('08:00', '10:00'), iv('09:00', '11:00')]) / MIN, 180, '重叠区间合并后统计');
});

test('isValid：非法区间被安全过滤', () => {
  assert.equal(interval.isValid({ start: 10, end: 5 }), false);
  assert.equal(interval.isValid({ start: 5, end: 5 }), false);
  assert.equal(interval.isValid({ start: 5, end: 10 }), true);
  assert.equal(interval.isValid({ start: NaN, end: 10 }), false);
  assert.equal(interval.merge([{ start: 10, end: 5 }, { start: 1, end: 2 }]).length, 1);
});
