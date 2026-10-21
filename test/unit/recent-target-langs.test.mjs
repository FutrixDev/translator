// The recently used target languages and the menu's recent group; what they
// are and when they are written is described by their owner,
// ctx.rememberRecentTargetLang in content/content-language.js.
//
// This file loads shared/lang-tags.js, shared/target-lang.js,
// content/content-local-pref.js (which owns the read, the settled flag and
// following other tabs) and content/content-language.js into a vm context of
// its own, with a fake
// chrome.storage, rather than adding content-language.js to engine-harness.mjs:
// the harness's load list is one of the four that must not change.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const SOURCES = ['shared/lang-tags.js', 'shared/target-lang.js', 'content/content-local-pref.js', 'content/content-language.js']
  .map((rel) => [rel, repoFile(rel)]);

// Languages the fake built-in engine can translate into. fa is not one of them,
// so with the built-in engine selected fa carries the "AI only" tag.
const BUILTIN_TARGETS = new Set(['en', 'zh-CN', 'fr', 'de', 'ja', 'ko', 'ru', 'es']);

/**
 * A content-script world with content-language.js loaded.
 * `stored` is what chrome.storage.local holds when the script starts; the
 * initial read answers only when `answerRead()` is called, so a test can land
 * it before or after a click; `answerRead(error)` answers it the way a failed
 * read does, with chrome.runtime.lastError set for the callback. console.warn
 * calls are collected in `warns`.
 */
function load({ stored = {}, builtin = false } = {}) {
  const writes = [];
  const listeners = [];
  let pendingRead = null;
  const chrome = {
    runtime: { sendMessage() {}, lastError: undefined },
    storage: {
      local: {
        get(key, callback) { pendingRead = () => callback({ [key]: stored[key] }); },
        set(values) { writes.push(structuredClone(values)); return Promise.resolve(); },
      },
      onChanged: { addListener(fn) { listeners.push(fn); } },
    },
  };
  const ctx = {
    settings: { targetLang: 'zh-CN' },
    uiLanguage: () => 'en',
    t: (key) => ({ langAiOnly: 'AI only', langRecent: 'Recent', langAll: 'All languages', langFilter: 'Search languages', langNoMatch: 'No matching language' })[key] || key,
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    builtinTranslator: {
      isSelected: () => builtin,
      supportsTarget: (code) => BUILTIN_TARGETS.has(code),
    },
    isExtensionContextAvailable: () => true,
  };
  const warns = [];
  const sandbox = { chrome, console: { ...console, warn: (...args) => warns.push(args) }, Intl, structuredClone };
  sandbox.globalThis = sandbox;
  sandbox.window = { AI_TRANSLATOR_CONTENT: ctx };
  vm.createContext(sandbox);
  for (const [rel, source] of SOURCES) vm.runInContext(source, sandbox, { filename: rel });
  return {
    ctx,
    TargetLang: sandbox.TargetLang,
    writes,
    warns,
    answerRead: (error) => {
      chrome.runtime.lastError = error;
      try {
        pendingRead();
      } finally {
        chrome.runtime.lastError = undefined;
      }
    },
    change: (changes, namespace) => listeners.forEach((fn) => fn(changes, namespace)),
  };
}

// Arrays made inside the vm have the vm's Array.prototype, which strict deep
// equality tells apart from this realm's.
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Draws the menu into a stand-in root the way openMenu does; reuse `menu` to reopen. */
function draw(ctx, selected, menu = { dataset: {} }) {
  ctx.buildTargetLangMenu(menu, selected);
  return menu;
}

/**
 * The menu's top-level pieces, in order: group headers and items. The filter
 * input above them and the empty-state line below are left out (the filter's
 * journey is J-L2 in test/e2e/target-languages.spec.js).
 */
function pieces(html) {
  return [...html.matchAll(/<(div|button) class="(ai-translator-lang-(?:group|item)[^"]*)"([^>]*)>([^<]*)<\/\1>/g)].map((m) => ({
    kind: m[2].startsWith('ai-translator-lang-group') ? 'group' : 'item',
    selected: /\bis-selected\b/.test(m[2]),
    lang: /data-lang="([^"]+)"/.exec(m[3])?.[1],
    recent: /data-recent="1"/.test(m[3]),
    tag: /data-tag="([^"]+)"/.exec(m[3])?.[1],
    role: /role="([^"]+)"/.exec(m[3])?.[1],
    text: m[4],
  }));
}

