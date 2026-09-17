'use strict';

/**
 * 真实界面截图脚本（供 GitHub Pages 项目介绍页使用）
 * ------------------------------------------------------------------
 * 原理：用无头 Chrome 的远程调试协议（CDP）驱动真实浏览器：
 *   1. 打开登录页，用演示账号登录（前端会把 token 存进 localStorage）；
 *   2. 通过 hash 路由逐个切换页面，等待页面渲染完成；
 *   3. 用 Page.captureScreenshot 截图并写入 docs/images/。
 * 这样得到的截图来自「真实运行的系统 + 真实接口数据」，不是示意图。
 *
 * 用法：
 *   node src/server.js                       # 先启动服务
 *   node scripts/capture-screenshots.js      # 再执行本脚本
 *
 * 可选环境变量：
 *   SHOT_BASE  服务地址，默认 http://127.0.0.1:3000
 *   CHROME     浏览器可执行文件路径（默认自动探测 Chrome / Edge）
 *   SHOT_WIDTH / SHOT_HEIGHT  视口尺寸，默认 1440x900
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:3000';
const WIDTH = Number(process.env.SHOT_WIDTH || 1440);
const HEIGHT = Number(process.env.SHOT_HEIGHT || 900);
const PORT = 9333;
const OUT_DIR = path.join(__dirname, '..', 'docs', 'images');

/**
 * 需要截图的页面：
 *   [输出文件名, hash 路由, 登录角色, 说明, 滚动位置(0~1), 自定义视口高度, 自定义视口宽度]
 * 尺寸可单独指定：信息密度高的页面（时间轴、管理概览、统计报表）用更大的视口，
 * 避免关键内容被裁掉或双栏布局被挤成窄栏。
 */
const SHOTS = [
  ['login.png', null, null, '登录页（含演示账号一键填入）', 0, 0, 0],
  ['dashboard-student.png', '#/', 'student', '学生工作台：在途预约、即将开始、可约设备推荐', 0, 0, 0],
  ['devices.png', '#/booking', 'student', '设备目录：按实验室/类别/状态检索，显示今日剩余空闲', 0, 0, 0],
  ['device-timeline.png', '#/devices/DEVICE_ID', 'student', '设备详情：一周时间轴可视化选时段（15 分钟吸附）', 0.22, 1240, 0],
  ['bookings.png', '#/bookings', 'student', '我的预约：状态筛选、在途/历史、导出 CSV', 0, 0, 0],
  ['waitlist.png', '#/waitlist', 'student', '候补队列：排队位次与限时确认补位', 0, 0, 0],
  ['profile.png', '#/profile', 'student', '个人中心：信用分台账、违约记录、本周额度', 0.35, 0, 0],
  ['review.png', '#/review', 'teacher', '审批中心（教师）：待我审批 + 使用中 + 批量审批', 0, 0, 0],
  ['admin-overview.png', '#/admin', 'admin', '管理概览：利用率排行、实验室对比、时段热力图', 0, 1150, 1600],
  ['admin-reports.png', '#/admin/reports', 'admin', '统计报表：利用率明细、趋势、履约率、CSV 导出', 0.2, 1180, 1600],
  ['admin-schedule.png', '#/admin/schedule', 'admin', '排班与停机：实验室默认排班 + 设备级例外 + 停机计划', 0, 0, 0],
  ['admin-devices.png', '#/admin/devices', 'admin', '设备管理：资产台账、免审批/签到/时长策略', 0, 0, 0],
  ['admin-blacklist.png', '#/admin/blacklist', 'admin', '违约与信用：违约统计、手工登记与撤销返还', 0, 0, 0],
  ['admin-audit.png', '#/admin/audit', 'admin', '审计日志：谁在何时对什么对象做了什么', 0, 0, 0],
  ['admin-system.png', '#/admin/system', 'admin', '运行状态：数据规模、WAL、后台作业执行统计', 0, 0, 0],
];

