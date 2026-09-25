# Changelog

## Unreleased

### 76 target languages and right-to-left layout

- **76 target languages instead of 10.** The list is Chrome's own interface
  languages, which include all 39 that Chrome's built-in Translator can
  translate on-device; the other 37 go through your AI service. There is one
  list in the extension, `TargetLang.SUPPORTED` in `shared/target-lang.js`.
- **Language names are in your interface language** and sorted the way that
  language sorts, computed by `Intl.DisplayNames` rather than written out: an
  English interface says "Japanese", not "日本語". The interface-language picker
  still names each language in itself. Comic and PDF translation keep their 10
  languages, named the same way.
- **A language the built-in engine cannot translate into is named, not
  swallowed.** The settings page says so for the chosen target, in the sentence
  your fallback setting calls for, and hides the language-pack download button.
  The in-page language menus tag such languages "AI only". A page that asks the
  built-in engine for one, with AI fallback off, fails with an error that names
  the language; nothing falls back to AI or to English on its own.
- **Every translation on a page carries its own `lang` and `dir`.** A
  translation into Arabic, Hebrew, Persian or Urdu is laid out right-to-left and
  aligned to its own start edge when the page runs the other way; a
  right-to-left page translated into English is laid out left-to-right. The
  indent next to a leading icon and the 4px gap beside a translated nav link
  stay on the source's start side. Loading and error text is marked with the
  interface language.
- **Read-aloud says when this device has no voice for the language**, instead of
  staying silent: the button shows a no-voice state.
- **Compatibility.** Stored values do not change: `targetLang` still holds a
  code, `zh-CN` / `zh-TW` keep their names, and `''` still means "follow the
  browser". Every code an older version could store is still in the list. What
  changes is "follow the browser": a browser language outside the old ten used
  to be translated into English and is now followed. For the 37 AI-only
  languages under the default setup (built-in engine, AI fallback off) that
  means a named error in place of an English translation, telling you to switch
  the engine to AI, allow AI fallback, or pick another target. Cached
  translations are keyed by request language, so none is reused for the new
  one.

### Local models without an API key

- **Ollama, LM Studio and other local model servers work with the API Key box
  left empty.** Before, every surface checked for a key on its own and refused
  a local setup before any request was sent. There is now one rule,
  `APICompat.requiresApiKey()` in `shared/api-compat.js`: the Ollama and LM
  Studio presets, and any endpoint on a loopback address, a private LAN
  address or a `.local` name, need no key. Remote endpoints still do. An empty
  key sends no `Authorization` / `x-api-key` header at all.
- **API errors are shown in your UI language.** They used to be Chinese
  sentences written in the shared API layer, whatever language the extension
  was set to. That layer now reports what happened (an HTTP status, or no
  answer at all), and the page, the popup or the settings page words it in the
  UI language, in all ten.
- **A local server that refuses the extension says how to fix it.** Ollama's
  403 names `OLLAMA_ORIGINS=chrome-extension://*`, LM Studio's names its CORS
  switch and `lms server start --cors`, and a server that is not running is
  named by its address.
- **The settings page says the key is optional** when the chosen provider or
  endpoint is local, and **Test Connection** goes through to the local server
  instead of asking for a key.

### Translation styles and display switch

- **Six translation styles.** Settings → Translation style, or the style
  select in the popup: Default, Underline, Dashed box, Highlight, Quote bar,
  and Blur until hovered. A style is one attribute on the page's `<html>` and
  one CSS rule (`content/css/translation.css`); switching restyles translations
  already on the page and sends nothing to the model. Every style keeps a
  translation's box where it was, except Quote bar, which indents it by its
  bar. The list lives in one place, `shared/translation-display.js`.
- **Blur** clears on hover, on keyboard focus, and on a tap (a second tap
  blurs it again). Hover only counts on devices that can hover, because a
  touch screen leaves the tapped element "hovered" until you tap elsewhere.
  Blur is off in translation-only mode, where there is no source to read
  instead, and on the translation of a link that is itself a block: that
  translation is drawn as a link taking no pointer events, so nothing could
  reveal it.
