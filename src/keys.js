import { createHash } from 'node:crypto';

// 会话键规则（引擎与存储必须共用，否则群聊引用回查会失效）：
// 群聊/频道是共享场景，记忆按「机器人+场景+目标」归并；单聊/私信按用户区分。
export const SHARED_SCENES = new Set(['group','channel']);

export function conversationKey(appId, event) {
  const parts = SHARED_SCENES.has(event?.scene)
    ? [appId, event.scene, event.targetId]
    : [appId, event.scene, event.targetId, event.userId];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
