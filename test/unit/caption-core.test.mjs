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

// ------------------------------------------- turning subtitles on, on request
test('with allowDisabled off, a track the page merely offers stays off', () => {
  // 默认档没有变过：传 undefined、传 {}、传 {allowDisabled:false} 是同一件事。
  for (const options of [undefined, {}, { allowDisabled: false }, { audioLang: 'en' }]) {
    assert.equal(core.pickSubtitleTrack([entry('disabled', 'en', true)], options), null);
  }
});

test('allowDisabled prefers the track that matches what is being spoken', () => {
  // 一段英文演讲，播放器列了四门字幕都没开。挑「默认」那条会挑到页面语言的那门
  // 译制字幕——那是一条已经翻过一次的中文字幕，我们再翻一次得到的是中文译中文。
  const picked = core.pickSubtitleTrack([
    entry('disabled', 'zh-CN', true),
    entry('disabled', 'de'),
    entry('disabled', 'en-US'),
  ], { allowDisabled: true, audioLang: 'en' });
  assert.equal(picked.track.language, 'en-US');
});

test('allowDisabled falls back to the page\'s own default, then to the first', () => {
  assert.equal(core.pickSubtitleTrack([
    entry('disabled', 'de'),
    entry('disabled', 'fr', true),
  ], { allowDisabled: true, audioLang: 'ja' }).track.language, 'fr');

  assert.equal(core.pickSubtitleTrack([
    entry('disabled', 'de'),
    entry('disabled', 'fr'),
  ], { allowDisabled: true }).track.language, 'de');

  assert.equal(core.pickSubtitleTrack([], { allowDisabled: true }), null);
});

