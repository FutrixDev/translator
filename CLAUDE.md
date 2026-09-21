# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blab Translation is a Chrome Extension (Manifest V3) that translates web content using OpenAI-compatible APIs. It supports selection translation, full-page translation, and a floating ball UI.

## Commands

```bash
npm run icons      # Generate extension icons (requires canvas package)
npm run zip        # Create distributable zip file
npm run test:unit  # Fast, no browser — API compatibility rules (test/unit/)
npm run test:e2e   # Playwright, loads the extension in Chrome (test/e2e/)
npm run test:headed # Same, but with a visible window (HEADED=1)
npm test           # test:unit + test:e2e
```

E2E runs headless by default, so it no longer steals window focus and the
pointer. That needs `channel: 'chromium'` in `test/e2e/fixtures.js` — the
bundled Playwright build still cannot load an unpacked extension headless,
only Chrome's newer headless shell can.

No build step required - the extension loads directly in Chrome as an unpacked extension.

**To test changes**: Load unpacked extension in Chrome via `chrome://extensions/` with Developer Mode enabled, then reload after changes.

## Architecture

### Component Communication Flow

```
[Popup/Options] <--chrome.storage--> [Background Service Worker] <--messages--> [Content Script]
                                            |
                                            v
                                    [OpenAI-compatible API]
```

### Main Components

1. **Background Service Worker** (`background/background.js`)
   - Handles all API requests to translation endpoints
   - Manages context menus and theme icon updates
   - Three translation methods: single, batch (numbered `[1]...[2]...`), fast batch (delimiter-based)
   - Stores default settings and translation prompts

2. **Content Script** (`content/content.js`)
   - Injected into all webpages for DOM interaction
   - Text extraction with code/math detection
   - Batch translation with concurrency control (8 workers, max 2500 chars or 25 items per batch)
   - UI components: selection button, float ball, translation popup, progress bar

3. **Popup** (`popup/`) - Quick access panel for common actions

4. **Options** (`options/`) - Full settings page with API configuration and feature toggles

5. **i18n** (`i18n/messages.js` + `i18n/lang/<tag>.js`) - one string table per
   language, registered onto one catalog; `messages.js` holds only the lookup and
   the UI-language resolution. Every load list carries all ten, in any order.

### Key Technical Patterns

- **Math formula preservation**: Detects MathJax/KaTeX elements, replaces with placeholders during translation, restores after
- **Code detection**: Regex patterns skip non-human text (code blocks, JSON, Markdown syntax)
- **Storage**: Chrome sync storage for cross-device settings
- **Theming**: CSS variables for dark/light theme support
- **Host-page containment**: our panels are a subtree of the page's own
  document, so every page rule on a bare tag matches them too — example.com
  ships `div { opacity: .8 }`, and every page builder ships
  `.kit button { … }` plus a heavier `.kit button:hover` twin. One scoped reset
  at the top of `content/css/popup.css` — the first of the twelve stylesheets
  the manifest injects, and that array's order *is* the cascade order — is the
  boundary, and specificity is a four-step band with no `!important` in it:

  ```
  theme base (0,1,1) < theme state (0,2,1) < the reset (0,2,2) ≤ ours (0,2,2)
  ```

  So **a new panel root has to be added to the reset's `:is()` lists**, and a
  new rule for a control needs `html body` plus its panel root
  (`html[data-ai-translator-theme="light"] body …` for a light override) or the
  theme's `:hover` takes back every property the rule leaves to the base rule.
  Guarded by `test/unit/host-css-containment.test.mjs` and the
  hostile-stylesheet spec in `test/e2e/input-translation.spec.js`.

### Account-Backed Features

Comic translation and PDF translation are the two features that do NOT use the
user's own API key: they run on our servers against a monthly free page
allowance, so both require a signed-in account. That makes their switches a
preference with a precondition, and the two halves live in different storage
areas on purpose:

| what | where | scope |
| --- | --- | --- |
| `enableComicTranslation` / `enablePdfTranslation` | `chrome.storage.sync` | per account |
| `comicToken` | `chrome.storage.local` | per device |

**A device with no token has both features off, whatever sync says.** That
answer is derived on every read by `shared/account-gate.js` — never written back
to sync. A new install syncs the switches down before it has ever signed in
(PDF ships on), so a signed-out device that "corrected" the preference would
reach across and disable the feature on the device that is still signed in.

