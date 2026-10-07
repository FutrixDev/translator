// AI 配置档：service worker 这一半（background/ai-profiles-host.js，P1-D 设计
// §2.5、§2.6、§3.6）。
//
// 守四件事：旧四键只迁一次、迁失败下次再试；翻译消息按 profileId 取整档，没带
// id 是调用方的错、带了却不在是用户能看到的错；给内容脚本的公开形状不含 Key；
// 测试连接的失败只在这里记一次日志，日志里没有 Key。
//
// 模块顶层注册监听——在 import 之前装好替身，捉住生产注册的那一个。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';

const listeners = { message: [] };
const data = {
  provider: 'openai',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: 'sk-legacy-secret',
  modelName: 'gpt-4.1-mini',
  targetLang: 'zh-CN',
};
const calls = { get: 0, remove: [] };
let failNextGet = false;

function pick(all, keys) {
  if (keys == null) return all;
  if (typeof keys === 'string') keys = [keys];
  if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in all).map((key) => [key, all[key]]));
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, key in all ? all[key] : fallback]));
}

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    getPlatformInfo: async () => ({ os: 'mac' }),
  },
  i18n: { getUILanguage: () => 'en' },
  storage: {
    sync: {
      get: async (keys) => {
        calls.get += 1;
        if (failNextGet) {
          failNextGet = false;
          throw new Error('sync unavailable');
        }
        return pick(JSON.parse(JSON.stringify(data)), keys);
      },
      set: async (items) => { Object.assign(data, JSON.parse(JSON.stringify(items))); },
      remove: async (keys) => {
        calls.remove.push(keys);
        for (const key of [].concat(keys)) delete data[key];
      },
    },
  },
};

await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/prompt-addenda.js');
await import('../../shared/api-compat.js');
await import('../../shared/ai-profiles.js');
await import('../../i18n/lang/en.js');
const host = await import('../../background/ai-profiles-host.js');
const { ensureMigrated, profileById, profileFor, handleMessage } = host;
const { AIProfiles } = globalThis;

function captureConsole(method) {
  const logged = [];
  const saved = console[method];
  console[method] = (...args) => logged.push(args);
  return { logged, restore: () => { console[method] = saved; } };
}

/** 通过生产注册的监听器发一条消息，等它回话。 */
function send(message) {
  return new Promise((resolve, reject) => {
    const [listener] = listeners.message;
    const kept = listener(message, {}, resolve);
    if (kept !== true) reject(new Error(`listener did not keep the channel for ${message.type}`));
  });
}

const profileKeys = () => Object.keys(data).filter((key) => key.startsWith(AIProfiles.KEY_PREFIX));

// 顺序有意义：模块里的迁移记忆一次成功后就一直在。

test('ai-profiles-host: registers exactly one message listener', () => {
  assert.equal(listeners.message.length, 1);
  assert.equal(listeners.message[0], handleMessage);
});

test('ai-profiles-host: a failed migration is forgotten and retried; a successful one runs once', async () => {
  failNextGet = true;
  const error = captureConsole('error');
  try {
    await assert.rejects(ensureMigrated(), /sync unavailable/);
  } finally {
    error.restore();
  }
  assert.ok('apiKey' in data, 'nothing was removed by the failed attempt');

  await ensureMigrated();
  assert.deepEqual(profileKeys(), [`${AIProfiles.KEY_PREFIX}${AIProfiles.LEGACY_ID}`]);
  for (const key of AIProfiles.LEGACY_KEYS) assert.ok(!(key in data), `old key ${key} is deleted`);
  assert.equal(data.targetLang, 'zh-CN', 'other settings are untouched');

  const before = calls.get;
  const first = ensureMigrated();
  assert.equal(ensureMigrated(), first, 'memoised: the same promise');
  await first;
  assert.equal(calls.get, before, 'no second read of the old keys in this worker lifetime');
});

test('ai-profiles-host: profileById returns the whole profile, key included', async () => {
  const profile = await profileById(AIProfiles.LEGACY_ID);
  assert.equal(profile.apiKey, 'sk-legacy-secret');
  assert.equal(profile.modelName, 'gpt-4.1-mini');
  assert.equal(profile.default, true);
});

test('ai-profiles-host: a request without profileId is a caller bug; an unknown id is aiProfileMissing', async () => {
  for (const id of [undefined, '']) await assert.rejects(profileById(id), TypeError);
  const error = await profileById('gone').then(() => assert.fail('should throw'), (err) => err);
  assert.deepEqual(error.profileError, { key: 'aiProfileMissing', id: 'gone' });
});

test('ai-profiles-host: the Blab profile id answers the fixed Blab profile, not a stored one', async () => {
  const before = calls.get;
  const profile = await profileById(globalThis.Engines.BLAB_PROFILE.id);
  assert.equal(profile, globalThis.Engines.BLAB_PROFILE);
  assert.equal(calls.get, before, 'nothing is read from sync for it');
});

