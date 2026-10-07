// 占位符 {{n}} 与内联标记 <a1>…</a1> 的语法只有一份：shared/text-markers.js。
//
// 取代 markup-marker-regex.test.mjs。那边守的是「两条形状很像的正则各归谁管、
// content-language.js 的抄本和正本逐字一致」；抄本已经没有了，两条正则都搬进了
// 这个模块，守的事变成：
//   - 通用语法（markerPattern、strip）只给分析用，渲染路径只用逐块的
//     debrisScrubber——讲 HTML 的页面正文里就写着 <b2>，笼统剥会删掉页面的字；
//   - i 标志不能丢：内置 NMT 实测会把开标记大写成 <A1>；
//   - 工厂每次给新实例，两处交错 exec 不互相改 lastIndex；
//   - 除了本模块和 test/，仓库里不再有第二份这两种记号的正则字面量。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { productSourceFiles, repoSource } from './helpers/sources.mjs';

import '../../shared/text-markers.js';

const TM = globalThis.TextMarkers;
const read = repoSource;

// ------------------------------------------------------- 语法本身

test('the strict marker pattern is global and case-insensitive — NMT hands back <A1>', () => {
  const flags = TM.markerPattern().flags;
  assert.ok(flags.includes('g'), 'without g only the first marker is stripped');
  assert.ok(flags.includes('i'),
    'without the i flag the uppercased opener NMT really emits is never stripped');
  assert.equal(TM.strip('阅读<A1>角色向量论文</a1>了解更多详情。'), '阅读角色向量论文了解更多详情。');
});

test('every pattern factory returns a fresh instance, so interleaved exec never shares lastIndex', () => {
  for (const [name, factory, first, second] of [
    ['placeholderPattern', TM.placeholderPattern, 'a{{1}}b{{2}}c{{3}}', 'x{{7}}y{{8}}'],
    ['markerPattern', TM.markerPattern, '<a1>x</a1><b2>y</b2>', '<i3>z</i3>'],
  ]) {
    const one = factory();
    const two = factory();
    assert.notEqual(one, two, `${name}() handed out one shared object`);
    const hits = [[], []];
    const res = [one, two];
    const texts = [first, second];
    const done = [false, false];
    // 交错：一边走一步，另一边走一步，直到两边都走完
    while (!done[0] || !done[1]) {
      for (const i of [0, 1]) {
        if (done[i]) continue;
        const m = res[i].exec(texts[i]);
        if (m === null) done[i] = true;
        else hits[i].push(m[0]);
      }
    }
    assert.deepEqual(hits[0], texts[0].match(factory()), `${name}: the first text lost matches`);
    assert.deepEqual(hits[1], texts[1].match(factory()), `${name}: the second text lost matches`);
  }
});

test('placeholder generation, parsing and id sets agree with each other', () => {
  assert.equal(TM.placeholder(3), '{{3}}');
  assert.equal(TM.parsePlaceholder(TM.placeholder(12)), '12');
  assert.equal(TM.parsePlaceholder(' {{1}}'), null, 'only the whole string is a placeholder');
  assert.equal(TM.parsePlaceholder('{{x}}'), null);
  assert.deepEqual([...TM.placeholderIds('a{{1}}b{{20}}c{{1}}')].sort(), ['1', '20']);
  assert.equal(TM.openTag('a', 1), '<a1>');
  assert.equal(TM.closeTag('strong', 2), '</strong2>');
});

// 实测内置引擎（Chrome Translator en→pt）真的吐过的形状，见 repairPlaceholders 的说明。
test('repairPlaceholders: puts back the braces the built-in engine dropped', () => {
  const R = TM.repairPlaceholders;
  assert.equal(R('The proof is complete.{{1}}', 'A prova está completa.{1}}'), 'A prova está completa.{{1}}');
  assert.equal(R('see {{1}}{{2}} here', 'veja {{1}}{2}} aqui'), 'veja {{1}}{{2}} aqui');
  assert.equal(R('see {{1}}{{2}} here', 'veja {{1}{{2}} aqui'), 'veja {{1}}{{2}} aqui');
  assert.equal(R('<a3>{{4}}</a3> is set', '<a3>{4}</a3> está definido'), '<a3>{{4}}</a3> está definido');
  // 同一个编号出现两次，两处都补
  assert.equal(R('{{1}} and {{1}}', '{1}} e {1}}'), '{{1}} e {{1}}');
});

