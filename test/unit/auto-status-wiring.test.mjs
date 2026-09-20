// 交互四触点（追问条、状态点、popup、Alt+A）靠的还是「装载顺序 + 同一个全局
// 对象 + 三份必须对齐的清单」，编辑器一条都提醒不了。这一组测的不是界面长什么
// 样，是这四个触点背后那几根线有没有接上、有没有接成两份。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
// 注释里把规则原样讲了一遍，不剥的话每一条断言都会被自己的说明文字匹配上。
// 先行注释后块注释，顺序不能反（见 auto-translate-wiring.test.mjs 的说明）。
const code = (rel) => read(rel)
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');

const manifest = JSON.parse(read('manifest.json'));
const isolated = manifest.content_scripts.find((entry) => (entry.world || 'ISOLATED') === 'ISOLATED').js;

const LOCALE_DIRS = fs.readdirSync(path.join(REPO_ROOT, '_locales'));

test('呈现层装在调度层后面 —— 它订阅的那一刻就要能拿到状态', () => {
  const scheduler = isolated.indexOf('content/content-auto-translate.js');
  const presenter = isolated.indexOf('content/content-auto-status.js');
  assert.ok(presenter >= 0, 'content/content-auto-status.js 不在装载清单里');
  assert.ok(scheduler >= 0 && scheduler < presenter, '调度层必须排在呈现层之前');

  // 初始化的顺序同理：setupAutoStatus() 订阅时会立刻收到一次当前状态，反过来
  // 装就只能等下一次变化 —— 而一个判完就定下来的页面根本不会有下一次。
  const boot = code('content/content-bootstrap.js');
  assert.ok(boot.indexOf('ctx.setupAutoTranslate()') < boot.indexOf('ctx.setupAutoStatus()'));
});

