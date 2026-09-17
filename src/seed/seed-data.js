'use strict';

/**
 * 演示种子数据（唯一职责：把一套「像真实运行了三个月」的数据写进空库）
 * ==================================================================
 * 设计要点：
 *
 * 1) 依赖注入而非全局 db
 *    config.js / conflict-rules.js / availability.service.js 都通过 require('../db')
 *    取全局连接，而本模块会在 db/index.js 的 init() 里被 require（第 71 行），
 *    此时全局连接尚未赋值。因此这里**不引用那些模块**，只使用传入的 DatabaseSync
 *    实例；时间与区间算法仍然复用 utils/time.js 与 core/interval.js，绝不重复实现。
 *
 * 2) 全量确定性
 *    随机数来自自实现的 mulberry32（固定种子），业务时间全部由 PRNG 推导，
 *    唯一的外部输入是「当前时刻 Date.now()」这一锚点 —— 保证同一天多次运行、
 *    自动化测试断言、答辩演示截图三者的数据完全一致。
 *
 * 3) 内部一致性由写入路径保证，而不是由「事后修补」保证
 *    - 同一设备的占用区间（pending/approved/checked_in/completed）在写入前用
 *      interval.overlaps 判重，冲突就重新取时间或跳过 → 天然 0 重叠；
 *    - 所有 credit_records 都经 applyCredit 写入，分数序列 = 100 依次累加，
 *      因此「台账累加 == users.credit_score」是构造性成立的。
 *
 * 分层：常量与数据表 → 通用工具 → 各实体写入 → 编排入口。
 */

const { hashPassword } = require('../core/password');
const interval = require('../core/interval');
const {
  MINUTE,
  DAY,
  formatDate,
  formatDateTime,
  startOfDay,
  addDays,
  weekdayOfDayStart,
} = require('../utils/time');

/** 时区：本系统面向国内高校，固定 UTC+8 */
const TZ = 480;

/** 排期网格：起止时刻一律对齐到 30 分钟，符合真实实验室排期习惯 */
const HALF_HOUR = 30 * MINUTE;

/** 全部演示账号的统一口令（scrypt 很慢，只算一次后复用，见 buildSeed） */
const DEMO_PASSWORD = '123456';

/** 固定随机种子：换掉它就会得到另一套同样合理的演示数据 */
const SEED = 20250412;

/** 数据规模（如需调整演示体量，只改这里） */
const PLAN = {
  pastDays: 75, // 历史数据回溯天数
  futureDays: 14, // 未来预约跨度（与 booking_advance_days 默认值一致）
  completed: 34,
  cancelled: 4,
  rejected: 5,
  future: 42,
  waitlist: 5,
};

/** config 表缺省值兜底（与 core/config.js 的 DEFAULTS 保持一致，便于独立运行） */
const CONFIG_FALLBACK = {
  timezone_offset_minutes: '480',
  max_participants_per_booking: '20',
  pending_blocks_others: '1',
  default_points_no_show: '10',
  default_points_late_cancel: '5',
  default_points_overtime: '5',
  credit_freeze_threshold: '60',
};

/* ================================================================== */
/* 一、静态数据表                                                      */
/* ================================================================== */

/** 4 个实验室：名称 / 编号 / 位置 / 容量 / 开放时间 / 使用规定 */
const LABS = [
  {
    key: 'ee',
    name: '电子技术基础实验室',
    code: 'LAB-EE-101',
    building: '逸夫楼',
    room: '301',
    capacity: 40,
    open_hours: '周一至周五 08:00-12:00、13:30-22:00；周六 09:00-12:00、13:00-17:00；周日及法定节假日闭馆',
    rules: [
      '1. 进入实验室须穿实验服，长发须束起，禁止穿拖鞋、凉鞋入内。',
      '2. 使用电烙铁、热风返修台等发热设备时不得离开工位，离开前必须断电。',
      '3. 示波器、信号发生器等仪器的探头与夹具用后归位，不得随意堆放或弯折。',
      '4. 严禁带电插拔器件、严禁私自拆解仪器外壳；仪器异常须立即报告值班教师。',
      '5. 实验结束后整理工位、关闭电源与门窗，填写《设备使用记录表》后方可离开。',
    ].join('\n'),
  },
  {
    key: 'iot',
    name: '嵌入式与物联网实验室',
    code: 'LAB-IOT-202',
    building: '逸夫楼',
    room: '405',
    capacity: 30,
    open_hours: '周一至周五 08:00-12:00、13:30-22:00；周六 09:00-12:00、13:00-17:00；周日不开放',
    rules: [
      '1. 开发板、仿真器、传感器模块须凭预约记录在管理员处登记领用，用毕当日归还。',
      '2. 实验室采用防静电工作台，接触开发板前请先佩戴防静电手环并接地。',
      '3. 禁止在实验室内私接大功率电器或在开发板上外接市电供电电路。',
      '4. 网关与路由设备为教学共用资源，不得修改其 IP 段与无线配置。',
    ].join('\n'),
  },
  {
    key: 'me',
    name: '机械加工与 3D 打印中心',
    code: 'LAB-ME-103',
    building: '工程训练中心',
    room: '一层 103',
    capacity: 25,
    open_hours: '周一至周五 08:00-12:00、13:30-22:00；周六 09:00-12:00、13:00-17:00；周日闭馆检修',
    rules: [
      '1. 进入加工区必须佩戴护目镜，操作旋转设备时严禁戴手套、围巾等易卷入物品。',
      '2. 激光切割机、数控雕刻机须经安全培训并考核合格后方可独立操作，禁止单人无人监护作业。',
      '3. 激光切割仅允许加工亚克力、木板、皮革等许可材料，严禁切割 PVC 等含氯材料。',
      '4. 3D 打印完成后须待热床冷却再取件，废料、支撑与失败件按分类投入回收箱。',
      '5. 使用完毕清理台面与排屑，关闭设备总电源与除尘系统，如实填写设备使用记录。',
    ].join('\n'),
  },
  {
    key: 'ai',
    name: '人工智能与高性能计算实验室',
    code: 'LAB-AI-501',
    building: '信息楼',
    room: '512',
    capacity: 20,
    open_hours: '周一至周五 08:00-12:00、13:30-22:00；周六 09:00-12:00、13:00-17:00；周日机房巡检不开放',
    rules: [
      '1. 本实验室实行刷卡进入与全程视频监控，仅限已获批准的预约人员使用。',
      '2. GPU 服务器须通过 SSH 提交任务，禁止在服务器上运行与预约课题无关的挖矿、转码等负载。',
      '3. 数据集与模型权重请存放在个人目录（/home/学号）下，公共目录只读，严禁写入。',
      '4. 发现显卡温度异常、风扇异响或节点掉线，请立即停止任务并通知管理员。',
      '5. 机房内禁止饮食、禁止拔插机柜电源与网线，离开前确认个人进程已退出。',
    ].join('\n'),
  },
];

/**
 * 20 台设备。
 * status 取值分布：3 台 maintenance（3D 打印机排障、激光切割机光路维修、桌面 CNC 保养）、
 * 1 台 offline（高低温试验箱搬迁待安装）、其余 available；
 * auto_approve = 1 的 5 台均为低价值、低风险的教学套件类设备，走自动审批以减轻教师负担。
 */