test('repairPlaceholders: compares whole ids, so {{12}} is never read as a piece of {{1}}', () => {
  const R = TM.repairPlaceholders;
  assert.equal(R('x {{1}} y {{12}}', 'x {1}} y {{12}}'), 'x {{1}} y {{12}}');
  assert.equal(R('x {{1}} y {{12}}', 'x {{1}} y {12}}'), 'x {{1}} y {{12}}');
  // {{1}} 已经完整，{1}} 再出现就不是它的残片——旁边的 {{2}} 丢了也一样
  assert.equal(R('x {{1}} y', 'x {{1}} y {1}}'), 'x {{1}} y {1}}');
  assert.equal(R('x {{1}} y {{2}}', 'x {{1}} y {2}} {1}}'), 'x {{1}} y {{2}} {1}}');
});

test('repairPlaceholders: leaves alone what this block did not send and what the page itself wrote', () => {
  const R = TM.repairPlaceholders;
  // 没发过 {{3}}：译文里的 {3}} 是别人的字
  assert.equal(R('a {{1}} b', 'a {{1}} b {3}}'), 'a {{1}} b {3}}');
  assert.equal(R('a {{1}} b', 'a {1}} b {3}}'), 'a {{1}} b {3}}');
  // 页面正文（去掉占位符以后）本来就写着 {2}}，同样写法原样留着，丢的照样算丢
  assert.equal(R('JSON {2}} then {{2}}', 'JSON {2}} então'), 'JSON {2}} então');
  // 没有占位符的块一个字不动
  assert.equal(R('plain {1}} text', 'texto {1}} simples'), 'texto {1}} simples');
});

test('segments round-trip to the original text and label each piece', () => {
  for (const text of [
    '',
    'plain',
    'a{{1}}b<a1>c</A1>d{{x}}',
    '{{0}}<b2>lead</b2>{{3}}',
    'HTML 里 <b9> 是什么意思？',
  ]) {
    const parts = TM.segments(text);
    assert.equal(parts.map((p) => p.value).join(''), text, `segments(${JSON.stringify(text)}) lost text`);
    for (const p of parts) {
      if (p.kind === 'placeholder') assert.notEqual(TM.parsePlaceholder(p.value), null);
      if (p.kind === 'marker') assert.equal(TM.strip(p.value), '');
      if (p.kind === 'text') assert.equal(TM.strip(p.value), p.value);
    }
  }
  assert.deepEqual(TM.segments('a{{1}}<a1>b').map((p) => p.kind), ['text', 'placeholder', 'marker', 'text']);
});

test('splitSafe never cuts a {{n}} in half', () => {
  const text = 'abc{{17}}def{{2}}';
  for (let at = 0; at <= text.length; at++) {
    const cut = TM.splitSafe(text, at);
    assert.ok(cut <= at, `splitSafe moved forward from ${at}`);
    const head = text.slice(0, cut);
    const tail = text.slice(cut);
    // 两半各自的占位符数加起来等于整段的：没有哪一个被切成两截
    const count = (s) => (s.match(TM.placeholderPattern()) || []).length;
    assert.equal(count(head) + count(tail), count(text), `cut at ${at} split a placeholder: ${head} | ${tail}`);
  }
  assert.equal(TM.splitSafe(text, 5), 3, 'inside {{17}} falls back to its {{');
  assert.equal(TM.splitSafe(text, 3), 3, 'right before {{ is already safe');
  assert.equal(TM.splitSafe(text, 9), 9, 'right after }} is already safe');
});

