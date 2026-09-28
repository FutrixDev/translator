// content/content-input-chip.js 在 Node 里对着一个假 DOM 跑：点下去之后那几道核对的
// **行为**（D-352、D-357）。
//
// test/unit/input-chip.test.mjs 守的是源码形状；e2e 走的是真浏览器。这里钉的是
// 浏览器里不好单独造出来的几条：
// - 身份核对（`pending !== request`）：译文在路上时按了 Esc，芯片收走了，但字没变、
//   焦点也没走 —— 只有身份核对拦得住这份没人要的译文。
// - 晚到的写入（writeback.landed）：点芯片、框被重新判定时先问一句，认出来就当
//   写成了，不再发请求。
// - 框离开了页面，芯片收起（D-361 M1）；登录名、密码、验证码、卡号框不挂芯片（M4）；
//   输入法组合期间与刚结束那一小段不判、不写（S4）。
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
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  remove() { this.isConnected = false; }
  closest() { return null; }
  getBoundingClientRect() { return { top: 0, bottom: 20, right: 200 }; }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// 宏任务边界：芯片里那几个 await 都是 promise，排干它们要等一个 setImmediate。
const flush = () => new Promise((resolve) => setImmediate(resolve));

function load({ landed = () => false, autocomplete = null } = {}) {
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
    // content-bootstrap.js 那一份的同形替身：passFatal 带着自己的文案，别的一律笼统一句。
    thrownTranslationMessage: (error) => (error && error.passFatal === true ? error.message : 'translationFailed'),
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
  if (autocomplete !== null) field.setAttribute('autocomplete', autocomplete);
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
    // 用户自己的手是 isTrusted: true；页面脚本的 .click() 是 false。
    clickChip(chip, { isTrusted = true } = {}) { for (const fn of chip.listeners.click) fn({ isTrusted }); },
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

test('页面脚本 .click() 芯片：不发翻译请求，不写回，芯片照旧可点', async () => {
  const harness = load();
  await harness.focus();
  const chip = harness.chip();
  assert.ok(chip && chip.isConnected, '芯片没出现，后面的核对无从谈起');

  harness.clickChip(chip, { isTrusted: false });
  await flush();
  await flush();
  assert.equal(harness.requests.length, 0, '合成的点击发出了翻译请求');
  assert.deepEqual(harness.writes, []);
  assert.equal(harness.field.value, '你好世界');
  assert.notEqual(chip.dataset.state, 'busy');

  // 同一颗芯片，用户自己点照常译。
  harness.clickChip(chip);
  await flush();
  assert.equal(harness.requests.length, 1);
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

test('登录名、密码、验证码、卡号框：不挂芯片', async () => {
  for (const autocomplete of [
    'username', 'current-password', 'new-password', 'one-time-code',
    'cc-number', 'cc-name', 'section-a shipping cc-csc', 'webauthn USERNAME',
  ]) {
    const harness = load({ autocomplete });
    await harness.focus();
    assert.equal(harness.chip(), undefined, `autocomplete="${autocomplete}" 的框挂出了芯片`);
  }
  for (const autocomplete of ['off', 'on', 'name', 'street-address', '']) {
    const harness = load({ autocomplete });
    await harness.focus();
    assert.ok(harness.chip()?.isConnected, `autocomplete="${autocomplete}" 的框不该被排除`);
  }
});

test('输入法组合开着：不判语言、不挂芯片；组合结束后照常', async () => {
  const harness = load();
  harness.fire('compositionstart', {});
  await harness.focus();
  assert.equal(harness.chip(), undefined, '拼音候选框还开着，芯片就挂出来了');

  harness.fire('compositionend', {});
  await new Promise((resolve) => setTimeout(resolve, 60));
  await harness.focus();
  assert.ok(harness.chip()?.isConnected, '组合结束之后芯片没醒过来');
});

test('组合刚结束那一小段里点芯片：不发请求、不写，芯片回到可点', async () => {
  const harness = load();
  await harness.focus();
  const chip = harness.chip();
  assert.ok(chip && chip.isConnected);

  harness.fire('compositionstart', {});
  harness.clickChip(chip);
  await flush();
  assert.equal(harness.requests.length, 0, '组合还开着就发了翻译请求');

  harness.fire('compositionend', {});
  harness.clickChip(chip);
  await flush();
  assert.equal(harness.requests.length, 0, '组合刚结束（编辑器还没把字读回模型）就发了翻译请求');
  assert.equal(chip.dataset.state, undefined, '芯片没回到可点');
  assert.equal(chip.isConnected, true);

  await new Promise((resolve) => setTimeout(resolve, 60));
  harness.clickChip(chip);
  await flush();
  assert.equal(harness.requests.length, 1, '组合结束一会儿之后，点芯片还是不译');
});

test('译文在路上时开始了输入法组合：译文回来不写，芯片回到可点', async () => {
  const harness = load();
  await harness.focus();
  const chip = harness.chip();
  harness.clickChip(chip);
  await flush();
  assert.equal(harness.requests.length, 1);

  harness.fire('compositionstart', {});
  harness.requests[0].answer.resolve({ translation: 'Hello world' });
  await flush();
  await flush();
  assert.deepEqual(harness.writes, [], '组合开着，译文照样写了进去');
  assert.equal(chip.dataset.state, undefined);
});

// D-384 F4：整轮致命的配置错（不认得的领域）带着自己的那一句；芯片和别的入口一样
// 显示它，而不是笼统的「翻译失败」。顶层直接抛出、子 frame 折成 {error, passFatal}
// 两条路都要到。
test('passFatal 的失败：芯片显示它自己的文案，两条路一样', async () => {
  const FATAL = 'promptDomainUnknown 的文案';
  for (const settle of [
    (answer) => answer.reject(Object.assign(new Error(FATAL), { passFatal: true })),
    (answer) => answer.resolve({ error: FATAL, passFatal: true }),
  ]) {
    const harness = load();
    await harness.focus();
    const chip = harness.chip();
    harness.clickChip(chip);
    await flush();
    settle(harness.requests[0].answer);
    await flush();
    await flush();
    assert.equal(chip.dataset.state, 'error');
    assert.equal(chip.textContent, FATAL, '芯片没显示 passFatal 的文案');
    assert.equal(chip.getAttribute('title'), FATAL, '长句被截断，title 里没有全文');
  }

  // 普通失败仍是笼统一句。
  const harness = load();
  await harness.focus();
  const chip = harness.chip();
  harness.clickChip(chip);
  await flush();
  harness.requests[0].answer.resolve({ error: 'HTTP 500 from the endpoint' });
  await flush();
  await flush();
  assert.equal(chip.textContent, 'translationFailed');
});
