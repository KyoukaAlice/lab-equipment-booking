/**
 * 面向学生 / 教师的页面：工作台、设备预约、我的预约、预约详情、审批中心、候补、通知、个人中心
 */

import { api, downloadWithAuth } from './api.js';
import {
  h,
  clear,
  toast,
  loading,
  emptyState,
  openModal,
  formModal,
  confirmDialog,
  statCard,
  pagination,
  progressBar,
  barChart,
  donutChart,
  heatmap,
  dataTable,
  descList,
  statusTag,
  fmtDateTime,
  fmtDate,
  fmtTime,
  fmtMinutes,
  fmtRelative,
  toDateStr,
  deviceIcon,
  deviceIconClass,
  debounce,
} from './ui.js';

const GRID_MINUTES = 15;
const MS_MIN = 60000;

/* ======================= 通用小部件 ======================= */

function deviceCard(device, { onBook, onDetail }) {
  const card = h('div.card.device-card', [
    h('div.dev-head', [
      h(`div.device-ico.${deviceIconClass(device.category)}`, deviceIcon(device.category)),
      h('div', { style: { minWidth: 0 } }, [
        h('h4', device.name),
        h('div.device-meta', `${device.labName} · ${device.location || '未登记位置'}`),
      ]),
    ]),
    h('div.device-tags', [
      h('span.tag', device.category),
      device.bookable ? h('span.tag.tag-success', '可预约') : h('span.tag.tag-danger', device.statusLabel),
      device.autoApprove ? h('span.tag.tag-info', '免审批') : null,
      device.busyNow ? h('span.tag.tag-warn', '使用中') : null,
      device.model ? h('span.tag', device.model) : null,
    ]),
    h('div.device-meta', [
      device.courseHint ? null : null,
      h('span', `单次时长 ${device.minDurationText} ~ ${device.maxDurationText}`),
    ]),
    h('div.row', { style: { gap: '10px', fontSize: '12.5px' } }, [
      h('span', [h('b', String(device.todayFreeMinutes || 0)), ' 分钟今日空闲']),
      h('span.muted', '·'),
      h('span', [h('b', String(device.todayFreeCount || 0)), ' 个可用时段']),
    ]),
    device.todayFirstSelectable
      ? h('div.small', { style: { color: 'var(--success)' } },
          `今日最早可约：${device.todayFirstSelectable.startClock} - ${device.todayFirstSelectable.endClock}`)
      : h('div.small.muted', '今日暂无可约时段'),
    h('div.device-foot', [
      h('button.btn.btn-primary.btn-sm', {
        disabled: !device.bookable,
        onclick: () => onBook(device),
      }, '预约'),
      h('button.btn.btn-sm', { onclick: () => onDetail(device) }, '查看详情'),
    ]),
  ]);
  return card;
}

