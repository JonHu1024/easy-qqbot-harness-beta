// 文本卫生：模型有时会模仿上下文里的元信息格式（例如把历史消息的时间前缀抄进回复）。
// 这里只在“行内还有其他内容”时剥离行首时间戳，避免误删用户真正要的时间回答。
// 也认我们自己加的「[2026-11-03 22:14 · 3天前]」这种带相对时间的标记。
const LEADING_TIMESTAMP = /^\s*\[\s*\d{4}[/-]\d{1,2}[/-]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*[·|｜]\s*[^\]]*)?\s*\]\s*/;
const BARE_TIMESTAMP = /^\s*\[\s*\d{4}[/-]\d{1,2}[/-]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*\]\s*$/;
const ISO_TIMESTAMP = /^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\s*$/;

export function stripStrayTimestamps(text) {
  return String(text ?? '').split('\n').map(line => line.replace(LEADING_TIMESTAMP, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function isTimestampOnly(text) {
  const value = String(text ?? '').trim();
  return BARE_TIMESTAMP.test(value) || ISO_TIMESTAMP.test(value);
}
const TIME_QUESTION = /几点|时间|日期|几号|星期|周几|多少号|什么时候|多久|now|time|date|clock/i;
export function asksAboutTime(text) { return TIME_QUESTION.test(String(text ?? '')); }
