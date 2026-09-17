/**
 * 管理端页面：管理概览、实验室、设备、排班与停机、用户、违约与信用、统计报表、系统配置、审计日志、运行状态
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
  fmtMinutes,
  fmtRelative,
  toDateStr,
  deviceIcon,
  deviceIconClass,
} from './ui.js';

function showErr(err) {
  toast(err && err.message ? err.message : '操作失败', 'error', 4200);
}

/** 日期范围选择器（统计类页面通用） */
function rangePicker({ from, to, onChange, extra = [] }) {
  const fromInput = h('input.input', { type: 'date', value: from });
  const toInput = h('input.input', { type: 'date', value: to });
  const btn = h('button.btn.btn-primary', {
    onclick: () => onChange(fromInput.value, toInput.value),
  }, '应用');
  const quick = (days, label) => h('button.btn.btn-sm', {
    onclick: () => {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - (days - 1));
      fromInput.value = toDateStr(start);
      toInput.value = toDateStr(end);
      onChange(fromInput.value, toInput.value);
    },
  }, label);
  return h('div.filters', [
    h('label.field', [h('span', '开始日期'), fromInput]),
    h('label.field', [h('span', '结束日期'), toInput]),
    ...extra,
    h('div.filters-actions', [btn, quick(7, '近 7 天'), quick(30, '近 30 天'), quick(90, '近 90 天')]),
  ]);
}

/* ======================= 管理概览 ======================= */

export async function renderAdminOverview({ navigate, renderRoute }) {
  const wrap = h('div');
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29);
  let from = toDateStr(start);
  let to = toDateStr(end);
  let labId = '';

  const labs = await api.labs();
  const labSelect = h('select.input', [
    h('option', { value: '' }, '全部实验室'),
    ...labs.items.map((l) => h('option', { value: String(l.id) }, l.name)),
  ]);

  const container = h('div');
  const picker = rangePicker({
    from,
    to,
    extra: [h('label.field', [h('span', '实验室'), labSelect])],
    onChange: (f, t) => {
      from = f;
      to = t;
      load();
    },
  });
  labSelect.addEventListener('change', () => {
    labId = labSelect.value;
    load();
  });

  wrap.appendChild(picker);
  wrap.appendChild(container);

  async function load() {
    clear(container);
    container.appendChild(loading('正在生成统计视图…'));
    try {
      const data = await api.dashboard({ from, to, labId });
      clear(container);
      const o = data.overview;

      /* 概览卡片 */
      const cards = h('div.grid.grid-stats');
      cards.appendChild(statCard({ label: '实验室 / 设备', value: `${o.labs} / ${o.devices.total}`, foot: `可预约 ${o.devices.available} 台，维护中 ${o.devices.maintenance} 台`, accent: 'brand' }));
      cards.appendChild(statCard({ label: '预约总量', value: String(o.bookings.total), foot: `统计区间 ${o.bookings.inRange} 条，今日 ${o.bookings.today} 条`, accent: 'info' }));
      cards.appendChild(statCard({ label: '待审批', value: String(o.bookings.pending), foot: '需及时处理，否则占用时段', accent: 'warn' }));
      cards.appendChild(statCard({ label: '当前使用中', value: String(o.devices.inUseNow), foot: `已签到 ${o.devices.busyNow} 台`, accent: 'success' }));
      cards.appendChild(statCard({ label: '平均利用率', value: `${(o.avgUtilization * 100).toFixed(1)}%`, foot: '已占用时长 / 排班开放时长', accent: 'purple' }));
      cards.appendChild(statCard({ label: '用户', value: String(o.users.total), foot: `学生 ${o.users.students}，冻结 ${o.users.frozen}`, accent: 'danger' }));
      cards.appendChild(statCard({ label: '候补队列', value: String(o.waitlist.active), foot: '等待补位中的申请', accent: 'purple' }));
      container.appendChild(cards);

      /* 趋势 + 时间构成 */
      const trendCard = h('div.card', [
        h('div.card-head', [h('h2', '预约趋势'), h('span.small.muted', `${data.range.fromDate} ~ ${data.range.toDate}`)]),
        barChart(
          data.trend.items.map((d) => ({ label: d.date.slice(5), value: d.total })),
          { formatter: (v) => String(v) },
        ),
      ]);
      const comp = data.composition;
      const compCard = h('div.card', [
        h('div.card-head', [h('h2', '时间段构成')]),
        donutChart([
          { label: '已预约占用', value: fmtMinutes(comp.bookedMinutes), color: '#2f6fed' },
          { label: '空闲可用', value: fmtMinutes(comp.freeMinutes), color: '#16a34a' },
          { label: '维护/停机', value: fmtMinutes(comp.blackoutMinutes), color: '#94a3b8' },
        ], { centerValue: `${(comp.utilization * 100).toFixed(1)}%`, centerLabel: '利用率' }),
      ]);
      container.appendChild(h('div.split-even', [trendCard, compCard]));

      /* 利用率排行 */
      const utilCard = h('div.card', [
        h('div.card-head', [h('h2', '设备利用率排行（Top 12）'), h('span.spacer'), h('button.btn.btn-sm', { onclick: () => navigate('#/admin/reports') }, '完整报表')]),
        dataTable([
          { label: '设备', render: (r) => h('div', [h('div', r.deviceName), h('div.small.muted', `${r.labName} · ${r.category}`)]) },
          { label: '利用率', render: (r) => h('div.row', { style: { minWidth: '150px' } }, [progressBar(r.utilization), h('span.small', `${(r.utilization * 100).toFixed(1)}%`)]) },
          { label: '占用/开放', num: true, render: (r) => `${r.bookedText} / ${r.scheduleText}` },
          { label: '预约次数', num: true, render: (r) => String(r.bookingCount) },
          { label: '爽约', num: true, render: (r) => String(r.noShowCount) },
        ], data.utilization),
      ]);
      container.appendChild(utilCard);

      /* 实验室汇总 */
      const labCard = h('div.card', [
        h('div.card-head', [h('h2', '实验室资源利用对比')]),
        dataTable([
          { label: '实验室', render: (r) => h('div', [h('div', r.labName), h('div.small.muted', r.code)]) },
          { label: '设备数', num: true, render: (r) => String(r.deviceCount) },
          { label: '预约数', num: true, render: (r) => String(r.bookingCount) },
          { label: '利用率', render: (r) => h('div.row', { style: { minWidth: '140px' } }, [progressBar(r.utilization), h('span.small', `${(r.utilization * 100).toFixed(1)}%`)]) },
          { label: '设备利用率差异', num: true, render: (r) => `${(r.deviceUtilizationSpread * 100).toFixed(1)}%` },
          { label: '最热门设备', render: (r) => r.topDevice || '—' },
        ], data.labs),
      ]);
      container.appendChild(labCard);

      /* 热力图 */
      container.appendChild(
        h('div.card', [
          h('div.card-head', [h('h2', '使用时段热力图（星期 × 小时）'), h('span.small.muted', '颜色越深表示该时段累计占用时长越多')]),
          heatmap(data.heatmap.grid, data.heatmap.maxMinutes, data.heatmap.weekdayLabels),
          data.heatmap.peakHours.length
            ? h('div.row', { style: { marginTop: '12px' } }, [
                h('span.small.muted', '高峰时段：'),
                ...data.heatmap.peakHours.map((p) => h('span.tag.tag-warn', `${p.label}（${p.text}）`)),
              ])
            : null,
        ]),
      );

      /* 用户排行与失信 */
      container.appendChild(
        h('div.split', [
          h('div.card', [
            h('div.card-head', [h('h2', '活跃用户排行')]),
            dataTable([
              { label: '用户', render: (r) => h('div', [h('div', r.name), h('div.small.muted', `${r.roleLabel} · ${r.department || '—'}`)]) },
              { label: '预约数', num: true, render: (r) => String(r.totalBookings) },
              { label: '累计时长', num: true, render: (r) => r.minutesText },
              { label: '履约率', num: true, render: (r) => `${(r.fulfillmentRate * 100).toFixed(0)}%` },
              { label: '信用分', num: true, render: (r) => String(r.creditScore) },
            ], data.users.items),
          ]),
          h('div.card', [
            h('div.card-head', [h('h2', '失信关注名单'), h('span.spacer'), h('button.btn.btn-sm', { onclick: () => navigate('#/admin/blacklist') }, '违约管理')]),
            data.users.blacklist.length
              ? dataTable([
                  { label: '用户', render: (r) => r.name },
                  { label: '信用分', num: true, render: (r) => h('span', { style: { color: r.creditScore < 60 ? 'var(--danger)' : 'inherit' } }, String(r.creditScore)) },
                  { label: '爽约', num: true, render: (r) => String(r.noShowCount) },
                  { label: '状态', render: (r) => statusTag(r.userStatus === 'frozen' ? 'rejected' : 'approved', r.userStatus === 'frozen' ? '已冻结' : '正常') },
                ], data.users.blacklist)
              : emptyState('✅', '暂无失信用户'),
          ]),
        ]),
      );
    } catch (err) {
      clear(container);
      container.appendChild(h('div.alert.alert-danger', err.message));
    }
  }

  await load();
  void renderRoute;
  return wrap;
}

