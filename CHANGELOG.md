# Changelog

## 1.3.0 — 2026-08-16

### New features

- **Image OCR** (`shared/ocr.js`, `offscreen/`, `vendor/tesseract/`):
  right-click an image to read the text in it. Two separable steps —
  recognition, then an *optional* translation. Recognition runs on-device by
  default (Tesseract WASM in an offscreen document: free, offline, no API key,
  which is why the `offscreen` permission and `wasm-unsafe-eval` were added);
  a vision model is the alternative for photographs and stylized type. Neither
  engine translates: both return `{text, language}` and the content script
  translates through the ordinary path, so Chrome's free built-in Translator
  serves the vision engine too. With the translate step off, the recognised
  text is a complete result and the popup shows it alone.
- **Region OCR**: a second context-menu entry puts a picker over the image and
  reads only the rectangle the user drew. What travels is fractions of the
  image, never pixels — the page and the worker need not hold the same
  resolution.
- **Recognise-first**: the menu says "recognise", and translation is an
  explicit second step from the result popup. `ocrTranslate` now means
  "auto-translate after recognition" and ships off. An opt-in hover shortcut
  (`enableImageOcrHoverButton`) offers recognition on images ≥200×200 CSS px
  through a single delegated listener.

### Fixes

- **A block's own text is translated, and the translation lands where the page
  has room for it.** Three defects on one reported page. Collection recursed
  over `element.children`, which excludes an element's *direct text nodes* — so
  any block that mixed text with an element child lost that text entirely and
  whole sentences were never sent for translation. Insertion then always chose
  a sibling: the translation of an element that paints its own background
  rendered as naked text outside the box (our reset strips
  `background`/`border`/`padding` off the copied class names), and a list
  item's translation was a sibling `<li>` that never inherited the page's
  inline indent and had its marker suppressed, so it sat flush left with no
  bullet. Direct text runs are now wrapped before recursing, and one rule —
  `getTranslationPlacement` — decides sibling-or-child for both full-page and
  hover translation, which had been answering it differently (hover had no
  table-cell case at all, so hover-translating a `<td>` added a phantom
  column).
- **Links survive on the default engine.** Inline-markup preservation was
  switched off for Chrome's built-in NMT on an assumption that was never
  measured — and that engine is the default, so most users lost every link in
  every translation. Measured instead (12 sentences × 3 targets × 3 runs):
  markers round-trip in the large majority, and the failures are bounded
  (`<a1>` returns as `<A1>`, a closer occasionally dropped). The reader now
  tolerates case and whitespace, auto-closes a missing closer, and scrubs
  debris using a regex built only from the markers that block actually issued,
  so a page's own prose containing `<b2>` is left alone. 99 links rebuilt on
  the reported page, 0 debris.
- **Translations no longer smear over coordinate-driven layouts.** The fit
  guard judges four geometric conditions — the union of source + translation
  escaping an enclosing padding box, a source box that cannot hold its own
  text, and horizontal growth under an absolutely positioned ancestor — and
  treats dropping the translation as a last resort: it first asks the source
  to yield, then re-measures. Measured across three pages, introduced overlaps
  fell to 0/1/1 while translations kept rose.
- Malformed batch responses route through the alignment guard instead of
  landing misaligned.
- Translation-only mode and marker rebuild hardened after review.
- Host-page CSS: a theme's `.kit button` and its heavier `:hover` twin no
  longer outrank the controls we style.
- PDF: one transient failure no longer poisons "translate this PDF" for 24
  hours.
- OCR: broken JSON replies raise an error instead of a half-dead popup; lines
  Tesseract itself did not believe are dropped; the script vote is weighted so
  OCR-garbage Latin cannot outvote real Han; the auto language pair puts the
  user's own script before English.

### Permissions added in this release

| permission | why |
| --- | --- |
| `offscreen` | Run the bundled Tesseract OCR engine. An MV3 service worker may not spawn a nested Worker or instantiate this WASM, so the offscreen document is the only place it can live. |
| CSP `wasm-unsafe-eval` on extension pages | Instantiate that same bundled WASM. No remote code is involved: core, worker and language data all ship inside `vendor/tesseract/` and every path is pinned. |

## 1.2.0 — 2026-08-10

### New features

- **PDF translation** (`pdf/`, account-backed): upload a PDF and receive a
  re-typeset translated document produced server-side against the account's
  monthly free page allowance. Ships enabled by default; requires sign-in on
  first use. Jobs survive page navigation — the service worker polls status
  once a minute via `chrome.alarms` and announces completion or failure via
  `chrome.notifications` (the two permissions added in this release).
- **Video subtitle translation on any site**: the YouTube-only caption
  translator became a general engine (`content/content-video-captions.js` +
  `shared/caption-core.js`) with per-site providers. Any player exposing a
  standard `<track>`/`TextTrack` gets a bilingual overlay with no per-site
  code; YouTube keeps its dedicated interceptor. We only translate subtitles
  the viewer already has on, and hand tracks back exactly as found.
- **Comic translation: colorize mode** alongside translation, hover entry
  points that don't depend on the context menu, results that survive page
  navigation and mode switches, and paid jobs that resume instead of
  re-ordering.
- **Account & free allowance**: comic and PDF translation run on our servers
  behind a signed-in account with a monthly free page allowance. Sign-in state
  is per device (`chrome.storage.local`), preferences per account
  (`chrome.storage.sync`), gated everywhere through
  `shared/account-gate.js`.
- **Reworked translation dialog**: new layout, read-aloud (TTS) buttons for
  source and translation, a reachable and persistent target-language picker in
  the input-translation dialog.
- **Options page autosave**: settings save on change; the connection test runs
  against the endpoint exactly as configured.

### Model/API compatibility

- `shared/api-compat.js` is now the single owner of per-model parameter rules,
  shared by the service worker and the options page.
- Adapted request parameters for GPT-5.6 (`reasoning_effort` floor `'none'`),
  Gemini 3+ (no `temperature`), and current Anthropic/OpenAI lineups; output
  budget floors for models that bill hidden reasoning tokens.

### Fixes

- Host-page CSS can no longer restyle our in-page panels (scoped containment
  reset in `content/content.css`, guarded by unit and e2e tests).
- Read-aloud picks a real voice by language family instead of trusting
  Chrome's first tag match, which could be a novelty voice; handles localized
  parenthesized voice names.
- Input-translation dialog no longer returns typed text untranslated, and
  detects CJK source pages correctly.
- Page translation: translations are no longer clipped away by collapsed
  ancestors; code-highlight classes match by token, not substring.
- Chrome's built-in Translator engine: a wedged instance is abandoned instead
  of hanging the page.
- Options: hotkey pairs can no longer conflict; autosave no longer talks over
  the connection test; custom model names release the model dropdown.
- Account gating: a signed-out device shows server-backed features as off
  without writing that state back to sync, so it can't disable the feature on
  a still-signed-in device.

### Permissions added in this release

| permission | why |
| --- | --- |
| `alarms` | Poll server-side PDF translation job status once a minute; MV3 service workers cannot hold long-lived timers. |
| `notifications` | Tell the user when a PDF translation job finishes or fails, since the job outlives the page that started it. |

## 1.1.1 — 2026-07-26

- Comic translation (server-side redraw, account-backed).

## 1.1.0 — 2026-07-18

- Renamed to "AI Translator"; localized store metadata.
