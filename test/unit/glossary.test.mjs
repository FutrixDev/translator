// 用户术语表（shared/glossary.js）。
//
// 读、写、缓存、增量由 SyncCollection 给出，那一份在 sync-collection.test.mjs 里测；
// 这一组测词条自己的语义：形状校验、哪两条算同一条、谁胜出、三种写入、额度，
// 以及错误一律是 i18n 键。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
await import('../../shared/glossary-csv.js');
const { Glossary } = globalThis;

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

function fakeSync(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const calls = { set: [], remove: [] };
  return {
    data,
    calls,
    chrome: {
      storage: {
        sync: {
          get: async () => JSON.parse(JSON.stringify(data)),
          set: async (items) => {
            calls.set.push(items);
            Object.assign(data, JSON.parse(JSON.stringify(items)));
          },
          remove: async (keys) => {
            calls.remove.push(keys);
            for (const key of keys) delete data[key];
          },
        },
      },
    },
  };
}

function withChrome(chrome, run) {
  const saved = globalThis.chrome;
  globalThis.chrome = chrome;
  return Promise.resolve().then(run).finally(() => {
    globalThis.chrome = saved;
  });
}

function captureConsole(method) {
  const calls = [];
  const saved = console[method];
  console[method] = (...args) => calls.push(args);
  return { calls, restore: () => { console[method] = saved; } };
}

const write = (kind, payload, sender) =>
  Glossary.applyWrite(Object.assign({ type: 'GLOSSARY_WRITE', kind }, payload), sender);
const rejectsWith = (promise, key) => assert.rejects(promise, { message: key });

// ------------------------------------------------------------ 形状

test('glossary: normalizeSource is NFC, trimmed, with inner whitespace collapsed', () => {
  assert.equal(Glossary.normalizeSource('  large\t\n language   model '), 'large language model');
  // e + 组合重音 -> 预组合的 é
  assert.equal(Glossary.normalizeSource('cafe' + String.fromCharCode(0x301)), 'caf' + String.fromCharCode(0xe9));
});

test('glossary: validateEntry normalizes and fills l, drops empty t, stores c as 1', () => {
  assert.deepEqual(Glossary.validateEntry({ s: '  attention ', t: ' 注意力 ' }), { s: 'attention', t: '注意力', l: '*' });
  assert.deepEqual(Glossary.validateEntry({ s: 'Transformer', t: '', c: true, h: 'WWW.Arxiv.org.', l: 'zh-CN', u: 7 }),
    { s: 'Transformer', c: 1, h: 'arxiv.org', l: 'zh-CN', u: 7 });
  assert.deepEqual(Glossary.validateEntry({ v: 1, s: 'x', c: 0, h: '', l: '*', id: 'abc' }), { s: 'x', l: '*' });
  // 上限恰好合法
  assert.doesNotThrow(() => Glossary.validateEntry({ s: 'x'.repeat(80), t: 'y'.repeat(160) }));
});

test('glossary: validateEntry rejects every bad shape with glossaryEntryInvalid', () => {
  const cases = [
    null, [], 'attention',
    {},
    { s: '' }, { s: '   ' }, { s: 1 },
    { s: 'x'.repeat(81) },
    { s: 'x', t: 'y'.repeat(161) }, { s: 'x', t: 3 },
    { s: 'x', c: 'yes' }, { s: 'x', c: 2 },
    { s: 'x', h: 'a b.test' }, { s: 'x', h: 'a.test/path' }, { s: 'x', h: 'a.test:8080' }, { s: 'x', h: 5 },
    // 写了站点、规范化后是空串：拒收，不当成「所有网站」
    { s: 'x', h: '...' }, { s: 'x', h: '.' }, { s: 'x', h: ' . ' },
    { s: 'x', l: 'klingon' }, { s: 'x', l: 7 },
    { s: 'x', v: 2 },
    { s: 'x', colour: 'red' },
    { s: 'x', u: Number.NaN }, { s: 'x', u: Infinity }, { s: 'x', u: '7' }, { s: 'x', u: null },
  ];
  for (const entry of cases) {
    assert.throws(() => Glossary.validateEntry(entry), { message: 'glossaryEntryInvalid' }, JSON.stringify(entry));
  }
});

