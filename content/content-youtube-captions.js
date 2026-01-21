// AI Translator YouTube Caption Translation
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) {
    if (window.location.hostname.includes('youtube.com')) {
      console.warn('AI Translator: YouTube captions skipped, ctx missing');
    }
    return;
  }
  if (window.location.hostname.includes('youtube.com')) {
    console.log('AI Translator: YouTube captions script loaded');
  }

  const PREFETCH_MS = 120000;
  const PREFETCH_INTERVAL_MS = 1000;
  const BATCH_SIZE = 12;
  const DELIMITER = '<<<>>>';

  const state = {
    active: false,
    overlay: null,
    cues: [],
    cueCache: new Map(),
    pendingKeys: new Set(),
    track: null,
    trackId: '',
    skipTranslation: false,
    captionsPoll: null,
    video: null,
    lastNowMs: 0,
    trackRequestInFlight: false,
  };

  let timedtextProxyInjected = false;
  let timedtextRequestSeq = 0;

  function isYouTube() {
    return window.location.hostname.includes('youtube.com');
  }

  function isCaptionsEnabled() {
    const button = document.querySelector('.ytp-subtitles-button');
    if (button) {
      return button.getAttribute('aria-pressed') === 'true';
    }
    return !!document.querySelector('.ytp-caption-window-container');
  }

  function getVideoElement() {
    return document.querySelector('video');
  }

  function resetState() {
    state.cues = [];
    state.cueCache.clear();
    state.pendingKeys.clear();
    state.track = null;
    state.trackId = '';
    state.skipTranslation = false;
    state.lastNowMs = 0;
    state.trackRequestInFlight = false;
    if (state.captionsPoll) {
      clearInterval(state.captionsPoll);
      state.captionsPoll = null;
    }
    if (state.overlay) {
      state.overlay.remove();
      state.overlay = null;
    }
    if (state.video) {
      state.video.removeEventListener('timeupdate', handleTimeUpdate);
      state.video = null;
    }
  }

  function cleanup() {
    state.active = false;
    resetState();
  }

  function ensureOverlay() {
    const container = document.querySelector('.ytp-caption-window-container');
    if (!container) return null;

    if (state.overlay && container.contains(state.overlay)) {
      return state.overlay;
    }

    const overlay = document.createElement('div');
    overlay.id = 'ai-translator-youtube-caption-overlay';
    const line = document.createElement('div');
    line.className = 'ai-translator-caption-line';
    overlay.appendChild(line);
    container.appendChild(overlay);
    state.overlay = overlay;
    return overlay;
  }

  function setOverlayText(text) {
    if (!state.overlay) return;
    const line = state.overlay.querySelector('.ai-translator-caption-line');
    if (!line) return;
    line.textContent = text || '';
  }

  function setOverlayVisible(visible) {
    if (!state.overlay) return;
    state.overlay.style.display = visible ? 'flex' : 'none';
  }

  async function requestCaptionTracks() {
    if (state.track) return;
    if (state.trackRequestInFlight) return;
    state.trackRequestInFlight = true;
    try {
      console.log('AI Translator: requestCaptionTracks start', {
        hasTrack: !!state.track,
      });
      const inlineTracks = getTracksFromInlineScripts();
      if (inlineTracks && inlineTracks.length) {
        console.log('AI Translator: inline tracks found', {
          count: inlineTracks.length,
        });
        handleTracks(inlineTracks);
        return;
      }
      const fetchedTracks = await fetchTracksFromWatchPage();
      if (fetchedTracks && fetchedTracks.length) {
        console.log('AI Translator: fetched tracks found', {
          count: fetchedTracks.length,
        });
        handleTracks(fetchedTracks);
      } else {
        console.log('AI Translator: no caption tracks found');
      }
    } finally {
      state.trackRequestInFlight = false;
    }
  }

  function getTrackLanguage(track) {
    const lang = track?.languageCode || '';
    return ctx.getLangBase ? ctx.getLangBase(lang) : lang.split('-')[0];
  }

  function getTargetLanguageBase() {
    const target = ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : '';
    return ctx.getLangBase ? ctx.getLangBase(target) : target.split('-')[0];
  }

  function selectTrack(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    return tracks[0];
  }

  function extractArrayLiteral(source, anchorIndex) {
    const bracketStart = source.indexOf('[', anchorIndex);
    if (bracketStart === -1) return null;
    let depth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let isEscaped = false;
    for (let i = bracketStart; i < source.length; i += 1) {
      const char = source[i];
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === '\\\\') {
        isEscaped = true;
        continue;
      }
      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        continue;
      }
      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }
      if (inSingleQuote || inDoubleQuote) continue;
      if (char === '[') {
        depth += 1;
      } else if (char === ']') {
        depth -= 1;
        if (depth === 0) {
          return source.slice(bracketStart, i + 1);
        }
      }
    }
    return null;
  }

  function extractJsonObject(source, anchorIndex) {
    const braceStart = source.indexOf('{', anchorIndex);
    if (braceStart === -1) return null;
    let depth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let isEscaped = false;
    for (let i = braceStart; i < source.length; i += 1) {
      const char = source[i];
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === '\\\\') {
        isEscaped = true;
        continue;
      }
      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        continue;
      }
      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }
      if (inSingleQuote || inDoubleQuote) continue;
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return source.slice(braceStart, i + 1);
        }
      }
    }
    return null;
  }

  function splitTopLevelObjects(source) {
    const items = [];
    let start = null;
    let depth = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let isEscaped = false;
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === '\\\\') {
        isEscaped = true;
        continue;
      }
      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        continue;
      }
      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }
      if (inSingleQuote || inDoubleQuote) continue;
      if (char === '{') {
        if (depth === 0) start = i;
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0 && start !== null) {
          items.push(source.slice(start, i + 1));
          start = null;
        }
      }
    }
    return items;
  }

  function decodeTrackValue(value) {
    if (!value) return value;
    return value
      .replace(/\\u0026/g, '&')
      .replace(/\\u003d/g, '=')
      .replace(/\\u003f/g, '?')
      .replace(/\\u002f/g, '/');
  }

  function logCaptionRenderer(renderer, source) {
    if (!renderer) return;
    const tracks = renderer.captionTracks || [];
    const translationLanguages = renderer.translationLanguages || [];
    const translationLangSample = translationLanguages
      .slice(0, 8)
      .map((lang) => lang.languageCode || lang.languageName?.simpleText || '');
    const summaries = tracks.map((track) => ({
      languageCode: track.languageCode,
      kind: track.kind || '',
      name: track.name?.simpleText || '',
      isTranslatable: track.isTranslatable,
      vssId: track.vssId,
      hasBaseUrl: !!track.baseUrl,
      hasSignatureCipher: !!track.signatureCipher,
      baseUrlSample: track.baseUrl ? String(track.baseUrl).slice(0, 120) : '',
    }));
    console.log('AI Translator: caption renderer info', {
      source,
      trackCount: tracks.length,
      translationLangCount: translationLanguages.length,
      translationLangSample,
    });
    console.log('AI Translator: caption track summaries', summaries);
  }

  function extractTracksFromResponse(data) {
    const renderer = data?.captions?.playerCaptionsTracklistRenderer || null;
    if (!renderer) return null;
    const tracks = renderer.captionTracks || null;
    if (!Array.isArray(tracks) || !tracks.length) return null;
    logCaptionRenderer(renderer, 'playerResponse');
    return tracks;
  }

  function parseTracksFromScriptText(text) {
    const responseIndex = text.indexOf('ytInitialPlayerResponse');
    if (responseIndex !== -1) {
      const json = extractJsonObject(text, responseIndex);
      if (json) {
        try {
          const data = JSON.parse(json);
          const tracks = extractTracksFromResponse(data);
          if (tracks) return tracks;
        } catch (error) {
          // Fall back to lightweight parsing.
        }
      }
    }

    // Parse captionTracks without eval to avoid CSP restrictions.
    const anchorIndex = text.indexOf('captionTracks');
    if (anchorIndex === -1) return null;
    const arrayLiteral = extractArrayLiteral(text, anchorIndex);
    if (!arrayLiteral) return null;
    const objects = splitTopLevelObjects(arrayLiteral.slice(1, -1));
    const tracks = [];
    for (const objText of objects) {
      const langMatch = objText.match(/languageCode\s*:\s*['"]([^'"]+)['"]/);
      const baseUrlMatch = objText.match(/baseUrl\s*:\s*['"]([^'"]+)['"]/);
      if (!langMatch || !baseUrlMatch) continue;
      tracks.push({
        languageCode: langMatch[1],
        baseUrl: decodeTrackValue(baseUrlMatch[1]),
      });
    }
    if (tracks.length) {
      console.log('AI Translator: caption tracks parsed (fallback)', {
        count: tracks.length,
      });
    }
    return tracks.length ? tracks : null;
  }

  function getTracksFromInlineScripts() {
    const scripts = Array.from(document.scripts || []);
    console.log('AI Translator: scanning inline scripts', {
      count: scripts.length,
    });
    for (const script of scripts) {
      const text = script.textContent || '';
      const tracks = parseTracksFromScriptText(text);
      if (tracks) {
        console.log('AI Translator: inline script tracks parsed', {
          count: tracks.length,
        });
        return tracks;
      }
    }
    return null;
  }

  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('v') || '';
  }

  async function fetchTracksFromWatchPage() {
    const videoId = getVideoId();
    if (!videoId) {
      console.warn('AI Translator: missing video id for watch fetch');
      return null;
    }
    try {
      const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
      if (!response.ok) {
        console.warn('AI Translator: watch fetch not ok', {
          status: response.status,
        });
        return null;
      }
      const html = await response.text();
      const tracks = parseTracksFromScriptText(html);
      if (tracks && tracks.length) {
        console.log('AI Translator: watch fetch tracks parsed', {
          count: tracks.length,
        });
      } else {
        console.warn('AI Translator: watch fetch tracks missing');
      }
      return tracks;
    } catch (error) {
      console.warn('AI Translator: watch fetch failed', error);
      return null;
    }
  }

  async function fetchTimedText(track) {
    if (!track?.baseUrl) return [];
    const jsonUrl = new URL(track.baseUrl);
    jsonUrl.searchParams.set('fmt', 'json3');
    const jsonResult = await fetchTimedTextUrl(jsonUrl.toString(), 'json3');
    if (jsonResult.ok && jsonResult.text) {
      const trimmed = jsonResult.text.trim();
      if (jsonResult.contentType.includes('json') || trimmed.startsWith('{')) {
        try {
          const data = JSON.parse(jsonResult.text);
          const cues = parseTimedText(data);
          console.log('AI Translator: timedtext json3 parsed', {
            cueCount: cues.length,
          });
          return cues;
        } catch (error) {
          console.warn('AI Translator: timedtext json parse failed', error);
        }
      } else {
        console.warn('AI Translator: timedtext not json', {
          contentType: jsonResult.contentType,
          length: jsonResult.text.length,
        });
      }
    }

    const vttUrl = new URL(track.baseUrl);
    vttUrl.searchParams.set('fmt', 'vtt');
    const vttResult = await fetchTimedTextUrl(vttUrl.toString(), 'vtt');
    if (vttResult.ok && vttResult.text) {
      const cues = parseVtt(vttResult.text);
      console.log('AI Translator: timedtext vtt parsed', {
        cueCount: cues.length,
      });
      if (cues.length) return cues;
    }

    const srv3Url = new URL(track.baseUrl);
    srv3Url.searchParams.set('fmt', 'srv3');
    const srv3Result = await fetchTimedTextUrl(srv3Url.toString(), 'srv3');
    if (!srv3Result.ok || !srv3Result.text) return [];
    const cues = parseSrv3(srv3Result.text);
    console.log('AI Translator: timedtext srv3 parsed', {
      cueCount: cues.length,
    });
    if (cues.length) return cues;

    const defaultResult = await fetchTimedTextUrl(track.baseUrl, 'default');
    if (!defaultResult.ok || !defaultResult.text) return [];
    return parseTimedTextFallback(defaultResult);
  }

  async function fetchTimedTextUrl(urlStr, format) {
    let response;
    try {
      response = await fetch(urlStr, {
        credentials: 'include',
      });
      const contentType = response.headers.get('content-type') || '';
      const contentLength = response.headers.get('content-length') || '';
      if (!response.ok) {
        console.warn('AI Translator: timedtext response not ok', {
          status: response.status,
          contentType,
          contentLength,
          url: urlStr,
          format,
        });
        return {
          ok: false,
          status: response.status,
          contentType,
          contentLength,
          text: '',
        };
      }
      const text = await response.text();
      console.log('AI Translator: timedtext response meta', {
        format,
        status: response.status,
        contentType,
        contentLength,
        url: urlStr.slice(0, 200),
      });
      console.log('AI Translator: timedtext body preview', {
        format,
        length: text.length,
        sample: text.slice(0, 80),
      });
      if (!text) {
        const proxyResult = await requestTimedTextViaPage(urlStr, format);
        if (proxyResult && proxyResult.text) {
          return proxyResult;
        }
      }
      return {
        ok: true,
        status: response.status,
        contentType,
        contentLength,
        text,
      };
    } catch (error) {
      const proxyResult = await requestTimedTextViaPage(urlStr, format);
      if (proxyResult && proxyResult.text) {
        return proxyResult;
      }
      console.warn('AI Translator: Failed to fetch timedtext', error, {
        url: urlStr,
        format,
        status: response?.status,
        contentType: response?.headers?.get('content-type') || '',
        contentLength: response?.headers?.get('content-length') || '',
      });
      return {
        ok: false,
        status: response?.status || 0,
        contentType: response?.headers?.get('content-type') || '',
        contentLength: response?.headers?.get('content-length') || '',
        text: '',
      };
    }
  }

  function ensureTimedtextProxy() {
    if (timedtextProxyInjected) return;
    timedtextProxyInjected = true;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('content/youtube-timedtext-proxy.js');
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.addEventListener('load', () => script.remove());
    script.addEventListener('error', () => {
      console.warn('AI Translator: timedtext proxy failed to load');
    });
  }

  function requestTimedTextViaPage(urlStr, format) {
    if (!window.location.hostname.includes('youtube.com')) return null;
    ensureTimedtextProxy();
    const requestId = `tt-${Date.now()}-${timedtextRequestSeq += 1}`;
    return new Promise((resolve) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', handler);
        resolve(null);
      }, 8000);
      const handler = (event) => {
        const data = event.data;
        if (!data || data.source !== 'ai-translator' || data.type !== 'YT_TIMEDTEXT_RESPONSE') return;
        if (data.requestId !== requestId) return;
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        window.removeEventListener('message', handler);
        if (data.error) {
          console.warn('AI Translator: timedtext proxy error', data.error);
          resolve(null);
          return;
        }
        console.log('AI Translator: timedtext proxy preview', {
          format,
          length: (data.text || '').length,
          sample: (data.text || '').slice(0, 80),
        });
        resolve({
          ok: !!data.ok,
          status: data.status || 0,
          contentType: data.contentType || '',
          contentLength: data.contentLength || '',
          text: data.text || '',
        });
      };
      window.addEventListener('message', handler);
      window.postMessage({
        source: 'ai-translator',
        type: 'YT_TIMEDTEXT_REQUEST',
        requestId,
        url: urlStr,
        format,
      }, '*');
    });
  }

  function parseVtt(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const cues = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) {
        i += 1;
        continue;
      }
      if (line.startsWith('WEBVTT')) {
        i += 1;
        continue;
      }
      if (line.includes('-->')) {
        const parts = line.split('-->');
        const startMs = parseVttTimestamp(parts[0]?.trim() || '');
        const endPart = parts[1]?.trim() || '';
        const endMs = parseVttTimestamp(endPart.split(' ')[0] || '');
        i += 1;
        const textLines = [];
        while (i < lines.length && lines[i].trim() !== '') {
          textLines.push(lines[i]);
          i += 1;
        }
        const cueText = textLines
          .join(' ')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && cueText) {
          cues.push({
            startMs,
            endMs,
            text: cueText,
          });
        }
        continue;
      }
      i += 1;
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

  function parseSrv3(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    const nodes = Array.from(doc.getElementsByTagName('text'));
    const cues = [];
    for (const node of nodes) {
      const start = Number(node.getAttribute('start'));
      const durValue = node.getAttribute('dur') || node.getAttribute('d');
      const dur = Number(durValue);
      if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
      const cueText = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!cueText) continue;
      cues.push({
        startMs: Math.round(start * 1000),
        endMs: Math.round((start + dur) * 1000),
        text: cueText,
      });
    }
    return cues;
  }

  function parseTimedTextFallback(result) {
    const text = result.text || '';
    const trimmed = text.trim();
    if (!trimmed) return [];
    if (result.contentType.includes('json') || trimmed.startsWith('{')) {
      try {
        const data = JSON.parse(trimmed);
        const cues = parseTimedText(data);
        console.log('AI Translator: timedtext default json parsed', {
          cueCount: cues.length,
        });
        return cues;
      } catch (error) {
        console.warn('AI Translator: default json parse failed', error);
      }
    }
    if (trimmed.startsWith('WEBVTT') || trimmed.includes('-->')) {
      const cues = parseVtt(trimmed);
      console.log('AI Translator: timedtext default vtt parsed', {
        cueCount: cues.length,
      });
      return cues;
    }
    const cues = parseSrv3(trimmed);
    console.log('AI Translator: timedtext default srv3 parsed', {
      cueCount: cues.length,
    });
    return cues;
  }

  function parseTimedText(data) {
    const events = Array.isArray(data?.events) ? data.events : [];
    const cues = [];
    for (const event of events) {
      const startMs = Number(event.tStartMs);
      const durationMs = Number(event.dDurationMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(durationMs) || durationMs <= 0) continue;
      const text = (event.segs || [])
        .map((seg) => seg.utf8 || '')
        .join('')
        .trim();
      if (!text) continue;
      cues.push({
        startMs,
        endMs: startMs + durationMs,
        text,
      });
    }
    return cues;
  }

  function getCueKey(cue) {
    return `${state.trackId}|${cue.startMs}|${cue.text}`;
  }

  function getCuesInWindow(nowMs) {
    const windowEnd = nowMs + PREFETCH_MS;
    return state.cues.filter((cue) => cue.startMs <= windowEnd && cue.endMs >= nowMs);
  }

  function getActiveCue(nowMs) {
    return state.cues.find((cue) => nowMs >= cue.startMs && nowMs <= cue.endMs);
  }

  async function translateCues(cues) {
    if (state.skipTranslation) return;
    if (!cues.length) return;

    const texts = cues.map((cue) => cue.text);
    const response = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_BATCH_FAST',
      texts,
      targetLang: ctx.getEffectiveTargetLang ? ctx.getEffectiveTargetLang() : '',
      delimiter: DELIMITER,
    });

    if (!response || response.error || !Array.isArray(response.translations)) {
      return;
    }

    response.translations.forEach((translation, index) => {
      const cue = cues[index];
      if (!cue) return;
      const key = getCueKey(cue);
      state.cueCache.set(key, translation || cue.text);
      state.pendingKeys.delete(key);
    });

    renderActiveCue(state.lastNowMs);
  }

  async function scheduleTranslations(nowMs) {
    if (state.skipTranslation) return;
    const upcoming = getCuesInWindow(nowMs);
    const queue = [];

    for (const cue of upcoming) {
      const key = getCueKey(cue);
      if (state.cueCache.has(key) || state.pendingKeys.has(key)) continue;
      state.pendingKeys.add(key);
      queue.push(cue);
    }

    if (!queue.length) return;

    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
      const batch = queue.slice(i, i + BATCH_SIZE);
      await translateCues(batch);
    }
  }

  function renderActiveCue(nowMs) {
    if (!state.overlay) return;
    const cue = getActiveCue(nowMs);
    if (!cue) {
      setOverlayText('');
      return;
    }
    const key = getCueKey(cue);
    const translation = state.cueCache.get(key);
    setOverlayText(translation || '');
  }

  async function handleTimeUpdate() {
    if (!state.active) return;
    if (!state.cues.length) return;

    if (!isCaptionsEnabled()) {
      setOverlayVisible(false);
      return;
    }

    ensureOverlay();
    setOverlayVisible(true);

    const nowMs = Math.floor((state.video?.currentTime || 0) * 1000);
    state.lastNowMs = nowMs;
    renderActiveCue(nowMs);
    await scheduleTranslations(nowMs);
  }

  async function startTimedTextFlow(track) {
    state.track = track;
    state.trackId = track?.baseUrl || track?.languageCode || 'track';
    console.log('AI Translator: startTimedTextFlow', {
      trackId: state.trackId,
      baseUrlSample: String(track?.baseUrl || '').slice(0, 80),
    });
    const cues = await fetchTimedText(track);
    state.cues = cues;
    console.log('AI Translator: cues loaded', {
      count: cues.length,
    });

    state.video = getVideoElement();
    if (state.video) {
      state.video.addEventListener('timeupdate', handleTimeUpdate);
      handleTimeUpdate();
    }
  }

  function ensureCaptionsReady(track) {
    if (!isCaptionsEnabled()) {
      console.log('AI Translator: captions disabled, waiting');
      if (!state.captionsPoll) {
        state.captionsPoll = setInterval(() => {
          if (isCaptionsEnabled()) {
            clearInterval(state.captionsPoll);
            state.captionsPoll = null;
            console.log('AI Translator: captions enabled, starting flow');
            ensureOverlay();
            startTimedTextFlow(track);
          }
        }, PREFETCH_INTERVAL_MS);
      }
      return;
    }

    console.log('AI Translator: captions enabled, starting flow');
    ensureOverlay();
    startTimedTextFlow(track);
  }

  function handleTracks(tracks) {
    if (state.track) return;
    console.log('AI Translator: handleTracks', {
      count: tracks?.length || 0,
    });
    const track = selectTrack(tracks);
    if (!track) return;

    state.track = track;
    const trackLang = getTrackLanguage(track);
    const targetLang = getTargetLanguageBase();
    console.log('AI Translator: track selected', {
      trackLang,
      targetLang,
      kind: track?.kind || '',
      isTranslatable: track?.isTranslatable,
      vssId: track?.vssId || '',
      hasSignatureCipher: !!track?.signatureCipher,
      hasBaseUrl: !!track?.baseUrl,
      baseUrlSample: String(track?.baseUrl || '').slice(0, 80),
    });

    if (trackLang && targetLang && trackLang === targetLang) {
      state.skipTranslation = true;
      console.log('AI Translator: skip translation, target equals track language');
      return;
    }

    ensureCaptionsReady(track);
  }

  function start() {
    if (state.active) return;
    state.active = true;
    resetState();
    requestCaptionTracks();
  }

  function handleYouTubeNavigation() {
    if (!state.active) return;
    resetState();
    requestCaptionTracks();
  }

  ctx.setupYouTubeCaptionTranslation = function() {
    console.log('AI Translator: setupYouTubeCaptionTranslation', {
      isYouTube: isYouTube(),
      enabled: !!ctx.settings?.enableYoutubeCaptionTranslation,
    });
    if (!isYouTube()) return;
    if (!ctx.settings?.enableYoutubeCaptionTranslation) return;
    start();
    window.addEventListener('yt-navigate-finish', handleYouTubeNavigation);
  };

  ctx.stopYouTubeCaptionTranslation = function() {
    window.removeEventListener('yt-navigate-finish', handleYouTubeNavigation);
    cleanup();
  };
})();
