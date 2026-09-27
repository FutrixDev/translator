// popup 刚打开的那一刻：按钮先活，页面慢了也不等它。
//
// R33 A1：内容脚本正忙时 AUTO_PAGE_STATE 能晚回好几秒，而监听器排在那一问的
// await 后面 —— 「翻译此页」画出来了，点下去却什么都不会发生。这里执行真的
// popup/popup.js：造一个最小的 document 和一个永远不答（或者由测试决定什么时候
// 答）的 chrome.tabs.sendMessage，看三件事：
//
//   1. DOMContentLoaded 一跑完，按钮就接上了 —— 一个微任务都不用等；
//   2. 页面状态过了上限就先按「不知道」画（那几行藏起来），迟到的答复补画；
//   3. 迟到的答复只在它还是最新一问时才画，不会盖掉之后那一问的快照。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { repoSource } from './helpers/sources.mjs';

const POPUP = repoSource('popup/popup.js');
const POPUP_HTML = repoSource('popup/popup.html');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// 按钮在 popup.html 里的起始模样（disabled、aria-pressed）。popup.js 看不见 HTML，
// 这里照 HTML 给假元素定初值，首帧问的就是真的那一份标记。
function markupOf(id) {
  const tag = POPUP_HTML.match(new RegExp(`<[a-z]+ id="${id}"[^>]*>`));
  if (!tag) return { disabled: false, hidden: false, attributes: {} };
  const pressed = tag[0].match(/aria-pressed="([^"]*)"/);
  return {
    disabled: /\sdisabled[\s>]/.test(tag[0]),
    hidden: /\shidden[\s>]/.test(tag[0]),
    attributes: pressed ? { 'aria-pressed': pressed[1] } : {},
  };
}

function fakeElement(id) {
  const listeners = {};
  const initial = markupOf(id);
  const attributes = { ...initial.attributes };
  let disabled = initial.disabled;
  // 每一次从灰变成能按，记下那一刻的 aria-pressed：能按的第一帧说的是什么。
  const enabledWith = [];
  return {
    id,
    hidden: initial.hidden,
    get disabled() { return disabled; },
    set disabled(value) {
      if (disabled && !value) enabledWith.push(attributes['aria-pressed']);
      disabled = value;
    },
    enabledWith,
    textContent: '',
    title: '',
    listeners,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return name in attributes ? attributes[name] : null; },
  };
}

/**
 * 装一个 popup。`reply(message)` 决定 chrome.tabs.sendMessage 对每一问答什么：
 * 返回一个 promise，测试可以攥着它的 resolve 决定什么时候答。
 */
