// Enough of a browser for content/content-translation-engine.js to install
// itself and run in Node.
//
// The engine caches the page's language for the life of the document, so a
// test file gets exactly one page language. Anything that needs a different
// one needs its own file — `node --test` gives each file its own process.
//
// Not used by builtin-translator-stall.test.mjs, which has its own harness
// wired for the download/stall clock.

// What headless Chrome's chrome.i18n.detectLanguage actually answers. Every
// one of these comes back isReliable=false: CJK is named correctly from a
// couple of characters, and short Latin input is nonsense.
const LATIN_MISREADS = { hello: 'sr', animation: 'ja', Bonjour: 'no', ok: 'pl' };

export function detectLanguage(sample) {
  const text = String(sample || '');
  if (/[一-鿿]/.test(text)) {
    return { isReliable: text.length >= 40, languages: [{ language: 'zh', percentage: 100 }] };
  }
  if (/[ぁ-ゟ゠-ヿ]/.test(text)) {
    return { isReliable: false, languages: [{ language: 'ja', percentage: 100 }] };
  }
  if (!/[a-z]/i.test(text)) return { isReliable: false, languages: [] };
  // Only a page-sized Latin sample is vouched for; short ones get CLD's real,
  // wrong answers.
  if (text.length >= 40) return { isReliable: true, languages: [{ language: 'en', percentage: 99 }] };
  return { isReliable: false, languages: [{ language: LATIN_MISREADS[text.trim()] || 'ja', percentage: 100 }] };
}

/**
 * Install the fakes and load the engine. Must be awaited before anything
 * touches `ctx`, and called once per process.
 */
export async function installEngineHarness({ pageText }) {
  const translateCalls = [];
  const sentToAI = [];
  const state = { apiKey: '' };

  globalThis.self = {
    isSecureContext: true,
    Translator: {
      availability: async () => 'available',
      create: async ({ sourceLanguage, targetLanguage }) => ({
        translate: async (text) => {
          translateCalls.push({ sourceLanguage, targetLanguage, text });
          return `builtin(${sourceLanguage}->${targetLanguage}):${text}`;
        },
        destroy() {},
      }),
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { userActivation: { isActive: true } },
    configurable: true,
    writable: true,
  });
  globalThis.window = {
    AI_TRANSLATOR_CONTENT: {
      // content/content-language.js installs this in the real extension; the
      // engine reads it to build the detection sample.
      getLanguageDetectionText(text) {
        if (!text) return '';
        return text.replace(/\{\{\d+\}\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 400);
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window.top = globalThis.window;
  globalThis.document = { body: { innerText: pageText } };
  globalThis.chrome = {
    i18n: { detectLanguage: async (sample) => detectLanguage(sample) },
    storage: {
      sync: { get: async () => ({ apiKey: state.apiKey }) },
      onChanged: { addListener() {} },
    },
    runtime: {
      sendMessage: async (message) => {
        sentToAI.push(message);
        return { translation: `AI:${message.text}`, phonetic: '', isWord: false };
      },
    },
  };

  // The engine narrates every fallback; assertions do the talking here.
  console.info = () => {};
  console.warn = () => {};

  await import('../../../content/content-translation-engine.js');

  return {
    ctx: globalThis.window.AI_TRANSLATOR_CONTENT,
    translateCalls,
    sentToAI,
    setApiKey(key) { state.apiKey = key; },
  };
}
