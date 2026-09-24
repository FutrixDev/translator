// Guards for the subtitle engine — content/captions/ 那一族加上入口
// content/content-video-captions.js，以及它周围的控件和默认值。
//
// 这一份里的断言几乎都在读源码：问的是「引擎有没有自己又写一遍」「这两件事谁排在
// 谁前面」这类**不变量**，运行时测不到，肉眼又看不住。问整族用 captionEngineSource()，
// 问装载顺序照旧读 manifest.json——理由见 test/unit/helpers/sources.mjs。
//
// shared/caption-core.js 本身（cue 形状、解析、合流、provider 选择、显示模式）在
// caption-core.test.mjs。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { captionEngineSource, contentCss } from './helpers/sources.mjs';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// 下面有一条断言问的是「caption-core 有没有把这几个名字转卖出去」，所以这里也要把
// 它装起来。没有 export —— 内容脚本是当普通脚本装的，import 的副作用就是挂上
// globalThis.CaptionCore。
await import('../../shared/lang-tags.js');
await import('../../shared/caption-core.js');
const core = globalThis.CaptionCore;

// -------------------------------------------------- turning subtitles on
// 这一轮的自动化里，只有这一件事**改动播放器自己的状态**。其余的（整页翻译、字
// 幕覆盖层）都只是往页面里插我们自己的节点，插错了刷新一下就没了；把播放器的 CC
// 点开是留在观众账号里的。所以它有自己的开关、默认关着，而且有一道只合不开的闩。
test('替观众开原字幕是一个单独的开关，默认关着', () => {
  const defaults = repoFile('shared/default-settings.js');
  assert.match(defaults, /autoEnableCaptions:\s*false/);

  // 设置页那一格要写得进去，也要读得回来。
  const options = repoFile('options/options.js');
  assert.match(options, /autoEnableCaptions:\s*elements\.autoEnableCaptions\.checked/);
  assert.match(options, /elements\.autoEnableCaptions\.checked\s*=\s*!!result\.autoEnableCaptions/);
  assert.match(repoFile('options/options.html'), /id="autoEnableCaptions"/);

  // 改了要当场生效，而不是等下一次刷新：字幕这一面靠 CAPTION_SETTING_KEYS 认领
  // 哪些键值得重新 applyCaptionSettings()。
  assert.match(repoFile('content/content-bootstrap.js'), /'autoEnableCaptions'/);
});

test('自动开原字幕过不了两道闸门：开关，和这个站点被不被明令拒绝', () => {
  const engine = captionEngineSource();
  const gate = engine.match(/function autoEnableAllowed\(\)[\s\S]*?\n  \}/);
  assert.ok(gate, '找不到 autoEnableAllowed()');
  assert.match(gate[0], /getSetting\('autoEnableCaptions'\)/);
  assert.match(gate[0], /siteRefused/);
  assert.match(gate[0], /state\.autoEnableBlocked/);

  // 闸门问的是「被拒绝了吗」而不是「开着自动翻吗」：视频站点在整页那一面多半是
  // ask，拿 siteAuto 当闸门等于这件事永远不发生。
  assert.equal(/autoEnableAllowed[\s\S]{0,400}?siteAuto/.test(engine), false);

  // 调度层只是转述 SiteRules 的答案，分类留在阶梯那边。
  assert.match(repoFile('content/content-auto-translate.js'), /\.refused === true/);
});

test('观众自己把字幕关掉之后，就不再替他开第二次', () => {
  const engine = captionEngineSource();
  const latch = engine.match(/function syncNativeCaptions\(\)[\s\S]*?\n  \}/);
  assert.ok(latch, '找不到 syncNativeCaptions()');
  // 看见开着 → 记下；再看见关了 → 落闩。少了任何一半，1.5 秒一次的心跳会把他
  // 刚关掉的字幕点回来，他关不掉。
  assert.match(latch[0], /state\.sawNativeOn\s*=\s*true/);
  assert.match(latch[0], /state\.autoEnableBlocked\s*=\s*true/);

  // 闩按会话留，sawNativeOn 按视频清：播放器在 SPA 跳转里会把字幕层拆掉重建，
  // 不清的话那一瞬的「不见了」会被读成「他关掉了」。
  const reset = engine.match(/function resetForVideo\(\)[\s\S]*?\n  \}/);
  assert.match(reset[0], /state\.sawNativeOn\s*=\s*false/);
  assert.equal(/autoEnableBlocked\s*=/.test(reset[0]), false, 'resetForVideo 不该动那道闩');

  // 越闩只有一条路：他自己在菜单里按的那一下。
  assert.match(engine, /ctx\.enableNativeCaptions = function[\s\S]*?state\.autoEnableBlocked = false/);
  assert.match(repoFile('content/content-caption-controls.js'), /ctx\.enableNativeCaptions\(\)/);
});

