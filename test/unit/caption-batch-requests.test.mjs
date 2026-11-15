// What a caption request carries, as the playhead moves — content/captions/translate.js.
//
// The engine translates ahead of the playhead inside a window (the window is
// the spend gate). This runs the real engine against a fake clock and a fake
// translator and reads the requests it makes: which lines travel together, how
// far ahead of the playhead they are, and how early each one is asked for.
//
// It runs the code rather than matching the source: every rule here is about
// what a sequence of calls adds up to, and a regex cannot see that.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = [
  'shared/lang-tags.js',
  'shared/caption-core.js',
  'content/captions/state.js',
  'content/captions/translate.js',
].map((rel) => [rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')]);

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** A track with one line every `everyMs`, each a sentence of its own. */
function track(count, everyMs) {
  return Array.from({ length: count }, (_, i) => ({
    startMs: i * everyMs,
    endMs: i * everyMs + Math.min(everyMs - SECOND, 4 * SECOND),
    text: `Line ${i + 1} of the talk.`,
  }));
}

/**
 * The engine with a track loaded. `batches` is the track as the engine cut it,
 * each batch as the lines it holds. `settings` are the user's; `builtin` is the
 * on-device engine as the caption engine sees it (absent = an AI engine).
 */
function load(cues, { settings = {}, builtin } = {}) {
  const requests = [];
  const ctx = {
    settings,
    builtinTranslator: builtin,
    translationProfile: { generation: () => 'g1' },
    getEffectiveTargetLang: () => 'zh-CN',
    requestTranslation: async (message) => {
      // Copied out: an array made inside the sandbox is another realm's Array.
      requests.push({ at: ctx.captions.state.lastNowMs, texts: Array.from(message.texts) });
      return { translations: message.texts.map((text) => `译:${text}`) };
    },
  };
  const sandbox = { window: { AI_TRANSLATOR_CONTENT: ctx }, console };
  vm.createContext(sandbox);
  for (const [filename, source] of SOURCES) vm.runInContext(source, sandbox, { filename });

  const caps = ctx.captions;
  Object.assign(caps.state, {
    active: true,
    trackId: 'track',
    trackLang: 'en',
    cues,
    batches: sandbox.CaptionCore.buildBatches(cues),
  });
  /** Put the playhead at `ms` and let the engine do whatever it does there. */
  const playTo = async (ms) => {
    caps.state.lastNowMs = ms;
    await caps.ensureTrackTranslated(true);
  };
  /** Watch from `fromMs` to `toMs`, the engine being nudged every two seconds. */
  const watch = async (fromMs, toMs) => {
    for (let ms = fromMs; ms <= toMs; ms += 2 * SECOND) await playTo(ms);
  };
  const batches = Array.from(caps.state.batches, (batch) => Array.from(batch, (seg) => seg.text));
  return { caps, requests, playTo, watch, batches };
}

const startOf = (cues) => new Map(cues.map((cue) => [cue.text, cue.startMs]));

test('lines that are spoken together are sent together, all the way through a talk', async () => {
  // Twenty minutes, a line every five seconds: fifteen batches of sixteen.
  const cues = track(240, 5 * SECOND);
  const { caps, requests, watch, batches } = load(cues);
  await watch(0, 20 * MINUTE);

  // The first pass fills the window, and that was always whole batches. The
  // ones after it are the test: as the window slides, a line enters it every
  // few seconds, and each used to be sent the moment it did, on its own.
  assert.equal(requests.length, batches.length);
  requests.forEach((request, i) => assert.deepEqual(request.texts, batches[i], `request ${i + 1}`));

  // The window is still the limit: nothing is sent from beyond it.
  const starts = startOf(cues);
  for (const request of requests) {
    for (const text of request.texts) {
      assert.ok(starts.get(text) - request.at <= caps.WINDOW_MS, `${text} was sent from past the window`);
    }
  }
  // And nothing is left late: a line is asked for at least two minutes before
  // it is spoken, unless the talk started closer to it than that.
  for (const request of requests) {
    for (const text of request.texts) {
      const lead = starts.get(text) - request.at;
      assert.ok(lead >= Math.min(starts.get(text), 2 * MINUTE), `${text} was asked for ${lead} ms ahead`);
    }
  }
});

test('a line far from its neighbours is not sent before the window reaches it', async () => {
  // A line every four minutes: sixteen of them are one batch an hour long. The
  // window is measured per line, so the batch is never sent as a whole.
  const cues = track(16, 4 * MINUTE);
  const { caps, requests, watch } = load(cues);
  await watch(0, 30 * MINUTE);

  const starts = startOf(cues);
  const sent = requests.flatMap((request) => request.texts);
  assert.deepEqual(sent, cues.slice(0, sent.length).map((cue) => cue.text), 'a line was sent twice or out of order');
  for (const request of requests) {
    for (const text of request.texts) {
      const lead = starts.get(text) - request.at;
      assert.ok(lead <= caps.WINDOW_MS, `${text} was sent ${lead} ms ahead`);
      assert.ok(lead >= Math.min(starts.get(text), 2 * MINUTE), `${text} was asked for only ${lead} ms ahead`);
    }
  }
  // Thirty minutes in, the lines of the second half-hour are still unsent.
  assert.ok(sent.length < cues.length);
  assert.ok(!sent.includes(cues[10].text));
});

test('after a seek the lines under the playhead go first, and only the ones ahead of it', async () => {
  const cues = track(240, 5 * SECOND);
  const { requests, playTo } = load(cues);
  await playTo(10 * MINUTE + SECOND);

  const starts = startOf(cues);
  // The line being spoken is in the first request.
  assert.ok(requests[0].texts.includes(cues[120].text));
  // Nothing behind the playhead is paid for.
  for (const request of requests) {
    for (const text of request.texts) assert.ok(starts.get(text) >= 10 * MINUTE, `${text} is behind the playhead`);
  }
});

test('with only the original on screen the window is short, and still holds', async () => {
  const cues = track(240, 5 * SECOND);
  const { caps, requests, watch } = load(cues, { settings: { captionDisplayMode: 'original' } });
  await watch(0, 5 * MINUTE);

  const starts = startOf(cues);
  for (const request of requests) {
    for (const text of request.texts) {
      assert.ok(starts.get(text) - request.at <= caps.NATIVE_WINDOW_MS, `${text} was sent from past the window`);
    }
  }
  // Sixty-odd lines were due in those five minutes. A request a line would be
  // sixty requests; a short window holds only a few lines, but they still go
  // out in runs.
  const sent = requests.reduce((count, request) => count + request.texts.length, 0);
  assert.ok(sent >= 60, `only ${sent} lines were sent`);
  assert.ok(requests.length <= sent / 3, `${requests.length} requests for ${sent} lines`);
});

test('an engine that costs nothing translates the whole track at once, in whole batches', async () => {
  const cues = track(240, 5 * SECOND);
  const builtin = { isActive: () => true, fallbackAllowed: () => false };
  const { requests, playTo, batches } = load(cues, { builtin });
  await playTo(0);

  assert.deepEqual(requests.map((request) => request.texts), batches);
});
