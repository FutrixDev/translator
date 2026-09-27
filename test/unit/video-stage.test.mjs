// "A video is filling the screen" (content/content-video-stage.js): the one
// answer the float ball steps aside for and the caption overlay positions by.
// Run in a vm page with stub boxes, because the property is about geometry —
// which box counts as filling the viewport — and a regex over the source
// cannot tell a letterboxed player from an inline one.
//
// Run with: npm run test:unit
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MODULE = 'content/content-video-stage.js';

const W = 1280;
const H = 720;
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const FULL = box(0, 0, W, H);
const INLINE = box(40, 120, 480, 270);

// Every stub element answers contains() by its parentElement chain, and
// closest(OWN_UI) only when it is marked `own` (one of our panels).
const OWN_UI = '#ai-translator-float-ball, #ai-translator-caption-overlay';
function element(props) {
  return {
    ...props,
    contains(other) {
      for (let node = other; node; node = node.parentElement) if (node === this) return true;
      return false;
    },
    closest(selector) {
      assert.equal(selector, OWN_UI, 'own UI is recognised by ctx.constants.OWN_UI_SELECTOR');
      return this.own ? this : null;
    },
  };
}

/**
 * One page. `videos` are { rect, muted, loop, parent } where `parent` is a
 * chain of { rect, position } from the video outward to (not including) body.
 * `atCentre(videoEls, body)` is what elementsFromPoint answers at the centre of
 * the viewport, topmost first; by default the first video is on top.
 */
function load({ fullscreen = null, videos = [], atCentre = (els) => els.slice(0, 1) } = {}) {
  const documentElement = element({ tagName: 'HTML', getBoundingClientRect: () => FULL });
  const body = element({ tagName: 'BODY', parentElement: documentElement, getBoundingClientRect: () => FULL });
  const listeners = { document: new Map(), window: new Map() };
  const timers = [];
  const link = (chain) => chain.reduceRight(
    (parent, el) => element({ ...el, parentElement: parent, getBoundingClientRect: () => el.rect }), body);
  const videoEls = videos.map((v) => element({
    tagName: 'VIDEO',
    muted: !!v.muted,
    loop: !!v.loop,
    getBoundingClientRect: () => v.rect,
    parentElement: link(v.parent || []),
  }));
  const document = {
    body,
    documentElement,
    fullscreenElement: fullscreen,
    getElementsByTagName: (tag) => (tag === 'video' ? videoEls : []),
    elementsFromPoint: (x, y) => {
      assert.deepEqual([x, y], [W / 2, H / 2], 'the centre of the viewport');
      return atCentre(videoEls, body);
    },
    addEventListener: (type, fn) => listeners.document.set(type, fn),
    removeEventListener: (type) => listeners.document.delete(type),
  };
  const ctx = { constants: { OWN_UI_SELECTOR: OWN_UI } };
  const window = {
    AI_TRANSLATOR_CONTENT: ctx,
    innerWidth: W,
    innerHeight: H,
    addEventListener: (type, fn) => listeners.window.set(type, fn),
    removeEventListener: (type) => listeners.window.delete(type),
  };
  const sandbox = {
    window,
    document,
    getComputedStyle: (el) => ({ position: el.position || 'static' }),
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: (id) => { timers[id - 1] = null; },
  };
  vm.runInNewContext(read(MODULE), sandbox, { filename: MODULE });
  return { stage: ctx.videoStage, document, videoEls, listeners, timers };
}

test('no video, no fullscreen: nothing fills the screen', () => {
  assert.equal(load().stage.videoFillsScreen(), false);
  assert.equal(load({ videos: [{ rect: INLINE }] }).stage.videoFillsScreen(), false);
});

test('standard fullscreen counts whatever element went fullscreen', () => {
  // A player <div>, an <iframe> with a cross-origin player, the <video> itself:
  // nothing outside it is rendered, so the answer is the same.
  for (const tagName of ['VIDEO', 'DIV', 'IFRAME', 'HTML']) {
    assert.equal(load({ fullscreen: { tagName } }).stage.videoFillsScreen(), true, tagName);
  }
});

test('web fullscreen: a video whose box covers the viewport', () => {
  assert.equal(load({ videos: [{ rect: FULL }] }).stage.videoFillsScreen(), true);
  // a border or a sub-pixel gap still counts
  assert.equal(load({ videos: [{ rect: box(2, 1, W - 3, H - 2) }] }).stage.videoFillsScreen(), true);
  // one inline player among others does not hide a fullscreen one
  const second = load({ videos: [{ rect: INLINE }, { rect: FULL }], atCentre: (els) => [els[1]] });
  assert.equal(second.stage.videoFillsScreen(), true);
});

