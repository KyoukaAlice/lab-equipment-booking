/**
 * 前端通用工具：DOM 构造、格式化、弹窗、提示、图表
 * 不依赖任何第三方库，全部基于原生 API 实现。
 */

/* ============================== 基础 DOM ============================== */

/**
 * 创建元素：h('div.card', {onclick}, [子元素...])
 * 标签支持 "div.class1.class2#id" 简写
 */
export function h(tag, attrs = null, children = null) {
  let tagName = 'div';
  const classes = [];
  let id = '';
  if (typeof tag === 'string' && tag.length) {
    const m = tag.match(/^([a-zA-Z0-9-]+)?((?:[.#][\w-]+)*)$/);
    if (m) {
      tagName = m[1] || 'div';
      const rest = m[2] || '';
      for (const token of rest.split(/(?=[.#])/)) {
        if (!token) continue;
        if (token[0] === '.') classes.push(token.slice(1));
        else if (token[0] === '#') id = token.slice(1);
      }
    } else {
      tagName = tag;
    }
  }

  const el = document.createElement(tagName);
  if (classes.length) el.className = classes.join(' ');
  if (id) el.id = id;

  const append = (child) => {
    if (child === null || child === undefined || child === false || child === true) return;
    if (Array.isArray(child)) {
      child.forEach(append);
      return;
    }
    if (child instanceof Node) {
      el.appendChild(child);
      return;
    }
    el.appendChild(document.createTextNode(String(child)));
  };

  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') {
        el.className = [el.className, v].filter(Boolean).join(' ');
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (k === 'dataset' && typeof v === 'object') {
        Object.assign(el.dataset, v);
      } else if (k === 'html') {
        el.innerHTML = v;
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'value') {
        el.value = v;
      } else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') {
        if (v) el.setAttribute(k, '');
        else el.removeAttribute(k);
        if (k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = Boolean(v);
      } else {
        el.setAttribute(k, String(v));
      }
    }
    append(children);
    return el;
  }

  append(attrs);
  return el;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 转义 HTML（用于必须拼接 innerHTML 的场景） */
export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

/* ============================== 格式化 ============================== */

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function fmtMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  if (hours && rest) return `${hours} 小时 ${rest} 分`;
  if (hours) return `${hours} 小时`;
  return `${rest} 分钟`;
}

export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtRelative(ts) {
  const diff = Date.now() - Number(ts);
  const abs = Math.abs(diff);
  const future = diff < 0;
  const units = [
    [86400000 * 30, '个月'],
    [86400000, '天'],
    [3600000, '小时'],
    [60000, '分钟'],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return future ? `${n} ${label}后` : `${n} ${label}前`;
    }
  }
  return future ? '即将' : '刚刚';
}

/** 把日期对象/时间戳格式化为 YYYY-MM-DD */
export function toDateStr(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 时间戳 -> 与 input[type=datetime-local] 兼容的字符串 */
export function toLocalInput(ts) {
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** input[type=datetime-local] 的值 -> 时间戳 */
export function fromLocalInput(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

export function statusTag(status, label) {
  const map = {
    pending: 'tag-warn',
    approved: 'tag-brand',
    checked_in: 'tag-success',
    completed: 'tag-info',
    rejected: 'tag-danger',
    cancelled: '',
    no_show: 'tag-danger',
    waitlist: 'tag-purple',
  };
  return h(`span.tag.${map[status] || ''}`, label || status);
}

/** 设备类别 -> 图标 emoji */
export function deviceIcon(category) {
  const map = {
    测量仪器: '📈',
    开发板: '🧩',
    加工设备: '🛠️',
    计算设备: '🖥️',
    电源设备: '🔌',
    分析仪器: '🔬',
    网络设备: '📡',
  };
  return map[category] || '🧰';
}

export const CATEGORY_CLASS = {
  测量仪器: 'cat-测量仪器',
  开发板: 'cat-开发板',
  加工设备: 'cat-加工设备',
  计算设备: 'cat-计算设备',
};

export function deviceIconClass(category) {
  return CATEGORY_CLASS[category] || 'cat-其他';
}

/* ============================== 提示与弹窗 ============================== */

export function toast(message, type = 'info', timeout = 3200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = h(`div.toast.${type}`, message);
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, timeout);
}

export function loading(text = '加载中…') {
  return h('div.loading', [h('div.spinner'), h('p.muted', text)]);
}

export function emptyState(icon, text, action = null) {
  return h('div.empty', [h('span.empty-icon', icon), h('p', text), action]);
}

/**
 * 打开弹窗
 * @param {{title:string, body:Node|string, width?:string, footer?:Node[], onClose?:Function}} opts
 * @returns {{close:Function, root:Element}}
 */
export function openModal({ title, body, footer = [], wide = false, onClose = null }) {
  const root = document.getElementById('modal-root');
  const mask = h('div.modal-mask');
  const closeBtn = h('button.btn.btn-sm.close', { onclick: () => close() }, '关闭');
  const modal = h(`div.modal${wide ? '.modal-wide' : ''}`, [
    h('div.modal-head', [h('h3', title), closeBtn]),
    h('div.modal-body', body),
    footer.length ? h('div.modal-foot', footer) : null,
  ]);
  mask.appendChild(modal);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  root.appendChild(mask);

  function close() {
    document.removeEventListener('keydown', onKey);
    mask.remove();
    if (typeof onClose === 'function') onClose();
  }
  return { close, root: mask, modal };
}

/** 确认对话框（Promise 化） */
export function confirmDialog(message, { title = '请确认', okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const okBtn = h(
      `button.btn.${danger ? 'btn-danger' : 'btn-primary'}`,
      { onclick: () => done(true) },
      okText,
    );
    const cancelBtn = h('button.btn', { onclick: () => done(false) }, '取消');
    const { close } = openModal({
      title,
      body: h('p', { style: { margin: '4px 0 10px' } }, message),
      footer: [cancelBtn, okBtn],
      onClose: () => resolve(false),
    });
    function done(val) {
      close();
      resolve(val);
    }
  });
}

/** 表单弹窗：收集字段值后交给 onSubmit */
export function formModal({ title, fields, submitText = '提交', wide = false, onSubmit, hint = '' }) {
  const inputs = {};
  const body = h('div', [
    hint ? h('div.alert.alert-info', hint) : null,
    h(
      'div.grid',
      { style: { gap: '12px' } },
      fields.map((f) => {
        const el = buildField(f, inputs);
        return el;
      }),
    ),
  ]);
  const error = h('p.form-error', { hidden: true });
  body.appendChild(error);

  const submitBtn = h('button.btn.btn-primary', submitText);
  const cancelBtn = h('button.btn', '取消');
  const { close } = openModal({ title, body, footer: [cancelBtn, submitBtn], wide });

  cancelBtn.addEventListener('click', () => close());
  submitBtn.addEventListener('click', async () => {
    const values = {};
    for (const [name, el] of Object.entries(inputs)) {
      values[name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    submitBtn.disabled = true;
    try {
      await onSubmit(values, close);
    } catch (err) {
      error.textContent = err.message || '操作失败';
      error.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
  return { close, inputs };
}

function buildField(f, inputs) {
  const label = h('label.field', [h('span', { class: f.required ? 'req' : '' }, f.label)]);
  let el;
  if (f.type === 'select') {
    el = h('select.input', { name: f.name });
    for (const opt of f.options || []) {
      const value = typeof opt === 'object' ? opt.value : opt;
      const text = typeof opt === 'object' ? opt.label : opt;
      const o = h('option', { value }, text);
      if (String(value) === String(f.value ?? '')) o.selected = true;
      el.appendChild(o);
    }
  } else if (f.type === 'textarea') {
    el = h('textarea.input', { name: f.name, rows: f.rows || 3, placeholder: f.placeholder || '' });
    el.value = f.value ?? '';
  } else if (f.type === 'checkbox') {
    el = h('input', { type: 'checkbox', name: f.name });
    el.checked = Boolean(f.value);
    const wrap = h('label.row', { style: { gap: '8px' } }, [el, h('span', f.label)]);
    inputs[f.name] = el;
    return wrap;
  } else {
    el = h('input.input', {
      type: f.type || 'text',
      name: f.name,
      placeholder: f.placeholder || '',
      min: f.min,
      max: f.max,
      step: f.step,
    });
    el.value = f.value ?? '';
  }
  inputs[f.name] = el;
  label.appendChild(el);
  if (f.help) label.appendChild(h('span.small.muted', f.help));
  return label;
}

/* ============================== 通用片段 ============================== */

export function statCard({ label, value, foot = '', accent = 'brand' }) {
  return h(`div.stat.accent-${accent}`, [
    h('div.stat-label', label),
    h('div.stat-value', value),
    foot ? h('div.stat-foot', foot) : null,
  ]);
}

export function pagination({ page, pageSize, total, onChange }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return h('div.pager', [
    h('span.muted', `共 ${total} 条，第 ${page}/${pages} 页`),
    h('button.btn.btn-sm', { disabled: page <= 1, onclick: () => onChange(page - 1) }, '上一页'),
    h('button.btn.btn-sm', { disabled: page >= pages, onclick: () => onChange(page + 1) }, '下一页'),
  ]);
}

/** 横向条形进度（用于利用率展示） */
export function progressBar(ratio, variant = '') {
  const pct = Math.max(0, Math.min(100, (Number(ratio) || 0) * 100));
  const cls = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'success';
  return h('div.bar', [h(`i.${variant || cls}`, { style: { width: `${pct.toFixed(1)}%` } })]);
}

/** 柱状图：data = [{label, value, cls?}] */
export function barChart(data, { max = null, height = 170, formatter = (v) => v } = {}) {
  const peak = max || Math.max(1, ...data.map((d) => Number(d.value) || 0));
  return h(
    'div.chart-bars',
    { style: { height: `${height}px` } },
    data.map((d) =>
      h('div.cb-col', { title: `${d.label}：${formatter(d.value)}` }, [
        h('div.cb-val', formatter(d.value)),
        h(`div.cb-bar${d.cls ? `.${d.cls}` : ''}`, {
          style: { height: `${Math.max(2, (Number(d.value) / peak) * (height - 52))}px` },
        }),
        h('div.cb-label', d.label),
      ]),
    ),
  );
}

/** 环形图：data = [{label, value, color}] */
export function donutChart(data, { size = 148, centerLabel = '', centerValue = '' } = {}) {
  const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0);
  let acc = 0;
  const stops = [];
  for (const d of data) {
    const pct = total > 0 ? (Number(d.value) / total) * 100 : 0;
    stops.push(`${d.color} ${acc.toFixed(2)}% ${(acc + pct).toFixed(2)}%`);
    acc += pct;
  }
  const bg = total > 0 ? `conic-gradient(${stops.join(',')})` : '#f1f5f9';
  return h('div.row', { style: { gap: '18px', alignItems: 'center' } }, [
    h('div.donut', { style: { background: bg, width: `${size}px`, height: `${size}px` } }, [
      h('div.donut-center', [h('div', [h('b', centerValue), h('div.small.muted', centerLabel)])]),
    ]),
    h(
      'div.legend-list',
      data.map((d) =>
        h('div.ll-item', [
          h('span.ll-dot', { style: { background: d.color } }),
          h('span', `${d.label}`),
          h('strong', { style: { marginLeft: 'auto' } }, `${d.value}`),
        ]),
      ),
    ),
  ]);
}

/** 热力图：grid[7][24] 分钟数 */
export function heatmap(grid, maxValue, labels) {
  const wrap = h('div.heatmap');
  wrap.appendChild(h('div.hm-label', ''));
  for (let hour = 0; hour < 24; hour += 1) {
    wrap.appendChild(h('div.hm-label', hour % 2 === 0 ? String(hour) : ''));
  }
  for (let wd = 0; wd < 7; wd += 1) {
    wrap.appendChild(h('div.hm-label', labels[wd]));
    for (let hour = 0; hour < 24; hour += 1) {
      const value = grid[wd][hour];
      const ratio = maxValue > 0 ? value / maxValue : 0;
      const color = value === 0 ? '#f1f5f9' : `rgba(47,111,237,${(0.12 + ratio * 0.88).toFixed(2)})`;
      wrap.appendChild(
        h('div.heat-cell', {
          style: { background: color },
          title: `${labels[wd]} ${hour}:00 - ${hour + 1}:00：${value} 分钟`,
        }),
      );
    }
  }
  return wrap;
}

/** 数据表格：columns = [{key,label,render?,num?}] */
export function dataTable(columns, rows, { empty = '暂无数据' } = {}) {
  if (!rows || !rows.length) return emptyState('📭', empty);
  return h('div.table-wrap', [
    h('table.table', [
      h('thead', [h('tr', columns.map((c) => h(`th${c.num ? '.num' : ''}`, c.label)))]),
      h(
        'tbody',
        rows.map((row) =>
          h(
            'tr',
            columns.map((c) => {
              const content = c.render ? c.render(row) : row[c.key];
              return h(`td${c.num ? '.num' : ''}`, content ?? '—');
            }),
          ),
        ),
      ),
    ]),
  ]);
}

/** 键值详情列表 */
export function descList(pairs) {
  return h(
    'dl.dl',
    pairs
      .filter((p) => p && p[1] !== undefined && p[1] !== null && p[1] !== '')
      .flatMap((p) => [h('dt', p[0]), h('dd', p[1])]),
  );
}

/** 防抖 */
export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