function bookingRowActions(booking, { refresh, navigate }) {
  const actions = [];
  const { actions: a } = booking;
  if (a.canReview) {
    actions.push(
      h('button.btn.btn-sm.btn-success', {
        onclick: async () => {
          try {
            await api.approveBooking(booking.id, '');
            toast('已通过该预约', 'success');
            refresh();
          } catch (err) {
            showErr(err);
          }
        },
      }, '通过'),
      h('button.btn.btn-sm.btn-danger', {
        onclick: async () => {
          const reason = await askText('驳回预约', '请填写驳回原因（申请人会收到通知）', '例如：该时段设备需用于教学实验');
          if (reason === null) return;
          try {
            await api.rejectBooking(booking.id, reason);
            toast('已驳回', 'success');
            refresh();
          } catch (err) {
            showErr(err);
          }
        },
      }, '驳回'),
    );
  }
  if (a.canCheckin) {
    actions.push(
      h('button.btn.btn-sm.btn-primary', {
        onclick: async () => {
          const code = await askText('现场签到', `请输入设备现场的 6 位签到码（预约 ${booking.code}）`, '6 位数字');
          if (code === null) return;
          try {
            await api.checkin(booking.id, code);
            toast('签到成功，请规范使用设备', 'success');
            refresh();
          } catch (err) {
            showErr(err);
          }
        },
      }, '签到'),
    );
  }
  if (a.canCheckout) {
    actions.push(
      h('button.btn.btn-sm.btn-warn', {
        onclick: async () => {
          if (!(await confirmDialog('确认已结束使用并归还设备？系统将记录实际使用时长。', { title: '签退确认', okText: '确认签退' }))) return;
          try {
            await api.checkout(booking.id);
            toast('签退成功', 'success');
            refresh();
          } catch (err) {
            showErr(err);
          }
        },
      }, '签退'),
    );
  }
  if (a.canCancel) {
    actions.push(
      h('button.btn.btn-sm', {
        onclick: async () => {
          const reason = await askText('取消预约', '请填写取消原因（临近开始时间取消会记一次违约并扣分）', '例如：课程安排调整');
          if (reason === null) return;
          try {
            await api.cancelBooking(booking.id, reason);
            toast('预约已取消', 'success');
            refresh();
          } catch (err) {
            showErr(err);
          }
        },
      }, '取消'),
    );
  }
  actions.push(h('button.btn.btn-sm.btn-link', { onclick: () => navigate(`#/bookings/${booking.id}`) }, '详情'));
  return h('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } }, actions);
}

function showErr(err) {
  toast(err && err.message ? err.message : '操作失败', 'error', 4200);
}

/** 简易单行文本输入弹窗 */
function askText(title, message, placeholder = '') {
  return new Promise((resolve) => {
    let value = null;
    const input = h('input.input', { placeholder });
    const okBtn = h('button.btn.btn-primary', {
      onclick: () => {
        const v = input.value.trim();
        if (!v) {
          toast('内容不能为空', 'warn');
          return;
        }
        value = v;
        close();
        resolve(v);
      },
    }, '确定');
    const { close } = openModal({
      title,
      body: h('div', [h('p', message), input]),
      footer: [h('button.btn', { onclick: () => { close(); resolve(null); } }, '取消'), okBtn],
      onClose: () => resolve(value),
    });
    setTimeout(() => input.focus(), 50);
  });
}

function bookingTable(bookings, { refresh, navigate, showUser = false }) {
  const columns = [
    { label: '预约编号', render: (b) => h('a', { href: `#/bookings/${b.id}` }, b.code) },
    { label: '设备 / 实验室', render: (b) => h('div', [h('div', b.deviceName), h('div.small.muted', b.labName)]) },
    showUser ? { label: '申请人', render: (b) => h('div', [h('div', b.userName), h('div.small.muted', b.userDepartment)]) } : null,
    { label: '使用时段', render: (b) => h('div', [h('div', `${b.dateText} ${b.timeText}`), h('div.small.muted', b.durationText)]) },
    { label: '用途', render: (b) => h('div', { style: { maxWidth: '190px' } }, b.purpose) },
    { label: '状态', render: (b) => statusTag(b.status, b.statusLabel) },
    { label: '操作', render: (b) => bookingRowActions(b, { refresh, navigate }) },
  ].filter(Boolean);
  return dataTable(columns, bookings, { empty: '暂无预约记录' });
}

/* ======================= 工作台 ======================= */

export async function renderDashboard({ state, navigate, renderRoute }) {
  const wrap = h('div');
  const isStudent = state.user.role === 'student';
  const summary = await api.myBookingSummary();
  const top = h('div.grid.grid-stats');

  top.appendChild(statCard({
    label: isStudent ? '我的在途预约' : '我的在途预约',
    value: summary.ongoing.length + summary.upcoming.length,
    foot: `待审批 ${summary.pendingCount} 条`,
    accent: 'brand',
  }));
  top.appendChild(statCard({
    label: '本周已用额度',
    value: '—',
    foot: '',
    accent: 'info',
  }));
  top.appendChild(statCard({
    label: '当前信用分',
    value: String(state.user.creditScore),
    foot: `等级 ${state.user.credit ? state.user.credit.level : '—'}`,
    accent: Number(state.user.creditScore) >= 75 ? 'success' : 'warn',
  }));
  top.appendChild(statCard({
    label: '未读通知',
    value: String(state.unread),
    foot: state.announcement ? '有系统公告' : '暂无公告',
    accent: 'warn',
  }));
  wrap.appendChild(top);

  // 本周额度单独异步填充，避免阻塞首屏
  api.myQuota().then((quota) => {
    const valueEl = top.children[1].querySelector('.stat-value');
    const footEl = top.children[1].querySelector('.stat-foot');
    if (valueEl) valueEl.textContent = fmtMinutes(quota.usedMinutes);
    if (footEl) footEl.textContent = `额度 ${fmtMinutes(quota.quotaMinutes)}，剩余 ${fmtMinutes(quota.remainingMinutes)}`;
  }).catch(() => {});

  /* 进行中 / 待签到 */
  const ongoingCard = h('div.card', [
    h('div.card-head', [h('h2', '进行中的预约'), h('span.spacer'), h('a.small', { href: '#/bookings' }, '查看全部 →')]),
  ]);
  if (!summary.ongoing.length) {
    ongoingCard.appendChild(emptyState('🕒', '当前没有正在使用的设备'));
  } else {
    for (const b of summary.ongoing) {
      ongoingCard.appendChild(
        h('div.row', { style: { borderBottom: '1px solid var(--line-2)', padding: '10px 0' } }, [
          h('div', { style: { flex: '1 1 220px' } }, [
            h('div', [h('b', b.deviceName), ' ', statusTag(b.status, b.statusLabel)]),
            h('div.small.muted', `${b.dateText} ${b.timeText} · ${b.labName}`),
          ]),
          b.actions.canCheckout
            ? h('button.btn.btn-sm.btn-warn', {
                onclick: async () => {
                  try {
                    await api.checkout(b.id);
                    toast('已签退', 'success');
                    renderRoute();
                  } catch (err) {
                    showErr(err);
                  }
                },
              }, '立即签退')
            : b.checkinCode
              ? h('div', [
                  h('div.small.muted', '签到码'),
                  h('div', { style: { fontFamily: 'monospace', fontSize: '17px', letterSpacing: '2px' } }, b.checkinCode),
                ])
              : null,
          h('button.btn.btn-sm', { onclick: () => navigate(`#/bookings/${b.id}`) }, '详情'),
        ]),
      );
    }
  }
  wrap.appendChild(ongoingCard);

  /* 即将开始 + 待签到 */
  const upcomingCard = h('div.card', [h('div.card-head', [h('h2', '即将开始')])]);
  if (!summary.upcoming.length && !summary.needCheckin.length) {
    upcomingCard.appendChild(emptyState('📅', '近期没有预约安排，去预约设备吧', h('button.btn.btn-primary.btn-sm', { onclick: () => navigate('#/booking') }, '预约设备')));
  } else {
    const rows = [...summary.needCheckin.map((b) => ({ ...b, needCheckin: true })), ...summary.upcoming.filter((b) => !b.actions.canCheckin)];
    for (const b of rows.slice(0, 6)) {
      upcomingCard.appendChild(
        h('div.row', { style: { borderBottom: '1px solid var(--line-2)', padding: '10px 0' } }, [
          h('div', { style: { flex: '1 1 220px' } }, [
            h('div', [h('b', b.deviceName), ' ', statusTag(b.status, b.statusLabel)]),
            h('div.small.muted', `${b.dateText} ${b.timeText} · ${fmtRelative(b.startAt)}开始`),
          ]),
          b.actions.canCheckin
            ? h('button.btn.btn-sm.btn-primary', {
                onclick: async () => {
                  const code = await askText('现场签到', '请输入设备现场的 6 位签到码', '6 位数字');
                  if (code === null) return;
                  try {
                    await api.checkin(b.id, code);
                    toast('签到成功', 'success');
                    renderRoute();
                  } catch (err) {
                    showErr(err);
                  }
                },
              }, '签到')
            : null,
          h('button.btn.btn-sm', { onclick: () => navigate(`#/bookings/${b.id}`) }, '详情'),
        ]),
      );
    }
  }
  wrap.appendChild(upcomingCard);

  /* 推荐设备（按类别热门） */
  const devices = await api.devices({ bookable: 'true', pageSize: 6, sort: 'category' });
  const recommend = h('div.card', [
    h('div.card-head', [
      h('h2', '可预约设备推荐'),
      h('span.spacer'),
      h('button.btn.btn-sm', { onclick: () => navigate('#/booking') }, '进入设备目录'),
    ]),
    h('div.grid.grid-cards', devices.items.slice(0, 6).map((d) => deviceCard(d, {
      onBook: () => navigate(`#/devices/${d.id}`),
      onDetail: () => navigate(`#/devices/${d.id}`),
    }))),
  ]);
  wrap.appendChild(recommend);

  if (state.user.role !== 'student') {
    const review = await api.bookings({ scope: 'todo', pageSize: 6, order: 'start_asc' });
    const reviewCard = h('div.card', [
      h('div.card-head', [
        h('h2', '待我审批'),
        h('span.tag.tag-warn', `${review.total} 条`),
        h('span.spacer'),
        h('button.btn.btn-sm', { onclick: () => navigate('#/review') }, '进入审批中心'),
      ]),
    ]);
    reviewCard.appendChild(bookingTable(review.items, { refresh: renderRoute, navigate, showUser: true }));
    wrap.appendChild(reviewCard);
  }

  void clear;
  return wrap;
}

/* ======================= 设备预约（目录 + 详情） ======================= */

export async function renderDeviceBooking({ params, state, navigate, renderRoute }) {
  if (params && params.id) return renderDeviceDetail({ params, state, navigate, renderRoute });

  const wrap = h('div');
  const [labs, categories] = await Promise.all([api.labs(), api.categories()]);
  const query = {
    page: 1,
    pageSize: 12,
    keyword: '',
    labId: '',
    category: '',
    sort: 'name',
    bookable: 'true',
  };

  const filters = h('div.filters');
  const keywordInput = h('input.input', { placeholder: '搜索设备名称 / 型号 / 序列号' });
  const labSelect = h('select.input', [
    h('option', { value: '' }, '全部实验室'),
    ...labs.items.map((l) => h('option', { value: String(l.id) }, `${l.name}（${l.availableDeviceCount} 台可约）`)),
  ]);
  const catSelect = h('select.input', [
    h('option', { value: '' }, '全部类别'),
    ...categories.items.map((c) => h('option', { value: c.category }, `${c.category}（${c.count}）`)),
  ]);
  const sortSelect = h('select.input', [
    h('option', { value: 'name' }, '按名称排序'),
    h('option', { value: 'category' }, '按类别排序'),
    h('option', { value: 'price_desc' }, '按价值从高到低'),
    h('option', { value: 'price_asc' }, '按价值从低到高'),
  ]);
  const onlyBookable = h('input', { type: 'checkbox' });
  onlyBookable.checked = true;

  filters.appendChild(h('label.field', [h('span', '关键字'), keywordInput]));
  filters.appendChild(h('label.field', [h('span', '实验室'), labSelect]));
  filters.appendChild(h('label.field', [h('span', '类别'), catSelect]));
  filters.appendChild(h('label.field', [h('span', '排序'), sortSelect]));
  filters.appendChild(h('label.field', [h('span', '仅看可预约'), h('div', { style: { paddingTop: '8px' } }, onlyBookable)]));
  filters.appendChild(h('div.filters-actions', [
    h('button.btn.btn-primary', { onclick: () => { query.page = 1; load(); } }, '查询'),
    h('button.btn', {
      onclick: () => {
        keywordInput.value = '';
        labSelect.value = '';
        catSelect.value = '';
        sortSelect.value = 'name';
        onlyBookable.checked = true;
        query.page = 1;
        load();
      },
    }, '重置'),
  ]));

  const summaryCards = h('div.grid.grid-stats');
  const listNode = h('div');
  wrap.appendChild(summaryCards);
  wrap.appendChild(h('div.card', [h('div.card-head', [h('h2', '设备目录')]), filters, listNode]));

  const doLoad = debounce(() => { query.page = 1; load(); }, 350);
  keywordInput.addEventListener('input', () => {
    query.keyword = keywordInput.value.trim();
    doLoad();
  });
  labSelect.addEventListener('change', () => { query.labId = labSelect.value; query.page = 1; load(); });
  catSelect.addEventListener('change', () => { query.category = catSelect.value; query.page = 1; load(); });
  sortSelect.addEventListener('change', () => { query.sort = sortSelect.value; query.page = 1; load(); });
  onlyBookable.addEventListener('change', () => { query.bookable = onlyBookable.checked ? 'true' : ''; query.page = 1; load(); });

  async function load() {
    clear(listNode);
    listNode.appendChild(loading('正在加载设备与可用时段…'));
    try {
      const data = await api.devices({ ...query });
      clear(listNode);
      clear(summaryCards);
      const freeToday = data.items.reduce((s, d) => s + (d.todayFreeMinutes || 0), 0);
      const freeCount = data.items.reduce((s, d) => s + (d.todayFreeCount || 0), 0);
      summaryCards.appendChild(statCard({ label: '符合条件的设备', value: String(data.total), foot: `本页 ${data.items.length} 台`, accent: 'brand' }));
      summaryCards.appendChild(statCard({ label: '本页今日剩余空闲', value: fmtMinutes(freeToday), foot: `${freeCount} 个可用时段`, accent: 'success' }));
      summaryCards.appendChild(statCard({
        label: '正在使用中',
        value: String(data.items.filter((d) => d.busyNow).length),
        foot: '含已通过待签到',
        accent: 'warn',
      }));

      if (!data.items.length) {
        listNode.appendChild(emptyState('🔍', '没有找到符合条件的设备，请调整筛选条件'));
        return;
      }
      const grid = h('div.grid.grid-cards');
      for (const d of data.items) {
        grid.appendChild(deviceCard(d, {
          onBook: () => navigate(`#/devices/${d.id}`),
          onDetail: () => navigate(`#/devices/${d.id}`),
        }));
      }
      listNode.appendChild(grid);
      listNode.appendChild(
        pagination({
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          onChange: (p) => {
            query.page = p;
            load();
          },
        }),
      );
    } catch (err) {
      clear(listNode);
      listNode.appendChild(h('div.alert.alert-danger', err.message));
    }
  }

  await load();
  return wrap;
}

/** 设备详情 + 时段选择 + 预约提交 */
async function renderDeviceDetail({ params, state, navigate, renderRoute }) {
  const deviceId = Number(params.id);
  const wrap = h('div');
  wrap.appendChild(loading('正在计算设备可用时段…'));

  let currentDate = toDateStr(new Date());
  let selection = null; // { start, end }

  const data = await api.deviceAvailability(deviceId, { date: currentDate, days: 7 });
  const device = data.device;
  const rules = data.rules;

  /** 计算时间轴显示区间：取排班范围的最小开始与最大结束，无排班则用 08:00-22:00 */
  function windowOfDays(days) {
    let min = 24 * 60;
    let max = 0;
    for (const day of days) {
      for (const s of day.schedule) {
        const d = new Date(day.date + 'T00:00:00');
        const base = d.getTime();
        min = Math.min(min, Math.round((s.start - base) / MS_MIN));
        max = Math.max(max, Math.round((s.end - base) / MS_MIN));
      }
    }
    if (max <= min) return { start: 8 * 60, end: 22 * 60 };
    return { start: Math.floor(min / 60) * 60, end: Math.ceil(max / 60) * 60 };
  }

  const axis = windowOfDays(data.days);
  const span = axis.end - axis.start;

  const body = h('div');

  /* 设备信息卡 */
  const infoCard = h('div.card', [
    h('div.row', { style: { alignItems: 'flex-start' } }, [
      h(`div.device-ico.${deviceIconClass(device.category)}`, { style: { width: '52px', height: '52px', fontSize: '24px' } }, deviceIcon(device.category)),
      h('div', { style: { flex: '1 1 300px' } }, [
        h('h1', { style: { marginBottom: '2px' } }, device.name),
        h('div.muted', `${device.labName} · ${device.location || '未登记位置'}${device.ownerName ? ` · 负责人 ${device.ownerName}` : ''}`),
        h('div.device-tags', { style: { marginTop: '8px' } }, [
          h('span.tag', device.category),
          device.bookable ? h('span.tag.tag-success', '可预约') : h('span.tag.tag-danger', device.statusLabel),
          device.autoApprove ? h('span.tag.tag-info', '免审批（提交即通过）') : h('span.tag.tag-warn', '需负责人审批'),
          device.checkinRequired ? h('span.tag.tag-purple', '需现场签到') : null,
          device.busyNow ? h('span.tag.tag-warn', '当前使用中') : null,
        ]),
      ]),
      h('div', { style: { textAlign: 'right' } }, [
        h('div.small.muted', '设备价值'),
        h('div', { style: { fontSize: '19px', fontWeight: '700' } }, device.priceText),
        h('div.small.muted', `序列号 ${device.serialNo}`),
      ]),
    ]),
  ]);
  body.appendChild(infoCard);

  /* 规则提示 */
  body.appendChild(
    h('div.alert.alert-info', [
      h('b', '预约规则：'),
      `单次时长 ${device.minDurationText} ~ ${device.maxDurationText}；`,
      `最多提前 ${rules.bookingAdvanceDays} 天；至少提前 ${rules.bookingMinLeadMinutes} 分钟提交；`,
      device.leadMinutes ? `该设备需提前 ${device.leadMinutes} 分钟预约；` : '',
      `签到宽限期 ${state.config.checkinGraceMinutes || 15} 分钟，逾期未签到将记爽约并扣分。`,
    ]),
  );

  /* 时间轴选时段 */
  const timelineCard = h('div.card', [
    h('div.card-head', [
      h('h2', '选择使用时段'),
      h('span.spacer'),
      h('button.btn.btn-sm', {
        onclick: () => {
          const d = new Date(`${data.days[0].date}T00:00:00`);
          d.setDate(d.getDate() - 7);
          currentDate = toDateStr(d);
          renderRoute();
        },
      }, '← 上一周'),
      h('button.btn.btn-sm', {
        onclick: () => {
          const d = new Date(`${data.days[0].date}T00:00:00`);
          d.setDate(d.getDate() + 7);
          currentDate = toDateStr(d);
          renderRoute();
        },
      }, '下一周 →'),
      h('button.btn.btn-sm', { onclick: () => { currentDate = toDateStr(new Date()); renderRoute(); } }, '回到今天'),
    ]),
  ]);

  const pickInfo = h('div.alert.alert-success', { hidden: true });

  function renderTimeline() {
    clear(timelineCard);
    timelineCard.appendChild(h('div.card-head', [
      h('h2', '选择使用时段'),
      h('span.small.muted', `${data.days[0].date} ~ ${data.days[data.days.length - 1].date}（点击时间轴选择开始与结束时刻，每次 15 分钟）`),
    ]));
    timelineCard.appendChild(pickInfo);
    const tl = h('div.timeline');

    for (const day of data.days) {
      const dayBase = new Date(`${day.date}T00:00:00`).getTime();
      const row = h('div.timeline-row');
      const weekdayLabel = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(dayBase).getDay()];
      row.appendChild(h('div.timeline-label', [
        h('div', day.date.slice(5)),
        h('div.small.muted', `${weekdayLabel} · 空闲 ${day.freeMinutes} 分`),
      ]));

      const track = h('div.timeline-track', {
        title: day.closed ? '当日不开放' : '点击选择时段',
      });

      if (day.closed) {
        track.appendChild(h('div.zone.blackout', { style: { left: '0%', width: '100%' } }, '不开放'));
      } else {
        // 空闲块（可点击）
        for (const free of day.free) {
          const startMin = Math.round((free.start - dayBase) / MS_MIN);
          const endMin = Math.round((free.end - dayBase) / MS_MIN);
          const left = ((startMin - axis.start) / span) * 100;
          const width = ((endMin - startMin) / span) * 100;
          if (width <= 0) continue;
          const zone = h('div.free-zone', {
            style: { left: `${left}%`, width: `${width}%` },
            title: `${free.startClock} - ${free.endClock} 空闲（${free.minutes} 分钟）${free.selectable ? '' : '，已过时间不可预约'}`,
          });
          if (free.selectable) {
            zone.addEventListener('click', (e) => {
              e.stopPropagation();
              handlePick(day, free, e);
            });
          } else {
            zone.style.cursor = 'not-allowed';
            zone.style.background = '#eef1f5';
          }
          track.appendChild(zone);
        }
        // 占用块
        for (const occ of day.occupancy) {
          const startMin = Math.round((occ.start - dayBase) / MS_MIN);
          const endMin = Math.round((occ.end - dayBase) / MS_MIN);
          const left = ((startMin - axis.start) / span) * 100;
          const width = ((endMin - startMin) / span) * 100;
          if (width <= 0) continue;
          const isBlackout = occ.kind === 'blackout';
          track.appendChild(
            h('div.zone', {
              class: isBlackout ? 'zone blackout' : `zone booking ${occ.status}${occ.mine ? ' mine' : ''}`,
              style: { left: `${left}%`, width: `${width}%` },
              title: `${fmtTime(occ.start)} - ${fmtTime(occ.end)} ${isBlackout ? occ.title : `${occ.statusLabel}${occ.owner ? ` · ${occ.owner}` : ''}`}`,
            }),
          );
        }
        // 已选区块
        if (selection && toDateStr(new Date(selection.dayBase)) === day.date) {
          const sMin = Math.round((selection.start - dayBase) / MS_MIN);
          const eMin = Math.round((selection.end - dayBase) / MS_MIN);
          track.appendChild(
            h('div.pick', {
              style: {
                left: `${((sMin - axis.start) / span) * 100}%`,
                width: `${((eMin - sMin) / span) * 100}%`,
              },
              title: `${fmtTime(selection.start)} - ${fmtTime(selection.end)}`,
            }),
          );
        }
      }
      row.appendChild(track);
      tl.appendChild(row);
    }

    const hourMarks = h('div.timeline-hours');
    for (let m = axis.start; m <= axis.end; m += 60) {
      hourMarks.appendChild(h('span', `${String(Math.floor(m / 60)).padStart(2, '0')}:00`));
    }
    tl.appendChild(hourMarks);
    tl.appendChild(
      h('div.timeline-legend', [
        h('span', [h('i', { style: { background: '#e8f8ee', border: '1px solid #bbf7d0' } }), '空闲可预约']),
        h('span', [h('i', { style: { background: '#94a3b8' } }), '他人已占用']),
        h('span', [h('i', { style: { background: '#fbbf24' } }), '待审批占用']),
        h('span', [h('i', { style: { background: '#2f6fed' } }), '我的预约']),
        h('span', [h('i', { style: { background: '#16a34a' } }), '使用中']),
        h('span', [h('i', { style: { background: '#cbd5e1' } }), '维护/停机']),
      ]),
    );
    timelineCard.appendChild(tl);
  }

  function handlePick(day, free, event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const minutesFromStart = Math.round((ratio * free.minutes) / GRID_MINUTES) * GRID_MINUTES;
    const dayBase = new Date(`${day.date}T00:00:00`).getTime();
    // 吸附到 15 分钟网格（绝对时间）
    let point = free.start + minutesFromStart * MS_MIN;
    point = Math.round(point / (GRID_MINUTES * MS_MIN)) * GRID_MINUTES * MS_MIN;
    point = Math.min(Math.max(point, free.start), free.end - GRID_MINUTES * MS_MIN);

    if (!selection || selection.dayBase !== dayBase) {
      selection = { dayBase, start: point, end: Math.min(point + 60 * MS_MIN, free.end) };
      toast(`已选择开始时间 ${fmtTime(point)}，请再点击确定结束时间`, 'info', 2600);
    } else {
      const anchor = selection.start;
      const newStart = Math.min(anchor, point);
      const newEnd = Math.max(anchor, point);
      if (newEnd - newStart < rules.minMinutes * MS_MIN) {
        toast(`时长不足 ${device.minDurationText}，请扩大选择范围或重新选择`, 'warn');
        selection = { dayBase, start: point, end: Math.min(point + rules.minMinutes * MS_MIN, free.end) };
      } else {
        selection = { dayBase, start: newStart, end: Math.min(newEnd, free.end) };
      }
    }
    // 保证选择跨在同一个空闲块内，超出的部分裁剪到空闲块边界
    selection.start = Math.max(selection.start, free.start);
    selection.end = Math.min(selection.end, free.end);
    updatePickInfo();
    renderTimeline();
  }

  function updatePickInfo() {
    if (!selection) {
      pickInfo.hidden = true;
      return;
    }
    const minutes = Math.round((selection.end - selection.start) / MS_MIN);
    pickInfo.hidden = false;
    clear(pickInfo);
    pickInfo.appendChild(
      h('div.row', [
        h('div', [
          h('b', `已选时段：${fmtDate(selection.start)} ${fmtTime(selection.start)} - ${fmtTime(selection.end)}`),
          h('div.small', `时长 ${fmtMinutes(minutes)}（限制 ${device.minDurationText} ~ ${device.maxDurationText}）`),
        ]),
        h('span.spacer', { style: { marginLeft: 'auto' } }),
        h('button.btn.btn-primary.btn-sm', { onclick: () => openBookingModal() }, '提交预约申请'),
        h('button.btn.btn-sm', {
          onclick: () => {
            selection = null;
            updatePickInfo();
            renderTimeline();
          },
        }, '清除选择'),
      ]),
    );
  }

  function openBookingModal() {
    if (!selection) {
      toast('请先在时间轴上选择时段', 'warn');
      return;
    }
    const minutes = Math.round((selection.end - selection.start) / MS_MIN);
    if (minutes < rules.minMinutes) {
      toast(`单次预约不得短于 ${device.minDurationText}`, 'warn');
      return;
    }
    if (minutes > rules.maxMinutes) {
      toast(`单次预约不得超过 ${device.maxDurationText}`, 'warn');
      return;
    }
    formModal({
      title: `预约 ${device.name}`,
      submitText: device.autoApprove ? '提交（免审批）' : '提交申请',
      hint: `时段：${fmtDate(selection.start)} ${fmtTime(selection.start)} - ${fmtTime(selection.end)}，共 ${fmtMinutes(minutes)}`,
      fields: [
        { name: 'purpose', label: '使用用途', required: true, type: 'textarea', placeholder: '例如：完成模拟电子技术实验课的信号测量环节', help: '请如实填写，实验室负责人将据此审批（至少 4 个字）' },
        { name: 'courseName', label: '关联课程 / 项目', placeholder: '例如：模拟电子技术实验' },
        { name: 'participants', label: '参与人数', type: 'number', value: 1, min: 1, max: state.config.maxParticipantsPerBooking || 20 },
      ],
      onSubmit: async (values, close) => {
        try {
          const res = await api.createBooking({
            deviceId: device.id,
            startAt: selection.start,
            endAt: selection.end,
            purpose: values.purpose,
            courseName: values.courseName,
            participants: Number(values.participants) || 1,
          });
          close();
          const status = res.booking.status;
          if (status === 'approved') {
            openResultModal(res.booking, true);
          } else {
            openResultModal(res.booking, false);
          }
          selection = null;
          renderRoute();
        } catch (err) {
          if (err && err.code === 'R10') {
            const conflict = await confirmDialog(
              `${err.message}。是否加入候补队列？系统会在时段释放时自动为您补位。`,
              { title: '时段已被占用', okText: '加入候补' },
            );
            if (conflict) {
              try {
                await api.joinWaitlist({
                  deviceId: device.id,
                  startAt: selection.start,
                  endAt: selection.end,
                  purpose: values.purpose,
                });
                close();
                toast('已加入候补队列，有人取消时会自动为您补位', 'success', 4200);
                navigate('#/waitlist');
              } catch (e2) {
                showErr(e2);
              }
            }
            return;
          }
          throw err;
        }
      },
    });
  }

  function openResultModal(booking, autoApproved) {
    openModal({
      title: autoApproved ? '预约成功（免审批）' : '申请已提交',
      body: h('div', [
        h('div.alert', { class: autoApproved ? 'alert-success' : 'alert-info' },
          autoApproved
            ? '该设备免审批，预约已生效，请按时到场签到。'
            : '申请已提交，实验室负责人审批后将通过站内通知告知您结果。'),
        descList([
          ['预约编号', booking.code],
          ['设备', booking.deviceName],
          ['时段', `${booking.dateText} ${booking.timeText}`],
          ['状态', statusTag(booking.status, booking.statusLabel)],
          autoApproved ? ['签到码', h('span.checkin-code', booking.checkinCode || '—')] : null,
        ]),
        autoApproved ? h('p.small.muted', '到达设备现场后，在「我的预约」中点击签到并输入该签到码。') : null,
      ]),
      footer: [
        h('button.btn', { onclick: () => window.print() }, '打印凭证'),
        h('button.btn.btn-primary', { onclick: () => navigate('#/bookings') }, '查看我的预约'),
      ],
    });
  }

  renderTimeline();
  body.appendChild(timelineCard);

  /* 设备档案与统计 */
  const detail = await api.device(deviceId);
  const d = detail.device;
  body.appendChild(
    h('div.split', [
      h('div.card', [
        h('div.card-head', [h('h2', '设备档案')]),
        descList([
          ['设备名称', d.name],
          ['类别 / 型号', `${d.category} / ${d.model || '—'}`],
          ['品牌', d.brand || '—'],
          ['序列号', d.serialNo],
          ['存放位置', d.location || '—'],
          ['所属实验室', `${d.labName}（${d.lab?.location || ''}）`],
          ['负责人', d.ownerName || '—'],
          ['购置日期', d.purchaseDate || '—'],
          ['设备价值', d.priceText],
          ['审批方式', d.autoApprove ? '免审批' : '需实验室负责人审批'],
          ['签到要求', d.checkinRequired ? `需现场签到（宽限 ${state.config.checkinGraceMinutes || 15} 分钟）` : '无需签到'],
          ['单次时长', `${d.minDurationText} ~ ${d.maxDurationText}`],
        ]),
        h('h3', { style: { marginTop: '14px' } }, '设备说明'),
        h('p.muted', d.description || '暂无说明'),
        h('h3', { style: { marginTop: '14px' } }, '每周开放时间'),
        h('div', d.weeklyPattern.map((w) =>
          h('div.row', { style: { gap: '10px', fontSize: '13px' } }, [
            h('span', { style: { width: '48px', color: 'var(--text-3)' } }, w.weekdayLabel),
            h('span', w.ranges.length ? w.ranges.join('、') : '不开放'),
          ]))),
      ]),
      h('div.card', [
        h('div.card-head', [h('h2', '使用统计与计划')]),
        h('div.grid.grid-2', [
          statCard({ label: '累计预约', value: String(d.stats.totalBookings), foot: `已完成 ${d.stats.completedBookings} 次`, accent: 'brand' }),
          statCard({ label: '累计使用时长', value: fmtMinutes(d.stats.totalUsedMinutes), foot: `爽约 ${d.stats.noShowBookings} 次`, accent: 'success' }),
          statCard({ label: '未来预约', value: String(d.stats.upcomingBookings), foot: `候补排队 ${d.stats.waitlistCount} 人`, accent: 'info' }),
          statCard({ label: '当前状态', value: d.statusLabel, foot: d.busyNow ? '正在使用中' : '当前空闲', accent: d.bookable ? 'success' : 'danger' }),
        ]),
        h('h3', { style: { marginTop: '14px' } }, '近期停机 / 不可用计划'),
        d.upcomingBlackouts.length
          ? h('div', d.upcomingBlackouts.map((b) =>
              h('div.row', { style: { borderBottom: '1px solid var(--line-2)', padding: '8px 0' } }, [
                h('div', [
                  h('div', [statusTag('cancelled', b.kindLabel), ' ', b.reason]),
                  h('div.small.muted', `${b.startText} ~ ${b.endText}（${b.durationText}）`),
                ]),
              ])))
          : h('p.muted', '暂无停机计划'),
        h('h3', { style: { marginTop: '14px' } }, '实验室规定'),
        h('div.small.muted', { style: { whiteSpace: 'pre-wrap' } }, d.lab?.rules || '暂无规定'),
      ]),
    ]),
  );

  clear(wrap);
  wrap.appendChild(body);
  return wrap;
}

