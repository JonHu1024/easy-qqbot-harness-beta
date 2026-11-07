// 消息合并器：收到消息后先等一小会儿，把这期间同一会话里的多条消息合并成一次回答。
//
// 目的（对应“接受到消息后不要立即回复，有个可设定的延迟”）：
//   1. 用户连着发 3 条消息时，机器人读完全部内容再回答，不会答一句漏一句。
//   2. 回复不再“秒回”，更像真人；等待时间由用户自己设定。
//
// 规则：
//   delayMs —— 首次回复延迟：至少等这么久才开始回答。
//   windowMs —— 合并窗口：等待期间到达的消息会并入同一次回答；0 表示不额外等待。
//   命令（斜杠命令）走 urgent 通道：立刻结算之前的普通消息，命令本身单独立即回答。

export class MessageBatcher {
  constructor({
    delayMs = 0,
    windowMs = 0,
    resolveTiming = null,
    maxEvents = 30,
    onFlush = () => {},
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle),
  } = {}) {
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.windowMs = Math.max(0, Number(windowMs) || 0);
    // resolveTiming 存在时，每次排程都读最新配置：改了设置立刻生效，不用重启。
    this.resolveTiming = typeof resolveTiming === 'function' ? resolveTiming : null;
    this.maxEvents = Math.max(1, Number(maxEvents) || 30);
    this.onFlush = onFlush;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.buckets = new Map();
  }

  configure({ delayMs, windowMs } = {}) {
    if (delayMs !== undefined) this.delayMs = Math.max(0, Number(delayMs) || 0);
    if (windowMs !== undefined) this.windowMs = Math.max(0, Number(windowMs) || 0);
  }

  get size() { return this.buckets.size; }
  get pending() { return [...this.buckets.values()].reduce((total, bucket) => total + bucket.events.length, 0); }

  _timing() {
    if (!this.resolveTiming) return { delayMs: this.delayMs, windowMs: this.windowMs };
    try {
      const value = this.resolveTiming() || {};
      return {
        delayMs: Math.max(0, Number(value.delayMs ?? this.delayMs) || 0),
        windowMs: Math.max(0, Number(value.windowMs ?? this.windowMs) || 0),
      };
    } catch { return { delayMs: this.delayMs, windowMs: this.windowMs }; }
  }

  _wait() {
    const { delayMs, windowMs } = this._timing();
    return Math.max(delayMs, windowMs);
  }

  /**
   * 收下一条消息。
   * @param {string} key 会话标识（同一 key 的消息才会被合并）
   * @param {object} event 归一化后的事件
   * @param {{urgent?:boolean}} options urgent=true 时立即回答（命令）
   */
  push(key, event, { urgent = false } = {}) {
    if (urgent) {
      // 命令要立刻有回应：先把挂起的普通消息结算掉，命令单独走一次。
      this.flush(key);
      return this.onFlush([event], { urgent: true, merged: false });
    }
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { key, events: [], timer: null, firstAt: this.now() };
      this.buckets.set(key, bucket);
    }
    bucket.events.push(event);
    if (bucket.events.length > this.maxEvents) bucket.events.splice(0, bucket.events.length - this.maxEvents);
    if (bucket.timer) this.clearTimer(bucket.timer);
    bucket.timer = this.setTimer(() => this.flush(key), this._wait());
    return null;
  }

  flush(key) {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    if (bucket.timer) this.clearTimer(bucket.timer);
    this.buckets.delete(key);
    if (!bucket.events.length) return null;
    return this.onFlush(bucket.events, { urgent: false, merged: bucket.events.length > 1 });
  }

  flushAll() {
    const keys = [...this.buckets.keys()];
    for (const key of keys) this.flush(key);
  }

  clear() {
    for (const bucket of this.buckets.values()) if (bucket.timer) this.clearTimer(bucket.timer);
    this.buckets.clear();
  }
}

// 把同一会话的多条消息合并成一条事件。
// 合并后的 content 用换行连接，附件全部带上，时间取第一条消息的发送时间。
export function mergeEvents(events) {
  if (!Array.isArray(events) || !events.length) return null;
  if (events.length === 1) return { ...events[0], mergedCount: 1 };
  const first = events[0];
  const last = events[events.length - 1];
  const content = events
    .map(event => (typeof event.content === 'string' ? event.content.trim() : ''))
    .filter(Boolean)
    .join('\n');
  const attachments = [];
  for (const event of events) {
    for (const item of event.attachments || []) attachments.push(item);
  }
  return {
    ...first,
    content,
    attachments,
    timestamp: first.timestamp || last.timestamp || '',
    mergedCount: events.length,
    mergedAt: new Date().toISOString(),
  };
}