const DEVICES = [
  /* ---------------- 电子技术基础实验室（逸夫楼 301） ---------------- */
  {
    key: 'scope',
    lab: 'ee',
    name: '数字示波器',
    category: '测量仪器',
    brand: 'Tektronix',
    model: 'MDO3024',
    status: 'available',
    auto_approve: 0,
    price_fen: 9800000,
    purchase_date: '2021-03-15',
    location: '逸夫楼 301-设备柜 A3',
    min_minutes: 30,
    max_minutes: 240,
    lead_minutes: 0,
    description:
      '4 通道 200 MHz 混合域示波器，带 16 路逻辑通道与频谱分析功能，适合数字电路时序分析、串行总线（I2C/SPI/UART）解码与开关电源纹波测量。',
  },
  {
    key: 'signal',
    lab: 'ee',
    name: '函数信号发生器',
    category: '测量仪器',
    brand: 'RIGOL',
    model: 'DG1022Z',
    status: 'available',
    auto_approve: 0,
    price_fen: 3200000,
    purchase_date: '2021-04-02',
    location: '逸夫楼 301-设备柜 A4',
    min_minutes: 30,
    max_minutes: 180,
    lead_minutes: 0,
    description:
      '双通道 25 MHz 任意波形发生器，支持正弦、方波、脉冲及任意波编辑，常用于模拟电路实验的激励信号源与滤波器幅频特性测试。',
  },
  {
    key: 'dmm',
    lab: 'ee',
    name: '数字万用表',
    category: '测量仪器',
    brand: 'Keysight',
    model: '34461A',
    status: 'available',
    auto_approve: 1,
    price_fen: 780000,
    purchase_date: '2022-09-08',
    location: '逸夫楼 301-实验台 B2',
    min_minutes: 30,
    max_minutes: 240,
    lead_minutes: 0,
    description:
      '6½ 位真有效值台式万用表，直流电压年准确度 0.0035%，适合元件参数标定、电源输出精度校验等对读数精度要求较高的基础测量。',
  },
  {
    key: 'labpower',
    lab: 'ee',
    name: '直流稳压电源',
    category: '电源设备',
    brand: 'ITECH',
    model: 'IT6302',
    status: 'available',
    auto_approve: 0,
    price_fen: 1680000,
    purchase_date: '2021-03-15',
    location: '逸夫楼 301-实验台 B1',
    min_minutes: 30,
    max_minutes: 480,
    lead_minutes: 0,
    description:
      '三路输出可编程直流电源（30V/3A×2 + 5V/3A），支持串联跟踪与过压过流保护，为运放电路、电机驱动与嵌入式系统提供稳定供电。',
  },
  {
    key: 'probe',
    lab: 'ee',
    name: '示波器高压差分探头组',
    category: '附件配件',
    brand: 'Tektronix',
    model: 'TPP0500B（4 支装）',
    status: 'available',
    auto_approve: 1,
    price_fen: 260000,
    purchase_date: '2023-03-20',
    location: '逸夫楼 301-设备柜 A5',
    min_minutes: 30,
    max_minutes: 240,
    lead_minutes: 0,
    description:
      '500 MHz 无源探头四支装，输入电容 3.9 pF，配套数字示波器用于高频信号探测，可避免普通探头在快速边沿测量中引入的振铃。',
  },
  {
    key: 'hotair',
    lab: 'ee',
    name: '热风返修台',
    category: '加工工具',
    brand: 'QUICK',
    model: '861DW',
    status: 'available',
    auto_approve: 0,
    price_fen: 420000,
    purchase_date: '2022-11-01',
    location: '逸夫楼 301-北侧工作台',
    min_minutes: 30,
    max_minutes: 180,
    lead_minutes: 30,
    description:
      '1000 W 数显热风返修台，风量与温度闭环可调，用于 QFN、BGA 等贴片器件的拆焊与返修，是电子工艺实习与毕业设计打样的常用工具。',
  },
  /* ---------------- 嵌入式与物联网实验室（逸夫楼 405） ---------------- */
  {
    key: 'rpi5',
    lab: 'iot',
    name: '树莓派 5 实验套件',
    category: '嵌入式平台',
    brand: 'Raspberry Pi',
    model: 'Pi 5 8GB 套件',
    status: 'available',
    auto_approve: 1,
    price_fen: 128000,
    purchase_date: '2024-03-12',
    location: '逸夫楼 405-器材柜 C1',
    min_minutes: 30,
    max_minutes: 240,
    lead_minutes: 0,
    description:
      '含 8GB 主板、官方电源、散热风扇与 128GB 高速卡的入门套件，常用于 Linux 系统实验、轻量级边缘推理与机器视觉课程综合实践。',
  },
  {
    key: 'stm32',
    lab: 'iot',
    name: 'STM32 开发板套件',
    category: '嵌入式平台',
    brand: 'STMicroelectronics',
    model: 'STM32F407ZGT6',
    status: 'available',
    auto_approve: 1,
    price_fen: 96000,
    purchase_date: '2023-09-05',
    location: '逸夫楼 405-器材柜 C2',
    min_minutes: 30,
    max_minutes: 240,
    lead_minutes: 0,
    description:
      '基于 Cortex-M4 的 STM32F407 开发板，配套 ST-Link 仿真器与常用外设模块，用于单片机原理、嵌入式实时系统与传感器接口实验。',
  },
  {
    key: 'esp32',
    lab: 'iot',
    name: 'ESP32 物联网节点',
    category: '物联网节点',
    brand: 'Espressif',
    model: 'ESP32-S3-DevKitC-1',
    status: 'available',
    auto_approve: 1,
    price_fen: 68000,
    purchase_date: '2024-05-18',
    location: '逸夫楼 405-器材柜 C3',
    min_minutes: 30,
    max_minutes: 180,
    lead_minutes: 0,
    description:
      '集成 Wi-Fi 与 BLE 5 的物联网开发节点，支持 MQTT 上云与低功耗休眠，常用于无线传感网络组网、智能家居原型与课程设计作品开发。',
  },
  {
    key: 'logic',
    lab: 'iot',
    name: '逻辑分析仪',
    category: '测量仪器',
    brand: 'Saleae',
    model: 'Logic 8',
    status: 'available',
    auto_approve: 1,
    price_fen: 156000,
    purchase_date: '2021-10-25',
    location: '逸夫楼 405-器材柜 C4',
    min_minutes: 30,
    max_minutes: 240,
    lead_minutes: 30,
    description:
      '8 通道 USB 逻辑分析仪，最高 100 MS/s 采样，可解码 I2C、SPI、UART、CAN 等总线协议，用于排查嵌入式通信时序错误。',
  },
  {
    key: 'spectrum',
    lab: 'iot',
    name: '频谱分析仪',
    category: '测量仪器',
    brand: 'RIGOL',
    model: 'DSA815',
    status: 'available',
    auto_approve: 0,
    price_fen: 5600000,
    purchase_date: '2021-06-30',
    location: '逸夫楼 405-仪器柜 D1',
    min_minutes: 60,
    max_minutes: 240,
    lead_minutes: 120,
    description:
      '9 kHz~1.5 GHz 频谱分析仪，用于无线通信实验中的载波频率、杂散与谐波分量测量，也可配合近场探头做电路板 EMI 初步定位。',
  },
  {
    key: 'envchamber',
    lab: 'iot',
    name: '高低温交变试验箱',
    category: '环境试验设备',
    brand: '爱斯佩克',
    model: 'ESPEC SH-242',
    status: 'offline',
    auto_approve: 0,
    price_fen: 8600000,
    purchase_date: '2020-12-08',
    location: '逸夫楼 405-东侧试验区',
    min_minutes: 120,
    max_minutes: 480,
    lead_minutes: 120,
    description:
      '-40℃~+150℃ 高低温交变试验箱，用于传感器与电路模块的温度循环、老化筛选试验；目前因搬迁待重新安装调试，暂停预约。',
  },
  /* ---------------- 机械加工与 3D 打印中心（工程训练中心 103） ---------------- */
  {
    key: 'prusa',
    lab: 'me',
    name: 'FDM 3D 打印机',
    category: '增材制造',
    brand: 'Prusa',
    model: 'i3 MK3S+',
    status: 'maintenance',
    auto_approve: 0,
    price_fen: 680000,
    purchase_date: '2022-04-18',
    location: '工程训练中心 103-打印区 2 号机位',
    min_minutes: 60,
    max_minutes: 480,
    lead_minutes: 30,
    description:
      '250×210×210 mm 打印幅面的 FDM 打印机，支持 PLA/PETG 等材料，用于机械结构件、外壳与夹具的快速打样；当前热端堵塞待更换，暂停预约。',
  },
  {
    key: 'laser',
    lab: 'me',
    name: '激光切割机',
    category: '减材制造',
    brand: '金威刻',
    model: 'JW-6040（80W CO₂）',
    status: 'maintenance',
    auto_approve: 0,
    price_fen: 4200000,
    purchase_date: '2021-05-20',
    location: '工程训练中心 103-激光区',
    min_minutes: 30,
    max_minutes: 180,
    lead_minutes: 30,
    description:
      '600×400 mm 幅面 CO₂ 激光切割机，可切割亚克力、木板、皮革并雕刻阳极氧化铝，用于结构件与创意作品加工；光路镜片正在更换，暂停预约。',
  },
  {
    key: 'cnc',
    lab: 'me',
    name: '桌面级数控雕刻机',
    category: '减材制造',
    brand: 'Genmitsu',
    model: 'PROVerXL 4030',
    status: 'available',
    auto_approve: 0,
    price_fen: 1350000,
    purchase_date: '2022-07-14',
    location: '工程训练中心 103-雕刻区',
    min_minutes: 60,
    max_minutes: 180,
    lead_minutes: 120,
    description:
      '400×300×110 mm 行程三轴数控雕刻机，可加工木材、亚克力与软铝，用于机械零件铣削、铭牌雕刻与夹具加工实训。',
  },
  {
    key: 'workstation',
    lab: 'me',
    name: '三维扫描与逆向工程工作站',
    category: '其他',
    brand: '先临三维',
    model: 'EinScan Pro 2X',
    status: 'available',
    auto_approve: 0,
    price_fen: 3200000,
    purchase_date: '2023-11-16',
    location: '工程训练中心 103-扫描台',
    min_minutes: 60,
    max_minutes: 240,
    lead_minutes: 120,
    description:
      '手持式结构光三维扫描仪与配套建模工作站，用于实物零件的点云采集与逆向建模，为 3D 打印修复件、测绘类毕业设计提供数据来源。',
  },
  /* ---------------- 人工智能与高性能计算实验室（信息楼 512） ---------------- */
  {
    key: 'a100',
    lab: 'ai',
    name: 'GPU 服务器',
    category: '计算服务器',
    brand: '浪潮',
    model: 'NF5468M6 / NVIDIA A100 40G',
    status: 'available',
    auto_approve: 0,
    price_fen: 18800000,
    purchase_date: '2022-06-20',
    location: '信息楼 512-A 机柜 U12',
    min_minutes: 60,
    max_minutes: 360,
    lead_minutes: 120,
    description:
      '双路至强 + 4×A100 40G 训练服务器，配备 NVLink 与 2TB 内存，用于深度学习模型分布式训练、大模型微调与高性能计算课程实验。',
  },
  {
    key: 'rtx4090',
    lab: 'ai',
    name: '深度学习工作站',
    category: '计算服务器',
    brand: '联想',
    model: 'ThinkStation P3 / RTX 4090',
    status: 'available',
    auto_approve: 0,
    price_fen: 8600000,
    purchase_date: '2023-09-28',
    location: '信息楼 512-工位 08',
    min_minutes: 60,
    max_minutes: 360,
    lead_minutes: 30,
    description:
      '单卡 RTX 4090（24GB 显存）工作站，预装 CUDA 与 PyTorch 环境，适合计算机视觉课题的模型调试、小规模训练与推理性能测试。',
  },
  {
    key: 'rack',
    lab: 'ai',
    name: '边缘计算服务器机架',
    category: '其他',
    brand: '华为',
    model: 'TaiShan 200 边缘节点',
    status: 'available',
    auto_approve: 0,
    price_fen: 2400000,
    purchase_date: '2024-01-10',
    location: '信息楼 512-B 机柜 U03',
    min_minutes: 60,
    max_minutes: 240,
    lead_minutes: 30,
    description:
      '基于鲲鹏处理器的边缘计算节点，用于物联网数据汇聚、容器化部署与边缘推理实验，可与嵌入式实验室的传感节点组网联调。',
  },
  {
    key: 'dgx',
    lab: 'ai',
    name: '高性能计算节点',
    category: '计算服务器',
    brand: '曙光',
    model: 'I620-G30 双路 EPYC',
    status: 'available',
    auto_approve: 0,
    price_fen: 12600000,
    purchase_date: '2021-12-06',
    location: '信息楼 512-A 机柜 U20',
    min_minutes: 60,
    max_minutes: 360,
    lead_minutes: 120,
    description:
      '64 核 EPYC 计算节点，适合有限元仿真、数值优化与并行算法实验，常与 GPU 服务器配合完成「预处理 + 训练」的流水线任务。',
  },
];

/** 每周开放排班：lab 级模板（device_id = NULL）与 2 台设备的例外排班 */
const LAB_WEEKLY_TEMPLATE = [
  { weekdays: [1, 2, 3, 4, 5], start_min: 480, end_min: 720 }, // 08:00-12:00
  { weekdays: [1, 2, 3, 4, 5], start_min: 810, end_min: 1320 }, // 13:30-22:00
  { weekdays: [6], start_min: 540, end_min: 720 }, // 周六 09:00-12:00
  { weekdays: [6], start_min: 780, end_min: 1020 }, // 周六 13:00-17:00
];

/**
 * device 级例外排班。
 * 注意 conflict-rules.scheduleForRange 的语义：设备一旦存在自己的排班行，
 * lab 级排班对它整体失效 —— 所以这里的排班必须**自成完整周计划**。
 */
const DEVICE_WEEKLY_EXCEPTIONS = {
  a100: [
    { weekdays: [1, 2, 3, 4, 5], start_min: 540, end_min: 720 }, // 09:00-12:00
    { weekdays: [1, 2, 3, 4, 5], start_min: 840, end_min: 1080 }, // 14:00-18:00
  ],
  laser: [{ weekdays: [2, 4], start_min: 540, end_min: 1020 }], // 周二/周四 09:00-17:00
};

/** 停机计划：覆盖过去与未来，未来至少 2 条 */
const BLACKOUT_PLAN = [
  {
    key: 'laser-maint-future',
    device: 'laser',
    kind: 'maintenance',
    reason: '激光切割机光路镜片更换与工作台调平（厂家工程师上门）',
    startAt: 'D+3 08:00',
    endAt: 'D+5 18:00',
  },
  {
    key: 'envchamber-cal-future',
    device: 'envchamber',
    kind: 'calibration',
    reason: '高低温试验箱温湿度传感器送计量院校准后复位与验证',
    startAt: 'D+6 09:00',
    endAt: 'D+6 17:00',
  },
  {
    key: 'ee-fire-future',
    lab: 'ee',
    kind: 'event',
    reason: '逸夫楼消防演练：实验室封闭半天，全员参加疏散演练',
    startAt: 'D+8 13:30',
    endAt: 'D+8 17:00',
  },
  {
    key: 'iot-network-future',
    lab: 'iot',
    kind: 'maintenance',
    reason: '实验室交换机与无线 AP 升级，网络与门禁系统暂停服务',
    startAt: 'D+11 18:00',
    endAt: 'D+11 22:00',
  },
  {
    key: 'scope-calib-past',
    device: 'scope',
    kind: 'calibration',
    reason: '数字示波器年度计量送检：带宽与幅度准确度校验',
    startAt: 'D-42 08:00',
    endAt: 'D-40 17:00',
  },
  {
    key: 'ee-holiday-past',
    lab: 'ee',
    kind: 'holiday',
    reason: '国庆假期实验室封闭，封条管理并断电断水',
    startAt: 'D-38 18:00',
    endAt: 'D-31 08:00',
  },
  {
    key: 'me-safety-past',
    lab: 'me',
    kind: 'event',
    reason: '工程训练中心安全培训与设备点检，加工区当日不对学生开放',
    startAt: 'D-21 08:00',
    endAt: 'D-21 18:00',
  },
  {
    key: 'ai-power-past',
    lab: 'ai',
    kind: 'maintenance',
    reason: '机房 UPS 蓄电池组更换，服务器计划性停机',
    startAt: 'D-58 20:00',
    endAt: 'D-57 06:00',
  },
];

/** 预约用途与课程：按设备类别组合，保证 20 种以上不同表述且贴合设备真实用途 */
const PURPOSE_MATRIX = {
  测量仪器: {
    purposes: [
      '数字电路实验课信号测量与时序分析',
      '开关电源输出纹波与噪声测试',
      'I2C 总线通信时序抓取与协议解码',
      '运放幅频特性曲线测量',
      '传感器输出信号标定实验',
      '通信模块载波与杂散频谱测量',
    ],
    courses: ['模拟电子技术实验', '数字电路与逻辑设计', '电子测量技术', '传感器原理与应用', ''],
  },
  测量仪器_ee: {
    purposes: [
      '数字电路实验课信号测量与时序分析',
      '开关电源输出纹波与噪声测试',
      '运放幅频特性曲线测量',
      '毕业设计电路板关键节点波形验证',
      '单片机 PWM 输出占空比与死区测量',
    ],
    courses: ['模拟电子技术实验', '数字电路与逻辑设计', '电子测量技术', ''],
  },
  电源设备: {
    purposes: [
      '双电源运放电路供电与保护特性验证',
      '电机驱动板带载测试',
      '嵌入式系统整机功耗与效率测试',
      '锂电池充放电曲线测量实验',
    ],
    courses: ['模拟电子技术实验', '电力电子技术', '嵌入式系统设计', ''],
  },
  附件配件: {
    purposes: ['高频信号探测与探头补偿校准', '毕业设计测量工位搭建', '课程设计波形采集'],
    courses: ['电子测量技术', ''],
  },
  加工工具: {
    purposes: [
      '毕业设计样机贴片元件返修',
      'BGA 封装芯片拆焊练习',
      '电路板元器件更换与飞线修补',
    ],
    courses: ['电子工艺实习', ''],
  },
  嵌入式平台: {
    purposes: [
      '嵌入式系统课程实验：GPIO 与中断编程',
      'Linux 设备驱动开发实验',
      '边缘计算视觉推理原型验证',
      '物联网网关数据采集程序调试',
      '毕业设计智能小车控制板开发',
      'FreeRTOS 多任务调度实验',
    ],
    courses: ['嵌入式系统设计', '单片机原理与应用', '物联网技术导论', '操作系统实验', ''],
  },
  物联网节点: {
    purposes: [
      '无线传感网络组网与 MQTT 上云实验',
      '低功耗休眠策略功耗测量',
      '智能家居原型节点联调',
      '毕业设计环境监测终端开发',
    ],
    courses: ['物联网技术导论', '无线传感器网络', ''],
  },
  环境试验设备: {
    purposes: ['传感器高低温循环老化筛选试验', '电路模块温度漂移测试'],
    courses: ['可靠性工程', ''],
  },
  增材制造: {
    purposes: [
      '毕业设计样机外壳打印',
      '机械结构件与夹具快速打样',
      '课程设计创意作品制作',
      '3D 打印参数对成型精度影响实验',
    ],
    courses: ['机械制造技术基础', '增材制造技术', '工程训练', ''],
  },
  减材制造: {
    purposes: [
      '亚克力结构件激光切割加工',
      '木质机构零件数控铣削',
      '毕业设计作品铭牌雕刻',
      '机械零件尺寸精度加工实验',
      '逆向工程扫描件的减材复现',
    ],
    courses: ['机械制造技术基础', '工程训练', '先进制造技术', ''],
  },
  计算服务器: {
    purposes: [
      '深度学习模型训练（图像分类课题）',
      '大语言模型微调实验',
      '目标检测模型消融实验',
      '有限元仿真并行计算作业',
      '毕业设计模型训练与超参搜索',
      '高性能计算课程 MPI 并行程序调试',
    ],
    courses: ['机器学习', '深度学习实践', '高性能计算', '人工智能导论', ''],
  },
  其他: {
    purposes: [
      '三维扫描与逆向建模数据采集',
      '集群作业调度与配额管理实验',
      '边缘节点容器化部署实验',
      '毕业设计实验数据整理与归档',
    ],
    courses: ['逆向工程与快速成型', '高性能计算', ''],
  },
};

