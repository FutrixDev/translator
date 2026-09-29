// 本页的术语表镜像（content/content-glossary.js）的接线。
//
// 镜像本身（先取一次、之后按增量走、去抖）在 sync-collection.test.mjs 里测；这里测
// 这个文件自己的那一半：顶层帧 init 之后把镜像登记进 ctx.syncMirrors，于是 bootstrap
// 转来的 storage 增量真的到得了它（过 bootstrap 那一段原样的 routeSyncMirrors）；
// 子帧什么都不登记。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { routeSyncMirrorsOf } from './helpers/sources.mjs';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/target-lang.js');
// glossary.js 在加载时取走 TextMarkers（词条不许含占位符和标记，D-387）。
await import('../../shared/text-markers.js');
// glossary.js 在加载时取走 BATCH_DELIMITER（词条里不许有批量分隔符，P1-D）。
await import('../../shared/batch-delimiter.js');
await import('../../shared/glossary.js');
const { Glossary } = globalThis;

const SOURCE = readFileSync(fileURLToPath(new URL('../../content/content-glossary.js', import.meta.url)), 'utf8');

// 镜像的增量去抖是 150 ms（shared/sync-collection.js 的 DEBOUNCE_MS）。
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

/** 每次 new Function 求值一份新的闭包（CJS 缓存不认查询串）。 */
function load({ frameRole = 'top', entries = [] } = {}) {
  const ctx = { frameRole, syncMirrors: [] };
  const asked = [];
  globalThis.window = globalThis;
  globalThis.AI_TRANSLATOR_CONTENT = ctx;
  globalThis.location = { hostname: 'glossary.test' };
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        asked.push(message.type);
        return { entries };
      },
    },
  };
  new Function(SOURCE)();
  return { ctx, asked };
}

test('顶层帧 init 之后镜像登记进 ctx.syncMirrors，bootstrap 转来的增量到得了它', async () => {
  const { ctx, asked } = load();
  ctx.glossary.init();
  await ctx.glossary.whenReady();
  assert.deepEqual(asked, ['GLOSSARY_FOR_HOST']);
  assert.deepEqual(ctx.syncMirrors.map((mirror) => mirror.prefix), [Glossary.KEY_PREFIX]);

  let notified = 0;
  ctx.glossary.subscribe(() => {
    notified += 1;
  });
  const route = routeSyncMirrorsOf(ctx);
  const rest = route({
    'glossary:abc123': { newValue: { s: 'attention', t: '注意力', l: '*', u: 1 } },
    modelName: { newValue: 'gpt-4.1-mini' },
  });
  // 词条键被镜像收走，不落进设置；别的键照旧交回去。
  assert.deepEqual(Object.keys(rest), ['modelName']);
  await settle();
  assert.deepEqual(ctx.glossary.entries().map((entry) => [entry.id, entry.s, entry.t]),
    [['abc123', 'attention', '注意力']]);
  assert.equal(notified, 1);

  // init 两次不会登记第二份。
  ctx.glossary.init();
  assert.equal(ctx.syncMirrors.length, 1);
});

test('子帧不建镜像、不登记前缀，也不向 SW 要词条', async () => {
  const { ctx, asked } = load({ frameRole: 'child' });
  ctx.glossary.init();
  await ctx.glossary.whenReady();
  assert.deepEqual(ctx.syncMirrors, []);
  assert.deepEqual(asked, []);
  assert.deepEqual(ctx.glossary.entries(), []);
});