// D-387：词条原文或译文里含占位符 {{n}} 或内联标记 <a1>/</a1>，拒收，不转义 ——
// 还原进译文后会被插入路径当成公式或页面元素。普通的花括号、尖括号照收。
test('glossary: validateEntry rejects placeholders and markers in s and in t, keeps plain braces', () => {
  for (const mark of ['{{1}}', '<a1>', '</a1>', 'GPU {{2}}', 'see <A1>here</a1>', '< a 1 >']) {
    assert.throws(() => Glossary.validateEntry({ s: mark }), { message: 'glossaryEntryInvalid' }, `s: ${mark}`);
    assert.throws(() => Glossary.validateEntry({ s: 'attention', t: mark }), { message: 'glossaryEntryInvalid' }, `t: ${mark}`);
  }
  for (const plain of ['a < b', '{x}', '<div>', '{{x}}', 'x -> y']) {
    assert.equal(Glossary.validateEntry({ s: plain }).s, plain, `s: ${plain}`);
    assert.equal(Glossary.validateEntry({ s: 'attention', t: plain }).t, plain, `t: ${plain}`);
  }
});

test('glossary: a stored entry with a marker is unreadable, and a put with one writes nothing', async () => {
  const warned = captureConsole('warn');
  try {
    const entries = Glossary.collect({
      'glossary:bbbb0001': { s: 'attention', t: '注意力', l: '*', u: 1 },
      'glossary:bbbb0002': { s: 'loss', t: '<a1>损失</a1>', l: '*', u: 2 },
      'glossary:bbbb0003': { s: '{{1}}', l: '*', u: 3 },
    });
    assert.deepEqual(entries.map((entry) => entry.id), ['bbbb0001']);
  } finally {
    warned.restore();
  }
  const sync = fakeSync();
  await withChrome(sync.chrome, async () => {
    await rejectsWith(write('put', { entry: { s: 'attention', t: '{{1}}' } }), 'glossaryEntryInvalid');
    await rejectsWith(write('put', { entry: { s: '</a1>', t: 'x' } }), 'glossaryEntryInvalid');
  });
  assert.deepEqual(sync.data, {}, 'a refused put wrote something');
});

// P1-D：词条里含批量分隔符会把快速批量切错位，拒收。分隔符只有一份（BATCH_DELIMITER）。
test('glossary: validateEntry rejects the batch delimiter in s and in t', () => {
  const delimiter = globalThis.BATCH_DELIMITER;
  assert.equal(typeof delimiter, 'string');
  assert.ok(delimiter.length > 0);
  for (const text of [delimiter, `a${delimiter}b`]) {
    assert.throws(() => Glossary.validateEntry({ s: text }), { message: 'glossaryEntryInvalid' }, `s: ${text}`);
    assert.throws(() => Glossary.validateEntry({ s: 'attention', t: text }), { message: 'glossaryEntryInvalid' }, `t: ${text}`);
  }
  // 分隔符的一部分不算
  const piece = delimiter.slice(0, 2);
  assert.equal(Glossary.validateEntry({ s: `x${piece}y` }).s, `x${piece}y`);
});

test('glossary: loading without BATCH_DELIMITER throws', () => {
  const source = repoFile('shared/glossary.js');
  const { SiteRules, StorageWriter, SyncCollection, TargetLang, TextMarkers } = globalThis;
  assert.throws(() => new Function('globalThis', source)({ SiteRules, StorageWriter, SyncCollection, TargetLang, TextMarkers }),
    /batch-delimiter/);
});

test('glossary: collect skips v > 1 and broken entries, keeps v missing or 1', () => {
  const warned = captureConsole('warn');
  try {
    const entries = Glossary.collect({
      'glossary:aaaa0001': { s: 'attention', t: '注意力', l: 'zh-CN', u: 1 },
      'glossary:aaaa0002': { v: 1, s: 'Transformer', c: 1, l: '*', u: 2 },
      'glossary:aaaa0003': { v: 2, s: 'future', l: '*' },
      'glossary:aaaa0004': { s: '', l: '*' },
      'customRule:aaaa0005': { v: 1, match: ['a.test'] },
    });
    assert.deepEqual(entries.map((entry) => entry.id), ['aaaa0001', 'aaaa0002']);
    assert.equal(warned.calls.length, 1);
    assert.match(String(warned.calls[0][0]), /skipped 2 unreadable entries/);
  } finally {
    warned.restore();
  }
});