Every surface that reads either switch must run it through
`AccountGate.applyAccountGate()` first: the options page, the popup, the content
scripts and the service worker's context menu entries all do, and
`npm run test:unit` asserts each of them loads the module. The one deliberate
exception is `assertFeatureEnabled()` in `background.js`, which judges the raw
switch — the account half is enforced one layer down, where `apiFetch` answers a
create with no token as `unauthorized`, and every surface turns that into a
sign-in offer.

### Video Subtitle Translation

One engine, one overlay, and a small provider per way of getting cues. The
engine — `content/content-video-captions.js` — owns everything that is the same
on every site: sentence segmentation, batching, the bilingual overlay and its
drag/resize/persistence, hiding the page's own line, and re-mounting on
fullscreen. `shared/caption-core.js` holds the pure parts of that (VTT/json3/srv3
parsing, cue merging, batching, track choice, the translation request) so
`npm run test:unit` can exercise them with no browser.

**Subtitles have no switch of their own.** Whether we translate them at all is
the same gate the page text goes through — the main `autoTranslate` switch plus
this site's rule — and the engine reads it off the scheduler's snapshot
(`siteRefused()` in `content/content-video-captions.js`, subscribed through
`ctx.autoTranslate.onStateChange`, which is why `ctx.init` starts the scheduler
first). It asks `siteRefused`, **not** `siteAuto`: video sites are not on the
built-in Always list, so the page-text answer there is usually `ask` and
`siteAuto` is permanently false — gating on it would mean subtitles never work
where they matter most. What has to be true is only that this site is not
*refused* (`GLOBAL_OFF` / `BLOCKLIST` / `USER_NEVER`, the `REFUSALS` list in
`shared/site-rules.js`). Anything the answer is not yet — the scheduler has not
decided, or `ctx.autoTranslate` is not up — counts as refused: this step sends
the page's text to a third party, and "not decided yet" must not look like yes.

The in-player menu's first row and the popup's site row are therefore the same
sentence, and go through one implementation, `SiteRules.setSiteAuto()`. That row
draws and writes **`siteAuto`**, not the gate — on an ordinary video site with no
rule the gate is open while `siteAuto` is false, so drawing the row from the gate
would show it on and a click would then write a permanent `never`. The engine
hands both down in `controls.sync({ enabled, siteAuto })` and the controls layer
recomputes neither, because a second computation is a second answer. Two things
the row cannot write are greyed out (`ruleWritable()`): a blocklisted host, where
`BLOCKLIST` outranks `USER_ALWAYS`, and a host `normalizeHost()` cannot turn into
a key — `file://` pages have no hostname, and there the rule would silently not
be stored while the "also open the main switch" half still ran.
`SiteRules.setSiteAuto()` throws on such a host rather than half-succeeding.

A provider in `content/content-caption-providers.js` answers four questions:

| question | method |
| --- | --- |
| can I supply cues on this page? | `canActivate()` |
| here are the cues | `attach(engine)` → `engine.ingestTrack()` |
| where does the overlay go? | `getOverlayHost()` / `syncOverlayHost()` |
| how do I get the page's own captions out of the way? | `setNativeCaptionsHidden()` |

`CaptionCore.selectProvider()` picks the highest-priority one that says yes.
Two ship today:

- **`YouTubeProvider`** — YouTube gates `/api/timedtext` behind a
  proof-of-origin token only its player can mint, so the cues are observed from
  the player's own response by the MAIN-world interceptor
  (`content/youtube-timedtext-interceptor.js`, matched to `*://*.youtube.com/*`
  alone — see below). It mounts into the player's caption layer.
- **`TextTrackProvider`** — the standard `<track>`/`TextTrack` API, so it needs
  no per-site code at all. It mounts a fixed-position host pinned to the
  `<video>` rect rather than wrapping the element, because reparenting a
  `<video>` breaks players that manage their own DOM.

Two rules the generic provider exists to keep:

