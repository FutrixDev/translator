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

## Default Configuration

```javascript
apiEndpoint: 'https://api.openai.com/v1/chat/completions'
modelName: 'gpt-4.1-mini'
targetLang: ''        // empty = follow browser language
theme: 'light'
```
