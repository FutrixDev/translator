// Translation styles and the bilingual / translation-only switch (P0-C).
//
// A style is one attribute on <html> plus one rule in content/css/translation.css,
// and the set of styles is one list, shared/translation-display.js (STYLES). What
// a browser cannot tell us until a user sees it, this file pins down:
//
//   - the list and the stylesheet name the same styles, in both directions;
//   - no style reflows the page (a property whitelist, and never `margin`);
//   - every selector has the shape P1 relies on to carry it into shadow roots;
//   - the new files load before whatever reads them, in every load list;
//   - the Alt+T command is declared, named in every locale, and does what the
//     other three switches do: write `showTranslationOnly`, nothing else.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { messageCatalog } from './helpers/sources.mjs';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const repoDir = (rel) => readdirSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)));

// background/settings.js reads chrome.i18n and globalThis.OCRCore at the top
// level, and background/commands.js imports it. storage and tabs are read at
// call time, so each test below swaps them in.
globalThis.chrome = { i18n: { getUILanguage: () => 'en' } };

await import('../../shared/translation-display.js');
await import('../../shared/default-settings.js');
await import('../../shared/ocr.js');
const Display = globalThis.TranslationDisplay;
const { defaultSettings: workerDefaults } = await import('../../background/settings.js');
const { runCommand } = await import('../../background/commands.js');

const STYLE_ATTR = 'data-ai-translator-style';
const ONLY_ATTR = 'data-ai-translator-only';
const PAGE_ONLY_NOTS = [
  ':not(.ai-translator-selection-translation)',
  ':not(.ai-translator-hover-translation)',
];

/** Split on top-level occurrences of `separator`, so `:not(a, b)` and `[x="a b"]` stay whole. */
function splitTopLevel(text, isSeparator) {
  const out = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const character of text) {
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(' || character === '[') {
      depth += 1;
    } else if (character === ')' || character === ']') {
      depth -= 1;
    } else if (depth === 0 && isSeparator(character)) {
      out.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  out.push(current);
  return out;
}

/**
 * Every rule in a stylesheet as { selectors, declarations }, comments stripped.
 * At-rule headers (`@media … {`) are not rules; the rules inside them are.
 */
function rulesOf(css) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, head, body]) => ({ head: head.trim(), body }))
    .filter(({ head }) => head && !head.startsWith('@'))
    .map(({ head, body }) => ({
      selectors: splitTopLevel(head, (c) => c === ',').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean),
      declarations: body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
        const colon = d.indexOf(':');
        return { property: d.slice(0, colon).trim(), value: d.slice(colon + 1).trim() };
      }),
    }));
}

const TRANSLATION_CSS = repoFile('content/css/translation.css');
const mentionsDisplayAttr = (selector) => selector.includes(STYLE_ATTR) || selector.includes(ONLY_ATTR);
const STYLE_RULES = rulesOf(TRANSLATION_CSS).filter((rule) => rule.selectors.some(mentionsDisplayAttr));
const styleOf = (selector) => (selector.match(new RegExp(`${STYLE_ATTR}="([^"]+)"`)) || [])[1];

// ---------------------------------------------------------------- 1. the list

test('STYLES is the six styles, default first, and unknown values read as the default', () => {
  assert.deepEqual([...Display.STYLES], ['default', 'underline', 'dashed', 'highlight', 'quote', 'blur']);
  assert.equal(Display.DEFAULT_STYLE, 'default');
  assert.ok(Object.isFrozen(Display) && Object.isFrozen(Display.STYLES));
  for (const style of Display.STYLES) assert.equal(Display.normalizeStyle(style), style);
  // A value from another build, a typo in synced storage, or nothing at all.
  for (const junk of ['sparkle', 'Underline', '', undefined, null, 0, {}]) {
    assert.equal(Display.normalizeStyle(junk), 'default', `normalizeStyle(${JSON.stringify(junk)})`);
  }
});

test('applyStyleAttribute puts the style on <html>, and default means no attribute', () => {
  assert.equal(Display.STYLE_ATTR, STYLE_ATTR);
  const attrs = new Map();
  const doc = {
    documentElement: {
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: (name) => attrs.delete(name),
    },
  };
  Display.applyStyleAttribute(doc, 'quote');
  assert.equal(attrs.get(STYLE_ATTR), 'quote');
  Display.applyStyleAttribute(doc, 'default');
  assert.equal(attrs.has(STYLE_ATTR), false);
  Display.applyStyleAttribute(doc, 'blur');
  Display.applyStyleAttribute(doc, 'sparkle');
  assert.equal(attrs.has(STYLE_ATTR), false, 'an unknown style reads as the default');
});