test('问不到「这个站点准不准」，就当是不准', () => {
  // 这一句话现在管两件事：替观众打开原字幕（改的是播放器自己的状态），以及字幕
  // 到底翻不翻（把页面上的文字发给第三方）。「还没判出来」和「判出来是不许」在
  // 观众那里没有区别，而后者错一次是把不该发的发出去了。
  const engine = captionEngineSource();
  // 「调度层没起来」和「state() 抛了（页面正在拆）」在取快照那一层就合成了同一
  // 个答案：null，什么都不知道。
  const snap = engine.match(/function autoSnapshot\(\)[\s\S]*?\n  \}/);
  assert.ok(snap, '找不到 autoSnapshot()');
  assert.match(snap[0], /if \(!auto \|\| typeof auto\.state !== 'function'\) return null/);
  assert.match(snap[0], /catch[\s\S]{0,80}?return null/);

  const gate = engine.match(/function siteRefused\(\)[\s\S]*?\n  \}/);
  assert.ok(gate, '找不到 siteRefused()');
  // 不知道 → 拒绝。而快照里没有这个字段也算不知道 —— `!== false` 而不是
  // `=== true` 的反面。
  assert.match(gate[0], /return !snap \|\| snap\.siteRefused !== false;/);

  // 自动开原字幕那一道闸复用同一句话，不自己再问一遍。
  const auto = engine.match(/function autoEnableAllowed\(\)[\s\S]*?\n  \}/);
  assert.ok(auto, '找不到 autoEnableAllowed()');
  assert.match(auto[0], /return !siteRefused\(\);/);

  // 自动翻译先起、字幕后起：字幕一装起来就去订阅那个闸门，顺序反了就得等下一次
  // 状态变化才上闸——而一个判完就定下来不再动的页面永远等不到那一次。
  const boot = repoFile('content/content-bootstrap.js');
  assert.ok(
    boot.indexOf('ctx.setupAutoTranslate') < boot.indexOf('setupVideoCaptionTranslation'),
    'bootstrap 顺序变了，subscribeToGate 的理由要重写'
  );
});