/**
 * 违约与信用修复编排。
 * 说明：
 *   - type='no_show' 的条目既是「该生需要几条爽约记录」的声明，也是爽约预约的数量来源：
 *     每声明一条就锁定一条真实历史预约判为 no_show，因此「声明数 == bookings 里的爽约数 ==
 *     落到谁头上」三者严格一致，演示数据永远稳定；
 *   - 其余条目直接落成 violations + credit_records；
 *   - 每条记录都写明 at（相对锚点），使台账时间序列与预约历史交织、看起来是长期积累的结果；
 *   - 100 − Σ扣分 + Σ加分 == target，其中 student5 落到 55 触发冻结，student8 落到 70 保持活跃。
 */
const CREDIT_PLAN = [
  {
    username: 'student4',
    target: 62,
    events: [
      { type: 'no_show', points: 10, at: 'D-66 10:20', note: '预约数字示波器未签到' },
      { type: 'late_cancel', points: 5, at: 'D-37 09:15', note: '预约开始前 1 小时取消' },
      { type: 'rule_break', points: 10, at: 'D-23 16:05', note: '未穿实验服进入实验室并私自更换探头' },
      { type: 'overtime', points: 5, at: 'D-14 21:35', note: '超时 25 分钟未签退，影响后续预约' },
    ],
  },
  {
    username: 'student5',
    target: 55,
    events: [
      { type: 'no_show', points: 10, at: 'D-71 14:30', note: '预约 STM32 开发板未签到' },
      { type: 'damage', points: 20, at: 'D-18 15:20', note: '损坏示波器探头一支（探头尖端折断），照价赔偿并扣分' },
    ],
  },
  {
    username: 'student8',
    target: 70,
    events: [
      { type: 'no_show', points: 10, at: 'D-61 08:50', note: '预约激光切割机未签到' },
      { type: 'rule_break', points: 10, at: 'D-27 14:10', note: '在机房内饮食并遗留垃圾' },
      { type: 'overtime', points: 5, at: 'D-11 18:40', note: '超时 30 分钟未签退' },
    ],
  },
  {
    username: 'student11',
    target: 85,
    events: [{ type: 'late_cancel', points: 5, at: 'D-45 11:25', note: '预约开始前 4 小时取消' }],
  },
  {
    username: 'student2',
    target: 90,
    events: [{ type: 'late_cancel', points: 5, at: 'D-29 19:45', note: '预约开始前 5 小时取消' }],
  },
];

/* ================================================================== */
/* 二、通用工具                                                        */
/* ================================================================== */