- **We translate the subtitles the viewer already has on, and by default we
  turn none on ourselves.** A track at `showing` or `hidden` is on (`hidden` is a
  player drawing the cues itself); everything at `disabled` is a language the
  page merely offers, and `pickSubtitleTrack()` returns null rather than choose
  among them. Vimeo lists four and shows none.

  The exception is `autoEnableCaptions` — off by default, and the only
  automation in the extension that changes the **player's own** state rather
  than adding nodes of ours, which is why it is a switch of its own. With it on,
  `pickSubtitleTrack({allowDisabled, audioLang})` may promote a disabled track:
  audio-language match, then `default`, then the first. `allowDisabled` is a
  permission for one call, never a mode a provider stays in — the engine asks
  for it (`enableNativeCaptions()`), so the engine can stop asking.

  **Re-opening is not choosing.** Those rungs pick a track for a viewer who has
  none; a viewer pressing 「开启原字幕」 after switching his own off already made
  that choice. So with every track at `disabled`, the one we are still holding
  wins over the rungs — otherwise the row that exists to give his subtitles back
  hands him whichever language the page listed first, a language change wearing
  the clothes of a re-enable. The rungs take over only when we hold nothing,
  and any track still at `showing`/`hidden` outranks both: the page has moved on
  and that one is the current answer.

  **And it is a latch that only closes.** `syncNativeCaptions()` runs on the
  1.5s controls heartbeat, so a viewer who switches subtitles off and sees them
  return cannot switch them off at all. Seeing captions on and then off sets
  `autoEnableBlocked` for the rest of the session — whoever turned them on, from
  the viewer's side those are the same event. `sawNativeOn` clears per video;
  the block does not. The one way past it is the menu's 「开启原字幕」
  (`ctx.enableNativeCaptions()`), which is the viewer asking.

  Two things that look like details and are not. **A provider answers three
  questions, and only one of them is a command.** `nativeCaptionsState()` says
  whether subtitles are on right now — `true`, `false`, or `null` for "the
  player is not up yet, ask again"; `enableNativeCaptions()` turns them on and
  answers plain yes/no; `canEnableNativeCaptions()` says whether the viewer
  could turn them on, `null` when there is nothing to judge by. And
  `nativeCaptionsState()` is a question about **the page**, not about us: the
  generic provider is a candidate on every page with a `<video>`, the status
  line is drawn whether or not subtitle translation is switched on, so holding
  no track of our own it reads the video's own track modes
  (`CaptionCore.hasActiveSubtitleTrack()` — the same `showing`/`hidden` pair the
  picker prefers, written once so the two cannot disagree). Answering "off"
  there told a viewer with subtitles on his screen that no subtitle track was
  detected. Which makes the other half a rule of its own: **what we
  hold is dropped the moment it stops being the page's video**
  (`releaseStaleVideo()`, on both a removed element and a track list that is no
  longer ours). A `<video>` an SPA swapped out keeps its tracks, and one of ours
  left at `hidden` on it would answer "subtitles are on" for a film that
  finished — which is exactly what would stop `autoEnableCaptions` turning them
  on for the video now playing. **Nothing a
  provider says about the player is written down.** Both probes are asked fresh
  on every beat, because every answer they give can change on the next one: a CC
  button mounts disabled while the player loads, and a reading of `false` kept
  from that moment would hide the menu's retry row for the rest of the video.
  The only thing recorded is what we did — a successful `enableNativeCaptions()`
  sets `sawNativeOn` on the spot, so a viewer who switches the new captions off
  within the 1.5s beat is not overridden. The same rule reaches past the
  providers: "this track is already in the target language" is `sameLanguage()`,
  computed on every read, because the viewer can change the target halfway
  through a video and nothing would go back to revise a stored answer — and it
  compares **whole tags**, through `LangTags.isSameLanguage()`. `zh-CN` and
  `zh-TW` share a base code and are two writing systems, so base equality would
  answer "already in your language" to exactly the conversion the viewer wants;
  the cue cache is keyed on the whole tag for the same reason. That judgement
  is **not the caption engine's own** — `shared/lang-tags.js` is the single
  owner, and `SiteRules.decide()` and `content/page/batch.js` ask the same one,
  so a page and its subtitles can no longer answer "is this already your
  language?" differently on the same tab. Anything that loads
  `shared/caption-core.js` or `shared/site-rules.js` must load `lang-tags.js`
  first; both throw at load without it, and `test/unit/site-rules.test.mjs`
  checks the order in all four load lists. For page text there is one more
  step before that question can be asked at all: `chrome.i18n.detectLanguage`
  answers a plain `zh` for both scripts (measured in the e2e Chrome — 100%,
  `isReliable`, no subtag), so `LangTags.refineScript()` reads the script off
  the characters and only then is the tag whole enough to compare. Its table
  holds only characters that exist on one side and not the other — 后, 几, 台,
  里 are ordinary Traditional words, and a table containing them would read a
  Traditional page as Simplified. That refinement belongs to
  `detectLanguageOf()` in `content/content-translation-engine.js`, not to any
  one caller, because the built-in engine asks the same question again one
  layer below the gate: it knows Simplified (`zh`) and Traditional
  (`zh-Hant`) as two languages, and a bare `zh` source against a `zh` target
  trips its own equal-language short-circuit — the gate opens and the page
  still comes back untranslated. Both harnesses that load the engine in Node
  (`test/unit/helpers/engine-harness.mjs`,
  `test/unit/builtin-translator-stall.test.mjs`) must load `lang-tags.js`
  first. And **the
  heartbeat runs all of this ahead of `captionPlayerButton`**:
  hiding our icon and turning subtitles on are separate settings, but
  `syncControls()` is the only thing driving either, and it returns early on the
  first.