test('菜单第一行画的是站点规则，不是闸门', () => {
  // 闸门＝「这个站点没明令拒绝我们」，站点规则＝「这个站点开着自动翻」，中间隔
  // 着一大片 ask。一个没设过规则的普通视频站上闸门开着而规则关着——拿闸门去画
  // 那一行，它会显示成「开」，而观众按下去写进去的是一条永久的 never。
  const engine = captionEngineSource();
  assert.match(engine, /function siteAuto\(\)[\s\S]*?return !!\(snap && snap\.siteAuto\);/);
  assert.match(engine, /state\.siteAuto = (?:caps\.)?siteAuto\(\);/);
  assert.match(engine, /controls\.sync\(\{[^}]*siteAuto: state\.siteAuto/);

  const controls = repoFile('content/content-caption-controls.js');
  assert.match(controls, /function siteAutoOn\(\)[\s\S]*?return !!\(ui\.info \|\| \{\}\)\.siteAuto;/);
  // 画、点两处都问站点规则。
  assert.match(controls, /aria-checked', siteAuto \? 'true' : 'false'/);
  assert.match(controls, /classList\.toggle\('ai-cap-on', siteAuto\)/);
  assert.match(controls, /SiteRules\.setSiteAuto\(location\.hostname, !siteAutoOn\(\)\)/);
  // 闸门还管着它该管的：字幕流水线自己，和「显示方式」那一格灰不灰。
  assert.match(controls, /parts\.modeItem\.classList\.toggle\('ai-cap-disabled', !enabled\)/);
});

test('写不进规则的站点，那一行点不动', () => {
  // 黑名单：BLOCKLIST 在 decide() 的阶梯上排在 USER_ALWAYS 前面，写进去也不算
  // 数。没有 host（file://）：normalizeHost 给不出键，规则一声不响地没写上，而
  // 「顺带打开总开关」那半边会照跑——他要的是这一个站点，拿到的是整个浏览器。
  // 判断只有一份，在 shared/site-rules.js —— 三处画这一行的地方（popup、字幕
  // 菜单、悬浮球菜单第一项）问的是同一句话。从前它是字幕菜单里的私有函数，第二
  // 处要用的时候差一点就被抄成第二份。
  const rules = repoFile('shared/site-rules.js');
  const shared = rules.match(/function siteRuleWritable\(hostname, path\)[\s\S]*?\n  \}/);
  assert.ok(shared, '找不到 SiteRules.siteRuleWritable()');
  assert.match(shared[0], /normalizeHost\(hostname\)/);
  assert.match(shared[0], /isBlocklisted\(hostname, path\)/);
  assert.match(rules, /^\s*siteRuleWritable,$/m, 'siteRuleWritable 没导出去');

  const controls = repoFile('content/content-caption-controls.js');
  const fn = controls.match(/function ruleWritable\(\)[\s\S]*?\n  \}/);
  assert.ok(fn, '找不到 ruleWritable()');
  assert.match(fn[0], /SiteRules\.siteRuleWritable\(location\.hostname, location\.pathname\)/);
  // 抄回来的第二份长这样：自己拼那两问。
  assert.doesNotMatch(fn[0], /isBlocklisted\(/, 'ruleWritable 又自己判了一遍');
  assert.match(controls, /parts\.enableItem\.classList\.toggle\('ai-cap-disabled', !ruleWritable\(\)\)/);

  // 写入口那边再挡一道：画面灰着只是画面，别的调用方照样能递个空 host 进来。
  const set = rules.slice(rules.indexOf('async function setSiteAuto(hostname, on)'));
  const guard = set.indexOf('if (!normalizeHost(hostname)) throw');
  assert.ok(guard > 0, 'setSiteAuto 没有挡住存不进去的 host');
  assert.ok(guard < set.indexOf('writeUserRule('), '得在写之前挡');
});

test('字幕翻不翻只有一个答案，控件不自己再算一遍', () => {
  // 引擎算出闸门，随 controls.sync() 递给控件；控件回头去读设置就是第二个答案，
  // 而两个答案里总有一个是错的。
  const engine = captionEngineSource();
  assert.match(engine, /state\.enabled = !(?:caps\.)?siteRefused\(\);/);
  assert.match(engine, /controls\.sync\(\{[^}]*enabled: state\.enabled/);

  const controls = repoFile('content/content-caption-controls.js');
  assert.match(controls, /function captionsOn\(\)[\s\S]*?return !!\(ui\.info \|\| \{\}\)\.enabled;/);
  assert.equal(
    /enableYoutubeCaptionTranslation/.test(controls), false,
    '字幕不再有自己的开关，控件不该还认得这个键',
  );

  // 闸门一变就重来一遍：订阅调度层，而不是等下一次心跳或者设置变动。站点规则
  // 变了也要重来：ask→always 并不挪动闸门，可菜单第一行画的就是它。
  assert.match(engine, /auto\.onStateChange\(/);
  assert.match(engine, /siteRefused\(\) === state\.enabled \|\| siteAuto\(\) !== state\.siteAuto/);
  // 先立旗再订阅：onStateChange 会当场回调一次，旗子晚一行就是一次无限递归。
  const sub = engine.match(/function subscribeToGate\(\)[\s\S]*?\n  \}/);
  assert.ok(sub, '找不到 subscribeToGate()');
  assert.ok(
    sub[0].indexOf('gateSubscribed = true') < sub[0].indexOf('auto.onStateChange('),
    '旗子必须在订阅之前立起来',
  );
});

test('藏起播放器上的按钮，不等于不要替他开原字幕', () => {
  // 两个设置，两件事：captionPlayerButton 说的是「别在控制条上摆你的图标」，
  // autoEnableCaptions 说的是「没开字幕的视频替我点开」。自动开启那一步唯一的驱
  // 动是心跳里的 syncControls()，所以它必须排在按钮那道闸门**前面**——排在后面，
  // 藏了图标的观众就再也等不到字幕。
  const engine = captionEngineSource();
  const sync = engine.match(/function syncControls\(\)[\s\S]*?\n  \}/);
  assert.ok(sync, '找不到 syncControls()');
  assert.equal((sync[0].match(/syncNativeCaptions\(\)/g) || []).length, 1);
  assert.ok(
    sync[0].indexOf('syncNativeCaptions()') < sync[0].indexOf("getSetting('captionPlayerButton')"),
    '自动开原字幕被挡在了按钮的开关后面'
  );
});

test('「能不能点开」是每一拍现问的，不是记下来的', () => {
  // 记下来的那个版本是这么坏的：菜单按过一次、按了个空，就把「这段视频没有字幕」
  // 记住，那一行藏到换视频为止。可 YouTube 在播放器加载中也会把 CC 按钮先摆成
  // disabled——于是一段本来有字幕的视频上，观众再没有别的路把字幕找回来。
  const providers = repoFile('content/content-caption-providers.js');
  const probe = providers.match(/canEnableNativeCaptions\(\) \{[\s\S]*?\n    \},/);
  assert.ok(probe, '找不到 YouTubeProvider.canEnableNativeCaptions()');
  assert.match(probe[0], /if \(!button\) return null/, '控制条还没上来 ≠ 没有字幕');
  assert.match(probe[0], /aria-disabled[\s\S]{0,40}?return false/);

  // 通用 provider 同理：一条字幕轨都没列 = 轨道从我们脚下没了（canActivate 要求
  // 它本来有），说不准，下一拍再问。
  assert.match(providers, /subtitleEntries\(TextTrackProvider\.getVideo\(\)\)\.length \? true : null/);

  // 菜单每一拍照这个答案决定摆不摆那一行，而且谁也不许把它记下来。
  const engine = captionEngineSource();
  const status = engine.match(/function captionStatus\(provider\)[\s\S]*?\n  \}/);
  assert.ok(status, '找不到 captionStatus()');
  assert.match(status[0], /canEnableNativeCaptions\(\)/);
  assert.match(status[0], /canEnable !== false/);
  assert.equal(
    /nativeUnavailable/.test(engine),
    false,
    '「这段视频没有字幕」又被记了下来：加载中的一拍会把菜单那行藏到换视频为止',
  );
});