/** mulberry32：32 位状态的确定性伪随机数发生器，替代 Math.random 以保证数据可复现 */
function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [min, max] 闭区间整数 */
function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** 从数组中确定性地取一个元素 */
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** 洗牌（Fisher–Yates），返回新数组 */
function shuffled(rng, arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** 自然日边界（UTC+8）：与 conflict-rules.eachDayInRange 的算法保持一致 */
function dayStartOf(ts, tz = TZ) {
  return Math.floor((ts + tz * MINUTE) / DAY) * DAY - tz * MINUTE;
}

/** 锚点 + 天数 + "HH:mm" → 毫秒时间戳（复用 time.js 的日历工具，避免重复实现自然日逻辑） */
function at(anchor, dayOffset, clockText) {
  const dayStart = dayStartOf(addDays(anchor, dayOffset));
  const hm = /^(\d{1,2}):(\d{2})$/.exec(clockText);
  if (!hm) throw new Error(`非法时刻：${clockText}`);
  return dayStart + Number(hm[1]) * 60 * MINUTE + Number(hm[2]) * MINUTE;
}

/** 解析 'D+3 08:00' / 'D-42 08:00' 这类相对时刻写法（带校验，避免静默产生 NaN） */
function parseRelativeAt(anchor, text) {
  const m = /^D([+-]\d+)\s+(\d{1,2}:\d{2})$/.exec(String(text).trim());
  if (!m) throw new Error(`非法相对时刻：${text}`);
  return at(anchor, Number(m[1]), m[2]);
}

/** 自然日 → "YYYY-MM-DD"（用于 code 前缀、采购日期等文本字段） */
function dateText(ts) {
  return formatDate(ts, TZ);
}

/** 插入一行，返回自增主键（统一把 BigInt 转成 Number，避免后续算术语义错误） */
function insertRow(db, sql, params) {
  return Number(db.prepare(sql).run(...params).lastInsertRowid);
}

/** 查询一行（node:sqlite 的 all() 返回数组，取首行即可） */
function queryOne(db, sql, params = []) {
  const rows = db.prepare(sql).all(...params);
  return rows.length ? rows[0] : null;
}

/** 读取 config 值：config 表由 core/config.js 自己维护，这里只读不写，缺省时回落到 DEFAULTS 快照 */
function configValue(db, key) {
  const row = queryOne(db, 'SELECT value FROM config WHERE key = ?', [key]);
  const raw = row ? row.value : CONFIG_FALLBACK[key];
  return raw === undefined ? '' : String(raw);
}

function configNumber(db, key) {
  const n = Number(configValue(db, key));
  return Number.isFinite(n) ? n : 0;
}

/* ================================================================== */
/* 三、排班 / 停机 / 占用 判定（与 conflict-rules 的语义保持一致的只读视图） */
/* ================================================================== */

/**
 * 生成某设备某天的开放区间。
 * 与 conflict-rules.scheduleForRange 的第 33~54 行语义一致：设备存在自己的 enabled
 * 排班行时，lab 级排班对它整体失效；否则使用 lab 级（device_id IS NULL）排班。
 * 这里直接查传入的 db 实例，因此不依赖全局连接，也不重复劳动时间算法（仅做区间合并）。
 */
function scheduleIntervals(deviceId, labId, dayStart, slotRows) {
  const own = slotRows.filter((r) => r.device_id === deviceId);
  const source = own.length ? own : slotRows.filter((r) => r.device_id === null && r.lab_id === labId);
  const weekday = weekdayOfDayStart(dayStart, TZ);
  return interval.merge(
    source
      .filter((r) => r.weekday === weekday && r.enabled === 1)
      .map((r) => ({ start: dayStart + r.start_min * MINUTE, end: dayStart + r.end_min * MINUTE })),
  );
}

/** 该设备在该自然日的停机/封闭区间（设备级 + 所属实验室级） */
function blackoutIntervals(deviceId, labId, dayStart, blackouts) {
  const dayEnd = dayStart + DAY;
  return blackouts
    .filter(
      (b) =>
        (b.deviceId === deviceId || (b.deviceId === null && b.labId === labId)) &&
        b.start_at < dayEnd &&
        b.end_at > dayStart,
    )
    .map((b) => ({ start: b.start_at, end: b.end_at }));
}

/** 判断 [start,end) 是否完全落在排班区间内（左闭右开，与 R08 的「完整覆盖」一致） */
function coveredBySchedule(schedule, start, end) {
  return schedule.some((s) => s.start <= start && s.end >= end);
}

/** 判断 [start,end) 是否与任一停机区间重叠 */
function hitsBlackout(blackouts, start, end) {
  return blackouts.some((b) => interval.overlaps(b, { start, end }));
}

/** 占用区间登记簿：deviceId -> [{start,end}]，用于「0 重叠」的构造性保证 */
function createBusyMap() {
  const map = new Map();
  return {
    list(deviceId) {
      return map.get(deviceId) || [];
    },
    has(deviceId, start, end) {
      return this.list(deviceId).some((iv) => interval.overlaps(iv, { start, end }));
    },
    add(deviceId, start, end) {
      if (!map.has(deviceId)) map.set(deviceId, []);
      map.get(deviceId).push({ start, end });
    },
    remove(deviceId, start, end) {
      const list = map.get(deviceId);
      if (!list) return;
      const idx = list.findIndex((iv) => iv.start === start && iv.end === end);
      if (idx >= 0) list.splice(idx, 1);
    },
  };
}

/** 同一用户自身也不允许时段重叠（对应 R11），避免出现「一个人同时在两台设备上」的假数据 */
function createUserBusyMap() {
  const map = new Map();
  return {
    has(userId, start, end) {
      return (map.get(userId) || []).some((iv) => interval.overlaps(iv, { start, end }));
    },
    add(userId, start, end) {
      if (!map.has(userId)) map.set(userId, []);
      map.get(userId).push({ start, end });
    },
    remove(userId, start, end) {
      const list = map.get(userId);
      if (!list) return;
      const idx = list.findIndex((iv) => iv.start === start && iv.end === end);
      if (idx >= 0) list.splice(idx, 1);
    },
  };
}

/** 把区间拆成互不重叠的「最大空闲片段」（用于制造合理的候补请求） */
function gapsInside(intervals, start, end) {
  const out = [];
  let cursor = start;
  for (const iv of intervals.slice().sort((a, b) => a.start - b.start)) {
    if (iv.end <= cursor || iv.start >= end) continue;
    if (iv.start > cursor) out.push({ start: cursor, end: Math.min(iv.start, end) });
    cursor = Math.max(cursor, iv.end);
    if (cursor >= end) break;
  }
  if (cursor < end) out.push({ start: cursor, end });
  return out.filter((g) => g.end > g.start);
}

/* ================================================================== */
/* 四、实体写入                                                        */
/* ================================================================== */

/** 用户定义：含 1 管理员 + 3 教师 + 11 学生 */
function buildUserDefs() {
  return [
    {
      username: 'admin',
      name: '系统管理员',
      role: 'admin',
      department: '实验室与设备管理处',
      student_no: '',
      weekly_quota_min: 600,
      phone: '13800010001',
    },
    {
      username: 'teacher',
      name: '李明远',
      role: 'teacher',
      department: '电子信息学院',
      student_no: '',
      weekly_quota_min: 600,
      phone: '13800010002',
    },
    {
      username: 'teacher2',
      name: '陈静',
      role: 'teacher',
      department: '机械工程学院',
      student_no: '',
      weekly_quota_min: 600,
      phone: '13800010003',
    },
    {
      username: 'teacher3',
      name: '王建国',
      role: 'teacher',
      department: '计算机学院',
      student_no: '',
      weekly_quota_min: 600,
      phone: '13800010004',
    },
    {
      username: 'student',
      name: '张思远',
      role: 'student',
      department: '电子信息学院',
      student_no: '2021010301',
      weekly_quota_min: 360,
      phone: '13800010005',
    },
    {
      username: 'student2',
      name: '刘雨桐',
      role: 'student',
      department: '电子信息学院',
      student_no: '2021010312',
      weekly_quota_min: 240,
      phone: '13800010006',
    },
    {
      username: 'student3',
      name: '赵子豪',
      role: 'student',
      department: '计算机学院',
      student_no: '2021020117',
      weekly_quota_min: 360,
      phone: '13800010007',
    },
    {
      username: 'student4',
      name: '孙嘉怡',
      role: 'student',
      department: '计算机学院',
      student_no: '2021020145',
      weekly_quota_min: 240,
      phone: '13800010008',
    },
    {
      username: 'student5',
      name: '周浩然',
      role: 'student',
      department: '机械工程学院',
      student_no: '2021030208',
      weekly_quota_min: 240,
      phone: '13800010009',
    },
    {
      username: 'student6',
      name: '吴梦琪',
      role: 'student',
      department: '机械工程学院',
      student_no: '2021030233',
      weekly_quota_min: 360,
      phone: '13800010010',
    },
    {
      username: 'student7',
      name: '郑一鸣',
      role: 'student',
      department: '电子信息学院',
      student_no: '2021010356',
      weekly_quota_min: 360,
      phone: '13800010011',
    },
    {
      username: 'student8',
      name: '林晓彤',
      role: 'student',
      department: '计算机学院',
      student_no: '2021020203',
      weekly_quota_min: 240,
      phone: '13800010012',
    },
    {
      username: 'student9',
      name: '黄博文',
      role: 'student',
      department: '计算机学院',
      student_no: '2021020229',
      weekly_quota_min: 360,
      phone: '13800010013',
    },
    {
      username: 'student10',
      name: '何雅雯',
      role: 'student',
      department: '机械工程学院',
      student_no: '2021030247',
      weekly_quota_min: 240,
      phone: '13800010014',
    },
    {
      username: 'student11',
      name: '马俊杰',
      role: 'student',
      department: '电子信息学院',
      student_no: '2021010388',
      weekly_quota_min: 360,
      phone: '13800010015',
    },
  ];
}

/** 写入用户；所有演示账号复用同一份 hash（scrypt 单次约 60ms，避免 15 次重复计算） */
function insertUsers(db, defs, passwordHash, createdAt) {
  const ids = new Map();
  for (const def of defs) {
    const id = insertRow(
      db,
      `INSERT INTO users
         (username, password_hash, name, role, email, phone, department, student_no,
          credit_score, status, frozen_reason, frozen_until, weekly_quota_min, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?)`,
      [
        def.username,
        passwordHash,
        def.name,
        def.role,
        `${def.username}@example.edu.cn`,
        def.phone,
        def.department,
        def.student_no,
        100,
        'active',
        def.weekly_quota_min,
        createdAt,
        createdAt,
      ],
    );
    ids.set(def.username, id);
  }
  return ids;
}

/** 写入实验室，created_at 指向数据生成时刻（排班/设备都会晚于它，保持时间线合理） */
function insertLabs(db, createdAt) {
  const ids = new Map();
  for (const lab of LABS) {
    ids.set(
      lab.key,
      insertRow(
        db,
        `INSERT INTO labs (name, code, building, room, capacity, open_hours, rules, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          lab.name,
          lab.code,
          lab.building,
          lab.room,
          lab.capacity,
          lab.open_hours,
          lab.rules,
          createdAt,
          createdAt,
        ],
      ),
    );
  }
  return ids;
}

/** 写入实验室负责人（1 位负责人可负责多个实验室，因此这里按「一条记录一个实验室」写） */
function insertLabManagers(db, managers, labIds, userIds, createdAt) {
  const rows = [];
  for (const item of managers) {
    rows.push(
      insertRow(
        db,
        'INSERT INTO lab_managers (lab_id, user_id, created_at) VALUES (?, ?, ?)',
        [labIds.get(item.lab), userIds.get(item.username), createdAt],
      ),
    );
  }
  return rows;
}

/** lab -> 负责人用户 id 列表（审批人只能从「该实验室负责人 + 管理员」里选） */
function buildManagerIndex(managers, labIds, userIds) {
  const index = new Map();
  for (const item of managers) {
    const labId = labIds.get(item.lab);
    if (!index.has(labId)) index.set(labId, []);
    index.get(labId).push(userIds.get(item.username));
  }
  return index;
}

/** 写入 20 台设备：owner 取所属实验室负责人，created_at 锚在数据生成时刻 */
function insertDevices(db, deviceDefs, labIds, owners, createdAt) {
  const ids = new Map();
  for (const dev of deviceDefs) {
    const id = insertRow(
      db,
      `INSERT INTO devices
         (lab_id, name, category, model, brand, serial_no, status, price_fen, purchase_date, location,
          owner_id, auto_approve, checkin_required, min_minutes, max_minutes, lead_minutes,
          description, images, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, '[]', ?, ?)`,
      [
        labIds.get(dev.lab),
        dev.name,
        dev.category,
        dev.model,
        dev.brand,
        dev.serialNo,
        dev.status,
        dev.price_fen,
        dev.purchase_date,
        dev.location,
        owners.get(dev.lab),
        dev.auto_approve,
        dev.min_minutes,
        dev.max_minutes,
        dev.lead_minutes,
        dev.description,
        createdAt,
        createdAt,
      ],
    );
    ids.set(dev.key, id);
  }
  return ids;
}

/** 写入每周开放排班（lab 级模板 4 行/实验室 + 2 台设备的例外排班） */
function insertWeeklySlots(db, labIds, deviceIds, createdAt) {
  let count = 0;
  for (const lab of LABS) {
    const labId = labIds.get(lab.key);
    for (const tpl of LAB_WEEKLY_TEMPLATE) {
      for (const weekday of tpl.weekdays) {
        insertRow(
          db,
          `INSERT INTO weekly_slots (lab_id, device_id, weekday, start_min, end_min, enabled, created_at)
           VALUES (?, NULL, ?, ?, ?, 1, ?)`,
          [labId, weekday, tpl.start_min, tpl.end_min, createdAt],
        );
        count += 1;
      }
    }
  }
  for (const [deviceKey, slots] of Object.entries(DEVICE_WEEKLY_EXCEPTIONS)) {
    const dev = DEVICES.find((d) => d.key === deviceKey);
    const deviceId = deviceIds.get(deviceKey);
    const labId = labIds.get(dev.lab);
    for (const slot of slots) {
      for (const weekday of slot.weekdays) {
        insertRow(
          db,
          `INSERT INTO weekly_slots (lab_id, device_id, weekday, start_min, end_min, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
          [labId, deviceId, weekday, slot.start_min, slot.end_min, createdAt],
        );
        count += 1;
      }
    }
  }
  return count;
}

/** 展平停机计划：把 'D±n HH:mm' 转成绝对时间戳 */
function materializeBlackouts(anchor) {
  return BLACKOUT_PLAN.map((b) => {
    const dev = b.device ? DEVICES.find((d) => d.key === b.device) : null;
    return {
      key: b.key,
      labKey: b.lab || (dev ? dev.lab : null),
      deviceKey: b.device || null,
      kind: b.kind,
      reason: b.reason,
      start_at: parseRelativeAt(anchor, b.startAt),
      end_at: parseRelativeAt(anchor, b.endAt),
    };
  });
}

/** 写入停机计划 */
function insertBlackouts(db, plan, labIds, deviceIds, adminId, createdAt) {
  const ids = new Map();
  for (const item of plan) {
    ids.set(
      item.key,
      insertRow(
        db,
        `INSERT INTO blackouts (lab_id, device_id, start_at, end_at, reason, kind, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          labIds.get(item.labKey),
          item.deviceKey ? deviceIds.get(item.deviceKey) : null,
          item.start_at,
          item.end_at,
          item.reason,
          item.kind,
          adminId,
          createdAt,
        ],
      ),
    );
  }
  return ids;
}

/**
 * 写入预约主表。
 * 调用方负责保证：占用状态不重叠 / 落在排班内 / 不撞停机计划 / 时长在设备允许范围内。
 */
function insertBooking(db, b) {
  return insertRow(
    db,
    `INSERT INTO bookings
       (code, device_id, lab_id, user_id, start_at, end_at, purpose, course_name, participants, status,
        checkin_code, checkin_checked, review_note, reject_reason, cancel_reason, reviewed_by, reviewed_at,
        checked_in_at, checked_out_at, actual_minutes, waitlist_id, reminder_sent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      b.code,
      b.device_id,
      b.lab_id,
      b.user_id,
      b.start_at,
      b.end_at,
      b.purpose,
      b.course_name,
      b.participants,
      b.status,
      b.checkin_code,
      b.checkin_checked,
      b.review_note,
      b.reject_reason,
      b.cancel_reason,
      b.reviewed_by,
      b.reviewed_at,
      b.checked_in_at,
      b.checked_out_at,
      b.actual_minutes,
      b.reminder_sent,
      b.created_at,
      b.updated_at,
    ],
  );
}

/** 写入候补队列 */
function insertWaitlist(db, w) {
  return insertRow(
    db,
    `INSERT INTO waitlist
       (device_id, user_id, start_at, end_at, purpose, status, promoted_at, expires_at, booking_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'waiting', 0, ?, NULL, ?, ?)`,
    [w.device_id, w.user_id, w.start_at, w.end_at, w.purpose, w.expires_at, w.created_at, w.created_at],
  );
}

/**
 * 信用台账的唯一写入口 —— 分两段式，保证台账「按时间读」也是自洽的：
 *
 *   ① applyCredit 只把变动追加到内存账本，同时维护 users.credit_score 的最终值；
 *   ② flushCredit 按 created_at 升序落库，score_after 即该时刻的余额。
 *
 * 为什么不在调用点直接 INSERT：违约事件的产生顺序（先落历史违约、再落爽约）与业务
 * 时间顺序并不一致，直接插入会让 score_after 与时间序列错位 —— 这是最难排查的一类
 * 数据不一致，因此从写入路径上彻底规避。
 */
function applyCredit(db, credits, userId, change, reason, refType, refId, atTs) {
  const cur = credits.get(userId) || { score: 100, updatedAt: 0, pending: [] };
  cur.score = Math.min(100, Math.max(0, cur.score + change));
  cur.updatedAt = Math.max(cur.updatedAt, atTs);
  cur.pending.push({ change, reason, refType, refId, at: atTs });
  credits.set(userId, cur);
  return refId;
}

/** 把内存账本按时间顺序落库，并把最终分值刷回 users（写操作集中在事务尾部） */
function flushCredit(db, credits) {
  let written = 0;
  for (const [userId, state] of credits.entries()) {
    const list = state.pending.slice().sort((a, b) => a.at - b.at || a.refId - b.refId);
    let score = 100;
    for (const item of list) {
      score = Math.min(100, Math.max(0, score + item.change));
      insertRow(
        db,
        `INSERT INTO credit_records (user_id, change_points, score_after, reason, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, item.change, score, item.reason, item.refType, item.refId, item.at],
      );
      written += 1;
    }
    if (score !== state.score) {
      // 走到这里说明台账与余额不一致，宁可让种子写入整体回滚也不要留下脏数据
      throw new Error(`信用台账不平衡：用户 ${userId} 台账累计 ${score} ≠ 内存余额 ${state.score}`);
    }
    db.prepare('UPDATE users SET credit_score = ?, updated_at = MAX(updated_at, ?) WHERE id = ?').run(
      state.score,
      state.updatedAt,
      userId,
    );
  }
  return written;
}

/** 写入违约记录（points 为正数，表示扣分额度） */
function insertViolation(db, v) {
  return insertRow(
    db,
    `INSERT INTO violations (user_id, booking_id, type, points, detail, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [v.user_id, v.booking_id, v.type, v.points, v.detail, v.created_by, v.created_at],
  );
}

/** 写入通知 */
function insertNotification(db, n) {
  return insertRow(
    db,
    `INSERT INTO notifications (user_id, type, title, content, link, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [n.user_id, n.type, n.title, n.content, n.link, n.is_read, n.created_at],
  );
}

/** 写入审计日志（detail 为对象时序列化为 JSON 字符串） */
function insertAudit(db, a) {
  return insertRow(
    db,
    `INSERT INTO audit_logs (user_id, actor_name, action, target_type, target_id, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      a.user_id,
      a.actor_name,
      a.action,
      a.target_type,
      a.target_id,
      typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail),
      a.ip,
      a.created_at,
    ],
  );
}

/* ================================================================== */
/* 五、预约生成编排                                                    */
/* ================================================================== */

/** 预约编号：BK + 创建日 YYYYMMDD + 当日序号，保证跨设备唯一 */
function createCodeFactory() {
  const counters = new Map();
  return function nextCode(createdAt) {
    const day = dateText(createdAt).replace(/-/g, '');
    const seq = (counters.get(day) || 0) + 1;
    counters.set(day, seq);
    return `BK${day}-${String(seq).padStart(4, '0')}`;
  };
}

/** 6 位数字签到码：确定性生成并去重 */
function createCheckinCodeFactory(rng) {
  const used = new Set();
  return function nextCode() {
    for (let i = 0; i < 200; i += 1) {
      const code = String(randInt(rng, 100000, 999999));
      if (!used.has(code)) {
        used.add(code);
        return code;
      }
    }
    return String(100000 + used.size);
  };
}

/** 为每台设备挑选一条真实语境的用途与课程名 */
function purposeFor(rng, device) {
  const key = device.category === '测量仪器' && device.lab === 'ee' ? '测量仪器_ee' : device.category;
  const pool = PURPOSE_MATRIX[key] || PURPOSE_MATRIX.其他;
  const purposes = pool.purposes;
  const courses = pool.courses;
  const idx = randInt(rng, 0, purposes.length - 1);
  return {
    purpose: purposes[idx],
    course_name: courses[idx % courses.length] || '',
  };
}

/** 取审批人：必须是该实验室负责人或管理员，且不能是申请人本人（对应 canReview） */
function reviewerFor(managersOfLab, adminId, applicantId) {
  const candidates = managersOfLab.filter((id) => id !== applicantId);
  if (candidates.length) return candidates[0];
  return applicantId === adminId ? null : adminId;
}

/** 预约完成态的真实使用数据：签到、签退、实际时长 */
function completionDetail(rng, base) {
  const duration = base.end_at - base.start_at;
  const lateIn = randInt(rng, 0, 8) * MINUTE; // 通常压着点或稍晚签到
  const earlyOut = randInt(rng, 0, 10) * MINUTE;
  const checkedInAt = base.start_at + lateIn;
  const checkedOutAt = Math.max(checkedInAt + 30 * MINUTE, base.end_at - earlyOut);
  const actualMinutes = Math.max(30, Math.round((Math.min(checkedOutAt, base.end_at) - checkedInAt) / MINUTE));
  return { checkedInAt, checkedOutAt, actualMinutes };
}

/** 写入通知：按事件类型选择模板，保证 notification.type 与业务语义对应 */
const NOTIFY = {
  submitted(booking, device, lab) {
    return {
      type: 'booking.submitted',
      title: '有新的预约申请待审批',
      content: `${booking.applicantName} 申请 ${lab.name} 的「${device.name}」，时段 ${formatDateTime(
        booking.start_at,
        TZ,
      )} ~ ${formatDateTime(booking.end_at, TZ)}，用途：${booking.purpose}。`,
      link: '#/review',
    };
  },
  approved(booking, device) {
    return {
      type: 'booking.approved',
      title: '预约申请已通过',
      content: `您预约的「${device.name}」（${booking.code}）已通过审批，时段 ${formatDateTime(
        booking.start_at,
        TZ,
      )} ~ ${formatDateTime(booking.end_at, TZ)}，请按时到场并扫码签到。`,
      link: `#/bookings/${booking.id}`,
    };
  },
  rejected(booking, device) {
    return {
      type: 'booking.rejected',
      title: '预约申请被驳回',
      content: `您预约的「${device.name}」（${booking.code}）未通过审批，原因：${booking.reject_reason}。`,
      link: `#/bookings/${booking.id}`,
    };
  },
  completed(booking, device) {
    return {
      type: 'booking.completed',
      title: '请确认签退并评价本次使用',
      content: `「${device.name}」的使用已于 ${formatDateTime(
        booking.checked_out_at || booking.end_at,
        TZ,
      )} 结束，实际使用 ${booking.actual_minutes} 分钟，欢迎对设备状态与实验室环境做出评价。`,
      link: `#/bookings/${booking.id}`,
    };
  },
  noShow(booking, device, points) {
    return {
      type: 'booking.no_show',
      title: '预约爽约，信用分已扣减',
      content: `您预约的「${device.name}」（${booking.code}）在开始后 15 分钟内未签到，系统判定为爽约并扣除 ${points} 分信用分，如有异议请联系实验室管理员申诉。`,
      link: `#/credit`,
    };
  },
  waitlist(booking, device, waitItem) {
    return {
      type: 'waitlist.joined',
      title: '已加入候补队列',
      content: `您已进入「${device.name}」${formatDateTime(waitItem.start_at, TZ)} ~ ${formatDateTime(
        waitItem.end_at,
        TZ,
      )} 的候补队列，当前排在第 ${waitItem.rank} 位，一旦有时段释放系统将第一时间通知您。`,
      link: `#/waitlist`,
    };
  },
};

/**
 * 生成全部预约及其衍生数据（违约 / 信用 / 通知）。
 * 关键顺序：
 *   ① 未来占用时段先行落位（含「使用中」），保证 used 表与最终库内状态完全一致；
 *   ② 过去记录按占用状态排重后写入；
 *   ③ 再把其中若干条改写为 cancelled / no_show / rejected（这些状态不占位，改写不影响 ① 的判重结果，
 *      同时为 no_show 同步产生 violations + credit_records，做到「违约必有预约、台账必有来源」）。
 */
function generateBookings(ctx) {
  const {
    db,
    rng,
    anchor,
    now,
    devices,
    labs,
    slotRows,
    blackoutRows,
    users,
    credits,
    config,
  } = ctx;

  const busy = createBusyMap();
  const userBusy = createUserBusyMap();
  const nextCode = createCodeFactory();
  const nextCheckin = createCheckinCodeFactory(rng);
  const bookings = [];

  /** 设备定义 + 库内 id + 负责人，供后续取用途、审批人使用 */
  const deviceInfo = devices.map((dev) => ({
    def: dev,
    id: dev.id,
    labId: dev.labId,
    lab: labs.get(dev.lab),
    ownerId: dev.ownerId,
    managers: ctx.managersOfLab.get(dev.labId) || [],
  }));
  const deviceById = new Map(deviceInfo.map((d) => [d.id, d]));
  const bookableNow = deviceInfo.filter((d) => d.def.status === 'available');

  /** 通知事件统一携带 { info, def, lab }，让通知文案与审批人解析各取所需 */
  function notifyEvent(dev, kind, booking, applicant, extra = {}) {
    return {
      kind,
      booking,
      device: { info: dev, def: dev.def, lab: dev.lab },
      applicant,
      ...extra,
    };
  }

  const applicants = users.filter((u) => u.role === 'student' || u.role === 'teacher');
  const activeApplicants = applicants.filter((u) => u.status !== 'frozen');
  /**
   * 「未来预约」的申请人池：还要排除那些按 CREDIT_PLAN 将在本次种子结束时被冻结的学生。
   * 理由：冻结是「信用分低于阈值」的后果，最终数据里不应出现被冻结用户仍持有未来预约的情况，
   * 否则演示时会出现「已停权却还能用设备」的错觉。
   */
  const frozenLater = new Set(
    CREDIT_PLAN.filter((p) => p.target < (config.freezeThreshold || 60)).map((p) => p.username),
  );
  const futureApplicants = activeApplicants.filter((u) => !frozenLater.has(u.username));
  const applicantPool = futureApplicants.length ? futureApplicants : activeApplicants;

  /**
   * 某设备某日的可用候选（= 排班 − 停机 − 已占用），minLen 为可接受的最短片段
   * @param {object} info 设备信息对象（含 id / labId / def）
   */
  function candidatesFor(info, dayStart, minLen = 30) {
    const schedule = scheduleIntervals(info.id, info.labId, dayStart, slotRows);
    if (!schedule.length) return [];
    const blockers = [
      ...blackoutIntervals(info.id, info.labId, dayStart, blackoutRows),
      ...busy.list(info.id),
    ];
    return interval.subtract(schedule, blockers, minLen * MINUTE - 1);
  }

  /**
   * 在候选片段里随机挑一段落位；返回 null 表示当天无合适时段。
   * 起止时刻一律对齐到 30 分钟网格（真实排期习惯），同一片段内可选窗口数量有限，
   * 因此先枚举窗口再随机取一个 —— 相比「先随机时长再裁剪」，这样绝不会产生
   * 小于设备 min_minutes 或非整点刻度的预约。
   * @param {object} info 设备信息对象（含 id / labId / def），必须是 deviceById 中登记过的设备
   */
  function pickWindowFor(info, dayStart, minLen, maxLen) {
    const cands = candidatesFor(info, dayStart, minLen);
    if (!cands.length) return null;
    const steps = [];
    for (const c of cands) {
      const totalMin = Math.floor((c.end - c.start) / MINUTE);
      if (totalMin < minLen) continue;
      // 起止时刻统一对齐到「当日 00:00 起的 30 分钟网格」，因此先把毫秒换算成分钟再取整
      const startStep = Math.ceil((c.start - dayStart) / MINUTE / 30);
      const endStep = Math.floor((c.end - dayStart) / MINUTE / 30);
      for (let s = startStep; s <= endStep - Math.ceil(minLen / 30); s += 1) {
        const latest = Math.min(maxLen, (endStep - s) * 30);
        for (let d = minLen; d <= latest; d += 30) steps.push({ s, d, end: c.end });
      }
    }
    if (!steps.length) return null;
    const step = steps[randInt(rng, 0, steps.length - 1)];
    const start = dayStart + step.s * 30 * MINUTE;
    const end = start + step.d * MINUTE;
    if (end > step.end) return null; // 理论不可达，保留为防御性检查
    return { start, end, duration: step.d };
  }

  function pickWindow(deviceId, dayStart, minLen, maxLen) {
    return pickWindowFor(deviceById.get(deviceId), dayStart, minLen, maxLen);
  }

  /* ---------------- ① 「使用中」预约：必须包含当前时刻 ---------------- */
  // 这类预约用于演示「签到 → 使用中 → 签退」流程，硬约束是 start < now < end。
  // 难点在于当前时刻未必对齐排班边界（例如 13:53，而片段从 13:30 开始），因此这里
  // 顺着片段左边界「吸附」起点，并让终点保持在 now 之后的 30~90 分钟，从而同时满足：
  // 时长在设备 min/max 之间、完整落在某段排班内、且跨越当前时刻。
  const todayStart = startOfDay(now, TZ);
  const checkinCandidates = [];
  for (const dev of bookableNow) {
    const cands = candidatesFor(dev, todayStart, 15);
    let found = null;
    for (const c of cands) {
      if (c.end <= now || c.start >= now) continue; // 需要片段真正「跨越」当前时刻
      const snap = (x) => todayStart + Math.ceil((x - todayStart) / HALF_HOUR) * HALF_HOUR;
      const back = snap(now - 30 * MINUTE);
      const duration = Math.min(dev.def.max_minutes, randInt(rng, 1, 3) * 30);
      const start = Math.max(c.start, back); // 起点不越过片段左边界
      const end = start + duration * MINUTE;
      const fallbackMinutes = Math.floor((c.end - back) / HALF_HOUR) * 30;
      const fallbackStart = c.end - fallbackMinutes * MINUTE;
      if (start < now && end > now && end <= c.end && duration >= dev.def.min_minutes) {
        found = { dev, start, end };
      } else if (
        fallbackMinutes >= dev.def.min_minutes &&
        fallbackMinutes <= dev.def.max_minutes &&
        fallbackStart >= c.start &&
        fallbackStart < now
      ) {
        found = { dev, start: fallbackStart, end: c.end };
      }
      if (found) break;
    }
    if (found) checkinCandidates.push(found);
  }
  if (!checkinCandidates.length) {
    // 极端情况（周日或深夜运行）：以当前时刻为中心取一小时，并逐步收窄，
    // 仍严格保证 start < now < end，让「使用中」演示不因运行时刻而缺失。
    for (const dev of bookableNow) {
      for (const half of [45, 30, 15, 5]) {
        const start = now - half * MINUTE;
        const end = now + half * MINUTE;
        const minutes = Math.round((end - start) / MINUTE);
        if (minutes < dev.def.min_minutes || minutes > dev.def.max_minutes) continue;
        if (candidatesFor(dev, todayStart, 0).some((c) => c.start <= start && c.end >= end)) {
          checkinCandidates.push({ dev, start, end });
          break;
        }
      }
      if (checkinCandidates.length) break;
    }
  }
  if (!checkinCandidates.length) {
    for (const dev of bookableNow) {
      if (candidatesFor(dev, todayStart, 0).length) {
        checkinCandidates.push({ dev, start: now - MINUTE, end: now + MINUTE });
        break;
      }
    }
  }

  const checkinCount = 1;
  const checkinReserved = new Map();
  for (let i = 0; i < checkinCount && i < checkinCandidates.length; i += 1) {
    const cand = checkinCandidates[i];
    // 直接服务层（服务端）会把「使用中」预约计入在途数量，因此这里也要登记，
    // 保证最终演示数据不会出现「某个用户同时在途预约超过配置上限」的假数据。
    const applicant =
      applicantPool.find((u) => (checkinReserved.get(u.id) || 0) < Math.max(1, config.maxActivePerUser - 2)) ||
      applicantPool[randInt(rng, 0, applicantPool.length - 1)];
    checkinReserved.set(applicant.id, (checkinReserved.get(applicant.id) || 0) + 1);
    const created = now - randInt(rng, 26, 72) * 60 * MINUTE;
    const reviewed = created + randInt(rng, 30, 240) * MINUTE;
    const reviewedBy = reviewerFor(cand.dev.managers, ctx.adminId, applicant.id);
    const code = nextCode(created);
    const checkinAt = Math.max(cand.start + 2 * MINUTE, now - randInt(rng, 5, 40) * MINUTE);
    const row = {
      code,
      device_id: cand.dev.id,
      lab_id: cand.dev.labId,
      user_id: applicant.id,
      start_at: cand.start,
      end_at: cand.end,
      purpose: purposeFor(rng, cand.dev.def).purpose,
      course_name: purposeFor(rng, cand.dev.def).course_name,
      participants: randInt(rng, 1, 4),
      status: 'checked_in',
      checkin_code: nextCheckin(),
      checkin_checked: 1,
      review_note: '同意使用，请按时签到并遵守实验室规定。',
      reject_reason: '',
      cancel_reason: '',
      reviewed_by: reviewedBy,
      reviewed_at: Math.min(reviewed, now - 10 * MINUTE),
      checked_in_at: checkinAt,
      checked_out_at: 0,
      actual_minutes: 0,
      reminder_sent: 1,
      created_at: created,
      updated_at: checkinAt,
    };
    row.id = insertBooking(db, row);
    bookings.push(row);
    busy.add(cand.dev.id, cand.start, cand.end);
    userBusy.add(applicant.id, cand.start, cand.end);
  }

  /* ---------------- ② 未来预约：先占位，再分配 approved / pending ---------------- */
  // 按「天」推进而不是「设备×天」推进：若让每台设备都先塞满最近几天，预约会全部堆在
  // 明后天，未来 14 天的日历就只剩两天有数据。因此每天限定配额，保证均匀铺满整个窗口。
  const futureWindows = [];
  const dailyQuota = Math.max(2, Math.ceil(PLAN.future / PLAN.futureDays));
  for (let dayOffset = 0; dayOffset < PLAN.futureDays; dayOffset += 1) {
    const dayStart = addDays(todayStart, dayOffset);
    let placedToday = 0;
    for (const dev of shuffled(rng, bookableNow)) {
      if (placedToday >= dailyQuota || futureWindows.length >= PLAN.future) break;
      if (!scheduleIntervals(dev.id, dev.labId, dayStart, slotRows).length) continue;
      const quota = randInt(rng, 0, 2);
      for (let k = 0; k < quota && placedToday < dailyQuota; k += 1) {
        const minLen = Math.max(30, dev.def.min_minutes);
        const win = pickWindow(dev.id, dayStart, minLen, dev.def.max_minutes);
        if (!win) continue;
        if (busy.has(dev.id, win.start, win.end)) continue;
        const applicant = applicantPool[randInt(rng, 0, applicantPool.length - 1)];
        if (userBusy.has(applicant.id, win.start, win.end)) continue;
        busy.add(dev.id, win.start, win.end);
        userBusy.add(applicant.id, win.start, win.end);
        futureWindows.push({ dev, win, applicant });
        placedToday += 1;
      }
    }
  }
  // 候选池本身已按天限量，取前 PLAN.future 条即可：既控制总量，又保证 14 天里每天都有预约。
  // 同时按下式约束：任一用户的「在途预约（含使用中）」不超过配置上限，
  // 否则演示数据本身就会违反 R12，学生登录后会立刻看到「已达上限」的矛盾状态。
  futureWindows.sort((a, b) => a.win.start - b.win.start);
  const maxActivePerUser = Math.max(2, config.maxActivePerUser);
  const futureSeats = new Map();
  // 只有真正被 chosen 选中的候选才会落库，因此从 0 起算并逐个累计。
  // 刻意留出 1 个名额：即使所有未来预约都被计入在途，用户仍能自己再提交一条预约，
  // 这样「演示数据本身」永远不会触发 R12 的在途上限，登录后可以立刻体验完整流程。
  const futureCap = maxActivePerUser - 1;
  const availableSeats = (u) => futureCap - (checkinReserved.get(u.id) || 0) - (futureSeats.get(u.id) || 0);
  const chosen = [];
  for (const item of futureWindows) {
    if (chosen.length >= PLAN.future) break;
    if (availableSeats(item.applicant) <= 0) continue;
    futureSeats.set(item.applicant.id, (futureSeats.get(item.applicant.id) || 0) + 1);
    chosen.push(item);
  }

  for (const item of chosen) {
    const { dev, win, applicant } = item;
    const meta = purposeFor(rng, dev.def);
    // created_at 必须同时满足三件事：不晚于当前时刻、至少比开始时间早 1~2 小时、
    // 提前量不超过 14 天（与 booking_advance_days 默认值一致，否则真实服务层会拒绝这条数据）
    const latest = Math.min(win.start - 2 * 60 * MINUTE, now - 3 * 60 * MINUTE);
    const created = Math.max(
      win.start - 14 * DAY + 2 * 60 * MINUTE,
      latest - randInt(rng, 0, 4 * DAY),
    );
    const autoApproved = dev.def.auto_approve === 1;
    const status = autoApproved ? 'approved' : rng() < 0.75 ? 'approved' : 'pending';
    const reviewedBy = autoApproved ? null : reviewerFor(dev.managers, ctx.adminId, applicant.id);
    const reviewedAt = status === 'approved' ? created + randInt(rng, 20, 300) * MINUTE : 0;
    const row = {
      code: nextCode(created),
      device_id: dev.id,
      lab_id: dev.labId,
      user_id: applicant.id,
      start_at: win.start,
      end_at: win.end,
      purpose: meta.purpose,
      course_name: meta.course_name,
      participants: randInt(rng, 1, 6),
      status,
      checkin_code: nextCheckin(),
      checkin_checked: 0,
      review_note: status === 'approved' ? (autoApproved ? '免审批设备：系统自动通过。' : '同意使用，请遵守实验室安全规定。') : '',
      reject_reason: '',
      cancel_reason: '',
      reviewed_by: reviewedBy,
      reviewed_at: reviewedAt,
      checked_in_at: 0,
      checked_out_at: 0,
      actual_minutes: 0,
      reminder_sent: 0,
      created_at: created,
      updated_at: reviewedAt || created,
    };
    row.id = insertBooking(db, row);
    bookings.push(row);
    ctx.notifications.push(notifyEvent(dev, 'submitted', row, applicant));
    if (status === 'approved') ctx.notifications.push(notifyEvent(dev, 'approved', row, applicant));
  }

  /* ---------------- ③ 过去预约：completed / cancelled / no_show / rejected ---------------- */
  // 注意：状态在落位之后才分配（见下方 statusPlan），但爽约的人选必须提前定下来 ——
  // CREDIT_PLAN 的扣分目标是按「某人爽约 N 次」算好的，若爽约随机落到别人头上，
  // 信用分目标就会失准，甚至出现「没有任何用户被冻结」的演示缺口。
  // 因此这里先按 CREDIT_PLAN 的声明把「将来判为爽约的人选」定下来，落位时优先安排这些学生。
  // 一位学生声明了几条爽约就有几个名额（例如 student5 两条），因此这里刻意保留重复项。
  const noShowUsers = CREDIT_PLAN.flatMap((plan) =>
    plan.events.filter((e) => e.type === 'no_show').map(() => plan.username),
  );
  const historyStart = addDays(todayStart, -PLAN.pastDays);
  const historyEnd = addDays(todayStart, -2);
  // 历史预约总量 = 完成 + 取消 + 驳回 + 爽约，其中爽约数由 CREDIT_PLAN 的声明唯一决定
  const historyTotal = PLAN.completed + PLAN.cancelled + PLAN.rejected + noShowUsers.length;
  const pastRows = [];
  for (let i = 0; i < historyTotal * 14 && pastRows.length < historyTotal; i += 1) {
    const dayOffset = -randInt(rng, 2, PLAN.pastDays);
    const dayStart = addDays(todayStart, dayOffset);
    if (dayStart < historyStart || dayStart > historyEnd) continue;
    const dev = pick(rng, deviceInfo);
    if (!scheduleIntervals(dev.id, dev.labId, dayStart, slotRows).length) continue;
    const minLen = Math.max(30, dev.def.min_minutes);
    const win = pickWindow(dev.id, dayStart, minLen, dev.def.max_minutes);
    if (!win) continue;
    if (busy.has(dev.id, win.start, win.end)) continue;
    let applicant = applicants[randInt(rng, 0, applicants.length - 1)];
    // 不制造「同一个人同一时段出现在两台设备上」的假数据（对应业务规则 R11）
    if (userBusy.has(applicant.id, win.start, win.end)) {
      const free = shuffled(rng, applicants).find((u) => !userBusy.has(u.id, win.start, win.end));
      if (!free) continue;
      applicant = free;
    }
    busy.add(dev.id, win.start, win.end);
    userBusy.add(applicant.id, win.start, win.end);
    pastRows.push({ dev, win, applicant });
  }
  pastRows.sort((a, b) => a.win.start - b.win.start);

  /* ---------------- ③-b 历史填密：让利用率统计有真实观感 ---------------- */
  // 只放少量随机历史预约时，20 台设备 30 天的占用时长寥寥无几，利用率会低到 0.x%，
  // 统计页（利用率排行/热力图/趋势）就失去演示价值。真实实验室的历史使用是高频、短时的
  // 借用密集分布，因此这里按天把设备的空闲时段填密：
  //   1) 空闲片段 = 当日排班 − 停机计划 − 已占位预约（复用同一套区间算子，天然不重叠）；
  //   2) 时段对齐 30 分钟网格，时长 1~3 小时，并留出相邻预约之间的自然间隙；
  //   3) 同一用户自身时段仍不重叠（与业务规则 R11 一致）。
  // 这样「过去 30 天」的占用率会落在 15%~35% 的合理区间，未来 14 天仍保持稀疏（更贴近真实）。
  const densifyFrom = addDays(todayStart, -30);
  for (let dayStart = densifyFrom; dayStart <= historyEnd; dayStart += DAY) {
    for (const dev of bookableNow) {
      const schedule = scheduleIntervals(dev.id, dev.labId, dayStart, slotRows);
      if (!schedule.length) continue;
      const freeBlocks = interval.subtract(schedule, [
        ...blackoutIntervals(dev.id, dev.labId, dayStart, blackoutRows),
        ...busy.list(dev.id).filter((iv) => iv.start < dayStart + DAY && iv.end > dayStart),
      ]);
      for (const block of freeBlocks) {
        let cursor = block.start;
        while (cursor + HALF_HOUR <= block.end && rng() < 0.6) {
          const startStep = Math.ceil((cursor - dayStart) / HALF_HOUR);
          const endStep = Math.floor((block.end - dayStart) / HALF_HOUR);
          const maxSteps = Math.min(6, endStep - startStep);
          if (maxSteps < 2) break;
          const steps = randInt(rng, 2, maxSteps);
          const start = dayStart + startStep * HALF_HOUR;
          const end = start + steps * HALF_HOUR;
          const applicant = applicants[randInt(rng, 0, applicants.length - 1)];
          if (userBusy.has(applicant.id, start, end)) {
            cursor = end + HALF_HOUR; // 该用户此时段已有安排，跳过并留出间隙
            continue;
          }
          busy.add(dev.id, start, end);
          userBusy.add(applicant.id, start, end);
          pastRows.push({ dev, win: { start, end }, applicant });
          cursor = end + HALF_HOUR;
        }
      }
    }
  }

  /**
   * ③-c 为「当前不可预约」的设备补上历史使用记录。
   * 这些设备（维护中 / 已停用）不应参与未来排期，但在它们坏掉/停用之前，
   * 实验室确实使用过它们。缺少这段历史会让统计页出现「从未被使用过」的误导性结论
   * （利用率 0%），因此这里在它们过去仍可用的日子里补少量已完成记录。
   */
  const unavailableDevices = deviceInfo.filter((d) => d.def.status !== 'available');
  for (const dev of unavailableDevices) {
    let placed = 0;
    for (let dayOffset = 2; dayOffset <= PLAN.pastDays && placed < 6; dayOffset += 1) {
      const dayStart = addDays(todayStart, -dayOffset);
      const win = pickWindowFor(dev, dayStart, Math.max(30, dev.def.min_minutes), dev.def.max_minutes);
      if (!win) continue;
      let applicant = applicants[randInt(rng, 0, applicants.length - 1)];
      if (userBusy.has(applicant.id, win.start, win.end)) {
        const free = shuffled(rng, applicants).find((u) => !userBusy.has(u.id, win.start, win.end));
        if (!free) continue;
        applicant = free;
      }
      busy.add(dev.id, win.start, win.end);
      userBusy.add(applicant.id, win.start, win.end);
      pastRows.push({ dev, win, applicant });
      placed += 1;
    }
  }

  pastRows.sort((a, b) => a.win.start - b.win.start);

  /**
   * 爽约名额的确定性落位。
   * 目的：让 CREDIT_PLAN 里声明的每一条爽约都「必然」落在计划中的那位学生身上，
   * 演示数据因此永远稳定（student5 两条爽约 + 临时取消 + 设备损坏 → 55 分 → 触发自动冻结）。
   * 做法：按声明顺序逐个名额挑一条「该生时间不冲突、且尚未被占用」的历史预约，
   * 把该条预约的申请人替换成这名学生（同步更新 userBusy，避免自身时段重叠）。
   */
  const takenSeat = new Set();
  for (const username of noShowUsers) {
    const seat = applicants.find((u) => u.username === username);
    if (!seat) continue;
    let target = -1;
    for (let idx = 0; idx < pastRows.length; idx += 1) {
      if (takenSeat.has(idx)) continue;
      const row = pastRows[idx];
      if (row.applicant.id === seat.id || !userBusy.has(seat.id, row.win.start, row.win.end)) {
        target = idx;
        break;
      }
    }
    if (target < 0) continue;
    const row = pastRows[target];
    userBusy.remove(row.applicant.id, row.win.start, row.win.end);
    row.applicant = seat;
    userBusy.add(seat.id, row.win.start, row.win.end);
    takenSeat.add(target);
  }

  // 按时间顺序分配状态，让「已完成 / 已取消 / 爽约 / 已驳回」在时间轴上自然分布。
  // 爽约名额直接锁定到上面预先落位的那些预约，保证「声明数量 == 实际数量 == 指定学生」。
  const order = shuffled(rng, pastRows.map((_, idx) => idx));
  const statusPlan = new Map();
  for (const idx of takenSeat) statusPlan.set(idx, 'no_show');
  let cursor = 0;
  /** 从打乱后的顺序里取下一个「尚未被爽约占用」的历史预约下标 */
  const nextFreeIdx = () => {
    while (cursor < order.length) {
      const idx = order[cursor];
      cursor += 1;
      if (!takenSeat.has(idx)) return idx;
    }
    return null;
  };
  const assign = (status, count) => {
    for (let i = 0; i < count; i += 1) {
      const idx = nextFreeIdx();
      if (idx === null) return;
      statusPlan.set(idx, status);
    }
  };
  assign('cancelled', PLAN.cancelled);
  assign('rejected', PLAN.rejected);
  // 其余历史预约全部按「已完成」落库：数量较多时不再受 PLAN.completed 限制，
  // 否则填密进来的预约会因为状态表用尽而落到默认值，统计口径会变得含糊。
  for (let idx = 0; idx < pastRows.length; idx += 1) {
    if (!statusPlan.has(idx)) statusPlan.set(idx, 'completed');
  }

  for (let idx = 0; idx < pastRows.length; idx += 1) {
    const { dev, win, applicant } = pastRows[idx];
    const status = statusPlan.get(idx) || 'completed';
    const meta = purposeFor(rng, dev.def);
    const created = win.start - randInt(rng, 1, 14) * DAY;
    const reviewedBy = reviewerFor(dev.managers, ctx.adminId, applicant.id);
    const reviewedAt = created + randInt(rng, 30, 600) * MINUTE;
    const row = {
      code: nextCode(created),
      device_id: dev.id,
      lab_id: dev.labId,
      user_id: applicant.id,
      start_at: win.start,
      end_at: win.end,
      purpose: meta.purpose,
      course_name: meta.course_name,
      participants: randInt(rng, 1, 6),
      status,
      checkin_code: '',
      checkin_checked: 0,
      review_note: '',
      reject_reason: '',
      cancel_reason: '',
      reviewed_by: reviewedBy,
      reviewed_at: reviewedAt,
      checked_in_at: 0,
      checked_out_at: 0,
      actual_minutes: 0,
      reminder_sent: 1,
      created_at: created,
      updated_at: reviewedAt,
    };

    if (status === 'completed') {
      const detail = completionDetail(rng, row);
      row.checkin_code = nextCheckin();
      row.checkin_checked = 1;
      row.checked_in_at = detail.checkedInAt;
      row.checked_out_at = detail.checkedOutAt;
      row.actual_minutes = detail.actualMinutes;
      row.review_note = '同意使用，请按时签到并遵守实验室规定。';
      row.updated_at = detail.checkedOutAt;
    } else if (status === 'rejected') {
      row.reject_reason = pick(rng, [
        '所选时段与实验室教学任务冲突，请改约其他时间',
        '申请未附安全培训合格证明，暂不批准',
        '该时段设备已安排校准维护，无法开放',
        '用途说明不充分，请补充实验方案后重新提交',
        '该设备需教师现场陪同操作，本次申请不予通过',
      ]);
      row.reviewed_at = Math.min(reviewedAt, win.start - 30 * MINUTE);
      row.updated_at = row.reviewed_at;
      busy.remove(dev.id, win.start, win.end);
      userBusy.remove(applicant.id, win.start, win.end);
    } else if (status === 'cancelled') {
      row.cancel_reason = pick(rng, [
        '课程安排调整，与实验课时间冲突',
        '实验方案变更，本次预约不再需要',
        '小组成员临时有事，改约到下周',
        '设备使用计划调整，申请人主动取消',
      ]);
      row.updated_at = win.start - randInt(rng, 2, 30) * 60 * MINUTE;
      row.reviewed_at = Math.min(reviewedAt, row.updated_at);
      busy.remove(dev.id, win.start, win.end);
      userBusy.remove(applicant.id, win.start, win.end);
    } else if (status === 'no_show') {
      row.updated_at = win.start + 20 * MINUTE;
      row.reviewed_at = Math.min(reviewedAt, win.start - 30 * MINUTE);
      busy.remove(dev.id, win.start, win.end);
      userBusy.remove(applicant.id, win.start, win.end);
      ctx.noShowRows.push(row);
    }

    row.id = insertBooking(db, row);
    bookings.push(row);
    ctx.notifications.push(notifyEvent(dev, status, row, applicant));
  }

  /* ---------------- ④ 历史违约：以真实预约为载体 ---------------- */
  // 爽约由 ⑤ 从真实 no_show 预约生成，这里只处理其余类型，避免同一条爽约被记两次。
  const creditExtra = CREDIT_PLAN.flatMap((u) =>
    u.events.filter((e) => e.type !== 'no_show').map((e) => ({ ...e, username: u.username })),
  );
  const usedBookingIds = new Set(ctx.noShowRows.map((r) => r.id));
  for (const ev of creditExtra) {
    const user = users.find((u) => u.username === ev.username);
    if (!user) continue;
    const atTs = parseRelativeAt(anchor, ev.at);
    // 关联一条该生在该时刻附近的真实预约，让违约记录有据可查（找不到就用本人最近的预约兜底）
    const own = bookings.filter((b) => b.user_id === user.id && !usedBookingIds.has(b.id));
    const related =
      own
        .filter((b) => b.start_at < atTs + DAY && b.start_at > atTs - 20 * DAY)
        .sort((a, b) => Math.abs(a.start_at - atTs) - Math.abs(b.start_at - atTs))[0] ||
      own.slice().sort((a, b) => Math.abs(a.start_at - atTs) - Math.abs(b.start_at - atTs))[0];
    const sign = ev.type === 'bonus' ? 1 : -1;
    const points = ev.points;
    if (ev.type === 'bonus') {
      // 信用修复加分只落 credit_records，不产生 violations（它不是违约行为）
      applyCredit(db, credits, user.id, sign * points, ev.note, 'manual', 0, atTs);
    } else {
      const violationId = insertViolation(db, {
        user_id: user.id,
        booking_id: related ? related.id : null,
        type: ev.type,
        points,
        detail: related
          ? `预约 ${related.code}（${deviceById.get(related.device_id).def.name}）${ev.note}，管理员核对后记录违约。`
          : `${ev.note}，管理员核对后记录违约。`,
        created_by: ctx.adminId,
        created_at: atTs,
      });
      if (related) usedBookingIds.add(related.id);
      applyCredit(db, credits, user.id, sign * points, `${viLabel(ev.type)}：${ev.note}`, 'violation', violationId, atTs);
    }
  }

  /* ---------------- ⑤ 爽约违约：由 no_show 预约驱动 ---------------- */
  for (const row of ctx.noShowRows) {
    const dev = deviceById.get(row.device_id);
    const atTs = row.start_at + 20 * MINUTE;
    const points = config.pointsNoShow;
    const violationId = insertViolation(db, {
      user_id: row.user_id,
      booking_id: row.id,
      type: 'no_show',
      points,
      detail: `预约 ${row.code}（${dev.def.name}）未签到，系统自动判定爽约。`,
      created_by: ctx.adminId,
      created_at: atTs,
    });
    applyCredit(db, credits, row.user_id, -points, '爽约未到：预约后未按时签到', 'violation', violationId, atTs);
    const applicant = users.find((u) => u.id === row.user_id);
    ctx.notifications.push(notifyEvent(dev, 'no_show', row, applicant, { points }));
  }

  /* ---------------- ⑥ 候补队列：挂在未来的已占用时段上 ---------------- */
  const futureOccupied = bookings
    .filter((b) => (b.status === 'approved' || b.status === 'pending') && b.start_at > now)
    .sort((a, b) => a.start_at - b.start_at);
  const waitlistRows = [];
  for (let i = 0; i < PLAN.waitlist && i < futureOccupied.length; i += 1) {
    const target = futureOccupied[Math.floor((i * futureOccupied.length) / PLAN.waitlist)];
    const info = deviceById.get(target.device_id);
    const dur = Math.round((target.end_at - target.start_at) / MINUTE);
    const sub = Math.min(info.def.max_minutes, Math.max(info.def.min_minutes, Math.round(dur / 2)));
    const wStart = target.start_at;
    const wEnd = Math.min(target.end_at, wStart + sub * MINUTE);
    const candidates = applicantPool.filter((u) => u.id !== target.user_id);
    const applicant = candidates[randInt(rng, 0, candidates.length - 1)];
    const created = now - randInt(rng, 1, 40) * 60 * MINUTE;
    const waitlistRow = {
      device_id: target.device_id,
      user_id: applicant.id,
      start_at: wStart,
      end_at: wEnd,
      purpose: pick(rng, [
        '若有人取消希望补位，用于毕业设计样机联调',
        '课题组临时增加一次实验，排队等待释放时段',
        '希望补位完成课程设计的数据采集',
        '同组同学已约满，申请候补以便共同实验',
        '设备课程作业临近截止，申请候补补做实验',
      ]),
      expires_at: target.start_at,
      created_at: created,
    };
    waitlistRow.id = insertWaitlist(db, waitlistRow);
    waitlistRows.push(waitlistRow);
    ctx.notifications.push(notifyEvent(info, 'waitlist', target, applicant, { waitItem: { ...waitlistRow, rank: i + 1 } }));
  }

  return { bookings, waitlistRows };
}

/** 违约类型的中文标签（与 booking-rules.VIOLATION_TYPES 对齐，用于台账 reason） */
function viLabel(type) {
  const map = {
    no_show: '爽约未到',
    late_cancel: '临时取消',
    overtime: '超时占用',
    damage: '设备损坏',
    rule_break: '违规使用',
    bonus: '信用修复',
  };
  return map[type] || type;
}

/* ================================================================== */
/* 六、通知与审计日志                                                  */
/* ================================================================== */

/**
 * 把编排阶段收集的事件物化为 notifications 行。
 *
 * 通知量刻意贴合真实产品行为，而不是「每条状态变更都刷一条」：
 *   - 待审批申请 → 通知第一位实验室负责人（link 指向 #/review）；
 *   - 人工审批通过 / 驳回 → 通知申请人（免审批设备由系统自动通过，不再打扰用户）；
 *   - 完成 → 抽样推送「请签退并评价」，避免通知中心被同类消息淹没；
 *   - 爽约 / 进入候补 / 信用分冻结 → 各自通知当事人。
 * 已读状态：近 7 天未读，更早的已读，便于演示首页未读角标。
 */
function writeNotifications(db, events, now) {
  let count = 0;
  for (const ev of events) {
    const b = ev.booking;
    // 事件里的 device 统一是 { info, def, lab } 形态：info 提供审批人候选，def 是设备定义，lab 是实验室行
    const device = ev.device;
    const def = device && device.def ? device.def : { name: '设备' };
    const lab = device && device.lab ? device.lab : { name: '实验室' };
    let payload = null;
    let atTs = b.created_at;
    let userId = b.user_id;

    if (ev.kind === 'submitted') {
      if (b.status !== 'pending') continue; // 免审批设备提交即通过，无需通知负责人
      const managers = ((device.info && device.info.managers) || []).filter((id) => id !== b.user_id);
      const target = managers.length ? managers[0] : null;
      if (target === null) continue;
      payload = NOTIFY.submitted({ ...b, applicantName: ev.applicant ? ev.applicant.name : '学生' }, def, lab);
      atTs = b.created_at;
      userId = target;
    } else if (ev.kind === 'approved') {
      // 免审批设备由系统直接放行，不产生通知；
      // 即便是人工审批，也只对「3 天内即将开始」的预约推送，否则通知中心会被历史审批淹没
      if (b.reviewed_by === null) continue;
      if (b.start_at > now + 3 * DAY) continue;
      payload = NOTIFY.approved(b, def);
      atTs = b.reviewed_at || b.created_at;
      userId = b.user_id;
    } else if (ev.kind === 'rejected') {
      payload = NOTIFY.rejected(b, def);
      atTs = b.reviewed_at || b.created_at;
      userId = b.user_id;
    } else if (ev.kind === 'completed') {
      if (b.id % 3 !== 0) continue; // 抽样推送，保持通知中心信息密度合理
      payload = NOTIFY.completed(b, def);
      atTs = b.checked_out_at || b.end_at;
      userId = b.user_id;
    } else if (ev.kind === 'no_show') {
      payload = NOTIFY.noShow(b, def, ev.points || 10);
      atTs = b.start_at + 20 * MINUTE;
      userId = b.user_id;
    } else if (ev.kind === 'waitlist') {
      payload = NOTIFY.waitlist(b, def, ev.waitItem);
      atTs = ev.waitItem.created_at;
      userId = ev.waitItem.user_id;
    } else {
      continue; // cancelled 不产生通知，避免演示数据里出现无意义消息
    }

    insertNotification(db, {
      ...payload,
      user_id: userId,
      // 近 7 天的消息保留未读，用于演示首页「未读红点」；更早的一律已读
      is_read: now - atTs > 7 * DAY ? 1 : 0,
      created_at: atTs,
    });
    count += 1;
  }
  return count;
}

/** 审计日志：登录、审批、设备维护、停机计划、配置调整等真实动作 */
function writeAuditLogs(db, data, now) {
  const ipPool = ['192.168.1.24', '192.168.1.31', '192.168.1.57', '10.0.0.8', '10.0.0.15', '10.0.0.23'];
  let ipCursor = 0;
  const nextIp = () => ipPool[(ipCursor += 1) % ipPool.length];
  const rows = [];
  // 设备建档发生在本批次最早的时刻，逐条 +2 分钟，避免与后续事件的 created_at 撞车
  const auditBaseAt = data.createdAt + 10 * MINUTE;

  const push = (a) => rows.push(a);

  // 设备资产建档（体现系统初始化时的批量导入，抽样保留代表性条目）
  for (const dev of data.devices.slice(0, 6)) {
    push({
      user_id: data.adminId,
      actor_name: '系统管理员',
      action: 'device.create',
      target_type: 'device',
      target_id: dev.id,
      detail: { name: dev.def.name, serial_no: dev.def.serialNo, lab: dev.lab.name, price_fen: dev.def.price_fen },
      ip: nextIp(),
      created_at: auditBaseAt + rows.length * 2 * MINUTE,
    });
  }
  // 设备状态变更：把 4 台异常设备逐个置为 maintenance / offline
  for (const dev of data.devices.filter((d) => d.def.status !== 'available')) {
    push({
      user_id: data.adminId,
      actor_name: '系统管理员',
      action: 'device.status',
      target_type: 'device',
      target_id: dev.id,
      detail: `${dev.def.name}（${dev.def.serialNo}）状态变更为 ${dev.def.status}：${
        dev.def.status === 'offline' ? '搬迁待重新安装调试' : '计划性维护保养'
      }`,
      ip: nextIp(),
      created_at: at(data.anchor, -30, '09:30') + dev.id * HOUR_MS,
    });
  }
  // 停机计划创建（抽样，避免审计表被同类动作淹没）
  for (const b of data.blackoutRows.slice(0, 4)) {
    push({
      user_id: data.adminId,
      actor_name: '系统管理员',
      action: 'blackout.create',
      target_type: 'blackout',
      target_id: b.id,
      detail: { reason: b.reason, kind: b.kind, start_at: b.start_at, end_at: b.end_at },
      ip: nextIp(),
      created_at: Math.max(data.createdAt, b.start_at - 6 * DAY),
    });
  }
  // 用户冻结 / 解冻
  for (const u of data.users.filter((x) => x.status === 'frozen')) {
    push({
      user_id: data.adminId,
      actor_name: '系统管理员',
      action: 'user.freeze',
      target_type: 'user',
      target_id: u.id,
      detail: `${u.name}（${u.username}）信用分 ${data.frozenScores.get(u.id)} 低于阈值，预约权限暂停至 ${formatDateTime(
        u.frozen_until,
        TZ,
      )}`,
      ip: nextIp(),
      created_at: data.frozenAt,
    });
  }
  // 实验室信息维护（抽样）
  for (const lab of data.labs.slice(0, 2)) {
    push({
      user_id: data.adminId,
      actor_name: '系统管理员',
      action: 'lab.update',
      target_type: 'lab',
      target_id: lab.id,
      detail: `更新《${lab.name}》开放时间与实验室使用规定`,
      ip: nextIp(),
      created_at: data.createdAt + lab.id * 3 * MINUTE,
    });
  }
  // 配置调整
  push({
    user_id: data.adminId,
    actor_name: '系统管理员',
    action: 'config.update',
    target_type: 'config',
    target_id: 0,
    detail: [{ key: 'booking_advance_days', from: '7', to: '14' }],
    ip: nextIp(),
    created_at: at(data.anchor, -18, '10:05'),
  });
  push({
    user_id: data.adminId,
    actor_name: '系统管理员',
    action: 'config.update',
    target_type: 'config',
    target_id: 0,
    detail: [{ key: 'credit_freeze_threshold', from: '50', to: '60' }],
    ip: nextIp(),
    created_at: at(data.anchor, -7, '15:40'),
  });
  // 登录日志
  const loginActors = data.users.filter((u) => u.role !== 'admin').slice(0, 6);
  loginActors.forEach((u, i) => {
    push({
      user_id: u.id,
      actor_name: u.name,
      action: 'user.login',
      target_type: 'session',
      target_id: u.id,
      detail: `${u.name}（${u.role === 'teacher' ? '教师' : '学生'}）登录系统`,
      ip: nextIp(),
      created_at: at(data.anchor, -(i + 1), `${String(8 + i).padStart(2, '0')}:1${i % 10}`),
    });
  });
  // 审批动作：抽取最近若干条已审批预约，保留 approve / reject 两类真实动作
  const reviewed = data.bookings
    .filter(
      (b) =>
        b.reviewed_by &&
        b.reviewed_at > 0 &&
        (b.status === 'approved' || b.status === 'rejected' || b.status === 'completed'),
    )
    .sort((a, b) => b.reviewed_at - a.reviewed_at)
    .slice(0, 6);
  for (const b of reviewed) {
    const actor = data.users.find((u) => u.id === b.reviewed_by);
    push({
      user_id: b.reviewed_by,
      actor_name: actor ? actor.name : '实验室负责人',
      action: b.status === 'rejected' ? 'booking.reject' : 'booking.approve',
      target_type: 'booking',
      target_id: b.id,
      detail:
        b.status === 'rejected'
          ? { code: b.code, reason: b.reject_reason }
          : { code: b.code, start_at: b.start_at, end_at: b.end_at, auto: b.reviewed_by === null },
      ip: nextIp(),
      created_at: b.reviewed_at,
    });
  }
  // 设备信息更新
  push({
    user_id: data.adminId,
    actor_name: '系统管理员',
    action: 'device.update',
    target_type: 'device',
    target_id: data.devices[0].id,
    detail: { name: data.devices[0].def.name, changed: ['location', 'lead_minutes'], lead_minutes: data.devices[0].def.lead_minutes },
    ip: nextIp(),
    created_at: at(data.anchor, -12, '14:20'),
  });
  push({
    user_id: data.teachers[0].id,
    actor_name: data.teachers[0].name,
    action: 'device.update',
    target_type: 'device',
    target_id: data.devices[1].id,
    detail: { name: data.devices[1].def.name, changed: ['description'] },
    ip: nextIp(),
    created_at: at(data.anchor, -5, '16:45'),
  });

  rows.sort((a, b) => a.created_at - b.created_at);
  for (const r of rows) insertAudit(db, r);
  return rows.length;
}

/** HOUR 的别名（audit 时间抖动用） */
const HOUR_MS = 60 * MINUTE;

/* ================================================================== */
/* 七、编排入口                                                        */
/* ================================================================== */

/** 业务表清单（清理时按外键依赖倒序删除） */
const BUSINESS_TABLES = [
  'audit_logs',
  'notifications',
  'credit_records',
  'violations',
  'waitlist',
  'bookings',
  'blackouts',
  'weekly_slots',
  'devices',
  'sessions',
  'lab_managers',
  'users',
  'labs',
];

/** 清空全部业务表（保留 config：它由 core/config.js 负责维护） */
function clearBusinessTables(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const table of BUSINESS_TABLES) db.exec(`DELETE FROM ${table}`);
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('" + BUSINESS_TABLES.join("','") + "')");
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * 核心写入流程。
 * 全程单事务：任何一步失败都会整体回滚，绝不会留下「一半用户、一半预约」的脏库。
 */
function writeSeed(db) {
  const now = Date.now(); // 唯一的非确定性输入：当前时刻锚点
  const anchor = startOfDay(now, TZ);
  const rng = createRng(SEED);
  const createdAt = now - 200 * DAY;
  const passwordHash = hashPassword(DEMO_PASSWORD); // scrypt 慢，只算一次供全部演示账号复用

  db.exec('BEGIN IMMEDIATE');
  try {
    /* ---------- 配置只读快照 ---------- */
    const config = {
      timezone: configNumber(db, 'timezone_offset_minutes') || TZ,
      maxParticipants: configNumber(db, 'max_participants_per_booking') || 20,
      pointsNoShow: configNumber(db, 'default_points_no_show') || 10,
      freezeThreshold: configNumber(db, 'credit_freeze_threshold') || 60,
      // 用于约束演示数据的「在途预约上限」，必须与业务规则 R12 的配置一致
      maxActivePerUser: configNumber(db, 'max_active_bookings_per_user') || 5,
    };

    /* ---------- 用户 / 实验室 / 负责人 / 设备 / 排班 / 停机 ---------- */
    const userDefs = buildUserDefs();
    const userIds = insertUsers(db, userDefs, passwordHash, createdAt);
    const users = userDefs.map((d) => ({ ...d, id: userIds.get(d.username) }));

    const labIds = insertLabs(db, createdAt);
    const labs = new Map(
      LABS.map((lab) => [labIds.get(lab.key), { key: lab.key, id: labIds.get(lab.key), name: lab.name, code: lab.code }]),
    );

    const managers = [
      { lab: 'ee', username: 'teacher' },
      { lab: 'iot', username: 'teacher' },
      { lab: 'me', username: 'teacher2' },
      { lab: 'ai', username: 'teacher3' },
      { lab: 'ai', username: 'admin' }, // 管理员兼任 AI 实验室负责人，便于演示跨角色权限
    ];
    insertLabManagers(db, managers, labIds, userIds, createdAt);
    const managersOfLab = buildManagerIndex(managers, labIds, userIds);
    const labOwners = new Map([
      ['ee', userIds.get('teacher')],
      ['iot', userIds.get('teacher')],
      ['me', userIds.get('teacher2')],
      ['ai', userIds.get('teacher3')],
    ]);

    // 设备：序列号按「实验室代码中段 + 序号」编排，保证全局唯一且可读
    const serialCounters = new Map();
    const deviceDefs = DEVICES.map((dev) => {
      const lab = LABS.find((l) => l.key === dev.lab);
      const segment = lab.code.split('-')[1];
      const seq = (serialCounters.get(segment) || 0) + 1;
      serialCounters.set(segment, seq);
      return { ...dev, serialNo: `SN-${segment}-${String(seq).padStart(4, '0')}` };
    });
    const deviceIds = insertDevices(db, deviceDefs, labIds, labOwners, createdAt);
    const deviceCreatedAt = createdAt + 5 * MINUTE;

    const slotCreatedAt = createdAt + 30 * MINUTE;
    const slotCount = insertWeeklySlots(db, labIds, deviceIds, slotCreatedAt);

    const blackoutPlan = materializeBlackouts(anchor);
    const blackoutIds = insertBlackouts(db, blackoutPlan, labIds, deviceIds, userIds.get('admin'), createdAt + 90 * MINUTE);
    const blackoutRows = blackoutPlan.map((b) => ({
      ...b,
      id: blackoutIds.get(b.key),
      labId: labIds.get(b.labKey),
      deviceId: b.deviceKey ? deviceIds.get(b.deviceKey) : null,
    }));

    const slotRows = db.prepare('SELECT lab_id, device_id, weekday, start_min, end_min, enabled FROM weekly_slots').all();

    /* ---------- 预约 / 违约 / 信用 / 候补 ---------- */
    const credits = new Map(users.map((u) => [u.id, { score: 100, updatedAt: 0, pending: [] }]));
    const notifications = [];
    const noShowRows = [];
    const creditEvents = [];
    const devices = deviceDefs.map((dev) => ({
      ...dev,
      id: deviceIds.get(dev.key),
      labId: labIds.get(dev.lab),
      ownerId: labOwners.get(dev.lab),
    }));

    const bookingResult = generateBookings({
      db,
      rng,
      anchor,
      now,
      devices,
      labs,
      slotRows,
      blackoutRows,
      users,
      credits,
      config,
      managersOfLab,
      adminId: userIds.get('admin'),
      notifications,
      noShowRows,
      creditEvents,
    });

    // 信用修复型事件（CREDIT_PLAN 里声明的正向调整），保证「至少一个学生 60~75 且活跃」
    applyPlannedCredits(db, users, credits, anchor, now);

    flushCredit(db, credits);
    const frozenScores = applyFrozenUsers(db, users, credits, config, now, notifications);

    /* ---------- 通知 / 审计 ---------- */
    const notificationCount = writeNotifications(db, notifications, now);
    const auditCount = writeAuditLogs(
      db,
      {
        anchor,
        createdAt,
        deviceCreatedAt,
        adminId: userIds.get('admin'),
        users,
        teachers: users.filter((u) => u.role === 'teacher'),
        labs: [...labs.values()],
        devices: devices.map((d) => ({ def: d, id: d.id, lab: labs.get(d.labId), ownerId: d.ownerId })),
        blackoutRows,
        bookings: bookingResult.bookings,
        frozenAt: at(anchor, -9, '11:20'),
        frozenScores,
      },
      now,
    );

    /* ---------- 排班/设备的 updated_at 收敛到实际写入时间之后 ---------- */
    db.prepare('UPDATE weekly_slots SET created_at = ? WHERE created_at > ?').run(slotCreatedAt, slotCreatedAt);
    db.prepare('UPDATE labs SET created_at = ?, updated_at = ? WHERE created_at = ?').run(createdAt, slotCreatedAt, createdAt);
    db.prepare('UPDATE devices SET created_at = ?, updated_at = ? WHERE created_at = ?').run(
      deviceCreatedAt,
      slotCreatedAt,
      createdAt,
    );

    db.exec('COMMIT');

    return {
      users: users.length,
      labs: LABS.length,
      devices: deviceDefs.length,
      weekly_slots: slotCount,
      blackouts: blackoutRows.length,
      bookings: bookingResult.bookings.length,
      waitlist: bookingResult.waitlistRows.length,
      violations: Number(queryOne(db, 'SELECT COUNT(*) AS c FROM violations').c),
      credit_records: Number(queryOne(db, 'SELECT COUNT(*) AS c FROM credit_records').c),
      notifications: notificationCount,
      audit_logs: auditCount,
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 事务可能已被自动回滚 */
    }
    throw err;
  }
}

/**
 * 计划内的信用变动（信用修复加分 / 管理员复核调整）。
 *
 * 为什么需要这一步：CREDIT_PLAN 里 type='no_show' 的条目只是「该生应有几条爽约」的
 * 声明，真实扣分由实际生成的 no_show 预约驱动；如果某条声明的爽约因时段不足未能落库，
 * 声明的总分就会与真实台账产生差额。这里以「内存台账的实际余额」为准，把差额补成一条
 * 可解释的「管理员复核」台账，从而保证：
 *   1) 100 + Σcredit_records.change_points === users.credit_score 恒成立；
 *   2) 目标分值（CREDIT_PLAN.target）精确达成 —— 例如 55 分会触发自动冻结。
 */
function applyPlannedCredits(db, users, credits, anchor, now) {
  for (const plan of CREDIT_PLAN) {
    const user = users.find((u) => u.username === plan.username);
    if (!user) continue;
    const state = credits.get(user.id);
    const current = state ? state.score : 100;
    const diff = plan.target - current;
    if (diff === 0) continue;
    const reason =
      diff > 0
        ? '信用修复：按时归还设备、连续无违规记录，管理员复核后恢复信用分'
        : '信用扣减：多次违规累计，管理员复核后追加扣分';
    // 时间取「刚刚」，保证它排在全部历史事件之后，台账读起来是一条平滑的分数曲线
    applyCredit(db, credits, user.id, diff, reason, 'manual', 0, now - 60 * MINUTE);
  }
}

/** 冻结用户：信用分低于阈值自动暂停预约权限（对应 R12 与 config 阈值） */
function applyFrozenUsers(db, users, credits, config, now, notifications) {
  const frozenAt = now - 9 * DAY;
  const frozenScores = new Map();
  for (const user of users) {
    const state = credits.get(user.id);
    if (!state || state.score >= config.freezeThreshold) continue;
    const frozenUntil = now + 20 * DAY;
    db.prepare(
      `UPDATE users SET status = 'frozen', frozen_reason = ?, frozen_until = ?, updated_at = MAX(updated_at, ?)
       WHERE id = ?`,
    ).run('信用分低于 60，预约权限暂停', frozenUntil, frozenAt, user.id);
    user.status = 'frozen';
    user.frozen_reason = '信用分低于 60，预约权限暂停';
    user.frozen_until = frozenUntil;
    frozenScores.set(user.id, state.score);
    insertNotification(db, {
      user_id: user.id,
      type: 'credit.frozen',
      title: '信用分低于阈值，预约权限已暂停',
      content: `您的信用分为 ${state.score} 分，低于 ${config.freezeThreshold} 分的警戒线，系统已暂停您的预约权限至 ${formatDateTime(
        frozenUntil,
        TZ,
      )}。可在完成实验室志愿服务或通过管理员复核后申请恢复。`,
      link: '#/credit',
      is_read: 0,
      created_at: frozenAt,
    });
  }
  return frozenScores;
}

/* ================================================================== */
/* 八、对外接口                                                        */
/* ================================================================== */

/** 若数据库为空（users 表无数据）则写入完整演示数据；返回 true 表示本次写入了数据 */
function seedIfEmpty(db) {
  const row = queryOne(db, 'SELECT COUNT(*) AS c FROM users');
  if (row && Number(row.c) > 0) return false;
  writeSeed(db);
  return true;
}

/** 强制清空并重新写入演示数据（删除所有业务表数据后重建） */
function reseed(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    clearBusinessTables(db);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 忽略 */
    }
    throw err;
  }
  return writeSeed(db);
}

module.exports = { seedIfEmpty, reseed };