/* ======================= 我的预约 ======================= */

export async function renderMyBookings({ state, navigate, renderRoute }) {
  const wrap = h('div');
  const isStaff = state.user.canReview || state.user.role === 'admin';
  const tabs = [
    { key: 'auto', label: '全部（可见范围）' },
    { key: 'active', label: '在途' },
    { key: 'history', label: '历史' },
  ];
  if (isStaff) tabs.splice(1, 0, { key: 'todo', label: '待我审批' });

  const query = { page: 1, pageSize: 15, scope: 'auto', keyword: '', from: '', to: '', order: 'start_desc' };

  const keywordInput = h('input.input', { placeholder: '搜索编号 / 设备 / 用途 / 申请人' });
  const fromInput = h('input.input', { type: 'date' });
  const toInput = h('input.input', { type: 'date' });
  const orderSelect = h('select.input', [
    h('option', { value: 'start_desc' }, '按使用时间倒序'),
    h('option', { value: 'start_asc' }, '按使用时间正序'),
    h('option', { value: 'created_desc' }, '按提交时间倒序'),
  ]);

  const filters = h('div.filters', [
    h('label.field', [h('span', '关键字'), keywordInput]),
    h('label.field', [h('span', '开始日期从'), fromInput]),
    h('label.field', [h('span', '到'), toInput]),
    h('label.field', [h('span', '排序'), orderSelect]),
    h('div.filters-actions', [
      h('button.btn.btn-primary', { onclick: () => { query.page = 1; load(); } }, '查询'),
      h('button.btn', {
        onclick: async () => {
          try {
            await downloadWithAuth(api.exportBookingsUrl(query), `预约记录_${toDateStr(new Date())}.csv`);
            toast('已导出 CSV 文件', 'success');
          } catch (err) {
            showErr(err);
          }
        },
      }, '导出 CSV'),
    ]),
  ]);

  const tabsNode = h('div.tabs');
  const listNode = h('div');
  const countsNode = h('div.grid.grid-stats');
  wrap.appendChild(h('div.card', [h('h2', '预约管理'), tabsNode, countsNode, filters, listNode]));

  const tabButtons = tabs.map((t) =>
    h('button.tab', {
      onclick: () => {
        query.scope = t.key;
        query.page = 1;
        load();
      },
    }, t.label),
  );

  function renderTabs(counts) {
    clear(tabsNode);
    for (let i = 0; i < tabs.length; i += 1) {
      const t = tabs[i];
      const active = query.scope === t.key;
      const count = t.key === 'active'
        ? (counts.pending || 0) + (counts.approved || 0) + (counts.checked_in || 0)
        : t.key === 'history'
          ? (counts.completed || 0) + (counts.cancelled || 0) + (counts.rejected || 0) + (counts.no_show || 0)
          : null;
      tabButtons[i].className = `tab${active ? ' active' : ''}`;
      clear(tabButtons[i]);
      tabButtons[i].appendChild(h('span', t.label));
      if (count !== null) tabButtons[i].appendChild(h('span.tab-count', ` ${count}`));
      tabsNode.appendChild(tabButtons[i]);
    }
  }

  async function load() {
    query.keyword = keywordInput.value.trim();
    query.from = fromInput.value;
    query.to = toInput.value;
    query.order = orderSelect.value;
    clear(listNode);
    listNode.appendChild(loading());
    try {
      const data = await api.bookings(query);
      renderTabs(data.counts || {});
      clear(listNode);
      clear(countsNode);
      const counts = data.counts || {};
      countsNode.appendChild(statCard({ label: '待审批', value: String(counts.pending || 0), accent: 'warn' }));
      countsNode.appendChild(statCard({ label: '已通过待使用', value: String(counts.approved || 0), accent: 'brand' }));
      countsNode.appendChild(statCard({ label: '使用中', value: String(counts.checked_in || 0), accent: 'success' }));
      countsNode.appendChild(statCard({ label: '已完成', value: String(counts.completed || 0), accent: 'info' }));
      countsNode.appendChild(statCard({ label: '爽约 / 驳回', value: `${counts.no_show || 0} / ${counts.rejected || 0}`, accent: 'danger' }));
      listNode.appendChild(bookingTable(data.items, { refresh: load, navigate, showUser: isStaff }));
      listNode.appendChild(pagination({ page: data.page, pageSize: data.pageSize, total: data.total, onChange: (p) => { query.page = p; load(); } }));
    } catch (err) {
      clear(listNode);
      listNode.appendChild(h('div.alert.alert-danger', err.message));
    }
  }

  await load();
  void renderRoute;
  return wrap;
}

