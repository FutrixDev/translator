// 整页翻译覆盖面（P1-A2）：shadow 样式、Alt+W 命令、正文范围的几条静态约束。
//
// 行为本身（shadow 里的块收没收、notranslate 怎么判、正文范围跳了什么）在 e2e 的
// test/e2e/page-coverage.spec.js 里走真浏览器；这里只守浏览器里看不出来、却会让
// 那些行为悄悄失效的东西：
//
//   - shadow root 里的译文靠 SW 递过去的样式文本活着。样式表清单漏一份、文档里的
//     `html body` 前缀没去掉，译文在 shadow 里就是一段没样式的字——e2e 只在一个
//     夹具上看得见，这里对每一份注入的 CSS 都看。
//   - Alt+W 只发给顶层 frame（子 frame 的覆盖值由顶层的手动轮带下去），别的命令
//     一概不接；样式消息的监听器不能替别人的消息关通道。
//   - 整页翻译里凡是「文档里的译文节点有哪些」的查询都得走 ctx.queryAllDeep，
//     否则 shadow 里的译文收不起来、也数不到。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentBundle, pageSource } from './helpers/sources.mjs';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// 模块顶层看见 chrome 才注册监听——在 import 之前装好替身，把注册下来的监听器
// 捉住，下面的用例调的就是生产注册的那一个。
const listeners = { message: [], command: [] };
const sent = [];
let sendMessageImpl = async (...args) => { sent.push(args); };
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    getURL: (rel) => `chrome-extension://test-id/${rel}`,
  },
  commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } },
  tabs: {
    sendMessage: (...args) => sendMessageImpl(...args),
    query: async () => [{ id: 42 }],
  },
};
let fetchCount = 0;
globalThis.fetch = async (url) => {
  fetchCount += 1;
  const rel = String(url).replace('chrome-extension://test-id/', '');
  return { ok: true, status: 200, text: async () => repoFile(rel) };
};

const { SHADOW_STYLE_FILES, toShadowCss, handleMessage, handleCommand } =
  await import('../../background/page-coverage.js');

const manifest = JSON.parse(repoFile('manifest.json'));
const injectedCss = manifest.content_scripts.flatMap((cs) => cs.css || []);

function classesIn(css) {
  return new Set(stripComments(css).match(/\.ai-translator-[a-z0-9-]*[a-z0-9]/g) || []);
}

test('every injected stylesheet that styles translation nodes is shipped into shadow roots', () => {
  // 整页译文节点的样式词汇 = translation.css 定义的类里、整页翻译这一族真会写到
  // 节点上的那些。悬停/划选的 `.ai-translator-inline` 不在内：那条路不经
  // batch.js 插入，不进 shadow 样式这一套。
  const page = pageSource();
  const vocabulary = new Set([...classesIn(repoFile('content/css/translation.css'))]
    .filter((cls) => new RegExp(`['"\\s.]${cls.slice(1)}(?![\\w-])`).test(page)));
  for (const cls of ['inline-block', 'source-hidden', 'hidden', 'inline-right']) {
    assert.ok(vocabulary.has(`.ai-translator-${cls}`), `.ai-translator-${cls} fell out of the vocabulary`);
  }
  const styling = injectedCss.filter((rel) => {
    const own = classesIn(repoFile(rel));
    return [...vocabulary].some((cls) => own.has(cls));
  });
  assert.deepEqual(styling.filter((rel) => !SHADOW_STYLE_FILES.includes(rel)), [],
    'these files style translation nodes but shadow roots never receive them — add them to SHADOW_STYLE_FILES');
  // 反方向：清单里的每一份都真是 manifest 注入的（改了名的文件会 404，样式静默丢失）。
  assert.deepEqual(SHADOW_STYLE_FILES.filter((rel) => !injectedCss.includes(rel)), []);
});

// 夹具：抄自 P0-C 提交 b26f6ef，#105 合入后改读真文件。
// content/css/translation.css 的 :50-51（逗号成对的 html body 前缀）与 :156-202
// （挂在 <html> 属性上的译文样式、blur 的 :not(...)、@media 里缩进的 :hover 行、
// 逗号成对的 focus-within / revealed 行）。
const P0C_FIXTURE = `
html body .ai-translator-inline-block::before,
html body .ai-translator-inline-block::after {
  content: none !important;
}

html[data-ai-translator-style="underline"] .ai-translator-inline-block:not(.ai-translator-selection-translation):not(.ai-translator-hover-translation) {
  text-decoration: underline 2px #4f6ef7 !important;
  text-underline-offset: 3px !important;
}

html[data-ai-translator-style="blur"]:not([data-ai-translator-only]) .ai-translator-inline-block:not(a):not(.ai-translator-selection-translation):not(.ai-translator-hover-translation) {
  filter: blur(5px) !important;
  transition: filter 0.15s !important;
}

@media (hover: hover) {
  html[data-ai-translator-style="blur"]:not([data-ai-translator-only]) .ai-translator-inline-block:not(a):not(.ai-translator-selection-translation):not(.ai-translator-hover-translation):hover {
    filter: none !important;
  }
}

html[data-ai-translator-style="blur"]:not([data-ai-translator-only]) .ai-translator-inline-block:not(a):not(.ai-translator-selection-translation):not(.ai-translator-hover-translation):focus-within,
html[data-ai-translator-style="blur"]:not([data-ai-translator-only]) .ai-translator-inline-block.ai-translator-revealed:not(a):not(.ai-translator-selection-translation):not(.ai-translator-hover-translation) {
  filter: none !important;
}
`;