- **Bilingual or translation only from four places:** the new Display row in
  the popup, the float ball menu row (**Show Translation Only** /
  **Show Bilingual**), the Settings checkbox, and a new shortcut, `Alt+T`
  (`toggle-translation-only`, rebindable at `chrome://extensions/shortcuts`).
  All four only write `showTranslationOnly` to sync storage; open pages switch
  from their storage listener, without a reload and without a request.
- **See the original in translation-only mode.** Point at a page translation,
  or tap it, and its source text opens in a small card beside it. The card
  never covers the pointer, stays inside the window, and closes when the
  pointer leaves, on a second tap, or on `Esc`.
- **Fix: the settings page no longer writes stale values back.** It saves the
  whole form at once, so a switch changed elsewhere while it was open (from
  the popup, the float ball, `Alt+T`) was silently reverted the next time you
  touched any other control there. The page now follows those changes into its
  controls (`options/options-sync-mirror.js`) without saving them again.
  Text fields you type into are not followed, so typing is never overwritten.

### Document translation: Word, EPUB, MOBI, TXT and Markdown

- **The upload page takes six formats**: PDF, Word (`.docx`), EPUB, MOBI
  (`.mobi`, `.azw3`), TXT and Markdown (`.md`, `.markdown`), up to 30 MB for a
  PDF, 50 MB for Word, EPUB and MOBI, and 10 MB for text. An empty file, a
  file whose contents do not match its extension, an unknown type, an
  oversize file or a book over 800 pages is refused on the page, with the
  reason, before anything is uploaded.
- **The page uploads the file itself**, straight to storage through a
  one-time signed address; the background worker no longer carries the bytes.
  Word, EPUB, TXT and Markdown are measured on your computer and the page
  count goes with the job, so the estimate is right the first time.
- **A document that turns out longer than estimated asks before it
  continues.** The popup shows the job as "Needs your confirmation" with a
  **Review** button, a notification says so, and the page shows how many more
  pages continuing uses. **Continue** or **Cancel Task**; doing nothing
  cancels it at the stated time with a full refund. This state used to raise
  a false "failed" notification, read "Queued", sit under History in Settings,
  and be forgotten after 24 hours of a 72-hour window.
- **Results by format.** A PDF opens in a tab as before; Word, EPUB, TXT and
  Markdown are saved as `<name> (bilingual).<ext>` or
  `<name> (translated).<ext>`; a MOBI is read on the website. **Open** in the
  popup, the settings list and a clicked notification all go to the same
  place: the result for a finished PDF, the job's page for everything else.
- **The status line only moves forward.** While a task writes out the
  translated file at the end, the upload page no longer drops back to
  "Translating…" after "Retypesetting…"; the same goes for PDFs.

## 1.4.0 — 2026-09-20

### New features

- **Automatic translation.** A page is translated on open, with no click, on
  the sites you have set to Always and on the ones our built-in list already
  covers; anywhere else you are asked once and the answer is kept. The
  decision is one function — `SiteRules.decide()` in `shared/site-rules.js` —
  and it answers one of five things: translate, don't, ask, this site is off,
  this page's language is not one you asked to have translated. Three inputs
  feed it, in strict precedence: **a rule you set for this site beats a rule we
  ship, and both beat the language list.** So a site you told us to leave alone
  stays alone even after it changes language, and the built-in list of sites
  worth translating (`shared/site-rules-builtin.js`) never overrules something
  you decided yourself.
- **One click can be a permanent answer.** The bar that appears on an
  undecided page asks 「这一页要翻译吗？」 with 「翻译」 and 「不用」, and a
  「总是翻译 <site>」 box: ticked, 「翻译」 writes a rule for that host and the
  bar never appears there again. A site that has been asked three times
  without a yes is not asked again. The other answer — never — is the
  「自动翻译这个站点」 switch in the toolbar popup (or the in-player menu)
  turned off, or 「不再自动翻译 <site>」 on the float ball. Rules apply down
  parent domains, so a decision about `reddit.com` covers `old.reddit.com`.
  Every rule you have made is listed in the settings page, and **every one of
  them can be deleted there** — an answer you gave by accident is one click
  from being unmade.