test('web fullscreen, letterboxed: the fixed frame around the video fills the viewport', () => {
  const letterboxed = { rect: box(0, 0, W, 540), parent: [{ rect: box(0, 0, W, 540) }, { rect: FULL, position: 'fixed' }] };
  assert.equal(load({ videos: [letterboxed] }).stage.videoFillsScreen(), true);
  // the same shape inside a fixed frame that does not fill the viewport
  const docked = { rect: box(0, 0, W, 540), parent: [{ rect: box(0, 0, W, 540), position: 'fixed' }] };
  assert.equal(load({ videos: [docked] }).stage.videoFillsScreen(), false);
});

test('a wide inline player and a hero backdrop are not web fullscreen', () => {
  // theatre mode: full width, not full height, not fixed
  const theatre = { rect: box(0, 56, W, 540), parent: [{ rect: box(0, 56, W, 540) }] };
  assert.equal(load({ videos: [theatre] }).stage.videoFillsScreen(), false);
  // a muted looping video covering the landing page is decoration
  assert.equal(load({ videos: [{ rect: FULL, muted: true, loop: true }] }).stage.videoFillsScreen(), false);
  // muted alone is a reader who turned the sound off
  assert.equal(load({ videos: [{ rect: FULL, muted: true }] }).stage.videoFillsScreen(), true);
});

test('the player has to be what is on screen: its control layer yes, page text over it no', () => {
  // The player <div> fills the viewport and holds the <video> and its own
  // control layer; the control layer is what the centre hit lands on.
  const player = { rect: FULL };
  const withControls = load({
    videos: [{ rect: FULL, parent: [player] }],
    atCentre: (els) => [element({ tagName: 'DIV', parentElement: els[0].parentElement }), els[0]],
  });
  assert.equal(withControls.stage.videoFillsScreen(), true, 'the control layer is part of the player');

  // A video pinned behind the page (z-index:-1 under a full-height column of
  // text) fills the viewport and shows nothing.
  const covered = load({
    videos: [{ rect: FULL }],
    atCentre: (els, body) => [element({ tagName: 'P', parentElement: body }), els[0]],
  });
  assert.equal(covered.stage.videoFillsScreen(), false, 'the page text is on top');

  // On a page scrolled to the top body and html fill the viewport too; the
  // frame must not grow into them, or it would contain the page text.
  const unframed = load({
    videos: [{ rect: FULL }],
    atCentre: (els, body) => [element({ tagName: 'P', parentElement: body })],
  });
  assert.equal(unframed.stage.videoFillsScreen(), false, 'body is not part of the player');

  // Our own UI (a caption overlay, the float ball) over the video is skipped.
  const ours = load({
    videos: [{ rect: FULL }],
    atCentre: (els) => [element({ tagName: 'DIV', own: true }), els[0]],
  });
  assert.equal(ours.stage.videoFillsScreen(), true, 'our own UI does not count as the page covering it');

  // A letterboxed player: the hit on the black bar is the fixed frame itself.
  const frame = { rect: FULL, position: 'fixed' };
  const letterboxed = load({
    videos: [{ rect: box(0, 90, W, 540), parent: [frame] }],
    atCentre: (els) => [els[0].parentElement],
  });
  assert.equal(letterboxed.stage.videoFillsScreen(), true);
});

test('an ordinary page is never hit-tested', () => {
  // elementsFromPoint is the costly part of a poll: only a video whose box
  // already fills the viewport gets there.
  const never = () => assert.fail('hit-tested a page with no filling video');
  assert.equal(load({ videos: [{ rect: INLINE }], atCentre: never }).stage.videoFillsScreen(), false);
  const theatre = { rect: box(0, 56, W, 540), parent: [{ rect: box(0, 56, W, 540) }] };
  assert.equal(load({ videos: [theatre], atCentre: never }).stage.videoFillsScreen(), false);
});

test('overlaySpot: inside the fullscreen element, or the top layer over a fullscreen <video>', () => {
  let page = load();
  assert.deepEqual({ ...page.stage.overlaySpot() }, { parent: page.document.body, topLayer: false });
  const player = { tagName: 'DIV' };
  page = load({ fullscreen: player });
  assert.equal(page.stage.overlaySpot().parent, player);
  assert.equal(page.stage.overlaySpot().topLayer, false);
  page = load({ fullscreen: { tagName: 'VIDEO' } });
  assert.equal(page.stage.overlaySpot().parent, page.document.body);
  assert.equal(page.stage.overlaySpot().topLayer, true);
});

// Just enough of an element for the popover calls, recording each one.
function popoverBox() {
  const calls = [];
  const attrs = new Set();
  let open = false;
  return {
    calls,
    parentElement: null,
    hasAttribute: (name) => attrs.has(name),
    setAttribute: (name) => { calls.push(`set:${name}`); attrs.add(name); },
    removeAttribute: (name) => { calls.push(`remove:${name}`); attrs.delete(name); },
    matches: (selector) => selector === ':popover-open' && open,
    showPopover: () => { calls.push('show'); open = true; },
    hidePopover: () => { calls.push('hide'); open = false; },
  };
}