test('glossary: dedupeKey folds case only for case-insensitive entries', () => {
  const key = (entry) => Glossary.dedupeKey(Glossary.validateEntry(entry));
  assert.equal(key({ s: 'Attention' }), key({ s: ' attention ' }));
  assert.equal(key({ s: 'Attention' }), 'i:attention|*|*');
  assert.notEqual(key({ s: 'Apple', c: 1 }), key({ s: 'apple', c: 1 }));
  assert.notEqual(key({ s: 'apple', c: 1 }), key({ s: 'apple' }));
  assert.notEqual(key({ s: 'apple', h: 'a.test' }), key({ s: 'apple' }));
  assert.notEqual(key({ s: 'apple', l: 'ja' }), key({ s: 'apple' }));
});

// ------------------------------------------------------------ 胜出

function entry(id, fields) {
  return Object.assign({ id }, Glossary.validateEntry(fields));
}

test('glossary: pick filters by host suffix and target language', () => {
  const entries = [
    entry('g1', { s: 'model', t: '模型' }),
    entry('s1', { s: 'kernel', t: '核', h: 'arxiv.org' }),
    entry('o1', { s: 'token', t: '令牌', h: 'other.test' }),
    entry('j1', { s: 'layer', t: 'レイヤー', l: 'ja' }),
    entry('z1', { s: 'loss', t: '损失', l: 'zh-CN' }),
  ];
  const ids = (host, lang) => Glossary.pick(entries, host, lang).map((e) => e.id).sort();
  assert.deepEqual(ids('export.arxiv.org', 'zh-CN'), ['g1', 's1', 'z1']);
  assert.deepEqual(ids('arxiv.org', 'ja'), ['g1', 'j1', 's1']);
  assert.deepEqual(ids('example.com', 'zh-CN'), ['g1', 'z1']);
  // www. 是同一个站点
  assert.deepEqual(ids('www.other.test', 'fr'), ['g1', 'o1']);
});

test('glossary: pick keeps one winner per source, most specific first', () => {
  const entries = [
    entry('a', { s: 'attention', t: 'G', u: 50 }),
    entry('b', { s: 'Attention', t: 'SITE', h: 'arxiv.org', u: 1 }),
    entry('c', { s: 'attention', t: 'LANG', l: 'zh-CN', u: 99 }),
    entry('d', { s: 'attention', t: 'SUB', h: 'export.arxiv.org', u: 1 }),
  ];
  // 站点 > 全局；更长的主机更具体
  assert.deepEqual(Glossary.pick(entries, 'export.arxiv.org', 'zh-CN').map((e) => e.t), ['SUB']);
  assert.deepEqual(Glossary.pick(entries, 'arxiv.org', 'zh-CN').map((e) => e.t), ['SITE']);
  // 指定语言 > 所有语言
  assert.deepEqual(Glossary.pick(entries, 'example.com', 'zh-CN').map((e) => e.t), ['LANG']);
  assert.deepEqual(Glossary.pick(entries, 'example.com', 'ja').map((e) => e.t), ['G']);
});

test('glossary: pick prefers case-sensitive, then newer, then the smaller id', () => {
  const caseFirst = [
    entry('a', { s: 'apple', t: 'fold', u: 99 }),
    entry('b', { s: 'Apple', t: 'CASE', c: 1, u: 1 }),
  ];
  assert.deepEqual(Glossary.pick(caseFirst, 'x.test', 'zh-CN').map((e) => e.t), ['CASE']);

  const newer = [entry('a', { s: 'go', t: 'old', u: 1 }), entry('b', { s: 'GO', t: 'new', u: 2 })];
  assert.deepEqual(Glossary.pick(newer, 'x.test', 'zh-CN').map((e) => e.t), ['new']);

  const tie = [entry('b', { s: 'go', t: 'B', u: 1 }), entry('a', { s: 'go', t: 'A', u: 1 })];
  assert.deepEqual(Glossary.pick(tie, 'x.test', 'zh-CN').map((e) => e.t), ['A']);

  // 两条都区分大小写、原文不逐字相等：各管各的，都留下
  const both = [entry('a', { s: 'Apple', t: 'A', c: 1 }), entry('b', { s: 'APPLE', t: 'B', c: 1 })];
  assert.deepEqual(Glossary.pick(both, 'x.test', 'zh-CN').map((e) => e.t).sort(), ['A', 'B']);
});

// ------------------------------------------------------------ 写入