test('「本来就是目标语言」是现算的，而且换了目标语言字幕这一面要当场知道', () => {
  const engine = captionEngineSource();

  // 记下来的那个版本（state.skipTranslation）一个视频只算一次，在 ingestTrack
  // 里。观众看到一半把目标语言从英文换成中文，那条英文轨道的「不必译」就冻在那
  // 里，之后每一次 handleTimeUpdate 都在早退上返回，整段视频再不会开译。
  assert.equal(
    /skipTranslation/.test(engine),
    false,
    '「不必译」又被记了下来：换目标语言之后没人回头去改它',
  );
  const derived = engine.match(/function sameLanguage\(\)[\s\S]*?\n  \}/);
  assert.ok(derived, '找不到 sameLanguage()');
  assert.match(derived[0], /state\.trackLang/);
  assert.match(derived[0], /getTargetLang\(\)/);

  // 现算还不够：得有人来推这一下。targetLang 不是字幕自己的设置，可它一变，
  // 译文表的键（整码，见 getTargetLang）和这道闸门一起翻篇。
  assert.match(repoFile('content/content-bootstrap.js'), /'targetLang',/);

  // 而且要越过 2 秒节流：视频停着的时候没有 timeupdate 来推第二次。
  const apply = engine.match(/ctx\.applyCaptionSettings = function\(\)[\s\S]*?\n  \};/);
  assert.ok(apply, '找不到 applyCaptionSettings()');
  assert.match(apply[0], /handleTimeUpdate\(true\)/);
  assert.match(engine, /ensureTrackTranslated\(!!force\)/);

  // 但事件监听器不能直接挂 handleTimeUpdate：Event 对象一概是真的，那样每一次
  // timeupdate 都成了 force，节流等于没有。
  assert.match(engine, /addEventListener\('timeupdate', onVideoTimeUpdate\)/);
  assert.equal(/addEventListener\('timeupdate', handleTimeUpdate\)/.test(engine), false);
});

test('「原字幕开着没有」要排在「本来就是目标语言」前面', () => {
  // 一条本来就是目标语言的轨道被观众关掉之后：菜单继续报「已经是你要的语言」，
  // 而那句话描述的是一条屏幕上已经不存在的轨道，还正好把唯一那条回头路挡住了
  // ——自动开启那一面记着「是他自己关的」，不会再替他点。
  const engine = captionEngineSource();
  const status = engine.match(/function captionStatus\(provider\)[\s\S]*?\n  \}/);
  assert.ok(status, '找不到 captionStatus()');
  assert.ok(
    status[0].indexOf('nativeCaptionsState()') < status[0].indexOf("'same-language'"),
    '「本来就是目标语言」抢在了原字幕那一问前面',
  );
  assert.ok(
    status[0].indexOf("'same-language'") < status[0].indexOf("kind: 'track'"),
    '同语言的轨道又要去报轨道名了',
  );
});