- **A track is put back the way the viewer would want it.** We hold it at
  `hidden`, not `disabled`, so cues keep loading; `restoreMode` goes back on
  detach. Usually that is the mode we found it in, with two exceptions, one at
  each end:
  - A track the viewer disabled while we held it stays disabled. Restoring it
    would turn subtitles back on, and we would read that as consent, forever.
  - A track we hold **because** he asked for it (`enableNativeCaptions()` on a
    `disabled` track — the menu row, or `autoEnableCaptions`) goes back at
    `showing`. Its found mode was `disabled`, so restoring that would switch
    subtitles off the moment we let go — in "original only", or when he turns
    translation off — taking away the thing he just asked for.

**Do not broaden the MAIN-world interceptor's match patterns to `<all_urls>`.**
Patching `fetch`/`XHR` on every page is a performance, compatibility and
store-review cost, and it buys nothing the `TextTrack` path does not already
give. A site that needs network observation gets its own match pattern.

Storage keys still read `youtubeCaption*` / `showYoutubeOriginalCaption` on
purpose: renaming them would drop the settings of everyone who already has the
feature on. (`enableYoutubeCaptionTranslation` is gone — the feature no longer
has a switch of its own, see above. The key is simply never read again; there is
no migration, because a stale value in sync storage that nothing consults costs
nothing, and a migration that runs on every profile can only lose data.)

### Image OCR

Right-click an image → read the text in it. **Two separable steps, and keeping
them separable is the whole design:**

1. **Recognise.** Two engines behind one contract, `{text, language}`:
   - **`local`** (the default) — Tesseract WASM, `vendor/tesseract/`, running in
     `offscreen/`. Free, offline, no API key. A service worker may not spawn a
     nested Worker or instantiate this WASM, which is the only reason the
     offscreen document exists; MV3 also needs `wasm-unsafe-eval` in
     `content_security_policy.extension_pages` and every path pinned
     (`corePath`/`workerPath`/`langPath`, `workerBlobURL:false`, `gzip:false`)
     because Tesseract's defaults fetch from a CDN.
   - **`vision`** — the user's own vision model, through the same
     `shared/api-compat.js` builders as everything else.
2. **Translate — optional, and not in either engine.** The content script runs
   it on the recognised text through `ctx.translateText`, the ordinary path.
   Always recognise-first: every entry point sends `translate: false`, the popup
   shows the recognised text with a Translate button for step 2. There is no
   auto-translate setting and no user-facing OCR language setting — nobody can
   pre-declare what language an arbitrary image will contain, so the local
   engine's languages come from the UI language (`resolveOcrLanguagePlan`) and
   the text's actual language is detected after recognition.

**A vision model could translate in the same call; it deliberately does not.**
One shape for one engine and two for the other would fork every caller, and it
would cut the free built-in Translator out of the vision path. Recognise-only is
a complete result, so it has a real terminal popup (`recognizeOnly`), not a
blank half.

`shared/ocr.js` is the pure half and owns everything two surfaces would
otherwise restate: the bundled language catalog (`OCR_LANGUAGES` — a language is
only usable if its `.traineddata` is in `vendor/tesseract/lang`, which
`npm run test:unit` asserts), `DEFAULT_OCR_ENGINE`, the retry ladder's tuning
(rescale rungs, acceptance bar, pass competition), the vision prompt and its
tolerant parser, the encoding limits, and `shouldTranslate`.

