// ctx.placeBeside（content/content-utils.js）：看原文卡、划词卡片、划词图标三个
// 浮层共用的唯一放置实现。纯算术，所以这里跑真代码，逐条对设计 §5 的规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'content/content-utils.js'), 'utf8');

function loadPlaceBeside() {
  const ctx = {};
  const target = { addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(SOURCE, {
    window: { AI_TRANSLATOR_CONTENT: ctx, ...target },
    document: { ...target, hidden: false, createElement: () => ({}) },
    navigator: {},
    console,
    Date,
    chrome: { runtime: { lastError: null, getManifest: () => ({ commands: {} }), sendMessage() {} } },
    setTimeout: () => 0,
    clearTimeout() {},
  }, { filename: 'content/content-utils.js' });
  return ctx.placeBeside;
}

const placeBeside = loadPlaceBeside();
const VIEWPORT = { width: 1000, height: 800 };
const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
const card = { width: 300, height: 200 };

test('below the anchor, 6px down, aligned to its start edge', () => {
  assert.deepEqual({ ...placeBeside(card, rect(100, 100, 500, 140), { viewport: VIEWPORT }) },
    { left: 100, top: 146, maxHeight: null });
});

test('above when below has no room', () => {
  const placed = placeBeside(card, rect(100, 600, 500, 640), { viewport: VIEWPORT });
  assert.equal(placed.top, 600 - 6 - 200);
  assert.equal(placed.maxHeight, null);
});

test('prefer above is honoured when it fits, and falls to below when it does not', () => {
  assert.equal(placeBeside(card, rect(100, 400, 500, 420), { viewport: VIEWPORT, prefer: 'above' }).top, 400 - 6 - 200);
  assert.equal(placeBeside(card, rect(100, 100, 500, 120), { viewport: VIEWPORT, prefer: 'above' }).top, 126);
});

test('neither side fits: the larger side, shrunk to its room, when that room reaches minHeight', () => {
  // 锚点占了视口中间一大块：上方 250-6-8=236，下方 800-8-(520+6)=266。
  const placed = placeBeside({ width: 300, height: 400 }, rect(100, 250, 500, 520), { viewport: VIEWPORT, minHeight: 160 });
  assert.equal(placed.maxHeight, 266);
  assert.equal(placed.top, 526);
});

test('neither side fits and neither reaches minHeight: against the fallback rect', () => {
  const tall = rect(100, 20, 500, 780);
  const line = rect(100, 300, 500, 320);
  const placed = placeBeside(card, tall, { viewport: VIEWPORT, minHeight: 160, fallback: line });
  assert.equal(placed.top, 326);
  assert.equal(placed.maxHeight, null);
  // 下方放不下时贴着 fallback 的上方。
  const low = placeBeside(card, tall, { viewport: VIEWPORT, fallback: rect(100, 700, 500, 720) });
  assert.equal(low.top, 700 - 6 - 200);
});

test('the fallback with no room either side takes the larger side and a maxHeight when minHeight is set', () => {
  const placed = placeBeside({ width: 300, height: 900 }, rect(0, 0, 1000, 800),
    { viewport: VIEWPORT, minHeight: 160, fallback: rect(0, 500, 1000, 520) });
  // 上方 500-6-8=486 > 下方 800-8-526=266。
  assert.equal(placed.maxHeight, 486);
  assert.equal(placed.top, 8);
});

test('top is clamped into the viewport margin', () => {
  const placed = placeBeside(card, rect(100, 20, 500, 780), { viewport: VIEWPORT });
  assert.ok(placed.top >= 8 && placed.top + 200 <= 792, JSON.stringify(placed));
});

test('horizontal: clamped so the right edge keeps its 8px margin', () => {
  assert.equal(placeBeside(card, rect(900, 100, 990, 140), { viewport: VIEWPORT }).left, 1000 - 8 - 300);
  assert.equal(placeBeside(card, rect(-50, 100, 20, 140), { viewport: VIEWPORT }).left, 8);
});

test('RTL aligns the card to the anchor\'s right edge', () => {
  assert.equal(placeBeside(card, rect(400, 100, 900, 140), { viewport: VIEWPORT, rtl: true }).left, 600);
});

test('x wins over the start edge, and is still clamped', () => {
  assert.equal(placeBeside(card, rect(100, 100, 500, 140), { viewport: VIEWPORT, x: 250 }).left, 250);
  assert.equal(placeBeside(card, rect(100, 100, 500, 140), { viewport: VIEWPORT, x: 900, rtl: true }).left, 692);
});

test('gap and margin are options', () => {
  const placed = placeBeside(card, rect(100, 100, 500, 140), { viewport: VIEWPORT, gap: 10, margin: 20 });
  assert.equal(placed.top, 150);
});
