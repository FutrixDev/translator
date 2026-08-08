// Guards for shared/caption-core.js — the site-independent half of subtitle
// translation, and the boundary that keeps it that way.
//
// Subtitle translation used to be one YouTube-shaped file. It is now an engine
// (content/content-video-captions.js) plus providers
// (content/content-caption-providers.js) that answer "can I supply cues here?".
// The two things that rot in that arrangement are asserted here rather than
// eyeballed: the cue shape every provider has to produce, and the rule that
// picks which provider gets the page.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// No `export` — it is also loaded as a classic script by the content scripts,
// so importing it for its side effect publishes globalThis.CaptionCore.
await import('../../shared/caption-core.js');
const core = globalThis.CaptionCore;

/** A stand-in for a browser VTTCue: seconds, and text that may carry markup. */
const cue = (startTime, endTime, text) => ({ startTime, endTime, text });

// ------------------------------------------------------ cue-shape conversion
test('a TextTrack cue becomes the engine cue shape: milliseconds, plain text', () => {
  assert.deepEqual(
    core.fromTextTrackCues([cue(1.25, 3.5, 'Hello world')]),
    [{ startMs: 1250, endMs: 3500, text: 'Hello world' }],
  );
});

test('inline cue markup and stray whitespace are stripped', () => {
  // WebVTT carries voice/class spans inside the cue payload; the model must not
  // see them, and neither should the reader.
  assert.deepEqual(
    core.fromTextTrackCues([cue(0, 1, '<v Roger>Hello\n  <c.loud>there</c>')]),
    [{ startMs: 0, endMs: 1000, text: 'Hello there' }],
  );
});

test('unusable cues are dropped rather than rendered empty', () => {
  const dropped = core.fromTextTrackCues([
    cue(1, 1, 'zero length'),
    cue(2, 1, 'ends before it starts'),
    cue(3, Infinity, 'live stream tail'),
    cue(4, 5, '   '),
    cue(5, 6, undefined),
    { startTime: 6, endTime: 7 }, // a metadata DataCue: no .text at all
  ]);
  assert.deepEqual(dropped, []);
});

test('sub-millisecond cue times round rather than truncate', () => {
  assert.deepEqual(
    core.fromTextTrackCues([cue(0.0006, 1.9994, 'x')]),
    [{ startMs: 1, endMs: 1999, text: 'x' }],
  );
});

test('a null cue list is not a crash', () => {
  assert.deepEqual(core.fromTextTrackCues(null), []);
  assert.deepEqual(core.fromTextTrackCues(undefined), []);
});

test('a TextTrack cue and the same cue as WebVTT text land on the same shape', () => {
  // The engine cannot tell where cues came from, and that is the whole point of
  // the provider split — so the two routes must agree exactly.
  const fromTrack = core.fromTextTrackCues([cue(1.5, 3, 'Hello <b>world</b>')]);
  const fromVtt = core.parseCaptionPayload('WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nHello <b>world</b>\n', 'text/vtt');
  assert.deepEqual(fromTrack, fromVtt);
});

// ------------------------------------------------------------------ parsers
test('the three payload formats are sniffed without a content type', () => {
  const json3 = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hi' }] }] });
  assert.deepEqual(core.parseCaptionPayload(json3, ''), [{ startMs: 0, endMs: 2000, text: 'Hi' }]);
  assert.deepEqual(
    core.parseCaptionPayload('WEBVTT\n\n00:00.000 --> 00:02.000\nHi\n', ''),
    [{ startMs: 0, endMs: 2000, text: 'Hi' }],
  );
  // SRT's comma decimal separator, and no WEBVTT header.
  assert.deepEqual(
    core.parseCaptionPayload('1\n00:00:00,000 --> 00:00:02,000\nHi\n', ''),
    [{ startMs: 0, endMs: 2000, text: 'Hi' }],
  );
  assert.deepEqual(core.parseCaptionPayload('not a subtitle file', ''), []);
  assert.deepEqual(core.parseCaptionPayload('', 'text/vtt'), []);
});

test('VTT cue settings after the end timestamp are not read as part of it', () => {
  const cues = core.parseCaptionPayload('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:90% align:center\nHi\n', '');
  assert.deepEqual(cues, [{ startMs: 1000, endMs: 2000, text: 'Hi' }]);
});

// ------------------------------------------------------------------- merging
test('re-offering a track adds only what is new, and says so', () => {
  const first = core.mergeRawCues([], [{ startMs: 1000, endMs: 2000, text: 'a' }]);
  assert.equal(first.added, true);

  const again = core.mergeRawCues(first.cues, [{ startMs: 1000, endMs: 2000, text: 'a' }]);
  assert.equal(again.added, false);
  // The same array instance, so the engine can skip re-segmenting the track on
  // every debounced re-read a growing in-band track produces.
  assert.equal(again.cues, first.cues);

  const grown = core.mergeRawCues(first.cues, [
    { startMs: 3000, endMs: 4000, text: 'c' },
    { startMs: 2000, endMs: 3000, text: 'b' },
  ]);
  assert.equal(grown.added, true);
  assert.deepEqual(grown.cues.map((c) => c.text), ['a', 'b', 'c'], 'cues stay in playback order');
});

