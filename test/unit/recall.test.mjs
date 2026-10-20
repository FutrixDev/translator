// 装回（content/page/recall.js）：同样的文字换了新节点，把页内记忆里上次落笔的
// 译文放回去。记忆本身（shared/block-identity.js 的 remember / recall、LRU、清空）
// 在 block-identity.test.mjs；这里盯的是装回这一层：
//   1. 查记忆只是查 —— 扫到的命中不因为被扫到就挪到 LRU 的最新端，挪是落笔的事；
//   2. 查的是新块自己送出去的原文，并且守「跳过目标语言」那道检测；
//   3. 落笔只走批量那一条路（batch.js 的 landTranslation）。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// 装回在加载时只读 ctx；收集、落笔、语言戳在调用时读，下面按用例换成替身。
globalThis.window = { AI_TRANSLATOR_CONTENT: { settings: {} }, innerWidth: 1280, innerHeight: 800 };

await import('../../shared/block-identity.js');
await import('../../content/page/recall.js');

const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;
const { BlockIdentity } = globalThis;

const entry = (source, translation) => ({ source, translation, targetLangChecked: false });
const remembered = (source) => {
  const hit = BlockIdentity.recall('zh-CN', source);
  return hit === null ? null : hit.translation;
};

// 一次装回扫到的命中比装回预算多：视口外的只装前 16 块，剩下的留给发现层进带
// 时再问。装回自己查记忆时一条都不挪 —— 否则一片装不完的大菜单每重建一次，就把
// 别处真在用的译文挤出记忆。真装回去的那几块由落笔（插入端的 remember）挪到最新
// 端，那一步不在这一层：落笔替身只记下装了哪几块。
test('a recall that restores only part of its hits moves none of them in the LRU order by itself', () => {
  // 先记 20 条命中，再记 1980 条别的：命中是表里最旧的 20 条。
  const hits = Array.from({ length: 20 }, (_, i) => `drawer item ${i}`);
  for (const text of hits) BlockIdentity.remember('zh-CN', entry(text, `抽屉 ${text}`));
  for (let i = 0; i < 1980; i++) BlockIdentity.remember('zh-CN', entry(`filler ${i}`, `填充 ${i}`));
  assert.equal(BlockIdentity.memorySize(), 2000);

  // 20 块全在视口下方；收集端按顺序交出这 20 块。
  const below = { top: 5000, bottom: 5040, left: 0, right: 300, width: 300, height: 40 };
  const blocks = hits.map((text) => ({ text, element: { getBoundingClientRect: () => below } }));
  ctx.collectPageBlocks = (_root, { limit }) => blocks.slice(0, limit);
  ctx.passTarget = () => ({ stamp: 'zh-CN', request: 'zh-CN', generation: 0 });
  const landed = [];
  ctx.landTranslation = (block, translation) => landed.push([block.text, translation]);

  assert.equal(ctx.recallTranslations([{ isConnected: true }]), 16);
  assert.deepEqual(landed, hits.slice(0, 16).map((text) => [text, `抽屉 ${text}`]));
  // 再记 4 条新的：挤掉的是最旧的 4 条 —— 命中里最早记下的那 4 条，装回没挪过谁。
  for (let i = 0; i < 4; i++) BlockIdentity.remember('zh-CN', entry(`newcomer ${i}`, `新 ${i}`));
  for (const text of hits.slice(0, 4)) {
    assert.equal(remembered(text), null, `${text} was moved to the most recent end by the recall itself`);
  }
  for (const text of hits.slice(4)) assert.equal(remembered(text), `抽屉 ${text}`);
  for (let i = 0; i < 4; i++) assert.equal(remembered(`filler ${i}`), `填充 ${i}`);
});

test('recall looks up the new block\'s own source, honours the skip check and lands through the batch path', () => {
  const recall = repoFile('content/page/recall.js');
  assert.match(recall, /BlockIdentity\.recall\(target\.stamp, block\.text, usableNow\);/,
    'recall no longer looks up the new block\'s own source text');
  assert.match(recall, /function usableNow\(entry\) \{\s*\n\s*return ctx\.settings\.skipTargetLanguageText !== true \|\| entry\.targetLangChecked;/,
    'recall restores translations that never passed the skip-target-language check');
  assert.equal((recall.match(/ctx\.landTranslation\(block, entry\.translation, target\)/g) || []).length, 2,
    'recall lands through a second path instead of the one the batch uses');
});
