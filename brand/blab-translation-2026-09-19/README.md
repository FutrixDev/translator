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
- `npm run icons` rewrites everything under `chrome/` in `EXPORTS` into
  `icons/`: `icon{16,32,48,128}.png` and the two Chrome Web Store promo tiles,
  `promo-large.png` (1400×560 marquee) and `promo-small.png` (440×280).
- The promo tiles are an illustration with the brand laid over it. The
  illustrations in `promo/` (`marquee-art.jpg`, `small-art.jpg`) came from
  Magic Art (`magic image`, 2k: the marquee at 21:9, the small tile at 3:2),
  prompted for no lettering at all. The marquee art is scaled to the tile's
  height and right-aligned so the text column clears its video card; the
  strip that leaves on the left is filled by stretching the art's soft left
  edge. All the English copy is drawn in `export.html` (the tile, wordmark,
  headline, feature list, pills and engine line), because an image model
  cannot be trusted to spell or to reproduce the mark. Every claim must match
  the store listing (`docs/store-submission-*.md`). To change the copy, edit `drawPromoMarquee` /
  `drawPromoSmall`. To change the picture, replace the JPEG. The export
  launches Chromium with `--allow-file-access-from-files`, so the file://
  JPEG does not taint the canvas.
- All text (promo copy and the TV banners) is set in two fonts bundled in
  `fonts/`, never the host's: Nunito for Latin, Noto Sans SC for Chinese (SIL
  OFL 1.1, `fonts/OFL.txt`). Both are variable-weight woff2 files cut down to
  the glyphs the drawings print: all of printable ASCII for Nunito, only the
  TV banner's Chinese for Noto. After adding a character outside that, add it
  to `fonts/subset.sh` and rerun it against the full TTFs: a character
  missing from a subset is drawn in whatever host font has it. `export.mjs`
  stops if either font fails to load. Canvas rasterisation still differs
  slightly between operating systems, so the PNGs are not byte-identical
  everywhere.
- `node brand/blab-translation-2026-09-19/export.mjs --all <dir>` writes the
  full set:
  - the website's `server/public/assets/icon*.png` (translator-site);
  - the TV app's mipmaps, adaptive layers, banner and the onboarding
    header's `drawable-nodpi/brand_tile.png` (subtitle-translator);
  - a full-bleed Play Store 512 and 1024 masters.

  Copy those files into the other two repos when the mark changes.

The design rounds leading here (r3–r7) are kept outside this repo in
`translator-g/brand/blab-translation-2026-09-19/`.
