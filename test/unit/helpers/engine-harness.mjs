// Enough of a browser for the engine family (content/engine/*.js and
// content/content-translation-engine.js) to install itself and run in Node.
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
 *
 * `url` is the page the engine thinks it is on: the AI exit asks
 * SiteRules.register() about `location` for the prompt addenda (R33 A4).
 * `location` stays writable so a test can move the page afterwards.
 */
export async function installEngineHarness({ pageText, url = 'https://example.test/' }) {
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
      // 真扩展里 bootstrap 先把 CONTENT_DEFAULTS 放在 ctx.settings 上；附加说明
      // （content/engine/addenda.js）每次发 AI 都读这两项，缺了就是缺陷、会抛。
      settings: { promptDomain: 'general', aiPageContext: false },
      // content/page/custom-rule.js 在真扩展里装它；附加说明每次都问本站规则钉住
      // 的领域，这里没有规则。
      customRules: {
        domain: () => null, engineOverride: () => null, profileOverride: () => null, whenReady: async () => {},
      },
      // content-bootstrap.js 装的取文案函数；这里原样回键名，断言按键名比。
      t: (key) => key,
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
  Object.defineProperty(globalThis, 'location', {
    value: new URL(url),
    configurable: true,
    writable: true,
  });
  globalThis.chrome = {
    i18n: { detectLanguage: async (sample) => detectLanguage(sample) },
    storage: {
      sync: { get: async () => ({ apiKey: state.apiKey }) },
      onChanged: { addListener() {} },
    },
    runtime: {
      sendMessage: async (message) => {
        sentToAI.push(message);
        return { translation: `AI:${message.text}` };
      },
    },
  };

  // The engine narrates every fallback; assertions do the talking here.
  console.info = () => {};
  console.warn = () => {};

  // manifest 里 shared/lang-tags.js 和 shared/target-lang.js 都排在引擎前面，
  // 引擎加载时就取走它们。夹具漏掉任何一个，引擎整个文件抛错——而抛错的模块
  // import 照样 resolve，于是 ctx 上什么都没有，红在三步之后。
  // shared/api-compat.js 也排在引擎前面：回落前问「AI 接口配好没有」的那条规则
  // （APICompat.isApiKeyMissing）住在那里。
  await import('../../../shared/api-compat.js');
  await import('../../../shared/lang-tags.js');
  await import('../../../shared/target-lang.js');
  // 发给模型的出口问 SiteRules.register() 这一页的语域（R33 A4）；site-rules.js
  // 加载时取走内置表和 StorageWriter，manifest 里三者都排在引擎前面。
  await import('../../../shared/site-rules-builtin.js');
  await import('../../../shared/storage-writer.js');
  await import('../../../shared/site-rules.js');
  // shared/text-markers.js 同样排在引擎前面：占位符的语法（keepsPlaceholders 取编号）住在那里。
  await import('../../../shared/text-markers.js');
  await import('../../../content/engine/languages.js');
  await import('../../../content/engine/watchdog.js');
  // 词表快照与附加说明（P1-C）。夹具没有 ctx.glossary，快照恒为空；切份读
  // PromptAddenda.LIMITS、缓存键读 stamp()，manifest 里 shared/prompt-addenda.js
  // 排在引擎前面。
  await import('../../../shared/prompt-addenda.js');
  // AI 配置档（P1-D）：真扩展里 content/content-ai-profiles.js 建镜像（它自己的单测
  // 在 content-ai-profiles.test.mjs）；这里换成同步的替身，setApiKey 立刻生效。选档
  // 走真的 AIProfiles.resolve —— 请求没标 feature 就照样抛。
  await import('../../../shared/sync-collection.js');
  await import('../../../shared/ai-profiles.js');
  const endpoint = 'https://api.openai.com/v1/chat/completions';
  const entries = () => [{
    id: globalThis.AIProfiles.LEGACY_ID, name: 'Legacy', provider: 'openai', apiEndpoint: endpoint,
    modelName: 'gpt-4.1-mini', features: [], default: true,
    keyMissing: globalThis.APICompat.isApiKeyMissing({ provider: 'openai', apiEndpoint: endpoint, apiKey: state.apiKey }),
  }];
  const ctx = globalThis.window.AI_TRANSLATOR_CONTENT;
  ctx.aiProfiles = {
    whenReady: async () => {},
    status: () => 'ready',
    resolve: (feature) => globalThis.AIProfiles.resolve(entries(),
      { feature, ruleProfileId: ctx.customRules.profileOverride() }),
    ready(feature) {
      const resolved = ctx.aiProfiles.resolve(feature);
      return Boolean(resolved.profile) && !resolved.profile.keyMissing;
    },
    subscribe: () => () => {},
  };
  await import('../../../content/engine/glossary.js');
  await import('../../../content/engine/addenda.js');
  await import('../../../content/content-translation-engine.js');
  await import('../../../content/engine/probe.js');

  return {
    ctx: globalThis.window.AI_TRANSLATOR_CONTENT,
    translateCalls,
    sentToAI,
    setApiKey(key) { state.apiKey = key; },
  };
}
