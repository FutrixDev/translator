// Blab Translation Content Script Language Helpers
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const options = ctx.constants.TARGET_LANGUAGE_OPTIONS;

  // 「跟随浏览器」算哪门语言，唯一实现在 shared/target-lang.js —— service
  // worker 和设置页读的是同一份。这里曾经自己写过一份：直接返回
  // navigator.language 而不做映射，于是一个 fr-FR 的浏览器在这一侧得到
  // 'fr-FR'、在 worker 那一侧得到 'fr'。
  ctx.getEffectiveTargetLang = function() {
    return TargetLang.effective(ctx.settings);
  };

  // 「任意标签收进那十门里」也只有一个实现，和上面同一个主人。这里曾经自己写过
  // 一份前缀匹配，而它把所有认不出的 zh-* 都落成简体 —— 于是一个繁体页面长出
  // 「译成简体中文」。两份实现只要有一处不一样，同一次安装里两个界面就会对同一
  // 件事各说各话。
  ctx.normalizeTargetLang = function(lang) {
    return TargetLang.fromTag(lang);
  };

  ctx.getTargetLangLabel = function(lang) {
    const normalized = ctx.normalizeTargetLang(lang);
    const match = options.find((option) => option.value === normalized);
    return match ? match.label : normalized;
  };

  ctx.buildTargetLangMenu = function(selectedLang) {
    const normalized = ctx.normalizeTargetLang(selectedLang);
    return options.map((option) => {
      const isSelected = option.value === normalized ? ' is-selected' : '';
      return `<button class="ai-translator-lang-item${isSelected}" type="button" data-lang="${option.value}">${ctx.escapeHtml(option.label)}</button>`;
    }).join('');
  };

  // 语言标签的判定只有一个主人：shared/lang-tags.js。这里是转手，不是副本。
  // ctx.getLangBase 这个名字留着，是因为 content/page/batch.js 一族都按它取。
  ctx.getLangBase = globalThis.LangTags.getLangBase;
  ctx.isSameLanguage = globalThis.LangTags.isSameLanguage;
  ctx.refineScriptTag = globalThis.LangTags.refineScript;

  ctx.getLanguageDetectionText = function(text) {
    if (!text) return '';
    // 剥掉数学占位符 {{n}} 和内联格式标记 <a1>…</a1>，两者都不是正文，混进去
    // 会拉低语言检测的置信度。标记的定义在 content-page-translation.js
    // （ctx.MARKUP_MARKER_RE）；字面量兜底只为本文件先于它加载的窗口期。
    // 兜底必须和那边逐字一致（含 i：内置 NMT 会把标记大写成 <A1>），
    // markup-marker-regex.test.mjs 会比对两处源码。
    const cleaned = text
      .replace(/\{\{\d+\}\}/g, '')
      .replace(ctx.MARKUP_MARKER_RE || /<\/?[a-z]+\d+>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.slice(0, 400);
  };
})();
