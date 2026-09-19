// 内容身份：这个元素上挂着的译文，还是它现在这段文字的译文吗。
//
// 自动翻译要一直跟着页面跑，而 X / Reddit 是虚拟列表：滚动时同一个 DOM 节点被回收
// 去装下一条推文。此前「翻过了」只由源元素上的 `.ai-translator-translated` 记住，
// 那是**节点身份** —— 节点没变，class 还在，里面的文字已经是另一条内容了，于是新
// 内容被静默跳过：不报错、不重试、永远不翻。
//
// 这一组测试盯住三件事：
//   1. 指纹稳定且只对「文字变了」有反应（shared/block-identity.js）；
//   2. 算指纹时读到的是页面自己的文字，不含我们插进去的译文（ctx.readSourceText）；
//   3. 判定发生在正确的位置，撤除时该收的都收了（content/page/insert.js 的
//      releaseTranslation，以及它在 collect.js 里被调用的时机）。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// ==================== the faked browser ====================

globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
globalThis.window = {
  AI_TRANSLATOR_CONTENT: {
    constants: { MATH_CONTAINER_SELECTOR: '.katex' },
    settings: {},
    state: {},
    t: (key) => key,
  },
};
globalThis.document = {};
globalThis.chrome = {};

await import('../../shared/block-identity.js');
await import('../../content/page/collect.js');
await import('../../content/page/insert.js');

const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;
const { BlockIdentity } = globalThis;

function el(tag = 'DIV', children = []) {
  const classes = new Set();
  return {
    nodeType: 1,
    tagName: tag,
    childNodes: children,
    removed: false,
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    },
    remove() { this.removed = true; },
  };
}

function textNode(data) {
  return { nodeType: 3, textContent: data };
}

function withClass(node, ...names) {
  names.forEach((name) => node.classList.add(name));
  return node;
}

// ==================== 指纹 ====================

test('the same text hashes the same, different text does not', () => {
  assert.equal(BlockIdentity.fingerprint('Hello there'), BlockIdentity.fingerprint('Hello there'));
  assert.notEqual(BlockIdentity.fingerprint('Hello there'), BlockIdentity.fingerprint('Hello there!'));
  assert.match(BlockIdentity.fingerprint('anything'), /^[0-9a-f]{8}$/);
  // 空字符串也要有个确定的值：没读到文字的块一样要能登记、能比对。
  assert.match(BlockIdentity.fingerprint(''), /^[0-9a-f]{8}$/);
});

test('whitespace is folded, because re-rendering the same tweet reflows it', () => {
  assert.equal(
    BlockIdentity.fingerprint('  Hello\n   there  '),
    BlockIdentity.fingerprint('Hello there'));
  // 组合字符的两种写法在页面上一模一样，不归一化就是两个 hash，同一条内容会被
  // 当成变了，翻完立刻重翻。
  assert.equal(BlockIdentity.fingerprint('café'), BlockIdentity.fingerprint('café'));
});

test('case is NOT folded — this asks whether the text changed, not whether it matches', () => {
  // 和 collect.js 的 normalizeComparableText 正相反：那边问「模型是不是把原文原样
  // 还回来了」，宽容才不会把大小写差异当成真译文；这边大小写变了就是变了。
  assert.notEqual(BlockIdentity.fingerprint('Hello'), BlockIdentity.fingerprint('hello'));
});

// ==================== 陈旧判定 ====================

test('an element nobody registered is not stale — it has nothing to be stale', () => {
  const node = el();
  assert.equal(BlockIdentity.lookup(node), undefined);
  assert.equal(BlockIdentity.isStale(node, BlockIdentity.fingerprint('whatever')), false);
});

test('a registered element goes stale exactly when its text changes', () => {
  const node = el();
  BlockIdentity.register(node, { fingerprint: BlockIdentity.fingerprint('First tweet') });
  assert.equal(BlockIdentity.isStale(node, BlockIdentity.fingerprint('First tweet')), false);
  assert.equal(BlockIdentity.isStale(node, BlockIdentity.fingerprint('Second tweet')), true);

  BlockIdentity.forget(node);
  assert.equal(BlockIdentity.lookup(node), undefined);
});

test('换了目标语言，挂着的译文就不是这一块的译文了', () => {
  // 第二种陈旧：文字一个字没变，可它下面那条译文是上一门语言的。不问这一问，
  // 用户把目标语言从中文改成日文之后，已经翻过的那一片永远停在中文 —— 收集那
  // 一层一看「登记过、指纹一致」就直接跳过，谁也不会把它送出去重翻。
  const node = el();
  const text = BlockIdentity.fingerprint('Ship it on Friday');
  BlockIdentity.register(node, { fingerprint: text, lang: 'zh-CN' });
  assert.equal(BlockIdentity.isStale(node, text, 'zh-CN'), false);
  assert.equal(BlockIdentity.isStale(node, text, 'ja'), true);
});

