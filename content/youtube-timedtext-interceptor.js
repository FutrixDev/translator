// AI Translator — YouTube timedtext interceptor (runs in the page MAIN world).
//
// Why this exists: YouTube's /api/timedtext endpoint now requires a per-session
// Proof-of-Origin Token (`pot`). A URL scraped from ytInitialPlayerResponse lacks
// it, so fetching it directly returns HTTP 200 with an EMPTY body. The only
// request that succeeds is the one the player itself makes (it carries a valid
// `pot`). So instead of building our own request, we passively observe the
// player's own XHR/fetch to /api/timedtext and relay the response body to the
// isolated content script via window.postMessage.
(function() {
  'use strict';

  if (window.__aiTranslatorTimedtextInterceptor) return;
  window.__aiTranslatorTimedtextInterceptor = true;

  var buffer = [];
  var MAX_BUFFER = 8;

  function isTimedText(url) {
    return typeof url === 'string' && url.indexOf('/api/timedtext') !== -1;
  }

  function relay(entry) {
    try {
      window.postMessage({
        source: 'ai-translator',
        type: 'YT_TIMEDTEXT_CAPTURED',
        url: entry.url,
        text: entry.text,
        contentType: entry.contentType,
      }, '*');
    } catch (e) { /* noop */ }
  }

  function record(url, text, contentType) {
    if (!text) return;
    var entry = { url: url, text: text, contentType: contentType || '' };
    buffer.push(entry);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    relay(entry);
  }

  // Hook XMLHttpRequest — the player fetches timedtext via XHR.
  try {
    var XHR = window.XMLHttpRequest;
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function(method, url) {
      this.__aiTtUrl = url;
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function() {
      var xhr = this;
      if (isTimedText(xhr.__aiTtUrl)) {
        xhr.addEventListener('load', function() {
          try {
            if (xhr.status < 200 || xhr.status >= 300) return;
            var isText = xhr.responseType === '' || xhr.responseType === 'text';
            var text = isText ? (xhr.responseText || '') : '';
            if (!text && typeof xhr.response === 'string') text = xhr.response;
            var ct = '';
            try { ct = xhr.getResponseHeader('content-type') || ''; } catch (e) {}
            record(String(xhr.__aiTtUrl), text, ct);
          } catch (e) { /* noop */ }
        });
      }
      return origSend.apply(this, arguments);
    };
  } catch (e) { /* noop */ }

  // Hook fetch as a fallback (in case a player build switches to fetch).
  try {
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function(input) {
        var url = (input && typeof input === 'object' && input.url) ? input.url : String(input);
        var promise = origFetch.apply(this, arguments);
        if (isTimedText(url)) {
          promise.then(function(res) {
            try {
              if (!res || !res.ok) return;
              var ct = (res.headers && res.headers.get('content-type')) || '';
              res.clone().text().then(function(text) {
                record(url, text || '', ct);
              }).catch(function() {});
            } catch (e) { /* noop */ }
          }).catch(function() {});
        }
        return promise;
      };
    }
  } catch (e) { /* noop */ }

  // Replay buffered captions on request. Covers the case where the player
  // fetched captions (CC on by default) before the content script attached
  // its message listener.
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== 'ai-translator' || data.type !== 'YT_TIMEDTEXT_REPLAY') return;
    for (var i = 0; i < buffer.length; i++) relay(buffer[i]);
  });

  // Drop stale captions when navigating to another video within the SPA.
  window.addEventListener('yt-navigate-start', function() { buffer = []; });
})();
