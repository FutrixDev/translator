// Recently picked target languages float to the top of the in-page language
// menu (D-542, design ext-opt-input-translation §B.2). The list is read,
// remembered and rendered by content/content-language.js; the one place that
// writes it is the menu's click handler in content-popup.js.
//
// This file loads shared/lang-tags.js, shared/target-lang.js and
// content/content-language.js into a vm context of its own, with a fake
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
const SOURCES = ['shared/lang-tags.js', 'shared/target-lang.js', 'content/content-language.js']
  .map((rel) => [rel, repoFile(rel)]);

// Languages the fake built-in engine can translate into. fa is not one of them,
// so with the built-in engine selected fa carries the "AI only" tag.
const BUILTIN_TARGETS = new Set(['en', 'zh-CN', 'fr', 'de', 'ja', 'ko', 'ru', 'es']);

/**
 * A content-script world with content-language.js loaded.
 * `stored` is what chrome.storage.local holds when the script starts; the
 * initial read answers only when `answerRead()` is called, so a test can land
 * it before or after a click.
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
        set(values) { writes.push(structuredClone(values)); },
      },
      onChanged: { addListener(fn) { listeners.push(fn); } },
    },
  };
  const ctx = {
    settings: { targetLang: 'zh-CN' },
    uiLanguage: () => 'en',
    t: (key) => ({ langAiOnly: 'AI only', langRecent: 'Recent', langAll: 'All languages' })[key] || key,
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    builtinTranslator: {
      isSelected: () => builtin,
      supportsTarget: (code) => BUILTIN_TARGETS.has(code),
    },
    isExtensionContextAvailable: () => true,
  };
  const sandbox = { chrome, console, Intl, structuredClone };
  sandbox.globalThis = sandbox;
  sandbox.window = { AI_TRANSLATOR_CONTENT: ctx };
  vm.createContext(sandbox);
  for (const [rel, source] of SOURCES) vm.runInContext(source, sandbox, { filename: rel });
  return {
    ctx,
    TargetLang: sandbox.TargetLang,
    writes,
    answerRead: () => pendingRead(),
    change: (changes, namespace) => listeners.forEach((fn) => fn(changes, namespace)),
  };
}

// The menu as content-language.js drew it before D-542, verbatim. With nothing
// remembered the new code has to produce exactly this, byte for byte.
function menuBeforeRecents(ctx, TargetLang, selectedLang) {
  const normalized = ctx.normalizeTargetLang(selectedLang);
  const bt = ctx.builtinTranslator;
  const tagAiOnly = bt.isSelected(false);
  const aiOnlyTag = ctx.escapeHtml(ctx.t('langAiOnly'));
  return TargetLang.options(ctx.uiLanguage()).map((option) => {
    const isSelected = option.value === normalized ? ' is-selected' : '';
    const tag = tagAiOnly && !bt.supportsTarget(option.value)
      ? ` data-tag="${aiOnlyTag}"`
      : '';
    return `<button class="ai-translator-lang-item${isSelected}" type="button" data-lang="${option.value}"${tag}>${ctx.escapeHtml(option.label)}</button>`;
  }).join('');
}

// Arrays made inside the vm have the vm's Array.prototype, which strict deep
// equality tells apart from this realm's.
const plain = (value) => JSON.parse(JSON.stringify(value));

/** The menu's top-level pieces, in order: group headers and items. */
function pieces(html) {
  return [...html.matchAll(/<(div|button) class="([^"]+)"([^>]*)>([^<]*)<\/\1>/g)].map((m) => ({
    kind: m[2].startsWith('ai-translator-lang-group') ? 'group' : 'item',
    selected: /\bis-selected\b/.test(m[2]),
    lang: /data-lang="([^"]+)"/.exec(m[3])?.[1],
    recent: /data-recent="1"/.test(m[3]),
    tag: /data-tag="([^"]+)"/.exec(m[3])?.[1],
    role: /role="([^"]+)"/.exec(m[3])?.[1],
    text: m[4],
  }));
}

test('with nothing remembered the menu is byte-identical to the flat list', () => {
  for (const builtin of [false, true]) {
    const world = load({ builtin });
    world.answerRead();
    for (const selected of ['fr', 'zh-CN', 'fa', 'pt-BR', '']) {
      assert.equal(world.ctx.buildTargetLangMenu(selected),
        menuBeforeRecents(world.ctx, world.TargetLang, selected),
        `builtin=${builtin} selected=${selected || '(empty)'}`);
    }
  }
});

test('remember moves the pick to the front, dedupes, keeps five and writes storage', () => {
  const { ctx, writes } = load();
  for (const lang of ['de', 'ja', 'ko', 'ru', 'es', 'fr']) ctx.rememberRecentTargetLang(lang);
  assert.deepEqual(plain(ctx.recentTargetLangs()), ['fr', 'es', 'ru', 'ko', 'ja'], 'de fell off the end');
  ctx.rememberRecentTargetLang('ko');
  assert.deepEqual(plain(ctx.recentTargetLangs()), ['ko', 'fr', 'es', 'ru', 'ja'], 'a repeat moves, not duplicates');
  assert.equal(writes.length, 7);
  assert.deepEqual(writes.at(-1), { recentTargetLangs: ['ko', 'fr', 'es', 'ru', 'ja'] });
  ctx.recentTargetLangs().push('xx');
  assert.equal(ctx.recentTargetLangs().length, 5, 'callers get a copy');
});

test('with recents: header, the recent items, header, then all 76', () => {
  const { ctx, TargetLang, answerRead } = load({ stored: { recentTargetLangs: ['de', 'fr'] } });
  answerRead();
  const all = pieces(ctx.buildTargetLangMenu('de'));
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

test('recent items get the AI-only tag the same way the full list does', () => {
  const { ctx, answerRead } = load({ builtin: true, stored: { recentTargetLangs: ['fa', 'fr'] } });
  answerRead();
  const recent = pieces(ctx.buildTargetLangMenu('fr')).filter((p) => p.recent);
  assert.deepEqual(recent.map((p) => [p.lang, p.tag]), [['fa', 'AI only'], ['fr', undefined]]);
});

test('codes the list does not offer are not drawn', () => {
  const { ctx, answerRead } = load({ stored: { recentTargetLangs: ['xx-nope', 'fr', 42] } });
  answerRead();
  const recent = pieces(ctx.buildTargetLangMenu('en')).filter((p) => p.recent);
  assert.deepEqual(recent.map((p) => p.lang), ['fr']);
});

test('the stored list arrives from storage and follows other tabs, not the sync default', () => {
  const world = load({ stored: { recentTargetLangs: ['ja'] } });
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), [], 'nothing until the read lands');
  world.answerRead();
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), ['ja']);
  world.change({ recentTargetLangs: { newValue: ['ko', 'ja'] } }, 'local');
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), ['ko', 'ja'], 'another tab picked ko');
  world.change({ targetLang: { newValue: 'en' } }, 'sync');
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), ['ko', 'ja'], 'a new default does not clear the habit');
});

test('a read that lands after a pick does not put the old list back', () => {
  const world = load({ stored: { recentTargetLangs: ['ja'] } });
  world.ctx.rememberRecentTargetLang('fr');
  world.answerRead();
  assert.deepEqual(plain(world.ctx.recentTargetLangs()), ['fr']);
});