- **Subtitles are part of that same decision.** Video subtitle translation used
  to be a switch of its own, off by default, on the second card of the settings
  page — which meant that on a site you had told us to translate, the page was
  translated and the subtitles were not, and that telling us to stop on
  youtube.com stopped the page text while the subtitles carried on. It is now
  the same gate: a site you have not refused gets translated subtitles, and a
  site you have refused gets none. The switch is gone from the settings page,
  and the first row of the in-player menu is now the same sentence the toolbar
  popup says — 「自动翻译这个站点」 — reading and writing the same rule, so it
  shows what the popup shows: on for a site you have turned on, off for a site
  you have said nothing about. **If you had the subtitle switch off, note that
  subtitles will now be translated on sites you have not turned off**. On a
  site you have said nothing about, that row reads off while subtitles are
  being translated — it answers "is this site set to translate?", not "are
  subtitles on?" — so the menu and the popup show one more row right under it
  there, 「不再自动翻译 youtube.com」 ("Stop auto-translating youtube.com"),
  the float ball's own wording. One click stores a never rule for the site,
  subtitles stop on the spot, and the row goes away; it is remembered.
- **A page can be paused without a decision.** Alt+A, the toolbar popup and the
  float ball all toggle the page you are looking at, for this visit only, and
  leave no rule behind.
- **Single-page apps are followed.** `shared/spa-navigation.js` watches the
  History API and the URL, so a new article on a site that never reloads gets
  the same treatment a fresh page would, and the old page's translations are
  dropped rather than left to attach to the wrong text.
- **A translation cache.** Text already translated with the same engine, model,
  prompt and target language is not sent again (`shared/translation-cache.js`),
  which makes a second visit free and a back-button navigation instant. Entries
  expire after 30 days, and the settings page has a button that empties the
  whole cache — what the privacy policy promises has to be a thing you can
  actually press.
- **Site adapters** (`content/page/site-adapter.js`): the containers worth
  translating and the furniture worth skipping, per site, for the handful where
  a generic sweep gets it wrong.
- **Papers, not just abstracts.** The built-in list now covers arXiv's full
  HTML papers (`/html/*`, which is also ar5iv — same domain suffix, same
  paths), its listing pages (`/list/*`) and Hugging Face's Daily Papers.
  Author blocks and bibliographies are skipped on the full-text pages: a
  translated reference list is one you can no longer search with.
- **Five more reading sites** on the built-in list: Lobsters, bioRxiv, Nature,
  Science and Google Scholar — each skipping what is not prose there (author
  lines, citation and DOI lines, reference lists, tag and link rows), with
  every selector checked against the site's real
  markup (Science sits behind a Cloudflare challenge, so its selectors were
  checked against archived copies of two article pages). Google Scholar is
  covered on its country domains too — `scholar.google.co.jp`,
  `scholar.google.de` and fourteen more — because a rule's `match` may now
  list several addresses for one site. They are listed one by one, not as
  `scholar.google.*`: without a public-suffix list that wildcard would also
  claim `scholar.google.evil.com`, so the table rejects a `*` in a host.
- **arXiv PDFs get an offer, never a job.** On `arxiv.org/pdf/*` a bar says
  this is a PDF and that translating it spends page credits; the server-side
  PDF translation behind it is billed per page, so **nothing is sent to it
  until the bar is clicked** — not even a price check. A path-level `never` rule keeps whole-page translation off those
  pages, since the document is not in the page's DOM and the ask bar would
  have translated nothing.
