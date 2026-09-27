# Blab Translation brand mark (2026-09-19 rebrand)

Four coloured pages fan out from a pivot at the bottom. They stand for the
languages (translation) and the pages of a book (reading). The front page is a
speech bubble with a white play button (video). Sparkles supply the magic. It
all sits on a warm tile.

- `icon.js` holds the drawing code: Canvas 2D on a 100×100 grid, exposed as
  `window.BlabR7`. Each size is drawn natively with its own detail tier:
  - ≤20 px: the fan opens wider and there are no sparkles or shadows.
  - ≤36 px: one sparkle.
  - ≤64 px: page rims.
  - Larger: text lines.
- `export.html` lists every output (`EXPORTS`). `export.mjs` renders them with
  Playwright's Chromium.
- `npm run icons` rewrites `icons/icon{16,32,48,128}.png`.
- `node brand/blab-translation-2026-09-19/export.mjs --all <dir>` writes the
  full set:
  - the website's `server/public/assets/icon*.png` (translator-site);
  - the TV app's mipmaps, adaptive layers and banner (subtitle-translator);
  - a full-bleed Play Store 512 and 1024 masters.

  Copy those files into the other two repos when the mark changes.

The design rounds leading here (r3–r7) are kept outside this repo in
`translator-g/brand/blab-translation-2026-09-19/`.
