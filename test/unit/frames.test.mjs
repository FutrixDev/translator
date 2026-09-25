// 整页翻译进 iframe（manifest 的 all_frames）的三道闸：
//
//   1. 进门资格（shared/frame-eligibility.js）：广告 / 验证码 / 支付 / 登录 / 播放器
//      的 frame 连 ctx 都不建 —— 而且「不建」要真的是一个监听都没挂（dormant）。
//   2. 子 frame 的自动翻译判定（content/frames/shelf.js 的 decideForFrame）：自己
//      站点的拒绝永远作数，没被拒的才跟着顶层。
//   3. 发给标签页的消息钉 frame：内容脚本进了每个 frame，不带 frameId 的
//      tabs.sendMessage 会发给所有 frame，第一个回话的赢 —— popup 就可能画出
//      iframe 的主机名。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentBundle, workerSource, framesSource, optionsSource } from './helpers/sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/site-rules.js');
await import('../../shared/frame-eligibility.js');
const { FrameEligibility, SiteRules } = globalThis;

// ------------------------------------------------------------ 1. 进门资格

const child = (href, over = {}) => FrameEligibility.evaluate({
  isTop: false,
  designMode: 'off',
  href,
  origin: (() => { try { return new URL(href).origin; } catch (_) { return 'null'; } })(),
  ancestorOrigins: ['https://news.example.com'],
  windowName: '',
  frameElementId: null,
  frameElementName: null,
  ...over,
});

test('the top document always activates, whatever it is', () => {
  // 顶层的去留由 manifest 的 matches 与站点规则管，不归这张表。
  assert.deepEqual(FrameEligibility.evaluate({ isTop: true, href: 'https://ad.doubleclick.net/x' }),
    { activate: true, reason: 'top' });
});

