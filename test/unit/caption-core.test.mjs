// Guards for shared/caption-core.js — the site-independent half of subtitle
// translation, and the boundary that keeps it that way.
//
// Subtitle translation used to be one YouTube-shaped file. It is now an engine
// (content/content-video-captions.js plus the content/captions/ family it loads)
// alongside providers (content/content-caption-providers.js) that answer
// "can I supply cues here?".
// The two things that rot in that arrangement are asserted here rather than
// eyeballed: the cue shape every provider has to produce, and the rule that
// picks which provider gets the page.
//
// 引擎那一面的守卫——替观众开原字幕的开关与闩、播放器菜单那一行、往前译的窗、
// 译文表的键——在 caption-engine.test.mjs；这一份问的是核心与边界本身。
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { captionEngineSource } from './helpers/sources.mjs';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// No `export` — it is also loaded as a classic script by the content scripts,
// so importing it for its side effect publishes globalThis.CaptionCore.
await import('../../shared/lang-tags.js');
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

test('「有人在放字幕」是 showing 和 hidden 两种，判定只此一处', () => {
  // 和 pickSubtitleTrack 偏好的是同一对模式：showing 是浏览器在画，hidden 是播
  // 放器自己在画（video.js / Vimeo / JW 都这样），在观众眼里都是「字幕开着」。
  // 两边要是各写各的，provider 就会去问「要不要替你开字幕」——而它正开着。
  assert.equal(core.hasActiveSubtitleTrack([entry('showing', 'fr')]), true);
  assert.equal(core.hasActiveSubtitleTrack([entry('disabled', 'en', true), entry('hidden', 'fr')]), true);
  assert.equal(core.hasActiveSubtitleTrack([entry('disabled', 'de'), entry('disabled', 'en', true)]), false);
  assert.equal(core.hasActiveSubtitleTrack([]), false);
  assert.equal(core.hasActiveSubtitleTrack(undefined), false);
  assert.equal(core.hasActiveSubtitleTrack([{}, { track: null }]), false);
});

test('手里没轨道不等于「页面没开字幕」——要去问页面', () => {
  // 字幕翻译默认是关着的，那时 TextTrackProvider 只是个候选，attach 从来没跑
  // 过，tt.track 一直是 null。菜单的状态行却每一拍都画：把「我手里没有」答成
  // 「原字幕关着」，屏幕上明明压着一条 <track> 字幕，菜单偏说「未检测到字幕
  // 轨」——因为功能关着的时候那一行「开启原字幕」本身是藏起来的
  // （refreshMenu），状态行只剩下那句最没用的话。
  const providers = repoFile('content/content-caption-providers.js');
  const generic = providers.slice(providers.indexOf('const TextTrackProvider = {'));
  const probe = generic.match(/nativeCaptionsState\(\) \{[\s\S]*?\n    \},/);
  assert.ok(probe, '找不到 TextTrackProvider.nativeCaptionsState()');
  assert.match(
    probe[0],
    /if \(tt\.track\) return tt\.track\.mode !== 'disabled';/,
    '手里有轨道的时候，答案就是那条轨道',
  );
  assert.match(
    probe[0],
    /return core\.hasActiveSubtitleTrack\(subtitleEntries\(TextTrackProvider\.getVideo\(\)\)\);/,
    '手里没轨道的时候没去问页面自己的轨道',
  );
});