test('every style has a name in all ten UI languages', () => {
  const catalog = messageCatalog();
  const keys = Display.STYLES.map((style) => Display.styleLabelKey(style));
  assert.equal(Display.styleLabelKey('underline'), 'translationStyleUnderline');
  assert.equal(Display.styleLabelKey('sparkle'), 'translationStyleDefault');
  for (const [lang, table] of Object.entries(catalog)) {
    for (const key of [...keys, 'showBilingual', 'showTranslationOnly', 'sourcePeekLabel']) {
      assert.ok(typeof table[key] === 'string' && table[key].trim(), `${lang} has no ${key}`);
    }
  }
  assert.equal(Object.keys(catalog).length, 10);
});

// ------------------------------------------------------- 2. CSS <-> STYLES

test('the stylesheet and STYLES name the same styles, in both directions', () => {
  const inCss = new Set(STYLE_RULES.flatMap((rule) => rule.selectors.map(styleOf)).filter(Boolean));
  const expected = Display.STYLES.filter((style) => style !== Display.DEFAULT_STYLE);
  for (const style of expected) assert.ok(inCss.has(style), `STYLES has "${style}" but translation.css has no rule for it`);
  for (const style of inCss) assert.ok(expected.includes(style), `translation.css styles "${style}", which STYLES does not list`);
  // default is "no attribute": display.js removes it, so a rule for it would never match.
  assert.ok(!inCss.has('default'));
  assert.ok(STYLE_RULES.length >= expected.length, 'no style rules found; the parser no longer reads translation.css');
});

test('every style rule is for page translations only', () => {
  for (const rule of STYLE_RULES) {
    for (const selector of rule.selectors.filter((s) => s.includes(STYLE_ATTR))) {
      for (const not of PAGE_ONLY_NOTS) {
        assert.ok(selector.includes(not), `${selector}\n  is missing ${not}: hover and selection translations share the class`);
      }
    }
  }
});

test('only translation.css styles by these attributes, so its shape rules cover all of them', () => {
  // The options page loads translation.css for its preview, and P1 injects it
  // into shadow roots; a style rule elsewhere would escape both.
  for (const dir of ['content/css', 'options/css', 'popup']) {
    for (const name of repoDir(dir).filter((n) => n.endsWith('.css'))) {
      const rel = `${dir}/${name}`;
      if (rel === 'content/css/translation.css') continue;
      assert.ok(!repoFile(rel).includes(STYLE_ATTR), `${rel} styles by ${STYLE_ATTR}`);
    }
  }
});

/** The body of each `@media <query> { … }` block, and the stylesheet with those blocks cut out. */
function splitMediaBlocks(css, query) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const header = `@media ${query}`;
  const inside = [];
  let outside = '';
  let from = 0;
  for (let at = bare.indexOf(header); at !== -1; at = bare.indexOf(header, from)) {
    outside += bare.slice(from, at);
    const open = bare.indexOf('{', at);
    let depth = 1;
    let i = open + 1;
    for (; depth > 0; i += 1) {
      if (bare[i] === '{') depth += 1;
      else if (bare[i] === '}') depth -= 1;
    }
    inside.push(bare.slice(open + 1, i - 1));
    from = i;
  }
  outside += bare.slice(from);
  return { inside: inside.join('\n'), outside };
}

test('blur is revealed by hover only where the pointer can hover', () => {
  // A tap leaves the element :hover (touch sticky hover), so on a touch-only
  // device a hover rule would keep a translation revealed after the second
  // tap had taken .ai-translator-revealed away. Touch goes through the class.
  const { inside, outside } = splitMediaBlocks(TRANSLATION_CSS, '(hover: hover)');
  const hoverSelectors = (css) => rulesOf(css).flatMap((rule) => rule.selectors)
    .filter((selector) => selector.includes(STYLE_ATTR) && /:hover(?![\w-])/.test(selector));
  assert.deepEqual(hoverSelectors(outside), [], 'a style rule reveals on :hover outside @media (hover: hover)');
  assert.ok(hoverSelectors(inside).some((selector) => styleOf(selector) === 'blur'),
    'the blur hover reveal is gone from @media (hover: hover)');
});

