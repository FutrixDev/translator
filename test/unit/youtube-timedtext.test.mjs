// Guards for shared/youtube-timedtext.js — whose captions a player request is for.
//
// A player fetches more than one video's captions through the same endpoint:
// an ad plays in the same element, with no navigation, and brings its own
// track. The player says which video the page is for; the request says which
// video the payload is for. These tests are that comparison, and the track id
// that comes out of it.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contentBundle } from './helpers/sources.mjs';

const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// No `export` — it is loaded as a classic script by the content scripts, so
// importing it for its side effect publishes globalThis.YouTubeTimedText.
await import('../../shared/youtube-timedtext.js');
const { trackOf } = globalThis.YouTubeTimedText;

const captionUrl = (query) => `https://video.example/api/timedtext?fmt=json3&${query}`;

test('a caption request for the video on the page names its track', () => {
  assert.deepEqual(trackOf(captionUrl('v=abc123&lang=en'), 'abc123'), {
    trackId: 'abc123|en|||',
    lang: 'en',
  });
});

test('a caption request for any other video is not a track of this page', () => {
  assert.equal(trackOf(captionUrl('v=adxyz&lang=en'), 'abc123'), null);
  assert.equal(trackOf(captionUrl('lang=en'), 'abc123'), null);
});

test('with no word from the player, no request is taken for this page’s', () => {
  // Guessing here is what puts an ad's lines on the video's timeline.
  assert.equal(trackOf(captionUrl('v=abc123&lang=en'), ''), null);
  assert.equal(trackOf(captionUrl('v=abc123&lang=en'), undefined), null);
});

test('two tracks of one language are two tracks', () => {
  const id = (query) => trackOf(captionUrl(`v=abc123&${query}`), 'abc123').trackId;
  const ids = [
    id('lang=en'),
    id('lang=en&kind=asr'),
    id('lang=en&name=Commentary'),
    id('lang=en&tlang=de'),
    id('lang=de'),
  ];
  assert.equal(new Set(ids).size, ids.length);
  // Parameters that change per request, not per track, are not part of it.
  assert.equal(id('lang=en&pot=ONE&fmt=json3'), id('pot=TWO&lang=en'));
});

test('a track the player translated is in the language it was translated into', () => {
  assert.equal(trackOf(captionUrl('v=abc123&lang=en&tlang=de'), 'abc123').lang, 'de');
});

test('a relative caption request is read against the page, and an unreadable one is refused', () => {
  assert.deepEqual(
    trackOf('/api/timedtext?v=abc123&lang=ja', 'abc123', 'https://video.example/watch'),
    { trackId: 'abc123|ja|||', lang: 'ja' },
  );
  assert.equal(trackOf('/api/timedtext?v=abc123&lang=ja', 'abc123'), null);
  assert.equal(trackOf(undefined, 'abc123'), null);
});

// A content script is a classic script: one that is missing from the manifest,
// or listed after its reader, fails silently — the reader finds no global and
// the page just never gets subtitles.
test('the content scripts load it, and before the provider that reads it', () => {
  const bundle = contentBundle();
  const at = bundle.indexOf('shared/youtube-timedtext.js');
  assert.ok(at >= 0, 'manifest.json must inject shared/youtube-timedtext.js');
  assert.ok(at < bundle.indexOf('content/content-caption-providers.js'));
});

test('the provider asks it, and reads no caption URL of its own', () => {
  const providers = repoFile('content/content-caption-providers.js');
  assert.match(providers, /globalThis\.YouTubeTimedText/);
  assert.match(providers, /\.trackOf\(/);
  assert.equal(/searchParams/.test(providers), false, 'a second reading of the caption URL has appeared in the provider');
});