const DENIED = [
  ['ads', 'https://googleads.g.doubleclick.net/pagead/ads?client=x'],
  ['ads', 'https://tpc.googlesyndication.com/sodar/sodar2/225/runner.html'],
  ['ads', 'https://abc123.safeframe.googlesyndication.com/safeframe/1-0-40/html/container.html'],
  ['ads', 'https://widgets.outbrain.com/hub/index.html'],
  ['ads', 'https://ib.adnxs.com/tt?id=1'],
  ['captcha', 'https://www.google.com/recaptcha/api2/anchor?k=x'],
  ['captcha', 'https://www.recaptcha.net/recaptcha/api2/bframe'],
  ['captcha', 'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html'],
  ['captcha', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2'],
  ['payment', 'https://js.stripe.com/v3/elements-inner-card-abc.html'],
  ['payment', 'https://www.paypal.com/smart/buttons?token=x'],
  ['payment', 'https://assets.braintreegateway.com/web/3.97.0/html/hosted-fields-frame.min.html'],
  ['payment', 'https://pay.google.com/gp/p/ui/payframe'],
  ['login', 'https://accounts.google.com/gsi/iframe/select'],
  ['login', 'https://appleid.apple.com/auth/authorize'],
  ['login', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'],
  ['player', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
  ['player', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
  ['player', 'https://player.vimeo.com/video/76979871'],
  ['player', 'https://open.spotify.com/embed/track/abc'],
];

for (const [category, href] of DENIED) {
  test(`a ${category} frame stays out: ${new URL(href).hostname}`, () => {
    assert.deepEqual(child(href), { activate: false, reason: category });
  });
}

const ALLOWED = [
  // 同名不同主：后缀匹配按点切，不按字符串。
  'https://doubleclick.net.example.com/article',
  'https://notdoubleclick.net/article',
  // 同一主机的别的路径：只有 /recaptcha、/embed 这些前缀是拒绝表里的。
  'https://www.google.com/maps/embed?pb=x',
  'https://www.youtube.com/watch?v=x',
  // 路径按段匹配：/embedded 不是 /embed。
  'https://www.youtube.com/embedded',
  // stripe.com 的文档不是 js.stripe.com 的卡号框。
  'https://stripe.com/docs/payments',
  // docs.google.com 不是 accounts.google.com（它在站点黑名单里，那是另一道闸）。
  'https://docs.google.com/document/d/abc/preview',
  // 正经的内容 frame。
  'https://codepen.io/team/codepen/embed/preview/PNaGbb',
  'https://en.wikipedia.org/wiki/Iframe',
];

for (const href of ALLOWED) {
  test(`a content frame gets in: ${href}`, () => {
    assert.deepEqual(child(href), { activate: true, reason: 'eligible' });
  });
}

test('about:blank and about:srcdoc are judged by the origin they inherit', () => {
  // 广告位最常见的写法：doubleclick 的 frame 里再开一个 about:blank。
  assert.deepEqual(child('about:blank', { origin: 'https://ad.doubleclick.net' }),
    { activate: false, reason: 'ads' });
  assert.deepEqual(child('about:srcdoc', { origin: 'https://js.stripe.com' }),
    { activate: false, reason: 'payment' });
  // 页面自己写出来的 about:blank（编辑器预览、评论框）照常进。
  assert.deepEqual(child('about:blank', { origin: 'https://news.example.com' }),
    { activate: true, reason: 'eligible' });
  // 没有 origin（沙箱 frame 的 'null'）不是拒绝的理由。
  assert.deepEqual(child('about:blank', { origin: 'null' }), { activate: true, reason: 'eligible' });
});

test('a frame nested inside a denied frame is part of that flow and stays out', () => {
  assert.deepEqual(
    child('https://cdn.example.net/card-field.html', { ancestorOrigins: ['https://checkout.paypal.com', 'https://shop.example.com'] }),
    { activate: false, reason: 'payment' },
  );
  // 只有路径的条目（google.com/recaptcha）不按祖先认：祖先只有 origin，没有路径，
  // 拿它去认会把所有嵌在 google.com 里的 frame 一并挡掉。
  assert.deepEqual(
    child('https://sites.example.com/page', { ancestorOrigins: ['https://www.google.com'] }),
    { activate: true, reason: 'eligible' },
  );
});

test('a rich-text editor frame (designMode on) stays out', () => {
  assert.deepEqual(child('about:blank', { designMode: 'on', origin: 'https://cms.example.com' }),
    { activate: false, reason: 'designMode' });
});

test('ad slots are recognised by their frame name as a word, not as a substring', () => {
  for (const name of ['google_ads_iframe_/1234/news/top_0', 'aswift_2', 'ad-slot', 'top_ads', 'sponsor', 'banner-1']) {
    assert.deepEqual(child('about:blank', { origin: 'https://news.example.com', windowName: name }),
      { activate: false, reason: 'frameName' }, name);
  }
  assert.deepEqual(child('about:blank', { origin: 'https://news.example.com', frameElementId: 'ad' }),
    { activate: false, reason: 'frameName' });
  for (const name of ['header', 'loading', 'adsorption', 'comments', 'readme', 'thread-ad3']) {
    assert.deepEqual(child('about:blank', { origin: 'https://news.example.com', windowName: name }),
      { activate: true, reason: 'eligible' }, name);
  }
});

// ------------------------------------------------------------ 1b. dormant 就是 dormant

/**
 * 在 vm 沙箱里按 manifest 顺序跑 content_scripts[1] 的每一个文件，记下所有监听的
 * 注册。dormant 的定义就是这里的零。
 *
 * 计时器全是空操作：顶层那一趟会真的跑 ctx.init，定时器一挂，进程就不退了。
 */
function loadContentScripts({ isTop, href }) {
  const registrations = [];
  const record = (what) => (type) => { registrations.push(typeof type === 'string' ? `${what}(${type})` : what); };
  const eventTarget = (what) => ({ addEventListener: record(what), removeEventListener() {} });
  const url = new URL(href);
  const noTimer = () => 0;
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    // URL 不是 V8 的内建，是 Node 挂的全局：新开的 vm 上下文里没有它。不给的话
    // frame-eligibility 解析不了地址，每个 frame 都会被当成「不认识的主机」放进来。
    URL,
    queueMicrotask,
    setTimeout: noTimer, clearTimeout() {}, setInterval: noTimer, clearInterval() {},
    requestAnimationFrame: noTimer, requestIdleCallback: noTimer,
    location: { href, origin: url.origin, hostname: url.hostname, pathname: url.pathname, ancestorOrigins: [] },
    name: '',
    document: {
      ...eventTarget('document.addEventListener'),
      designMode: 'off',
      readyState: 'complete',
      documentElement: eventTarget('documentElement.addEventListener'),
      body: eventTarget('body.addEventListener'),
    },
    navigator: { language: 'en-US', languages: ['en-US'], userAgent: 'node' },
    MutationObserver: class { constructor() { registrations.push('new MutationObserver'); } observe() {} disconnect() {} },
    chrome: {
      runtime: {
        id: 'test',
        onMessage: { addListener: record('chrome.runtime.onMessage') },
        sendMessage: async () => null,
        getURL: (p) => p,
      },
      storage: {
        onChanged: { addListener: record('chrome.storage.onChanged') },
        sync: { get: async (defaults) => defaults, set: async () => {} },
        local: { get: async (defaults) => defaults, set: async () => {} },
      },
      i18n: { getUILanguage: () => 'en', detectLanguage: async () => ({ languages: [] }) },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = record('window.addEventListener');
  sandbox.removeEventListener = () => {};
  sandbox.top = isTop ? sandbox : {};
  vm.createContext(sandbox);

  const thrown = [];
  for (const rel of contentBundle()) {
    try {
      vm.runInContext(read(rel), sandbox, { filename: rel });
    } catch (error) {
      thrown.push(`${rel}: ${error.message}`);
    }
  }
  return { registrations, thrown, sandbox };
}

test('a dormant frame runs every content script and registers nothing', () => {
  const { registrations, thrown, sandbox } = loadContentScripts({ isTop: false, href: 'https://ad.doubleclick.net/ddm/adi/x' });
  // 抛了错的文件会让后面的注册「看起来」没有 —— 所以先要求一个都没抛。
  assert.deepEqual(thrown, [], 'a content script threw while loading in a dormant frame');
  assert.equal(sandbox.AI_TRANSLATOR_CONTENT, undefined, 'a dormant frame built a ctx');
  assert.deepEqual(registrations, [], 'a dormant frame registered listeners');
});

test('the same harness does see registrations when the frame is not dormant', () => {
  // 反面对照：证明上一条的「零」是 dormant 的零，不是记录器没接上。
  const { registrations, sandbox } = loadContentScripts({ isTop: true, href: 'https://news.example.com/' });
  assert.ok(sandbox.AI_TRANSLATOR_CONTENT, 'the top frame did not build a ctx');
  assert.ok(registrations.includes('chrome.runtime.onMessage'), `no message listener in an active frame: ${registrations}`);
  assert.ok(registrations.includes('chrome.storage.onChanged'), `no storage listener in an active frame: ${registrations}`);
});

test('frame-eligibility loads right before content-bootstrap, and the frames family before messaging', () => {
  const js = contentBundle();
  const at = (rel) => js.indexOf(rel);
  assert.equal(at('shared/frame-eligibility.js') + 1, at('content/content-bootstrap.js'));
  for (const rel of ['content/frames/shelf.js', 'content/frames/top.js', 'content/frames/child.js']) {
    assert.ok(at(rel) !== -1 && at(rel) < at('content/content-messaging.js'), `${rel} must load before content-messaging.js`);
  }
  assert.ok(at('content/frames/shelf.js') < at('content/frames/top.js'));
  assert.ok(at('content/frames/shelf.js') < at('content/frames/child.js'));
});

test('the page bundle goes into every frame, including about:blank ones', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const bundle = manifest.content_scripts.find((cs) => cs.js.includes('content/content-bootstrap.js'));
  assert.equal(bundle.all_frames, true);
  assert.equal(bundle.match_about_blank, true);
  assert.equal(bundle.match_origin_as_fallback, true);
  // YouTube 的 MAIN world 拦截器不跟：它只该在 youtube.com 的顶层打补丁。
  const interceptor = manifest.content_scripts.find((cs) => cs.world === 'MAIN');
  assert.ok(interceptor && !interceptor.all_frames, 'the MAIN-world interceptor must stay top-frame only');
});

// ------------------------------------------------------------ 2. 子 frame 的判定

function loadShelf() {
  const sandbox = { window: { AI_TRANSLATOR_CONTENT: { frameRole: 'child' } }, globalThis: { SiteRules } };
  vm.createContext(sandbox);
  vm.runInContext(read('content/frames/shelf.js'), sandbox, { filename: 'content/frames/shelf.js' });
  return sandbox.window.AI_TRANSLATOR_CONTENT.frames;
}

const frames = loadShelf();
const SETTINGS = { autoTranslate: true, autoTranslateLangs: [] };
// 结果对象造在 vm 上下文里，原型不是本进程的 Object.prototype —— 摊开一次再比。
const decideAs = (over) => ({ ...frames.decideForFrame({
  host: 'embed.example.com', path: '/widget', userRules: {}, settings: SETTINGS, follow: true, ...over,
}) });

test('decideForFrame has exactly the shape of SiteRules.decide', () => {
  const own = SiteRules.decide({ host: 'embed.example.com', path: '/widget', userRules: {}, settings: SETTINGS });
  assert.deepEqual(Object.keys(decideAs({})).sort(), Object.keys(own).sort());
});

test('a frame follows the top when told to, and sits still otherwise', () => {
  assert.deepEqual(decideAs({ follow: true }), { verdict: 'auto', reason: 'FRAME_FOLLOW', rule: null, refused: false });
  assert.deepEqual(decideAs({ follow: false }), { verdict: 'off', reason: 'FRAME_IDLE', rule: null, refused: false });
});

test('the frame own site refusals win over the top page, every one of them', () => {
  // 黑名单：邮箱被嵌在别人的页面里也还是邮箱。
  const blocked = decideAs({ host: 'mail.google.com', path: '/mail/u/0' });
  assert.equal(blocked.refused, true);
  assert.equal(blocked.verdict, 'off');
  assert.equal(blocked.reason, SiteRules.REASONS.BLOCKLIST);
  // 用户自己的 never。
  const never = decideAs({ userRules: { 'embed.example.com': 'never' } });
  assert.equal(never.refused, true);
  assert.equal(never.reason, SiteRules.REASONS.USER_NEVER);
  // 内置 never（arxiv 的 PDF）。
  const builtinNever = decideAs({ host: 'arxiv.org', path: '/pdf/2401.00001' });
  assert.equal(builtinNever.refused, true);
});

test('the global switch does not stop a frame from following a page the user translated by hand', () => {
  // 顶层手动翻了（总开关关着也能手动翻），子 frame 跟着 —— 那是用户的一次点击，
  // 不是我们自己开始翻。顶层没在翻时，translate 为假，follow 就是假。
  const followed = decideAs({ settings: { autoTranslate: false }, follow: true });
  assert.equal(followed.verdict, 'auto');
  assert.equal(followed.refused, false);
});

test('FRAME_FOLLOW and FRAME_IDLE never reach a surface that turns reasons into text', () => {
  // 子 frame 没有状态条和 popup；这两个理由进了 REASONS 就得有文案。
  assert.equal(Object.values(SiteRules.REASONS).includes('FRAME_FOLLOW'), false);
  assert.equal(Object.values(SiteRules.REASONS).includes('FRAME_IDLE'), false);
});

test('a child frame ignores the messages only the top frame answers', () => {
  for (const type of ['TRANSLATE_PAGE', 'TOGGLE_PAGE_TRANSLATION', 'SET_AUTO_PAUSED', 'AUTO_PAGE_STATE', 'PROBE_ENGINE', 'COMIC_TRANSLATE_PAGE']) {
    assert.equal(frames.ignores(type), true, type);
  }
  // 作用于 frame 自身的照常答：划选、OCR、清掉行内译文、设置变更。
  for (const type of ['TRANSLATE_SELECTION_TEXT', 'OCR_TRANSLATE_IMAGE', 'CLEAR_INLINE_TRANSLATION_CONTEXT', 'SETTINGS_UPDATED']) {
    assert.equal(frames.ignores(type), false, type);
  }
});

// ------------------------------------------------------------ 3. 消息钉 frame

/**
 * 生产代码里每一处 tabs.sendMessage 要么带第三个参数（frameId），要么就是有意
 * 发给所有 frame 的那几条。新增一处不带 frameId 的，这里红。
 */
const BROADCASTS = [
  // 设置页：设置变了、语言包好了 —— 每个 frame 都该知道。
  { surface: 'options', message: 'SETTINGS_UPDATED' },
  { surface: 'options', message: 'LANGUAGE_PACK_READY' },
  // 中继：顶层的指令本来就是发给所有子 frame 的。
  { surface: 'worker', message: 'FRAME_DIRECTIVE' },
];

/** 从 `tabs.sendMessage(` 起，数括号找到调用的结尾，返回顶层逗号分出的参数个数与原文。 */
function sendMessageCalls(source) {
  const calls = [];
  const code = source.replace(/\/\/[^\n]*/g, '');
  for (const m of code.matchAll(/tabs\.sendMessage\(/g)) {
    let depth = 1;
    let commas = 0;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) {
      const ch = code[i];
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 1) commas++;
    }
    const text = code.slice(m.index, i);
    // 末尾逗号不算参数。
    const args = commas + 1 - (/,\s*\)$/.test(text) ? 1 : 0);
    calls.push({ args, text });
  }
  return calls;
}

const SURFACES = {
  worker: workerSource(),
  popup: read('popup/popup.js'),
  options: optionsSource(),
  content: framesSource(),
};

test('every tabs.sendMessage names its frame, or is a declared broadcast', () => {
  const offenders = [];
  let seen = 0;
  for (const [surface, source] of Object.entries(SURFACES)) {
    for (const call of sendMessageCalls(source)) {
      seen++;
      if (call.args >= 3) continue;
      const declared = BROADCASTS.some((b) => b.surface === surface && call.text.includes(b.message));
      if (!declared) offenders.push(`${surface}: ${call.text.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  assert.ok(seen >= 10, `found only ${seen} tabs.sendMessage calls; the scanner is broken`);
  assert.deepEqual(offenders, [], 'a tab message with no frameId reaches every frame of the page');
});

test('the broadcast whitelist names calls that still exist', () => {
  // 白名单里的条目没了对应的调用，就是一条不再守着任何东西的豁免。
  for (const { surface, message } of BROADCASTS) {
    const hit = sendMessageCalls(SURFACES[surface]).some((call) => call.args < 3 && call.text.includes(message));
    assert.ok(hit, `${surface} no longer broadcasts ${message}; drop it from BROADCASTS`);
  }
});

test('the relay is loaded by the service worker', () => {
  assert.match(read('background/background.js'), /^import '\.\/frame-relay\.js';$/m);
});
