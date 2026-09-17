# 高校实验室设备预约与共享管理系统

> Laboratory Equipment Booking & Sharing Platform ｜ 毕业设计实现
> `Node ≥ 22.5`（实测运行于 Node 24.19）· `零第三方依赖`（无需 npm install）· `node:sqlite` + WAL · 自动化测试 46/46 · HTTP 冒烟 46/46 · 演示数据自检 33/33 · 前端渲染验证 30/30 · MIT

**目录**：[项目简介](#1-项目简介) · [功能一览](#2-功能一览) · [技术选型与亮点](#3-技术选型与亮点) · [项目结构](#4-项目结构) · [快速开始](#5-快速开始) · [脚本命令](#6-可用脚本命令) · [核心业务规则](#7-核心业务规则) · [REST 接口](#8-rest-接口一览) · [前端路由](#9-前端页面路由) · [测试与验证](#10-测试与验证) · [配置项](#11-配置项说明) · [FAQ](#12-常见问题faq) · [许可](#13-许可与说明)

## 1. 项目简介

高校实验室的仪器设备长期存在「排期靠微信群、占用靠纸条、爽约无人管」的问题：学生不知道某台示波器今天还剩哪些空闲时段，实验室负责人无法快速判断一条申请会不会和已有排期、维修停机撞车，管理员也拿不到可信的设备利用率数据。本系统面向**学生（预约使用方）、实验室负责人（审批方）、实验室与设备管理处（管理方）**三类用户，把「查空闲 → 提交申请 → 规则校验 → 审批 → 现场签到码核验 → 签退/超时违约 → 候补自动补位 → 信用分与失信限制 → 利用率统计报表」做成一条完整闭环的 Web 应用：把设备排期收敛为**左闭右开区间**上的集合运算，把「能不能约」拆解为 **R01~R12 十二条可解释规则**，并用**进程内写锁 + SQLite `BEGIN IMMEDIATE`** 保证并发抢同一时段时不会产生双重预约。

## 2. 功能一览

### 2.1 学生 / 教师

| 功能 | 真实实现说明 |
| --- | --- |
| 注册与登录 | 学生可自助注册（角色固定 `student`，初始信用 100 分）；教师/管理员账号由管理员创建。口令用 `crypto.scrypt`（N=16384, r=8, p=1）加盐散列，校验用 `timingSafeEqual`；会话有效期 7 天，支持 `Authorization: Bearer` 或 Cookie `lab_token` |
| 设备目录 | 按实验室 / 类别 / 状态 / 关键字筛选与排序（名称、价格、类别、最新），列表返回今日与未来 7 天空闲概览、当前是否被占用；`bookable=true` 只列可预约设备 |
| 可用时段查询 | 单台设备按天返回「开放排班 / 占用区块（他人预约已脱敏）/ 可直接预约的空闲块」；支持多台设备的**共同空闲时段**（团队协作场景） |
| 预约申请 | 提交前跑完 R01~R12 全部校验；失败返回 `规则码 + 中文说明 + detail`（冲突占用者、停机原因与类型、排班明细等），前端据此给出可读提示 |
| 我的预约 | 支持 `scope=mine/todo/active/history`、状态、实验室、设备、时间区间、关键字、进行中等过滤；返回分状态计数供 Tab 徽标使用；可导出 CSV（带 UTF-8 BOM，Excel 直接打开） |
| 预约详情 | 生命周期时间线：提交申请 → 审批通过/驳回 → 现场签到 → 签退完成（含实际使用时长），并返回取消/爽约节点 |
| 现场签到 | 需输入 6 位签到码（`crypto.randomInt` 生成），且必须落在签到窗口内：开始前 `checkin_open_before_minutes`（默认 30 分钟）至开始后 `checkin_grace_minutes`（默认 15 分钟）之间 |
| 签退 | 记录实际使用时长；超过「预约结束时间 + `overtime_grace_minutes`」判为超时占用并自动记违约扣分 |
| 取消预约 | 本人/审批人/管理员可取消；本人在开始前不足 `cancel_deadline_hours`（默认 12 小时）取消，记一次「临时取消」违约并扣分 |
| 候补队列 | 仅当该时段确实被占用才允许排队（否则提示直接预约）；去重防重复排队；预约被取消/驳回/爽约/提前签退释放时段后，系统按申请先后自动补位并给予限时确认（默认 60 分钟），逾期自动失效并顺延给下一位 |
| 信用分与违约 | 「我的信用分」含台账（每次变动）、违约记录、本周额度使用情况；分数低于阈值（默认 60）自动冻结预约权限，冻结期默认 30 天，到期由后台作业自动解冻 |
| 通知中心 | 站内通知（提交/审批/驳回/取消/签到/签退/提醒/候补/违约/冻结等）、未读数轮询、单条已读与全部已读 |
| 审批（教师） | 只能审批**自己负责的实验室**（`lab_managers`）或**自己负责的设备**（`devices.owner_id`）下的预约；任何人不得审批自己的预约；审批通过时生成签到码；支持批量通过/驳回；驳回必须填写原因；`scope=todo` 返回「待我审批 + 正在使用中」待办与角标计数 |
| 统计报表（教师） | 教师只能查看所辖实验室的统计（利用率、实验室汇总、热力图、趋势、用户排行） |

### 2.2 管理员

| 功能 | 真实实现说明 |
| --- | --- |
| 管理概览 | `GET /api/stats/dashboard` 一次返回概览指标、设备利用率 Top12 / Bottom5、实验室汇总、时段热力图、用户排行与失信名单、时间构成、预约趋势 |
| 实验室管理 | 新增 / 修改 / 删除实验室，维护名称、编号（唯一）、楼栋房间、容量、开放时间、使用规定、负责人（`lab_managers`，可多名）与启用状态；实验室下仍有设备时禁止删除 |
| 设备管理 | 新增 / 修改 / 删除设备，维护类别、型号、品牌、序列号（唯一）、状态（`available`/`maintenance`/`offline`/`scrapped`）、价格（分）、负责人、**免审批**、**是否需要签到**、单次时长上下限、最小提前量；状态改为不可用时提示受影响的未来预约数；有历史预约的设备删除时改为标记「已报废」以保护统计口径 |
| 排班管理 | 维护每周固定开放时段：`device_id` 为空表示**实验室级默认排班**，指定设备表示**设备级例外排班**（设备级优先）；支持启用/停用，创建时校验同范围时段重叠与设备归属 |
| 停机计划 | 维护设备维修 / 校准 / 假期 / 活动 / 其他不可用计划（可针对整个实验室或单台设备），创建时统计受影响的在途预约并逐个发送通知 |
| 用户管理 | 用户增删改查（角色、院系、学号、周额度、负责实验室）、冻结 / 解冻（带原因与天数）、停用 / 启用、重置任一用户口令（改密即失效其全部会话）；系统始终保留至少一名可用管理员，不能停用当前登录账号 |
| 违约与信用 | 违约记录列表与按类型统计；手工登记违约（设备损坏、违规使用等，分值可覆盖）；撤销误判记录并返还分数 |
| 系统配置 | 在线修改 23 项业务规则配置（未知键与非负数字校验，改动写入审计日志，缓存自动失效） |
| 审计日志 | 按动作前缀、操作人过滤查询审计日志：谁在什么时间对什么对象做了什么（登录、预约全流程、设备/实验室/排班/停机/用户/违约/配置等写操作） |
| 运行状态 | 各表数据量、数据库文件路径与大小、`journal_mode`、后台作业计数与最近一轮结果、Node 版本、平台、内存、运行时长 |
| 容量视图 | 各实验室未来 1~14 天逐日空闲分钟数、排班总时长与利用率，用于调度决策 |
| 后台作业 | 每 60 秒自动执行一轮（启动时立即执行一轮），并支持 `POST /api/admin/jobs/run` 手动触发排障 |

## 3. 技术选型与亮点

| 亮点 | 具体做法 |
| --- | --- |
| **零第三方依赖** | `package.json` 不含任何 `dependencies` / `devDependencies`，**无需 `npm install`**。数据库用内置 `node:sqlite`（`DatabaseSync`），Web 服务器用内置 `node:http`，口令散列用 `crypto.scrypt`，签到码用 `crypto.randomInt`，令牌用 `crypto.randomBytes` |
| **SQLite + WAL** | 启动即执行 `PRAGMA journal_mode=WAL; foreign_keys=ON; busy_timeout=5000; synchronous=NORMAL`，读写互不阻塞；14 张表覆盖配置、用户、实验室负责人、实验室、设备、每周排班、停机计划、预约、候补、违约、信用台账、通知、审计、会话 |
| **左闭右开区间语义** | 所有时间区间为 `[start, end)`：`09:00-10:00` 与 `10:00-11:00` 相邻但不冲突，符合真实排期习惯。`src/core/interval.js` 提供 `overlaps / contains / merge / clip / subtract / findFreeSlots / hits / totalDuration` 等算子 |
| **并发唯一性** | 所有写操作走 `db.writeTx`：**进程内互斥锁（带等待队列）+ `BEGIN IMMEDIATE`**，并在事务内**重新执行完整冲突校验后再插入**，因此「判冲突 → 写入」之间没有竞态窗口；自动化测试用 20 个并发请求抢同一时段，只有 1 条成功 |
| **可解释的规则引擎** | 预约校验拆成 R01~R12 十二条独立规则，逐条短路返回结构化失败（`code=规则码`，`detail` 含冲突占用者、停机原因、额度用量等），前端可翻译成人话提示，答辩时可逐条演示 |
| **可用时段 = 集合运算** | 可用时段 = `（每周排班 ∩ 查询窗口）−（占用预约 ∪ 停机计划）`，再按最短可用时长过滤碎片；排班、占用、停机全部复用同一套区间算子 |
| **配置化业务规则** | 23 项规则（预约窗口、签到宽限、扣分标准、信用阈值、候补保留时长、周额度、在途上限…）落库到 `config` 表，读取走内存缓存、写入即失效，管理后台可在线调整而不改代码 |
| **后台作业** | `scheduler.service.js` 每 60 秒一轮：爽约判定（含扣分、释放时段、顺延候补）、开始前提醒（只发一次）、候补确认超时顺延、冻结到期自动解冻；启动时立即跑一轮，保证重启后状态一致 |
| **前端零构建** | 原生 ES Module + 手写 CSS 的单页应用，`public/js/{api,ui,app,pages-core,pages-admin}.js` 五个模块，hash 路由；服务端对非 `/api` 路径做 SPA 回退 |
| **自研零依赖测试框架** | `test/runner.js` 提供 `test / assert / before / after`，`test/run.js` 自动发现并串行执行 `test/*.test.js`，支持按文件名过滤；测试使用内存数据库 |
| **演示数据可复现** | 演示数据由自实现的 `mulberry32`（固定种子 `SEED=20250412`）生成，业务时间全部由 PRNG 推导、仅以「当前时刻」为锚点，同一天多次生成结果一致；写入前用区间判重，保证同设备占用零重叠、信用台账累加恒等于当前分数 |

## 4. 项目结构

```
lab-equipment-booking/
├── package.json                  # 元信息、engines(>=22.5)、npm scripts（无任何依赖）
├── data/lab.db                   # SQLite 数据库（首次启动自动建库并写入演示数据）
├── public/                       # 前端 SPA（原生 ES Module + 手写 CSS，无构建步骤）
│   ├── index.html                # 应用外壳：登录/注册视图 + 主框架（侧边导航、顶栏、内容区）
│   ├── css/style.css             # 全部样式（布局、卡片、表格、标签、图表、响应式）
│   └── js/
│       ├── api.js                # 后端接口封装（fetch + token 注入 + 统一错误对象 ApiError）
│       ├── ui.js                 # DOM 构建工具与通用组件（h/表格/标签/图表/Toast 等）
│       ├── app.js                # 应用外壳：登录流程、全局状态、hash 路由表、导航与未读徽标
│       ├── pages-core.js         # 核心页面：工作台、预约设备/设备详情、我的预约、预约详情、审批中心、候补、通知、个人中心
│       └── pages-admin.js        # 管理页面：概览、实验室、设备、排班停机、用户、违约信用、报表、配置、审计、运行状态
├── scripts/
│   ├── start.bat                 # 一键启动（ASCII-only：先自检，再启动服务，最后 pause）
│   ├── stop.bat                  # 一键关闭残留的 Node 服务进程（按端口查找，仅结束 node.exe）
│   ├── run-tests.bat             # 一键跑自动化测试
│   ├── reset-data.bat            # 一键重置演示数据（带二次确认）
│   ├── preflight.js              # 启动自检（Node 版本 / node:sqlite / 端口占用 / 文件完整性 / 数据目录）
│   ├── reseed.js                 # 清空并重新生成演示数据（等价于 npm run reset）
│   ├── smoke.js                  # HTTP 端到端冒烟测试（46 项，需先启动服务）
│   ├── check-seed.js             # 演示数据自检（33 项业务不变量，内存库运行）
│   ├── verify-frontend.js        # 前端页面渲染验证（DOM 桩，30 项，需先启动服务）
│   ├── capture-screenshots.js    # 用无头 Chrome（CDP）自动登录并逐页截图，产出 docs/images/
│   └── preview-pages.js          # 本地预览 GitHub Pages 站点（静态服务器，默认 4000 端口）
├── index.html                    # Pages 入口跳转页（若发布源指向仓库根目录则生效）
├── docs/                         # GitHub Pages 项目介绍页（发布源设为 main 分支 /docs）
│   ├── index.html                # 介绍页：痛点→能力→R01~R12→架构→真实界面图库→测试→快速开始
│   ├── .nojekyll                 # 跳过 Jekyll 处理
│   └── images/                   # 16 张真实运行界面截图（由 capture-screenshots.js 生成）
├── src/
│   ├── server.js                 # 程序入口：启动服务、打印横幅、优雅关闭
│   ├── core/                     # 领域内核（不依赖 HTTP 层）
│   │   ├── interval.js           # 区间算法：overlaps/merge/clip/subtract/findFreeSlots…
│   │   ├── conflict-rules.js     # 冲突检测规则引擎 R01~R12 + 排班推导 + 占用收集
│   │   ├── booking-rules.js      # 预约状态机、占用状态、审批/取消权限、违约类型与分值
│   │   ├── config.js             # 配置中心：DEFAULTS、缓存读取、批量更新 + 审计
│   │   └── password.js           # scrypt 口令散列、6 位签到码、会话令牌生成
│   ├── db/
│   │   ├── index.js              # 数据库访问层：连接/WAL、查询封装、写锁 + BEGIN IMMEDIATE 写事务
│   │   └── schema.sql            # 14 张表的建表语句与索引（毫秒时间戳、金额存「分」）
│   ├── http/
│   │   ├── server.js             # node:http 服务器：解析/鉴权/路由分发/统一错误/静态资源与 SPA 回退
│   │   ├── router.js             # 极简路由器：路径参数 :id、405 区分、中间件链
│   │   └── helpers.js            # 统一响应体、登录/角色守卫、分页与入参读取
│   ├── routes/                   # REST 路由（共 76 个端点）
│   │   ├── auth.routes.js        # 认证、注册、个人中心、信用、额度、公开信息
│   │   ├── lab.routes.js         # 实验室、当日占用、分类与规则元信息
│   │   ├── device.routes.js      # 设备目录、详情、可用时段、多设备共同空闲
│   │   ├── booking.routes.js     # 预约全流程 + 候补队列 + 手动后台作业
│   │   ├── notification.routes.js# 通知中心
│   │   ├── stats.routes.js       # 统计报表与 CSV 导出
│   │   └── admin.routes.js       # 实验室/设备/排班/停机/用户/违约/配置/审计/系统
│   ├── services/
│   │   ├── booking.service.js    # 预约核心：创建/审批/取消/签到/签退/爽约/候补补位/CSV 导出
│   │   ├── availability.service.js # 可用时段计算（排班 − 占用 − 停机）与多设备共同空闲（核心算法之三）
│   │   ├── stats.service.js      # 利用率、实验室对比、星期×小时热力图、趋势、用户履约、时间构成
│   │   ├── credit.service.js     # 信用分唯一写入口：违约扣分、台账、自动冻结/解冻
│   │   ├── notification.service.js # 站内通知：单发/群发/列表/已读/未读数
│   │   ├── scheduler.service.js  # 后台作业：每 60 秒一轮（爽约/提醒/候补超时/解冻）
│   │   ├── audit.service.js      # 审计日志写入与查询
│   │   └── presenters.js         # 出参组装（字段命名、状态标签、可执行动作、脱敏）
│   ├── seed/seed-data.js         # 演示数据生成（确定性 PRNG，15 用户/4 实验室/20 设备/约 700 条预约/…）
│   └── utils/                    # 时间（毫秒 + 时区偏移）、统一错误、入参校验
└── test/
    ├── run.js / runner.js        # 测试入口（发现并串行执行 *.test.js，支持文件名过滤）+ 自研零依赖测试框架（test/assert/before/after）
    ├── helpers.js                # 测试辅助：内存库引导、测试服务器、登录、空闲时段查找、造数
    ├── interval.test.js          # 区间算法 9 个用例
    ├── conflict-rules.test.js    # R01~R12 规则 17 个用例
    └── booking-flow.test.js      # 预约全流程与并发唯一性 20 个用例
```

## 5. 快速开始

### 5.1 环境要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 22.5.0** | `node:sqlite` 从该版本开始提供；`package.json` 的 `engines` 已声明。实测运行于 Node 24.19 |
| 依赖安装 | **无需** | 零第三方依赖，不需要 `npm install`，也不需要本地编译工具链 |
| 操作系统 | Windows / Linux / macOS | Windows 下提供 `.bat` 一键脚本 |

### 5.2 启动

```bash
# 方式一：npm 脚本
npm start                # 等价于 node src/server.js

# 方式二：Windows 双击 / 命令行
scripts\start.bat        # 先自检（Node 版本 / 端口 / 文件 / 数据目录），通过后启动服务
scripts\stop.bat         # 关闭残留的 Node 服务进程（端口被占用时用）
```

启动后终端会打印：

```
  高校实验室设备预约与共享管理系统
  服务地址   : http://127.0.0.1:3000
  数据库     : data/lab.db（SQLite / WAL）
  演示账号   : admin / teacher / student   口令统一为 123456
  当前数据   : 15 个用户，697 条预约记录
```

浏览器访问 **<http://127.0.0.1:3000>**。首次启动会自动建库（`data/lab.db`）并写入一整套演示数据。

### 5.3 演示账号（口令统一 `123456`）

| 账号 | 姓名 | 角色与权限 |
| --- | --- | --- |
| `admin` | 系统管理员 | 全部权限：实验室/设备/排班/停机/用户/违约/配置/审计/统计（同时兼任人工智能与高性能计算实验室负责人，便于演示跨角色） |
| `teacher` | 李明远 | 电子技术基础实验室、嵌入式与物联网实验室负责人，可审批这两个实验室的预约 |
| `teacher2` | 陈静 | 机械加工与 3D 打印中心负责人，可审批 |
| `teacher3` | 王建国 | 人工智能与高性能计算实验室负责人，可审批 |
| `student` ~ `student11` | 张思远 等 11 人 | 学生账号：预约、取消、签到签退、候补、查看信用与通知 |
| `student5` | 周浩然 | 信用分 **55**（低于冻结阈值 60），账号已自动冻结，用于演示失信限制（R12） |

### 5.4 环境变量

`PORT`（默认 `3000`，HTTP 端口）、`HOST`（默认 `0.0.0.0`，监听地址）、`LAB_DB_PATH`（默认 `data/lab.db`，设为 `:memory:` 可跑内存库）、`LAB_DEBUG_PROMOTION=1`（打印候补补位的跳过原因）、`SMOKE_BASE`（冒烟/前端验证脚本的目标地址，也可用第一个命令行参数）。

## 6. 可用脚本命令

### 6.1 npm scripts（`package.json`）

| 命令 | 实际执行 | 用途 |
| --- | --- | --- |
| `npm start` | `node src/server.js` | 启动服务（默认 3000 端口） |
| `npm run dev` | `node --watch src/server.js` | 开发模式，改代码自动重启 |
| `npm test` | `node test/run.js` | 运行全部自动化测试（内存库） |
| `npm run test:unit` | `node test/run.js interval,conflict-rules` | 只跑单元测试（区间算法 + R01~R12 规则），共 26 个用例 |
| `npm run test:flow` | `node test/run.js booking` | 只跑业务流程与并发集成测试（20 个用例） |
| `npm run smoke` | `node scripts/smoke.js` | HTTP 冒烟测试（需先启动服务） |
| `npm run check:seed` | `node scripts/check-seed.js` | 演示数据业务不变量自检（内存库） |
| `npm run check:frontend` | `node scripts/verify-frontend.js` | 前端页面渲染验证（需先启动服务） |
| `npm run seed` / `npm run reset` | `node scripts/reseed.js` | 重置演示数据（清空业务数据后重新生成） |

### 6.2 Windows 一键脚本（`scripts/`）

| 脚本 | 用途 |
| --- | --- |
| `scripts\start.bat` | 一键启动：先确认 Node 已安装，再执行 `scripts\preflight.js` 自检（版本 / 端口 / 文件 / 数据目录），通过后启动服务；失败会打印中文原因与解决办法 |
| `scripts\stop.bat` | 关闭残留的 Node 服务进程：按端口（默认 3000）查找监听者，只结束 `node.exe`，不会误杀其它程序 |
| `scripts\run-tests.bat` | 运行 `node test\run.js` 并给出通过/失败结论（不影响 `data\lab.db`） |
| `scripts\reset-data.bat` | 二次确认后执行 `node scripts\reseed.js`，清空并重建演示数据 |

> **为什么这几个 .bat 文件里全是英文？** cmd.exe 用系统 OEM 代码页（中文 Windows 上是 GBK）解析批处理文件，若文件内含 UTF-8 中文，会被错误解码成乱码命令，表现为「双击无法启动 / 窗口一闪而过」。因此 bat 只保留纯 ASCII 命令，所有中文提示交由 `scripts/preflight.js` 等 Node 脚本输出（Node 以 UTF-8 输出，配合 `chcp 65001` 正常显示）。

### 6.3 验证脚本（Node 直接运行）

| 命令 | 前置条件 | 用途 |
| --- | --- | --- |
| `node test/run.js` | 无 | 46 个自动化用例（区间算法 / R01~R12 / 预约全流程与并发）；可传文件名关键字过滤，支持逗号分隔多个，如 `node test/run.js interval,conflict-rules` |
| `node scripts/check-seed.js` | 无（内存库） | 33 项演示数据业务不变量自检 |
| `node scripts/smoke.js [baseUrl]` | **需先启动服务** | 46 项 HTTP 端到端验证（含权限边界、完整预约闭环、管理接口、静态资源） |
| `node scripts/verify-frontend.js [baseUrl]` | **需先启动服务** | 30 项前端页面渲染验证（DOM 桩，真实请求后端渲染 20 个页面） |
| `node scripts/capture-screenshots.js` | **需先启动服务** + 本机安装 Chrome/Edge | 驱动无头浏览器自动登录并逐页截图，输出到 `docs/images/`（介绍页用图） |
| `node scripts/preview-pages.js [port]` | 无 | 本地预览 GitHub Pages 介绍页，默认 <http://127.0.0.1:4000/docs/index.html> |
| `node scripts/preflight.js` | 无 | 启动自检：Node 版本、`node:sqlite` 可用性、端口占用、关键文件完整性、数据目录可写，逐项给出中文结论与解决办法 |
| `node scripts/reseed.js` | 无 | 重置演示数据（等价于 `npm run reset`） |

## 7. 核心业务规则

### 7.1 冲突检测规则 R01~R12（`src/core/conflict-rules.js`）

按顺序逐条校验，任一条不通过即返回结构化失败（`code` 为规则码，`detail` 为明细），前端据此提示：

| 规则 | 校验内容 | 失败返回的明细 |
| --- | --- | --- |
| **R01** | 设备存在且状态为 `available` | 当前设备状态 |
| **R02** | 所属实验室未被停用（`status = active`） | — |
| **R03** | 时间参数合法：起止为数字且 `start < end` | — |
| **R04** | 开始时间不早于当前时间 | `startAt` / `now` |
| **R05** | 满足最小提前量 `booking_min_lead_minutes`（默认 30 分钟，0 表示不限） | `leadMinutes` |
| **R06** | 不超过最大提前天数 `booking_advance_days`（默认 14 天） | `advanceDays` |
| **R07** | 时长落在设备允许区间 `[min_minutes, max_minutes]` | `minMinutes` / `maxMinutes` |
| **R08** | 请求区间被某段开放排班**完整覆盖**（设备级排班优先于实验室级） | 该日排班区间列表（含可读时间文本） |
| **R09** | 不落在停机/封闭/校准计划内 | 停机 `reason`、`kind`、起止时间 |
| **R10** | 同一设备同一时段无重叠占用（占用状态见 `occupyingStatuses()`） | 冲突预约的编号、状态、时段、占用者与院系 |
| **R11** | 与本人其它预约无时间冲突 | 冲突的预约编号、设备名与时段 |
| **R12** | 账号未被冻结/停用；在途预约数未达 `max_active_bookings_per_user`；本周额度（`weekly_quota_min`，按周一为一周起点）足够 | 已用/额度/本次申请分钟数、冻结原因与解除时间 |

> 补充：`occupyingStatuses()` 默认把 `approved / checked_in / completed` 视为占用；配置 `pending_blocks_others=1`（默认）时 `pending` 也占用时段，避免同一时段被重复申请。

### 7.2 预约状态机（`src/core/booking-rules.js`）

| 状态 | 含义 | 允许迁移到 |
| --- | --- | --- |
| `pending` | 待审批（提交后的初始状态；免审批设备为学生申请时直接进入 `approved`） | `approved`、`rejected`、`cancelled`、`no_show` |
| `approved` | 已通过（已生成 6 位签到码） | `checked_in`、`cancelled`、`no_show` |
| `checked_in` | 使用中（已现场签到） | `completed` |
| `completed` | 已完成（已签退，记录实际使用分钟数） | 终态 |
| `cancelled` | 已取消（本人或审批人/管理员） | 终态 |
| `rejected` | 已驳回（必须填写原因） | 终态 |
| `no_show` | 爽约（超过签到宽限期未签到） | 终态 |
| `waitlist` | 候补中（时段被占满时排队） | `pending`、`cancelled`、`rejected` |

状态迁移统一经 `assertTransition` 校验，非法迁移返回 `409 ILLEGAL_TRANSITION`。触发迁移的操作：提交申请、审批通过/驳回、取消、签到、签退、后台作业判爽约、候补补位与确认。

## 8. REST 接口一览

统一约定：响应体为 `{ ok: true, data: … }` 或 `{ ok: false, code, message, detail, requestId }`；请求体支持 JSON 与表单；请求体上限 1MB。权限列中的「登录」表示需有效会话，「教师(所辖)」表示需为该实验室负责人或该设备负责人，「管理员」表示 `role = admin`（教师路由用 `requireStaff`，即管理员或教师）。

### 8.1 认证、个人中心与元信息（`auth.routes.js`、`lab.routes.js`）

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | 登录，返回 token、用户信息、站点名、公告；失败会记审计 | 公开 |
| POST | `/api/auth/logout` | 退出登录，销毁当前会话 | 登录 |
| GET | `/api/auth/me` | 当前用户 + 站点信息 + 前端所需配置（提前天数、签到宽限等） | 登录 |
| POST | `/api/auth/register` | 学生自助注册（角色固定 student，初始信用 100）并自动登录 | 公开 |
| GET | `/api/public/info` | 登录页公开信息：站点名、公告、实验室/设备/预约数、演示账号列表 | 公开 |
| GET | `/api/me` | 我的资料 | 登录 |
| PATCH | `/api/me` | 修改资料（姓名、院系、邮箱、手机号） | 登录 |
| POST | `/api/me/password` | 修改密码（校验原密码，改密后其它会话失效） | 登录 |
| GET | `/api/me/credit` | 我的信用台账 + 信用概览（分数、等级、近 180 天违约数、冻结信息） | 登录 |
| GET | `/api/me/violations` | 我的违约记录（分页） | 登录 |
| GET | `/api/me/quota` | 本周额度：额度、已用、剩余、周一 00:00 起止 | 登录 |
| GET | `/api/labs` | 实验室列表（按状态/关键字过滤，含设备统计） | 登录 |
| GET | `/api/labs/:id` | 实验室详情：设备列表（含当前是否占用）、未来停机、分类、排班模式 | 登录 |
| GET | `/api/labs/:id/today` | 实验室当日各设备空闲/占用概览（他人预约脱敏） | 登录 |
| GET | `/api/meta/categories` | 设备分类及数量（筛选用） | 登录 |
| GET | `/api/meta/booking-rules` | 状态标签、违约类型与分值、关键配置、R01~R12 规则说明 | 登录 |

### 8.2 设备与可用性（`device.routes.js`）

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/devices` | 设备目录：分页、实验室/类别/状态/关键字/仅可预约筛选、排序、今日与 7 天空闲概览 | 登录 |
| GET | `/api/devices/:id` | 设备详情：实验室、负责人、使用统计、每周排班、未来停机 | 登录 |
| GET | `/api/devices/:id/availability` | 可用时段（`?date=YYYY-MM-DD&days=1..31`）：排班、占用（脱敏）、可直接预约的空闲块与规则 | 登录 |
| GET | `/api/devices/common-availability` | 多设备共同空闲时段（`?deviceIds=1,2&days=7&minMinutes=60`） | 登录 |

### 8.3 预约与候补（`booking.routes.js`）

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| POST | `/api/bookings` | 提交预约申请（写事务内重新校验 R01~R12；免审批设备自动通过并生成签到码） | 登录 |
| GET | `/api/bookings` | 预约列表：`scope=mine/todo/active/history`，状态/实验室/设备/用户/日期/关键字/进行中过滤，分页 + 分状态计数 | 登录（可见范围按角色限定） |
| GET | `/api/bookings/export` | 导出预约 CSV（UTF-8 BOM，遵循可见范围） | 登录（同上） |
| GET | `/api/bookings/:id` | 预约详情：生命周期时间线 + 设备信息 + 取消/签到时限 | 本人 / 审批人 / 管理员 |
| POST | `/api/bookings/:id/approve` | 审批通过（生成签到码、通知申请人、按配置恢复此前扣分） | 教师(所辖) / 管理员 |
| POST | `/api/bookings/:id/reject` | 驳回（必填原因，通知申请人并释放时段触发候补补位） | 教师(所辖) / 管理员 |
| POST | `/api/bookings/batch-review` | 批量审批：`{ ids, action: approve\|reject, note }`，逐条返回成功/失败 | 教师(所辖) / 管理员 |
| POST | `/api/bookings/:id/cancel` | 取消预约（临近开始取消记「临时取消」违约，释放时段触发补位） | 本人 / 审批人 / 管理员 |
| POST | `/api/bookings/:id/checkin` | 现场签到：校验签到码 + 时间窗 | 本人 |
| POST | `/api/bookings/:id/checkout` | 签退：记录实际使用时长，超时记违约，提前结束则释放时段给候补 | 本人 / 审批人 / 管理员 |
| GET | `/api/bookings/mine/summary` | 我的待办：进行中、即将开始（最多 5 条）、待审批数、待签到列表 | 登录 |
| GET | `/api/waitlist` | 候补列表（可按 scope/status/deviceId 过滤，分页） | 登录（可见范围按角色限定） |
| POST | `/api/waitlist` | 加入候补（仅当时段确实被占用；防重复排队；返回排队位次） | 登录 |
| POST | `/api/waitlist/:id/leave` | 退出候补（若为待确认状态则顺延给下一位） | 本人 / 管理员 |
| POST | `/api/waitlist/:id/confirm` | 确认补位：把占位预约转为正式预约（重新校验冲突） | 本人 |
| POST | `/api/admin/jobs/run` | 手动执行一轮后台作业（返回本轮结果与累计计数） | 管理员 |

### 8.4 通知中心（`notification.routes.js`）

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/notifications` | 通知列表（`onlyUnread=true` 只看未读，返回未读数与分页） | 登录 |
| GET | `/api/notifications/unread-count` | 未读数（顶栏红点轮询） | 登录 |
| POST | `/api/notifications/:id/read` | 标记单条已读 | 登录 |
| POST | `/api/notifications/read-all` | 全部标记已读 | 登录 |

### 8.5 统计报表（`stats.routes.js`）

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/stats/dashboard` | 仪表盘聚合：概览 + 利用率 + 实验室汇总 + 热力图 + 用户排行 + 时间构成 + 趋势 | 登录（教师仅所辖实验室，学生仅概览） |
| GET | `/api/stats/overview` | 概览指标：用户/设备/预约/候补数量、状态分布、平均利用率 | 登录 |
| GET | `/api/stats/utilization` | 设备利用率排行（利用率 = 占用时长 ÷ 排班开放时长，可 `limit`） | 教师 / 管理员 |
| GET | `/api/stats/labs` | 实验室维度汇总（利用率、设备数、爽约数、设备间利用率差异） | 教师 / 管理员 |
| GET | `/api/stats/heatmap` | 星期 × 小时热力图 + 高峰时段 Top5（含预约条数） | 教师 / 管理员 |
| GET | `/api/stats/users` | 用户使用与履约统计：完成数、爽约数、时长、履约率、失信名单 | 教师 / 管理员 |
| GET | `/api/stats/composition` | 时间构成：已预约占用 / 空闲可用 / 维护停机的分钟数与占比 | 教师 / 管理员 |
| GET | `/api/stats/trend` | 逐日预约趋势（总量、完成、取消、爽约、待审批、分钟数） | 教师 / 管理员 |
| GET | `/api/stats/export/utilization` | 导出设备利用率 CSV | 教师 / 管理员 |

### 8.6 管理接口（`admin.routes.js`）

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| POST | `/api/admin/labs` | 新增实验室（编号/名称唯一），可同时指定负责人 | 管理员 |
| PATCH | `/api/admin/labs/:id` | 修改实验室（含负责人列表整体覆盖） | 管理员 |
| DELETE | `/api/admin/labs/:id` | 删除实验室（仍有设备时拒绝） | 管理员 |
| POST | `/api/admin/devices` | 新增设备（序列号唯一，可设免审批/签到要求/时长上下限/提前量） | 管理员 |
| PATCH | `/api/admin/devices/:id` | 修改设备；状态转为不可用时返回受影响的未来预约数 | 管理员 |
| DELETE | `/api/admin/devices/:id` | 删除设备；有在途预约时拒绝，有历史预约时改为标记「已报废」 | 管理员 |
| GET | `/api/admin/slots` | 每周排班列表（含实验室级/设备级与星期、起止时钟） | 管理员 |
| POST | `/api/admin/slots` | 新增排班（校验设备归属与时段重叠） | 管理员 |
| PATCH | `/api/admin/slots/:id` | 修改排班时间或启用状态 | 管理员 |
| DELETE | `/api/admin/slots/:id` | 删除排班 | 管理员 |
| GET | `/api/admin/blackouts` | 停机计划列表（可按实验室/设备/仅未来过滤，分页） | 管理员 |
| POST | `/api/admin/blackouts` | 新增停机计划，统计并通知受影响的在途预约 | 管理员 |
| DELETE | `/api/admin/blackouts/:id` | 删除停机计划 | 管理员 |
| GET | `/api/admin/users` | 用户列表（角色/状态/关键字过滤，含预约数、违约数、负责实验室数、信用概览） | 管理员 |
| POST | `/api/admin/users` | 新增用户（角色、初始口令、信用分、周额度、可负责实验室） | 管理员 |
| PATCH | `/api/admin/users/:id` | 修改用户（角色、额度、负责实验室、可选重置口令并踢出会话） | 管理员 |
| POST | `/api/admin/users/:id/freeze` | 冻结 / 解冻（`action=freeze\|unfreeze`，冻结需原因与天数） | 管理员 |
| POST | `/api/admin/users/:id/disable` | 停用 / 启用账号（不能停用自己，保留至少一名管理员） | 管理员 |
| POST | `/api/admin/users/:id/reset-password` | 重置指定用户口令并使其会话失效 | 管理员 |
| GET | `/api/admin/violations` | 违约记录列表 + 按类型统计（条数与扣分合计） | 管理员 |
| POST | `/api/admin/violations` | 手工登记违约（类型、分值、说明，可关联预约） | 管理员 |
| DELETE | `/api/admin/violations/:id` | 撤销违约记录并返还对应分数 | 管理员 |
| GET | `/api/admin/config` | 读取全部配置项（值、说明、默认值、类型） | 管理员 |
| PATCH | `/api/admin/config` | 批量修改配置（未知键与非负数字校验，写审计） | 管理员 |
| GET | `/api/admin/audit` | 审计日志（按动作前缀、操作人过滤，分页） | 管理员 |
| GET | `/api/admin/system` | 系统运行状态：各表行数、数据库路径/大小/journal_mode、后台作业、运行时信息 | 管理员 |
| GET | `/api/admin/capacity` | 各实验室未来 1~14 天逐日空闲分钟数与利用率 | 管理员 |

> 合计 **76** 个 REST 端点（认证与个人 11 + 实验室与元信息 5 + 设备 4 + 预约与候补 16 + 通知 4 + 统计 9 + 管理 27）。

## 9. 前端页面路由

前端为 hash 路由的单页应用（`public/js/app.js` 的 `ROUTES` 表）。带 `admin` 标记的路由仅 `role=admin` 可进；带 `staff` 标记的路由需 `canReview`（实验室负责人）或管理员。

| hash 路由 | 页面 | 可见角色 |
| --- | --- | --- |
| `#/` | 工作台（我的待办、进行中/即将开始、快捷入口） | 全部登录用户 |
| `#/devices` | 设备目录（与工作台共用渲染） | 全部登录用户 |
| `#/booking` | 预约设备（目录 + 筛选） | 全部登录用户 |
| `#/devices/:id` | 设备详情（可用时段时间轴、预约规则、发起预约/候补） | 全部登录用户 |
| `#/bookings` | 我的预约（Tab、筛选、导出） | 全部登录用户 |
| `#/bookings/:id` | 预约详情（生命周期时间线、签到/签退/取消操作） | 全部登录用户（数据可见范围受后端限制） |
| `#/review` | 审批中心（待审批、使用中、批量审批） | 实验室负责人 / 管理员 |
| `#/waitlist` | 候补队列（排队位次、限时确认、退出） | 全部登录用户 |
| `#/notifications` | 通知中心 | 全部登录用户 |
| `#/profile` | 个人中心（资料、改密、信用台账、违约记录、额度） | 全部登录用户 |
| `#/reports` | 统计报表 | 实验室负责人 / 管理员 |
| `#/admin` | 管理概览 | 管理员 |
| `#/admin/labs` | 实验室管理 | 管理员 |
| `#/admin/devices` | 设备管理 | 管理员 |
| `#/admin/schedule` | 排班与停机 | 管理员 |
| `#/admin/users` | 用户管理 | 管理员 |
| `#/admin/blacklist` | 违约与信用 | 管理员 |
| `#/admin/reports` | 统计报表 | 管理员 |
| `#/admin/config` | 系统配置 | 管理员 |
| `#/admin/audit` | 审计日志 | 管理员 |
| `#/admin/system` | 运行状态 | 管理员 |

## 10. 测试与验证

| 验证项 | 命令 | 前置条件 | 实测结果 |
| --- | --- | --- | --- |
| 自动化测试 | `node test/run.js`（或 `npm test`） | 无（使用内存数据库 `:memory:`，不影响 `data/lab.db`） | **46 个用例全部通过**，耗时约 0.4 秒 |
| HTTP 冒烟测试 | `node scripts/smoke.js` | **需先启动服务** | **46 项全部通过** |
| 演示数据自检 | `node scripts/check-seed.js` | 无（内存库运行） | **33 项全部通过** |
| 前端页面渲染验证 | `node scripts/verify-frontend.js` | **需先启动服务** | **30 项全部通过**（DOM 桩下真实渲染 20 个页面） |

自动化测试的 46 个用例分布：

| 测试文件 | 用例数 | 覆盖范围 |
| --- | --- | --- |
| `test/interval.test.js` | 9 | 左闭右开语义、包含判定、合并、差集、最短碎片过滤、排班−占用链路、窗口裁剪与总时长 |
| `test/conflict-rules.test.js` | 17 | R01~R12 逐条失败与通过、冲突明细、相邻时段衔接、设备级排班优先 |
| `test/booking-flow.test.js` | 20 | 提交/审批/驳回/取消/签到/签退/爽约、信用冻结与解冻、候补补位与超时顺延、**20 并发抢同一时段只有 1 条成功**、状态机非法迁移、可见范围、CSV 导出、后台提醒 |
| **合计** | **46** | — |

冒烟测试覆盖：公共信息与登录、鉴权与权限边界（越权 403/401）、设备目录与可用时段、完整预约闭环（申请 → 审批 → 签到 → 签退）、候补、通知、统计、管理端增删改（实验室/设备/排班/停机/配置）、手动后台作业、系统状态、审计日志、静态资源与 SPA 回退。

**运行须知**

- `node scripts/smoke.js` 中的「系统状态接口返回数据规模」会断言 `journal_mode = 'wal'`，因此**必须对文件数据库（默认 `data/lab.db`）运行**；若把服务跑在 `LAB_DB_PATH=:memory:` 这类内存库上，该项会失败（内存库的 journal_mode 为 `memory`）。
- 候补排队位次按 `created_at` 升序推导，并以自增 `id` 作为同毫秒的兜底比较键，因此连续快速加入候补也能得到稳定位次。
- `check-seed.js` 的「过期待审批预约」断言允许 24 小时的自然老化窗口（演示数据以生成时刻为锚点），因此脚本在任意时刻运行均稳定通过。

## 11. 配置项说明

全部配置存于 `config` 表（首次启动写入，共 23 项），可在「管理后台 → 系统配置」在线修改，读取走内存缓存、写入即失效，修改会写入审计日志。

| 配置键 | 默认值 | 含义 |
| --- | --- | --- |
| `site_name` | 高校实验室设备预约与共享管理系统 | 站点名称（登录页与顶栏显示） |
| `timezone_offset_minutes` | 480 | 时区偏移（分钟），480 = UTC+8，全系统时间换算基准 |
| `booking_advance_days` | 14 | 最多可提前预约的自然日数（R06） |
| `booking_min_lead_minutes` | 30 | 至少提前多少分钟提交（0 = 不限制，R05） |
| `cancel_deadline_hours` | 12 | 少于该小时数取消视为「临时取消」并扣分 |
| `checkin_grace_minutes` | 15 | 开始后多少分钟内未签到判定为爽约 |
| `checkin_open_before_minutes` | 30 | 开始前多少分钟开放签到 |
| `reminder_minutes` | 30 | 开始前多少分钟发送提醒（后台作业只发一次） |
| `overtime_grace_minutes` | 10 | 签退超过该分钟数判定超时占用并扣分；同时也是冲突检测的边界缓冲 |
| `max_weekly_minutes_default` | 240 | 新用户每周默认预约额度（分钟） |
| `max_active_bookings_per_user` | 5 | 同时在途（待审批 + 已通过 + 使用中）预约上限（R12） |
| `default_points_no_show` | 10 | 爽约扣分 |
| `default_points_late_cancel` | 5 | 临时取消扣分 |
| `default_points_overtime` | 5 | 超时占用扣分 |
| `credit_freeze_threshold` | 60 | 信用分低于该值自动冻结预约权限（并作为统计「失信名单」阈值） |
| `credit_freeze_days` | 30 | 自动冻结的解除天数（到期由后台作业解冻） |
| `credit_restore_on_approve` | 1 | 被扣分的预约重新获批时是否恢复分数（1/0） |
| `pending_blocks_others` | 1 | 待审批预约是否占用时段（1 = 占用，避免同一时段重复申请） |
| `waitlist_hold_minutes` | 60 | 候补补位后保留确认的分钟数，逾期顺延下一位 |
| `max_participants_per_booking` | 20 | 单次预约最大参与人数 |
| `announcement` | （空） | 首页公告，填了才显示 |

> 说明：`damage`（设备损坏，默认 20 分）与 `rule_break`（违规使用，默认 10 分）不在可配置项中，其分值定义在 `booking-rules.js` 的 `VIOLATION_TYPES`，仅管理员手工登记违约时使用（分值可在登记时覆盖，范围 1~100）。

## 12. 常见问题（FAQ）

**12.1 启动时报 `Cannot find module 'node:sqlite'`？**
Node 版本过低。`node:sqlite` 自 Node **22.5.0** 起提供，请升级到 22.5 以上（推荐 LTS 或当前的 24.x），用 `node -v` 确认。项目的 `package.json` 已声明 `"engines": { "node": ">=22.5.0" }`。

**12.2 端口 3000 被占用怎么办？**
用环境变量换端口（服务启动横幅会打印实际地址）：

```bash
# PowerShell（当前会话）
$env:PORT=3001; npm start

# CMD
set PORT=3001 && npm start

# Linux / macOS / Git Bash
PORT=3001 npm start
```

也可以用 `HOST` 限制监听地址（默认 `0.0.0.0`）。换端口后跑冒烟测试要带地址：`node scripts/smoke.js http://127.0.0.1:3001`。

**12.3 如何重置演示数据？**
三种等价方式：`npm run reset`、`node scripts/reseed.js`、双击 `scripts\reset-data.bat`（带二次确认）。重置会清空 `data/lab.db` 中的业务数据并重新生成一整套演示数据（15 用户 / 4 实验室 / 20 设备 / 60 条排班 / 8 条停机 / 约 700 条预约，其中**过去 30 天按真实使用密度填密**，使设备利用率落在约 19% 的可信区间 / 5 条候补 / 11 条违约），随后可用 `node scripts/check-seed.js` 自检。

**12.4 数据文件在哪里？能改路径吗？**
默认在 `data/lab.db`。WAL 模式下还会有 `data/lab.db-wal`（预写日志）和 `data/lab.db-shm`（共享内存索引）两个伴随文件，**它们和主库文件必须一起保留**；停止服务后 SQLite 会自动做检查点合并，但请勿手工删除其中之一。可用环境变量换位置：`$env:LAB_DB_PATH='D:\lab-data\lab.db'; npm start`。

**12.5 为什么测试不用 Node 内置的 `node:test`？**
因为本项目的开发和验证在受限沙箱环境中进行：`node:test` 的默认运行方式需要 `fork` 子进程并通过管道收集输出，而该环境会以 `EPERM` 拒绝子进程管道操作，导致测试无法运行。因此项目自研了零依赖测试框架（`test/runner.js` + `test/run.js`）：直接在当前进程内加载 `test/*.test.js`、串行执行用例、自行统计与着色输出，既避免了子进程，也保证了「零第三方依赖」这一约束。用法与常见框架一致：`test('名称', fn)` + `assert.equal / ok / deepEqual`，支持 `before` / `after` 钩子。

**12.6 如何修改业务规则（比如把签到宽限期从 15 分钟改成 20 分钟）？**
三种方式：① 管理后台「系统配置」页在线修改；② 调用 `PATCH /api/admin/config`，请求体如 `{ "checkin_grace_minutes": 20 }`；③ 直接改库（不推荐）。所有键的取值会被校验（未知键拒绝、数字项必须为非负数字），修改后配置缓存立即失效，并写入审计日志。各配置项含义见第 11 节。

**12.7 `npm run test:unit` / `npm run test:flow` 分别跑什么？**
`test/run.js` 的参数是**文件名关键字**过滤，支持逗号分隔多个关键字。因此：
- `npm run test:unit` → `node test/run.js interval,conflict-rules`，跑区间算法与 R01~R12 规则共 26 个用例；
- `npm run test:flow` → `node test/run.js booking`，跑业务流程与并发集成共 20 个用例；
- `npm test` → 跑全部 46 个用例。
若传入的关键字不匹配任何文件（例如 `node test/run.js foo`），运行器会提示「共发现 0 个测试文件」，这属于预期的过滤行为。

**12.8 签到失败，提示「尚未到签到时间」或「已超过签到宽限期」？**
签到有严格时间窗：最早为预约开始前 `checkin_open_before_minutes`（默认 30 分钟），最晚为开始后 `checkin_grace_minutes`（默认 15 分钟），超出即拒绝并提示；超期未签到的预约会被后台作业判为爽约（`no_show`）并扣分。另外签到码必须是审批通过时生成的 6 位数字，输错返回 `400 BAD_CHECKIN_CODE`。

**12.9 候补明明释放了时段，为什么没有补位？**
补位会为候补者重新跑一遍完整冲突校验，任一条件不满足都会跳过并尝试下一位：候补窗口与释放时段求交后不足 15 分钟（或不足设备最小时长）、交集起点已经过去、候补者自身时间冲突（R11）、额度或信用状态不满足（R12）等。排查时以 `LAB_DEBUG_PROMOTION=1` 启动服务，终端会打印每位候选被跳过的具体规则码与原因。

**12.10 项目介绍页（GitHub Pages）是怎么发布的？**
站点源码就在本仓库的 docs/ 目录里（docs/index.html + 16 张真实界面截图 + .nojekyll），无需任何构建步骤：

- **发布设置**：仓库 Settings → Pages → Source 选 Deploy from a branch，分支选 main、目录选 /docs，保存后访问 https://<用户名>.github.io/<仓库名>/；
- 仓库根目录还放了一个 index.html 跳转页：若把发布源设成 / (root)，它会把访问者送到 docs/index.html，避免 404；
- **本地预览**：node scripts/preview-pages.js，然后打开 http://127.0.0.1:4000/docs/index.html ；
- **重新生成截图**：先启动业务服务，再执行 node scripts/capture-screenshots.js（需本机有 Chrome/Edge，脚本通过 CDP 自动登录并逐页截图）。

## 13. 许可与说明

- 本项目以 **MIT License** 发布（见 `package.json` 的 `"license": "MIT"`），可自由用于学习、教学与二次开发。
- 本项目为**本科毕业设计作品**：代码、数据库结构、规则引擎、演示数据与验证脚本均为教学演示用途，未经过生产环境的安全加固与压力测试（例如未启用 HTTPS、未做多实例部署下的跨进程锁、会话存储为数据库单表）。
- 演示数据中的人名、学号、手机号、设备序列号等均为虚构，仅用于界面与报表展示；演示账号口令统一为 `123456`，仅便于答辩演示，实际部署前请重置全部口令并调整 `config` 中的默认策略。