/* ======================= 统计报表（管理员/教师） ======================= */

export async function renderAdminReports({ state, navigate }) {
  const wrap = h('div');
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29);
  let from = toDateStr(start);
  let to = toDateStr(end);
  let labId = state.user.role === 'teacher' && state.user.managedLabs.length ? String(state.user.managedLabs[0].id) : '';

  const labs = await api.labs();
  const labSelect = h('select.input', [
    h('option', { value: '' }, state.user.role === 'admin' ? '全部实验室' : '我负责的实验室'),
    ...labs.items
      .filter((l) => state.user.role === 'admin' || state.user.managedLabs.some((m) => m.id === l.id))
      .map((l) => h('option', { value: String(l.id) }, l.name)),
  ]);
  labSelect.value = labId;

  const container = h('div');
  wrap.appendChild(
    rangePicker({
      from,
      to,
      extra: [h('label.field', [h('span', '实验室'), labSelect])],
      onChange: (f, t) => {
        from = f;
        to = t;
        load();
      },
    }),
  );
  labSelect.addEventListener('change', () => {
    labId = labSelect.value;
    load();
  });
  wrap.appendChild(container);

  async function load() {
    clear(container);
    container.appendChild(loading());
    try {
      const [util, labStats, heat, users, comp, trend] = await Promise.all([
        api.utilization({ from, to, labId }),
        api.statsLabs({ from, to }),
        api.heatmap({ from, to, labId }),
        api.statsUsers({ from, to, limit: 30 }),
        api.statsComposition({ from, to, labId }),
        api.statsTrend({ from, to, labId }),
      ]);
      clear(container);

      const totalSchedule = util.items.reduce((s, r) => s + r.scheduleMinutes, 0);
      const totalBooked = util.items.reduce((s, r) => s + r.bookedMinutes, 0);
      const totalBookings = util.items.reduce((s, r) => s + r.bookingCount, 0);
      const totalNoShow = util.items.reduce((s, r) => s + r.noShowCount, 0);
      const cards = h('div.grid.grid-stats');
      cards.appendChild(statCard({ label: '开放总时长', value: fmtMinutes(totalSchedule), foot: `${util.items.length} 台设备`, accent: 'info' }));
      cards.appendChild(statCard({ label: '已占用时长', value: fmtMinutes(totalBooked), foot: `利用率 ${totalSchedule ? ((totalBooked / totalSchedule) * 100).toFixed(1) : '0.0'}%`, accent: 'brand' }));
      cards.appendChild(statCard({ label: '预约次数', value: String(totalBookings), foot: `爽约 ${totalNoShow} 次`, accent: 'warn' }));
      cards.appendChild(statCard({ label: '空闲时长', value: fmtMinutes(comp.freeMinutes), foot: `停机 ${fmtMinutes(comp.blackoutMinutes)}`, accent: 'success' }));
      container.appendChild(cards);

      container.appendChild(h('div.card', [
        h('div.card-head', [h('h2', '预约趋势（按日）')]),
        barChart(trend.items.map((d) => ({ label: d.date.slice(5), value: d.total })), { formatter: (v) => String(v) }),
      ]));

      container.appendChild(h('div.split-even', [
        h('div.card', [
          h('div.card-head', [h('h2', '时间构成')]),
          donutChart([
            { label: '已占用', value: fmtMinutes(comp.bookedMinutes), color: '#2f6fed' },
            { label: '空闲', value: fmtMinutes(comp.freeMinutes), color: '#16a34a' },
            { label: '停机', value: fmtMinutes(comp.blackoutMinutes), color: '#94a3b8' },
          ], { centerValue: `${(comp.utilization * 100).toFixed(1)}%`, centerLabel: '利用率' }),
        ]),
        h('div.card', [
          h('div.card-head', [h('h2', '高峰时段 Top 5')]),
          heat.peakHours.length
            ? h('div.grid', { style: { gap: '8px' } }, heat.peakHours.map((p, i) =>
                h('div.row', [
                  h('span.tag.tag-brand', `No.${i + 1}`),
                  h('span', p.label),
                  h('span.spacer', { style: { marginLeft: 'auto' } }),
                  h('b', p.text),
                ])))
            : emptyState('📉', '统计区间内暂无高峰数据'),
        ]),
      ]));

      const utilCard = h('div.card', [
        h('div.card-head', [
          h('h2', '设备利用率明细'),
          h('span.spacer'),
          h('button.btn.btn-sm', {
            onclick: async () => {
              try {
                await downloadWithAuth(
                  `/api/stats/export/utilization?from=${from}&to=${to}${labId ? `&labId=${labId}` : ''}`,
                  `设备利用率_${from}_${to}.csv`,
                );
                toast('已导出利用率报表', 'success');
              } catch (err) {
                showErr(err);
              }
            },
          }, '导出 CSV'),
          h('button.btn.btn-sm', { onclick: () => window.print() }, '打印'),
        ]),
        dataTable([
          { label: '设备', render: (r) => h('div', [h('div', r.deviceName), h('div.small.muted', `${r.labName} · ${r.category} · ${r.statusLabel}`)]) },
          { label: '利用率', render: (r) => h('div.row', { style: { minWidth: '160px' } }, [progressBar(r.utilization), h('span.small', `${(r.utilization * 100).toFixed(1)}%`)]) },
          { label: '已占用', num: true, render: (r) => r.bookedText },
          { label: '开放时长', num: true, render: (r) => r.scheduleText },
          { label: '日均使用', num: true, render: (r) => `${r.avgMinutesPerDay} 分` },
          { label: '预约/爽约', num: true, render: (r) => `${r.bookingCount} / ${r.noShowCount}` },
          { label: '价值产出比', num: true, render: (r) => (r.valueEfficiency ? `¥${r.valueEfficiency}/分钟` : '—') },
        ], util.items),
      ]);
      container.appendChild(utilCard);

      container.appendChild(h('div.card', [
        h('div.card-head', [h('h2', '实验室资源对比')]),
        dataTable([
          { label: '实验室', render: (r) => h('div', [h('div', r.labName), h('div.small.muted', r.code)]) },
          { label: '设备数', num: true, render: (r) => String(r.deviceCount) },
          { label: '预约数', num: true, render: (r) => String(r.bookingCount) },
          { label: '爽约', num: true, render: (r) => String(r.noShowCount) },
          { label: '利用率', render: (r) => h('div.row', { style: { minWidth: '150px' } }, [progressBar(r.utilization), h('span.small', `${(r.utilization * 100).toFixed(1)}%`)]) },
          { label: '占用/开放', num: true, render: (r) => `${r.bookedText} / ${r.scheduleText}` },
        ], labStats.items),
      ]));

      container.appendChild(h('div.card', [
        h('div.card-head', [h('h2', '使用时段热力图')]),
        heatmap(heat.grid, heat.maxMinutes, heat.weekdayLabels),
      ]));

      container.appendChild(h('div.card', [
        h('div.card-head', [h('h2', '用户使用与履约情况')]),
        dataTable([
          { label: '用户', render: (r) => h('div', [h('div', r.name), h('div.small.muted', `${r.roleLabel} · ${r.department || '—'}`)]) },
          { label: '预约', num: true, render: (r) => String(r.totalBookings) },
          { label: '完成', num: true, render: (r) => String(r.completedCount) },
          { label: '爽约', num: true, render: (r) => String(r.noShowCount) },
          { label: '取消', num: true, render: (r) => String(r.cancelledCount) },
          { label: '累计时长', num: true, render: (r) => r.minutesText },
          { label: '履约率', num: true, render: (r) => `${(r.fulfillmentRate * 100).toFixed(0)}%` },
          { label: '信用分', num: true, render: (r) => String(r.creditScore) },
        ], users.items),
      ]));
    } catch (err) {
      clear(container);
      container.appendChild(h('div.alert.alert-danger', err.message));
    }
  }

  await load();
  void navigate;
  return wrap;
}

