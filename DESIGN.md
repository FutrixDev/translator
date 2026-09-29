---
name: Blab Translation
description: The extension's own surfaces — the toolbar popup, the float ball and its menu — in the 2026-09-19 brand.
colors:
  paper: "#fffaf3"
  paper-deep: "#fcebdd"
  paper-glow: "rgba(255, 178, 120, 0.3)"
  surface: "#f6efe5"
  hover: "#f1e8dc"
  raised: "#ffffff"
  line: "#ebe1d4"
  ink: "#10172a"
  ink-2: "#4b5264"
  muted: "#858a99"
  primary: "#4a55e8"
  primary-from: "#8c72ff"
  primary-to: "#3f55f2"
  focus: "#6b63f5"
  switch-off: "#ddd2c4"
  ok: "#2fcb97"
  error: "#ff6f6c"
  error-text: "#d93a3f"
  dark-paper: "#12151f"
  dark-surface: "#1a1e2a"
  dark-hover: "#222736"
  dark-raised: "#2a3042"
  dark-line: "#262b39"
  dark-ink: "#f4efe8"
  dark-ink-2: "#b0b4c2"
  dark-primary: "#9d8cff"
  mark-coral: "#ff6f6c"
  mark-sky: "#3faaf4"
  mark-amber: "#ffb04a"
  mark-mint: "#2fcb97"
  mark-bubble: "#5a60f6"
  state-paused: "#8a8f9e"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 700
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.3
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.25
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  hairline: "2px"
  xs: "4px"
  kbd: "5px"
  sm: "6px"
  segment-inner: "7px"
  control: "8px"
  segment: "9px"
  md: "10px"
  lg: "12px"
  menu: "14px"
  dock: "22px"
  pill: "999px"
spacing:
  row-y: "8px"
  row-x: "10px"
  panel-x: "8px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.raised}"
    rounded: "{rounded.lg}"
    padding: "10px 12px"
    height: "42px"
  menu-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
    height: "36px"
  menu-row-hover:
    backgroundColor: "{colors.hover}"
  switch-off:
    backgroundColor: "{colors.switch-off}"
    height: "18px"
  switch-on:
    backgroundColor: "{colors.primary}"
    height: "18px"
  float-ball:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    size: "36px"
  float-menu:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.menu}"
    padding: "6px"
    width: "208px"
---

# Design System: Blab Translation (extension surfaces)

Scope: `popup/`, `content/css/float-ball.css`, `content/css/float-menu.css` and
their light/dark tokens. The in-page translation styles, the selection card and
the settings page are not described here yet.

## Overview

**Creative North Star: "Morning Paper"**

The brand's fanned-pages mark sits on warm paper, with ink for type and one
indigo-violet voice for the action that matters. Each surface is a short list of
things you can do to this page. It reads top to bottom:

1. the one action;
2. the switches that decide what happens next time;
3. how translations look;
4. the tools you reach for occasionally;
5. a footer that says whether anything is wrong.

The float ball and its menu live on other people's pages, so they have to hold
up against any stylesheet. Whatever the page does, the ball stays warm white
and the mark keeps its four colours.

