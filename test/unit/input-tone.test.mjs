// "Adjust the tone" of what the user is writing (docs/design/input-tone-rewrite.md).
//
// The extension's half of the contract: the nine tone ids and their labels, the
// one request (four fields, never a prompt), and which refusals get an entry
// ("View plans" for the free plan's daily allowance, nothing for a paid plan's,
// which comes back by itself tomorrow). The menu and the chip are walked in
// test/e2e/input-tone.spec.js.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import('../../i18n/messages.js');
await import('../../shared/quota-copy.js');
await import('../../shared/tones.js');
const { Tones, I18N_MESSAGES, UI_LANGUAGES } = globalThis;

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('nine tones: six at once, three behind More, each with a label key', () => {
  assert.deepEqual([...Tones.PRIMARY], ['friendly', 'formal', 'polite', 'serious', 'concise', 'casual']);
  assert.deepEqual([...Tones.MORE], ['confident', 'empathetic', 'natural']);
  assert.deepEqual([...Tones.IDS], [...Tones.PRIMARY, ...Tones.MORE]);
  assert.equal(Tones.labelKey('formal'), 'toneFormal');
  assert.equal(Tones.isTone('formal'), true);
  for (const bad of ['Formal', 'shorter', '', undefined, 'toString']) {
    assert.equal(Tones.isTone(bad), false, String(bad));
  }
  assert.throws(() => Tones.labelKey('shorter'), /unknown tone/);
});

test('every locale words every tone and every menu string', () => {
  const keys = [
    ...Tones.IDS.map(Tones.labelKey),
    'inputChipMenu', 'inputChipHideOnSite', 'menuTranslate', 'menuOtherLanguages', 'toneGroup', 'toneMore',
    'toneRegenerate', 'toneLoginRequired', 'toneFormattedUnsupported', 'toneDailyLimitFree', 'toneDailyLimitPaid',
    'toneTextTooLong', 'toneContentBlocked', 'toneFailed', 'toneLanguageUnknown', 'customRuleInputChip',
  ];
  assert.equal(UI_LANGUAGES.length, 15);
  for (const lang of UI_LANGUAGES) {
    const messages = I18N_MESSAGES[lang];
    for (const key of keys) {
      assert.equal(typeof messages[key], 'string', `${lang}.${key}`);
      assert.ok(messages[key].trim(), `${lang}.${key}`);
    }
    assert.match(messages.toneDailyLimitFree, /\{limit\}/, `${lang} names the allowance`);
    assert.match(messages.toneTextTooLong, /\{limit\}/, `${lang} names the length`);
  }
  // zh-CN carries the design's wording (§4.1).
  assert.deepEqual(Tones.IDS.map((id) => I18N_MESSAGES['zh-CN'][Tones.labelKey(id)]),
    ['更友好', '更正式', '更委婉', '更严肃', '更简洁', '更随意', '更自信', '更体贴', '更地道']);
});

// The SW's composeTone over a fake token store and a fake fetch: what leaves
// the browser is exactly the four fields, and nothing leaves without a token.
async function withComposeEnv({ token, reply = { status: 200, body: { text: 'Dear team,', tone: 'formal', usage: { used: 1, limit: 20 } } } }, run) {
  const sent = [];
  const saved = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (defaults) => Object.assign({}, defaults, token ? { comicToken: token } : {}),
        remove: async () => {},
        set: async () => {},
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { composeTone } = await import('../../background/compose-client.js');
    return await run(composeTone, sent);
  } finally {
    console.warn = warn;
    globalThis.chrome = saved.chrome;
    globalThis.fetch = saved.fetch;
  }
}

