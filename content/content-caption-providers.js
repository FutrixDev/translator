// AI Translator — caption providers.
//
// A provider answers three questions for one class of site:
//
//   can I supply cues on this page?          canActivate()
//   here are the cues                        attach(engine) -> engine.ingestTrack()
//   where does the overlay go, and how do    getOverlayHost() /
//   I get the page's own captions out of     setNativeCaptionsHidden()
//   the way?
//
// Everything downstream of that — sentence segmentation, batching, translation,
// the bilingual overlay and its drag/resize — is the same for every site and
// lives in content/content-video-captions.js. Adding a site means adding a
// provider here, not another copy of the engine.
//
// Two ship today:
//
//   YouTubeProvider    cues observed from the player's own /api/timedtext
//                      response (YouTube gates that endpoint behind a
//                      per-session token we cannot reproduce, so we watch
//                      rather than fetch — see youtube-timedtext-interceptor.js)
//   TextTrackProvider  cues the browser has already parsed, from a plain
//                      <track> element or any TextTrack the player added.
//                      Zero per-site code: it works anywhere the standard
//                      subtitle API is used.
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;
  const core = globalThis.CaptionCore;
  if (!core) return;

  ctx.captionProviders = ctx.captionProviders || [];

  // =========================================================== YouTube
  const yt = { engine: null, onMessage: null, onNavigate: null };

  function onTimedTextMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'ai-translator' || data.type !== 'YT_TIMEDTEXT_CAPTURED') return;

    let lang = '';
    try {
      lang = new URL(data.url || '', window.location.href).searchParams.get('lang') || '';
    } catch (e) { /* keep empty */ }

    const cues = core.parseCaptionPayload(data.text || '', data.contentType || '');
    if (!cues.length || !yt.engine) return;
    yt.engine.ingestTrack({ trackId: lang || 'track', lang, cues });
  }

  const YouTubeProvider = {
    id: 'youtube',
    // Above the generic provider: YouTube's player does expose a TextTrack, but
    // it holds only the cues around the playhead, and taking it over would
    // fight the player for the track's mode.
    priority: core.PROVIDER_PRIORITY.SITE,

    canActivate() {
      return window.location.hostname.includes('youtube.com');
    },

    attach(engine) {
      yt.engine = engine;
      if (!yt.onMessage) {
        yt.onMessage = onTimedTextMessage;
        window.addEventListener('message', yt.onMessage);
      }
      if (!yt.onNavigate) {
        // Watching another video in the same SPA session: drop the old cues.
        // No replay here — the interceptor clears its buffer on navigation and
        // the player issues a fresh request for the new video.
        yt.onNavigate = () => { if (yt.engine) yt.engine.reset(); };
        window.addEventListener('yt-navigate-finish', yt.onNavigate);
      }
      // Captions may have been fetched before we started listening (CC on by
      // default); ask the interceptor to replay what it buffered.
      window.postMessage({ source: 'ai-translator', type: 'YT_TIMEDTEXT_REPLAY' }, '*');
    },

    detach() {
      if (yt.onMessage) {
        window.removeEventListener('message', yt.onMessage);
        yt.onMessage = null;
      }
      if (yt.onNavigate) {
        window.removeEventListener('yt-navigate-finish', yt.onNavigate);
        yt.onNavigate = null;
      }
      YouTubeProvider.setNativeCaptionsHidden(false);
      yt.engine = null;
    },

    getVideo() {
      return document.querySelector('video');
    },

    isCaptionsEnabled() {
      const button = document.querySelector('.ytp-subtitles-button');
      if (button) return button.getAttribute('aria-pressed') === 'true';
      return !!document.querySelector('.ytp-caption-window-container');
    },

    // The player's own caption layer: already positioned over the video and
    // already inside the element that goes fullscreen.
    getOverlayHost() {
      return document.querySelector('.ytp-caption-window-container');
    },

    // Hide YouTube's caption windows while our bilingual overlay is showing, so
    // the native line and ours don't stack. Scoped by a marker class so native
    // captions return the moment the overlay goes inactive.
    setNativeCaptionsHidden(hidden) {
      const container = document.querySelector('.ytp-caption-window-container');
      if (!container) return;
      container.classList.toggle('ai-translator-hide-native', !!hidden);
    },
  };

  // ======================================================= generic TextTrack
  // The browser has already fetched and parsed these cues, so there is nothing
  // to intercept and nothing to sniff: read video.textTracks, hold the track at
  // mode 'hidden' (cues keep firing, the browser draws nothing) and render the
  // bilingual line ourselves.
  const SUBTITLE_KINDS = ['subtitles', 'captions'];
  const CUE_SYNC_DEBOUNCE_MS = 250;

  const tt = {
    engine: null,
    video: null,
    track: null,
    trackEl: null,
    restoreMode: '',
    host: null,
    syncTimer: null,
    onCueUpdate: null,
    onFullscreen: null,
    onViewportChange: null,
  };

  /** Subtitle/caption tracks only — a chapters or metadata track has no dialogue. */
  function subtitleEntries(video) {
    const entries = [];
    if (!video) return entries;
    let defaults = [];
    try {
      defaults = Array.from(video.querySelectorAll('track[default]')).map((el) => el.track);
    } catch (e) { /* no <track> children */ }
    try {
      for (const track of video.textTracks) {
        if (SUBTITLE_KINDS.indexOf(track.kind) === -1) continue;
        entries.push({ track, isDefault: defaults.indexOf(track) !== -1 });
      }
    } catch (e) {
      // A <track> from another origin without CORS leaves the list unreadable.
    }
    return entries;
  }

  function findVideoWithTracks() {
    for (const video of document.querySelectorAll('video')) {
      if (subtitleEntries(video).length) return video;
    }
    return null;
  }

  function trackIdOf(track) {
    return `${track.language || ''}|${track.label || ''}|${track.kind || ''}`;
  }

  function scheduleCueSync() {
    if (tt.syncTimer) return;
    tt.syncTimer = setTimeout(() => {
      tt.syncTimer = null;
      pushCues();
    }, CUE_SYNC_DEBOUNCE_MS);
  }

  // Offer the whole track, every time. A <track> file arrives at once but an
  // in-band track grows cue by cue, and the engine already ignores what it
  // holds — so one debounced re-read covers both without a delta to get wrong.
  function pushCues() {
    if (!tt.track || !tt.engine) return;
    const cues = core.fromTextTrackCues(tt.track.cues);
    if (!cues.length) return;
    tt.engine.ingestTrack({
      trackId: trackIdOf(tt.track),
      lang: tt.track.language || '',
      cues,
    });
  }

  /** The <track> element a TextTrack came from, if it came from one at all. */
  function trackElementFor(track, video) {
    if (!video) return null;
    try {
      return Array.from(video.querySelectorAll('track')).find((el) => el.track === track) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Hand a track back in the mode the page had it in.
   *
   * The one exception is a track that is 'disabled' now: that is the viewer
   * having switched subtitles off since we adopted it, and the mode we recorded
   * is from before they did. Restoring it would turn their subtitles back on —
   * so a track we no longer want is left exactly where they left it.
   *
   * Every path that gives a track back goes through here: switching tracks,
   * detaching, and the overlay going inactive.
   */
  function restoreTrackMode(track, mode) {
    if (!track || track.mode === 'disabled') return;
    try { track.mode = mode || 'disabled'; } catch (e) { /* detached */ }
  }

  function releaseTrack() {
    if (!tt.track) return;
    tt.track.removeEventListener('cuechange', tt.onCueUpdate);
    tt.track.removeEventListener('addcue', tt.onCueUpdate);
    if (tt.trackEl) {
      tt.trackEl.removeEventListener('load', tt.onCueUpdate);
      tt.trackEl = null;
    }
    restoreTrackMode(tt.track, tt.restoreMode);
    tt.track = null;
    tt.restoreMode = '';
  }

  function adoptTrack(track, video) {
    releaseTrack();
    tt.video = video;
    tt.track = track;
    tt.restoreMode = track.mode;
    if (!tt.onCueUpdate) tt.onCueUpdate = scheduleCueSync;
    // A <track> is only fetched once its mode leaves 'disabled', so the file
    // may well arrive after we adopt it — and Chrome fires no 'addcue' for a
    // <track> that finishes parsing, only for cues added through the API. The
    // element's own load event is what closes that gap; without it a track
    // adopted before its file landed would sit there with no cues forever.
    tt.trackEl = trackElementFor(track, video);
    if (tt.trackEl) tt.trackEl.addEventListener('load', tt.onCueUpdate);
    // 'hidden' is the point of the whole provider: cues load and fire, and the
    // browser renders nothing, leaving the line to us.
    try { track.mode = 'hidden'; } catch (e) { /* detached */ }
    track.addEventListener('cuechange', tt.onCueUpdate);
    track.addEventListener('addcue', tt.onCueUpdate);
    scheduleCueSync();
  }

  /**
   * Choose (or re-choose) a track. Called on attach and whenever the page's
   * track list or a track's mode changes, so switching subtitle language in the
   * site's own control switches what we translate.
   *
   * No answer is a normal outcome — a page that offers subtitles the viewer has
   * not turned on gets nothing from us until they do, and this runs again then.
   */
  function syncSelection() {
    const video = findVideoWithTracks() || tt.video;
    const entries = subtitleEntries(video);
    if (!entries.length) return;
    const picked = core.pickSubtitleTrack(entries);
    if (!picked || picked.track === tt.track) return;
    // Our own track sits at 'hidden', which is never 'showing' — so only an
    // explicit switch by the page (or losing the track we held) moves us.
    const held = tt.track && entries.some((e) => e.track === tt.track) && tt.track.mode !== 'disabled';
    if (held && picked.track.mode !== 'showing') return;
    adoptTrack(picked.track, video);
  }

  // ---- overlay host: a rect-tracked box over the video ----
  // A generic player has no caption layer to borrow, and wrapping the <video>
  // breaks players that manage their own DOM. So the host is a fixed-position
  // box pinned to the video's rect — the same approach the comic overlay takes
  // over an <img>.
  function hostParent() {
    const fullscreen = document.fullscreenElement;
    if (!fullscreen) return document.body;
    // Nothing outside the fullscreen element is rendered, so the overlay has to
    // move inside it. A fullscreen <video> is the exception: it draws no
    // children, and the top layer (setTopLayer below) is the only way over it.
    if (fullscreen.tagName === 'VIDEO') return document.body;
    return fullscreen;
  }

  // Promote the host into the top layer so it paints above a fullscreen
  // <video>. Only while that is the case: a popover that is not open is
  // display:none, which would hide the overlay the rest of the time.
  function setTopLayer(on) {
    const host = tt.host;
    if (!host) return;
    try {
      if (on) {
        if (!host.hasAttribute('popover')) host.setAttribute('popover', 'manual');
        if (!host.matches(':popover-open')) host.showPopover();
      } else if (host.hasAttribute('popover')) {
        if (host.matches(':popover-open')) host.hidePopover();
        host.removeAttribute('popover');
      }
    } catch (e) {
      // Chrome without the popover API: captions over a fullscreen <video>
      // simply aren't available, everything else still works.
    }
  }

  function syncHost() {
    const host = tt.host;
    const video = tt.video;
    if (!host || !video || !document.body) return;
    const parent = hostParent();
    if (host.parentElement !== parent) parent.appendChild(host);
    setTopLayer(!!document.fullscreenElement && parent === document.body);

    const rect = video.getBoundingClientRect();
    const onScreen = rect.width > 1 && rect.height > 1
      && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth;
    host.style.display = onScreen ? 'block' : 'none';
    if (!onScreen) return;
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.width = `${rect.width}px`;
    host.style.height = `${rect.height}px`;
  }

  const TextTrackProvider = {
    id: 'texttrack',
    priority: core.PROVIDER_PRIORITY.GENERIC,

    // The whole activation rule: this page has a video with subtitle cues the
    // browser is already holding.
    canActivate() {
      return !!findVideoWithTracks();
    },

    attach(engine) {
      tt.engine = engine;
      if (!tt.onFullscreen) {
        tt.onFullscreen = () => syncHost();
        document.addEventListener('fullscreenchange', tt.onFullscreen);
      }
      if (!tt.onViewportChange) {
        // Keep the box on the video while the page moves under it, including
        // when playback is paused and no timeupdate is coming.
        tt.onViewportChange = () => syncHost();
        window.addEventListener('scroll', tt.onViewportChange, true);
        window.addEventListener('resize', tt.onViewportChange);
      }
      syncSelection();
    },

    detach() {
      if (tt.syncTimer) { clearTimeout(tt.syncTimer); tt.syncTimer = null; }
      releaseTrack();
      if (tt.onFullscreen) {
        document.removeEventListener('fullscreenchange', tt.onFullscreen);
        tt.onFullscreen = null;
      }
      if (tt.onViewportChange) {
        window.removeEventListener('scroll', tt.onViewportChange, true);
        window.removeEventListener('resize', tt.onViewportChange);
        tt.onViewportChange = null;
      }
      if (tt.host) {
        setTopLayer(false);
        tt.host.remove();
        tt.host = null;
      }
      tt.video = null;
      tt.engine = null;
    },

    // A new video, or a track added to one: re-run the choice.
    onMediaChanged() {
      syncSelection();
    },

    getVideo() {
      return tt.video || findVideoWithTracks() || document.querySelector('video');
    },

    // We hold the track at 'hidden' ourselves, so "are the site's subtitles on"
    // is really "do we still have a track". A player turning subtitles off
    // sets the track to 'disabled', which is how that reads here.
    isCaptionsEnabled() {
      return !!tt.track && tt.track.mode !== 'disabled';
    },

    getOverlayHost() {
      if (!tt.video) tt.video = TextTrackProvider.getVideo();
      if (!tt.video || !document.body) return null;
      if (!tt.host) {
        const host = document.createElement('div');
        host.className = 'ai-translator-caption-host';
        tt.host = host;
      }
      syncHost();
      return tt.host;
    },

    syncOverlayHost() {
      syncHost();
    },

    // The browser draws nothing for a hidden track, so hiding the native line
    // is the same act as adopting the track — and showing it again means
    // handing the track back in the mode the page had it in.
    setNativeCaptionsHidden(hidden) {
      if (!tt.track) return;
      if (!hidden) {
        // Not just cosmetic: without restoreTrackMode's disabled check, a viewer
        // switching subtitles off would get them handed straight back, we would
        // read that next frame as subtitles being on, adopt the track again, and
        // flip it off and on for as long as the video played.
        restoreTrackMode(tt.track, tt.restoreMode || 'showing');
        return;
      }
      try { tt.track.mode = 'hidden'; } catch (e) { /* detached */ }
    },
  };

  ctx.captionProviders.push(YouTubeProvider, TextTrackProvider);
})();
