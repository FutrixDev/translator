# Video Subtitle Translation Beyond YouTube — Design + Site Survey

**Goal**
Turn the YouTube-only caption feature into one engine with a small provider per
way of getting cues, and add a provider for the standard `<track>`/`TextTrack`
API so any player carrying its own subtitle track works with no per-site code.

Supersedes the scope line in
[2026-01-21-youtube-caption-translation-design.md](2026-01-21-youtube-caption-translation-design.md)
("Scope: YouTube only", "Non-Goals: non-YouTube sites"). Everything else in that
document — bilingual rendering, no auto-enabling of captions, skip when the
track language is the target language — still holds and is now enforced for
every site at once.

## How subtitles reach a page

The survey below sorts sites into four classes:

| class | how the page gets subtitles | what it costs us |
| --- | --- | --- |
| **A** | a `TextTrack` the browser holds — `<track>` elements, or tracks a player creates from HLS/DASH and feeds itself | nothing per site |
| **B** | a sidecar the player fetches and renders itself, never becoming a `TextTrack` (site JSON APIs, some HLS players) | MAIN-world network observation, per site |
| **C/D** | no text subtitles at all, or burned-in / DRM-protected | out of reach |

## Survey

Probed with headless Chrome: load, play, wait, then read every frame's
`<video>`, its `textTracks`, and every subtitle-shaped request.

| site | class | what was seen |
| --- | --- | --- |
| developer.apple.com (WWDC) | **A** | 4 subtitle `TextTrack`s (en showing with cues, zh/ja/ko hidden) — created by the player from the HLS manifest, which also fetches `.webvtt` sidecars |
| player.vimeo.com | **A** | 4 `<track>` elements (de/es/en/fr), all `disabled` until the viewer turns CC on |
| developer.mozilla.org (`<track>` docs) | **A**, iframe only | `captions` track, `showing`, 5 cues — inside an `mdnplay.dev` iframe |
| videojs.com | — | one `metadata` "thumbnails" track and no subtitles; correctly ignored |
| ocw.mit.edu | mixed | YouTube `<iframe>` embed, plus the course's own `.vtt` sidecar |
| khanacademy.org | — | `youtube-nocookie.com` iframe; note `hostname.includes('youtube.com')` does **not** match that host |
| arte.tv | **B** | HLS manifest advertises subtitle renditions |
| bilibili.com | **B** | own JSON subtitle API (`/x/v2/subtitle/web/view`), blob video, no tracks |
| dailymotion.com | **C/D** | cross-origin player iframe, no tracks, no subtitle fetches |
| netflix.com | **C/D** | DRM |
| TED, vimeo.com, PBS, NYT, BBC, Coursera | unclassified | headless was bot-blocked before a `<video>` appeared |

Two findings decided the scope.

**Class A is bigger than it looks.** A player that plays HLS through
`hls.js`/MSE still calls `addTextTrack()` and pushes cues into it — Apple's own
site is exactly that shape, and it lands in class A with cues already parsed.
So "HLS subtitles" is not by itself a class B problem; only players that fetch a
sidecar and draw it *without* a `TextTrack` are.

**The iframe gap is the real limiter.** Four of the reachable sites put the
player in an iframe, and `manifest.json` declares no `all_frames`, so the
content scripts never run there. That gap costs more coverage than class B
would win.

## Architecture

One engine, one overlay, a provider per source of cues.

- `shared/caption-core.js` — the pure half: VTT/json3/srv3 parsing, cue
  conversion, sentence segmentation, batching, provider selection, track
  choice, and the translation request. Loadable by Node, so `npm run test:unit`
  covers it with no browser.
- `content/content-video-captions.js` — the engine: cue ingestion, translation
  scheduling, the bilingual overlay and its drag/resize/persistence, hiding the
  page's own line, and the media/track-list watching that decides when a
  provider can attach.
- `content/content-caption-providers.js` — the providers. Each answers:
  `canActivate()`, `attach(engine)` → `engine.ingestTrack()`, `getVideo()`,
  `isCaptionsEnabled()`, `getOverlayHost()`, `setNativeCaptionsHidden()`.