test('allowDisabled never overrules a track that is already on', () => {
  // 观众自己开着一门字幕，而声道是另一门语言：动他的选择比留着更糟。
  const picked = core.pickSubtitleTrack([
    entry('showing', 'fr'),
    entry('disabled', 'en'),
  ], { allowDisabled: true, audioLang: 'en' });
  assert.equal(picked.track.language, 'fr');
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

// -------------------------------------------------------------- display mode
// Three modes and one position, resolved from settings alone so the engine, the
// in-player menu and the options preview cannot disagree about what is on
// screen. The migration is the part with teeth: `captionDisplayMode` unset is
// every user who installed before F17, and their only control was a checkbox.
test('bilingual is the default, with the translation under the original', () => {
  assert.deepEqual(core.resolveCaptionDisplay({}), {
    mode: 'bilingual',
    showOriginal: true,
    showTranslation: true,
    translationFirst: false,
    useNative: false,
  });
});

test('position "above" flips the two lines, and only in bilingual mode', () => {
  const above = core.resolveCaptionDisplay({ captionDisplayMode: 'bilingual', captionTranslationPosition: 'above' });
  assert.equal(above.translationFirst, true);
  // With one line on screen there is nothing to put it above.
  const single = core.resolveCaptionDisplay({ captionDisplayMode: 'translation', captionTranslationPosition: 'above' });
  assert.equal(single.translationFirst, false);
});

test('"translation" shows the translated line alone', () => {
  const d = core.resolveCaptionDisplay({ captionDisplayMode: 'translation' });
  assert.equal(d.showOriginal, false);
  assert.equal(d.showTranslation, true);
  assert.equal(d.useNative, false);
});

test('"original" draws nothing of ours and hands the page its own captions back', () => {
  // Not the same as switching the feature off: the track keeps translating in
  // the background, so coming back out of this mode is instant.
  const d = core.resolveCaptionDisplay({ captionDisplayMode: 'original' });
  assert.equal(d.showOriginal, false);
  assert.equal(d.showTranslation, false);
  assert.equal(d.useNative, true);
});

test('the pre-F17 "show original caption" checkbox keeps its meaning', () => {
  // Unchecked was the only way to get a translation-only line before the select
  // existed. Reading it as bilingual would put a second line on screen for
  // everyone who had turned it off.
  assert.equal(core.resolveCaptionDisplay({ showYoutubeOriginalCaption: false }).mode, 'translation');
  assert.equal(core.resolveCaptionDisplay({ showYoutubeOriginalCaption: true }).mode, 'bilingual');
  // ...and the new key wins the moment it is set.
  assert.equal(
    core.resolveCaptionDisplay({ showYoutubeOriginalCaption: false, captionDisplayMode: 'bilingual' }).mode,
    'bilingual',
  );
});

test('a mode nobody recognises falls back rather than blanking the screen', () => {
  assert.equal(core.resolveCaptionDisplay({ captionDisplayMode: 'sideways' }).mode, 'bilingual');
  assert.equal(core.resolveCaptionDisplay(null).mode, 'bilingual');
});

// The migration above is only reachable if nothing pre-fills the key. Every
// reader of settings passes chrome.storage a dictionary of defaults, and a
// `captionDisplayMode: 'bilingual'` in one of those is handed to the resolver
// as a set mode: the boolean is never consulted, and a user who had unchecked
// "show original caption" gets a second line back on upgrade. The unit tests of
// the pure function cannot see that, so the defaults themselves are asserted.
// The content scripts' dictionary was three copies inside content-bootstrap.js
// and is now one file; the options page keeps its own, because its dictionary
// is the initial value of every form control, not the same set.
const DEFAULT_DICTIONARY_SOURCES = [
  'shared/default-settings.js',
  'options/options.js',
];

test('no default dictionary pre-fills captionDisplayMode with a mode', () => {
  for (const rel of DEFAULT_DICTIONARY_SOURCES) {
    const src = repoFile(rel);
    const assignments = src.match(/captionDisplayMode:\s*(?:'[^']*'|"[^"]*")/g) || [];
    assert.ok(assignments.length > 0, `${rel} no longer declares a captionDisplayMode default`);
    for (const assignment of assignments) {
      assert.match(
        assignment,
        /captionDisplayMode:\s*(?:''|"")/,
        `${rel}: ${assignment} — a mode here kills the migration off showYoutubeOriginalCaption`,
      );
    }
  }
});

test('the content scripts read one defaults dictionary, not a copy of one', () => {
  // content-bootstrap.js held three copies of this dictionary — the initial
  // value, the storage read set, and the read-failed fallback — and they had
  // already drifted. A copy reintroduced here is a caption default that applies
  // on one code path and not another.
  const bootstrap = repoFile('content/content-bootstrap.js');
  assert.match(bootstrap, /DefaultSettings\.contentDefaults\(\)/, 'content-bootstrap.js stopped using the shared defaults');
  assert.doesNotMatch(
    bootstrap,
    /captionDisplayMode:|translationEngine:/,
    'content-bootstrap.js is declaring settings defaults again — they belong in shared/default-settings.js',
  );
});

test('the defaults still carry showYoutubeOriginalCaption for the resolver to read', () => {
  // The unset mode is only half of it: the old boolean has to stay in the read
  // set, or storage returns nothing for it and every pre-F17 profile reads as
  // bilingual anyway.
  for (const rel of DEFAULT_DICTIONARY_SOURCES) {
    assert.match(repoFile(rel), /showYoutubeOriginalCaption:\s*true/, `${rel} dropped the migration source`);
  }
});

// ------------------------------------------------------------------ controls
test('the in-player control file holds no site-specific selectors', () => {
  // Same rule the engine is held to: where the button goes is the provider's
  // answer (getControlsHost), not something the control file knows.
  const controls = repoFile('content/content-caption-controls.js');
  for (const marker of ['ytp-right-controls', 'youtube.com', 'movie_player', 'x.com']) {
    assert.equal(controls.includes(marker), false, `content-caption-controls.js mentions ${marker}`);
  }
});

test('the controls load after the providers and before the engine', () => {
  // It reads a provider's getControlsHost() and the engine drives it, so it has
  // to be defined between the two.
  const manifest = repoFile('manifest.json');
  assert.ok(manifest.indexOf('content/content-caption-providers.js') < manifest.indexOf('content/content-caption-controls.js'));
  assert.ok(manifest.indexOf('content/content-caption-controls.js') < manifest.indexOf('content/content-video-captions.js'));
});

// -------------------------------------------------- turning subtitles on
// 这一轮的自动化里，只有这一件事**改动播放器自己的状态**。其余的（整页翻译、字
// 幕覆盖层）都只是往页面里插我们自己的节点，插错了刷新一下就没了；把播放器的 CC
// 点开是留在观众账号里的。所以它有自己的开关、默认关着，而且有一道只合不开的闩。
test('替观众开原字幕是一个单独的开关，默认关着', () => {
  const defaults = repoFile('shared/default-settings.js');
  assert.match(defaults, /autoEnableCaptions:\s*false/);

  // 设置页那一格要写得进去，也要读得回来。
  const options = repoFile('options/options.js');
  assert.match(options, /autoEnableCaptions:\s*elements\.autoEnableCaptions\.checked/);
  assert.match(options, /elements\.autoEnableCaptions\.checked\s*=\s*!!result\.autoEnableCaptions/);
  assert.match(repoFile('options/options.html'), /id="autoEnableCaptions"/);

  // 改了要当场生效，而不是等下一次刷新：字幕这一面靠 CAPTION_SETTING_KEYS 认领
  // 哪些键值得重新 applyCaptionSettings()。
  assert.match(repoFile('content/content-bootstrap.js'), /'autoEnableCaptions'/);
});

test('自动开原字幕过不了两道闸门：开关，和这个站点被不被明令拒绝', () => {
  const engine = repoFile('content/content-video-captions.js');
  const gate = engine.match(/function autoEnableAllowed\(\)[\s\S]*?\n  \}/);
  assert.ok(gate, '找不到 autoEnableAllowed()');
  assert.match(gate[0], /getSetting\('autoEnableCaptions'\)/);
  assert.match(gate[0], /siteRefused/);
  assert.match(gate[0], /state\.autoEnableBlocked/);

  // 闸门问的是「被拒绝了吗」而不是「开着自动翻吗」：视频站点在整页那一面多半是
  // ask，拿 siteAuto 当闸门等于这件事永远不发生。
  assert.equal(/autoEnableAllowed[\s\S]{0,400}?siteAuto/.test(engine), false);

  // 调度层只是转述 SiteRules 的答案，分类留在阶梯那边。
  assert.match(repoFile('content/content-auto-translate.js'), /\.refused === true/);
});

test('观众自己把字幕关掉之后，就不再替他开第二次', () => {
  const engine = repoFile('content/content-video-captions.js');
  const latch = engine.match(/function syncNativeCaptions\(\)[\s\S]*?\n  \}/);
  assert.ok(latch, '找不到 syncNativeCaptions()');
  // 看见开着 → 记下；再看见关了 → 落闩。少了任何一半，1.5 秒一次的心跳会把他
  // 刚关掉的字幕点回来，他关不掉。
  assert.match(latch[0], /state\.sawNativeOn\s*=\s*true/);
  assert.match(latch[0], /state\.autoEnableBlocked\s*=\s*true/);

  // 闩按会话留，sawNativeOn 按视频清：播放器在 SPA 跳转里会把字幕层拆掉重建，
  // 不清的话那一瞬的「不见了」会被读成「他关掉了」。
  const reset = engine.match(/function resetForVideo\(\)[\s\S]*?\n  \}/);
  assert.match(reset[0], /state\.sawNativeOn\s*=\s*false/);
  assert.equal(/autoEnableBlocked\s*=/.test(reset[0]), false, 'resetForVideo 不该动那道闩');

  // 越闩只有一条路：他自己在菜单里按的那一下。
  assert.match(engine, /ctx\.enableNativeCaptions = function[\s\S]*?state\.autoEnableBlocked = false/);
  assert.match(repoFile('content/content-caption-controls.js'), /ctx\.enableNativeCaptions\(\)/);
});

