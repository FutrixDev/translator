# Changelog

## Unreleased

### A word looks itself up like a dictionary

- **Type or select a single word on the AI engine and you get a dictionary
  entry, not just a translation.** Under the translation, the input box and the
  selection card now show UK and US pronunciations, each with its own speaker
  (British and American voices). They also show the senses grouped by part of
  speech, up to three examples, and the word's forms (past tense, plural and so
  on). Both surfaces draw the entry from one shared module, so they always look
  the same.
- **A word or a short phrase is looked up; anything longer is translated.**
  In both the input box and the card, text with no sentence punctuation that
  is one to three words long (or one to four characters in Chinese, Japanese,
  Korean, Thai and similar scripts) gets an entry, so "give up" is looked up
  in both places. Text with a full stop, comma, colon, semicolon, question
  mark or exclamation mark is always translated as a sentence.
- **A short formula is translated, not looked up.** `$x + y$`, `x - y`,
  `\alpha` or `a = b` is translated, not sent off as a dictionary word;
  `x-ray` and `km/h` are still looked up.
- **Your own translation prompt no longer breaks the entry.** The presets on
  the settings page say "reply with the translation only"; a lookup now tells
  the model that the entry format overrides that, so choosing a preset still
  gives a full entry.
- **The built-in engine gives the translation only.** It has no dictionary, so
  switching the card to the built-in engine removes the entry rather than
  showing a half-empty one.
- **A broken entry is reported, not guessed at.** If the model's answer cannot
  be read as an entry, the box shows "The dictionary entry could not be read.
  Please try again." It used to guess a phonetic from the first line of
  whatever came back. A reasoning model's `<think>` block before the entry is
  ignored, and a part of the entry that comes back in the wrong form (senses
  written as one line of text, say) is left out rather than failing the whole
  lookup.

### PDF and comic translation show in the popup before you sign in

- **The popup offers "Translate this PDF", "Translate a local document" and
  the two comic rows even when this device is not signed in.** They used to
  appear only after signing in, so a signed-out user on a PDF or a comic page
  found nothing to click. Clicking one now asks you to sign in first, then
  carries on: the PDF is sent, or the comic page is redrawn, without a second
  click. On a page the extension cannot reach (or a .pdf link that turns out
  not to be a PDF) the click opens the sign-in and the PDF takes one more click
  afterwards. Closing the sign-in tab simply does nothing.
- **Turning a feature off in Settings still hides its rows**, signed in or
  not. The PDF task list still shows only when signed in, since the tasks
  belong to the account.

### The X sidebar is translated

- **News headlines and trends in X's right column are now translated.** The whole sidebar used to be kept in its original language, so
  auto-translate on X left "Today's News" and "What's happening" in English.
  Scores and other numbers are still left alone, as are short button labels. A
  translation that would overflow its box is still taken back. Team names on a
  scoreboard are words, so they are translated. "Who to follow" is still left
  alone: it is only names, handles and Follow buttons. The left navigation is
  still not translated.

### Text already in your language is skipped even when it carries foreign terms

- **A paragraph written in your language is left alone even when it is full of
  foreign names.** "Skip text already in the target language" used to hand the
  whole paragraph to Chrome's built-in language detection, and a Chinese tech
  paragraph full of English product names came back unsure or wrong (55% Chinese,
  sometimes Kazakh or Japanese). It was then translated into the language it
  was already written in. Each paragraph is now checked sentence by sentence.
  Short runs of another alphabet, such as "kubectl apply" or "Next.js App Router",
  are set aside first. Only the remaining text goes to the detector. This works
  both ways, so an English sentence with one Chinese word in it is English to an
  English reader.
- **A real foreign sentence still gets translated.** If any sentence in the
  paragraph is foreign, the whole paragraph is translated, even when most of it
  is in your language. That covers a full foreign sentence, a foreign clause
  longer than six words, or a sentence where foreign words outnumber yours more
  than two to one. The whole paragraph is now read, not just its first 400
  characters, so a foreign sentence at the end is no longer missed. Japanese
  is never mistaken for Chinese, because kana and hangul are never set aside.