test('替他开成了就当场记下，别等下一拍', () => {
  // 心跳 1.5 秒一拍。开成了却把 true 丢掉，观众在这 1.5 秒里把刚亮起来的字幕关
  // 掉，下一拍看见的是「关着，而且没落闩」——于是又替他开一次。那道闩要防的正
  // 是这件事，只不过发生在它合上之前。
  const engine = captionEngineSource();
  const sync = engine.match(/function syncNativeCaptions\(\)[\s\S]*?\n  \}/);
  assert.ok(sync, '找不到 syncNativeCaptions()');
  assert.match(
    sync[0],
    /if \(provider\.enableNativeCaptions\(\)\) state\.sawNativeOn = true;/,
    '按下去的结果被丢掉了',
  );
});

test('他自己按那一行开成了，同样要当场记下', () => {
  // 菜单那一行走的是另一个函数，漏在了外面。YouTube 的 enableNativeCaptions() 在
  // button.click() 之后直接答 true，不等 aria-pressed 翻面，而这一行紧接着就
  // syncControls() —— 那一问要是还读到 false，就落进自动那一路：闩刚被这一行解开，
  // autoEnableCaptions 又开着的话，它会再点一次，把观众刚要的字幕点回去。
  const engine = captionEngineSource();
  const manual = engine.match(/ctx\.enableNativeCaptions = function\(\)[\s\S]*?\n  \};/);
  assert.ok(manual, '找不到 ctx.enableNativeCaptions');
  assert.match(
    manual[0],
    /if \(answer\) state\.sawNativeOn = true;\n\s*syncControls\(\);/,
    '按下去的结果丢了，或者记在了 syncControls() 后面——那一拍已经去问过播放器了',
  );

  // 点一次和答 true 之间没有确认：正因为如此，上面那一行才省不得。
  const providers = repoFile('content/content-caption-providers.js');
  const press = providers.match(/enableNativeCaptions\(\) \{[\s\S]*?\n    \},/);
  assert.ok(press, '找不到 YouTubeProvider.enableNativeCaptions()');
  assert.match(press[0], /button\.click\(\);[\s\S]{0,80}return true;/);
});

test('「原字幕开着没有」拿不准的时候，不许去合那道闩', () => {
  // 那道闩一合就是一整个会话。YouTube 的字幕容器是播放器外壳的一部分，可以先于
  // 控制条挂上来、而且是空的——把它读成「开着」，等按钮带着 aria-pressed="false"
  // 出现，下一拍就成了「观众刚把字幕关掉」，自动开启从此停摆，而他什么都没做过。
  const providers = repoFile('content/content-caption-providers.js');
  const probe = providers.match(/nativeCaptionsState\(\) \{[\s\S]*?\n    \},/);
  assert.ok(probe, '找不到 YouTubeProvider.nativeCaptionsState()');
  assert.match(probe[0], /aria-pressed'\) === 'true'/, '按钮才是权威');
  assert.match(
    probe[0],
    /ytp-caption-segment'\)\) return true;[\s\S]{0,40}return null;/,
    '没有按钮的时候，空容器要答「说不准」，不能答 true 也不能答 false',
  );

  // 引擎照三种答案走：只有确凿的 false 才往闩那一步去。
  const engine = captionEngineSource();
  const sync = engine.match(/function syncNativeCaptions\(\)[\s\S]*?\n  \}/);
  assert.match(sync[0], /if \(on === true\)/);
  assert.match(sync[0], /if \(on !== false\) return;/, '「说不准」被读成了「关着」');
  assert.equal(
    /provider\.isCaptionsEnabled/.test(engine),
    false,
    '还留着两问一样问题的两个方法',
  );
});