test('glossary put: no id adds, the same dedupeKey replaces in place', async () => {
  const sync = fakeSync();
  await withChrome(sync.chrome, async () => {
    const first = await write('put', { entry: { s: 'attention', t: '注意力' } });
    assert.equal(first.replaced, false);
    assert.match(first.id, /^[0-9a-z]{8}$/);
    const stored = sync.data[`glossary:${first.id}`];
    assert.equal(stored.s, 'attention');
    assert.equal(stored.t, '注意力');
    assert.equal(stored.l, '*');
    assert.ok(Number.isFinite(stored.u));
    assert.equal(stored.id, undefined, 'the id lives only in the key');

    const again = await write('put', { entry: { s: 'Attention ', t: '关注' } });
    assert.deepEqual(again, { id: first.id, replaced: true });
    assert.equal(Object.keys(sync.data).length, 1);
    assert.equal(sync.data[`glossary:${first.id}`].t, '关注');
  });
});

test('glossary put: an id replaces that entry, a collision with another is glossaryDuplicate', async () => {
  const sync = fakeSync({
    'glossary:aaaa0001': { s: 'attention', t: '注意力', l: '*', u: 1 },
    'glossary:aaaa0002': { s: 'kernel', t: '核', l: '*', u: 1 },
  });
  await withChrome(sync.chrome, async () => {
    const edited = await write('put', { entry: { id: 'aaaa0002', s: 'kernel', t: '内核' } });
    assert.deepEqual(edited, { id: 'aaaa0002', replaced: true });
    assert.equal(sync.data['glossary:aaaa0002'].t, '内核');

    const before = JSON.stringify(sync.data);
    const setsBefore = sync.calls.set.length;
    await rejectsWith(write('put', { entry: { id: 'aaaa0002', s: 'Attention', t: 'x' } }), 'glossaryDuplicate');
    assert.equal(JSON.stringify(sync.data), before, 'storage untouched');
    assert.equal(sync.calls.set.length, setsBefore);

    const fresh = await write('put', { entry: { id: 'bbbb0001', s: 'loss' } });
    assert.deepEqual(fresh, { id: 'bbbb0001', replaced: false });
    await rejectsWith(write('put', { entry: { id: 'NOT AN ID', s: 'loss' } }), 'glossaryEntryInvalid');
  });
});

test('glossary put scope site: h comes from sender.tab.url, never from the payload', async () => {
  const sync = fakeSync();
  await withChrome(sync.chrome, async () => {
    const sender = { tab: { url: 'https://www.arxiv.org/abs/1' }, url: 'https://frame.test/embed' };
    // 网页一侧带来的 h 不再被悄悄换掉，而是整条拒绝（D-384 A8），存储不动。
    await rejectsWith(write('put', { entry: { s: 'attention', t: '注意力', h: 'evil.test' }, scope: 'site' }, sender), 'glossaryEntryInvalid');
    assert.deepEqual(sync.data, {});
    const reply = await write('put', { entry: { s: 'attention', t: '注意力' }, scope: 'site' }, sender);
    assert.equal(sync.data[`glossary:${reply.id}`].h, 'arxiv.org');

    await rejectsWith(write('put', { entry: { s: 'x' }, scope: 'site' }, {}), 'glossaryEntryInvalid');
    await rejectsWith(write('put', { entry: { s: 'x' }, scope: 'site' }, { tab: { url: 'not a url' } }), 'glossaryEntryInvalid');
    await rejectsWith(write('put', { entry: { s: 'x' }, scope: 'page' }, sender), 'glossaryEntryInvalid');
    await rejectsWith(write('put', {}), 'glossaryEntryInvalid');
  });
});

