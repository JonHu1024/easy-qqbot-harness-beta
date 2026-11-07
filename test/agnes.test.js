import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { generateImage, generateVideo } from '../src/agnes.js';

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

const KEY = 'sk-test-secret-123';
const BASE = 'https://apihub.agnes-ai.com/v1';
const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('generateImage sends extra_body.response_format and reads data[0].url', async () => {
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url: String(url), init }; return jsonRes({ data: [{ url: 'https://cdn.example.com/a.png', b64_json: null }] }); };

  const out = await generateImage({ prompt: 'a cat', size: '1024x768', model: 'agnes-image-2.1-flash', apiKey: KEY, baseUrl: `${BASE}/` });

  assert.equal(seen.url, `${BASE}/images/generations`);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body, { model: 'agnes-image-2.1-flash', prompt: 'a cat', size: '1024x768', extra_body: { response_format: 'url' } });
  assert.equal('response_format' in body, false);
  assert.deepEqual(out, { kind: 'image', url: 'https://cdn.example.com/a.png', mime: 'image/png', notes: [] });
});

test('generateImage supports b64_json responses and sniffs the mime type', async () => {
  globalThis.fetch = async () => jsonRes({ data: [{ url: null, b64_json: PNG_B64 }] });
  const out = await generateImage({ prompt: 'p', apiKey: KEY, baseUrl: BASE });
  assert.equal(out.kind, 'image');
  assert.equal(out.base64, PNG_B64);
  assert.equal(out.mime, 'image/png');
  assert.equal('url' in out, false);
  assert.ok(out.notes.some(note => /Base64/.test(note)));
});

test('generateImage defaults size, model and base url', async () => {
  let body;
  globalThis.fetch = async (url, init) => { assert.equal(String(url), `${BASE}/images/generations`); body = JSON.parse(init.body); return jsonRes({ data: [{ url: 'https://x/y.jpg' }] }); };
  const out = await generateImage({ prompt: 'p', apiKey: KEY });
  assert.equal(body.size, '1024x1024');
  assert.equal(body.model, 'agnes-image-2.1-flash');
  assert.equal(out.mime, 'image/jpeg');
});

test('图片尺寸由模型自己挑：认不出来的写法退回默认尺寸', async () => {
  let body = null;
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return jsonRes({ data: [{ b64_json: 'iVBORw0KGgo=' }] }); };
  await generateImage({ prompt: 'p', apiKey: KEY, size: '512x512' });
  assert.equal(body.size, '1024x1024');
  body = null;
  await generateImage({ prompt: 'p', apiKey: KEY, size: 'portrait' });
  assert.equal(body.size, '1024x1792');
});

test('generateImage rejects missing key, empty prompt and bad size without calling fetch', async () => {
  let called = 0;
  globalThis.fetch = async () => { called++; return jsonRes({}); };
  await assert.rejects(() => generateImage({ prompt: 'p', apiKey: '  ' }), /API Key/);
  await assert.rejects(() => generateImage({ prompt: '   ', apiKey: KEY }), /提示词不能为空/);
  await assert.rejects(() => generateImage({ prompt: 'p', apiKey: KEY, timeoutMs: 0 }), /超时时间无效/);
  await assert.rejects(() => generateImage({ prompt: 'p', apiKey: KEY, baseUrl: 'ftp://x/v1' }), /HTTP\/HTTPS/);
  assert.equal(called, 0);
});

test('generateImage surfaces provider error.message and never leaks the api key', async () => {
  globalThis.fetch = async () => jsonRes({ error: { message: `invalid api key ${KEY}` } }, 401);
  await assert.rejects(() => generateImage({ prompt: 'p', apiKey: KEY, baseUrl: BASE }), error => {
    assert.match(error.message, /HTTP 401/);
    assert.match(error.message, /invalid api key/);
    assert.doesNotMatch(error.message, /sk-test-secret-123/);
    return true;
  });
});