test('with nothing remembered the recent group shows the current language and writes nothing', () => {
  for (const builtin of [false, true]) {
    const world = load({ builtin });
    world.answerRead();
    const values = plain(world.TargetLang.options('en').map((o) => o.value));
    for (const selected of ['fr', 'zh-CN', 'fa', 'pt-BR']) {
      const label = `builtin=${builtin} selected=${selected}`;
      const all = pieces(draw(world.ctx, selected).innerHTML);
      assert.equal(all.length, 1 + 1 + 1 + 76, label);
      assert.deepEqual(all.filter((p) => p.kind === 'group').map((p) => p.text), ['Recent', 'All languages'], label);
      assert.deepEqual([all[0].kind, all[2].kind], ['group', 'group'], label);
      // pt-BR is normalized to the list's pt, the way the trigger and the full list see it.
      assert.deepEqual([all[1].lang, all[1].recent, all[1].selected],
        [world.ctx.normalizeTargetLang(selected), true, true], label);
      assert.deepEqual(all.slice(3).map((p) => p.lang), values, `${label}: the full list is untouched`);
      assert.equal(all.slice(3).some((p) => p.recent), false, label);
    }
    assert.deepEqual(plain(world.ctx.recentTargetLangs()), [], 'drawing the preset does not remember it');
    assert.equal(world.writes.length, 0);
  }
});

test('remember moves the language to the front, dedupes, keeps five and writes storage', () => {
  const { ctx, writes, answerRead } = load();
  answerRead();
  for (const lang of ['de', 'ja', 'ko', 'ru', 'es', 'fr']) ctx.rememberRecentTargetLang(lang);
  assert.deepEqual(plain(ctx.recentTargetLangs()), ['fr', 'es', 'ru', 'ko', 'ja'], 'de fell off the end');
  ctx.rememberRecentTargetLang('ko');
  assert.deepEqual(plain(ctx.recentTargetLangs()), ['ko', 'fr', 'es', 'ru', 'ja'], 'a repeat moves, not duplicates');
  assert.equal(writes.length, 7);
  assert.deepEqual(writes.at(-1), { recentTargetLangs: ['ko', 'fr', 'es', 'ru', 'ja'] });
  ctx.recentTargetLangs().push('xx');
  assert.equal(ctx.recentTargetLangs().length, 5, 'callers get a copy');
});

test('remembering the language already in front writes nothing', () => {
  const { ctx, writes, answerRead } = load({ stored: { recentTargetLangs: ['ko', 'fr'] } });
  answerRead();
  ctx.rememberRecentTargetLang('ko');
  ctx.rememberRecentTargetLang('ko');
  assert.equal(writes.length, 0, 'the same list is not written again');
  ctx.rememberRecentTargetLang('fr');
  ctx.rememberRecentTargetLang('fr');
  assert.deepEqual(writes, [{ recentTargetLangs: ['fr', 'ko'] }]);
  ctx.rememberRecentTargetLang('');
  assert.equal(writes.length, 1, 'no language, nothing to remember');
});

test('a code is remembered in the form the language list uses', () => {
  const { ctx, writes, answerRead } = load({ stored: { recentTargetLangs: ['fr'] } });
  answerRead();
  ctx.rememberRecentTargetLang('pt-BR');
  ctx.rememberRecentTargetLang('FR');
  assert.deepEqual(writes, [{ recentTargetLangs: ['pt', 'fr'] }, { recentTargetLangs: ['fr', 'pt'] }]);
});

test('with recents: header, the recent items, header, then all 76', () => {
  const { ctx, TargetLang, answerRead } = load({ stored: { recentTargetLangs: ['de', 'fr'] } });
  answerRead();
  const all = pieces(draw(ctx, 'de').innerHTML);
  assert.equal(all.length, 1 + 2 + 1 + 76);
  assert.deepEqual(all.filter((p) => p.kind === 'group').map((p) => [p.text, p.role]),
    [['Recent', 'presentation'], ['All languages', 'presentation']]);
  assert.equal(all[0].kind, 'group');
  assert.equal(all[3].kind, 'group');
  assert.deepEqual(all.slice(1, 3).map((p) => [p.lang, p.recent]), [['de', true], ['fr', true]]);
  const full = all.slice(4);
  assert.equal(full.some((p) => p.recent), false, 'the full list carries no data-recent');
  assert.deepEqual(full.map((p) => p.lang), plain(TargetLang.options('en').map((o) => o.value)),
    'the full list is untouched, recents included');
  assert.deepEqual(all.filter((p) => p.selected).map((p) => [p.lang, p.recent]), [['de', true], ['de', false]],
    'both copies of the selected language are selected, recent first');
});

test('the menu root is reused, and a list cleared elsewhere redraws as the preset', () => {
  const { ctx, answerRead, change } = load({ stored: { recentTargetLangs: ['de', 'fr'] } });
  answerRead();
  const menu = draw(ctx, 'fr');
  assert.deepEqual(pieces(menu.innerHTML).filter((p) => p.recent).map((p) => p.lang), ['de', 'fr']);
  change({ recentTargetLangs: { newValue: [] } }, 'local');
  draw(ctx, 'fr', menu);
  const all = pieces(menu.innerHTML);
  assert.deepEqual(all.filter((p) => p.recent).map((p) => p.lang), ['fr'], 'another tab cleared the list');
  assert.equal(all.filter((p) => p.kind === 'group').length, 2);
  assert.deepEqual(Object.keys(menu.dataset), [], 'the root carries no mark of its own');
});

