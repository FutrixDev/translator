// 输入框按钮的「在此网站不显示」（shared/input-chip-hosts.js）。
//
// 它存在自己的 sync 键里，不碰用户站点规则：隐藏之后再写的规则，仍是旧版本扩展
// 认得的形状（custom-rules.js 与 bd92bba 逐字相同，VERSIONS 仍是 1/2/3）。
import test from 'node:test';
import assert from 'node:assert/strict';

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/prompt-addenda.js');
await import('../../shared/api-compat.js');
await import('../../shared/ai-profiles.js');
await import('../../shared/engines.js');
await import('../../shared/custom-rules.js');
await import('../../shared/input-chip-hosts.js');
const { CustomRules, InputChipHosts } = globalThis;

function fakeSync() {
  const data = {};
  return {
    data,
    chrome: {
      storage: {
        sync: {
          get: async () => JSON.parse(JSON.stringify(data)),
          set: async (items) => { Object.assign(data, JSON.parse(JSON.stringify(items))); },
          remove: async (keys) => { for (const key of keys) delete data[key]; },
        },
      },
    },
  };
}

async function withChrome(chrome, run) {
  const saved = globalThis.chrome;
  globalThis.chrome = chrome;
  try {
    return await run();
  } finally {
    globalThis.chrome = saved;
  }
}

const hide = (host) => InputChipHosts.applyWrite({ type: 'INPUT_CHIP_HOSTS_WRITE', kind: 'hide', host });

test('input-chip-hosts: hiding stores one normalized host list, once', async () => {
  const sync = fakeSync();
  await withChrome(sync.chrome, async () => {
    assert.equal(await InputChipHosts.hidden('www.example.com'), false);
    await hide('www.example.com');
    await hide('example.com');
    assert.deepEqual(sync.data, { inputChipHiddenHosts: ['example.com'] });
    assert.equal(await InputChipHosts.hidden('example.com'), true);
    assert.equal(await InputChipHosts.hidden('other.com'), false);
  });
});

test('input-chip-hosts: a site rule written after hiding is still one the old decoder reads', async () => {
  const sync = fakeSync();
  await withChrome(sync.chrome, async () => {
    await hide('example.com');
    await CustomRules.applyWrite({
      type: 'CUSTOM_RULES_WRITE', kind: 'addSelector',
      host: 'example.com', path: '/docs', field: 'keepOriginal', selector: '.brand',
    });
  });
  const ruleKeys = Object.keys(sync.data).filter((key) => key !== 'inputChipHiddenHosts');
  assert.equal(ruleKeys.length, 1);
  assert.match(ruleKeys[0], /^customRule:/);
  const stored = sync.data[ruleKeys[0]];
  // bd92bba 的解码器：v 不在 {1,2,3} 里的整条丢掉；也没有 inputChip 字段。
  assert.ok([1, 2, 3].includes(stored.v), `v=${stored.v}`);
  assert.equal('inputChip' in stored, false);
  const rules = CustomRules.collect(sync.data);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].keepOriginal, ['.brand']);
  assert.equal(CustomRules.collect({ [ruleKeys[0]]: { ...stored, v: 4 } }).length, 0, 'v4 would be dropped');
});

// 「重新显示」：设置页那一行的按钮。它和 hide 走同一个单写者（applyWrite 的 kind:'show'），
// 没有它，点过一次「在此网站不显示」就再也撤不回来（rr2 B1）。
const show = (host) => InputChipHosts.applyWrite({ type: 'INPUT_CHIP_HOSTS_WRITE', kind: 'show', host });

function countingSync(initial) {
  const sync = fakeSync();
  Object.assign(sync.data, initial);
  let writes = 0;
  const set = sync.chrome.storage.sync.set;
  sync.chrome.storage.sync.set = async (items) => { writes += 1; return set(items); };
  return { ...sync, writes: () => writes };
}

test('input-chip-hosts: show takes the normalized host out, duplicates included, and keeps the others in order', async () => {
  const sync = countingSync({ inputChipHiddenHosts: ['a.com', 'example.com', 'b.com', 'example.com', 'c.com'] });
  await withChrome(sync.chrome, async () => {
    await show('www.example.com');
    assert.deepEqual(sync.data.inputChipHiddenHosts, ['a.com', 'b.com', 'c.com']);
    assert.equal(await InputChipHosts.hidden('example.com'), false);
    assert.equal(await InputChipHosts.hidden('b.com'), true);
    assert.equal(sync.writes(), 1);
  });
});

test('input-chip-hosts: showing a host that is not hidden writes nothing', async () => {
  const sync = countingSync({ inputChipHiddenHosts: ['a.com'] });
  await withChrome(sync.chrome, async () => {
    await show('other.com');
    assert.deepEqual(sync.data.inputChipHiddenHosts, ['a.com']);
    const empty = countingSync({});
    await withChrome(empty.chrome, () => show('a.com'));
    assert.deepEqual(empty.data, {}, 'no key is created by a show');
    assert.equal(empty.writes(), 0);
  });
  assert.equal(sync.writes(), 0);
});

test('input-chip-hosts: hide, show, hide again is one entry, newest last; list has each host once', async () => {
  const sync = countingSync({ inputChipHiddenHosts: ['a.com', 'a.com'] });
  await withChrome(sync.chrome, async () => {
    assert.deepEqual(await InputChipHosts.list(), ['a.com']);
    await hide('example.com');
    await hide('b.com');
    await show('example.com');
    await hide('example.com');
    assert.deepEqual(await InputChipHosts.list(), ['a.com', 'b.com', 'example.com']);
  });
});

test('input-chip-hosts: show refuses something that is not a host, and the failure reaches the caller', async () => {
  const sync = countingSync({ inputChipHiddenHosts: ['a.com'] });
  await withChrome(sync.chrome, async () => {
    await assert.rejects(show(''), /not a host/);
  });
  assert.equal(sync.writes(), 0);
});
