# Hover Translation Design

Date: 2026-01-14

## Goal
Add a mouse hover translation feature that is enabled by default and triggered by holding Shift while hovering a paragraph-like block. The translation is inserted under the block and disappears when Shift is released or the hover ends. Selection translation uses the same inline mode when hover translation is enabled.

## Key Decisions
- Hover translation toggle lives in the options/settings page.
- Trigger requires Shift + hover (no auto-translate on hover without Shift).
- Target is the nearest paragraph-like block (P, LI, H1-H6, BLOCKQUOTE, FIGCAPTION, DT, DD).
- Selection translation translates only the selected text, but displays inline under the containing block when hover translation is enabled.
- Inline hover/selection translations are temporary and auto-removed.

## Architecture Overview
Introduce a new content module `content/content-hover-translation.js` responsible only for hover and inline selection translation. Reuse existing math and insertion helpers by exposing them on `window.AI_TRANSLATOR_CONTENT` from `content/content-page-translation.js` to avoid duplicating logic.

## Components
- `content/content-hover-translation.js`
  - Tracks Shift state, current hovered block, and active translation node.
  - Resolves hovered node to target block.
  - Extracts text via `getTextWithMathPlaceholders`.
  - Sends `TRANSLATE` request and inserts inline translation below the block.
  - Removes translation on Shift up or mouse out.
  - Caches translations per block + target language to reduce repeat calls.
- `content/content-selection.js`
  - When selection button is clicked, uses inline translation if `enableHoverTranslation` is true; otherwise uses existing popup.
- `content/content-page-translation.js`
  - Exposes helper methods on `ctx` for reuse: `getTextWithMathPlaceholders`, `buildTranslationContentWithMath`, `isMathElement`, `isIconElement`, `isHorizontalFlexParent`.
- `options/options.html` + `options/options.js`
  - New toggle `enableHoverTranslation` stored in `chrome.storage.sync` with default true.
- `i18n/messages.js`
  - New label and hint strings for the hover translation toggle.

## Data Flow
1. User holds Shift and hovers a paragraph-like block.
2. Hover module resolves target block and extracts text with math placeholders.
3. Content script sends `TRANSLATE` to background.
4. Response is inserted as a temporary sibling below the block using existing inline translation styles.
5. On mouse out or Shift release, translation is removed and hover state resets.

Selection flow:
1. User selects text and clicks the selection translate button.
2. If hover translation is enabled, inline translation is inserted under the containing block.
3. Translation is removed on selection clear or Escape.
4. If hover translation is disabled, fallback to popup.

## Error Handling
- If background returns an error, insert a temporary inline error message using existing `translationFailed`/`extensionContextInvalidated` copy.
- Ignore stale translation responses by tracking a per-request id.

## UX Notes
- Inline hover/selection translations do not mark the source element as `ai-translator-translated` to avoid interfering with full-page translation state.
- Horizontal flex layouts use inline right insertion to preserve layout, consistent with existing page translation logic.

## Testing Plan
- E2E: Shift+hover on a paragraph should insert a temporary translation element, then remove it on Shift release.
- E2E: selection translation should insert inline under the block when hover translation is enabled, and disappear on selection clear.
- Tests assert DOM markers rather than translation content to avoid API dependency.

## Rollout
- Default enable hover translation via `enableHoverTranslation: true`.
- Existing popup behavior remains when the toggle is off.
