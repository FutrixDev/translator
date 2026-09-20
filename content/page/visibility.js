// Blab Translation — 整页翻译：原文的显隐
//
// 译文插好之后，原文该不该继续占位：仅显示译文模式、放不下时的挤压豁免，
// 以及“隐藏译文”开关关掉后把译文重新放出来。
// 只认已经落笔的那对 DOM，不参与收集也不参与翻译。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const { settings, state } = ctx;

  // 「整页翻译的译文」是什么，**只有这一条说了算**。悬停和划词的译文块用的是同一
  // 个 .ai-translator-inline-block 类名，只多带一个自己的类名，所以少写一个
  // :not() 就会把用户划词译的那一句算成整页翻译的一部分 —— 于是 Alt+A 第一下不是
  // 翻译整页，是把那一句藏起来。
  //
  // 这个文件里三处用到它，三处都必须是同一条：显隐开关、「仅显示译文」的逐条计算，
  // 以及 content-page-translation.js 问的「这一页翻过了没有」。
  const PAGE_TRANSLATION_SELECTOR =
    '.ai-translator-inline-block:not(.ai-translator-selection-translation):not(.ai-translator-hover-translation)';

  /**
   * 「此刻想不想看译文」——**这个开关只有这一处实现**。
   *
   * 入口有四个：悬浮球单击、悬浮球菜单里的显示/隐藏、popup 的那一行、以及
   * 「翻译整页」顺手把藏起来的放出来。四处各写一遍的代价不是重复，是漏项：
   * 忘了受管容器那批（它们是原文块的 ::after，在下面那串里只有一个不显示的
   * 替身），或者忘了通知自动翻译——用户一边藏译文，新译文一边冒出来。
   */
  function setTranslationsVisible(visible) {
    // 无条件置位。这个标记是「用户此刻想不想看译文」唯一的出处，自动翻译那一层
    // （content/content-auto-translate.js 的 start()）也读它 —— 只在「确实藏着
    // 东西」时才置位的话，在一个还没有译文的页面上藏一次、再点「翻译整页」，标记
    // 就永远停在 false，自动翻译从此不会再醒。
    state.translationsVisible = visible;
    // 只管整页翻译那一批。划词和悬停译出来的是**一次性**的结果：用户刚刚指着一句
    // 话说「这句什么意思」，答案不该被一个管着整页的开关收走。而且那条插入路径
    // （content-hover-translation.js）根本不读这个标记 —— 藏旧的、不藏新的，用户
    // 看到的就是这个开关时灵时不灵。一次性的结果由它自己那条路收（点别处、Esc）。
    document.querySelectorAll(PAGE_TRANSLATION_SELECTOR).forEach((el) => {
      el.classList.toggle('ai-translator-hidden', !visible);
    });
    // 受管容器里的译文整体开关（见 content-managed-translation.js）：它没有自己
    // 的节点可以加类名，只能整体开关。幂等，所以不必先问它现在是什么状态。
    if (ctx.setManagedTranslationsVisible) ctx.setManagedTranslationsVisible(visible);
    // “仅显示译文”与本开关联动：译文被藏起来时必须把原文放回来，否则页面两边
    // 都不显示；译文重新显示时再把原文藏回去。
    applyTranslationOnlyMode();
    // 「显示原文」就是「我现在想看原文」。自动翻译要是继续往下翻，用户一边藏
    // 译文、一边有新译文冒出来 —— 那个开关就成了摆设。
    if (ctx.autoTranslate) {
      if (visible) ctx.autoTranslate.resumeCurrentPage();
      else ctx.autoTranslate.pauseCurrentPage();
    }
  }

  function revealHiddenTranslations() {
    setTranslationsVisible(true);
  }

  /**
   * 刚插进来的这一条译文，跟上当前的显隐状态。
   *
   * setTranslationsVisible() 只管得到调用那一刻已经在 DOM 里的块。用户在一轮翻译
   * 跑到一半时点了「显示原文」，后面几批插进来的译文得自己知道现在是藏着的 ——
   * 否则他一边藏，译文一边冒出来，那个开关就成了摆设。
   *
   * 受管译文（::after 那一路）不走这里：它们的显隐是根元素上的一个属性，整体
   * 开关，新画出来的天然就跟着。
   */
  function applyTranslationVisibility(translationEl) {
    if (!translationEl || !translationEl.classList) return;
    translationEl.classList.toggle('ai-translator-hidden', state.translationsVisible === false);
  }

  // ==================== 隐藏原文 ====================
  // 隐藏一条译文对应的原文，有两个互不相干的理由：
  //
  //   1. settings.showTranslationOnly（默认关）——用户要的，全页一刀切。
  //   2. 这一块挤不下两种语言（content-fit-guard.js 判的）——页面逼的，逐块决定。
  //      译文节点上带 data-ai-translator-crowded 标记。
  //
  // 两个理由共用一套隐藏/释放机制，但**该不该藏是逐条算的**，不能再看一个全局开关：
  // 「仅显示译文」关掉时，crowded 那批必须继续藏着，否则挤不下的那些块又糊回去。
  // 只作用于整页翻译（.ai-translator-translated 标记的块）；悬停/划词翻译的
  // 译文块（带各自的类名）被明确排除。
  const CROWDED_ATTR = 'data-ai-translator-crowded';

  function shouldHideSource(translationEl) {
    // 浮球“隐藏译文”开关优先：译文都不显示了还藏着原文，页面就两边全空了
    if (state.translationsVisible === false) return false;
    if (settings.showTranslationOnly) return true;
    return translationEl.hasAttribute(CROWDED_ATTR);
  }

  function isTranslationOnlyActive() {
    return !!settings.showTranslationOnly && state.translationsVisible !== false;
  }

  // 隐藏一条译文对应的原文：
  // - 译文是原文块的兄弟节点（常规段落）→ 给原文块加 hidden 类
  // - 译文插在原文块内部（水平 flex / 表格单元格 / slot）→ 把译文之前的子节点
  //   包进一个 wrap 再隐藏。wrap 在模式关闭时原样解包（见 applyTranslationOnlyMode），
  //   不给页面留下多余结构。
  // 已知局限：wrap 会移动页面自己的节点。框架（React/Vue）重渲染被 wrap 的
  // 子树时可能因找不到原父节点而报错。隔离世界里看不到页面世界的
  // __reactFiber$ 等 expando，无法预检测；本模式默认关、由用户显式打开，
  // 遇到这类页面关掉开关即可完整恢复。
  // @param {{safeOnly?: boolean}} [options] safeOnly：只走加类名那条路，不碰 wrap。
  //   crowded 隐藏是默认行为（用户没打开任何开关），不能顺带把搬节点的风险也变成
  //   默认——包不进去就让 fit guard 撤译文，那条路一个页面节点都不动。
  // @returns {boolean} 原文是否藏起来了
  function hideSourceForTranslation(translationEl, options) {
    const prev = translationEl.previousElementSibling;
    if (prev && prev.classList && prev.classList.contains('ai-translator-translated')) {
      prev.classList.add('ai-translator-source-hidden');
      return true;
    }
    if (options && options.safeOnly) return false;

    const holder = translationEl.parentElement;
    const host = holder && holder.closest('.ai-translator-translated');
    if (!host) return false;
    // 受管容器：译文是原文块自己的 ::after，隐藏原文会连译文一起消失，只能共存
    if (ctx.isInsideManagedDomRoot && ctx.isInsideManagedDomRoot(host)) return false;

    let wrap = holder.querySelector(':scope > .ai-translator-source-wrap');
    for (const node of Array.from(holder.childNodes)) {
      // 译文之后的节点不动：插译文时原文全在它前面，之后出现的是页面新加的
      // 内容，收进 wrap 会在解包时把它挪到译文前面，改变页面自己的顺序。
      if (node === translationEl) break;
      if (node.nodeType === Node.ELEMENT_NODE &&
          (node.classList.contains('ai-translator-inline-block') ||
           node.classList.contains('ai-translator-source-wrap'))) continue;
      if (!wrap) {
        wrap = document.createElement('span');
        wrap.className = 'ai-translator-source-wrap';
        holder.insertBefore(wrap, node);
      }
      wrap.appendChild(node);
    }
    if (wrap) wrap.classList.add('ai-translator-source-hidden');
    return !!wrap;
  }

  // 找一条隐藏原文配对的译文。隐藏原文有两种形态，配对方向相反：
  // 加了类名的原文块 → 译文是它的下一个兄弟；wrap → 译文是 wrap 的兄弟。
  function pairedTranslation(hiddenEl) {
    const candidate = hiddenEl.classList.contains('ai-translator-source-wrap')
      ? hiddenEl.parentElement && hiddenEl.parentElement.querySelector(':scope > .ai-translator-inline-block')
      : hiddenEl.nextElementSibling;
    return candidate && candidate.classList
      && candidate.classList.contains('ai-translator-inline-block') ? candidate : null;
  }

  function releaseHiddenSource(hiddenEl) {
    hiddenEl.classList.remove('ai-translator-source-hidden');
    if (!hiddenEl.classList.contains('ai-translator-source-wrap')) return;
    const parent = hiddenEl.parentNode;
    if (!parent) return;
    while (hiddenEl.firstChild) parent.insertBefore(hiddenEl.firstChild, hiddenEl);
    hiddenEl.remove();
  }

  // 重新算一遍每条原文该不该藏。设置变化、浮球“隐藏译文”切换、
  // revealHiddenTranslations、fit guard 撤译文时都会调用，幂等。
  //
  // 先全量释放再重新隐藏，而不是分「模式开/模式关」两条路：现在藏原文的理由不止一
  // 个（见 shouldHideSource），逐条问一次是唯一不会把两个理由搞混的写法。释放这一
  // 遍同时修掉页面脚本删掉译文之后留下的孤儿原文——译文没了原文不能跟着陪葬。
  function applyTranslationOnlyMode() {
    document.querySelectorAll('.ai-translator-source-hidden').forEach((el) => {
      const translation = pairedTranslation(el);
      if (translation && shouldHideSource(translation)) return;
      releaseHiddenSource(el);
    });
    // 释放之后还剩下的 wrap 是上一轮留下的空壳，原样解包，不给页面留多余结构
    document.querySelectorAll('.ai-translator-source-wrap:not(.ai-translator-source-hidden)')
      .forEach((wrap) => releaseHiddenSource(wrap));

    document.querySelectorAll(PAGE_TRANSLATION_SELECTOR).forEach((el) => {
      if (shouldHideSource(el)) hideSourceForTranslation(el);
    });
  }

  // fit guard 判定这一块挤不下两种语言时调用：给译文打上 crowded 标记，把原文让出来。
  // 只走加类名那条安全路（见 hideSourceForTranslation 的 safeOnly）。
  // @returns {boolean} 让出来了没有；没让出来的话 fit guard 会撤掉译文
  function hideCrowdedSource(translationEl) {
    if (!hideSourceForTranslation(translationEl, { safeOnly: true })) return false;
    translationEl.setAttribute(CROWDED_ATTR, '');
    return true;
  }

  // fit guard 要撤掉这条译文了：先把为它让出来的原文放回去。两个理由藏的都要放
  // ——译文没了还藏着原文，那一块彻底空白，比重叠糟得多。
  function releaseSourceForTranslation(translationEl) {
    translationEl.removeAttribute(CROWDED_ATTR);
    const prev = translationEl.previousElementSibling;
    if (prev && prev.classList && prev.classList.contains('ai-translator-source-hidden')) {
      releaseHiddenSource(prev);
      return;
    }
    const holder = translationEl.parentElement;
    const wrap = holder && holder.querySelector(':scope > .ai-translator-source-wrap');
    if (wrap) releaseHiddenSource(wrap);
  }


  ctx.revealHiddenTranslations = revealHiddenTranslations;
  ctx.setTranslationsVisible = setTranslationsVisible;
  ctx.applyTranslationVisibility = applyTranslationVisibility;
  ctx.PAGE_TRANSLATION_SELECTOR = PAGE_TRANSLATION_SELECTOR;
  ctx.isTranslationOnlyActive = isTranslationOnlyActive;
  ctx.hideSourceForTranslation = hideSourceForTranslation;
  ctx.applyTranslationOnlyMode = applyTranslationOnlyMode;
  // content-fit-guard.js 用：挤不下两种语言时让原文，撤译文时把原文放回来
  ctx.hideCrowdedSource = hideCrowdedSource;
  ctx.releaseSourceForTranslation = releaseSourceForTranslation;
})();
