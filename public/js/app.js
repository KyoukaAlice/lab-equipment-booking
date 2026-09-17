/**
 * 应用外壳：登录流程、状态管理、hash 路由、导航与通知徽标
 */

import { api, ApiError, getToken, setToken } from './api.js';
import { h, clear, toast, fmtDateTime } from './ui.js';
import { renderDashboard, renderDeviceBooking, renderMyBookings, renderBookingDetail, renderReview, renderWaitlist, renderNotifications, renderProfile } from './pages-core.js';
import { renderAdminOverview, renderAdminLabs, renderAdminDevices, renderAdminSchedule, renderAdminUsers, renderAdminBlacklist, renderAdminConfig, renderAdminAudit, renderAdminSystem, renderAdminReports } from './pages-admin.js';

/* ============================== 全局状态 ============================== */

export const state = {
  user: null,
  siteName: '高校实验室设备预约与共享管理系统',
  announcement: '',
  config: {},
  meta: null,
  unread: 0,
  route: { name: 'home', params: {} },
};

/* ============================== 路由表 ============================== */

const ROUTES = [
  { pattern: /^#?\/?$/, name: 'home', title: '工作台', render: renderDashboard },
  { pattern: /^#\/devices$/, name: 'devices', title: '设备目录', render: renderDashboard },
  { pattern: /^#\/booking$/, name: 'booking', title: '预约设备', render: renderDeviceBooking },
  { pattern: /^#\/devices\/(\d+)$/, name: 'device', title: '设备详情', render: renderDeviceBooking, keys: ['id'] },
  { pattern: /^#\/bookings$/, name: 'bookings', title: '预约管理', render: renderMyBookings },
  { pattern: /^#\/bookings\/(\d+)$/, name: 'bookingDetail', title: '预约详情', render: renderBookingDetail, keys: ['id'] },
  { pattern: /^#\/review$/, name: 'review', title: '审批中心', render: renderReview, staff: true },
  { pattern: /^#\/waitlist$/, name: 'waitlist', title: '候补队列', render: renderWaitlist },
  { pattern: /^#\/notifications$/, name: 'notifications', title: '通知中心', render: renderNotifications },
  { pattern: /^#\/profile$/, name: 'profile', title: '个人中心', render: renderProfile },
  { pattern: /^#\/reports$/, name: 'reports', title: '统计报表', render: renderAdminReports, staff: true },
  { pattern: /^#\/admin$/, name: 'admin', title: '管理概览', render: renderAdminOverview, admin: true },
  { pattern: /^#\/admin\/labs$/, name: 'adminLabs', title: '实验室管理', render: renderAdminLabs, admin: true },
  { pattern: /^#\/admin\/devices$/, name: 'adminDevices', title: '设备管理', render: renderAdminDevices, admin: true },
  { pattern: /^#\/admin\/schedule$/, name: 'adminSchedule', title: '排班与停机', render: renderAdminSchedule, admin: true },
  { pattern: /^#\/admin\/users$/, name: 'adminUsers', title: '用户管理', render: renderAdminUsers, admin: true },
  { pattern: /^#\/admin\/blacklist$/, name: 'adminBlacklist', title: '违约与信用', render: renderAdminBlacklist, admin: true },
  { pattern: /^#\/admin\/reports$/, name: 'adminReports', title: '统计报表', render: renderAdminReports, admin: true },
  { pattern: /^#\/admin\/config$/, name: 'adminConfig', title: '系统配置', render: renderAdminConfig, admin: true },
  { pattern: /^#\/admin\/audit$/, name: 'adminAudit', title: '审计日志', render: renderAdminAudit, admin: true },
  { pattern: /^#\/admin\/system$/, name: 'adminSystem', title: '运行状态', render: renderAdminSystem, admin: true },
];

function resolveRoute(hash) {
  const clean = hash || '#/';
  for (const route of ROUTES) {
    const m = clean.match(route.pattern);
    if (!m) continue;
    const params = {};
    (route.keys || []).forEach((k, i) => {
      params[k] = m[i + 1];
    });
    return { route, params };
  }
  return { route: { name: 'notFound', title: '页面不存在' }, params: {} };
}

export function navigate(hash, { replace = false } = {}) {
  if (replace) {
    window.location.replace(hash);
  } else if (window.location.hash === hash) {
    renderRoute();
  } else {
    window.location.hash = hash;
  }
}

/* ============================== 消息与错误 ============================== */

/** 统一的错误提示：把后端返回的规则码翻译成用户能看懂的话 */
export function showError(err) {
  if (err instanceof ApiError) {
    if (err.code === 'NETWORK_ERROR') {
      toast('无法连接服务器，请确认服务已启动', 'error');
      return;
    }
    let msg = err.message;
    if (err.code === 'R10' && err.detail && err.detail.conflict) {
      const c = err.detail.conflict;
      msg = `该时段已被占用：${fmtDateTime(c.start)} ~ ${fmtDateTime(c.end)}（${c.occupant || '其他用户'}）`;
    } else if (err.code === 'R11' && err.detail && err.detail.conflict) {
      const c = err.detail.conflict;
      msg = `与您自己的预约冲突：${c.deviceName} ${fmtDateTime(c.start)} ~ ${fmtDateTime(c.end)}`;
    } else if (err.code === 'R12' && err.detail && err.detail.rule) {
      msg = err.message;
    }
    toast(msg, 'error', 4200);
    return;
  }
  console.error(err);
  toast(err && err.message ? err.message : '操作失败', 'error');
}

/* ============================== 顶部导航渲染 ============================== */

const ICONS = {
  home: '🏠', devices: '🧰', bookings: '📋', review: '✅', waitlist: '⏳',
  notifications: '🔔', profile: '👤', admin: '⚙️', reports: '📊', labs: '🏫',
  equipment: '🔧', schedule: '📅', users: '👥', blacklist: '🚫', config: '🛠️',
  audit: '📜', system: '💻',
};

function navItems() {
  const u = state.user;
  const items = [
    { group: '预约使用' },
    { key: 'home', hash: '#/', label: '工作台', icon: ICONS.home },
    { key: 'devices', hash: '#/booking', label: '预约设备', icon: ICONS.devices },
    { key: 'bookings', hash: '#/bookings', label: '我的预约', icon: ICONS.bookings, countKey: 'activeBookings' },
    { key: 'waitlist', hash: '#/waitlist', label: '候补队列', icon: ICONS.waitlist },
  ];
  if (u && u.canReview) {
    items.push({ group: '实验室管理' });
    items.push({ key: 'review', hash: '#/review', label: '审批中心', icon: ICONS.review, badge: 'reviewPending' });
    items.push({ key: 'reports', hash: '#/reports', label: '统计报表', icon: ICONS.reports });
  }
  items.push({ group: '个人' });
  items.push({ key: 'notifications', hash: '#/notifications', label: '通知中心', icon: ICONS.notifications, unread: true });
  items.push({ key: 'profile', hash: '#/profile', label: '个人中心', icon: ICONS.profile });
  if (u && u.role === 'admin') {
    items.push({ group: '系统管理' });
    items.push({ key: 'admin', hash: '#/admin', label: '管理概览', icon: ICONS.admin });
    items.push({ key: 'adminLabs', hash: '#/admin/labs', label: '实验室管理', icon: ICONS.labs });
    items.push({ key: 'adminDevices', hash: '#/admin/devices', label: '设备管理', icon: ICONS.equipment });
    items.push({ key: 'adminSchedule', hash: '#/admin/schedule', label: '排班与停机', icon: ICONS.schedule });
    items.push({ key: 'adminUsers', hash: '#/admin/users', label: '用户管理', icon: ICONS.users });
    items.push({ key: 'adminBlacklist', hash: '#/admin/blacklist', label: '违约与信用', icon: ICONS.blacklist });
    items.push({ key: 'adminReports', hash: '#/admin/reports', label: '统计报表', icon: ICONS.reports });
    items.push({ key: 'adminConfig', hash: '#/admin/config', label: '系统配置', icon: ICONS.config });
    items.push({ key: 'adminAudit', hash: '#/admin/audit', label: '审计日志', icon: ICONS.audit });
    items.push({ key: 'adminSystem', hash: '#/admin/system', label: '运行状态', icon: ICONS.system });
  }
  return items;
}

function renderNav() {
  const nav = document.getElementById('nav');
  clear(nav);
  const currentKey = state.route.name;
  for (const item of navItems()) {
    if (item.group) {
      nav.appendChild(h('div.nav-group-title', item.group));
      continue;
    }
    const active = currentKey === item.key || (item.key === 'home' && currentKey === 'home');
    const children = [h('span.nav-icon', item.icon), h('span', item.label)];
    if (item.unread && state.unread > 0) children.push(h('span.nav-count', String(state.unread)));
    if (item.countKey && state.user && state.user[item.countKey]) {
      children.push(h('span.nav-count', String(state.user[item.countKey])));
    }
    if (item.badge) {
      const badge = state.badges && state.badges[item.badge];
      if (badge) children.push(h('span.nav-count', String(badge)));
    }
    nav.appendChild(h(`a.nav-item${active ? '.active' : ''}`, { href: item.hash }, children));
  }
}

function renderCreditBox() {
  const box = document.getElementById('credit-box');
  const u = state.user;
  if (!u || !box) return;
  clear(box);
  const credit = u.credit || { creditScore: u.creditScore, level: '', threshold: 60 };
  const score = Number(credit.creditScore);
  const cls = score >= 85 ? '' : score >= 60 ? 'warn' : 'danger';
  box.appendChild(
    h('div', [
      h('div.row', { style: { justifyContent: 'space-between' } }, [
        h('span', '信用分'),
        h(`span.credit-score${cls ? `.${cls}` : ''}`, String(score)),
      ]),
      h('div.credit-bar', [h(`i.${cls}`, { style: { width: `${score}%` } })]),
      h('div.small', { style: { color: '#94a3b8', marginTop: '4px' } }, `等级：${credit.level || '—'}`),
    ]),
  );
}

function renderUserChip() {
  const chip = document.getElementById('user-chip');
  const u = state.user;
  if (!chip || !u) return;
  clear(chip);
  chip.appendChild(h('div.avatar', u.name ? u.name.slice(0, 1) : '?'));
  chip.appendChild(
    h('div', { style: { lineHeight: '1.25' } }, [
      h('div', u.name),
      h('div.small.muted', `${u.roleLabel}${u.department ? ` · ${u.department}` : ''}`),
    ]),
  );
  chip.addEventListener('click', () => navigate('#/profile'));
}

function renderNotifyBadge() {
  const badge = document.getElementById('notify-badge');
  if (!badge) return;
  if (state.unread > 0) {
    badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function renderAnnouncement() {
  const el = document.getElementById('announcement');
  if (!el) return;
  if (state.announcement) {
    el.textContent = `📢 ${state.announcement}`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/* ============================== 路由渲染 ============================== */

let renderToken = 0;

export async function renderRoute() {
  if (!state.user) return;
  const { route, params } = resolveRoute(window.location.hash);
  state.route = { name: route.name, params };

  if (route.admin && state.user.role !== 'admin') {
    toast('该功能仅管理员可用', 'warn');
    navigate('#/', { replace: true });
    return;
  }
  if (route.staff && !state.user.canReview && state.user.role !== 'admin') {
    toast('该功能仅实验室负责人可用', 'warn');
    navigate('#/', { replace: true });
    return;
  }

  document.getElementById('page-title').textContent = route.title || '';
  const view = document.getElementById('view');
  clear(view);
  renderNav();
  document.querySelector('.sidebar')?.classList.remove('open');

  if (!route.render) {
    view.appendChild(h('div.card', [h('h2', '页面不存在'), h('p.muted', '请通过左侧菜单访问功能页面。')]));
    return;
  }

  const myToken = ++renderToken;
  try {
    const node = await route.render({ params, state, navigate, showError, renderRoute });
    if (myToken !== renderToken) return; // 快速切换路由时丢弃过期渲染
    clear(view);
    if (node) view.appendChild(node);
  } catch (err) {
    if (myToken !== renderToken) return;
    clear(view);
    view.appendChild(
      h('div.card', [
        h('h2', '页面加载失败'),
        h('div.alert.alert-danger', err.message || '未知错误'),
        h('button.btn', { onclick: () => renderRoute() }, '重新加载'),
        h('p.small.muted', '若持续失败，请检查后端服务是否正常运行。'),
      ]),
    );
    console.error(err);
  }
}

/** 刷新当前用户信息（信用分、未读数、在途预约数） */
export async function refreshUser() {
  const data = await api.me();
  state.user = data.user;
  state.siteName = data.siteName;
  state.announcement = data.announcement;
  state.config = data.config;
  state.unread = data.user.unreadNotifications || 0;
  renderCreditBox();
  renderUserChip();
  renderNotifyBadge();
  renderAnnouncement();
  return data.user;
}

async function refreshBadges() {
  if (!state.user) return;
  try {
    const unread = await api.unreadCount();
    state.unread = unread.unread;
    renderNotifyBadge();
  } catch {
    /* 忽略轮询失败 */
  }
  if (state.user.canReview) {
    try {
      const todo = await api.bookings({ scope: 'todo', pageSize: 1 });
      state.badges = { reviewPending: todo.total };
      renderNav();
    } catch {
      /* 忽略 */
    }
  }
}

/* ============================== 登录 ============================== */

function showLogin() {
  document.getElementById('login-view').hidden = false;
  document.getElementById('app').hidden = true;
  const demo = document.getElementById('login-demo');
  clear(demo);
  api
    .publicInfo()
    .then((info) => {
      document.getElementById('login-title').textContent = info.siteName;
      document.getElementById('brand-name').textContent = info.siteName.slice(0, 12);
      state.siteName = info.siteName;
      demo.appendChild(h('div.demo-title', `演示账号（口令统一为 ${info.demoPassword}，点击即可填入）`));
      const list = h('div.demo-list');
      for (const acc of info.demoAccounts) {
        list.appendChild(
          h(
            'button.demo-item',
            {
              type: 'button',
              onclick: () => {
                const form = document.getElementById('login-form');
                form.querySelector('[name=username]').value = acc.username;
                form.querySelector('[name=password]').value = info.demoPassword;
              },
            },
            [
              h('b', acc.username),
              h('span.tag.tag-brand', acc.role),
              h('span', { style: { marginLeft: 'auto' } }, acc.description),
            ],
          ),
        );
      }
      demo.appendChild(list);
      demo.appendChild(
        h('p.small.muted', { style: { marginTop: '10px' } },
          `当前系统已有 ${info.stats.labs} 间实验室、${info.stats.devices} 台可预约设备、累计 ${info.stats.bookings} 条预约记录。`),
      );
    })
    .catch(() => {
      demo.appendChild(h('p.small.muted', '无法获取系统信息，请确认后端服务已启动。'));
    });
}

async function enterApp(user) {
  state.user = user;
  document.getElementById('login-view').hidden = true;
  document.getElementById('app').hidden = false;
  await refreshUser();
  document.getElementById('brand-name').textContent = state.siteName.slice(0, 12);
  renderNav();
  if (!window.location.hash) window.location.hash = '#/';
  await renderRoute();
  refreshBadges();
}

function bindLoginForms() {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const tabs = document.querySelectorAll('#login-tabs .tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      const isLogin = tab.dataset.tab === 'login';
      loginForm.hidden = !isLogin;
      registerForm.hidden = isLogin;
    });
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const error = document.getElementById('login-error');
    error.hidden = true;
    const fd = new FormData(loginForm);
    const btn = loginForm.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const data = await api.login(fd.get('username'), fd.get('password'));
      setToken(data.token);
      toast(`欢迎回来，${data.user.name}`, 'success');
      await enterApp(data.user);
    } catch (err) {
      error.textContent = err.message || '登录失败';
      error.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '登录';
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const error = document.getElementById('register-error');
    error.hidden = true;
    const fd = new FormData(registerForm);
    const btn = registerForm.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const payload = Object.fromEntries(fd.entries());
      const data = await api.register(payload);
      setToken(data.token);
      toast('注册成功，已自动登录', 'success');
      await enterApp(data.user);
    } catch (err) {
      error.textContent = err.message || '注册失败';
      error.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

/* ============================== 启动 ============================== */

function startClock() {
  const el = document.getElementById('clock');
  if (!el) return;
  const tick = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    el.textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

async function boot() {
  if (boot.started) return;
  boot.started = true;
  bindLoginForms();
  startClock();

  document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
      await api.logout();
    } catch {
      /* 忽略登出接口异常 */
    }
    setToken('');
    state.user = null;
    showLogin();
    toast('已退出登录', 'info');
  });

  document.getElementById('notify-btn').addEventListener('click', () => navigate('#/notifications'));
  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.querySelector('.sidebar')?.classList.toggle('open');
  });

  window.addEventListener('hashchange', () => {
    if (state.user) renderRoute();
  });

  window.addEventListener('auth:expired', () => {
    state.user = null;
    showLogin();
    toast('登录状态已过期，请重新登录', 'warn');
  });

  // 通知未读数轮询
  setInterval(() => {
    if (state.user) refreshBadges();
  }, 30000);

  // 已有 token 时尝试免登录进入
  if (getToken()) {
    try {
      const data = await api.me();
      await enterApp(data.user);
      return;
    } catch (err) {
      setToken('');
      if (!(err instanceof ApiError) || err.status !== 401) {
        console.warn('自动登录失败：', err.message);
      }
    }
  }
  showLogin();
}

/** 启动：模块脚本本身是 defer 语义，DOM 已就绪时直接启动，否则等 DOMContentLoaded */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