// ------------------------------------------------------- 3. nothing reflows

const PAINT_ONLY = [
  /^text-decoration(-[a-z-]+)?$/,
  /^text-underline-offset$/,
  /^outline(-[a-z-]+)?$/,
  /^box-shadow$/,
  /^background-color$/,
  /^border-radius$/,
  /^filter$/,
  /^transition$/,
  /^cursor$/,
];
// quote draws its bar on the translation's own start side, and alone may take space for it.
const QUOTE_EXTRAS = [/^border-inline-start(-[a-z]+)?$/, /^padding-inline-start$/];

test('every style rule uses only properties that take no space, and never margin', () => {
  for (const rule of STYLE_RULES) {
    const styles = new Set(rule.selectors.map(styleOf));
    const allowed = styles.has('quote') && styles.size === 1 ? [...PAINT_ONLY, ...QUOTE_EXTRAS] : PAINT_ONLY;
    for (const { property, value } of rule.declarations) {
      assert.ok(!/margin/.test(property), `${rule.selectors[0]} sets ${property}: pages centre blocks with margin-inline:auto`);
      assert.ok(allowed.some((re) => re.test(property)), `${rule.selectors[0]} sets ${property}, which reflows the page`);
      // (0,4,1) alone loses to the base rule's background:none / border:none / padding:0.
      assert.match(value, /!important$/, `${rule.selectors[0]} { ${property} } is not !important`);
    }
  }
});

test('the whitelist check really reads declarations', () => {
  const quote = STYLE_RULES.find((rule) => rule.selectors.some((s) => styleOf(s) === 'quote'));
  assert.ok(quote, 'no quote rule found');
  assert.deepEqual(quote.declarations.map((d) => d.property).sort(), ['border-inline-start', 'padding-inline-start']);
});

// ------------------------------------------------------- 8. selector shape

/**
 * The contract with P1-A (design §9.1-1): exactly one leading `html` compound
 * carrying the attributes, a descendant combinator, and no `html` / `body`
 * anywhere after it. P1 can then rewrite the leading compound to
 * `:host-context(html…)` mechanically.
 */
function shapeProblem(selector) {
  const parts = splitTopLevel(selector, (c) => c === ' ');
  const [lead, ...rest] = parts.filter(Boolean);
  if (!/^html(?=[[:]|$)/.test(lead)) return 'does not start with an html compound';
  if (rest.length === 0) return 'has no descendant after the html compound';
  if (['>', '+', '~'].includes(rest[0])) return `joins the html compound with "${rest[0]}", not a descendant combinator`;
  if (/(^|[^\w-])body(?![\w-])/.test(lead.replace(/\[[^\]]*\]/g, ''))) return 'names body in the leading compound';
  const tail = rest.join(' ').replace(/\[[^\]]*\]/g, '');
  if (/(^|[^\w-])(html|body)(?![\w-])/.test(tail)) return 'names html or body after the leading compound';
  for (const attr of [STYLE_ATTR, ONLY_ATTR]) {
    if (rest.join(' ').includes(attr)) return `puts ${attr} outside the leading compound`;
  }
  return null;
}

test('every selector on the display attributes has the one shape P1 can carry into shadow roots', () => {
  const selectors = STYLE_RULES.flatMap((rule) => rule.selectors).filter(mentionsDisplayAttr);
  assert.ok(selectors.length >= 7, `only ${selectors.length} selectors found`);
  for (const selector of selectors) {
    assert.equal(shapeProblem(selector), null, `${selector}\n  ${shapeProblem(selector)}`);
  }
});

test('the shape check fails the two mutations it exists for', () => {
  const good = `html[${STYLE_ATTR}="underline"] .ai-translator-inline-block${PAGE_ONLY_NOTS.join('')}`;
  assert.equal(shapeProblem(good), null);
  assert.equal(shapeProblem(`html[${STYLE_ATTR}="blur"]:not([${ONLY_ATTR}]) .ai-translator-inline-block:not(a)`), null);
  assert.ok(shapeProblem(`html body[${STYLE_ATTR}="underline"] .ai-translator-inline-block`));
  assert.ok(shapeProblem(`.x html[${STYLE_ATTR}="underline"] .ai-translator-inline-block`));
  assert.ok(shapeProblem(`html[${STYLE_ATTR}="underline"] body .ai-translator-inline-block`));
  assert.ok(shapeProblem(`html[${STYLE_ATTR}="underline"] > .ai-translator-inline-block`));
  assert.ok(shapeProblem(`html .ai-translator-inline-block[${STYLE_ATTR}="underline"]`));
  assert.ok(shapeProblem(`htmlx[${STYLE_ATTR}="underline"] .a`));
});

