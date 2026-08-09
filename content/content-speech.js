// AI Translator Content Script Speech
//
// One owner for read-aloud. Both translation surfaces — the selection popup and
// the input dialog — mount speaker buttons for the original text and for the
// translation, and every one of them is wired through `bindSpeakButton` here.
// Keeping the utterance, the play/stop toggle and the button's own label and
// pressed state in a single place is what stops the four buttons from drifting
// into four slightly different behaviours.
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // Chrome's speech engine stalls partway through very long utterances. These
  // buttons answer "how is this read", not "read me the article", so the text
  // is capped rather than risking a silent cut-off mid-sentence.
  const MAX_SPEAK_CHARS = 1000;

  // The glyph every speaker button carries. It lives here so the four buttons
  // cannot end up drawn from two slightly different SVGs.
  const SPEAKER_ICON = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 9v6h4l5 4V5L8 9H4z"/>
      <path d="M16 9a5 5 0 010 6"/>
      <path d="M19 7a8 8 0 010 10"/>
    </svg>
  `;

  // The button that owns the utterance currently playing, so a second click on
  // it stops playback instead of queueing another one, and so the pressed state
  // is cleared on whichever button set it.
  let activeButton = null;
  // Bumped by every stop and every new request: an async language detection that
  // resolves after its request was superseded checks this and bails.
  let requestToken = 0;

  function isSpeechAvailable() {
    return typeof window.speechSynthesis !== 'undefined'
      && typeof window.SpeechSynthesisUtterance === 'function';
  }

  function detectLang(text) {
    if (!chrome?.i18n?.detectLanguage) return Promise.resolve('');
    return new Promise((resolve) => {
      try {
        chrome.i18n.detectLanguage(text, (result) => {
          resolve(result?.languages?.[0]?.language || '');
        });
      } catch (error) {
        // detectLanguage throws once the extension context is invalidated;
        // an undeclared language still speaks, just in the default voice.
        resolve('');
      }
    });
  }

  function applyButtonState(button, speaking) {
    if (!button) return;
    button.classList.toggle('is-speaking', speaking);
    button.setAttribute('aria-pressed', speaking ? 'true' : 'false');
    const label = speaking
      ? button.dataset.speakStopLabel
      : button.dataset.speakLabel;
    if (label) {
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  }

  function stopSpeaking() {
    requestToken++;
    if (isSpeechAvailable()) {
      window.speechSynthesis.cancel();
    }
    applyButtonState(activeButton, false);
    activeButton = null;
  }

  /**
   * Speak `text`, cancelling whatever is already playing.
   * @param {string} text
   * @param {{lang?: string, button?: HTMLElement|null}} [options] `lang` is the
   *   BCP-47 tag to speak in; omit it to detect the language from the text.
   *   `button` makes the call a toggle — clicking the button that is already
   *   speaking stops it.
   * @returns {Promise<boolean>} whether an utterance was started.
   */
  async function speakText(text, options = {}) {
    if (!isSpeechAvailable()) return false;

    const { lang = '', button = null } = options;
    const trimmed = (typeof text === 'string' ? text : '').trim().slice(0, MAX_SPEAK_CHARS);
    const isStopClick = button !== null && button === activeButton;

    stopSpeaking();
    if (!trimmed || isStopClick) return false;

    const token = ++requestToken;
    const resolvedLang = lang || await detectLang(trimmed);
    if (token !== requestToken) return false;

    const utterance = new SpeechSynthesisUtterance(trimmed);
    if (resolvedLang) utterance.lang = resolvedLang;

    const finish = () => {
      if (token !== requestToken) return;
      applyButtonState(activeButton, false);
      activeButton = null;
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    activeButton = button;
    applyButtonState(button, true);
    window.speechSynthesis.speak(utterance);
    return true;
  }

  /**
   * Wire a speaker button and hand back the only supported way to show or hide
   * it. Callers must not set `hidden` themselves: routing it through the
   * returned setter is what keeps a browser without speech synthesis from ever
   * showing a button that could not do anything.
   *
   * @param {HTMLElement|null} button
   * @param {() => {text: string, lang?: string}} resolve read at click time, so
   *   the button always speaks the text on screen now, not the text that was
   *   there when it was bound.
   * @returns {(visible: boolean) => void}
   */
  function bindSpeakButton(button, resolve) {
    if (!button) return () => {};

    if (!isSpeechAvailable()) {
      button.hidden = true;
      return () => {};
    }

    button.dataset.speakLabel = button.getAttribute('aria-label') || button.title || ctx.t('pronounce');
    button.dataset.speakStopLabel = ctx.t('stopPronunciation');
    applyButtonState(button, false);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const payload = (typeof resolve === 'function' && resolve()) || {};
      speakText(payload.text, { lang: payload.lang, button });
    });

    return (visible) => {
      button.hidden = !visible;
      // A button that leaves the screen mid-utterance would otherwise keep
      // talking with no way left to stop it.
      if (!visible && activeButton === button) stopSpeaking();
    };
  }

  ctx.speech = {
    SPEAKER_ICON,
    isSpeechAvailable,
    speakText,
    stopSpeaking,
    bindSpeakButton,
  };
})();