/* ======================= 实验室管理 ======================= */

export async function renderAdminLabs({ renderRoute }) {
  const wrap = h('div');
  const listNode = h('div');
  wrap.appendChild(h('div.card', [
    h('div.card-head', [
      h('h2', '实验室与负责人管理'),
      h('span.small.muted', '实验室是设备与排班的归属单位，负责人可审批该实验室下所有设备的预约'),
    ]),
    listNode,
  ]));

  async function staffOptions() {
    const users = await api.adminUsers({ role: 'teacher', pageSize: 100 });
    const admins = await api.adminUsers({ role: 'admin', pageSize: 50 });
    return [...users.items, ...admins.items].map((u) => ({ value: String(u.id), label: `${u.name}（${u.roleLabel}）` }));
  }

  function openLabForm(lab, options) {
    formModal({
      title: lab ? `编辑实验室：${lab.name}` : '新增实验室',
      wide: true,
      fields: [
        { name: 'name', label: '实验室名称', required: true, value: lab ? lab.name : '' },
        { name: 'code', label: '实验室编号', required: true, value: lab ? lab.code : '', placeholder: '如 LAB-EE-101' },
        { name: 'building', label: '楼栋', value: lab ? lab.building : '', placeholder: '如 逸夫楼' },
        { name: 'room', label: '房间号', value: lab ? lab.room : '', placeholder: '如 301' },
        { name: 'capacity', label: '容纳人数', type: 'number', value: lab ? lab.capacity : 30, min: 0 },
        { name: 'openHours', label: '开放时间说明', value: lab ? lab.openHours : '周一至周五 08:00-22:00', placeholder: '展示用文本' },
        { name: 'status', label: '状态', type: 'select', value: lab ? lab.status : 'active', options: [{ value: 'active', label: '开放中' }, { value: 'suspended', label: '已停用' }] },
        { name: 'rules', label: '实验室规定', type: 'textarea', rows: 4, value: lab ? lab.rules : '' },
        {
          name: 'managerIds',
          label: '负责人',
          type: 'select',
          value: '',
          options: [{ value: '', label: '（在下方多选中指定）' }, ...options],
          help: '多选负责人在「用户管理」中维护，或点击下一步在弹窗中勾选',
        },
      ],
      submitText: lab ? '保存' : '创建',
      onSubmit: async (values, close) => {
        const payload = {
          name: values.name,
          code: values.code,
          building: values.building,
          room: values.room,
          capacity: Number(values.capacity) || 0,
          openHours: values.openHours,
          rules: values.rules,
          status: values.status,
        };
        if (lab) {
          await api.updateLab(lab.id, payload);
          toast('实验室信息已更新', 'success');
        } else {
          const res = await api.createLab(payload);
          toast('实验室已创建，请配置负责人与设备', 'success');
          void res;
        }
        close();
        renderRoute();
      },
    });
  }

  async function load() {
    clear(listNode);
    listNode.appendChild(loading());
    try {
      const [labs, options] = await Promise.all([api.adminLabs(), staffOptions()]);
      clear(listNode);
      listNode.appendChild(
        h('div.row', { style: { marginBottom: '12px' } }, [
          h('span.muted', `共 ${labs.items.length} 间实验室`),
          h('span.spacer', { style: { marginLeft: 'auto' } }),
          h('button.btn.btn-primary', { onclick: () => openLabForm(null, options) }, '新增实验室'),
        ]),
      );

    const columns = [
      { label: '实验室', render: (l) => h('div', [h('b', l.name), h('div.small.muted', `${l.code} · ${l.location}`)]) },
      { label: '容量', num: true, render: (l) => String(l.capacity) },
      { label: '设备', num: true, render: (l) => `${l.availableDeviceCount} / ${l.deviceCount} 可约` },
      { label: '负责人', render: (l) => (l.managers.length ? l.managers.map((m) => h('span.tag.tag-brand', m.name)) : h('span.muted', '未指定')) },
      { label: '状态', render: (l) => statusTag(l.status === 'active' ? 'approved' : 'cancelled', l.statusLabel) },
      {
        label: '操作',
        render: (l) => h('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } }, [
          h('button.btn.btn-sm', { onclick: () => openLabForm(l, options) }, '编辑'),
          h('button.btn.btn-sm', {
            onclick: () => {
              const checked = new Set(l.managers.map((m) => String(m.id)));
              const boxes = [];
              const body = h('div', [
                h('p.muted', '勾选该实验室的负责人（可多选，负责人可审批该实验室下所有设备的预约）'),
                h('div.grid', { style: { gap: '6px' } }, options.map((o) => {
                  const cb = h('input', { type: 'checkbox' });
                  cb.checked = checked.has(o.value);
                  boxes.push([o.value, cb]);
                  return h('label.row', { style: { gap: '8px' } }, [cb, h('span', o.label)]);
                })),
              ]);
              const dialog = openModal({
                title: `设置负责人：${l.name}`,
                body,
                footer: [
                  h('button.btn', { onclick: () => dialog.close() }, '取消'),
                  h('button.btn.btn-primary', {
                    onclick: async () => {
                      try {
                        await api.updateLab(l.id, {
                          managerIds: boxes.filter(([, cb]) => cb.checked).map(([id]) => Number(id)),
                        });
                        toast('负责人已更新', 'success');
                        dialog.close();
                        load();
                      } catch (err) {
                        showErr(err);
                      }
                    },
                  }, '保存'),
                ],
              });
            },
          }, '设负责人'),
          h('button.btn.btn-sm.btn-danger', {
            onclick: async () => {
              if (!(await confirmDialog(`确认删除实验室「${l.name}」？删除前需先移除其下设备。`, { title: '删除实验室', danger: true, okText: '删除' }))) return;
              try {
                await api.deleteLab(l.id);
                toast('实验室已删除', 'success');
                load();
              } catch (err) {
                showErr(err);
              }
            },
          }, '删除'),
        ]),
      },
    ];
      listNode.appendChild(dataTable(columns, labs.items));
    } catch (err) {
      clear(listNode);
      listNode.appendChild(h('div.alert.alert-danger', `加载实验室列表失败：${err.message || err}`));
    }
  }

  await load();
  void renderRoute;
  return wrap;
}

/* ======================= 设备管理 ======================= */

