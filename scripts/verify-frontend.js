'use strict';

/**
 * 前端页面渲染验证（无浏览器环境）
 * ------------------------------------------------------------------
 * 思路：用最小的 DOM/BOM 桩模拟浏览器，然后真实调用前端的各个页面渲染函数，
 * 请求打到正在运行的后端服务上，从而验证「接口契约 + 渲染逻辑」是否真的能跑通。
 * 这能在没有浏览器的环境下捕获：语法错误、导出缺失、字段名写错、渲染期异常等。
 *
 * 用法：先启动服务，然后 node scripts/verify-frontend.js [baseUrl]
 */

const BASE = process.argv[2] || process.env.SMOKE_BASE || 'http://127.0.0.1:3000';

/* ============================== DOM 桩 ============================== */

class StubClassList {
  constructor() {
    this.set = new Set();
  }
  add(...names) {
    names.forEach((n) => this.set.add(n));
  }
  remove(...names) {
    names.forEach((n) => this.set.delete(n));
  }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : force;
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
  contains(name) {
    return this.set.has(name);
  }
  get value() {
    return [...this.set].join(' ');
  }
}

class StubNode {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.classList = new StubClassList();
    this.parentNode = null;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.type = '';
    this.textContent = '';
  }

  get className() {
    return this.classList.value;
  }

  set className(v) {
    this.classList = new StubClassList();
    String(v || '')
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => this.classList.add(c));
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof StubNode);
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  appendChild(node) {
    if (!node) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      node.parentNode = null;
    }
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = value;
    if (name === 'value') this.value = value;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = value;
    if (name === 'hidden') this.hidden = true;
    if (name === 'disabled') this.disabled = true;
    if (name === 'checked') this.checked = true;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'hidden') this.hidden = false;
    if (name === 'disabled') this.disabled = false;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) || []) fn({ type, target: this, ...event });
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return queryStub(this, selector);
  }

  /** 递归收集文本，便于断言渲染结果确实包含业务数据 */
  get textDump() {
    let text = this.textContent || '';
    for (const child of this.childNodes) {
      if (child instanceof StubNode) text += child.textDump;
      else text += String(child);
    }
    return text;
  }

  get elementCount() {
    let count = 1;
    for (const child of this.childNodes) {
      if (child instanceof StubNode) count += child.elementCount;
    }
    return count;
  }
}

class StubElement extends StubNode {
  constructor(tagName) {
    super(tagName);
    this._innerHTML = '';
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(v) {
    this._innerHTML = String(v);
  }
  focus() {}
  click() {
    this.dispatch('click', {});
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 300, height: 30, right: 300, bottom: 30 };
  }
}

class StubText {
  constructor(text) {
    this.nodeType = 3;
    this.data = String(text);
    this.parentNode = null;
  }
  toString() {
    return this.data;
  }
}

const ids = [  'login-view', 'app', 'login-title', 'brand-name', 'brand-sub', 'nav', 'credit-box', 'logout-btn',
  'page-title', 'clock', 'notify-btn', 'notify-badge', 'user-chip', 'announcement', 'view',
  'modal-root', 'toast-root', 'menu-toggle', 'login-form', 'register-form', 'login-error',
  'register-error', 'login-demo', 'login-tabs',
];
const registry = new Map();
for (const id of ids) {
  const el = new StubElement('div');
  el.setAttribute('id', id);
  registry.set(id, el);
}
// 表单内部控件：登录/注册流程会通过 [name=xxx] 取值
for (const id of ['login-form', 'register-form']) {
  const form = registry.get(id);
  for (const name of ['username', 'password', 'name', 'department', 'studentNo', 'email', 'phone']) {
    const input = new StubElement('input');
    input.setAttribute('name', name);
    form.appendChild(input);
  }
  const submit = new StubElement('button');
  submit.setAttribute('type', 'submit');
  form.appendChild(submit);
}
// 登录页的 tab 按钮
const loginTabs = registry.get('login-tabs');
for (const name of ['login', 'register']) {
  const tab = new StubElement('button');
  tab.setAttribute('data-tab', name);
  tab.className = name === 'login' ? 'tab active' : 'tab';
  loginTabs.appendChild(tab);
}

