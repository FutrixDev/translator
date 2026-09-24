# Translator Extension Technical Plan

## Goals
- Collect text blocks for translation in batches and translate concurrently for performance.
- Preserve math symbols, MathJax/KaTeX/MathML, and plain-text LaTeX in both input and output.
- Allow users to provide their own AI API key and endpoint.
- Allow users to define a custom prompt applied to single, batch, and page translation.

## Architecture Overview
- Content script scans the page for translatable blocks and inline elements, skipping code and non-text nodes.
- Background service worker handles API calls to OpenAI-compatible or Claude endpoints.
- Options page stores settings (API key, endpoint, model, prompt, UI theme) in `chrome.storage.sync`.

## Translation Flow
- Selection translation: content script sends `TRANSLATE` with selected text.
- Page translation: content script collects blocks, creates batches, and sends `TRANSLATE_BATCH_FAST`.
- Background returns translations; content script inserts translated blocks inline or as siblings.

## Batch + Performance
- Batches are created by max item count and max char count.
- Concurrency is controlled with a promise pool to reduce latency.
- Fast batch mode uses a delimiter to split and reassemble outputs consistently.

## Math + LaTeX Handling
- DOM math (MathJax/KaTeX/MathML) is replaced with placeholders during extraction.
- Plain-text LaTeX (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`) is also replaced with placeholders.
- Prompts always include a placeholder rule; placeholders are reinserted in the output.

## Settings + Customization
- Users set API key, endpoint, and model in the options page.
- Custom prompt is applied to single, batch, and page translation.
- Batch translations append strict output-format rules to keep parsing stable.

## Commit Messages
- Commit messages are English only, and so are PR titles (GitHub writes the title into the commit that lands on `main`). No Chinese characters and no full-width punctuation; `.githooks/commit-msg` rejects them. The full rule is under "Shipping Changes" in `CLAUDE.md`.