// ------------------------------------------------------- 4. load order

const MANIFEST = JSON.parse(repoFile('manifest.json'));

test('the manifest loads the style list before display.js, and display.js right after visibility.js', () => {
  const list = MANIFEST.content_scripts.find((cs) => (cs.js || []).includes('content/page/display.js')).js;
  const at = (file) => {
    const index = list.indexOf(file);
    assert.notEqual(index, -1, `${file} is not in the content-script list`);
    return index;
  };
  assert.ok(at('shared/default-settings.js') < at('shared/translation-display.js'));
  assert.ok(at('shared/translation-display.js') < at('content/page/display.js'));
  assert.equal(at('content/page/display.js'), at('content/page/visibility.js') + 1);
  // display.js hangs its names on ctx; ctx.init (run by the entry, content.js) calls them.
  assert.ok(at('content/page/display.js') < at('content/content.js'));
});

function scriptOrder(rel) {
  return [...repoFile(rel).matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
}

test('popup.html and options.html load the style list before the scripts that read it', () => {
  for (const [page, consumers] of [
    ['popup/popup.html', ['popup-display.js', 'popup.js']],
    ['options/options.html', ['options-display.js', 'options-sync-mirror.js', 'options.js']],
  ]) {
    const order = scriptOrder(page);
    const list = order.indexOf('../shared/translation-display.js');
    assert.notEqual(list, -1, `${page} does not load shared/translation-display.js`);
    for (const consumer of consumers) {
      const at = order.indexOf(consumer);
      assert.ok(at > list, `${page} loads ${consumer} before shared/translation-display.js (or not at all)`);
    }
  }
  // The options preview is drawn by the page's own rules, not a copy of them.
  assert.match(repoFile('options/options.html'), /<link rel="stylesheet" href="\.\.\/content\/css\/translation\.css">/);
});

test('the e2e page-translation harness loads both new files, in manifest order', () => {
  const helpers = repoFile('test/e2e/helpers.js');
  const start = helpers.indexOf('const PAGE_TRANSLATION_MODULES = Object.freeze([');
  assert.notEqual(start, -1);
  const list = [...helpers.slice(start, helpers.indexOf('])', start)).matchAll(/'([^']+\.js)'/g)].map((m) => m[1]);
  const at = (file) => list.indexOf(file);
  assert.ok(at('shared/translation-display.js') !== -1 && at('content/page/display.js') !== -1);
  assert.ok(at('shared/translation-display.js') < at('content/page/display.js'));
  assert.equal(at('content/page/display.js'), at('content/page/visibility.js') + 1);
});

// ------------------------------------------------------- 5. commands

test('Alt+T is declared, within Chrome\'s four suggested keys, and named in every locale', () => {
  const withKeys = Object.values(MANIFEST.commands).filter((command) => command.suggested_key);
  assert.ok(withKeys.length <= 4, `${withKeys.length} commands suggest a key; Chrome ignores all past the fourth`);
  const command = MANIFEST.commands['toggle-translation-only'];
  assert.ok(command, 'manifest has no toggle-translation-only command');
  assert.equal(command.suggested_key.default, 'Alt+T');
  assert.equal(command.description, '__MSG_cmdToggleTranslationOnly__');
  const locales = repoDir('_locales');
  assert.equal(locales.length, 10);
  for (const locale of locales) {
    const messages = JSON.parse(repoFile(`_locales/${locale}/messages.json`));
    assert.ok(messages.cmdToggleTranslationOnly && messages.cmdToggleTranslationOnly.message.trim(),
      `_locales/${locale} has no cmdToggleTranslationOnly`);
  }
});

function stubChrome({ stored = {}, activeTab = { id: 7 }, sendFails = false } = {}) {
  const calls = { set: [], sent: [], queried: 0 };
  globalThis.chrome.storage = {
    sync: {
      get: async (defaults) => ({ ...defaults, ...stored }),
      set: async (values) => { calls.set.push(values); },
    },
  };
  globalThis.chrome.tabs = {
    query: async () => { calls.queried += 1; return activeTab ? [activeTab] : []; },
    sendMessage: async (...args) => {
      calls.sent.push(args);
      if (sendFails) throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  };
  return calls;
}

test('Alt+T flips showTranslationOnly and writes nothing else', async () => {
  let calls = stubChrome();
  await runCommand('toggle-translation-only', { id: 3 });
  assert.deepEqual(calls.set, [{ showTranslationOnly: true }], 'unset reads as the default (off) and flips on');
  assert.deepEqual(calls.sent, [], 'the switch is a setting; content scripts apply it from storage');

  calls = stubChrome({ stored: { showTranslationOnly: true } });
  await runCommand('toggle-translation-only', undefined);
  assert.deepEqual(calls.set, [{ showTranslationOnly: false }]);
  assert.equal(workerDefaults.showTranslationOnly, false);
});

test('Alt+A still sends the page toggle, to the top frame of the right tab', async () => {
  let calls = stubChrome();
  await runCommand('toggle-translate-page', { id: 3 });
  assert.deepEqual(calls.sent, [[3, { type: 'TOGGLE_PAGE_TRANSLATION' }, { frameId: 0 }]]);
  assert.equal(calls.queried, 0, 'a tab handed in by onCommand is the target');

  calls = stubChrome({ activeTab: { id: 9 } });
  await runCommand('toggle-translate-page', undefined);
  assert.deepEqual(calls.sent, [[9, { type: 'TOGGLE_PAGE_TRANSLATION' }, { frameId: 0 }]]);

  // chrome:// and the Web Store have no content script: nothing to do, and no unhandled rejection.
  calls = stubChrome({ sendFails: true });
  const log = console.log;
  console.log = () => {};
  try {
    await runCommand('toggle-translate-page', { id: 3 });
  } finally {
    console.log = log;
  }
  assert.equal(calls.sent.length, 1);

  calls = stubChrome();
  await runCommand('no-such-command', { id: 3 });
  assert.deepEqual([calls.set, calls.sent], [[], []]);
});

// ------------------------------------------------------- 6. defaults

function pageDefaults(rel) {
  const source = repoFile(rel);
  const start = source.indexOf('const defaultSettings = {');
  assert.notEqual(start, -1, `could not find the defaults in ${rel}`);
  const literal = source.slice(source.indexOf('{', start), source.indexOf('\n};', start) + 2);
  return new Function('DEFAULT_SELECTION_HOTKEY', 'OCRCore', `return (${literal});`)(
    globalThis.DefaultSettings.DEFAULT_SELECTION_HOTKEY, globalThis.OCRCore);
}

test('all four default tables say translationStyle "default" and translation-only off', () => {
  for (const [name, table] of [
    ['shared/default-settings.js', globalThis.DefaultSettings.contentDefaults()],
    ['background/settings.js', workerDefaults],
    ['options/options.js', pageDefaults('options/options.js')],
    ['popup/popup.js', pageDefaults('popup/popup.js')],
  ]) {
    assert.equal(table.translationStyle, 'default', `${name} translationStyle`);
    assert.equal(table.showTranslationOnly, false, `${name} showTranslationOnly`);
  }
});

// ------------------------------------------------------- 7. peek card containment

test('the source-peek card is a panel root in every list of the containment reset', () => {
  // The reset alone, bounded by its markers (host-css-containment.test.mjs reads
  // the same block); the control rules after it scope to two panels on purpose.
  const whole = repoFile('content/css/popup.css');
  const start = whole.indexOf('/* ==================== Host-page containment ====================');
  const end = whole.indexOf('/* ==================== end of host-page containment ==================== */');
  assert.ok(start > 0 && end > start, 'the containment reset lost its markers');
  const css = whole.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  const lists = [...css.matchAll(/:is\(\.ai-translator-popup,[^{]*?\)(?=[\s:{*,.>])/g)].map((m) => m[0]);
  assert.ok(lists.length >= 9, `only ${lists.length} root lists found; the reset changed shape`);
  for (const list of lists) {
    assert.ok(list.includes('[id="ai-translator-source-peek"]'), `a reset list leaves the peek card out:\n  ${list.slice(0, 120)}…`);
  }
});