test('allowDisabled 只从 enableNativeCaptions 那条路进来', () => {
  // 它是「把页面只是提供的那几门字幕挑一门出来开」的许可。任何别的调用点拿到
  // 它，默认行为就变成了「替所有人开字幕」，而那是整个功能唯一不可逆的一步。
  const providers = repoFile('content/content-caption-providers.js');
  const calls = providers.match(/syncSelection\((true)?\)/g) || [];
  assert.ok(calls.length >= 3, '至少三处 syncSelection 调用');
  assert.equal(calls.filter((c) => c === 'syncSelection(true)').length, 1);
  const enable = providers.match(/enableNativeCaptions\(\)\s*\{[\s\S]*?syncSelection\(true\)/);
  assert.ok(enable, 'syncSelection(true) 不在 enableNativeCaptions 里');

  // 两个 provider 都得答得上这句话，否则引擎在那种页面上只能干等。
  assert.equal((providers.match(/enableNativeCaptions\(\)\s*\{/g) || []).length, 2);
});

test('往前译有个窗，而且只有花钱的那条路才设窗', () => {
  // 从前是「整条轨道一次译完」：一小时的讲座在观众看到第二句之前就整片发去了云
  // 端，其中绝大多数他不会看到。
  const engine = captionEngineSource();
  const window = engine.match(/function translationWindowMs\(\)[\s\S]*?\n  \}/);
  assert.ok(window, '找不到 translationWindowMs()');
  assert.match(window[0], /builtin\.isActive\(\)/);
  assert.match(window[0], /return Infinity/);
  assert.match(window[0], /useNative \? (?:caps\.)?NATIVE_WINDOW_MS : (?:caps\.)?WINDOW_MS/);

  // 「选了内置引擎」不等于「这一批不花钱」：语言包还没下到本地时内置会抛
  // EngineUnavailableError，而 engineFallback === 'allow-ai' 的用户会把这一批原
  // 样转给他自己的接口。所以不设限得再加一条：回退关着。
  assert.match(
    window[0],
    /engineFallback'\) !== 'allow-ai'/,
    '回退开着的时候也不设限：一场两小时的讲座会整片发去云端',
  );

  // 窗要真的拦住句子，而不是算出来放着不用。
  assert.match(engine, /function pickNextBatch\(limitMs\)/);
  assert.match(engine, /if \(!withinWindow\(seg, playhead, limitMs\)\) continue;/);
  // 而且每一轮现算：一轮可以跑很久，观众中途把引擎从内置换成 AI，取一次留着用
  // 等于拿上一个引擎的结论去放行下一个引擎的批次。
  assert.match(engine, /pickNextBatch\(translationWindowMs\(\)\)/);
  const loopFn = engine.match(/async function ensureTrackTranslated\(force\)[\s\S]*?\n  \}/);
  assert.equal(
    /const limitMs = translationWindowMs\(\)/.test(loopFn[0]),
    false,
    '窗在整轮开始时取了一次就留着用',
  );

  // 而且量的是**句子**，不是批次：批次只按条数和字数切，时间上想多长有多长。一
  // 段前面一句、一小时后一句的稀疏轨道，两句同批，这一批离播放头最近的那一头是
  // 0——按批次量，那一小时之外的一句就跟着发出去了，窗等于没设。
  const pick = engine.match(/function pickNextBatch\(limitMs\)[\s\S]*?\n  \}/);
  assert.ok(pick, '找不到 pickNextBatch()');
  assert.match(pick[0], /segmentDistance\(seg, playhead\)/);
  assert.equal(
    /batchDistance/.test(engine),
    false,
    '窗又按整批量了：一批里只要有一句在窗内，整批都会被发出去',
  );

  // 而且只往前看。距离本身是对称的，拿它直接比上限等于让播放头**后面**五分钟的
  // 句子和前面五分钟的抢同一份额度——实际宽度翻倍，多出来的那一半全花在观众已经
  // 跳过去的内容上。不设窗那一路（不花钱）不受这条约束：整条译到底本来就是它。
  const within = engine.match(/function withinWindow\(seg, playheadMs, limitMs\)[\s\S]*?\n  \}/);
  assert.ok(within, '找不到 withinWindow()');
  assert.match(within[0], /if \(limitMs === Infinity\) return true;/);
  assert.match(
    within[0],
    /if \(seg\.endMs < playheadMs\) return false;/,
    '已经放过去的句子还在占那份额度',
  );
});