test('ai-profiles-host: profileFor picks by feature (OCR has no site rule)', async () => {
  const profile = await profileFor('ocr');
  assert.equal(profile.id, AIProfiles.LEGACY_ID);
});

test('ai-profiles-host: AI_PROFILES_PUBLIC never carries a key', async () => {
  const reply = await send({ type: 'AI_PROFILES_PUBLIC' });
  assert.equal(reply.profiles.length, 1);
  assert.equal(reply.profiles[0].id, AIProfiles.LEGACY_ID);
  assert.ok(!JSON.stringify(reply).includes('sk-legacy-secret'));
  assert.ok(!('apiKey' in reply.profiles[0]));
});

test('ai-profiles-host: AI_PROFILES_READY answers per feature', async () => {
  assert.deepEqual(await send({ type: 'AI_PROFILES_READY', feature: 'page' }), { ready: true });
});

test('ai-profiles-host: other messages are not answered', () => {
  let answered = false;
  assert.equal(handleMessage({ type: 'TRANSLATE' }, {}, () => { answered = true; }), undefined);
  assert.equal(handleMessage(undefined, {}, () => { answered = true; }), undefined);
  assert.equal(answered, false);
});

async function withFetch(answer, run) {
  const saved = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return answer();
  };
  try {
    return await run(seen);
  } finally {
    globalThis.fetch = saved;
  }
}

const draft = {
  name: 'Draft',
  provider: 'custom',
  apiEndpoint: 'http://127.0.0.1:9/v1/chat/completions',
  apiKey: 'sk-draft-secret',
  modelName: 'draft-model',
  timeoutSec: 30,
};

test('ai-profiles-host: AI_PROFILE_TEST sends one minimal request with the unsaved draft', async () => {
  await withFetch(() => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Hi' } }] }) }),
    async (seen) => {
      assert.deepEqual(await send({ type: 'AI_PROFILE_TEST', profile: draft }), { ok: true });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, draft.apiEndpoint);
      assert.equal(seen[0].body.model, 'draft-model');
    });
  assert.deepEqual(profileKeys(), [`${AIProfiles.KEY_PREFIX}${AIProfiles.LEGACY_ID}`], 'the draft is not saved');
});

test('ai-profiles-host: a failed AI_PROFILE_TEST is worded, logged once, and the log has no key', async () => {
  const error = captureConsole('error');
  let reply;
  try {
    // D2：响应要带 headers（callModel 读 Retry-After），真 fetch 的响应总有。
    await withFetch(() => ({ ok: false, status: 401, headers: new Headers(),
      json: async () => ({ error: { message: 'Incorrect API key' } }) }),
    async () => { reply = await send({ type: 'AI_PROFILE_TEST', profile: draft }); });
  } finally {
    error.restore();
  }
  assert.equal(typeof reply.error, 'string');
  assert.ok(reply.error.startsWith(globalThis.getMessage('apiErrorAuth', 'en')), reply.error);
  assert.equal(error.logged.length, 1);
  assert.match(String(error.logged[0][0]), /^AI_PROFILE_TEST failed \(profile \(unsaved\), feature \(test\)\)/);
  assert.ok(!JSON.stringify(error.logged, (key, value) => (value instanceof Error ? value.message : value))
    .includes('sk-draft-secret'));
});

test('ai-profiles-host: AI_PROFILE_TEST tries once even on a retryable failure (no retry, no limiter)', async () => {
  const error = captureConsole('error');
  let reply;
  try {
    await withFetch(() => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '1' }),
      json: async () => ({}) }),
    async (seen) => {
      reply = await send({ type: 'AI_PROFILE_TEST', profile: Object.assign({}, draft, { concurrency: 1, rpm: 1 }) });
      reply = await send({ type: 'AI_PROFILE_TEST', profile: Object.assign({}, draft, { concurrency: 1, rpm: 1 }) });
      assert.equal(seen.length, 2, 'AI_PROFILE_TEST once per click: no retry, and rpm 1 does not hold the second back');
    });
  } finally {
    error.restore();
  }
  assert.ok(reply.error.startsWith(globalThis.getMessage('apiErrorUnavailable', 'en')), reply.error);
  assert.match(String(error.logged[0][0]), /^AI_PROFILE_TEST failed \(profile/, 'one try: no "after N attempts"');
});

test('ai-profiles-host: a draft the form described badly is refused with its error key, no request', async () => {
  const error = captureConsole('error');
  let reply;
  try {
    await withFetch(() => assert.fail('no request for an invalid draft'), async () => {
      reply = await send({ type: 'AI_PROFILE_TEST', profile: Object.assign({}, draft, { modelName: '' }) });
    });
  } finally {
    error.restore();
  }
  assert.equal(typeof reply.error, 'string');
  assert.equal(error.logged.length, 1);
});
