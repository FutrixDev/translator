// 自动翻译这条链路由五个文件拼起来，彼此之间靠的是「装载顺序」和「同一个全局
// 对象」——两样都不是 import，编辑器不会提醒，跑起来才发现少了一块。这一组测试
// 守的就是这些接缝：没有一条在测翻译本身，测的是「零件都在，而且只有一份」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
// 这些断言问的是「代码里有没有这一句」，而这些文件的注释里恰恰把该规则原原本本
// 讲了一遍 —— 不剥注释，每一条都会被自己的说明文字匹配上。
//
// 先剥行注释再剥块注释，顺序不能反：行注释里出现的 `content/page/*` 会被当成一个
// 块注释的开头，一路吃到下一个真正的 `*/`，中间的代码就此消失。
const code = (rel) => read(rel)
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');

const manifest = JSON.parse(read('manifest.json'));
const isolated = manifest.content_scripts.find((entry) => (entry.world || 'ISOLATED') === 'ISOLATED').js;

await import('../../shared/default-settings.js');
const { DefaultSettings } = globalThis;

test('两个新模块都装进了 manifest', () => {
  assert.ok(isolated.includes('content/content-auto-discover.js'));
  assert.ok(isolated.includes('content/content-auto-translate.js'));
});

test('调度层读的全局，都由排在它前面的文件提供', () => {
  const source = read('content/content-auto-translate.js');
  const providers = {
    SessionGuard: 'shared/session-guard.js',
    BlockIdentity: 'shared/block-identity.js',
    SiteRules: 'shared/site-rules.js',
    SpaNavigation: 'shared/spa-navigation.js'
  };
  const at = isolated.indexOf('content/content-auto-translate.js');
  for (const [name, file] of Object.entries(providers)) {
    assert.match(source, new RegExp(`globalThis\\.${name}`), `${name} 应当是调度层用到的`);
    const provided = isolated.indexOf(file);
    assert.ok(provided >= 0, `${file} 不在装载清单里`);
    assert.ok(provided < at, `${file} 必须排在调度层之前`);
  }
});

test('默认设置里有自动翻译的三个键，而且总开关默认开', () => {
  const defaults = DefaultSettings.contentDefaults();
  assert.equal(defaults.autoTranslate, true);
  assert.deepEqual(defaults.siteRules, {});
  assert.deepEqual(defaults.autoTranslateLangs, []);
});

test('容器型默认值每次给一份新的：一处记下站点规则不会污染下一处', () => {
  const a = DefaultSettings.contentDefaults();
  const b = DefaultSettings.contentDefaults();
  assert.notEqual(a.siteRules, b.siteRules);
  assert.notEqual(a.autoTranslateLangs, b.autoTranslateLangs);
  a.siteRules['example.com'] = 'always';
  a.autoTranslateLangs.push('en');
  assert.deepEqual(b.siteRules, {});
  assert.deepEqual(b.autoTranslateLangs, []);
  // 源头本身是冻的，谁想就地改它都会当场抛，而不是悄悄改掉所有人的默认值。
  assert.throws(() => { DefaultSettings.CONTENT_DEFAULTS.siteRules['x.com'] = 'never'; }, TypeError);
});

