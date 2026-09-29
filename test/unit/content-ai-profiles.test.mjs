// 本 frame 的 AI 配置档镜像（content/content-ai-profiles.js，ctx.aiProfiles，P1-D）。
//
// 镜像本身（先取一次、之后按增量走、去抖、1500 ms 上限）在 sync-collection.test.mjs
// 里测；这里测这个文件自己的那一半：三个状态（pending / ready / failed）、晚到的回话
// 照样翻成 ready 并通知订阅者、resolve 在非 ready 时抛而 ready() 答 false、站点规则
// 指定的档胜过默认档、登记进 ctx.syncMirrors 的前缀，以及发给 SW 的那条消息只有
// type —— Key 不进页面，增量经 publicCollection 解出来也没有 apiKey。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { repoSource, routeSyncMirrorsOf } from './helpers/sources.mjs';

// shared/ai-profiles.js 装载时取走 StorageWriter / SyncCollection / APICompat，
// sync-collection.js 又取走 SiteRules：顺序同 manifest。
await import('../../shared/lang-tags.js');
await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/api-compat.js');
await import('../../shared/ai-profiles.js');
const { AIProfiles } = globalThis;

const SOURCE = repoSource('content/content-ai-profiles.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const profile = (id, over = {}) => Object.assign({
  id, name: id, provider: 'openai', apiEndpoint: ENDPOINT, modelName: 'gpt-4.1-mini',
  features: [], default: false, keyMissing: false,
}, over);

/**
 * 每次 new Function 求值一份新的闭包（CJS 缓存不认查询串）。reply 是 SW 的回话：
 * 值、抛错的函数，或一个由测试自己决定何时兑现的 promise。
 */
function load({ reply, override = null } = {}) {
  const sent = [];
  const rule = { override };
  const ctx = { syncMirrors: [], customRules: { profileOverride: () => rule.override } };
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
        return typeof reply === 'function' ? reply() : reply;
      },
    },
  };
  new Function('window', 'chrome', 'location', SOURCE)(
    { AI_TRANSLATOR_CONTENT: ctx }, chrome, { hostname: 'profiles.test' });
  return { ctx, sent, rule };
}

test('content-ai-profiles: whenReady() before init() throws instead of waiting forever', () => {
  const { ctx } = load({ reply: { profiles: [] } });
  assert.throws(() => ctx.aiProfiles.whenReady(), /before init/);
  assert.equal(ctx.aiProfiles.status(), 'pending');
});

test('content-ai-profiles: asks the worker once with the bare message, then resolves the default, a feature and a rule pin', async () => {
  const list = [
    profile('main', { default: true }),
    profile('fast', { features: ['page'] }),
    profile('pinned'),
  ];
  const { ctx, sent, rule } = load({ reply: { profiles: list } });
  ctx.aiProfiles.init();
  ctx.aiProfiles.init();
  await ctx.aiProfiles.whenReady();
  assert.deepEqual(sent, [{ type: 'AI_PROFILES_PUBLIC' }], '只要一次，消息里只有 type（不带主机、不带 Key）');
  assert.equal(ctx.aiProfiles.status(), 'ready');

  assert.equal(ctx.aiProfiles.resolve('selection').profile.id, 'main');
  assert.equal(ctx.aiProfiles.resolve('page').profile.id, 'fast');
  rule.override = 'pinned';
  assert.equal(ctx.aiProfiles.resolve('page').profile.id, 'pinned', '站点规则指定的档胜过功能分配');
  rule.override = 'gone';
  assert.deepEqual(ctx.aiProfiles.resolve('page'), { error: 'aiProfileMissing', id: 'gone' },
    '规则指向的档不在就报错，不回落到默认档');
  assert.equal(ctx.aiProfiles.ready('page'), false);
  rule.override = null;

  assert.equal(ctx.aiProfiles.ready('selection'), true);
  assert.throws(() => ctx.aiProfiles.resolve(undefined), TypeError, '请求没标 feature 就抛');
  assert.throws(() => ctx.aiProfiles.ready('nope'), TypeError);
});

test('content-ai-profiles: a profile whose key is missing is resolved but not ready', async () => {
  const { ctx } = load({ reply: { profiles: [profile('main', { default: true, keyMissing: true })] } });
  ctx.aiProfiles.init();
  await ctx.aiProfiles.whenReady();
  assert.equal(ctx.aiProfiles.resolve('hover').profile.id, 'main');
  assert.equal(ctx.aiProfiles.ready('hover'), false);
});