/* ======================= 预约详情 ======================= */

export async function renderBookingDetail({ params, state, navigate, renderRoute }) {
  const id = Number(params.id);
  const { booking } = await api.booking(id);
  const wrap = h('div');
  const canReview = booking.actions.canReview;

  wrap.appendChild(
    h('div.card', [
      h('div.card-head', [
        h('h1', { style: { margin: 0 } }, booking.code),
        statusTag(booking.status, booking.statusLabel),
        h('span.spacer'),
        h('button.btn.btn-sm', { onclick: () => navigate('#/bookings') }, '返回列表'),
      ]),
      h('div.split', [
        h('div', [
          descList([
            ['设备', h('a', { href: `#/devices/${booking.deviceId}` }, booking.deviceName)],
            ['实验室', `${booking.labName} ${booking.labLocation || ''}`],
            ['使用时段', `${booking.dateText} ${booking.timeText}`],
            ['时长', booking.durationText],
            ['申请人', `${booking.userName}（${booking.userDepartment || '—'}）`],
            ['参与人数', String(booking.participants)],
            ['使用用途', booking.purpose],
            ['关联课程', booking.courseName || '—'],
            ['提交时间', booking.createdText],
            ['审批人', booking.reviewerName || '—'],
            ['审批时间', booking.reviewedText || '—'],
            ['审批意见', booking.reviewNote || booking.rejectReason || '—'],
            ['签到时间', booking.checkedInText || '—'],
            ['签退时间', booking.checkedOutText || '—'],
            ['实际使用', booking.actualText || '—'],
            booking.cancelReason ? ['取消原因', booking.cancelReason] : null,
          ]),
          booking.mine && booking.checkinCode && ['approved', 'checked_in'].includes(booking.status)
            ? h('div.alert.alert-success', { style: { marginTop: '12px' } }, [
                h('div', '现场签到码（仅在预约时段内使用）'),
                h('div.checkin-code', booking.checkinCode),
              ])
            : null,
          booking.violations.length
            ? h('div.alert.alert-danger', { style: { marginTop: '12px' } }, [
                h('b', '该预约关联的违约记录：'),
                h('ul', { style: { margin: '6px 0 0 18px' } }, booking.violations.map((v) =>
                  h('li', `${v.typeLabel}：${v.detail}（扣 ${v.points} 分）`))),
              ])
            : null,
        ]),
        h('div', [
          h('h3', '生命周期'),
          h('div.tl', booking.timeline.map((node) =>
            h(`div.tl-item.${node.key}`, [
              h('div', h('b', node.label)),
              h('div.tl-time', `${node.timeText}${node.by ? ` · ${node.by}` : ''}`),
              node.note ? h('div.small.muted', node.note) : null,
            ]))),
          h('h3', { style: { marginTop: '16px' } }, '可执行操作'),
          h('div.row', [
            booking.actions.canCheckin
              ? h('button.btn.btn-primary', {
                  onclick: async () => {
                    const code = await askText('现场签到', '请输入设备现场的 6 位签到码', '6 位数字');
                    if (code === null) return;
                    try {
                      await api.checkin(booking.id, code);
                      toast('签到成功', 'success');
                      renderRoute();
                    } catch (err) {
                      showErr(err);
                    }
                  },
                }, '签到')
              : null,
            booking.actions.canCheckout
              ? h('button.btn.btn-warn', {
                  onclick: async () => {
                    if (!(await confirmDialog('确认结束使用并归还设备？', { title: '签退确认', okText: '确认签退' }))) return;
                    try {
                      await api.checkout(booking.id);
                      toast('签退成功', 'success');
                      renderRoute();
                    } catch (err) {
                      showErr(err);
                    }
                  },
                }, '签退')
              : null,
            canReview
              ? h('button.btn.btn-success', {
                  onclick: async () => {
                    try {
                      await api.approveBooking(booking.id, '');
                      toast('已通过', 'success');
                      renderRoute();
                    } catch (err) {
                      showErr(err);
                    }
                  },
                }, '审批通过')
              : null,
            canReview
              ? h('button.btn.btn-danger', {
                  onclick: async () => {
                    const reason = await askText('驳回预约', '请填写驳回原因', '例如：设备该时段需用于教学');
                    if (reason === null) return;
                    try {
                      await api.rejectBooking(booking.id, reason);
                      toast('已驳回', 'success');
                      renderRoute();
                    } catch (err) {
                      showErr(err);
                    }
                  },
                }, '驳回')
              : null,
            booking.actions.canCancel
              ? h('button.btn', {
                  onclick: async () => {
                    const reason = await askText('取消预约', `请填写取消原因（开始前 ${booking.cancelDeadlineHours} 小时内取消将记违约）`, '例如：时间冲突');
                    if (reason === null) return;
                    try {
                      await api.cancelBooking(booking.id, reason);
                      toast('已取消', 'success');
                      renderRoute();
                    } catch (err) {
                      showErr(err);
                    }
                  },
                }, '取消预约')
              : null,
          ]),
        ]),
      ]),
    ]),
  );

  if (booking.device) {
    wrap.appendChild(
      h('div.card', [
        h('div.card-head', [h('h2', '设备信息')]),
        descList([
          ['名称', booking.device.name],
          ['类别', booking.device.category],
          ['型号', booking.device.model || '—'],
          ['位置', booking.device.location || '—'],
          ['负责人', booking.device.ownerName || '—'],
        ]),
      ]),
    );
  }
  void state;
  return wrap;
}