test('allowDisabled 只从 enableNativeCaptions 那条路进来', () => {
  // 它是「把页面只是提供的那几门字幕挑一门出来开」的许可。任何别的调用点拿到
  // 它，默认行为就变成了「替所有人开字幕」，而那是整个功能唯一不可逆的一步。
  const providers = repoFile('content/content-caption-providers.js');
  const calls = providers.match(/syncSelection\((true)?\)/g) || [];
  assert.ok(calls.length >= 3, '至少三处 syncSelection 调用');
  assert.equal(calls.filter((c) => c === 'syncSelection(true)').length, 1);
  const enable = providers.match(/enableNativeCaptions\(\)\s*\{[\s\S]*?syncSelection\(true\)/);
  assert.ok(enable, 'syncSelection(true) 不在 enableNativeCaptions 里');

  // 两个 provider 都得答得上这句话，否则引擎在那种页面上只能干等。
  assert.equal((providers.match(/enableNativeCaptions\(\)\s*\{/g) || []).length, 2);
});

test('往前译有个窗，而且只有花钱的那条路才设窗', () => {
  // 从前是「整条轨道一次译完」：一小时的讲座在观众看到第二句之前就整片发去了云
  // 端，其中绝大多数他不会看到。
  const engine = repoFile('content/content-video-captions.js');
  const window = engine.match(/function translationWindowMs\(\)[\s\S]*?\n  \}/);
  assert.ok(window, '找不到 translationWindowMs()');
  assert.match(window[0], /builtin\.isActive\(\)\) return Infinity/);
  assert.match(window[0], /useNative \? NATIVE_WINDOW_MS : WINDOW_MS/);

  // 窗要真的拦住批次，而不是算出来放着不用。
  assert.match(engine, /function pickNextBatch\(limitMs\)/);
  assert.match(engine, /if \(dist > limitMs\) continue;/);
  assert.match(engine, /pickNextBatch\(limitMs\)/);
});