`YouTubeProvider` keeps the five things that were only ever true of YouTube:
`/api/timedtext` observed through the MAIN-world interceptor (the endpoint is
gated by a proof-of-origin token only the player can mint), the
`.ytp-subtitles-button` state, the `.ytp-caption-window-container` mount, the
class that hides the native caption windows, and the SPA navigation reset.

`TextTrackProvider` is the generic one: it activates wherever a `<video>`
exposes subtitle/caption tracks, holds the chosen track at `mode = 'hidden'` so
cues keep loading while the browser draws nothing, and feeds
`cue.startTime/endTime/text` in as `{startMs, endMs, text}`.

### Decisions worth keeping

- **We translate the subtitles the viewer already has on; we never turn
  subtitles on.** `showing` and `hidden` both mean on (`hidden` is a player
  drawing cues itself); `disabled` is a language the page merely offers.
  `pickSubtitleTrack()` returns null rather than choose among disabled tracks —
  Vimeo lists four, and picking one would put German on an English video that
  nobody asked to subtitle. The provider stays attached and adopts the moment a
  mode changes.
- **A track goes back the way it was found**, via `restoreMode` on detach. The
  one exception: a track the viewer disabled while we held it is left alone.
  Restoring that one would turn subtitles back on, and the next frame would read
  that as consent — an off/on flip for as long as the video played.
- **The track's own language is sent as `sourceLang`.** A subtitle line is a few
  words, too short to identify; left to detection the engine falls back to the
  language of the *page*, and a Chinese-UI site playing an English talk answers
  `zh` — the line is read as already translated and handed back untouched.
- **The overlay is a fixed-position host pinned to the video's rect**, not a
  wrapper around the `<video>`: reparenting the element breaks players that
  manage their own DOM. On `fullscreenchange` it reparents into the fullscreen
  element, except for a fullscreen `<video>`, which renders no children — there
  it is promoted to the top layer with `popover="manual"`.
- **Storage keys keep their `youtube` names** (`enableYoutubeCaptionTranslation`,
  `youtubeCaption*`, `showYoutubeOriginalCaption`). They are user data; renaming
  them would discard every existing user's caption position, size and colours.

## Class B — evaluated, not built

Not worth building yet, on the survey's evidence:

- Its strongest-looking candidate (Apple) is already class A, because the player
  creates real `TextTrack`s from the HLS subtitle renditions.
- What is left is site-specific: bilibili's JSON API, arte's manifest. Each needs
  its own parser and its own match pattern — i.e. a provider, which the registry
  now makes a contained addition rather than a second engine.
- The cost is not shared. Observing network traffic needs a MAIN-world
  `document_start` script, and **its match patterns must stay a curated
  allowlist**. Broadening the interceptor to `<all_urls>` would monkey-patch
  `fetch`/`XHR` on every page the user visits: a performance cost on pages with
  no video at all, a compatibility risk with every site that wraps those APIs
  itself, and a store-review liability — for coverage the `TextTrack` path
  already gives.

When a class B site is worth supporting, add: one provider, one MAIN-world entry
in `manifest.json` matched to that host, one parser in `caption-core.js`.

## `all_frames` — evaluated, deferred

Four of the reachable sites (MDN, MIT OCW, Khan Academy, Dailymotion) play their
video inside an iframe, where no content script runs today. Enabling
`all_frames` on the existing entry is the wrong way to close that: it would run
the whole 18-file bundle — selection UI, float ball, hover translation, page
translation, comic translation — in every ad and tracking frame on every page.

The shape that would work is a separate caption-only content-script entry with
`all_frames: true`, carrying only `i18n/messages.js`, `shared/caption-core.js`,
the providers and the engine. That needs the engine's dependency on the full
content bootstrap (`window.AI_TRANSLATOR_CONTENT`: settings, messaging, target
language) factored into something a frame can load on its own, plus a rule for
which frame owns the overlay when several claim a video. That is its own change,
with its own tests, and it is deliberately left out of this one.
