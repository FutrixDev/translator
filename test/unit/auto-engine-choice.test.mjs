// 自动模式走哪个引擎（PRD FR-9），在真的引擎上问，不是在源码上问。
//
// 这一份是为一个已经发生过的回归立的桩：费用闸拿**手动**那张开关
// （translationEngine）去回答**自动**那一边的问题，于是一个为了划词翻译把引擎
// 切到 AI 的用户，此后每一页的自动翻译都被拦在 COST_ENGINE 上 —— 满屏原文，
// 状态点上写着一句他看不懂的话，而他从没关过任何东西。
//
// 源码断言拦不住这一类：两处都写着 `!== 'ai'`，读上去一模一样，错的是问的是
// 哪一张表。所以这里把引擎装起来，真的发一次请求，看它落在谁手里。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const PAGE = 'This page is written in ordinary English prose, long enough for the detector to be sure about it.'.repeat(6);
const BLOCK = 'A paragraph of ordinary English prose, long enough that the engine asks the detector itself.';

const { ctx, translateCalls, sentToAI } = await installEngineHarness({ pageText: PAGE });

// 预算那一格的替身。真账本在 auto-stats.test.mjs 里验，这里只关心「有没有走到
// 它面前」，以及它说不的时候请求是不是真的没发出去。
const charged = [];
let allow = true;
globalThis.AutoStats = {
  textsChars: (texts) => texts.reduce((sum, text) => sum + String(text || '').length, 0),
  charge: async (chars, budget) => {
    charged.push({ chars, budget });
    return { allowed: allow };
  }
};

function configure(patch) {
  Object.assign(ctx.settings, {
    translationEngine: 'builtin',
    autoTranslateEngine: 'builtin',
    engineFallback: 'local-only',
    autoAiDailyBudget: 200000
  }, patch);
  translateCalls.length = 0;
  sentToAI.length = 0;
  charged.length = 0;
  allow = true;
}

const translate = (extra) => ctx.requestTranslation({
  type: 'TRANSLATE', text: BLOCK, targetLang: 'zh-CN', mode: 'text', ...extra
});

test('手动那边选了 AI，自动这边照样走免费的内置引擎', async () => {
  // 回归本体。两张开关是两件事：他选 AI 是为了自己点出来的那几次翻译，而自动
  // 模式默认开着，凭的就是它不花钱。
  configure({ translationEngine: 'ai' });

  assert.equal(await ctx.builtinTranslator.effectiveEngine({ auto: true }), 'builtin');
  assert.equal(await ctx.builtinTranslator.effectiveEngine(), 'ai', '手动那一边不该被自动的开关改掉');

  const result = await translate({ auto: true });
  assert.equal(translateCalls.length, 1, '自动请求没走内置引擎');
  assert.equal(sentToAI.length, 0, '自动请求跑去花钱了');
  assert.equal(charged.length, 0, '走内置的那一趟不该记额度');
  assert.match(result.translation, /^builtin\(/);
});

test('同一份设置下，手动请求还是走 AI', async () => {
  configure({ translationEngine: 'ai' });

  const result = await translate({});
  assert.equal(sentToAI.length, 1, '手动请求被自动那张开关按回内置了');
  assert.equal(translateCalls.length, 0);
  assert.equal(charged.length, 0, '手动翻译不过预算闸');
  assert.equal(result.translation, `AI:${BLOCK}`);
});

test('自动模式自己选了 AI，才花钱，而且过预算闸', async () => {
  configure({ autoTranslateEngine: 'ai' });

  assert.equal(await ctx.builtinTranslator.effectiveEngine({ auto: true }), 'ai');
  await translate({ auto: true });
  assert.equal(sentToAI.length, 1);
  assert.equal(charged.length, 1, '花了钱却没记账');
  assert.equal(charged[0].chars, BLOCK.length);
  assert.equal(charged[0].budget, 200000);
});

test('额度用完了就拒，而且是在发出去之前拒', async () => {
  configure({ autoTranslateEngine: 'ai' });
  allow = false;

  const result = await translate({ auto: true });
  assert.equal(sentToAI.length, 0, '额度说不了，请求还是发出去了');
  assert.ok(result.error, '被拒了却没给出一句话');
});

test('内置引擎给不出译文、又没开回退：自动模式判 none，不是 ai', async () => {
  // FR-9.1 的那一格。判 'ai' 的后果是一批批撞在下游的错误上，攒够三次以一句
  // 「翻译失败」收场；判 'none' 调度层才说得出「你选的是仅本地引擎」。
  configure({ translationEngine: 'ai' });
  const realIsSecure = globalThis.self.isSecureContext;
  globalThis.self.isSecureContext = false; // http:// 页面上内置 API 压根不存在
  try {
    assert.equal(await ctx.builtinTranslator.effectiveEngine({ auto: true }), 'none');
    ctx.settings.engineFallback = 'allow-ai';
    assert.equal(await ctx.builtinTranslator.effectiveEngine({ auto: true }), 'none',
      '没有 API Key 时，开了回退也回退不到哪里去');
  } finally {
    globalThis.self.isSecureContext = realIsSecure;
  }
});

// 上面那五条验的是引擎自己答得对。这一条验的是**别人问得对** —— 同一个回归可以
// 在任何一个漏掉 auto 的调用点上原样重来，而那几个调用点的症状一个比一个隐蔽：
// 攒批攒错了形状不会红，只是慢；缓存写错了边不会红，只是串味和计费。
test('凡是问「这一轮跑在内置引擎上吗」的地方，都把 auto 一起问了', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = new URL('../../content/', import.meta.url);

  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.js')) files.push(next);
    }
  };
  walk(root);
  assert.ok(files.length >= 20, `只扫到 ${files.length} 个文件，走目录那段该修了`);

  // 空括号就是漏掉的那一下：isActive() / isSelected() 不带参数问的永远是手动那
  // 一边。调用方手上有没有 auto 是另一回事 —— 没有的（划词、悬停、字幕）要写成
  // isActive(false) 说出来，因为「这条路本来就没有自动的一半」和「忘了传」在源码
  // 上长得一模一样，而后者不会红。
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/builtinTranslator\.(isActive|isSelected)\(\s*\)/g)) {
      offenders.push(`${fileURLToPath(file).split('/content/')[1]}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `这几处问的是手动那一边，可它们两边的流量都经手：\n  ${offenders.join('\n  ')}`);
});
