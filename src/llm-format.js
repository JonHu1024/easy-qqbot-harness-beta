// 聊天接口的两种协议适配：
//  - openai：POST {base}/chat/completions，Authorization: Bearer，system 混在 messages 里
//  - anthropic：POST {base}/messages，x-api-key + anthropic-version，system 是独立字段，
//    工具调用用 tool_use / tool_result 内容块，多模态用 image/document 块
// 内部统一使用 OpenAI 风格的 messages/tools，只在请求边界做转换，便于两种协议共用同一套业务逻辑。
export const FORMATS = ['openai', 'anthropic'];

export function detectFormat(baseUrl) {
  return /(^|\.)anthropic\.com|claude/i.test(String(baseUrl || '')) ? 'anthropic' : 'openai';
}
export function formatOf(config) {
  const declared = config?.llm?.apiFormat || 'auto';
  return declared === 'auto' ? detectFormat(config?.llm?.baseUrl) : declared;
}
const dataUrl = value => {
  const match = /^data:([^;,]+)(;charset=[^;,]+)?;base64,(.+)$/i.exec(String(value || ''));
  return match ? { mime: match[1].toLowerCase(), data: match[3] } : null;
};
function anthropicBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url' && part.image_url?.url) {
      const url = String(part.image_url.url);
      const parsed = dataUrl(url);
      if (parsed) blocks.push({ type: 'image', source: { type: 'base64', media_type: parsed.mime, data: parsed.data } });
      else if (/^https?:\/\//i.test(url)) blocks.push({ type: 'image', source: { type: 'url', url } });
      else blocks.push({ type: 'text', text: '[图片地址无法读取]' });
    } else if (part.type === 'file' && part.file?.file_data) {
      const parsed = dataUrl(part.file.file_data);
      if (parsed) blocks.push({ type: 'document', source: { type: 'base64', media_type: parsed.mime, data: parsed.data }, ...(part.file.filename ? { title: part.file.filename } : {}) });
      else blocks.push({ type: 'text', text: `[文件无法读取：${part.file.filename || '附件'}]` });
    } else if (typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
  }
  return blocks;
}
// OpenAI 风格 messages → Anthropic 的 {system, messages}
export function toAnthropicMessages(messages) {
  const system = [];
  const converted = [];
  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'system' || message.role === 'developer') {
      const text = typeof message.content === 'string' ? message.content : anthropicBlocks(message.content).filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (text) system.push(text);
      continue;
    }
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.tool_call_id, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') };
      const last = converted[converted.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.some(b => b.type === 'tool_result')) last.content.push(block);
      else converted.push({ role: 'user', content: [block] });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const blocks = anthropicBlocks(message.content);
      for (const call of message.tool_calls) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name || '', input });
      }
      converted.push({ role: 'assistant', content: blocks });
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = anthropicBlocks(message.content);
    if (!blocks.length) continue;
    const last = converted[converted.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else converted.push({ role, content: blocks });
  }
  // Anthropic 要求 user/assistant 交替：同角色的连续消息已合并，这里再做一次兜底交替。
  const merged = [];
  for (const message of converted) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) last.content.push(...message.content);
    else merged.push(message);
  }
  return { system: system.join('\n\n'), messages: merged };
}
export function toAnthropicTools(tools) {
  return (tools || []).map(tool => ({
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description || '',
    input_schema: tool.function?.parameters || tool.input_schema || { type: 'object', properties: {} },
  }));
}
export function buildRequest(format, { baseUrl, apiKey, model, messages, tools, toolChoice, temperature, maxTokens, reasoningEffort, signal } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (format === 'anthropic') {
    const { system, messages: converted } = toAnthropicMessages(messages);
    const body = {
      model,
      max_tokens: Math.max(1, Number(maxTokens) || 1024),
      messages: converted,
      ...(system ? { system } : {}),
      ...(Number.isFinite(temperature) ? { temperature } : {}),
    };
    // Anthropic 没有 tool_choice:'none'；要禁用工具就干脆不传 tools。
    if (tools?.length && toolChoice !== 'none') {
      body.tools = toAnthropicTools(tools);
      if (toolChoice && toolChoice !== 'auto') body.tool_choice = { type: toolChoice };
    }
    const headers = { 'content-type': 'application/json', accept: 'application/json', 'anthropic-version': '2023-06-01' };
    if (apiKey) { headers['x-api-key'] = apiKey; headers.authorization = `Bearer ${apiKey}`; }
    return { url: `${base}/messages`, headers, body, signal };
  }
  const body = {
    model,
    messages,
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(tools?.length ? { tools, tool_choice: toolChoice || 'auto', parallel_tool_calls: false } : {}),
  };
  // 思考型模型（MiniMax M2/M3、o 系列、DeepSeek R1 等）会先写一大段推理。
  // 不限制的话它能把整个输出额度耗光，正文一个字都吐不出来。
  if (reasoningEffort && reasoningEffort !== 'off') body.reasoning_effort = reasoningEffort;
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return { url: `${base}/chat/completions`, headers, body, signal };
}
export function parseResponse(format, data) {
  if (format === 'anthropic') {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
    const toolCalls = blocks.filter(block => block?.type === 'tool_use' && block.name).map(block => ({
      id: String(block.id || ''),
      type: 'function',
      function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) },
    }));
    // 思考型模型：正文前面会有一大段 thinking。
    // 如果 thinking 把输出额度吃光了，正文就一个字都吐不出来 —— 这时要明确告诉用户是「被截断」。
    const thinking = blocks.filter(block => block?.type === 'thinking' && typeof block.thinking === 'string');
    return {
      content: text.trim() ? text : '',
      tool_calls: toolCalls,
      thinkingOnly: !text.trim() && !toolCalls.length && thinking.length > 0,
      thinkingChars: thinking.reduce((sum, block) => sum + block.thinking.length, 0),
      stopReason: String(data?.stop_reason || ''),
      usage: {
        promptTokens: Number(data?.usage?.input_tokens ?? NaN),
        completionTokens: Number(data?.usage?.output_tokens ?? NaN),
        total: Number(data?.usage?.input_tokens ?? 0) + Number(data?.usage?.output_tokens ?? 0),
        counted: !!data?.usage,
      },
    };
  }
  const message = data?.choices?.[0]?.message;
  const usage = data?.usage;
  const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
  const content = typeof message?.content === 'string' ? message.content : '';
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return {
    content,
    tool_calls: toolCalls,
    thinkingOnly: !content.trim() && !toolCalls.length && !!reasoning.trim(),
    thinkingChars: reasoning.length,
    stopReason: String(data?.choices?.[0]?.finish_reason || ''),
    usage: {
      promptTokens: Number(usage?.prompt_tokens ?? usage?.input_tokens ?? NaN),
      completionTokens: Number(usage?.completion_tokens ?? usage?.output_tokens ?? NaN),
      total: Number(usage?.total_tokens ?? NaN),
      counted: !!usage,
    },
  };
}
