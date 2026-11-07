'use strict';

const $ = (id) => document.getElementById(id);
const all = (selector, root = document) => [...root.querySelectorAll(selector)];
const configFields = all('[data-config]');
const busyElements = new Set();
const harnessDefaults = {
  splitLines: true, visionEnabled: true, filesEnabled: true, pdfFileParts: false, maxAttachmentMB: 8, maxImages: 4, maxStorageMB: 20,
  autoMemory: true, modelTasks: true, memesEnabled: false, memeChance: 0.15,
  typingEnabled: false, naturalDelay: true, maxToolRounds: 12, fileOutputEnabled: true, longReplyEnabled: false,
  longReplyCooldownMinutes: 60, longReplyMaxChars: 3500, retryEnabled: true,
  emojiFaces: true, tasksAutoCleanup: true, taskHistoryDays: 7,
  resourcesEnabled: true, resourceMaxChars: 1200, resourceAutoInject: 3, pokeEnabled: true, shellEnabled: true,
  profileLookup: true, profileCacheMinutes: 30, resourceImageEnabled: true, autoApproveJoin: false,
  searchEnabled: false, searchProvider: 'auto', searchResults: 5, readUrlEnabled: false,
  imageGenEnabled: false, videoGenEnabled: false,
  genMode: 'agnes', genBaseUrl: '', genApiKey: '',
  genCustomUrl: '', genCustomMethod: 'POST', genCustomBody: '', genCustomPath: 'data.0.url', genCustomHeaders: '',
  imageModel: 'agnes-image-2.5-flash', videoModel: 'agnes-video-2.5-flash',
  genUseReference: true, videoSeconds: 5,
};
const botDefaults = {
  name: '我的QQ机器人', persona: '你是一个友善、简洁的中文助手。',
  defiance: '你不是无条件顺从的工具。遇到明显不合理的要求（自相矛盾、越权、要求你伪造事实或滥用工具）时，先用一句话说明你的顾虑，再给出你能做到的部分或替代方案；不要长篇说教，也不要为了反对而反对。对正常的闲聊、帮忙与创作请求，正常配合就好。',
  enabled: true, mode: 'rules', fallback: '你好！发送 /帮助 查看可用命令。',
  replyCount: 1, minChars: 10, maxChars: 300, replyDelayMs: 800, cooldownMs: 1000,
  firstReplyDelayMs: 1200, mergeWindowMs: 2500, memoryEnabled: true, historyTurns: 12, memoryDays: 30,
  allowUsers: [], denyUsers: [], allowTargets: [], admins: [], welcome: '',
  autoReplyScenes: ['c2c', 'group', 'channel', 'dm'],
};
const llmDefaults = {
  baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '', temperature: 0.7,
  maxTokens: 16384, timeoutMs: 120000, apiFormat: 'auto', reasoningEffort: 'low',
};
const imageMimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const fileMimes = [...imageMimes, 'application/pdf', 'text/plain', 'text/markdown', 'application/json', 'text/csv'];
const resourceExtensions = ['txt', 'md', 'markdown', 'csv', 'json', 'pdf', 'log', 'tsv', 'yaml', 'yml', 'ini', 'conf'];
const resourceImageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const state = {
  session: null, config: null, dirty: false, status: null, tab: 'overview',
  conversations: [], memoryKey: null, factsDirty: false, memoryLoading: false,
  logs: [], statusLoading: false, logsLoading: false, initialized: false,
  attachments: [], tasks: [], memes: [], taskEditId: null, memeEditId: null,
  taskDirty: false, memeDirty: false, tasksLoading: false, memesLoading: false,
  folders: [], foldersLoading: false, folderEditId: null, folderDirty: false,
  usage: null, usageLoading: false,
};

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function json(value) { return JSON.stringify(value, null, 2); }
// 窄栏用的紧凑日期：2026/11/3 17:52 -> 11-03 17:52
function shortDate(value) {
  const text = date(value);
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(.+)$/.exec(text);
  return match ? `${match[2]}-${match[3]} ${match[4]}` : text;
}
function date(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString('zh-CN');
}
function errorText(error) {
  let text = error.message || String(error);
  if (error.code !== undefined) text += `\n业务码：${error.code}`;
  if (error.traceId) text += `\ntraceId：${error.traceId}`;
  return text;
}
let feedbackTimer = null;
function feedback(text, error = false, id = 'feedback') {
  const element = $(id);
  if (!element) return;
  element.textContent = text;
  element.classList.toggle('error-text', error);
  element.classList.toggle('success-text', !error && Boolean(text));
  element.classList.toggle('is-error', id === 'feedback' && error);
  if (id === 'feedback' && text) {
    element.hidden = false;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => { element.textContent = ''; element.hidden = true; }, error ? 8000 : 4000);
  }
}
function result(id, value, error = false) {
  const element = $(id);
  if (!element) return;
  element.hidden = false;
  element.textContent = error ? json(value.responseData || { error: value.message || String(value), ...(value.code !== undefined ? { code: value.code } : {}), ...(value.traceId ? { traceId: value.traceId } : {}), ...(value.status ? { status: value.status } : {}) }) : json(value);
  element.classList.toggle('error-text', error);
}
function loginView(show) {
  $('login-panel').hidden = !show;
  $('console').hidden = show;
  $('startup-error').hidden = true;
  if (show) $('login-password').focus();
}
async function api(path, { method = 'GET', body, keepSession = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && path !== '/api/login') {
    if (!state.session?.csrfToken) throw new Error('会话未就绪，请重新登录或刷新页面。');
    headers['X-CSRF-Token'] = state.session.csrfToken;
  }
  const response = await fetch(path, {
    method, headers, credentials: 'same-origin', cache: 'no-store',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { throw new Error(`服务器返回了非 JSON 响应（HTTP ${response.status}）。请检查服务与代理配置。`); }
  if (!response.ok || (data && typeof data === 'object' && data.error)) {
    const error = new Error(typeof data?.error === 'string' ? data.error : `请求失败（HTTP ${response.status}）`);
    error.code = data?.code;
    error.traceId = data?.traceId;
    error.status = response.status;
    error.responseData = data;
    if (response.status === 401 && !keepSession) {
      if (state.session) state.session.authenticated = false;
      loginView(true);
      feedback('登录已失效，请重新登录。未保存的表单仍保留。', true, 'login-feedback');
    }
    throw error;
  }
  return data;
}
function syncControls() {
  const running = Boolean(state.status?.running);
  const unavailable = !state.config;
  for (const element of all('[data-config^="qq."], [data-intent], #clear-qq-secret')) {
    element.disabled = running || unavailable || busyElements.has(element);
  }
  for (const id of ['save-config', 'reload-config', 'export-config', 'import-config']) {
    $(id).disabled = unavailable || busyElements.has($(id));
  }
  $('start-bot').disabled = !state.status || running || unavailable || busyElements.has($('start-bot'));
  $('stop-bot').disabled = !state.status || !running || busyElements.has($('stop-bot'));
  $('check-bot').disabled = unavailable || busyElements.has($('check-bot'));
  for (const id of ['save-facts', 'delete-memory', 'consolidate-facts', 'rename-session', 'export-session']) {
    if (!$(id)) continue;
    $(id).disabled = !state.memoryKey || state.memoryLoading || busyElements.has($(id));
  }
  for (const id of ['test-chat', 'test-image', 'test-video']) {
    if (!$(id)) continue;
    $(id).disabled = unavailable || busyElements.has($(id));
  }
  $('memory-actions').hidden = !state.memoryKey || state.memoryLoading;
}
async function locked(elements, action) {
  const list = [...new Set(elements)].filter(Boolean);
  if (list.some((element) => busyElements.has(element))) return;
  const previous = list.map((element) => element.disabled);
  list.forEach((element) => { busyElements.add(element); element.disabled = true; });
  try { return await action(); }
  finally {
    list.forEach((element, index) => { busyElements.delete(element); element.disabled = previous[index]; });
    syncControls();
  }
}
function controls(root) { return all('input, textarea, select, button', root); }
function configControls() { return [...all('.config-card input, .config-card textarea, .config-card select, .config-card button'), ...all('.savebar button')]; }
function changed() {
  state.dirty = true;
  $('save-state').textContent = '有未保存的改动';
  $('save-state').classList.add('unsaved');
}
function markSaved() {
  state.dirty = false;
  $('save-state').textContent = '配置已保存';
  $('save-state').classList.remove('unsaved');
}
function showTab(tab) {
  state.tab = tab;
  for (const element of all('[data-panel]')) element.hidden = element.dataset.panel !== tab;
  const panel = document.querySelector(`[data-panel="${tab}"]`);
  if (panel) {
    $('page-eyebrow').textContent = panel.dataset.eyebrow || '';
    $('page-title').textContent = panel.dataset.title || '';
    $('page-sub').textContent = panel.dataset.sub || '';
  }
  for (const element of all('[data-tab]')) {
    const selected = element.dataset.tab === tab;
    element.classList.toggle('active', selected);
    if (selected) element.setAttribute('aria-current', 'page');
    else element.removeAttribute('aria-current');
  }
  if (tab === 'memory') loadConversations().catch((error) => feedback(errorText(error), true));
  if (tab === 'overview') loadUsage().catch((error) => feedback(errorText(error), true, 'usage-feedback'));
  if (tab === 'logs') loadLogs().catch((error) => feedback(errorText(error), true));
  if (tab === 'tasks') loadTasks().catch((error) => feedback(errorText(error), true, 'task-feedback'));
  if (tab === 'memes') loadMemes().catch((error) => feedback(errorText(error), true, 'meme-feedback'));
  if (tab === 'resources') loadFolders().catch((error) => feedback(errorText(error), true, 'folder-feedback'));
  if (tab === 'storage') loadStorage().catch((error) => feedback(errorText(error), true));
}
function syncIntents() {
  const bits = Number(document.querySelector('[data-config="qq.intents"]').value);
  for (const checkbox of all('[data-intent]')) checkbox.checked = Number.isFinite(bits) && Math.floor(bits / Number(checkbox.dataset.intent)) % 2 === 1;
}
function fillConfig(config) {
  config = { ...config, llm: { ...llmDefaults, ...config.llm, apiFormat: config.llm?.apiFormat ?? llmDefaults.apiFormat }, harness: { ...harnessDefaults, ...config.harness } };
  for (const field of configFields) {
    const [group, key] = field.dataset.config.split('.');
    const value = config[group][key];
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else if (field.hasAttribute('data-list')) field.value = value.join('\n');
    else field.value = value ?? '';
  }
  $('clear-qq-secret').checked = config.qq.appSecret === null;
  $('clear-llm-secret').checked = config.llm.apiKey === null;
  $('clear-gen-secret').checked = config.harness.genApiKey === null;
  $('clear-tts-secret').checked = config.harness.ttsApiKey === null;
  const voiceSelect = $('tts-voice-select');
  if (voiceSelect) {
    const wanted = config.harness.ttsWindowsVoice || '';
    const known = [...voiceSelect.options].some((option) => option.value === wanted);
    if (wanted && !known) {
      const option = document.createElement('option');
      option.value = wanted; option.textContent = `${wanted}（手填）`;
      voiceSelect.append(option);
    }
    voiceSelect.value = wanted;
  }
  $('qq-secret-hint').textContent = state.config?.qq.hasAppSecret ? '已保存密钥；留空不会修改。勾选清除会删除。' : '尚未保存 QQ 密钥。';
  $('llm-secret-hint').textContent = state.config?.llm.hasApiKey ? '已保存 API Key；留空不会修改。勾选清除会删除。' : '尚未保存模型 API Key。';
  $('gen-secret-hint').textContent = state.config?.harness.hasGenApiKey ? '已保存生成 API Key；留空不会修改。勾选清除会删除。' : '尚未保存生成 API Key（留空则沿用模型 API Key）。';
  for (const field of all('#reply-scenes input')) field.checked = config.bot.autoReplyScenes.includes(field.value);
  $('command-rows').replaceChildren();
  config.commands.forEach((command) => addCommand(command));
  $('rule-rows').replaceChildren();
  config.rules.forEach((rule) => addRule(rule));
  updateRowEmpty();
  syncIntents();
  syncControls();
  syncGenMode();
  syncTtsMode();
  syncTtsSecretHint();
  updateBotName(config.bot.name);
}
// 语音接入方式切换：只显示当前方式需要的字段。
function syncTtsMode() {
  const mode = document.querySelector('[data-config="harness.ttsMode"]')?.value || 'off';
  const api = $('tts-api'), windows = $('tts-windows');
  if (api) api.hidden = mode !== 'api';
  if (windows) windows.hidden = mode !== 'windows';
  const format = document.querySelector('[data-config="harness.ttsApiFormat"]')?.value || 'openai';
  const common = $('tts-api-common'), custom = $('tts-api-custom'), minimax = $('tts-api-minimax');
  if (common) common.hidden = format === 'custom';
  if (custom) custom.hidden = format !== 'custom';
  if (minimax) minimax.hidden = format !== 'minimax';
  const pickerRow = $('tts-voice-picker-row');
  if (pickerRow) pickerRow.hidden = format !== 'minimax';
  const preset = $('tts-preset');
  if (preset) {
    const presetFormat = { minimax: 'minimax', openai: 'openai', azure: 'openai' }[preset.value];
    preset.disabled = !preset.value || !presetFormat || presetFormat !== format;
  }
}

// 服务预设：一次性把地址、协议、模型、音色填好，省得对着文档抄。
const TTS_PRESETS = {
  minimax: { format: 'minimax', baseUrl: 'https://api.minimax.cn', model: 'speech-2.8-hd', voice: 'male-qn-qingse' },
  openai: { format: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy' },
  azure: { format: 'openai', baseUrl: '', model: 'tts-1', voice: 'alloy' },
};
function applyTtsPreset(name) {
  const preset = TTS_PRESETS[name];
  if (!preset) return;
  const set = (path, value) => {
    const field = document.querySelector(`[data-config="harness.${path}"]`);
    if (field) { field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); }
  };
  set('ttsApiFormat', preset.format);
  if (preset.baseUrl) set('ttsBaseUrl', preset.baseUrl);
  set('ttsModel', preset.model);
  set('ttsVoice', preset.voice);
  syncTtsMode();
  changed();
}
function syncTtsSecretHint() {
  const hint = $('tts-secret-hint');
  if (!hint) return;
  const saved = Boolean(state.config?.harness?.ttsApiKey);
  hint.textContent = saved ? '已保存密钥（不会回显）。' : '尚未保存密钥。';
}

// 生成接入方式切换：只显示当前方式需要的字段。
function syncGenMode() {
  const mode = document.querySelector('[data-config="harness.genMode"]')?.value || 'agnes';
  const standard = $('gen-standard'), custom = $('gen-custom');
  if (standard) standard.hidden = mode === 'custom';
  if (custom) custom.hidden = mode !== 'custom';
  const hint = $('gen-standard-hint');
  if (hint) {
    hint.innerHTML = mode === 'openai'
      ? '图片走 <code>{地址}/images/generations</code>，视频走 <code>{地址}/videos/generations</code>（服务不支持时自动改用 <code>/videos</code>）。Key 留空时沿用聊天模型的 Key。'
      : '内置技能自带异步任务轮询与字段兼容处理。Key 留空时沿用聊天模型的 Key —— <strong>聊天模型不是 Agnes 时请单独填写</strong>。';
  }
}
function updateBotName(name) {
  const element = $('top-bot-name');
  if (element) element.textContent = name || '未命名机器人';
}
function cell(row, className) {
  const td = node('td', undefined, className);
  row.append(td);
  return td;
}
function fieldInput(td, key, title, { type = 'text', value = '', options, required = false, maxLength, placeholder, rows = 3 } = {}) {
  let input;
  if (options) {
    input = node('select');
    for (const [optionValue, text] of options) {
      const option = node('option', text);
      option.value = optionValue;
      input.append(option);
    }
  } else if (type === 'textarea') {
    input = node('textarea');
    input.rows = rows;
  } else {
    input = node('input');
    input.type = type;
  }
  input.dataset.field = key;
  input.required = required;
  if (maxLength) input.maxLength = maxLength;
  if (placeholder) input.placeholder = placeholder;
  if (type !== 'checkbox') input.value = value;
  input.setAttribute('aria-label', title);
  td.append(input);
  return input;
}
function addCommand(command = { name: '', description: '', kind: 'text', response: '', enabled: true, adminOnly: false }) {
  const row = node('tr', undefined, 'editable-row');
  const name = fieldInput(cell(row), 'name', '命令名称', { value: command.name, required: true, maxLength: 50, placeholder: '不含 /' });
  name.pattern = '[^/\\s]+';
  fieldInput(cell(row), 'description', '帮助说明', { value: command.description, maxLength: 500, placeholder: '可选' });
  fieldInput(cell(row), 'kind', '回复类型', { value: command.kind, options: [['text', '固定文本'], ['llm', '模型指令']] });
  fieldInput(cell(row), 'response', '回复文本 / 模型指令', { type: 'textarea', value: command.response, required: true, maxLength: 12000, placeholder: '固定文本或本次命令的模型指令' });
  const enabled = fieldInput(cell(row), 'enabled', '启用', { type: 'checkbox' });
  enabled.checked = Boolean(command.enabled);
  const adminOnly = fieldInput(cell(row), 'adminOnly', '仅管理员', { type: 'checkbox' });
  adminOnly.checked = Boolean(command.adminOnly);
  const actions = cell(row, 'row-actions');
  removeRowButton(actions, row);
  $('command-rows').append(row);
  updateRowEmpty();
}
function addRule(rule = { keyword: '', match: 'contains', response: '', enabled: true }) {
  const row = node('tr', undefined, 'editable-row');
  fieldInput(cell(row), 'keyword', '关键词', { value: rule.keyword, required: true, maxLength: 500 });
  fieldInput(cell(row), 'match', '匹配方式', { value: rule.match, options: [['exact', '完全相等'], ['contains', '包含关键词'], ['prefix', '以关键词开头']] });
  fieldInput(cell(row), 'response', '回复文本', { value: rule.response, required: true, maxLength: 12000 });
  const enabled = fieldInput(cell(row), 'enabled', '启用', { type: 'checkbox' });
  enabled.checked = Boolean(rule.enabled);
  const actions = cell(row, 'row-actions');
  removeRowButton(actions, row);
  $('rule-rows').append(row);
  updateRowEmpty();
}
function removeRowButton(container, row) {
  const button = node('button', '删除', 'danger row-delete');
  button.type = 'button';
  button.setAttribute('aria-label', '删除这一行');
  button.addEventListener('click', () => { row.remove(); updateRowEmpty(); changed(); });
  container.append(button);
}
function updateRowEmpty() {
  const commands = $('command-rows').children.length;
  const rules = $('rule-rows').children.length;
  $('commands-empty').hidden = commands > 0;
  $('rules-empty').hidden = rules > 0;
  $('command-list').hidden = commands === 0;
  $('rule-list').hidden = rules === 0;
}
function gatherRows(id) {
  return all('.editable-row', $(id)).map((row) => Object.fromEntries(all('[data-field]', row).map((field) => [field.dataset.field, field.type === 'checkbox' ? field.checked : field.value])));
}
function gatherConfig() {
  const config = { qq: {}, bot: {}, llm: {}, harness: {}, commands: gatherRows('command-list'), rules: gatherRows('rule-list') };
  for (const field of configFields) {
    const [group, key] = field.dataset.config.split('.');
    config[group][key] = field.type === 'checkbox' ? field.checked : field.type === 'number' ? Number(field.value) : field.hasAttribute('data-list') ? field.value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean) : field.value;
  }
  config.qq.appSecret = $('clear-qq-secret').checked ? null : config.qq.appSecret;
  config.llm.apiKey = $('clear-llm-secret').checked ? null : config.llm.apiKey;
  // 生成密钥与模型密钥同样处理：留空表示保留服务器上已保存的值，只有勾选清除才覆盖为空。
  // null = 明确清除；空字符串 = 保留服务器上已保存的密钥。
  if ($('clear-gen-secret').checked) config.harness.genApiKey = null;
  else if (!config.harness.genApiKey) delete config.harness.genApiKey;
  if ($('clear-tts-secret').checked) config.harness.ttsApiKey = null;
  else if (!config.harness.ttsApiKey) delete config.harness.ttsApiKey;
  config.bot.autoReplyScenes = all('#reply-scenes input:checked').map((input) => input.value);
  return config;
}
function validateConfig() {
  for (const field of all('.config-card input, .config-card textarea, .config-card select')) {
    if (!field.checkValidity()) {
      showTab(field.closest('[data-panel]').dataset.panel);
      field.reportValidity();
      throw new Error('请先修正表单中标记的字段。');
    }
  }
  const config = gatherConfig();
  if (config.bot.minChars > config.bot.maxChars) {
    showTab('reply');
    throw new Error('目标最少字数不能超过每条最多字数。');
  }
  const names = config.commands.map((command) => command.name.trim());
  if (new Set(names).size !== names.length) { showTab('commands'); throw new Error('命令名称不能重复。'); }
  return config;
}
async function loadConfig() {
  const config = await api('/api/config');
  state.config = { ...config, llm: { ...llmDefaults, ...config.llm }, harness: { ...harnessDefaults, ...config.harness } };
  fillConfig(config);
  markSaved();
}
function requireSaved() {
  if (state.dirty) throw new Error('存在未保存设置。请先点击「保存配置」，或重新读取放弃改动，再进行凭据检查 / 启动。');
}
function renderStatus(status) {
  state.status = status;
  const labels = { stopped: '已停止', connecting: '连接中', resuming: '连接中', starting: '正在启动', reconnecting: '重新连接中', listening: '已连接', connected: '已连接', running: '已连接', ready: '已就绪', error: '连接异常', webhook: '等待回调' };
  const label = labels[status.state] || status.state || (status.running ? '已连接' : '已停止');
  const counts = `${status.stats?.received ?? 0} / ${status.stats?.sent ?? 0} / ${status.stats?.errors ?? 0}`;
  const badge = $('connection-status');
  badge.textContent = label;
  badge.className = 'badge';
  if (status.state === 'error') badge.classList.add('bad');
  else if (['connecting', 'resuming', 'starting', 'reconnecting'].includes(status.state)) badge.classList.add('warn');
  else if (status.running) badge.classList.add('ok');
  else badge.classList.add('idle');
  $('top-counts').textContent = counts;
  const pending = Number(status.pendingMessages || 0);
  $('top-pending').textContent = pending > 0 ? `${pending} 条待回复` : '—';
  $('status-state').textContent = label;
  $('status-counts').textContent = counts;
  const seconds = Math.max(0, Math.floor(Number(status.uptime || 0)));
  $('status-uptime').textContent = `${Math.floor(seconds / 3600)}时 ${Math.floor(seconds % 3600 / 60)}分 ${seconds % 60}秒`;
  $('status-event').textContent = date(status.lastEventAt);
  $('status-error').textContent = status.lastError ? (typeof status.lastError === 'string' ? status.lastError : json(status.lastError)) : '';
  $('status-identity').hidden = !status.identity;
  if (status.identity) $('status-identity').textContent = json(status.identity);
  syncControls();
}
async function loadStatus() {
  if (state.statusLoading) return;
  state.statusLoading = true;
  try { renderStatus(await api('/api/status')); }
  catch (error) {
    $('connection-status').textContent = '状态获取失败（非实时）';
    $('connection-status').classList.remove('online');
    throw error;
  } finally { state.statusLoading = false; }
}

function usageCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
function usageBlock(title, bucket) {
  const data = bucket && typeof bucket === 'object' ? bucket : {};
  const block = node('div', undefined, 'usage-block');
  block.append(node('h4', title), node('strong', String(usageCount(data.totalTokens)), 'usage-total'), node('span', '总 token', 'hint usage-unit'));
  const lines = [
    ['请求数', String(usageCount(data.requests))],
    ['prompt + completion', `${usageCount(data.promptTokens)} + ${usageCount(data.completionTokens)}`],
    ['工具调用', String(usageCount(data.toolCalls))],
    ['图片 / 视频 / 搜索 / 读网页', `${usageCount(data.images)} / ${usageCount(data.videos)} / ${usageCount(data.searches)} / ${usageCount(data.readUrls)}`],
  ];
  for (const [label, value] of lines) {
    const line = node('div', undefined, 'usage-line');
    line.append(node('span', label), node('strong', value));
    block.append(line);
  }
  return block;
}
function usageRow(cells) {
  const row = node('div', undefined, 'usage-row');
  cells.forEach((cell) => row.append(node('span', cell)));
  return row;
}
function usageTable(id, columns, entries) {
  const container = $(id);
  container.replaceChildren();
  const head = usageRow(columns);
  head.classList.add('usage-head');
  container.append(head);
  if (!entries.length) container.append(node('p', '暂无记录。', 'empty usage-none'));
  for (const entry of entries) container.append(entry);
}
function renderUsage(usage) {
  const data = usage && typeof usage === 'object' ? usage : {};
  $('usage-summary').replaceChildren(usageBlock('今日', data.today), usageBlock('本月', data.month), usageBlock('累计', data.all));
  const unknown = usageCount(data.unknownUsage);
  $('usage-unknown').hidden = unknown <= 0;
  $('usage-unknown').textContent = unknown > 0 ? `${unknown} 次请求未返回 usage，未能计入 token。` : '';
  $('usage-timezone').textContent = typeof data.timezone === 'string' && data.timezone ? `今日 / 本月按 ${data.timezone} 时区归集。` : '';
  usageTable('usage-models', ['模型', '请求', '总 token'], (Array.isArray(data.byModel) ? data.byModel : []).map((entry) => {
    const model = entry && typeof entry === 'object' ? entry : {};
    return usageRow([typeof model.model === 'string' && model.model ? model.model : '未命名模型', String(usageCount(model.requests)), String(usageCount(model.totalTokens))]);
  }));
  usageTable('usage-daily', ['日期', '请求', '总 token'], (Array.isArray(data.daily) ? data.daily : []).map((entry) => {
    const day = entry && typeof entry === 'object' ? entry : {};
    return usageRow([typeof day.day === 'string' && day.day ? day.day : '—', String(usageCount(day.requests)), String(usageCount(day.totalTokens))]);
  }));
}
async function loadUsage() {
  if (state.usageLoading) return;
  state.usageLoading = true;
  try { state.usage = await api('/api/usage'); renderUsage(state.usage); }
  finally { state.usageLoading = false; }
}

function renderConversations() {
  const search = $('memory-filter').value.toLowerCase();
  const entries = state.conversations.filter((entry) => [entry.key, entry.scene, entry.targetId, entry.userId, entry.label, entry.displayName, entry.userName, entry.targetName].join(' ').toLowerCase().includes(search));
  $('conversation-rows').replaceChildren();
  $('conversation-list').hidden = entries.length === 0;
  for (const entry of entries) {
    const row = node('tr', undefined, 'conversation');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.title = `会话键：${entry.key}`;
    row.classList.toggle('selected', entry.key === state.memoryKey);
    row.setAttribute('aria-disabled', String(state.memoryLoading));
    // 优先显示昵称；查不到时退回短 OpenID，避免整屏都是一串代码。
    const first = cell(row);
    first.append(node('strong', entry.displayName || entry.userId || '未知用户', 'cell-strong nowrap'));
    first.append(node('small', `${entry.sceneLabel || entry.scene} · ${entry.targetLabel || '—'}`, 'cell-muted nowrap'));
    cell(row).append(node('span', `${entry.count} 条`, 'cell-muted nowrap'));
    cell(row).append(node('span', shortDate(entry.lastAt), 'cell-muted nowrap'));
    const open = () => { if (!state.memoryLoading) selectConversation(entry).catch((error) => feedback(errorText(error), true)); };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    $('conversation-rows').append(row);
  }
  $('memory-empty').hidden = entries.length > 0;
  $('memory-empty').textContent = state.conversations.length ? '没有符合筛选条件的会话。' : '暂无会话。QQ 里收到消息后会自动出现在这里。';
}
async function loadConversations() {
  state.conversations = await api('/api/conversations');
  renderConversations();
}
async function selectConversation(entry) {
  if (state.memoryLoading) return;
  if (state.factsDirty && !confirm('长期事实尚未保存。切换会话并放弃改动？')) return;
  state.memoryLoading = true;
  renderConversations();
  syncControls();
  try {
    const detail = await api(`/api/conversations/${encodeURIComponent(entry.key)}`);
    state.memoryKey = entry.key;
    state.factsDirty = false;
    $('memory-title').textContent = `${entry.displayName || entry.userId || '未知用户'}${entry.sceneLabel ? ` · ${entry.sceneLabel}` : ''}`;
    $('memory-key').textContent = `会话键：${entry.key}\n用户：${entry.userLabel || entry.userId}\n目标：${entry.targetLabel || entry.targetId}`;
    $('memory-facts').value = detail.facts || '';
    $('facts-state').textContent = '长期事实已读取';
    $('memory-detail').hidden = false;
    $('memory-history').replaceChildren();
    for (const message of detail.messages) {
      const item = node('article', undefined, 'history-item');
      item.append(node('small', `${message.role} · 发送 ${date(message.meta?.sentAt || message.createdAt)} · 记录 ${date(message.createdAt)}`), node('p', message.content));
      presentMetadata(item, message.meta);
      $('memory-history').append(item);
    }
    if (!detail.messages.length) $('memory-history').append(node('p', '此会话暂无历史。', 'empty'));
  } finally { state.memoryLoading = false; renderConversations(); syncControls(); }
}
function resetMemoryDetail() {
  state.memoryKey = null; state.factsDirty = false;
  $('memory-detail').hidden = true;
  $('memory-title').textContent = '请选择一个会话';
  $('memory-key').textContent = '';
  syncControls();
}
async function loadLogs() {
  if (state.logsLoading) return;
  state.logsLoading = true;
  try { state.logs = await api('/api/logs?after=0'); renderLogs(); }
  finally { state.logsLoading = false; }
}
function renderLogs() {
  const opened = new Set(all('details[open]', $('log-list')).map((details) => details.dataset.logId));
  const scrollTop = $('log-list').scrollTop;
  const level = $('log-level').value;
  const search = $('log-search').value.toLowerCase();
  const entries = state.logs.filter((entry) => (!level || entry.level === level) && `${entry.message} ${json(entry.detail) || ''}`.toLowerCase().includes(search));
  $('log-list').replaceChildren();
  for (const entry of [...entries].reverse()) {
    const level = ['info', 'warn', 'error', 'debug'].includes(entry.level) ? entry.level : 'info';
    const item = node('article', undefined, 'log-entry');
    const line = node('div', undefined, 'log-line');
    line.append(node('span', level, `log-level ${level}`), node('span', date(entry.createdAt), 'log-time'), node('span', entry.message, 'log-message'));
    item.append(line);
    if (entry.detail !== undefined && entry.detail !== null) {
      const details = node('details');
      details.dataset.logId = String(entry.id);
      details.open = opened.has(String(entry.id));
      details.append(node('summary', '详细信息'), node('pre', typeof entry.detail === 'string' ? entry.detail : json(entry.detail), 'log-detail'));
      item.append(details);
    }
    $('log-list').append(item);
  }
  $('log-list').scrollTop = scrollTop;
  $('logs-empty').hidden = entries.length > 0;
  $('logs-empty').textContent = state.logs.length ? '没有符合筛选条件的日志。' : '暂无日志。';
}

function memeImage(id, name) {
  const image = node('img', undefined, 'asset-thumb');
  image.src = `/api/memes/${encodeURIComponent(id)}/image`;
  image.alt = name || '表情包';
  image.loading = 'lazy';
  image.addEventListener('error', () => { image.replaceWith(node('p', '图片暂不可用，请检查登录状态或图片来源。', 'hint')); }, { once: true });
  return image;
}
function safeMetadata(meta) {
  return JSON.parse(JSON.stringify(meta, (key, value) => {
    if (/token|secret|authorization|fileData/i.test(key)) return '[已隐藏]';
    if (key === 'url') return typeof value === 'string' && value.startsWith('data:') ? '[本地附件数据已隐藏]' : '[附件地址已隐藏]';
    return value;
  }));
}
function presentMetadata(item, meta) {
  if (!meta || typeof meta !== 'object' || !Object.keys(meta).length) return;
  const messages = Array.isArray(meta.messages) ? meta.messages : [];
  if (meta.memeId) item.append(memeImage(meta.memeId, meta.name));
  for (const message of messages) if (message.type === 'meme' && message.memeId) item.append(memeImage(message.memeId, message.name));
  for (const attachment of Array.isArray(meta.attachments) ? meta.attachments : []) {
    const title = `${attachment.filename || '附件'} · ${attachment.contentType || '未知格式'}${attachment.size ? ` · ${(attachment.size / 1024).toFixed(1)} KB` : ''}`;
    item.append(node('p', title, 'hint'));
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(attachment.url || '')) {
      const image = node('img', undefined, 'asset-thumb'); image.src = attachment.url; image.alt = attachment.filename || '本地图片'; item.append(image);
    }
  }
  if (meta.reference) {
    const reference = node('details');
    reference.append(node('summary', `引用上下文 · ${meta.reference.source || '来源未知'}`), node('pre', json(safeMetadata(meta.reference)), 'result'));
    item.append(reference);
  }
  const details = node('details');
  details.append(node('summary', '消息元数据 / 工具与记忆来源'), node('pre', json(safeMetadata(meta)), 'result'));
  item.append(details);
}
function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`无法读取文件 ${file.name}。`));
    reader.readAsDataURL(file);
  });
}
function attachmentMime(file) {
  if (fileMimes.includes(file.type)) return file.type;
  const extension = file.name.split('.').pop().toLowerCase();
  const types = { txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  return types[extension] || '';
}
function localDateTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const part = (number) => String(number).padStart(2, '0');
  return `${parsed.getFullYear()}-${part(parsed.getMonth() + 1)}-${part(parsed.getDate())}T${part(parsed.getHours())}:${part(parsed.getMinutes())}:${part(parsed.getSeconds())}`;
}
function taskOwner(task) { return task.owner || task; }
async function loadTasks() {
  if (state.tasksLoading || controls($('task-list')).some((element) => busyElements.has(element))) return;
  state.tasksLoading = true;
  try { state.tasks = await api('/api/tasks'); renderTasks(); }
  finally { state.tasksLoading = false; }
}
function taskButton(container, title, handler, danger = false) {
  const button = node('button', title, danger ? 'danger' : '');
  button.type = 'button';
  button.addEventListener('click', () => handler(button).catch((error) => feedback(errorText(error), true, 'task-feedback')));
  container.append(button);
}
function renderTasks() {
  $('task-rows').replaceChildren();
  const statuses = { pending: '等待', running: '执行中', done: '已完成', failed: '失败', cancelled: '已取消', paused: '已暂停' };
  for (const task of state.tasks) {
    const owner = taskOwner(task);
    const row = node('tr', undefined, 'data-row');
    const title = cell(row);
    title.append(node('strong', task.title), node('p', task.content, 'cell-text'));
    if (task.lastError) title.append(node('p', typeof task.lastError === 'string' ? task.lastError : json(task.lastError), 'error-text cell-text'));
    const details = node('details'); details.append(node('summary', `任务 ID：${task.id} / 完整详情`), node('pre', json(safeMetadata(task)), 'result')); title.append(details);
    const target = cell(row);
    target.append(node('span', owner.scene === 'preview' ? '本地 preview · 不发送 QQ' : `真实 QQ · ${owner.scene}`, 'cell-sub'));
    target.append(node('span', `目标 ${owner.targetId}`, 'cell-sub'));
    target.append(node('span', `所属用户 ${owner.userId}`, 'cell-sub'));
    const status = cell(row);
    status.append(node('span', statuses[task.status] || task.status || '等待', `tag tag-${task.status === 'failed' ? 'danger' : task.status === 'done' ? 'muted' : 'info'}`));
    status.append(node('span', `${task.enabled === false ? '未启用' : '启用'} · 来源 ${task.source || 'admin'} · 重复 ${task.intervalSeconds || 0} 秒`, 'cell-sub'));
    const timing = cell(row);
    timing.append(node('span', `下次：${date(task.nextAt || task.dueAt)}`, 'cell-sub'));
    timing.append(node('span', `上次：${date(task.lastRunAt)}`, 'cell-sub'));
    timing.append(node('span', `更新：${date(task.updatedAt)}`, 'cell-sub'));
    const actions = cell(row, 'row-actions');
    taskButton(actions, '编辑', async () => editTask(task));
    taskButton(actions, task.enabled === false ? '恢复' : '暂停', async () => {
      if (!confirm(`${task.enabled === false ? '恢复' : '暂停'}任务「${task.title}」？${owner.scene === 'preview' ? '仅影响本地提醒。' : '恢复后将按计划发送真实 QQ 消息。'}`)) return;
      await locked([...controls($('task-list')), $('refresh-tasks')], async () => {
        await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: { enabled: task.enabled === false } });
      });
      await loadTasks(); feedback('任务启用状态已更新。', false, 'task-feedback');
    });
    taskButton(actions, '立即执行', async () => {
      if (!confirm(`立即执行「${task.title}」？${owner.scene === 'preview' ? '仅写入本地 preview。' : `将向 ${owner.scene} / ${owner.targetId} 发送真实 QQ 消息（需在线及权限）。`}`)) return;
      await locked([...controls($('task-list')), $('refresh-tasks')], () => api(`/api/tasks/${encodeURIComponent(task.id)}/run`, { method: 'POST', body: {} }));
      await loadTasks(); feedback('已请求立即执行；请刷新查看实际投递状态。', false, 'task-feedback');
    });
    taskButton(actions, '删除', async () => {
      if (!confirm(`永久删除任务「${task.title}」？不可撤销。`)) return;
      await locked([...controls($('task-list')), $('refresh-tasks')], () => api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' }));
      if (state.taskEditId === task.id) resetTaskForm();
      await loadTasks(); feedback('任务已删除。', false, 'task-feedback');
    }, true);
    $('task-rows').append(row);
  }
  $('tasks-empty').hidden = state.tasks.length > 0;
  $('task-list').hidden = state.tasks.length === 0;
  $('tasks-empty').textContent = '暂无任务。可以手工创建，或在启用模型提醒后通过聊天创建。';
}
function resetTaskForm() {
  $('task-form').reset(); state.taskEditId = null; state.taskDirty = false;
  for (const id of ['task-scene', 'task-target', 'task-user']) $(id).disabled = false;
  $('task-form-title').textContent = '创建任务'; $('task-save').textContent = '创建任务';
  $('task-cancel').hidden = true;
}
function editTask(task) {
  if (controls($('task-form')).some((element) => busyElements.has(element))) return;
  if (state.taskDirty && !confirm('放弃尚未保存的任务编辑？')) return;
  const owner = taskOwner(task);
  state.taskEditId = task.id; state.taskDirty = false;
  $('task-title').value = task.title; $('task-content').value = task.content;
  $('task-scene').value = owner.scene; $('task-target').value = owner.targetId; $('task-user').value = owner.userId;
  $('task-due').value = localDateTime(task.nextAt || task.dueAt);
  $('task-interval').value = task.intervalSeconds || 0;
  for (const id of ['task-scene', 'task-target', 'task-user']) $(id).disabled = true;
  $('task-form-title').textContent = `编辑任务 · ${task.id}（所属场景 / 目标 / 用户不可更改）`;
  $('task-save').textContent = '保存任务';
  $('task-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
}
async function saveTask() {
  if (controls($('task-form')).some((element) => busyElements.has(element))) return;
  if (!$('task-form').reportValidity()) return;
  const intervalSeconds = Number($('task-interval').value);
  if (intervalSeconds !== 0 && intervalSeconds < 60) throw new Error('重复间隔须为 0（单次）或至少 60 秒。');
  const dueAt = new Date($('task-due').value);
  if (Number.isNaN(dueAt.getTime())) throw new Error('请选择有效执行时间。');
  const body = { title: $('task-title').value.trim(), content: $('task-content').value, dueAt: dueAt.toISOString(), intervalSeconds };
  const editing = state.taskEditId;
  const scene = $('task-scene').value;
  if (!editing) Object.assign(body, { scene, targetId: $('task-target').value.trim(), userId: $('task-user').value.trim() });
  if (!confirm(`${editing ? '保存' : '创建'}任务「${body.title}」？${scene === 'preview' ? '仅投递本地 preview。' : `此任务会向 ${scene} / ${$('task-target').value.trim()} 发送真实 QQ 提醒。`}`)) return;
  await locked([...controls($('task-form')), ...controls($('task-list'))], async () => {
    await api(editing ? `/api/tasks/${encodeURIComponent(editing)}` : '/api/tasks', { method: editing ? 'PATCH' : 'POST', body });
  });
  resetTaskForm(); await loadTasks(); feedback('任务已保存。请在列表查看状态；手工创建不依赖模型提醒开关。', false, 'task-feedback');
}
async function loadMemes() {
  if (state.memesLoading || controls($('meme-list')).some((element) => busyElements.has(element))) return;
  state.memesLoading = true;
  try { state.memes = await api('/api/memes'); renderMemes(); }
  finally { state.memesLoading = false; }
}
function renderMemes() {
  const list = $('meme-list');
  list.replaceChildren();
  for (const meme of state.memes) {
    const card = node('article', undefined, 'asset-card');
    const image = memeImage(meme.id, meme.name);
    image.classList.add('asset-thumb');
    card.append(image);
    const body = node('div', undefined, 'asset-body');
    body.append(node('h4', meme.name));
    const meta = node('p');
    meta.append(node('span', meme.enabled ? '已启用' : '已停用', `pill ${meme.enabled ? '' : 'muted'}`));
    body.append(meta);
    card.append(body);
    const actions = node('div', undefined, 'asset-actions');
    const add = (title, handler, danger = false) => {
      const button = node('button', title, `tiny${danger ? ' danger' : ''}`); button.type = 'button';
      button.addEventListener('click', () => handler().catch((error) => feedback(errorText(error), true, 'meme-feedback')));
      actions.append(button);
    };
    add('编辑', async () => {
      if (controls($('meme-form')).some((element) => busyElements.has(element))) return;
      if (state.memeDirty && !confirm('放弃尚未保存的表情包编辑？')) return;
      state.memeEditId = meme.id; state.memeDirty = false;
      $('meme-name').value = meme.name;
      $('meme-url').value = ''; $('meme-file').value = '';
      $('meme-form-title').textContent = `编辑表情 · ${meme.name}`; $('meme-save').textContent = '保存修改'; $('meme-cancel').hidden = false;
      $('meme-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    add(meme.enabled ? '停用' : '启用', async () => {
      if (!confirm(`${meme.enabled ? '停用' : '启用'}表情包「${meme.name}」？`)) return;
      await locked([...controls(list), $('refresh-memes')], () => api('/api/memes', { method: 'POST', body: { id: meme.id, name: meme.name, tags: meme.tags, enabled: !meme.enabled } }));
      await loadMemes(); feedback('表情包状态已更新。', false, 'meme-feedback');
    });
    add('删除', async () => {
      if (!confirm(`永久删除表情包「${meme.name}」？不可撤销。`)) return;
      await locked([...controls(list), $('refresh-memes')], () => api(`/api/memes/${encodeURIComponent(meme.id)}`, { method: 'DELETE' }));
      if (state.memeEditId === meme.id) resetMemeForm();
      await loadMemes(); feedback('表情包已删除。', false, 'meme-feedback');
    }, true);
    card.append(actions);
    list.append(card);
  }
  $('memes-empty').hidden = state.memes.length > 0;
  list.hidden = state.memes.length === 0;
  $('memes-empty').textContent = '暂无表情包。模型仍可直接用 Unicode emoji 表达情绪，不影响回复；添加并启用图片后会额外可选发送图片表情。';
}
function resetMemeForm() {
  $('meme-form').reset(); state.memeEditId = null; state.memeDirty = false;
  $('meme-form-title').textContent = '添加表情'; $('meme-save').textContent = '保存表情';
  $('meme-cancel').hidden = true;
}
async function saveMeme() {
  if (controls($('meme-form')).some((element) => busyElements.has(element))) return;
  if (!$('meme-form').reportValidity()) return;
  const id = state.memeEditId, url = $('meme-url').value.trim(), file = $('meme-file').files[0];
  if (url && file) throw new Error('图片 URL 与本地文件只能选择一个。');
  if (!id && !url && !file) throw new Error('请选择图片或填写公网 HTTPS URL。');
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('只允许无凭据的公网 HTTPS 图片 URL；服务端还会检查地址安全性。');
  }
  if (file && (!imageMimes.includes(file.type) || file.size > 2 * 1024 * 1024)) throw new Error('图片仅支持 PNG / JPEG / GIF / WebP，且不能超过 2 MB。');
  await locked([...controls($('meme-form')), ...controls($('meme-list'))], async () => {
    const body = { ...(id ? { id } : {}), name: $('meme-name').value.trim(), tags: [] };
    if (url) body.url = url;
    if (file) { body.fileData = (await readDataURL(file)).split(',')[1]; body.mime = file.type; }
    await api('/api/memes', { method: 'POST', body });
  });
  resetMemeForm(); await loadMemes(); feedback('表情包已保存。预览通过已登录的同源图片接口加载。', false, 'meme-feedback');
}

// ---------------------------------------------------------------- 资料库
// 每个资料夹 = 一个文件夹；DOC.md 说明什么时候该读它、里面大概有什么。
async function loadFolders() {
  if (state.foldersLoading) return;
  state.foldersLoading = true;
  try { state.folders = await api('/api/resources'); renderFolders(); }
  finally { state.foldersLoading = false; }
}
// 资料夹的折叠状态记在本地，刷新页面也不会丢。
const COLLAPSE_KEY = 'qqbot.collapsedFolders';
function loadCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}
function saveCollapsed(set) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* 隐私模式下写不了就算了 */ }
}
function folderIcon() {
  const icon = node('span', undefined, 'folder-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '▤';
  return icon;
}
function renderFolders() {
  const list = $('folder-list');
  list.replaceChildren();
  const collapsed = loadCollapsed();
  for (const folder of state.folders) {
    const card = node('article', undefined, 'folder-card');
    card.dataset.folderId = folder.id;
    const head = node('div', undefined, 'folder-head');
    const body = node('div', undefined, 'folder-body');
    const isCollapsed = collapsed.has(folder.id);
    card.dataset.collapsed = isCollapsed ? 'true' : 'false';
    const toggle = node('button', undefined, 'folder-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    toggle.title = isCollapsed ? '展开这个资料夹' : '折叠这个资料夹';
    toggle.append(node('span', undefined, 'folder-caret'));
    toggle.addEventListener('click', () => {
      const nowCollapsed = card.dataset.collapsed !== 'true';
      card.dataset.collapsed = nowCollapsed ? 'true' : 'false';
      toggle.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
      toggle.title = nowCollapsed ? '展开这个资料夹' : '折叠这个资料夹';
      body.hidden = nowCollapsed;
      const saved = loadCollapsed();
      if (nowCollapsed) saved.add(folder.id); else saved.delete(folder.id);
      saveCollapsed(saved);
      // 展开时才去拉文件列表，折叠着就不浪费请求。
      if (!nowCollapsed && !body.dataset.loaded) {
        body.dataset.loaded = '1';
        listFolderFiles(folder.id, fileList).catch((error) => feedback(errorText(error), true, 'folder-feedback'));
      }
    });
    head.append(toggle);
    head.append(folderIcon());
    const titles = node('div', undefined, 'folder-titles');
    titles.append(node('h4', folder.name));
    const subtitle = node('span', undefined, 'folder-count');
    subtitle.append(document.createTextNode(`${folder.fileCount} 个文件`));
    if (folder.trigger) subtitle.append(document.createTextNode(` · ${folder.trigger}`));
    titles.append(subtitle);
    head.append(titles);
    const actions = node('div', undefined, 'folder-actions');
    const add = (title, handler, danger = false) => {
      const button = node('button', title, `tiny${danger ? ' danger' : ''}`); button.type = 'button';
      button.addEventListener('click', () => handler().catch((error) => feedback(errorText(error), true, 'folder-feedback')));
      actions.append(button);
    };
    add('编辑', async () => {
      if (state.folderDirty && !confirm('放弃尚未保存的资料夹编辑？')) return;
      state.folderEditId = folder.id; state.folderDirty = false;
      $('folder-name').value = folder.name;
      $('folder-trigger').value = folder.trigger || '';
      $('folder-summary').value = folder.summary || '';
      $('folder-form-title').textContent = `编辑资料夹 · ${folder.name}`;
      $('folder-save').textContent = '保存修改';
      $('folder-cancel').hidden = false;
      $('folder-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    add('删除', async () => {
      if (!confirm(`删除资料夹「${folder.name}」及其中的所有文件？不可撤销。`)) return;
      await locked([...controls(list), $('refresh-resources')], () => api(`/api/resources/${encodeURIComponent(folder.id)}`, { method: 'DELETE' }));
      if (state.folderEditId === folder.id) resetFolderForm();
      await loadFolders(); feedback('资料夹已删除。', false, 'folder-feedback');
    }, true);
    head.append(actions);
    card.append(head);

    const doc = node('div', undefined, 'folder-doc');
    const triggerLine = node('p');
    triggerLine.append(node('strong', '触发内容：'), document.createTextNode(folder.trigger || '（未填写，模型可能不会主动读它）'));
    doc.append(triggerLine);
    const summaryLine = node('p');
    summaryLine.append(node('strong', '内容概述：'), document.createTextNode(folder.summary || '（未填写）'));
    doc.append(summaryLine);
    body.append(doc);

    const files = node('div', undefined, 'folder-files');
    files.append(node('span', '文件', 'folder-files-label'));
    body.append(files);
    const fileRow = node('div', undefined, 'folder-file-row');
    const picker = node('label', undefined, 'file-picker');
    const input = node('input'); input.type = 'file'; input.multiple = true;
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,application/json,text/csv,.txt,.md,.csv,.json,.pdf,.png,.jpg,.jpeg,.gif,.webp';
    input.addEventListener('change', async () => {
      const files = [...input.files];
      if (!files.length) return;
      await locked([input], async () => {
        const body = { files: [] };
        for (const file of files) {
          body.files.push({ name: file.name, contentType: file.type || '', data: (await readDataURL(file)).split(',')[1] });
        }
        const result = await api(`/api/resources/${encodeURIComponent(folder.id)}/files`, { method: 'POST', body });
        const failed = (result.errors || []).join('；');
        feedback(result.count > 1 ? `已加入 ${result.count} 个文件${failed ? `；${failed}` : ''}。` : `已加入 ${result.count} 个文件${failed ? `：${failed}` : ''}。`, !result.count, 'folder-feedback');
      });
      input.value = '';
      await loadFolders();
    });
    picker.append(input, node('span', '＋ 添加文件', 'file-picker-button'));
    fileRow.append(picker);
    body.append(fileRow);

    const fileList = node('ul', undefined, 'folder-file-list');
    body.append(fileList);
    body.hidden = isCollapsed;
    card.append(body);
    list.append(card);
    if (!isCollapsed) {
      body.dataset.loaded = '1';
      listFolderFiles(folder.id, fileList).catch((error) => feedback(errorText(error), true, 'folder-feedback'));
    }
  }
  $('folders-empty').hidden = state.folders.length > 0;
  list.hidden = state.folders.length === 0;
  $('folders-empty').textContent = '还没有资料夹。建一个文件夹，写清楚什么时候该读它，再把资料放进去。';
  // 按钮文案跟着实际状态走：全展开时说「全部折叠」，有折叠的就说「全部展开」。
  const cards = [...all('.folder-card', list)];
  const allCollapsed = cards.length > 0 && cards.every((card) => card.dataset.collapsed === 'true');
  $('toggle-all-folders').textContent = allCollapsed ? '全部展开' : '全部折叠';
  $('toggle-all-folders').disabled = cards.length === 0;
}
async function listFolderFiles(folderId, container) {
  const detail = await api(`/api/resources/${encodeURIComponent(folderId)}`);
  container.replaceChildren();
  for (const file of detail.files || []) {
    const item = node('li', undefined, 'folder-file');
    const label = node('span');
    label.append(node('strong', file.name));
    label.append(node('span', ` · ${file.kind === 'image' ? '图片' : file.kind === 'pdf' ? 'PDF' : '文本'} · ${file.chars || 0} 字`, 'cell-muted'));
    item.append(label);
    if (file.description) item.append(node('small', file.description, 'file-desc'));
    else item.append(node('small', '还没有说明', 'file-desc'));
    const remove = node('button', '删除', 'tiny danger'); remove.type = 'button';
    remove.addEventListener('click', () => locked([remove], async () => {
      await api(`/api/resources/${encodeURIComponent(folderId)}/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
      feedback(`已删除 ${file.name}。`, false, 'folder-feedback');
      await loadFolders();
    }).catch((error) => feedback(errorText(error), true, 'folder-feedback')));
    item.append(remove);
    container.append(item);
  }
  if (!container.children.length) container.append(node('li', '这个资料夹还是空的。', 'cell-muted'));
}
function resetFolderForm() {
  $('folder-form').reset();
  state.folderEditId = null; state.folderDirty = false;
  $('folder-form-title').textContent = '新建资料夹';
  $('folder-save').textContent = '保存资料夹';
  $('folder-cancel').hidden = true;
}
async function saveFolder() {
  if (!$('folder-form').reportValidity()) return;
  const name = $('folder-name').value.trim();
  const trigger = $('folder-trigger').value.trim();
  const summary = $('folder-summary').value.trim();
  if (!name) throw new Error('资料夹名称不能为空。');
  if (!trigger) throw new Error('请写清楚「触发内容」：什么情况下该读这个文件夹。');
  await locked(controls($('folder-form')), async () => {
    await api('/api/resources', { method: 'POST', body: { ...(state.folderEditId ? { id: state.folderEditId } : {}), name, trigger, summary } });
  });
  resetFolderForm();
  await loadFolders();
  feedback('资料夹已保存。命中触发条件时，程序会提示模型去读它。', false, 'folder-feedback');
}

for (const [form, key] of [['task-form', 'taskDirty'], ['meme-form', 'memeDirty'], ['folder-form', 'folderDirty']]) $(form).addEventListener('input', () => { state[key] = true; });
// 资源库批量上传：文件选择 + 拖拽放入，两种入口都走同一个多选控件。
$('task-form').addEventListener('submit', (event) => { event.preventDefault(); saveTask().catch((error) => feedback(errorText(error), true, 'task-feedback')); });
$('meme-form').addEventListener('submit', (event) => { event.preventDefault(); saveMeme().catch((error) => feedback(errorText(error), true, 'meme-feedback')); });
$('folder-form').addEventListener('submit', (event) => { event.preventDefault(); saveFolder().catch((error) => feedback(errorText(error), true, 'folder-feedback')); });
$('task-cancel').addEventListener('click', () => { if (!state.taskDirty || confirm('放弃尚未保存的任务编辑？')) resetTaskForm(); });
$('task-new').addEventListener('click', () => { resetTaskForm(); $('task-title').focus(); });
$('meme-cancel').addEventListener('click', () => { if (!state.memeDirty || confirm('放弃尚未保存的表情编辑？')) resetMemeForm(); });
$('meme-new').addEventListener('click', () => { resetMemeForm(); $('meme-name').focus(); });
$('folder-cancel').addEventListener('click', () => { if (!state.folderDirty || confirm('放弃尚未保存的资料夹编辑？')) resetFolderForm(); });
$('folder-new').addEventListener('click', () => { resetFolderForm(); $('folder-name').focus(); });
$('refresh-tasks').addEventListener('click', () => locked([$('refresh-tasks')], loadTasks).catch((error) => feedback(errorText(error), true, 'task-feedback')));
$('refresh-memes').addEventListener('click', () => locked([$('refresh-memes')], loadMemes).catch((error) => feedback(errorText(error), true, 'meme-feedback')));
$('refresh-resources').addEventListener('click', () => locked([$('refresh-resources')], loadFolders).catch((error) => feedback(errorText(error), true, 'folder-feedback')));

for (const button of all('[data-tab]')) button.addEventListener('click', () => showTab(button.dataset.tab));
for (const card of all('.config-card')) {
  card.addEventListener('input', changed);
  card.addEventListener('change', changed);
}
document.querySelector('[data-config="qq.intents"]').addEventListener('input', syncIntents);
for (const checkbox of all('[data-intent]')) checkbox.addEventListener('change', () => {
  const input = document.querySelector('[data-config="qq.intents"]');
  const bits = Number(input.value);
  if (!Number.isSafeInteger(bits) || bits < 0 || bits > 4294967295) { feedback('请先输入有效 intents 整数。', true); syncIntents(); return; }
  const bit = Number(checkbox.dataset.intent);
  const present = Math.floor(bits / bit) % 2 === 1;
  input.value = bits + (checkbox.checked && !present ? bit : !checkbox.checked && present ? -bit : 0);
  changed();
});
for (const [clearId, selector] of [['clear-qq-secret', '[data-config="qq.appSecret"]'], ['clear-llm-secret', '[data-config="llm.apiKey"]'], ['clear-gen-secret', '[data-config="harness.genApiKey"]'], ['clear-tts-secret', '[data-config="harness.ttsApiKey"]']]) {
  $(clearId).addEventListener('change', () => {
    if ($(clearId).checked) { document.querySelector(selector).value = ''; feedback('已标记清除密钥。仅在保存配置后生效。'); }
  });
  document.querySelector(selector).addEventListener('input', () => { if (document.querySelector(selector).value) $(clearId).checked = false; });
}
$('add-command').addEventListener('click', () => { addCommand(); changed(); });
$('add-rule').addEventListener('click', () => { addRule(); changed(); });
$('save-config').addEventListener('click', async () => {
  try {
    const config = validateConfig();
    if ((config.qq.appSecret === null || config.llm.apiKey === null || $('clear-gen-secret').checked || $('clear-tts-secret').checked) && !confirm('本次保存将清除勾选的密钥。确定继续？')) return;
    await locked(configControls(), async () => {
      const saved = await api('/api/config', { method: 'PUT', body: config });
      if (saved?.qq && saved?.bot && saved?.llm) { state.config = saved; fillConfig(saved); markSaved(); }
      else await loadConfig();
    });
    feedback('配置已保存。试聊和后续回复将使用已保存设置。');
  } catch (error) { feedback(errorText(error), true); }
});
$('reload-config').addEventListener('click', async () => {
  if (state.dirty && !confirm('重新读取将放弃所有未保存改动，确定继续？')) return;
  try { await locked(configControls(), loadConfig); feedback('已重新读取配置。'); }
  catch (error) { feedback(errorText(error), true); }
});
$('export-config').addEventListener('click', async () => {
  try {
    await locked([$('export-config')], async () => {
      const config = await api('/api/export');
      const url = URL.createObjectURL(new Blob([json(config)], { type: 'application/json' }));
      const anchor = node('a'); anchor.href = url; anchor.download = 'qqbot-config.json'; document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      feedback('已导出服务器保存的配置，不含密钥或记忆。未保存改动不会导出。');
    });
  } catch (error) { feedback(errorText(error), true); }
});
$('import-config').addEventListener('click', () => {
  if (state.dirty && !confirm('导入会替换当前未保存的表单改动，确定继续？')) return;
  $('import-file').click();
});
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0];
  if (!file) return;
  try {
    await locked(configControls(), async () => {
      if (state.status?.running) throw new Error('导入包含 QQ 接入设置，请先停止机器人。');
      if (file.size > 2 * 1024 * 1024) throw new Error('配置文件不能超过 2 MB。');
      const config = JSON.parse(await file.text());
      if (!config || !Array.isArray(config.commands) || !Array.isArray(config.rules)) throw new Error('配置文件缺少命令或规则数组。');
      config.harness = { ...harnessDefaults, ...config.harness };
      config.llm = { ...config.llm, apiFormat: config.llm?.apiFormat ?? llmDefaults.apiFormat };
      for (const field of configFields) {
        const [group, key] = field.dataset.config.split('.');
        const value = config[group]?.[key];
        const secret = key === 'appSecret' || key === 'apiKey' || key === 'genApiKey';
        if (value === undefined || (!secret && value === null)) throw new Error(`配置文件缺少字段 ${group}.${key}。请使用完整导出文件。`);
        if (field.hasAttribute('data-list') && (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))) throw new Error(`${group}.${key} 必须是 ID 字符串数组。`);
        if (field.type === 'checkbox' && typeof value !== 'boolean') throw new Error(`${group}.${key} 必须是布尔值。`);
        if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${group}.${key} 必须是数字。`);
        if (!field.hasAttribute('data-list') && !['checkbox', 'number'].includes(field.type) && !(secret && value === null) && typeof value !== 'string') throw new Error(`${group}.${key} 必须是字符串。`);
        if (field.tagName === 'SELECT' && ![...field.options].some((option) => option.value === value)) throw new Error(`${group}.${key} 包含不支持的选项。`);
      }
      if (!Array.isArray(config.bot.autoReplyScenes) || config.bot.autoReplyScenes.some((scene) => !['c2c', 'group', 'channel', 'dm'].includes(scene))) throw new Error('自动回复场景无效。');
      for (const command of config.commands) {
        if (!command || ['name', 'description', 'response'].some((key) => typeof command[key] !== 'string') || !['text', 'llm'].includes(command.kind) || typeof command.enabled !== 'boolean' || typeof command.adminOnly !== 'boolean') throw new Error('命令数组格式不正确。');
      }
      for (const rule of config.rules) {
        if (!rule || typeof rule.keyword !== 'string' || typeof rule.response !== 'string' || !['exact', 'contains', 'prefix'].includes(rule.match) || typeof rule.enabled !== 'boolean') throw new Error('规则数组格式不正确。');
      }
      fillConfig(config); changed();
      feedback('配置已导入表单，尚未保存。空密钥保留服务器现有凭据；请检查所有设置后点击「保存配置」。');
    });
  } catch (error) { feedback(`导入失败：${errorText(error)}`, true); }
  finally { $('import-file').value = ''; }
});
for (const [id, action] of [['start-bot', 'start'], ['stop-bot', 'stop'], ['check-bot', 'check']]) {
  $(id).addEventListener('click', async () => {
    try {
      if (action !== 'stop') requireSaved();
      await locked(['start-bot', 'stop-bot', 'check-bot'].map($), async () => {
        const data = await api(`/api/bot/${action}`, { method: 'POST', body: {} });
        if (action === 'check') { result('status-identity', data); feedback('凭据检查通过；能否收发消息仍取决于场景权限与平台接入配置。'); }
        else { renderStatus(data); feedback(action === 'start' ? '启动请求已完成，请查看实际状态与日志；Webhook 还需公网回调。' : '机器人已停止。'); }
      });
    } catch (error) { feedback(errorText(error), true); $('status-error').textContent = errorText(error); }
  });
}
$('refresh-status').addEventListener('click', async () => {
  try { await locked([$('refresh-status')], loadStatus); feedback('已刷新状态。'); }
  catch (error) { feedback(errorText(error), true); }
});
$('refresh-usage').addEventListener('click', async () => {
  try {
    await locked([$('refresh-usage')], loadUsage);
    feedback('已刷新 Token 用量。', false, 'usage-feedback');
  } catch (error) { feedback(errorText(error), true, 'usage-feedback'); }
});
$('reset-usage').addEventListener('click', async () => {
  if (!confirm('清空全部 Token 用量统计？此操作只删除本机统计记录，不可撤销。')) return;
  try {
    await locked([$('reset-usage'), $('refresh-usage')], async () => {
      await api('/api/usage', { method: 'DELETE' });
      await loadUsage();
    });
    feedback('用量统计已重置。', false, 'usage-feedback');
  } catch (error) { feedback(errorText(error), true, 'usage-feedback'); }
});
$('test-chat').addEventListener('click', async () => {
  const output = $('test-chat-result');
  output.textContent = '正在测试…';
  try {
    const result = await locked([$('test-chat')], () => api('/api/models/test', { method: 'POST', body: { kind: 'chat' } }));
    output.textContent = `✅ 连接正常 · ${result.model} · ${result.latencyMs} ms${result.reply ? ` · 回复「${result.reply}」` : ''}${result.thinkingChars ? ` · 思考 ${result.thinkingChars} 字` : ''}`;
    output.classList.remove('error-text');
    if (result.notes?.length) {
      const note = document.createElement('div');
      note.className = 'hint';
      note.style.marginTop = '6px';
      note.textContent = result.notes.join(' ');
      output.parentElement?.appendChild(note);
    }
  } catch (error) {
    output.textContent = `❌ ${errorText(error)}`;
    output.classList.add('error-text');
  }
});
for (const [id, kind] of [['test-image', 'image'], ['test-video', 'video']]) {
  $(id).addEventListener('click', async () => {
    const output = $('test-gen-result');
    output.textContent = kind === 'video' ? '正在测试生视频（可能要几分钟）…' : '正在测试生图…';
    try {
      const result = await locked([$(id)], () => api('/api/models/test', { method: 'POST', body: { kind } }));
      output.textContent = `✅ ${kind === 'video' ? '生视频' : '生图'}正常 · ${result.model} · ${result.latencyMs} ms`;
      output.classList.remove('error-text');
    } catch (error) {
      output.textContent = `❌ ${errorText(error)}`;
      output.classList.add('error-text');
    }
  });
}
document.querySelector('[data-config="harness.genMode"]')?.addEventListener('change', syncGenMode);
document.querySelector('[data-config="harness.ttsMode"]')?.addEventListener('change', syncTtsMode);
document.querySelector('[data-config="harness.ttsApiFormat"]')?.addEventListener('change', syncTtsMode);
$('clear-tts-secret').addEventListener('change', () => {
  if ($('clear-tts-secret').checked) $('tts-secret-hint').textContent = '保存后会清除已保存的语音密钥。';
  else syncTtsSecretHint();
});
$('test-voice').addEventListener('click', async () => {
  const output = $('test-voice-result');
  output.textContent = '正在合成…';
  try {
    const result = await locked([$('test-voice')], () => api('/api/tts/preview', { method: 'POST', body: { text: '你好，这是语音合成的连通性测试。' } }));
    output.textContent = `✅ 合成正常 · ${result.format} · ${(result.bytes / 1024).toFixed(1)} KB${result.durationSec ? ` · 约 ${result.durationSec} 秒` : ''} · 来源 ${result.source === 'windows' ? 'Windows 系统语音' : '合成接口'}`;
    output.classList.remove('error-text');
  } catch (error) {
    output.textContent = `❌ ${errorText(error)}`;
    output.classList.add('error-text');
  }
});
$('tts-preset').addEventListener('change', () => {
  const name = $('tts-preset').value;
  if (name) applyTtsPreset(name);
  else syncTtsMode();
});
$('load-service-voices').addEventListener('click', async () => {
  const output = $('test-voice-result');
  output.textContent = '正在读取服务音色…';
  try {
    const result = await locked([$('load-service-voices')], () => api('/api/tts/service-voices', { method: 'POST', body: {} }));
    if (!result.ok) { output.textContent = `❌ ${result.error}`; output.classList.add('error-text'); return; }
    const voices = result.voices || [];
    if (!voices.length) { output.textContent = '这个账号下还没有可用音色。'; output.classList.remove('error-text'); return; }
    // 用原生 select 承载，方便用户直接挑选。
    const voiceField = document.querySelector('[data-config="harness.ttsVoice"]');
    let select = $('tts-service-voice-select');
    if (!select) {
      select = document.createElement('select');
      select.id = 'tts-service-voice-select';
      select.className = 'inline-select';
      const host = voiceField?.closest('label');
      if (host) host.append(select);
      select.addEventListener('change', () => {
        if (voiceField) { voiceField.value = select.value; changed(); }
      });
    }
    select.replaceChildren();
    for (const voice of voices) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = `${voice.group} · ${voice.name}`;
      select.append(option);
    }
    const current = voiceField ? voiceField.value : '';
    if (current && [...select.options].some((option) => option.value === current)) select.value = current;
    output.textContent = `✅ 找到 ${voices.length} 个音色，已列在「音色 ID」下面。`;
    output.classList.remove('error-text');
  } catch (error) {
    output.textContent = `❌ ${errorText(error)}`;
    output.classList.add('error-text');
  }
});
$('toggle-all-folders').addEventListener('click', () => {
  const cards = [...all('.folder-card', $('folder-list'))];
  if (!cards.length) return;
  // 只要还有一个展开的，就全部折叠；否则全部展开。
  const shouldCollapse = cards.some((card) => card.dataset.collapsed !== 'true');
  const saved = loadCollapsed();
  for (const card of cards) {
    const id = card.dataset.folderId;
    const toggle = card.querySelector('.folder-toggle');
    const body = card.querySelector('.folder-body');
    card.dataset.collapsed = shouldCollapse ? 'true' : 'false';
    if (toggle) toggle.setAttribute('aria-expanded', shouldCollapse ? 'false' : 'true');
    if (body) body.hidden = shouldCollapse;
    if (!shouldCollapse && id && !body?.dataset.loaded) {
      body.dataset.loaded = '1';
      listFolderFiles(id, body.querySelector('.folder-file-list')).catch((error) => feedback(errorText(error), true, 'folder-feedback'));
    }
    if (id) { if (shouldCollapse) saved.add(id); else saved.delete(id); }
  }
  saveCollapsed(saved);
  $('toggle-all-folders').textContent = shouldCollapse ? '全部展开' : '全部折叠';
});
$('load-voices').addEventListener('click', async () => {
  const output = $('voice-list-feedback');
  output.textContent = '正在读取系统音色…';
  try {
    const result = await locked([$('load-voices')], () => api('/api/tts/voices'));
    if (!result.ok) { output.textContent = `❌ ${result.error}`; output.classList.add('error-text'); return; }
    const select = $('tts-voice-select');
    const current = document.querySelector('[data-config="harness.ttsWindowsVoice"]')?.value || '';
    select.replaceChildren();
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = '（未选择，使用系统默认）';
    select.append(blank);
    for (const voice of result.voices || []) {
      const option = document.createElement('option');
      option.value = voice.name;
      option.textContent = voice.culture ? `${voice.name}（${voice.culture}）` : voice.name;
      select.append(option);
    }
    select.value = current;
    if (current && !select.value) {
      const option = document.createElement('option');
      option.value = current; option.textContent = `${current}（手填）`;
      select.append(option); select.value = current;
    }
    output.textContent = `✅ 找到 ${result.voices.length} 个系统音色。`;
    output.classList.remove('error-text');
  } catch (error) {
    output.textContent = `❌ ${errorText(error)}`;
    output.classList.add('error-text');
  }
});
$('tts-voice-select').addEventListener('change', () => {
  const field = document.querySelector('[data-config="harness.ttsWindowsVoice"]');
  if (field) { field.value = $('tts-voice-select').value; changed(); }
});
$('refresh-memory').addEventListener('click', async () => {
  try { await locked([$('refresh-memory')], loadConversations); feedback('已刷新会话列表，未改动当前事实编辑。'); }
  catch (error) { feedback(errorText(error), true); }
});
$('memory-filter').addEventListener('input', renderConversations);
$('memory-facts').addEventListener('input', () => { state.factsDirty = true; $('facts-state').textContent = '长期事实有未保存改动'; });
$('save-facts').addEventListener('click', async () => {
  if (!state.memoryKey || state.memoryLoading) return;
  const key = state.memoryKey;
  state.memoryLoading = true; renderConversations(); syncControls();
  try {
    await locked([...controls($('memory-detail')), ...all('.conversation')], async () => {
      await api(`/api/conversations/${encodeURIComponent(key)}`, { method: 'PUT', body: { facts: $('memory-facts').value } });
      state.factsDirty = false; $('facts-state').textContent = '长期事实已保存'; await loadConversations();
    });
    feedback('长期事实已保存。');
  } catch (error) { feedback(errorText(error), true); }
  finally { state.memoryLoading = false; renderConversations(); syncControls(); }
});
$('consolidate-facts').addEventListener('click', async () => {
  if (!state.memoryKey || state.memoryLoading) return;
  if (!confirm('让模型阅读现有长期事实，合并重复与过时条目后整体重写？请先在文本框中保存你的手动修改。')) return;
  const key = state.memoryKey;
  state.memoryLoading = true; renderConversations(); syncControls();
  try {
    await locked([...controls($('memory-detail')), ...all('.conversation')], async () => {
      const result = await api(`/api/conversations/${encodeURIComponent(key)}/consolidate`, { method: 'POST', body: {} });
      state.factsDirty = false;
      $('facts-state').textContent = `已整理：${result.before} 行 → ${result.after} 行`;
      await loadConversations();
      await selectConversation(state.conversations.find((item) => item.key === key) || { key });
    });
    feedback('已让模型整理长期事实。');
  } catch (error) { feedback(errorText(error), true); }
  finally { state.memoryLoading = false; renderConversations(); syncControls(); }
});
$('rename-session').addEventListener('click', async () => {
  const entry = state.conversations.find((item) => item.key === state.memoryKey);
  if (!entry) return;
  const label = prompt('给这个会话起个名字（留空清除）：', entry.label || entry.displayName || '');
  if (label === null) return;
  try {
    await locked([$('rename-session')], () => api(`/api/conversations/${encodeURIComponent(state.memoryKey)}`, { method: 'PATCH', body: { label } }));
    await loadConversations();
    await selectConversation(state.conversations.find((item) => item.key === state.memoryKey) || entry);
    feedback(label.trim() ? '会话已重命名。' : '会话名称已清除。');
  } catch (error) { feedback(errorText(error), true); }
});
$('export-session').addEventListener('click', async () => {
  if (!state.memoryKey) return;
  try {
    const detail = await api(`/api/conversations/${encodeURIComponent(state.memoryKey)}`);
    const entry = state.conversations.find((item) => item.key === state.memoryKey) || {};
    const payload = { name: entry.label || entry.displayName || state.memoryKey, scene: entry.scene, facts: detail.facts, messages: detail.messages.map((m) => ({ role: m.role, content: m.content, at: m.createdAt })) };
    const url = URL.createObjectURL(new Blob([json(payload)], { type: 'application/json' }));
    const anchor = node('a'); anchor.href = url; anchor.download = `${(payload.name || 'session').replace(/[\\/:*?"<>|]/g, '_')}.json`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    feedback('会话已导出。');
  } catch (error) { feedback(errorText(error), true); }
});
$('delete-memory').addEventListener('click', async () => {
  if (!state.memoryKey || state.memoryLoading || !confirm('永久删除此会话的全部历史和长期事实？此操作不可撤销。')) return;
  const key = state.memoryKey;
  state.memoryLoading = true; renderConversations(); syncControls();
  try {
    await locked([...controls($('memory-detail')), ...all('.conversation')], async () => {
      await api(`/api/conversations/${encodeURIComponent(key)}`, { method: 'DELETE' });
      resetMemoryDetail();
      await loadConversations();
    });
    feedback('会话历史和长期事实已删除。');
  } catch (error) { feedback(errorText(error), true); }
  finally { state.memoryLoading = false; renderConversations(); syncControls(); }
});
// ---- 数据文件 ----
const fmtBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
};
const FILE_LABELS = {
  'qqbot.sqlite': '主数据库：配置、会话、消息、资料库、表情包、提醒、日志、用量',
  'qqbot.sqlite-wal': '预写日志（数据库的临时写入缓冲）',
  'qqbot.sqlite-shm': '共享内存索引',
  'master.key': '密钥种子：用来加密 API Key 等敏感配置，丢了就解不开',
  'instance.lock': '运行锁：标记机器人正在运行，防止开两个',
};
async function loadStorage() {
  const data = await api('/api/storage');
  $('storage-dir').textContent = data.dataDir || '—';
  $('storage-total').textContent = fmtBytes(data.totalBytes);
  const files = $('storage-files');
  files.replaceChildren();
  for (const entry of data.entries || []) {
    const row = node('div', undefined, 'file-row');
    const main = node('div', undefined, 'file-main');
    main.append(node('strong', entry.name, 'file-name'));
    const desc = FILE_LABELS[entry.name];
    if (desc) main.append(node('small', desc, 'file-desc'));
    row.append(main, node('span', fmtBytes(entry.size), 'file-size'));
    files.append(row);
  }
  const tables = $('storage-tables');
  tables.replaceChildren();
  for (const [name, count] of Object.entries(data.counts || {})) {
    tables.append(node('span', `${name} ${count ?? '—'}`, 'tag'));
  }
}
async function loadVersion() {
  try {
    const info = await api('/api/version');
    $('app-version').textContent = `${info.name || 'easy-qqbot-harness'} v${info.version || '?'}`;
  } catch { /* 版本显示不出来也不影响用 */ }
}
$('refresh-storage').addEventListener('click', async () => {
  try { await locked([$('refresh-storage')], loadStorage); }
  catch (error) { feedback(errorText(error), true); }
});
$('log-level').addEventListener('change', renderLogs);
$('log-search').addEventListener('input', renderLogs);
$('refresh-logs').addEventListener('click', async () => {
  try { await locked([$('refresh-logs')], loadLogs); }
  catch (error) { feedback(errorText(error), true); }
});
$('clear-logs').addEventListener('click', async () => {
  if (!confirm('清空服务器运行日志？此操作不可撤销。')) return;
  try {
    await locked([$('clear-logs'), $('refresh-logs')], async () => { await api('/api/logs', { method: 'DELETE' }); await loadLogs(); });
    feedback('运行日志已清空。');
  } catch (error) { feedback(errorText(error), true); }
});
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await locked(controls($('login-form')), async () => {
      await api('/api/login', { method: 'POST', body: { password: $('login-password').value } });
      $('login-password').value = ''; feedback('', false, 'login-feedback'); await initialize();
    });
  } catch (error) { feedback(errorText(error), true, 'login-feedback'); }
});
$('logout').addEventListener('click', async () => {
  if ((state.dirty || state.factsDirty || state.taskDirty || state.memeDirty || state.folderDirty) && !confirm('有未保存的改动或附件。退出登录？表单将暂存到本页，刷新会丢失。')) return;
  try {
    await locked([$('logout')], async () => {
      await api('/api/logout', { method: 'POST' }); state.session = await api('/api/session'); loginView(true); feedback('已退出登录。', false, 'login-feedback');
    });
  } catch (error) { feedback(errorText(error), true); }
});
async function initialize() {
  $('startup-error').hidden = true;
  try {
    state.session = await api('/api/session');
    if (state.session.authRequired && !state.session.authenticated) { loginView(true); return; }
    loginView(false); $('logout').hidden = !state.session.authRequired;
    if (!state.dirty) await loadConfig();
    await loadStatus();
    await loadVersion().catch(() => {});
    await loadUsage().catch((error) => feedback(errorText(error), true, 'usage-feedback'));
    state.initialized = true;
    feedback(state.dirty ? '登录成功。原有未保存表单已保留，请检查后保存。' : '控制台已就绪。');
  } catch (error) {
    if (error.status === 401) return;
    $('console').hidden = true; $('login-panel').hidden = true; $('startup-error').hidden = false;
    $('startup-error-text').textContent = errorText(error);
  }
}
$('startup-retry').addEventListener('click', () => locked([$('startup-retry')], initialize));
window.addEventListener('beforeunload', (event) => {
  if (state.dirty || state.factsDirty || state.taskDirty || state.memeDirty || state.folderDirty) { event.preventDefault(); event.returnValue = ''; }
});
setInterval(() => {
  if (!state.initialized || document.hidden || $('console').hidden) return;
  loadStatus().catch((error) => { $('status-error').textContent = errorText(error); });
  if (state.tab === 'overview') loadUsage().catch((error) => feedback(errorText(error), true, 'usage-feedback'));
  if (state.tab === 'logs') loadLogs().catch((error) => feedback(errorText(error), true));
  if (state.tab === 'tasks') loadTasks().catch((error) => feedback(errorText(error), true, 'task-feedback'));
  if (state.tab === 'resources') loadFolders().catch((error) => feedback(errorText(error), true, 'folder-feedback'));
}, 4000);
syncControls();
initialize();