test('呈现层只画，不碰队列、不碰代次、不自己判一遍', () => {
  const view = code('content/content-auto-status.js');
  assert.doesNotMatch(view, /collectTranslatableBlocks|insertTranslationBlock|runTranslationPass/);
  assert.doesNotMatch(view, /SiteRules\.decide\(/, '判定只有调度层问，问第二遍就会有第二个答案');
  assert.doesNotMatch(view, /bumpSession\(/, '代次归调度层，这一层翻篇会把正在跑的那一轮作废');
  // 用户表态走的是调度层的入口，不是自己去改 explicit 或者直接开译。
  assert.match(view, /ctx\.autoTranslate\.markPageExplicit\(\)/);
});

test('追问条的上限和计数是同一处说了算', () => {
  const view = code('content/content-auto-status.js');
  // 一处定义，两处比较：领号回来的那个权威计数，和省一趟往返的本地预检（见
  // 「追问的号要先领到手才画条子」）。两处比的都得是这个常量 —— 谁把 3 直接写
  // 进判断里，改上限的时候就只会改到一半。
  assert.equal((view.match(/MAX_ASKS/g) || []).length, 3, '一处定义，两处比较');
  // 加一这件事本身在服务工作者里（见「追问计数只有服务工作者一个人写」），这里
  // 只确认本页没有自己拿内存那份加一 —— 那会让上限永远够不着。
  assert.doesNotMatch(view, /ctx\.settings\.siteAskCount\[[^\]]*\]\s*(\+\+|=[^=])/);
});

test('站点规则写在哪个键上只有 normalizeHost 说了算', () => {
  const rules = code('shared/site-rules.js');
  assert.match(rules, /async function applyUserRule\(\{ host, state \}\)/);
  assert.match(rules, /const key = normalizeHost\(host\);/);

  // 三个写入点（追问条、popup、设置页）都得走它。各自拼一次键，写进去的和
  // decide() 读出来的迟早不是同一个。
  for (const file of ['content/content-auto-status.js', 'popup/popup.js']) {
    const source = code(file);
    assert.match(source, /SiteRules\.writeUserRule\(/, `${file} 应当走共用的写入口`);
    for (const hit of source.match(/[\w.]*normalizeHost/g) || []) {
      assert.ok(hit.endsWith('SiteRules.normalizeHost'), `${file} 的 normalizeHost 必须是共用那一个`);
    }
    assert.doesNotMatch(source, /siteRules\[/, `${file} 不该自己拼站点规则表`);
  }
});

test('popup 的「关」写的是 never，不是把规则删掉', () => {
  // 删掉之后判定往下落到内置名单，而 x.com、reddit.com 在内置名单里就是 always
  // —— 用户刚关掉，下一次打开又自动翻了，规则表里还干干净净。
  const popup = code('popup/popup.js');
  assert.match(popup, /writeUserRule\(pageState\.host, on \? 'never' : 'always'\)/);
});

test('popup 的三行从同一次往返画出来', () => {
  const popup = code('popup/popup.js');
  assert.equal((popup.match(/AUTO_PAGE_STATE/g) || []).length, 1, '问一次，不是一行问一次');
  const messaging = code('content/content-messaging.js');
  for (const type of ['AUTO_PAGE_STATE', 'TOGGLE_PAGE_TRANSLATION', 'SET_AUTO_PAUSED']) {
    assert.match(messaging, new RegExp(`case '${type}'`), `${type} 没有接收端`);
  }
});

test('「有译文就收起来，没有就译」只有一处说了算', () => {
  const page = code('content/content-page-translation.js');
  assert.match(page, /function hasPageTranslations\(\)/);
  assert.match(page, /ctx\.hasPageTranslations = hasPageTranslations;/);
  // 判据本身归显隐层所有。这里自己写一条选择器，就会漏掉那两个 :not()，
  // 于是用户划词译的一句让整页变成「翻过了」—— 再点一下是藏那一句，不是翻整页。
  assert.match(page, /ctx\.PAGE_TRANSLATION_SELECTOR/);
  assert.doesNotMatch(page, /ai-translator-inline-block/, '选择器不该在这里再写一遍');

  for (const file of ['popup/popup.js', 'content/content-float-ball.js']) {
    assert.doesNotMatch(code(file), /ai-translator-inline-block/, `${file} 不该自己再判一遍`);
  }
});

test('整页译文的判据带着那两个 :not()，划词和悬停不算', () => {
  const visibility = code('content/page/visibility.js');
  assert.match(visibility, /const PAGE_TRANSLATION_SELECTOR\s*=/);
  assert.match(visibility, /ctx\.PAGE_TRANSLATION_SELECTOR = PAGE_TRANSLATION_SELECTOR;/);
  const selector = visibility.match(/const PAGE_TRANSLATION_SELECTOR\s*=\s*\n?\s*'([^']+)'/);
  assert.ok(selector, '取不到选择器本身');
  for (const cls of ['ai-translator-selection-translation', 'ai-translator-hover-translation']) {
    assert.ok(selector[1].includes(`:not(.${cls})`), `${cls} 必须被排除`);
  }

  // 受管译文（PDF、漫画、Lexical 这类容器）的句柄同样带 .ai-translator-inline-block，
  // 挂在文档里的离屏 holder 上，所以同一条选择器就数到了 —— 不必再留一个
  // 「有没有受管译文」的问法，两个问法迟早各答各的。
  const managed = code('content/content-managed-translation.js');
  assert.doesNotMatch(managed, /hasManagedTranslations/, '两处判据必然会分家');
  assert.match(managed, /handle\.className = \['ai-translator-inline-block'/);
});

test('一轮翻译跑到一半藏译文，后面插进来的也得是藏着的', () => {
  const insert = code('content/page/insert.js');
  // 插入点必须跟上当前的显隐状态。跟在哪一步由 clip-guard.test.mjs 钉着：得等
  // 两道几何守卫量完再跟 —— .ai-translator-hidden 是 display:none，先藏起来，
  // 两道守卫量到的就都是零。
  assert.match(insert, /ctx\.applyTranslationVisibility\(translationEl\)/, '插入点没有跟上当前显隐状态');
  const visibility = code('content/page/visibility.js');
  assert.match(visibility, /function applyTranslationVisibility\(translationEl\)/);
  assert.match(visibility, /classList\.toggle\('ai-translator-hidden', state\.translationsVisible === false\)/);
  assert.doesNotMatch(insert, /ai-translator-hidden/, '类名归显隐层，这里不该再写一遍');
});

test('同步存储上的读—改—写只有服务工作者一个人做', () => {
  // 站点规则和追问计数都是「整份对象读出来、改一个键、整份写回」。同一个域名开
  // 着三个标签页，三页各自读出同一份旧对象再各自写回，后写的把先写的整个盖掉：
  // 「问三次就不再问」一次都攒不满，用户在 popup 上点的「关」也会凭空消失。
  const rules = code('shared/site-rules.js');
  assert.match(rules, /const IN_SERVICE_WORKER\s*=/);
  assert.match(rules, /function applyWrite\(message\)/);
  // 两条写入路径共用同一条队列 —— 各排各的等于没排。
  assert.equal((rules.match(/enqueue\(/g) || []).length, 2, '一处定义一处使用');
  assert.match(rules, /writeQueue = result\.catch/);
  for (const fn of ['applyUserRule', 'applyAskCount']) {
    assert.match(rules, new RegExp(`WRITES = \\{[^}]*${fn}`), `${fn} 必须挂在同一张表上`);
  }
  // 写入点两边共用一个名字：调用方不该自己判断「我现在是不是服务工作者」。
  assert.match(rules, /function writeUserRule\(hostname, state\) \{\s*return request\('rule'/);
  assert.match(rules, /function updateAskCount\(hostname, op\) \{\s*return request\('ask'/);

  for (const file of ['content/content-auto-status.js', 'popup/popup.js', 'options/options.js']) {
    assert.doesNotMatch(
      code(file),
      /storage\.sync\.set\([^)]*site(Rules|AskCount)/,
      `${file} 不该自己写这两张表`
    );
  }

  const background = code('background/background.js');
  assert.match(background, /case 'SITE_RULES_WRITE':/);
  assert.match(background, /SiteRules\.applyWrite\(message\)/);
  assert.match(background, /import '\.\.\/shared\/site-rules\.js';/);
});

test('勾了「总是」就要等规则落地再翻', () => {
  // 不等的话，用户在写落地之前切走这一页，这个站点就只翻了这一次 —— 条子已经
  // 收走，没有任何地方会再提起他说过「总是」。
  const status = code('content/content-auto-status.js');
  assert.match(status, /async function acceptAsk\(always\)/);
  assert.match(status, /await globalThis\.SiteRules\.writeUserRule\(location\.hostname, 'always'\)/);
  assert.match(status, /await clearAskCount\(\);[\s\S]{0,200}?markPageExplicit\(\)/);
  // 写失败不拦着这一页翻：他要的就是现在这一页。
  assert.match(status, /catch \(error\) \{[\s\S]{0,160}?site rule write failed/);
});

test('藏着译文时按「继续」，先把译文放回来', () => {
  // 藏译文会顺手把这一页停下（setTranslationsVisible → pauseCurrentPage），而
  // start() 里那道闩还认着「我现在想看原文」。直接重开一轮只会原地弹回 PAUSED，
  // popup 上那颗「继续」按下去毫无反应，还不报错。
  const auto = code('content/content-auto-translate.js');
  assert.match(
    auto,
    /function resumeCurrentPage\(\) \{[\s\S]{0,320}?ctx\.state\.translationsVisible === false[\s\S]{0,120}?ctx\.revealHiddenTranslations\(\);\s*return;/,
    '「继续」没有把译文放回来'
  );
  // 放回来这件事只有显隐层做得了，这里不该自己改标记或者摘类名。
  assert.doesNotMatch(auto, /translationsVisible = /, '标记归显隐层写');
  assert.doesNotMatch(auto, /ai-translator-hidden/, '类名归显隐层');
});

test('popup 那一行印「继续」的时候，页面那边真的会继续', () => {
  // 两边各写各的门，就会出现按钮印着「暂停」、点下去把 ERROR 变成 PAUSED 的
  // 局面 —— 用户得重开一次 popup 再点一次才轮到重试，而出错那一页正是最需要
  // 一下点中的。所以这道门在 popup 里只有一处说了算，且和页面那边一字不差。
  const auto = code('content/content-auto-translate.js');
  assert.match(
    auto,
    /function resumeCurrentPage\(\) \{\s*if \(status !== STATUS\.PAUSED && status !== STATUS\.ERROR\) return;/,
    '页面那边的「继续」门变了'
  );

  const popup = code('popup/popup.js');
  assert.match(popup, /const AUTO_RESUMABLE = new Set\(\['paused', 'error'\]\);/);
  // 标签和消息共用同一个集合，不是各判各的。
  assert.equal((popup.match(/AUTO_RESUMABLE/g) || []).length, 3, '一处定义，两处用');
  assert.match(popup, /AUTO_RESUMABLE\.has\(status\) \? t\('popupResumePage'\) : t\('popupPausePage'\)/);
  assert.match(popup, /paused: !AUTO_RESUMABLE\.has\(status\)/);
  assert.doesNotMatch(popup, /status === 'paused'/, '别再单独拿 paused 判一次');
});

test('Alt+A 和右键菜单、popup 那一行是同一个动作', () => {
  assert.ok(manifest.commands, 'manifest 里没有 commands');
  const command = manifest.commands['toggle-translate-page'];
  assert.ok(command, 'toggle-translate-page 没声明');
  assert.equal(command.suggested_key.default, 'Alt+A');

  const background = code('background/background.js');
  assert.match(background, /chrome\.commands\.onCommand\.addListener/);
  assert.match(background, /type: 'TOGGLE_PAGE_TRANSLATION'/);

  // popup 印的键位从 chrome.commands.getAll() 读：用户改过之后 manifest 那行
  // 就是假话。
  assert.match(code('popup/popup.js'), /chrome\.commands\.getAll\(\)/);
  assert.doesNotMatch(code('popup/popup.html'), /Alt\+A/);
});

test('manifest 里每个 __MSG__ 占位符，十个 _locales 都得有', () => {
  // 少一个 Chrome 直接拒装，而且报的是「无法载入扩展程序」这种不指哪儿的错。
  const placeholders = new Set(
    [...read('manifest.json').matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1])
  );
  assert.ok(placeholders.has('cmdTogglePage'));
  for (const dir of LOCALE_DIRS) {
    const messages = JSON.parse(read(path.join('_locales', dir, 'messages.json')));
    for (const key of placeholders) {
      assert.ok(messages[key] && messages[key].message, `_locales/${dir} 缺 ${key}`);
    }
  }
});

test('追问条也是一个面板根，进了那道防护栏的名单', () => {
  const css = read('content/content.css');
  const reset = css.slice(
    css.indexOf('/* ==================== Host-page containment'),
    css.indexOf('/* ==================== end of host-page containment')
  );
  assert.ok(reset.length > 0, '找不到防护栏那一段');
  const bar = (reset.match(/\[id="ai-translator-auto-bar"\]/g) || []).length;
  const ocr = (reset.match(/\[id="ai-translator-ocr-hover-btn"\]/g) || []).length;
  assert.equal(bar, ocr, '每一条 :is() 名单都要带上追问条，漏一条就是漏一类样式');
});

test('状态点的显隐只有一套机制', () => {
  // hidden 属性和我们自己的 display 规则同时在，UA 的 [hidden]{display:none}
  // 权重最低，结果是「设了 hidden 却还看得见」这种查半天的样子。
  const ball = code('content/content-float-ball.js');
  assert.match(ball, /class="ai-translator-status-dot" data-state="none"/);
  assert.doesNotMatch(ball, /ai-translator-status-dot" hidden/);
  assert.match(read('content/content.css'), /\.ai-translator-status-dot\[data-state="none"\] \{\s*display: none;/);
});

test('单修饰键的快捷键要等一等，别和 Alt+A 的第一下撞上', () => {
  // 划词和悬停的快捷键是「单独一个修饰键」，Alt+A 的第一下 keydown 和它长得一
  // 模一样。两个 keydown 处理器只要有一个直接动手，用户按一次 Alt+A 就会既译
  // 一句又译一页 —— 两次请求，用自己的 API 就是两份钱。判据放这里，是因为这
  // 件事按下去看着正常，只有账单知道。
  const utils = code('content/content-utils.js');
  assert.match(utils, /ctx\.armModifierTap = function\(key, run, options\)/);
  // 四个了结的口子：来了别的键作废、松开就算数、按住够久也算数，以及这一按已
  // 经被「按住划」花掉了就收回。
  assert.match(utils, /addEventListener\('keydown'[\s\S]*?event\.key !== pendingTap\.key\) settleModifierTap\('chord'\)/);
  assert.match(utils, /addEventListener\('keyup'[\s\S]*?event\.key === pendingTap\.key\) settleModifierTap\('fire'\)/);
  assert.match(utils, /if \(opts\.hold\) \{[\s\S]*?settleModifierTap\('hold'\)[\s\S]*?MODIFIER_TAP_HOLD_MS\)/);
  assert.match(utils, /ctx\.disarmModifierTap = function\(\) \{\s*settleModifierTap\('spent'\);/);

  // 和弦可以来得比「动手」还晚：按住 Alt 超过一瞬、或者按着 Alt 先划了一段，
  // 再去够 A。那一下撤不回已经译的，但必须把 onChord 补跑一次——不然松手之前
  // 划过的每一段都还当按住悬停，一个和弦换一串请求。'hold' 和 'spent' 都要留
  // 着盯，'fire' 不用：键都松了，没有第二下了。
  assert.match(utils, /if \(outcome === 'hold' \|\| outcome === 'spent'\) spentTap = tap;/);
  assert.match(utils, /addEventListener\('keydown'[\s\S]*?event\.key !== spentTap\.key\) settleSpentTap\('chord'\)/);
  assert.match(utils, /addEventListener\('keyup'[\s\S]*?event\.key === spentTap\.key\) settleSpentTap\('drop'\)/);
  // 盯着的那一下也要跟着窗口失焦和下一次 arm 一起清掉。
  assert.match(utils, /ctx\.armModifierTap = function[\s\S]{0,200}?settleSpentTap\('drop'\);/);
  assert.match(utils, /addEventListener\('blur'[\s\S]*?settleSpentTap\('drop'\)/);

  // 而这条闸门必须装在两个处理器里，不能只装一个。
  for (const rel of ['content/content-selection.js', 'content/content-hover-translation.js']) {
    assert.match(code(rel), /ctx\.armModifierTap\(event\.key,/, `${rel} 的修饰键快捷键没过那道闸门`);
  }

  // 「按住够久也算数」只给悬停开。划词是点一下的手势，给它开上，用户按着 Ctrl
  // 伸手去够 C 的那半秒就又变回一次翻译 —— 和弦的第二下来得慢一点就漏。
  assert.match(code('content/content-hover-translation.js'), /hold: true,/);
  assert.doesNotMatch(code('content/content-selection.js'), /hold:/, '划词不该开按住档');

  // 悬停还多两层：和弦作废时连「按住了」一起收回，否则接着划过的每一段都会被
  // 当成按住悬停（一个和弦，一串请求）；而「按住划」一旦真的译了，挂起的那一下
  // 要收回，否则松手会把刚划出来的译文又切掉。
  const hover = code('content/content-hover-translation.js');
  assert.match(hover, /ctx\.disarmModifierTap\(\);/);
  assert.match(hover, /chordKey = event\.key;/);
  assert.match(hover, /if \(chordKey\) return;/);
  assert.match(hover, /event\.key === chordKey\) chordKey = null;/);
});

test('追问的号要先领到手才画条子 —— 三次额度经不起两个标签页同时开', () => {
  // 三次是硬上限，而「现在问到第几次了」这件事同一时刻可能有好几个标签页在读。
  // 各读各的本地快照，读到的都是 2，于是四张条子一起画出来，问了四次。所以顺序
  // 反过来：先向唯一的主人（服务工作者）要一个号，它加完把真数发回来，够了才画。
  const status = code('content/content-auto-status.js');
  assert.match(status, /function reserveAskSlot\(\) \{\s*if \(askSlot !== 'none'\) return;\s*askSlot = 'pending';/);
  assert.match(status, /updateAskCount\('bump'\)\.then\(\(count\) => \{[\s\S]*?count > MAX_ASKS[\s\S]*?askSlot = 'denied'/);

  // 画之前的那道闸门：号没到手就先把条子收了，等 then 回来再 render 一次。
  assert.match(status, /if \(mode === 'ask' && askSlot !== 'granted'\) \{\s*reserveAskSlot\(\);\s*removeBar\(\);\s*return;\s*\}/);

  // 而领到号之后，本地那个数已经被自己这一次加过了 —— 第三次正好等于 3，再拿
  // 它和上限比就会把自己问掉。所以 granted 直接放行，本地判断只是省一趟往返。
  const should = status.slice(status.indexOf('function shouldAsk'));
  const shouldFn = should.slice(0, should.indexOf('\n  }') + 4);
  assert.ok(shouldFn.indexOf("askSlot === 'granted'") < shouldFn.indexOf('askCount() < MAX_ASKS'),
    '本地预检必须排在「号已到手」后面，否则第三次追问会被自己的计数挡掉');

  // 旧的「画完再记一笔」那个闩不能还留着：它和领号是同一件事的两种记法。
  assert.doesNotMatch(status, /bumpAskCount/);
  assert.doesNotMatch(status, /\blet counted\b/);
});

test('黑名单那一行是死的，不是关着的 —— 点不动，也带不动总开关', () => {
  // 前提在 site-rules.test.mjs：「the blocklist outranks the user own always」。
  // 既然写 always 下去也翻不了，这一行就不能装成一个能开的开关 —— 点一下什么都
  // 没变已经够糟，而它真正会变的那件事更糟：顺手把总开关打开，别的站点全自动翻
  // 起来，他本来只想管眼前这一个。
  const popup = code('popup/popup.js');
  assert.match(popup, /const blocked = !!pageState\.blocked;/);
  assert.match(popup, /elements\.toggleSiteAuto\.disabled = blocked;/);
  assert.match(popup, /elements\.toggleSiteAuto\.title = blocked \? t\('autoReasonBlocklist'\)/);
  assert.match(read('i18n/messages.js'), /autoReasonBlocklist:/, '理由那句话得真有');

  // 画面灰掉之外再挡一道：键盘走得到 disabled 的按钮，扩展页面也点得动。
  const body = popup.slice(popup.indexOf('async function toggleSiteAuto()'),
    popup.indexOf('async function togglePageTranslation()'));
  const guard = body.indexOf('pageState.blocked');
  assert.ok(guard > 0, 'toggleSiteAuto 里没有黑名单闸');
  assert.ok(guard < body.indexOf('autoTranslate: true'), '闸必须在打开总开关之前');

  // **不许**回头去读 auto.reason：总开关关着时它是 GLOBAL_OFF，黑名单被遮住，
  // 而那正是这个开关最该灰着的时候（site-rules.test.mjs 里有这一条的行为断言）。
  assert.doesNotMatch(popup, /reason === 'BLOCKLIST'/, "别用被遮住的 reason 判黑名单");

  // 这一句只有页面答得了（popup 自己的 location 是 chrome-extension://），
  // 而且答的必须是判定层那一个主人，不是 popup 自己再判一遍。
  assert.match(code('content/content-messaging.js'),
    /blocked: globalThis\.SiteRules\.isBlocklisted\(location\.hostname, location\.pathname\)/);
  const rules = code('shared/site-rules.js');
  assert.match(rules, /function isBlocklisted\(host, path\)/);
  assert.match(rules, /if \(isBlocklisted\(host, path\)\) return out\('off', REASONS\.BLOCKLIST\);/,
    '阶梯自己也得问这一问，否则两处迟早不一致');
  assert.doesNotMatch(popup, /isBlocklisted/, 'popup 手上没有内置表，判不了');
});

test('站点规则先落地，总开关才跟着开', () => {
  // 反过来写的话，规则写失败（同步存储配额）时总开关已经替所有别的站点开好了：
  // 他点的是一个站点，拿到的是整个浏览器。漏掉的那半边不伤人 —— 规则落了地而
  // 总开关没开，再点一次就补上了。
  const popup = code('popup/popup.js');
  const body = popup.slice(popup.indexOf('async function toggleSiteAuto()'),
    popup.indexOf('async function togglePageTranslation()'));
  const rule = body.indexOf('writeUserRule(');
  const globalOn = body.indexOf('autoTranslate: true');
  assert.ok(rule > 0 && globalOn > 0, '两条写入都得在这个函数里');
  assert.ok(globalOn > rule, '总开关不该排在站点规则前面');
  // 两条都在同一个 try 里，失败才说得出口。
  assert.ok(body.indexOf('try {') < rule && rule < body.indexOf('} catch (error) {'));
});
