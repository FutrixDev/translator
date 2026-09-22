// 交互四触点（追问条、状态点、popup、Alt+A）靠的还是「装载顺序 + 同一个全局
// 对象 + 三份必须对齐的清单」，编辑器一条都提醒不了。这一组测的不是界面长什么
// 样，是这四个触点背后那几根线有没有接上、有没有接成两份。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentCss, hoverSource, messagesSource } from './helpers/sources.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
// 注释里把规则原样讲了一遍，不剥的话每一条断言都会被自己的说明文字匹配上。
// 先行注释后块注释，顺序不能反（见 auto-translate-wiring.test.mjs 的说明）。
const stripComments = (text) => text
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');
const code = (rel) => stripComments(read(rel));
// 悬停那条路是一族文件，问它就整族一起问 —— 哪个函数落在哪一份是排版，不是契约。
const hoverCode = () => stripComments(hoverSource());

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

  // 四个写入点（追问条、popup、播放器里的字幕菜单、设置页）都得走它。各自拼一
  // 次键，写进去的和 decide() 读出来的迟早不是同一个。
  const WRITERS = [
    'content/content-auto-status.js',
    'popup/popup.js',
    'content/content-caption-controls.js',
  ];
  for (const file of WRITERS) {
    const source = code(file);
    assert.match(source, /SiteRules\.setSiteAuto\(/, `${file} 应当走共用的写入口`);
    // 三处说的都是「这个站点自动翻」这一句话，所以三处都该是 setSiteAuto。自己
    // 去调底下那个 writeUserRule，就会漏掉它顺带做的那两件事：挡住存不进规则表
    // 的 host，和把总开关打开。
    assert.doesNotMatch(source, /SiteRules\.writeUserRule\(/,
      `${file} 绕过 setSiteAuto 直接写规则`);
    for (const hit of source.match(/[\w.]*normalizeHost/g) || []) {
      assert.ok(hit.endsWith('SiteRules.normalizeHost'), `${file} 的 normalizeHost 必须是共用那一个`);
    }
    assert.doesNotMatch(source, /siteRules\[/, `${file} 不该自己拼站点规则表`);
  }
});

test('「这个站点自动翻 / 不自动翻」只有一份实现', () => {
  // popup 上那一行、播放器里字幕菜单的第一行、追问条上那个「总是」勾选框，说的
  // 都是同一句话（字幕并进主开关之后）。三处各写一遍，迟早一处写 never、另一处
  // 写「把规则删掉」。
  const rules = code('shared/site-rules.js');
  assert.match(rules, /async function setSiteAuto\(hostname, on\)/);
  assert.match(rules, /^\s*setSiteAuto,$/m, 'setSiteAuto 没有导出');

  assert.match(code('popup/popup.js'), /SiteRules\.setSiteAuto\(pageState\.host, !on\)/);
  assert.match(code('content/content-caption-controls.js'),
    /SiteRules\.setSiteAuto\(location\.hostname, !siteAutoOn\(\)\)/);
  assert.match(code('content/content-auto-status.js'),
    /SiteRules\.setSiteAuto\(location\.hostname, true\)/);
});

test('「关」写的是 never，不是把规则删掉', () => {
  // 删掉之后判定往下落到内置名单，而 x.com、reddit.com 在内置名单里就是 always
  // —— 用户刚关掉，下一次打开又自动翻了，规则表里还干干净净。
  const rules = code('shared/site-rules.js');
  const body = rules.slice(rules.indexOf('async function setSiteAuto(hostname, on)'));
  assert.match(body.slice(0, 600), /writeUserRule\(hostname, on \? 'always' : 'never'\)/);
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

test('显隐开关只收整页那一批 —— 划词译出来的一句不归它管', () => {
  // 这个开关的三个入口（悬浮球、Alt+A、popup）说的都是「这一页我想看原文」。
  // 用它去收划词译的那一句是两头不落好：那是用户刚刚指着一句话问出来的答案，
  // 而且插它的那条路（content-hover-translation.js）根本不读这个标记 —— 藏旧
  // 的、不藏新的，用户看到的就是这个开关时灵时不灵。
  const visibility = code('content/page/visibility.js');
  const fn = visibility.slice(visibility.indexOf('function setTranslationsVisible(visible)'),
    visibility.indexOf('function revealHiddenTranslations()'));
  assert.match(fn, /document\.querySelectorAll\(PAGE_TRANSLATION_SELECTOR\)/);
  assert.doesNotMatch(fn, /'\.ai-translator-inline-block'/, '收的是整页那一批，不是页面上所有译文块');

  // 划词/悬停那条插入路径确实不读这个标记 —— 上面那句话的依据。它只在整页那条
  // 路（content/page/insert.js）上被调用。
  assert.doesNotMatch(hoverCode(), /applyTranslationVisibility/);
  assert.match(code('content/page/insert.js'), /ctx\.applyTranslationVisibility\(translationEl\)/);
});

test('受管容器里那一句划词译文也不归显隐开关收', () => {
  // 受管译文（PDF、漫画、Lexical 这类容器）没有自己的节点：译文是原文块的
  // ::after，由一条文档级规则统管。所以上面那两个 :not() 在这里落不到实处 ——
  // 一个挂在 <html> 上的属性会把**所有**受管译文一起关掉，连同刚划词译出来的
  // 那一句；而且它管的是生成内容，接下来新划的一句照样不出来，直到整页译文
  // 重新显示为止。规则里必须把一次性那一类让开。
  const managed = code('content/content-managed-translation.js');
  assert.match(managed, /const ONE_OFF_ATTR = 'data-ai-translator-managed-one-off';/);
  assert.match(managed,
    /\[\$\{HIDDEN_ATTR\}\] \[\$\{BLOCK_ATTR\}\]:not\(\[\$\{ONE_OFF_ATTR\}\]\)::after \{\s*content: none !important;/,
    '藏译文的那条规则得把一次性那一类让开');

  // 判据只有一条：句柄自己答不答得上 PAGE_TRANSLATION_SELECTOR。这里再按
  // kind / className 判一遍的话，两处迟早各答各的。
  assert.match(managed, /!handle\.matches\(ctx\.PAGE_TRANSLATION_SELECTOR\)/);
  assert.match(managed, /if \(oneOff\) block\.setAttribute\(ONE_OFF_ATTR, ''\);\s*else block\.removeAttribute\(ONE_OFF_ATTR\);/);
  // 块放回去的时候三个标记一起摘 —— 留一个下来，下一条译文借这个块时就带着
  // 上一条的身份。
  assert.match(managed,
    /removeAttribute\(BLOCK_ATTR\);\s*entry\.block\.removeAttribute\(STATE_ATTR\);\s*entry\.block\.removeAttribute\(ONE_OFF_ATTR\);/);
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
  assert.match(status, /await globalThis\.SiteRules\.setSiteAuto\(location\.hostname, true\)/);
  assert.match(status, /await clearAskCount\(\);[\s\S]{0,200}?markPageExplicit\(\)/);
  // 写失败不拦着这一页翻：他要的就是现在这一页。
  assert.match(status, /catch \(error\) \{[\s\S]{0,160}?site rule write failed/);
});

test('规则没存上要说一声，不能只留一行控制台日志', () => {
  // 勾选框是个乐观控件：用户看到的是「记住了」。规则没落地的话，下一次打开这个
  // 站点还会再问一遍，而中间没有任何地方提起过这件事 —— 他只会觉得这个扩展记不
  // 住事。file:// 页面（location.hostname 是空串）每一次都走这条路。
  const status = code('content/content-auto-status.js');
  assert.match(status, /failed = true;/);
  assert.match(status, /setNotice\(failed \? t\('popupSiteRuleFailed'\) : ''\)/);
  // 同一句话的第二个来源：悬浮球菜单第一行「不再自动翻译这个站点」。那一行也是
  // 乐观控件，按下去菜单就收了。它不自己造条子 —— 两条窄条会在右下角叠在一起。
  assert.match(status, /ctx\.showAutoStatusNotice = setNotice;/);
  assert.match(code('content/content-float-ball.js'),
    /ctx\.showAutoStatusNotice\(t\('popupSiteRuleFailed'\)\)/);
  // 那句话得真画到条子上，而且压在追问和展开说明之上。
  assert.match(status, /const mode = notice \? 'notice' :/);
  assert.match(status, /mode === 'notice' \? notice : explainLine\(snap\)/);
  // 关掉一次只关掉一层：他关的是这句话，底下没答完的那一问不该跟着一起没。
  assert.match(status, /if \(notice\) notice = '';\s*\n\s*else if \(explaining\)/);
  // 这个模式在样式表里得和 explain 一样只剩一行字和一个关闭，否则那两个按钮会
  // 挂在一句「没能保存」下面，按下去是「翻译」和「不用」。
  const css = contentCss();
  for (const act of ['translate', 'dismiss']) {
    assert.match(
      css,
      new RegExp(`\\[data-mode="notice"\\][^{]*\\[data-act="${act}"\\]`),
      `notice 模式没藏掉「${act}」那个按钮`,
    );
  }
});

test('藏着译文时按「继续」，先把译文放回来', () => {
  // 藏译文会顺手把这一页停下（setTranslationsVisible → pauseCurrentPage），而
  // start() 里那道闩还认着「我现在想看原文」。直接重开一轮只会原地弹回 PAUSED，
  // popup 上那颗「继续」按下去毫无反应，还不报错。
  const auto = code('content/content-auto-translate.js');
  assert.match(
    auto,
    /function resumeCurrentPage\(cause\) \{[\s\S]{0,760}?ctx\.state\.translationsVisible === false[\s\S]{0,160}?ctx\.revealHiddenTranslations\(\);[\s\S]{0,200}?\}\s*start\('resume'\);/,
    '「继续」没有把译文放回来'
  );
  // 放回来之后这一轮通常是在显隐层那次回调里接上的（它会再叫一次 resumeCurrentPage）
  // —— 唯独停在 ERROR 的那一页接不上，得由这一次自己 start()。那一条另有专门的
  // 一测，见「出错停下的那一页，看一眼原文不算「重试」」。
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
    /function resumeCurrentPage\(cause\) \{\s*if \(status !== STATUS\.PAUSED && status !== STATUS\.ERROR\) return;/,
    '页面那边的「继续」门变了'
  );

  const popup = code('popup/popup.js');
  assert.match(popup, /const AUTO_RESUMABLE = new Set\(\['paused', 'error'\]\);/);
  assert.equal((popup.match(/const AUTO_RESUMABLE\b/g) || []).length, 1, '一处定义');
  // 标签和消息共用同一个集合，不是各判各的。
  assert.match(popup, /AUTO_RESUMABLE\.has\(status\) \? t\('popupResumePage'\) : t\('popupPausePage'\)/);
  assert.match(popup, /paused: !AUTO_RESUMABLE\.has\(live\)/);

  // 而且点下去那一刻要**重新问一遍**。按钮是 popup 打开那一刻画的，他盯着它的
  // 这几秒里那一轮可能已经失败了；拿快照去写，送出去的 paused:true 会把 ERROR
  // 改写成 PAUSED（从 popup 来的这一下不带 cause:'hidden'，页面那边那道 ERROR
  // 守卫拦不住它），失败的原因就此没人说得出，而那一行正是他重试的入口。
  const click = popup.slice(popup.indexOf('async function togglePagePause()'));
  const body = click.slice(0, click.indexOf('\n}'));
  assert.ok(body.indexOf('await refreshPageRows()') < body.indexOf('SET_AUTO_PAUSED'),
    '先重新问一页，再决定送什么');
  assert.match(body, /AUTO_RESUMABLE\.has\(drawn\) !== AUTO_RESUMABLE\.has\(live\)\) return;/,
    '状态变过就只重画 —— 这一下瞄的是另一颗按钮');
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
  const css = contentCss();
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
  assert.match(contentCss(), /\.ai-translator-status-dot\[data-state="none"\] \{\s*display: none;/);
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
  // 「按住够久也算数」还带一条例外：命令键位占着的修饰键不开这一档（Alt+A 的
  // 那半秒不该先译一段）。那条规则是「什么时候**不**动手」，比对着源文件看更
  // 该跑一遍 —— 整套闸门的行为判据在 test/unit/modifier-tap.test.mjs。
  assert.match(utils, /if \(opts\.hold && !commandModifiers\.has\(key\)\) \{[\s\S]*?settleModifierTap\('hold'\)[\s\S]*?MODIFIER_TAP_HOLD_MS\)/);
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
  for (const [rel, src] of [['content/content-selection.js', code('content/content-selection.js')],
    ['悬停那一族', hoverCode()]]) {
    assert.match(src, /ctx\.armModifierTap\(event\.key,/, `${rel} 的修饰键快捷键没过那道闸门`);
  }

  // 「按住够久也算数」只给悬停开。划词是点一下的手势，给它开上，用户按着 Ctrl
  // 伸手去够 C 的那半秒就又变回一次翻译 —— 和弦的第二下来得慢一点就漏。
  assert.match(hoverCode(), /hold: true,/);
  assert.doesNotMatch(code('content/content-selection.js'), /hold:/, '划词不该开按住档');

  // 悬停还多两层：和弦作废时连「按住了」一起收回，否则接着划过的每一段都会被
  // 当成按住悬停（一个和弦，一串请求）；而「按住划」一旦真的译了，挂起的那一下
  // 要收回，否则松手会把刚划出来的译文又切掉。
  const hover = hoverCode();
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
  // 领号那一下还得先问这一页看不看得见（见「追问的号只在看得见的标签页里领」）。
  assert.match(status, /if \(mode === 'ask' && askSlot !== 'granted'\) \{\s*if \(document\.visibilityState === 'visible'\) reserveAskSlot\(\);\s*removeBar\(\);\s*return;\s*\}/);

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
  assert.match(messagesSource(), /autoReasonBlocklist:/, '理由那句话得真有');

  // 画面灰掉之外再挡一道：键盘走得到 disabled 的按钮，扩展页面也点得动。
  const body = popup.slice(popup.indexOf('async function toggleSiteAuto()'),
    popup.indexOf('async function togglePageTranslation()'));
  const guard = body.indexOf('pageState.blocked');
  assert.ok(guard > 0, 'toggleSiteAuto 里没有黑名单闸');
  assert.ok(guard < body.indexOf('SiteRules.setSiteAuto('), '闸必须在写规则之前');

  // 播放器里那一行是同一个开关的第二块画布，同样得挡住：写 always 下去不算数，
  // 而「顺带打开总开关」那个副作用会照跑。
  const controls = code('content/content-caption-controls.js');
  assert.match(controls, /siteRuleWritable\(location\.hostname, location\.pathname\)/);
  assert.match(controls,
    /parts\.enableItem\.classList\.toggle\('ai-cap-disabled', !ruleWritable\(\)\);/);
  const click = controls.slice(controls.indexOf("enableItem.addEventListener('click'"));
  const capGuard = click.indexOf("ai-cap-disabled");
  assert.ok(capGuard > 0 && capGuard < click.indexOf('SiteRules.setSiteAuto('),
    '字幕菜单那一行点下去之前得先看黑名单');

  // **不许**回头去读 auto.reason：总开关关着时它是 GLOBAL_OFF，黑名单被遮住，
  // 而那正是这个开关最该灰着的时候（site-rules.test.mjs 里有这一条的行为断言）。
  assert.doesNotMatch(popup, /reason === 'BLOCKLIST'/, "别用被遮住的 reason 判黑名单");

  // 这一句只有页面答得了（popup 自己的 location 是 chrome-extension://），
  // 而且答的必须是判定层那一个主人，不是 popup 自己再判一遍。
  assert.match(code('content/content-messaging.js'),
    /blocked: globalThis\.SiteRules\.isBlocklisted\(location\.hostname, location\.pathname\)/);
  const rules = code('shared/site-rules.js');
  assert.match(rules, /function isBlocklisted\(host, path\)/);
  // 阶梯自己也得问这一问，否则两处迟早不一致。它问完之后还要再问一次 isBlocked()，
  // 那一问只决定说辞：内置表里的 never（arxiv 的 /pdf/）和黑名单（网银）都是「翻
  // 不过来」，但对用户说的不是同一句话。
  assert.match(rules, /if \(isBlocklisted\(host, path\)\) \{\s*\n\s*return out\('off', isBlocked\(host, path\) \? REASONS\.BLOCKLIST : REASONS\.BUILTIN_NEVER\);/,
    '阶梯自己也得问这一问，否则两处迟早不一致');
  assert.doesNotMatch(popup, /isBlocklisted/, 'popup 手上没有内置表，判不了');
});

test('站点规则先落地，总开关才跟着开', () => {
  // 反过来写的话，规则写失败（同步存储配额）时总开关已经替所有别的站点开好了：
  // 他点的是一个站点，拿到的是整个浏览器。漏掉的那半边不伤人 —— 规则落了地而
  // 总开关没开，再点一次就补上了。
  const rules = code('shared/site-rules.js');
  const body = rules.slice(rules.indexOf('async function setSiteAuto(hostname, on)'));
  const fn = body.slice(0, body.indexOf('\n  }') + 4);
  const rule = fn.indexOf('writeUserRule(');
  const globalOn = fn.indexOf('autoTranslate: true');
  assert.ok(rule > 0 && globalOn > 0, '两条写入都得在这个函数里');
  assert.ok(globalOn > rule, '总开关不该排在站点规则前面');
  // 规则写不进去就该抛出去 —— 两条写入之间没有 catch，调用方才答得出「没存上」。
  assert.equal(/catch/.test(fn), false, 'setSiteAuto 不该自己把失败吞掉');

  // 调用方接得住：popup 那一行失败了要说得出口。
  const popup = code('popup/popup.js');
  const toggle = popup.slice(popup.indexOf('async function toggleSiteAuto()'),
    popup.indexOf('async function togglePageTranslation()'));
  const call = toggle.indexOf('SiteRules.setSiteAuto(');
  assert.ok(toggle.indexOf('try {') < call && call < toggle.indexOf('} catch (error) {'));
});

test('译文藏着的时候改了规则也得重判 —— 否则那个站点开关关不掉', () => {
  // 「我想看原文」把这一页停在 PAUSED。这时在 popup 上把站点关掉：规则落地会
  // 重开一轮，而那一轮要是直接在隐藏闩上返回，status 和 reason 都还停在上一次，
  // 这一行照着 status 画出来还是「开」—— 再点一次又写一遍 never，怎么点都关不掉。
  const auto = code('content/content-auto-translate.js');
  const guard = auto.slice(auto.indexOf('if (ctx.state.translationsVisible === false || pausedByUser)'));
  assert.match(guard.slice(0, 900),
    /const held = resolve\(pageLang\);\s*reason = held\.reason;\s*setStatus\(held\.verdict === 'off' \? STATUS\.OFF : STATUS\.PAUSED\);/,
    '隐藏闩得先重判再返回，不能原地掉头');
  // 规则改了确实会重开一轮，否则上面那段永远跑不到。
  const keys = auto.slice(auto.indexOf('const RESTART_KEYS'), auto.indexOf('function onSettingsChanged'));
  assert.match(keys, /'siteRules'/);
  // 站点那一行自己每次都重判（auto.siteAuto），所以这一段现在护的是另外两样：
  // reason 决定状态点上那句说明，status 决定暂停那一行在不在 —— 藏着的一页被
  // 改成 never 之后，那一行不该还印着「继续」，点下去又把它开回来。
  assert.match(auto, /siteAuto: siteAuto\(\),/, '站点那一句跟着快照一起回');
  const popup = code('popup/popup.js');
  assert.match(popup, /function siteAutoOn\(\) \{\s*return !!\(pageState && pageState\.auto && pageState\.auto\.siteAuto\);/);
  assert.equal((popup.match(/siteAutoOn\(\)/g) || []).length, 3,
    '一处定义、两处调用（画这一行、点这一行）—— 画的和点的必须是同一句');
});

test('一次性的「翻译这一页」不能让站点开关翻成「开」', () => {
  // 没设过规则的站点，追问条上点「翻译」而没勾「总是」：markPageExplicit() 把这
  // 一页推进 idle/running，可规则表里一条都没落地，下次再来照样问他。那一行照着
  // status 画就会写「开」—— 而他顺手去点那个看起来已经开着的开关，写下的是一条
  // **永久的 never**：他想开，反倒关死了。行为断言在
  // test/e2e/auto-translate-touchpoints.spec.js 的同名旅程里。
  const auto = code('content/content-auto-translate.js');
  assert.match(auto, /function siteAuto\(\) \{\s*return resolve\(pageLang, \{ explicit: false \}\)\.verdict === 'auto';\s*\}/,
    '站点那一句得把用户在这一页表过的那一下刨掉再判');
  assert.match(auto, /siteAuto: siteAuto\(\),/, '它得跟着快照一起回 popup');
  // 默认那一头不许跟着改：resolve() 不带参数问的仍是「这一页此刻该不该翻」，
  // 连同他表过的态 —— 兑现那一下点击的整条路（后续长出来的内容）全靠它。
  assert.match(auto, /explicit: options && options\.explicit === false \? false : explicit/);

  // 刨的必须是 explicit 本身，不能换成「只认 USER_ALWAYS / BUILTIN_ALWAYS 这两
  // 条理由」：decide() 的阶梯上 explicit 排在所有站点规则之前，一旦表过态那两条
  // 就被挡在后面 —— 在 x.com（内置 always）上按一下 Alt+A，这一行反倒翻成「关」。
  const ladder = code('shared/site-rules.js');
  const decide = ladder.slice(ladder.indexOf('function decide(input)'));
  assert.ok(decide.indexOf("REASONS.USER_EXPLICIT") < decide.indexOf("REASONS.USER_ALWAYS"),
    'explicit 排在站点规则之前 —— 这正是不能按 reason 认的原因');
  const popup = code('popup/popup.js');
  assert.doesNotMatch(popup, /USER_ALWAYS|BUILTIN_ALWAYS/, 'popup 手上没有阶梯，认不了 reason');
  assert.doesNotMatch(popup, /siteAutoOn\(status\)/, '站点那一行不看 status');
});

test('pending 不能画出一行「暂停这一页」—— 它只会走到 ask 或 off，没有什么可停', () => {
  // 走到 pending 的前提就是第一问已经答了 ask（off 和 auto 都当场返回了），而
  // 第二问带上语言之后，decide() 的阶梯上剩给它的只有 off 和 ask。所以一个
  // pending 的页面永远不会变成「在自动翻」—— 给它画一行「暂停这一页」，用户按
  // 下去停的是一件从来没开始的事，而按钮会就此改口写「继续」。
  const popup = code('popup/popup.js');
  const set = popup.slice(popup.indexOf('const AUTO_ACTIVE'), popup.indexOf('const AUTO_RESUMABLE'));
  assert.doesNotMatch(set, /'pending'/, 'pending 不是「自动翻译在管这一页」');
  for (const s of ['idle', 'running', 'paused', 'error']) assert.match(set, new RegExp(`'${s}'`));

  // 这个集合只管这一行。站点那一行问的是另一句话（见 siteAutoOn()）。
  assert.match(popup, /const pauseRow = AUTO_ACTIVE\.has\(status\);/);
  // 数用了几次没有意义（点击那一头要判的次数会变）；要钉住的是**没有第二份判
  // 据**：状态字面量在 popup 里只许出现在这两个集合的定义里，别处再拼一遍，画
  // 出来的那一行和点下去做的那件事就会各判各的。
  assert.equal((popup.match(/const AUTO_ACTIVE\b/g) || []).length, 1, '一处定义');
  const literals = popup.split('\n')
    .filter((line) => !/const AUTO_(ACTIVE|RESUMABLE)\b/.test(line))
    .join('\n');
  for (const s of ['idle', 'running', 'paused', 'error']) {
    assert.doesNotMatch(literals, new RegExp(`'${s}'`), `'${s}' 只许写在集合的定义里`);
  }

  // 上面那段推理的依据：decide() 里 off 和 auto 都当场返回，ask 是阶梯的末端。
  const rules = code('shared/site-rules.js');
  const ladder = rules.slice(rules.indexOf('function decide(input)'));
  assert.match(ladder.slice(0, 2000), /if \(!pageLang\) return out\('ask', REASONS\.UNKNOWN_LANGUAGE\);\s*return out\('ask', REASONS\.DEFAULT_ASK\);/,
    '语言那一段之后没有通往 auto 的路 —— 这条一旦变了，pending 的含义也变了');
});

test('收起译文不该被 API key 拦下 —— 那一下不花钱', () => {
  // 用内置引擎译完、事后把引擎换成自定义的（还没填 key），按钮上写着「收起
  // 译文」，点下去弹出设置页、译文还在原地。门只对真要开译的那一下开。
  const popup = code('popup/popup.js');
  const body = popup.slice(popup.indexOf('async function translateCurrentPage()'),
    popup.indexOf('function openSettings()'));
  assert.match(body, /const willTranslate = !isHideAction\(\);/);
  assert.match(body, /if \(willTranslate && settings\.translationEngine === 'ai' && !settings\.apiKey\)/);
});

test('「这一下是不是收起」只有一个出处 —— 按钮上那行字和那道门问的是同一句', () => {
  // 两处各写一遍迟早对不上。而且这一问里的 translationsVisible 不是装饰：译文
  // 藏着的那一下按下去走的是 translatePage()，它会把这一页新长出来、还没翻的块
  // 补上 —— 那些块要花钱，门得拦得住。
  const popup = code('popup/popup.js');
  assert.match(popup,
    /function isHideAction\(\) \{\s*return !!\(pageState && pageState\.hasTranslations && pageState\.translationsVisible\);\s*\}/);
  assert.equal((popup.match(/isHideAction\(\)/g) || []).length, 3, '一处定义、两处用，多一处就是又立了一套');
  assert.match(popup, /const showing = isHideAction\(\);/);
  // 「藏着的那一下会补新块」这件事是上面那句注释的依据，它变了这个测试就该重判。
  const pageSide = code('content/content-page-translation.js');
  const toggle = pageSide.slice(pageSide.indexOf('function togglePageTranslation()'));
  assert.match(toggle.slice(0, 500), /translationsVisible !== false\)[\s\S]*?return 'restored';[\s\S]*?translatePage\(\);/);
});

test('追问的号只在看得见的标签页里领 —— 后台那一串不能把三次机会花光', () => {
  // 中键点开的十条链接、浏览器预渲染的那一份，都会一路跑到 render()。条子在那些
  // 标签页里谁也没见过，号却照领 —— 三次机会在用户面前一次没露过的情况下花光，
  // 这个域名从此永远安静。
  const view = code('content/content-auto-status.js');
  assert.match(view,
    /if \(document\.visibilityState === 'visible'\) reserveAskSlot\(\);/,
    '领号前得先确认这一页看得见');
  assert.equal((view.match(/reserveAskSlot\(\)/g) || []).length, 2, '一处定义一处调用，多一处就是又开了一条不看可见性的路');
  // 而且「等它被看见了再领」得真有人来叫第二遍：预渲染转正走的也是这个事件。
  assert.match(view,
    /document\.addEventListener\('visibilitychange', \(\) => \{\s*if \(document\.visibilityState === 'visible'\) render\(\);\s*\}\);/,
    '页面转到前台时必须重画一次，否则那张条子永远不会出现');
});

test('用户按下的暂停是一道闩 —— 别的标签页改规则不能把它顶开', () => {
  // status 会被下一次 start() 覆盖，而 start() 常常是别人替他叫的：另一个标签页
  // 在追问条上点了「总是」，siteRules 一落地，这一页的 onSettingsChanged 就重开
  // 一轮 —— 他按下的暂停当场失效，页面自己又翻起来了。
  const auto = code('content/content-auto-translate.js');
  assert.match(auto, /let pausedByUser = false;/);
  assert.match(auto, /if \(ctx\.state\.translationsVisible === false \|\| pausedByUser\) \{/, 'start() 得认这道闩');

  const pause = auto.slice(auto.indexOf('function pauseCurrentPage('), auto.indexOf('    /**\n     * 「继续翻这一页」'));
  assert.match(pause, /if \(cause !== 'hidden'\) pausedByUser = true;/,
    '藏译文那一停不上闩：start() 看 translationsVisible 已经拦着了，再上一道就会被一次「显示译文」顺手解开');

  // 解闩的只有用户自己后说的那两句（继续 / 翻译整页），外加「换了一页」。
  assert.equal((auto.match(/pausedByUser = false;/g) || []).length, 4,
    '一处声明、三处解闩（resumeCurrentPage / markPageExplicit / onRouteChange），多一处就是又开了一条自己会解闩的路');
  const resume = auto.slice(auto.indexOf('function resumeCurrentPage('), auto.indexOf('    /**\n     * 用户在这一页点了「翻译整页」'));
  assert.match(resume, /pausedByUser = false;/);
  // 解铃还须系铃人：把译文放回来不等于撤销他在 popup 上按下的暂停。越过这道闩
  // 的话，藏一下再显示一下就把暂停洗掉了，而他从头到尾没碰过那颗按钮。
  assert.match(resume,
    /if \(cause === 'hidden'\) \{\s*if \(pausedByUser\) return;\s*if \(status === STATUS\.ERROR\) return;\s*\} else \{/,
    '带 hidden 的继续不解闩，而且闩还在就得原地停住');
  const visibility = code('content/page/visibility.js');
  assert.match(visibility,
    /resumeCurrentPage\('hidden'\);\s*else ctx\.autoTranslate\.pauseCurrentPage\('hidden'\);/,
    '显隐层这两下都要报上名来');
  assert.match(code('content/content-messaging.js'),
    /pauseCurrentPage\(\);\s*else ctx\.autoTranslate\.resumeCurrentPage\(\);/,
    'popup 那两下是用户自己说的，不带 cause');
  const explicit = auto.slice(auto.indexOf('function markPageExplicit()'), auto.indexOf('function onRouteChange('));
  assert.match(explicit,
    /const wasHeld = pausedByUser;\s*pausedByUser = false;\s*if \(explicit && !wasHeld\) return;/,
    '闩解了就得重开一轮 —— 哪怕这一页早就表过态，那一轮正停在闩上');

  // 他按的那句话是「**这一页**先别翻了」。SPA 里点进下一篇就是新的一页，闩不解
  // 的话往后全是原文，而「继续」那颗按钮此刻指着的是他早就离开的那一页。
  const route = auto.slice(auto.indexOf('function onRouteChange('), auto.indexOf('const RESTART_KEYS'));
  assert.match(route,
    /explicit = false;[\s\S]*pausedByUser = false;[\s\S]*pageLang = null;\s*langResolved = false;\s*start\(`route:/,
    '换了一页，表态、闩和上一页量到的语言都归零');

  // 语言是**一页**的测量结果，清它的只有「换了一页」那一下 —— 声明一处、过期一
  // 处，多一处就是又多了一个主人。尤其是 start()：它说的是「重新判」，同一个文档
  // 上量到的语言照样作数；反过来，这一处要是没有，藏着译文时换一页就会被上一页
  // 的语言判成 off，而「显示译文」只叫得醒 PAUSED / ERROR，那一页再也问不出来。
  assert.equal((auto.match(/pageLang = null;/g) || []).length, 2,
    '一处声明、一处过期（onRouteChange）');
  const startBody = auto.slice(auto.indexOf('function start(why)'), auto.indexOf('function stopDiscovery('));
  assert.doesNotMatch(startBody, /pageLang = null;/, 'start() 不清语言：它不是「换了一页」');
});

test('球上那两颗按钮键盘够得着', () => {
  // 计划里写死的那一行：追问条、状态点、popup 四行都要能 Tab / Enter。span 上挂
  // 一个 role="button" 不算 —— 它既不进 Tab 序，也不认 Enter。
  const ball = code('content/content-float-ball.js');
  assert.match(ball, /<button type="button" class="ai-translator-status-dot"/);
  assert.match(ball, /<button type="button" class="ai-translator-ball-more"/);
  assert.doesNotMatch(ball, /<span class="ai-translator-(status-dot|ball-more)"/, '回到 span 就等于键盘又够不着了');

  // 鼠标那条路摊在 mousedown/mouseup 一对事件上（要分辨拖拽），键盘一个字都跑不到，
  // 所以得自己派活；<button> 合成的那一下 click 要挡掉，否则将来一按点两回。
  const keydown = ball.slice(ball.indexOf("state.floatBall.addEventListener('keydown'"));
  assert.ok(keydown, '球上没有键盘入口');
  assert.match(keydown.slice(0, 700), /if \(e\.key !== 'Enter' && e\.key !== ' ' && e\.key !== 'Spacebar'\) return;/);
  assert.match(keydown.slice(0, 700), /const hit = pressZone\(e\.target\);[\s\S]*?e\.preventDefault\(\);/,
    '落在哪一颗上得问同一个 pressZone，别在键盘这条路上再判一遍');
  assert.match(keydown.slice(0, 700), /if \(hit === 'menu'\) toggleFloatMenu\(\);/);
  assert.match(keydown.slice(0, 700), /ctx\.toggleAutoStatusExplain\(\)/);

  // 「Esc 关掉浮层」统管在 content-selection.js 那一处（它连着 popup、划词、悬停
  // 一起关）。这里再挂一个就是同一个问题有了两个主人 —— 迟早一个关了一个没关。
  assert.doesNotMatch(ball, /'Escape'/, 'Esc 的主人是 content-selection.js，不是悬浮球');
  assert.match(code('content/content-selection.js'), /if \(ctx\.hideFloatMenu\) ctx\.hideFloatMenu\(\);/);
  // 而菜单一撤焦点就掉回 <body>：焦点原本在菜单里的那一种，得把它送回 ··· 上。
  // 鼠标点别处关的不算 —— 那时候焦点本来就不在这儿，抢回来是打断。
  assert.match(ball,
    /const returnFocus = state\.floatMenu\.contains\(document\.activeElement\);[\s\S]*?if \(returnFocus\) \{[\s\S]*?more\.focus\(\);/);
  assert.match(ball, /function setMoreExpanded\(open\)/);
  assert.match(ball, /more\.setAttribute\('aria-expanded', open \? 'true' : 'false'\)/);

  // 状态点没有文字，读屏只能靠 aria-label，而它说的必须和 title 是同一句。
  const view = code('content/content-auto-status.js');
  assert.match(view, /dot\.title = line;\s*dot\.setAttribute\('aria-label', line\);/);

  // ··· 平时 opacity:0。焦点停在一个看不见的东西上，人看到的是焦点凭空消失了一格。
  const css = contentCss();
  assert.match(css, /#ai-translator-float-ball:focus-within \.ai-translator-ball-more \{/);
  for (const cls of ['status-dot', 'ball-more']) {
    assert.match(css, new RegExp(`#ai-translator-float-ball \\.ai-translator-${cls}:focus-visible`), `${cls} 没有焦点环`);
  }
});

test('出错停下的那一页，看一眼原文不算「重试」', () => {
  // 「隐藏译文 / 显示译文」走的是 pauseCurrentPage('hidden') / resumeCurrentPage('hidden')，
  // 和 popup 上那颗「暂停 / 继续」共用同两个函数。可这两句话不是一回事：一句是
  // 「我现在想看原文」，另一句是「这件事重来一遍」。ERROR 那一页上，两者的差价是
  // 一串真发出去的请求。
  const auto = code('content/content-auto-translate.js');
  const pause = auto.slice(auto.indexOf('function pauseCurrentPage('), auto.indexOf('function resumeCurrentPage('));
  const resume = auto.slice(auto.indexOf('function resumeCurrentPage('), auto.indexOf('function markPageExplicit('));

  // 一、藏译文不改写 ERROR。改写了，状态点就从「出错」变成「已暂停」——「为什么
  // 停了」就此没人说得出；而下面那一道也就白设了，因为回来时它已经是 PAUSED。
  assert.match(pause, /if \(cause === 'hidden' && status === STATUS\.ERROR\) return;/,
    '藏一下译文不该把出错的那一页改写成「已暂停」');
  // 二、显示译文不叫醒 ERROR。
  assert.match(resume,
    /if \(cause === 'hidden'\) \{\s*if \(pausedByUser\) return;\s*if \(status === STATUS\.ERROR\) return;/,
    '「显示译文」不是「重试」：出错的那一页等的是一句明确的「继续」');

  // 三、而他真说出那一句的时候，它得动。显隐层那条路是拐个弯回来的：
  // start() 前先把译文放回去，放回去那一下显隐层又会叫一次 resumeCurrentPage('hidden')
  // —— 平时这一轮就是在那一次里接上的，可停在 ERROR 的那一页正好被上面第二道挡
  // 住。所以这一处不能无条件 return，否则 popup 上的「继续」在藏着译文时按下去
  // 永远没有反应，而那是这一页唯一的重试入口。
  assert.match(resume,
    /ctx\.revealHiddenTranslations\(\);[\s\S]*?if \(status !== STATUS\.ERROR\) return;\s*\}\s*start\('resume'\);/,
    '藏着译文的 ERROR 页，「继续」得由这一次自己接上');
});

test('悬浮球菜单第一行是「不再自动翻译这个站点」，而且只在它真在翻的时候才有', () => {
  // 关掉一个站点的自动翻译在此之前只有一条路：进设置页，在列表里找到它。那是这
  // 类功能差评的第一来源 —— 撤销比开启难。所以这一行排在菜单最前面。
  const ball = code('content/content-float-ball.js');
  const menu = ball.slice(ball.indexOf('state.floatMenu.innerHTML = `'));

  const stop = menu.indexOf("data-action=\"stop-site-auto\"");
  assert.ok(stop > 0, '悬浮球菜单里没有「不再自动翻译这个站点」那一行');
  for (const action of ['translate-input', 'translate-selection', 'translate-page', 'settings']) {
    assert.ok(stop < menu.indexOf(`data-action="${action}"`), `那一行得排在 ${action} 前面`);
  }
  // 站点名要真印出来。一行不带站名的「不再自动翻译」，在一个 iframe 套着三个域
  // 名的页面上说的是哪一个，用户无从知道。
  assert.match(menu, /t\('autoStopSite'\)\.replace\('\{site\}', stopSiteHost\)/);
  assert.match(messagesSource(), /autoStopSite:/, '那句话得真有');

  // 画的是 siteAuto，不是状态、也不是闸门。拿状态画的话，用户在一个没设过规则的
  // 站点上点一次「翻译整页」，这一行就会冒出来 —— 而他点下去写进去的是一条永久
  // 的 never（同一个坑在 popup 和字幕菜单上各踩过一次，见 siteAuto() 的注释）。
  assert.match(ball, /ctx\.autoTranslate\.state\(\)\.siteAuto/);
  assert.doesNotMatch(ball, /state\(\)\.status/, '别拿状态画站点规则');
  // 写不进去的站点不画：点下去要么毫无动静，要么只剩「顺带打开总开关」那半边。
  assert.match(ball, /SiteRules\.siteRuleWritable\(location\.hostname, location\.pathname\)/);
});

test('「不再自动翻译」先落规则再还原 —— 反过来译文会自己长回来', () => {
  const ball = code('content/content-float-ball.js');
  const fn = ball.slice(ball.indexOf('async function stopSiteAuto()'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);

  const write = body.indexOf('SiteRules.setSiteAuto(location.hostname, false)');
  const restore = body.indexOf('ctx.setTranslationsVisible(false)');
  assert.ok(write > 0, '没走 setSiteAuto —— popup 那一行和字幕菜单第一项说的是同一句话');
  assert.ok(restore > 0, '置了 never 却没还原这一页');
  assert.ok(write < restore,
    '还原跑在写规则前面的话，调度层此刻判的仍是 auto，它会把刚还原的这一页重新翻一遍');

  // 还原走显隐层那唯一的入口：自己去摘节点是第二份实现，而且摘不干净（受管容器
  // 那一批没有自己的节点，「仅显示译文」那一半也得跟着回来）。
  assert.doesNotMatch(body, /querySelectorAll|\.remove\(\)/, '别自己动手摘译文');

  // 写失败那一路不还原 —— 规则没落地，还原只会被调度层立刻推翻。
  const fail = body.indexOf("ctx.showAutoStatusNotice(t('popupSiteRuleFailed'))");
  assert.ok(fail > 0 && fail < restore, '写失败得说一声');
  assert.match(body.slice(fail), /^[\s\S]{0,80}?return;/, '写失败之后不该接着还原');
});