test('the parser pattern tolerates the casing and whitespace NMT introduces', () => {
  // 实测 en→zh-Hans 的产物
  assert.match('阅读<A1>角色向量论文</a1>了解更多详情。', TM.markerParsePattern(),
    'an uppercased opener must still parse');
  // 宽容一点，免得多一个空格就把链接丢了
  assert.match('请阅读< a1 >文档</ a1 >。', TM.markerParsePattern(), 'injected whitespace must still parse');
  assert.deepEqual(TM.parseMarker(TM.markerParsePattern().exec('</ Strong 12 >')),
    { closing: true, tag: 'strong', number: '12' }, 'parsed: closing, lowercased tag, digits');
});

// 把一段译文里认得出的标记全部规整成 `/span13` 这种标准写法
const parsedMarkers = (text) => [...text.matchAll(TM.markerParsePattern())].map((m) => {
  const { closing, tag, number } = TM.parseMarker(m);
  return `${closing ? '/' : ''}${tag}${number}`;
});

test('a marker the model broke up with " . " still parses as the marker it was', () => {
  // 实测 Chrome 内置 NMT en→pt，Wikipedia「Football」首段的三个引注 [1][2][3]：
  // 每个引注是 sup > a > span > span.cite-bracket，发出去 10 个标记，回来两个被
  // 插了 ` . `，原样印在了读者眼前。
  assert.deepEqual(parsedMarkers('[1][</span1 . 3>2]<span1 . 7>[3]'), ['/span13', 'span17']);
  // 同一页上其它被插坏的形状：句点插进编号、标签名、斜杠前后、结尾，斜杠后的空格
  assert.deepEqual(
    parsedMarkers('</span8. 1> </sup1 . 05> </s . pan48> </su . p13> <a . 38> < . /span16> </spa . N132> </span11 . > <sup . 47> </ span9>'),
    ['/span81', '/sup105', '/span48', '/sup13', 'a38', '/span16', '/span132', '/span11', 'sup47', '/span9']);
});

test('a dotted marker is still only debris when its tag and numbers were issued', () => {
  const scrub = TM.debrisScrubber([...spans(19), { tag: 'sup', index: 5 }]);
  assert.equal(scrub('[1][</span1 . 3>2]<span1 . 7>[3]'), '[1][2][3]');
  // 本块没发过 b；200 也拆不成本块发过的编号（1…19 里没有 0、00、200）：页面的字，不动
  assert.equal(scrub('HTML 里 <b . 9> 不动'), 'HTML 里 <b . 9> 不动');
  assert.equal(scrub('</span2 . 00>'), '</span2 . 00>');
  // 普通的句点、尖括号还是普通的字
  assert.equal(scrub('a < b. 3 > 2.'), 'a < b. 3 > 2.');
});

test('a long run of dots and spaces inside a would-be marker is judged without backtracking', () => {
  const started = performance.now();
  const junk = ' .'.repeat(20000);
  for (const text of [`<${junk}`, `<a${junk}`, `<a${junk}1${junk}`, `<a1${junk}`, `</${junk}a${junk}`]) {
    assert.equal(TM.hasMarkers(text), false, text.slice(0, 12));
  }
  assert.ok(performance.now() - started < 1000, 'a run of separators took too long');
});

test('hasMarkers answers with the two patterns the insert path parses, and nothing wider', () => {
  // 落笔时会被当成结构的：占位符、标记（开闭、大写、括号里带空白或句点都算，
  // 和 insert.js 的宽松解析一致）。用户写进术语表的字靠它拒收（D-387）。
  for (const text of ['{{1}}', 'x {{12}} y', '<a1>', '</a1>', '<A1>', '< a 1 >', '</ strong2 >', '<h1>', '</span1 . 3>', '<No. 1>']) {
    assert.equal(TM.hasMarkers(text), true, text);
  }
  // 普通的花括号、尖括号不是记号：没有编号就不是
  for (const text of ['a < b', 'a > b', '{x}', '{{x}}', '{1}', '<div>', '<a>', '</b>', '<1>', 'x->y', '', null, undefined]) {
    assert.equal(TM.hasMarkers(text), false, String(text));
  }
});

// ------------------------------------------------------- 渲染路径只用逐块清理

