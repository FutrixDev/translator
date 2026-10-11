// 同一个词在输入框对话框里查，答案有没有词典条目（音标、例句），全看这一次
// 请求被路由到哪个引擎：内置引擎只回 {translation}，只有模型引擎的 word 模式
// 回答带 entry（D-479）。而路由每次请求都重算——设置、站点规则、指名、以及
// engineFallback 为 allow-ai 时内置的各种失败——于是同一个人同一个词，这一站
// 有词典、那一站没有（design ext-opt-input-translation §A.2 成因 1）。
//
// 这张表就是那份研究里 scratchpad/route.mjs 的十个用例，原样进单测：它是对话框
// 「内置引擎不给词典，改用 AI」说明行的前提——说明行只在引擎为 builtin 时出现，
// 所以哪些条件落在 builtin、哪些落在 AI 必须钉住。修复不自动改走 AI（那是花用户
// 的钱），表里每一行的引擎都和今天一样。
//
// 错误分支要 ctx.languageName（content-language.js）和 EngineStatus
// （shared/engine-status.js），engine-harness 不装这两样；这里像
// engine-target-unsupported / engine-pin 那样装真文件，不塞替身。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEngineHarness } from './helpers/engine-harness.mjs';

const PAGE = 'Every day I run along the river before the town wakes up. '.repeat(3);

const harness = await installEngineHarness({ pageText: PAGE });
const { ctx, sentToAI, translateCalls } = harness;
ctx.uiLanguage = () => 'en';
await import('../../shared/engine-status.js');
// content-language.js 加载时经 ctx.localPref 建「最近使用」，manifest 里它排在前面。
await import('../../content/content-local-pref.js');
await import('../../content/content-language.js');

// 服务工作者的替身：模型的 word 模式回答带条目，和真处理器一样；text 模式只有译文。
globalThis.chrome.runtime.sendMessage = async (message) => {
  if (message.type === 'COMIC_ACCOUNT') return { ok: true, data: { signedIn: false } };
  sentToAI.push(message);
  const translation = `AI:${message.text}`;
  return message.mode === 'word'
    ? { translation, entry: { translation, phonetics: [{ label: '', ipa: 'rʌn' }] } }
    : { translation };
};
harness.setApiKey('sk-test');

const realTranslator = globalThis.self.Translator;
const realAvailability = realTranslator.availability;

function configure({ engine = 'builtin', fallback = 'local-only', secure = true, pack = 'available',
  activation = true, sitePin = null } = {}) {
  Object.assign(ctx.settings, { translationEngine: engine, engineFallback: fallback });
  globalThis.self.isSecureContext = secure;
  realTranslator.availability = pack === 'available' ? realAvailability : async () => pack;
  globalThis.navigator.userActivation.isActive = activation;
  ctx.customRules.engineOverride = () => sitePin;
  sentToAI.length = 0;
  translateCalls.length = 0;
}

const lookUp = (text, targetLang, extra = {}) => ctx.requestTranslation({
  type: 'TRANSLATE', feature: 'input', text, targetLang, mode: 'word', standaloneText: true, ...extra,
});

// [#, 条件, configure, 词, 目标语, 指名, 走到的引擎, 有词典, 错误键]
const ROUTES = [
  [1, 'builtin, https, en->zh', {}, 'run', 'zh-CN', undefined, 'builtin', false, undefined],
  [2, 'builtin, zh->zh echoes the source', {}, '跑步', 'zh-CN', undefined, 'builtin', false, undefined],
  [3, 'builtin, en->sw (no built-in sw), allow-ai', { fallback: 'allow-ai' }, 'run', 'sw', undefined, 'ai', true, undefined],
  [4, 'builtin, en->sw, local-only', {}, 'run', 'sw', undefined, 'builtin', false, 'builtinTargetUnsupportedLocalOnly'],
  [5, 'builtin, http page, local-only', { secure: false }, 'run', 'zh-CN', undefined, 'builtin', false, 'builtinUnsupportedEnv'],
  [6, 'builtin, http page, allow-ai', { secure: false, fallback: 'allow-ai' }, 'run', 'zh-CN', undefined, 'ai', true, undefined],
  [7, 'builtin, pack not downloaded, no activation, allow-ai',
    { pack: 'downloadable', activation: false, fallback: 'allow-ai' }, 'run', 'ja', undefined, 'ai', true, undefined],
  [8, 'builtin, pack not downloaded, no activation, local-only',
    { pack: 'downloadable', activation: false }, 'run', 'ja', undefined, 'builtin', false, 'builtinNeedsDownload'],
  [9, 'settings ai', { engine: 'ai' }, 'run', 'zh-CN', undefined, 'ai', true, undefined],
  [10, 'settings ai, request pins builtin', { engine: 'ai' }, 'run', 'zh-CN', 'builtin', 'builtin', false, undefined],
];

for (const [n, label, setup, text, targetLang, engine, wantEngine, wantEntry, wantError] of ROUTES) {
  test(`route ${n}: ${label} -> ${wantEngine}${wantEntry ? ' with an entry' : ', no entry'}`, async () => {
    configure(setup);
    const result = await lookUp(text, targetLang, engine ? { engine } : {});
    assert.equal(result.engine, wantEngine);
    assert.equal(Boolean(result.entry), wantEntry);
    assert.equal(result.error, wantError);
    assert.equal(sentToAI.length, wantEngine === 'ai' && !wantError ? 1 : 0, 'model calls');
    if (wantEngine === 'builtin' && !wantError) assert.ok(result.translation, 'the built-in engine answered');
    if (n === 2) {
      assert.equal(result.translation, '跑步', 'same language: the source comes back as is');
      assert.equal(translateCalls.length, 0, 'same language never reaches the built-in translator');
    }
  });
}

// 表外一行：站点规则钉住内置，和指名一样压过设置里的 AI。
test('a site rule pinning builtin outranks settings ai, and no entry comes back', async () => {
  configure({ engine: 'ai', sitePin: 'builtin' });
  const result = await lookUp('run', 'zh-CN');
  assert.equal(result.engine, 'builtin');
  assert.equal(Boolean(result.entry), false);
  assert.equal(sentToAI.length, 0);
});
