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
  assert.equal((view.match(/MAX_ASKS/g) || []).length, 2, '一处定义一处使用');
  // 计数是读改写，不是拿内存里那份加一：同一个站点开三个标签页，各算各的就会
  // 三个都写成 1，上限永远够不着。
  assert.match(view, /chrome\.storage\.sync\.get\(\{ siteAskCount: \{\} \}\)/);
  assert.doesNotMatch(view, /ctx\.settings\.siteAskCount\[[^\]]*\]\s*(\+\+|=[^=])/);
});

test('站点规则写在哪个键上只有 normalizeHost 说了算', () => {
  const rules = code('shared/site-rules.js');
  assert.match(rules, /async function writeUserRule\(hostname, state\)/);
  assert.match(rules, /const key = normalizeHost\(hostname\);/);

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
  // 管控容器里的译文（PDF、漫画）不在正文 DOM 里，谁漏算谁就会在同一页上把
  // 「还原」画成「翻译」。
  assert.match(page, /ctx\.hasManagedTranslations && ctx\.hasManagedTranslations\(\)/);
  assert.equal(
    (page.match(/ai-translator-inline-block/g) || []).length, 1,
    '判断「有没有译文」的那一句只该有一处'
  );

  for (const file of ['popup/popup.js', 'content/content-float-ball.js']) {
    assert.doesNotMatch(code(file), /ai-translator-inline-block/, `${file} 不该自己再判一遍`);
  }
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