test('语言这一维只在两边都说得出来时才问', () => {
  // 两头都要能退回从前。登记时没说语言（lang: null），或者问的人没带目标语言，
  // 都按「不问这一问」算 —— 顶多回到旧行为（旧译文继续挂着）。
  //
  // 反过来把「没说」当成某个具体值（比如空串）就是灾难：每一块都判成陈旧 →
  // 放开 → 重翻 → 再登记 → 再判陈旧，一个烧钱的死循环，而且页面上看着一切正常。
  const unsaid = el();
  const text = BlockIdentity.fingerprint('Ship it on Friday');
  BlockIdentity.register(unsaid, { fingerprint: text });
  assert.equal(BlockIdentity.lookup(unsaid).lang, null);
  assert.equal(BlockIdentity.isStale(unsaid, text, 'ja'), false);

  const said = el();
  BlockIdentity.register(said, { fingerprint: text, lang: 'zh-CN' });
  assert.equal(BlockIdentity.isStale(said, text), false);
  assert.equal(BlockIdentity.isStale(said, text, null), false);
});

test('文字变了就是变了，语言一致也救不回来', () => {
  // 两问互不吞没：指纹这一问答「这个节点是不是被回收给另一条内容了」，先问、
  // 且一票否决。把语言揉进指纹就再也分不开这两件事。
  const node = el();
  BlockIdentity.register(node, { fingerprint: BlockIdentity.fingerprint('First tweet'), lang: 'zh-CN' });
  assert.equal(BlockIdentity.isStale(node, BlockIdentity.fingerprint('Second tweet'), 'zh-CN'), true);
});

// ==================== 读的是页面自己的文字 ====================

test('the source text comes from the whole subtree — X nests its tweet text in spans', () => {
  // [data-testid="tweetText"] 里没有一个直接文本子节点。只读直接子文本（旧的
  // getDirectText）会得到空串，整列推文指纹相同，回收一次也认不出来。
  const tweet = el('DIV', [
    el('SPAN', [textNode('Ship it ')]),
    el('SPAN', [el('SPAN', [textNode('on Friday')])]),
  ]);
  assert.equal(ctx.readSourceText(tweet), 'Ship it on Friday');
  assert.notEqual(BlockIdentity.fingerprint(ctx.readSourceText(tweet)), BlockIdentity.fingerprint(''));
});

test('our own translation node is not part of the source text', () => {
  // 登记发生在译文已经进 DOM 之后，比对发生在下一轮发现时。两头读法必须一致，
  // 否则每个翻过的块都会被判成「内容变了」—— 翻完立刻重翻的烧钱死循环。
  const source = el('DIV', [textNode('Ship it on Friday')]);
  const before = ctx.readSourceText(source);
  source.childNodes.push(withClass(el('DIV', [textNode('周五发布')]), 'ai-translator-inline-block'));
  assert.equal(ctx.readSourceText(source), before);
});

test('a text-run anchor span is read, not skipped — the original lives inside it', () => {
  const source = el('DIV', [withClass(el('SPAN', [textNode('Ship it')]), 'ai-translator-text-run')]);
  assert.equal(ctx.readSourceText(source), 'Ship it');
});

test('a hover-translated child is page text, not ours — its class sits on the page\'s own node', () => {
  // `.ai-translator-inline-source` 打在页面自己的块上（悬停译过的那块），不是我们
  // 插的节点。跳掉它就是把真正的正文从指纹里抹去：这段字变了看不出来，而悬停标记
  // 被摘掉时指纹反倒凭空一变，白翻一遍。
  const marked = withClass(el('SPAN', [textNode('on Friday')]), 'ai-translator-inline-source');
  const source = el('DIV', [textNode('Ship it '), marked]);
  assert.equal(ctx.readSourceText(source), 'Ship it on Friday');
});

// ==================== 撤除 ====================

test('releasing a recycled block takes the translation, the source-hiding and the mark', () => {
  const released = [];
  ctx.releaseSourceForTranslation = (node) => released.push(node);

  const source = el('DIV', [textNode('First tweet')]);
  const translation = el('DIV', [textNode('第一条')]);
  source.classList.add('ai-translator-translated');
  BlockIdentity.register(source, {
    fingerprint: BlockIdentity.fingerprint('First tweet'),
    translationEl: translation,
  });

  assert.equal(ctx.releaseTranslation(source), true);
  assert.equal(translation.removed, true, 'the stale translation is still on the page');
  // 为译文让出位置而藏起来的原文要放回去，不然新内容连原文都不显示。
  assert.deepEqual(released, [translation]);
  // 这个 class 是发现层 closest() 串里的一员：留着的话，放开的块下一轮照样被跳过。
  assert.equal(source.classList.contains('ai-translator-translated'), false);
  assert.equal(BlockIdentity.lookup(source), undefined);
});