export async function renderAdminDevices({ renderRoute }) {
  const wrap = h('div');
  const labs = await api.labs();
  const categories = await api.categories();
  const query = { page: 1, pageSize: 15, keyword: '', labId: '', category: '', status: '' };

  const keywordInput = h('input.input', { placeholder: '设备名称 / 型号 / 序列号' });
  const labSelect = h('select.input', [h('option', { value: '' }, '全部实验室'), ...labs.items.map((l) => h('option', { value: String(l.id) }, l.name))]);
  const catSelect = h('select.input', [h('option', { value: '' }, '全部类别'), ...categories.items.map((c) => h('option', { value: c.category }, c.category))]);
  const statusSelect = h('select.input', [
    h('option', { value: '' }, '全部状态'),
    h('option', { value: 'available' }, '可预约'),
    h('option', { value: 'maintenance' }, '维护中'),
    h('option', { value: 'offline' }, '已停用'),
    h('option', { value: 'scrapped' }, '已报废'),
  ]);

  const listNode = h('div');
  wrap.appendChild(h('div.card', [
    h('h2', '设备资产管理'),
    h('div.filters', [
      h('label.field', [h('span', '关键字'), keywordInput]),
      h('label.field', [h('span', '实验室'), labSelect]),
      h('label.field', [h('span', '类别'), catSelect]),
      h('label.field', [h('span', '状态'), statusSelect]),
      h('div.filters-actions', [
        h('button.btn.btn-primary', { onclick: () => { query.page = 1; load(); } }, '查询'),
        h('button.btn.btn-primary', { onclick: () => openDeviceForm(null) }, '新增设备'),
      ]),
    ]),
    listNode,
  ]));

  async function openDeviceForm(device) {
    const owners = await api.adminUsers({ role: 'teacher', pageSize: 100 });
    const labOptions = labs.items.map((l) => ({ value: String(l.id), label: l.name }));
    const ownerOptions = [{ value: '', label: '（不指定）' }, ...owners.items.map((u) => ({ value: String(u.id), label: `${u.name}（${u.department || '—'}）` }))];
    const catOptions = categories.items.map((c) => c.category);
    const knownCats = [...new Set([...catOptions, '测量仪器', '开发板', '加工设备', '计算设备', '电源设备', '分析仪器', '其他'])];

    formModal({
      title: device ? `编辑设备：${device.name}` : '新增设备',
      wide: true,
      hint: '最小/最大预约时长、审批方式、签到要求会直接影响学生的预约流程与冲突校验。',
      fields: [
        { name: 'name', label: '设备名称', required: true, value: device ? device.name : '' },
        { name: 'labId', label: '所属实验室', type: 'select', required: true, value: device ? String(device.labId) : String(labs.items[0].id), options: labOptions },
        { name: 'category', label: '设备类别', type: 'select', value: device ? device.category : knownCats[0], options: knownCats },
        { name: 'model', label: '型号', value: device ? device.model : '' },
        { name: 'brand', label: '品牌', value: device ? device.brand : '' },
        { name: 'serialNo', label: '序列号', value: device ? device.serialNo : '', placeholder: '留空则自动生成' },
        { name: 'location', label: '存放位置', value: device ? device.location : '' },
        { name: 'priceFen', label: '设备价值（分）', type: 'number', value: device ? device.priceFen : 0, min: 0, help: '例如 9800000 分 = 9.8 万元' },
        { name: 'purchaseDate', label: '购置日期', value: device ? device.purchaseDate : '', placeholder: 'YYYY-MM-DD' },
        {
          name: 'status',
          label: '状态',
          type: 'select',
          value: device ? device.status : 'available',
          options: [
            { value: 'available', label: '可预约' },
            { value: 'maintenance', label: '维护中（不可预约）' },
            { value: 'offline', label: '已停用（不可预约）' },
            { value: 'scrapped', label: '已报废' },
          ],
        },
        { name: 'ownerId', label: '设备负责人', type: 'select', value: device && device.ownerId ? String(device.ownerId) : '', options: ownerOptions },
        { name: 'minMinutes', label: '最短预约（分钟）', type: 'number', value: device ? device.minMinutes : 30, min: 15 },
        { name: 'maxMinutes', label: '最长预约（分钟）', type: 'number', value: device ? device.maxMinutes : 240, min: 15 },
        { name: 'leadMinutes', label: '需提前预约（分钟）', type: 'number', value: device ? device.leadMinutes : 0, min: 0 },
        {
          name: 'autoApprove',
          label: '免审批（提交即通过）',
          type: 'select',
          value: device ? String(device.autoApprove ? 1 : 0) : '0',
          options: [{ value: '0', label: '需实验室负责人审批' }, { value: '1', label: '免审批，直接通过' }],
        },
        {
          name: 'checkinRequired',
          label: '是否需要现场签到',
          type: 'select',
          value: device ? String(device.checkinRequired ? 1 : 0) : '1',
          options: [{ value: '1', label: '需要签到（未签到记爽约）' }, { value: '0', label: '无需签到' }],
        },
        { name: 'description', label: '设备说明', type: 'textarea', rows: 3, value: device ? device.description : '' },
      ],
      submitText: device ? '保存修改' : '创建设备',
      onSubmit: async (values, close) => {
        const payload = {
          name: values.name,
          labId: Number(values.labId),
          category: values.category,
          model: values.model,
          brand: values.brand,
          serialNo: values.serialNo,
          location: values.location,
          priceFen: Number(values.priceFen) || 0,
          purchaseDate: values.purchaseDate,
          status: values.status,
          ownerId: values.ownerId ? Number(values.ownerId) : null,
          minMinutes: Number(values.minMinutes),
          maxMinutes: Number(values.maxMinutes),
          leadMinutes: Number(values.leadMinutes),
          autoApprove: Number(values.autoApprove),
          checkinRequired: Number(values.checkinRequired),
          description: values.description,
        };
        if (device) {
          const res = await api.updateDevice(device.id, payload);
          if (res.warning) toast(res.warning, 'warn', 5000);
          else toast('设备已更新', 'success');
        } else {
          await api.createDevice(payload);
          toast('设备已创建，请记得配置开放排班', 'success', 4200);
        }
        close();
        load();
      },
    });
  }

  async function load() {
    query.keyword = keywordInput.value.trim();
    query.labId = labSelect.value;
    query.category = catSelect.value;
    query.status = statusSelect.value;
    clear(listNode);
    listNode.appendChild(loading());
    try {
      const data = await api.devices(query);
      clear(listNode);
      const columns = [
        { label: '设备', render: (d) => h('div.row', [h(`div.device-ico.${deviceIconClass(d.category)}`, { style: { width: '32px', height: '32px', fontSize: '16px' } }, deviceIcon(d.category)), h('div', [h('div', d.name), h('div.small.muted', `${d.model || '—'} · ${d.serialNo}`)])]) },
        { label: '实验室', render: (d) => d.labName },
        { label: '类别', render: (d) => h('span.tag', d.category) },
        { label: '状态', render: (d) => statusTag(d.status === 'available' ? 'approved' : d.status === 'maintenance' ? 'pending' : 'rejected', d.statusLabel) },
        { label: '审批/签到', render: (d) => h('div.small', [d.autoApprove ? h('span.tag.tag-info', '免审批') : h('span.tag.tag-warn', '需审批'), ' ', d.checkinRequired ? h('span.tag.tag-purple', '需签到') : h('span.tag', '免签到')]) },
        { label: '时长限制', render: (d) => h('div.small', `${d.minDurationText} ~ ${d.maxDurationText}`) },
        { label: '价值', num: true, render: (d) => d.priceText },
        {
          label: '操作',
          render: (d) => h('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } }, [
            h('button.btn.btn-sm', { onclick: () => openDeviceForm(d) }, '编辑'),
            h('button.btn.btn-sm', {
              onclick: async () => {
                const next = d.status === 'available' ? 'maintenance' : 'available';
                if (!(await confirmDialog(`将「${d.name}」状态改为「${next === 'available' ? '可预约' : '维护中'}」？`, { title: '变更设备状态', okText: '确认变更' }))) return;
                try {
                  const res = await api.updateDevice(d.id, { status: next });
                  if (res.warning) toast(res.warning, 'warn', 5000);
                  else toast('状态已更新', 'success');
                  load();
                } catch (err) {
                  showErr(err);
                }
              },
            }, d.status === 'available' ? '转维护' : '恢复可约'),
            h('button.btn.btn-sm.btn-danger', {
              onclick: async () => {
                if (!(await confirmDialog(`确认删除设备「${d.name}」？若存在历史预约将自动改为「已报废」以保留统计记录。`, { title: '删除设备', danger: true, okText: '删除' }))) return;
                try {
                  const res = await api.deleteDevice(d.id);
                  toast(res.message, 'success', 4500);
                  load();
                } catch (err) {
                  showErr(err);
                }
              },
            }, '删除'),
          ]),
        },
      ];
      listNode.appendChild(dataTable(columns, data.items));
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

/* ======================= 排班与停机 ======================= */

export async function renderAdminSchedule({ renderRoute }) {
  const wrap = h('div');
  const labs = await api.labs();
  const devices = await api.devices({ pageSize: 200 });

  let currentLabId = String(labs.items[0] ? labs.items[0].id : '');
  const container = h('div');

  const labSelect = h('select.input', labs.items.map((l) => h('option', { value: String(l.id) }, `${l.name}（${l.code}）`)));
  labSelect.addEventListener('change', () => {
    currentLabId = labSelect.value;
    load();
  });

  wrap.appendChild(h('div.card', [
    h('div.card-head', [
      h('h2', '排班与停机管理'),
      h('span.spacer'),
      h('label.field', { style: { minWidth: '220px' } }, [h('span', '实验室'), labSelect]),
    ]),
    h('div.alert.alert-info', '排班决定设备每周可被预约的时间池；若某设备配置了「设备级排班」，则该设备不再使用实验室级排班。停机计划（维护/校准/假期）会参与冲突校验，期间设备无法预约。'),
    container,
  ]));

  async function load() {
    clear(container);
    container.appendChild(loading());
    const labId = Number(currentLabId);
    const labDevices = devices.items.filter((d) => d.labId === labId);
    const [slots, blackouts] = await Promise.all([
      api.slots({ labId }),
      api.blackouts({ labId, pageSize: 50 }),
    ]);
    clear(container);

    /* 实验室级排班 */
    const labSlots = slots.items.filter((s) => s.scope === 'lab');
    const labSlotCard = h('div.card', [
      h('div.card-head', [
        h('h3', '实验室默认排班'),
        h('span.spacer'),
        h('button.btn.btn-sm.btn-primary', {
          onclick: () => openSlotForm(null, labId, null),
        }, '新增时段'),
      ]),
    ]);
    const grouped = {};
    for (const s of labSlots) {
      grouped[s.weekday] = grouped[s.weekday] || [];
      grouped[s.weekday].push(s);
    }
    labSlotCard.appendChild(
      h('div', [1, 2, 3, 4, 5, 6, 0].map((wd) => {
        const items = (grouped[wd] || []).sort((a, b) => a.startMin - b.startMin);
        return h('div.row', { style: { padding: '7px 0', borderBottom: '1px solid var(--line-2)' } }, [
          h('span', { style: { width: '52px', color: 'var(--text-3)' } }, ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][wd]),
          h('div.row', { style: { flex: 1, gap: '6px' } }, items.length
            ? items.map((s) => h('span.row', { style: { gap: '4px' } }, [
                h(`span.tag.${s.enabled ? 'tag-brand' : ''}`, `${s.startClock}-${s.endClock}${s.enabled ? '' : '（停用）'}`),
                h('button.btn.btn-sm.btn-link', { onclick: () => openSlotForm(s, labId, null) }, '改'),
                h('button.btn.btn-sm.btn-link', {
                  onclick: async () => {
                    if (!(await confirmDialog('确认删除该排班时段？', { title: '删除排班', danger: true, okText: '删除' }))) return;
                    try {
                      await api.deleteSlot(s.id);
                      toast('已删除', 'success');
                      load();
                    } catch (err) {
                      showErr(err);
                    }
                  },
                }, '删'),
              ]))
            : [h('span.muted.small', '不开放')]),
        ]);
      })),
    );
    container.appendChild(labSlotCard);

    /* 设备级例外排班 */
    const deviceSlotCard = h('div.card', [
      h('div.card-head', [
        h('h3', '设备级例外排班'),
        h('span.small.muted', '（配置后该设备将忽略实验室默认排班）'),
        h('span.spacer'),
        h('button.btn.btn-sm', {
          onclick: () => {
            if (!labDevices.length) {
              toast('该实验室还没有设备', 'warn');
              return;
            }
            openSlotForm(null, labId, labDevices[0].id);
          },
        }, '新增设备排班'),
      ]),
    ]);
    const deviceSlots = slots.items.filter((s) => s.scope === 'device');
    deviceSlotCard.appendChild(
      deviceSlots.length
        ? dataTable([
            { label: '设备', render: (s) => s.deviceName },
            { label: '星期', render: (s) => s.weekdayLabel },
            { label: '时段', render: (s) => `${s.startClock} - ${s.endClock}` },
            { label: '状态', render: (s) => statusTag(s.enabled ? 'approved' : 'cancelled', s.enabled ? '生效中' : '已停用') },
            {
              label: '操作',
              render: (s) => h('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } }, [
                h('button.btn.btn-sm', { onclick: () => openSlotForm(s, labId, s.deviceId) }, '编辑'),
                h('button.btn.btn-sm', {
                  onclick: async () => {
                    try {
                      await api.updateSlot(s.id, { enabled: s.enabled ? 0 : 1 });
                      toast('已更新', 'success');
                      load();
                    } catch (err) {
                      showErr(err);
                    }
                  },
                }, s.enabled ? '停用' : '启用'),
                h('button.btn.btn-sm.btn-danger', {
                  onclick: async () => {
                    if (!(await confirmDialog('确认删除该设备排班？', { title: '删除排班', danger: true, okText: '删除' }))) return;
                    try {
                      await api.deleteSlot(s.id);
                      toast('已删除', 'success');
                      load();
                    } catch (err) {
                      showErr(err);
                    }
                  },
                }, '删除'),
              ]),
            },
          ], deviceSlots)
        : h('p.muted', '该实验室暂无设备级排班，所有设备使用实验室默认排班。'),
    );
    container.appendChild(deviceSlotCard);

    /* 停机计划 */
    const blackoutCard = h('div.card', [
      h('div.card-head', [
        h('h3', '停机 / 封闭计划'),
        h('span.spacer'),
        h('button.btn.btn-sm.btn-primary', {
          onclick: () => openBlackoutForm(labId, labDevices),
        }, '新增停机计划'),
      ]),
    ]);
    blackoutCard.appendChild(
      blackouts.items.length
        ? dataTable([
            { label: '范围', render: (b) => h('div', [h('div', b.scopeLabel === '指定设备' ? b.deviceName : '全实验室'), h('div.small.muted', b.scopeLabel)]) },
            { label: '类型', render: (b) => h('span.tag.tag-warn', b.kindLabel) },
            { label: '时间', render: (b) => h('div', [h('div', `${b.startText}`), h('div.small.muted', `至 ${b.endText}（${b.durationText}）`)]) },
            { label: '原因', render: (b) => b.reason },
            { label: '创建人', render: (b) => b.creatorName || '—' },
            {
              label: '操作',
              render: (b) => h('button.btn.btn-sm.btn-danger', {
                onclick: async () => {
                  if (!(await confirmDialog('确认删除该停机计划？设备将恢复可预约。', { title: '删除停机计划', danger: true, okText: '删除' }))) return;
                  try {
                    await api.deleteBlackout(b.id);
                    toast('已删除', 'success');
                    load();
                  } catch (err) {
                    showErr(err);
                  }
                },
              }, '删除'),
            },
          ], blackouts.items)
        : h('p.muted', '暂无停机计划。'),
    );
    container.appendChild(blackoutCard);
  }

  function openSlotForm(slot, labId, deviceId) {
    const labDevices = devices.items.filter((d) => d.labId === labId);
    formModal({
      title: slot ? '编辑排班时段' : '新增排班时段',
      fields: [
        {
          name: 'deviceId',
          label: '适用范围',
          type: 'select',
          value: deviceId ? String(deviceId) : '',
          options: [{ value: '', label: '整个实验室（默认排班）' }, ...labDevices.map((d) => ({ value: String(d.id), label: `仅设备：${d.name}` }))],
          help: '设备级排班优先于实验室默认排班',
        },
        {
          name: 'weekday',
          label: '星期',
          type: 'select',
          value: slot ? String(slot.weekday) : '1',
          options: [1, 2, 3, 4, 5, 6, 0].map((wd) => ({ value: String(wd), label: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][wd] })),
        },
        { name: 'start', label: '开始时间', value: slot ? slot.startClock : '08:00', placeholder: 'HH:mm', required: true },
        { name: 'end', label: '结束时间', value: slot ? slot.endClock : '12:00', placeholder: 'HH:mm', required: true },
      ],
      submitText: '保存',
      onSubmit: async (values, close) => {
        const payload = {
          labId,
          deviceId: values.deviceId ? Number(values.deviceId) : null,
          weekday: Number(values.weekday),
          start: values.start,
          end: values.end,
        };
        if (slot) {
          await api.updateSlot(slot.id, { start: values.start, end: values.end });
          toast('排班已更新', 'success');
        } else {
          await api.createSlot(payload);
          toast('排班已新增', 'success');
        }
        close();
        load();
      },
    });
  }

  function openBlackoutForm(labId, labDevices) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    formModal({
      title: '新增停机 / 封闭计划',
      wide: true,
      hint: '提交后会统计受影响的在途预约，并自动通知相关申请人。',
      fields: [
        {
          name: 'deviceId',
          label: '影响范围',
          type: 'select',
          value: '',
          options: [{ value: '', label: '整个实验室（全部设备）' }, ...labDevices.map((d) => ({ value: String(d.id), label: d.name }))],
        },
        {
          name: 'kind',
          label: '类型',
          type: 'select',
          value: 'maintenance',
          options: [
            { value: 'maintenance', label: '设备维护' },
            { value: 'calibration', label: '计量校准' },
            { value: 'holiday', label: '假期封闭' },
            { value: 'event', label: '活动占用' },
            { value: 'other', label: '其他' },
          ],
        },
        { name: 'startAt', label: '开始时间', type: 'datetime-local', value: fmt(now), required: true },
        { name: 'endAt', label: '结束时间', type: 'datetime-local', value: fmt(new Date(now.getTime() + 4 * 3600 * 1000)), required: true },
        { name: 'reason', label: '原因说明', required: true, placeholder: '例如：激光切割机冷却系统维护' },
      ],
      submitText: '创建',
      onSubmit: async (values, close) => {
        const res = await api.createBlackout({
          labId,
          deviceId: values.deviceId ? Number(values.deviceId) : null,
          kind: values.kind,
          startAt: values.startAt.replace('T', ' '),
          endAt: values.endAt.replace('T', ' '),
          reason: values.reason,
        });
        close();
        if (res.affectedBookings > 0) {
          toast(`停机计划已创建，有 ${res.affectedBookings} 条在途预约受影响并已通知申请人`, 'warn', 5200);
        } else {
          toast('停机计划已创建', 'success');
        }
        load();
      },
    });
  }

  await load();
  void renderRoute;
  return wrap;
}

