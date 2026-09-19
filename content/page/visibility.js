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
  function revealHiddenTranslations() {
    const hidden = document.querySelectorAll('.ai-translator-inline-block.ai-translator-hidden');
    hidden.forEach(el => el.classList.remove('ai-translator-hidden'));
    // 受管容器里的译文整体开关（见 content-managed-translation.js），它被隐藏时
    // 上面那批里只有一个不显示的替身，光看 hidden.length 会漏判。
    const managedHidden = ctx.areManagedTranslationsHidden && ctx.areManagedTranslationsHidden();
    if (managedHidden && ctx.setManagedTranslationsVisible) {
      ctx.setManagedTranslationsVisible(true);
    }
    if (hidden.length > 0 || managedHidden) {
      state.translationsVisible = true;
    }
    // “仅显示译文”开着时，此前因“隐藏译文”被放回来的原文要重新藏起去
    applyTranslationOnlyMode();
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
  const PAGE_TRANSLATION_SELECTOR =
    '.ai-translator-inline-block:not(.ai-translator-selection-translation):not(.ai-translator-hover-translation)';

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
  ctx.isTranslationOnlyActive = isTranslationOnlyActive;
  ctx.hideSourceForTranslation = hideSourceForTranslation;
  ctx.applyTranslationOnlyMode = applyTranslationOnlyMode;
  // content-fit-guard.js 用：挤不下两种语言时让原文，撤译文时把原文放回来
  ctx.hideCrowdedSource = hideCrowdedSource;
  ctx.releaseSourceForTranslation = releaseSourceForTranslation;
})();