/* ======================= 审批中心 ======================= */

export async function renderReview({ state, navigate, renderRoute }) {
  const wrap = h('div');
  const query = { scope: 'todo', page: 1, pageSize: 15, keyword: '', from: '', to: '', order: 'start_asc' };
  const picked = new Set();

  const stats = h('div.grid.grid-stats');
  const tabsNode = h('div.tabs');
  const listNode = h('div');
  const batchBar = h('div.row', { style: { marginBottom: '10px' } });

  const keywordInput = h('input.input', { placeholder: '搜索申请人 / 设备 / 编号' });
  const fromInput = h('input.input', { type: 'date' });
  const toInput = h('input.input', { type: 'date' });
  const filters = h('div.filters', [
    h('label.field', [h('span', '关键字'), keywordInput]),
    h('label.field', [h('span', '开始日期从'), fromInput]),
    h('label.field', [h('span', '到'), toInput]),
    h('div.filters-actions', [h('button.btn.btn-primary', { onclick: () => { query.page = 1; load(); } }, '查询')]),
  ]);

  wrap.appendChild(h('div.card', [h('h2', '审批中心'), h('p.muted', '展示您负责实验室范围内的预约申请与在用情况。同一时段只有一条预约能通过，系统会在审批时再次校验冲突。'), stats, filters, batchBar, tabsNode, listNode]));

  const tabDefs = [
    { key: 'todo', label: '待处理' },
    { key: 'active', label: '在途全部' },
    { key: 'history', label: '历史记录' },
  ];
  const tabButtons = tabDefs.map((t) => h('button.tab', {
    onclick: () => {
      query.scope = t.key;
      query.page = 1;
      picked.clear();
      load();
    },
  }, t.label));

  function renderTabs(counts) {
    clear(tabsNode);
    tabDefs.forEach((t, i) => {
      tabButtons[i].className = `tab${query.scope === t.key ? ' active' : ''}`;
      clear(tabButtons[i]);
      tabButtons[i].appendChild(h('span', t.label));
      const c = t.key === 'todo'
        ? (counts.pending || 0) + (counts.checked_in || 0)
        : t.key === 'active'
          ? (counts.pending || 0) + (counts.approved || 0) + (counts.checked_in || 0)
          : (counts.completed || 0) + (counts.cancelled || 0) + (counts.rejected || 0) + (counts.no_show || 0);
      tabButtons[i].appendChild(h('span.tab-count', ` ${c}`));
      tabsNode.appendChild(tabButtons[i]);
    });
  }

  function renderBatchBar(rows) {
    clear(batchBar);
    const pendingIds = rows.filter((b) => b.status === 'pending').map((b) => b.id);
    batchBar.appendChild(h('span.small.muted', `已选 ${picked.size} 条`));
    batchBar.appendChild(h('button.btn.btn-sm', {
      onclick: () => {
        picked.clear();
        pendingIds.forEach((id) => picked.add(id));
        renderBatchBar(rows);
        markCheckboxes();
      },
    }, '全选本页待审批'));
    batchBar.appendChild(h('button.btn.btn-sm.btn-success', {
      disabled: !picked.size,
      onclick: async () => {
        try {
          const res = await api.batchReview([...picked], 'approve', '批量审批通过');
          toast(`批量审批完成：成功 ${res.succeeded} 条，失败 ${res.failed} 条`, res.failed ? 'warn' : 'success', 4500);
          picked.clear();
          load();
        } catch (err) {
          showErr(err);
        }
      },
    }, '批量通过'));
    batchBar.appendChild(h('button.btn.btn-sm.btn-danger', {
      disabled: !picked.size,
      onclick: async () => {
        const reason = await askText('批量驳回', '请填写统一的驳回原因', '例如：该时段设备需用于教学实验');
        if (reason === null) return;
        try {
          const res = await api.batchReview([...picked], 'reject', reason);
          toast(`批量驳回完成：成功 ${res.succeeded} 条，失败 ${res.failed} 条`, res.failed ? 'warn' : 'success', 4500);
          picked.clear();
          load();
        } catch (err) {
          showErr(err);
        }
      },
    }, '批量驳回'));
  }

  let currentRows = [];
  function markCheckboxes() {
    listNode.querySelectorAll('input[type=checkbox][data-id]').forEach((cb) => {
      cb.checked = picked.has(Number(cb.dataset.id));
    });
  }

  async function load() {
    query.keyword = keywordInput.value.trim();
    query.from = fromInput.value;
    query.to = toInput.value;
    clear(listNode);
    listNode.appendChild(loading());
    try {
      const data = await api.bookings(query);
      currentRows = data.items;
      renderTabs(data.counts || {});
      renderBatchBar(currentRows);
      clear(listNode);
      clear(stats);
      const counts = data.counts || {};
      stats.appendChild(statCard({ label: '待我审批', value: String(counts.pending || 0), accent: 'warn' }));
      stats.appendChild(statCard({ label: '已通过', value: String(counts.approved || 0), accent: 'brand' }));
      stats.appendChild(statCard({ label: '使用中', value: String(counts.checked_in || 0), accent: 'success' }));
      stats.appendChild(statCard({ label: '本页记录', value: String(data.items.length), foot: `共 ${data.total} 条`, accent: 'info' }));

      if (!data.items.length) {
        listNode.appendChild(emptyState('✅', '当前没有需要处理的预约'));
        return;
      }

      const columns = [
        {
          label: '',
          render: (b) => {
            if (b.status !== 'pending') return h('span.muted', '—');
            const cb = h('input', { type: 'checkbox' });
            cb.dataset.id = String(b.id);
            cb.checked = picked.has(b.id);
            cb.addEventListener('change', () => {
              if (cb.checked) picked.add(b.id);
              else picked.delete(b.id);
              renderBatchBar(currentRows);
            });
            return cb;
          },
        },
        { label: '预约编号', render: (b) => h('a', { href: `#/bookings/${b.id}` }, b.code) },
        { label: '申请人', render: (b) => h('div', [h('div', b.userName), h('div.small.muted', `${b.userDepartment || '—'} · 信用 ${b.creditScore ?? '—'}`)]) },
        { label: '设备', render: (b) => h('div', [h('div', b.deviceName), h('div.small.muted', b.labName)]) },
        { label: '使用时段', render: (b) => h('div', [h('div', `${b.dateText} ${b.timeText}`), h('div.small.muted', b.durationText)]) },
        { label: '用途', render: (b) => h('div', { style: { maxWidth: '200px' } }, b.purpose) },
        { label: '状态', render: (b) => statusTag(b.status, b.statusLabel) },
        { label: '操作', render: (b) => bookingRowActions(b, { refresh: load, navigate }) },
      ];
      listNode.appendChild(dataTable(columns, data.items));
      listNode.appendChild(pagination({ page: data.page, pageSize: data.pageSize, total: data.total, onChange: (p) => { query.page = p; load(); } }));
    } catch (err) {
      clear(listNode);
      listNode.appendChild(h('div.alert.alert-danger', err.message));
    }
  }

  await load();
  void state;
  void renderRoute;
  return wrap;
}

