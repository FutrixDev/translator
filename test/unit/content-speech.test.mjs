// Guards for content/content-speech.js — the single owner of read-aloud.
//
// Four speaker buttons across two surfaces (the selection popup's original and
// translation, the input dialog's original and translation) all speak through
// this module. The failure it prevents is the one this feature was born from:
// the popup used to carry its own `speakText` + `getDetectedLang` pair, so the
// input dialog reached across for `ctx.speakText` and got a button with no
// play/stop toggle, no pressed state and no label swap. A fifth surface that
// calls `new SpeechSynthesisUtterance` itself would drift the same way.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const OWNER = 'content/content-speech.js';

await import('../../shared/speech-lang.js');
const { SPEECH_REGION, scriptOf, resolveSpeechLang, resolveSpokenLang, pickVoice } = globalThis.SpeechLang;

// A stand-in for what speechSynthesis.getVoices() hands back on macOS: every
// entry region-qualified, never a bare tag, and several regions per language.
const VOICES = [
  'zh-CN', 'zh-TW', 'zh-HK', 'en-US', 'en-GB', 'en-AU', 'ja-JP', 'ko-KR',
  'fr-FR', 'fr-CA', 'de-DE', 'es-ES', 'es-MX', 'pt-BR', 'pt-PT', 'ru-RU',
  'it-IT', 'nl-NL',
].map((lang) => ({ lang }));

// Every script the manifest injects, minus the owner itself.
function otherContentScripts() {
  const manifest = JSON.parse(repoFile('manifest.json'));
  return manifest.content_scripts
    .flatMap(entry => entry.js)
    .filter(src => src !== OWNER && src.startsWith('content/'));
}

test('only content-speech.js touches the Web Speech API', () => {
  for (const src of otherContentScripts()) {
    const code = repoFile(src);
    assert.doesNotMatch(code, /\bSpeechSynthesisUtterance\b/,
      `${src} builds its own utterance — speak through ctx.speech.bindSpeakButton instead`);
    assert.doesNotMatch(code, /\bspeechSynthesis\b/,
      `${src} drives speechSynthesis directly — speak through ctx.speech instead`);
  }
});

