'use strict';

/**
 * 预约状态机与领域规则
 * ------------------------------------------------------------------
 * 状态流转图（毕业设计文档中的「预约生命周期」）：
 *
 *                ┌──────────── reject ──────────► rejected
 *                │
 *   pending ─────┼──────────── approve ─────────► approved ──checkin──► checked_in ──checkout──► completed
 *                │                                  │                      │
 *                │                                  │                      └── 超时未签退 ──► completed(记超时违约)
 *                └──────────── cancel ────────────► cancelled
 *
 *   pending/approved ── 到点未签到（超过宽限期）──► no_show（记爽约违约）
 *   waitlist ── 时段释放后自动补位 ──► pending（等待确认/审批）
 */

const config = require('./config');
const { AppError } = require('../utils/errors');

/** 全部合法状态 */
const STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  WAITLIST: 'waitlist',
  CHECKED_IN: 'checked_in',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  NO_SHOW: 'no_show',
};

const STATUS_LABELS = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  waitlist: '候补中',
  checked_in: '使用中',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '爽约',
};

/** 状态机：from -> 允许迁移到的状态集合 */
const TRANSITIONS = {
  pending: [STATUS.APPROVED, STATUS.REJECTED, STATUS.CANCELLED, STATUS.NO_SHOW],
  approved: [STATUS.CHECKED_IN, STATUS.CANCELLED, STATUS.NO_SHOW],
  checked_in: [STATUS.COMPLETED],
  waitlist: [STATUS.PENDING, STATUS.CANCELLED, STATUS.REJECTED],
  completed: [],
  rejected: [],
  cancelled: [],
  no_show: [],
};

/** 占用设备时段的状态（用于冲突检测：这些状态下的预约会挡住别人） */
function occupyingStatuses() {
  const base = [STATUS.APPROVED, STATUS.CHECKED_IN, STATUS.COMPLETED];
  if (config.bool('pending_blocks_others')) base.push(STATUS.PENDING);
  return base;
}

/** 仍在流转中的状态（用于「我的预约」默认过滤与额度统计） */
const ACTIVE_STATUSES = [STATUS.PENDING, STATUS.APPROVED, STATUS.CHECKED_IN];

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function assertTransition(from, to, actionLabel = '操作') {
  if (!canTransition(from, to)) {
    throw new AppError(
      409,
      'ILLEGAL_TRANSITION',
      `预约当前状态为「${STATUS_LABELS[from] || from}」，无法执行${actionLabel}`,
      { from, to },
    );
  }
}

/**
 * 审批权限：谁可以审批某条预约
 *   - 管理员：全部
 *   - 教师：其负责的实验室下的设备；若设备未指定负责人，则该实验室任何负责人均可
 *   - 学生：不可审批（仅可查看自己的预约）
 * 另外：任何人不得审批自己的预约（避免自审自批）
 */
function canReview(user, booking, device, isLabManager) {
  if (!user) return false;
  if (booking.user_id === user.id) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'teacher') return Boolean(isLabManager) || (device && device.owner_id === user.id);
  return false;
}

/** 是否可以取消：本人 + 待审批/已通过；审批人/管理员可代为取消 */
function canCancel(user, booking, isReviewer) {
  if (ACTIVE_STATUSES.includes(booking.status) === false) return false;
  if (booking.user_id === user.id) return true;
  return Boolean(isReviewer);
}

/** 违约类型与默认扣分 */
const VIOLATION_TYPES = {
  no_show: { label: '爽约未到', configKey: 'default_points_no_show', defaultPoints: 10 },
  late_cancel: { label: '临时取消', configKey: 'default_points_late_cancel', defaultPoints: 5 },
  overtime: { label: '超时占用', configKey: 'default_points_overtime', defaultPoints: 5 },
  damage: { label: '设备损坏', configKey: null, defaultPoints: 20 },
  rule_break: { label: '违规使用', configKey: null, defaultPoints: 10 },
};

function violationPoints(type) {
  const item = VIOLATION_TYPES[type];
  if (!item) return 0;
  if (!item.configKey) return item.defaultPoints;
  return config.num(item.configKey);
}

module.exports = {
  STATUS,
  STATUS_LABELS,
  TRANSITIONS,
  ACTIVE_STATUSES,
  VIOLATION_TYPES,
  occupyingStatuses,
  canTransition,
  assertTransition,
  canReview,
  canCancel,
  violationPoints,
};