Two things it deliberately does not own:

- **Language-code normalisation.** `shouldTranslate` takes codes the caller has
  already put through `ctx.builtinTranslator.toApiLang`. A second alias table
  here would have to agree with `content/content-translation-engine.js` forever.
- **Detecting the language during recognition.** Tesseract must be told its
  languages up front and Chrome's `LanguageDetector` reports `unavailable` on
  plenty of profiles, so the language is worked out *after* the text exists, by
  `detectScriptLanguage()` counting codepoints — with the Tesseract language
  string as the only thing that can tell Simplified from Traditional Han.

### API Compatibility

Works with any OpenAI Chat Completions-compatible API, plus Anthropic's native
Messages API:
- OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, Ollama, LM Studio
- Request format: `{model, messages, max_tokens}` plus whatever per-model
  parameters `shared/api-compat.js` decides (see the rules below —
  `temperature` is only sent where the model still honours it)
- Response: `{choices[0].message.content}`, or `{content[0].text}` for Anthropic

**All of it lives in `shared/api-compat.js`** — the provider catalog, every
per-model parameter rule, request-body construction, and vendor error parsing.
Both the service worker (`import '../shared/api-compat.js'`) and the options
page (`<script src="../shared/api-compat.js">`) consume it, so the "test
connection" button sends exactly the request translation will send.

When a vendor ships a new model generation, `shared/api-compat.js` should be
the only file that changes. Do not reimplement these checks in a caller —
`npm run test:unit` fails if `background.js` or `options.js` redeclares them.
New top-level directories also need adding to the `zip` script in
`package.json`, which the same suite asserts.

Parameters are model-dependent and change between generations. Current rules:
- `gpt-5`+ and `o1`+ use `max_completion_tokens`, never `temperature`
- `reasoning_effort` floor is `'minimal'` up to gpt-5.5, `'none'` from gpt-5.6
  (which removed `'minimal'` outright)
- Gemini 3+ must not be sent `temperature` (Google's guidance: keep the 1.0
  default; lowering it can cause looping)
- Claude models reject `temperature`, including behind an OpenAI-compatible
  gateway
- Models that bill hidden reasoning/thinking tokens get a floor on the output
  budget, or short calls return empty text with `finish_reason: "length"`

## Bug Fixing Guidelines

Follow this process when fixing bugs:

1. **Find Root Cause First** - Don't rush to fix surface symptoms; identify the underlying cause
2. **Code-Level Investigation** - Use code analysis, git history, and log analysis to locate issues
3. **Ask for More Info When Needed** - If code analysis is insufficient, request from user:
   - Console log output
   - Reproduction steps
   - Environment info (browser version, page URL, etc.)
   - Screenshots or screen recordings
   - Relevant DOM structure or network requests
4. **Document Root Cause** - Explain the root cause in commit messages, not just "fixed XX issue"
5. **Verify the Fix** - Ensure the fix addresses the actual root cause, not just a workaround
6. **Avoid Breaking Other Features** - When adding or fixing a feature, ensure existing functionality is not affected. Run unit tests if available; if not, manually verify related features still work

## Shipping Changes

1. **Every finished change ships as a PR.** Once the work is done and tested,
   don't leave it sitting in the working tree — run the `github-pr-workflow`
   skill (`python3 /Users/dylanwang/github-workflow/scripts/github_pr_workflow.py .`)
   and follow its loop through to merge-ready: read the bot's review, fix the
   code yourself, push, let it re-review. The script auto-commits the *entire*
   working tree, so check `git status` for another session's changes first — a
   stray file swept into a PR is someone else's work merged without review.

2. **After several rounds of patching, step back and look at the whole.** A
   feature built one fix at a time drifts: the same origin ends up hardcoded in
   three files, two functions answer the same question differently, a helper
   lives in the caller that needed it first. Before opening the PR, re-read the
   feature end to end and ask whether the shape still makes sense — not just
   whether each patch was right on its own. Consolidate duplicated logic into
   the module that owns it (`shared/api-compat.js` and `shared/account-gate.js`
   exist because of exactly this), and add a unit test that fails if the
   duplicate comes back.

## Default Configuration

```javascript
apiEndpoint: 'https://api.openai.com/v1/chat/completions'
modelName: 'gpt-4.1-mini'
targetLang: ''        // empty = follow browser language
theme: 'light'
```
