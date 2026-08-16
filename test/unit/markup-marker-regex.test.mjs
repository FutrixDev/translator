// 内联格式标记的两条正则，各自该归谁管。
//
// content-page-translation.js 里有两条形状很像的正则，用途完全不同，混用会出真
// 问题：
//
//   MARKUP_MARKER_RE  —— 笼统的“标记形状”。只用在**分析前的剥离**：代码检测、
//                        长度阈值、语言检测、译文与原文的比对。结果永远不落到
//                        页面上，多剥少剥都伤不到读者。
//   markupDebrisRe()  —— 只认本块**真生成过**的标签名和编号。用在**渲染前的剥
//                        离**。这里不能用笼统的那条：讲 HTML 的页面正文里就写着
//                        <b2> 这类字样，笼统剥会把页面自己的字删掉。
//
// 另外 content-language.js 拿不到模块作用域，抄了一份字面量兜底。抄本必须和正本
// 逐字一致——尤其是 i 标志：内置 NMT 实测会把开标记大写成 <A1>，少个 i 就漏剥。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageTranslation = readFileSync(new URL('../../content/content-page-translation.js', import.meta.url), 'utf8');
const language = readFileSync(new URL('../../content/content-language.js', import.meta.url), 'utf8');

test('the canonical marker regex is case-insensitive — NMT hands back <A1>', () => {
  const m = pageTranslation.match(/const MARKUP_MARKER_RE = (\/.+\/[a-z]*);/);
  assert.ok(m, 'MARKUP_MARKER_RE is no longer declared in the shape this test reads');
  assert.match(m[1], /\/[a-z]*i[a-z]*$/,
    'without the i flag the uppercased opener NMT really emits is never stripped');
});

test('content-language.js copy of the regex still matches the canonical one', () => {
  const canonical = pageTranslation.match(/const MARKUP_MARKER_RE = (\/.+\/[a-z]*);/)[1];
  const copy = language.match(/ctx\.MARKUP_MARKER_RE \|\| (\/.+\/[a-z]*)/);
  assert.ok(copy, 'the literal fallback in content-language.js moved or was renamed');
  assert.equal(copy[1], canonical,
    'the two spellings drifted — content-language.js strips a different set of markers');
});

test('the parser regex tolerates the casing and whitespace NMT introduces', () => {
  const m = pageTranslation.match(/const markerRe = (\/.+\/[a-z]*);/);
  assert.ok(m, 'markerRe is no longer declared in the shape this test reads');
  const re = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')), m[1].slice(m[1].lastIndexOf('/') + 1));
  // 实测 en→zh-Hans 的产物
  assert.match('阅读<A1>角色向量论文</a1>了解更多详情。', re, 'an uppercased opener must still parse');
  // 宽容一点，免得多一个空格就把链接丢了
  assert.match('请阅读< a1 >文档</ a1 >。', re, 'injected whitespace must still parse');
});

test('the reader-facing strip is the narrow one, the analysis strips are the broad one', () => {
  // 渲染路径（buildTranslationContent 的 emit、受管容器的 ::after）只能用
  // markupDebrisRe；用笼统正则就会删掉页面正文里本来就有的 <b2>。
  const build = pageTranslation.slice(pageTranslation.indexOf('function buildTranslationContent'));
  // 注释里提名字是可以的，这里要看的是代码里真的用了哪条
  const body = build.slice(0, build.indexOf('\n  // 向后兼容的旧签名'))
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(body, /markupDebrisRe\(markupElements\)/,
    'buildTranslationContent no longer scrubs debris before rendering');
  assert.doesNotMatch(body, /MARKUP_MARKER_RE/,
    'the render path must not use the broad regex — it eats the page\'s own prose');

  const managed = pageTranslation.slice(pageTranslation.indexOf('ctx.renderManagedTranslation(') - 700,
    pageTranslation.indexOf('ctx.renderManagedTranslation(') + 200);
  assert.match(managed, /markupDebrisRe\(block\.markupElements\)/,
    'the managed ::after path fell back to the broad regex');
});

test('markupDebrisRe only ever names tags and numbers this block handed out', () => {
  const src = pageTranslation.match(/function markupDebrisRe[\s\S]+?\n  }/)[0];
  const markupDebrisRe = new Function(`${src}; return markupDebrisRe;`)();

  // 本块发出去的是 a1 和 strong2
  const re = markupDebrisRe([{ tag: 'a', index: 1 }, { tag: 'strong', index: 2 }]);
  const scrub = (s) => s.replace(new RegExp(re.source, re.flags), '');

  // 自己的字：发过的标签名 + 发过的编号，无论怎么串、什么大小写、夹不夹空格
  assert.equal(scrub('请阅读<a1>文档</a1>。'), '请阅读文档。');
  assert.equal(scrub('请阅读<A1>文档</a1>。'), '请阅读文档。');
  assert.equal(scrub('请阅读< a1 >文档</ a1 >。'), '请阅读文档。');
  assert.equal(scrub('串错了的<strong1>也是残骸'), '串错了的也是残骸');

  // 页面自己的字：没发过 b，也没发过 9，一个都不能动
  assert.equal(scrub('HTML 里 <b9> 是什么意思？'), 'HTML 里 <b9> 是什么意思？');
  assert.equal(scrub('<div1> 不在标记集里'), '<div1> 不在标记集里');

  assert.equal(markupDebrisRe([]), null, 'no markers issued → nothing to scrub');
  assert.equal(markupDebrisRe(null), null);
});