### Serbian, Uzbek and Kazakh pages keep their language in either alphabet

- **Short text in a language written in two alphabets keeps the page's
  language.** Serbian is written in Cyrillic and Latin, Uzbek and Bosnian in
  Latin and Cyrillic, Kazakh is moving from Cyrillic to Latin. A short block or
  a typed phrase in the alphabet the language "usually" doesn't use was ruled
  out as the page's language. It then went to a guess, either English or
  whatever the detector picked. Both alphabets now count for these languages.
  The "skip text already in your language" check also no longer reads
  Latin-script Serbian as foreign.
- **Pages in a language the built-in translator doesn't support keep their own
  alphabet.** A short Cyrillic line on a Kazakh or Mongolian page used to be
  treated as not Kazakh or Mongolian. It is now read as the page's language.

### Reddit and X: only the content is translated

- **Sites on the built-in Always list are translated in their main content
  only.** Reddit's left nav, rules sidebar and community card, and X's left
  nav, no longer fill up with translations; X's trends and who-to-follow
  column keeps its original text. Choosing "whole page" in Settings still
  translates everything.
- **Text written only for screen readers stays untranslated.** Reddit's
  "Go to comments" inside a button, `.sr-only` labels and the like are
  invisible on the page, yet their translations used to show up next to
  buttons and links. They are recognised by how they are hidden (clipped to
  nothing, or a 1px box), not by class name, so this works on any site.
- **Button labels and bare numbers are left alone.** "Share", "Join", the
  "Hot" and "Rising" tabs, vote and comment counts, rule numbers and scores
  used to get a translation squeezed in beside them, which knocked the whole
  action row out of line (and a number translates to itself). A short label
  counts only while its control's visible text is short (at most 3 words or
  30 characters, and not a sentence), so a card built as one big button, or
  a longer button like "Show more of this", is still translated; so is any
  control that holds a heading or paragraph, even a three-word one. Chinese,
  Japanese and Korean labels count two characters as a word, so a whole CJK
  headline is not mistaken for a label, and an icon's SVG title does not
  count as visible text. Links are never treated as controls. On Reddit's rules list the rule number no longer
  gets a column of its own; each rule's translation stays under its text.
- **A translation that would cut off text in a one-line row is dropped.**
  Rows that clip their overflow with an ellipsis used to end up showing the
  first few words of the original and the first few of the translation. Now
  the translation first gives the space back to the original; if the row
  still cuts off more than it did before, the translation is removed and the
  original shows as it did. Rows that scroll sideways are left alone.

### A new look for the popup and the float ball

- **The popup, the float ball and its menu wear the new brand.** Warm paper,
  ink-dark type and one indigo-violet button for the action that matters,
  in a light and a dark theme. The popup reads top to bottom: translate this
  page, the switches for what happens next time, how translations look, the
  occasional tools, then a footer that says whether anything needs attention.
  Every row shows and hides exactly as before, with the same wording.
- **The float ball is the fanned-pages mark on a warm-white ball**, in both
  themes, so it stays recognisable on dark and light pages alike. Its status
  dot takes the mark's colours: sky while translating, amber when partly
  done, grey when paused, coral on an error.
- **Page styles on bare tags can no longer repaint our icons.** A site rule
  such as `svg { fill: … }` or `path { stroke-width: … }`, including a
  `.kit button:hover svg` rule, used to fill in or thicken the outline icons
  of the float menu; they now keep their colour, stroke width and round ends.
  A page rule scoped by a class of its own on the path itself can still reach
  them, and the selection button, the rule picker, the subtitle controls and
  the auto-translate bar have not moved to the new look yet.
- `DESIGN.md` at the repository root documents the colours, type, shapes and
  components of these surfaces.

### Popup, site policy and prompt register

