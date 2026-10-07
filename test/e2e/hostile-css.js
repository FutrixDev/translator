/**
 * The stylesheet a hostile host page serves.
 *
 * Every rule here targets a bare tag, because that is the whole mechanism: our
 * panels are `div`s and `button`s and `label`s inside the page's own document,
 * so a page rule with no class in it matches them. `div { opacity: .8 }` is
 * real — example.com ships it — and the rest are the same shape, drawn from
 * what page CSS routinely does to bare tags.
 *
 * Three separate defects came out of this one mechanism before it was fixed at
 * the boundary: the box model overflowing the textarea past the modal, the
 * stacking context the opacity built around the dialog header (which sealed
 * the language menu behind the textarea, so the picker looked decorative), and
 * the compounded opacity that let page text show through the panel.
 *
 * The `.host-kit button` rule is the fourth, and it is the shape that matters
 * most in practice. A theme does not style `button` from a bare tag; it styles
 * it from a class on `<body>`, which weighs (0,1,1) — one type selector more
 * than the single-class rules our own controls were written with. This is
 * Elementor's kit rule copied off azulle.com, where it turned the float menu,
 * the popup, the input dialog and the progress toast into stacks of lime pills
 * all at once.
 *
 * Its `:hover`/`:focus` twin is the fifth, and it is heavier still — a state is
 * a pseudo-class, so (0,2,1). It takes whatever the control's own hover rule
 * does not restate, which on the first fix was the border and the colour: the
 * float menu drew a near-black box around the item under the pointer and turned
 * its label white, on a white menu. Both rules are the real values off that
 * site, so the fixture fails the way the site did.
 */
const HOSTILE_PAGE_CSS = `
  div { opacity: 0.8; box-sizing: content-box; filter: saturate(0.4); }
  span { opacity: 0.8; }
  button { text-transform: uppercase; font-family: monospace; }
  textarea { box-sizing: content-box; font-family: monospace; transform: translateX(30px); }
  label { text-transform: uppercase; letter-spacing: 4px; }
  .host-kit button {
    background-color: rgb(195, 250, 125);
    border: 1px solid rgb(195, 250, 125);
    border-radius: 100px;
    padding: 14px 30px;
    font: 600 15.75px monospace;
  }
  .host-kit button:hover,
  .host-kit button:focus {
    background-color: rgb(0, 2, 22);
    color: rgb(255, 255, 255);
    border: 1px solid rgb(0, 2, 22);
  }
  svg { fill: rgb(255, 0, 0); stroke-width: 4px; stroke-linecap: square; }
  path { stroke: rgb(255, 0, 0); stroke-width: 4px; stroke-linecap: square; stroke-linejoin: bevel; }
  .host-kit button:hover svg { fill: rgb(255, 0, 0); stroke-width: 4px; }
`;

/**
 * HOSTILE_PAGE_CSS plus the sixth shape: colour, size, display and padding,
 * which the containment reset leaves to our own rules. The dictionary entry is
 * built from bare spans and divs, and before each of its elements said all four
 * for itself, `span { font-size: 30px }` blew a definition up to headline size.
 * test/e2e/dictionary-entry.spec.js serves this sheet under both surfaces.
 *
 * It is kept apart from HOSTILE_PAGE_CSS because the float ball does not yet
 * hold against it: `div { display: inline; padding: 12px }` collapses the fan
 * of its mark, which input-translation.spec.js checks on that page.
 */
const HOSTILE_ENTRY_CSS = `${HOSTILE_PAGE_CSS}
  span { color: red; font-size: 30px; display: block; }
  div { padding: 12px; display: inline; }
`;

module.exports = { HOSTILE_PAGE_CSS, HOSTILE_ENTRY_CSS };