test('一批译文回来时轨道或代次已经翻篇，就整批丢掉——但键要先放开', () => {
  // getCueKey() 读的是 state **此刻**的值。观众换一门字幕语言或换个目标语言，上
  // 一轮的译文会照着新的那一套键写进缓存——而且因为键是对的，它永远不会被重译掉。
  const engine = repoFile('content/content-video-captions.js');
  const fn = engine.match(/async function translateCues\(cues\)[\s\S]*?\n  \}/);
  assert.ok(fn, '找不到 translateCues()');
  // 键、轨道号、代次，三样都取在 await 之前。
  const beforeAwait = fn[0].slice(0, fn[0].indexOf('await ctx.requestTranslation'));
  assert.match(beforeAwait, /const keys = cues\.map\(\(cue\) => getCueKey\(cue\)\);/);
  assert.match(beforeAwait, /const trackId = state\.trackId;/);
  assert.match(beforeAwait, /const version = sessionVersion\(\);/);
  // 丢掉这一批之前先按当初那一套键放开 pendingKeys。换轨道那一路 clearTrack() 顺
  // 手清过，换目标语言那一路没有——不放开，这几句就永远停在「正在译」上。
  assert.match(
    fn[0],
    /if \(trackId !== state\.trackId \|\| version !== sessionVersion\(\)\) \{\s*\n\s*releaseBatch\(keys\);\s*\n\s*return false;/,
    '过期的一批直接 return 了，pendingKeys 没放开',
  );
  // 条数对不上也整批作废：短一条，尾部那几句会永远留在 pendingKeys 里。
  assert.match(fn[0], /response\.translations\.length !== cues\.length/);
  // 记「正在译」和放开它在同一个函数里，两道早退才不会各自漏一个口子。
  assert.match(beforeAwait, /keys\.forEach\(\(key\) => state\.pendingKeys\.add\(key\)\);/);
  assert.doesNotMatch(engine, /pendingKeys\.add\(getCueKey\(/, 'pendingKeys 又在 translateCues 之外记了一处');
});

test('译文表的键里带着目标语言：换一门语言就是换一套键', () => {
  // 少了这一截，看片中途把目标语言从中文换成日文，已经译过的句子键一个不变，整
  // 段视频继续放着中文，而且因为键是对的，永远不会被重译掉。
  const engine = repoFile('content/content-video-captions.js');
  const fn = engine.match(/function getCueKey\(cue\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, '找不到 getCueKey()');
  assert.match(fn[0], /getTargetLangBase\(\)/, '键里没有目标语言：换语言后旧译文会被当成新语言的');
  assert.match(fn[0], /state\.trackId/);
});

test('菜单里那一项是按情况露出来的，CSS 得让 hidden 真的藏得住', () => {
  // `[hidden]` 的 display:none 只是 UA 规则，菜单项自己那条 `display: flex` 一来
  // 就把它压掉了——JS 照样把 hidden 置上，屏幕上那一行纹丝不动。菜单根节点早就为
  // 同一件事单独写过一条（`#ai-translator-caption-menu[hidden]`），这是第二处。
  const controls = repoFile('content/content-caption-controls.js');
  assert.match(controls, /parts\.nativeItem\.hidden = !needsNative;/);
  const css = repoFile('content/content.css');
  assert.match(
    css,
    /#ai-translator-caption-menu \.ai-translator-caption-menu-item\[hidden\]\s*\{\s*display:\s*none;/,
    '菜单项缺 [hidden] 规则：JS 藏不住它'
  );
});