**Key Characteristics:**
- Warm paper (#fffaf3) and ink (#10172a), never pure white on pure black.
- Exactly one filled, gradient control per surface: "Translate page".
- Switches are right-aligned toggles on the row they describe, and the whole row is the hit target.
- The mark's four pages double as the state colours.
- Light and dark are the same token set redeclared; a rule names a colour directly only when it is the same in both themes.

## Colors

Warm neutrals carry everything; indigo-violet is the only accent. The mark's
four page colours appear only as states.

### Primary
- **Indigo-Violet Gradient** (#8c72ff → #3f55f2, 135°): fills the primary "Translate page" button only.
- **Indigo** (#4a55e8; dark #9d8cff): an "on" switch, a hovered icon, and the text of the quiet "Open"/"Review" button in the PDF job list.
- **Focus Violet** (#6b63f5; dark #9d8cff): the 2px focus ring on every popup control. The float menu rings its rows in its own accent token instead.

### Neutral
- **Paper** (#fffaf3; dark #12151f): the panel background, and the float ball's face in both themes. The ball's face deepens to #fcebdd, with a peach glow of rgba(255, 178, 120, .3) at the top right.
- **Sand** (#f6efe5; dark #1a1e2a): the segmented control's track and inset areas.
- **Sand Hover** (#f1e8dc; dark #222736): the background of a hovered popup row. The float menu's hovered row is an accent tint instead (`--ait-menu-hover`).
- **Seam** (#ebe1d4; dark #262b39): dividers between groups and the footer rule.
- **Ink / Ink-2 / Muted** (#10172a / #4b5264 / #858a99): labels, icons at rest, and secondary text such as the kbd hints and footer.

### State (the mark's pages)
The states use the mark's own hex values, not near neighbours of them.
- **Sky** (#3faaf4): auto-translate is running. It breathes, with opacity 1 → 0.3 over 1.6s.
- **Amber** (#ffb04a): partially translated.
- **Grey** (#8a8f9e): paused. It is the one state that is not a page of the mark.
- **Coral** (#ff6f6c): an error. This is also the footer dot when the API is not configured.
- **Mint** (#2fcb97): the footer's "ready" dot.

**The Four Pages Rule.** A state colour is always one of the mark's pages (or paused grey), and it only ever shows up as a dot. It never fills a button or a row.

## Typography

**Body Font:** the system UI stack (-apple-system, Segoe UI, PingFang SC, Hiragino Sans, Roboto).

**Character:** native and quiet. The panels should look like part of the browser, not a web page.

### Hierarchy
- **Title** (700, 14px): the product name in the popup header.
- **Body** (400, 13px, 1.3): every row label. The primary row is weight 600.
- **Label** (400, 12px, 1.25): the display segment and the style select.
- **Caption** (400, 11px, 1.45): kbd hints, footer status and job status.

## Layout

- The popup is 280px wide with an 8px side inset. Rows are at least 36px tall, and the primary row is 42px.
- Groups are separated by a 1px Seam line. A group whose children are all hidden collapses, so there are never two lines in a row.
- The float menu is 208px wide with 6px padding and 34px rows.
- Rows wrap long labels (German, "Adjust what gets translated here") instead of truncating them.

## Elevation & Depth

Mostly flat, with tonal layering. Shadows mark only things that float over something else.

- **Primary lift**: `0 6px 16px -6px rgba(63, 85, 242, .55)`, under the gradient button.
- **Raised chip**: `0 1px 2px rgba(16, 23, 42, .08), 0 1px 1px rgba(16, 23, 42, .04)`, on the selected segment only. The kbd hints are flat.
- **Ball**: `0 4px 14px rgba(16, 23, 42, .18), 0 1px 2px rgba(16, 23, 42, .12), 0 0 0 1px rgba(16, 23, 42, .06)`. On hover it becomes an indigo-tinted glow.
- **Menu**: a large soft drop plus a 1px border: `rgba(16, 23, 42, .08)` on paper, `rgba(255, 255, 255, .08)` in dark.

## Shapes

Soft rectangles for rows (10px) and the primary button (12px), 14px for the
float menu, and full circles for the ball, the status dot and the ··· button.
Smaller controls step down with their size: 9px for the segment track and 7px for its
buttons, 8px for the select, the ⚙ button and the float menu's rows, 5px for the kbd hints,
4px for the job list's close button and 2px for the progress track. The docked capsule
is 22px, half of its height.
Icons are 16–18px outline strokes (width 1.8–2, round caps and joins). They are never filled.

## Components

### Primary button
- Gradient fill, white text and icon, 12px radius, 42px tall.
- The kbd hint sits right-aligned in a translucent white chip.
- Hover brightens it slightly and active presses it down. It is the only filled control on a surface.

### Menu rows and switch rows
- Transparent at rest; the Sand Hover fill on hover; the icon turns Indigo on hover.
- A switch row keeps its label and adds a 30×18 track on the right: Seam-sand when off, Indigo when on. The row carries `aria-pressed`. The track is a `<span>` whose On/Off word stays in the DOM for screen readers and specs; it is not a `<kbd>`, which is kept for real shortcuts.

### Display group
- A two-option segmented control (Bilingual / Translation only) on a Sand track. The selected half is a raised white chip with ink text at weight 600.
- Under it, the translation-style select sits beside its kbd hint.

### Footer
- A status dot and text on the left, and a 30×30 ⚙ button on the right that opens settings.

### Float ball (signature)
- A 36px warm-paper circle carrying the 28px fanned-pages mark.
- The ··· button (18px, white) appears on hover or focus-within at the top-right edge.
- The status dot (6px, with a 16px hit area) sits bottom-right and is `display: none` when there is no state.
- Docked to an edge, a dark or light capsule tail sits behind it.

### Float menu
- 208px, 14px radius, outline icons. Unlike the ball, the menu follows the theme: the paper card under the light theme (the settings default), and a dark ink card (#1a1e2a) under the dark one. In CSS the dark values are the base tokens and `light-theme.css` overrides them.
- Tokens are `--ait-menu-*` on the root, and `light-theme.css` redeclares only those tokens.

## Do's and Don'ts

### Do:
- **Do** put any colour that follows the theme in as a token on the root and redeclare it for the other theme. The float ball's mark and dot colours are the one exception: they never follow the theme, so they are written as literals in `float-ball.css`.
- **Do** bake geometry into SVG path data on any page-injected surface. The containment reset pins `transform: none` on every descendant, so a `transform=` attribute will not work there.
- **Do** mirror any new value of the five SVG paint attributes (`fill`, `stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`) in the reset's SVG paint block, as a doubled selector `[attr="v"][attr] { attr: v; }`. The doubling puts it at (0,3,0), above a page's `.kit button:hover svg` (0,2,2). `test/unit/host-css-containment.test.mjs` fails until you do.
- **Do** put your own paint CSS for a page-injected icon only on elements that carry none of those attributes. A (0,3,0) mirror outweighs an ordinary (0,2,3) rule, so the attribute, not your rule, would win. The float menu's icons leave `stroke-width` off the `<svg>` for this reason.

### Don't:
- **Don't** add a second filled or gradient button to a surface.
- **Don't** use a state colour for anything but a dot.
- **Don't** let the float ball follow the theme. It sits on pages of any colour, and warm paper reads on all of them.
- **Don't** use `!important` or `#id` selectors in the containment reset (see `CLAUDE.md`, Host-page containment).