test('重看一遍不该再付一次钱：字幕也走那张持久缓存', () => {
  // 内存里那张 state.cueCache 只活到 clearTrack()：换一集、刷一次页面、第二天再
  // 打开，它都是空的，而一部两小时的片子是两千来条句子。整页翻译走
  // ctx.requestTranslationCached 已经很久了，字幕从前直接走 ctx.requestTranslation
  // —— 同一条轨道看几遍就付几遍钱，而那几遍的译文一模一样。
  const engine = captionEngineSource();
  assert.match(
    engine,
    /await \(ctx\.requestTranslationCached \|\| ctx\.requestTranslation\)\(/,
    '字幕又绕过缓存层直接发请求了',
  );
  // 只有这一处发译文请求。多一处就是一条不走缓存的岔路，而它省下的钱看不见，
  // 多花的钱也看不见。
  assert.equal(
    (engine.match(/ctx\.requestTranslation(?!Cached)\(/g) || []).length,
    0,
    '还有一处直接调 ctx.requestTranslation',
  );
  // 而轨道声明的那门语言要跟着请求走：它是缓存键的一个因子（见
  // test/unit/translation-cache.test.mjs），少了它，两门源语言会共用一条译文。
  assert.match(engine, /trackLang: state\.trackLang/);
});

test('一批译文回来时轨道或目标语言已经翻篇，就整批丢掉——但键要先放开', () => {
  // getCueKey() 读的是 state **此刻**的值。观众换一门字幕语言或换个目标语言，上
  // 一轮的译文会照着新的那一套键写进缓存——而且因为键是对的，它永远不会被重译掉。
  const engine = captionEngineSource();
  const fn = engine.match(/async function translateCues\(cues\)[\s\S]*?\n  \}/);
  assert.ok(fn, '找不到 translateCues()');
  // 键、轨道号、目标语言，三样都取在 await 之前。
  const beforeAwait = fn[0].slice(0, fn[0].indexOf('await ctx.requestTranslation'));
  assert.match(beforeAwait, /const keys = cues\.map\(\(cue\) => getCueKey\(cue\)\);/);
  assert.match(beforeAwait, /const trackId = state\.trackId;/);
  assert.match(beforeAwait, /const target = (?:caps\.)?getTargetLang\(\);/);
  // 过期只由字幕自己的两样东西决定。整页那一面的代次号（sessionVersion）是另一个
  // 部件的时钟：暂停这一页、藏起译文、关掉全局自动翻译都会让它翻篇，而轨道和目标
  // 语言一样没变——在飞的那一批被判过期丢掉，下一轮又把同一批句子重发一次，钱付两
  // 回而第一回的结果就在手上。
  assert.ok(
    !/sessionVersion\(\)/.test(fn[0]),
    '字幕的过期判定又挂回整页那一面的代次号上了',
  );
  // 丢掉这一批之前先按当初那一套键放开 pendingKeys。换轨道那一路 clearTrack() 顺
  // 手清过，换目标语言那一路没有——不放开，这几句就永远停在「正在译」上。
  assert.match(
    fn[0],
    /if \(trackId !== state\.trackId \|\| target !== (?:caps\.)?getTargetLang\(\)\) \{\s*\n\s*releaseBatch\(keys\);\s*\n\s*return STALE;/,
    '过期的一批直接 return 了，pendingKeys 没放开',
  );

  // 而且「过期」要和「失败」分开报：过期说的是脚下的世界变了，新的那一套句子一
  // 个都还没译，而当时想去译它们的那次调用正撞上 state.translating 被这一批占着，
  // 什么也没做就回去了。当失败停下来，视频停着的时候没有 timeupdate 来推第二次，
  // 新字幕会一直空着。
  // 这一问要排在**看 response 之前**：请求失败和脚下的世界变了是两件独立的事，
  // 而换目标语言时在飞的那个请求多半两样都占。按失败处理就是记一笔谁也用不上的
  // 冷却，然后 return false 把整轮停在那里——正是上面那段话要防的事。
  assert.ok(
    fn[0].indexOf('return STALE;') < fn[0].indexOf('markBatchFailed'),
    '过期这一问排在了失败处理后面：一批过期的请求恰好报错，就又成了失败',
  );
  // 同一个问题不留两个答案：markBatchFailed 不再自己对一次 trackId。
  assert.match(engine, /function markBatchFailed\(keys\)/);

  const loop = engine.match(/async function ensureTrackTranslated\(force\)[\s\S]*?\n  \}/);
  assert.ok(loop, '找不到 ensureTrackTranslated()');
  assert.match(loop[0], /result === STALE\) continue;/, '过期的一批把整轮停掉了');
  assert.match(loop[0], /if \(!result\) break;/);
  // 条数对不上也整批作废：短一条，尾部那几句会永远留在 pendingKeys 里。
  assert.match(fn[0], /response\.translations\.length !== cues\.length/);
  // 记「正在译」和放开它在同一个函数里，两道早退才不会各自漏一个口子。
  assert.match(beforeAwait, /keys\.forEach\(\(key\) => state\.pendingKeys\.add\(key\)\);/);
  assert.doesNotMatch(engine, /pendingKeys\.add\(getCueKey\(/, 'pendingKeys 又在 translateCues 之外记了一处');
});

test('译文表的键里带着目标语言：换一门语言就是换一套键', () => {
  // 少了这一截，看片中途把目标语言从中文换成日文，已经译过的句子键一个不变，整
  // 段视频继续放着中文，而且因为键是对的，永远不会被重译掉。
  const engine = captionEngineSource();
  const fn = engine.match(/function getCueKey\(cue\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, '找不到 getCueKey()');
  assert.match(fn[0], /getTargetLang\(\)/, '键里没有目标语言：换语言后旧译文会被当成新语言的');
  assert.match(fn[0], /state\.trackId/);

  // 而且要整码。zh-CN 和 zh-TW 的基码都是 zh，可它们是两套字：按基码做键，观众
  // 从简体切到繁体，整段视频会继续放着简体，永远不会被重译掉。
  const keyFn = engine.match(/function getTargetLang\(\) \{[\s\S]*?\n  \}/);
  assert.ok(keyFn, '找不到 getTargetLang()');
  assert.ok(
    !/getLangBase/.test(keyFn[0]),
    'getTargetLang() 砍成了基码：简繁互换会共用同一套键，同语言那道闸门也会把繁体轨道当成简体的',
  );
  assert.match(keyFn[0], /toLowerCase\(\)/);
});

test('菜单里那一项是按情况露出来的，CSS 得让 hidden 真的藏得住', () => {
  // `[hidden]` 的 display:none 只是 UA 规则，菜单项自己那条 `display: flex` 一来
  // 就把它压掉了——JS 照样把 hidden 置上，屏幕上那一行纹丝不动。菜单根节点早就为
  // 同一件事单独写过一条（`#ai-translator-caption-menu[hidden]`），这是第二处。
  const controls = repoFile('content/content-caption-controls.js');
  assert.match(controls, /parts\.nativeItem\.hidden = !needsNative;/);
  assert.match(controls, /parts\.stopSiteItem\.hidden = !\(ui\.info \|\| \{\}\)\.stopSite;/);
  const css = contentCss();
  assert.match(
    css,
    /#ai-translator-caption-menu \.ai-translator-caption-menu-item\[hidden\]\s*\{\s*display:\s*none;/,
    '菜单项缺 [hidden] 规则：JS 藏不住它'
  );
});

test('字幕引擎问的是那一个共用的语言判定，不是自己再写一遍', () => {
  // 简繁不是同一门语言、en-GB 和 en 是——这些的行为断言在
  // test/unit/lang-tags.test.mjs，判定本身在 shared/lang-tags.js。这里只守一件
  // 事：引擎问的是**那一份**。一条繁体轨道配简体目标正是观众要的那件事，按基码
  // 判两边都是 zh，「本来就是目标语言」成立，handleTimeUpdate 在那道闸门上返回，
  // 一个字也不译。
  const engine = captionEngineSource();
  const fn = engine.match(/function sameLanguage\(\)[\s\S]*?\n  \}/);
  assert.ok(fn, '找不到 sameLanguage()');
  assert.match(fn[0], /langTags\.isSameLanguage\(/);
  assert.ok(!/getLangBase/.test(fn[0]), 'sameLanguage() 又砍回基码了');

  // 而且 caption-core 不再转卖这三个函数：两个名字指同一件事，迟早有人改其中
  // 一个。
  for (const name of ['getLangBase', 'getScriptVariant', 'isSameLanguage']) {
    assert.equal(core[name], undefined, `CaptionCore 又把 ${name} 转出去了`);
  }
});

test('一轮译文有主，换了视频的那一轮不许接着跑', () => {
  // resetForVideo() 会把 state.translating 清掉，紧接着新轨道进来又起一轮新的，
  // 而旧那一轮正停在 await 上。它回来照 STALE 接着跑，两轮就并排跑起来——各自的
  // finally 又都会清标志，于是第三轮第四轮也能进来，付费的批次同时在飞。
  const engine = captionEngineSource();
  const fn = engine.match(/async function ensureTrackTranslated\(force\)[\s\S]*?\n  \}/);
  assert.ok(fn, '找不到 ensureTrackTranslated()');
  assert.match(fn[0], /const pass = \+\+passSeq;/, '这一轮没有号：所有权无从谈起');
  assert.match(fn[0], /state\.translating = pass;/);
  assert.match(
    fn[0],
    /if \(state\.translating !== pass\) return;/,
    '所有权被收走之后还往下走：两轮并行',
  );
  assert.ok(
    fn[0].indexOf('if (state.translating !== pass) return;') < fn[0].indexOf('if (result === STALE)'),
    '先接着跑再验所有权，等于没验',
  );
  assert.match(
    fn[0],
    /if \(state\.translating === pass\) state\.translating = false;/,
    'finally 清掉的可能是接班那一轮的标志',
  );
});