/* ======================= 候补队列 ======================= */

export async function renderWaitlist({ state, navigate, renderRoute }) {
  const wrap = h('div');
  const listNode = h('div');
  wrap.appendChild(h('div.card', [
    h('div.card-head', [
      h('h2', '我的候补队列'),
      h('span.spacer'),
      h('button.btn.btn-sm', { onclick: () => navigate('#/booking') }, '去预约设备'),
    ]),
    h('div.alert.alert-info', '当时段被他人占用时可加入候补。系统在有人取消、被驳回或提前签退时，会按排队顺序自动补位，并给您保留一段确认时间；逾期未确认将顺延给下一位。'),
    listNode,
  ]));

  async function load() {
    clear(listNode);
    listNode.appendChild(loading());
    try {
      const data = await api.waitlist({ scope: 'mine', page: 1, pageSize: 50 });
      clear(listNode);
      if (!data.items.length) {
        listNode.appendChild(emptyState('⏳', '您还没有候补记录'));
        return;
      }
      const columns = [
        { label: '设备', render: (w) => h('div', [h('div', w.deviceName), h('div.small.muted', w.labName)]) },
        { label: '期望时段', render: (w) => h('div', [h('div', `${w.dateText} ${w.timeText}`), h('div.small.muted', fmtMinutes(w.durationMinutes))]) },
        { label: '用途', render: (w) => w.purpose || '—' },
        { label: '状态', render: (w) => h('div', [statusTag(w.status === 'promoted' ? 'approved' : w.status === 'waiting' ? 'waitlist' : 'cancelled', w.statusLabel), w.queuePosition ? h('div.small.muted', `第 ${w.queuePosition} 位`) : null]) },
        { label: '申请时间', render: (w) => w.createdText },
        {
          label: '操作',
          render: (w) => h('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } }, [
            w.status === 'promoted'
              ? h('button.btn.btn-sm.btn-primary', {
                  onclick: async () => {
                    try {
                      await api.confirmWaitlist(w.id);
                      toast('补位成功，已生成预约（待审批）', 'success', 4200);
                      renderRoute();
                    } catch (err) {
                      showErr(err);
                    }
                  },
                }, `确认补位（${w.expiresText ? `限至 ${w.expiresText.slice(11)}` : '限时'}）`)
              : null,
            w.status === 'promoted' || w.status === 'waiting'
              ? h('button.btn.btn-sm', {
                  onclick: async () => {
                    if (!(await confirmDialog('确认退出该候补队列？', { title: '退出候补' }))) return;
                    try {
                      await api.leaveWaitlist(w.id);
                      toast('已退出候补', 'success');
                      load();
                    } catch (err) {
                      showErr(err);
                    }
                  },
                }, '退出候补')
              : null,
            h('button.btn.btn-sm.btn-link', { onclick: () => navigate(`#/devices/${w.deviceId}`) }, '查看设备'),
            w.bookingId ? h('button.btn.btn-sm.btn-link', { onclick: () => navigate(`#/bookings/${w.bookingId}`) }, '查看预约') : null,
          ]),
        },
      ];
      listNode.appendChild(dataTable(columns, data.items));
    } catch (err) {
      clear(listNode);
      listNode.appendChild(h('div.alert.alert-danger', err.message));
    }
  }

  await load();
  void state;
  return wrap;
}

