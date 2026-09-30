// 失败标记的生命周期（P1-D D2 修复回合 1 的 A、E、I.2；content/page/failed-blocks.js）。
//
// 一个标记只对「放下它的那一刻」的这段内容、这门目标语言作数。页面删掉了标记、
// 原文换了（虚拟列表回收节点、SPA 重渲）、目标语言换了，条目就过期：isMarked 与
// retry 先核对，过期的收走、交回正常流程，绝不拿旧的 block.text 去请求。
//
// 这里装**真实的** failed-blocks.js 与 shared/block-identity.js（指纹同一个入口），
// DOM 换成最小替身：标记节点记下监听器、remove() 把 isConnected 置 false；
// placeFailureMarker 把标记「挂进文档」；runTranslationPass 是记账桩 —— 它没被调，
// 就是没有请求、也没有任何译文插进来。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { repoSource } from './helpers/sources.mjs';

await import('../../shared/block-identity.js');
const SOURCE = repoSource('content/page/failed-blocks.js');

function fakeMarker() {
  const listeners = {};
  return {
    className: '',
    tabIndex: -1,
    textContent: '',
    title: '',
    isConnected: false,
    setAttribute() {},
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    remove() {
      this.isConnected = false;
    },
    fire(type, init = {}) {
      listeners[type]({ preventDefault() {}, stopPropagation() {}, ...init });
    },
  };
}

function load() {
  const placed = [];
  const passes = [];
  let lang = 'zh-CN';
  const ctx = {
    t: (key) => key,
    readSourceText: (el) => el.text,
    currentTargetLang: () => lang,
    placeFailureMarker: (block, marker) => {
      marker.isConnected = true;
      placed.push(marker);
      return true;
    },
    queryAllDeep: () => placed.filter((marker) => marker.isConnected),
    runTranslationPass: (blocks, options) => {
      passes.push({ blocks, options });
      return Promise.resolve(null);
    },
  };
  globalThis.window = { AI_TRANSLATOR_CONTENT: ctx };
  globalThis.document = { createElement: () => fakeMarker() };
  new Function(SOURCE)();
  return { api: ctx.failedBlocks, placed, passes, setLang: (next) => { lang = next; } };
}

function paragraph(text) {
  const element = { text, isConnected: true, classList: { contains: () => false } };
  return { element, text };
}

test('a marker the page removed no longer counts, and clicking it sends nothing', async () => {
  const s = load();
  const block = paragraph('A paragraph that failed.');
  s.api.mark(block, 'apiErrorTimeout 30');
  assert.equal(s.api.isMarked(block.element), true);
  const [marker] = s.placed;
  assert.equal(marker.title, 'apiErrorTimeout 30');
  marker.remove();
  assert.equal(s.api.isMarked(block.element), false, 'a detached marker must not keep the block from the scheduler');
  marker.fire('click');
  await Promise.resolve();
  assert.equal(s.passes.length, 0);
});

test('the source changed under the marker: not marked any more, and a retry sends and inserts nothing', async () => {
  const s = load();
  const block = paragraph('The old tweet text.');
  s.api.mark(block, 'apiErrorUnavailable');
  const [marker] = s.placed;
  // 虚拟列表把这个节点回收去装下一条：节点还是那一个，文字换了。
  block.element.text = 'A different tweet in the same node.';
  marker.fire('click');
  await Promise.resolve();
  assert.equal(s.passes.length, 0, 'the old block.text must not be requested');
  assert.equal(marker.isConnected, false, 'the stale marker is taken back');
  assert.equal(s.api.isMarked(block.element), false);
});

test('the source changed and nothing clicked: isMarked answers false and takes the marker back', () => {
  const s = load();
  const block = paragraph('Before.');
  s.api.mark(block);
  const [marker] = s.placed;
  assert.equal(marker.title, 'translationFailed', 'no reason: the generic text');
  block.element.text = 'After.';
  assert.equal(s.api.isMarked(block.element), false);
  assert.equal(marker.isConnected, false);
});

test('the target language changed: the marker is stale and goes (E)', async () => {
  const s = load();
  const block = paragraph('Failed while translating into Chinese.');
  s.api.mark(block, 'apiErrorUnavailable');
  const [marker] = s.placed;
  s.setLang('ja');
  assert.equal(s.api.isMarked(block.element), false);
  assert.equal(marker.isConnected, false);

  // 点下去的那一刻才发现换了语言：同样收走、不送。
  const other = paragraph('Another one.');
  s.api.mark(other, 'apiErrorUnavailable');
  s.setLang('ko');
  s.placed[1].fire('keydown', { key: 'Enter' });
  await Promise.resolve();
  assert.equal(s.passes.length, 0);
});

test('clearWhere takes back only the markers whose source matches (the custom-rule sweep)', () => {
  const s = load();
  const kept = paragraph('Kept.');
  const ad = paragraph('An ad.');
  s.api.mark(kept);
  s.api.mark(ad);
  s.api.clearWhere((el) => el === ad.element);
  assert.equal(s.api.isMarked(ad.element), false);
  assert.equal(s.placed[1].isConnected, false);
  assert.equal(s.api.isMarked(kept.element), true);
  assert.equal(s.placed[0].isConnected, true);
});

test('a still-valid marker retries that one block, visibly; Enter and Space are the same as a click', async () => {
  for (const trigger of [(m) => m.fire('click'), (m) => m.fire('keydown', { key: 'Enter' }),
    (m) => m.fire('keydown', { key: ' ' })]) {
    const s = load();
    const block = paragraph('Still the same text.');
    s.api.mark(block, 'apiErrorUnavailable', { auto: true });
    const [marker] = s.placed;
    trigger(marker);
    await Promise.resolve();
    assert.equal(marker.isConnected, false, 'the marker makes way for the retry');
    assert.equal(s.passes.length, 1);
    assert.deepEqual(s.passes[0].blocks, [block]);
    assert.deepEqual(s.passes[0].options, { auto: true, markFailures: true });
  }
});