test('content-ai-profiles: no profile at all answers aiNotConfigured, and ready() is false', async () => {
  const { ctx } = load({ reply: { profiles: [] } });
  ctx.aiProfiles.init();
  await ctx.aiProfiles.whenReady();
  assert.deepEqual(ctx.aiProfiles.resolve('page'), { error: 'aiNotConfigured' });
  assert.equal(ctx.aiProfiles.ready('page'), false);
});

test('content-ai-profiles: an error reply is failed, resolve throws and ready() is false', async (t) => {
  const warned = [];
  t.mock.method(console, 'warn', (...args) => warned.push(args));
  for (const reply of [{ error: 'boom' }, undefined, { profiles: 'nope' }, () => { throw new Error('gone'); }]) {
    const { ctx } = load({ reply });
    ctx.aiProfiles.init();
    await ctx.aiProfiles.whenReady();
    assert.equal(ctx.aiProfiles.status(), 'failed');
    assert.throws(() => ctx.aiProfiles.resolve('page'), /profiles are failed/, '坏了的镜像不拿空表假装「未配置」');
    assert.equal(ctx.aiProfiles.ready('page'), false);
  }
  // 失败在集合那一层被接住（settle([])），日志只在那一层打一次。
  assert.equal(warned.length, 4);
});

test('content-ai-profiles: pending until the reply, failed at the 1500 ms cap, ready and notified when the reply is late', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer;
  const late = new Promise((resolve) => { answer = resolve; });
  const { ctx } = load({ reply: () => late });
  let notified = 0;
  ctx.aiProfiles.subscribe(() => { notified += 1; });
  ctx.aiProfiles.init();
  let settled = false;
  ctx.aiProfiles.whenReady().then(() => { settled = true; });
  await tick();
  assert.equal(ctx.aiProfiles.status(), 'pending');
  assert.throws(() => ctx.aiProfiles.resolve('page'), /profiles are pending/);
  assert.equal(ctx.aiProfiles.ready('page'), false);

  t.mock.timers.tick(1499);
  await tick();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await tick();
  assert.equal(settled, true, '1500 ms 上限到了，whenReady 放行');
  assert.equal(ctx.aiProfiles.status(), 'failed');
  assert.equal(notified, 0);

  answer({ profiles: [profile('main', { default: true })] });
  await tick();
  assert.equal(ctx.aiProfiles.status(), 'ready', '晚到的回话照样翻成 ready');
  assert.equal(notified, 1, '并通知订阅者（缓存层据此换代）');
  assert.equal(ctx.aiProfiles.ready('page'), true);
});

test('content-ai-profiles: registers under aiProfile:, and a routed delta lands after the debounce without the key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { ctx } = load({ reply: { profiles: [profile('main', { default: true })] } });
  ctx.aiProfiles.init();
  ctx.aiProfiles.init();
  assert.deepEqual(ctx.syncMirrors.map((mirror) => mirror.prefix), [AIProfiles.KEY_PREFIX]);
  assert.equal(AIProfiles.KEY_PREFIX, 'aiProfile:');
  await ctx.aiProfiles.whenReady();
  let notified = 0;
  ctx.aiProfiles.subscribe(() => { notified += 1; });

  const rest = routeSyncMirrorsOf(ctx)({
    'aiProfile:second': {
      newValue: {
        v: 1, name: 'Second', provider: 'openai', apiEndpoint: ENDPOINT, apiKey: 'sk-never-in-page',
        modelName: 'gpt-4.1', features: ['hover'], default: false,
      },
    },
    targetLang: { newValue: 'ja' },
  });
  assert.deepEqual(Object.keys(rest), ['targetLang'], '配置档键被镜像收走，不落进设置');
  t.mock.timers.tick(149);
  assert.equal(ctx.aiProfiles.resolve('hover').profile.id, 'main');
  t.mock.timers.tick(1);
  const hover = ctx.aiProfiles.resolve('hover').profile;
  assert.equal(hover.id, 'second');
  assert.equal(hover.modelName, 'gpt-4.1');
  assert.equal(hover.keyMissing, false);
  assert.equal('apiKey' in hover, false, 'Key 不进页面');
  assert.equal(notified, 1);
});