function findBrowser() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('未找到 Chrome / Edge，请用 CHROME 环境变量指定浏览器路径');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const target = list.find((t) => t.type === 'page');
      if (target && target.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch {
      /* 浏览器还没起来，继续等待 */
    }
    await sleep(300);
  }
  throw new Error('等待 Chrome 远程调试端口超时');
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = findBrowser();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-shot-'));

  console.log(`浏览器：${browser}`);
  console.log(`服务地址：${BASE}`);
  console.log(`视口：${WIDTH}x${HEIGHT}`);
  console.log('');

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${PORT}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  let ws = null;
  try {
    const wsUrl = await waitForDevtools();
    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = (e) => reject(new Error(`WebSocket 连接失败：${e.message || e.type}`));
    });

    let id = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || {})})`));
        else resolve(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
        setTimeout(() => {
          if (pending.has(msgId)) {
            pending.delete(msgId);
            reject(new Error(`CDP 调用超时：${method}`));
          }
        }, 30000);
      });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    let navSeq = 0;
    /**
     * 导航到指定 hash 路由。
     * 关键点：只改 location.hash 不会重新加载文档，而 app.js 的首次渲染发生在 boot()，
     * 因此这里每次都换一个查询参数强制「完整文档加载」，再设置 hash 并派发 hashchange，
     * 保证截图对应的是目标页面而不是上一个页面。
     */
    async function gotoRoute(hash, opts = {}) {
      const { waitLogin = false, minNodes = 30, timeoutMs = 20000 } = opts;
      navSeq += 1;
      const url = `${BASE}/?n=${navSeq}${hash || ''}`;
      await send('Page.navigate', { url });
      await sleep(900);

      // 等 boot() 完成：登录态页面会出现 #view 且导航已渲染
      const deadline = Date.now() + timeoutMs;
      let loggedIn = false;
      while (Date.now() < deadline) {
        const { result } = await send('Runtime.evaluate', {
          expression: `(() => {
            const chip = document.getElementById('user-chip');
            const nav = document.getElementById('nav');
            return JSON.stringify({
              chip: chip ? chip.textContent.trim().length : 0,
              navNodes: nav ? nav.querySelectorAll('*').length : 0,
            });
          })()`,
          returnByValue: true,
        });
        const st = JSON.parse(result.value);
        if (st.chip > 0 && st.navNodes > 8) {
          loggedIn = true;
          break;
        }
        await sleep(300);
      }
      if (waitLogin && !loggedIn) throw new Error('自动登录未生效：未检测到已登录界面');

      // 设置目标 hash（对非首页路由）并等待内容渲染
      if (hash && hash !== '#/') {
        await send('Runtime.evaluate', {
          expression: `(() => { window.location.hash = ${JSON.stringify(hash)}; window.dispatchEvent(new HashChangeEvent('hashchange')); return true; })()`,
          returnByValue: true,
        });
      }
      const settle = Date.now() + timeoutMs;
      let nodes = 0;
      while (Date.now() < settle) {
        const { result } = await send('Runtime.evaluate', {
          expression: `(() => {
            const view = document.getElementById('view');
            return JSON.stringify({
              nodes: view ? view.querySelectorAll('*').length : 0,
              loading: document.querySelectorAll('.loading').length,
            });
          })()`,
          returnByValue: true,
        });
        const st = JSON.parse(result.value);
        nodes = st.nodes;
        if (st.loading === 0 && nodes >= minNodes) break;
        await sleep(350);
      }
      return { loggedIn, nodes };
    }

    async function evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.text || '页面脚本执行失败');
      return result.value;
    }

    async function shot(file, scrollRatio = 0) {
      if (scrollRatio > 0) {
        await evaluate(`window.scrollTo(0, document.body.scrollHeight * ${scrollRatio}); true`);
        await sleep(500);
      } else {
        await evaluate('window.scrollTo(0, 0); true');
        await sleep(200);
      }
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const filePath = path.join(OUT_DIR, file);
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
      const size = fs.statSync(filePath).size;
      console.log(`  ✓ ${file.padEnd(24)} ${(size / 1024).toFixed(0)} KB`);
      return size;
    }

    /* ---------------- 登录页 ---------------- */
    console.log('[1/4] 登录页');
    navSeq += 1;
    await send('Page.navigate', { url: `${BASE}/?n=${navSeq}` });
    await sleep(2000);
    await shot('login.png');

    /* ---------------- 按角色登录并截图 ---------------- */
    const roles = [
      { key: 'admin', username: 'admin', label: '管理员' },
      { key: 'teacher', username: 'teacher', label: '教师' },
      { key: 'student', username: 'student', label: '学生' },
    ];
    /** 各角色的登录令牌（Node 侧使用，用于预取截图所需的数据） */
    const tokenOf = {};

    for (const role of roles) {
      const list = SHOTS.filter((s) => s[2] === role.key);
      if (!list.length) continue;
      console.log(`\n[2/4] 以${role.label} ${role.username} 登录并截图 ${list.length} 张`);

      // 1) 先以当前文档提供的服务端接口换取新 token 并写入 localStorage
      await gotoRoute('#/', { minNodes: 10 });
      const token = await evaluate(`
        (async () => {
          localStorage.removeItem('lab_booking_token');
          const r = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: '${role.username}', password: '123456' }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.message || '登录失败');
          localStorage.setItem('lab_booking_token', j.data.token);
          window.__shotUser = j.data.user.name + '（' + j.data.user.roleLabel + '）';
          return j.data.token;
        })()
      `);
      tokenOf[role.key] = token;
      const user = await evaluate('window.__shotUser');
      // 2) 强制重新加载，让 app.js 走「已有 token 免登录」分支
      const state = await gotoRoute('#/', { waitLogin: true });
      const who = await evaluate("document.getElementById('user-chip').textContent.replace(/\\s+/g, ' ').trim()");
      console.log(`      登录成功：${user}｜界面识别为：${who}｜首屏节点 ${state.nodes}`);

      // 设备详情页需要一台真实存在的设备 id：直接用 Node 侧请求后端取，
      // 避免在页面切换过程中执行页面脚本（上下文可能被销毁）。
      let deviceId = '';
      try {
        const res = await fetch(`${BASE}/api/devices?bookable=true&pageSize=30`, {
          headers: { Authorization: `Bearer ${tokenOf[role.key]}` },
        });
        const json = await res.json();
        const items = (json && json.data && json.data.items) || [];
        const pick = items.find((x) => (x.todayFreeCount || 0) > 0) || items[0];
        deviceId = pick ? String(pick.id) : '';
        if (deviceId) console.log(`      截图用设备：${pick.name}（id=${deviceId}）`);
      } catch (err) {
        console.log(`      （获取设备列表失败：${err.message}）`);
      }

      for (const [file, hash, , desc, scrollRatio] of list) {
        let route = hash;
        if (route === '#/devices/DEVICE_ID') {
          if (!deviceId) {
            console.log(`  - 跳过 ${file}（未取到可预约设备）`);
            continue;
          }
          route = `#/devices/${deviceId}`;
        }
        const minNodes = route.startsWith('#/admin') || route === '#/reports' ? 60 : 40;
        const shotRow = SHOTS.find((s) => s[0] === file);
        const shotHeight = shotRow[5] || HEIGHT;
        const shotWidth = shotRow[6] || WIDTH;
        if (shotHeight !== HEIGHT || shotWidth !== WIDTH) {
          await send('Emulation.setDeviceMetricsOverride', {
            width: shotWidth,
            height: shotHeight,
            deviceScaleFactor: 1,
            mobile: false,
          });
        }
        const { nodes } = await gotoRoute(route, { minNodes, timeoutMs: 25000 });
        const metrics = await evaluate(`(() => {
          const view = document.getElementById('view');
          return JSON.stringify({
            body: document.body.scrollHeight,
            view: view ? view.getBoundingClientRect().height : 0,
            scrollMax: Math.max(0, document.body.scrollHeight - window.innerHeight),
          });
        })()`);
        const m = JSON.parse(metrics);
        console.log(`      页面高度 ${m.body}px（内容区 ${Math.round(m.view)}px，可滚动 ${m.scrollMax}px）`);
        await shot(file, scrollRatio);
        console.log(`      ${desc}｜节点 ${nodes}`);
        if (shotHeight !== HEIGHT || shotWidth !== WIDTH) {
          await send('Emulation.setDeviceMetricsOverride', {
            width: WIDTH,
            height: HEIGHT,
            deviceScaleFactor: 1,
            mobile: false,
          });
        }
      }
    }

    /* ---------------- 移动端视图 ---------------- */
    console.log('\n[3/4] 移动端视图（390x844）');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    const mobileDev = await evaluate(`
      (async () => {
        try {
          const r = await fetch('/api/devices?bookable=true&pageSize=5');
          const j = await r.json();
          const items = (j && j.data && j.data.items) || [];
          return items[0] ? String(items[0].id) : '1';
        } catch (e) { return '1'; }
      })()
    `);
    await gotoRoute(`#/devices/${mobileDev}`, { minNodes: 40, timeoutMs: 20000 });
    await shot('mobile-device.png');

    /* ---------------- 二次清理并复位视口 ---------------- */
    console.log('\n[4/4] 完成');
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

    const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.png'));
    let total = 0;
    for (const f of files) total += fs.statSync(path.join(OUT_DIR, f)).size;
    console.log(`\n共 ${files.length} 张截图，合计 ${(total / 1024 / 1024).toFixed(2)} MB，输出目录：docs/images/`);
  } finally {
    try {
      if (ws) ws.close();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await sleep(600);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结果 */
    }
  }
}

main().catch((err) => {
  console.error('\n截图失败：', err.message);
  console.error('请确认：1) 服务已在运行（node src/server.js）；2) 浏览器可执行；3) 端口 9333 未被占用。');
  process.exit(1);
});
