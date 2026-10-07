// What may wake a page whose auto session stopped on an error (D-497 R1-N3, M7).
//
// A page pass that ended on a whole-pass failure (a Blab account error, say)
// leaves the auto session broken: status ERROR, discovery stopped. Only a word
// about this page restarts it: a changed setting in RESTART_KEYS, a language
// pack that just landed, or the user asking for this page again
// (markPageExplicit). A site rule or an AI profile changed, usually in another
// tab, is not about this page's failure, and restarting there would translate
// the page with another engine behind the user's back.
//
// The real content/content-auto-translate.js runs in a vm, with discovery and
// the translation pass stubbed out.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { repoSource } from './helpers/sources.mjs';

function load() {
  const triggers = {};
  let discoveries = 0;
  const ctx = {
    frameRole: 'top',
    state: { isTranslatingPage: false, translationsVisible: true },
    settings: { autoTranslate: true, siteRules: {}, autoAiDailyBudget: 0 },
    t: (key) => key,
    customRules: { isCatchingUp: () => false, onChange(fn) { triggers.customRule = fn; } },
    aiProfiles: { subscribe(fn) { triggers.aiProfiles = fn; return () => {}; } },
    onLanguagePackReady(fn) { triggers.languagePack = fn; },
    failedBlocks: { isMarked: () => false, mark() {} },
    readSourceText: (el) => el.text,
    builtinTranslator: { effectiveEngine: async () => 'builtin' },
    filterBlocksByLanguage: async (blocks) => blocks,
    runTranslationPass: () => new Promise(() => {}),
    setupAutoDiscovery() {
      discoveries += 1;
      return { rescan() {}, stop() {}, suspend() {}, resume() {} };
    },
  };
  const sandbox = {
    console,
    queueMicrotask,
    URL,
    location: { href: 'https://example.com/a', hostname: 'example.com', pathname: '/a' },
    addEventListener() {},
    removeEventListener() {},
    document: { body: {}, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame() {},
    SiteRules: { decide: () => ({ verdict: 'auto', reason: 'BUILTIN_ALWAYS', refused: false }) },
    AutoStats: { add() {}, read: async () => ({}), budgetExceeded: () => false },
    AI_TRANSLATOR_CONTENT: ctx,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ['shared/spa-navigation.js', 'shared/block-identity.js', 'shared/session-guard.js',
    'content/content-auto-translate.js']) {
    vm.runInContext(repoSource(rel), sandbox, { filename: rel });
  }
  const auto = ctx.setupAutoTranslate();
  return { auto, triggers, discoveries: () => discoveries };
}

// The page as a failed Blab pass leaves it: the auto session stopped on ERROR.
function broken() {
  const s = load();
  assert.equal(s.auto.state().status, 'idle', 'the page started on auto');
  assert.equal(s.discoveries(), 1);
  s.auto.stopForPassFailure('blabPlanRequired');
  assert.equal(s.auto.state().status, 'error');
  return s;
}

test('R1-N3: a site rule or an AI profile changed elsewhere does not wake a broken page', () => {
  const s = broken();
  s.triggers.customRule();
  assert.equal(s.auto.state().status, 'error', 'a rule change left the stop in place');
  assert.equal(s.auto.state().error, 'blabPlanRequired', 'and the reason with it');
  s.triggers.aiProfiles();
  assert.equal(s.auto.state().status, 'error', 'a profile change left the stop in place');
  assert.equal(s.discoveries(), 1, 'nothing started looking for blocks again');
});

test('R1-N3: on a page that did not fail, a rule or profile change restarts as before', () => {
  const s = load();
  const before = s.auto.state().sessionVersion;
  s.triggers.customRule();
  assert.equal(s.auto.state().status, 'idle');
  s.triggers.aiProfiles();
  assert.equal(s.auto.state().status, 'idle');
  // start() throws the old session away each time.
  assert.equal(s.auto.state().sessionVersion, before + 2);
});

test('R1-N3: a setting in RESTART_KEYS still wakes a broken page', () => {
  const s = broken();
  s.auto.onSettingsChanged({ autoTranslateEngine: { newValue: 'builtin' } });
  assert.equal(s.auto.state().status, 'idle');
  assert.equal(s.auto.state().error, null);
  assert.equal(s.discoveries(), 2, 'it looks for blocks again');
});

test('R1-N3: a language pack that just landed still wakes a broken page', () => {
  const s = broken();
  s.triggers.languagePack();
  assert.equal(s.auto.state().status, 'idle');
  assert.equal(s.discoveries(), 2);
});

test('M7: the user asking for this page again wakes a broken page', () => {
  // He asked for this page (translate page), that pass failed on his account,
  // he fixed it and asks again.
  const s = load();
  s.auto.markPageExplicit();
  s.auto.stopForPassFailure('blabPlanRequired');
  assert.equal(s.auto.state().status, 'error');
  const looked = s.discoveries();
  s.auto.markPageExplicit();
  assert.equal(s.auto.state().status, 'idle');
  assert.equal(s.auto.state().error, null);
  assert.equal(s.discoveries(), looked + 1, 'it looks for blocks again');
});