test('译文写回页面只有一个入口 —— 迟到校验才不会漏在某一条路径上', () => {
  const source = code('content/page/batch.js');
  const calls = source.match(/ctx\.insertTranslationBlock\(/g) || [];
  assert.equal(calls.length, 1, '三条插入路径都要走 insertTranslation()');
  assert.match(source, /function insertTranslation\(block, translation, accept\)/);
  assert.match(source, /if \(accept && !accept\(block\)\) return;/);
});

test('语言判定的阈值只有一处，且调度层用的是同一个函数', () => {
  const batch = code('content/page/batch.js');
  assert.equal((batch.match(/LANGUAGE_CONFIDENCE_MIN/g) || []).length, 2, '一处定义一处使用');
  assert.match(batch, /ctx\.detectReliableLanguage = detectReliableLanguage;/);

  const scheduler = code('content/content-auto-translate.js');
  assert.match(scheduler, /ctx\.detectReliableLanguage\(/);
  assert.doesNotMatch(scheduler, /detectLanguage\s*\(/, '调度层不该自己再探一次语言');
  assert.doesNotMatch(scheduler, /\b85\b/, '调度层不该有第二套把握程度阈值');
});

test('该不该翻只由 SiteRules.decide 回答，调度层不自己搭一条阶梯', () => {
  const scheduler = code('content/content-auto-translate.js');
  assert.match(scheduler, /SiteRules\.decide\(/);
  // 有人图省事在这里补一条「黑名单也拦一下」，两处判断就开始各说各话。
  assert.doesNotMatch(scheduler, /blocklist|isBlocked/i);
});

test('发现层只回答「轮到谁了」：不发请求，也不碰页面状态', () => {
  const discover = code('content/content-auto-discover.js');
  assert.doesNotMatch(discover, /runTranslationPass|requestTranslation|insertTranslationBlock/);
  assert.doesNotMatch(discover, /ctx\.state\b/);
});

test('自己插的译文不算页面变了 —— 否则翻译会把自己再触发一遍', () => {
  const discover = code('content/content-auto-discover.js');
  assert.match(discover, /ai-translator-inline-block/);
  assert.match(discover, /function ownMutation\(record\)/);
  // 文本裹套用的 class 挂在页面自己的文字上，认作我们的就会让页面后续的改动
  // 全部失声。见该文件 OWN_UI_SELECTOR 上方的注释。
  assert.doesNotMatch(discover, /ai-translator-text-run/);
});

test('管控容器的漏收计数，读的那一行紧挨着收集，中间没有 await', () => {
  const source = code('content/content-page-translation.js');
  const collect = source.indexOf('ctx.collectTranslatableBlocks(document.body)');
  const skip = source.indexOf('ctx.getManagedSkipCount()');
  assert.ok(collect >= 0 && skip > collect);
  assert.doesNotMatch(source.slice(collect, skip), /await/, '中间夹一次 await，读到的就可能是发现层那次收集的结果');
});

test('「已经是目标语言就别翻」这条设置，自动这一轮也认', () => {
  const scheduler = code('content/content-auto-translate.js');
  // 手动整页翻译在发请求前会先过这道滤网。自动这一轮绕过去，就是把用户明确说过
  // 不必发的文字，一屏一屏地替他发出去 —— 页面上还看不出任何异样。
  assert.match(scheduler, /ctx\.filterBlocksByLanguage\(/);
  assert.match(code('content/page/batch.js'), /ctx\.filterBlocksByLanguage = filterBlocksByLanguage;/);
});

test('自动这一轮不触发语言包下载 —— 它没有 user activation', () => {
  const batch = code('content/page/batch.js');
  // 三个请求点原本写死 true。写死了，自动那一轮就会去 create() 一个要下载的
  // 翻译器，换回 NotAllowedError，白等一次创建超时。
  assert.doesNotMatch(batch, /allowDownload:\s*true/);
  assert.match(batch, /const allowDownload = options\.allowDownload !== false;/);
  assert.match(code('content/content-auto-translate.js'), /allowDownload:\s*false/);
});

test('排队那一刻的原样文字和开跑时的实况对不上，这一块就不发', () => {
  const scheduler = code('content/content-auto-translate.js');
  // 虚拟列表把节点回收给下一条内容：拿旧文字去译、用新文字的指纹去验，验得过，
  // 于是错的译文被永久登记成这段新文字的译文。
  assert.match(scheduler, /source: guard\.stamp\(element\)\.textFingerprint/);
  assert.match(scheduler, /entry\.source !== ticket\.textFingerprint/);
  // 两边必须是同一个表示法。block.text 是「送去翻译的文本」——带公式占位符、
  // 内联标记，而且 trim 过；拿它去和 readSourceText 的指纹比，带链接的段落和
  // 所有含公式的段落会被一律丢掉，而且再也没有东西把它们送回来。
  assert.doesNotMatch(scheduler, /fingerprint\(block\.text\)/);
});

test('「隐藏译文」期间没有任何一条路能把自动翻译重开', () => {
  const scheduler = code('content/content-auto-translate.js');
  // 闩在 start() 里。换路由、改设置、用户表态都会重开一轮，漏一条就是一次
  // 「菜单写着已隐藏、页面上却自己冒出译文」—— 新插进去的译文不带
  // ai-translator-hidden，那个开关就此成了摆设。
  assert.match(
    scheduler,
    /function start\(why\) \{[\s\S]*?if \(ctx\.state\.translationsVisible === false\) \{\s*status = STATUS\.PAUSED;\s*return;\s*\}/
  );
  // 所以各个调用点不再各自判一遍 PAUSED。
  assert.doesNotMatch(scheduler, /if \(status === STATUS\.PAUSED\) return;\s*start\(/);

  // 把译文放出来的两条路都要通知到这一层：悬浮球的开关，和「翻译整页」。
  const visibility = code('content/page/visibility.js');
  assert.match(visibility, /\n    state\.translationsVisible = true;/);
  assert.match(visibility, /ctx\.autoTranslate\.resumeCurrentPage\(\)/);
  assert.match(code('content/content-float-ball.js'), /ctx\.autoTranslate\.pauseCurrentPage\(\)/);
});

test('上一代跑完的那一轮，不许改这一代的状态', () => {
  const scheduler = code('content/content-auto-translate.js');
  assert.match(scheduler, /const session = guard\.version\(\);/);
  assert.match(scheduler, /if \(guard\.version\(\) !== session\)/);
  // 挂起的是当时那一个，换了路由之后 discovery 已经是新的了。
  assert.match(scheduler, /const suspended = discovery;/);
  assert.doesNotMatch(scheduler, /if \(discovery\) discovery\.resume\(\);/);
});

test('换引擎也要重开一轮 —— 只作废不重扫，页面会一直空着', () => {
  const scheduler = code('content/content-auto-translate.js');
  const keys = scheduler.match(/const RESTART_KEYS = \[([^\]]*)\]/);
  assert.ok(keys, 'RESTART_KEYS 应当是一处列全的清单');
  for (const key of ['autoTranslate', 'siteRules', 'autoTranslateLangs', 'targetLang', 'translationEngine']) {
    assert.ok(keys[1].includes(`'${key}'`), `${key} 变了这一页要从头来过`);
  }
});

test('观察器按离视口的远近挑该观察谁，不按挂上的先后', () => {
  const discover = code('content/content-auto-discover.js');
  // 首次全量扫长文时所有元素在同一个任务里挂上，「最早挂上的」正是用户此刻
  // 看着的那一屏。
  assert.match(discover, /function distanceFromViewport\(element\)/);
  // 近的排在前面：留下的是前 MAX_OBSERVED 个。排反了就是把读者眼前那一屏换出去。
  assert.match(discover, /ranked\.sort\(\(a, b\) => a\.away - b\.away\)/);
  // 同步重排是在 IntersectionObserver 还没派发过一次回调的时候就动手。
  assert.match(discover, /rebalanceTimer = setTimeout\(rebalance, REBALANCE_DELAY_MS\)/);
});

test('挤不进观察器的块要记在一边，不能扔', () => {
  const discover = code('content/content-auto-discover.js');
  // 扔掉就再也回不来了：静态长文滚过去既不产生变动也不触发重扫，被扔掉的那
  // 一段永远是原文，而且页面上看不出任何异样。
  assert.match(discover, /const deferred = new Set\(\);/);
  assert.match(discover, /if \(observed\.size >= MAX_OBSERVED\) \{\s*deferred\.add\(element\);/);
  // 三条把位置还给 deferred 的路：进带即摘腾出位置、读者一跃跳走、重排换人。
  // 缺一条就有一类页面翻不全。
  assert.match(discover, /function unwatch\(element\) \{[\s\S]*?scheduleRebalance\(\);/);
  assert.match(discover, /function onScroll\(\) \{[\s\S]*?scheduleRebalance\(\);/);
  assert.match(discover, /deferred\.delete\(entry\.element\);\s*observed\.add\(entry\.element\);\s*bandObserver\.observe\(entry\.element\);/);
  // 停掉时两个集合都要清，滚动监听也要摘。
  assert.match(discover, /deferred\.clear\(\);/);
  assert.match(discover, /window\.removeEventListener\('scroll', onScroll, SCROLL_LISTENER\);/);
});

// 翻完了才拒，钱已经花掉。这一条钉的是「还要不要发下一批」。
test('换了路由或关掉自动翻译之后，在途的那一轮不再发下一批', () => {
  const batch = code('content/page/batch.js');
  // 「要不要停」只有一个答案：三处问的必须是同一个谓词，否则逐块回退那条路
  // 只认 batchError，外面喊停喊不动它。
  assert.match(batch, /const aborted = \(\) => !!batchError \|\| \(typeof options\.isAborted === 'function' && options\.isAborted\(\)\)/);
  assert.match(batch, /isAborted: aborted,/);
  // 早先那两处 `if (batchError) return;` 都要换成 aborted()，一处不换就是一个
  // 停不下来的口子。
  assert.doesNotMatch(batch, /if \(batchError\) return;/);
  assert.equal(batch.match(/if \(aborted\(\)\) return;/g).length, 2);

  const scheduler = code('content/content-auto-translate.js');
  assert.match(scheduler, /isAborted: \(\) => guard\.version\(\) !== session,/);
  // 探语言本身就是一串 await，回来时这一页可能已经不归这一轮管了 —— 那就一块
  // 都别发，而不是发完再一条条拒。
  assert.match(scheduler, /if \(fresh\.length > 0 && guard\.version\(\) === session\)/);
});

test('换页要让页面语言的缓存过期，且这件事归引擎自己管', () => {
  const engine = code('content/content-translation-engine.js');
  assert.match(engine, /SpaNavigation\.onRouteChange\(\(\) => \{\s*pageSourceLangPromise = null;/);
  // 缓存归引擎所有，过期也归它。放到自动翻译那一层去清的话，自动翻译关着的时候
  // 划词/悬停/字幕照样在用一份上一页的语言。
  assert.doesNotMatch(code('content/content-auto-translate.js'), /pageSourceLangPromise/);
  // 订阅要真订得上：引擎必须排在 spa-navigation 后面。
  assert.ok(
    isolated.indexOf('shared/spa-navigation.js') < isolated.indexOf('content/content-translation-engine.js'),
    'shared/spa-navigation.js 必须排在 content-translation-engine.js 前面'
  );
});