test('recent items get the AI-only tag the same way the full list does', () => {
  const { ctx, answerRead } = load({ builtin: true, stored: { recentTargetLangs: ['fa', 'fr'] } });
  answerRead();
  const recent = pieces(draw(ctx, 'fr').innerHTML).filter((p) => p.recent);
  assert.deepEqual(recent.map((p) => [p.lang, p.tag]), [['fa', 'AI only'], ['fr', undefined]]);
});

test('codes the list does not offer are not drawn', () => {
  const { ctx, answerRead } = load({ stored: { recentTargetLangs: ['xx-nope', 'fr', 42] } });
  answerRead();
  const recent = pieces(draw(ctx, 'en').innerHTML).filter((p) => p.recent);
  assert.deepEqual(recent.map((p) => p.lang), ['fr']);
});

test('a list of nothing but unknown codes shows the preset', () => {
  const { ctx, answerRead } = load({ stored: { recentTargetLangs: ['xx-nope', 42] } });
  answerRead();
  const recent = pieces(draw(ctx, 'en').innerHTML).filter((p) => p.recent);
  assert.deepEqual(recent.map((p) => [p.lang, p.selected]), [['en', true]]);
});

test('the stored list arrives from storage and follows other tabs, not the sync default', () => {
  const world = load({ stored: { recentTargetLangs: ['ja'] } });
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), [], 'nothing until the read lands');
  world.answerRead();
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), ['ja']);
  world.change({ recentTargetLangs: { newValue: ['ko', 'ja'] } }, 'local');
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), ['ko', 'ja'], 'another tab translated into ko');
  world.change({ targetLang: { newValue: 'en' } }, 'sync');
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), ['ko', 'ja'], 'a new default does not clear the habit');
  // The list lives in local storage only (one device's habit): a key of the same
  // name arriving in sync is someone else's, and is not followed.
  world.change({ recentTargetLangs: { newValue: ['de'] } }, 'sync');
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), ['ko', 'ja'], 'a sync key of the same name is ignored');
});

test('a failed read is warned about once, by key, and leaves the list empty', () => {
  const world = load({ stored: { recentTargetLangs: ['ja'] } });
  world.answerRead({ message: 'storage backend unavailable' });
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), []);
  assert.equal(world.warns.length, 1);
  assert.match(String(world.warns[0][0]), /reading recentTargetLangs failed/);
  assert.equal(world.warns[0][1], 'storage backend unavailable');
});

test('a dispatch before the read lands waits for it and builds on the stored list', () => {
  const world = load({ stored: { recentTargetLangs: ['ja', 'ko'] } });
  world.ctx.rememberRecentTargetLang('fr');
  world.ctx.rememberRecentTargetLang('de');
  assert.deepEqual(world.writes, [], 'nothing is written over a list not read yet');
  world.answerRead();
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), ['de', 'fr', 'ja', 'ko']);
  assert.deepEqual(world.writes, [
    { recentTargetLangs: ['fr', 'ja', 'ko'] },
    { recentTargetLangs: ['de', 'fr', 'ja', 'ko'] },
  ]);
});

test('once the read has landed a dispatch is written at once', () => {
  const world = load({ stored: { recentTargetLangs: ['ja'] } });
  world.answerRead();
  world.ctx.rememberRecentTargetLang('fr');
  assert.deepEqual(world.writes, [{ recentTargetLangs: ['fr', 'ja'] }]);
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), ['fr', 'ja']);
});

test('a failed read writes nothing over the stored list, before or after it fails', () => {
  const world = load({ stored: { recentTargetLangs: ['ja', 'ko'] } });
  world.ctx.rememberRecentTargetLang('fr');
  world.answerRead({ message: 'storage backend unavailable' });
  world.ctx.rememberRecentTargetLang('de');
  assert.deepEqual(world.writes, []);
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), []);
  assert.equal(world.warns.length, 1, 'the failure is logged once, where the updates are dropped');
  assert.match(String(world.warns[0][0]), /reading recentTargetLangs failed/);
  assert.equal(world.warns[0][1], 'storage backend unavailable');
  // Another tab's write tells this frame the stored list; from then on it is built on.
  world.change({ recentTargetLangs: { newValue: ['es'] } }, 'local');
  world.ctx.rememberRecentTargetLang('de');
  assert.deepEqual(world.writes, [{ recentTargetLangs: ['de', 'es'] }]);
});

test('another tab writing first settles the list, and the waiting dispatch builds on that', () => {
  const world = load({ stored: { recentTargetLangs: ['ja'] } });
  world.ctx.rememberRecentTargetLang('fr');
  world.change({ recentTargetLangs: { newValue: ['ko', 'ja'] } }, 'local');
  assert.deepEqual(world.writes, [{ recentTargetLangs: ['fr', 'ko', 'ja'] }]);
  world.answerRead();
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), ['fr', 'ko', 'ja'], 'the late read is ignored');
});
