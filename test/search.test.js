import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { webSearch, readUrl, htmlToText, extractTitle } from '../src/search.js';

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

const htmlRes = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const hanging = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
});

test('duckduckgo HTML results are parsed, uddg decoded and entities cleaned', async () => {
  const page = `
    <div class="result"><h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">A &amp; B</a>
    </h2><a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Snippet <b>one</b> &ndash; ok</a></div>
    <div class="result"><h2 class="result__title"><a class="result__a" href="https://direct.example.org/page">Direct</a></h2>
      <div class="result__snippet">Second <i>snippet</i></div></div>
    <a class="result__a">No href here</a>`;
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url: new URL(url), init }; return htmlRes(page); };

  const out = await webSearch('  hello world  ', { provider: 'duckduckgo', count: 5 });

  assert.equal(out.provider, 'duckduckgo');
  assert.deepEqual(out.results, [
    { title: 'A & B', url: 'https://example.com/a?x=1', snippet: 'Snippet one – ok' },
    { title: 'Direct', url: 'https://direct.example.org/page', snippet: 'Second snippet' },
  ]);
  assert.equal(seen.url.hostname, 'html.duckduckgo.com');
  assert.equal(seen.url.searchParams.get('q'), 'hello world');
  assert.equal(seen.init.method, 'GET');
  // 重定向改成「手动跟一跳，但目标主机必须在白名单里」——
  // 搜索站点经常 302 到同族域名（cn.bing.com → www.bing.com），一律拒绝就等于废了这个源。
  assert.equal(seen.init.redirect, 'manual');
  assert.match(seen.init.headers['User-Agent'], /Mozilla/);
  assert.deepEqual(out.notes, []);
});

test('result count is capped at 10 with a note', async () => {
  const blocks = Array.from({ length: 12 }, (_, index) => `<a class="result__a" href="https://site${index}.example.com/x">Title ${index}</a><a class="result__snippet">snip ${index}</a>`).join('\n');
  globalThis.fetch = async () => htmlRes(blocks);
  const out = await webSearch('many', { provider: 'duckduckgo', count: 99 });
  assert.equal(out.results.length, 10);
  assert.equal(out.results[9].title, 'Title 9');
  assert.ok(out.notes.some(note => /限制为 10/.test(note)));
});

test('auto provider falls back duckduckgo → wikipedia in order and decodes wiki snippets', async () => {
  const calls = [];
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    calls.push(parsed.hostname + parsed.pathname);
    if (parsed.hostname === 'html.duckduckgo.com') return htmlRes('<html><body>no results</body></html>', 202);
    if (parsed.hostname === 'cn.bing.com') return htmlRes('<html></html>', 200);
    if (parsed.hostname === 'api.duckduckgo.com') return jsonRes({ AbstractText: '', RelatedTopics: [] });
    if (parsed.hostname === 'zh.wikipedia.org') {
      assert.equal(parsed.searchParams.get('srsearch'), 'node js');
      assert.equal(parsed.searchParams.get('srlimit'), '5');
      return jsonRes({ query: { search: [
        { title: 'Node.js', snippet: '<span class="searchmatch">JavaScript</span> runtime' },
        { title: 'Hello world', snippet: 'a program' },
      ] } });
    }
    throw new Error(`unexpected host ${parsed.hostname}`);
  };

  const out = await webSearch('node js', { count: 5 });

  assert.equal(out.provider, 'wikipedia');
  // auto 顺序：DuckDuckGo → 必应 → 维基百科
  assert.deepEqual(calls, ['html.duckduckgo.com/html/', 'api.duckduckgo.com/', 'cn.bing.com/search', 'zh.wikipedia.org/w/api.php']);
  assert.deepEqual(out.results.map(item => item.url), ['https://zh.wikipedia.org/wiki/Node.js', 'https://zh.wikipedia.org/wiki/Hello_world']);
  assert.equal(out.results[0].snippet, 'JavaScript runtime');
  assert.ok(out.notes.some(note => /风控/.test(note)));
  assert.ok(out.notes.some(note => /改用 Instant Answer/.test(note)));
});

test('duckduckgo instant answer supplies results when the HTML endpoint is blocked', async () => {
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    if (parsed.hostname === 'html.duckduckgo.com') return htmlRes('<html></html>', 202);
    return jsonRes({ Heading: 'Foo', AbstractURL: 'https://en.wikipedia.org/wiki/Foo', AbstractText: 'Foo <b>bar</b>', RelatedTopics: [{ FirstURL: 'https://example.com/t', Text: 'Topic &amp; text' }] });
  };
  const out = await webSearch('foo');
  assert.equal(out.provider, 'duckduckgo');
  assert.deepEqual(out.results[0], { title: 'Foo', url: 'https://en.wikipedia.org/wiki/Foo', snippet: 'Foo bar' });
  assert.deepEqual(out.results[1], { title: 'Topic & text', url: 'https://example.com/t', snippet: '' });
});

test('malformed HTML yields no results without throwing; invalid queries reject', async () => {
  await assert.rejects(() => webSearch('   '), /关键词不能为空/);
  await assert.rejects(() => webSearch('x', { provider: 'google' }), /不支持的搜索提供方/);
  await assert.rejects(() => webSearch('x', { timeoutMs: 0 }), /超时时间无效/);
  globalThis.fetch = async () => htmlRes('<html><body><p>nothing relevant</p></body></html>');
  const out = await webSearch('x', { provider: 'duckduckgo' });
  assert.deepEqual(out.results, []);
  assert.equal(out.provider, 'duckduckgo');
  assert.ok(out.notes.length > 0);
});