/**
 * 极简选择器引擎：支持 `.class` / `#id` / `tag` / `[name=x]` / `[type=x]`
 * 以及空格分隔的后代选择器（例如 '#login-tabs .tab'）。
 * 页面渲染函数会用到的选择器都在此覆盖范围内。
 */
function matchSimple(node, sel) {
  if (!(node instanceof StubNode)) return false;
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return node.attributes.get('id') === sel.slice(1);
  const attr = /^([a-zA-Z]*)\[([\w-]+)=["']?([^"'\]]+)["']?\]$/.exec(sel);
  if (attr) {
    if (attr[1] && node.tagName !== attr[1].toUpperCase()) return false;
    const key = attr[2];
    if (key === 'type') return node.type === attr[3];
    return node.attributes.get(key) === attr[3];
  }
  if (/^[a-zA-Z]+$/.test(sel)) return node.tagName === sel.toUpperCase();
  return false;
}

function queryStub(root, selector) {
  const parts = String(selector).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  let current = [root];
  for (const part of parts) {
    const next = [];
    for (const node of current) {
      const walk = (n) => {
        for (const child of n.childNodes) {
          if (!(child instanceof StubNode)) continue;
          if (matchSimple(child, part)) next.push(child);
          walk(child);
        }
      };
      walk(node);
    }
    current = next;
    if (!current.length) return [];
  }
  return current;
}

const documentStub = {
  readyState: 'complete',
  createElement: (tag) => new StubElement(tag),
  createTextNode: (text) => new StubText(text),
  getElementById: (id) => registry.get(id) || null,
  querySelector: (sel) => {
    if (sel.startsWith('#')) return registry.get(sel.slice(1)) || null;
    for (const el of registry.values()) {
      const found = el.querySelector(sel);
      if (found) return found;
    }
    return null;
  },
  querySelectorAll: (sel) => {
    const out = [];
    for (const el of registry.values()) out.push(...queryStub(el, sel));
    return out;
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  body: new StubElement('body'),
  documentElement: new StubElement('html'),
};

/* ============================== BOM 桩 ============================== */

const storage = new Map();
const windowStub = {
  location: { hash: '', href: `${BASE}/`, replace(h) { this.hash = h; }, assign(h) { this.hash = h; } },
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  CustomEvent: class CustomEvent {
    constructor(type, opts = {}) {
      this.type = type;
      this.detail = opts.detail;
    }
  },
  print: () => {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  fetch: (...args) => fetch(...args),
  navigator: { userAgent: 'node-verify' },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
};

globalThis.document = documentStub;
globalThis.window = windowStub;
globalThis.localStorage = windowStub.localStorage;
globalThis.location = windowStub.location;
globalThis.CustomEvent = windowStub.CustomEvent;
globalThis.HTMLElement = StubElement;
globalThis.Node = StubNode;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

// 浏览器里前端用相对路径请求（/api/...）；在 Node 中需要补齐服务地址
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (typeof input === 'string' && input.startsWith('/')) return nativeFetch(`${BASE}${input}`, init);
  return nativeFetch(input, init);
};

/* ============================== 验证逻辑 ============================== */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const JS_DIR = path.join(__dirname, '..', 'public', 'js');

/**
 * 把前端 ES 模块复制到临时目录再导入。
 * 原因：项目 package.json 是 "type": "commonjs"（后端使用 CommonJS），
 * 而 public/js 下的文件是浏览器 ES 模块；临时目录里放一个 "type": "module"
 * 的 package.json 即可让 Node 按 ESM 正确加载，从而真实执行模块顶层代码与依赖解析。
 */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-frontend-'));
fs.writeFileSync(path.join(TMP_DIR, 'package.json'), JSON.stringify({ type: 'module' }));
for (const f of fs.readdirSync(JS_DIR)) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(JS_DIR, f), path.join(TMP_DIR, f));
}

let pass = 0;
let fail = 0;

