# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Translator is a Chrome Extension (Manifest V3) that translates web content using OpenAI-compatible APIs. It supports selection translation, full-page translation, and a floating ball UI.

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

5. **i18n** (`i18n/messages.js`) - 10+ language translations, auto-selects based on target language

### Key Technical Patterns

- **Math formula preservation**: Detects MathJax/KaTeX elements, replaces with placeholders during translation, restores after
- **Code detection**: Regex patterns skip non-human text (code blocks, JSON, Markdown syntax)
- **Storage**: Chrome sync storage for cross-device settings
- **Theming**: CSS variables for dark/light theme support
- **Host-page containment**: our panels are a subtree of the page's own
  document, so every page rule on a bare tag matches them too — example.com
  ships `div { opacity: .8 }`, and every page builder ships
  `.kit button { … }` plus a heavier `.kit button:hover` twin. One scoped reset
  at the top of `content/content.css` is the boundary, and specificity is a
  four-step band with no `!important` in it:

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

- **We translate the subtitles the viewer already has on; we never turn
  subtitles on.** A track at `showing` or `hidden` is on (`hidden` is a player
  drawing the cues itself); everything at `disabled` is a language the page
  merely offers, and `pickSubtitleTrack()` returns null rather than choose among
  them. Vimeo lists four and shows none.
- **A track is put back exactly as it was found.** We hold it at `hidden`, not
  `disabled`, so cues keep loading; `restoreMode` goes back on detach. The one
  exception is a track the viewer disabled while we held it — restoring that one
  would turn subtitles back on and we would read that as consent, forever.

**Do not broaden the MAIN-world interceptor's match patterns to `<all_urls>`.**
Patching `fetch`/`XHR` on every page is a performance, compatibility and
store-review cost, and it buys nothing the `TextTrack` path does not already
give. A site that needs network observation gets its own match pattern.

Storage keys still read `enableYoutubeCaptionTranslation` / `youtubeCaption*` /
`showYoutubeOriginalCaption` on purpose: renaming them would drop the settings
of everyone who already has the feature on.

### API Compatibility

Works with any OpenAI Chat Completions-compatible API, plus Anthropic's native
Messages API:
- OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, Ollama, LM Studio
- Request format: `{model, messages, temperature, max_tokens}`
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
