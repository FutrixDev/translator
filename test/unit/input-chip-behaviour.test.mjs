// content/content-input-chip.js 在 Node 里对着一个假 DOM 跑：点下去之后那几道核对的
// **行为**（D-352、D-357）。
//
// test/unit/input-chip.test.mjs 守的是源码形状；e2e 走的是真浏览器。这里钉的是
// 浏览器里不好单独造出来的几条：
// - 身份核对（`pending !== request`）：译文在路上时按了 Esc，芯片收走了，但字没变、
//   焦点也没走 —— 只有身份核对拦得住这份没人要的译文。
// - 晚到的写入（writeback.landed）：点芯片、框被重新判定时先问一句，认出来就当
//   写成了，不再发请求。
// - 框离开了页面，芯片收起（D-361 M1）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { repoSource } from './helpers/sources.mjs';

const SOURCE = repoSource('content/content-input-chip.js');

// 「已写入」判定用的是写回模块自己那把尺子（sameText），这里直接借真的来，不另写一份。
const { sameText } = (() => {
  const window = { AI_TRANSLATOR_CONTENT: {} };
  new Function('window', 'document', repoSource('content/content-input-writeback.js'))(window, {});
  return window.AI_TRANSLATOR_CONTENT.inputWriteback;
})();

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.nodeType = 1;
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.isConnected = false;
    this.textContent = '';
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  remove() { this.isConnected = false; }
  closest() { return null; }
  getBoundingClientRect() { return { top: 0, bottom: 20, right: 200 }; }
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// 宏任务边界：芯片里那几个 await 都是 promise，排干它们要等一个 setImmediate。
const flush = () => new Promise((resolve) => setImmediate(resolve));

function load({ landed = () => false } = {}) {
  const listeners = {};
  const timers = [];
  const created = [];
  const document = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    createElement(tag) {
      const node = new FakeNode(tag.toUpperCase());
      created.push(node);
      return node;
    },
    body: { appendChild(node) { node.isConnected = true; } },
  };
  const window = {
    innerHeight: 800,
    innerWidth: 1200,
    addEventListener() {},
  };
  const requests = [];
  const writes = [];
  const ctx = {
    settings: {},
    t: (key) => key,
    languageName: () => 'English',
    normalizeTargetLang: (lang) => lang,
    isSameLanguage: (a, b) => a === b,
    builtinTranslator: {
      pageSourceLang: async () => 'en',
      detectStandaloneLang: async () => 'zh-CN',
    },
    requestTranslation(message) {
      const answer = deferred();
      requests.push({ message, answer });
      return answer.promise;
    },
    inputWriteback: {
      fieldText: (field) => field.value,
      hasFocus: () => true,
      landed,
      sameText,
      async write(field, translation) { writes.push(translation); field.value += `\n${translation}`; },
    },
  };
  window.AI_TRANSLATOR_CONTENT = ctx;
  const setTimeoutFake = (fn) => { timers.push(fn); return timers.length; };
  new Function('window', 'document', 'setTimeout', 'clearTimeout', SOURCE)(
    window, document, setTimeoutFake, () => {});
  ctx.setupInputTranslateChip();

  const fire = (type, event) => { for (const fn of listeners[type] || []) fn(event); };
  const field = new FakeNode('TEXTAREA');
  field.value = '你好世界';
  field.isConnected = true;
  const event = { composedPath: () => [field] };

  return {
    field,
    requests,
    writes,
    chip: () => created.find((node) => node.id === 'ai-translator-input-chip'),
    // 聚焦这个框，跑完 400ms 防抖那一轮判定。
    async focus() {
      fire('focusin', event);
      while (timers.length) timers.shift()();
      await flush();
    },
    press(key) { fire('keydown', { key }); },
    fire,
    clickChip(chip) { for (const fn of chip.listeners.click) fn(); },
  };
}

test('译文在路上时按了 Esc：字没变、焦点没走，这份译文照样不写', async () => {
  const harness = load();
  await harness.focus();
  const chip = harness.chip();
  assert.ok(chip && chip.isConnected, '芯片没出现，后面的核对无从谈起');

  harness.clickChip(chip);
  await flush();
  assert.equal(harness.requests.length, 1);
  assert.equal(chip.dataset.state, 'busy');

  harness.press('Escape');
  assert.equal(chip.isConnected, false, 'Esc 没把芯片收走');

  harness.requests[0].answer.resolve({ translation: 'Hello world' });
  await flush();
  await flush();
  assert.deepEqual(harness.writes, [], '芯片收走之后回来的译文还是被写进了框');
  assert.equal(harness.field.value, '你好世界');
});

test('上一次写入晚一拍落进来了：点芯片直接认成写成，不再发请求', async () => {
  let late = false;
  const harness = load({ landed: () => late });
  await harness.focus();
  const chip = harness.chip();
  assert.ok(chip && chip.isConnected);

  late = true;
  harness.clickChip(chip);
  await flush();
  assert.equal(harness.requests.length, 0, '字已经在框里了，又为它发了一次翻译请求');
  assert.deepEqual(harness.writes, []);
  assert.equal(chip.isConnected, false, '认成写成之后芯片没退场');

  // 记成写完了：同一段字再被判定，芯片也不再出来。
  late = false;
  await harness.focus();
  assert.equal(chip.isConnected, false, '写完的「原文 + 译文」又冒出了芯片');
});

test('框被重新判定时先问 landed：认出来就不挂芯片', async () => {
  const harness = load({ landed: () => true });
  await harness.focus();
  assert.equal(harness.chip(), undefined, '晚到的写入已经落进来了，芯片还是挂了出来');
  assert.equal(harness.requests.length, 0);
});

// 写完之后编辑器把空格换成了 &nbsp;、段落之间多了一个空行：还是那段「原文 + 译文」，
// 芯片不能因为逐字不等就又冒出来、再追加一遍（D-361 M2）。
test('写完之后编辑器改了空白：芯片不再冒出来', async () => {
  const harness = load();
  await harness.focus();
  harness.clickChip(harness.chip());
  await flush();
  harness.requests[0].answer.resolve({ translation: 'Hello world' });
  await flush();
  await flush();
  assert.deepEqual(harness.writes, ['Hello world']);

  harness.field.value = '你好世界\n\nHello\u00a0world';
  await harness.focus();
  assert.equal(harness.chip().isConnected, false, '编辑器只改了空白，芯片又冒了出来');
});

test('框离开了页面（React 换掉了整个输入框）：芯片收起，不跳去视口左上角', async () => {
  const harness = load();
  await harness.focus();
  const chip = harness.chip();
  assert.ok(chip && chip.isConnected);

  harness.field.isConnected = false;
  harness.fire('scroll', {});
  assert.equal(chip.isConnected, false, '框已经不在页面上了，芯片还挂着');
});