function check(label, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}${extra ? `（${extra}）` : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${extra ? `（${extra}）` : ''}`);
  }
}

async function importModule(name) {
  return import(pathToFileURL(path.join(TMP_DIR, name)).href);
}

async function main() {
  console.log(`\n=== 前端模块与页面渲染验证（后端：${BASE}）===\n`);

  console.log('[1] 模块加载（语法 / 导出 / 依赖解析）');
  const apiMod = await importModule('api.js');
  check('api.js 加载成功且导出 api', typeof apiMod.api === 'object');
  const uiMod = await importModule('ui.js');
  check('ui.js 加载成功且导出 h/表格/图表等组件', typeof uiMod.h === 'function' && typeof uiMod.dataTable === 'function' && typeof uiMod.barChart === 'function');
  const coreMod = await importModule('pages-core.js');
  const adminMod = await importModule('pages-admin.js');
  const pageNames = [
    'renderDashboard', 'renderDeviceBooking', 'renderMyBookings', 'renderBookingDetail',
    'renderReview', 'renderWaitlist', 'renderNotifications', 'renderProfile',
  ];
  check('pages-core.js 导出全部核心页面', pageNames.every((n) => typeof coreMod[n] === 'function'), pageNames.filter((n) => typeof coreMod[n] !== 'function').join(','));
  const adminNames = [
    'renderAdminOverview', 'renderAdminLabs', 'renderAdminDevices', 'renderAdminSchedule',
    'renderAdminUsers', 'renderAdminBlacklist', 'renderAdminConfig', 'renderAdminAudit',
    'renderAdminSystem', 'renderAdminReports',
  ];
  check('pages-admin.js 导出全部管理页面', adminNames.every((n) => typeof adminMod[n] === 'function'), adminNames.filter((n) => typeof adminMod[n] !== 'function').join(','));

  console.log('\n[2] 真实登录并渲染学生视角页面');
  const login = await apiMod.api.login('student3', '123456');
  apiMod.setToken(login.token);
  const state = {
    user: login.user,
    siteName: '高校实验室设备预约与共享管理系统',
    announcement: '',
    config: {},
    unread: 0,
    route: { name: 'home', params: {} },
  };
  const me = await apiMod.api.me();
  state.config = me.config;
  state.user = me.user;

  const nav = { params: {}, state, navigate: () => {}, showError: () => {}, renderRoute: () => {} };
  const studentPages = [
    ['工作台', () => coreMod.renderDashboard(nav)],
    ['设备目录', () => coreMod.renderDeviceBooking(nav)],
    ['我的预约', () => coreMod.renderMyBookings(nav)],
    ['候补队列', () => coreMod.renderWaitlist(nav)],
    ['通知中心', () => coreMod.renderNotifications(nav)],
    ['个人中心', () => coreMod.renderProfile(nav)],
  ];
  for (const [label, render] of studentPages) {
    try {
      const node = await render();
      const text = node.textDump;
      check(`${label} 渲染成功`, node.elementCount > 1, `${node.elementCount} 个节点，${text.length} 字文本`);
    } catch (err) {
      check(`${label} 渲染成功`, false, err.message);
    }
  }

  // 设备详情页（含时间轴选择逻辑）
  try {
    const devices = await apiMod.api.devices({ pageSize: 5, bookable: 'true' });
    const device = devices.items[0];
    const node = await coreMod.renderDeviceBooking({ ...nav, params: { id: String(device.id) } });
    const text = node.textDump;
    check('设备详情页渲染成功（含时段时间轴）', node.elementCount > 10 && text.includes(device.name), `${node.elementCount} 个节点`);
    check('设备详情页包含规则说明与时间轴图例', text.includes('预约规则') && text.includes('空闲可预约'));
  } catch (err) {
    check('设备详情页渲染成功', false, err.message);
  }

  // 预约详情页
  try {
    const list = await apiMod.api.bookings({ scope: 'auto', pageSize: 1 });
    if (list.items.length) {
      const node = await coreMod.renderBookingDetail({ ...nav, params: { id: String(list.items[0].id) } });
      check('预约详情页渲染成功（含生命周期时间线）', node.textDump.includes('生命周期'), `${node.elementCount} 个节点`);
    } else {
      check('预约详情页渲染成功', false, '没有可用的预约数据');
    }
  } catch (err) {
    check('预约详情页渲染成功', false, err.message);
  }

  console.log('\n[3] 教师视角：审批中心与统计报表');
  const teacherLogin = await apiMod.api.login('teacher', '123456');
  apiMod.setToken(teacherLogin.token);
  const teacherState = { ...state, user: teacherLogin.user };
  const teacherNav = { ...nav, state: teacherState };
  for (const [label, render] of [
    ['审批中心', () => coreMod.renderReview(teacherNav)],
    ['统计报表', () => adminMod.renderAdminReports(teacherNav)],
  ]) {
    try {
      const node = await render();
      check(`${label}（教师）渲染成功`, node.elementCount > 5, `${node.elementCount} 个节点`);
    } catch (err) {
      check(`${label}（教师）渲染成功`, false, err.message);
    }
  }

  console.log('\n[4] 管理员视角：全部管理页面');
  const adminLogin = await apiMod.api.login('admin', '123456');
  apiMod.setToken(adminLogin.token);
  const adminState = { ...state, user: adminLogin.user };
  const adminNav = { ...nav, state: adminState };
  const adminPages = [
    ['管理概览', () => adminMod.renderAdminOverview(adminNav)],
    ['实验室管理', () => adminMod.renderAdminLabs(adminNav)],
    ['设备管理', () => adminMod.renderAdminDevices(adminNav)],
    ['排班与停机', () => adminMod.renderAdminSchedule(adminNav)],
    ['用户管理', () => adminMod.renderAdminUsers(adminNav)],
    ['违约与信用', () => adminMod.renderAdminBlacklist(adminNav)],
    ['统计报表', () => adminMod.renderAdminReports(adminNav)],
    ['系统配置', () => adminMod.renderAdminConfig(adminNav)],
    ['审计日志', () => adminMod.renderAdminAudit(adminNav)],
    ['运行状态', () => adminMod.renderAdminSystem(adminNav)],
  ];
  for (const [label, render] of adminPages) {
    try {
      const node = await render();
      check(
        `${label} 渲染成功`,
        node.elementCount > 3,
        `${node.elementCount} 个节点` +
          (node.elementCount <= 3 ? ` ｜ 渲染结果文本：${JSON.stringify(node.textDump.slice(0, 160))}` : ''),
      );
    } catch (err) {
      check(`${label} 渲染成功`, false, err.message);
    }
  }

  console.log('\n[5] 应用外壳（app.js）登录流程');
  // 让 app.js 直接复用当前管理员 token，验证 bootstrap → 免登录进入 → 首页渲染
  apiMod.setToken(adminLogin.token);
  registry.get('app').hidden = true;
  let appBooted = false;
  try {
    await importModule('app.js');
    await new Promise((resolve) => setTimeout(resolve, 500));
    appBooted = registry.get('app').hidden === false;
    check('app.js 启动并自动登录进入主界面', appBooted);
    check('导航菜单已渲染', registry.get('nav').elementCount > 8, `${registry.get('nav').elementCount} 个节点`);
    check('顶栏显示当前用户', registry.get('user-chip').textDump.includes(adminLogin.user.name));
    check('信用分组件已渲染', registry.get('credit-box').textDump.includes('信用分'));
    const view = registry.get('view');
    check('主内容区已渲染工作台内容', view.elementCount > 5, `${view.elementCount} 个节点`);
  } catch (err) {
    check('app.js 启动并自动登录进入主界面', false, err.message);
  }

  console.log(`\n${'─'.repeat(64)}`);
  if (fail === 0) {
    console.log(`✅ 前端验证全部通过：${pass} 项\n`);
  } else {
    console.log(`❌ 前端验证失败 ${fail} 项 / 共 ${pass + fail} 项\n`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('验证脚本异常：', err);
  process.exit(1);
});
