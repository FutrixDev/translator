// content/content-input-menu.js 在 Node 里对着一个小假 DOM 跑：锚上的忙（run /
// inflight / release）和菜单上的 data-busy（D-1043 M6）。
//
// 锚上同一时刻只做一件事，data-busy 只在 showBusy 一处写。这里钉复审的两条：
// - #1：菜单开着时开始翻译，关掉再打开，翻译回来 —— 菜单上的 data-busy 要摘掉，
//   不能挂在新打开的那一次上（旧写法只摘「发起时那一次打开」的）。
// - #6：一次语气被放掉（用户改了字），接着又开始一次翻译；语气晚回来，它的收尾
//   不能把翻译的忙摘掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { repoSource } from './helpers/sources.mjs';

await import('../../shared/tones.js');

const MENU_SOURCE = repoSource('content/content-input-menu.js');

class FakeEl {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.textContent = '';
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.hidden = false;
    this.id = '';
  }

  get isConnected() {
    let node = this;
    while (node.parent) node = node.parent;
    return node.isBody === true;
  }

  addEventListener() {}
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  contains(node) {
    for (let at = node; at; at = at.parent) if (at === this) return true;
    return false;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  matches(selector) {
    const cls = selector.match(/^\.([\w-]+)$/);
    if (cls) return this.className.split(/\s+/).includes(cls[1]);
    const attr = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const value = attr[1].startsWith('data-')
        ? this.dataset[attr[1].slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())]
        : this.getAttribute(attr[1]);
      return attr[2] === undefined ? value != null : value === attr[2];
    }
    throw new Error(`fake DOM: unsupported selector ${selector}`);
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  closest(selector) {
    for (let at = this; at; at = at.parent) if (!at.isBody && at.matches(selector)) return at;
    return null;
  }
  getBoundingClientRect() { return { top: 0, bottom: 20, left: 0, right: 200 }; }
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function load() {
  const body = new FakeEl('body');
  body.isBody = true;
  const document = {
    body,
    createElement: (tag) => new FakeEl(tag),
    addEventListener() {},
  };
  const window = { innerWidth: 1200, innerHeight: 800, addEventListener() {} };
  const ctx = {
    t: (key) => key,
    localPref: () => ({ get: () => '', set() {} }),
    normalizeTargetLang: (lang) => lang,
    recentTargetLangs: () => [],
    uiLanguage: () => 'en',
    languageName: (lang) => lang,
    placeBeside: () => ({ left: 0, top: 0, maxHeight: null }),
    accountActionButton: () => null,
    comic: { sendMessage: async () => ({ ok: true, data: { signedIn: true } }) },
  };
  window.AI_TRANSLATOR_CONTENT = ctx;
  const chrome = { storage: { onChanged: { addListener() {} } } };
  new Function('window', 'document', 'chrome', 'TargetLang', 'requestAnimationFrame', MENU_SOURCE)(
    window, document, chrome, { options: () => [] }, () => 0);
  const anchor = new FakeEl('div');
  body.appendChild(anchor);
  const menu = () => body.children.find((node) => node.id === 'ai-translator-input-menu');
  const open = () => ctx.inputMenu.open({
    anchor,
    targetLang: 'en',
    tones: null,
    toneBlocked: false,
    onTranslate() {},
    onTone: async () => {},
  });
  return { api: ctx.inputMenu, anchor, menu, open };
}

test('#1：翻译时关掉菜单再打开，翻译回来，菜单上的忙摘掉', async () => {
  const { api, anchor, menu, open } = load();
  open();
  const answer = deferred();
  const running = api.run(anchor, 'translate', () => answer.promise);
  assert.equal(menu().dataset.busy, 'translate');
  assert.equal(anchor.dataset.busy, 'translate');

  api.close();
  assert.equal(api.isOpen(anchor), false);
  open();
  assert.equal(menu().dataset.busy, 'translate', '重新打开的菜单没认出锚上还在翻译');

  answer.resolve();
  await running;
  assert.equal(menu().dataset.busy, undefined, '翻译回来了，重新打开的菜单还挂着忙');
  assert.equal(anchor.dataset.busy, undefined);
  assert.equal(api.inflight(anchor), '');
});

test('关着的菜单不带上一次的忙', async () => {
  const { api, anchor, menu, open } = load();
  open();
  const answer = deferred();
  const running = api.run(anchor, 'tone', () => answer.promise);
  assert.equal(menu().dataset.busy, 'tone');
  api.close();
  assert.equal(menu(), undefined);
  answer.resolve();
  await running;
  open();
  assert.equal(menu().dataset.busy, undefined);
});

test('#6：被放掉的语气晚回来，不摘掉后来那次翻译的忙', async () => {
  const { api, anchor } = load();
  const tone = deferred();
  let toneStill;
  const toneRun = api.run(anchor, 'tone', (still) => { toneStill = still; return tone.promise; });
  assert.equal(anchor.dataset.busy, 'tone');

  api.release(anchor);
  assert.equal(anchor.dataset.busy, undefined);
  assert.equal(toneStill(), false, '放掉之后 still() 还答 true');

  const translate = deferred();
  const translateRun = api.run(anchor, 'translate', () => translate.promise);
  assert.equal(anchor.dataset.busy, 'translate');

  tone.resolve();
  await toneRun;
  await flush();
  assert.equal(api.inflight(anchor), 'translate', '语气的收尾把翻译从锚上摘掉了');
  assert.equal(anchor.dataset.busy, 'translate');

  translate.resolve();
  await translateRun;
  assert.equal(anchor.dataset.busy, undefined);
});

test('一个锚一次只做一件事：还在跑时再 run 是调用方的错，直接抛', async () => {
  const { api, anchor } = load();
  const answer = deferred();
  const running = api.run(anchor, 'translate', () => answer.promise);
  await assert.rejects(api.run(anchor, 'tone', async () => {}), /translate is still running/);
  assert.equal(api.inflight(anchor), 'translate');
  answer.resolve();
  await running;
});

test('锚上的忙变了就请锚的主人重画', async () => {
  const { api, anchor } = load();
  const seen = [];
  api.onBusyChange(anchor, () => seen.push(api.inflight(anchor)));
  await api.run(anchor, 'tone', async () => {});
  assert.deepEqual(seen, ['tone', '']);
});
