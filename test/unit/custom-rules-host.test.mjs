// 用户站点规则：SW 回给内容脚本的那一半（background/custom-rules-host.js）。
//
// 守的是一条浏览器里看不出来的约束：回哪个主机的规则，由发信那一帧的地址
// （sender.url）决定，消息里带来的主机一概不认。内容脚本自己的镜像按
// location.hostname 建，两边一致时 e2e 看不出差别；可一旦 SW 信了消息里的主机，
// 任何一帧都能要到别的站点的规则。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// 模块顶层注册监听——在 import 之前装好替身，把注册下来的监听器捉住，下面的
// 用例调的就是生产注册的那一个（写法同 page-coverage.test.mjs 开头）。
const listeners = { message: [] };
const stored = {
  'customRule:a': { v: 1, match: ['a.test'], exclude: ['.ad'], updatedAt: 1 },
  'customRule:b': { v: 1, match: ['b.test'], exclude: ['.promo'], updatedAt: 2 },
  unrelated: true,
};
globalThis.chrome = {
  runtime: { onMessage: { addListener: (fn) => listeners.message.push(fn) } },
  storage: { sync: { get: async () => JSON.parse(JSON.stringify(stored)) } },
};

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/custom-rules.js');
const { handleMessage } = await import('../../background/custom-rules-host.js');

function ask(message, sender) {
  return new Promise((resolve) => {
    const keepOpen = listeners.message[0](message, sender, resolve);
    assert.equal(keepOpen, true, 'an async reply needs the channel kept open');
  });
}

test('custom-rules-host.js registers one message listener and the worker imports it', () => {
  assert.equal(listeners.message.length, 1);
  assert.equal(listeners.message[0], handleMessage);
  // 入口真的 import 了它（不 import，上面那个监听在 SW 里根本不存在）。
  const worker = repoFile('background/background.js');
  assert.match(worker, /^import '\.\/custom-rules-host\.js';$/m);
  // 处理只留这一份：入口的 switch 里不再有这个 case。
  assert.doesNotMatch(worker, /case 'CUSTOM_RULES_FOR_HOST'/);
});

test('CUSTOM_RULES_FOR_HOST answers with the rules of the sender frame host', async () => {
  const reply = await ask({ type: 'CUSTOM_RULES_FOR_HOST' }, { url: 'https://a.test/page' });
  assert.deepEqual(reply.rules.map((rule) => rule.id), ['a']);
});

test('a host carried in the message is ignored: only sender.url decides', async () => {
  const reply = await ask(
    { type: 'CUSTOM_RULES_FOR_HOST', host: 'b.test' },
    { url: 'https://a.test/page' },
  );
  assert.deepEqual(reply.rules.map((rule) => rule.id), ['a']);
  assert.ok(!reply.rules.some((rule) => rule.match.includes('b.test')));
});

test('other messages are left alone: no reply, no open channel', () => {
  for (const message of [{ type: 'CUSTOM_RULES_WRITE' }, { type: 'GET_SHADOW_STYLES' }, {}, null]) {
    let replied = false;
    const result = listeners.message[0](message, { url: 'https://a.test/' }, () => { replied = true; });
    assert.equal(result, undefined, `${JSON.stringify(message)} must not keep the channel open`);
    assert.equal(replied, false);
  }
});