function load({ reply, syncGet = async (defaults) => ({ ...defaults }) }) {
  const elements = new Map();
  const docListeners = {};
  const sent = [];
  const written = [];
  const storageListeners = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement(id));
      return elements.get(id);
    },
    querySelectorAll: () => [],
    documentElement: { setAttribute() {} },
    body: { classList: { toggle() {} } },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  };
  const chrome = {
    storage: {
      sync: {
        get: syncGet,
        set: async (patch) => { written.push(patch); },
      },
      onChanged: { addListener(fn) { storageListeners.push(fn); } },
    },
    tabs: {
      query: async () => [{ id: 7, url: 'https://example.test/' }],
      sendMessage: (tabId, message) => {
        sent.push(message);
        return reply(message);
      },
    },
    commands: { getAll: async () => [] },
    runtime: { openOptionsPage() {}, sendMessage: async () => ({ ok: true, data: [] }) },
  };
  const sandbox = {
    document,
    chrome,
    window: { close() {} },
    console,
    setTimeout,
    clearTimeout,
    getMessage: (key) => key,
    getUILanguage: () => 'en',
    setupDisplayRow() {},
    setupPdfSection() {},
    AccountGate: { applyAccountGate: async (settings) => settings },
    EngineStatus: {
      UNKNOWN_PROBE: { unknown: true },
      describeEngineStatus: () => ({ key: 'ready', detailKey: '', ok: true }),
      selectedEngine: () => 'builtin',
    },
    APICompat: { isApiKeyMissing: () => false },
    SiteRules: { siteLabel: (host) => host },
  };
  vm.createContext(sandbox);
  // 理由 → 人话那张表跑真的：popup 按页面回的枚举取话，表是共用的那一张。
  vm.runInContext(repoSource('shared/auto-reason-keys.js'), sandbox, { filename: 'shared/auto-reason-keys.js' });
  vm.runInContext(POPUP, sandbox, { filename: 'popup/popup.js' });
  return {
    element: (id) => document.getElementById(id),
    fire: () => docListeners.DOMContentLoaded.forEach((fn) => fn()),
    sent,
    written,
    storageChanged: (changes) => storageListeners.forEach((fn) => fn(changes, 'sync')),
    run: (code) => vm.runInContext(code, sandbox),
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE = {
  host: 'slow.test',
  ruleWritable: true,
  hasTranslations: false,
  translationsVisible: false,
  pickerAvailable: false,
  auto: { status: 'idle', siteAuto: true },
};

test('the DOMContentLoaded handler binds the buttons before its first await', () => {
  const start = POPUP.indexOf("document.addEventListener('DOMContentLoaded'");
  assert.ok(start >= 0, 'popup.js has no DOMContentLoaded handler');
  const body = POPUP.slice(start, POPUP.indexOf('\n});', start));
  const bind = body.indexOf('setupEventListeners()');
  assert.ok(bind >= 0, 'the handler no longer binds the listeners');
  const firstAwait = body.indexOf('await ');
  assert.ok(firstAwait === -1 || bind < firstAwait,
    'a listener bound after an await is a dead button for as long as that await takes');
});

test('the buttons work while the tab never answers', () => {
  const popup = load({ reply: () => new Promise(() => {}) });
  popup.fire();
  // 同步断言：一个微任务都没跑。
  const translate = popup.element('translatePage');
  assert.equal((translate.listeners.click || []).length, 1, 'translatePage has no click listener');
  for (const id of ['toggleGlobalAuto', 'toggleSiteAuto', 'stopSiteAuto', 'togglePagePause', 'pickSiteRegion', 'openSettings']) {
    assert.equal((popup.element(id).listeners.click || []).length, 1, `${id} has no click listener`);
  }
});

test('a slow page state draws as unknown, then repaints when it lands', async () => {
  const state = deferred();
  const popup = load({
    reply: (message) => (message.type === 'AUTO_PAGE_STATE' ? state.promise : new Promise(() => {})),
  });
  const site = popup.element('toggleSiteAuto');
  popup.fire();

  await wait(450);
  assert.equal(popup.run('pageState'), null, 'past the deadline the page is "unknown"');
  assert.equal(site.hidden, true, 'the site row is drawn from a snapshot nobody gave');

  state.resolve(PAGE);
  await wait(10);
  assert.equal(site.hidden, false, 'the late answer never repainted the rows');
  assert.equal(popup.run('pageState && pageState.host'), 'slow.test');
});

test('a late answer does not overwrite a newer snapshot', async () => {
  const first = deferred();
  const second = deferred();
  let asked = 0;
  const popup = load({
    reply: (message) => {
      if (message.type !== 'AUTO_PAGE_STATE') return new Promise(() => {});
      asked += 1;
      return asked === 1 ? first.promise : second.promise;
    },
  });
  popup.fire();
  await wait(450);

  // 他点了一下，popup 重新问了一次；新答复先到。
  const again = popup.run('refreshPageRows()');
  second.resolve({ ...PAGE, host: 'new.test' });
  await again;
  assert.equal(popup.run('pageState.host'), 'new.test');

  // 开 popup 时那一问这才回来 —— 它说的是过去的事。
  first.resolve({ ...PAGE, host: 'old.test' });
  await wait(10);
  assert.equal(popup.run('pageState.host'), 'new.test', 'a stale reply painted over the newer one');
});

test('both tab round-trips share one deadline helper', () => {
  const races = POPUP.match(/Promise\.race\(/g) || [];
  assert.equal(races.length, 1, 'a second hand-rolled race is a second timeout to drift');
  assert.match(POPUP, /raceReply\(sendToActiveTab\(\{ type: 'PROBE_ENGINE' \}\)/);
  assert.match(POPUP, /raceReply\(pending, TAB_REPLY_TIMEOUT_MS\)/);
});

test('the auto-translate master switch writes the options page key and follows storage', async () => {
  const popup = load({ reply: () => Promise.resolve(PAGE) });
  popup.fire();
  await wait(10);
  const status = popup.element('globalAutoStatus');
  assert.equal(status.textContent, 'on', 'autoTranslate defaults to on');

  // 点一下写的是设置页 #autoTranslate 那一个键，不是别的什么副本。
  await popup.element('toggleGlobalAuto').listeners.click[0]();
  // 沙箱里造的对象跨了 realm，按 JSON 比。
  assert.equal(JSON.stringify(popup.written), '[{"autoTranslate":false}]');
  // 写完问一次页面：调度层停下来以后的样子由页面答。
  assert.ok(popup.sent.filter((m) => m.type === 'AUTO_PAGE_STATE').length >= 2);

  // 画面只跟存储走：onChanged 到了才变。设置页那边打开，这里跟着亮。
  popup.storageChanged({ autoTranslate: { newValue: false } });
  assert.equal(status.textContent, 'off');
  await popup.element('toggleGlobalAuto').listeners.click[0]();
  assert.equal(JSON.stringify(popup.written[1]), '{"autoTranslate":true}');
  popup.storageChanged({ autoTranslate: { newValue: true } });
  assert.equal(status.textContent, 'on');
});

test('the master switch is not drawn from a guess: disabled until storage answers, then right on its first frame', async () => {
  // R33 N1：以前 popup.html 写死 aria-pressed="true"、状态格写死「On」，存储里是
  // 关着的人打开 popup 先看见「开」，那一瞬点下去写的是 !true。
  const stored = deferred();
  const popup = load({
    reply: () => Promise.resolve(PAGE),
    syncGet: async (defaults) => ({ ...defaults, ...(await stored.promise) }),
  });
  const master = popup.element('toggleGlobalAuto');
  const status = popup.element('globalAutoStatus');
  popup.fire();
  await wait(10);
  // 存储还没答：灰着，不说开也不说关。
  assert.equal(master.disabled, true, 'the switch can be pressed before anyone knows its state');
  assert.equal(master.getAttribute('aria-pressed'), null, 'the switch claims a state before storage answered');
  assert.equal(status.textContent, '');
  // 空的也不行：kbd 有底色和边框，空格子画出来是一颗空药丸（D-360 F9）。
  assert.equal(status.hidden, true, 'an empty status cell is drawn as an empty pill before storage answers');
  // 监听器照样同步接上了（A1 不动）。
  assert.equal((master.listeners.click || []).length, 1);

  stored.resolve({ autoTranslate: false });
  await wait(10);
  assert.equal(master.disabled, false);
  assert.deepEqual([...master.enabledWith], ['false'], 'the first pressable frame said something other than storage');
  assert.equal(status.textContent, 'off');
  assert.equal(status.hidden, false, 'the answered state was never shown');
});

test('the master switch stays disabled when storage cannot be read', async () => {
  const popup = load({ reply: () => Promise.resolve(PAGE), syncGet: async () => { throw new Error('storage gone'); } });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    popup.fire();
    await wait(10);
  } finally {
    console.error = original;
  }
  assert.equal(popup.element('toggleGlobalAuto').disabled, true);
  assert.equal(popup.element('globalAutoStatus').hidden, true, 'an unread state must not draw a pill');
  assert.ok(errors.some((args) => /Failed to check status/.test(String(args[0]))), 'the failure was not logged');
});

test('the site row says which refusal greys it out, as the page named it', async () => {
  // R33 D-360 F3：页面以前只回一个 blocked 布尔值，popup 在 title 上一律写「在黑
  // 名单里」—— x.com 的私信页、arxiv 的 /pdf/ 是内置 never，不是黑名单。现在页面
  // 回的是 SiteRules.blockReason() 的枚举，popup 只按它取话，不自己重判。
  const cases = [
    [{ ruleWritable: false, blockReason: 'BUILTIN_NEVER' }, 'autoReasonBuiltinNever'],
    [{ ruleWritable: false, blockReason: 'BLOCKLIST' }, 'autoReasonBlocklist'],
    [{ ruleWritable: true, blockReason: null }, 'slow.test'],
  ];
  for (const [extra, title] of cases) {
    const popup = load({ reply: () => Promise.resolve({ ...PAGE, ...extra }) });
    popup.fire();
    await wait(10);
    const site = popup.element('toggleSiteAuto');
    assert.equal(site.hidden, false, 'the site row was not drawn');
    assert.equal(site.title, title, `blockReason ${extra.blockReason}`);
    assert.equal(site.disabled, !extra.ruleWritable);
  }
});