/* ======================= 用户管理 ======================= */

export async function renderAdminUsers({ renderRoute }) {
  const wrap = h('div');
  const labs = await api.labs();
  const query = { page: 1, pageSize: 15, keyword: '', role: '', status: '' };

  const keywordInput = h('input.input', { placeholder: '用户名 / 姓名 / 院系 / 学号' });
  const roleSelect = h('select.input', [
    h('option', { value: '' }, '全部角色'),
    h('option', { value: 'student' }, '学生'),
    h('option', { value: 'teacher' }, '教师'),
    h('option', { value: 'admin' }, '管理员'),
  ]);
  const statusSelect = h('select.input', [
    h('option', { value: '' }, '全部状态'),
    h('option', { value: 'active' }, '正常'),
    h('option', { value: 'frozen' }, '已冻结'),
    h('option', { value: 'disabled' }, '已停用'),
  ]);

  const listNode = h('div');
  wrap.appendChild(h('div.card', [
    h('h2', '用户与权限管理'),
    h('div.filters', [
      h('label.field', [h('span', '关键字'), keywordInput]),
      h('label.field', [h('span', '角色'), roleSelect]),
      h('label.field', [h('span', '状态'), statusSelect]),
      h('div.filters-actions', [
        h('button.btn.btn-primary', { onclick: () => { query.page = 1; load(); } }, '查询'),
        h('button.btn.btn-primary', { onclick: () => openUserForm(null) }, '新增用户'),
      ]),
    ]),
    listNode,
  ]));

  function openUserForm(user) {
    const labOptions = labs.items.map((l) => ({ value: String(l.id), label: l.name }));
    formModal({
      title: user ? `编辑用户：${user.name}` : '新增用户',
      wide: true,
      hint: user ? '修改角色、周额度或重置密码会立即影响该用户的预约权限。' : '可创建教师/管理员账号；学生也可自助注册。',
      fields: [
        { name: 'username', label: '用户名', required: !user, value: user ? user.username : '', placeholder: '字母开头，3-30 位' },
        { name: 'name', label: '姓名', required: true, value: user ? user.name : '' },
        {
          name: 'role',
          label: '角色',
          type: 'select',
          value: user ? user.role : 'student',
          options: [
            { value: 'student', label: '学生（可预约、可候补）' },
            { value: 'teacher', label: '教师（可审批所辖实验室预约）' },
            { value: 'admin', label: '管理员（全部权限）' },
          ],
        },
        { name: 'department', label: '院系 / 部门', value: user ? user.department : '' },
        { name: 'studentNo', label: '学号 / 工号', value: user ? user.studentNo : '' },
        { name: 'email', label: '邮箱', value: user ? user.email : '' },
        { name: 'phone', label: '手机号', value: user ? user.phone : '' },
        { name: 'weeklyQuotaMin', label: '每周预约额度（分钟）', type: 'number', value: user ? user.weeklyQuotaMinutes : 240, min: 0, help: '0 表示不允许预约' },
        { name: 'password', label: user ? '重置密码（留空则不修改）' : '初始密码', type: 'password', value: '', help: '至少 6 位' },
      ],
      submitText: user ? '保存' : '创建',
      onSubmit: async (values, close) => {
        if (user) {
          const payload = {
            name: values.name,
            role: values.role,
            department: values.department,
            studentNo: values.studentNo,
            email: values.email,
            phone: values.phone,
            weeklyQuotaMin: Number(values.weeklyQuotaMin) || 0,
          };
          if (values.password) payload.password = values.password;
          await api.updateUser(user.id, payload);
          toast('用户信息已更新', 'success');
        } else {
          if (!values.password) throw new Error('请填写初始密码');
          await api.createUser({
            username: values.username,
            name: values.name,
            role: values.role,
            department: values.department,
            studentNo: values.studentNo,
            email: values.email,
            phone: values.phone,
            weeklyQuotaMin: Number(values.weeklyQuotaMin) || 0,
            password: values.password,
          });
          toast('用户已创建', 'success');
        }
        close();
        load();
      },
    });
    void labOptions;
  }

  async function load() {
    query.keyword = keywordInput.value.trim();
    query.role = roleSelect.value;
    query.status = statusSelect.value;
    clear(listNode);
    listNode.appendChild(loading());
    try {
      const data = await api.adminUsers(query);
      clear(listNode);
      const columns = [
        { label: '用户', render: (u) => h('div', [h('b', u.name), h('div.small.muted', `@${u.username} · ${u.studentNo || '—'}`)]) },
        { label: '角色', render: (u) => h('span', { class: `tag ${u.role === 'admin' ? 'tag-danger' : u.role === 'teacher' ? 'tag-brand' : ''}` }, u.roleLabel) },
        { label: '院系', render: (u) => u.department || '—' },
        { label: '信用分', num: true, render: (u) => h('span', { style: { color: u.creditScore < 60 ? 'var(--danger)' : 'inherit' } }, String(u.creditScore)) },
        { label: '预约 / 违约', num: true, render: (u) => `${u.bookingCount} / ${u.violationCount}` },
        { label: '周额度', num: true, render: (u) => fmtMinutes(u.weeklyQuotaMinutes) },
        { label: '状态', render: (u) => statusTag(u.status === 'active' ? 'approved' : u.status === 'frozen' ? 'pending' : 'rejected', u.statusLabel) },
        {
          label: '操作',
          render: (u) => h('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } }, [
            h('button.btn.btn-sm', { onclick: () => openUserForm(u) }, '编辑'),
            u.status === 'frozen'
              ? h('button.btn.btn-sm.btn-success', {
                  onclick: async () => {
                    try {
                      await api.freezeUser(u.id, { action: 'unfreeze', reason: '管理员解除限制' });
                      toast(`${u.name} 的预约权限已恢复`, 'success');
                      load();
                    } catch (err) {
                      showErr(err);
                    }
                  },
                }, '解冻')
              : h('button.btn.btn-sm.btn-warn', {
                  onclick: () => {
                    formModal({
                      title: `冻结预约权限：${u.name}`,
                      fields: [
                        { name: 'reason', label: '冻结原因', required: true, value: '多次爽约，暂停预约权限' },
                        { name: 'days', label: '冻结天数', type: 'number', value: 30, min: 1, max: 365 },
                      ],
                      submitText: '确认冻结',
                      onSubmit: async (values, close) => {
                        await api.freezeUser(u.id, { action: 'freeze', reason: values.reason, days: Number(values.days) });
                        toast('已冻结该用户的预约权限', 'success');
                        close();
                        load();
                      },
                    });
                  },
                }, '冻结'),
            h('button.btn.btn-sm', {
              onclick: async () => {
                if (!(await confirmDialog(`确认${u.status === 'disabled' ? '启用' : '停用'}账号「${u.name}」？${u.status === 'disabled' ? '' : '停用后该用户将无法登录。'}`, { title: '账号状态变更', danger: u.status !== 'disabled', okText: '确认' }))) return;
                try {
                  await api.toggleUserDisable(u.id);
                  toast('账号状态已更新', 'success');
                  load();
                } catch (err) {
                  showErr(err);
                }
              },
            }, u.status === 'disabled' ? '启用' : '停用'),
            h('button.btn.btn-sm.btn-link', {
              onclick: () => {
                formModal({
                  title: `重置密码：${u.name}`,
                  fields: [{ name: 'password', label: '新密码', required: true, type: 'password', help: '至少 6 位，重置后该用户需重新登录' }],
                  submitText: '确认重置',
                  onSubmit: async (values, close) => {
                    const res = await api.resetUserPassword(u.id, values.password);
                    toast(res.message, 'success');
                    close();
                  },
                });
              },
            }, '重置密码'),
          ]),
        },
      ];
      listNode.appendChild(dataTable(columns, data.items));
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

/* ======================= 违约与信用 ======================= */

export async function renderAdminBlacklist({ renderRoute }) {
  const wrap = h('div');
  const statsNode = h('div.grid.grid-stats');
  const listNode = h('div');
  let typeFilter = '';

  const typeSelect = h('select.input', [
    h('option', { value: '' }, '全部违约类型'),
    h('option', { value: 'no_show' }, '爽约未到'),
    h('option', { value: 'late_cancel' }, '临时取消'),
    h('option', { value: 'overtime' }, '超时占用'),
    h('option', { value: 'damage' }, '设备损坏'),
    { value: 'rule_break', label: '违规使用' },
  ]);

  wrap.appendChild(h('div.card', [
    h('h2', '违约记录与信用管理'),
    h('p.muted', '系统会在「超过签到宽限期未签到」时自动记爽约、在「临近开始时间取消」时自动记临时取消、在「超时占用」时自动记超时；也可在此手工登记设备损坏等违约。撤销违约会自动返还信用分。'),
    statsNode,
    h('div.filters', [
      h('label.field', [h('span', '违约类型'), typeSelect]),
      h('div.filters-actions', [
        h('button.btn.btn-primary', { onclick: () => { load(); } }, '筛选'),
        h('button.btn.btn-primary', { onclick: () => openViolationForm() }, '手工登记违约'),
      ]),
    ]),
    listNode,
  ]));

  typeSelect.addEventListener('change', () => {
    typeFilter = typeSelect.value;
    load();
  });

  async function openViolationForm() {
    const users = await api.adminUsers({ pageSize: 200 });
    formModal({
      title: '手工登记违约',
      hint: '用于设备损坏、违规使用等需要人工判定的场景；提交后立即扣减信用分并通知本人。',
      fields: [
        {
          name: 'userId',
          label: '用户',
          type: 'select',
          required: true,
          options: users.items.map((u) => ({ value: String(u.id), label: `${u.name}（${u.roleLabel} · 信用 ${u.creditScore}）` })),
        },
        {
          name: 'type',
          label: '违约类型',
          type: 'select',
          value: 'damage',
          options: [
            { value: 'damage', label: '设备损坏（默认扣 20 分）' },
            { value: 'rule_break', label: '违规使用（默认扣 10 分）' },
            { value: 'overtime', label: '超时占用（默认扣 5 分）' },
            { value: 'no_show', label: '爽约未到（默认扣 10 分）' },
            { value: 'late_cancel', label: '临时取消（默认扣 5 分）' },
          ],
        },
        { name: 'points', label: '扣分', type: 'number', value: 20, min: 1, max: 100 },
        { name: 'detail', label: '情况说明', required: true, type: 'textarea', rows: 3, placeholder: '例如：归还示波器时发现探头破损，需更换' },
      ],
      submitText: '登记并扣分',
      onSubmit: async (values, close) => {
        const res = await api.createViolation({
          userId: Number(values.userId),
          type: values.type,
          points: Number(values.points),
          detail: values.detail,
        });
        toast(`已登记违约，扣 ${res.points} 分，该用户当前信用分 ${res.creditScore}`, 'success', 4800);
        close();
        load();
      },
    });
  }

  async function load() {
    clear(listNode);
    listNode.appendChild(loading());
    try {
      const data = await api.violations({ page: 1, pageSize: 50, type: typeFilter });
      clear(listNode);
      clear(statsNode);
      statsNode.appendChild(statCard({ label: '违约记录总数', value: String(data.total), accent: 'danger' }));
      for (const s of data.stats) {
        statsNode.appendChild(statCard({ label: s.label, value: String(s.count), foot: `累计扣 ${s.points} 分`, accent: 'warn' }));
      }
      const columns = [
        { label: '时间', render: (v) => v.createdText },
        { label: '用户', render: (v) => h('b', v.userName) },
        { label: '类型', render: (v) => statusTag('rejected', v.typeLabel) },
        { label: '扣分', num: true, render: (v) => h('span', { style: { color: 'var(--danger)' } }, `-${v.points}`) },
        { label: '关联预约', render: (v) => (v.bookingCode ? h('a', { href: `#/bookings/${v.bookingId}` }, v.bookingCode) : '—') },
        { label: '说明', render: (v) => v.detail },
        { label: '登记人', render: (v) => v.creatorName || '系统' },
        {
          label: '操作',
          render: (v) => h('button.btn.btn-sm', {
            onclick: async () => {
              if (!(await confirmDialog(`确认撤销该违约记录并返还 ${v.points} 分信用分？`, { title: '撤销违约', okText: '确认撤销' }))) return;
              try {
                const res = await api.revokeViolation(v.id, '管理员撤销违约记录');
                toast(res.message, 'success');
                load();
              } catch (err) {
                showErr(err);
              }
            },
          }, '撤销'),
        },
      ];
      listNode.appendChild(dataTable(columns, data.items, { empty: '暂无违约记录' }));
    } catch (err) {
      clear(listNode);
      listNode.appendChild(h('div.alert.alert-danger', err.message));
    }
  }

  await load();
  void renderRoute;
  return wrap;
}

/* ======================= 系统配置 ======================= */

export async function renderAdminConfig({ renderRoute }) {
  const wrap = h('div');
  const data = await api.config();
  const inputs = {};

  const grid = h('div.grid.grid-3');
  for (const item of data.items) {
    const isNumber = item.type === 'number';
    const input = h('input.input', { type: isNumber ? 'number' : 'text', value: item.value, min: 0 });
    inputs[item.key] = input;
    grid.appendChild(
      h('label.field', [
        h('span', item.description || item.key),
        input,
        h('span.small.muted', `配置键：${item.key}${item.defaultValue !== null ? ` · 默认值 ${item.defaultValue}` : ''}`),
      ]),
    );
  }

  wrap.appendChild(h('div.card', [
    h('div.card-head', [
      h('h2', '业务规则配置'),
      h('span.spacer'),
      h('button.btn', {
        onclick: async () => {
          const reset = await api.config();
          for (const item of reset.items) {
            if (inputs[item.key] && item.defaultValue !== null) inputs[item.key].value = item.defaultValue;
          }
          toast('已载入默认值（尚未保存）', 'info');
        },
      }, '载入默认值'),
      h('button.btn.btn-primary', {
        onclick: async () => {
          const patch = {};
          for (const [key, el] of Object.entries(inputs)) patch[key] = el.value;
          try {
            const res = await api.updateConfig(patch);
            toast(res.changed.length ? `已保存 ${res.changed.length} 项配置` : '配置未发生变化', 'success');
            renderRoute();
          } catch (err) {
            showErr(err);
          }
        },
      }, '保存配置'),
    ]),
    h('div.alert.alert-info', '提示：配置修改后立即生效（服务无需重启）。若缩短「最多提前预约天数」或「单次最长时长」，不会自动取消已有预约，但新的预约会按新规则校验。'),
    grid,
  ]));
  return wrap;
}

/* ======================= 审计日志 ======================= */

export async function renderAdminAudit() {
  const wrap = h('div');
  const query = { page: 1, pageSize: 30, action: '' };
  const listNode = h('div');
  const actionInput = h('input.input', { placeholder: '动作前缀，如 booking / device / user' });

  wrap.appendChild(h('div.card', [
    h('h2', '审计日志'),
    h('p.muted', '记录所有关键写操作（登录、审批、设备变更、配置修改等），用于追责与安全审计。'),
    h('div.filters', [
      h('label.field', [h('span', '动作过滤'), actionInput]),
      h('div.filters-actions', [
        h('button.btn.btn-primary', { onclick: () => { query.page = 1; load(); } }, '查询'),
        h('button.btn', { onclick: () => { actionInput.value = ''; query.action = ''; query.page = 1; load(); } }, '重置'),
      ]),
    ]),
    listNode,
  ]));

  async function load() {
    query.action = actionInput.value.trim();
    clear(listNode);
    listNode.appendChild(loading());
    try {
      const data = await api.auditLogs(query);
      clear(listNode);
      listNode.appendChild(dataTable([
        { label: '时间', render: (l) => l.createdText },
        { label: '操作人', render: (l) => h('div', [h('div', l.actorName || '系统'), h('div.small.muted', l.ip || '—')]) },
        { label: '动作', render: (l) => h('span.tag.tag-brand', l.action) },
        { label: '对象', render: (l) => `${l.targetType || '—'}${l.targetId ? `#${l.targetId}` : ''}` },
        { label: '详情', render: (l) => h('div.small', { style: { maxWidth: '420px', wordBreak: 'break-all' } }, l.detail || '—') },
      ], data.items, { empty: '暂无审计记录' }));
      listNode.appendChild(pagination({ page: data.page, pageSize: data.pageSize, total: data.total, onChange: (p) => { query.page = p; load(); } }));
    } catch (err) {
      clear(listNode);
      listNode.appendChild(h('div.alert.alert-danger', err.message));
    }
  }

  await load();
  return wrap;
}

/* ======================= 运行状态 ======================= */

export async function renderAdminSystem({ renderRoute }) {
  const wrap = h('div');
  const data = await api.system();
  const capacity = await api.capacity({ days: 7 });

  wrap.appendChild(h('div.card', [
    h('div.card-head', [
      h('h2', '系统运行状态'),
      h('span.spacer'),
      h('button.btn', {
        onclick: async () => {
          try {
            const res = await api.runJobs();
            const r = res.result || {};
            toast(`后台作业已执行：爽约判定 ${r.noShow} 条，提醒 ${r.reminders} 条，候补超时 ${r.waitlistExpired} 条，自动解冻 ${r.unfrozen} 人`, 'success', 5200);
            renderRoute();
          } catch (err) {
            showErr(err);
          }
        },
      }, '立即执行后台作业'),
      h('button.btn', { onclick: () => renderRoute() }, '刷新'),
    ]),
    h('div.grid.grid-4', [
      statCard({ label: '服务运行时长', value: fmtMinutes(Math.round(data.runtime.uptimeSeconds / 60)), foot: `Node ${data.runtime.node} · ${data.runtime.platform}`, accent: 'brand' }),
      statCard({ label: '内存占用', value: `${data.runtime.memoryMb} MB`, foot: 'RSS 常驻内存', accent: 'info' }),
      statCard({ label: '数据库大小', value: `${data.db.sizeKb} KB`, foot: `日志模式 ${data.db.journalMode}（WAL 并发读写）`, accent: 'success' }),
      statCard({ label: '后台作业', value: data.scheduler.running ? '运行中' : '已停止', foot: data.scheduler.lastRun ? `上次执行 ${fmtRelative(data.scheduler.lastRun.at)}` : '尚未执行', accent: data.scheduler.running ? 'success' : 'danger' }),
    ]),
    h('h3', { style: { marginTop: '16px' } }, '数据规模'),
    h('div.grid.grid-4', Object.entries(data.counts).map(([table, count]) =>
      statCard({ label: table, value: String(count), accent: 'brand' }))),
    h('h3', { style: { marginTop: '16px' } }, '后台作业累计处理'),
    descList([
      ['执行轮次', String(data.scheduler.counters.rounds)],
      ['判定爽约', `${data.scheduler.counters.noShow} 条`],
      ['发送开始提醒', `${data.scheduler.counters.reminders} 条`],
      ['候补确认超时顺延', `${data.scheduler.counters.waitlistExpired} 条`],
      ['自动解冻', `${data.scheduler.counters.unfrozen} 人`],
      ['数据库路径', data.db.path],
      ['服务器时间', fmtDateTime(data.runtime.now)],
    ]),
  ]));

  wrap.appendChild(h('div.card', [
    h('div.card-head', [h('h2', '未来 7 天各实验室容量')]),
    dataTable([
      { label: '实验室', render: (r) => h('div', [h('b', r.labName), h('div.small.muted', `${r.deviceCount} 台可预约设备`)]) },
      ...capacity.items[0].days.map((_, idx) => ({
        label: capacity.items[0].days[idx].date.slice(5),
        num: true,
        render: (r) => {
          const d = r.days[idx];
          return h('div', [
            h('div', fmtMinutes(d.freeMinutes)),
            h('div.small.muted', `利用率 ${(d.utilization * 100).toFixed(0)}%`),
          ]);
        },
      })),
    ], capacity.items),
  ]));
  return wrap;
}

export { fmtDate, progressBar, barChart, donutChart, heatmap };