test('the reader-facing strip is the narrow one, the analysis strips are the broad one', () => {
  // 渲染路径（buildTranslationContent 的 emit、受管容器的 ::after）只能用
  // debrisScrubber；用笼统的 markerPattern / strip 就会删掉页面正文里本来就有的 <b2>。
  const insert = read('content/page/insert.js');
  const build = insert.slice(insert.indexOf('function buildTranslationContent'));
  // 注释里提名字是可以的，这里要看的是代码里真的用了哪条
  const body = build.slice(0, build.indexOf('\n  // 向后兼容的旧签名'))
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(body, /TextMarkers\.debrisScrubber\(markupElements\)/,
    'buildTranslationContent no longer scrubs debris before rendering');
  assert.doesNotMatch(body, /markerPattern|TextMarkers\.strip/,
    'the render path must not use the broad pattern — it eats the page\'s own prose');

  const managed = insert.slice(insert.indexOf('ctx.renderManagedTranslation(') - 700,
    insert.indexOf('ctx.renderManagedTranslation(') + 200);
  assert.match(managed, /TextMarkers\.debrisScrubber\(block\.markupElements\)/,
    'the managed ::after path fell back to the broad pattern');
});

test('language detection strips through TextMarkers, and nobody reads ctx.MARKUP_MARKER_RE any more', () => {
  assert.match(read('content/content-language.js'), /TextMarkers\.strip\(/);
  const readers = [];
  for (const rel of sourceFiles()) {
    if (read(rel).includes('MARKUP_MARKER_RE')) readers.push(rel);
  }
  assert.deepEqual(readers, [], 'the old shelf name is back');
});

// 一块发出去 n 个同名标记：span1 … spann。
const spans = (n) => Array.from({ length: n }, (_, i) => ({ tag: 'span', index: i + 1 }));

test('the scrubber only ever removes tags and numbers this block handed out', () => {
  // 本块发出去的是 a1 和 strong2
  const scrub = TM.debrisScrubber([{ tag: 'a', index: 1 }, { tag: 'strong', index: 2 }]);

  // 自己的字：发过的标签名 + 发过的编号，无论怎么串、什么大小写、夹不夹空格
  assert.equal(scrub('请阅读<a1>文档</a1>。'), '请阅读文档。');
  assert.equal(scrub('请阅读<A1>文档</a1>。'), '请阅读文档。');
  assert.equal(scrub('请阅读< a1 >文档</ a1 >。'), '请阅读文档。');
  assert.equal(scrub('串错了的<strong1>也是残骸'), '串错了的也是残骸');

  // 页面自己的字：没发过 b，也没发过 9，一个都不能动
  assert.equal(scrub('HTML 里 <b9> 是什么意思？'), 'HTML 里 <b9> 是什么意思？');
  assert.equal(scrub('<div1> 不在标记集里'), '<div1> 不在标记集里');

  const none = TM.debrisScrubber([]);
  assert.equal(none('<a1>原样</a1>'), '<a1>原样</a1>', 'no markers issued → nothing to scrub');
  assert.equal(TM.debrisScrubber(null)('<a1>'), '<a1>');
});

test('a marker whose number the model fused or doubled is still debris', () => {
  // 实测：Reddit 卡片头发出 span1…span13，内置引擎把 <span11> 写回成 <span1111>，
  // 一个编号都配不上，原样显示给了读者。
  const scrub = TM.debrisScrubber(spans(13));
  assert.equal(scrub('4 小时前 帖子<span1111>报告'), '4 小时前 帖子报告');
  // 两个相邻标记粘成一个：<span12><span13> → <span1213>
  assert.equal(scrub('奖励<span1213>分享'), '奖励分享');
  assert.equal(scrub('奖励</span1213>分享'), '奖励分享');
});

test('a fused number that does not split into this block\'s own numbers is left alone', () => {
  // 只发过 span1…span3：99 拆不成 1/2/3，0 不是任何编号——不是本块的字，不动
  const scrub = TM.debrisScrubber(spans(3));
  assert.equal(scrub('<span99>'), '<span99>');
  assert.equal(scrub('<span0>'), '<span0>');
  assert.equal(scrub('<span124>'), '<span124>', '4 was never issued');
  // 标签名不对，编号再对也不动
  assert.equal(scrub('<b12>'), '<b12>');
});

test('a long run of digits is judged in linear time, not by backtracking', () => {
  // 编号 1、11 互为前缀；写进正则的交替会在这种串上指数回溯
  const scrub = TM.debrisScrubber(spans(11));
  const digits = '1'.repeat(5000);
  const started = performance.now();
  assert.equal(scrub(`<span${digits}>`), '');
  // 0 不是任何编号的开头，00、100 也都没发过：整串拆不开，得一路判到底才知道
  assert.equal(scrub(`<span${digits}00>`), `<span${digits}00>`);
  assert.ok(performance.now() - started < 1000, 'splitting a long number took too long');
});

// ------------------------------------------------------- 扫描守卫

const OWNER = 'shared/text-markers.js';
const sourceFiles = () => productSourceFiles().filter((rel) => rel !== OWNER);

// 按「正则字面量 / 拼接模板」判，不按字符串判：background/prompts.js 给模型看的
// 说明文字里写着 {{1}}、<a1>，那是给模型读的字，不是第二份语法。
const LITERALS = [
  ['placeholder regex source', /\\\{\\\{/],
  ['placeholder template', /\{\{\$\{/],
  ['marker template', /<\/?\$\{/],
  ['marker regex source', /\[a-z\]\+\)?(?:\\s\*)?\(?\\d\+/],
];

test('no placeholder or marker grammar outside shared/text-markers.js and test/', () => {
  const hits = [];
  for (const rel of sourceFiles()) {
    read(rel).split('\n').forEach((line, i) => {
      for (const [what, re] of LITERALS) {
        if (re.test(line)) hits.push(`${rel}:${i + 1} [${what}] ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(hits, [], 'ask TextMarkers instead of writing the grammar again');
});

test('the scan would catch the grammar it guards against', () => {
  // 守卫自己的反例：每条规则都要认得出迁移前真实存在过的写法
  const before = [
    'const MARKUP_MARKER_RE = /<\\/?[a-z]+\\d+>/gi;',
    "const markerRe = /<\\s*(\\/?)\\s*([a-z]+)\\s*(\\d+)\\s*>/gi;",
    'const placeholderRe = /\\{\\{(\\d+)\\}\\}/g;',
    'const placeholder = `{{${mathIndex}}}`;',
    'const open = `<${tag}${index}>`;',
    'text += `</${tag}${index}>`;',
  ];
  for (const line of before) {
    assert.ok(LITERALS.some(([, re]) => re.test(line)), `the scan misses: ${line}`);
  }
  // 给模型看的说明文字不算
  assert.ok(!LITERALS.some(([, re]) => re.test('Keep placeholders like {{1}} and tags like <a1> unchanged.')));
});

// ------------------------------------------------------- 加载顺序

test('text-markers loads before content-language.js in the manifest and the e2e page harness', () => {
  const manifest = JSON.parse(read('manifest.json'));
  let seen = 0;
  for (const cs of manifest.content_scripts) {
    const order = cs.js || [];
    const at = order.indexOf('content/content-language.js');
    if (at < 0) continue;
    seen += 1;
    const dep = order.indexOf(OWNER);
    assert.ok(dep >= 0 && dep < at, `${cs.matches} loads content-language.js before ${OWNER} (or not at all)`);
  }
  assert.ok(seen > 0, 'no content script list loads content-language.js');

  const helpers = read('test/e2e/helpers.js');
  const start = helpers.indexOf('const PAGE_TRANSLATION_MODULES = Object.freeze([');
  assert.notEqual(start, -1);
  const list = [...helpers.slice(start, helpers.indexOf('])', start)).matchAll(/'([^']+\.js)'/g)].map((m) => m[1]);
  const at = (file) => list.indexOf(file);
  assert.ok(at(OWNER) !== -1, `PAGE_TRANSLATION_MODULES does not load ${OWNER}`);
  assert.ok(at(OWNER) < at('content/content-language.js'));
});