test('speaker buttons are wired through bindSpeakButton, not by hand', () => {
  // The surfaces that actually render speaker buttons. Each must delegate.
  const surfaces = ['content/content-popup.js', 'content/content-input-dialog.js'];
  for (const src of surfaces) {
    const code = repoFile(src);
    assert.match(code, /speech\.bindSpeakButton\(/,
      `${src} renders speaker buttons but does not bind them through ctx.speech`);
    // `hidden` is the one thing bindSpeakButton's returned setter owns: setting
    // it directly is how a browser with no speech synthesis ends up showing a
    // button that can do nothing.
    assert.doesNotMatch(code, /speak[A-Za-z]*(Btn|Button)\s*\.hidden\s*=/,
      `${src} toggles a speaker button's hidden directly — use the setter bindSpeakButton returns`);
  }
});

test('the speaker glyph is drawn from one place', () => {
  // The path of the speaker cone. Two copies is how the popup's button and the
  // dialog's button start rendering at different sizes.
  const cone = /M4 9v6h4l5 4V5L8 9H4z/;
  assert.match(repoFile(OWNER), cone, `${OWNER} owns the speaker icon`);
  for (const src of otherContentScripts()) {
    assert.doesNotMatch(repoFile(src), cone,
      `${src} inlines its own speaker icon — use ctx.speech.SPEAKER_ICON`);
  }
});

test('the owner loads before every surface that uses it', () => {
  const manifest = JSON.parse(repoFile('manifest.json'));
  const scripts = manifest.content_scripts.find(entry => entry.js.includes(OWNER)).js;
  const ownerAt = scripts.indexOf(OWNER);
  assert.ok(ownerAt !== -1, `manifest.json must inject ${OWNER}`);
  for (const consumer of ['content/content-popup.js', 'content/content-input-dialog.js']) {
    assert.ok(ownerAt < scripts.indexOf(consumer),
      `${OWNER} must load before ${consumer}, which reads ctx.speech at module scope`);
  }
});

// ==================== which voice actually speaks ====================
//
// The bug these cover: Chrome matches `utterance.lang` against the installed
// voices and answers no match with the SYSTEM DEFAULT voice, not a near one.
// No installed voice carries a bare tag, and eight of our ten targets are
// bare — so picking English on a Chinese-locale Mac read the English aloud
// with 婷婷.

test('a bare target language is widened to a tag some voice answers to', () => {
  for (const [base, expected] of Object.entries(SPEECH_REGION)) {
    assert.equal(resolveSpeechLang(base, VOICES), expected,
      `'${base}' must resolve to an installed voice's tag, or Chrome uses the system default`);
  }
});

test('every language the picker offers can be spoken', () => {
  // The same drift target/unit/target-languages.test.mjs guards for the prompt:
  // a language offered but not mapped here is silently read in the wrong voice.
  const bootstrap = repoFile('content/content-bootstrap.js');
  const block = bootstrap.slice(bootstrap.indexOf('TARGET_LANGUAGE_OPTIONS: ['));
  const offered = [...block.slice(0, block.indexOf(']')).matchAll(/value: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(offered.length >= 10, `expected the full target list, saw ${offered.join(', ')}`);

  for (const lang of offered) {
    const resolved = resolveSpeechLang(lang, VOICES);
    assert.ok(VOICES.some((v) => v.lang === resolved),
      `target '${lang}' resolves to '${resolved}', which no voice answers to — add it to SPEECH_REGION`);
  }
});

test('a tag a voice already answers to is left alone', () => {
  // zh-CN and zh-TW are different voices, not two spellings of one.
  assert.equal(resolveSpeechLang('zh-TW', VOICES), 'zh-TW');
  assert.equal(resolveSpeechLang('en-GB', VOICES), 'en-GB');
  // A language with no map entry still beats the system default.
  assert.equal(resolveSpeechLang('nl', VOICES), 'nl-NL');
  // Nothing installed for it: hand back the tag rather than invent a region.
  assert.equal(resolveSpeechLang('sw', VOICES), 'sw');
  // No list to check against yet — same, rather than guessing.
  assert.equal(resolveSpeechLang('en', []), 'en');
});

test('script decides the language when the text disagrees with the target', async () => {
  const never = () => { throw new Error('detection should not be reached'); };

  // The reported case: translating 动画 into English echoed the source back,
  // and the translation button read Chinese with an English voice.
  assert.equal(await resolveSpokenLang('动画', 'en', never), 'zh');
  assert.equal(await resolveSpokenLang('안녕하세요', 'en', never), 'ko');
  assert.equal(await resolveSpokenLang('こんにちは', 'en', never), 'ja');
  // Kanji beside kana is Japanese, not Chinese.
  assert.equal(await resolveSpokenLang('日本語を話す', 'en', never), 'ja');
  // The target agrees, so its finer form survives: zh-TW must not become zh.
  assert.equal(await resolveSpokenLang('動畫', 'zh-TW', never), 'zh-TW');
});

test('detection is the last resort, not the first', async () => {
  // Latin text with a Latin target: no reason to spend a detection call, and
  // no reason to doubt the target.
  assert.equal(await resolveSpokenLang('animation', 'en', () => { throw new Error('no'); }), 'en');
  // Latin text with a CJK target is the target being wrong; ask.
  assert.equal(await resolveSpokenLang('animation', 'zh-CN', async () => 'en'), 'en');
  // Detection has nothing to say on two characters — better the declared
  // target than an empty tag, which is the system default voice again.
  assert.equal(await resolveSpokenLang('xy', 'fr', async () => ''), 'fr');
  assert.equal(scriptOf('animation'), '');
});

// ==================== which of the matching voices speaks ====================
//
// The bug these cover: with `utterance.voice` unset, Chrome takes the FIRST
// listed voice matching the tag — and macOS enumerates alphabetically, so a
// correct `en-US` was read by Albert, a hoarse novelty voice, while Samantha
// sat at index 131. The original sounded fine (婷婷 is the system default on a
// Chinese-locale Mac); only the translation croaked.

// The shape speechSynthesis.getVoices() actually has on that Mac: alphabetical
// by name, novelty and Eloquence voices listed before the natural ones, the
// system default nowhere near the language being spoken.
const MACOS_VOICES = [
  { name: '婷婷', lang: 'zh-CN', default: true },
  { name: 'Albert', lang: 'en-US' },
  { name: 'Bad News', lang: 'en-US' },
  { name: 'Eddy (英语（美国）)', lang: 'en-US' },
  { name: 'Eddy (日语（日本）)', lang: 'ja-JP' },
  { name: 'Eddy (芬兰语（芬兰）)', lang: 'fi-FI' },
  { name: 'Flo (芬兰语（芬兰）)', lang: 'fi-FI' },
  { name: 'Grandma (英语（美国）)', lang: 'en-US' },
  { name: 'Kyoko', lang: 'ja-JP' },
  { name: 'Samantha', lang: 'en-US' },
  { name: 'Whisper', lang: 'en-US' },
];

test('a natural voice beats the novelty voices listed before it', () => {
  // The reported case: translation to English read by Albert, the croak.
  assert.equal(pickVoice('en', MACOS_VOICES)?.name, 'Samantha');
  // Eloquence robots are ahead of Kyoko alphabetically too.
  assert.equal(pickVoice('ja', MACOS_VOICES)?.name, 'Kyoko');
  // A locale that renders the OUTER parenthesis fullwidth must not smuggle an
  // Eloquence voice into the natural tier.
  assert.equal(pickVoice('en', [
    { name: 'Eddy（英语（美国））', lang: 'en-US' },
    { name: 'Samantha', lang: 'en-US' },
  ])?.name, 'Samantha');
});

test('the system default wins its own language, joke voices never inherit it', () => {
  assert.equal(pickVoice('zh-CN', MACOS_VOICES)?.name, '婷婷');
  // A language whose only installed voices are Eloquence still gets one —
  // robotic in the right language beats natural in the wrong one.
  assert.equal(pickVoice('fi-FI', MACOS_VOICES)?.name, 'Eddy (芬兰语（芬兰）)');
});

test('no candidates means no voice, not a guess', () => {
  assert.equal(pickVoice('sw', MACOS_VOICES), null);
  assert.equal(pickVoice('en', []), null);
  assert.equal(pickVoice('', MACOS_VOICES), null);
});

test('the utterance is given the picked voice, not just a tag', () => {
  // Setting only `utterance.lang` is the exact regression this guards: Chrome
  // resolves a bare tag to the first listed match, which on macOS is a
  // novelty voice.
  const code = repoFile(OWNER);
  assert.match(code, /SpeechLang\.pickVoice\(/, `${OWNER} must choose the voice through SpeechLang.pickVoice`);
  assert.match(code, /utterance\.voice\s*=/, `${OWNER} must set utterance.voice from the picked voice`);
});

test('the pure half is loaded before the module that uses it', () => {
  const manifest = JSON.parse(repoFile('manifest.json'));
  const scripts = manifest.content_scripts.find((entry) => entry.js.includes(OWNER)).js;
  const at = scripts.indexOf('shared/speech-lang.js');
  assert.ok(at !== -1, 'manifest.json must inject shared/speech-lang.js');
  assert.ok(at < scripts.indexOf(OWNER), 'shared/speech-lang.js must load before ' + OWNER);
  // And the owner must not grow its own copy of the resolution it delegates.
  assert.doesNotMatch(repoFile(OWNER), /SPEECH_REGION\s*=/,
    `${OWNER} redeclares the region map — it belongs to shared/speech-lang.js`);
});

test('every string this feature added has a translation in all locales', () => {
  const messages = repoFile('i18n/messages.js');
  const locales = [...messages.matchAll(/^\s{2}'?([a-zA-Z-]+)'?:\s*\{$/gm)].map(m => m[1]);
  assert.ok(locales.length >= 10, `expected the full locale set, saw ${locales.join(', ')}`);

  const keys = ['pronounceOriginal', 'pronounceTranslation', 'stopPronunciation', 'translateShortcutHint'];
  for (const key of keys) {
    const uses = [...messages.matchAll(new RegExp(`^\\s+${key}:`, 'gm'))];
    assert.equal(uses.length, locales.length,
      `${key} is missing from ${locales.length - uses.length} locale(s)`);
  }
});
