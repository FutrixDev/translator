// 内联格式标记的两条正则，各自该归谁管。
//
// 整页翻译里有两条形状很像的正则，用途完全不同，混用会出真问题
// （拆分后一条在 content/page/collect.js，一条在 content/page/insert.js）：
//
//   MARKUP_MARKER_RE  —— 笼统的“标记形状”。只用在**分析前的剥离**：代码检测、
//                        长度阈值、语言检测、译文与原文的比对。结果永远不落到
//                        页面上，多剥少剥都伤不到读者。
//   markupDebrisScrubber() —— 只认本块**真生成过**的标签名和编号（编号可以是几
//                        个本块编号粘在一起）。用在**渲染前的剥离**。这里不能用
//                        笼统的那条：讲 HTML 的页面正文里就写着 <b2> 这类字样，
//                        笼统剥会把页面自己的字删掉。
//
// 另外 content-language.js 拿不到模块作用域，抄了一份字面量兜底。抄本必须和正本
// 逐字一致——尤其是 i 标志：内置 NMT 实测会把开标记大写成 <A1>，少个 i 就漏剥。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
// 收集端编码标记，落笔端解码标记，两条正则各在自己那一头。
const collect = read('content/page/collect.js');
const insert = read('content/page/insert.js');
const language = read('content/content-language.js');

test('the canonical marker regex is case-insensitive — NMT hands back <A1>', () => {
  const m = collect.match(/const MARKUP_MARKER_RE = (\/.+\/[a-z]*);/);
  assert.ok(m, 'MARKUP_MARKER_RE is no longer declared in the shape this test reads');
  assert.match(m[1], /\/[a-z]*i[a-z]*$/,
    'without the i flag the uppercased opener NMT really emits is never stripped');
});

test('content-language.js copy of the regex still matches the canonical one', () => {
  const canonical = collect.match(/const MARKUP_MARKER_RE = (\/.+\/[a-z]*);/)[1];
  const copy = language.match(/ctx\.MARKUP_MARKER_RE \|\| (\/.+\/[a-z]*)/);
  assert.ok(copy, 'the literal fallback in content-language.js moved or was renamed');
  assert.equal(copy[1], canonical,
    'the two spellings drifted — content-language.js strips a different set of markers');
});

test('the parser regex tolerates the casing and whitespace NMT introduces', () => {
  const m = insert.match(/const markerRe = (\/.+\/[a-z]*);/);
  assert.ok(m, 'markerRe is no longer declared in the shape this test reads');
  const re = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')), m[1].slice(m[1].lastIndexOf('/') + 1));
  // 实测 en→zh-Hans 的产物
  assert.match('阅读<A1>角色向量论文</a1>了解更多详情。', re, 'an uppercased opener must still parse');
  // 宽容一点，免得多一个空格就把链接丢了
  assert.match('请阅读< a1 >文档</ a1 >。', re, 'injected whitespace must still parse');
});

test('the reader-facing strip is the narrow one, the analysis strips are the broad one', () => {
  // 渲染路径（buildTranslationContent 的 emit、受管容器的 ::after）只能用
  // markupDebrisScrubber；用笼统正则就会删掉页面正文里本来就有的 <b2>。
  const build = insert.slice(insert.indexOf('function buildTranslationContent'));
  // 注释里提名字是可以的，这里要看的是代码里真的用了哪条
  const body = build.slice(0, build.indexOf('\n  // 向后兼容的旧签名'))
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(body, /markupDebrisScrubber\(markupElements\)/,
    'buildTranslationContent no longer scrubs debris before rendering');
  assert.doesNotMatch(body, /MARKUP_MARKER_RE/,
    'the render path must not use the broad regex — it eats the page\'s own prose');

  const managed = insert.slice(insert.indexOf('ctx.renderManagedTranslation(') - 700,
    insert.indexOf('ctx.renderManagedTranslation(') + 200);
  assert.match(managed, /markupDebrisScrubber\(block\.markupElements\)/,
    'the managed ::after path fell back to the broad regex');
});

function loadScrubber() {
  const src = insert.match(/function markupDebrisScrubber[\s\S]+?\n  }/)[0];
  return new Function(`${src}; return markupDebrisScrubber;`)();
}

// 一块发出去 n 个同名标记：span1 … spann。
const spans = (n) => Array.from({ length: n }, (_, i) => ({ tag: 'span', index: i + 1 }));

test('the scrubber only ever removes tags and numbers this block handed out', () => {
  const markupDebrisScrubber = loadScrubber();

  // 本块发出去的是 a1 和 strong2
  const scrub = markupDebrisScrubber([{ tag: 'a', index: 1 }, { tag: 'strong', index: 2 }]);

  // 自己的字：发过的标签名 + 发过的编号，无论怎么串、什么大小写、夹不夹空格
  assert.equal(scrub('请阅读<a1>文档</a1>。'), '请阅读文档。');
  assert.equal(scrub('请阅读<A1>文档</a1>。'), '请阅读文档。');
  assert.equal(scrub('请阅读< a1 >文档</ a1 >。'), '请阅读文档。');
  assert.equal(scrub('串错了的<strong1>也是残骸'), '串错了的也是残骸');

  // 页面自己的字：没发过 b，也没发过 9，一个都不能动
  assert.equal(scrub('HTML 里 <b9> 是什么意思？'), 'HTML 里 <b9> 是什么意思？');
  assert.equal(scrub('<div1> 不在标记集里'), '<div1> 不在标记集里');

  const none = markupDebrisScrubber([]);
  assert.equal(none('<a1>原样</a1>'), '<a1>原样</a1>', 'no markers issued → nothing to scrub');
  assert.equal(markupDebrisScrubber(null)('<a1>'), '<a1>');
});

test('a marker whose number the model fused or doubled is still debris', () => {
  const markupDebrisScrubber = loadScrubber();
  // 实测：Reddit 卡片头发出 span1…span13，内置引擎把 <span11> 写回成 <span1111>，
  // 一个编号都配不上，原样显示给了读者。
  const scrub = markupDebrisScrubber(spans(13));
  assert.equal(scrub('4 小时前 帖子<span1111>报告'), '4 小时前 帖子报告');
  // 两个相邻标记粘成一个：<span12><span13> → <span1213>
  assert.equal(scrub('奖励<span1213>分享'), '奖励分享');
  assert.equal(scrub('奖励</span1213>分享'), '奖励分享');
});

test('a fused number that does not split into this block\'s own numbers is left alone', () => {
  const markupDebrisScrubber = loadScrubber();
  // 只发过 span1…span3：99 拆不成 1/2/3，0 不是任何编号——不是本块的字，不动
  const scrub = markupDebrisScrubber(spans(3));
  assert.equal(scrub('<span99>'), '<span99>');
  assert.equal(scrub('<span0>'), '<span0>');
  assert.equal(scrub('<span124>'), '<span124>', '4 was never issued');
  // 标签名不对，编号再对也不动
  assert.equal(scrub('<b12>'), '<b12>');
});

test('a long run of digits is judged in linear time, not by backtracking', () => {
  const markupDebrisScrubber = loadScrubber();
  // 编号 1、11 互为前缀；写进正则的交替会在这种串上指数回溯
  const scrub = markupDebrisScrubber(spans(11));
  const digits = '1'.repeat(5000);
  const started = performance.now();
  assert.equal(scrub(`<span${digits}>`), '');
  // 0 不是任何编号的开头，00、100 也都没发过：整串拆不开，得一路判到底才知道
  assert.equal(scrub(`<span${digits}00>`), `<span${digits}00>`);
  assert.ok(performance.now() - started < 1000, 'splitting a long number took too long');
});
