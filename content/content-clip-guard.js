// 别让译文被祖先裁掉。
//
// 译文插进去了、内容也对，用户还是什么都看不见 —— 因为它落在某个
// overflow:hidden 祖先的可视区之外。Higgsfield 的作品简介就是这样：简介外面套着
// 一个 `overflow:hidden; max-height:60px` 的折叠容器（Tailwind 的
// `transition-[max-height]` 收放动画），原文正好三行占满 60px，译文插在原文后面，
// 从第 61 像素开始 —— 整条被裁掉。实测：
//
//   插入前  clientHeight 60, scrollHeight 60   （没裁到东西）
//   插入后  clientHeight 60, scrollHeight 84   （译文在 532–552，容器底边 530）
//
// 这不是受管 DOM 那类问题（那边节点会被删，见 content-managed-translation.js），
// 节点好好地在 DOM 里，只是被裁了。所以判据也不同：不看节点在不在，看它的矩形有
// 没有掉到祖先的可视框外面。
//
// 处理办法是把造成裁剪的高度约束放开（max-height，不够再放 height / line-clamp），
// 记下原值，译文撤掉时还原。只动高度、不动 overflow —— 站点用 overflow:hidden 做
// 圆角裁切、做遮罩的地方很多，把它改成 visible 会露出本不该露的东西。
//
// 一个已知的取舍：容器本来就折叠着（真正的“展开全文”，原文自己就没显示全）时，
// 放开约束会把原文一起展开。这是有意的 —— 用户主动要了译文，让他看见译文比维持
// 折叠状态重要；译文移除后一切还原。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  // 往上找几层就够了：再往上是页面骨架，那一层的 overflow 不是冲着这段文字来的
  const MAX_DEPTH = 8;
  // 布局取整会差个零点几像素，别为此动手
  const SLACK = 1;

  const GUARD_ATTR = 'data-ai-translator-unclipped';
  // 还留着译文的容器不能还原。受管译文没有自己的节点，认原文块上的标记。
  const TRANSLATION_SELECTOR = '.ai-translator-inline-block, [data-ai-translator-managed]';

  // 被放开的祖先 -> 它原来的内联声明（值和 !important 都要记，还原才是原样）
  const guarded = new Map();

  function readProp(el, name) {
    return { value: el.style.getPropertyValue(name), priority: el.style.getPropertyPriority(name) };
  }

  function writeProp(el, name, saved) {
    if (saved.value) {
      el.style.setProperty(name, saved.value, saved.priority);
    } else {
      el.style.removeProperty(name);
    }
  }

  function remember(el) {
    if (guarded.has(el)) return;
    guarded.set(el, {
      maxHeight: readProp(el, 'max-height'),
      height: readProp(el, 'height'),
      lineClamp: readProp(el, '-webkit-line-clamp')
    });
    el.setAttribute(GUARD_ATTR, '');
  }

  // anchor 的下边缘有没有掉到 el 的可视框外面。
  // 用 clientTop/clientHeight 而不是 getBoundingClientRect().height：后者含边框，
  // 裁剪发生在 padding box 上。
  function clipsAway(el, anchor) {
    if (!anchor.isConnected) return false;
    const box = el.getBoundingClientRect();
    const visibleBottom = box.top + el.clientTop + el.clientHeight;
    return anchor.getBoundingClientRect().bottom > visibleBottom + SLACK;
  }

  // 要量的那个矩形。受管译文没有自己的节点：它是原文块的一条 ::after，句柄只是个挂在
  // 离屏 holder 里的替身，量它会走错整条祖先链。这一步在这里做而不是让调用方各自判断
  // ——调用方拿到什么就传什么。见 content-managed-translation.js。
  function resolveAnchor(target) {
    const block = ctx.getManagedTranslationBlock && ctx.getManagedTranslationBlock(target);
    return block || target;
  }

  // 保证译文不被祖先裁掉。传译文节点、受管句柄或原文块都行。
  ctx.keepTranslationVisible = function(target) {
    const anchor = resolveAnchor(target);
    if (!anchor || anchor.nodeType !== Node.ELEMENT_NODE || !anchor.isConnected) return;

    let el = anchor.parentElement;
    for (let depth = 0; depth < MAX_DEPTH && el && el !== document.body && el !== document.documentElement; depth++) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;

      if (overflowY === 'auto' || overflowY === 'scroll') return; // 滚一下就看得到，不用动它
      if (overflowY !== 'visible' && clipsAway(el, anchor)) {
        remember(el);
        // 先只放开 max-height：绝大多数折叠容器就是靠它收起来的
        el.style.setProperty('max-height', 'none', 'important');
        // 还被裁，说明高度是写死的 height 或者 -webkit-line-clamp 定的，再放这两个
        if (clipsAway(el, anchor)) {
          el.style.setProperty('height', 'auto', 'important');
          if (style.webkitLineClamp && style.webkitLineClamp !== 'none') {
            el.style.setProperty('-webkit-line-clamp', 'none', 'important');
          }
        }
      }

      el = el.parentElement;
    }
  };

  // 还原那些已经不含译文的容器。译文是一条条撤的（悬停换块、关掉划词），所以按
  // “里面还有没有译文”判断，而不是按调用次数配对。
  ctx.releaseTranslationClipGuards = function() {
    if (guarded.size === 0) return;
    for (const [el, saved] of Array.from(guarded)) {
      if (el.isConnected && el.querySelector(TRANSLATION_SELECTOR)) continue;
      writeProp(el, 'max-height', saved.maxHeight);
      writeProp(el, 'height', saved.height);
      writeProp(el, '-webkit-line-clamp', saved.lineClamp);
      el.removeAttribute(GUARD_ATTR);
      guarded.delete(el);
    }
  };
})();
