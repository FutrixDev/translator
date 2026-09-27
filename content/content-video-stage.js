// Is a video what the reader is looking at, edge to edge? One answer for every
// surface that has to step aside for it (the float ball, the auto-status bar)
// or stay over it (the caption overlay and the caption controls' floating box),
// so they cannot drift.
//
// Two ways a video fills the screen, and the page can only see one of them as
// an event:
//   - standard fullscreen: document.fullscreenElement is set. Nothing outside
//     that element is rendered, whatever it is — a <video>, a player <div>, an
//     <iframe> holding a cross-origin player.
//   - web fullscreen: the player restyles itself to position:fixed over the
//     viewport (bilibili, Youku, most Chinese video sites, many embeds). No
//     event fires, the fullscreen API is not involved, and our z-index sits
//     above theirs — so it has to be measured.
// A browser window in F11 / macOS fullscreen is neither: the page cannot tell
// it from a large window, and only counts once a video fills it (web
// fullscreen again).
(function () {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // How far a box may fall short of an edge and still count as filling it:
  // players leave a sub-pixel gap, or a 1–2 px border.
  const EDGE_TOLERANCE = 4;
  // Web fullscreen has no event, so the watch polls while anyone listens.
  const POLL_MS = 400;

  function fullscreenElement() {
    return document.fullscreenElement || null;
  }

  function fillsViewport(rect) {
    return rect.left <= EDGE_TOLERANCE && rect.top <= EDGE_TOLERANCE
      && rect.right >= window.innerWidth - EDGE_TOLERANCE
      && rect.bottom >= window.innerHeight - EDGE_TOLERANCE;
  }

  // A muted, looping video is page decoration (a hero background), not a
  // player the reader switched to full screen; hiding the ball there would
  // take it away on every such landing page.
  function isBackdrop(video) {
    return video.muted && video.loop;
  }

  // Page structure above the player, never part of it: on a page scrolled to
  // the top, body and html fill the viewport too, and a frame grown into them
  // would contain every hit below.
  function isPageRoot(el) {
    return el === document.body || el === document.documentElement;
  }

  // The box this video fills the viewport with, or null. The video's own box,
  // or — for a letterboxed player, whose <video> keeps its aspect ratio inside
  // a black viewport-sized frame — the nearest fixed ancestor, which is what
  // web fullscreen actually pins over the page. Then outward while ancestors
  // still fill, so the player's own control layer (a sibling of the <video>)
  // is inside the frame.
  function frameOf(video) {
    if (isBackdrop(video)) return null;
    const rect = video.getBoundingClientRect();
    let frame = null;
    if (fillsViewport(rect)) {
      frame = video;
    } else {
      // Letterboxed, it still spans one full dimension; anything smaller is an
      // inline player, and the ancestor walk (a style read per level, every
      // poll) is skipped.
      const spansWidth = rect.width >= window.innerWidth - 2 * EDGE_TOLERANCE;
      const spansHeight = rect.height >= window.innerHeight - 2 * EDGE_TOLERANCE;
      if (!spansWidth && !spansHeight) return null;
      for (let el = video.parentElement; el && !isPageRoot(el); el = el.parentElement) {
        if (getComputedStyle(el).position !== 'fixed') continue;
        if (fillsViewport(el.getBoundingClientRect())) frame = el;
        break;
      }
      if (!frame) return null;
    }
    for (let el = frame.parentElement; el && !isPageRoot(el); el = el.parentElement) {
      if (!fillsViewport(el.getBoundingClientRect())) break;
      frame = el;
    }
    return frame;
  }

  // Filling the viewport is not being on screen: a video pinned behind the
  // page's own content (a negative z-index, an opaque layer over it) fills
  // the viewport and shows nothing. What the reader sees at the centre of the
  // viewport has to be part of the player — skipping our own UI, since the
  // caption overlay can sit there. Only asked once a video's box already
  // fills the viewport, so an ordinary page never hit-tests.
  function isOnTop(frame) {
    const hits = document.elementsFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const first = hits.find((el) => !el.closest(ctx.constants.OWN_UI_SELECTOR));
    return !!first && frame.contains(first);
  }

  function videoFillsScreen() {
    if (fullscreenElement()) return true;
    const videos = document.getElementsByTagName('video');
    for (let i = 0; i < videos.length; i++) {
      const frame = frameOf(videos[i]);
      if (frame && isOnTop(frame)) return true;
    }
    return false;
  }

  // Where a box that must stay over the playing video has to live, and
  // whether it needs the top layer to get there. Nothing outside a fullscreen
  // element is rendered, so the box moves inside it — except when the
  // fullscreen element is the <video> itself, which draws no children; the
  // top layer is the only way over that.
  function overlaySpot() {
    const fullscreen = fullscreenElement();
    if (!fullscreen) return { parent: document.body, topLayer: false };
    if (fullscreen.tagName === 'VIDEO') return { parent: document.body, topLayer: true };
    return { parent: fullscreen, topLayer: false };
  }

  // Promote `el` into the top layer so it paints above a fullscreen <video>,
  // or take it back out. Only while that is the case: a popover that is not
  // open is display:none, which would hide the box the rest of the time.
  function setTopLayer(el, on) {
    try {
      if (on) {
        if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
        if (!el.matches(':popover-open')) el.showPopover();
      } else if (el.hasAttribute('popover')) {
        if (el.matches(':popover-open')) el.hidePopover();
        el.removeAttribute('popover');
      }
    } catch (e) {
      // Chrome without the popover API: a box over a fullscreen <video> simply
      // isn't available there, everything else still works.
    }
  }

  // Put a box that must stay over the playing video where overlaySpot() says,
  // in or out of the top layer. Called on every reposition: a fullscreen change
  // moves the spot, and a page that rebuilt its DOM may have dropped the box.
  function placeOverlay(el) {
    const spot = overlaySpot();
    if (el.parentElement !== spot.parent) spot.parent.appendChild(el);
    setTopLayer(el, spot.topLayer);
  }

  const listeners = new Set();
  let last = null;
  let timer = null;

  function check() {
    const now = videoFillsScreen();
    if (now === last) return;
    last = now;
    for (const listener of [...listeners]) listener(now);
  }

  // Calls `listener(filled)` on every change, starting from the next one.
  // Returns the unsubscribe.
  function watch(listener) {
    listeners.add(listener);
    if (listeners.size === 1) {
      last = videoFillsScreen();
      document.addEventListener('fullscreenchange', check);
      window.addEventListener('resize', check);
      timer = setInterval(check, POLL_MS);
    }
    return () => {
      if (!listeners.delete(listener) || listeners.size) return;
      document.removeEventListener('fullscreenchange', check);
      window.removeEventListener('resize', check);
      clearInterval(timer);
      timer = null;
      last = null;
    };
  }

  ctx.videoStage = { fullscreenElement, videoFillsScreen, overlaySpot, placeOverlay, setTopLayer, watch };
})();
