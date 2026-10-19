// A word lookup through the service worker's real prompt path (D-472①).
//
// A preset prompt says "Reply with the translation only". Picked by the user
// it is their custom prompt, so a lookup puts it first and
// DictEntry.OUTPUT_RULES after it; the rules' last line has to say that the
// entry format overrides any earlier word on the reply's format, or the model
// answers with a bare translation and every lookup fails. The default preset
// is not a custom prompt: a lookup under it keeps SINGLE_WORD_PROMPT. Checked
// for every preset on the system prompt the worker actually sends.
//
// And the other end: an answer that is not an entry reaches the reader as
// dictEntryUnreadable in their UI language (background/api-errors.js).
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { messageCatalog } from './helpers/sources.mjs';

// ---- the least service worker that loads -----------------------------------
const requests = [];
let reply = () => '{"translation":"你好"}';
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    sync: { get: async (defaults) => defaults || {}, set: async () => {} },
    onChanged: { addListener() {} },
  },
  runtime: { id: 'test', getManifest: () => ({ version: '0' }), sendMessage: async () => ({}) },
  i18n: { getUILanguage: () => 'en' },
};
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  requests.push(body);
  const content = reply();
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
console.warn = () => {};

await import('../../shared/site-rules-builtin.js');
await import('../../shared/storage-writer.js');
await import('../../shared/lang-tags.js');
await import('../../shared/site-rules.js');
await import('../../shared/sync-collection.js');
await import('../../shared/api-compat.js');
await import('../../shared/ai-profiles.js');
const prompts = await import('../../background/prompts.js');
const ai = await import('../../background/ai-translate.js');
const { apiErrorMessage } = await import('../../background/api-errors.js');

const { FORMAT_OVERRIDE, OUTPUT_RULES } = globalThis.DictEntry;
const PROFILE = {
  id: 'default',
  provider: 'openai',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: 'test-key',
  modelName: 'gpt-4.1-mini',
  timeoutSec: 60,
};

// The presets the settings page offers, and the one "reset" restores: one
// table, shared/prompt-presets.js, loaded by the worker through prompts.js.
const { TEMPLATES, DEFAULT } = globalThis.PromptPresets;
const CATALOG = messageCatalog();
await import('../../i18n/messages.js');

async function wordSystemPrompt(customPrompt) {
  requests.length = 0;
  const answer = await ai.translateTextWithMode('hello', 'zh-CN', PROFILE, { customPrompt }, true, {});
  assert.equal(answer.translation, '你好');
  assert.equal(requests.length, 1);
  return requests[0].messages[0].content;
}

test('the override clause is the last line of the rules and says what it overrides', () => {
  assert.ok(OUTPUT_RULES.endsWith('\n' + FORMAT_OVERRIDE));
  assert.match(FORMAT_OVERRIDE, /overrides any earlier instruction/i);
  assert.match(FORMAT_OVERRIDE, /translation only/i);
});

test('the presets are the three the settings page offers, and the default is one of them', () => {
  assert.deepEqual(Object.keys(TEMPLATES), ['standard', 'literal', 'creative']);
  assert.equal(DEFAULT, 'creative');
  for (const [name, template] of Object.entries(TEMPLATES)) {
    assert.ok(template.includes('{targetLang}'), `${name} is not a prompt template`);
  }
});

test('every preset the user picks is overridden by the entry format that follows it', async () => {
  // The name {targetLang} becomes for zh-CN, read off the path itself.
  const targetName = (await wordSystemPrompt('{targetLang}')).split('\n\n')[0];
  assert.match(targetName, /Chinese/);
  for (const [name, preset] of Object.entries(TEMPLATES)) {
    const system = await wordSystemPrompt(preset);
    // The default in the box is the default, not a custom prompt: the word
    // path keeps its dictionary prompt for it (shared/prompt-presets.js).
    const expected = name === DEFAULT ? prompts.SINGLE_WORD_PROMPT : preset;
    const substituted = expected.replace(/\{targetLang\}/g, targetName);
    const at = system.indexOf(substituted);
    assert.equal(at, 0, `${name}: the system prompt does not start with ${name === DEFAULT ? 'the word prompt' : 'the preset'}`);
    assert.ok(system.lastIndexOf(FORMAT_OVERRIDE) > at + substituted.length,
      `${name}: the override clause does not come after the template`);
    assert.ok(system.endsWith(FORMAT_OVERRIDE), `${name}: something follows the override clause`);
  }
});

test('the default lookup prompt ends with the override clause too, after the addenda', async () => {
  requests.length = 0;
  await ai.translateTextWithMode('hello', 'zh-CN', PROFILE, { customPrompt: '' }, true, { register: 'forum' });
  const system = requests[0].messages[0].content;
  assert.ok(system.startsWith(prompts.SINGLE_WORD_PROMPT.split('{targetLang}')[0]));
  assert.ok(system.indexOf(globalThis.PromptAddenda.REGISTER_SENTENCES.forum) < system.indexOf(OUTPUT_RULES),
    'the addenda come before the rules');
  assert.ok(system.endsWith(FORMAT_OVERRIDE));
});

test('an answer that is not an entry reads as dictEntryUnreadable in the UI language', async () => {
  reply = () => '你好';
  try {
    await assert.rejects(ai.translateTextWithMode('hello', 'zh-CN', PROFILE, { customPrompt: '' }, true, {}),
      (error) => {
        for (const lang of Object.keys(CATALOG)) {
          assert.equal(apiErrorMessage(error, { uiLanguage: lang }, PROFILE), globalThis.getMessage('dictEntryUnreadable', lang), lang);
        }
        return error.invalidEntry === true;
      });
  } finally {
    reply = () => '{"translation":"你好"}';
  }
  // The mapping keys on the flag alone, not on the message.
  const flagged = Object.assign(new Error('anything'), { invalidEntry: true });
  assert.equal(apiErrorMessage(flagged, { uiLanguage: 'en' }, PROFILE), globalThis.getMessage('dictEntryUnreadable', 'en'));
  assert.equal(apiErrorMessage(new Error('anything'), { uiLanguage: 'en' }, PROFILE), 'anything');
});