- **The popup's buttons work the moment it opens.** Clicking the toolbar icon
  no longer leaves "Translate this page" dead while a busy tab takes seconds
  to report its state: the buttons are wired before the popup asks the page
  anything, the page's rows wait at most 300 ms before drawing as unknown and
  repaint when the late answer lands, and the engine probe runs alongside
  instead of after it.
- **Sites nobody has ruled on stay quiet.** The "Translate this page?" bar is
  gone, along with its three-asks counter and the list of page languages that
  decided whether to ask. A site that is on no list is simply left alone: no
  bar, no request, and it does not count as a refusal, so video captions and
  other page-level helpers still work there. Turning a site on is one click in
  the popup, the settings page or Alt+A.
- **Common social, Q&A and news sites translate by themselves.** Threads,
  Bluesky, Facebook, Instagram, Medium, Substack, Quora, Stack Overflow, Stack
  Exchange and eleven major news sites (The New York Times, The Guardian, BBC,
  Reuters, AP News, The Washington Post, The Wall Street Journal, Bloomberg,
  CNN, the Financial Times and The Economist) join the built-in list. YouTube
  is listed as a captions site: its page text stays as it is while its
  captions are translated. Your own rule for any of them still wins.
- **Direct messages are never translated on their own.** On X, Twitter,
  Facebook, Instagram, Reddit and Bluesky the private-message pages
  (`/messages`, `/i/chat`, `/direct`, `/chat` and chat.reddit.com) are left
  alone even though the rest of the site translates by itself, and even if you
  set the whole site to always translate: nothing from a conversation is sent
  to the AI without a click. "Translate this page" and Alt+A still translate a
  conversation when you ask. This also holds when you click into a
  conversation from the home timeline: the address is checked again right
  before anything is sent, so a message is never sent under the timeline's
  verdict while the site's router is still finishing the navigation. On such a
  page the tooltip on the popup's greyed site row now says the page is not
  auto-translated, where it used to say the whole site was on the blocklist.
- **Videos get their own subtitles switched on for you.** "Turn subtitles on
  automatically" is now on by default, so a video whose subtitles are off has
  something to translate. Switch them off in the player and they stay off in
  that tab, on later videos too, until you reload the page or choose "Turn on
  subtitles" in Blab Translation's own subtitle menu in the player (the small
  arrow next to its icon), which is what the setting's description under Video
  captions now says.
- **An auto-translate switch in the popup.** The popup's first row turns
  automatic translation on or off everywhere. It is the same setting as
  "Translate pages automatically" in Settings, and switching it off stops the
  current page on the spot: nothing new is sent, while what is already
  translated stays. Its On/Off label appears once the setting has been
  read, so there is no empty box beside it while the popup opens.
- **Manage sites from Settings.** Under "Translate pages automatically" you
  can now type a site (a whole address works too: `https://www.` and the
  path are dropped) and set it to always or never translate, switch a rule
  between the two, or remove it. A mistyped address, or a site that is never
  translated, is explained under the box. The built-in lists are shown below,
  folded: turn off a listed site with one click. The note under the sites that
  are never translated says what that means: never automatically, while
  "Translate Page" in the popup still translates one when you ask. A captions-only site gets
  two buttons, one to translate its page too and one to stop translating it,
  subtitles included. An open tab of that site follows at once.
- **One click in the player turns subtitle translation off and on.** The
  icon in the video's control bar is now a switch for this video: pressed, the
  translated subtitles show; click it and they go away and the video's own
  subtitles come back; click again to bring them back. On YouTube it sits
  right before the CC button. The menu it used to open is still there, behind
  the small arrow next to the icon, and is reachable from the keyboard.