test('provider timeouts are recorded as notes and never fabricate results', async () => {
  globalThis.fetch = hanging;
  const out = await webSearch('slow', { timeoutMs: 15 });
  assert.deepEqual(out.results, []);
  assert.ok(out.notes.some(note => /超时/.test(note)), JSON.stringify(out.notes));
});

test('an aborted caller signal cancels the search with the original reason', async () => {
  globalThis.fetch = hanging;
  const controller = new AbortController();
  const pending = webSearch('x', { signal: controller.signal, timeoutMs: 5000 });
  controller.abort(new Error('用户取消'));
  await assert.rejects(pending, /用户取消/);
});

test('readUrl extracts title and text, strips script/style and truncates with a note', async () => {
  const page = `<html><head><title> 示例 &amp; 标题 </title><style>body{color:red}</style><script>steal()</script></head>
    <body><h1>Hello</h1><p>first &nbsp; line</p><script>evil()</script><p>second</p></body></html>`;
  const download = async (url, { signal } = {}) => {
    assert.equal(url, 'https://example.com/page');
    assert.equal(signal, undefined);
    return { bytes: Buffer.from(page, 'utf8'), contentType: 'text/html' };
  };

  const out = await readUrl('https://example.com/page#section', { download });

  assert.equal(out.url, 'https://example.com/page');
  assert.equal(out.title, '示例 & 标题');
  assert.match(out.text, /Hello/);
  assert.match(out.text, /first line/);
  assert.doesNotMatch(out.text, /steal|evil|color:red/);
  assert.deepEqual(out.notes, []);

  const long = await readUrl('https://example.com/page', { download, maxChars: 5 });
  assert.equal(long.text.length, 5);
  assert.ok(long.notes.some(note => /截断/.test(note)));
});

test('readUrl pretty prints JSON and rejects unsupported content types', async () => {
  const json = await readUrl('https://api.example.com/x', { download: async () => ({ bytes: Buffer.from('{"a":1,"b":[2,3]}'), contentType: 'application/json; charset=utf-8' }) });
  assert.match(json.text, /"a": 1/);
  assert.equal(json.title, '');

  await assert.rejects(
    () => readUrl('https://example.com/a.png', { download: async () => ({ bytes: Buffer.from([0x89, 0x50]), contentType: 'image/png' }) }),
    /不支持的内容类型/,
  );
});

test('readUrl validates input and wraps download failures and aborts', async () => {
  let called = 0;
  const download = async () => { called++; return { bytes: Buffer.alloc(0), contentType: 'text/plain' }; };
  await assert.rejects(() => readUrl('   ', { download }), /不能为空/);
  await assert.rejects(() => readUrl('not a url', { download }), /格式无效/);
  await assert.rejects(() => readUrl('file:///etc/passwd', { download }), /http\/https/);
  await assert.rejects(() => readUrl('https://example.com', { download, maxChars: 0 }), /上限无效/);
  assert.equal(called, 0);

  await assert.rejects(
    () => readUrl('https://example.com', { download: async () => { throw new Error('附件 DNS 包含私有或保留地址'); } }),
    /网页读取失败/,
  );

  const controller = new AbortController();
  controller.abort(new Error('取消读取'));
  await assert.rejects(() => readUrl('https://example.com', { download, signal: controller.signal }), /取消读取/);
});

test('htmlToText and extractTitle handle malformed and entity-laden markup', () => {
  assert.equal(extractTitle('<html><title>A &#38; B</title>'), 'A & B');
  assert.equal(extractTitle('<html><body>no title</body>'), '');
  assert.equal(htmlToText('<p>a</p><p>b</p>'), 'a\nb');
  assert.equal(htmlToText('<script>alert(1)</script>tail'), 'tail');
  assert.equal(htmlToText('<style>p{}</style><div>keep &amp; drop &lt;tag&gt;</div>'), 'keep & drop <tag>');
  assert.equal(htmlToText('<div>unclosed <script>alert(1)'), 'unclosed');
});

test('搜索跟随重定向，但只允许跳到白名单里的主机', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), redirect: options.redirect });
    const parsed = new URL(String(url));
    if (parsed.hostname === 'cn.bing.com') {
      return new Response('', { status: 302, headers: { location: 'https://www.bing.com/search?q=x' } });
    }
    if (parsed.hostname === 'www.bing.com') {
      return htmlRes('<html><ol id="b_results"><li class="b_algo"><h2><a href="https://example.com/a">标题</a></h2><p>摘要</p></li></ol></html>', 200);
    }
    throw new Error(`unexpected host ${parsed.hostname}`);
  };
  const out = await webSearch('x', { provider: 'bing' });
  assert.equal(out.provider, 'bing');
  assert.equal(out.results[0].url, 'https://example.com/a');
  assert.equal(calls[0].redirect, 'manual');
});

test('搜索不会跟随到白名单之外的主机', async () => {
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'cn.bing.com') {
      return new Response('', { status: 302, headers: { location: 'http://127.0.0.1:8080/secret' } });
    }
    return htmlRes('<html></html>', 200);
  };
  const out = await webSearch('x', { provider: 'bing' });
  assert.deepEqual(out.results, [], '不该把跳转目标的内容取回来');
  assert.ok(out.notes.some((note) => /不允许访问的搜索主机/.test(note)), JSON.stringify(out.notes));
});