test('「开启原字幕」要把观众自己选的那条开回来，不是重挑一条', () => {
  // allowDisabled 只从这一条路进来。观众本来在看第四门语言，自己把字幕关了，再
  // 按这一行：所有轨道都 disabled，挑选器于是按「声道语言 / default / 第一条」
  // 往下走，开回来的是页面列在最前面的那门——一次改语言，伪装成一次开字幕。
  const providers = repoFile('content/content-caption-providers.js');
  const sync = providers.match(/function syncSelection\(allowDisabled\) \{[\s\S]*?\n  \}/);
  assert.ok(sync, '找不到 syncSelection()');
  assert.match(
    sync[0],
    /const heldEntry = tt\.track \? entries\.find\(\(entry\) => entry\.track === tt\.track\) : null;/,
  );
  assert.match(
    sync[0],
    /const reopenHeld = !!\(allowDisabled && heldEntry && !core\.hasActiveSubtitleTrack\(entries\)\);/,
    '重开那条路没有优先认手里攥着的轨道，或者没有让位给已经开着的轨道',
  );
  assert.match(sync[0], /const picked = reopenHeld \? heldEntry : core\.pickSubtitleTrack\(/);
  // 同一个 heldEntry 也是下面那道「我们还在这条轨道上」的依据：两处各算一遍，
  // 迟早会算出两个答案来。
  assert.match(sync[0], /const holding = !!heldEntry && !heldOff;/);
  assert.equal(/entries\.some\(\(e\) => e\.track === tt\.track\)/.test(sync[0]), false);
});

test('页面把那个 <video> 换掉了，手里攥着的东西全得放开', () => {
  // SPA 换一条视频：旧的 <video> 从文档里摘走，可它身上的轨道原样还在——脱离文
  // 档、没人看得见，却照样有问必答。我们留在它身上那条 hidden 轨道会答「原字幕
  // 开着」，于是 autoEnableCaptions 再也不会替新视频开字幕；浮层问 getVideo()
  // 要的是一个谁也看不见的框；引擎手里那批 cue 还钉在一部放完了的片子上。
  const providers = repoFile('content/content-caption-providers.js');
  const stale = providers.match(/function releaseStaleVideo\(nextVideo\) \{[\s\S]*?\n  \}/);
  assert.ok(stale, '找不到 releaseStaleVideo()');
  assert.match(stale[0], /releaseTrack\(\);\n\s*tt\.video = nextVideo \|\| null;/, '轨道和视频要一起放开');
  assert.match(
    stale[0],
    /if \(heldTrack && tt\.engine && tt\.engine\.reset\) tt\.engine\.reset\(\);/,
    '没告诉引擎——新视频一条轨道都没开的时候，谁也不会替它清掉旧的 cue',
  );
  // 放开要排在 releaseTrack 之后：setNativeCaptionsHidden(false) 认 tt.track，
  // 先清掉才不会把旧轨道的模式再动一次。
  assert.ok(stale[0].indexOf('releaseTrack();') < stale[0].indexOf('tt.engine.reset()'));

  const sync = providers.match(/function syncSelection\(allowDisabled\) \{[\s\S]*?\n  \}/);
  assert.match(
    sync[0],
    /if \(tt\.video && tt\.video\.isConnected === false\) releaseStaleVideo\(null\);/,
    '页面把元素摘走了这一种没认出来',
  );
  assert.match(
    sync[0],
    /if \(tt\.track && !entries\.some\(\(entry\) => entry\.track === tt\.track\)\) releaseStaleVideo\(video\);/,
    '元素还在、轨道换了一套这一种没认出来',
  );
  // 两道都要排在读它之前：下面每一行都是在拿手里那条轨道算事情。
  assert.ok(sync[0].indexOf('releaseStaleVideo(video)') < sync[0].indexOf('const heldEntry'));
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
  const engine = captionEngineSource();
  assert.match(engine, /core\.buildTranslationRequest\(/);
  assert.equal(
    engine.includes("type: 'TRANSLATE_BATCH_FAST'"),
    false,
    '字幕引擎自己拼了一份请求，没走 buildTranslationRequest',
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
  // 引擎拆成了一族：入口加 content/captions/ 下的几份。清单从磁盘列出来再比对，
  // 于是新加一份而忘了写进 manifest 会在这里停下 —— 内容脚本是普通脚本，漏装只会
  // 安静地少掉几个函数，不会报错。
  const family = readdirSync(fileURLToPath(new URL('../../content/captions', import.meta.url)))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `content/captions/${name}`);
  assert.ok(family.length > 0, 'content/captions/ 空了？');
  for (const file of ['shared/caption-core.js', 'content/content-caption-providers.js',
    'content/content-video-captions.js', ...family]) {
    assert.ok(bundle.includes(file), `manifest.json must inject ${file}`);
  }
  assert.ok(
    !bundle.includes('content/content-youtube-captions.js'),
    'the YouTube-only module is gone — its engine half is content-video-captions.js',
  );
  // Order matters: every consumer reads globalThis.CaptionCore at load time.
  assert.ok(bundle.indexOf('shared/caption-core.js') < bundle.indexOf('content/content-caption-providers.js'));
  for (const file of [...family, 'content/content-video-captions.js']) {
    assert.ok(bundle.indexOf('shared/caption-core.js') < bundle.indexOf(file), `${file} 排在 caption-core 前面了`);
  }
  // 这一族自己也有一条：state.js 挂的那张表是其余几份装载时就读走的。
  for (const file of family.filter((f) => f !== 'content/captions/state.js')) {
    assert.ok(bundle.indexOf('content/captions/state.js') < bundle.indexOf(file), `${file} 排在 captions/state.js 前面了`);
  }
});

test('no consumer re-declares the shared caption logic', () => {
  // The whole point of the split is that adding a site means adding a provider,
  // not another copy of the parsing/segmenting/selecting. Keep exactly one
  // definition of each — same rule shared/api-compat.js is held to.
  const shared = ['parseVtt', 'parseJson3', 'parseSrv3', 'parseCaptionPayload',
    'buildSegments', 'buildBatches', 'fromTextTrackCues', 'mergeRawCues',
    'selectProvider', 'pickSubtitleTrack', 'buildTranslationRequest'];
  for (const [file, src] of [['字幕引擎那一族', captionEngineSource()],
    ['content/content-caption-providers.js', repoFile('content/content-caption-providers.js')]]) {
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
  const engine = captionEngineSource();
  for (const marker of ['ytp-', 'youtube.com', 'yt-navigate', 'timedtext']) {
    assert.equal(engine.includes(marker), false, `字幕引擎里出现了 ${marker}`);
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
  // 引擎的第一份是 content/captions/state.js —— 比对它，而不是比对入口文件。
  assert.ok(manifest.indexOf('content/content-caption-controls.js') < manifest.indexOf('content/captions/state.js'));
});