- **AI translations keep the tone of the page.** Every prompt that
  translates text now tells the model to match the register of the source: a
  meme or a slang reply stays casual instead of turning formal or being
  explained. A custom prompt keeps its own wording and gets that rule added
  after it. Looking up a single word is a dictionary entry and has no tone to
  keep, so its prompt does not carry the rule. On the social, forum, news and
  academic sites in the built-in list, the AI engine is also told which of
  the four kinds of page it is reading. Only that label is sent, never the
  site's address, and a page inside a frame is described by its own address,
  not the page around it. Chrome's built-in translator reads no prompt and
  is unchanged. Cached translations are kept apart per kind of page. A
  custom prompt left as nothing but spaces or blank lines now counts as no
  custom prompt on every path; translating one paragraph used to send it as
  the whole instruction instead of the default one.

### PDF and comic shortcut

- **`Alt+M` translates the PDF or the comic on screen.** On a PDF it starts
  the PDF translation; on a comic reader it translates the pages on screen;
  anywhere else it says there is nothing to translate. Change the key at
  `chrome://extensions/shortcuts`.
- **A hint that names the shortcut.** A PDF shows a small bar, "Press Alt+M
  to translate this PDF", with a Translate button. A comic reader (three or
  more wide pages stacked one right under the next, taller together than the
  window) shows the same kind of bar once per site, as soon as one of its
  pages is on screen; a feed or an article with pictures a post apart, or a
  sidebar column of thumbnails, does not. Nothing is sent until you press the
  key or the button, and pressing either with no comic page on screen says so
  and keeps the bar. If the shortcut is unbound, the bar offers a link to set
  one.
- **Not signed in? Sign in, then it carries on.** The key and the button open
  the sign-in first and start the translation as soon as you are back.
  Closing the sign-in tab cancels quietly. The "sign in to translate
  documents" notification now has a Sign In button too.
- **Turned off stays off.** If you switched PDF or comic translation off in
  settings, the hint no longer appears. The key still works on the page you
  use it on, and your setting is left as it is. You can switch either one off
  without signing in; while you are signed out, a switch that is on says it
  takes effect once you sign in.
- **Comic translation is on by default,** like PDF translation.

### Float ball over full-screen video

- **The float ball steps aside for "web fullscreen" too.** Players that fill
  the page without the browser's fullscreen mode (a site's own "web
  fullscreen" button, or a player filling a fullscreen browser window) used
  to leave the ball on top of the video. It now hides while a video fills the
  window and comes back when the player shrinks. A muted, looping background
  video does not count, and neither does a video the page draws its own
  content over.
- **So does the bar in the bottom-right corner.** The PDF and comic hint, the
  status line you open from the ball's dot, and the "couldn't save" notice
  all share that bar; in standard or web fullscreen it now hides with the
  ball and comes back, unchanged, when the video leaves the screen.

### Selection icon and card actions

- **A translate icon next to your selection.** Select text and a small round
  icon appears beside the line you released the mouse on; click it for the
  translation card. It goes away when you scroll, press `Esc`, click
  elsewhere or clear the selection, and never appears inside input boxes,
  text areas or editable text.
- **Choose how a selection starts translating.** Settings → Selection
  trigger: the icon, the modifier key, or both (the default, so nobody who
  relied on the modifier key loses it). The hotkey conflict check ignores the
  modifier key when the trigger is icon only.
- **The card sits beside the selection, not on top of it.** It opens below
  the selection, or above it near the bottom of the window; long text shrinks
  the card and scrolls inside it, and the card stays inside the window. Once
  you drag the card it stays where you put it.
- **Card actions: retranslate, switch engine, copy, read aloud.** The card
  says which engine answered (Chrome built-in or My AI). Retranslate asks the
  engine again; switch engine translates this card with the other engine,
  when it is usable, without changing your settings and without falling back
  to anything else.
- **The card's buttons stay where they are.** A button whose label changes —
  Copy to Copied, or the switch-engine label after a switch — is as wide as
  its longest label, so the row never rewraps and no other button moves under
  the pointer, in all ten interface languages.
- **Errors show on the card, not as a translation.** A failed request — from
  the icon, the modifier key, the float ball or the right-click menu — shows
  its reason in the card's error line, and Retranslate tries again.
- **The language menu opens at your language.** Opening the target language
  menu on the card or the input box scrolls the selected language into view,
  inside the menu only; the page stays where it was.