test('generateImage rejects non-JSON responses, empty payloads and oversized bodies', async () => {
  globalThis.fetch = async () => new Response('<html>oops</html>', { status: 200 });
  await assert.rejects(() => generateImage({ prompt: 'p', apiKey: KEY }), /非 JSON 响应/);

  globalThis.fetch = async () => jsonRes({ data: [] });
  await assert.rejects(() => generateImage({ prompt: 'p', apiKey: KEY }), /未返回图片数据/);

  globalThis.fetch = async () => jsonRes({ data: [{}] });
  await assert.rejects(() => generateImage({ prompt: 'p', apiKey: KEY }), /未返回图片 URL 或 Base64/);

  globalThis.fetch = async () => new Response('x'.repeat(4 * 1024 * 1024 + 64), { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(() => generateImage({ prompt: 'p', apiKey: KEY }), /大小限制/);
});

test('generateVideo submits, polls until completed and returns url + taskId', async () => {
  const calls = [];
  let poll = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    if (init.method === 'POST') return jsonRes({ id: 'task_1', status: 'queued' });
    poll++;
    return jsonRes(poll === 1
      ? { id: 'task_1', status: 'processing', progress: 40 }
      : { id: 'task_1', status: 'completed', url: 'https://cdn.example.com/v.mp4' });
  };

  const out = await generateVideo({ prompt: 'run', duration: 5, apiKey: KEY, baseUrl: BASE, pollMs: 1, maxWaitMs: 1000 });

  assert.deepEqual(out, { kind: 'video', url: 'https://cdn.example.com/v.mp4', status: 'completed', taskId: 'task_1', notes: [] });
  assert.equal(calls[0].url, `${BASE}/video/generations`);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { model: 'agnes-video-2.5-flash', prompt: 'run', mode: 'text2video', width: 1152, num_frames: 121, frame_rate: 24 });
  assert.equal(calls[1].url, `${BASE}/video/generations/task_1`);
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[1].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls.length, 3);
});

test('generateVideo stops on failed tasks and reports the taskId', async () => {
  globalThis.fetch = async (url, init) => init.method === 'POST'
    ? jsonRes({ task_id: 'task_9', status: 'queued' })
    : jsonRes({ status: 'failed', error: { message: '内容违规' } });
  await assert.rejects(() => generateVideo({ prompt: 'p', apiKey: KEY, baseUrl: BASE, pollMs: 1, maxWaitMs: 500 }), error => {
    assert.match(error.message, /内容违规/);
    assert.match(error.message, /task_9/);
    return true;
  });
});

test('generateVideo timeout error carries the taskId for a retry', async () => {
  globalThis.fetch = async (url, init) => init.method === 'POST' ? jsonRes({ video_id: 'video_7', status: 'queued' }) : jsonRes({ status: 'processing' });
  await assert.rejects(() => generateVideo({ prompt: 'p', apiKey: KEY, baseUrl: BASE, pollMs: 2, maxWaitMs: 25 }), error => {
    assert.match(error.message, /超时/);
    assert.equal(error.taskId, 'video_7');
    return true;
  });
});

test('generateVideo rejects missing keys, bad durations and missing task ids without polling', async () => {
  let called = 0;
  globalThis.fetch = async () => { called++; return jsonRes({}); };
  await assert.rejects(() => generateVideo({ prompt: 'p', apiKey: '' }), /API Key/);
  await assert.rejects(() => generateVideo({ prompt: '   ', apiKey: KEY }), /提示词不能为空/);
  await assert.rejects(() => generateVideo({ prompt: 'p', apiKey: KEY, duration: 999 }), /时长必须是 1-60/);
  await assert.rejects(() => generateVideo({ prompt: 'p', apiKey: KEY, pollMs: 0 }), /轮询间隔无效/);
  await assert.rejects(() => generateVideo({ prompt: 'p', apiKey: KEY, maxWaitMs: 0 }), /最长等待时间无效/);
  assert.equal(called, 0);

  globalThis.fetch = async (url, init) => init.method === 'POST' ? jsonRes({ status: 'queued' }) : jsonRes({ status: 'processing' });
  await assert.rejects(() => generateVideo({ prompt: 'p', apiKey: KEY, baseUrl: BASE }), /未返回任务 ID/);
});

test('generateVideo surfaces poll HTTP errors without leaking the key', async () => {
  globalThis.fetch = async (url, init) => init.method === 'POST'
    ? jsonRes({ id: 'task_2' })
    : jsonRes({ error: { message: `rate limited for ${KEY}` } }, 429);
  await assert.rejects(() => generateVideo({ prompt: 'p', apiKey: KEY, baseUrl: BASE, pollMs: 1, maxWaitMs: 500 }), error => {
    assert.match(error.message, /HTTP 429/);
    assert.doesNotMatch(error.message, /sk-test-secret-123/);
    return true;
  });
});