test('an endless live track is capped from the front', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 900, text: `c${i}` }));
  const { cues } = core.mergeRawCues([], many, 4);
  assert.deepEqual(cues.map((c) => c.text), ['c6', 'c7', 'c8', 'c9']);
});

// -------------------------------------------------------- provider selection
const provider = (id, priority, canActivate) => ({ id, priority, canActivate });

test('the highest-priority provider that can run gets the page', () => {
  const picked = core.selectProvider([
    provider('generic', core.PROVIDER_PRIORITY.GENERIC, () => true),
    provider('site', core.PROVIDER_PRIORITY.SITE, () => true),
  ]);
  assert.equal(picked.id, 'site');
});

test('a site provider that cannot run steps aside for the generic one', () => {
  const picked = core.selectProvider([
    provider('site', core.PROVIDER_PRIORITY.SITE, () => false),
    provider('generic', core.PROVIDER_PRIORITY.GENERIC, () => true),
  ]);
  assert.equal(picked.id, 'generic');
});

test('a provider that throws while probing does not take the page down with it', () => {
  // A site provider looking for DOM that is not there must not block the
  // generic provider behind it.
  const picked = core.selectProvider([
    provider('site', core.PROVIDER_PRIORITY.SITE, () => { throw new Error('no player'); }),
    provider('generic', core.PROVIDER_PRIORITY.GENERIC, () => true),
  ]);
  assert.equal(picked.id, 'generic');
});

test('no provider is a valid answer — most pages have no video at all', () => {
  assert.equal(core.selectProvider([provider('generic', 10, () => false)]), null);
  assert.equal(core.selectProvider([]), null);
  assert.equal(core.selectProvider(undefined), null);
});

test('equal priority keeps registration order', () => {
  const picked = core.selectProvider([
    provider('first', 50, () => true),
    provider('second', 50, () => true),
  ]);
  assert.equal(picked.id, 'first');
});

test('a site provider always outranks the generic one', () => {
  assert.ok(core.PROVIDER_PRIORITY.SITE > core.PROVIDER_PRIORITY.GENERIC);
});

// ------------------------------------------------------------ track choosing
const entry = (mode, language, isDefault) => ({ track: { mode, language }, isDefault: !!isDefault });

test('the page\'s own showing track wins over everything', () => {
  const picked = core.pickSubtitleTrack([
    entry('disabled', 'en', true),
    entry('showing', 'fr'),
  ]);
  assert.equal(picked.track.language, 'fr');
});

test('a hidden track counts as on — the player is drawing it itself', () => {
  // video.js, Vimeo and JW load the cues and render them from JS, so the track
  // sits at 'hidden' the whole time the viewer is reading subtitles.
  const picked = core.pickSubtitleTrack([
    entry('disabled', 'en', true),
    entry('hidden', 'fr'),
  ]);
  assert.equal(picked.track.language, 'fr');
});

test('among several tracks in the same mode, the default one is the answer', () => {
  const picked = core.pickSubtitleTrack([
    entry('hidden', 'en'),
    entry('hidden', 'de', true),
  ]);
  assert.equal(picked.track.language, 'de');
});

test('subtitles the page merely offers are left off', () => {
  // Vimeo's player lists four languages and shows none until asked. Picking one
  // would put subtitles on screen that nobody turned on, in whichever language
  // the page happened to list first — German, for an English video.
  assert.equal(core.pickSubtitleTrack([
    entry('disabled', 'de'),
    entry('disabled', 'en'),
  ]), null);
  assert.equal(core.pickSubtitleTrack([entry('disabled', 'en', true)]), null);
  assert.equal(core.pickSubtitleTrack([]), null);
});

// -------------------------------------------------------- translation request
test('the track states the source language, so detection never has to guess', () => {
  // A subtitle line is a few words — too short to identify. Without this the
  // engine falls back to the language of the page, and a Chinese-UI video site
  // playing an English talk answers 'zh': the line is read as already
  // translated and handed back untouched.
  const message = core.buildTranslationRequest({
    texts: ['Hello world'],
    targetLang: 'zh-CN',
    trackLang: 'en',
    delimiter: '|',
  });
  assert.equal(message.type, 'TRANSLATE_BATCH_FAST');
  assert.deepEqual(message.texts, ['Hello world']);
  assert.equal(message.targetLang, 'zh-CN');
  assert.equal(message.sourceLang, 'en');
  assert.equal(message.delimiter, '|');
  // Subtitles run with the playhead and cannot wait on a language pack.
  assert.equal(message.allowDownload, false);
});