- **Right-to-left translations read from the right.** The card marks its
  translation with the target language and its direction, so Arabic, Hebrew,
  Persian or Urdu start at the right edge even on a page that aligns
  everything left.
- **Switch engine only offers what can answer.** The card no longer offers
  the Chrome built-in engine for a target language it cannot translate into
  (the ones the menu tags "AI only").
- **Importing settings checks the selection trigger.** A value other than
  icon, modifier key or both is left out of the import and listed as skipped.
- **Fix: a copy button clicked twice no longer stays on "Copied".** The card
  and the input box each put back the label they found when clicked, which on
  a second click within 1.5 s was "Copied" itself. They now share one copy
  button that returns to its own label 1.5 s after the last click.

### Site translation rules

- **Tell a site what to translate.** A new Site Translation Rules card in
  Settings holds rules of your own, one per set of sites
  (`example.com`, `*.example.com`, `example.com/docs/*`). A rule can say
  which areas to translate, which to leave out of the translation, which to
  keep as the original inside it, add CSS for the translations on that site,
  and pin the engine (built-in or your own AI) for that site. Rules take
  effect on open pages as soon as they are saved, with no reload.
- **Pick an area on the page.** "Adjust what gets translated here" in the
  float-ball menu and in the toolbar popup outlines what the pointer is over;
  click, move up with Parent, check the match count, then choose Don't
  translate here, Keep original or Only translate here. The selector it
  writes can be edited before saving.
- **Don't translate versus keep original.** On a whole block both mean the
  block is not translated. On a word or link inside a paragraph, Don't
  translate here leaves it out of the translation, while Keep original keeps
  it, unchanged, inside the translation.
- **Your rules win over the built-in site list**, which can only keep text
  as the original. A pinned engine never falls back to the other one.
- **CSS stays local.** Anything in a rule's CSS that can load something from
  the network (`url(`, `@import`, `@font-face`, `image(`, `attr(` and
  similar), a backslash, or more than 4096 characters is refused, even inside
  a comment, both when saving and again on the page.
- **Rules sync with your browser account** (one sync key per rule, at most
  6 KiB each, 24 KiB and 50 rules in total) and can be exported and imported
  as `blab-site-rules-YYYYMMDD.json`. The Import & Export file now carries
  them too; an import is previewed (added, replaced, and how many would let
  automatic translation use your AI) and is all or nothing.
- Choosing AI as a rule's engine asks first, like choosing AI for automatic
  translation, and the daily AI limit field is enabled while any rule uses
  AI.
- No new permissions.

### Onboarding page and settings import/export

- **A welcome page on first install.** A fresh install (not an update) opens
  `onboarding/onboarding.html`: whether the on-device language pack for your
  target language is ready, with a download button that only runs when you
  press it; the target language; the engine, built-in or AI, where choosing
  Ollama or LM Studio fills in the local connection and opens Settings at the
  connection card; and the extension's keyboard
  shortcuts as Chrome reports them. Every choice is saved at once and sent to
  open tabs.
- **Export and import settings** from a new Import & Export card on the
  Settings page. The file is `blab-settings-YYYYMMDD.json`
  (`{format: 'blab-settings', version: 1, exportedAt, settings, siteRules}`).
  The API key is only included when you tick the box; device-local data
  (caches, usage statistics, account sign-in, per-site prompt counters,
  panel positions) never is.
- **An import is previewed before anything is written**: settings that
  change, settings skipped as unknown or invalid, site rules merged in, and
  parts of the file this version does not recognise. It warns when the import
  would let AI translate without a click, and when it moves the API endpoint
  while your saved key stays. Confirming merges the file over your settings
  and tells open tabs.
- **A bad file changes nothing.** Not JSON, not a Blab Translation file, a
  different file version, a damaged part, over 1 MB, or a selection/hover
  hotkey clash: the whole file is refused before any write.