// `:host-context(` 起到配平的 `)` 为止；参数必须恰好是一个以 html 开头的复合选择器
// （html 加属性选择器与 :not(...)）。不合格的抛错，合格的整组去掉，留下的再去查前缀。
const HTML_COMPOUND = /^html(?:\[(?:"[^"]*"|'[^']*'|[^\]"'])*\]|:not\((?:"[^"]*"|'[^']*'|[^()"'])*\))*$/;
function withoutHostContext(selector) {
  let rest = selector;
  for (let at = rest.indexOf(':host-context('); at !== -1; at = rest.indexOf(':host-context(')) {
    const open = at + ':host-context'.length;
    let depth = 0;
    let close = -1;
    for (let i = open; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')' && --depth === 0) { close = i; break; }
    }
    assert.notEqual(close, -1, `unbalanced :host-context in ${selector}`);
    const arg = rest.slice(open + 1, close);
    assert.match(arg, HTML_COMPOUND, `:host-context argument is not one html compound: ${arg}`);
    rest = rest.slice(0, at) + rest.slice(close + 1);
  }
  return rest;
}

function selectorsOf(css) {
  return stripComments(css).split('{').slice(0, -1).map((chunk) => chunk.split('}').pop().trim())
    .filter((sel) => !sel.startsWith('@'));
}

function anchoredOnHtmlOrBody(css) {
  return selectorsOf(css).map(withoutHostContext)
    .filter((sel) => /(^|[\s,>+~(])(html|body)(?![\w-])/.test(sel));
}

test('the shadow copy of the styles has no html/body prefix left', () => {
  // shadow 树里没有 <html>/<body>，留下任何一个前缀，那条规则在 shadow 里就一个
  // 元素都匹配不上。`html[data-ai-translator-theme=...] body` 这类变体也算——它们
  // 该变成 :host-context(html[...])，这里先验明、去掉那一组再查。
  for (const rel of SHADOW_STYLE_FILES) {
    assert.deepEqual(anchoredOnHtmlOrBody(toShadowCss(repoFile(rel))), [],
      `${rel}: selectors still anchored on html/body in the shadow copy`);
  }
  assert.deepEqual(anchoredOnHtmlOrBody(toShadowCss(P0C_FIXTURE)), [],
    'P0-C fixture: selectors still anchored on html/body in the shadow copy');
  // 反面对照：检查器真认得出前缀（没改写的原文，五条规则的选择器条条都算）。
  assert.equal(anchoredOnHtmlOrBody(P0C_FIXTURE).length, 5);
  assert.equal(toShadowCss('html body .a, html body .b{x:1}'), '.a, .b{x:1}');
  assert.equal(toShadowCss('}\nhtml  body .a{}'), '}\n.a{}');
  // 类名里恰好带着 html/body 的不动。
  assert.equal(toShadowCss('.xhtml body .a{}'), '.xhtml body .a{}');
  assert.equal(toShadowCss('html-foo .a{}'), 'html-foo .a{}');
});

test('conditions on <html> become :host-context(html...) in the shadow copy', () => {
  assert.equal(toShadowCss('html[data-x="y"] body .a{}'), ':host-context(html[data-x="y"]) .a{}');
  const out = toShadowCss(P0C_FIXTURE);
  const PAIR = '.ai-translator-inline-block';
  // 普通的一行。
  assert.ok(out.includes(`\n:host-context(html[data-ai-translator-style="underline"]) ${PAIR}:not(`), out);
  // blur 带 :not([data-ai-translator-only]) 的那一行：:not 整个进 :host-context。
  const BLUR = ':host-context(html[data-ai-translator-style="blur"]:not([data-ai-translator-only]))';
  assert.ok(out.includes(`\n${BLUR} ${PAIR}:not(a):not(`), out);
  // @media 里缩进的 :hover 行。
  assert.ok(out.includes(`@media (hover: hover) {\n  ${BLUR} ${PAIR}:not(a)`), out);
  assert.ok(/:hover \{\n\s+filter: none/.test(out), out);
  // 逗号成对的第二项。
  assert.ok(out.includes(`:focus-within,\n${BLUR} ${PAIR}.ai-translator-revealed`), out);
  // 没有条件的 html body 前缀照旧整段去掉。
  assert.ok(out.includes(`\n${PAIR}::before,\n${PAIR}::after {`), out);
  // 组合子不是后代、body 本身是主体、html 后面不是复合选择器的，都不是这条规则。
  for (const css of ['html > body .a{}', 'html body{}', 'html {x:1}', 'html:hover .a{}', 'html, body{}']) {
    assert.equal(toShadowCss(css), css);
  }
});

test('the worker registers one message listener and one command listener', () => {
  assert.equal(listeners.message.length, 1);
  assert.equal(listeners.command.length, 1);
  assert.equal(listeners.message[0], handleMessage);
  assert.equal(listeners.command[0], handleCommand);
  // 入口真的 import 了它（不 import，上面那两个监听在 SW 里根本不存在）。
  assert.match(repoFile('background/background.js'), /^import '\.\/page-coverage\.js';$/m);
});

test('GET_SHADOW_STYLES answers with the stripped stylesheet text, fetched once', async () => {
  const onMessage = listeners.message[0];
  const replies = [];
  const keepOpen = onMessage({ type: 'GET_SHADOW_STYLES' }, {}, (reply) => replies.push(reply));
  assert.equal(keepOpen, true, 'an async reply needs the channel kept open');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(replies.length, 1);
  assert.equal(typeof replies[0].css, 'string');
  assert.ok(replies[0].css.includes('.ai-translator-inline-block'));
  assert.ok(!/(^|[\s,{}])html\s+body\s/.test(replies[0].css));
  const before = fetchCount;
  onMessage({ type: 'GET_SHADOW_STYLES' }, {}, (reply) => replies.push(reply));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetchCount, before, 'the stylesheet is read once per worker lifetime');
  assert.equal(replies[1].css, replies[0].css);
});

test('other messages are left alone: no reply, no open channel', () => {
  const onMessage = listeners.message[0];
  for (const message of [{ type: 'TRANSLATE_WHOLE_PAGE' }, { type: 'translate' }, {}, null]) {
    let replied = false;
    const result = onMessage(message, {}, () => { replied = true; });
    assert.equal(result, undefined, `${JSON.stringify(message)} must not keep the channel open`);
    assert.equal(replied, false);
  }
});

test('Alt+W sends TRANSLATE_WHOLE_PAGE to the top frame only', async () => {
  const onCommand = listeners.command[0];
  sent.length = 0;
  await onCommand('translate-whole-page', { id: 7 });
  assert.deepEqual(sent, [[7, { type: 'TRANSLATE_WHOLE_PAGE' }, { frameId: 0 }]]);

  // 没带 tab（某些 Chrome 版本的命令事件）：取当前窗口的活动标签页。
  sent.length = 0;
  await onCommand('translate-whole-page', undefined);
  assert.deepEqual(sent, [[42, { type: 'TRANSLATE_WHOLE_PAGE' }, { frameId: 0 }]]);
});

test('other commands are not ours, and a missing receiver stays quiet', async () => {
  const onCommand = listeners.command[0];
  sent.length = 0;
  await onCommand('toggle-translate-page', { id: 7 });
  await onCommand('_execute_action', { id: 7 });
  assert.deepEqual(sent, []);

  sendMessageImpl = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
  const log = console.log;
  console.log = () => {};
  try {
    await assert.doesNotReject(onCommand('translate-whole-page', { id: 7 }));
  } finally {
    console.log = log;
    sendMessageImpl = async (...args) => { sent.push(args); };
  }
});

test('the manifest declares the shortcut with a localized description', () => {
  const command = manifest.commands['translate-whole-page'];
  assert.ok(command, 'manifest.commands.translate-whole-page is missing');
  assert.equal(command.suggested_key.default, 'Alt+W');
  assert.equal(command.description, '__MSG_cmdTranslateWholePage__');
});

test('page-translation queries over translation nodes reach into shadow roots', () => {
  // document.querySelectorAll 只看得见文档的 light 树；shadow 里的译文要靠
  // ctx.queryAllDeep 一起拿到，收起 / 显示 / 「这页有没有译文」才对得上。
  const source = pageSource();
  const TRANSLATION_NODE = /PAGE_TRANSLATION_SELECTOR|ai-translator-(?:inline-block|source-hidden|source-wrap|translated)/;
  const bare = [...source.matchAll(/document\.querySelectorAll\(([^)]*)\)/g)]
    .map((m) => m[1])
    .filter((arg) => TRANSLATION_NODE.test(arg));
  assert.deepEqual(bare, [], 'use ctx.queryAllDeep(...) for translation nodes');
  assert.match(source, /ctx\.queryAllDeep\(PAGE_TRANSLATION_SELECTOR\)/);
});

test('the three page-coverage modules load before the collector', () => {
  const bundle = contentBundle();
  const collect = bundle.indexOf('content/page/collect.js');
  assert.notEqual(collect, -1);
  for (const rel of ['content/page/shadow.js', 'content/page/notranslate.js', 'content/page/scope.js']) {
    const at = bundle.indexOf(rel);
    assert.notEqual(at, -1, `${rel} is not in the content bundle`);
    assert.ok(at < collect, `${rel} must load before collect.js`);
  }
});

test('the production entry points collect through the page scope', () => {
  // 手动整页翻译与发现层都经 collectPageBlocks；直接调 collectTranslatableBlocks
  // 就绕过了正文范围（和它读出的整页覆盖值）。
  assert.match(repoFile('content/content-page-translation.js'), /ctx\.collectPageBlocks\(\)/);
  assert.match(repoFile('content/content-auto-discover.js'), /ctx\.collectPageBlocks\(root\)/);
});