// D-384 A8：网页里的内容脚本（有 sender.tab、sender.url 是网页）带 h 的 put 一律
// 拒绝，有没有 scope 都一样；我们自己的扩展页 —— 设置页开在标签页里时也带
// sender.tab —— 和服务工作者自己写（没有 sender）照样可以带 h。
test('glossary put: a web page may not name a site; the settings page and the worker may', async () => {
  const sync = fakeSync();
  await withChrome(sync.chrome, async () => {
    const page = { tab: { id: 3, url: 'https://arxiv.org/abs/1' }, url: 'https://arxiv.org/abs/1' };
    const frame = { tab: { id: 3, url: 'https://arxiv.org/abs/1' }, url: 'https://embed.test/x' };
    for (const sender of [page, frame]) {
      await rejectsWith(write('put', { entry: { s: 'attention', h: 'arxiv.org' } }, sender), 'glossaryEntryInvalid');
      await rejectsWith(write('put', { entry: { s: 'attention', h: 'evil.test', l: 'zh-CN' } }, sender), 'glossaryEntryInvalid');
    }
    assert.deepEqual(sync.data, {}, 'a refused put wrote something');

    const optionsUrl = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options/options.html';
    const optionsTab = { tab: { id: 9, url: optionsUrl }, url: optionsUrl, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' };
    const popup = { url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup/popup.html' };
    const stored = [];
    for (const [sender, s] of [[optionsTab, 'loss'], [popup, 'token'], [undefined, 'layer']]) {
      const reply = await write('put', { entry: { s, h: 'WWW.Example.com' } }, sender);
      stored.push(sync.data[`glossary:${reply.id}`].h);
    }
    assert.deepEqual(stored, ['example.com', 'example.com', 'example.com']);
  });
});

test('glossary: siteKey is the one predicate for a site key; normalizeSite refuses exactly what it empties', () => {
  assert.equal(Glossary.siteKey('WWW.Arxiv.org.'), 'arxiv.org');
  assert.equal(Glossary.siteKey('localhost'), 'localhost');
  for (const bad of ['', '[::1]', '[2001:db8::1]', 'a b', 'a/b', 'host:8080', undefined, null, 7]) {
    assert.equal(Glossary.siteKey(bad), '', `siteKey(${JSON.stringify(bad)}) should be empty`);
  }
  // 一个带了 h 的条目：siteKey 给空的，存储一侧就拒绝 —— 同一个谓词。
  for (const bad of ['...', '[::1]', '[2001:db8::1]', 'a b', 'a/b', 'host:8080', 7]) {
    assert.throws(() => Glossary.validateEntry({ s: 'x', h: bad }), { message: 'glossaryEntryInvalid' }, `h ${JSON.stringify(bad)}`);
  }
  assert.equal(Glossary.validateEntry({ s: 'x', h: 'WWW.Arxiv.org.' }).h, 'arxiv.org');
});

test('glossary remove: ids are validated, removed counts only what existed', async () => {
  const sync = fakeSync({
    'glossary:aaaa0001': { s: 'a', l: '*' },
    'glossary:aaaa0002': { s: 'b', l: '*' },
  });
  await withChrome(sync.chrome, async () => {
    assert.deepEqual(await write('remove', { ids: ['aaaa0001', 'zzzz9999', 'aaaa0001'] }), { removed: 1 });
    assert.deepEqual(Object.keys(sync.data), ['glossary:aaaa0002']);
    await rejectsWith(write('remove', { ids: [] }), 'glossaryEntryInvalid');
    await rejectsWith(write('remove', { ids: ['../x'] }), 'glossaryEntryInvalid');
    await rejectsWith(write('remove', {}), 'glossaryEntryInvalid');
  });
});

test('glossary import: merges by dedupeKey, keeps the old id, stamps u, writes only what the file touched', async () => {
  const sync = fakeSync({
    'glossary:aaaa0001': { s: 'attention', t: '关注', l: 'zh-CN', u: 5 },
    'glossary:aaaa0002': { s: 'untouched', l: '*', u: 6 },
  });
  await withChrome(sync.chrome, async () => {
    const before = Date.now();
    const csv = 'source,target,case_sensitive,site,target_lang\r\nATTENTION,注意力,0,,zh-CN\r\nTransformer,,1,arxiv.org,*\r\n';
    assert.deepEqual(await write('import', { csv }), { added: 1, replaced: 1 });
    assert.equal(sync.calls.set.length, 1, 'one multi-key set');
    const written = sync.calls.set[0];
    assert.equal(Object.keys(written).length, 2, 'the untouched entry is not rewritten');
    assert.equal(written['glossary:aaaa0001'].s, 'ATTENTION', 'replacement keeps the existing id');
    assert.equal(written['glossary:aaaa0001'].t, '注意力');
    const fresh = Object.keys(written).find((key) => key !== 'glossary:aaaa0001');
    assert.deepEqual({ ...written[fresh], u: 0 }, { s: 'Transformer', c: 1, h: 'arxiv.org', l: '*', u: 0 });
    for (const value of Object.values(written)) assert.ok(value.u >= before, 'u is the moment of the import');
    assert.deepEqual(sync.data['glossary:aaaa0002'], { s: 'untouched', l: '*', u: 6 });
    assert.equal(sync.calls.remove.length, 0);
  });
});

test('glossary import: all or nothing, the worker re-parses and refuses a bad file without writing', async () => {
  const sync = fakeSync({ 'glossary:aaaa0001': { s: 'kept', l: '*', u: 1 } });
  await withChrome(sync.chrome, async () => {
    await rejectsWith(write('import', { csv: 'a,b\nc,d,e\n' }), 'glossaryImportInvalid');
    await rejectsWith(write('import', { csv: { rows: [] } }), 'glossaryImportInvalid');
    await rejectsWith(write('import', {}), 'glossaryImportInvalid');
    const many = Array.from({ length: 300 }, (_, i) => `term${i},t`).join('\n');
    await rejectsWith(write('import', { csv: many }), 'glossaryBudgetFull');
    assert.equal(sync.calls.set.length, 0);
    assert.deepEqual(Object.keys(sync.data), ['glossary:aaaa0001']);
  });
});

test('glossary import: without glossary-csv.js loaded it is glossarySaveFailed, logged once', async () => {
  const csv = globalThis.GlossaryCsv;
  delete globalThis.GlossaryCsv;
  const errors = captureConsole('error');
  try {
    const sync = fakeSync();
    await withChrome(sync.chrome, async () => {
      await rejectsWith(write('import', { csv: 'SECRET-TERM,x' }), 'glossarySaveFailed');
    });
    assert.equal(sync.calls.set.length, 0);
    assert.equal(errors.calls.length, 1);
    assert.match(String(errors.calls[0][0]), /^Glossary import write failed:/);
  } finally {
    errors.restore();
    globalThis.GlossaryCsv = csv;
  }
});

test('glossary writes: budget errors are keys, other failures become glossarySaveFailed and log once', async () => {
  // 300 条满额，第 301 条拒绝
  const full = {};
  for (let i = 0; i < 300; i += 1) full[`glossary:f${String(i).padStart(7, '0')}`] = { s: `t${i}`, l: '*' };
  await withChrome(fakeSync(full).chrome, async () => {
    await rejectsWith(write('put', { entry: { s: 'one more' } }), 'glossaryBudgetFull');
  });

  // 存储失败：换成 glossarySaveFailed，在这一层记一条，不带词条内容
  const broken = fakeSync();
  broken.chrome.storage.sync.set = async () => { throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded'); };
  const errors = captureConsole('error');
  try {
    await withChrome(broken.chrome, async () => {
      await rejectsWith(write('put', { entry: { s: 'SECRET-TERM' } }), 'glossarySaveFailed');
    });
    assert.equal(errors.calls.length, 1);
    assert.match(String(errors.calls[0][0]), /^Glossary put write failed:/);
    assert.ok(!errors.calls[0].some((arg) => String(arg).includes('SECRET-TERM')));
  } finally {
    errors.restore();
  }

  assert.equal(Glossary.userErrorKey(new Error('glossaryDuplicate')), 'glossaryDuplicate');
  assert.equal(Glossary.userErrorKey(new Error('glossarySaveFailed')), 'glossarySaveFailed');
  assert.equal(Glossary.userErrorKey(new Error('boom')), null);
});

test('glossary: an entry over 1 KiB stored is glossaryEntryTooLarge', async () => {
  // 字数都在上限内，但 80 个汉字的原文（240 字节）+ 160 个汉字的译文（480 字节）
  // + 一个长站点，存下来超过单条 1 KiB：按字节算，不按字数。
  await withChrome(fakeSync().chrome, async () => {
    await rejectsWith(write('put', { entry: { s: '中'.repeat(80), t: '文'.repeat(160), h: 'a'.repeat(300) + '.test' } }),
      'glossaryEntryTooLarge');
  });
});

// ------------------------------------------------------------ 接线

test('the worker imports glossary.js and glossary-csv.js and routes GLOSSARY_WRITE with the sender', () => {
  const worker = repoFile('background/background.js');
  const order = ['shared/sync-collection.js', 'shared/target-lang.js', 'shared/glossary.js', 'shared/glossary-csv.js',
    'shared/text-markers.js']
    .map((file) => worker.indexOf(`import '../${file}';`));
  assert.ok(order.every((at) => at >= 0), 'all five are imported');
  assert.ok(order[0] < order[2] && order[1] < order[2], 'glossary.js after its dependencies');
  assert.ok(order[4] < order[2], 'glossary.js after text-markers.js (it takes TextMarkers at load, D-387)');
  assert.ok(order[2] < order[3], 'glossary-csv.js after glossary.js (it takes Glossary at load)');
  assert.match(worker, /GLOSSARY_WRITE: \(\) => globalThis\.Glossary,/);
  assert.match(worker, /case 'GLOSSARY_WRITE':\s*STORAGE_WRITERS\[message\.type\]\(\)\.applyWrite\(message, sender\)/);
});