- **Primary buttons meet 4.5:1.** White text on the settings page's primary
  buttons and the welcome page's accent buttons was 4.35:1 or lower; they now
  use darker accent fills.
- README: the repository address is `github.com/FutrixDev/translator`, and the
  page-translation batch sizes match the code (40 paragraphs or 9,000
  characters per batch, 4 concurrent on the built-in engine, 12 on AI).

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

### Page translation reaches more of the page

- **Embedded frames.** Page translation now follows the text into iframes
  (including `about:blank` and `srcdoc` frames): the top frame drives, every
  eligible frame translates its own text through the same engine, and showing
  or hiding translations applies to all of them. Ad, payment, captcha and sign-in frames
  are never read at all: the content script stops before it builds anything
  there (`shared/frame-eligibility.js`).
- **Shadow DOM, open and closed.** Text inside web components is collected and
  translated in place, and our translation styles reach inside the shadow root.
- **`translate="no"` and `.notranslate` are respected.** A block the page marks
  that way is skipped (a `translate="yes"` inside it is honoured); a word marked
  that way inside a sentence, such as a product name, is kept as it is and not
  sent.
- **Main content only, by default.** Navigation, sidebars, menus, headers and
  footers are left alone. Settings has a new "Page translation scope" choice
  (Main content only / Whole page).
- **Whole page on demand.** "Translate Whole Page" in the float ball's menu, or
  Alt+W, translates everything on this page once, without changing the setting.
- **The context menu item now reads like the float ball's.** In Simplified
  Chinese, Traditional Chinese, Japanese and Korean the right-click item used
  the "whole page" wording while running the main-content scope; it now says
  "Translate Page", like the float ball and the popup.

No new permission.

### A finished document opens in the reader

- **One button, View, for every finished document.** The job page no longer
  offers "Open Bilingual PDF", "Open Translated PDF" or "View on the web";
  View opens the document in the web reader, whose download menu has the
  bilingual and translated PDFs and the translated file. A MOBI, which used to
  have only the website link, gets View too.
- **Word, EPUB, TXT and Markdown still save from the page.** "Save Bilingual
  File" and "Save Translated File" stay beside View, so the file keeps your own
  name.
- **The popup, the settings list and a clicked notification go to the same
  place.** A finished job of any format opens in the reader; a job waiting on
  your confirmation still opens its page through **Review**. The settings
  list's per-row "View on the web" link is gone; the link to the web library
  stays in the card header. A running or failed row has no button; its status
  line says where it stands.
- **No dead button.** If the account's site address is not a web address,
  the page says the reader cannot be opened instead of showing View.

No new permission.

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
  language, a small "Translate to English" chip appears at the box's corner. A
  click writes the translation straight into the box: a multi-line box (a text
  area, or a rich editor such as a comment box) keeps what you wrote and adds
  the translation on a new line below it, and a single-line box has its text
  replaced. One Ctrl/Cmd+Z takes it back. The chip reads "Translating..." while
  it works and goes away once the translation is in. If the request fails, or
  the translation would not fit the box's length limit, the box is not touched
  and the chip turns red with "Translation failed, please retry"; clicking it
  again retries. The chip also turns red when the box, read back after the
  write, does not hold your text with the translation on its own line below
  it; the box may already have changed then (an editor can take the text a
  moment late, or insert it twice), so if the box no longer holds just your
  text, a retry treats the translation as written and clears the chip instead
  of adding it again. If you keep typing or move to another box before the
  answer arrives, nothing is written; the same holds if, just before writing,
  the box has lost focus, lost the cursor, changed or left the page. While an
  input method is still composing (a pinyin candidate window is open, say)
  the chip does not appear, and a click on it does nothing. There is no time
  limit on the request: the chip stays busy until the answer arrives or you
  type, press Esc or leave the box. It never submits, never presses Enter and
  never moves the cursor to another box. Language detection is local and
  nothing is sent until you click. Password, username, one-time-code and card
  fields never get the chip. Settings has a switch for it; the float ball's
  input translator still opens its own window.
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
