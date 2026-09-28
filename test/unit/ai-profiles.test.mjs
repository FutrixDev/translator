// AI 配置档（shared/ai-profiles.js，P1-D）。
//
// 读、写、缓存、增量由 SyncCollection 给出，那一份在 sync-collection.test.mjs 里测
// （那里的防复制扫描也覆盖这个文件）；这一组测配置档自己的语义：形状校验、集合
// 规则、选档、给内容脚本的公开形状、旧四键的转换、四种写入，以及错误一律是
// i18n 键、日志里不带 Key。
//
// Run with: npm run test:unit
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
await import('../../shared/custom-rules.js');
const { AIProfiles } = globalThis;

function fakeSync(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const calls = { set: [], remove: [], get: [] };
  return {
    data,
    calls,
    chrome: {
      storage: {
        sync: {
          get: async (keys) => {
            calls.get.push(keys);
            const all = JSON.parse(JSON.stringify(data));
            if (keys == null) return all;
            return Object.fromEntries(keys.filter((key) => key in all).map((key) => [key, all[key]]));
          },
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

const write = (kind, payload) =>
  AIProfiles.applyWrite(Object.assign({ type: 'AI_PROFILES_WRITE', kind }, payload), {});
const rejectsWith = (promise, key) => assert.rejects(promise, { message: key });

const base = (over = {}) => Object.assign({
  name: 'Work',
  provider: 'openai',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: 'sk-secret-work',
  modelName: 'gpt-4.1-mini',
}, over);

const stored = (data) => Object.fromEntries(
  Object.entries(data).filter(([key]) => key.startsWith(AIProfiles.KEY_PREFIX)),
);

// ------------------------------------------------------------ 形状

test('ai-profiles: normalize trims, fills defaults and drops unknown fields', () => {
  const out = AIProfiles.normalize(Object.assign(base({ name: '  Work  ', apiKey: ' sk-x ' }), { colour: 'red', id: 'x' }));
  assert.deepEqual(out, {
    v: 1, name: 'Work', provider: 'openai', apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: 'sk-x', modelName: 'gpt-4.1-mini', features: [], default: false,
    rpm: 0, concurrency: 0, timeoutSec: 120,
  });
  // 功能去重并按 FEATURES 的顺序排
  assert.deepEqual(AIProfiles.normalize(base({ features: ['ocr', 'page', 'ocr'] })).features, ['page', 'ocr']);
  // 缺 Key 合法（本地模型）；上下限恰好合法
  assert.equal(AIProfiles.normalize(base({ apiKey: undefined })).apiKey, '');
  assert.doesNotThrow(() => AIProfiles.normalize(base({
    name: 'n'.repeat(40), modelName: 'm'.repeat(128), rpm: 600, concurrency: 32, timeoutSec: 240,
  })));
  assert.doesNotThrow(() => AIProfiles.normalize(base({ timeoutSec: 15, rpm: 0, concurrency: 0 })));
});

test('ai-profiles: validate answers aiProfileInvalid for every bad shape, null for a good one', () => {
  assert.equal(AIProfiles.validate(base()), null);
  const cases = [
    null, [], 'profile', {},
    base({ v: 2 }),
    base({ name: '' }), base({ name: '   ' }), base({ name: 'n'.repeat(41) }), base({ name: 3 }),
    base({ provider: 'acme' }), base({ provider: 'toString' }),
    base({ apiEndpoint: 'ftp://x.test/' }), base({ apiEndpoint: 'not a url' }), base({ apiEndpoint: '' }),
    base({ apiEndpoint: 'https://x.test/' + 'p'.repeat(512) }),
    base({ apiKey: 'k'.repeat(1025) }), base({ apiKey: 7 }),
    base({ modelName: '' }), base({ modelName: 'm'.repeat(129) }),
    base({ features: ['page', 'chat'] }), base({ features: 'page' }),
    base({ default: 'yes' }),
    base({ rpm: 601 }), base({ rpm: -1 }), base({ rpm: 1.5 }),
    base({ concurrency: 33 }), base({ timeoutSec: 14 }), base({ timeoutSec: 241 }), base({ timeoutSec: '60' }),
    base({ updatedAt: Number.NaN }), base({ updatedAt: '1' }),
  ];
  for (const profile of cases) {
    assert.equal(AIProfiles.validate(profile), 'aiProfileInvalid', JSON.stringify(profile));
  }
});

test('ai-profiles: validateSet wants exactly one default and each feature on at most one profile', () => {
  assert.equal(AIProfiles.validateSet([]), null);
  assert.equal(AIProfiles.validateSet([{ default: true, features: ['page'] }, { default: false, features: ['ocr'] }]), null);
  assert.equal(AIProfiles.validateSet([{ default: false, features: [] }]), 'aiProfileInvalid');
  assert.equal(AIProfiles.validateSet([{ default: true, features: [] }, { default: true, features: [] }]), 'aiProfileInvalid');
  assert.equal(AIProfiles.validateSet([{ default: true, features: ['page'] }, { default: false, features: ['page'] }]), 'aiProfileInvalid');
});

// ------------------------------------------------------------ 选档

test('ai-profiles: resolve picks rule profile, then the feature owner, then the default', () => {
  const profiles = [
    { id: 'main0001', default: true, features: [] },
    { id: 'ocr00001', default: false, features: ['ocr'] },
    { id: 'site0001', default: false, features: [] },
  ];
  assert.equal(AIProfiles.resolve(profiles, { feature: 'page' }).profile.id, 'main0001');
  assert.equal(AIProfiles.resolve(profiles, { feature: 'ocr' }).profile.id, 'ocr00001');
  // 规则指定的档压过功能分配
  assert.equal(AIProfiles.resolve(profiles, { feature: 'ocr', ruleProfileId: 'site0001' }).profile.id, 'site0001');
  // 规则指向的档不在：报错，不回落默认档
  assert.deepEqual(AIProfiles.resolve(profiles, { feature: 'page', ruleProfileId: 'gone0001' }),
    { error: 'aiProfileMissing', id: 'gone0001' });
  assert.deepEqual(AIProfiles.resolve([], { feature: 'page' }), { error: 'aiNotConfigured' });
  assert.deepEqual(AIProfiles.resolve(undefined, { feature: 'hover' }), { error: 'aiNotConfigured' });
  // 功能名写错是调用方的 bug：抛，不当成「未配置」
  assert.throws(() => AIProfiles.resolve(profiles, { feature: 'chat' }), TypeError);
  assert.throws(() => AIProfiles.resolve(profiles, {}), TypeError);
});

test('ai-profiles: resolveMessageKey words both resolve errors and throws on anything else', () => {
  // 「一档都没有」和弹出窗口是同一句 configureApiKeyFirst，不另起一句。
  assert.equal(AIProfiles.resolveMessageKey('aiNotConfigured'), 'configureApiKeyFirst');
  assert.equal(AIProfiles.resolveMessageKey('aiProfileMissing'), 'aiProfileMissing');
  for (const code of ['aiProfileInvalid', 'configureApiKeyFirst', '', undefined, 'toString']) {
    assert.throws(() => AIProfiles.resolveMessageKey(code), TypeError, String(code));
  }
});

test('ai-profiles: defaultOf is the one default or null; editDefault patches it without touching the input', () => {
  const main = Object.assign({ id: 'main0001', updatedAt: 5 }, AIProfiles.normalize(base({ default: true })));
  const other = Object.assign({ id: 'ocr00001' }, AIProfiles.normalize(base({ name: 'OCR', features: ['ocr'] })));
  assert.equal(AIProfiles.defaultOf([other, main]), main);
  assert.equal(AIProfiles.defaultOf([other]), null);
  assert.equal(AIProfiles.defaultOf(undefined), null);

  const before = JSON.stringify(main);
  const edited = AIProfiles.editDefault([other, main], { modelName: 'gpt-4.1', timeoutSec: 15 });
  assert.equal(JSON.stringify(main), before, '纯函数：不改传进来的档');
  assert.equal(edited.id, 'main0001', '改的是默认档本身，put 按 id 覆盖');
  assert.equal(edited.modelName, 'gpt-4.1');
  assert.equal(edited.timeoutSec, 15);
  assert.equal(edited.apiKey, 'sk-secret-work', '表单没提 Key 就留着');
  assert.equal(edited.name, 'Work', '用户起过的名字不跟服务商走');
  assert.equal('updatedAt' in edited, false, 'updatedAt 由写入口盖');

  // 没有默认档：盖在 DRAFT 上，名字跟着服务商。
  const fresh = AIProfiles.editDefault([], { provider: 'anthropic', apiEndpoint: 'https://api.anthropic.com/v1/messages', apiKey: 'k' });
  assert.equal('id' in fresh, false);
  assert.equal(fresh.name, globalThis.APICompat.PROVIDERS.anthropic.name);
  assert.equal(fresh.timeoutSec, AIProfiles.DRAFT.timeoutSec);
  assert.equal(AIProfiles.validate(fresh), null);
  // 名字还是服务商名的默认档，换服务商时名字跟着换；显式改名则不跟。
  const named = Object.assign({ id: 'main0001' }, AIProfiles.normalize(base({ name: globalThis.APICompat.PROVIDERS.openai.name, default: true })));
  assert.equal(AIProfiles.editDefault([named], { provider: 'anthropic' }).name, globalThis.APICompat.PROVIDERS.anthropic.name);
  assert.equal(AIProfiles.editDefault([named], { provider: 'anthropic', name: 'Mine' }).name, 'Mine');
});

test('ai-profiles: publicView carries no apiKey, only whether one is missing', () => {
  const view = AIProfiles.publicView(Object.assign({ id: 'main0001' }, AIProfiles.normalize(base())));
  assert.equal('apiKey' in view, false);
  assert.equal(JSON.stringify(view).includes('sk-secret-work'), false);
  assert.deepEqual(view, {
    id: 'main0001', name: 'Work', provider: 'openai', apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    modelName: 'gpt-4.1-mini', features: [], default: false, keyMissing: false,
  });
  assert.equal(AIProfiles.publicView(Object.assign({ id: 'a' }, AIProfiles.normalize(base({ apiKey: '' })))).keyMissing, true);
  const local = AIProfiles.normalize(base({ provider: 'ollama', apiEndpoint: 'http://localhost:11434/v1/chat/completions', apiKey: '' }));
  assert.equal(AIProfiles.publicView(Object.assign({ id: 'b' }, local)).keyMissing, false);
  // 内容脚本镜像的 decode 给的也是这个形状（去掉 id，id 由集合从键里取）
  const mirrored = AIProfiles.publicCollection.collect({ 'aiProfile:main0001': AIProfiles.normalize(base()) });
  assert.deepEqual(mirrored, [view]);
});

// ------------------------------------------------------------ 旧四键

test('ai-profiles: fromLegacy turns the four old keys into one default profile', () => {
  assert.equal(AIProfiles.fromLegacy({}), null);
  assert.equal(AIProfiles.fromLegacy({ theme: 'dark' }), null);
  assert.deepEqual(AIProfiles.fromLegacy({ apiKey: 'sk-old' }), {
    v: 1, name: 'OpenAI', provider: 'openai', apiEndpoint: AIProfiles.DRAFT.apiEndpoint, apiKey: 'sk-old',
    modelName: AIProfiles.DRAFT.modelName, features: [], default: true, rpm: 0, concurrency: 0, timeoutSec: 120,
  });
  const custom = AIProfiles.fromLegacy({ provider: 'acme', apiEndpoint: 'https://gw.test/v1', modelName: 'm1' });
  assert.equal(custom.provider, 'custom');
  assert.equal(custom.name, 'Custom');
  assert.equal(custom.apiKey, '');
  assert.equal(AIProfiles.fromLegacy({ provider: 'deepseek' }).name, 'DeepSeek');
});

// ------------------------------------------------------------ 写入

test('ai-profiles: the first put becomes the default; a later default put takes it over', async () => {
  const sync = fakeSync();
  await withChrome(sync.chrome, async () => {
    const { id: first } = await write('put', { profile: base() });
    assert.equal(sync.data[`aiProfile:${first}`].default, true);
    assert.equal('id' in sync.data[`aiProfile:${first}`], false, 'the id lives in the key only');
    const { id: second } = await write('put', { profile: base({ name: 'Home', default: true, features: ['ocr'] }) });
    assert.equal(sync.data[`aiProfile:${second}`].default, true);
    assert.equal(sync.data[`aiProfile:${first}`].default, false);
    // 功能从别的档上摘下来
    const { id: third } = await write('put', { profile: base({ name: 'Vision', features: ['ocr', 'hover'] }) });
    assert.deepEqual(sync.data[`aiProfile:${second}`].features, []);
    assert.deepEqual(sync.data[`aiProfile:${third}`].features, ['hover', 'ocr']);
    assert.equal(AIProfiles.validateSet(AIProfiles.collection.collect(sync.data)), null);
    // 带 id 的 put 是整档替换
    await write('put', { profile: base({ id: third, name: 'Vision 2', features: ['ocr'] }) });
    assert.equal(sync.data[`aiProfile:${third}`].name, 'Vision 2');
    assert.equal(Object.keys(stored(sync.data)).length, 3);
  });
});

test('ai-profiles: a put that would leave no default, or a bad shape, writes nothing', async () => {
  const sync = fakeSync();
  await withChrome(sync.chrome, async () => {
    const { id } = await write('put', { profile: base() });
    await write('put', { profile: base({ name: 'Other' }) });
    const before = JSON.stringify(sync.data);
    // 把唯一的默认档改成非默认：写后没有默认档
    await rejectsWith(write('put', { profile: base({ id, default: false }) }), 'aiProfileInvalid');
    await rejectsWith(write('put', { profile: base({ modelName: '' }) }), 'aiProfileInvalid');
    await rejectsWith(write('put', { profile: base({ id: 'bad id!' }) }), 'aiProfileInvalid');
    assert.equal(JSON.stringify(sync.data), before);
  });
});

test('ai-profiles: a storage failure becomes aiProfileSaveFailed, logged once without the key', async () => {
  const sync = fakeSync();
  sync.chrome.storage.sync.set = async () => { throw new Error('boom'); };
  const logged = captureConsole('error');
  try {
    await withChrome(sync.chrome, () => rejectsWith(write('put', { profile: base() }), 'aiProfileSaveFailed'));
  } finally {
    logged.restore();
  }
  assert.equal(logged.calls.length, 1);
  assert.match(String(logged.calls[0][0]), /AIProfiles put write failed/);
  assert.equal(JSON.stringify(logged.calls.map((args) => args.map(String))).includes('sk-secret-work'), false);
  assert.equal(AIProfiles.userErrorKey(new Error('aiProfileSaveFailed')), 'aiProfileSaveFailed');
  assert.equal(AIProfiles.userErrorKey(new Error('aiProfileInUse')), 'aiProfileInUse');
  assert.equal(AIProfiles.userErrorKey(new Error('boom')), null);
});

test('ai-profiles: remove refuses a profile a site rule uses, and the default while others exist', async () => {
  const sync = fakeSync({
    'aiProfile:main0001': Object.assign(AIProfiles.normalize(base({ default: true })), { updatedAt: 1 }),
    'aiProfile:site0001': Object.assign(AIProfiles.normalize(base({ name: 'Site' })), { updatedAt: 1 }),
    'aiProfile:free0001': Object.assign(AIProfiles.normalize(base({ name: 'Free' })), { updatedAt: 1 }),
    'customRule:rule0001': { v: 3, match: ['a.test', 'b.test'], profile: 'site0001', updatedAt: 1 },
  });
  await withChrome(sync.chrome, async () => {
    await assert.rejects(write('remove', { id: 'site0001' }), (error) => {
      assert.equal(error.message, 'aiProfileInUse');
      assert.deepEqual(error.params, { rules: 'a.test, b.test' });
      return true;
    });
    await rejectsWith(write('remove', { id: 'main0001' }), 'aiProfileDefaultInUse');
    assert.deepEqual(await write('remove', { id: 'free0001' }), { removed: true });
    assert.deepEqual(await write('remove', { id: 'none0001' }), { removed: false });
    await rejectsWith(write('remove', { id: '' }), 'aiProfileInvalid');
    assert.deepEqual(Object.keys(stored(sync.data)).sort(), ['aiProfile:main0001', 'aiProfile:site0001']);
  });
  // 只剩默认档时可以删（集合变空是合法的）
  const lone = fakeSync({ 'aiProfile:main0001': AIProfiles.normalize(base({ default: true })) });
  await withChrome(lone.chrome, async () => {
    assert.deepEqual(await write('remove', { id: 'main0001' }), { removed: true });
  });
  assert.deepEqual(stored(lone.data), {});
});

test('ai-profiles: import merges by id; keepKeys keeps the local key only for keyless profiles', async () => {
  const sync = fakeSync({
    'aiProfile:main0001': AIProfiles.normalize(base({ default: true, apiKey: 'sk-local-main' })),
    'aiProfile:ocr00001': AIProfiles.normalize(base({ name: 'Vision', features: ['ocr'], apiKey: 'sk-local-ocr' })),
  });
  const file = [
    Object.assign(base({ name: 'Main (file)' }), { id: 'main0001', apiKey: undefined }),
    Object.assign(base({ name: 'Vision (file)', features: ['ocr'], apiKey: 'sk-from-file' }), { id: 'ocr00001' }),
    Object.assign(base({ name: 'New', features: ['page'] }), { id: 'new00001', apiKey: undefined }),
  ];
  await withChrome(sync.chrome, async () => {
    assert.deepEqual(await write('import', { profiles: file, keepKeys: true }), { added: 1, replaced: 2 });
  });
  assert.equal(sync.data['aiProfile:main0001'].apiKey, 'sk-local-main');
  assert.equal(sync.data['aiProfile:main0001'].name, 'Main (file)');
  assert.equal(sync.data['aiProfile:main0001'].default, true, 'the local default stays when the file names none');
  assert.equal(sync.data['aiProfile:ocr00001'].apiKey, 'sk-from-file');
  assert.equal(sync.data['aiProfile:new00001'].apiKey, '');
  assert.deepEqual(sync.data['aiProfile:new00001'].features, ['page']);

  const blank = fakeSync({ 'aiProfile:main0001': AIProfiles.normalize(base({ default: true, apiKey: 'sk-local-main' })) });
  await withChrome(blank.chrome, async () => {
    await write('import', { profiles: [Object.assign(base(), { id: 'main0001', apiKey: undefined })], keepKeys: false });
  });
  assert.equal(blank.data['aiProfile:main0001'].apiKey, '', 'keepKeys false: a keyless file clears the key');

  // 本机是空的、文件里又没标默认：导进来的第一档当默认
  const empty = fakeSync();
  await withChrome(empty.chrome, async () => {
    await write('import', {
      profiles: [Object.assign(base({ name: 'A' }), { id: 'aaaa0001' }), Object.assign(base({ name: 'B' }), { id: 'bbbb0001' })],
      keepKeys: false,
    });
  });
  assert.equal(empty.data['aiProfile:aaaa0001'].default, true);
  assert.equal(empty.data['aiProfile:bbbb0001'].default, false);
});

test('ai-profiles: import refuses bad batches without writing', async () => {
  const sync = fakeSync();
  const one = Object.assign(base(), { id: 'aaaa0001' });
  await withChrome(sync.chrome, async () => {
    await rejectsWith(write('import', { profiles: [], keepKeys: false }), 'aiProfileInvalid');
    await rejectsWith(write('import', { profiles: [one], keepKeys: 'yes' }), 'aiProfileInvalid');
    await rejectsWith(write('import', { profiles: [one, one], keepKeys: false }), 'aiProfileInvalid');
    await rejectsWith(write('import', { profiles: [base()], keepKeys: false }), 'aiProfileInvalid');
    await rejectsWith(write('import', {
      profiles: [Object.assign(base({ default: true }), { id: 'aaaa0001' }), Object.assign(base({ default: true }), { id: 'bbbb0001' })],
      keepKeys: false,
    }), 'aiProfileInvalid');
    await rejectsWith(write('import', {
      profiles: Array.from({ length: 21 }, (_, index) => Object.assign(base(), { id: `p${String(index).padStart(7, '0')}` })),
      keepKeys: false,
    }), 'aiProfileInvalid');
  });
  assert.deepEqual(sync.data, {});
});

test('ai-profiles: the byte budget is the collection budget', async () => {
  const sync = fakeSync();
  // 每档约 1.8 KB（单条上限 2.5 KB 以内），8 KB 装得下四档，第五档拒收
  const big = (index) => base({
    name: `big ${index}`, apiKey: 'k'.repeat(1024), apiEndpoint: 'https://x.test/' + 'p'.repeat(490), modelName: 'm'.repeat(128),
  });
  await withChrome(sync.chrome, async () => {
    for (let index = 0; index < 4; index += 1) await write('put', { profile: big(index) });
    await rejectsWith(write('put', { profile: big(4) }), 'aiProfilesBudgetFull');
  });
  assert.equal(Object.keys(stored(sync.data)).length, 4);
});

// ------------------------------------------------------------ 迁移

test('ai-profiles: migrateLegacy writes aiProfile:legacy as the default and removes the old keys', async () => {
  const sync = fakeSync({ provider: 'deepseek', apiEndpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: 'sk-old', modelName: 'deepseek-chat', theme: 'dark' });
  await withChrome(sync.chrome, async () => {
    assert.deepEqual(await write('migrateLegacy', {}), { migrated: true });
    // 第二次：旧键已删，什么都不做
    assert.deepEqual(await write('migrateLegacy', {}), { migrated: false });
  });
  const legacy = sync.data['aiProfile:legacy'];
  assert.equal(legacy.provider, 'deepseek');
  assert.equal(legacy.apiKey, 'sk-old');
  assert.equal(legacy.default, true);
  for (const key of AIProfiles.LEGACY_KEYS) assert.equal(key in sync.data, false, key);
  assert.equal(sync.data.theme, 'dark', 'other settings untouched');
});

test('ai-profiles: migrateLegacy skips when another device already migrated, keys still removed', async () => {
  const sync = fakeSync({
    'aiProfile:legacy': AIProfiles.normalize(base({ default: true, apiKey: 'sk-first-device' })),
    apiKey: 'sk-stale',
  });
  await withChrome(sync.chrome, async () => {
    assert.deepEqual(await write('migrateLegacy', {}), { migrated: false });
  });
  assert.equal(sync.data['aiProfile:legacy'].apiKey, 'sk-first-device');
  assert.equal('apiKey' in sync.data, false);
});

test('ai-profiles: an unusable legacy value makes no profile, logs without the key, removes the old keys', async () => {
  const sync = fakeSync({ provider: 'custom', apiEndpoint: '', apiKey: 'sk-broken', modelName: '' });
  const warned = captureConsole('warn');
  try {
    await withChrome(sync.chrome, async () => {
      assert.deepEqual(await write('migrateLegacy', {}), { migrated: false });
    });
  } finally {
    warned.restore();
  }
  assert.deepEqual(stored(sync.data), {});
  for (const key of AIProfiles.LEGACY_KEYS) assert.equal(key in sync.data, false, key);
  assert.equal(warned.calls.length, 1);
  assert.equal(JSON.stringify(warned.calls.map((args) => args.map(String))).includes('sk-broken'), false);
});

test('ai-profiles: a legacy profile joining an existing set does not steal the default', async () => {
  const sync = fakeSync({
    'aiProfile:main0001': AIProfiles.normalize(base({ default: true })),
    apiKey: 'sk-old',
  });
  await withChrome(sync.chrome, async () => {
    assert.deepEqual(await write('migrateLegacy', {}), { migrated: true });
  });
  assert.equal(sync.data['aiProfile:legacy'].default, false);
  assert.equal(sync.data['aiProfile:main0001'].default, true);
});
