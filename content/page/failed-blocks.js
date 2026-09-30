// Blab Translation — 整页翻译：失败段落标记（P1-D 批次 D2，设计 §4）
//
// SW 重试完仍然失败的那一段，不再静默留着原文：在它的译文本该出现的位置放一个
// 「翻译失败 · 重试」，title 是失败原因。点它（或聚焦后按 Enter / 空格）只重译
// 这一段，走的仍是整页翻译那一轮（ctx.runTranslationPass，page 功能、原来的引擎、
// requestTranslationCached 那条路）；再失败就再放一个。
//
// 标记借用 .ai-translator-inline-block 这个类名，于是收集、发现、划词、悬停这些
// 「跳过我们自己的节点」的地方不用各改一遍。代价是凡是**数译文**的地方都要把它
// 排除：那一条选择器归 content/page/visibility.js（PAGE_TRANSLATION_SELECTOR），
// translation.css 里画译文的选择器同样带 :not(.ai-translator-failed)。
//
// 一个标记只对「放下它的那一刻」的这段内容、这门目标语言作数（修复回合 1 的 A/E）。
// 标记被页面删掉、原文换了（虚拟列表回收节点、SPA 重渲）、目标语言换了，这个条目
// 就过期：isMarked 与 retry 先核对（stillValid），过期的收走并交回正常流程 —— 自动
// 翻译的调度层看到 isMarked 为 false 会自己送它，整页翻译下一次收集照常收它。绝不
// 拿旧的 block.text 去请求，也不把旧内容的译文插进新内容。语言按条目记（不设
// 「换语言时全清」的广播）：换语言没有一个集中的事件，collect.js 对已翻块的做法也是
// 收集时逐块核对，这里同一口径。
//
// 放标记是「接住失败、展示给用户」的那一层，失败本身已经在 batch.js 记过日志，
// 这里不再打。唯一的例外是重试那一轮自己抛出来的异常：它在这一层被接住（换成
// 一个新标记），所以在这一层记一次。
(function() {
  'use strict';

  const ctx = window.AI_TRANSLATOR_CONTENT;
  if (!ctx) return;

  const t = ctx.t;
  const CLASS = 'ai-translator-failed';
  const SELECTOR = `.ai-translator-inline-block.${CLASS}`;

  // 原文元素 → { marker, block, auto, fingerprint, lang }。按元素记：同一段下一轮
  // 收集出来的是新的 block 对象，元素还是那一个。byMarker 是反查：clearWhere 从
  // 文档里找到的是标记节点。
  const markers = new WeakMap();
  const byMarker = new WeakMap();

  // 与 insert.js 登记译文身份同一口径：readSourceText 跳过我们自己的节点，所以挂在
  // 段内的标记不改变指纹；只装了整页模块的夹具里没有引擎，语言记 null（不比）。
  const fingerprintOf = (element) => globalThis.BlockIdentity.fingerprint(ctx.readSourceText(element));
  const targetLang = () => (ctx.currentTargetLang ? ctx.currentTargetLang() : null);

  function drop(entry) {
    if (markers.get(entry.block.element) === entry) markers.delete(entry.block.element);
    byMarker.delete(entry.marker);
    entry.marker.remove();
  }

  /**
   * 这个条目还作不作数：标记和原文都还在文档里、原文指纹没变、目标语言没换
   * （两边都说了语言才比，与 BlockIdentity.isStale 同一规则）。不作数就收走，回 false。
   */
  function stillValid(entry) {
    const element = entry.block.element;
    const lang = targetLang();
    const langChanged = entry.lang != null && lang != null && entry.lang !== lang;
    if (entry.marker.isConnected && element.isConnected && !langChanged
      && entry.fingerprint === fingerprintOf(element)) return true;
    drop(entry);
    return false;
  }

  /** 这一段身上的失败标记（有就摘掉）。译文插进来之前、重新放标记之前都先调它。 */
  function clear(block) {
    const element = block && block.element;
    if (!element) return;
    const entry = markers.get(element);
    if (entry) drop(entry);
  }

  /** 收走文档里原文元素满足 predicate 的所有标记（自定义规则禁掉的区域）。 */
  function clearWhere(predicate) {
    ctx.queryAllDeep(SELECTOR).forEach((marker) => {
      const entry = byMarker.get(marker);
      if (entry && predicate(entry.block.element)) drop(entry);
    });
  }

  /**
   * 标记的点击和按键不能走到宿主页面：段落可能就在一个链接或一张可点的卡片里。
   * 在标记自己身上 preventDefault + stopPropagation —— 事件先经过祖先的捕获阶段，
   * 那一段拦不住，但页面的点击处理绝大多数挂在冒泡阶段。
   */
  function swallow(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function retry(entry) {
    if (markers.get(entry.block.element) !== entry) return;
    // 内容或语言变了：entry.block 是旧内容，收走标记、交回正常流程，不拿它请求。
    if (!stillValid(entry)) return;
    clear(entry.block);
    const element = entry.block.element;
    // markFailures：自动翻译那一轮默认不放标记（它自己在 giveUp 那一刻放），
    // 但这一次是用户点出来的，失败就该看得见。
    ctx.runTranslationPass([entry.block], { auto: entry.auto, markFailures: true })
      .then((error) => {
        // 整轮级的失败（扩展上下文没了、配置错）可能停在发请求之前，没放下标记：
        // 补一个，带上那句原因。
        if (error && !markers.has(element)) mark(entry.block, error, { auto: entry.auto });
      })
      .catch((error) => {
        console.error('Blab Translation: failed-block retry failed', error);
        mark(entry.block, error && error.message, { auto: entry.auto });
      });
  }

  /**
   * 在这一段上放一个失败标记。已经有一个就先换掉（原因可能不同）；这一段已经有
   * 译文（另一轮先落了笔）就不放。
   *
   * @param {object} block 收集端给的块（至少有 element）
   * @param {string} [reason] 本地化的失败原因，做 title；没有就用 translationFailed
   * @param {{auto?: boolean}} [options] 这一段是不是自动翻译那一轮的；重试沿用
   */
  function mark(block, reason, { auto = false } = {}) {
    const element = block && block.element;
    if (!element) return;
    clear(block);
    if (element.classList.contains('ai-translator-translated')) return;

    const marker = document.createElement('span');
    marker.className = `ai-translator-inline-block ${CLASS}`;
    marker.setAttribute('role', 'button');
    marker.tabIndex = 0;
    marker.textContent = t('translationFailedRetry');
    marker.title = reason || t('translationFailed');
    const entry = { marker, block, auto: auto === true, fingerprint: fingerprintOf(element), lang: targetLang() };
    marker.addEventListener('click', (event) => {
      swallow(event);
      retry(entry);
    });
    marker.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      swallow(event);
      retry(entry);
    });
    // 宿主的 mousedown / mouseup 处理（拖选、卡片跳转）同样不该被这一下触发。
    marker.addEventListener('mousedown', (event) => event.stopPropagation());
    marker.addEventListener('mouseup', (event) => event.stopPropagation());

    if (!ctx.placeFailureMarker(block, marker)) return;
    markers.set(element, entry);
    byMarker.set(marker, entry);
  }

  /**
   * 这个原文元素身上是不是挂着一个还作数的失败标记。自动翻译的调度层据此不再
   * 自己送它；过期的在这里收走，回 false，调度层就照常送。
   */
  function isMarked(element) {
    const entry = markers.get(element);
    return Boolean(entry) && stillValid(entry);
  }

  ctx.failedBlocks = Object.freeze({ CLASS, SELECTOR, mark, clear, clearWhere, isMarked });
})();