test('composeTone sends the text, the language, the tone id and the source language, nothing else', async () => {
  await withComposeEnv({ token: 'tok' }, async (composeTone, sent) => {
    const result = await composeTone({ text: 'hi team', targetLang: 'en', tone: 'formal', sourceLang: 'en', prompt: 'x' });
    assert.deepEqual(result, { text: 'Dear team,', tone: 'formal', usage: { used: 1, limit: 20 } });
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /\/api\/compose\/tone$/);
    assert.equal(sent[0].init.method, 'POST');
    assert.equal(sent[0].init.headers.Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(sent[0].init.body), { text: 'hi team', targetLang: 'en', tone: 'formal', sourceLang: 'en' });

    // No source language: the field is left out, not sent empty.
    await composeTone({ text: 'hi team', targetLang: 'ja', tone: 'casual' });
    assert.deepEqual(JSON.parse(sent[1].init.body), { text: 'hi team', targetLang: 'ja', tone: 'casual' });
  });
});

test('composeTone refuses before any request: no token, an unknown tone, no text', async () => {
  await withComposeEnv({ token: '' }, async (composeTone, sent) => {
    await assert.rejects(composeTone({ text: 'hi', targetLang: 'en', tone: 'formal' }), { code: 'unauthorized' });
    assert.equal(sent.length, 0, 'signed out sends nothing');
  });
  await withComposeEnv({ token: 'tok' }, async (composeTone, sent) => {
    await assert.rejects(composeTone({ text: 'hi', targetLang: 'en', tone: 'shorter' }), { code: 'bad_request' });
    await assert.rejects(composeTone({ text: '  ', targetLang: 'en', tone: 'formal' }), { code: 'bad_request' });
    assert.equal(sent.length, 0);
  });
});

test('composeTone carries the refusal fields through, and an empty rewrite is a failure', async () => {
  const limit = { status: 429, body: { error: 'daily_limit', plan: 'free', limit: 20, used: 20, resetsAt: '2026-11-08T00:00:00Z' } };
  await withComposeEnv({ token: 'tok', reply: limit }, async (composeTone) => {
    await assert.rejects(composeTone({ text: 'hi', targetLang: 'en', tone: 'formal' }), (error) => {
      assert.equal(error.code, 'daily_limit');
      assert.equal(error.status, 429);
      assert.deepEqual(error.toMessage().error.plan, 'free');
      assert.deepEqual(error.toMessage().error.limit, 20);
      return true;
    });
  });
  await withComposeEnv({ token: 'tok', reply: { status: 200, body: { text: '  ', tone: 'formal' } } }, async (composeTone) => {
    await assert.rejects(composeTone({ text: 'hi', targetLang: 'en', tone: 'formal' }), { code: 'upstream_failed' });
  });
});

test('the free plan daily limit offers View plans, a paid plan one offers nothing', async () => {
  const { accountActionFor } = await import('../../background/account-actions.js');
  assert.equal(accountActionFor('daily_limit', { plan: 'free' }), 'subscribe');
  assert.equal(accountActionFor('daily_limit', { plan: 'standard' }), undefined);
  assert.equal(accountActionFor('daily_limit'), undefined);
  assert.equal(accountActionFor('insufficient_points'), 'subscribe');
});

test('no tone wording ships in the extension: the page and the worker send ids only', () => {
  const files = ['background/compose-client.js', 'content/content-input-menu.js', 'content/content-input-chip.js',
    'content/content-input-dialog.js', 'shared/tones.js'];
  for (const file of files) {
    const text = source(file);
    assert.doesNotMatch(text, /\b(system|prompt)\s*:/i, `${file} assembles a prompt`);
    assert.doesNotMatch(text, /rewrite (it|this|the text) (in|to|so)/i, `${file} words a tone instruction`);
  }
  // The page's request is the four fields, built in one place.
  const menu = source('content/content-input-menu.js');
  const requests = [...menu.matchAll(/type: 'COMPOSE_TONE'/g)];
  assert.equal(requests.length, 1, 'one place sends COMPOSE_TONE');
  assert.match(menu, /const request = \{ text, targetLang, tone \};\s*if \(sourceLang\) request\.sourceLang = sourceLang;/);
  const worker = source('background/compose-client.js');
  assert.match(worker, /const body = \{ text, targetLang, tone \};\s*if \(sourceLang\) body\.sourceLang = sourceLang;/);
});
