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

  // 「任意标签收进那 78 门里」也只有一个实现，和上面同一个主人。这里曾经自己写过
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

  // 最近用过的目标语，在请求发出时记下：对话框与划词卡片共用一份，最近在前、
  // 最多 5 个，只存规范码。每次派发翻译就记它的目标语，默认语也记；只点菜单不记——
  // 卡片点了必重译，对话框有字才译，没译的点选不算用过。两条派发路（输入框对话框的
  // translateInputText、划词卡片的 translateText，OCR 的翻译也走后者）共用的下一步是
  // ctx.dictRoute，但写入不放进它：dictRoute 只是无副作用的路由（问离线词典还是发请求），
  // 放进去就成了藏起来的写；所以两处各显式调一次这里。放 local 不放 sync：这是一台
  // 设备的习惯。sync 的默认目标语改了也不清空：默认语变了不等于常用语变了（与对话框的
  // inputTargetLang 不同）。
  // 读、settled、初读落地前的排队、跟随别的标签（或这一页的别的 frame）都归
  // ctx.localPref（content/content-local-pref.js）；规范化、去重和上限归这里。
  const MAX_RECENT_TARGET_LANGS = 5;

  function recentFrom(value) {
    return Array.isArray(value) ? value.filter((code) => typeof code === 'string' && code) : [];
  }

  const recentPref = ctx.localPref('recentTargetLangs', { parse: recentFrom });

  ctx.recentTargetLangs = function() {
    return recentPref.get().slice();
  };

  // 新表要在存储里那张表上建：用 update 而不是 get + set，初读没落地时排队等它。
  ctx.rememberRecentTargetLang = function(lang) {
    if (!lang) return;
    const code = ctx.normalizeTargetLang(lang);
    recentPref.update((list) => [code, ...list.filter((other) => other !== code)]
      .slice(0, MAX_RECENT_TARGET_LANGS));
  };

  // 这个菜单属于手动翻译（输入框对话框、划词卡），所以问的是手动引擎：它是内置时，
  // 端上译不了的语言标「仅 AI」—— 和引擎抛 UNSUPPORTED_PAIR 用的是同一个谓词。
  // 菜单怎么画、怎么筛归 shared/lang-picker.js（设置页、工具栏弹窗用的也是它）；
  // 这里只给出这一侧的输入：最近用过的、手动引擎、界面语言和文案。
  ctx.buildTargetLangMenu = function(menu, selectedLang) {
    const bt = ctx.builtinTranslator;
    return LangPicker.renderMenu(menu, {
      selected: ctx.normalizeTargetLang(selectedLang),
      uiLang: ctx.uiLanguage(),
      recent: recentPref.get(),
      aiOnly: bt.isSelected(false) ? (code) => !bt.supportsTarget(code) : null,
      labels: {
        filter: ctx.t('langFilter'),
        recent: ctx.t('langRecent'),
        all: ctx.t('langAll'),
        noMatch: ctx.t('langNoMatch'),
        aiOnly: ctx.t('langAiOnly'),
      },
    });
  };

  // 我们放进页面的每一段文字都带上自己的 lang / dir（TargetLang.mark）：译文常常挂在
  // 一个方向相反的原文块里，靠继承就继承到了原文的方向。
  ctx.markLanguage = TargetLang.mark;

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

  // 语言标签的判定只有一个主人：shared/lang-tags.js。这里是转手，不是副本。
  // ctx.getLangBase 这个名字留着，是因为 content/page/batch.js 一族都按它取。
  ctx.getLangBase = globalThis.LangTags.getLangBase;
  ctx.isSameLanguage = globalThis.LangTags.isSameLanguage;
  ctx.refineScriptTag = globalThis.LangTags.refineScript;

  // maxChars：默认 400，够检测器定一门语言。整页翻译判「这一段是不是已经是目标
  // 语言」时要看完整一段（content/page/batch.js）：只看开头，后半段成句的外文就
  // 被前半段的母语带着一起跳过了。
  ctx.getLanguageDetectionText = function(text, maxChars = 400) {
    if (!text) return '';
    // 剥掉数学占位符 {{n}} 和内联格式标记 <a1>…</a1>，两者都不是正文，混进去
    // 会拉低语言检测的置信度。两者的语法在 shared/text-markers.js。
    const cleaned = globalThis.TextMarkers.strip(text)
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.slice(0, maxChars);
  };
})();
