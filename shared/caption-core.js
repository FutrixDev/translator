// AI Translator — the site-independent half of subtitle translation.
//
// Everything here is pure: give it text or cues, get cues or segments back. It
// knows nothing about YouTube, about the DOM, or about how a page hands over
// its subtitles — that is a caption *provider*'s job (see
// content/content-caption-providers.js), and this module is what every provider
// feeds into.
//
// Three things live here because more than one provider needs each of them:
//
//   parsers          WebVTT / JSON3 / SRV3-XML text -> {startMs, endMs, text}
//   cue conversion   a browser TextTrackCue -> the same shape
//   segmentation     raw cues -> sentences -> translation batches
//
// Loaded as a classic script by the content scripts, so it publishes onto the
// global object rather than using `export` — same reason as
// shared/account-gate.js.
(function (root) {
  'use strict';

  // Merge short ASR fragments into full sentences, so the model translates
  // coherent units (not word-fragments) and the reader sees a complete line
  // while it is being spoken.
  const SEG_MAX_DURATION_MS = 12000;
  const SEG_MAX_CHARS = 220;
  const SEG_GAP_MS = 1500;
  // Contiguous sentences are grouped into batches so each request carries
  // neighbouring sentences for context.
  const BATCH_MAX_ITEMS = 16;
  const BATCH_MAX_CHARS = 1600;
  const MAX_CUES = 20000;

  /**
   * One cue's text, as the translator should see it: no inline markup (WebVTT
   * `<c>`/`<v>` tags, TTML spans), no runs of whitespace, no surrounding space.
   */
  function normalizeCueText(value) {
    return String(value == null ? '' : value)
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * The engine's cue shape, from a start/end in *seconds*. Returns null for
   * anything unusable — an empty line, a zero-length cue, or the Infinity end
   * time a live stream's last cue can carry.
   */
  function toRawCue(startSec, endSec, text) {
    const startMs = Math.round(Number(startSec) * 1000);
    const endMs = Math.round(Number(endSec) * 1000);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    const clean = normalizeCueText(text);
    if (!clean) return null;
    return { startMs, endMs, text: clean };
  }

  /**
   * A browser TextTrackCueList -> raw cues. This is the whole of what a
   * class-A site (plain `<track>` / TextTrack) costs us: the browser has
   * already parsed the file, so there is nothing to fetch and nothing to sniff.
   */
  function fromTextTrackCues(cues) {
    const out = [];
    const list = cues ? Array.from(cues) : [];
    for (const cue of list) {
      // VTTCue.text is the cue payload including its inline markup; other cue
      // types (a DataCue on a metadata track) have no text and drop out here.
      const raw = toRawCue(cue.startTime, cue.endTime, cue.text);
      if (raw) out.push(raw);
    }
    return out;
  }

  // ---------------------------------------------------------------- parsers
  function parseJson3(data) {
    const events = Array.isArray(data && data.events) ? data.events : [];
    const cues = [];
    for (const event of events) {
      const startMs = Number(event.tStartMs);
      const durationMs = Number(event.dDurationMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(durationMs) || durationMs <= 0) continue;
      const text = normalizeCueText((event.segs || []).map((seg) => seg.utf8 || '').join(''));
      if (!text) continue;
      cues.push({ startMs, endMs: startMs + durationMs, text });
    }
    return cues;
  }

  function parseVttTimestamp(value) {
    if (!value) return Number.NaN;
    const cleaned = value.replace(',', '.');
    const parts = cleaned.split(':');
    if (parts.length < 2) return Number.NaN;
    const secondsPart = parts.pop() || '0';
    const minutesPart = parts.pop() || '0';
    const hoursPart = parts.pop() || '0';
    const [secStr, msStr = '0'] = secondsPart.split('.');
    const hours = Number(hoursPart);
    const minutes = Number(minutesPart);
    const seconds = Number(secStr);
    const millis = Number(msStr.padEnd(3, '0').slice(0, 3));
    if (![hours, minutes, seconds, millis].every(Number.isFinite)) return Number.NaN;
    return ((hours * 3600 + minutes * 60 + seconds) * 1000) + millis;
  }

  /** WebVTT and SRT — the two differ only in the timestamp separator. */
  function parseVtt(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const cues = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line || line.startsWith('WEBVTT')) {
        i += 1;
        continue;
      }
      if (line.includes('-->')) {
        const parts = line.split('-->');
        const startMs = parseVttTimestamp((parts[0] || '').trim());
        const endMs = parseVttTimestamp(((parts[1] || '').trim()).split(' ')[0] || '');
        i += 1;
        const textLines = [];
        while (i < lines.length && lines[i].trim() !== '') {
          textLines.push(lines[i]);
          i += 1;
        }
        const cueText = normalizeCueText(textLines.join(' '));
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && cueText) {
          cues.push({ startMs, endMs, text: cueText });
        }
        continue;
      }
      i += 1;
    }
    return cues;
  }

  function parseSrv3(text) {
    // Only reachable in a page (the parser is a DOM API). Node runs this module
    // for its unit tests, where the XML formats simply do not arise.
    if (typeof DOMParser === 'undefined') return [];
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const nodes = Array.from(doc.getElementsByTagName('text'));
    const cues = [];
    for (const node of nodes) {
      const start = Number(node.getAttribute('start'));
      const dur = Number(node.getAttribute('dur') || node.getAttribute('d'));
      if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
      const cueText = normalizeCueText(node.textContent);
      if (!cueText) continue;
      cues.push({
        startMs: Math.round(start * 1000),
        endMs: Math.round((start + dur) * 1000),
        text: cueText,
      });
    }
    return cues;
  }

  /** Sniff a subtitle payload and parse it. Unknown shapes yield no cues. */
  function parseCaptionPayload(text, contentType) {
    const trimmed = (text || '').trim();
    if (!trimmed) return [];
    const ct = contentType || '';
    if (ct.includes('json') || trimmed.startsWith('{')) {
      try {
        return parseJson3(JSON.parse(trimmed));
      } catch (e) { /* fall through */ }
    }
    if (trimmed.startsWith('WEBVTT') || trimmed.includes('-->')) {
      return parseVtt(trimmed);
    }
    if (trimmed.startsWith('<')) {
      return parseSrv3(trimmed);
    }
    try {
      return parseJson3(JSON.parse(trimmed));
    } catch (e) { /* give up */ }
    return [];
  }

  // ----------------------------------------------------------- segmentation
  function endsSentence(text) {
    return /[.!?。！？…؟][)"'”’\]]?\s*$/.test(text);
  }

  /**
   * Group consecutive raw cues into sentence-level segments. A new segment
   * starts at sentence-ending punctuation, a long pause, or when the merged
   * text/span grows too large.
   */
  function buildSegments(rawCues) {
    const sorted = rawCues.slice().sort((a, b) => a.startMs - b.startMs);
    const segments = [];
    let cur = null;
    for (const cue of sorted) {
      if (!cur) {
        cur = { startMs: cue.startMs, endMs: cue.endMs, text: cue.text };
        continue;
      }
      const gap = cue.startMs - cur.endMs;
      const merged = `${cur.text} ${cue.text}`.replace(/\s+/g, ' ').trim();
      const spanTooLong = (cue.endMs - cur.startMs) > SEG_MAX_DURATION_MS;
      if (endsSentence(cur.text) || gap > SEG_GAP_MS || merged.length > SEG_MAX_CHARS || spanTooLong) {
        segments.push(cur);
        cur = { startMs: cue.startMs, endMs: cue.endMs, text: cue.text };
      } else {
        cur.text = merged;
        cur.endMs = cue.endMs;
      }
    }
    if (cur) segments.push(cur);
    return segments;
  }

  /** Chunk contiguous segments into batches, bounded by item count and characters. */
  function buildBatches(segments) {
    const batches = [];
    let cur = [];
    let chars = 0;
    for (const seg of segments) {
      if (cur.length && (cur.length >= BATCH_MAX_ITEMS || chars + seg.text.length > BATCH_MAX_CHARS)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(seg);
      chars += seg.text.length;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  /**
   * Add cues to a track's set, ignoring ones already held.
   *
   * Providers re-offer the whole track rather than a delta — a TextTrack grows
   * cue by cue and a `<track>` file arrives all at once, and neither knows what
   * we have already seen. Returns the same array instance when nothing is new,
   * so a caller can skip re-segmenting on the common no-op.
   */
  function mergeRawCues(existing, incoming, maxCues) {
    const cap = maxCues || MAX_CUES;
    const identity = (cue) => `${cue.startMs}|${cue.text}`;
    const seen = new Set(existing.map(identity));
    const merged = existing.slice();
    let added = false;
    for (const cue of incoming || []) {
      const id = identity(cue);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(cue);
      added = true;
    }
    if (!added) return { cues: existing, added: false };
    merged.sort((a, b) => a.startMs - b.startMs);
    return { cues: merged.length > cap ? merged.slice(-cap) : merged, added: true };
  }

  // ------------------------------------------------------- provider picking
  /**
   * Provider ranks. A site-specific provider always outranks the generic one:
   * where a site needs special handling it is because the standard TextTrack
   * route gives a worse answer there, not a missing one.
   */
  const PROVIDER_PRIORITY = { SITE: 100, GENERIC: 10 };

  /**
   * The provider that gets this page: the highest-priority one that says it can
   * supply cues here. Ties keep registration order (Array#sort is stable).
   *
   * A provider that throws from canActivate() is a provider that cannot run —
   * a site-specific one probing for DOM that is not there must never take the
   * page down with it, nor block the generic provider behind it.
   */
  function selectProvider(providers) {
    const ranked = (providers || []).slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
    for (const provider of ranked) {
      try {
        if (provider && provider.canActivate && provider.canActivate()) return provider;
      } catch (e) { /* next */ }
    }
    return null;
  }

  function getLangBase(lang) {
    if (!lang) return '';
    return String(lang).split('-')[0].toLowerCase();
  }

  /**
   * Which of a video's subtitle tracks to translate, given `{track, isDefault}`
   * entries (isDefault is the `default` attribute on the `<track>` element,
   * which a TextTrack itself does not expose).
   *
   * We translate the subtitles the viewer already has on. We never turn
   * subtitles on for them, and a track's mode is what says which is which:
   * 'showing' is the browser drawing the track, and 'hidden' is a player that
   * loads the cues and draws them itself (video.js, Vimeo and JW all do).
   *
   * Everything left at 'disabled' is a language the page merely offers —
   * Vimeo's player lists four and shows none until asked — so choosing among
   * those would put subtitles on screen that nobody asked for, in whichever
   * language happened to be listed first. Returning null is therefore an
   * ordinary answer and not a failure: the provider stays attached, and this
   * runs again the moment a track's mode changes.
   */
  function pickSubtitleTrack(entries) {
    const list = entries || [];
    const inMode = (mode) => {
      const matching = list.filter((entry) => entry.track && entry.track.mode === mode);
      if (!matching.length) return null;
      // Several at once is a player preloading its whole list; the one the
      // page marked default is its answer to which of them matters.
      return matching.find((entry) => entry.isDefault) || matching[0];
    };
    return inMode('showing') || inMode('hidden') || null;
  }

  /**
   * The translation request for one batch of caption segments.
   *
   * The caption track states its own language, and that statement beats
   * detection every time: one subtitle line is a handful of words, far too
   * short to identify reliably, so detection falls back to the language of the
   * *page* — which on a video site describes the interface, not the audio. A
   * Chinese-UI page playing an English talk detects as `zh`, the engine reads
   * that as "already in the target language" and hands the line back
   * untouched, and the viewer sees no translation at all.
   *
   * `sourceLang` is left off when the track declares nothing, which puts that
   * track back on detection rather than on a guess.
   */
  function buildTranslationRequest(options) {
    const opts = options || {};
    const message = {
      type: 'TRANSLATE_BATCH_FAST',
      texts: opts.texts || [],
      targetLang: opts.targetLang || '',
      delimiter: opts.delimiter,
      // Subtitles run with the playhead, so they cannot wait on a language
      // pack download the way a page translation can.
      allowDownload: false,
    };
    const trackLang = String(opts.trackLang == null ? '' : opts.trackLang).trim();
    if (trackLang) message.sourceLang = trackLang;
    return message;
  }

  root.CaptionCore = {
    SEG_MAX_DURATION_MS,
    SEG_MAX_CHARS,
    SEG_GAP_MS,
    BATCH_MAX_ITEMS,
    BATCH_MAX_CHARS,
    MAX_CUES,
    normalizeCueText,
    toRawCue,
    fromTextTrackCues,
    parseJson3,
    parseVtt,
    parseSrv3,
    parseCaptionPayload,
    endsSentence,
    buildSegments,
    buildBatches,
    mergeRawCues,
    buildTranslationRequest,
    PROVIDER_PRIORITY,
    selectProvider,
    pickSubtitleTrack,
    getLangBase,
  };
})(globalThis);
