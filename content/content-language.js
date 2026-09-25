// Blab Translation Content Script Language Helpers
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // 「跟随浏览器」算哪门语言，唯一实现在 shared/target-lang.js —— service
  // worker 和设置页读的是同一份。这里曾经自己写过一份：直接返回
  // navigator.language 而不做映射，于是一个 fr-FR 的浏览器在这一侧得到
  // 'fr-FR'、在 worker 那一侧得到 'fr'。
  ctx.getEffectiveTargetLang = function() {
    return TargetLang.effective(ctx.settings);
  };

  // 「任意标签收进那 76 门里」也只有一个实现，和上面同一个主人。这里曾经自己写过
  // 一份前缀匹配，而它把所有认不出的 zh-* 都落成简体 —— 于是一个繁体页面长出
  // 「译成简体中文」。两份实现只要有一处不一样，同一次安装里两个界面就会对同一
  // 件事各说各话。
  ctx.normalizeTargetLang = function(lang) {
    return TargetLang.fromTag(lang);
  };

  // 语言名在界面语言下由 Intl 现算（shared/target-lang.js）。默认是菜单形（独立
  // 出现的名字，句首大写）；填进句子里的 {lang} 要传 { inSentence: true }，
  // fr 下是「Traduire en persan」而不是「en Persan」。
  ctx.languageName = function(code, opts) {
    return TargetLang.nameOf(code, ctx.uiLanguage(), opts);
  };

  ctx.getTargetLangLabel = function(lang) {
    return ctx.languageName(ctx.normalizeTargetLang(lang));
  };

  // 这个菜单属于手动翻译（输入框对话框、划词卡），所以问的是手动引擎：它是内置时，
  // 端上译不了的语言标「仅 AI」—— 和引擎抛 UNSUPPORTED_PAIR 用的是同一个谓词。
  // 标记只进 data-tag，由 popup.css 的 ::after 画出来：content-popup.js 选中时把
  // item.textContent 当标签，写进文字就会跟着进标签。
  ctx.buildTargetLangMenu = function(selectedLang) {
    const normalized = ctx.normalizeTargetLang(selectedLang);
    const bt = ctx.builtinTranslator;
    const tagAiOnly = bt.isSelected(false);
    const aiOnlyTag = ctx.escapeHtml(ctx.t('langAiOnly'));
    return TargetLang.options(ctx.uiLanguage()).map((option) => {
      const isSelected = option.value === normalized ? ' is-selected' : '';
      const tag = tagAiOnly && !bt.supportsLang(bt.toApiLang(option.value))
        ? ` data-tag="${aiOnlyTag}"`
        : '';
      return `<button class="ai-translator-lang-item${isSelected}" type="button" data-lang="${option.value}"${tag}>${ctx.escapeHtml(option.label)}</button>`;
    }).join('');
  };

  // 我们放进页面的每一段文字都带上自己的 lang / dir：屏读按 lang 选语音、浏览器按
  // lang 选字形，dir 决定标点和换行往哪边走。LTR 也明写 —— 译文常常挂在一个方向
  // 相反的原文块里，靠继承就继承到了原文的方向。
  ctx.markLanguage = function(el, code) {
    el.lang = code;
    el.dir = TargetLang.direction(code);
  };

  // 原文方向的起始边：LTR 是左，RTL 是右。缩进和行内译文的间隙都开在这一边。
  ctx.startSide = function(style) {
    return style.direction === 'rtl' ? 'right' : 'left';
  };

  // 译文照抄原文的对齐，只在两边方向一致时成立。方向相反时，除了居中和两端对齐，
  // 一律靠译文自己的起始边：原文靠起始边时这是对的；原文靠结束边时（LTR 页里右对齐
  // 的数字列），那个物理位置恰好就是异向译文的起始边。把 left/right 逻辑对调反而
  // 会把那一列的阿拉伯语译文压到错的一边。
  ctx.translationTextAlign = function(sourceStyle, dir) {
    const align = sourceStyle.textAlign;
    if (sourceStyle.direction === dir) return align;
    if (align === 'center' || align === '-webkit-center') return 'center';
    if (align === 'justify') return 'justify';
    return 'start';
  };

  // 原文前面有图标之类的前置元素时，译文让出同样的缩进，和原文文字对齐。量和写都在
  // 原文的起始边：缩进说的是「原文文字所在的那条带」，与译文的方向无关。
  ctx.applyTextInset = function(translationEl, sourceEl, options) {
    const px = ctx.getTextInset(sourceEl, options);
    if (px > 0) {
      const side = ctx.startSide(window.getComputedStyle(sourceEl));
      translationEl.style.setProperty(`padding-${side}`, `${px}px`, 'important');
    }
  };

  // 76 项的菜单打开时，已选项多半在视口外。只动菜单自己的 scrollTop，把它放到可见区
  // 中部；不用 scrollIntoView，那会连宿主页面一起滚。
  ctx.revealSelectedLanguage = function(menu) {
    const item = menu.querySelector('.is-selected');
    if (!item) return;
    const menuTop = menu.getBoundingClientRect().top + menu.clientTop;
    const itemRect = item.getBoundingClientRect();
    menu.scrollTop += itemRect.top - menuTop - (menu.clientHeight - itemRect.height) / 2;
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
