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

  // 最近用过的目标语，在请求发出时记下：对话框与划词卡片共用一份，最近在前、
  // 最多 5 个，只存规范码。每次派发翻译就记它的目标语，默认语也记；只点菜单不记——
  // 卡片点了必重译，对话框有字才译，没译的点选不算用过。两条派发路（输入框对话框的
  // translateInputText、划词卡片的 translateText，OCR 的翻译也走后者）共用的下一步是
  // ctx.dictRoute，但写入不放进它：dictRoute 只是无副作用的路由（问离线词典还是发请求），
  // 放进去就成了藏起来的写；所以两处各显式调一次这里。放 local 不放 sync：这是一台
  // 设备的习惯。sync 的默认目标语改了也不清空：默认语变了不等于常用语变了（与对话框的
  // inputDialogTargetLang 不同）。
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
  // 标记只进 data-tag，由 popup.css 的 ::after 画出来：content-popup.js 选中时把
  // item.textContent 当标签，写进文字就会跟着进标签。
  //
  // 菜单总是两组：先「最近使用」（data-recent="1"），再「全部语言」全表；全表不剔除最近
  // 项，按字母找的人照样找得到。最近项是全表选项的子集引用，不是第二份语言清单：存储里
  // 认不出的码直接不出。一个认得出的记录都没有时，最近组只放当前语言——只是显示，不写
  // 存储，所以第一次打开就看得到这一组在哪。
  //
  // 两组上面是一个筛选框（.ai-translator-lang-filter），菜单底下是一句「没有匹配的
  // 语言」（.ai-translator-lang-empty，平时藏着）。返回这一次画出来的菜单的控制器
  // （langMenu）：筛选、看得见的选项、当前项与方向键/回车都归它。打开、关上、焦点
  // 回到哪里归打开菜单的那一处（content-popup.js 的 setupLanguageDropdown，划词卡与
  // 输入框对话框共用），它每次打开都重画一次，拿到新的控制器。
  ctx.buildTargetLangMenu = function(menu, selectedLang) {
    const normalized = ctx.normalizeTargetLang(selectedLang);
    const bt = ctx.builtinTranslator;
    const tagAiOnly = bt.isSelected(false);
    const aiOnlyTag = ctx.escapeHtml(ctx.t('langAiOnly'));
    const item = (option, recent) => {
      const isSelected = option.value === normalized ? ' is-selected' : '';
      const tag = tagAiOnly && !bt.supportsTarget(option.value)
        ? ` data-tag="${aiOnlyTag}"`
        : '';
      const mark = recent ? ' data-recent="1"' : '';
      return `<button class="ai-translator-lang-item${isSelected}" type="button" data-lang="${option.value}"${mark}${tag}>${ctx.escapeHtml(option.label)}</button>`;
    };
    const options = TargetLang.options(ctx.uiLanguage());
    const all = options.map((option) => item(option, false)).join('');
    const known = (codes) => codes
      .map((code) => options.find((option) => option.value === code))
      .filter(Boolean);
    const stored = known(recentPref.get());
    const recent = stored.length ? stored : known([normalized]);
    const group = (key, which) =>
      `<div class="ai-translator-lang-group" role="presentation" data-group="${which}">${ctx.escapeHtml(ctx.t(key))}</div>`;
    const filterLabel = ctx.escapeHtml(ctx.t('langFilter'));
    menu.innerHTML = `<input class="ai-translator-lang-filter" type="text" placeholder="${filterLabel}" aria-label="${filterLabel}" autocomplete="off" spellcheck="false">`
      + group('langRecent', 'recent')
      + recent.map((option) => item(option, true)).join('')
      + group('langAll', 'all')
      + all
      + `<div class="ai-translator-lang-empty" role="status" hidden>${ctx.escapeHtml(ctx.t('langNoMatch'))}</div>`;
    return langMenu(menu, options.map(matchNames));
  };

  // 一门语言能用哪些名字找到：界面语言下的名字（菜单上写的那个）、英文名、它自己的
  // 名字（日本語）、语言码。英文名和自称与界面语言无关，算一次记下。全部小写，
  // 筛选时拿小写的查询去比。
  const fixedNames = new Map();
  function matchNames(option) {
    let fixed = fixedNames.get(option.value);
    if (!fixed) {
      fixed = [TargetLang.nameOf(option.value, 'en'), TargetLang.autonym(option.value), option.value];
      fixedNames.set(option.value, fixed);
    }
    return [...new Set([option.label, ...fixed].map((name) => name.toLocaleLowerCase()))];
  }

  // 查询和一门语言的名字有多贴：0 某个名字就是它（ja、日本語），1 某个名字以它开头，
  // 2 名字里某个词以它开头（Chinese (Traditional) 里的 trad），3 只是包含它；
  // -1 对不上。「ja」要先给日语，不能按字母序先给 Azerbaijani。
  function matchRank(names, query) {
    if (names.includes(query)) return 0;
    if (names.some((name) => name.startsWith(query))) return 1;
    if (names.some((name) => name.split(/[\s()\-]+/).some((word) => word.startsWith(query)))) return 2;
    if (names.some((name) => name.includes(query))) return 3;
    return -1;
  }

  // 菜单里两类节点的选择器，打开菜单的那一处（content-popup.js）也按它们认节点。
  const ITEM = '.ai-translator-lang-item';
  const FILTER = '.ai-translator-lang-filter';
  ctx.LANG_MENU_SELECTORS = Object.freeze({ ITEM, FILTER });

  // 一次画出来的菜单的控制器。`names[i]` 是全表第 i 项的名字（与画出来的顺序一致）。
  // 节点只在第一次用到时去找：只想看画出了什么的人（单测）不必有一棵 DOM。
  //
  // 筛选不挪节点：全表项按贴合度写 CSS order（菜单是一列 flex，见 popup.css），清空
  // 查询就把 order 去掉，回到画出来的顺序。有查询时只在全表里找、每门语言只出一次：
  // 最近组是全表的重复，连标题一起藏起；同一档保持原序。一项都没有时露出「没有匹配
  // 的语言」，「全部语言」的标题也藏起。
  //
  // 当前项（is-active）是上下键挑到的那一项：没有当前项时向下从第一项起、向上从最后
  // 一项起，到头就停。筛选框里的回车选当前项，没有就选第一个看得见的；Tab 聚焦到某一项
  // 上按的回车不归它：那是按下这个按钮，浏览器照常点它，选的就是它。
  function langMenu(menu, names) {
    let dom = null;
    const nodes = () => dom || (dom = {
      filter: menu.querySelector(FILTER),
      empty: menu.querySelector('.ai-translator-lang-empty'),
      recentGroup: menu.querySelector('.ai-translator-lang-group[data-group="recent"]'),
      allGroup: menu.querySelector('.ai-translator-lang-group[data-group="all"]'),
      recent: [...menu.querySelectorAll(`${ITEM}[data-recent]`)],
      full: [...menu.querySelectorAll(`${ITEM}:not([data-recent])`)],
    });
    // 有查询时按显示顺序排好的匹配项；没有查询时为 null，看得见的就是画出来的全部。
    let matches = null;
    let active = null;

    // 只动菜单自己的 scrollTop，不用 scrollIntoView（那会连宿主页面一起滚）。筛选框粘在
    // 菜单顶上，被它挡住的那一截不算露出来：看得见的一段从筛选框底边到菜单可视区底边，
    // 都按屏幕上量到的位置算。
    const keepInView = (item) => {
      const box = item.getBoundingClientRect();
      const top = nodes().filter.getBoundingClientRect().bottom;
      const bottom = menu.getBoundingClientRect().top + menu.clientTop + menu.clientHeight;
      if (box.top < top) menu.scrollTop -= top - box.top;
      else if (box.bottom > bottom) menu.scrollTop += box.bottom - bottom;
    };
    const setActive = (item) => {
      if (active) active.classList.remove('is-active');
      active = item;
      if (item) {
        item.classList.add('is-active');
        keepInView(item);
      }
    };
    const visibleItems = () => matches || [...nodes().recent, ...nodes().full];

    return {
      visibleItems,
      focus() {
        nodes().filter.focus({ preventScroll: true });
      },
      filter(rawQuery) {
        const query = String(rawQuery || '').trim().toLocaleLowerCase();
        const { full, recent, recentGroup, allGroup, empty } = nodes();
        const ranked = full.map((el, order) => ({ el, order, rank: query ? matchRank(names[order], query) : 0 }));
        matches = query
          ? ranked.filter((entry) => entry.rank >= 0)
            .sort((a, b) => a.rank - b.rank || a.order - b.order)
            .map((entry) => entry.el)
          : null;
        for (const { el, rank } of ranked) el.hidden = rank < 0;
        if (matches) matches.forEach((el, at) => { el.style.order = String(at + 1); });
        else for (const el of full) el.style.removeProperty('order');
        for (const el of recent) el.hidden = !!query;
        recentGroup.hidden = !!query;
        allGroup.hidden = !!matches && !matches.length;
        empty.hidden = !matches || matches.length > 0;
        menu.scrollTop = 0;
        setActive(matches ? matches[0] || null : null);
      },
      // 方向键，和筛选框里（`target` 是按键落在的节点）的回车；别的键不归它，返回 false。
      handleKey(key, target) {
        const shown = visibleItems();
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          const at = shown.indexOf(active);
          const step = key === 'ArrowDown' ? 1 : -1;
          const next = at < 0 ? (step > 0 ? 0 : shown.length - 1) : Math.min(Math.max(at + step, 0), shown.length - 1);
          setActive(shown[next] || null);
          return true;
        }
        if (key === 'Enter' && target === nodes().filter) {
          const pick = shown.includes(active) ? active : shown[0];
          if (pick) pick.click();
          return true;
        }
        return false;
      },
    };
  }

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
