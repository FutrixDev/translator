# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blab Translation is a Chrome Extension (Manifest V3) that translates web content using OpenAI-compatible APIs. It supports selection translation, full-page translation, and a floating ball UI.

## Commands

```bash
npm run icons      # Redraw icons/ (icon{16,32,48,128}.png + store promo tiles) from brand/blab-translation-2026-09-19/
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

**Nothing here is one file any more.** Every part below is a *family* of
ES-module or classic-script files under one directory; which function lives in
which file is layout, not contract. The rule that makes that safe is the same
everywhere: **ask the surface, not the file** — the helpers in
`test/unit/helpers/sources.mjs` (`workerSource()`, `optionsSource()`,
`messagesSource()`, `contentCss()`, `comicSource()`, `captionEngineSource()`,
`hoverSource()`, `engineSource()`, `popupSource()`, `uploadPageSource()`,
`framesSource()`, `pageSource()`) read a whole family, so adding a module never
means editing a test. Only assertions about **load order** read `manifest.json` or the entry
file directly.

1. **Background Service Worker** (`background/*.js`, entry `background.js` —
   a real ES module, so these are `import`s)
   - Handles all API requests to translation endpoints (`api-client.js`,
     `ai-translate.js`, `prompts.js`)
   - Manages context menus (`context-menus.js`)
   - Two TRANSLATE handlers: single and fast batch (delimiter-based, falling back to the numbered `[1]...[2]...` format); every model request goes through one AI profile (`model-client.js`, profiles in `shared/ai-profiles.js`). `callModel` retries network errors, timeouts, 429 and 5xx up to 3 attempts in total (1 s / 2 s backoff with jitter, or the server's `Retry-After`; over 60 s it fails at once), each attempt first taking a token from the per-profile rate limiter `model-limiter.js` (rpm / concurrency). The whole call — queueing, every attempt, every wait — stays within one budget of `AIProfiles.LIMITS.timeoutMax` (240 s), so a service-worker event never outlives Chrome's 5-minute cap; `AI_PROFILE_TEST` (`retry: false, limit: false`) is bound by it too
   - Stores default settings and translation prompts (`settings.js`)
   - The account-backed clients live beside it: `comic-client.js`,
     `pdf-client.js`, `pdf-jobs.js`, `pdf-notify.js`, `ocr-recognize.js`,
     `feature-gate.js`
   - Page coverage: `frame-relay.js` (relays `FRAME_*` messages between a
     child frame and the top frame of the same tab) and `page-coverage.js`
     (answers `GET_SHADOW_STYLES` with the translation stylesheet rewritten for
     shadow roots). The Alt+W whole-page shortcut is a row in the `COMMANDS`
     table of `commands.js`, beside Alt+A, not a listener of its own

2. **Content Script** (`content/*.js` + the sub-families below)
   - Injected into all webpages for DOM interaction
   - Text extraction with code/math detection, batch translation with
     concurrency control (at most 40 items or 9000 chars per batch; 4 batches
     at a time on the built-in engine, 12 on AI — `content/page/batch.js`) —
     `content/page/*.js` (collect, insert, batch, visibility, progress,
     site-adapter, `failed-blocks.js` for the "failed · retry" marker left on a
     block that still failed after the retries, plus `scope.js` for the main-content scope, `shadow.js` for
     open and closed shadow roots, `notranslate.js` for `translate="no"` /
     `.notranslate`) behind the entry `content-page-translation.js`
   - Frames: `content/frames/` (`shelf.js`, `top.js`, `child.js`, shelf
     `ctx.frames`) — the top frame drives, child frames follow its directive.
     Whether a frame runs at all is `shared/frame-eligibility.js`: ad, captcha,
     payment, sign-in and player frames stop at the first statement of
     `content-bootstrap.js` and never build `ctx`
   - UI components: selection button, float ball, translation popup, progress bar
   - Four more families have sections of their own below: the translation
     engine (`content/engine/`), comic (`content/comic/`), hover/selection
     (`content/hover/`), captions (`content/captions/`)

   **Content scripts are classic scripts sharing one global lexical
   environment**, so `manifest.json`'s order *is* the dependency graph, and a
   file that throws at load fails silently rather than loudly. That is why each
   sub-family hangs its cross-file names on one shelf object
   (`ctx.engine` / `ctx.comic` / `ctx.hover` / `ctx.captions` / `ctx.frames`) and reads them at call time:
   order then stops mattering. A name that crosses a file and is *not* written
   `comic.foo` is a bug waiting for a reload — including after `...`, where the
   spread operator's dots look exactly like a property access.

3. **Popup** (`popup/`) - Quick access panel for common actions

4. **Options** (`options/options*.js` + `options.html`) - Full settings page
   with API configuration and feature toggles, one script per card
   (connection, models, builtin, account, auto, pdf-tasks, i18n) over the
   shared `options.js`

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
  at the top of `content/css/popup.css` — the first of the fourteen stylesheets
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
- **Translation display is the one property a page cannot win.** Translations
  sit inside the page's own content, where a page rule like reddit's
  `.feed-card-text-preview :not(ol,ul,li,h1) { display: inline !important }`
  (0,2,2) outweighs any class of ours. That rule once put every translation
  inline and broke both "hide translations" and translation-only. So every
  `display … !important` in `content/css/translation.css` sits in
  `@layer ai-translator-display`: a layered `!important` beats every unlayered
  one, whatever its specificity. **Only display goes in the layer.** A layered
  `!important` also beats our own unlayered rules, such as the translation
  styles and the source-hidden margin reset, and those win today on
  specificity alone. Normal (non-important) display stays out too, because
  inside a layer it is weaker, not stronger. Guarded by
  `test/unit/translation-display-layer.test.mjs` and
  `test/e2e/hostile-display-css.spec.js`, which asserts computed display,
  not just the class.

### Account-Backed Features

Comic translation and document translation are the two features that do NOT use the
user's own API key: they run on our servers against a monthly free page
allowance, so both require a signed-in account. That makes their switches a
preference with a precondition, and the two halves live in different storage
areas on purpose:

| what | where | scope |
| --- | --- | --- |
| `enableComicTranslation` / `enablePdfTranslation` | `chrome.storage.sync` | per account |
| `comicToken` | `chrome.storage.local` | per device |

**"Turned off" and "not signed in" are two different answers** (D-353), and
`AccountGate.featureState(settings, key, signedIn)` in `shared/account-gate.js`
is the one place they are told apart. It never rewrites a setting; it answers
one of three states:

| state | meaning | what surfaces do |
| --- | --- | --- |
| `off` | the user turned the switch off | nothing appears on its own; only the media shortcut (this page's consent) still works |
| `signed_out` | switch on, no token on this device | the PDF/comic hints and the popup's PDF/comic rows show, and using one signs in first (the PDF task list, which is the account's, stays hidden) |
| `ready` | switch on, signed in | every entry point, menus included |

The options page draws `signed_out` as **the switch on plus a pending line**
under it — `featureOnAfterSignIn` ("On. Takes effect once you sign in.",
`#comicSignInPending` / `#pdfSignInPending`) — never as a switch drawn off.
The switch shows the stored preference, which is what a click would change;
drawing it off would read as `off` and hide the fact that signing in is all
that is missing. `renderAccountFeature()` in `options/options-account.js`
takes all three states from `featureState()`, and an account check still in
flight counts as signed in, so the signed-in majority never sees the line
flash on load. Only `ready` shows the PDF task list.

Nothing is written back to sync: a new install syncs the switches down before
it has ever signed in (both ship on), so a signed-out device that "corrected"
the preference would reach across and disable the feature on the device that is
still signed in.

Every surface asks through it: content scripts via `ctx.featureState(key)`
(`ctx.signedIn` is tracked beside the raw `ctx.settings`), the service worker via
`featureState(key)` in `background/feature-gate.js`, the popup and the options
page directly. `assertFeatureEnabled(key, {consent})` refuses only `off` — the
account half is enforced one layer down, where `apiFetch` answers a create with
no token as `unauthorized`, and every surface turns that into a sign-in offer.

Comic translation is a family of classic scripts sharing one shelf, `ctx.comic`:

| file | what it owns |
| --- | --- |
| `content/comic/pages.js` | is this a comic page, which images to translate, page ids, the mode/status vocabulary |
| `content/comic/entries.js` | the per-image ledger, showing the result or the original |
| `content/comic/overlay.js` | the badge and the spinner drawn over an image |
| `content/comic/memory.js` | jobs remembered in `chrome.storage.local` across a reload |
| `content/comic/prompts.js` | the sign-in / out-of-credit / error prompts |
| `content/content-comic-translation.js` | the entry: the job lifecycle (create, poll, recover) and page-swap watching |

Every reference crossing a file goes through the shelf (`comic.foo`), so no file
depends on being loaded before another. Tests ask the **family**, not a file:
`comicSource()` in `test/unit/helpers/sources.mjs`.

### Document Translation

Six formats — PDF, Word (`.docx`), EPUB, MOBI (`.mobi`/`.azw3`), TXT, Markdown —
through one upload page (`pdf/upload.html`, its card drawn by
`pdf/job-view.js`) and one set of worker messages. The file and
message names still say `pdf`; what they carry does not.

- **`shared/doc-jobs.js` (`DocJobs`) is the only place a format or a status set
  is written down**: the formats, their extensions and content types, the byte
  caps (`maxBytesFor`, mirroring the server's env), the magic-byte sniff,
  `isActiveStatus` / `isAwaitingStatus` / `isTerminalStatus` /
  `isUnsettledStatus`, the result file name, and the reader address a
  finished job is viewed at (`readerUrl` → `<site>/app/reader/<id>`, `''` for a
  non-web base or a `local:` id). It loads before `shared/pdf-errors.js` in
  every load list.
  `shared/doc-measure.js` (`DocMeasure`) counts a flow document's standard pages
  (3,000 characters each) on the page, so an over-800-page book is refused
  before any request; PDF and MOBI are not measured and declare nothing.
  `test/unit/doc-guards.test.mjs` fails on a byte cap, a hand-built
  `queued`/`running` set or base64 anywhere in the document surfaces.
- **The page PUTs the bytes; the worker never holds them.** The page asks the
  worker for a ticket (`PDF_UPLOAD_TICKET`), PUTs the file itself to the
  one-time presigned `uploadUrl` (no bearer token — the signature is the
  authorization), then asks the worker to create the job (`PDF_CREATE_JOB`
  with `source: {kind: 'uploaded', sourceKey, sourceFormat}` and
  `declaredUnits` when measured). Only the web-PDF path (`PDF_TRANSLATE_URL`)
  still fetches and PUTs from the worker, and it takes PDFs only.
- **`awaiting_confirm` is a status of its own**, neither active nor terminal: a
  job that measured longer than it reserved stops and asks. The page shows
  `#docConfirmPanel` (`PDF_JOB_CONFIRM` / `PDF_JOB_ABANDON`), the popup's row
  offers **Review**, and records keep it for 96 h (unsettled) rather than the
  24 h a settled job gets.
- **Only the poll raises a job's notification.** `refreshPdfJobs()` in
  `background/pdf-jobs.js` compares each refreshed record with the one it
  replaced and notifies on what changed — settled, now awaiting, or no longer
  awaiting (which clears `pdf-confirm-<id>`). A page handler that learns the
  same fact from its own fetch must not notify; the guard test checks.
- **A finished job of any format is viewed in the web reader** (D-488),
  whose download menu has every file. The job page's one primary action is
  **View** (`#docView`), opening `DocJobs.readerUrl(<site base>, jobId)`;
  Word, EPUB, TXT and Markdown also keep **Save Bilingual / Translated File**
  as secondary buttons, saved as `<name> (bilingual).<ext>`. No open-the-file
  path exists any more.
- **`PDF_OPEN_JOB` is the one way a row or notification leaves a surface** —
  the popup row, the settings list and a clicked notification. `openPdfJob`
  polls the job first; a succeeded job opens the reader at the base
  `comicClient.getApiBase()` gives (the same one `ACCOUNT_SITE_BASE` answers),
  everything else — and a poll that fails — opens `pdf/upload.html#job=<id>`.

### Hover / Selection Translation

Hold the hotkey and point at a paragraph, or select text and click the icon —
both land in the same place. It is a family of classic scripts sharing one
shelf, `ctx.hover`:

| file | what it owns |
| --- | --- |
| `content/hover/blocks.js` | which element counts as a block, its text, the translation cache key |
| `content/hover/inline.js` | the ledger of inline translations: managed rendering, clip guards, survival checks, the context-menu target |
| `content/hover/latex.js` | pulling formulas out before translating and putting them back |
| `content/hover/selection.js` | the selection path: anchors, safe insertion ranges, rendering a selection's translation |
| `content/hover/render.js` | what a translation looks like: base style, loading dots, the inline node |
| `content/content-hover-translation.js` | the entry: hotkeys, mouse, right-click, translating one block, and the `ctx.*` exports |

Every reference crossing a file goes through the shelf (`hov.foo`), so no file
depends on being loaded before another. Tests ask the **family**, not a file:
`hoverSource()` in `test/unit/helpers/sources.mjs`.

**The selection icon and card live outside the shelf**, in
`content/content-selection.js` and `content/content-popup.js`. After a mouseup
settles, a 28×28 icon sits next to the selection's last line (the line the
mouse was released on); `selectionTrigger` (`icon` / `modifier` / `both`)
decides whether the icon, the modifier key, or both start a translation.
Every selection translation except the icon goes through one function,
`ctx.translateSelection(text, { range, element })`, which picks inline or card
from `selectionTranslationMode`; the icon always opens the card. All three
floating layers (source peek, card, icon) are placed by one pure function,
`ctx.placeBeside(size, anchor, options)` in `content/content-utils.js`: the
card goes beside the selection, never over it, and is re-placed by a
ResizeObserver until the user drags it. The card's action row is retranslate,
switch engine, add to glossary, copy; errors go to its single
`.ai-translator-error` element (`ctx.showCardError`), never into the
translation text. The row wraps, so a button whose width followed its label
moved a different button under the pointer: a button whose label changes is
drawn with `ctx.fitLabel(text, labels)`, sized for every label it will show,
and every copy button is
`ctx.copyButtonContent(label)` + `ctx.copyWithFeedback(button, text)` — the one
place "Copied" is shown and the clipboard written
(`test/unit/copy-feedback.test.mjs`). The `execCommand` fallback in
`ctx.copyToClipboard` is not dead code: a cross-origin frame without
`allow="clipboard-write"` is refused `navigator.clipboard`, and the fallback is
what copies there. Journeys J-D1–J-D11 in `test/e2e/selection-card.spec.js`;
J-D11 runs the icon and card in a cross-origin frame, whose translations go
through the top frame's engine.

**Add to glossary** (`.ai-translator-add-term`, `content/content-add-term.js`,
shelf `ctx.addTerm`) is shown or hidden in exactly one place: `settle(popup,
translated)`, the first, synchronous statement of `settleCardActions` in
`content/content-popup.js`. It shows after a successful translation whose
source, through `Glossary.normalizeSource`, is 1–80 characters, and it is never
hidden and re-shown while a retranslation or an engine switch is in flight (it
is only disabled, like the other buttons; the row wraps). Its label goes
through `ctx.fitLabel` over `glossaryAdd` / `glossaryAdded` /
`glossaryUpdated`. The form it opens is a child of `.ai-translator-popup`, not
a new panel root, and it folds whenever a request starts. Saving is one
`Glossary.request('put')`: "This site only" sends `scope: 'site'` and never an
`h` — the service worker takes the site from `sender.tab.url`, which in a child
frame is the top page — and "All sites" sends no scope at all (D-381). The host
the form prints is only for the reader: `ctx.frames.topHost()`, which a child
frame answers from the `host` in the top frame's directive, and with `''` (so
only "All sites" is offered) until one has arrived. Nothing is validated on the
card: the worker rejects an over-long entry with the same `Glossary.LIMITS`,
and the form stays open with that message. Saving never retranslates. Journeys
in `test/e2e/glossary-selection.spec.js`.

**Dictionary entry** (`shared/dict-entry.js`, global `DictEntry`, loaded by
both the content scripts and the service worker) owns the entry end to end:
the shape (translation, phonetics, senses, examples, forms), the prompt rules
(`OUTPUT_RULES`, appended after any user, preset or default word prompt and
ending in `FORMAT_OVERRIDE`, so a preset's "reply with the translation only"
never wins — `test/unit/dict-word-prompt.test.mjs`), the parser
(`fromModelText`) and the one renderer (`render`) the input box and the
selection card both call. **The phonetics are the translation's, in the target
language** (D-487): `FIELDS.phonetics.describe` asks for the pronunciation of
`translation` — two items, `UK` and `US` IPA, when the target is English, and
one item with an empty label in that language's usual notation (pinyin with
tone marks, kana) for any other target. Every phonetic speaker reads
`entry.translation` (aria label `pronounceTranslation`): `UK` in `en-GB`, `US`
in `en-US`, an empty label in the target language. The accent voices hold
only for an English target (`LangTags.getLangBase(targetLang) === 'en'`, so
render reads `LangTags`, loaded before it in the manifest): under any other
target a `UK`/`US` label is dropped at render (D-472) and the row is read in
the target language — a stale label must not give `correr` an English voice.
So `render(container,
entry, { targetLang, t, speech })` takes the target language the caller used
for this request (the dialog's or card's override, else the shown target) and
throws on an entry drawn without one; it has no `word` option. The looked-up
text keeps its own speaker on each surface (`#ai-translator-input-speak`,
`.ai-translator-speak-source`). Neither surface builds entry markup or decides what
a lookup is on its own: both send `mode: 'word'` exactly when
`DictEntry.isLookup(text)` holds — trimmed, no sentence punctuation
(`. ! ? 。！？；; ，, ：:`), no formula notation (`$`, `\(`, `\[`, a backslash
command such as `\alpha`, any `\p{Sm}` math symbol, `^ _ { }`, D-474; any `*`,
or a `-` or `/` between spaces or between bare operands — `x - y`, `3/4`,
`(x-y)` — while `x-ray`, `Wi-Fi` and `km/h` stay lookups, D-475; a formula
takes the text path, where the math placeholder rule applies), and 1–3 words
in a spaced script or 1–4 characters in Han, kana, hangul, Thai and the like
(D-473). The parser fails hard, as
`invalidEntry` → `dictEntryUnreadable`, only when no JSON can be extracted
(after `<think>…</think>` is stripped), the JSON is not an object, or the
translation is missing or empty; a wrong-typed or overlong optional field or
list item is dropped, never guessed at (D-472). The entry is drawn only for a
reply from engine `ai` (`DictEntry.entryFor`); the built-in engine gives the
translation alone. `content/css/dict-entry.css` states colour, size, display
and padding on every element, because the containment reset leaves those to
our own rules and the entry is made of bare spans and divs. Journeys C1–C9 and
J1–J3 (the translation's phonetics and speakers, D-487) in
`test/e2e/dictionary-entry.spec.js`.

### Translation Engine

Every translation a content script asks for — page, hover, selection, input
box, subtitles, OCR — goes through one call, `ctx.requestTranslation`, which
picks a backend (Chrome's built-in Translator API or the user's own AI
endpoint) and is the **only** place a request leaves for the model. It is two
steps: `ctx.withPromptAddenda(message)` stamps the request once with this
document's register (below), and `ctx.sendTranslation(message)` sends a stamped
request — backend choice, fallback and the budget gate live there. The cached
entry `ctx.requestTranslationCached` is the same two steps, its send being
`ctx.sendTranslationCached` (`content/content-translation-cache.js`). A child
frame overrides only the two send steps (they hand the request to the top
frame), and the top frame's relay calls them directly, so a relayed request
keeps the child's stamp. The glossary, the prompt domain and the page context
belong to the frame that executes the request (the top frame for a child's
request): `sendToModel` merges them into the same `addenda` object and never
overwrites the register (D-382). It is a family of classic scripts
sharing one shelf, `ctx.engine`:

| file | what it owns |
| --- | --- |
| `content/engine/languages.js` | extension codes ↔ Translator API codes (`toApiLang`), which languages the built-in engine knows, `detectLanguageOf()`, the page's and a snippet's source language |
| `content/engine/watchdog.js` | the stall watchdog: every call into the Translator API gets a deadline, and a download's deadline moves with its progress events |
| `content/content-translation-engine.js` | the entry: backend choice, the budget gate, `ctx.requestTranslation` (`ctx.withPromptAddenda` + `ctx.sendTranslation`), `ctx.builtinTranslator` |

The options page loads the same family (language-pack status and download), so
both load lists — `manifest.json` and `options/options.html` — carry every file,
after `shared/lang-tags.js`; `test/unit/engine-status.test.mjs` checks both.
Tests ask the **family**, not a file: `engineSource()`.

**A request can pin its engine, and every response says who answered.**
`message.engine` (a value of `Engines.ENGINES` in `shared/engines.js`:
`'builtin'` | `'ai'` | `'blab'`, anything else throws) is read in one
place, `pinnedEngine(message)` in `content/content-translation-engine.js`; it
outranks the settings and a pinned engine **never falls back** — its failure is
the answer. Nothing is persisted. Every response from `ctx.requestTranslation`
carries `engine: 'builtin' | 'ai' | 'blab'` (on errors: the engine that
failed). The card's switch-engine button is the only caller that pins, and it
asks `ctx.engineChoices(targetLang, feature)` (`{ builtin, ai, blab }`) which
engines are usable right now for the card's target language: `blab` needs the
signed-in paid account (`eng.model.blabAvailable()`), `builtin` also needs the built-in
engine to know that target. That is `eng.supportsTarget(targetLang)` in
`content/engine/languages.js`, the one predicate for "can the built-in engine
translate into this extension code": the language menus' "AI only" tag, the
language-pack status and the engine's own error wording ask it too, and no
caller rebuilds it from `supportsLang(toApiLang(…))`.

**Two engine switches, one per half of the extension.** `translationEngine` is
for what the user clicks (and for subtitles, below); `autoTranslateEngine` is
for pages translated automatically, and defaults to the free built-in engine.
Every predicate that asks "built-in or AI?" takes the `auto` bit
(`isBuiltinSelected(auto)`, `effectiveEngine({ auto })`), and
`test/unit/auto-engine-choice.test.mjs` fails on a bare `isActive()` — a caller
that has no automatic half writes `isActive(false)` to say so.

**The daily AI budget gates zero-click spend, and there are two zero-click
paths.** `refuseAutoAiSpend()` sits right before the one `sendMessage` exit and
charges `AutoStats` (`shared/auto-stats.js`, a single-writer queue in the
service worker) for requests marked either `auto` (page auto-translation) or
`unattended` (subtitles: `CaptionCore.buildTranslationRequest` sets it). They
are different flags on purpose: subtitles keep the **manual** engine — `auto`
would also move them onto `autoTranslateEngine` — but nobody clicks per line, so
their AI spend counts toward the same `autoAiDailyBudget`. A refusal comes back
as `{ error, budgetSpent: true }`; the caption menu turns that into
「今日 AI 额度已用完」 and the next batch after the cooldown tries again, so
raising the budget or a new day heals it without a reload. The options page
greys the budget field only when none of the four unattended AI paths is open
(auto engine = AI, manual engine = AI, fallback allowed, or a site rule with
engine = AI).

**The model is told what kind of page it is reading, and only that.** Built-in
site rules may carry a `register` (`social` / `forum` / `news` / `academic`,
the table in `shared/prompt-addenda.js`), read by `SiteRules.register(host,
path)`. That reader looks only at the built-in table: user rules have no
register. `ctx.withPromptAddenda()` attaches `addenda` to every one of the
three translate messages: `{ register }` when this page has one, `{}` when it
has none. It runs once per request, in the frame that asked, reading `location`
at call time (an SPA route change is a new register), and throws on a request
that already carries `addenda`; because every request carries the field, that
guard also fires on a page with no register. A child frame's request crosses the
relay untouched, so a child page with no register sends `{}` even under a news
top page. The translation
cache stamps once too, keys on that stamped `addenda` and sends its misses
through `ctx.sendTranslation`, so the key and the request cannot disagree. It sends the
label and never the host. The service
worker's two TRANSLATE handlers run `PromptAddenda.validate()` before
translating, and it throws on a missing `addenda`, an unknown register or any
extra field. The
handlers pass the addenda down every `ai-translate.js` path, including the
fast batch's numbered fallback and the single-word prompt. There
`composePromptAddenda()` places the addenda after the template and before the
math placeholder rule, in the order REGISTER, DOMAIN, GLOSSARY, PAGE CONTEXT
(broad to narrow: what kind of page, what field, which words, which
neighbours). A register and a domain with the same id (`news`, `academic`)
send the DOMAIN line only; `general` sends no DOMAIN line. Separately, every text path carries `REGISTER_RULE`
(casual stays casual, formal stays formal): the default single, numbered-batch
and fast-batch templates, and the rules appended to a custom prompt on those
same three paths, the single-text one included. The word/dictionary path never
carries it, neither `SINGLE_WORD_PROMPT` nor `WORD_OUTPUT_RULES`: a dictionary
entry has no register to keep, though its addenda still arrive. The eighth translation-cache
factor (`addenda`) is computed in one place,
`ctx.engine.addenda.stamp(addenda, snap, text, current)` in
`content/engine/addenda.js`: the stamped register (`PromptAddenda.stamp()`),
this text's glossary hits, the effective domain and the page-context switch.
`current` is one `ctx.engine.addenda.settings()` snapshot (`{ domain, context
}`), read after `ctx.customRules.whenReady()`, and `sendTranslationCached`
hands the same snapshot and the same glossary snapshot to the send as
`opts.addendaSettings` / `opts.glossary`, so the key and the prompt read one
domain; the uncached path reads its own at send time. The built-in engine
reads no prompt and never sees it. Captions need nothing of their own, because
they go through `ctx.requestTranslation` too. Covered by
`test/unit/prompt-addenda.test.mjs`,
`test/unit/prompt-register-engine.test.mjs`,
`test/unit/frame-relay-addenda.test.mjs` (both relay directions, real
`child.js` → `frame-relay.js` → `top.js`) and
`test/e2e/prompt-register.spec.js`.

**The domain and the page context are two settings plus one rule field.**
`promptDomain` (default `general`, one of `PromptAddenda.DOMAINS`) and
`aiPageContext` (default off) live in sync settings; a user site rule's
`domain` outranks `promptDomain` (a rule that says `general` counts as having
said it). `content/engine/addenda.js` (`ctx.engine.addenda`: `plan`,
`compose`, `stamp`) builds each request's addenda from a snapshot of the
glossary, splits a batch into parts of at most 60 glossary entries each, and
adds the page context (title, and 300 characters either side for a whole-page
batch). The neighbours travel as `message.pageContext`, which `sendToModel`
strips in the frame that executes the request, so a child frame's request
carries it across the relay and the top frame strips it; it never reaches the
model or the built-in engine. A domain the table does not know is a
configuration error: the thrown error carries `passFatal: true`, and a
whole-page round (`content/page/batch.js`) stops at the first one instead of
waiting for the failure threshold; a child frame's relay carries the flag back.

**`ctx.translationProfile` (`content/content-translation-cache.js`) is the
generation of the page's in-memory caches.** Hover and captions key their own
caches on target language and text only, so the key is prefixed with a
generation that goes up when a translation-relevant setting changes
(`GENERATION_KEYS`), when the page's glossary signature changes, or when
`ctx.customRules.onProfileChange` fires (this site's pinned engine or domain
changed). A child frame never bumps its own; it inherits the top frame's from
the directive (`translationProfile.inherit`).

**"Already in the target language" means the body is, not the whole
paragraph.** `isTargetLanguageText` in `content/page/batch.js` is the one
predicate behind both the pre-filter (`filterBlocksByLanguage`: manual, auto,
child frames, user rules) and `shouldSkipTranslation`. It never hands the raw
paragraph to `chrome.i18n.detectLanguage`. A Chinese tech paragraph full of
English names comes back as `zh:55` unreliable, or even `kk`. Instead,
`LangTags.splitForeignTerms(text, targetLang)` in `shared/lang-tags.js` splits
the whole block into sentences with `Intl.Segmenter`. It strips runs of the
other alphabet (the Latin / non-Latin axis, so kana and hangul are never
stripped). Which side is native follows the block: if
`LangTags.langFitsText(target, block)` says the target can be written in the
block's own script, the other side is stripped; if not, the block's own script
is the foreign side. So Latin-script Serbian is not stripped bare. Pinyin or
transliterated Russian under a zh or ru target is all foreign and never
reaches the detector. The detector would answer `zh-Latn` or `ru-Latn`, and
`isSameLanguage` compares scripts only for Chinese. `langFitsText` is also the
engine's `pageLangFits`. It asks Intl for the default script of every
language, not only `SUPPORTED_LANGS`. It honours a script subtag in the tag
(`sr-Latn`), counts both sides for `BOTH_SIDES_LANGS` (sr, bs, uz, kk), and
vetoes tags Intl cannot place. It reports `foreign` if any sentence
has a run longer than `TERM_MAX_WORDS` (6), foreign words more than
`FOREIGN_RATIO_MAX` (2) times the native ones, or no native letters and at
least `FOREIGN_SENTENCE_MIN_WORDS` (3) foreign words. A foreign sentence
translates the whole paragraph, because the translation unit stays the
paragraph and the sentence is only the unit of judgement. Only the residue is
asked, under `detectReliableLanguage`'s gate. Han-only residue counts as `zh`
without asking, since the detector answers `ja` on two Han characters.
Confidence must be at least 85. `isReliable` is required only for pure-Latin
residue. Chrome's `LanguageDetector` is not used: it reports unavailable on
many profiles.

Splitting cannot see a foreign sentence written in the same alphabet: a French
paragraph with one English sentence reads `fr:100` as a whole. So when the
native side is Latin, `splitForeignTerms` also returns `sentences`, the kept
sentences longer than `TERM_MAX_WORDS` words. After the whole residue passes,
`isTargetLanguageText` asks each one through the same `detectReliableLanguage`
gate (a sentence identical to the residue is not asked twice). One reliable
reading of another language translates the paragraph. Measured in the e2e
Chrome, pure-Latin sentences of up to about nine words come back
`isReliable: false`, so a short same-script foreign sentence still slips
through. Non-Latin native sides get no per-sentence check, because Chinese
residue with its names stripped is fragments, and the detector reads those as
`kk` or `ja`. The extra calls are spent only on paragraphs about to be skipped.
Both comparisons use `LangTags.isDetectedAsLanguage`, not `isSameLanguage`.
The detector cannot tell Serbian, Croatian and Bosnian apart: Latin-script
Serbian reliably reads `bs`. One Croatian sentence read `sl`, which is a
different language and is left out of the group, so that paragraph gets
translated. Covered by `test/unit/native-text-skip.test.mjs` (a fake detector
replaying measured readings) and
`test/e2e/page-translation-native-skip.spec.js` (the real one).

### User Site Rules

Per-site rules the user writes: which part of a page to translate
(`include`), what to leave out of the translation (`exclude`), what to keep
as the original inside it (`keepOriginal`), a stylesheet for the page, and an
engine pinned for the site. Written from the Settings page's Site
Translation Rules card (`options/options-custom-rules.js`) or the in-page
picker (`content/picker/`, opened by `OPEN_RULE_PICKER` from the float-ball
menu or the popup; top frame only).

- **One resolver**: `shared/custom-rules.js` (`CustomRules`) validates a
  rule, sanitizes its CSS (`sanitizeCss`, the only CSS check anywhere — the
  settings page's live hint and the content side both call it), picks the
  one winning rule for a URL, and merges an import. The page side reads it
  through `content/page/custom-rule.js` (`ctx.customRules`); user rules
  outrank the built-in site adapter, and `SiteRules.decide()` does not
  change.
- **Key layout**: one `chrome.storage.sync` key per rule, `customRule:<id>`,
  and no index key — two devices adding rules at once would overwrite an
  index. Reading every rule is `get(null)` filtered by
  `CustomRules.KEY_PREFIX` (Chrome 116 has no `getKeys()`).
- **Writes** go through the service worker's single-writer queue built by
  `shared/storage-writer.js` (`StorageWriter.create`), shared with
  `SiteRules` and `AutoStats`; the quota check is
  `SyncCollection.assertFits`, the one check behind every write and the
  import preview. No page writes a `customRule:` key itself.
- **Content-side mirror**: `shared/sync-collection.js` (`SyncCollection`).
  A frame asks the worker once for its own host's rules
  (`CUSTOM_RULES_FOR_HOST`, host taken from `sender.url`), then follows the
  `customRule:` deltas that `content-bootstrap.js` hands out through the
  `ctx.syncMirrors` registry; those keys never enter `ctx.settings`.
- **Exclude and keepOriginal differ only on inline elements**: a block hit
  skips the whole block for both; an inline exclude hit is removed from the
  text sent and from the translation, an inline keepOriginal hit is sent as a
  placeholder and comes back unchanged. The built-in table is keepOriginal
  only.
- A rule's engine is a pin: it never falls back, and child frames inherit the
  top frame's through the frame directive (`engineOverride`).
- A rule may carry a `domain` (P1-C). A rule is written at the lowest version
  that can express it: `v: 2` only when it has a `domain`, `v: 1` otherwise,
  and a `v: 2` rule without one is invalid. `ctx.customRules.domain()` answers
  this page's, and `onProfileChange(fn)` calls back only when the effective
  `engineOverride` or `domain` changes.

### User Glossary

"Translate this word as that, or leave it alone." `shared/glossary.js`
(`Glossary`, a dual-mode classic script: the service worker imports it, the
content scripts and the settings page load it) owns the entry shape, the
limits (`Glossary.LIMITS`: source 1–80 characters, translation at most 160),
`normalizeSource`, `caseSensitiveByDefault` (an uppercase letter in the source
makes a new entry case-sensitive — the settings page and the card both ask it),
which entry wins, and the three writes. Entries are one sync key each,
`glossary:<id>`, `{ s, t?, c?, h?, l, u }` (`t` absent = keep the original,
`h` = a site, `l` = a target language or `*`).

- **No markers in a term** (D-387). A source or translation containing a
  `{{n}}` placeholder or an `<a1>`-style marker is rejected, not escaped:
  restored into a translated block, it would be read as structure by
  `content/page/insert.js`. The test is `TextMarkers.hasMarkers`, the same
  two patterns the insert path parses, called only from
  `Glossary.validateEntry` — so the form, the card, CSV import and decode all
  get it. `glossary.js` takes `TextMarkers` at load, so every load list has
  `shared/text-markers.js` before it.
- **Writes** are `GLOSSARY_WRITE` (`put` / `remove` / `import`) through the
  same `StorageWriter` single-writer queue as the site rules; callers use
  `Glossary.request(kind, payload)`. Errors come back as i18n keys
  (`Glossary.userErrorKey`). A `put` with `scope: 'site'` has its `h` set from
  `sender.tab.url`, never from the message. CSV import and export are
  `shared/glossary-csv.js`, and the worker re-parses an import itself.
- **Reads**: `background/glossary-host.js` answers `GLOSSARY_FOR_HOST` with the
  entries in effect for the sender's host. Only the top frame asks and keeps a
  mirror (`content/content-glossary.js`, `ctx.glossary`), then follows
  `glossary:` deltas through `ctx.syncMirrors`; a child frame keeps none,
  because its requests run in the top frame.
- **Use**: `content/engine/glossary.js` (`ctx.engine.glossary`) takes one
  immutable snapshot per request (`current(targetLang)`), matches it, and on
  the built-in engine swaps hits for `{{n}}` placeholders (at most
  `MAX_PLACEHOLDERS`, 20) and back (`withGlossary`); the AI engine gets the
  hits in `addenda.glossary`, which the prompt prints under `GLOSSARY
  (user-defined; …)`. `TextMarkers.splitSafe` (`shared/text-markers.js`) keeps
  a split point out of a placeholder, and it recognises only well-formed
  `{{n}}` ones.
- The top frame's directive carries its `host` (`SiteRules.normalizeHost` of
  the top page, `''` when there is none), and a changed host is a new
  directive; this is what `ctx.frames.topHost()` answers in a child frame.

### Video Subtitle Translation

One engine, one overlay, and a small provider per way of getting cues. The
engine owns everything that is the same on every site: sentence segmentation,
batching, the bilingual overlay and its drag/resize/persistence, hiding the
page's own line, and re-mounting on fullscreen. `shared/caption-core.js` holds
the pure parts of that (VTT/json3/srv3 parsing, cue merging, batching, track
choice, the translation request) so `npm run test:unit` can exercise them with
no browser.

The engine is a family of classic scripts sharing one shelf, `ctx.captions`:

| file | what it owns |
| --- | --- |
| `content/captions/state.js` | the one mutable `state` object, the timing constants, the settings/target-language/video-element readers. **Loads first** — the others take `caps.state` at load time. |
| `content/captions/overlay.js` | the overlay: mount, render, drag/resize, persistence, fullscreen |
| `content/captions/translate.js` | cue keys, batch picking, `translateCues`, the sliding window |
| `content/captions/activation.js` | when we take over a video: the site gate, track watching, provider selection, `ctx.enableNativeCaptions` |
| `content/content-video-captions.js` | the entry: the time-update loop, `ctx.applyCaptionSettings`, `ctx.setupVideoCaptionTranslation` |

Everything crossing a file goes through the shelf (`caps.foo`), so only that one
`state` read depends on manifest order. Tests ask the **family**, not a file:
`captionEngineSource()` in `test/unit/helpers/sources.mjs`.

**Subtitles have no switch of their own.** Whether we translate them at all is
the same gate the page text goes through — the main `autoTranslate` switch plus
this site's rule — and the engine reads it off the scheduler's snapshot
(`siteRefused()` in `content/captions/activation.js`, subscribed through
`ctx.autoTranslate.onStateChange`, which is why `ctx.init` starts the scheduler
first). It asks `siteRefused`, **not** `siteAuto`: video sites are not on the
built-in Always list, so the page-text answer there is usually a quiet off
(`DEFAULT_OFF`, not a refusal) and `siteAuto` is permanently false — gating on it would mean subtitles never work
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

That leaves a band where the two answers disagree: a site with no rule, gate
open, subtitles being translated, first row reading off. Stopping there used to
take two clicks (on writes `always`, off writes `never`). It is covered by a
**second row, not a second meaning of the first**: 「不再自动翻译 {site}」
(`autoStopSite`, the float ball's key and wording), right under the first row
in both the player menu and the popup, writing `SiteRules.setSiteAuto(host,
false)` in one click. All three rows print the site through
`SiteRules.siteLabel()` — the key the rule is written under, so the button and
the Settings list name the same site. Whether it shows is one function,
`stopSiteOffered()` in `content/captions/activation.js` — a provider on this
page, gate open, `siteAuto` off, and `siteRuleWritable()` — and neither
surface recomputes it:
the engine hands it to the menu as `controls.sync({ …, stopSite })`, computed
from the same `state` the first row is drawn from, and the popup reads
`captionStopSite` off the same `AUTO_PAGE_STATE` reply as `auto.siteAuto`
(`ctx.captionStopSiteOffered()`). Once the `never` lands the gate is shut, so
the row disappears and the first row — still off — is the way back on. A
tri-state first row was the alternative and was rejected: its middle state
("follow the default") means deleting the rule, which is a no-op on a
built-in-list site and under `GLOBAL_OFF`, and changing what an off switch
writes depending on context the user cannot see is the bug the first
paragraph exists to prevent. The float ball's own stop row is separate and
still shows only when `siteAuto` is on — it also hides the page's translations.

**The player icon is a per-video switch; the menu sits behind the chevron
beside it.** A click on `#ai-translator-caption-btn` calls
`ctx.setVideoCaptionsOn()` in `content/content-video-captions.js`, which flips
`state.dismissed` — the same flag the overlay's close button sets, reset for
every new video — and writes no storage: turning translation off for one video
must not turn it off for the site, and on a captions-only site (YouTube) turning
it on must not start translating the page text. The engine hands the flag down
as `controls.sync({ …, dismissed })`, and the icon draws `aria-pressed` from it
(on only while the gate is open and the video is not dismissed). While the gate
is shut the icon has nothing to switch, so a click opens the menu instead. The
menu itself is unchanged and opens from `#ai-translator-caption-more`, the small
chevron right after the icon (`aria-haspopup="menu"`, `aria-expanded`), which is
also the menu's anchor. On YouTube the pair is inserted before
`.ytp-subtitles-button`, not at the start of the right-hand group: the real bar
opens that group with the player's own expand chevron.

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

- **We translate the subtitles the viewer already has on; picking a track
  never turns one on by itself.** A track at `showing` or `hidden` is on (`hidden` is a
  player drawing the cues itself); everything at `disabled` is a language the
  page merely offers, and `pickSubtitleTrack()` returns null rather than choose
  among them. Vimeo lists four and shows none.

  The exception is `autoEnableCaptions` — on by default since R33 (a video
  with its subtitles off has nothing to translate), and the only automation in
  the extension that changes the **player's own** state rather than adding
  nodes of ours, which is why it is a switch of its own and why the latch in
  `syncNativeCaptions()` stops it for good once the viewer turns them off. With it on,
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
  owner, and `content/page/batch.js` asks the same one, so a page and its
  subtitles can no longer answer "is this already your language?"
  differently on the same tab. Anything that loads `shared/caption-core.js`
  must load `lang-tags.js` first; it throws at load without it. For page text there is one more
  step before that question can be asked at all: `chrome.i18n.detectLanguage`
  answers a plain `zh` for both scripts (measured in the e2e Chrome — 100%,
  `isReliable`, no subtag), so `LangTags.refineScript()` reads the script off
  the characters and only then is the tag whole enough to compare. Its table
  holds only characters that exist on one side and not the other — 后, 几, 台,
  里 are ordinary Traditional words, and a table containing them would read a
  Traditional page as Simplified. That refinement belongs to
  `detectLanguageOf()` in `content/engine/languages.js`, not to any
  one caller, because the built-in engine asks the same question again one
  layer below the gate: it knows Simplified (`zh`) and Traditional
  (`zh-Hant`) as two languages, and a bare `zh` source against a `zh` target
  trips its own equal-language short-circuit — the gate opens and the page
  still comes back untranslated. Both harnesses that load the engine in Node
  (`test/unit/helpers/engine-harness.mjs`,
  `test/unit/builtin-translator-stall.test.mjs`) must load `lang-tags.js`
  first. They also load the site-rules chain (`site-rules-builtin.js`,
  `storage-writer.js`, `site-rules.js`) and `prompt-addenda.js`, and define
  `location`, because the engine's exit asks `SiteRules.register()` about the
  page. And **the
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
  here would have to agree with `content/engine/languages.js` forever.
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

**Whether a key is needed is one question with one answer**,
`APICompat.requiresApiKey()` / `isApiKeyMissing()`: the Ollama and LM Studio
presets and any loopback, private-LAN or `.local` endpoint take none. No caller
tests `apiKey` for truthiness itself; `test/unit/api-key-rule.test.mjs` scans
for it. A failed request is a structured failure (`readAPIResponse` returns
`{ failure: { status, detail } }`, `callTranslationAPI` throws with
`err.apiFailure`), worded only at a boundary that knows the UI language, through
`APICompat.describeAPIFailure(failure, t)` — `background/api-errors.js` in the
service worker, which also words the settings page's test button (`AI_PROFILE_TEST`).
A 429 whose `Retry-After` is over 60 s carries `rateLimitedWait` (seconds) on the
failure and is worded `apiErrorRateLimitedWait`; a 5xx with the same header keeps
its status wording (server class), never the rate-limit one.

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

3. **Commit messages are English — never Chinese.** Subject and body both,
   and the PR title too: GitHub writes it into the commit that lands on
   `main` (a merge commit's body, the subject of a squash of several commits),
   and nothing checks it mechanically. No Chinese characters and no full-width
   punctuation (`，` `。` `「」`); a change about a UI string names its i18n
   key (`autoStopSite`) or its English text rather than quoting the zh-CN one.
   `.githooks/commit-msg` refuses a message that breaks this
   (`scripts/check-commit-message.mjs`) — don't `--no-verify` past it — and
   `npm install` switches it on for the whole clone (`core.hooksPath`, which
   every worktree shares). Commits from before the rule keep their messages:
   published history is not rewritten to translate them.

## Default Configuration

```javascript
// AI connection (endpoint, key, model) lives in AI profiles (`aiProfile:<id>`), not settings
targetLang: ''        // empty = follow browser language
theme: 'light'
```