test('placeOverlay moves the box to the spot and in or out of the top layer', () => {
  const box = popoverBox();
  const appended = [];
  const into = (parent) => { parent.appendChild = (el) => { appended.push(parent); el.parentElement = parent; }; };

  // A fullscreen <video>: stays in body, promoted once however often it is placed.
  let page = load({ fullscreen: { tagName: 'VIDEO' } });
  into(page.document.body);
  page.stage.placeOverlay(box);
  page.stage.placeOverlay(box);
  assert.deepEqual(appended, [page.document.body]);
  assert.deepEqual(box.calls, ['set:popover', 'show']);

  // A fullscreen player <div>: moved inside it, and out of the top layer.
  const player = { tagName: 'DIV' };
  into(player);
  page = load({ fullscreen: player });
  page.stage.placeOverlay(box);
  assert.equal(box.parentElement, player);
  assert.deepEqual(box.calls.slice(2), ['hide', 'remove:popover']);

  // Taking a box that was never promoted out of the top layer touches nothing.
  const plain = popoverBox();
  page.stage.setTopLayer(plain, false);
  assert.deepEqual(plain.calls, []);
});

test('setTopLayer without the popover API leaves the box where it is', () => {
  const page = load();
  const box = { ...popoverBox(), showPopover() { throw new TypeError('showPopover is not a function'); } };
  assert.doesNotThrow(() => page.stage.setTopLayer(box, true));
});

test('watch reports each change once, polls for web fullscreen, and stops with its last listener', () => {
  const page = load({ videos: [{ rect: INLINE }] });
  const seen = [];
  const unwatch = page.stage.watch((filled) => seen.push(filled));
  assert.equal(page.timers.filter(Boolean).length, 1, 'one poll while someone listens');
  assert.ok(page.listeners.document.has('fullscreenchange'));

  const tick = () => page.timers.filter(Boolean).forEach((fn) => fn());
  tick();
  assert.deepEqual(seen, [], 'no change, no call');

  // web fullscreen has no event: the poll finds it
  page.videoEls[0].getBoundingClientRect = () => FULL;
  tick();
  tick();
  assert.deepEqual(seen, [true]);

  // leaving it restores
  page.videoEls[0].getBoundingClientRect = () => INLINE;
  tick();
  assert.deepEqual(seen, [true, false]);

  // standard fullscreen arrives as an event
  page.document.fullscreenElement = { tagName: 'VIDEO' };
  page.listeners.document.get('fullscreenchange')();
  assert.deepEqual(seen, [true, false, true]);

  unwatch();
  assert.equal(page.timers.filter(Boolean).length, 0, 'the poll stops with the last listener');
  assert.ok(!page.listeners.document.has('fullscreenchange'));
});

// ---------------------------------------------------------------- one mechanism

function contentSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js')) out.push(rel);
    }
  };
  walk('content');
  return out;
}

test('the fullscreen state is read in one place, and the top layer entered in one place', () => {
  // Both caption boxes (the overlay in content-caption-providers.js and the
  // controls' floating box in content-caption-controls.js) go through
  // ctx.videoStage.placeOverlay(): a second copy of the spot or of the
  // popover dance is a second answer that can drift from this one.
  const readers = contentSources().filter((rel) => /document\.fullscreenElement/.test(read(rel)));
  assert.deepEqual(readers, [MODULE]);
  const promoters = contentSources().filter((rel) => /showPopover|setAttribute\(\s*'popover'/.test(read(rel)));
  assert.deepEqual(promoters, [MODULE]);
});

test('the float ball and the auto-status bar step aside through the stage, not a listener of their own', () => {
  // The auto-status bar is also where the PDF / comic hint (content-media-hints.js)
  // is drawn, so this one check covers that hint too.
  for (const file of ['content/content-float-ball.js', 'content/content-auto-status.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /fullscreenchange/, file);
    assert.match(source, /ctx\.videoStage\.watch\(/, file);
    assert.match(source, /wanted && !ctx\.videoStage\.videoFillsScreen\(\)/, file);
    // The stage polls while watched: a surface with nothing to show stops
    // watching, so a page where nobody sees it is not measured.
    assert.match(source, /if \(!wanted && stageWatch\) \{\s*stageWatch\(\);\s*stageWatch = null;/, file);
  }
});

test('the stage loads before everything that reads it', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const bundle = manifest.content_scripts.flatMap((entry) => entry.js || []);
  const at = (file) => bundle.indexOf(file);
  assert.ok(at(MODULE) > at('content/content-utils.js'), 'ctx must exist first');
  for (const file of ['content/content-caption-providers.js', 'content/content-caption-controls.js',
    'content/content-float-ball.js', 'content/content-auto-status.js']) {
    assert.ok(at(file) > at(MODULE), `${file} loads before ${MODULE}`);
  }
});