test('a track that declares no language is left to detection', () => {
  for (const trackLang of [undefined, null, '', '   ']) {
    const message = core.buildTranslationRequest({ texts: ['x'], targetLang: 'zh', trackLang });
    assert.equal('sourceLang' in message, false, `${JSON.stringify(trackLang)} should not become a hint`);
  }
  // A region-tagged track passes through as-is; the engine narrows it.
  assert.equal(core.buildTranslationRequest({ trackLang: 'en-US' }).sourceLang, 'en-US');
});

test('the caption engine asks for its request through the shared builder', () => {
  // The source-language hint is the whole point of the builder; a caller that
  // assembles its own message drops it and silently loses the translation.
  const engine = repoFile('content/content-video-captions.js');
  assert.match(engine, /core\.buildTranslationRequest\(/);
  assert.equal(
    engine.includes("type: 'TRANSLATE_BATCH_FAST'"),
    false,
    'content-video-captions.js hand-rolls the request instead of using buildTranslationRequest',
  );
});

// ------------------------------------------------------------- segmentation
test('fragments merge into sentences and split on punctuation and pauses', () => {
  const segments = core.buildSegments([
    { startMs: 0, endMs: 900, text: 'the quick brown' },
    { startMs: 900, endMs: 1800, text: 'fox jumps.' },
    { startMs: 1900, endMs: 2800, text: 'over the lazy dog' },
    // A gap longer than SEG_GAP_MS starts a new segment even mid-sentence.
    { startMs: 9000, endMs: 9900, text: 'and then some' },
  ]);
  assert.deepEqual(segments.map((s) => s.text), [
    'the quick brown fox jumps.',
    'over the lazy dog',
    'and then some',
  ]);
  assert.equal(segments[0].startMs, 0);
  assert.equal(segments[0].endMs, 1800);
});

test('batches stay under both the item and character caps', () => {
  const segments = Array.from({ length: 40 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 900, text: `sentence ${i}.` }));
  for (const batch of core.buildBatches(segments)) {
    assert.ok(batch.length <= core.BATCH_MAX_ITEMS);
    assert.ok(batch.reduce((n, s) => n + s.text.length, 0) <= core.BATCH_MAX_CHARS);
  }
  assert.equal(core.buildBatches(segments).flat().length, segments.length, 'no segment is dropped');
});

// ------------------------------------------------------------ the boundary
test('the engine and the providers load the shared core, and the manifest ships it', () => {
  const manifest = JSON.parse(repoFile('manifest.json'));
  const bundle = manifest.content_scripts.flatMap((entry) => entry.js || []);
  for (const file of ['shared/caption-core.js', 'content/content-caption-providers.js', 'content/content-video-captions.js']) {
    assert.ok(bundle.includes(file), `manifest.json must inject ${file}`);
  }
  assert.ok(
    !bundle.includes('content/content-youtube-captions.js'),
    'the YouTube-only module is gone — its engine half is content-video-captions.js',
  );
  // Order matters: both consumers read globalThis.CaptionCore at load time.
  assert.ok(bundle.indexOf('shared/caption-core.js') < bundle.indexOf('content/content-caption-providers.js'));
  assert.ok(bundle.indexOf('shared/caption-core.js') < bundle.indexOf('content/content-video-captions.js'));
});

test('no consumer re-declares the shared caption logic', () => {
  // The whole point of the split is that adding a site means adding a provider,
  // not another copy of the parsing/segmenting/selecting. Keep exactly one
  // definition of each — same rule shared/api-compat.js is held to.
  const shared = ['parseVtt', 'parseJson3', 'parseSrv3', 'parseCaptionPayload',
    'buildSegments', 'buildBatches', 'fromTextTrackCues', 'mergeRawCues',
    'selectProvider', 'pickSubtitleTrack', 'buildTranslationRequest'];
  for (const file of ['content/content-video-captions.js', 'content/content-caption-providers.js']) {
    const src = repoFile(file);
    for (const name of shared) {
      assert.equal(
        src.includes(`function ${name}(`),
        false,
        `${file} re-declares ${name} — it belongs to shared/caption-core.js alone`,
      );
    }
  }
});

test('the engine holds no site-specific selectors', () => {
  // Every one of these belongs to a provider. An engine that reaches for a
  // YouTube class name is an engine that has stopped being generic.
  const engine = repoFile('content/content-video-captions.js');
  for (const marker of ['ytp-', 'youtube.com', 'yt-navigate', 'timedtext']) {
    assert.equal(engine.includes(marker), false, `content-video-captions.js mentions ${marker}`);
  }
});

test('providers declare their rank from the shared scale', () => {
  const providers = repoFile('content/content-caption-providers.js');
  assert.equal(
    /priority:\s*\d/.test(providers),
    false,
    'a hardcoded priority number bypasses PROVIDER_PRIORITY and its site-beats-generic rule',
  );
});
