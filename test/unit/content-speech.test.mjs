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