test('a managed (::after) translation is released through its own path', () => {
  const dropped = [];
  ctx.releaseManagedTranslation = (handle) => { dropped.push(handle); return true; };
  ctx.releaseSourceForTranslation = () => assert.fail('a ::after translation hides no source');

  const source = el('DIV', [textNode('First tweet')]);
  const handle = el('SPAN');
  source.classList.add('ai-translator-translated');
  BlockIdentity.register(source, { fingerprint: BlockIdentity.fingerprint('First tweet'), translationEl: handle, managed: true });

  assert.equal(ctx.releaseTranslation(source), true);
  // 句柄自己 remove() 不会让 ::after 消失 —— 规则和原文块上的标记都在那边收。
  assert.deepEqual(dropped, [handle]);
  assert.equal(handle.removed, false);
});

test('releasing an element that was never translated is a no-op, not a crash', () => {
  assert.equal(ctx.releaseTranslation(el()), false);
});

// ==================== 接线 ====================

test('the recycle check runs before the closest() that would swallow it', () => {
  const source = repoFile('content/page/collect.js');
  const check = source.indexOf('identity.lookup(element)');
  const closest = source.indexOf(".closest('.ai-translator-popup");
  assert.ok(check !== -1, 'processElement no longer asks whether this block was recycled');
  assert.ok(closest !== -1, 'the skip chain moved; re-check where the recycle test belongs');
  // closest() 从元素自己开始找，而它的选择器串里就有 `.ai-translator-translated`。
  // 排在它后面，回收的块会先被当成「已翻译」挡掉，陈旧判定再也没机会发生。
  assert.ok(check < closest, 'the recycle check sits behind the class check that hides it');
});

test('every insertion registers an identity — including the one with no node to insert', () => {
  const source = repoFile('content/page/insert.js');
  const body = source.slice(source.indexOf('function insertTranslationBlock'));
  // 四种有节点的形态都汇进 finishTranslationInsert，受管 ::after 那条没有节点，
  // 走不到那里，所以它必须自己登记一次。
  assert.match(body, /registerTranslation\(element, handle, true, lang\)/,
    'the managed (::after) branch inserts a translation nobody can later release');
  assert.match(source, /function finishTranslationInsert\(element, translationEl, sourceWidthBefore, lang\) \{\s*\n\s*registerTranslation\(element, translationEl, false, lang\);/,
    'the shared post-insert path no longer registers the block identity');
});

test('block-identity loads before the modules that use it', () => {
  const manifest = JSON.parse(repoFile('manifest.json'));
  const list = manifest.content_scripts.find((cs) => (cs.js || []).includes('shared/block-identity.js')).js;
  const at = (file) => list.indexOf(file);
  assert.ok(at('shared/block-identity.js') < at('content/page/collect.js'));
  assert.ok(at('shared/block-identity.js') < at('content/page/insert.js'));
});

// e2e 的 DOM 夹具（test/e2e/helpers.js）是 manifest 之外的第二份加载清单，
// 而它漏一个模块的报错形状和 manifest 完全不同：报的是三步之后
// `Cannot read properties of undefined (reading 'lookup')`，堆栈指着 collect.js，
// 一次打挂四个 spec，看起来像整页翻译坏了。PR-3 就是这么挂的一轮。
//
// 这条守卫是通用的，不只看 BlockIdentity：清单里的模块每引用一个
// `globalThis.X`，就必须有前面某个文件把 X 挂上去。PR-4 的缓存、PR-5 的导航
// 信号往 shared/ 加模块时，忘了这份清单会当场红，而不是留给 e2e 慢慢发现。
test('the e2e DOM harness provides every global its modules reach for', () => {
  const helpers = repoFile('test/e2e/helpers.js');
  const listOf = (name) => {
    const at = helpers.indexOf(`const ${name} = Object.freeze([`);
    assert.ok(at !== -1, `${name} moved or changed shape; this guard can no longer read it`);
    const body = helpers.slice(at, helpers.indexOf('])', at));
    return [...body.matchAll(/'([^']+\.js)'/g)].map((m) => m[1]);
  };

  const files = [...listOf('CONTENT_HARNESS_PRELUDE'), ...listOf('PAGE_TRANSLATION_MODULES')];
  const provided = new Set();
  for (const file of files) {
    const source = repoFile(file);
    for (const m of source.matchAll(/globalThis\.([A-Za-z_$][\w$]*)/g)) {
      const name = m[1];
      // 同一个文件里 `root.X = …` 的 root 就是 globalThis，所以先收后查：
      // 读取只在运行时发生，而挂载在加载时发生。
      assert.ok(
        provided.has(name) || new RegExp(`(root|globalThis)\\.${name}\\s*=`).test(source),
        `${file} 读 globalThis.${name}，但夹具清单里它前面没有任何文件提供它`
      );
    }
    for (const m of source.matchAll(/(?:root|globalThis)\.([A-Za-z_$][\w$]*)\s*=/g)) provided.add(m[1]);
  }
  // 清单真的被读到了，否则上面的循环空转也会绿。
  assert.ok(provided.has('BlockIdentity'), 'the harness list no longer loads shared/block-identity.js');
});