/* ======================= 通知中心 ======================= */

export async function renderNotifications({ navigate, renderRoute }) {
  const wrap = h('div');
  const listNode = h('div');
  let onlyUnread = false;

  const unreadBtn = h('button.btn.btn-sm', {
    onclick: () => {
      onlyUnread = !onlyUnread;
      unreadBtn.textContent = onlyUnread ? '显示全部' : '只看未读';
      load();
    },
  }, '只看未读');

  wrap.appendChild(h('div.card', [
    h('div.card-head', [
      h('h2', '通知中心'),
      h('span.spacer'),
      unreadBtn,
      h('button.btn.btn-sm', {
        onclick: async () => {
          try {
            await api.readAllNotifications();
            toast('已全部标记为已读', 'success');
            window.dispatchEvent(new CustomEvent('auth:refresh'));
            load();
          } catch (err) {
            showErr(err);
          }
        },
      }, '全部已读'),
    ]),
    listNode,
  ]));

  async function load() {
    clear(listNode);
    listNode.appendChild(loading());
    try {
      const data = await api.notifications({ onlyUnread, page: 1, pageSize: 50 });
      clear(listNode);
      if (!data.items.length) {
        listNode.appendChild(emptyState('🔔', onlyUnread ? '没有未读通知' : '暂无通知'));
        return;
      }
      for (const n of data.items) {
        listNode.appendChild(
          h('div.row', {
            style: {
              padding: '11px 2px',
              borderBottom: '1px solid var(--line-2)',
              alignItems: 'flex-start',
              background: n.isRead ? 'transparent' : '#f7faff',
            },
          }, [
            h('div', { style: { flex: '1 1 auto' } }, [
              h('div', [
                n.isRead ? null : h('span.tag.tag-danger', '未读'),
                ' ',
                h('b', n.title),
                h('span.small.muted', ` · ${n.createdText}（${fmtRelative(n.createdAt)}）`),
              ]),
              h('div.small', { style: { color: 'var(--text-2)', whiteSpace: 'pre-wrap' } }, n.content),
            ]),
            h('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } }, [
              n.link ? h('button.btn.btn-sm', {
                onclick: async () => {
                  if (!n.isRead) {
                    try {
                      await api.readNotification(n.id);
                    } catch { /* 忽略 */ }
                  }
                  navigate(n.link.replace(/^#/, '#'));
                },
              }, '查看') : null,
              n.isRead ? null : h('button.btn.btn-sm', {
                onclick: async () => {
                  try {
                    await api.readNotification(n.id);
                    load();
                  } catch (err) {
                    showErr(err);
                  }
                },
              }, '标为已读'),
            ]),
          ]),
        );
      }
      void renderRoute;
    } catch (err) {
      clear(listNode);
      listNode.appendChild(h('div.alert.alert-danger', err.message));
    }
  }

  await load();
  return wrap;
}

/* ======================= 个人中心 ======================= */

export async function renderProfile({ state, navigate, renderRoute }) {
  const wrap = h('div');
  const [quota, credit] = await Promise.all([api.myQuota(), api.myCredit({ page: 1, pageSize: 20 })]);
  const u = state.user;

  const profileForm = h('div.grid.grid-2');
  const fields = [
    ['name', '姓名', u.name],
    ['department', '院系 / 部门', u.department],
    ['email', '邮箱', u.email],
    ['phone', '手机号', u.phone],
  ];
  const inputs = {};
  for (const [key, label, value] of fields) {
    const input = h('input.input', { value });
    inputs[key] = input;
    profileForm.appendChild(h('label.field', [h('span', label), input]));
  }

  wrap.appendChild(
    h('div.split', [
      h('div.card', [
        h('div.card-head', [h('h2', '个人资料')]),
        descList([
          ['用户名', u.username],
          ['角色', u.roleLabel],
          ['学号', u.studentNo || '—'],
          ['负责实验室', u.managedLabs.length ? u.managedLabs.map((l) => l.name).join('、') : '—'],
          ['账号状态', statusTag(u.status === 'active' ? 'approved' : 'rejected', u.statusLabel)],
          u.frozenReason ? ['限制原因', u.frozenReason] : null,
          u.frozenUntil ? ['解除时间', fmtDateTime(u.frozenUntil)] : null,
        ]),
        h('div', { style: { marginTop: '14px' } }, [h('h3', '修改资料'), profileForm]),
        h('div.row', { style: { marginTop: '12px' } }, [
          h('button.btn.btn-primary', {
            onclick: async () => {
              try {
                await api.updateProfile({
                  name: inputs.name.value.trim(),
                  department: inputs.department.value.trim(),
                  email: inputs.email.value.trim(),
                  phone: inputs.phone.value.trim(),
                });
                toast('资料已更新', 'success');
                window.dispatchEvent(new CustomEvent('auth:refresh'));
                renderRoute();
              } catch (err) {
                showErr(err);
              }
            },
          }, '保存资料'),
          h('button.btn', {
            onclick: () => {
              formModal({
                title: '修改密码',
                hint: '修改成功后其它设备上的登录将失效，需要重新登录。',
                fields: [
                  { name: 'oldPassword', label: '当前密码', type: 'password', required: true },
                  { name: 'newPassword', label: '新密码', type: 'password', required: true, help: '至少 6 位' },
                  { name: 'confirm', label: '确认新密码', type: 'password', required: true },
                ],
                submitText: '确认修改',
                onSubmit: async (values, close) => {
                  if (values.newPassword !== values.confirm) throw new Error('两次输入的新密码不一致');
                  await api.changePassword(values.oldPassword, values.newPassword);
                  close();
                  toast('密码修改成功', 'success');
                },
              });
            },
          }, '修改密码'),
          h('button.btn', {
            onclick: () => {
              if (!u.managedLabs.length) {
                toast('您当前不是任何实验室的负责人', 'info');
                return;
              }
              openModal({
                title: '我负责的实验室',
                body: h('div', u.managedLabs.map((l) => h('div.row', { style: { padding: '6px 0', borderBottom: '1px solid var(--line-2)' } }, [
                  h('b', l.name),
                  h('span.spacer', { style: { marginLeft: 'auto' } }),
                  h('span.tag', l.code),
                ]))),
              });
            },
          }, '我的实验室'),
        ]),
      ]),
      h('div.card', [
        h('div.card-head', [h('h2', '信用与额度')]),
        h('div.grid.grid-2', [
          statCard({
            label: '当前信用分',
            value: String(credit.summary.creditScore),
            foot: `等级 ${credit.summary.level}，冻结阈值 ${credit.summary.threshold}`,
            accent: credit.summary.creditScore >= 75 ? 'success' : 'warn',
          }),
          statCard({
            label: '近 180 天违约',
            value: String(credit.summary.recentViolations),
            foot: credit.summary.frozen ? '当前处于限制状态' : '状态正常',
            accent: credit.summary.recentViolations ? 'danger' : 'success',
          }),
          statCard({
            label: '本周已用额度',
            value: fmtMinutes(quota.usedMinutes),
            foot: `额度 ${fmtMinutes(quota.quotaMinutes)}，剩余 ${fmtMinutes(quota.remainingMinutes)}`,
            accent: 'brand',
          }),
          statCard({
            label: '在途预约',
            value: `${u.activeBookings} / ${u.activeBookingLimit}`,
            foot: '待审批 + 已通过 + 使用中',
            accent: 'info',
          }),
        ]),
        h('h3', { style: { marginTop: '14px' } }, '信用分变动台账'),
        credit.items.length
          ? dataTable([
              { label: '时间', render: (r) => r.createdText },
              { label: '变动', num: true, render: (r) => h('span', { style: { color: r.changePoints >= 0 ? 'var(--success)' : 'var(--danger)' } }, `${r.changePoints >= 0 ? '+' : ''}${r.changePoints}`) },
              { label: '变动后', num: true, render: (r) => String(r.scoreAfter) },
              { label: '原因', render: (r) => r.reason },
            ], credit.items)
          : emptyState('📗', '暂无信用分变动记录'),
        h('div.row', { style: { marginTop: '10px' } }, [
          h('button.btn.btn-sm', {
            onclick: async () => {
              const v = await api.myViolations({ page: 1, pageSize: 20 });
              openModal({
                title: '我的违约记录',
                wide: true,
                body: v.items.length
                  ? dataTable([
                      { label: '时间', render: (r) => r.createdText },
                      { label: '类型', render: (r) => statusTag('rejected', r.typeLabel) },
                      { label: '扣分', num: true, render: (r) => String(r.points) },
                      { label: '预约', render: (r) => r.bookingCode || '—' },
                      { label: '说明', render: (r) => r.detail },
                    ], v.items)
                  : emptyState('✅', '没有违约记录，请继续保持'),
              });
            },
          }, '查看违约记录'),
        ]),
      ]),
    ]),
  );
  void navigate;
  return wrap;
}

export { fmtMinutes };
