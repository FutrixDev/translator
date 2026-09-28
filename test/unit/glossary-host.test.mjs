// 术语表：SW 回给内容脚本的那一半（background/glossary-host.js）。
//
// 与 custom-rules-host 同一条约束：回哪个主机的词条，由发信那一帧的地址
// （sender.url）决定，消息里带来的主机一概不认 —— 否则任何一帧都能要到别的站点
// 的词条。主机按 SiteRules.normalizeHost 规范化（www. 与裸域是同一个站点）。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const listeners = { message: [] };
const stored = {
  'glossary:aaaa0001': { s: 'attention', t: '注意力', l: '*', u: 1 },
  'glossary:aaaa0002': { s: 'kernel', t: '核', h: 'a.test', l: '*', u: 2 },
  'glossary:aaaa0003': { s: 'token', t: '令牌', h: 'b.test', l: '*', u: 3 },
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
await import('../../shared/target-lang.js');
await import('../../shared/glossary.js');
const { handleMessage } = await import('../../background/glossary-host.js');

function ask(message, sender) {
  return new Promise((resolve) => {
    const keepOpen = listeners.message[0](message, sender, resolve);
    assert.equal(keepOpen, true, 'an async reply needs the channel kept open');
  });
}

test('glossary-host.js registers one message listener and the worker imports it', () => {
  assert.equal(listeners.message.length, 1);
  assert.equal(listeners.message[0], handleMessage);
  const worker = repoFile('background/background.js');
  assert.match(worker, /^import '\.\/glossary-host\.js';$/m);
  assert.doesNotMatch(worker, /case 'GLOSSARY_FOR_HOST'/);
});

test('GLOSSARY_FOR_HOST answers with global entries plus the sender host, www. folded', async () => {
  const reply = await ask({ type: 'GLOSSARY_FOR_HOST' }, { url: 'https://www.a.test/page' });
  assert.deepEqual(reply.entries.map((entry) => entry.id).sort(), ['aaaa0001', 'aaaa0002']);
  const sub = await ask({ type: 'GLOSSARY_FOR_HOST' }, { url: 'https://docs.a.test/' });
  assert.deepEqual(sub.entries.map((entry) => entry.id).sort(), ['aaaa0001', 'aaaa0002']);
});

test('a host carried in the message is ignored: only sender.url decides', async () => {
  const reply = await ask({ type: 'GLOSSARY_FOR_HOST', host: 'b.test' }, { url: 'https://a.test/page' });
  assert.ok(!reply.entries.some((entry) => entry.h === 'b.test'));
});

test('a sender without a usable url gets an error reply, logged once', async () => {
  const saved = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const reply = await ask({ type: 'GLOSSARY_FOR_HOST' }, {});
    assert.equal(typeof reply.error, 'string');
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /^GLOSSARY_FOR_HOST failed:/);
  } finally {
    console.error = saved;
  }
});

test('other messages are left alone: no reply, no open channel', () => {
  for (const message of [{ type: 'GLOSSARY_WRITE' }, { type: 'CUSTOM_RULES_FOR_HOST' }, {}, null]) {
    let replied = false;
    const result = listeners.message[0](message, { url: 'https://a.test/' }, () => { replied = true; });
    assert.equal(result, undefined, `${JSON.stringify(message)} must not keep the channel open`);
    assert.equal(replied, false);
  }
});
