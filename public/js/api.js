/**
 * 后端接口客户端
 * 统一处理：Bearer 鉴权、JSON 序列化、错误对象、HTTP 错误码 -> 中文提示
 */

const TOKEN_KEY = 'lab_booking_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** 业务错误：携带后端返回的机器可读 code 与明细 */
export class ApiError extends Error {
  constructor(message, code, status, detail) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

async function request(method, path, { body, query, raw = false } = {}) {
  let url = path;
  if (query && Object.keys(query).length) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      params.append(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError('网络连接失败，请检查服务是否已启动', 'NETWORK_ERROR', 0, null);
  }

  if (res.status === 204) return null;

  if (raw) {
    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(text || '导出失败', 'EXPORT_FAILED', res.status, null);
    }
    return res;
  }

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError('服务器返回了非 JSON 数据', 'BAD_RESPONSE', res.status, text.slice(0, 200));
  }

  if (!res.ok || (payload && payload.ok === false)) {
    const message = (payload && payload.message) || `请求失败（HTTP ${res.status}）`;
    const code = (payload && payload.code) || 'HTTP_ERROR';
    if (res.status === 401) {
      setToken('');
      window.dispatchEvent(new CustomEvent('auth:expired'));
    }
    throw new ApiError(message, code, res.status, payload ? payload.detail : null);
  }
  return payload ? payload.data : null;
}

const get = (path, query) => request('GET', path, { query });
const post = (path, body) => request('POST', path, { body });
const patch = (path, body) => request('PATCH', path, { body });
const del = (path, body) => request('DELETE', path, { body });

/* ============================== 接口定义 ============================== */

export const api = {
  /* 认证与个人中心 */
  publicInfo: () => get('/api/public/info'),
  login: (username, password) => post('/api/auth/login', { username, password }),
  register: (payload) => post('/api/auth/register', payload),
  logout: () => post('/api/auth/logout', {}),
  me: () => get('/api/auth/me'),
  updateProfile: (payload) => patch('/api/me', payload),
  changePassword: (oldPassword, newPassword) => post('/api/me/password', { oldPassword, newPassword }),
  myCredit: (query) => get('/api/me/credit', query),
  myViolations: (query) => get('/api/me/violations', query),
  myQuota: () => get('/api/me/quota'),

  /* 元信息 */
  categories: () => get('/api/meta/categories'),
  bookingRules: () => get('/api/meta/booking-rules'),

  /* 实验室与设备 */
  labs: (query) => get('/api/labs', query),
  lab: (id) => get(`/api/labs/${id}`),
  labToday: (id) => get(`/api/labs/${id}/today`),
  devices: (query) => get('/api/devices', query),
  device: (id) => get(`/api/devices/${id}`),
  deviceAvailability: (id, query) => get(`/api/devices/${id}/availability`, query),
  commonAvailability: (query) => get('/api/devices/common-availability', query),

  /* 预约 */
  createBooking: (payload) => post('/api/bookings', payload),
  bookings: (query) => get('/api/bookings', query),
  booking: (id) => get(`/api/bookings/${id}`),
  myBookingSummary: () => get('/api/bookings/mine/summary'),
  approveBooking: (id, note) => post(`/api/bookings/${id}/approve`, { note }),
  rejectBooking: (id, reason) => post(`/api/bookings/${id}/reject`, { reason }),
  batchReview: (ids, action, note) => post('/api/bookings/batch-review', { ids, action, note }),
  cancelBooking: (id, reason) => post(`/api/bookings/${id}/cancel`, { reason }),
  checkin: (id, code) => post(`/api/bookings/${id}/checkin`, { code }),
  checkout: (id) => post(`/api/bookings/${id}/checkout`, {}),
  exportBookingsUrl: (query) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') params.append(k, String(v));
    }
    return `/api/bookings/export?${params.toString()}`;
  },

  /* 候补 */
  waitlist: (query) => get('/api/waitlist', query),
  joinWaitlist: (payload) => post('/api/waitlist', payload),
  leaveWaitlist: (id) => post(`/api/waitlist/${id}/leave`, {}),
  confirmWaitlist: (id) => post(`/api/waitlist/${id}/confirm`, {}),

  /* 通知 */
  notifications: (query) => get('/api/notifications', query),
  unreadCount: () => get('/api/notifications/unread-count'),
  readNotification: (id) => post(`/api/notifications/${id}/read`, {}),
  readAllNotifications: () => post('/api/notifications/read-all', {}),

  /* 统计 */
  dashboard: (query) => get('/api/stats/dashboard', query),
  overview: (query) => get('/api/stats/overview', query),
  utilization: (query) => get('/api/stats/utilization', query),
  statsLabs: (query) => get('/api/stats/labs', query),
  heatmap: (query) => get('/api/stats/heatmap', query),
  statsUsers: (query) => get('/api/stats/users', query),
  statsComposition: (query) => get('/api/stats/composition', query),
  statsTrend: (query) => get('/api/stats/trend', query),

  /* 管理端 */
  adminLabs: () => get('/api/labs'),
  createLab: (payload) => post('/api/admin/labs', payload),
  updateLab: (id, payload) => patch(`/api/admin/labs/${id}`, payload),
  deleteLab: (id) => del(`/api/admin/labs/${id}`),
  createDevice: (payload) => post('/api/admin/devices', payload),
  updateDevice: (id, payload) => patch(`/api/admin/devices/${id}`, payload),
  deleteDevice: (id) => del(`/api/admin/devices/${id}`),
  slots: (query) => get('/api/admin/slots', query),
  createSlot: (payload) => post('/api/admin/slots', payload),
  updateSlot: (id, payload) => patch(`/api/admin/slots/${id}`, payload),
  deleteSlot: (id) => del(`/api/admin/slots/${id}`),
  blackouts: (query) => get('/api/admin/blackouts', query),
  createBlackout: (payload) => post('/api/admin/blackouts', payload),
  deleteBlackout: (id) => del(`/api/admin/blackouts/${id}`),
  adminUsers: (query) => get('/api/admin/users', query),
  createUser: (payload) => post('/api/admin/users', payload),
  updateUser: (id, payload) => patch(`/api/admin/users/${id}`, payload),
  freezeUser: (id, payload) => post(`/api/admin/users/${id}/freeze`, payload),
  toggleUserDisable: (id) => post(`/api/admin/users/${id}/disable`, {}),
  resetUserPassword: (id, password) => post(`/api/admin/users/${id}/reset-password`, { password }),
  violations: (query) => get('/api/admin/violations', query),
  createViolation: (payload) => post('/api/admin/violations', payload),
  revokeViolation: (id, reason) => del(`/api/admin/violations/${id}`, { reason }),
  config: () => get('/api/admin/config'),
  updateConfig: (payload) => patch('/api/admin/config', payload),
  auditLogs: (query) => get('/api/admin/audit', query),
  system: () => get('/api/admin/system'),
  capacity: (query) => get('/api/admin/capacity', query),
  runJobs: () => post('/api/admin/jobs/run', {}),
};

/** 触发受保护文件下载（CSV 导出需要携带 token，故用 fetch + blob） */
export async function downloadWithAuth(url, filename) {
  const res = await request('GET', url, { raw: true });
  const blob = await res.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 1000);
}
