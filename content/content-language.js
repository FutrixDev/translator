// AI Translator Content Script Language Helpers
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const options = ctx.constants.TARGET_LANGUAGE_OPTIONS;

  ctx.getEffectiveTargetLang = function() {
    if (ctx.settings.targetLang) return ctx.settings.targetLang;
    return navigator.language || navigator.userLanguage || 'en';
  };

  ctx.normalizeTargetLang = function(lang) {
    if (!lang) return 'en';
    if (options.some((option) => option.value === lang)) {
      return lang;
    }
    const base = lang.split('-')[0];
    const baseMatch = options.find((option) => option.value === base);
    if (baseMatch) return baseMatch.value;
    if (base === 'zh') return 'zh-CN';
    return 'en';
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

  ctx.getLangBase = function(lang) {
    if (!lang) return '';
    return lang.split('-')[0].toLowerCase();
  };

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
