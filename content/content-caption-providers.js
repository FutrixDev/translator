// Blab Translation — caption providers.
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

    // true / false / null — the same three answers as enableNativeCaptions, for
    // the same reason. The button is the only authority: the engine arms a
    // session-long latch off a false here (the viewer just switched captions
    // off, so stop turning them back on — see syncNativeCaptions), and a false
    // that was really a guess stops auto-enable for the rest of the session.
    //
    // Without a button, the caption container is all there is, and its mere
    // presence is not an answer: it is part of the player's chrome and can be
    // mounted, empty, before the control bar is. A caption actually drawn
    // inside it is an answer. Nothing drawn is "not yet" — never false — both
    // because the container may be empty simply between two cues, and because
    // an answer this weak must not be the one that closes the latch.
    nativeCaptionsState() {
      const button = document.querySelector('.ytp-subtitles-button');
      if (button) return button.getAttribute('aria-pressed') === 'true';
      const container = document.querySelector('.ytp-caption-window-container');
      if (container && container.querySelector('.ytp-caption-segment')) return true;
      return null;
    },

    // Press the player's own CC button. Only the engine calls this — from
    // syncNativeCaptions() when the viewer has asked for it in advance
    // (autoEnableCaptions), or from ctx.enableNativeCaptions() when they press
    // the menu's own row.
    //
    // Clicking YouTube's own control rather than reaching into the player's
    // API: the button is what a viewer would press, so whatever it does — pick
    // the default caption track, fall back to the auto-generated one, remember
    // the choice for the next video — is what happens here too. Auto-generated
    // captions come down the same /api/timedtext request, so the interceptor
    // picks them up with no extra work, and that is most of why this is worth
    // doing at all: the majority of YouTube videos have no human-written track.
    //
    // True means captions are on, or the click that turns them on just
    // happened. Why it came up empty is a separate question, and it has its own
    // method: canEnableNativeCaptions below.
    enableNativeCaptions() {
      const button = document.querySelector('.ytp-subtitles-button');
      if (!button) return false;
      if (button.getAttribute('aria-pressed') === 'true') return true;
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
      try {
        button.click();
      } catch (e) {
        return false;
      }
      return true;
    },

    // Could the viewer turn captions on right now? The menu asks this every
    // beat to decide whether to offer the row, and the answer is never written
    // down — all three of these change while a player loads:
    //   true  — the button is there and live;
    //   false — the button is there and disabled, which is how YouTube says
    //           this video has no caption track at all;
    //   null  — no control bar yet; ask again on the next beat.
    // Asking every time is the whole point. A disabled button is not always
    // permanent — the player disables it briefly during load — so an answer
    // remembered once would take the row away for the rest of the video, and
    // the viewer would have no way back.
    canEnableNativeCaptions() {
      const button = document.querySelector('.ytp-subtitles-button');
      if (!button) return null;
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
      return true;
    },

    // The player's own caption layer: already positioned over the video and
    // already inside the element that goes fullscreen.
    getOverlayHost() {
      return document.querySelector('.ytp-caption-window-container');
    },

    // Our button belongs in the player's own control bar, first in the right
    // group — left of the settings gear, where a viewer looks for caption
    // controls. The menu is anchored to #movie_player because that is the
    // element that goes fullscreen; a menu outside it would vanish there.
    getControlsHost() {
      // The bar is split into two groups on the live player today
      // (…-left holds CC and the gear, …-right holds size and fullscreen) and
      // is flat on older layouts. Prefer the left group so the button lands
      // beside the caption controls rather than beside fullscreen; fall back to
      // the bar itself where the split does not exist.
      const parent = document.querySelector('.ytp-right-controls-left')
        || document.querySelector('.ytp-right-controls');
      if (!parent) return null;
      return {
        parent,
        before: parent.firstElementChild,
        menuRoot: document.querySelector('#movie_player') || parent,
        buttonClass: 'ytp-button',
      };
    },

    // Sit where YouTube puts its own captions, and step above the control bar
    // while that is showing rather than hide behind it.
    getCaptionAnchor() {
      const player = document.querySelector('#movie_player');
      const controlsUp = !!player && !player.classList.contains('ytp-autohide');
      return { bottomPct: 8, liftPx: controlsUp ? 52 : 0 };
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
      label: tt.track.label || '',
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

  /**
   * Let go of a video that is not the page's any more, and of everything we
   * were holding on it.
   *
   * A generic SPA swaps the `<video>` on a route change, and the element it
   * removed keeps its tracks — detached, unwatchable, and still answering
   * every question we put to it. The track we left at 'hidden' on it reports
   * "subtitles are on" (nativeCaptionsState), which is what stops
   * autoEnableCaptions from ever turning a track on for the new video; the
   * overlay gets its box from a `<video>` nobody can see; and the cues stay
   * pinned to a film that finished.
   *
   * The engine is told because nobody else will tell it. Adopting a track on
   * the new video resets its cues by trackId — but the case this exists for is
   * the one where no adoption happens (every track at 'disabled', or none at
   * all), and the old lines would go on being drawn over the new picture.
   */
  function releaseStaleVideo(nextVideo) {
    const heldTrack = !!tt.track;
    releaseTrack();
    tt.video = nextVideo || null;
    if (heldTrack && tt.engine && tt.engine.reset) tt.engine.reset();
  }

  function adoptTrack(track, video) {
    releaseTrack();
    tt.video = video;
    tt.track = track;
    // What to hand it back as. Normally the mode we took it in — but a disabled
    // track only ever reaches here through "turn subtitles on" (see
    // syncSelection's allowDisabled), and subtitles are exactly what the viewer
    // asked for there. Handing that one back at 'disabled' takes away what he
    // just asked for the moment we let go: a blank screen in "original only",
    // and subtitles going with us when he switches translation off.
    tt.restoreMode = track.mode === 'disabled' ? 'showing' : track.mode;
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
   * What language is being spoken, as far as anything on the page will say.
   *
   * Usually nothing will: Chrome ships no `video.audioTracks` at all, and a
   * `lang` attribute on a `<video>` is rare. Both are read anyway because when
   * one of them *is* there it is a statement by the page rather than a guess,
   * and it is the only thing that can tell a transcription apart from a
   * translation in a track list. An empty answer is ordinary — see the rungs
   * in CaptionCore.pickSubtitleTrack().
   *
   * Deliberately not read: the page's own `lang`. On a video site that is the
   * language of the interface, which says nothing about the audio — the very
   * confusion caption-core's buildTranslationRequest() exists to avoid.
   */
  function audioLangOf(video) {
    if (!video) return '';
    try {
      const list = video.audioTracks;
      if (list && list.length) {
        for (const track of list) {
          if (track.enabled && track.language) return track.language;
        }
      }
    } catch (e) { /* not implemented here, which is the common case */ }
    return video.getAttribute && video.getAttribute('lang') || '';
  }

  /**
   * Choose (or re-choose) a track. Called on attach and whenever the page's
   * track list or a track's mode changes, so switching subtitle language in the
   * site's own control switches what we translate.
   *
   * No answer is a normal outcome — a page that offers subtitles the viewer has
   * not turned on gets nothing from us until they do, and this runs again then.
   *
   * `allowDisabled` is a **permission for this one call**, never a mode the
   * provider stays in. Turning subtitles on is something the engine decides and
   * the engine takes back (it stops the moment the viewer switches them off
   * again); if the flag lived here, every later track-list event would quietly
   * re-open the track the viewer had just closed.
   */
  function syncSelection(allowDisabled) {
    // Two ways to be holding a video that is gone, and both have to be cleared
    // before anything here reads state off it — see releaseStaleVideo(). The
    // page removed the element; or the element is still there and the tracks
    // we knew are not its any more.
    if (tt.video && tt.video.isConnected === false) releaseStaleVideo(null);
    const video = findVideoWithTracks() || tt.video;
    const entries = subtitleEntries(video);
    if (!entries.length) return;
    if (tt.track && !entries.some((entry) => entry.track === tt.track)) releaseStaleVideo(video);
    // Re-opening is not the same as choosing. `allowDisabled` only ever comes
    // from "turn subtitles on for me", and on a video whose tracks are all off
    // the track we are still holding is the one the viewer had on before he
    // turned them off — his choice, made once already.
    //
    // The picker cannot know that. With nothing showing it works down audio
    // language, `default`, first-listed, which on a list of four languages
    // hands back whichever the page listed first: a silent language change
    // wearing the clothes of a re-enable, and the viewer's own selection lost
    // to a press of the row that was meant to give it back.
    //
    // Only when nothing else is on: a track at 'showing' or 'hidden' means the
    // page (or the viewer) has already moved to another one, and that one is
    // the current answer — the same order pickSubtitleTrack() itself keeps.
    const heldEntry = tt.track ? entries.find((entry) => entry.track === tt.track) : null;
    const reopenHeld = !!(allowDisabled && heldEntry && !core.hasActiveSubtitleTrack(entries));
    const picked = reopenHeld ? heldEntry : core.pickSubtitleTrack(entries, allowDisabled
      ? { allowDisabled: true, audioLang: audioLangOf(video) }
      : undefined);
    if (!picked) return;
    // The page switched off the track we hold (its mode went to 'disabled'):
    // we have not let go of it, but it is no longer a track we are on. Without
    // this, `picked.track === tt.track` reads "re-open the one I just closed"
    // as "you are already on it", and enableNativeCaptions() reports failure
    // having done nothing — when re-opening it is the entire point of the call.
    //
    // Only the re-enable path arrives here holding what was picked: an
    // ordinary sync calls pickSubtitleTrack() without allowDisabled, which
    // filters disabled tracks out and so can never hand back the one we hold.
    const heldOff = !!tt.track && tt.track.mode === 'disabled';
    if (picked.track === tt.track && !heldOff) return;
    // Our own track sits at 'hidden', which is never 'showing' — so only an
    // explicit switch by the page (or losing the track we held) moves us.
    const holding = !!heldEntry && !heldOff;
    if (holding && picked.track.mode !== 'showing') return;
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

    // Once we hold a track, that track is the answer: we keep it at 'hidden'
    // and draw the line ourselves, and a player turning subtitles off sets it
    // to 'disabled', which is how that reads here.
    //
    // Holding nothing is a different question, not the same one answered "no".
    // This provider is asked as a *candidate* too: the menu's status line is
    // drawn on every page with a video, and with subtitle translation switched
    // off — the default — nothing ever attaches, so `tt.track` is null on a
    // page whose own subtitles are running perfectly well. Answering "off"
    // there put "no subtitle track detected" in the menu about the very track
    // burned into the picture in front of the viewer (the status line falls to
    // that wording because the "turn subtitles on" row is itself hidden while
    // the feature is off — see refreshMenu in content-caption-controls.js).
    //
    // So with nothing of our own to read, read the page's: a subtitle track
    // out of 'disabled' is subtitles being drawn by somebody, the browser at
    // 'showing' or the player itself at 'hidden'.
    //
    // Never null: unlike a control bar that has to mount, a track list is
    // readable from the first frame, so this provider is always sure.
    nativeCaptionsState() {
      if (tt.track) return tt.track.mode !== 'disabled';
      return core.hasActiveSubtitleTrack(subtitleEntries(TextTrackProvider.getVideo()));
    },

    // Turn subtitles on: re-run the choice with disabled tracks allowed in.
    // Adopting a track is *already* how this provider switches captions on —
    // it holds them at 'hidden' and draws the line itself — so there is nothing
    // to click here, only a track to take.
    //
    // True means a track is now held, which is as much as this can promise:
    // its cues may still be on their way (a <track> file is only fetched once
    // its mode leaves 'disabled' — see adoptTrack).
    //
    enableNativeCaptions() {
      syncSelection(true);
      return !!(tt.track && tt.track.mode !== 'disabled');
    },

    // A track listed is all this one needs, since adopting one is how it turns
    // captions on. None listed is "not yet" rather than "never": this provider
    // only offers itself on a video that had a track (canActivate), so an empty
    // list means they went out from under us — a video swapped, a <track> not
    // mounted yet — and the next beat may well find them.
    canEnableNativeCaptions() {
      return subtitleEntries(TextTrackProvider.getVideo()).length ? true : null;
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

    // A generic player's controls are its own; we do not know its bar, so the
    // engine falls back to a badge pinned to the video (see content-caption-
    // controls.js). Returning null is that answer, not a failure.
    getControlsHost() {
      return null;
    },

    // No player chrome we can measure, so just off the bottom edge.
    getCaptionAnchor() {
      return { bottomPct: 6, liftPx: 0 };
    },

    // What the menu's status line names. Read-only: this runs while the feature
    // is off, so it must not adopt anything or touch a track's mode.
    //
    // A track we hold but the page has switched off is not a track we are on:
    // naming it would have the menu say subtitles are running when the screen
    // is blank, and hide the row that offers to turn them back on. Falling
    // through answers what is actually available — nothing, while every track
    // is disabled, which is the honest answer there.
    getTrackLabel() {
      if (tt.track && tt.track.mode !== 'disabled') return tt.track.label || tt.track.language || '';
      const entries = subtitleEntries(findVideoWithTracks());
      if (!entries.length) return '';
      const picked = core.pickSubtitleTrack(entries);
      if (!picked) return '';
      return picked.track.label || picked.track.language || '';
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
