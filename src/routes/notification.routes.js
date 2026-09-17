'use strict';

/**
 * 通知中心路由
 */

const notification = require('../services/notification.service');
const presenters = require('../services/presenters');
const { ok, requireLogin, pageQuery } = require('../http/helpers');
const { notFound } = require('../utils/errors');

function register(ctx) {
  /** 通知列表（onlyUnread=true 只看未读） */
  ctx.router.get('/api/notifications', async (req) => {
    const user = requireLogin(req);
    const { page, pageSize } = pageQuery(req, 20);
    const result = notification.list(user.id, {
      onlyUnread: req.query.onlyUnread === 'true',
      page,
      pageSize,
    });
    return ok({
      items: result.items.map(presenters.notification),
      total: result.total,
      unread: result.unread,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  /** 未读数（用于顶栏红点轮询） */
  ctx.router.get('/api/notifications/unread-count', async (req) => {
    const user = requireLogin(req);
    return ok({ unread: notification.unreadCount(user.id) });
  });

  /** 标记单条已读 */
  ctx.router.post('/api/notifications/:id/read', async (req) => {
    const user = requireLogin(req);
    const done = notification.markRead(user.id, Number(req.params.id));
    if (!done) throw notFound('通知不存在或已标记为已读');
    return ok({ unread: notification.unreadCount(user.id) });
  });

  /** 全部标记已读 */
  ctx.router.post('/api/notifications/read-all', async (req) => {
    const user = requireLogin(req);
    const marked = notification.markAllRead(user.id);
    return ok({ marked, unread: 0 });
  });
}

module.exports = { register };