test('模型无可用通道时自动附带当前 Key 可用模型，且不改写原始错误', async (t) => {
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    requests.push(String(url));
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({data:[{id:'agnes-video-2.5-flash'},{id:'agnes-video-2.5'},{id:'agnes-image-2.5-flash'}]}),{status:200});
    }
    return new Response(JSON.stringify({error:{message:'No available channel for model agnes-video-v2.0 under group default (distributor)'}}),{status:503});
  });
  const error=await generateVideo({prompt:'跑',model:'agnes-video-v2.0',apiKey:'sk-test',baseUrl:'https://apihub.agnes-ai.com/v1',pollMs:1,maxWaitMs:50}).then(()=>null,caught=>caught);
  assert.ok(error,'应抛出错误');
  assert.match(error.message,/No available channel/);
  assert.match(error.message,/agnes-video-2.5-flash、agnes-video-2.5/);
  assert.match(error.message,/Harness/);
  assert.equal(requests.filter(url=>url.endsWith('/models')).length,1);
  assert.equal(error.message.includes('sk-test'),false);
});

test('模型清单查询失败时不掩盖真实错误', async (t) => {
  t.mock.method(globalThis,'fetch',async(url)=>{
    if (String(url).endsWith('/models')) throw new Error('network down');
    return new Response(JSON.stringify({error:{message:'model agnes-image-9.9-flash not found'}}),{status:404});
  });
  const error=await generateImage({prompt:'画',model:'agnes-image-9.9-flash',apiKey:'sk-test',baseUrl:'https://apihub.agnes-ai.com/v1'}).then(()=>null,caught=>caught);
  assert.match(error.message,/not found/);
  assert.match(error.message,/HTTP 404/);
});

test('网关拒绝多余字段时按提示逐个剔除后重试，并支持 metadata.url 与备用轮询路径', async (t) => {
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const target=String(url);
    calls.push({url:target,body:options?.body?JSON.parse(options.body):null});
    if (target.endsWith('/video/generations')) {
      const body=JSON.parse(options.body);
      if ('height' in body) return new Response(JSON.stringify({code:'invalid_request',message:'height is a forbidden field'}),{status:400});
      if ('width' in body) return new Response(JSON.stringify({code:'invalid_request',message:'width is a forbidden field'}),{status:400});
      return new Response(JSON.stringify({id:'task_9',status:'queued'}),{status:200});
    }
    if (target.includes('/video/generations/task_9')) return new Response(JSON.stringify({error:{message:'not found'}}),{status:404});
    if (target.includes('/videos/task_9')) return new Response(JSON.stringify({status:'completed',metadata:{url:'https://cdn.example.com/out.mp4'}}),{status:200});
    throw new Error('unexpected '+target);
  });
  const out=await generateVideo({prompt:'跑',apiKey:'sk-test',baseUrl:'https://api.example.com/v1',pollMs:1,maxWaitMs:2000});
  assert.equal(out.url,'https://cdn.example.com/out.mp4');
  assert.equal(out.status,'completed');
  const submits=calls.filter(c=>c.url.endsWith('/video/generations'));
  assert.equal(submits.length,2,'应剔除 width 后重试一次');
  assert.deepEqual(Object.keys(submits.at(-1).body).sort(),['frame_rate','mode','model','num_frames','prompt']);
  assert.ok('width' in submits[0].body,'首次尝试应带上 width');
  assert.ok(out.notes.some(n=>/不接受字段 width/.test(n)),JSON.stringify(out.notes));
  assert.ok(calls.some(c=>c.url.includes('/videos/task_9')),'应回退到备用状态路径');
});

test('429 免费额度限制会原样抛出且不附带模型名误导', async (t) => {
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:{message:'You reached the API rate limit for free users. Upgrade to a Token Plan to unlock higher limits.'}}),{status:429}));
  const error=await generateVideo({prompt:'跑',apiKey:'sk-test',baseUrl:'https://api.example.com/v1'}).then(()=>null,e=>e);
  assert.match(error.message,/HTTP 429/);
  assert.match(error.message,/rate limit for free users/);
  assert.doesNotMatch(error.message,/可用的视频模型/);
});

