// 用户 / 会话资料服务：把 QQ 的 OpenID 换成人类看得懂的昵称。
//
// 官方接口能力（https://bot.q.qq.com/wiki/develop/api-v2/autogen/）：
//   群成员  GET /v2/groups/{group_openid}/members/{member_openid}  → username
//   群列表  GET /v2/groups/{group_openid}/members                → 每个成员的 username
//   频道成员 GET /channels/{channel_id}/members/{user_id}        → nick
//   群信息  GET /v2/groups/{group_openid}/info                   → group_name
// 单聊（c2c）官方**没有**任何查询用户昵称的接口，只能拿到 user_openid；
// 因此单聊场景退回事件里自带的 username（通常为空），
// 并允许用户用 /昵称 命令自己登记一个显示名。
const DEFAULT_TTL = 30 * 60 * 1000;

export function profileKey(appId, kind, scene, targetId, userId = '') {
  return `${appId}|${kind}|${scene}|${targetId}|${userId}`;
}

export class ProfileService {
  constructor(store, { client, log = () => {}, ttlMs = DEFAULT_TTL } = {}) {
    this.store = store;
    this.client = client;
    this.log = log;
    this.ttlMs = ttlMs;
    this.pending = new Map();
  }

  _cached(key, loader) {
    const cached = this.store.getProfile(key);
    if (cached && Date.now() - cached.updatedAt < this.ttlMs) return Promise.resolve(cached);
    if (this.pending.has(key)) return this.pending.get(key);
    const flight = (async () => {
      try {
        const value = await loader();
        if (value && (value.name || value.avatar || value.role)) {
          const merged = { ...cached, ...value, updatedAt: Date.now() };
          this.store.saveProfile(key, merged);
          return merged;
        }
        return cached || null;
      } catch (error) {
        // 拿不到昵称不影响对话：保留旧值，只记一条警告。
        this.log('warn', '获取 QQ 用户资料失败', { error: error.message });
        return cached || null;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, flight);
    return flight;
  }

  /** 解析某个用户的显示名；返回 {name, avatar, role, source} 或 null。 */
  async resolveUser(appId, event) {
    if (!appId || !event?.userId) return null;
    const scene = event.scene;
    const key = profileKey(appId, 'user', scene, event.targetId, event.userId);
    // 事件里已经带了昵称（频道事件常见）就直接用，不必打扰接口。
    const inline = typeof event.senderName === 'string' ? event.senderName.trim() : '';
    if (inline) {
      this.store.saveProfile(key, { name: inline, avatar: '', role: '', source: 'event', updatedAt: Date.now() });
      return this.store.getProfile(key);
    }
    if (!this.client || !['group', 'channel'].includes(scene)) {
      return this.store.getProfile(key);
    }
    return this._cached(key, async () => {
      const profile = await this.client.memberProfile(scene, event.targetId, event.userId);
      if (profile?.name) return profile;
      // 单个成员接口在内邀/无权限时会失败，退回“群成员列表”再查一次。
      if (scene === 'group') {
        const list = await this.client.request('GET', `/v2/groups/${encodeURIComponent(event.targetId)}/members`);
        const rows = Array.isArray(list?.data) ? list.data : (Array.isArray(list?.members) ? list.members : []);
        const hit = rows.find(row => String(row?.member_openid || '') === String(event.userId));
        if (hit?.username) return { name: String(hit.username).slice(0, 64), role: String(hit.member_role || ''), avatar: '', source: 'api-list' };
      }
      return null;
    });
  }

  /** 解析群 / 会话的显示名。 */
  async resolveTarget(appId, event) {
    if (!appId || !event?.targetId) return null;
    const key = profileKey(appId, 'target', event.scene, event.targetId);
    if (!this.client || event.scene !== 'group') return this.store.getProfile(key);
    return this._cached(key, async () => {
      const profile = await this.client.groupProfile(event.targetId);
      return profile?.name ? profile : null;
    });
  }

  /** 同步读取已缓存的显示名（控制台列表用，避免每行都发网络请求）。 */
  cachedName(appId, kind, scene, targetId, userId = '') {
    const profile = this.store.getProfile(profileKey(appId, kind, scene, targetId, userId));
    return profile?.name || '';
  }
}

// 没有昵称时给一个可读的占位名，避免界面出现一串十六进制。
export function shortId(value, keep = 6) {
  const text = String(value || '');
  if (!text) return '';
  return text.length <= keep * 2 ? text : `${text.slice(0, keep)}…${text.slice(-4)}`;
}

export const SCENE_LABEL = { c2c: 'QQ 单聊', group: 'QQ 群聊', channel: '频道', dm: '频道私信', preview: '本地试聊' };