- **Automatic translation has an engine of its own, and a daily AI
  allowance.** 「自动翻译用哪个引擎」 defaults to Chrome's on-device
  translator whatever the manual engine is, so switching to AI for your own
  selections no longer turns every automatic page into a paid one; choosing
  AI for automatic translation asks first. What the zero-click paths spend on
  AI is capped per day (200,000 characters by default, 0 for no cap),
  checked before anything is sent and counted on this computer only. Video
  subtitles keep following the manual engine — swapping engines mid-video
  would change the translation style under the playhead — but their AI
  characters count toward the same allowance; when it runs out the in-player
  menu says 「今日 AI 额度已用完」 and subtitles resume on their own once the
  allowance is raised or the day turns. The allowance field in Settings is
  greyed only when no zero-click path can reach AI at all.
- **Stop a site from the float ball.** The first row of the float-ball menu is
  「不再自动翻译 <site>」 — undoing an automatic decision should not take a
  trip to Settings. It writes the same rule as the popup and the in-player
  menu, then restores the page.
- **A translate chip in text boxes.** When what you type is not in the page's
  language, a small 「译成 English」 chip appears at the box's corner; a click
  opens the input translator with your text. It never rewrites your input,
  language detection is local, and nothing is sent until you click. Settings
  has a switch for it.
- **On this computer** — a small panel in the settings page counting the pages
  translated this month, how much the cache saved, and how many characters
  actually went to the model. It lives in `chrome.storage.local`
  (`shared/auto-stats.js`): **it is not synced, and not sent anywhere.** It is
  a mirror for you, not telemetry for us.

### Fixes

- **A page and its subtitles no longer disagree about what language you
  read.** Page translation compared base codes (`zh`) while the caption engine
  compared whole tags (`zh-TW`), so on a Traditional Chinese page with
  Simplified as your target the subtitles were translated and the body text was
  silently skipped — the same question, two routes, two answers. There is now
  one owner of that judgement, `shared/lang-tags.js`, and both routes ask it:
  whole tags, so Simplified↔Traditional is a real translation and `en-GB` to
  `en` is still not. The language list in the settings page keeps working on
  base codes, because what you tick there is 「中文」, not 「简体中文」.

  Chrome's own language detector cannot tell the two scripts apart — it answers
  a plain `zh` for both — so for Chinese the script is now read off the
  characters themselves before that judgement is made. Only characters that
  exist on one side and not the other count; 后, 几, 台 and 里 are ordinary
  words in Traditional text too, and counting them would have read a Traditional
  page as Simplified.

  The default engine asks the same question a second time, one layer down, and
  it was getting the same bare `zh`: Chrome's built-in translator knows
  Simplified and Traditional as two separate languages, so a Traditional page
  with Simplified as the target came back as "source and target are the same
  language" and every block was handed back untranslated. It now reads the
  script the same way the gate above it does.

- **One answer to 「which language do I translate into」.** Three copies of
  「follow the browser」 disagreed, so a fresh install on a French browser had a
  context menu reading 「译成 Français」 while page translation went to
  Simplified Chinese, and a `zh-Hant-TW` browser got Simplified text under a
  Traditional label. `shared/target-lang.js` is now the only copy.
- The context menu follows a change of interface language at once, instead of
  at the service worker's next cold start.
- Subtitles use the persistent translation cache, so watching the same video
  again, or the next day, does not pay for the same lines twice.
- 「总是」 on the ask bar now goes through the same write as the popup and the
  player menu; on a page whose site cannot hold a rule (a `file://` page) it
  says the setting could not be saved, instead of looking saved and asking
  again next time.
- A page stuck on a missing built-in language pack now recovers by itself the
  moment the pack lands, whether it was downloaded by the page's own prefetch
  or by the button in the settings page — previously it stayed blank until a
  reload.
- Twenty-seven settings-page strings that were English in the other nine
  locales are translated, and `test/unit/i18n-locale-coverage.test.mjs` now
  fails on the next English-only string instead of letting it ship.

## 1.3.1 — 2026-08-18

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
