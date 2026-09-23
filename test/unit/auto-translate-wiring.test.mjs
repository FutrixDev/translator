// 自动翻译这条链路由五个文件拼起来，彼此之间靠的是「装载顺序」和「同一个全局
// 对象」——两样都不是 import，编辑器不会提醒，跑起来才发现少了一块。这一组测试
// 守的就是这些接缝：没有一条在测翻译本身，测的是「零件都在，而且只有一份」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineSource, familyPaths, workerSource } from './helpers/sources.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
// 这些断言问的是「代码里有没有这一句」，而这些文件的注释里恰恰把该规则原原本本
// 讲了一遍 —— 不剥注释，每一条都会被自己的说明文字匹配上。
//
// 先剥行注释再剥块注释，顺序不能反：行注释里出现的 `content/page/*` 会被当成一个
// 块注释的开头，一路吃到下一个真正的 `*/`，中间的代码就此消失。
const strip = (source) => source
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');
const code = (rel) => strip(read(rel));
// service worker 拆成了一组模块（background/*.js），一个 handler 落在哪个文件里
// 是实现细节 —— 这里问的都是「worker 有没有这么做」，所以整份读它。
const workerCode = () => strip(workerSource());
// 翻译引擎也是一族（content/engine/*.js 加入口），同样整族读。
const engineCode = () => strip(engineSource());

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
    SpaNavigation: 'shared/spa-navigation.js',
    AutoStats: 'shared/auto-stats.js'
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
  // 签名本身由「台账等结果再记」那一条钉住（它还要求同一个口子报 onSettled）。
  assert.match(source, /async function insertTranslation\(\s*\n\s*block, translation, \{/);
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
  //
  // 拦的是**开始翻**，不是**重新判**：setStatus 紧跟着 return，这一闩里一行翻译
  // 都跑不了；而判定照常跟上，否则 popup 上那个站点开关会一直停在「开」。
  assert.match(
    scheduler,
    /function start\(why\) \{[\s\S]*?if \(ctx\.state\.translationsVisible === false \|\| pausedByUser\) \{[\s\S]*?const held = resolve\(pageLang\);\s*reason = held\.reason;\s*setStatus\(held\.verdict === 'off' \? STATUS\.OFF : STATUS\.PAUSED\);\s*return;\s*\}/
  );
  // 所以各个调用点不再各自判一遍 PAUSED。
  assert.doesNotMatch(scheduler, /if \(status === STATUS\.PAUSED\) return;\s*start\(/);

  // 显隐只有一个出处：content/page/visibility.js。它两边都通知到 —— 放出来是
  // resume，藏起来是 pause。
  const visibility = code('content/page/visibility.js');
  assert.match(visibility, /function setTranslationsVisible\(visible\)/);
  // 两下都报上名来：这是显隐干的。停不上闩、继续也不解闩 —— 他在 popup 上按下
  // 的那句「这一页先别翻了」不归这个开关撤销（见 auto-status-wiring 那一条）。
  assert.match(visibility, /ctx\.autoTranslate\.resumeCurrentPage\('hidden'\)/);
  assert.match(visibility, /ctx\.autoTranslate\.pauseCurrentPage\('hidden'\)/);
  // 悬浮球和「翻译整页」都走它，不自己动 state.translationsVisible ——
  // 自己写那个字段就是把暂停这一半漏掉，而漏掉的症状要等到下一轮才看得见。
  for (const file of ['content/content-float-ball.js', 'content/content-page-translation.js']) {
    const source = code(file);
    assert.match(source, /ctx\.setTranslationsVisible\(/, `${file} 应当走共用的显隐入口`);
    assert.doesNotMatch(source, /state\.translationsVisible\s*=(?!=)/, `${file} 不该自己写显隐字段`);
    assert.doesNotMatch(source, /autoTranslate\.(pause|resume)CurrentPage/, `${file} 不该越过显隐层直接停调度`);
  }
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
  // 只钉方向，不钉这句怎么写 —— 相等短路那一段归下面「没有布局盒子的候选」那条。
  assert.match(discover, /ranked\.sort\(\(a, b\) => .*a\.away - b\.away/);
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
  assert.match(discover, /function onScroll\(event\) \{[\s\S]*?scheduleRebalance\(\);/);
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
  const engine = engineCode();
  assert.match(engine, /SpaNavigation\.onRouteChange\(\(\) => \{\s*pageSourceLangPromise = null;/);
  // 缓存归引擎所有，过期也归它。放到自动翻译那一层去清的话，自动翻译关着的时候
  // 划词/悬停/字幕照样在用一份上一页的语言。
  assert.doesNotMatch(code('content/content-auto-translate.js'), /pageSourceLangPromise/);
  // 订阅要真订得上：引擎这一族（订阅是在装载时做的）必须整族排在 spa-navigation 后面。
  for (const file of familyPaths('content/engine', 'content/content-translation-engine.js')) {
    assert.ok(isolated.indexOf(file) >= 0, `${file} 不在内容脚本里`);
    assert.ok(
      isolated.indexOf('shared/spa-navigation.js') < isolated.indexOf(file),
      `shared/spa-navigation.js 必须排在 ${file} 前面`
    );
  }
});

test('跳转这道门量的是真正在滚的那个容器，不是 window', () => {
  const discover = code('content/content-auto-discover.js');
  // 候选长在内部滚动容器里（侧栏、自己滚的信息流）时，滚它一样会派发到这个捕获
  // 监听上，但 window.scrollY 一动不动。门若只看 window，超出观察上限的那一截就
  // 永远卡在 deferred 里 —— 留下的块没有一个会进带，也没有别的路会排重排。
  assert.match(discover, /const target = scrollTargetOf\(event\);/);
  assert.doesNotMatch(discover, /const now = window\.scrollY;/);
  // 门槛取这个容器自己的一屏高，位置取它自己的 scrollTop。
  assert.match(discover, /return target === document \? window\.scrollY : target\.scrollTop;/);
  assert.match(discover, /return target\.clientHeight \|\| 0;/);
  // 页面滚动的 target 在各家浏览器里是 document / documentElement / scrollingElement，
  // 不归一成一个键的话，同一次滚动会分记两份记号，两份都到不了门槛。
  assert.match(discover, /target === document\.scrollingElement \|\| target === document\.documentElement/);
  // 记号按容器分开存，且存在 WeakMap 里 —— 容器是页面自己的节点，页面删掉它之后
  // 这里不该拦着不放。
  assert.match(discover, /let scrollMarks = new WeakMap\(\);/);
  assert.match(discover, /scrollMarks\.set\(target, now\);/);
  // 没见过的容器按「停在 0」算。改成「第一次先记下、这一次不算」就会吞掉一次跳转：
  // 一次跳转只派发一个 scroll 事件，那一次正好就是第一次。
  assert.match(discover, /const mark = scrollMarks\.get\(target\) \|\| 0;/);
  // 这个模块的包装是 (function () {，里面没有 root 这个绑定 —— 写 root 就是每次
  // 滚动抛一次 ReferenceError，而页面上看不出来。
  assert.match(discover, /^\(function \(\) \{/m);
  assert.doesNotMatch(discover, /target === root/);
});

test('「翻过了」要连目标语言一起问 —— 两个生产调用点都带第三个参数', () => {
  // 换目标语言时只把调度层重启一遍是不够的：页面上那些块的身份登记还在，指纹也
  // 没变，收集那一层一看「登记过、不陈旧」就直接跳过 —— 已经翻过的那一片永远停
  // 在上一门语言。所以答案放在**译文的身份**里，手动整页翻译因此一并修好。
  const identity = code('shared/block-identity.js');
  assert.match(identity, /function isStale\(element, currentFingerprint, targetLang\)/);
  // 两头都要能退回从前：漏传只是回到旧行为，绝不能把「没说」当成某个具体值 ——
  // 那会让每一块都判成陈旧，放开、重翻、再登记、再判陈旧，一个烧钱的死循环。
  assert.match(identity, /if \(targetLang == null \|\| entry\.lang == null\) return false;/);
  assert.match(identity, /lang: entry && entry\.lang != null \? String\(entry\.lang\) : null,/);

  // 登记的那一刻记下译成了哪门语言，就在唯一的登记口（managed 和普通两条插入路
  // 径都经过它）。语言是**带进来**的，不是在那里现问的 —— 见下面「一轮翻译只认
  // 一门语言」。
  const insert = code('content/page/insert.js');
  assert.match(insert, /function registerTranslation\(element, translationEl, managed, lang\)/);
  // 落笔端只有一处能现问设置：裁决两轮同时在飞时谁说了算（supersedesExistingTranslation）。
  // 除它以外一处都不许有 —— 戳必须是发请求时的那一门语言，在这里现问就会把
  // 用户中途改的新语言盖在旧译文上，从此这一块指纹一致、语言「也一致」，再没
  // 人会把它重翻。
  const arbiterAt = insert.indexOf('function supersedesExistingTranslation');
  assert.ok(arbiterAt !== -1, '裁决者没了：两轮同时在飞时谁说了算？');
  const arbiterEnd = insert.indexOf('\n  }\n', arbiterAt);
  const arbiter = insert.slice(arbiterAt, arbiterEnd);
  assert.match(arbiter, /const current = ctx\.currentTargetLang \? ctx\.currentTargetLang\(\) : null;/);
  assert.match(arbiter, /return current != null && lang === current;/);
  assert.doesNotMatch(insert.slice(0, arbiterAt) + insert.slice(arbiterEnd), /currentTargetLang/);
  // 两个问「这块还算翻过吗」的地方都要带上目标语言。
  assert.match(code('content/page/collect.js'), /identity\.isStale\(element, identity\.fingerprint\(readSourceText\(element\)\), target\)/);
  assert.match(code('content/content-auto-translate.js'), /identity\.isStale\(element, textFingerprint, target\)/);

  // 目标语言的规范化归引擎所有（toApiLang 那套别名表只有一份）。
  assert.match(engineCode(), /ctx\.currentTargetLang = currentTargetLang;/);
  assert.ok(
    isolated.indexOf('content/content-translation-engine.js') < isolated.indexOf('content/page/insert.js'),
    'content-translation-engine.js 必须排在 page/insert.js 前面'
  );
});

test('台账等结果再记，且结果由翻译层报上来', () => {
  const batch = code('content/page/batch.js');
  // 「这一块有结果了」只有翻译层知道，而且要在唯一的写回口报 —— 模型把原文原样
  // 还回来（不用翻）和真的写回去了，同样是终局，漏报哪一种都会让那一块下一轮再
  // 花一次同样的钱。
  assert.match(batch, /async function insertTranslation\(\s*\n\s*block, translation, \{ accept, onSettled, target = passTarget\(\) \} = \{\}\s*\n\s*\)/);
  assert.equal((batch.match(/if \(onSettled\) onSettled\(block\);/g) || []).length, 2);
  assert.match(batch, /const onSettled = typeof options\.onSettled === 'function' \? options\.onSettled : null;/);

  const auto = code('content/content-auto-translate.js');
  // 发出去的那一刻不记账：批次失败一两次时这一轮不报错（MAX_BATCH_FAILURES 是
  // 3），那几块一个字都没翻 —— 先记账就是让它们永远被当成翻过了，页面上一片原文
  // 而且没有任何报错。所以整份文件里 `ledger.add` 只能有一处，就在 commit 里。
  assert.equal((auto.match(/ledger\.add\(/g) || []).length, 1);
  assert.match(auto, /inflight\.set\(element, \{ key, entry \}\);/);
  assert.match(auto, /onSettled: \(block\) => \{\s*\n\s*translated = true;\s*\n\s*commit\(block\.element\);\s*\n\s*\},/);
  // 「这一轮真的译出了东西」也只能从这同一个口子置起。放在发请求之前就是另一
  // 个方向的同一个错：一张只有一两批的小页面可以整页全失败而 error 仍是 null
  // （连错三批才报错），那一页一个字都没译出来，却会被记成「自动翻了一页」。
  assert.equal((auto.match(/translated = true;/g) || []).length, 1);
  assert.match(auto, /function commit\(element\) \{[\s\S]*?ledger\.add\(pending\.key\);/);
  // 被语言滤掉的是有意跳过，也是结果，同样要记。
  assert.match(auto, /for \(const block of blocks\) if \(!keep\.has\(block\.element\)\) commit\(block\.element\);/);
  // 代次翻篇和一轮收尾都要清空在途表：迟到的结果不能往新一代的台账里塞一笔。
  assert.equal((auto.match(/inflight\.clear\(\);/g) || []).length, 3);
});

test('「发给模型的字符数」一次调用记一笔，不多不少', () => {
  const bg = workerCode();

  // 记在三个真发请求的函数上，不记在消息监听器里。监听器两头都漏：前面漏掉
  // `if (!settings.apiKey)` 那一关（没配 Key 时一个字符也没发出去，而自动翻译
  // 一页最多同时开 12 批，整页整页地虚记），后面漏掉快速分批分隔符对不上时的
  // 整批重发（一条消息两次调用）。
  for (const fn of ['handleTranslate', 'handleBatchTranslate', 'handleBatchTranslateFast']) {
    const body = bg.match(new RegExp(`async function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(body, `${fn} 不见了`);
    assert.match(body[0], /if \(!settings\.apiKey\) \{/, `${fn} 的前提变了，记账那一侧要跟着改`);
    assert.doesNotMatch(body[0], /countCharsSentToModel/, `${fn} 在 apiKey 那一关这一侧，记不得账`);
  }

  for (const fn of ['translateTextWithMode', 'translateBatchWithAI', 'translateBatchFastWithAI']) {
    const body = bg.match(new RegExp(`async function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(body, `${fn} 不见了`);
    assert.match(body[0], /countCharsSentToModel\(/, `${fn} 是一次真发出去的调用，要记一笔`);
  }

  // 回退那一次走的就是 translateBatchWithAI，于是自然记第二笔 —— 靠的是这一句，
  // 不是在回退处另记一笔。
  assert.match(bg, /return translateBatchWithAI\(texts, targetLang, settings\);/);
  // 求和只有一处（shared/auto-stats.js），三个调用点不各抄一遍。
  assert.equal((bg.match(/AutoStats\.textsChars\(/g) || []).length, 2);
  assert.equal((bg.match(/AutoStats\.add\(\{ aiChars/g) || []).length, 1);
  assert.doesNotMatch(bg, /countCharsSentToModel\(message\)/, '消息监听器不再记账');
});

test('设置页里两块别处写的数据，要跟着别处一起变', () => {
  const options = code('options/options.js');
  // 站点审计表是弹出窗口写的，本机统计是内容脚本和 worker 写的，而
  // openOptionsPage() 把已开着的标签页调到前面、不重新加载它。没有这一条订阅，
  // 用户刚在另一个标签页按下的「总是翻译」就不在表里，想撤回也无从撤起。
  const listener = options.match(/chrome\.storage\.onChanged\.addListener\([\s\S]*?\n  \}\);/);
  assert.ok(listener, '设置页没有订阅 storage.onChanged');
  assert.match(listener[0], /area === 'sync' && changes\.siteRules\) renderSiteRules\(\)/);
  // autoStats 在 local，不在 sync —— 盯错了区域就一个事件也收不到。
  assert.match(listener[0], /area === 'local' && changes\.autoStats\) renderAutoStats\(\)/);
});

test('改对了密钥/地址/模型/回落，停在错误上的那一页要自己重来', () => {
  const auto = code('content/content-auto-translate.js');
  const keys = auto.match(/const RESTART_KEYS = \[([\s\S]*?)\];/);
  assert.ok(keys, 'RESTART_KEYS 不见了');
  for (const key of ['autoTranslate', 'siteRules', 'autoTranslateLangs', 'targetLang',
    'skipTargetLanguageText', 'translationEngine',
    'apiKey', 'apiEndpoint', 'modelName', 'engineFallback']) {
    assert.ok(keys[1].includes(`'${key}'`), `RESTART_KEYS 少了 ${key}`);
  }
  // 名单在调度层，不在转发那一层 —— 在 bootstrap 里摊成一串 if 就是把它抄一遍，
  // 抄本迟早和正本对不上（这条规则正是因为那份「五个键」的注释过期才立的）。
  const bootstrap = code('content/content-bootstrap.js');
  assert.match(bootstrap, /if \(ctx\.autoTranslate\) ctx\.autoTranslate\.onSettingsChanged\(changes\);/);
  assert.doesNotMatch(bootstrap, /RESTART_KEYS/);
  // 这四个键真的是设置里存的那四个 —— 拼错一个，这条门就永远不开，而且没有任何
  // 迹象。engineFallback 归内容侧默认值管，另外三个归后台的 defaultSettings。
  assert.ok('engineFallback' in DefaultSettings.CONTENT_DEFAULTS);
  const declared = workerSource().match(/const defaultSettings = \{([\s\S]*?)\n\};/);
  assert.ok(declared, 'worker 的 defaultSettings 不见了');
  for (const key of ['apiKey', 'apiEndpoint', 'modelName']) {
    assert.match(declared[1], new RegExp(`^\\s*${key}:`, 'm'), `defaultSettings 里没有 ${key}`);
  }
});

// 这份名单历来是手写的，而漏一个的后果是静默的：设置改了、这一页不重来，台账里
// 那些 key 还在、元素早被发现层摘了，新设置永远轮不到它们。所以不再靠人记 ——
// 把「谁喂进了判定」从源头扫出来对账。
test('凡是喂进判定的设置键，都在 RESTART_KEYS 里', () => {
  const auto = code('content/content-auto-translate.js');
  const listed = auto.match(/const RESTART_KEYS = \[([\s\S]*?)\];/);
  assert.ok(listed, 'RESTART_KEYS 不见了');

  // 「这一页翻不翻」和「这一块翻不翻」，两个判定各自读了哪些设置键。
  const sources = {
    'shared/site-rules.js': /\bprefs\.([A-Za-z_$][\w$]*)/g,
    'content/page/batch.js': /\bsettings\.([A-Za-z_$][\w$]*)/g,
    // 调度层自己也读设置 —— 费用闸的预算（costRefusal）就只在这里出现，
    // decide() 一个都不认识。它在 ctx 上读，所以是另一个正则。
    'content/content-auto-translate.js': /\bctx\.settings\.([A-Za-z_$][\w$]*)/g,
    // 费用闸的另一半在引擎里：「自动模式这一刻走哪个引擎」由
    // isBuiltinSelected(auto) / canFallBackToAI() 回答，调度层只是问它。判定的
    // 入参因此有一段住在引擎那一族里，漏掉它就等于把那几个键从对账里摘掉。
    '翻译引擎那一族': /\bsettings\.([A-Za-z_$][\w$]*)/g
  };
  const readSource = (file) => (file === '翻译引擎那一族' ? engineCode() : code(file));
  // decide() 另外两个入参的出处：调用点从 ctx.settings 上取，名字和这里对不上。
  const viaParams = ['siteRules', 'targetLang'];
  // 读了但**故意**不重来的键写在这里，连同理由 —— 空着就是「一个也没有」。
  const deliberately = new Map();

  const found = new Set(viaParams);
  for (const [file, pattern] of Object.entries(sources)) {
    for (const hit of readSource(file).matchAll(pattern)) found.add(hit[1]);
  }
  assert.ok(found.has('skipTargetLanguageText'), '扫描没扫到已知的键，正则该修了');
  assert.ok(found.has('autoAiDailyBudget'), '费用闸的预算键没被扫到，第三条正则该修了');
  assert.ok(found.has('autoTranslateEngine'), '自动模式的引擎键没被扫到，第四条正则该修了');

  for (const key of found) {
    if (deliberately.has(key)) continue;
    assert.ok(
      listed[1].includes(`'${key}'`),
      `${key} 喂进了判定却不在 RESTART_KEYS 里；要么补进去，要么在 deliberately 里写明为什么不用`
    );
  }
});

test('这一轮没结果的块放回队列，但只放一次', () => {
  const auto = code('content/content-auto-translate.js');
  // 发现层「进带即摘」，一张静止的页面不会再有任何变动把它送回来 —— 所以调度层
  // 得亲自放回去，而且要连排队时那条 entry 一起放（takeBatch 拿 entry.source 认
  // 「这个节点被回收去装别的内容了」）。
  assert.match(auto, /queue\.set\(element, pending\.entry\)/);
  // 只给一次。不设这道闸，一个在某几块上稳定失败、又够不上 MAX_BATCH_FAILURES
  // 的接口会把这里变成每 250ms 一次的死循环。
  assert.match(auto, /if \(retried\.has\(pending\.key\)\)/);
  assert.match(auto, /retried\.add\(pending\.key\);/);
  // 放弃的那些走 commit，台账仍然只有一个写入口。
  assert.match(auto, /for \(const element of giveUp\) commit\(element\);/);
  assert.equal((auto.match(/ledger\.add\(/g) || []).length, 1);
  // 代次翻篇整本作废，重来的次数也一样。
  assert.match(auto, /function bumpSession\([\s\S]*?retried\.clear\(\);/);
});

test('语言包装好了，停在错误上的那一页要自己活过来', () => {
  const pack = code('content/content-language-pack.js');
  // 预取是这个内容脚本里唯一「先确认过没下、然后真的把它下下来」的地方，
  // 所以通知从那里发 —— 而且只在下载真的成功之后。
  assert.match(pack, /notifyLanguagePackReady\(\{ sourceLang: src, targetLang: tgt \}\)/);
  assert.match(pack, /ctx\.onLanguagePackReady = onLanguagePackReady;/);
  // 监听器自己抛不能把别的监听器带走。
  assert.match(pack, /function notifyLanguagePackReady\([\s\S]*?try \{[\s\S]*?\} catch/);

  const auto = code('content/content-auto-translate.js');
  // 调度层订阅，并且走 start() —— 它会把 broken 放掉、重新判、重新扫。只作废不
  // 重扫的话那些块进带时已经被摘了，页面就一直空着。
  assert.match(auto, /ctx\.onLanguagePackReady\(\(\) => start\('language-pack'\)\)/);
  // 这个文件漏在 manifest 外面，init() 里那句订阅会当场 TypeError —— 响是响，
  // 但整个初始化就断在那儿了，所以这一条直接钉住它在不在名单里。
  assert.ok(
    isolated.includes('content/content-language-pack.js'),
    'content-language-pack.js 必须在 manifest 的内容脚本名单里'
  );
});

test('没有布局盒子的候选排在最后，而不是和视口里的并列', () => {
  const discover = code('content/content-auto-discover.js');
  // rect 全零算出来是 -0，和「正在视口里」同一档；稳定排序会让文档靠前的隐藏块
  // 把 observed 的名额占满不放。
  assert.match(discover, /if \(rect\.width === 0 && rect\.height === 0\) return Infinity;/);
  // Infinity - Infinity 是 NaN，而返回 NaN 的比较函数排出来的顺序没有定义。
  assert.match(discover, /ranked\.sort\(\(a, b\) => \(a\.away === b\.away \? 0 : a\.away - b\.away\)\);/);
});

// ---- 一轮翻译只认一门语言 ------------------------------------------------
//
// 用户在一轮跑到一半时改了目标语言：早发出去的那几批拿回来的是**旧**语言的译文，
// 而落笔那一刻现问设置，问到的是**新**语言。旧译文盖上新戳，下一轮收集端一看
// 「语言没变」把这些块全跳过 —— 那一块永远停在旧语言上，页面上还看不出异样。
//
// 所以目标语言在 runTranslationPass 开跑时读一次，之后一路带着走。改设置不靠这
// 一轮去追，靠 RESTART_KEYS 另起一轮（见上面那条）。
test('一轮翻译只读一次目标语言，然后一路带到落笔', () => {
  const batch = code('content/page/batch.js');

  // 两个读数在同一个地方、同一时刻取。
  assert.match(batch, /function passTarget\(\) \{[\s\S]*?request: getEffectiveTargetLang\(\)[\s\S]*?stamp: ctx\.currentTargetLang/);
  // 这一轮只在开跑时取一次。
  assert.match(batch, /const target = passTarget\(\);/);

  // 发请求的三个地方（分批 / 逐块回退 / 超大块）全用这一轮定下的那门语言，
  // 没有一个还在现问。
  assert.equal((batch.match(/targetLang: target\.request,/g) || []).length, 3);
  assert.doesNotMatch(batch, /targetLang: getEffectiveTargetLang\(\)/);

  // 落笔时把它交给唯一的登记口。
  assert.match(batch, /ctx\.insertTranslationBlock\(block, translation, \{ lang: target\.stamp \}\)/);
  assert.match(code('content/page/insert.js'), /function insertTranslationBlock\(block, translation, \{ lang = null \} = \{\}\)/);

  // 「这块是不是本来就已经是目标语言」也要按这一轮的那门语言问，否则同一轮里
  // 前后两批会按两门语言判该不该跳过。
  assert.match(batch, /isTargetLanguageText\(block\.text, target\.request\)/);
});

// ---- 语言包预取要跟着语言对走 --------------------------------------------
//
// 预取是一次性监听：挂的时候记的是「为哪个语言对挂的」。用户换目标语言、换引擎、
// 或者单页应用翻到一篇别的语言的文章之后，挂着的那一对就过期了 —— 而一个带着过期
// 语言对的监听比没有更糟：用户的下一次点击会把**别的**包下下来，真正缺的那个永远
// 没人下。
test('语言包预取记着自己是为哪个语言对挂的，过期了要换掉', () => {
  const engine = engineCode();
  const pack = code('content/content-language-pack.js');

  // 同一时刻只有一份，换语言对时先摘掉旧的。
  assert.match(pack, /let armedPrefetch = null;/);
  assert.match(pack, /function armLanguagePackPrefetch\(src, tgt\)/);
  assert.match(pack, /if \(armedPrefetch && armedPrefetch\.src === src && armedPrefetch\.tgt === tgt\) return;/);
  assert.match(pack, /disarmLanguagePackPrefetch\(\);\s*\n\s*const onGesture/);
  // 预取只走引擎的公开面。伸手进去拿内部实现，这个文件就白拆了。
  assert.doesNotMatch(pack, /SUPPORTED_LANGS|getTranslator\(|probeAvailability\(/);

  // 真正撞上「缺这个包」的时候就地挂上 —— 那一刻 src/tgt 是现成的，换语言、换
  // 引擎、路由切换三种过期情形全由它接住，一次多余的探测往返都不花。
  // 只数真实翻译那条路上的。设置页那颗下载按钮（ensureDownloaded）跑在 options
  // 页自己的上下文里，那里没有要翻的页面，挂预取没有意义。
  const translatePath = engine.slice(
    engine.indexOf('async function translateWithBuiltin'),
    engine.indexOf('async ensureDownloaded')
  );
  const armedBeforeThrow = translatePath.match(
    /ctx\.armLanguagePackPrefetch\(src, tgt\);\s*\n\s*throw new EngineUnavailableError\(ENGINE_REASONS\.NEEDS_DOWNLOAD\);/g
  ) || [];
  const needsDownloadThrows = translatePath.match(
    /throw new EngineUnavailableError\(ENGINE_REASONS\.NEEDS_DOWNLOAD\);/g
  ) || [];
  assert.equal(needsDownloadThrows.length, 2, 'NEEDS_DOWNLOAD 的抛出点应当正好两处');
  assert.equal(armedBeforeThrow.length, 2, '每一处「缺包」都要就地把预取挂上');

  // 手势真的来了，还要再确认一次这一对没过期：挂上之后、点下去之前，用户仍然
  // 可能改掉目标语言。
  assert.match(pack, /if \(downloadTargetLang\(\) !== tgt\) return;/);
  // 预取要的是「真能下下来的那个包」，所以补 navigator.language；身份戳那一门
  // 不补（空串是哨兵）。两者不能合并。
  assert.match(pack, /function downloadTargetLang\(\)[\s\S]*?toApiLang\(ctx\.getEffectiveTargetLang/);
  // 挂的时候问的和触发的时候问的必须是同一个问题：划词/输入框弹窗上那个一次性
  // 的语言下拉能让一次翻译用上跟设置不同的目标语言，那一对挂上去只会被手势那道
  // 门拒掉，还顺手顶掉真正该挂的那一对。且这道门要挡在 disarm 之前。
  assert.match(
    pack,
    /if \(tgt !== downloadTargetLang\(\)\) return;\s*\n\s*if \(armedPrefetch &&[\s\S]*?\n\s*disarmLanguagePackPrefetch\(\);/
  );
});
